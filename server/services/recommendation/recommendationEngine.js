'use strict';

/**
 * Recommendation Engine
 * Phase 1 P0: All DB reads from PostgreSQL; cache layer is async Redis.
 * Two-stage: Content-based retrieval + Collaborative scoring.
 */

const { v4: uuidv4 } = require('uuid');
const db    = require('../../db');
const cache = require('../cache/cacheService');

// ── User Profile Builder ───────────────────────────────────────────────────────
async function buildUserProfile(userId) {
  const cacheKey = `profile:${userId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const [bookingsResult, behaviorResult, userResult] = await Promise.all([
    db.readQuery(
      `SELECT b.cabin_class, b.total_fare, f.origin_iata, f.dest_iata
       FROM bookings b LEFT JOIN flights f ON f.flight_id = b.flight_id
       WHERE b.user_id = $1 AND b.status = 'CONFIRMED'`,
      [userId]
    ),
    db.readQuery(
      `SELECT event_type, event_data FROM user_behavior WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId]
    ),
    db.readQuery('SELECT loyalty_tier, loyalty_points, preferences FROM users WHERE user_id = $1', [userId]),
  ]);

  const bookings  = bookingsResult.rows;
  const behavior  = behaviorResult.rows;
  const user      = userResult.rows[0];

  // Preferred routes from booking history
  const routeCounts = {};
  bookings.forEach(b => {
    if (b.origin_iata && b.dest_iata) {
      const route = `${b.origin_iata}:${b.dest_iata}`;
      routeCounts[route] = (routeCounts[route] || 0) + 1;
    }
  });

  // Search behavior routes
  const searchRoutes = {};
  behavior.filter(e => e.event_type === 'search_performed').forEach(e => {
    const data = typeof e.event_data === 'string' ? JSON.parse(e.event_data || '{}') : (e.event_data || {});
    if (data.origin && data.dest) {
      const route = `${data.origin}:${data.dest}`;
      searchRoutes[route] = (searchRoutes[route] || 0) + 1;
    }
  });

  // Cabin preference
  const cabinCounts = { ECONOMY: 0, BUSINESS: 0, FIRST: 0 };
  bookings.forEach(b => { cabinCounts[b.cabin_class] = (cabinCounts[b.cabin_class] || 0) + 1; });
  const preferredCabin = Object.entries(cabinCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'ECONOMY';

  const userPrefs = typeof user?.preferences === 'string'
    ? JSON.parse(user?.preferences || '{}')
    : (user?.preferences || {});

  const profile = {
    userId,
    frequentRoutes:  Object.entries(routeCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r]) => r),
    searchInterests: Object.entries(searchRoutes).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r]) => r),
    preferredCabin:  userPrefs.cabin || preferredCabin,
    loyaltyTier:     user?.loyalty_tier || 'BLUE',
    loyaltyPoints:   user?.loyalty_points || 0,
    bookingCount:    bookings.length,
    avgFare: bookings.length > 0
      ? bookings.reduce((s, b) => s + parseFloat(b.total_fare), 0) / bookings.length
      : 5000,
  };

  await cache.set(cacheKey, profile, 3600);
  return profile;
}

// ── Collaborative Score ────────────────────────────────────────────────────────
async function collaborativeScore(originIata, destIata, userId) {
  const { rows } = await db.readQuery(
    `SELECT COUNT(*) AS match_count FROM bookings b
     JOIN flights f ON f.flight_id = b.flight_id
     WHERE b.user_id <> $1 AND b.status = 'CONFIRMED'
       AND f.origin_iata = $2 AND f.dest_iata = $3`,
    [userId, originIata, destIata]
  );
  return Math.min(25, parseInt(rows[0]?.match_count || 0) * 2);
}

