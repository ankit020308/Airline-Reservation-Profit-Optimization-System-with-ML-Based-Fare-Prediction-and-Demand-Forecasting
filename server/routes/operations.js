'use strict';

const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { processFlightDelay, processFlightCancellation, simulateRandomEvent } = require('../services/simulation/opsSimulator');
const db = require('../db');
const router = express.Router();

// POST /api/operations/delay — Trigger flight delay
router.post('/delay', authenticate, requireRole('admin'), async (req, res) => {
  const { flightId, delayMinutes, reason } = req.body;
  if (!flightId || !delayMinutes) return res.status(400).json({ error: 'FLIGHT_ID_DELAY_REQUIRED' });

  const result = await processFlightDelay({ flightId, delayMinutes, reason });
  res.json(result);
});

// POST /api/operations/cancel — Cancel flight
router.post('/cancel', authenticate, requireRole('admin'), async (req, res) => {
  const { flightId, reason } = req.body;
  if (!flightId) return res.status(400).json({ error: 'FLIGHT_ID_REQUIRED' });

  const result = await processFlightCancellation({ flightId, reason });
  res.json(result);
});

// POST /api/operations/simulate — Trigger random event (demo)
router.post('/simulate', authenticate, requireRole('admin'), async (req, res) => {
  const result = await simulateRandomEvent();
  res.json(result || { message: 'No flights in active window for simulation' });
});

// GET /api/operations/events
router.get('/events', authenticate, (req, res) => {
  const events = db.memFind('flight_operations', () => true)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);
  res.json({ events, total: events.length });
});

// GET /api/operations/live — Live flight status board
router.get('/live', (req, res) => {
  const flights = db.memFind('flights', f =>
    ['SCHEDULED', 'DELAYED', 'BOARDING'].includes(f.status) &&
    new Date(f.departure_time) > Date.now() - 3600000 &&
    new Date(f.departure_time) < Date.now() + 6 * 3600000
  ).map(f => {
    const airline = db.memFindOne('tenants', t => t.tenant_id === f.tenant_id);
    return {
      flightId: f.flight_id,
      flightNumber: f.flight_number,
      airline: airline?.airline_name,
      airlineLogo: airline?.logo_url,
      origin: f.origin_iata,
      destination: f.dest_iata,
      scheduledDeparture: f.departure_time,
      estimatedDeparture: f.delay_minutes
        ? new Date(new Date(f.departure_time).getTime() + f.delay_minutes * 60000).toISOString()
        : f.departure_time,
      status: f.status,
      delayMinutes: f.delay_minutes || 0,
    };
  });

  res.json({ flights, timestamp: new Date().toISOString() });
});

module.exports = router;
