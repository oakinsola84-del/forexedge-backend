// ============================================================
// ForexEdge — Production Backend
// Node.js + Express + SQLite (swap for PostgreSQL in prod)
// ============================================================
// Install: npm install express better-sqlite3 bcryptjs
//          jsonwebtoken dotenv cors helmet express-rate-limit
//          node-telegram-bot-api stripe
// Run:     node server.js
// ============================================================

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const Database     = require('better-sqlite3');
const path         = require('path');

// ── CONFIG ────────────────────────────────────────────────────
const PORT     = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const DB_PATH  = process.env.DB_PATH || './forexedge.db';

// ── DATABASE SETUP ────────────────────────────────────────────
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT    UNIQUE NOT NULL,
    password    TEXT    NOT NULL,
    first_name  TEXT    NOT NULL,
    last_name   TEXT    NOT NULL,
    country     TEXT,
    plan        TEXT    DEFAULT 'starter',
    plan_status TEXT    DEFAULT 'trial',
    trial_ends  INTEGER,
    stripe_id   TEXT,
    telegram_id TEXT,
    experience  TEXT,
    goal        TEXT,
    created_at  INTEGER DEFAULT (unixepoch()),
    last_login  INTEGER
  );

  CREATE TABLE IF NOT EXISTS signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pair        TEXT    NOT NULL,
    direction   TEXT    NOT NULL CHECK(direction IN ('long','short')),
    entry       REAL    NOT NULL,
    tp1         REAL    NOT NULL,
    tp2         REAL,
    sl          REAL    NOT NULL,
    rr          TEXT,
    status      TEXT    DEFAULT 'open'
                        CHECK(status IN ('open','tp1','tp2','sl','closed')),
    analyst_id  INTEGER,
    note        TEXT,
    pips        REAL    DEFAULT 0,
    opened_at   INTEGER DEFAULT (unixepoch()),
    closed_at   INTEGER,
    FOREIGN KEY (analyst_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    stripe_sub_id   TEXT    UNIQUE,
    plan            TEXT    NOT NULL,
    status          TEXT    NOT NULL,
    current_period_start INTEGER,
    current_period_end   INTEGER,
    cancel_at_period_end INTEGER DEFAULT 0,
    created_at      INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS affiliates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER UNIQUE NOT NULL,
    code        TEXT    UNIQUE NOT NULL,
    clicks      INTEGER DEFAULT 0,
    signups     INTEGER DEFAULT 0,
    earnings    REAL    DEFAULT 0,
    created_at  INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS referrals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliate_id    INTEGER NOT NULL,
    referred_user   INTEGER NOT NULL,
    commission      REAL,
    paid            INTEGER DEFAULT 0,
    created_at      INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(id),
    FOREIGN KEY (referred_user) REFERENCES users(id)
  );
`);

// ── APP SETUP ─────────────────────────────────────────────────
const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests — please try again later.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts — wait 15 minutes.' },
});
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);

// ── MIDDLEWARE ────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  try {
    const token = header.slice(7);
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function requirePlan(...plans) {
  return (req, res, next) => {
    const user = db.prepare('SELECT plan, plan_status FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.plan_status === 'cancelled' || user.plan_status === 'expired') {
      return res.status(402).json({ error: 'Subscription required.' });
    }
    if (plans.length && !plans.includes(user.plan)) {
      return res.status(403).json({ error: `This feature requires: ${plans.join(' or ')} plan.` });
    }
    next();
  };
}

// ── AUTH ROUTES ───────────────────────────────────────────────
const authRouter = express.Router();

// POST /api/auth/register
authRouter.post('/register', async (req, res) => {
  const { email, password, firstName, lastName, country, plan, refCode } = req.body;
  if (!email || !password || !firstName || !lastName) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'Email already registered.' });
  }

  const hash = await bcrypt.hash(password, 12);
  const trialEnds = Math.floor(Date.now() / 1000) + (14 * 24 * 60 * 60); // 14 days

  const result = db.prepare(`
    INSERT INTO users (email, password, first_name, last_name, country, plan, plan_status, trial_ends)
    VALUES (?, ?, ?, ?, ?, ?, 'trial', ?)
  `).run(email.toLowerCase(), hash, firstName, lastName, country || null, plan || 'starter', trialEnds);

  const userId = result.lastInsertRowid;

  // Handle affiliate referral
  if (refCode) {
    const affiliate = db.prepare('SELECT id FROM affiliates WHERE code = ?').get(refCode);
    if (affiliate) {
      db.prepare('INSERT INTO referrals (affiliate_id, referred_user) VALUES (?, ?)').run(affiliate.id, userId);
      db.prepare('UPDATE affiliates SET signups = signups + 1 WHERE id = ?').run(affiliate.id);
    }
  }

  const token = jwt.sign({ id: userId, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
  res.status(201).json({
    token,
    user: { id: userId, email: email.toLowerCase(), firstName, lastName, plan: plan || 'starter', planStatus: 'trial' },
  });
});

// POST /api/auth/login
authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials.' }); // Don't reveal which
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  // Check trial expiry
  if (user.plan_status === 'trial' && user.trial_ends < Math.floor(Date.now() / 1000)) {
    db.prepare("UPDATE users SET plan_status = 'expired' WHERE id = ?").run(user.id);
    user.plan_status = 'expired';
  }

  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), user.id);
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      plan: user.plan,
      planStatus: user.plan_status,
      trialEnds: user.trial_ends,
      telegramId: user.telegram_id,
    },
  });
});

// GET /api/auth/me
authRouter.get('/me', requireAuth, (req, res) => {
  const user = db.prepare(`
    SELECT id, email, first_name, last_name, plan, plan_status, trial_ends, telegram_id, experience, goal, created_at
    FROM users WHERE id = ?
  `).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json(user);
});

app.use('/api/auth', authRouter);

// ── SIGNAL ROUTES ─────────────────────────────────────────────
const signalRouter = express.Router();

// GET /api/signals — all members can see signals
signalRouter.get('/', requireAuth, (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  let query = `
    SELECT s.*, u.first_name || ' ' || u.last_name AS analyst_name
    FROM signals s
    LEFT JOIN users u ON s.analyst_id = u.id
  `;
  const params = [];
  if (status) { query += ' WHERE s.status = ?'; params.push(status); }
  query += ' ORDER BY s.opened_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const signals = db.prepare(query).all(...params);
  const total = db.prepare('SELECT COUNT(*) AS n FROM signals').get().n;
  res.json({ signals, total });
});

// GET /api/signals/stats
signalRouter.get('/stats', requireAuth, (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('tp1','tp2') THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN status = 'sl' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
      AVG(CASE WHEN status NOT IN ('open','closed') THEN pips END) AS avg_pips,
      SUM(pips) AS total_pips
    FROM signals
  `).get();

  stats.win_rate = stats.total > 0
    ? Math.round((stats.wins / (stats.wins + stats.losses)) * 100)
    : 0;

  res.json(stats);
});

