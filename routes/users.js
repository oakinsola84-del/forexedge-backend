// ─────────────────────────────────────────────────────────────
// routes/users.js — User profile management
// ─────────────────────────────────────────────────────────────
const express  = require('express');
const { body, validationResult } = require('express-validator');
const { User } = require('../models');
const { requireRole } = require('../middleware/auth');
const router   = express.Router();

// GET /api/users/me
router.get('/me', (req, res) => {
  const user = { ...req.user };
  delete user.password; delete user.refreshToken;
  delete user.emailVerifyToken; delete user.passwordResetToken;
  res.json(user);
});

// PATCH /api/users/me
router.patch('/me', [
  body('firstName').optional().trim().notEmpty(),
  body('lastName').optional().trim().notEmpty(),
  body('experience').optional().isIn(['beginner','developing','experienced','professional','']),
  body('goal').optional().trim(),
  body('session').optional().isIn(['london','ny','tokyo','sydney','']),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const allowed = ['firstName','lastName','experience','goal','session','country'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).lean();
    delete user.password; delete user.refreshToken;
    res.json(user);
  } catch (err) { next(err); }
});

// POST /api/users/link-telegram — store chatId from onboarding
router.post('/link-telegram', [
  body('chatId').notEmpty(),
], async (req, res, next) => {
  try {
    const { chatId, username } = req.body;
    // Generate link token = base64(userId) for the bot deep link
    const token = Buffer.from(req.user._id.toString()).toString('base64');
    await User.findByIdAndUpdate(req.user._id, {
      telegramChatId:   chatId,
      telegramUsername: username || null,
    });
    res.json({
      token,
      botUrl: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=link_${token}`,
      message: 'Click the bot link to complete Telegram connection',
    });
  } catch (err) { next(err); }
});

// GET /api/users — admin only
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { plan, page = 1, limit = 50 } = req.query;
    const query = plan ? { plan } : {};
    const users = await User.find(query)
      .select('-password -refreshToken -emailVerifyToken -passwordResetToken')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page)-1)*parseInt(limit))
      .lean();
    const total = await User.countDocuments(query);
    res.json({ users, total });
  } catch (err) { next(err); }
});

module.exports = router;
