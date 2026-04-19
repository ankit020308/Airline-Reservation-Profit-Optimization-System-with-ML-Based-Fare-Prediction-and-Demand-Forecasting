'use strict';

/**
 * Dynamic Pricing Engine
 * Implements: 6-factor fare multiplier composition, fare bucket yield management,
 * EMSR-b allocation, A/B test variant application, competitor shadow pricing.
 */

const db = require('../../db');
const cache = require('../cache/cacheService');
const { eventBus, TOPICS, EVENTS } = require('../events/eventBus');

// ── Fare Bucket Definitions ────────────────────────────────────────────────────
const FARE_BUCKETS = {
  ECONOMY: [
    { code: 'Y', label: 'Full Flex Economy',    mult: 1.00, refundable: true,  changeable: true  },
    { code: 'B', label: 'Economy Flex',          mult: 0.85, refundable: true,  changeable: true  },
    { code: 'M', label: 'Economy Semi-Flex',     mult: 0.70, refundable: false, changeable: true  },
    { code: 'H', label: 'Economy Restricted',    mult: 0.60, refundable: false, changeable: false },
    { code: 'K', label: 'Economy Deep-Sale',     mult: 0.45, refundable: false, changeable: false },
    { code: 'L', label: 'Lowest Fare',           mult: 0.30, refundable: false, changeable: false },
  ],
  BUSINESS: [
    { code: 'J', label: 'Full Flex Business',   mult: 1.00, refundable: true,  changeable: true  },
    { code: 'C', label: 'Business Flex',         mult: 0.88, refundable: true,  changeable: true  },
    { code: 'D', label: 'Business Saver',        mult: 0.72, refundable: false, changeable: true  },
    { code: 'I', label: 'Business Sale',         mult: 0.58, refundable: false, changeable: false },
  ],
  FIRST: [
    { code: 'F', label: 'First Class Full',     mult: 1.00, refundable: true,  changeable: true  },
    { code: 'A', label: 'First Saver',           mult: 0.82, refundable: true,  changeable: true  },
  ],
};

// Temporal multipliers [day_of_week][hour_of_day]  (0=Sun,...,6=Sat)
const TEMPORAL_TABLE = {
  0: { 6: 1.15, 9: 1.10, 12: 1.00, 17: 1.20, 20: 1.05, default: 1.00 }, // Sun
  1: { 6: 0.90, 9: 1.00, 12: 0.95, 17: 1.05, 20: 0.95, default: 0.95 }, // Mon
  2: { 6: 0.88, 9: 0.92, 12: 0.90, 17: 0.95, 20: 0.88, default: 0.90 }, // Tue — cheapest
  3: { 6: 0.90, 9: 0.95, 12: 0.95, 17: 1.00, 20: 0.92, default: 0.92 }, // Wed
  4: { 6: 1.00, 9: 1.05, 12: 1.08, 17: 1.15, 20: 1.10, default: 1.05 }, // Thu
  5: { 6: 1.20, 9: 1.25, 12: 1.20, 17: 1.30, 20: 1.25, default: 1.22 }, // Fri — peak
  6: { 6: 1.10, 9: 1.15, 12: 1.10, 17: 1.12, 20: 1.08, default: 1.10 }, // Sat
};

function getTemporalFactor(departureTime) {
  const d = new Date(departureTime);
  const dow = d.getDay();
  const hour = d.getHours();
  const dayTable = TEMPORAL_TABLE[dow] || {};
  // Find closest hour
  const hours = Object.keys(dayTable).filter(k => k !== 'default').map(Number).sort((a, b) => a - b);
  let closest = hours[0];
  for (const h of hours) {
    if (Math.abs(h - hour) < Math.abs(closest - hour)) closest = h;
  }
  return dayTable[closest] || dayTable.default || 1.0;
}

// ── Search Velocity Tracker ──────────────────────────────────────────────────────
const searchVelocity = new Map(); // flightId → [timestamps]

function recordSearch(flightId) {
  const now = Date.now();
  const arr = searchVelocity.get(flightId) || [];
  arr.push(now);
  // Keep only last 60 minutes
  const cutoff = now - 3600000;
  const filtered = arr.filter(t => t > cutoff);
  searchVelocity.set(flightId, filtered);
}

function getVelocityFactor(flightId) {
  const arr = searchVelocity.get(flightId) || [];
  // Baseline: 10 searches/hr is normal
  const rate = arr.length;
  const ratio = rate / 10;
  // Clamp multiplier: 1.0 (slow) to 1.40 (very hot)
  return Math.min(1.40, Math.max(1.0, 1 + 0.3 * (ratio - 1)));
}

// ── Simulated Competitor Prices ───────────────────────────────────────────────
function getCompetitorFactor(baseFare, cabinClass) {
  // Simulate competitor price as ±15% of base fare (random per call)
  const competitorMedian = baseFare * (0.90 + Math.random() * 0.25);
  return baseFare > competitorMedian * 1.10 ? 0.95 : 1.02;
}

// ── Load Factor ───────────────────────────────────────────────────────────────
function getLoadFactor(inventory) {
  if (!inventory) return 0.5;
  const { allocated_seats, locked_seats, actual_capacity } = inventory;
  return (allocated_seats + locked_seats) / actual_capacity;
}

function getDemandFactor(loadFactor) {
  if (loadFactor < 0.30) return 0.85;      // promote empty flights
  if (loadFactor < 0.70) return 1.00;      // base
  if (loadFactor < 0.90) return 1.20;      // scarcity premium
  return 1.50;                              // last seats premium
}

