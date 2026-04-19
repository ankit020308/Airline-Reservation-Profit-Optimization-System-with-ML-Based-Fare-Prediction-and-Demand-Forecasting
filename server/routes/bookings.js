'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { lockSeats, releaseSeats, finalizeSeats } = require('../services/inventory/inventoryService');
const { calculateFare } = require('../services/pricing/pricingEngine');
const { eventBus, TOPICS, EVENTS } = require('../services/events/eventBus');
const { recordBookingEvent } = require('../services/ai/aiService');
const { getBundleRecommendations } = require('../services/recommendation/recommendationEngine');
const { scoreFraud } = require('../services/security/fraudDetection');

const router = express.Router();

// ── Generate PNR ────────────────────────────────────────────────────────────
function generatePNR() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// POST /api/bookings — Initiate booking (Saga Step 1)
router.post('/', authenticate, async (req, res) => {
  try {
    const { flightId, cabinClass, passengers, couponCode, priceGuaranteeId } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] || uuidv4();

    // Idempotency check
    const existing = db.memFindOne('bookings', b => b.idempotency_key === idempotencyKey);
    if (existing && existing.status !== 'EXPIRED') {
      return res.status(200).json({ ...formatBooking(existing), message: 'Existing booking returned' });
    }

    if (!flightId || !cabinClass || !passengers?.length) {
      return res.status(400).json({ error: 'MISSING_REQUIRED_FIELDS' });
    }

    const flight = db.memFindOne('flights', f => f.flight_id === flightId);
    if (!flight || flight.status === 'CANCELLED') {
      return res.status(422).json({ error: 'FLIGHT_UNAVAILABLE' });
    }

    const paxCount = passengers.length;

    // Saga Step 1: Lock seats
    const lockResult = await lockSeats({
      flightId, cabinClass,
      count: paxCount,
      bookingId: null,
      sessionId: req.user.userId,
    });

    if (!lockResult.success) {
      return res.status(409).json({
        error: lockResult.reason,
        availableCount: lockResult.availableCount,
        retryAfterMs: 3000,
      });
    }

    // Saga Step 2: Calculate fare
    const fare = await calculateFare({
      flightId, cabinClass, paxCount,
      userId: req.user.userId,
      loyaltyTier: req.user.tier,
    });

    if (!fare) {
      await releaseSeats({ lockId: lockResult.lockId, lockToken: lockResult.lockToken, reason: 'FARE_ERROR' });
      return res.status(422).json({ error: 'FARE_CALCULATION_FAILED' });
    }

    // Apply coupon if provided
    let discountAmount = 0;
    let appliedCoupon = null;
    if (couponCode) {
      const coupon = db.memFindOne('coupons', c =>
        c.code === couponCode.toUpperCase() && c.active &&
        new Date(c.valid_to) > new Date() &&
        (!c.usage_limit || c.usage_count < c.usage_limit)
      );
      if (coupon && parseFloat(coupon.min_fare) <= fare.totalFare) {
        if (coupon.type === 'PERCENT') {
          discountAmount = Math.min(fareTotal * coupon.value / 100, parseFloat(coupon.max_discount || Infinity));
        } else if (coupon.type === 'FIXED') {
          discountAmount = parseFloat(coupon.value);
        }
        coupon.usage_count++;
        appliedCoupon = { code: coupon.code, type: coupon.type, discount: discountAmount };
      }
    }

    const finalFare = Math.max(0, fare.totalFare - discountAmount);

    // Create booking
    const bookingId = uuidv4();
    const booking = {
      booking_id: bookingId,
      pnr: generatePNR(),
      tenant_id: flight.tenant_id,
      user_id: req.user.userId,
      flight_id: flightId,
      cabin_class: cabinClass,
      status: 'HOLD',
      total_fare: finalFare,
      currency: 'INR',
      fare_basis: fare.fareBucket,
      fare_multipliers: JSON.stringify(fare.multipliers),
      lock_token: lockResult.lockToken,
      idempotency_key: idempotencyKey,
      hold_expires_at: lockResult.expiresAt,
      metadata: JSON.stringify({ appliedCoupon, priceGuaranteeId }),
    };
    db.memInsert('bookings', booking);

    // Update lock with booking_id
    const lock = db.memFindOne('seat_locks', l => l.lock_id === lockResult.lockId);
    if (lock) lock.booking_id = bookingId;

    // Insert passengers
    for (const pax of passengers) {
      db.memInsert('booking_passengers', {
        passenger_id: uuidv4(),
        booking_id: bookingId,
        passenger_type: pax.type || 'ADULT',
        first_name: pax.firstName,
        last_name: pax.lastName,
        dob: pax.dob,
        passport_no: pax.passportNo,
        nationality: pax.nationality,
        seat_number: pax.seatPreference,
        meal_preference: pax.meal,
      });
    }

    // Publish event
    eventBus.publish(TOPICS.BOOKING, EVENTS.BOOKING_CREATED, {
      bookingId,
      pnr: booking.pnr,
      userId: req.user.userId,
      flightId,
      cabinClass,
      totalFare: finalFare,
      expiresAt: lockResult.expiresAt,
    });

    // Anomaly detection
    const flight_data = db.memFindOne('flights', f => f.flight_id === flightId);
    if (flight_data) recordBookingEvent(flight_data.origin_iata, flight_data.dest_iata, req.user.userId);

    // Bundle recommendations
    const bundles = getBundleRecommendations({
      bookingId, userId: req.user.userId, cabinClass, totalFare: finalFare
    });

    res.status(201).json({
      ...formatBooking(booking),
      passengers: passengers.length,
      fare: {
        perPassenger: fare.perPassengerFare,
        total: finalFare,
        discount: discountAmount,
        currency: 'INR',
        fareBasis: fare.fareBucket,
        fareBucketLabel: fare.fareBucketLabel,
        refundable: fare.refundable,
        multipliers: fare.multipliers,
      },
      lockInfo: {
        lockId: lockResult.lockId,
        expiresAt: lockResult.expiresAt,
        seatsRemaining: lockResult.seatsRemaining,
      },
      bundleRecommendations: bundles,
      paymentUrl: `/api/payments?booking_id=${bookingId}`,
    });
  } catch (err) {
    console.error('[Bookings] Error:', err);
    res.status(500).json({ error: 'BOOKING_FAILED', message: err.message });
  }
});