// ── Main: Get Recommendations ─────────────────────────────────────────────────
async function getRecommendations({ userId, originIata, destIata, limit = 10 }) {
  const cacheKey = `recs:${userId}:${originIata || 'any'}:${destIata || 'any'}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const profile = await buildUserProfile(userId);

  // Stage 1: Candidate retrieval from Postgres
  const params = [];
  let sql = `
    SELECT f.flight_id, f.flight_number, f.origin_iata, f.dest_iata, f.departure_time,
           fi.base_fare, fi.actual_capacity - fi.allocated_seats - fi.locked_seats AS available
    FROM flights f
    JOIN flight_inventory fi ON fi.flight_id = f.flight_id AND fi.cabin_class = $1
    WHERE f.status = 'SCHEDULED' AND f.departure_time > NOW()
  `;
  params.push(profile.preferredCabin);

  if (originIata) { sql += ` AND f.origin_iata = $${params.length + 1}`; params.push(originIata); }
  if (destIata)   { sql += ` AND f.dest_iata   = $${params.length + 1}`; params.push(destIata);   }
  sql += ` ORDER BY f.departure_time LIMIT 200`;

  const { rows: candidates } = await db.readQuery(sql, params);

  // Stage 2: Rank with content + collaborative scores
  const ranked = await Promise.all(candidates.map(async (f) => {
    let score = 0;
    const route = `${f.origin_iata}:${f.dest_iata}`;

    if (profile.frequentRoutes.includes(route))  score += 30;
    if (profile.searchInterests.includes(route)) score += 15;
    if (parseFloat(f.base_fare) / profile.avgFare >= 0.8 && parseFloat(f.base_fare) / profile.avgFare <= 1.3) score += 15;
    if (f.available > 20) score += 10;
    if (profile.loyaltyTier === 'GOLD' || profile.loyaltyTier === 'PLATINUM') score += 5;

    const cfScore = await collaborativeScore(f.origin_iata, f.dest_iata, userId);
    score += cfScore;

    return {
      flightId:       f.flight_id,
      flightNumber:   f.flight_number,
      origin:         f.origin_iata,
      destination:    f.dest_iata,
      departure:      f.departure_time,
      cabin:          profile.preferredCabin,
      baseFare:       parseFloat(f.base_fare),
      seatsAvailable: f.available,
      mlScore:        parseFloat((score / 100).toFixed(2)),
      reasons: [
        score > 40 ? 'Matches your travel history' : null,
        cfScore > 10 ? 'Popular with similar travelers' : null,
        parseFloat(f.base_fare) < profile.avgFare ? 'Within your budget' : null,
      ].filter(Boolean),
    };
  }));

  const result = ranked.filter(r => r.seatsAvailable > 0).sort((a, b) => b.mlScore - a.mlScore).slice(0, limit);
  await cache.set(cacheKey, result, 1800);
  return result;
}

// ── Bundle Recommendations ─────────────────────────────────────────────────────
async function getBundleRecommendations({ bookingId, userId, cabinClass, totalFare }) {
  const { rows } = await db.readQuery(
    'SELECT loyalty_tier FROM users WHERE user_id = $1', [userId]
  );
  const tier = rows[0]?.loyalty_tier || 'BLUE';
  const bundles = [];

  if (cabinClass === 'ECONOMY') {
    bundles.push({ type: 'UPGRADE', title: 'Upgrade to Business Class', description: 'Lie-flat seats, gourmet meals, priority boarding', price: Math.round(totalFare * 2.2), icon: '💼' });
  }
  if (tier === 'GOLD' || tier === 'PLATINUM' || cabinClass === 'BUSINESS') {
    bundles.push({ type: 'LOUNGE', title: 'Airport Lounge Access', description: 'Complimentary food, beverages, shower, Wi-Fi', price: 1500, icon: '🛋️' });
  }
  bundles.push({ type: 'INSURANCE', title: 'Travel Insurance', description: 'Medical cover, trip cancellation, baggage loss', price: Math.round(totalFare * 0.04), icon: '🛡️' });
  bundles.push({ type: 'BAGGAGE', title: 'Extra Baggage 15kg', description: 'Pre-book and save vs airport rates', price: 1200, icon: '🧳' });

  return bundles;
}

// ── Track Behavior ─────────────────────────────────────────────────────────────
function trackBehavior({ userId, eventType, data, sessionId }) {
  // Fire-and-forget insert into Postgres
  db.query(
    `INSERT INTO user_behavior (event_id, user_id, session_id, event_type, event_data)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuidv4(), userId, sessionId || null, eventType, JSON.stringify(data)]
  ).catch(err => console.error('[Rec] trackBehavior error:', err.message));

  // Invalidate user profile cache
  cache.del(`profile:${userId}`).catch(() => {});
}

module.exports = { getRecommendations, getBundleRecommendations, buildUserProfile, trackBehavior };
