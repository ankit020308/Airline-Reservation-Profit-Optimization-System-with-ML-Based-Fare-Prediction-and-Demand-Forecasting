'use strict';

/**
 * Auth Middleware — JWT verification
 *
 * SCALING UPGRADE:
 *  - Reads token from httpOnly cookie (primary) OR Authorization header (API clients).
 *  - Session revocation check against Redis (O(1), works across all replicas).
 *  - No more in-memory session lookup.
 */

const jwt   = require('jsonwebtoken');
const cache = require('../services/cache/cacheService');

const JWT_SECRET = process.env.JWT_SECRET || 'skyplatform-super-secret-dev-key-2026';

/**
 * Extract JWT from request.
 * Priority: 1. httpOnly cookie, 2. Authorization: Bearer header.
 */
function extractToken(req) {
  if (req.cookies?.access_token) return req.cookies.access_token;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

async function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check Redis revocation list (replaces in-memory session check)
    const revoked = await cache.exists(`revoked:${decoded.userId}:${decoded.iat}`);
    if (revoked) {
      return res.status(401).json({ error: 'SESSION_REVOKED' });
    }

    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'TOKEN_EXPIRED', message: 'Please refresh your session' });
    }
    return res.status(401).json({ error: 'INVALID_TOKEN', message: err.message });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'FORBIDDEN', required: roles, got: req.user.role });
    }
    next();
  };
}

function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (_) { /* non-blocking */ }
  }
  next();
}

module.exports = { authenticate, requireRole, optionalAuth, JWT_SECRET };
