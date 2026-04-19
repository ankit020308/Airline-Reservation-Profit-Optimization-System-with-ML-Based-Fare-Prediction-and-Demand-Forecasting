'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { finalizeSeats } = require('../services/inventory/inventoryService');
const { eventBus, TOPICS, EVENTS } = require('../services/events/eventBus');
const { scoreFraud } = require('../services/security/fraudDetection');
const router = express.Router();

// POST /api/payments — Process payment (Saga Step 3)
router.post('/', authenticate, async (req, res) => {
  try {
    const { bookingId, paymentMethod = 'CARD', cardLast4 } = req.body;
    const idempotencyKey = req.headers['idempotency-key'];

    if (!bookingId) return res.status(400).json({ error: 'BOOKING_ID_REQUIRED' });

    // Idempotency: prevent double charge
    if (idempotencyKey) {
      const existingPayment = db.memFindOne('payments', p => p.idempotency_key === idempotencyKey);
      if (existingPayment) return res.status(200).json({ payment: existingPayment, duplicate: true });
    }

    const booking = db.memFindOne('bookings', b =>
      b.booking_id === bookingId && b.user_id === req.user.userId);
    if (!booking) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });

    if (booking.status === 'CONFIRMED') {
      return res.status(409).json({ error: 'ALREADY_PAID', pnr: booking.pnr });
    }
    if (booking.status !== 'HOLD') {
      return res.status(409).json({ error: 'BOOKING_NOT_IN_HOLD', status: booking.status });
    }
    if (booking.hold_expires_at && new Date(booking.hold_expires_at) < new Date()) {
      booking.status = 'EXPIRED';
      return res.status(410).json({ error: 'BOOKING_EXPIRED' });
    }

    // Fraud check
    const flight = db.memFindOne('flights', f => f.flight_id === booking.flight_id);
    const fraudResult = scoreFraud({
      userId: req.user.userId,
      amount: parseFloat(booking.total_fare),
      ipAddress: req.ip,
      paymentMethod,
      flightInfo: flight ? { departure: flight.departure_time } : null,
    });

    if (fraudResult.decision === 'HOLD') {
      return res.status(402).json({
        error: 'FRAUD_HOLD',
        message: 'Transaction under review. Please contact support.',
        fraudScore: fraudResult.score,
      });
    }

    const paymentId = uuidv4();

    // Simulate payment gateway (90% success rate)
    const paymentSuccess = Math.random() > 0.08;

    eventBus.publish(TOPICS.PAYMENT, EVENTS.PAYMENT_INITIATED, {
      paymentId, bookingId, amount: booking.total_fare, currency: 'INR',
    });

    if (!paymentSuccess) {
      // Payment failed
      db.memInsert('payments', {
        payment_id: paymentId,
        booking_id: bookingId,
        user_id: req.user.userId,
        amount: booking.total_fare,
        currency: 'INR',
        status: 'FAILED',
        payment_method: paymentMethod,
        fraud_score: fraudResult.score,
        fraud_flags: fraudResult.signals,
        idempotency_key: idempotencyKey,
      });

      eventBus.publish(TOPICS.PAYMENT, EVENTS.PAYMENT_FAILED, {
        paymentId, bookingId, reason: 'GATEWAY_REJECTION',
      });

      return res.status(402).json({
        error: 'PAYMENT_FAILED',
        paymentId,
        message: 'Payment was declined. Please try a different payment method.',
        retryable: true,
      });
    }

    // Payment success
    const payment = {
      payment_id: paymentId,
      booking_id: bookingId,
      user_id: req.user.userId,
      amount: booking.total_fare,
      currency: 'INR',
      status: 'COMPLETED',
      payment_method: paymentMethod,
      transaction_id: `TXN${Date.now()}`,
      fraud_score: fraudResult.score,
      fraud_flags: fraudResult.signals,
      idempotency_key: idempotencyKey,
      processed_at: new Date().toISOString(),
    };
    db.memInsert('payments', payment);

    // Saga Step 3: Confirm booking
    booking.status = 'CONFIRMED';
    booking.confirmed_at = new Date().toISOString();

    // Finalize seat (lock → allocated)
    const lock = db.memFindOne('seat_locks', l => l.booking_id === bookingId && !l.released);
    if (lock) await finalizeSeats({ lockId: lock.lock_id, bookingId });

    // Award loyalty points
    const user = db.memFindOne('users', u => u.user_id === req.user.userId);
    if (user) {
      const pointsEarned = Math.floor(parseFloat(booking.total_fare) / 100);
      user.loyalty_points = (user.loyalty_points || 0) + pointsEarned;
      // Tier upgrade logic
      if (user.loyalty_points >= 50000) user.loyalty_tier = 'PLATINUM';
      else if (user.loyalty_points >= 25000) user.loyalty_tier = 'GOLD';
      else if (user.loyalty_points >= 10000) user.loyalty_tier = 'SILVER';
    }

    // Queue confirmation notification
    db.memInsert('notifications', {
      notification_id: uuidv4(),
      user_id: req.user.userId,
      booking_id: bookingId,
      type: 'BOOKING_CONFIRMED',
      channel: 'IN_APP',
      subject: `Booking Confirmed — PNR: ${booking.pnr}`,
      body: `Your booking is confirmed! PNR: ${booking.pnr}. Total: ₹${parseFloat(booking.total_fare).toLocaleString('en-IN')}`,
      status: 'QUEUED',
    });

    eventBus.publish(TOPICS.PAYMENT, EVENTS.PAYMENT_COMPLETED, {
      paymentId, bookingId, transactionId: payment.transaction_id,
    });
    eventBus.publish(TOPICS.BOOKING, EVENTS.BOOKING_CONFIRMED, {
      bookingId, pnr: booking.pnr, userId: req.user.userId,
    });

    res.status(201).json({
      message: 'Payment successful, booking confirmed!',
      pnr: booking.pnr,
      bookingId,
      paymentId,
      transactionId: payment.transaction_id,
      totalCharged: parseFloat(booking.total_fare),
      currency: 'INR',
      pointsEarned: Math.floor(parseFloat(booking.total_fare) / 100),
      loyalty: { tier: user?.loyalty_tier, total: user?.loyalty_points },
      requiresMFA: fraudResult.requiresMFA,
    });
  } catch (err) {
    console.error('[Payment] Error:', err);
    res.status(500).json({ error: 'PAYMENT_FAILED', message: err.message });
  }
});

// GET /api/payments/:bookingId
router.get('/:bookingId', authenticate, (req, res) => {
  const payment = db.memFindOne('payments', p => p.booking_id === req.params.bookingId);
  if (!payment) return res.status(404).json({ error: 'PAYMENT_NOT_FOUND' });
  res.json(payment);
});

module.exports = router;
