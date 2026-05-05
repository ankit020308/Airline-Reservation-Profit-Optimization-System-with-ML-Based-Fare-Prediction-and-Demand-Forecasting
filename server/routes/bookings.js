'use strict';

/**
 * Bookings Routes
 * Phase 1 P0: All CRUD operations now use PostgreSQL transactions.
 * Saga pattern: lock seats → calculate fare → create booking → insert passengers.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db');
const { authenticate }              = require('../middleware/auth');
const { lockSeats, releaseSeats }   = require('../services/inventory/inventoryService');
const { calculateFare }             = require('../services/pricing/pricingEngine');
const { eventBus, TOPICS, EVENTS }  = require('../services/events/eventBus');
const { recordBookingEvent }        = require('../services/ai/aiService');
const { getBundleRecommendations }  = require('../services/recommendation/recommendationEngine');
const { scoreFraud }                = require('../services/security/fraudDetection');

const router = express.Router();

function generatePNR() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function formatBooking(b) {
  return {
    bookingId:    b.booking_id,
    pnr:          b.pnr,
    status:       b.status,
    cabinClass:   b.cabin_class,
    totalFare:    parseFloat(b.total_fare),
    currency:     b.currency || 'INR',
    fareBasis:    b.fare_basis,
    holdExpiresAt: b.hold_expires_at,
    confirmedAt:  b.confirmed_at,
    cancelledAt:  b.cancelled_at,
    refundAmount: b.refund_amount ? parseFloat(b.refund_amount) : null,
    refundStatus: b.refund_status,
    createdAt:    b.created_at,
  };
}

// ── POST /api/bookings — Initiate booking (Saga) ────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const { flightId, cabinClass, passengers, couponCode, priceGuaranteeId } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] || uuidv4();

    // Idempotency check
    const { rows: existing } = await db.readQuery(
      `SELECT * FROM bookings WHERE idempotency_key = $1 AND status <> 'EXPIRED'`,
      [idempotencyKey]
    );
    if (existing.length > 0) {
      return res.status(200).json({ ...formatBooking(existing[0]), message: 'Existing booking returned' });
    }

    if (!flightId || !cabinClass || !passengers?.length) {
      return res.status(400).json({ error: 'MISSING_REQUIRED_FIELDS' });
    }

    const { rows: flightRows } = await db.readQuery(
      `SELECT f.*, t.tenant_id FROM flights f JOIN tenants t ON t.tenant_id = f.tenant_id WHERE f.flight_id = $1`,
      [flightId]
    );
    const flight = flightRows[0];
    if (!flight || flight.status === 'CANCELLED') {
      return res.status(422).json({ error: 'FLIGHT_UNAVAILABLE' });
    }

    const paxCount = passengers.length;

    // Saga Step 1: Lock seats (inventory service)
    const lockResult = await lockSeats({ flightId, cabinClass, count: paxCount, bookingId: null, sessionId: req.user.userId });
    if (!lockResult.success) {
      return res.status(409).json({ error: lockResult.reason, availableCount: lockResult.availableCount, retryAfterMs: 3000 });
    }

    // Saga Step 2: Calculate dynamic fare
    const fare = await calculateFare({ flightId, cabinClass, paxCount, userId: req.user.userId, loyaltyTier: req.user.tier });
    if (!fare) {
      await releaseSeats({ lockId: lockResult.lockId, lockToken: lockResult.lockToken, reason: 'FARE_ERROR' });
      return res.status(422).json({ error: 'FARE_CALCULATION_FAILED' });
    }

    // Apply coupon if provided
    let discountAmount = 0;
    let appliedCoupon = null;
    if (couponCode) {
      const { rows: couponRows } = await db.readQuery(
        `SELECT * FROM coupons WHERE code = $1 AND active = TRUE AND valid_to > NOW()
         AND (usage_limit IS NULL OR usage_count < usage_limit)`,
        [couponCode.toUpperCase()]
      );
      const coupon = couponRows[0];
      if (coupon && parseFloat(coupon.min_fare) <= fare.totalFare) {
        if (coupon.type === 'PERCENT') {
          discountAmount = Math.min(fare.totalFare * coupon.value / 100, parseFloat(coupon.max_discount || fare.totalFare));
        } else if (coupon.type === 'FIXED') {
          discountAmount = parseFloat(coupon.value);
        }
        await db.query('UPDATE coupons SET usage_count = usage_count + 1 WHERE coupon_id = $1', [coupon.coupon_id]);
        appliedCoupon = { code: coupon.code, type: coupon.type, discount: discountAmount };
      }
    }

    const finalFare = Math.max(0, fare.totalFare - discountAmount);
    const bookingId = uuidv4();
    const pnr = generatePNR();

    // Saga Step 3: Persist booking + passengers in a transaction
    await db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO bookings (booking_id, pnr, tenant_id, user_id, flight_id, cabin_class,
           status, total_fare, currency, fare_basis, fare_multipliers, lock_token,
           idempotency_key, hold_expires_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, 'HOLD', $7, 'INR', $8, $9, $10, $11, $12, $13)`,
        [
          bookingId, pnr, flight.tenant_id, req.user.userId, flightId, cabinClass,
          finalFare, fare.fareBucket, JSON.stringify(fare.multipliers),
          lockResult.lockToken, idempotencyKey, lockResult.expiresAt,
          JSON.stringify({ appliedCoupon, priceGuaranteeId }),
        ]
      );

      // Update lock with booking_id
      await client.query('UPDATE seat_locks SET booking_id = $1 WHERE lock_id = $2', [bookingId, lockResult.lockId]);

      // Insert passengers
      for (const pax of passengers) {
        await client.query(
          `INSERT INTO booking_passengers (passenger_id, booking_id, passenger_type, first_name,
             last_name, dob, passport_no, nationality, seat_number, meal_preference)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            uuidv4(), bookingId, pax.type || 'ADULT',
            pax.firstName, pax.lastName, pax.dob || null,
            pax.passportNo || null, pax.nationality || null,
            pax.seatPreference || null, pax.meal || null,
          ]
        );
      }
    });

    // Publish events (non-blocking)
    eventBus.publish(TOPICS.BOOKING, EVENTS.BOOKING_CREATED, {
      bookingId, pnr, userId: req.user.userId, flightId, cabinClass,
      totalFare: finalFare, expiresAt: lockResult.expiresAt,
    });
    recordBookingEvent(flight.origin_iata, flight.dest_iata, req.user.userId);

    const bundles = getBundleRecommendations({ bookingId, userId: req.user.userId, cabinClass, totalFare: finalFare });

    res.status(201).json({
      bookingId, pnr, status: 'HOLD',
      cabinClass, currency: 'INR', totalFare: finalFare,
      passengers: paxCount,
      fare: {
        perPassenger: fare.perPassengerFare, total: finalFare,
        discount: discountAmount, currency: 'INR',
        fareBasis: fare.fareBucket, fareBucketLabel: fare.fareBucketLabel,
        refundable: fare.refundable, multipliers: fare.multipliers,
      },
      lockInfo: { lockId: lockResult.lockId, expiresAt: lockResult.expiresAt, seatsRemaining: lockResult.seatsRemaining },
      bundleRecommendations: bundles,
      paymentUrl: `/api/payments?booking_id=${bookingId}`,
    });
  } catch (err) {
    console.error('[Bookings] Error:', err);
    res.status(500).json({ error: 'BOOKING_FAILED', message: err.message });
  }
});

// ── GET /api/bookings — List user bookings ──────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const params = [req.user.userId];
    let sql = `
      SELECT b.*, f.flight_number, f.origin_iata, f.dest_iata, f.departure_time AS flight_dep,
             f.status AS flight_status, t.airline_name
      FROM bookings b
      LEFT JOIN flights f  ON f.flight_id  = b.flight_id
      LEFT JOIN tenants t  ON t.tenant_id  = b.tenant_id
      WHERE b.user_id = $1
    `;
    if (status) {
      sql += ` AND b.status = $${params.length + 1}`;
      params.push(status.toUpperCase());
    }
    sql += ` ORDER BY b.created_at DESC`;

    const { rows } = await db.readQuery(sql, params);
    const paginated = rows.slice((page - 1) * limit, page * limit);

    res.json({
      bookings: paginated.map(b => ({
        ...formatBooking(b),
        flight: b.flight_number ? {
          flightNumber: b.flight_number, origin: b.origin_iata,
          destination: b.dest_iata, departure: b.flight_dep,
          airline: b.airline_name, status: b.flight_status,
        } : null,
      })),
      total: rows.length,
      page: parseInt(page),
    });
  } catch (err) {
    res.status(500).json({ error: 'BOOKINGS_FETCH_FAILED', message: err.message });
  }
});

// ── GET /api/bookings/:id ──────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const { rows } = await db.readQuery(
      `SELECT b.*, f.flight_number, f.origin_iata, f.dest_iata,
              f.departure_time AS flight_dep, f.arrival_time AS flight_arr,
              f.duration_minutes, f.aircraft_type, f.status AS flight_status,
              f.delay_minutes, t.airline_name, t.logo_url AS airline_logo
       FROM bookings b
       LEFT JOIN flights f ON f.flight_id = b.flight_id
       LEFT JOIN tenants t ON t.tenant_id = b.tenant_id
       WHERE (b.booking_id = $1 OR b.pnr = $2)
         AND (b.user_id = $3 OR $4 = 'admin')`,
      [req.params.id, id, req.user.userId, req.user.role]
    );
    const booking = rows[0];
    if (!booking) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });

    const [{ rows: passengers }, { rows: payments }] = await Promise.all([
      db.readQuery('SELECT * FROM booking_passengers WHERE booking_id = $1', [booking.booking_id]),
      db.readQuery('SELECT status, payment_method, amount FROM payments WHERE booking_id = $1 LIMIT 1', [booking.booking_id]),
    ]);

    res.json({
      ...formatBooking(booking),
      passengers,
      flight: booking.flight_number ? {
        flightNumber:    booking.flight_number,
        airline:         booking.airline_name,
        airlineLogo:     booking.airline_logo,
        origin:          booking.origin_iata,
        destination:     booking.dest_iata,
        departure:       booking.flight_dep,
        arrival:         booking.flight_arr,
        durationMinutes: booking.duration_minutes,
        status:          booking.flight_status,
        delayMinutes:    booking.delay_minutes,
      } : null,
      payment: payments[0] ? {
        status: payments[0].status, method: payments[0].payment_method, amount: payments[0].amount,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'BOOKING_FETCH_FAILED', message: err.message });
  }
});

// ── DELETE /api/bookings/:id — Cancel booking ──────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { rows } = await db.readQuery(
      `SELECT b.*, f.departure_time FROM bookings b
       LEFT JOIN flights f ON f.flight_id = b.flight_id
       WHERE b.booking_id = $1 AND b.user_id = $2`,
      [req.params.id, req.user.userId]
    );
    const booking = rows[0];
    if (!booking) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
    if (!['HOLD', 'CONFIRMED'].includes(booking.status)) {
      return res.status(409).json({ error: 'CANNOT_CANCEL', status: booking.status });
    }

    const daysToFlight = booking.departure_time
      ? (new Date(booking.departure_time) - Date.now()) / 86400000 : 999;
    const isRefundable = ['Y', 'J', 'F', 'B', 'C'].includes(booking.fare_basis);
    let refundAmount = 0;
    if (isRefundable) {
      refundAmount = daysToFlight > 1 ? parseFloat(booking.total_fare) : parseFloat(booking.total_fare) * 0.5;
    } else if (daysToFlight > 7) {
      refundAmount = parseFloat(booking.total_fare) * 0.3;
    }

    const cancelReason = req.body.reason || 'PASSENGER_REQUEST';
    const refundStatus = refundAmount > 0 ? 'PROCESSING' : 'NOT_ELIGIBLE';

    await db.withTransaction(async (client) => {
      await client.query(
        `UPDATE bookings SET status = 'CANCELLED', cancelled_at = NOW(),
          cancel_reason = $1, refund_amount = $2, refund_status = $3
         WHERE booking_id = $4`,
        [cancelReason, refundAmount, refundStatus, booking.booking_id]
      );

      // Release any active seat lock
      await client.query(
        `UPDATE seat_locks SET released = TRUE
         WHERE booking_id = $1 AND released = FALSE`,
        [booking.booking_id]
      );

      // Return allocated seat if booking was confirmed
      if (booking.status === 'CONFIRMED') {
        await client.query(
          `UPDATE flight_inventory
           SET allocated_seats = GREATEST(0, allocated_seats - 1)
           WHERE flight_id = $1 AND cabin_class = $2`,
          [booking.flight_id, booking.cabin_class]
        );
      }
    });

    eventBus.publish(TOPICS.BOOKING, EVENTS.BOOKING_CANCELLED, {
      bookingId: booking.booking_id, reason: cancelReason, refundAmount,
    });

    res.json({
      message: 'Booking cancelled', pnr: booking.pnr, refundAmount,
      refundStatus, refundTimeline: refundAmount > 0 ? '5-7 business days' : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'CANCELLATION_FAILED', message: err.message });
  }
});

module.exports = router;
