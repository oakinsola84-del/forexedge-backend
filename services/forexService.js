// ─────────────────────────────────────────────────────────────
// services/forexService.js — Live price cache + Twelve Data
// ─────────────────────────────────────────────────────────────
const priceCache = new Map();
let cacheUpdatedAt = null;

const PAIRS = [
  'EUR/USD','GBP/USD','USD/JPY','USD/CHF',
  'AUD/USD','USD/CAD','NZD/USD','EUR/GBP',
  'EUR/JPY','GBP/JPY','EUR/CHF','AUD/JPY',
  'GBP/CHF','EUR/AUD','CAD/JPY',
];

async function fetchFromTwelveData() {
  const key = process.env.TWELVE_DATA_KEY;
  if (!key) throw new Error('TWELVE_DATA_KEY not set');

  const symbols = PAIRS.map(p => p.replace('/', '')).join(',');
  const url = `https://api.twelvedata.com/price?symbol=${symbols}&apikey=${key}`;

  const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = await res.json();

  if (data.status === 'error') throw new Error(data.message);

  // Normalise: { 'EUR/USD': { price: 1.08420 }, ... }
  const prices = {};
  for (const [sym, val] of Object.entries(data)) {
    if (val?.price) {
      const pair = sym.slice(0,3) + '/' + sym.slice(3);
      prices[pair] = {
        price:     parseFloat(val.price),
        updatedAt: new Date().toISOString(),
      };
    }
  }
  return prices;
}

async function refreshPriceCache() {
  try {
    const prices = await fetchFromTwelveData();
    for (const [pair, data] of Object.entries(prices)) {
      const prev = priceCache.get(pair);
      priceCache.set(pair, {
        ...data,
        prev: prev?.price || data.price,
        change: prev ? data.price - prev.price : 0,
      });
    }
    cacheUpdatedAt = new Date();
  } catch (err) {
    console.warn('[Forex] Cache refresh failed:', err.message);
  }
}

function startForexCache() {
  refreshPriceCache(); // immediate
  const ttl = parseInt(process.env.FOREX_CACHE_TTL || 30) * 1000;
  setInterval(refreshPriceCache, ttl);
}

function getPrices(pairs = null) {
  if (!pairs) return Object.fromEntries(priceCache);
  return pairs.reduce((acc, p) => {
    if (priceCache.has(p)) acc[p] = priceCache.get(p);
    return acc;
  }, {});
}

function getPrice(pair) {
  return priceCache.get(pair) || null;
}

module.exports = { startForexCache, getPrices, getPrice, refreshPriceCache };


// ─────────────────────────────────────────────────────────────
// services/emailService.js — Nodemailer / Resend
// ─────────────────────────────────────────────────────────────
const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || 465),
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

const EMAIL_TEMPLATES = {
  welcome: (data) => ({
    subject: 'Welcome to ForexEdge — your 14-day trial is active',
    html: `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0b0d10">
        <div style="font-size:22px;font-weight:900;margin-bottom:24px">Forex<span style="color:#c8962a">Edge</span></div>
        <h1 style="font-size:28px;margin-bottom:12px;line-height:1.2">Welcome, ${data.firstName}.</h1>
        <p style="font-size:16px;color:#4a5060;line-height:1.7;margin-bottom:20px">
          Your 14-day free trial is now active. You have full access to live forex signals, the course library, and the community.
        </p>
        <div style="background:#f4f1eb;border-radius:8px;padding:20px;margin-bottom:24px">
          <div style="font-size:13px;color:#8a8f9a;margin-bottom:4px">Trial ends</div>
          <div style="font-size:18px;font-weight:600">${new Date(data.trialEndsAt).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })}</div>
        </div>
        <a href="${process.env.FRONTEND_URL}/dashboard" style="display:inline-block;background:#c8962a;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">Go to your dashboard →</a>
        <hr style="border:none;border-top:1px solid #ebe7de;margin:32px 0"/>
        <p style="font-size:12px;color:#8a8f9a;line-height:1.6">ForexEdge provides educational forex content only. This is not financial advice. Forex trading involves significant risk of loss.</p>
      </div>`,
  }),

  paymentSuccess: (data) => ({
    subject: 'ForexEdge — payment confirmed',
    html: `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0b0d10">
        <div style="font-size:22px;font-weight:900;margin-bottom:24px">Forex<span style="color:#c8962a">Edge</span></div>
        <h1 style="font-size:24px;margin-bottom:12px">Payment confirmed ✓</h1>
        <p style="font-size:16px;color:#4a5060;line-height:1.7">Hi ${data.firstName}, your ${data.plan} subscription payment of $${data.amount} ${data.currency} was successful.</p>
        <a href="${process.env.FRONTEND_URL}/dashboard" style="display:inline-block;background:#c8962a;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:20px">Go to dashboard →</a>
      </div>`,
  }),

  paymentFailed: (data) => ({
    subject: 'ForexEdge — payment failed, action required',
    html: `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0b0d10">
        <div style="font-size:22px;font-weight:900;margin-bottom:24px">Forex<span style="color:#c8962a">Edge</span></div>
        <h1 style="font-size:24px;margin-bottom:12px">Payment failed ⚠</h1>
        <p style="font-size:16px;color:#4a5060;line-height:1.7">Hi ${data.firstName}, we couldn't process your payment. Please update your payment method to keep your signal access.</p>
        <a href="${process.env.FRONTEND_URL}/billing" style="display:inline-block;background:#b02a2a;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:20px">Update payment method →</a>
      </div>`,
  }),

  trialEnding: (data) => ({
    subject: 'Your ForexEdge trial ends in 2 days',
    html: `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0b0d10">
        <div style="font-size:22px;font-weight:900;margin-bottom:24px">Forex<span style="color:#c8962a">Edge</span></div>
        <h1 style="font-size:24px;margin-bottom:12px">Your trial ends in 2 days.</h1>
        <p style="font-size:16px;color:#4a5060;line-height:1.7">Hi ${data.firstName}, your free trial ends soon. To keep receiving signals, add a payment method before it expires.</p>
        <a href="${process.env.FRONTEND_URL}/pricing" style="display:inline-block;background:#c8962a;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:20px">Continue with ${data.plan} →</a>
        <p style="font-size:13px;color:#8a8f9a;margin-top:16px">You can cancel anytime. No questions asked.</p>
      </div>`,
  }),

  cancelled: (data) => ({
    subject: 'Your ForexEdge subscription has been cancelled',
    html: `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0b0d10">
        <div style="font-size:22px;font-weight:900;margin-bottom:24px">Forex<span style="color:#c8962a">Edge</span></div>
        <h1 style="font-size:24px;margin-bottom:12px">Subscription cancelled.</h1>
        <p style="font-size:16px;color:#4a5060;line-height:1.7">Hi ${data.firstName}, your subscription has been cancelled. You can rejoin anytime — your account and performance history are preserved.</p>
        <a href="${process.env.FRONTEND_URL}/pricing" style="display:inline-block;background:#c8962a;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:20px">Rejoin ForexEdge →</a>
      </div>`,
  }),
};

