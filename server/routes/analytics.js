'use strict';

const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { getRevenueAnalytics, getBookingFunnel } = require('../services/analytics/analyticsService');
const { getAnomalyLog } = require('../services/ai/aiService');
const { eventBus } = require('../services/events/eventBus');
const cache = require('../services/cache/cacheService');
const db = require('../db');
const router = express.Router();

// GET /api/analytics/revenue (admin only)
router.get('/revenue', authenticate, requireRole('admin'), async (req, res) => {
  const data = await getRevenueAnalytics();
  res.json(data);
});

// GET /api/analytics/funnel
router.get('/funnel', authenticate, requireRole('admin'), (req, res) => {
  res.json(getBookingFunnel());
});

// GET /api/analytics/anomalies
router.get('/anomalies', authenticate, requireRole('admin'), (req, res) => {
  res.json({ anomalies: getAnomalyLog(50) });
});

// GET /api/analytics/events
router.get('/events', authenticate, requireRole('admin'), (req, res) => {
  res.json(eventBus.getMetrics());
});

// GET /api/analytics/cache
router.get('/cache', authenticate, requireRole('admin'), (req, res) => {
  res.json(cache.stats());
});

// GET /api/analytics/operations
router.get('/operations', authenticate, requireRole('admin'), (req, res) => {
  const ops = db.memFind('flight_operations', () => true).slice(0, 50);
  res.json({ operations: ops, total: ops.length });
});

// GET /api/analytics/notifications
router.get('/notifications', authenticate, (req, res) => {
  const notifications = db.memFind('notifications',
    n => req.user.role === 'admin' || n.user_id === req.user.userId
  ).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20);
  res.json({ notifications });
});

module.exports = router;
