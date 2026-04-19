'use strict';

/**
 * Zenith Optima — Main Server Entry Point
 * Airline Reservation Profit Optimization System
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
const { Server }   = require('socket.io');

// Services
const db           = require('./db');
const { seed }     = require('./db/seed');
const cache        = require('./services/cache/cacheService');
const { eventBus, TOPICS, EVENTS } = require('./services/events/eventBus');
const { startLockExpiryJob } = require('./services/inventory/inventoryService');
const { metricsMiddleware, getMetricsRoute } = require('./middleware/metrics');

// Routes
const authRoutes    = require('./routes/auth');
const flightRoutes  = require('./routes/flights');
const bookingRoutes = require('./routes/bookings');
const paymentRoutes = require('./routes/payments');
const pricingRoutes = require('./routes/pricing');
const recRoutes     = require('./routes/recommendations');
const analyticsRoutes = require('./routes/analytics');
const opsRoutes     = require('./routes/operations');
const chatbotRoutes = require('./routes/chatbot');

// ── App Setup ─────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3000;

// ── Middleware Stack ──────────────────────────────────────────────────────────
app.use(metricsMiddleware);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for dev (enable in prod with proper directives)
  crossOriginEmbedderPolicy: false,
}));

// CORS — allow frontend
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
}));

// Compression
app.use(compression());

// Request parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Structured logging
app.use(morgan(':method :url :status :response-time ms - :res[content-length]', {
  stream: { write: (msg) => console.log('[HTTP]', msg.trim()) },
  skip: (req) => req.url === '/health',
}));

// Rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  message: { error: 'TOO_MANY_REQUESTS', retryAfter: '15 minutes' },
});
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
});

app.use(globalLimiter);
app.use('/api/auth/login', strictLimiter);
app.use('/api/auth/register', strictLimiter);

// ── Request ID ────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.requestId = require('uuid').v4();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.get('/api/metrics', getMetricsRoute);
app.use('/api/auth',            authRoutes);
app.use('/api/flights',         flightRoutes);
app.use('/api/bookings',        bookingRoutes);
app.use('/api/payments',        paymentRoutes);
app.use('/api/pricing',         pricingRoutes);
app.use('/api/recommendations', recRoutes);
app.use('/api/analytics',       analyticsRoutes);
app.use('/api/operations',      opsRoutes);
app.use('/api/chatbot',         chatbotRoutes);

// ── Health & Status ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
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
    data: {
      flights:  db.mem.flights?.length  || 0,
      bookings: db.mem.bookings?.length || 0,
      users:    db.mem.users?.length    || 0,
    },
  });
});

app.get('/api/airports', (req, res) => {
  res.json({ airports: db.mem.airports || [] });
});

app.get('/api/airlines', (req, res) => {
  res.json({ airlines: db.mem.tenants?.map(t => ({
    tenantId: t.tenant_id, code: t.iata_code, name: t.airline_name, logo: t.logo_url,
  })) || [] });
});

// ── Static Frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../client/src')));

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API_ENDPOINT_NOT_FOUND', path: req.path });
  }
  res.sendFile(path.join(__dirname, '../client/src/index.html'));
});

// ── Error Handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[Error] ${req.method} ${req.path}:`, err.message);
  res.status(err.status || 500).json({
    error: err.code || 'INTERNAL_SERVER_ERROR',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
    requestId: req.requestId,
  });
});

// ── WebSocket: Real-Time Updates ─────────────────────────────────────────────
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

// Bridge event bus to Socket.io for real-time push
eventBus.subscribe(TOPICS.FLIGHT_OPS, async (event) => {
  io.to(`flight:${event.payload.flightId}`).emit('flight:update', {
    type: event.type,
    ...event.payload,
  });
  // Broadcast to all for live board
  io.emit('operations:update', event);
});

eventBus.subscribe(TOPICS.BOOKING, async (event) => {
  if (event.payload.userId) {
    io.to(`user:${event.payload.userId}`).emit('booking:update', {
      type: event.type,
      ...event.payload,
    });
  }
});

eventBus.subscribe(TOPICS.INVENTORY, async (event) => {
  io.emit('inventory:update', event);
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function bootstrap() {
  console.log('\n🚀 Zenith Optima — Booting intelligent profit optimization engine...\n');

  // Seed in-memory data
  await seed();

  // Start background jobs
  startLockExpiryJob();
  console.log('[Jobs] ⏰ Seat lock expiry job started (30s interval)');

  // Periodic ops simulation (demo mode)
  if (process.env.DEMO_MODE !== 'false') {
    setInterval(async () => {
      try {
        const { simulateRandomEvent } = require('./services/simulation/opsSimulator');
        const event = await simulateRandomEvent();
        if (event) console.log(`[Sim] 🎭 Random event fired`);
      } catch (_) {}
    }, 120000); // Every 2 minutes
    console.log('[Sim] 🎭 Demo simulation active (2-min interval)');
  }

  server.listen(PORT, () => {
    console.log(`\n✅ Zenith Optima running on http://localhost:${PORT}`);
    console.log(`   Health:     http://localhost:${PORT}/health`);
    console.log(`   API Base:   http://localhost:${PORT}/api`);
    console.log(`   Frontend:   http://localhost:${PORT}/\n`);
    console.log('─'.repeat(60));
    console.log('  SERVICES ACTIVE:');
    console.log('  ✓ Dynamic Pricing Engine (6-factor model)');
    console.log('  ✓ Inventory Service (distributed locking)');
    console.log('  ✓ AI Fare Prediction & Demand Forecasting');
    console.log('  ✓ Recommendation Engine (2-stage ML)');
    console.log('  ✓ Operations Simulator (delay/cancel/rebok)');
    console.log('  ✓ Fraud Detection (real-time scoring)');
    console.log('  ✓ Analytics & Revenue Dashboard');
    console.log('  ✓ Event Bus (Kafka Cluster | In-Memory fallback)');
    console.log('  ✓ WebSocket (real-time updates)');
    console.log('  ✓ AI Chatbot (intent + entity engine)');
    console.log('  ✓ API Metrics (Prometheus Exporter)');
    console.log('  ✓ Distributed Cache & Locks (Redis | In-Memory fallback)');
    console.log('─'.repeat(60) + '\n');
  });
}

bootstrap().catch(err => {
  console.error('❌ Bootstrap failed:', err);
  process.exit(1);
});

module.exports = { app, io };
