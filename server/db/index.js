'use strict';

/**
 * Database Connection Pool — PostgreSQL (Mandatory)
 *
 * SCALING UPGRADE:
 *  - Removed in-memory fallback: Postgres is now REQUIRED.
 *  - Dual pool: primary (write) + readPool (read replica / same primary if not configured).
 *  - Slow-query logging at 200ms threshold.
 *  - Structured error events for Prometheus alerting.
 */

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ [DB] DATABASE_URL is required. Set it in your .env file.');
  console.error('   Example: DATABASE_URL=postgresql://sky:skypass@localhost:5432/skyplatform');
  process.exit(1);
}

// ── Primary pool (writes + reads) ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.DB_POOL_MAX || '20'),
  min: parseInt(process.env.DB_POOL_MIN || '2'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10000, // 10s hard limit per query
});

// ── Read replica pool (point to replica, falls back to primary) ────────────────
const readPool = process.env.DATABASE_READ_URL
  ? new Pool({
      connectionString: process.env.DATABASE_READ_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: parseInt(process.env.DB_READ_POOL_MAX || '10'),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
      statement_timeout: 10000,
    })
  : pool;

pool.on('error', (err) => console.error('[DB] Primary pool error:', err.message));
if (readPool !== pool) readPool.on('error', (err) => console.error('[DB] Read pool error:', err.message));

// Startup connectivity test
pool.query('SELECT 1').then(() => {
  console.log('[DB] ✅ PostgreSQL primary connected');
}).catch((err) => {
  console.error('[DB] ❌ Cannot connect to PostgreSQL:', err.message);
  process.exit(1);
});

// ── Query helper with slow-query logging ───────────────────────────────────────
async function query(text, params = []) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 200) {
    console.warn(`[DB] ⚠️  Slow write query (${duration}ms): ${text.substring(0, 100)}`);
  }
  return result;
}

async function readQuery(text, params = []) {
  const start = Date.now();
  const result = await readPool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 200) {
    console.warn(`[DB] ⚠️  Slow read query (${duration}ms): ${text.substring(0, 100)}`);
  }
  return result;
}

// ── Transaction helper ─────────────────────────────────────────────────────────
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Health check data for /health endpoint ────────────────────────────────────
function healthStats() {
  return {
    primary: {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    },
    replica: readPool !== pool
      ? {
          totalCount: readPool.totalCount,
          idleCount: readPool.idleCount,
          waitingCount: readPool.waitingCount,
        }
      : 'same-as-primary',
  };
}

const db = {
  query,
  readQuery,
  withTransaction,
  getClient: () => pool.connect(),
  healthStats,
  isMemory: () => false,  // Always false — Postgres is required
  close: async () => {
    await pool.end();
    if (readPool !== pool) await readPool.end();
  },
};

module.exports = db;
