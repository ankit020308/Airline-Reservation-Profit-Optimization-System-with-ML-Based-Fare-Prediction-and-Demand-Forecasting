'use strict';

/**
 * Zenith Optima — Main Server Entry Point
 *
 * SCALING UPGRADE:
 *  - Socket.io Redis adapter: WebSocket rooms shared across ALL replicas.
 *  - Removed in-memory DB/cache/kafka fallbacks.
 *  - Graceful shutdown with connection drain.
 *  - Request tracing: requestId header on every response.
 *  - Helmet CSP enabled with proper directives.
 */

require('dotenv').config();

const express      = require('express');
const http         = require('http');
const cors         = require('cors');
const helmet       = require('helmet');
const compression  = require('compression');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const { createClient } = require('redis');
const { Server }   = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

// Services
const db           = require('./db');
const { seed }     = require('./db/seed');
const cache        = require('./services/cache/cacheService');
const { eventBus, TOPICS } = require('./services/events/eventBus');
const { startLockExpiryJob } = require('./services/inventory/inventoryService');
const { metricsMiddleware, getMetricsRoute } = require('./middleware/metrics');

// Routes
const authRoutes      = require('./routes/auth');
const flightRoutes    = require('./routes/flights');
const bookingRoutes   = require('./routes/bookings');
const paymentRoutes   = require('./routes/payments');
const pricingRoutes   = require('./routes/pricing');
const recRoutes       = require('./routes/recommendations');
const analyticsRoutes = require('./routes/analytics');
const opsRoutes       = require('./routes/operations');
const chatbotRoutes   = require('./routes/chatbot');

// ── App Setup ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

// ── Middleware Stack ──────────────────────────────────────────────────────────
app.use(metricsMiddleware);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],   // Vanilla JS SPA — tighten when migrating to Next.js
      styleSrc:   ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc:    ["'self'", 'fonts.gstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc:     ["'self'", 'data:', 'blob:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',')
  || ['http://localhost:3000', 'http://localhost:5173'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Structured HTTP logging
app.use(morgan(':method :url :status :response-time ms - :res[content-length] :req[x-request-id]', {
  stream: { write: (msg) => console.log('[HTTP]', msg.trim()) },
  skip: (req) => req.url === '/health',
}));

// Rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_REQUESTS', retryAfter: '15 minutes' },
});
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
});

app.use(globalLimiter);
app.use('/api/auth/login',    strictLimiter);
app.use('/api/auth/register', strictLimiter);
app.use('/api/auth/refresh',  strictLimiter);

// Request ID — propagated to all logs and responses
const { v4: uuidv4 } = require('uuid');
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.get('/api/metrics',           getMetricsRoute);
app.use('/api/auth',              authRoutes);
app.use('/api/flights',           flightRoutes);
app.use('/api/bookings',          bookingRoutes);
app.use('/api/payments',          paymentRoutes);
app.use('/api/pricing',           pricingRoutes);
app.use('/api/recommendations',   recRoutes);
app.use('/api/analytics',         analyticsRoutes);
app.use('/api/operations',        opsRoutes);
app.use('/api/chatbot',           chatbotRoutes);

// ── Health & Status ───────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const [flights, bookings, users] = await Promise.all([
      db.readQuery('SELECT COUNT(*) AS c FROM flights'),
      db.readQuery('SELECT COUNT(*) AS c FROM bookings'),
      db.readQuery('SELECT COUNT(*) AS c FROM users'),
    ]);
    res.json({
      status: 'healthy',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime().toFixed(0) + 's',
      memory: {
        used:  Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB',
      },
      cache: cache.stats(),
      events: eventBus.getMetrics(),
      db: db.healthStats(),
      data: {
        flights:  parseInt(flights.rows[0].c),
        bookings: parseInt(bookings.rows[0].c),
        users:    parseInt(users.rows[0].c),
      },
    });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

app.get('/api/airports', async (req, res) => {
  try {
    const { rows } = await db.readQuery('SELECT * FROM airports ORDER BY city');
    res.json({ airports: rows });
  } catch (err) {
    res.status(500).json({ error: 'AIRPORTS_FETCH_FAILED' });
  }
});

app.get('/api/airlines', async (req, res) => {
  try {
    const { rows } = await db.readQuery('SELECT tenant_id, iata_code, airline_name, logo_url FROM tenants WHERE active = TRUE');
    res.json({ airlines: rows.map(t => ({ tenantId: t.tenant_id, code: t.iata_code, name: t.airline_name, logo: t.logo_url })) });
  } catch (err) {
    res.status(500).json({ error: 'AIRLINES_FETCH_FAILED' });
  }
});

