'use strict';

/**
 * Auth Routes — Register, Login, Refresh, Logout, Profile
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticate, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'skyplatform-refresh-secret-2026';

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'EMAIL_PASSWORD_REQUIRED' });

    const existing = db.memFindOne('users', u => u.email === email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'EMAIL_ALREADY_EXISTS' });

    const hash = await bcrypt.hash(password, 10);
    const user = {
      user_id: uuidv4(),
      email: email.toLowerCase(),
      password_hash: hash,
      first_name: firstName || '',
      last_name: lastName || '',
      phone: phone || '',
      loyalty_tier: 'BLUE',
      loyalty_points: 500, // welcome bonus
      role: 'passenger',
      active: true,
    };
    db.memInsert('users', user);

    // Audit
    db.memInsert('audit_log', {
      log_id: uuidv4(), user_id: user.user_id,
      action: 'USER_REGISTERED', resource_type: 'user', resource_id: user.user_id,
    });

    res.status(201).json({
      message: 'Account created successfully',
      userId: user.user_id,
      loyaltyPoints: user.loyalty_points,
    });
  } catch (err) {
    res.status(500).json({ error: 'REGISTRATION_FAILED', message: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'CREDENTIALS_REQUIRED' });

    const user = db.memFindOne('users', u => u.email === email.toLowerCase() && u.active);
    if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

    // Issue tokens
    const accessToken = jwt.sign(
      { userId: user.user_id, email: user.email, role: user.role, tier: user.loyalty_tier },
      JWT_SECRET,
      { expiresIn: '15m' }
    );
    const refreshToken = uuidv4();

    // Store session
    db.memInsert('sessions', {
      session_id: uuidv4(),
      user_id: user.user_id,
      refresh_token: refreshToken,
      expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      ip_address: req.ip,
      revoked: false,
    });

    user.last_login = new Date().toISOString();

    res.json({
      accessToken,
      refreshToken,
      expiresIn: 900,
      user: {
        userId: user.user_id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        loyaltyTier: user.loyalty_tier,
        loyaltyPoints: user.loyalty_points,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'LOGIN_FAILED', message: err.message });
  }
});

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'REFRESH_TOKEN_REQUIRED' });

  const session = db.memFindOne('sessions',
    s => s.refresh_token === refreshToken && !s.revoked && new Date(s.expires_at) > new Date());

  if (!session) return res.status(401).json({ error: 'INVALID_REFRESH_TOKEN' });

  const user = db.memFindOne('users', u => u.user_id === session.user_id);
  if (!user) return res.status(401).json({ error: 'USER_NOT_FOUND' });

  const accessToken = jwt.sign(
    { userId: user.user_id, email: user.email, role: user.role, tier: user.loyalty_tier },
    JWT_SECRET,
    { expiresIn: '15m' }
  );

  res.json({ accessToken, expiresIn: 900 });
});

// POST /api/auth/logout
router.post('/logout', authenticate, (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    db.memUpdate('sessions', s => s.refresh_token === refreshToken, { revoked: true });
  }
  res.json({ message: 'Logged out successfully' });
});

// GET /api/auth/me — Current user profile
router.get('/me', authenticate, (req, res) => {
  const user = db.memFindOne('users', u => u.user_id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

  const bookings = db.memFind('bookings', b =>
    b.user_id === user.user_id && b.status === 'CONFIRMED').length;

  res.json({
    userId: user.user_id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    phone: user.phone,
    nationality: user.nationality,
    loyaltyTier: user.loyalty_tier,
    loyaltyPoints: user.loyalty_points,
    role: user.role,
    totalBookings: bookings,
    memberSince: user.created_at,
    preferences: typeof user.preferences === 'string'
      ? JSON.parse(user.preferences || '{}')
      : (user.preferences || {}),
  });
});

// PATCH /api/auth/me — Update profile
router.patch('/me', authenticate, (req, res) => {
  const { firstName, lastName, phone, preferences } = req.body;
  const user = db.memFindOne('users', u => u.user_id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

  if (firstName) user.first_name = firstName;
  if (lastName) user.last_name = lastName;
  if (phone) user.phone = phone;
  if (preferences) user.preferences = JSON.stringify(preferences);

  res.json({ message: 'Profile updated', user: { firstName: user.first_name, lastName: user.last_name } });
});

module.exports = router;
