// ─────────────────────────────────────────────────────────────
// routes/telegram.js — Telegram-specific user actions
// ─────────────────────────────────────────────────────────────
const router = require('express').Router();

// POST /api/telegram/send-test
router.post('/send-test', async (req, res, next) => {
  try {
    const user = req.user;
    if (!user.telegramChatId) {
      return res.status(400).json({ error: 'No Telegram linked. Connect Telegram first.' });
    }
    const { getBot } = require('../services/telegramService');
    const bot = getBot();
    if (!bot) return res.status(503).json({ error: 'Bot not available' });

    await bot.sendMessage(user.telegramChatId,
      `✅ *Test message from ForexEdge*\n\nYour Telegram is connected and working correctly. You'll receive all signal alerts here.`,
      { parse_mode: 'Markdown' }
    );
    res.json({ message: 'Test message sent' });
  } catch (err) { next(err); }
});

// DELETE /api/telegram/unlink
router.delete('/unlink', async (req, res, next) => {
  try {
    await require('../models').User.findByIdAndUpdate(req.user._id, {
      telegramChatId: null, telegramLinked: false, telegramUsername: null,
    });
    res.json({ message: 'Telegram unlinked' });
  } catch (err) { next(err); }
});

module.exports = router;
