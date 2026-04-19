'use strict';

/**
 * Recommendation Engine
 * Two-stage: Content-based retrieval + collaborative scoring
 */

const db = require('../../db');
const cache = require('../cache/cacheService');

// ── User Profile Builder ───────────────────────────────────────────────────────
function buildUserProfile(userId) {
  const cacheKey = `profile:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const bookings = db.memFind('bookings', b => b.user_id === userId && b.status === 'CONFIRMED');
  const behavior = db.memFind('user_behavior', e => e.user_id === userId);

  // Preferred routes
  const routeCounts = {};
  bookings.forEach(b => {
    const flight = db.memFindOne('flights', f => f.flight_id === b.flight_id);
    if (flight) {
      const route = `${flight.origin_iata}:${flight.dest_iata}`;
      routeCounts[route] = (routeCounts[route] || 0) + 1;
    }
  });

  // Search behavior
  const searchRoutes = {};
  behavior.filter(e => e.event_type === 'search_performed').forEach(e => {
    const data = typeof e.event_data === 'string' ? JSON.parse(e.event_data) : e.event_data;
    const route = `${data.origin}:${data.dest}`;
    searchRoutes[route] = (searchRoutes[route] || 0) + 1;
  });

  // Cabin preference
  const cabinCounts = { ECONOMY: 0, BUSINESS: 0, FIRST: 0 };
  bookings.forEach(b => { cabinCounts[b.cabin_class] = (cabinCounts[b.cabin_class] || 0) + 1; });
  const preferredCabin = Object.entries(cabinCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'ECONOMY';

  const user = db.memFindOne('users', u => u.user_id === userId);
  const userPrefs = typeof user?.preferences === 'string'
    ? JSON.parse(user.preferences || '{}')
    : (user?.preferences || {});

  const profile = {
    userId,
    frequentRoutes: Object.entries(routeCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([route]) => route),
    searchInterests: Object.entries(searchRoutes)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([route]) => route),
    preferredCabin: userPrefs.cabin || preferredCabin,
    loyaltyTier: user?.loyalty_tier || 'BLUE',
    loyaltyPoints: user?.loyalty_points || 0,
    bookingCount: bookings.length,
    avgFare: bookings.length > 0
      ? bookings.reduce((s, b) => s + parseFloat(b.total_fare), 0) / bookings.length
      : 5000,
  };

  cache.set(cacheKey, profile, 3600); // 1-hour cache
  return profile;
}

// ── Content-Based Scoring ─────────────────────────────────────────────────────
function contentScore(flight, inventory, profile) {
  let score = 0;

  // Route familiarity
  const route = `${flight.origin_iata}:${flight.dest_iata}`;
  if (profile.frequentRoutes.includes(route)) score += 30;
  if (profile.searchInterests.includes(route)) score += 15;

  // Cabin match
  const hasPrefCabin = db.memFindOne('flight_inventory',
    i => i.flight_id === flight.flight_id && i.cabin_class === profile.preferredCabin);
  if (hasPrefCabin) score += 20;

  // Price fit
  if (inventory && profile.avgFare > 0) {
    const priceRatio = parseFloat(inventory.base_fare) / profile.avgFare;
    if (priceRatio >= 0.8 && priceRatio <= 1.3) score += 15; // within budget
  }

  // Availability bonus
  if (inventory) {
    const available = inventory.actual_capacity - inventory.allocated_seats;
    if (available > 20) score += 10;
  }

  // Loyalty bonus for premium members
  if (profile.loyaltyTier === 'GOLD' || profile.loyaltyTier === 'PLATINUM') score += 5;

  return score;
}

// ── Collaborative Filter (item-based similarity) ──────────────────────────────
function collaborativeScore(flight, userId) {
  // Find users who booked same origin/destination
  const flight_data = db.memFindOne('flights', f => f.flight_id === flight.flight_id);
  if (!flight_data) return 0;

  const similarBookings = db.memFind('bookings', b =>
    b.user_id !== userId && b.status === 'CONFIRMED');

  let matchCount = 0;
  for (const booking of similarBookings) {
    const bf = db.memFindOne('flights', f => f.flight_id === booking.flight_id);
    if (bf && bf.origin_iata === flight_data.origin_iata && bf.dest_iata === flight_data.dest_iata) {
      matchCount++;
    }
  }

  // Normalize to score (max 25 points)
  return Math.min(25, matchCount * 2);
}

// ── Main: Get Recommendations ─────────────────────────────────────────────────
async function getRecommendations({ userId, originIata, destIata, limit = 10 }) {
  const cacheKey = `recs:${userId}:${originIata || 'any'}:${destIata || 'any'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const profile = buildUserProfile(userId);
  const now = new Date();

  // Candidate flights (Stage 1: retrieval)
  let candidates = db.memFind('flights', f => {
    if (f.status !== 'SCHEDULED') return false;
    if (new Date(f.departure_time) < now) return false;
    if (originIata && f.origin_iata !== originIata) return false;
    if (destIata && f.dest_iata !== destIata) return false;
    return true;
  }).slice(0, 200);

  // Stage 2: rank
  const ranked = candidates.map(flight => {
    const inventory = db.memFindOne('flight_inventory',
      i => i.flight_id === flight.flight_id && i.cabin_class === profile.preferredCabin);
    const cScore = contentScore(flight, inventory, profile);
    const cfScore = collaborativeScore(flight, userId);
    const totalScore = cScore + cfScore;

    return {
      flightId: flight.flight_id,
      flightNumber: flight.flight_number,
      origin: flight.origin_iata,
      destination: flight.dest_iata,
      departure: flight.departure_time,
      cabin: profile.preferredCabin,
      baseFare: inventory ? parseFloat(inventory.base_fare) : null,
      seatsAvailable: inventory
        ? inventory.actual_capacity - inventory.allocated_seats - inventory.locked_seats
        : 0,
      mlScore: parseFloat((totalScore / 100).toFixed(2)),
      reasons: [
        cScore > 20 ? 'Matches your travel history' : null,
        cfScore > 10 ? 'Popular with similar travelers' : null,
        inventory && parseFloat(inventory.base_fare) < profile.avgFare ? 'Within your budget' : null,
      ].filter(Boolean),
    };
  })
  .filter(r => r.seatsAvailable > 0)
  .sort((a, b) => b.mlScore - a.mlScore)
  .slice(0, limit);

  cache.set(cacheKey, ranked, 1800); // 30-min cache
  return ranked;
}

// ── Bundle Recommendations ────────────────────────────────────────────────────
function getBundleRecommendations({ bookingId, userId, cabinClass, totalFare }) {
  const user = db.memFindOne('users', u => u.user_id === userId);
  const tier = user?.loyalty_tier || 'BLUE';
  const bundles = [];

  // Seat upgrade
  if (cabinClass === 'ECONOMY') {
    bundles.push({
      type: 'UPGRADE',
      title: 'Upgrade to Business Class',
      description: 'Lie-flat seats, gourmet meals, priority boarding',
      price: Math.round(totalFare * 2.2),
      icon: '💼',
    });
  }

  // Lounge access
  if (tier === 'GOLD' || tier === 'PLATINUM' || cabinClass === 'BUSINESS') {
    bundles.push({
      type: 'LOUNGE',
      title: 'Airport Lounge Access',
      description: 'Complimentary food, beverages, shower, Wi-Fi',
      price: 1500,
      icon: '🛋️',
    });
  }

  // Travel Insurance
  bundles.push({
    type: 'INSURANCE',
    title: 'Travel Insurance',
    description: 'Medical cover, trip cancellation, baggage loss',
    price: Math.round(totalFare * 0.04),
    icon: '🛡️',
  });

  // Extra baggage
  bundles.push({
    type: 'BAGGAGE',
    title: 'Extra Baggage 15kg',
    description: 'Pre-book and save vs airport rates',
    price: 1200,
    icon: '🧳',
  });

  return bundles;
}

// ── Track Behavior ────────────────────────────────────────────────────────────
function trackBehavior({ userId, eventType, data, sessionId }) {
  db.memInsert('user_behavior', {
    event_id: require('uuid').v4(),
    user_id: userId,
    session_id: sessionId,
    event_type: eventType,
    event_data: JSON.stringify(data),
  });
  // Invalidate user profile cache
  cache.del(`profile:${userId}`);
}

module.exports = {
  getRecommendations,
  getBundleRecommendations,
  buildUserProfile,
  trackBehavior,
};
