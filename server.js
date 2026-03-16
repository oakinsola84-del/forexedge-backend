require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const fs         = require('fs');
const path       = require('path');

const PORT       = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const DB_FILE    = process.env.DB_PATH || './db.json';

// ── SIMPLE JSON DATABASE ──────────────────────────────────────
// Zero native dependencies — works on every platform
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch(e) {}
  return { users: [], signals: [], subscriptions: [], affiliates: [] };
}
function saveDB(data) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
}
let DB = loadDB();
function nextId(arr) {
  return arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1;
}

// ── APP SETUP ─────────────────────────────────────────────────
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));

// Stripe webhook needs raw body — mount BEFORE express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 15*60*1000, max: 200 });
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 20 });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Auth required.' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token.' }); }
}

// ── AUTH ROUTES ───────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, password, firstName, lastName, country, plan } = req.body;
  if (!email || !password || !firstName) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  DB = loadDB();
  if (DB.users.find(u => u.email === email.toLowerCase())) {
    return res.status(409).json({ error: 'Email already registered.' });
  }
  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: nextId(DB.users),
    email: email.toLowerCase(),
    password: hash,
    firstName, lastName,
    country: country || '',
    plan: plan || 'starter',
    planStatus: 'trial',
    trialEnds: Math.floor(Date.now()/1000) + 14*24*60*60,
    telegramId: null,
    createdAt: Math.floor(Date.now()/1000),
  };
  DB.users.push(user);
  saveDB(DB);
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  const { password: _, ...safeUser } = user;
  res.status(201).json({ token, user: safeUser });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  DB = loadDB();
  const user = DB.users.find(u => u.email === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });
  user.lastLogin = Math.floor(Date.now()/1000);
  saveDB(DB);
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  const { password: _, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  DB = loadDB();
  const user = DB.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { password: _, ...safeUser } = user;
  res.json(safeUser);
});

// ── SIGNAL ROUTES ─────────────────────────────────────────────
app.get('/api/signals', requireAuth, (req, res) => {
  DB = loadDB();
  const { status } = req.query;
  let signals = [...DB.signals].reverse();
  if (status) signals = signals.filter(s => s.status === status);
  res.json({ signals, total: DB.signals.length });
});

app.get('/api/signals/stats', requireAuth, (req, res) => {
  DB = loadDB();
  const closed = DB.signals.filter(s => s.status !== 'open');
  const wins   = DB.signals.filter(s => s.status === 'tp1' || s.status === 'tp2').length;
  const losses = DB.signals.filter(s => s.status === 'sl').length;
  res.json({
    total:      DB.signals.length,
    wins, losses,
    open_count: DB.signals.filter(s => s.status === 'open').length,
    total_pips: DB.signals.reduce((a, s) => a + (s.pips || 0), 0),
    win_rate:   closed.length ? Math.round((wins / (wins + losses || 1)) * 100) : 0,
  });
});