// ── Static Frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../client/src'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
}));

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API_ENDPOINT_NOT_FOUND', path: req.path });
  }
  res.sendFile(path.join(__dirname, '../client/src/index.html'));
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(`[Error] ${req.method} ${req.path} [${req.requestId}]:`, err.message);
  res.status(err.status || 500).json({
    error: err.code || 'INTERNAL_SERVER_ERROR',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
    requestId: req.requestId,
  });
});

// ── WebSocket Setup with Redis Adapter (Multi-Replica Safe) ───────────────────
async function setupSocketIO() {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  const pubClient = createClient({ url: redisUrl });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => console.error('[Socket.io Redis Pub]', err.message));
  subClient.on('error', (err) => console.error('[Socket.io Redis Sub]', err.message));

  await Promise.all([pubClient.connect(), subClient.connect()]);
  console.log('[Socket.io] ✅ Redis adapter connected (multi-replica WebSocket ready)');

  const io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.adapter(createAdapter(pubClient, subClient));

  io.on('connection', (socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    socket.on('subscribe:flight', (flightId) => {
      socket.join(`flight:${flightId}`);
    });

    socket.on('subscribe:user', (userId) => {
      socket.join(`user:${userId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });

  // Bridge event bus → Socket.io real-time push
  eventBus.subscribe(TOPICS.FLIGHT_OPS, async (event) => {
    io.to(`flight:${event.payload.flightId}`).emit('flight:update', {
      type: event.type, ...event.payload,
    });
    io.emit('operations:update', event);
  });

  eventBus.subscribe(TOPICS.BOOKING, async (event) => {
    if (event.payload.userId) {
      io.to(`user:${event.payload.userId}`).emit('booking:update', {
        type: event.type, ...event.payload,
      });
    }
  });

  eventBus.subscribe(TOPICS.INVENTORY, async (event) => {
    io.emit('inventory:update', event);
  });

  return io;
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[Shutdown] ${signal} received — gracefully shutting down...`);
  server.close(async () => {
    try {
      await db.close();
      await cache.client.quit();
      console.log('[Shutdown] ✅ All connections closed');
    } catch (err) {
      console.error('[Shutdown] Error during cleanup:', err.message);
    }
    process.exit(0);
  });
  // Force kill after 10s
  setTimeout(() => {
    console.error('[Shutdown] ❌ Forced exit after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (err) => { console.error('[Uncaught]', err); });
process.on('unhandledRejection', (err) => { console.error('[Unhandled]', err); });

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  console.log('\n🚀 Zenith Optima — Booting intelligent profit optimization engine...\n');

  // Seed PostgreSQL (idempotent — safe to re-run on every boot)
  if (process.env.SKIP_SEED !== 'true') {
    await seed();
  }

  // Wait for Redis to be ready
  await cache.ready();

  // Setup Socket.io with Redis adapter
  await setupSocketIO();

  // Start background jobs
  startLockExpiryJob();
  console.log('[Jobs] ⏰ Seat lock expiry job started (30s interval)');

  // Demo mode simulation
  if (process.env.DEMO_MODE !== 'false') {
    setInterval(async () => {
      try {
        const { simulateRandomEvent } = require('./services/simulation/opsSimulator');
        await simulateRandomEvent();
      } catch (_) {}
    }, 120000);
    console.log('[Sim] 🎭 Demo simulation active (2-min interval)');
  }

  server.listen(PORT, () => {
    console.log(`\n✅ Zenith Optima running on http://localhost:${PORT}`);
    console.log(`   Health:     http://localhost:${PORT}/health`);
    console.log(`   API Base:   http://localhost:${PORT}/api`);
    console.log(`   Frontend:   http://localhost:${PORT}/\n`);
    console.log('─'.repeat(60));
    console.log('  SCALING UPGRADES ACTIVE:');
    console.log('  ✓ PostgreSQL — mandatory, dual pool (write + read)');
    console.log('  ✓ Redis — mandatory, stampede-protected, distributed locks');
    console.log('  ✓ Socket.io — Redis adapter (multi-replica WebSocket sync)');
    console.log('  ✓ JWT — httpOnly cookies + refresh token rotation');
    console.log('  ✓ Auth Middleware — Redis revocation (O(1) across replicas)');
    console.log('  ✓ Rate Limiting — per-route + global limiter');
    console.log('  ✓ Graceful Shutdown — connection drain on SIGTERM');
    console.log('  ✓ CSP Headers — Helmet with proper directives');
    console.log('─'.repeat(60) + '\n');
  });
}

bootstrap().catch((err) => {
  console.error('❌ Bootstrap failed:', err);
  process.exit(1);
});

module.exports = { app };
