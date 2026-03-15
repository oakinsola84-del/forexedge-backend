// ─────────────────────────────────────────────────────────────
// server.js — ForexEdge Backend Entry Point
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const compression = require('compression');
const mongoose   = require('mongoose');

const { rateLimiter }    = require('./middleware/rateLimiter');
const { errorHandler }   = require('./middleware/errorHandler');
const { authenticate }   = require('./middleware/auth');

const authRoutes      = require('./routes/auth');
const userRoutes      = require('./routes/users');
const signalRoutes    = require('./routes/signals');
const forexRoutes     = require('./routes/forex');
const stripeRoutes    = require('./routes/stripe');
const telegramRoutes  = require('./routes/telegram');
const statsRoutes     = require('./routes/stats');

const { startForexCache }   = require('./services/forexService');
const { initTelegramBot }   = require('./services/telegramService');
const { startSignalCron }   = require('./services/signalCron');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── TRUST PROXY (for Railway/Render/Fly.io) ───────────────────
app.set('trust proxy', 1);

// ── SECURITY MIDDLEWARE ───────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
}));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── BODY PARSING ──────────────────────────────────────────────
// Stripe webhooks need raw body — mount BEFORE express.json()
app.use('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  stripeRoutes
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── RATE LIMITING ─────────────────────────────────────────────
app.use('/api/', rateLimiter);

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    env:     process.env.NODE_ENV,
    uptime:  Math.floor(process.uptime()),
    db:      mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

// ── PUBLIC ROUTES ─────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/forex',   forexRoutes);     // public price data
app.use('/api/stats',   statsRoutes);     // public performance stats

// ── PROTECTED ROUTES ──────────────────────────────────────────
app.use('/api/users',    authenticate, userRoutes);
app.use('/api/signals',  authenticate, signalRoutes);
app.use('/api/telegram', authenticate, telegramRoutes);

// ── STRIPE ROUTES (non-webhook) ───────────────────────────────
app.use('/api/stripe', authenticate, stripeRoutes);

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── ERROR HANDLER ─────────────────────────────────────────────
app.use(errorHandler);

// ── STARTUP ───────────────────────────────────────────────────
async function start() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log('✅  MongoDB connected');

    // Start services
    startForexCache();
    console.log('✅  Forex price cache started');

    initTelegramBot();
    console.log('✅  Telegram bot initialised');

    startSignalCron();
    console.log('✅  Signal cron jobs started');

    // Start server
    app.listen(PORT, () => {
      console.log(`\n🚀  ForexEdge backend running on port ${PORT}`);
      console.log(`    ENV:  ${process.env.NODE_ENV}`);
      console.log(`    Docs: http://localhost:${PORT}/health\n`);
    });
  } catch (err) {
    console.error('❌  Startup failed:', err.message);
    process.exit(1);
  }
}

start();
