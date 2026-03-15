// ─────────────────────────────────────────────────────────────
// middleware/auth.js — JWT authentication middleware
// ─────────────────────────────────────────────────────────────
const jwt         = require('jsonwebtoken');
const { User }    = require('../models');

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = header.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(payload.userId).lean();
    if (!user) return res.status(401).json({ error: 'User not found' });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Role guard — use after authenticate
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

// Plan guard — checks subscription tier
const requirePlan = (...plans) => (req, res, next) => {
  const allowed = ['admin', ...plans]; // admins always pass
  if (req.user.role === 'admin') return next();
  if (!plans.includes(req.user.plan)) {
    return res.status(403).json({
      error: 'This content requires a higher plan',
      required: plans,
      current: req.user.plan,
      upgradeUrl: '/pricing',
    });
  }
  next();
};

module.exports = { authenticate, requireRole, requirePlan };
