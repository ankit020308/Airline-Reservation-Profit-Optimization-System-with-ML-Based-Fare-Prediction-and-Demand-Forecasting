'use strict';

/**
 * Inventory Service
 * Phase 1 P0: Distributed seat locking with PostgreSQL + Redis.
 * Optimistic concurrency via Postgres version column.
 */

const { v4: uuidv4 } = require('uuid');
const db    = require('../../db');
const cache = require('../cache/cacheService');
const { eventBus, TOPICS, EVENTS } = require('../events/eventBus');

const LOCK_TTL_SECONDS = 600; // 10 minutes

// ── Overbooking Model ────────────────────────────────────────────────────────
function getOverbookingCapacity(physicalSeats, route) {
  const noShowRates = {
    domestic:      { mu: 0.07, sigma: 0.02 },
    international: { mu: 0.05, sigma: 0.015 },
  };
  const { mu, sigma } = noShowRates[route] || noShowRates.domestic;
  const safeOBRate = Math.max(0, mu - 2 * sigma);
  return Math.floor(physicalSeats * (1 + safeOBRate));
}

// ── Acquire Distributed Seat Lock ─────────────────────────────────────────────
async function lockSeats({ flightId, cabinClass, count, bookingId, sessionId, lockType = 'BOOKING' }) {
  const lockToken = uuidv4();
  const lockKey   = `lock:seats:${flightId}:${cabinClass}:${lockToken}`;

  // Redis advisory lock (non-blocking, best-effort)
  await cache.setnx(lockKey, sessionId, LOCK_TTL_SECONDS);

  // Postgres optimistic concurrency: check & increment locked_seats atomically
  const expiresAt = new Date(Date.now() + LOCK_TTL_SECONDS * 1000);

  const { rows } = await db.query(
    `UPDATE flight_inventory
     SET locked_seats = locked_seats + $1,
         version      = version + 1
     WHERE flight_id  = $2
       AND cabin_class = $3
       AND (actual_capacity - allocated_seats - locked_seats) >= $1
     RETURNING *`,
    [count, flightId, cabinClass]
  );

  if (!rows.length) {
    // Check why it failed
    const { rows: inv } = await db.readQuery(
      `SELECT actual_capacity - allocated_seats - locked_seats AS available
       FROM flight_inventory WHERE flight_id = $1 AND cabin_class = $2`,
      [flightId, cabinClass]
    );
    await cache.del(lockKey);
    const available = inv[0]?.available ?? 0;
    return {
      success: false,
      reason: available <= 0 ? 'SOLD_OUT' : 'INSUFFICIENT_SEATS',
      availableCount: available,
    };
  }

  const inv = rows[0];

  // Persist lock record
  const lockId = uuidv4();
  await db.query(
    `INSERT INTO seat_locks (lock_id, flight_id, cabin_class, count, booking_id,
       session_id, lock_token, lock_type, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [lockId, flightId, cabinClass, count, bookingId, sessionId, lockToken, lockType, expiresAt]
  );

  eventBus.publish(TOPICS.INVENTORY, EVENTS.SEAT_LOCKED, {
    lockId, flightId, cabinClass, count, bookingId, expiresAt: expiresAt.toISOString(), ttl: LOCK_TTL_SECONDS,
  });

  const newAvailable = inv.actual_capacity - inv.allocated_seats - inv.locked_seats;
  if (newAvailable <= 5) {
    eventBus.publish(TOPICS.INVENTORY, EVENTS.INVENTORY_LOW, {
      flightId, cabinClass, remaining: newAvailable,
      alertLevel: newAvailable === 0 ? 'CRITICAL' : 'WARNING',
    });
  }

  return {
    success: true, lockId, lockToken, count,
    expiresAt: expiresAt.toISOString(), seatsRemaining: newAvailable,
  };
}

// ── Release Seat Lock ─────────────────────────────────────────────────────────
async function releaseSeats({ lockId, lockToken, reason = 'MANUAL' }) {
  const { rows } = await db.query(
    `UPDATE seat_locks SET released = TRUE
     WHERE lock_id = $1 AND released = FALSE
     RETURNING *`,
    [lockId]
  );
  const lock = rows[0];
  if (!lock) return { success: false, reason: 'LOCK_NOT_FOUND' };

  // Return seats to inventory
  await db.query(
    `UPDATE flight_inventory
     SET locked_seats = GREATEST(0, locked_seats - $1), version = version + 1
     WHERE flight_id = $2 AND cabin_class = $3`,
    [lock.count, lock.flight_id, lock.cabin_class]
  );

  await cache.del(`lock:seats:${lock.flight_id}:${lock.cabin_class}:${lock.lock_token}`);

  eventBus.publish(TOPICS.INVENTORY, EVENTS.SEAT_RELEASED, {
    lockId, flightId: lock.flight_id, cabinClass: lock.cabin_class, count: lock.count, reason,
  });

  return { success: true };
}

// ── Finalize Seats (on payment confirmed) ─────────────────────────────────────
async function finalizeSeats({ lockId, bookingId }) {
  const { rows } = await db.query(
    `UPDATE seat_locks SET released = TRUE, booking_id = $1
     WHERE lock_id = $2 AND released = FALSE
     RETURNING *`,
    [bookingId, lockId]
  );
  const lock = rows[0];
  if (!lock) return { success: false, reason: 'LOCK_NOT_FOUND' };

  // Convert lock → allocated
  await db.query(
    `UPDATE flight_inventory
     SET locked_seats    = GREATEST(0, locked_seats - $1),
         allocated_seats = allocated_seats + $1,
         version         = version + 1
     WHERE flight_id = $2 AND cabin_class = $3`,
    [lock.count, lock.flight_id, lock.cabin_class]
  );

  return { success: true };
}

// ── Check Availability ─────────────────────────────────────────────────────────
async function checkAvailability(flightId, cabinClass, count = 1) {
  const { rows } = await db.readQuery(
    `SELECT actual_capacity - allocated_seats - locked_seats AS available,
            overbooking_pct,
            ROUND((allocated_seats + locked_seats)::numeric / NULLIF(actual_capacity,0), 2) AS load_factor
     FROM flight_inventory WHERE flight_id = $1 AND cabin_class = $2`,
    [flightId, cabinClass]
  );
  const inv = rows[0];
  if (!inv) return { available: false, reason: 'NOT_FOUND' };
  return {
    available:      inv.available >= count,
    availableCount: inv.available,
    loadFactor:     parseFloat(inv.load_factor),
    overbookingPct: inv.overbooking_pct,
  };
}

// ── Background: Expire Stale Locks (Postgres-based) ───────────────────────────
function startLockExpiryJob() {
  setInterval(async () => {
    try {
      // Find expired, unreleased locks
      const { rows: staleLocks } = await db.query(
        `UPDATE seat_locks SET released = TRUE
         WHERE released = FALSE AND expires_at < NOW()
         RETURNING *`
      );
      for (const lock of staleLocks) {
        // Return locked seats
        await db.query(
          `UPDATE flight_inventory
           SET locked_seats = GREATEST(0, locked_seats - $1), version = version + 1
           WHERE flight_id = $2 AND cabin_class = $3`,
          [lock.count, lock.flight_id, lock.cabin_class]
        );
        console.log(`[Inventory] ⏰ Expired lock ${lock.lock_id} released (${lock.count} seats)`);
        eventBus.publish(TOPICS.INVENTORY, EVENTS.SEAT_RELEASED, {
          lockId: lock.lock_id, flightId: lock.flight_id,
          cabinClass: lock.cabin_class, count: lock.count, reason: 'TIMEOUT',
        });
      }
      if (staleLocks.length > 0) {
        console.log(`[Inventory] Expired ${staleLocks.length} stale lock(s)`);
      }
    } catch (err) {
      console.error('[Inventory] Lock expiry job error:', err.message);
    }
  }, 30000);
}

module.exports = { lockSeats, releaseSeats, finalizeSeats, checkAvailability, startLockExpiryJob, getOverbookingCapacity };
