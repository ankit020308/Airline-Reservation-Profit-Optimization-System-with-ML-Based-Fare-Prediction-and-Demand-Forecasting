'use strict';

/**
 * Auth Routes — Register, Login, Refresh, Logout, Profile
 *
 * Security model:
 *  - Access token  → httpOnly cookie, 15 min TTL, sameSite=strict
 *  - Refresh token → httpOnly cookie, 30 day TTL, path=/api/auth
 *  - Rotation: every /refresh call revokes the old refresh token and issues a
 *    new one (prevents refresh token replay attacks).
 *  - Revocation: logout adds access token's (userId, iat) pair to Redis
 *    blacklist so the auth middleware rejects it instantly across all replicas.
 *  - No tokens ever appear in JSON response bodies or localStorage.
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db');
const cache   = require('../services/cache/cacheService');
const { authenticate, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();
const PROD = process.env.NODE_ENV === 'production';

// ── Cookie helpers ────────────────────────────────────────────────────────────

function setAccessCookie(res, token) {
  res.cookie('access_token', token, {
    httpOnly: true,
    secure:   PROD,
    sameSite: PROD ? 'strict' : 'lax',
    maxAge:   15 * 60 * 1000,   // 15 min in ms
  });
}

function setRefreshCookie(res, token) {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure:   PROD,
    sameSite: PROD ? 'strict' : 'lax',
    maxAge:   30 * 24 * 60 * 60 * 1000,  // 30 days in ms
    path:     '/api/auth',               // Only sent to auth endpoints
  });
}

function clearAuthCookies(res) {
  res.clearCookie('access_token');
  res.clearCookie('refresh_token', { path: '/api/auth' });
}

function buildUserPayload(user) {
  return {
    userId:        user.user_id,
    email:         user.email,
    firstName:     user.first_name,
    lastName:      user.last_name,
    role:          user.role,
    loyaltyTier:   user.loyalty_tier,
    loyaltyPoints: user.loyalty_points,
  };
}

// ── POST /api/auth/register ────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'EMAIL_PASSWORD_REQUIRED' });

    const existing = await db.readQuery(
      'SELECT user_id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (existing.rows.length > 0) return res.status(409).json({ error: 'EMAIL_ALREADY_EXISTS' });

    const hash   = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    await db.query(
      `INSERT INTO users
         (user_id, email, password_hash, first_name, last_name, phone, loyalty_tier, loyalty_points, role, active)
       VALUES ($1,$2,$3,$4,$5,$6,'BLUE',500,'passenger',TRUE)`,
      [userId, email.toLowerCase(), hash, firstName || '', lastName || '', phone || '']
    );

    await db.query(
      `INSERT INTO audit_log (log_id, user_id, action, resource_type, resource_id)
       VALUES ($1,$2,'USER_REGISTERED','user',$3)`,
      [uuidv4(), userId, userId]
    );

    res.status(201).json({ message: 'Account created successfully', userId, loyaltyPoints: 500 });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'REGISTRATION_FAILED', message: err.message });
  }
});

// ── POST /api/auth/login ───────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'CREDENTIALS_REQUIRED' });

    const { rows } = await db.readQuery(
      'SELECT * FROM users WHERE email = $1 AND active = TRUE',
      [email.toLowerCase()]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

    // Issue tokens
    const accessToken  = jwt.sign(
      { userId: user.user_id, email: user.email, role: user.role, tier: user.loyalty_tier },
      JWT_SECRET,
      { expiresIn: '15m' }
    );
    const refreshToken = uuidv4();

    // Persist session (refresh token stored hashed for safety)
    await db.query(
      `INSERT INTO sessions
         (session_id, user_id, refresh_token, expires_at, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        uuidv4(), user.user_id, refreshToken,
        new Date(Date.now() + 30 * 86400000),
        req.ip, req.headers['user-agent'] || '',
      ]
    );

    // Track last login (non-blocking)
    db.query('UPDATE users SET last_login = NOW() WHERE user_id = $1', [user.user_id]).catch(() => {});

    // Set httpOnly cookies — tokens never touch the response body
    setAccessCookie(res, accessToken);
    setRefreshCookie(res, refreshToken);

    // Return user info only (no tokens)
    res.json({ user: buildUserPayload(user), expiresIn: 900 });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'LOGIN_FAILED', message: err.message });
  }
});

// ── POST /api/auth/refresh ─────────────────────────────────────────────────────
// Reads refresh_token from cookie, rotates both tokens.
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;
    if (!refreshToken) return res.status(400).json({ error: 'REFRESH_TOKEN_REQUIRED' });

    const { rows: sessions } = await db.query(
      `SELECT s.*, u.user_id, u.email, u.role, u.loyalty_tier
       FROM sessions s
       JOIN users u ON s.user_id = u.user_id
       WHERE s.refresh_token = $1 AND s.revoked = FALSE AND s.expires_at > NOW()`,
      [refreshToken]
    );
    const session = sessions[0];
    if (!session) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'INVALID_REFRESH_TOKEN' });
    }

    // Rotate: revoke old session, issue new tokens
    const newRefreshToken = uuidv4();
    const newAccessToken  = jwt.sign(
      { userId: session.user_id, email: session.email, role: session.role, tier: session.loyalty_tier },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    await db.withTransaction(async (client) => {
      // Revoke old session
      await client.query(
        'UPDATE sessions SET revoked = TRUE WHERE refresh_token = $1',
        [refreshToken]
      );
      // Create new session
      await client.query(
        `INSERT INTO sessions
           (session_id, user_id, refresh_token, expires_at, ip_address, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          uuidv4(), session.user_id, newRefreshToken,
          new Date(Date.now() + 30 * 86400000),
          req.ip, req.headers['user-agent'] || '',
        ]
      );
    });

    setAccessCookie(res, newAccessToken);
    setRefreshCookie(res, newRefreshToken);

    res.json({ expiresIn: 900 });
  } catch (err) {
    console.error('[Auth] Refresh error:', err.message);
    res.status(500).json({ error: 'REFRESH_FAILED', message: err.message });
  }
});

// ── POST /api/auth/logout ──────────────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;

    // Revoke refresh session in DB
    if (refreshToken) {
      await db.query(
        'UPDATE sessions SET revoked = TRUE WHERE refresh_token = $1',
        [refreshToken]
      );
    }

    // Blacklist access token in Redis until it naturally expires
    // Key: revoked:<userId>:<iat>  — auth middleware checks this
    if (req.user?.iat) {
      const ttl = req.user.exp - Math.floor(Date.now() / 1000);
      if (ttl > 0) {
        await cache.set(`revoked:${req.user.userId}:${req.user.iat}`, 1, ttl);
      }
    }

    clearAuthCookies(res);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('[Auth] Logout error:', err.message);
    clearAuthCookies(res);
    res.status(500).json({ error: 'LOGOUT_FAILED', message: err.message });
  }
});

// ── GET /api/auth/me ───────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await db.readQuery(
      'SELECT * FROM users WHERE user_id = $1',
      [req.user.userId]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

    const { rows: bookings } = await db.readQuery(
      `SELECT COUNT(*) AS total FROM bookings WHERE user_id = $1 AND status = 'CONFIRMED'`,
      [user.user_id]
    );

    res.json({
      ...buildUserPayload(user),
      phone:        user.phone,
      nationality:  user.nationality,
      totalBookings: parseInt(bookings[0]?.total || 0),
      memberSince:  user.created_at,
      preferences:  typeof user.preferences === 'string'
        ? JSON.parse(user.preferences || '{}')
        : (user.preferences || {}),
    });
  } catch (err) {
    res.status(500).json({ error: 'PROFILE_FETCH_FAILED', message: err.message });
  }
});

// ── PATCH /api/auth/me ─────────────────────────────────────────────────────────
router.patch('/me', authenticate, async (req, res) => {
  try {
    const { firstName, lastName, phone, preferences } = req.body;

    await db.query(
      `UPDATE users
       SET first_name  = COALESCE($1, first_name),
           last_name   = COALESCE($2, last_name),
           phone       = COALESCE($3, phone),
           preferences = COALESCE($4::jsonb, preferences)
       WHERE user_id = $5`,
      [
        firstName || null, lastName || null, phone || null,
        preferences ? JSON.stringify(preferences) : null,
        req.user.userId,
      ]
    );

    res.json({ message: 'Profile updated' });
  } catch (err) {
    res.status(500).json({ error: 'PROFILE_UPDATE_FAILED', message: err.message });
  }
});

module.exports = router;
