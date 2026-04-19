'use strict';

/**
 * Database Connection Pool
 * Uses pg (PostgreSQL) with in-memory fallback store for dev/demo without a DB
 */

const { Pool } = require('pg');

// ── In-memory store (SQLite-like fallback when no Postgres available) ──────────
const memStore = {
  users: [],
  sessions: [],
  flights: [],
  flight_inventory: [],
  seat_locks: [],
  bookings: [],
  booking_passengers: [],
  payments: [],
  notifications: [],
  user_behavior: [],
  flight_operations: [],
  fare_alerts: [],
  coupons: [],
  audit_log: [],
  tenants: [],
  airports: [],
  ab_tests: [],
};

let useMemory = true;
let pool = null;

if (process.env.DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
    pool.on('error', (err) => {
      console.error('[DB] Pool error:', err.message);
    });
    useMemory = false;
    console.log('[DB] Connected to PostgreSQL');
  } catch (e) {
    console.warn('[DB] PostgreSQL unavailable, using in-memory store');
  }
}

/**
 * Execute a query against PostgreSQL or the in-memory store
 * For in-memory mode, only a subset of queries are emulated.
 * The services directly use the `db` object methods.
 */
const db = {
  query: async (text, params = []) => {
    if (useMemory) {
      // Basic passthrough for memory mode – full emulation handled per service
      return { rows: [], rowCount: 0 };
    }
    const start = Date.now();
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 500) {
      console.warn(`[DB] Slow query (${duration}ms):`, text.substring(0, 80));
    }
    return result;
  },

  getClient: async () => {
    if (useMemory) throw new Error('Transactions not available in memory mode');
    return pool.connect();
  },

  // ── In-memory CRUD helpers (used when no PostgreSQL) ──────────────────────

  mem: memStore,
  isMemory: () => useMemory,

  memInsert: (table, row) => {
    row.created_at = row.created_at || new Date().toISOString();
    memStore[table] = memStore[table] || [];
    memStore[table].push(row);
    return row;
  },

  memFind: (table, predicate) => {
    return (memStore[table] || []).filter(predicate);
  },

  memFindOne: (table, predicate) => {
    return (memStore[table] || []).find(predicate) || null;
  },

  memUpdate: (table, predicate, updates) => {
    let updated = null;
    memStore[table] = (memStore[table] || []).map(row => {
      if (predicate(row)) {
        Object.assign(row, updates, { updated_at: new Date().toISOString() });
        updated = row;
        return row;
      }
      return row;
    });
    return updated;
  },

  memDelete: (table, predicate) => {
    const before = (memStore[table] || []).length;
    memStore[table] = (memStore[table] || []).filter(r => !predicate(r));
    return before - memStore[table].length;
  },

  close: async () => {
    if (pool) await pool.end();
  },
};

module.exports = db;