app.get('/api/signals/performance', (req, res) => {
  DB = loadDB();
  const byMonth = {};
  DB.signals.filter(s => s.status !== 'open').forEach(s => {
    const d = new Date(s.openedAt * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if (!byMonth[key]) byMonth[key] = { month: key, signals: 0, wins: 0, losses: 0, total_pips: 0 };
    byMonth[key].signals++;
    if (s.status === 'tp1' || s.status === 'tp2') byMonth[key].wins++;
    if (s.status === 'sl') byMonth[key].losses++;
    byMonth[key].total_pips += (s.pips || 0);
  });
  const result = Object.values(byMonth)
    .sort((a,b) => b.month.localeCompare(a.month))
    .map(m => ({ ...m, win_rate: m.signals ? Math.round((m.wins/m.signals)*100) : 0 }));
  res.json(result);
});

app.post('/api/signals', requireAuth, (req, res) => {
  DB = loadDB();
  const user = DB.users.find(u => u.id === req.user.id);
  if (!['analyst','admin'].includes(user?.plan)) {
    return res.status(403).json({ error: 'Analysts only.' });
  }
  const { pair, direction, entry, tp1, tp2, sl, rr, note } = req.body;
  if (!pair || !direction || !entry || !tp1 || !sl) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  const signal = {
    id: nextId(DB.signals),
    pair, direction, entry, tp1, tp2: tp2||null, sl, rr: rr||null,
    note: note||null, status: 'open', pips: 0,
    analystId: req.user.id,
    analystName: `${user.firstName} ${user.lastName}`,
    openedAt: Math.floor(Date.now()/1000),
    closedAt: null,
  };
  DB.signals.push(signal);
  saveDB(DB);
  res.status(201).json(signal);
});

app.patch('/api/signals/:id', requireAuth, (req, res) => {
  DB = loadDB();
  const user = DB.users.find(u => u.id === req.user.id);
  if (!['analyst','admin'].includes(user?.plan)) {
    return res.status(403).json({ error: 'Analysts only.' });
  }
  const signal = DB.signals.find(s => s.id === parseInt(req.params.id));
  if (!signal) return res.status(404).json({ error: 'Signal not found.' });
  const { status, pips } = req.body;
  signal.status = status || signal.status;
  signal.pips   = pips !== undefined ? pips : signal.pips;
  if (['tp1','tp2','sl','closed'].includes(status)) {
    signal.closedAt = Math.floor(Date.now()/1000);
  }
  saveDB(DB);
  res.json(signal);
});

// ── FOREX PRICE PROXY ─────────────────────────────────────────
let priceCache = { data: null, ts: 0 };
app.get('/api/forex/prices', requireAuth, async (req, res) => {
  if (priceCache.data && Date.now() - priceCache.ts < 30000) {
    return res.json({ ...priceCache.data, cached: true });
  }
  const PAIRS = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD','GBP/JPY','EUR/GBP'];
  const apiKey = process.env.TWELVE_DATA_KEY;
  if (!apiKey) {
    const simulated = PAIRS.map(p => ({
      pair: p, price: (1 + Math.random()).toFixed(5), simulated: true,
    }));
    return res.json({ prices: simulated, simulated: true });
  }
  try {
    const symbols = PAIRS.map(p => p.replace('/','/')).join(',');
    const r = await fetch(`https://api.twelvedata.com/price?symbol=${symbols}&apikey=${apiKey}`);
    const data = await r.json();
    const prices = Object.entries(data).map(([sym, val]) => ({
      pair: sym, price: parseFloat(val.price),
    }));
    priceCache = { data: { prices }, ts: Date.now() };
    res.json({ prices });
  } catch(err) {
    res.status(500).json({ error: 'Price fetch failed.' });
  }
});

// ── USER ROUTES ───────────────────────────────────────────────
app.patch('/api/users/profile', requireAuth, (req, res) => {
  DB = loadDB();
  const user = DB.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { experience, goal, telegramId } = req.body;
  if (experience) user.experience = experience;
  if (goal)       user.goal = goal;
  if (telegramId) user.telegramId = telegramId;
  saveDB(DB);
  res.json({ success: true });
});

app.get('/api/users/dashboard', requireAuth, (req, res) => {
  DB = loadDB();
  const user = DB.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { password: _, ...safeUser } = user;
  const recentSignals = [...DB.signals].reverse().slice(0, 5);
  const wins   = DB.signals.filter(s => s.status === 'tp1' || s.status === 'tp2').length;
  const losses = DB.signals.filter(s => s.status === 'sl').length;
  res.json({
    user: safeUser,
    stats: { total: DB.signals.length, wins, losses, win_rate: wins+losses ? Math.round(wins/(wins+losses)*100) : 0 },
    recentSignals,
  });
});

// ── STRIPE ROUTES ─────────────────────────────────────────────
app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(503).json({ error: 'Stripe not configured.' });
  const Stripe = require('stripe');
  const stripe = Stripe(stripeKey);
  const { plan = 'pro', billing = 'monthly' } = req.body;
  const PRICE_IDS = {
    starter_monthly: process.env.STRIPE_PRICE_STARTER_MO,
    pro_monthly:     process.env.STRIPE_PRICE_PRO_MO,
    elite_monthly:   process.env.STRIPE_PRICE_ELITE_MO,
    starter_annual:  process.env.STRIPE_PRICE_STARTER_AN,
    pro_annual:      process.env.STRIPE_PRICE_PRO_AN,
    elite_annual:    process.env.STRIPE_PRICE_ELITE_AN,
  };
  const priceId = PRICE_IDS[`${plan}_${billing}`];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan.' });
  DB = loadDB();
  const user = DB.users.find(u => u.id === req.user.id);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: user.email,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { trial_period_days: user.planStatus === 'trial' ? 14 : 0 },
    success_url: `${process.env.FRONTEND_URL}/trading-platform.html?upgrade=success`,
    cancel_url:  `${process.env.FRONTEND_URL}/onboarding.html`,
    metadata: { userId: user.id.toString(), plan },
  });
  res.json({ url: session.url });
});

app.post('/api/stripe/webhook', (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.json({ received: true });
  const Stripe = require('stripe');
  const stripe = Stripe(stripeKey);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch(err) {
    return res.status(400).json({ error: 'Webhook error.' });
  }
  DB = loadDB();
  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const sub    = event.data.object;
    const userId = parseInt(sub.metadata?.userId);
    const user   = DB.users.find(u => u.id === userId);
    if (user) {
      user.planStatus = sub.status === 'trialing' ? 'trial' : sub.status;
      user.stripeSubId = sub.id;
      saveDB(DB);
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub    = event.data.object;
    const userId = parseInt(sub.metadata?.userId);
    const user   = DB.users.find(u => u.id === userId);
    if (user) { user.planStatus = 'cancelled'; saveDB(DB); }
  }
  res.json({ received: true });
});

app.get('/api/stripe/plans', (req, res) => {
  res.json({ plans: [
    { id:'starter', name:'Starter', monthly:29, annual:23,
      features:['Live signals','Community access','Basic education'] },
    { id:'pro', name:'Pro', monthly:79, annual:63, featured:true,
      features:['Everything in Starter','Full course library','Live sessions','Analytics'] },
    { id:'elite', name:'Elite', monthly:149, annual:119,
      features:['Everything in Pro','1-on-1 coaching','Prop firm prep','Early signals'] },
  ]});
});

// ── AFFILIATE ROUTES ──────────────────────────────────────────
app.post('/api/affiliate/join', requireAuth, (req, res) => {
  DB = loadDB();
  if (DB.affiliates.find(a => a.userId === req.user.id)) {
    return res.status(409).json({ error: 'Already an affiliate.' });
  }
  const code = 'FE-' + Math.random().toString(36).slice(2,8).toUpperCase();
  const aff  = { id: nextId(DB.affiliates), userId: req.user.id, code, clicks:0, signups:0, earnings:0 };
  DB.affiliates.push(aff);
  saveDB(DB);
  res.status(201).json({ code, referralUrl: `${process.env.FRONTEND_URL}?ref=${code}` });
});

app.get('/api/affiliate/stats', requireAuth, (req, res) => {
  DB = loadDB();
  const aff = DB.affiliates.find(a => a.userId === req.user.id);
  if (!aff) return res.status(404).json({ error: 'Not an affiliate.' });
  res.json(aff);
});

// ── HEALTH ────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n  ForexEdge API running on port ${PORT}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
