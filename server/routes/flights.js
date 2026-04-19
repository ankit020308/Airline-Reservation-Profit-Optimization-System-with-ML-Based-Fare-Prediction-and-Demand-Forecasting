'use strict';

const express = require('express');
const db = require('../db');
const cache = require('../services/cache/cacheService');
const { calculateFare, recordSearch } = require('../services/pricing/pricingEngine');
const { trackBehavior } = require('../services/recommendation/recommendationEngine');
const { optionalAuth } = require('../middleware/auth');
const { forecastDemand } = require('../services/ai/aiService');
const router = express.Router();

// GET /api/flights/search
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const { origin, dest, date, cabin = 'ECONOMY', pax = 1, page = 1, limit = 20 } = req.query;
    if (!origin || !dest) return res.status(400).json({ error: 'ORIGIN_DEST_REQUIRED' });

    const cacheKey = `search:${origin}:${dest}:${date || 'any'}:${cabin}:${pax}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      // Track search behavior async
      if (req.user) trackBehavior({ userId: req.user.userId, eventType: 'search_performed', data: { origin, dest, date, cabin, pax } });
      return res.json({ ...cached, fromCache: true });
    }

    // Query flights
    let flights = db.memFind('flights', f => {
      if (f.status === 'CANCELLED') return false;
      if (f.origin_iata !== origin.toUpperCase()) return false;
      if (f.dest_iata !== dest.toUpperCase()) return false;
      if (date) {
        const depDate = f.departure_time.split('T')[0];
        if (depDate !== date) return false;
      } else {
        if (new Date(f.departure_time) < new Date()) return false;
      }
      return true;
    });

    if (flights.length === 0) {
      return res.json({
        searchId: require('uuid').v4(), results: [], total: 0,
        message: 'No flights found for this route and date',
      });
    }

    // Price each flight
    const userId = req.user?.userId;
    const loyaltyTier = req.user?.tier || 'BLUE';
    const paxCount = parseInt(pax);

    const results = [];
    for (const flight of flights.slice(0, 50)) {
      recordSearch(flight.flight_id);

      const fare = await calculateFare({
        flightId: flight.flight_id,
        cabinClass: cabin,
        paxCount,
        userId,
        loyaltyTier,
      });
      if (!fare) continue;
      if (fare.seatsAvailable < paxCount) continue;

      const airline = db.memFindOne('tenants', t => t.tenant_id === flight.tenant_id);
      const depTime = new Date(flight.departure_time);
      const arrTime = new Date(flight.arrival_time);

      results.push({
        flightId: flight.flight_id,
        tenantId: flight.tenant_id,
        airline: airline?.airline_name || 'SkyAir',
        airlineCode: airline?.iata_code || 'SK',
        airlineLogo: airline?.logo_url || '✈️',
        flightNumber: flight.flight_number,
        aircraft: flight.aircraft_type,
        origin: flight.origin_iata,
        destination: flight.dest_iata,
        departure: flight.departure_time,
        arrival: flight.arrival_time,
        departureTime: depTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        arrivalTime: arrTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        duration: `${Math.floor(flight.duration_minutes / 60)}h ${flight.duration_minutes % 60}m`,
        durationMinutes: flight.duration_minutes,
        stops: flight.stops,
        status: flight.status,
        delayMinutes: flight.delay_minutes || 0,
        cabin,
        seatsAvailable: fare.seatsAvailable,
        perPassengerFare: fare.perPassengerFare,
        totalFare: fare.totalFare,
        currency: fare.currency,
        fareBasis: fare.fareBucket,
        fareBucketLabel: fare.fareBucketLabel,
        refundable: fare.refundable,
        changeable: fare.changeable,
        loadFactor: fare.currentLoadFactor,
        priceGuaranteeId: fare.priceGuaranteeId,
        validUntil: fare.validUntil,
        mlScore: Math.random() * 0.3 + 0.6, // placeholder for ML ranking
      });
    }

    // Sort by fare + mlScore
    results.sort((a, b) => a.totalFare - b.totalFare);

    // Demand forecast
    const demand = forecastDemand({
      originIata: origin.toUpperCase(),
      destIata: dest.toUpperCase(),
      travelDate: date || new Date().toISOString().split('T')[0],
    });

    const response = {
      searchId: require('uuid').v4(),
      origin: origin.toUpperCase(),
      destination: dest.toUpperCase(),
      date,
      cabin,
      pax: paxCount,
      results: results.slice((page - 1) * limit, page * limit),
      total: results.length,
      page: parseInt(page),
      limit: parseInt(limit),
      demandInsight: demand,
      cachedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };

    cache.set(cacheKey, response, 300); // 5-min cache
    if (req.user) trackBehavior({ userId: req.user.userId, eventType: 'search_performed', data: { origin, dest, date, cabin, pax } });

    res.json(response);
  } catch (err) {
    console.error('[Flights] Search error:', err);
    res.status(500).json({ error: 'SEARCH_FAILED', message: err.message });
  }
});

// GET /api/flights/:flightId
router.get('/:flightId', optionalAuth, async (req, res) => {
  const { flightId } = req.params;
  const { cabin = 'ECONOMY', pax = 1 } = req.query;

  const flight = db.memFindOne('flights', f => f.flight_id === flightId);
  if (!flight) return res.status(404).json({ error: 'FLIGHT_NOT_FOUND' });

  const airline = db.memFindOne('tenants', t => t.tenant_id === flight.tenant_id);

  // All cabin fares
  const cabins = ['ECONOMY', 'BUSINESS', 'FIRST'];
  const faresByClass = {};
  for (const c of cabins) {
    const fare = await calculateFare({
      flightId,
      cabinClass: c,
      paxCount: parseInt(pax),
      userId: req.user?.userId,
      loyaltyTier: req.user?.tier,
    });
    if (fare) faresByClass[c] = fare;
  }

  // Track view
  if (req.user) {
    trackBehavior({ userId: req.user.userId, eventType: 'flight_viewed', data: { flightId, cabin } });
  }

  res.json({
    flightId: flight.flight_id,
    flightNumber: flight.flight_number,
    airline: airline?.airline_name,
    airlineLogo: airline?.logo_url,
    origin: flight.origin_iata,
    destination: flight.dest_iata,
    departure: flight.departure_time,
    arrival: flight.arrival_time,
    durationMinutes: flight.duration_minutes,
    aircraft: flight.aircraft_type,
    status: flight.status,
    delayMinutes: flight.delay_minutes,
    faresByClass,
  });
});

// GET /api/flights/:flightId/availability
router.get('/:flightId/availability', (req, res) => {
  const { flightId } = req.params;
  const inventories = db.memFind('flight_inventory', i => i.flight_id === flightId);
  if (!inventories.length) return res.status(404).json({ error: 'FLIGHT_NOT_FOUND' });

  res.json(inventories.map(inv => ({
    cabin: inv.cabin_class,
    available: inv.actual_capacity - inv.allocated_seats - inv.locked_seats,
    loadFactor: parseFloat(((inv.allocated_seats + inv.locked_seats) / inv.actual_capacity).toFixed(2)),
  })));
});

// GET /api/flights — Live flight board
router.get('/', (req, res) => {
  const { status, limit = 30 } = req.query;
  let flights = db.memFind('flights', f =>
    !status || f.status === status.toUpperCase()
  ).slice(0, parseInt(limit));

  flights = flights.map(f => {
    const airline = db.memFindOne('tenants', t => t.tenant_id === f.tenant_id);
    return {
      flightId: f.flight_id,
      flightNumber: f.flight_number,
      airline: airline?.airline_name,
      origin: f.origin_iata,
      destination: f.dest_iata,
      departure: f.departure_time,
      status: f.status,
      delayMinutes: f.delay_minutes,
    };
  });

  res.json({ flights, total: flights.length });
});

module.exports = router;
