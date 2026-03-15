// ─────────────────────────────────────────────────────────────
// routes/stats.js — Public performance stats
// ─────────────────────────────────────────────────────────────
const express = require('express');
const { PerfLog, Signal } = require('../models');
const router = express.Router();

router.get('/performance', async (req, res, next) => {
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

router.get('/overview', async (req, res, next) => {
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

module.exports = router;
