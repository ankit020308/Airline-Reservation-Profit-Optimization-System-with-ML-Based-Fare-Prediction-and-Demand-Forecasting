'use strict';

const express = require('express');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { calculateFare } = require('../services/pricing/pricingEngine');
const { predictFare } = require('../services/ai/aiService');
const db = require('../db');
const router = express.Router();

// GET /api/pricing/calculate
router.get('/calculate', optionalAuth, async (req, res) => {
  const { flightId, cabin = 'ECONOMY', pax = 1 } = req.query;
  if (!flightId) return res.status(400).json({ error: 'FLIGHT_ID_REQUIRED' });

  const fare = await calculateFare({
    flightId, cabinClass: cabin, paxCount: parseInt(pax),
    userId: req.user?.userId, loyaltyTier: req.user?.tier,
  });
  if (!fare) return res.status(404).json({ error: 'FLIGHT_NOT_FOUND' });
  res.json(fare);
});

// GET /api/pricing/predict/:flightId
router.get('/predict/:flightId', optionalAuth, async (req, res) => {
  const { flightId } = req.params;
  const { cabin = 'ECONOMY' } = req.query;

  const fare = await calculateFare({ flightId, cabinClass: cabin, paxCount: 1 });
  if (!fare) return res.status(404).json({ error: 'FLIGHT_NOT_FOUND' });

  const inv = db.memFindOne('flight_inventory', i => i.flight_id === flightId && i.cabin_class === cabin);
  const prediction = predictFare({
    flightId, cabinClass: cabin,
    currentFare: fare.perPassengerFare,
    baseFare: inv ? parseFloat(inv.base_fare) : fare.perPassengerFare,
  });

  res.json({ fare, prediction });
});

// GET /api/pricing/fare-history/:flightId — Simulated fare history
router.get('/fare-history/:flightId', (req, res) => {
  const { flightId } = req.params;
  const inv = db.memFindOne('flight_inventory', i => i.flight_id === flightId && i.cabin_class === 'ECONOMY');
  if (!inv) return res.status(404).json({ error: 'NOT_FOUND' });

  const base = parseFloat(inv.base_fare);
  const now = Date.now();
  const history = Array.from({ length: 30 }, (_, i) => {
    const noise = (Math.random() - 0.5) * base * 0.2;
    const trend = base * (0.7 + 0.3 * (i / 30)); // rising trend
    return {
      date: new Date(now - (30 - i) * 86400000).toISOString().split('T')[0],
      fare: Math.round(trend + noise),
    };
  });

  res.json({ flightId, cabin: 'ECONOMY', history });
});

module.exports = router;
