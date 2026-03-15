// ─────────────────────────────────────────────────────────────
// services/signalCron.js — Scheduled signal monitoring jobs
// ─────────────────────────────────────────────────────────────
const cron = require('node-cron');
const { Signal } = require('../models');
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

        const price  = live.price;
        const isLong = signal.direction === 'long';
        const pip    = signal.pair.includes('JPY') ? 0.01 : 0.0001;

        // Check TP1
        if (signal.tp1 && (isLong ? price >= signal.tp1 : price <= signal.tp1)) {
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

  // Daily market briefing — 7:30 AM UTC (London open prep), weekdays only
  cron.schedule('30 7 * * 1-5', async () => {
    try {
      await sendDailyBriefing(generateDailyBriefing());
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
  const day = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return `*${day}*\n\n🌅 London session opening. Key events to watch today:\n• EUR/USD — Watch 1.0820 support level\n• GBP/USD — UK economic data at 09:30 GMT\n• USD/JPY — BOJ commentary risk elevated\n\n⚡ Check /signals for any active trades.\n\n_All signals are for educational purposes only._`;
}

module.exports = { startSignalCron };