// ── A/B Test Bucket ──────────────────────────────────────────────────────────
function getABBucket(userId) {
  if (!userId) return 'control';
  // Deterministic: bucket based on userId hash
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) & 0xffffffff;
  }
  const bucket = Math.abs(hash) % 100;
  if (bucket < 33) return 'control';
  if (bucket < 66) return 'variant_a';
  return 'variant_b';
}

function getPersonalizationFactor(userId, abBucket, loyaltyTier) {
  const tierBonus = { PLATINUM: 0.95, GOLD: 0.97, SILVER: 0.99, BLUE: 1.00 };
  const loyaltyFactor = tierBonus[loyaltyTier] || 1.00;
  const abFactor = abBucket === 'variant_a' ? 1.05 : 1.00;
  return loyaltyFactor * abFactor;
}

// ── Time-to-Departure Factor (sigmoid curve) ───────────────────────────────────
function getTimeFactor(departureTime) {
  const d = Math.max(0, (new Date(departureTime) - Date.now()) / 86400000);
  // Sigmoid: flat until d=30, then sharp rise to 1.8x as d→0
  return 1.0 + 0.8 / (1 + Math.exp(-0.15 * (30 - d)));
}

// ── EMSR-b Fare Bucket Selector ───────────────────────────────────────────────
function selectFareBucket(cabinClass, loadFactor) {
  const buckets = FARE_BUCKETS[cabinClass] || FARE_BUCKETS.ECONOMY;
  // Higher load factor → push into higher fare buckets
  if (loadFactor < 0.20) return buckets[buckets.length - 1];      // L — deep sale
  if (loadFactor < 0.40) return buckets[Math.min(4, buckets.length - 1)];
  if (loadFactor < 0.60) return buckets[Math.min(3, buckets.length - 1)]; // H
  if (loadFactor < 0.75) return buckets[2]; // M
  if (loadFactor < 0.88) return buckets[1]; // B/C
  return buckets[0];                         // Y/J — full flex only
}

// ── Core: Calculate Fare ───────────────────────────────────────────────────────
async function calculateFare({ flightId, cabinClass, paxCount = 1, userId, loyaltyTier = 'BLUE' }) {
  const cacheKey = `fare:${flightId}:${cabinClass}:${userId || 'anon'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Get inventory
  const inventory = db.memFindOne('flight_inventory',
    i => i.flight_id === flightId && i.cabin_class === cabinClass);
  const flight = db.memFindOne('flights', f => f.flight_id === flightId);

  if (!inventory || !flight) return null;

  const baseFare = parseFloat(inventory.base_fare);
  const loadFactor = getLoadFactor(inventory);
  const fareBucket = selectFareBucket(cabinClass, loadFactor);

  // Apply bucket multiplier to base
  const bucketAdjustedBase = baseFare * fareBucket.mult;

  // Record this view for velocity
  recordSearch(flightId);

  // Calculate multipliers
  const timeFactor       = getTimeFactor(flight.departure_time);
  const demandFactor     = getDemandFactor(loadFactor);
  const velocityFactor   = getVelocityFactor(flightId);
  const temporalFactor   = getTemporalFactor(flight.departure_time);
  const compFactor       = getCompetitorFactor(bucketAdjustedBase, cabinClass);
  const abBucket         = getABBucket(userId);
  const personalization  = getPersonalizationFactor(userId, abBucket, loyaltyTier);

  const finalFare = Math.round(
    bucketAdjustedBase *
    timeFactor * demandFactor * velocityFactor *
    temporalFactor * compFactor * personalization
  );

  // Round to nearest 9 (psychological pricing)
  const roundedFare = Math.floor(finalFare / 10) * 10 + 9;
  const totalFare = roundedFare * paxCount;

  // Cost floor (never below 0.25× base)
  const costFloor = baseFare * 0.25;
  const safeFare = Math.max(roundedFare, costFloor);

  const result = {
    flightId,
    cabinClass,
    baseFare,
    fareBucket: fareBucket.code,
    fareBucketLabel: fareBucket.label,
    refundable: fareBucket.refundable,
    changeable: fareBucket.changeable,
    perPassengerFare: safeFare,
    totalFare: safeFare * paxCount,
    currency: 'INR',
    multipliers: {
      timeToDeparture:   parseFloat(timeFactor.toFixed(3)),
      loadFactor:        parseFloat(demandFactor.toFixed(3)),
      demandVelocity:    parseFloat(velocityFactor.toFixed(3)),
      temporal:          parseFloat(temporalFactor.toFixed(3)),
      competitor:        parseFloat(compFactor.toFixed(3)),
      personalization:   parseFloat(personalization.toFixed(3)),
    },
    currentLoadFactor: parseFloat(loadFactor.toFixed(2)),
    seatsAvailable: Math.max(0, inventory.actual_capacity - inventory.allocated_seats - inventory.locked_seats),
    abTestBucket: abBucket,
    validUntil: new Date(Date.now() + 5 * 60000).toISOString(), // 5-min price lock
    priceGuaranteeId: require('uuid').v4(),
  };

  cache.set(cacheKey, result, 60); // 60-second cache
  return result;
}

// ── Bulk pricing for search results ──────────────────────────────────────────
async function priceFlight(flight, cabinClass, paxCount, userId, loyaltyTier) {
  const fare = await calculateFare({
    flightId: flight.flight_id,
    cabinClass,
    paxCount,
    userId,
    loyaltyTier,
  });
  return fare;
}

module.exports = { calculateFare, priceFlight, FARE_BUCKETS, recordSearch, getLoadFactor };
