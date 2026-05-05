'use strict';

/**
 * Flights Routes
 * Phase 1 P0: All reads from PostgreSQL with caching layer.
 */

const express = require('express');
const db      = require('../db');
const cache   = require('../services/cache/cacheService');
const { calculateFare, recordSearch } = require('../services/pricing/pricingEngine');
const { trackBehavior }               = require('../services/recommendation/recommendationEngine');
const { optionalAuth }                = require('../middleware/auth');
const { forecastDemand }              = require('../services/ai/aiService');
const router = express.Router();

// ── GET /api/flights/search ────────────────────────────────────────────────────
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const { origin, dest, date, cabin = 'ECONOMY', pax = 1, page = 1, limit = 20 } = req.query;
    if (!origin || !dest) return res.status(400).json({ error: 'ORIGIN_DEST_REQUIRED' });

    const cacheKey = `search:${origin}:${dest}:${date || 'any'}:${cabin}:${pax}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      if (req.user) trackBehavior({ userId: req.user.userId, eventType: 'search_performed', data: { origin, dest, date, cabin, pax } });
      return res.json({ ...cached, fromCache: true });
    }

    // Build SQL query
    let sql = `
      SELECT f.*, t.airline_name, t.iata_code AS airline_code, t.logo_url
      FROM flights f
      JOIN tenants t ON t.tenant_id = f.tenant_id
      WHERE f.status <> 'CANCELLED'
        AND f.origin_iata = $1
        AND f.dest_iata   = $2
    `;
    const params = [origin.toUpperCase(), dest.toUpperCase()];

    if (date) {
      sql += ` AND DATE(f.departure_time) = $${params.length + 1}`;
      params.push(date);
    } else {
      sql += ` AND f.departure_time > NOW()`;
    }
    sql += ' ORDER BY f.departure_time LIMIT 50';

    const { rows: flights } = await db.readQuery(sql, params);

    if (!flights.length) {
      return res.json({ searchId: require('uuid').v4(), results: [], total: 0, message: 'No flights found for this route and date' });
    }

    const paxCount = parseInt(pax);
    const results = [];
    for (const flight of flights) {
      recordSearch(flight.flight_id);
      const fare = await calculateFare({
        flightId: flight.flight_id, cabinClass: cabin, paxCount,
        userId: req.user?.userId, loyaltyTier: req.user?.tier || 'BLUE',
      });
      if (!fare || fare.seatsAvailable < paxCount) continue;

      const dep = new Date(flight.departure_time);
      const arr = new Date(flight.arrival_time);
      results.push({
        flightId:         flight.flight_id,
        tenantId:         flight.tenant_id,
        airline:          flight.airline_name,
        airlineCode:      flight.airline_code,
        airlineLogo:      flight.logo_url,
        flightNumber:     flight.flight_number,
        aircraft:         flight.aircraft_type,
        origin:           flight.origin_iata,
        destination:      flight.dest_iata,
        departure:        flight.departure_time,
        arrival:          flight.arrival_time,
        departureTime:    dep.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        arrivalTime:      arr.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        duration:         `${Math.floor(flight.duration_minutes / 60)}h ${flight.duration_minutes % 60}m`,
        durationMinutes:  flight.duration_minutes,
        stops:            flight.stops,
        status:           flight.status,
        delayMinutes:     flight.delay_minutes || 0,
        cabin,
        seatsAvailable:   fare.seatsAvailable,
        perPassengerFare: fare.perPassengerFare,
        totalFare:        fare.totalFare,
        currency:         fare.currency,
        fareBasis:        fare.fareBucket,
        fareBucketLabel:  fare.fareBucketLabel,
        refundable:       fare.refundable,
        changeable:       fare.changeable,
        loadFactor:       fare.currentLoadFactor,
        priceGuaranteeId: fare.priceGuaranteeId,
        validUntil:       fare.validUntil,
        mlScore:          Math.random() * 0.3 + 0.6,
      });
    }

    results.sort((a, b) => a.totalFare - b.totalFare);

    const demand = forecastDemand({
      originIata: origin.toUpperCase(),
      destIata: dest.toUpperCase(),
      travelDate: date || new Date().toISOString().split('T')[0],
    });

    const response = {
      searchId:     require('uuid').v4(),
      origin:       origin.toUpperCase(),
      destination:  dest.toUpperCase(),
      date, cabin,
      pax:          paxCount,
      results:      results.slice((page - 1) * limit, page * limit),
      total:        results.length,
      page:         parseInt(page),
      limit:        parseInt(limit),
      demandInsight: demand,
      cachedAt:     new Date().toISOString(),
      expiresAt:    new Date(Date.now() + 300000).toISOString(),
    };

    await cache.set(cacheKey, response, 300);
    if (req.user) trackBehavior({ userId: req.user.userId, eventType: 'search_performed', data: { origin, dest, date, cabin, pax } });

    res.json(response);
  } catch (err) {
    console.error('[Flights] Search error:', err);
    res.status(500).json({ error: 'SEARCH_FAILED', message: err.message });
  }
});

// ── GET /api/flights — Live flight board ────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, limit = 30 } = req.query;
    let sql = `
      SELECT f.flight_id, f.flight_number, f.origin_iata, f.dest_iata,
             f.departure_time, f.status, f.delay_minutes,
             t.airline_name
      FROM flights f
      JOIN tenants t ON t.tenant_id = f.tenant_id
    `;
    const params = [];
    if (status) {
      sql += ` WHERE f.status = $1`;
      params.push(status.toUpperCase());
    }
    sql += ` ORDER BY f.departure_time LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const { rows } = await db.readQuery(sql, params);
    res.json({ flights: rows.map(f => ({
      flightId:     f.flight_id,
      flightNumber: f.flight_number,
      airline:      f.airline_name,
      origin:       f.origin_iata,
      destination:  f.dest_iata,
      departure:    f.departure_time,
      status:       f.status,
      delayMinutes: f.delay_minutes,
    })), total: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'FLIGHTS_FETCH_FAILED', message: err.message });
  }
});

