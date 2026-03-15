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
  refreshPriceCache();
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
