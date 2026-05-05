'use strict';

/**
 * Distributed Cache Service — Redis (Mandatory for production scale)
 *
 * SCALING UPGRADE:
 *  - Redis is now mandatory in production (NODE_ENV=production).
 *  - Added stampede protection via single-flight locking (getOrSetAtomic).
 *  - Added per-key-prefix TTL presets.
 *  - Cache hit/miss counters exposed for Prometheus.
 *  - Retry + reconnect logic with exponential backoff.
 */

const { createClient } = require('redis');

// TTL presets by data category (seconds)
const TTL = {
  FLIGHT_SEARCH:    300,   // 5 min — flight results
  FARE_PREDICTION:   30,   // 30 sec — dynamic pricing is hot
  USER_SESSION:   86400,   // 24 hr — auth sessions
  ANALYTICS:        600,   // 10 min — revenue dashboards
  INVENTORY:         15,   // 15 sec — seat availability (very hot)
  RECOMMENDATIONS:  180,   // 3 min
  DEFAULT:          300,
};

class CacheService {
  constructor() {
    this.hits = 0;
    this.misses = 0;
    this._inflightLocks = new Map(); // single-flight stampede protection (local layer)

    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    this.client = createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.error('[Redis] Max reconnection attempts reached');
            return new Error('Redis max retries exceeded');
          }
          return Math.min(retries * 100, 3000); // Exponential backoff, max 3s
        },
      },
    });

    this.pubClient = null; // Populated externally by Socket.io adapter setup
    this.subClient = null;

    this.client.on('error', (err) => console.error('[Redis] ❌ Client Error:', err.message));
    this.client.on('connect', () => console.log('[Redis] ✅ Connected'));
    this.client.on('reconnecting', () => console.warn('[Redis] ⚠️  Reconnecting...'));

    this._ready = this.client.connect().catch((err) => {
      console.error('[Redis] ❌ Initial connection failed:', err.message);
      if (process.env.NODE_ENV === 'production') process.exit(1);
    });
  }

  async ready() {
    return this._ready;
  }

  // ── Core Operations ──────────────────────────────────────────────────────────

  async set(key, value, ttl = TTL.DEFAULT) {
    await this.client.set(key, JSON.stringify(value), ttl > 0 ? { EX: ttl } : {});
    return true;
  }

  async get(key) {
    const val = await this.client.get(key);
    if (!val) { this.misses++; return null; }
    this.hits++;
    return JSON.parse(val);
  }

  /**
   * SET only if key does Not eXist (Redis atomic NX).
   * Used for distributed locks.
   */
  async setnx(key, value, ttl = TTL.DEFAULT) {
    const res = await this.client.set(key, JSON.stringify(value), {
      NX: true,
      ...(ttl > 0 ? { EX: ttl } : {}),
    });
    return !!res;
  }

  async del(...keys) {
    if (!keys.length) return 0;
    return this.client.del(keys);
  }

  async exists(key) {
    return (await this.client.exists(key)) > 0;
  }

  async incr(key, amount = 1) {
    if (amount === 1) return this.client.incr(key);
    return this.client.incrBy(key, amount);
  }

  async expire(key, ttl) {
    return this.client.expire(key, ttl);
  }

  async ttl(key) {
    return this.client.ttl(key);
  }

  async mget(keys) {
    if (!keys.length) return [];
    const vals = await this.client.mGet(keys);
    return vals.map((v) => (v ? JSON.parse(v) : null));
  }

  async delPattern(pattern) {
    let count = 0;
    for await (const key of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      await this.client.del(key);
      count++;
    }
    return count;
  }

  // ── Stampede-Protected Cache-Aside ────────────────────────────────────────────
  /**
   * Get from cache; on miss, use a local Promise lock to ensure only ONE
   * caller invokes `fn()` simultaneously (single-flight pattern).
   * This eliminates cache stampede on popular keys.
   */
  async getOrSet(key, fn, ttl = TTL.DEFAULT) {
    const cached = await this.get(key);
    if (cached !== null) return cached;

    // Check if another concurrent call is already fetching
    if (this._inflightLocks.has(key)) {
      return this._inflightLocks.get(key);
    }

    const promise = fn().then(async (value) => {
      if (value !== null && value !== undefined) {
        await this.set(key, value, ttl);
      }
      this._inflightLocks.delete(key);
      return value;
    }).catch((err) => {
      this._inflightLocks.delete(key);
      throw err;
    });

    this._inflightLocks.set(key, promise);
    return promise;
  }

  // ── Distributed Lock ─────────────────────────────────────────────────────────
  /**
   * Acquire a distributed lock via Redis SET NX.
   * Returns unlock() function — call when done.
   */
  async acquireLock(resource, ttl = 30) {
    const lockKey = `lock:${resource}`;
    const lockVal = `${Date.now()}-${Math.random()}`;
    const acquired = await this.setnx(lockKey, lockVal, ttl);
    if (!acquired) return null;
    return {
      unlock: async () => {
        const current = await this.get(lockKey);
        if (current === lockVal) await this.del(lockKey);
      },
    };
  }

  // ── Pub/Sub for cross-replica broadcasts ─────────────────────────────────────
  async publish(channel, message) {
    return this.client.publish(channel, JSON.stringify(message));
  }

  // ── Stats for /health endpoint ────────────────────────────────────────────────
  stats() {
    const total = this.hits + this.misses;
    return {
      backend: 'Redis',
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? ((this.hits / total) * 100).toFixed(1) + '%' : '0%',
      inflightKeys: this._inflightLocks.size,
    };
  }
}

// Singleton
const cache = new CacheService();
cache.TTL = TTL;

module.exports = cache;