// GET /api/bookings — List user bookings
router.get('/', authenticate, (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;
  let bookings = db.memFind('bookings', b => {
    if (b.user_id !== req.user.userId) return false;
    if (status && b.status !== status.toUpperCase()) return false;
    return true;
  });

  bookings.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const paginated = bookings.slice((page - 1) * limit, page * limit);

  const enriched = paginated.map(b => {
    const flight = db.memFindOne('flights', f => f.flight_id === b.flight_id);
    const airline = flight ? db.memFindOne('tenants', t => t.tenant_id === flight.tenant_id) : null;
    return {
      ...formatBooking(b),
      flight: flight ? {
        flightNumber: flight.flight_number,
        origin: flight.origin_iata,
        destination: flight.dest_iata,
        departure: flight.departure_time,
        airline: airline?.airline_name,
        status: flight.status,
      } : null,
    };
  });

  res.json({ bookings: enriched, total: bookings.length, page: parseInt(page) });
});

// GET /api/bookings/:id
router.get('/:id', authenticate, (req, res) => {
  const booking = db.memFindOne('bookings', b =>
    (b.booking_id === req.params.id || b.pnr === req.params.id.toUpperCase()) &&
    (b.user_id === req.user.userId || req.user.role === 'admin')
  );
  if (!booking) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });

  const flight = db.memFindOne('flights', f => f.flight_id === booking.flight_id);
  const airline = flight ? db.memFindOne('tenants', t => t.tenant_id === flight.tenant_id) : null;
  const passengers = db.memFind('booking_passengers', p => p.booking_id === booking.booking_id);
  const payment = db.memFindOne('payments', p => p.booking_id === booking.booking_id);

  res.json({
    ...formatBooking(booking),
    passengers,
    flight: flight ? {
      flightNumber: flight.flight_number,
      airline: airline?.airline_name,
      airlineLogo: airline?.logo_url,
      origin: flight.origin_iata,
      destination: flight.dest_iata,
      departure: flight.departure_time,
      arrival: flight.arrival_time,
      durationMinutes: flight.duration_minutes,
      status: flight.status,
      delayMinutes: flight.delay_minutes,
    } : null,
    payment: payment ? {
      status: payment.status,
      method: payment.payment_method,
      amount: payment.amount,
    } : null,
  });
});