// GET /api/signals/performance — public performance log
signalRouter.get('/performance', (req, res) => {
  const monthly = db.prepare(`
    SELECT
      strftime('%Y-%m', datetime(opened_at, 'unixepoch')) AS month,
      COUNT(*) AS signals,
      SUM(CASE WHEN status IN ('tp1','tp2') THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN status = 'sl' THEN 1 ELSE 0 END) AS losses,
      ROUND(100.0 * SUM(CASE WHEN status IN ('tp1','tp2') THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0), 1) AS win_rate,
      ROUND(SUM(pips), 1) AS total_pips
    FROM signals
    WHERE status != 'open'
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `).all();
  res.json(monthly);
});

// POST /api/signals — analysts only (plan = 'analyst' or 'admin')
signalRouter.post('/', requireAuth, (req, res) => {
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.id);
  if (!['analyst', 'admin'].includes(user?.plan)) {
    return res.status(403).json({ error: 'Analysts only.' });
  }
  const { pair, direction, entry, tp1, tp2, sl, rr, note } = req.body;
  if (!pair || !direction || !entry || !tp1 || !sl) {
    return res.status(400).json({ error: 'pair, direction, entry, tp1, sl are required.' });
  }
  const result = db.prepare(`
    INSERT INTO signals (pair, direction, entry, tp1, tp2, sl, rr, note, analyst_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(pair, direction, entry, tp1, tp2 || null, sl, rr || null, note || null, req.user.id);

  const signal = db.prepare('SELECT * FROM signals WHERE id = ?').get(result.lastInsertRowid);

  // Notify via Telegram (imported separately)
  if (global.telegramBot) {
    global.telegramBot.broadcastSignal(signal);
  }

  res.status(201).json(signal);
});

// PATCH /api/signals/:id — update signal status
signalRouter.patch('/:id', requireAuth, (req, res) => {
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.id);
  if (!['analyst', 'admin'].includes(user?.plan)) {
    return res.status(403).json({ error: 'Analysts only.' });
  }
  const { status, pips } = req.body;
  const closedAt = ['tp1','tp2','sl','closed'].includes(status)
    ? Math.floor(Date.now() / 1000) : null;

  db.prepare(`
    UPDATE signals SET status = ?, pips = ?, closed_at = ? WHERE id = ?
  `).run(status, pips || 0, closedAt, req.params.id);

  const signal = db.prepare('SELECT * FROM signals WHERE id = ?').get(req.params.id);
  res.json(signal);
});

app.use('/api/signals', signalRouter);

// ── FOREX PRICE PROXY ─────────────────────────────────────────
const forexRouter = express.Router();

// Simple in-memory cache
const priceCache = { data: null, ts: 0 };

forexRouter.get('/prices', requireAuth, async (req, res) => {
  const CACHE_TTL = 30 * 1000; // 30 seconds
  if (priceCache.data && Date.now() - priceCache.ts < CACHE_TTL) {
    return res.json({ ...priceCache.data, cached: true });
  }

  const PAIRS = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD','NZD/USD','GBP/JPY','EUR/GBP','EUR/JPY'];
  const apiKey = process.env.TWELVE_DATA_KEY;

  if (!apiKey || apiKey === 'your_key_here') {
    // Return simulated data if no key
    const simulated = PAIRS.map(p => ({
      pair: p,
      price: (1 + Math.random()).toFixed(5),
      change: ((Math.random() - 0.5) * 20).toFixed(1),
      simulated: true,
    }));
    return res.json({ prices: simulated, simulated: true });
  }

  try {
    const symbols = PAIRS.map(p => p.replace('/', '')).join(',');
    const url = `https://api.twelvedata.com/price?symbol=${symbols}&apikey=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    const prices = Object.entries(data).map(([sym, val]) => ({
      pair: sym.slice(0, 3) + '/' + sym.slice(3),
      price: parseFloat(val.price),
    }));

    priceCache.data = { prices };
    priceCache.ts = Date.now();
    res.json({ prices });
  } catch (err) {
    res.status(500).json({ error: 'Price fetch failed.', detail: err.message });
  }
});

