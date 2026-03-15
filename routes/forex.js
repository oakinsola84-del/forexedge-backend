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
