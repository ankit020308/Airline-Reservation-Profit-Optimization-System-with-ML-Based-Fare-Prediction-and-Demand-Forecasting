'use strict';

/**
 * Fraud Detection Service
 * Real-time scoring with rule-based signals + risk engine
 */

const db = require('../../db');
const cache = require('../cache/cacheService');

// Risk signal weights
const SIGNALS = {
  IP_VELOCITY:      { weight: 25, desc: 'Multiple cards from same IP' },
  CARD_VELOCITY:    { weight: 30, desc: 'Same card, multiple users' },
  ROUTE_ANOMALY:    { weight: 20, desc: 'Booking/IP country mismatch' },
  LARGE_AMOUNT:     { weight: 15, desc: 'Unusually high transaction' },
  NEW_USER:         { weight: 10, desc: 'No booking history' },
  LAST_MIN_BOOKING: { weight: 15, desc: 'High-value last-minute booking' },
  RAPID_RETRY:      { weight: 20, desc: 'Multiple payment attempts' },
};

// IP velocity tracking
const ipAttempts = new Map();

function recordIPAttempt(ip) {
  const now = Date.now();
  const arr = ipAttempts.get(ip) || [];
  arr.push(now);
  const filtered = arr.filter(t => t > now - 3600000);
  ipAttempts.set(ip, filtered);
  return filtered.length;
}

function scoreFraud({ userId, amount, ipAddress, paymentMethod, flightInfo }) {
  const signals = [];
  let score = 0;

  // 1. IP velocity
  const ipCount = recordIPAttempt(ipAddress);
  if (ipCount > 10) {
    score += SIGNALS.IP_VELOCITY.weight;
    signals.push('HIGH_IP_VELOCITY');
  }

  // 2. New user with high amount
  const userBookings = db.memFind('bookings', b => b.user_id === userId);
  if (userBookings.length === 0) {
    score += SIGNALS.NEW_USER.weight;
    signals.push('NEW_USER');
  }

  // 3. Large transaction
  if (amount > 50000) {
    score += SIGNALS.LARGE_AMOUNT.weight;
    signals.push('LARGE_TRANSACTION');
  } else if (amount > 25000) {
    score += SIGNALS.LARGE_AMOUNT.weight * 0.5;
  }

  // 4. Last-minute high value
  if (flightInfo && amount > 20000) {
    const daysToFlight = (new Date(flightInfo.departure) - Date.now()) / 86400000;
    if (daysToFlight < 2) {
      score += SIGNALS.LAST_MIN_BOOKING.weight;
      signals.push('LAST_MINUTE_HIGH_VALUE');
    }
  }

  // 5. Rapid retry (cache-based)
  const retryKey = `fraud:retry:${userId}`;
  const retries = cache.incr(retryKey);
  if (retries === 1) cache.set(retryKey, 1, 300); // 5-min window
  if (retries > 3) {
    score += SIGNALS.RAPID_RETRY.weight;
    signals.push('RAPID_PAYMENT_RETRY');
  }

  // Normalize
  score = Math.min(100, score);

  // Decision
  let decision, requiresMFA;
  if (score < 30) {
    decision = 'APPROVE';
    requiresMFA = false;
  } else if (score < 70) {
    decision = 'REVIEW_3DS';
    requiresMFA = true;
  } else {
    decision = 'HOLD';
    requiresMFA = true;
  }

  return { score, signals, decision, requiresMFA };
}

module.exports = { scoreFraud };
