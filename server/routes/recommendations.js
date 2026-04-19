'use strict';

const express = require('express');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { getRecommendations, getBundleRecommendations } = require('../services/recommendation/recommendationEngine');
const router = express.Router();

// GET /api/recommendations — Personalized flight recommendations  
router.get('/', optionalAuth, async (req, res) => {
  const { origin, dest, limit = 10 } = req.query;
  const userId = req.user?.userId || 'anonymous';

  const recs = await getRecommendations({ userId, originIata: origin, destIata: dest, limit: parseInt(limit) });
  res.json({ recommendations: recs, userId, total: recs.length });
});

// GET /api/recommendations/bundles/:bookingId
router.get('/bundles/:bookingId', authenticate, (req, res) => {
  const bundles = getBundleRecommendations({
    bookingId: req.params.bookingId,
    userId: req.user.userId,
    cabinClass: req.query.cabin || 'ECONOMY',
    totalFare: parseFloat(req.query.fare || 5000),
  });
  res.json({ bundles });
});

module.exports = router;
