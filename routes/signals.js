// ─────────────────────────────────────────────────────────────
// routes/signals.js — Signal CRUD + publishing
// ─────────────────────────────────────────────────────────────
const express  = require('express');
const { body, validationResult } = require('express-validator');
const { Signal, PerfLog } = require('../models');
const { requireRole, requirePlan } = require('../middleware/auth');
const { sendSignalToTelegram }     = require('../services/telegramService');

const router = express.Router();

// ── GET /api/signals ──────────────────────────────────────────
// All members get signals, but Elite tier gets 15 min early
router.get('/', async (req, res, next) => {
  try {
    const { status, pair, limit = 50, page = 1 } = req.query;
    const query = {};

    if (status) query.status = status;
    if (pair)   query.pair   = pair.toUpperCase();

    // Filter by plan tier
    const userPlan = req.user.plan;
    const planRank = { free: 0, starter: 1, pro: 2, elite: 3 };
    const tierFilter = ['all'];
    if (planRank[userPlan] >= 1) tierFilter.push('starter');
    if (planRank[userPlan] >= 2) tierFilter.push('pro');
    if (planRank[userPlan] >= 3) tierFilter.push('elite');
    query.tier = { $in: tierFilter };

    // Elite members: see all signals immediately
    // Non-elite: only see signals older than 15 minutes
    if (userPlan !== 'elite' && req.user.role !== 'admin') {
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
      query.createdAt = { $lte: fifteenMinsAgo };
    }

    const signals = await Signal.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .populate('analyst', 'firstName lastName')
      .lean();

    const total = await Signal.countDocuments(query);

    res.json({ signals, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { next(err); }
});

// ── GET /api/signals/:id ──────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const signal = await Signal.findById(req.params.id)
      .populate('analyst', 'firstName lastName')
      .lean();
    if (!signal) return res.status(404).json({ error: 'Signal not found' });
    res.json(signal);
  } catch (err) { next(err); }
});

// ── POST /api/signals ─────────────────────────────────────────
// Analysts and admins only
router.post('/', requireRole('analyst', 'admin'), [
  body('pair').notEmpty().trim().toUpperCase(),
  body('direction').isIn(['long', 'short']),
  body('entry').isFloat({ gt: 0 }),
  body('tp1').isFloat({ gt: 0 }),
  body('sl').isFloat({ gt: 0 }),
  body('note').optional().trim(),
  body('tier').optional().isIn(['all', 'starter', 'pro', 'elite']),
  body('sendToTelegram').optional().isBoolean(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      pair, direction, entry, tp1, tp2, tp3, sl,
      note, timeframe, session, tier = 'all',
      sendToTelegram = true,
    } = req.body;

    // Calculate R:R
    const risk   = Math.abs(entry - sl);
    const reward = Math.abs(tp1 - entry);
    const rr     = risk > 0 ? `1:${(reward / risk).toFixed(1)}` : '—';

    const signal = await Signal.create({
      pair, direction, entry, tp1, tp2, tp3, sl, rr,
      note, timeframe, session, tier,
      status: 'active',
      analyst: req.user._id,
      analystName: `${req.user.firstName} ${req.user.lastName}`,
    });

    // Broadcast to Telegram
    if (sendToTelegram) {
      sendSignalToTelegram(signal)
        .then(msgId => Signal.findByIdAndUpdate(signal._id, {
          telegramMessageId: msgId,
          sentToTelegram: true,
        }))
        .catch(err => console.error('[Telegram send error]', err));
    }

    res.status(201).json(signal);
  } catch (err) { next(err); }
});

// ── PATCH /api/signals/:id/status ────────────────────────────
// Update signal status (TP hit, SL hit, close)
router.patch('/:id/status', requireRole('analyst', 'admin'), [
  body('status').isIn(['tp1', 'tp2', 'tp3', 'sl', 'closed', 'cancelled']),
  body('pips').optional().isFloat(),
  body('closedPrice').optional().isFloat({ gt: 0 }),
], async (req, res, next) => {
  try {
    const { status, pips, closedPrice } = req.body;
    const signal = await Signal.findByIdAndUpdate(
      req.params.id,
      {
        status,
        ...(pips        !== undefined && { pips }),
        ...(closedPrice !== undefined && { closedPrice }),
        closedAt: ['tp1','tp2','tp3','sl','closed'].includes(status) ? new Date() : undefined,
      },
      { new: true }
    );

    if (!signal) return res.status(404).json({ error: 'Signal not found' });

    // Update performance log
    await updatePerfLog(signal);

    // Notify Telegram of result
    const { notifySignalResult } = require('../services/telegramService');
    notifySignalResult(signal).catch(console.error);

    res.json(signal);
  } catch (err) { next(err); }
});

// ── GET /api/signals/stats/performance ───────────────────────
router.get('/stats/performance', async (req, res, next) => {
  try {
    const logs = await PerfLog.find().sort({ month: -1 }).limit(12).lean();
    res.json(logs);
  } catch (err) { next(err); }
});

// ── Helper: update monthly performance log ────────────────────
async function updatePerfLog(signal) {
  if (!['tp1','tp2','tp3','sl'].includes(signal.status)) return;
  const month = signal.createdAt.toISOString().slice(0, 7); // "2025-03"
  const isWin = signal.status.startsWith('tp');

  await PerfLog.findOneAndUpdate(
    { month },
    {
      $inc: {
        signals: 1,
        wins:    isWin ? 1 : 0,
        losses:  isWin ? 0 : 1,
        totalPips: signal.pips || 0,
      },
    },
    { upsert: true, new: true }
  ).then(async (log) => {
    const winRate = log.signals > 0 ? (log.wins / log.signals) * 100 : 0;
    await PerfLog.findByIdAndUpdate(log._id, { winRate });
  });
}

module.exports = router;
