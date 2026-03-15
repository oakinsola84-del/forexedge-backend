// ─────────────────────────────────────────────────────────────
// routes/auth.js — Register, login, token refresh, password reset
// ─────────────────────────────────────────────────────────────
const express  = require('express');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { body, validationResult } = require('express-validator');
const { User } = require('../models');
const { authLimiter } = require('../middleware/rateLimiter');
const { sendEmail }   = require('../services/emailService');

const router = express.Router();

// ── Helper: sign tokens ───────────────────────────────────────
function signAccess(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}
function signRefresh(userId) {
  return jwt.sign({ userId }, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: '30d',
  });
}

// ── POST /api/auth/register ───────────────────────────────────
router.post('/register', authLimiter, [
  body('firstName').trim().notEmpty().withMessage('First name required'),
  body('lastName').trim().notEmpty().withMessage('Last name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be 8+ characters'),
  body('country').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { firstName, lastName, email, password, country, plan = 'starter' } = req.body;

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: 'Email already registered' });

    // Set trial dates
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

    const user = await User.create({
      firstName, lastName, email, password, country,
      plan,
      planStatus: 'trialing',
      trialEndsAt,
      emailVerifyToken: crypto.randomBytes(32).toString('hex'),
    });

    // Send welcome email (non-blocking)
    sendEmail({
      to: email,
      subject: 'Welcome to ForexEdge — your 14-day trial is active',
      template: 'welcome',
      data: { firstName, trialEndsAt },
    }).catch(console.error);

    const accessToken  = signAccess(user._id);
    const refreshToken = signRefresh(user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken, lastLoginAt: new Date() });

    res.status(201).json({
      message: 'Account created',
      accessToken,
      refreshToken,
      user: user.toSafeJSON(),
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const accessToken  = signAccess(user._id);
    const refreshToken = signRefresh(user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken, lastLoginAt: new Date() });

    res.json({
      accessToken,
      refreshToken,
      user: user.toSafeJSON(),
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/refresh ────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ error: 'No refresh token' });

    const payload = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    const user    = await User.findById(payload.userId);

    if (!user || user.refreshToken !== refreshToken) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const newAccess  = signAccess(user._id);
    const newRefresh = signRefresh(user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken: newRefresh });

    res.json({ accessToken: newAccess, refreshToken: newRefresh });
  } catch (err) {
    return res.status(401).json({ error: 'Token invalid or expired' });
  }
});

// ── POST /api/auth/forgot-password ───────────────────────────
router.post('/forgot-password', authLimiter, [
  body('email').isEmail().normalizeEmail(),
], async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    // Always respond 200 to prevent email enumeration
    if (!user) return res.json({ message: 'If that email exists, a reset link was sent.' });

    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await User.findByIdAndUpdate(user._id, {
      passwordResetToken: token,
      passwordResetExpiry: expiry,
    });

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
    await sendEmail({
      to: email,
      subject: 'Reset your ForexEdge password',
      template: 'passwordReset',
      data: { firstName: user.firstName, resetUrl },
    });

    res.json({ message: 'If that email exists, a reset link was sent.' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/reset-password ────────────────────────────
router.post('/reset-password', [
  body('token').notEmpty(),
  body('password').isLength({ min: 8 }),
], async (req, res, next) => {
  try {
    const { token, password } = req.body;
    const user = await User.findOne({
      passwordResetToken:  token,
      passwordResetExpiry: { $gt: new Date() },
    });

    if (!user) return res.status(400).json({ error: 'Token invalid or expired' });

    user.password            = password;
    user.passwordResetToken  = null;
    user.passwordResetExpiry = null;
    await user.save();

    res.json({ message: 'Password reset successfully' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/logout ─────────────────────────────────────
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await User.findOneAndUpdate({ refreshToken }, { refreshToken: null });
  }
  res.json({ message: 'Logged out' });
});

module.exports = router;