forexRouter.get('/candles', requireAuth, async (req, res) => {
  const { pair = 'EUR/USD', interval = '1h', count = 48 } = req.query;
  const apiKey = process.env.TWELVE_DATA_KEY;

  if (!apiKey || apiKey === 'your_key_here') {
    // Generate simulated candles
    const candles = [];
    let price = 1.082;
    for (let i = 0; i < count; i++) {
      const open = price;
      const close = open + (Math.random() - 0.49) * 0.002;
      candles.push({
        datetime: new Date(Date.now() - (count - i) * 3600000).toISOString(),
        open: open.toFixed(5),
        high: (Math.max(open, close) + Math.random() * 0.001).toFixed(5),
        low: (Math.min(open, close) - Math.random() * 0.001).toFixed(5),
        close: close.toFixed(5),
      });
      price = close;
    }
    return res.json({ candles, simulated: true });
  }

  try {
    const [from, to] = pair.split('/');
    const url = `https://api.twelvedata.com/time_series?symbol=${from}/${to}&interval=${interval}&outputsize=${count}&apikey=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json({ candles: data.values || [] });
  } catch (err) {
    res.status(500).json({ error: 'Candle fetch failed.' });
  }
});

app.use('/api/forex', forexRouter);

// ── USER ROUTES ───────────────────────────────────────────────
const userRouter = express.Router();

userRouter.patch('/profile', requireAuth, (req, res) => {
  const { experience, goal, session, telegramId } = req.body;
  db.prepare(`
    UPDATE users SET experience = ?, goal = ?, telegram_id = ? WHERE id = ?
  `).run(experience || null, goal || null, telegramId || null, req.user.id);
  res.json({ success: true });
});

userRouter.get('/dashboard', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, first_name, last_name, plan, plan_status, trial_ends, telegram_id FROM users WHERE id = ?').get(req.user.id);
  const stats = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('tp1','tp2') THEN 1 ELSE 0 END) AS wins,
    SUM(pips) AS total_pips
    FROM signals WHERE status != 'open'
  `).get();
  const recentSignals = db.prepare(`
    SELECT s.*, u.first_name AS analyst
    FROM signals s LEFT JOIN users u ON s.analyst_id = u.id
    ORDER BY s.opened_at DESC LIMIT 5
  `).all();
  res.json({ user, stats, recentSignals });
});

app.use('/api/users', userRouter);

// ── AFFILIATE ROUTES ──────────────────────────────────────────
const affiliateRouter = express.Router();

affiliateRouter.post('/join', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT id FROM affiliates WHERE user_id = ?').get(req.user.id);
  if (existing) return res.status(409).json({ error: 'Already an affiliate.' });

  const code = 'FE-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  db.prepare('INSERT INTO affiliates (user_id, code) VALUES (?, ?)').run(req.user.id, code);
  res.status(201).json({ code, referralUrl: `${process.env.FRONTEND_URL}?ref=${code}` });
});

affiliateRouter.get('/stats', requireAuth, (req, res) => {
  const aff = db.prepare('SELECT * FROM affiliates WHERE user_id = ?').get(req.user.id);
  if (!aff) return res.status(404).json({ error: 'Not an affiliate.' });
  const referrals = db.prepare(`
    SELECT r.*, u.email, u.plan, u.created_at
    FROM referrals r JOIN users u ON r.referred_user = u.id
    WHERE r.affiliate_id = ? ORDER BY r.created_at DESC
  `).all(aff.id);
  res.json({ ...aff, referrals });
});

app.use('/api/affiliate', affiliateRouter);

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    db: 'connected',
    time: new Date().toISOString(),
  });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ForexEdge backend running on http://localhost:${PORT}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Database:    ${DB_PATH}\n`);
});

module.exports = { app, db };
