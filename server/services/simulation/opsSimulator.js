'use strict';

/**
 * Operations Simulator — Flight delay/cancellation cascades, auto-rebooking
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../../db');
const { eventBus, TOPICS, EVENTS } = require('../events/eventBus');
const { generatePNR } = require('../../db/seed');
const cache = require('../cache/cacheService');

// ── Process Flight Delay Event ────────────────────────────────────────────────
async function processFlightDelay({ flightId, delayMinutes, reason = 'OPERATIONAL', triggeredBy }) {
  const flight = db.memFindOne('flights', f => f.flight_id === flightId);
  if (!flight) return { success: false, reason: 'FLIGHT_NOT_FOUND' };

  const originalDep = new Date(flight.departure_time);
  const newDep = new Date(originalDep.getTime() + delayMinutes * 60000);

  // Update flight
  flight.status = 'DELAYED';
  flight.delay_minutes = delayMinutes;
  const newDepStr = newDep.toISOString();

  // Log operation
  const opsEvent = {
    ops_event_id: uuidv4(),
    flight_id: flightId,
    event_type: 'DELAYED',
    original_departure: originalDep.toISOString(),
    new_departure: newDepStr,
    delay_minutes: delayMinutes,
    reason,
    affected_pax_count: 0,
    rebooking_triggered: false,
  };
  db.memInsert('flight_operations', opsEvent);

  // Find affected bookings
  const affectedBookings = db.memFind('bookings',
    b => b.flight_id === flightId && ['CONFIRMED', 'HOLD'].includes(b.status));

  opsEvent.affected_pax_count = affectedBookings.length;

  // Publish event
  eventBus.publish(TOPICS.FLIGHT_OPS, EVENTS.FLIGHT_DELAYED, {
    flightId,
    flightNumber: flight.flight_number,
    originalDeparture: originalDep.toISOString(),
    newDeparture: newDepStr,
    delayMinutes,
    affectedPaxCount: affectedBookings.length,
    reason,
  });

  // Find connection passengers at risk (delay > 90 min)
  let autoRebookCount = 0;
  if (delayMinutes >= 90 && affectedBookings.length > 0) {
    opsEvent.rebooking_triggered = true;
    autoRebookCount = await triggerAutoRebooking(affectedBookings, flight, delayMinutes);
  }

  // Queue notifications for all affected passengers
  for (const booking of affectedBookings) {
    const user = db.memFindOne('users', u => u.user_id === booking.user_id);
    if (user) {
      queueNotification({
        userId: booking.user_id,
        bookingId: booking.booking_id,
        type: 'FLIGHT_DELAYED',
        channel: 'IN_APP',
        subject: `Flight ${flight.flight_number} is delayed`,
        body: `Your flight ${flight.flight_number} is delayed by ${delayMinutes} minutes. New departure: ${newDep.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}. ${delayMinutes >= 240 ? 'You may be eligible for compensation.' : ''}`,
      });
    }
  }

  // Compensation eligibility
  const compensationEligible = reason !== 'WEATHER' && delayMinutes >= 120;

  return {
    success: true,
    opsEventId: opsEvent.ops_event_id,
    affectedBookings: affectedBookings.length,
    autoRebookingEligible: autoRebookCount,
    notificationsQueued: affectedBookings.length,
    compensationEligible,
    compensation: compensationEligible ? getCompensationAmount(delayMinutes, false) : null,
  };
}

// ── Auto-Rebooking Engine ─────────────────────────────────────────────────────
async function triggerAutoRebooking(affectedBookings, originalFlight, delayMinutes) {
  let rebooked = 0;

  for (const booking of affectedBookings) {
    // Find alternative flights on same route
    const alternatives = db.memFind('flights', f =>
      f.origin_iata === originalFlight.origin_iata &&
      f.dest_iata === originalFlight.dest_iata &&
      f.flight_id !== originalFlight.flight_id &&
      f.status === 'SCHEDULED' &&
      new Date(f.departure_time) > new Date() &&
      new Date(f.departure_time) < new Date(Date.now() + 8 * 3600000) // within 8 hrs
    ).slice(0, 3);

    if (alternatives.length === 0) continue;

    // Score alternatives: prefer less delay
    const best = alternatives.sort((a, b) => {
      const aInv = db.memFindOne('flight_inventory',
        i => i.flight_id === a.flight_id && i.cabin_class === booking.cabin_class);
      const bInv = db.memFindOne('flight_inventory',
        i => i.flight_id === b.flight_id && i.cabin_class === booking.cabin_class);
      const aAvail = aInv ? aInv.actual_capacity - aInv.allocated_seats : 0;
      const bAvail = bInv ? bInv.actual_capacity - bInv.allocated_seats : 0;
      return bAvail - aAvail;
    })[0];

    const altInv = db.memFindOne('flight_inventory',
      i => i.flight_id === best.flight_id && i.cabin_class === booking.cabin_class);

    if (!altInv || (altInv.actual_capacity - altInv.allocated_seats) < 1) continue;

    // Create rebook record
    const newBookingId = uuidv4();
    const newPNR = generatePNR();
    db.memInsert('bookings', {
      booking_id: newBookingId,
      pnr: newPNR,
      tenant_id: booking.tenant_id,
      user_id: booking.user_id,
      flight_id: best.flight_id,
      cabin_class: booking.cabin_class,
      status: 'CONFIRMED',
      total_fare: booking.total_fare,
      currency: booking.currency,
      original_booking_id: booking.booking_id,
      metadata: JSON.stringify({ rebookedFrom: booking.pnr, reason: 'AUTO_REBOK_DELAY' }),
      confirmed_at: new Date().toISOString(),
    });

    // Mark original as rebooked
    booking.status = 'REBOOKED';
    booking.cancel_reason = `Auto-rebooked to ${best.flight_number} due to delay`;

    // Deduct one seat from alternative
    altInv.allocated_seats++;

    queueNotification({
      userId: booking.user_id,
      bookingId: newBookingId,
      type: 'REBOOKED',
      channel: 'IN_APP',
      subject: 'Your flight has been rebooked',
      body: `We've rebooked you on flight ${best.flight_number} departing ${new Date(best.departure_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}. New PNR: ${newPNR}. No additional charge.`,
    });

    rebooked++;
  }

  return rebooked;
}

// ── Flight Cancellation ───────────────────────────────────────────────────────
async function processFlightCancellation({ flightId, reason, alternativeFlightIds = [] }) {
  const flight = db.memFindOne('flights', f => f.flight_id === flightId);
  if (!flight) return { success: false };

  flight.status = 'CANCELLED';
  flight.cancellation_reason = reason;

  const affectedBookings = db.memFind('bookings',
    b => b.flight_id === flightId && b.status === 'CONFIRMED');

  // Full refund for all passengers
  for (const booking of affectedBookings) {
    booking.status = 'CANCELLED';
    booking.cancelled_at = new Date().toISOString();
    booking.cancel_reason = `Flight cancelled: ${reason}`;
    booking.refund_amount = booking.total_fare;
    booking.refund_status = 'PROCESSING';

    queueNotification({
      userId: booking.user_id,
      bookingId: booking.booking_id,
      type: 'FLIGHT_CANCELLED',
      channel: 'IN_APP',
      subject: `Flight ${flight.flight_number} cancelled`,
      body: `We're sorry. Flight ${flight.flight_number} has been cancelled. A full refund of ₹${parseFloat(booking.total_fare).toLocaleString('en-IN')} will be processed in 5-7 business days.`,
    });
  }

  eventBus.publish(TOPICS.FLIGHT_OPS, EVENTS.FLIGHT_CANCELLED, {
    flightId,
    flightNumber: flight.flight_number,
    reason,
    affectedBookings: affectedBookings.length,
    alternativeFlights: alternativeFlightIds,
  });

  return { success: true, affectedBookings: affectedBookings.length };
}

// ── Notification Queue Helper ─────────────────────────────────────────────────
function queueNotification({ userId, bookingId, type, channel, subject, body }) {
  db.memInsert('notifications', {
    notification_id: uuidv4(),
    user_id: userId,
    booking_id: bookingId,
    type,
    channel,
    subject,
    body,
    status: 'QUEUED',
  });
}

// ── Compensation Calculator ───────────────────────────────────────────────────
function getCompensationAmount(delayMinutes, isInternational) {
  if (delayMinutes < 120) return { amount: 0, type: 'NONE' };
  if (delayMinutes < 240) {
    return {
      amount: isInternational ? 35000 : 10000,
      type: 'VOUCHER',
      description: `Meal voucher + ₹${isInternational ? '35,000' : '10,000'} compensation`,
      regulation: isInternational ? 'EU261' : 'DGCA',
    };
  }
  return {
    amount: isInternational ? 77500 : 20000,
    type: 'CASH_VOUCHER',
    description: `Full compensation under regulations`,
    regulation: isInternational ? 'EU261' : 'DGCA',
    hotelEligible: true,
  };
}

// ── Simulate Random Ops Event (for demo) ────────────────────────────────────
function simulateRandomEvent() {
  const flights = db.memFind('flights', f =>
    f.status === 'SCHEDULED' &&
    new Date(f.departure_time) > Date.now() &&
    new Date(f.departure_time) < Date.now() + 4 * 3600000
  );

  if (flights.length === 0) return null;

  const flight = flights[Math.floor(Math.random() * flights.length)];
  const roll = Math.random();

  if (roll < 0.15) { // 15% chance of delay
    const delayMin = [30, 45, 60, 90, 120, 180, 240][Math.floor(Math.random() * 7)];
    return processFlightDelay({
      flightId: flight.flight_id,
      delayMinutes: delayMin,
      reason: ['WEATHER', 'TECHNICAL', 'ATC', 'OPERATIONAL'][Math.floor(Math.random() * 4)],
    });
  }
  return null;
}

module.exports = {
  processFlightDelay,
  processFlightCancellation,
  simulateRandomEvent,
  getCompensationAmount,
  queueNotification,
};