// ── GET /api/flights/:flightId ─────────────────────────────────────────────────
router.get('/:flightId', optionalAuth, async (req, res) => {
  try {
    const { flightId } = req.params;
    const { cabin = 'ECONOMY', pax = 1 } = req.query;

    const { rows } = await db.readQuery(
      `SELECT f.*, t.airline_name, t.iata_code AS airline_code, t.logo_url
       FROM flights f JOIN tenants t ON t.tenant_id = f.tenant_id
       WHERE f.flight_id = $1`,
      [flightId]
    );
    const flight = rows[0];
    if (!flight) return res.status(404).json({ error: 'FLIGHT_NOT_FOUND' });

    const faresByClass = {};
    for (const c of ['ECONOMY', 'BUSINESS', 'FIRST']) {
      const fare = await calculateFare({
        flightId, cabinClass: c, paxCount: parseInt(pax),
        userId: req.user?.userId, loyaltyTier: req.user?.tier,
      });
      if (fare) faresByClass[c] = fare;
    }

    if (req.user) trackBehavior({ userId: req.user.userId, eventType: 'flight_viewed', data: { flightId, cabin } });

    res.json({
      flightId:        flight.flight_id,
      flightNumber:    flight.flight_number,
      airline:         flight.airline_name,
      airlineLogo:     flight.logo_url,
      origin:          flight.origin_iata,
      destination:     flight.dest_iata,
      departure:       flight.departure_time,
      arrival:         flight.arrival_time,
      durationMinutes: flight.duration_minutes,
      aircraft:        flight.aircraft_type,
      status:          flight.status,
      delayMinutes:    flight.delay_minutes,
      faresByClass,
    });
  } catch (err) {
    res.status(500).json({ error: 'FLIGHT_FETCH_FAILED', message: err.message });
  }
});

// ── GET /api/flights/:flightId/availability ────────────────────────────────────
router.get('/:flightId/availability', async (req, res) => {
  try {
    const { rows } = await db.readQuery(
      `SELECT cabin_class, actual_capacity, allocated_seats, locked_seats
       FROM flight_inventory WHERE flight_id = $1`,
      [req.params.flightId]
    );
    if (!rows.length) return res.status(404).json({ error: 'FLIGHT_NOT_FOUND' });

    res.json(rows.map(inv => ({
      cabin:      inv.cabin_class,
      available:  inv.actual_capacity - inv.allocated_seats - inv.locked_seats,
      loadFactor: parseFloat(((inv.allocated_seats + inv.locked_seats) / inv.actual_capacity).toFixed(2)),
    })));
  } catch (err) {
    res.status(500).json({ error: 'AVAILABILITY_FETCH_FAILED', message: err.message });
  }
});

module.exports = router;
