'use strict';

/**
 * Distributed Cache Service — Redis implementation
 * Falls back to an in-memory Map structure if Redis is disabled or unavailable.
 */
const { createClient } = require('redis');

class CacheService {
  constructor() {
    this.useRedis = process.env.NODE_ENV === 'production' || process.env.REDIS_URL;
    this.defaultTtl = 300; // seconds

    if (this.useRedis) {
      this.client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
      this.client.on('error', (err) => console.error('[Redis] Client Error', err));
      this.client.connect().then(() => console.log('[Redis] Connected')).catch(console.error);
    } else {
      console.log('[Cache] Using In-Memory Fallback structure');
      this.store = new Map();
      setInterval(() => this._sweep(), 60000);
    }

    this.hits = 0;
    this.misses = 0;
  }

  async set(key, value, ttl = this.defaultTtl) {
    if (this.useRedis) {
      await this.client.set(key, JSON.stringify(value), { EX: ttl > 0 ? ttl : undefined });
      return true;
    }
    this.store.set(key, { value, expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : Infinity });
    return true;
  }

  async get(key) {
    if (this.useRedis) {
      const val = await this.client.get(key);
      if (!val) { this.misses++; return null; }
      this.hits++;
      return JSON.parse(val);
    }
    const entry = this.store.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      if (entry) this.store.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.value;
  }

  async setnx(key, value, ttl = this.defaultTtl) {
    if (this.useRedis) {
      const res = await this.client.set(key, JSON.stringify(value), { NX: true, EX: ttl > 0 ? ttl : undefined });
      return !!res;
    }
    if (await this.exists(key)) return false;
    await this.set(key, value, ttl);
    return true;
  }

  async del(...keys) {
    if (!keys.length) return 0;
    if (this.useRedis) return await this.client.del(keys);
    let count = 0;
    for (const key of keys) { if (this.store.delete(key)) count++; }
    return count;
  }

  async exists(key) {
    if (this.useRedis) return (await this.client.exists(key)) > 0;
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return false; }
    return true;
  }

  async incr(key, amount = 1) {
    if (this.useRedis) {
      if (amount === 1) return await this.client.incr(key);
      return await this.client.incrBy(key, amount);
    }
    const current = (await this.get(key)) || 0;
    const next = current + amount;
    await this.set(key, next);
    return next;
  }

  async ttl(key) {
    if (this.useRedis) return await this.client.ttl(key);
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (entry.expiresAt === Infinity) return -1;
    return Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
  }

  async mget(keys) {
    if (!keys.length) return [];
    if (this.useRedis) {
      const vals = await this.client.mGet(keys);
      return vals.map(v => v ? JSON.parse(v) : null);
    }
    return Promise.all(keys.map(k => this.get(k)));
  }

  async delPattern(pattern) {
    if (this.useRedis) {
      let count = 0;
      for await (const key of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        await this.client.del(key);
        count++;
      }
      return count;
    }
    const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
    let count = 0;
    for (const key of this.store.keys()) {
      if (regex.test(key)) { this.store.delete(key); count++; }
    }
    return count;
  }

  async getOrSet(key, fn, ttl = this.defaultTtl) {
    const cached = await this.get(key);
    if (cached !== null) return cached;
    const value = await fn();
    if (value !== null && value !== undefined) await this.set(key, value, ttl);
    return value;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.useRedis ? 'External Redis' : this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? ((this.hits / total) * 100).toFixed(1) + '%' : '0%',
    };
  }

  _sweep() {
    if (this.useRedis) return;
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }
}

const cache = new CacheService();
module.exports = cache;