async function sendEmail({ to, subject, template, data }) {
  try {
    const t = EMAIL_TEMPLATES[template];
    if (!t) throw new Error(`Unknown template: ${template}`);

    const { html } = t(data);
    await getTransporter().sendMail({
      from:    process.env.EMAIL_FROM,
      to,
      subject: subject || t(data).subject,
      html,
    });
  } catch (err) {
    console.error('[Email send error]', err.message);
    throw err;
  }
}

module.exports = { sendEmail };


// ─────────────────────────────────────────────────────────────
// services/signalCron.js — Scheduled jobs
// ─────────────────────────────────────────────────────────────
const cron           = require('node-cron');
const { Signal }     = require('../models');
const { sendDailyBriefing } = require('./telegramService');

function startSignalCron() {
  // Auto-check signals vs live prices every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { getPrices } = require('./forexService');
      const prices = getPrices();
      const activeSignals = await Signal.find({ status: 'active' });

      for (const signal of activeSignals) {
        const live = prices[signal.pair];
        if (!live) continue;

        const price = live.price;
        const isLong = signal.direction === 'long';

        // Check TP1
        if (signal.tp1 && (isLong ? price >= signal.tp1 : price <= signal.tp1)) {
          const pip = signal.pair.includes('JPY') ? 0.01 : 0.0001;
          const pips = Math.round(Math.abs(signal.tp1 - signal.entry) / pip);
          await Signal.findByIdAndUpdate(signal._id, {
            status: 'tp1', pips, closedPrice: signal.tp1, closedAt: new Date(),
          });
          const { notifySignalResult } = require('./telegramService');
          await notifySignalResult({ ...signal.toObject(), status: 'tp1', pips });
          continue;
        }

        // Check SL
        if (signal.sl && (isLong ? price <= signal.sl : price >= signal.sl)) {
          const pip = signal.pair.includes('JPY') ? 0.01 : 0.0001;
          const pips = -Math.round(Math.abs(signal.entry - signal.sl) / pip);
          await Signal.findByIdAndUpdate(signal._id, {
            status: 'sl', pips, closedPrice: signal.sl, closedAt: new Date(),
          });
          const { notifySignalResult } = require('./telegramService');
          await notifySignalResult({ ...signal.toObject(), status: 'sl', pips });
        }
      }
    } catch (err) {
      console.error('[Signal cron error]', err);
    }
  });

  // Daily market briefing — 7:30 AM UTC (London open prep)
  cron.schedule('30 7 * * 1-5', async () => {
    try {
      const briefing = generateDailyBriefing();
      await sendDailyBriefing(briefing);
    } catch (err) {
      console.error('[Briefing cron error]', err);
    }
  });

  // Weekly performance summary — Monday 8 AM UTC
  cron.schedule('0 8 * * 1', async () => {
    try {
      const { PerfLog } = require('../models');
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      const month = lastMonth.toISOString().slice(0, 7);
      const log = await PerfLog.findOne({ month });
      if (log) {
        await sendDailyBriefing(
          `📊 Last month summary: ${log.wins}W ${log.losses}L — ${log.winRate?.toFixed(0)}% win rate — ${log.totalPips > 0 ? '+' : ''}${log.totalPips} pips total`
        );
      }
    } catch (err) {
      console.error('[Weekly summary cron error]', err);
    }
  });

  console.log('[Cron] Signal monitor: every 5min | Daily briefing: 07:30 UTC | Weekly summary: Mon 08:00 UTC');
}

function generateDailyBriefing() {
  const now   = new Date();
  const day   = now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
  return `*${day}*

🌅 London session opening. Key events to watch today:
• EUR/USD — Watch 1.0820 support level
• GBP/USD — UK economic data at 09:30 GMT
• USD/JPY — BOJ commentary risk elevated

⚡ Check /signals for any active trades.

_All signals are for educational purposes only._`;
}

module.exports = { startSignalCron };