// DELETE /api/bookings/:id — Cancel booking
router.delete('/:id', authenticate, async (req, res) => {
  const booking = db.memFindOne('bookings', b =>
    b.booking_id === req.params.id && b.user_id === req.user.userId);

  if (!booking) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
  if (!['HOLD', 'CONFIRMED'].includes(booking.status)) {
    return res.status(409).json({ error: 'CANNOT_CANCEL', status: booking.status });
  }

  // Cancellation fee logic
  const flight = db.memFindOne('flights', f => f.flight_id === booking.flight_id);
  const daysToFlight = flight
    ? (new Date(flight.departure_time) - Date.now()) / 86400000 : 999;
  const fareBasis = booking.fare_basis;
  const isRefundable = ['Y', 'J', 'F', 'B', 'C'].includes(fareBasis);

  let refundAmount = 0;
  if (isRefundable) {
    refundAmount = daysToFlight > 1 ? parseFloat(booking.total_fare) : parseFloat(booking.total_fare) * 0.5;
  } else if (daysToFlight > 7) {
    refundAmount = parseFloat(booking.total_fare) * 0.3;
  }

  booking.status = 'CANCELLED';
  booking.cancelled_at = new Date().toISOString();
  booking.cancel_reason = req.body.reason || 'PASSENGER_REQUEST';
  booking.refund_amount = refundAmount;
  booking.refund_status = refundAmount > 0 ? 'PROCESSING' : 'NOT_ELIGIBLE';

  // Release seat lock if still held
  const lock = db.memFindOne('seat_locks', l => l.booking_id === booking.booking_id && !l.released);
  if (lock) await releaseSeats({ lockId: lock.lock_id, lockToken: lock.lock_token, reason: 'CANCELLATION' });

  // Inventory: return seat
  const inv = db.memFindOne('flight_inventory', i =>
    i.flight_id === booking.flight_id && i.cabin_class === booking.cabin_class);
  if (inv && inv.allocated_seats > 0 && booking.status !== 'HOLD') inv.allocated_seats--;

  eventBus.publish(TOPICS.BOOKING, EVENTS.BOOKING_CANCELLED, {
    bookingId: booking.booking_id,
    reason: booking.cancel_reason,
    refundAmount,
  });

  res.json({
    message: 'Booking cancelled',
    pnr: booking.pnr,
    refundAmount,
    refundStatus: booking.refund_status,
    refundTimeline: refundAmount > 0 ? '5-7 business days' : null,
  });
});

function formatBooking(b) {
  return {
    bookingId: b.booking_id,
    pnr: b.pnr,
    status: b.status,
    cabinClass: b.cabin_class,
    totalFare: parseFloat(b.total_fare),
    currency: b.currency || 'INR',
    fareBasis: b.fare_basis,
    holdExpiresAt: b.hold_expires_at,
    confirmedAt: b.confirmed_at,
    cancelledAt: b.cancelled_at,
    refundAmount: b.refund_amount ? parseFloat(b.refund_amount) : null,
    refundStatus: b.refund_status,
    createdAt: b.created_at,
  };
}

module.exports = router;
