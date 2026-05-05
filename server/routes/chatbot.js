'use strict';

const express = require('express');
const { processChatMessage } = require('../services/ai/aiService');
const { optionalAuth } = require('../middleware/auth');
const router = express.Router();

// POST /api/chatbot/message
router.post('/message', optionalAuth, async (req, res) => {
  const { message, context = {} } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'MESSAGE_REQUIRED' });

  const response = await processChatMessage({
    message: message.trim(),
    userId: req.user?.userId,
    context,
  });
  res.json(response);
});

// GET /api/chatbot/suggestions — Quick action suggestions
router.get('/suggestions', (req, res) => {
  res.json({
    suggestions: [
      '✈️ Find flights from Delhi to Mumbai',
      '📋 Check my booking status',
      '💰 When is the cheapest time to fly?',
      '🔔 Set a fare alert for me',
      '❓ What documents do I need?',
    ],
  });
});

module.exports = router;
