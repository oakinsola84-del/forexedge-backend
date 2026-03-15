// ─────────────────────────────────────────────────────────────
// routes/forex.js — Live price endpoints (public)
// ─────────────────────────────────────────────────────────────
const express = require('express');
const { getPrices, getPrice } = require('../services/forexService');
const router = express.Router();

// GET /api/forex/prices — all cached prices
router.get('/prices', (req, res) => {
  res.json({ prices: getPrices(), updatedAt: new Date().toISOString() });
});

// GET /api/forex/price/:pair — single pair e.g. EUR-USD
router.get('/price/:pair', (req, res) => {
  const pair  = req.params.pair.replace('-', '/').toUpperCase();
  const price = getPrice(pair);
  if (!price) return res.status(404).json({ error: 'Pair not found or not yet cached' });
  res.json({ pair, ...price });
});

// GET /api/forex/candles?pair=EUR/USD&interval=1h&count=100
router.get('/candles', async (req, res, next) => {
  try {
    const { pair = 'EUR/USD', interval = '1h', count = 100 } = req.query;
    const [from, to] = pair.split('/');
    const url = `https://api.twelvedata.com/time_series`
      + `?symbol=${from}/${to}&interval=${interval}&outputsize=${count}`
      + `&apikey=${process.env.TWELVE_DATA_KEY}`;

    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data     = await response.json();

    if (data.status === 'error') {
      return res.status(400).json({ error: data.message });
    }

    res.json({ pair, interval, candles: data.values || [] });
  } catch (err) { next(err); }
});

module.exports = router;

// ─────────────────────────────────────────────────────────────
// routes/stats.js — Public performance stats
// ─────────────────────────────────────────────────────────────
const { PerfLog, Signal } = require('../models');
const statsRouter = express.Router();

statsRouter.get('/performance', async (req, res, next) => {
  try {
    const logs = await PerfLog.find().sort({ month: -1 }).limit(12).lean();

    const allTime = logs.reduce((acc, l) => ({
      signals: acc.signals + l.signals,
      wins:    acc.wins + l.wins,
      losses:  acc.losses + l.losses,
      pips:    acc.pips + (l.totalPips || 0),
    }), { signals: 0, wins: 0, losses: 0, pips: 0 });

    const winRate = allTime.signals > 0
      ? ((allTime.wins / allTime.signals) * 100).toFixed(1)
      : 0;

    res.json({ monthly: logs, allTime: { ...allTime, winRate } });
  } catch (err) { next(err); }
});

statsRouter.get('/overview', async (req, res, next) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const [active, todaySignals, totalSignals] = await Promise.all([
      Signal.countDocuments({ status: 'active' }),
      Signal.countDocuments({ createdAt: { $gte: today } }),
      Signal.countDocuments(),
    ]);
    res.json({ active, todaySignals, totalSignals });
  } catch (err) { next(err); }
});

module.exports = statsRouter;
