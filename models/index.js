// ─────────────────────────────────────────────────────────────
// models/index.js — All Mongoose models
// ─────────────────────────────────────────────────────────────
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// ══════════════════════════════════════════════════════════════
// USER MODEL
// ══════════════════════════════════════════════════════════════
const userSchema = new mongoose.Schema({
  firstName:   { type: String, required: true, trim: true },
  lastName:    { type: String, required: true, trim: true },
  email:       { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:    { type: String, required: true, minlength: 8 },
  country:     { type: String, default: '' },
  role:        { type: String, enum: ['member', 'analyst', 'admin'], default: 'member' },

  // Subscription
  plan:        { type: String, enum: ['free', 'starter', 'pro', 'elite'], default: 'free' },
  planStatus:  { type: String, enum: ['trialing', 'active', 'past_due', 'canceled', 'none'], default: 'none' },
  trialEndsAt: { type: Date },
  subEndsAt:   { type: Date },

  // Stripe
  stripeCustomerId:     { type: String, default: null },
  stripeSubscriptionId: { type: String, default: null },

  // Telegram
  telegramChatId:  { type: String, default: null },
  telegramUsername: { type: String, default: null },
  telegramLinked:  { type: Boolean, default: false },

  // Profile
  experience:  { type: String, enum: ['beginner', 'developing', 'experienced', 'professional', ''], default: '' },
  goal:        { type: String, default: '' },
  session:     { type: String, default: 'london' },
  avatarUrl:   { type: String, default: null },

  // Stats
  signalsTaken:  { type: Number, default: 0 },
  xp:            { type: Number, default: 0 },

  // Auth
  emailVerified:       { type: Boolean, default: false },
  emailVerifyToken:    { type: String, default: null },
  passwordResetToken:  { type: String, default: null },
  passwordResetExpiry: { type: Date, default: null },
  lastLoginAt:         { type: Date, default: null },
  refreshToken:        { type: String, default: null },
}, { timestamps: true });

// Hash password before save
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
  next();
});

// Compare password
userSchema.methods.comparePassword = function(plain) {
  return bcrypt.compare(plain, this.password);
};

// Strip sensitive fields from JSON output
userSchema.methods.toSafeJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.emailVerifyToken;
  delete obj.passwordResetToken;
  delete obj.refreshToken;
  return obj;
};

userSchema.index({ email: 1 });
userSchema.index({ stripeCustomerId: 1 });
userSchema.index({ telegramChatId: 1 });


// ══════════════════════════════════════════════════════════════
// SIGNAL MODEL
// ══════════════════════════════════════════════════════════════
const signalSchema = new mongoose.Schema({
  pair:      { type: String, required: true },          // e.g. "EUR/USD"
  direction: { type: String, enum: ['long', 'short'], required: true },
  entry:     { type: Number, required: true },
  tp1:       { type: Number, required: true },
  tp2:       { type: Number },
  tp3:       { type: Number },
  sl:        { type: Number, required: true },
  rr:        { type: String },                          // e.g. "1:2.4"
  status:    { type: String, enum: ['pending', 'active', 'tp1', 'tp2', 'tp3', 'sl', 'closed', 'cancelled'], default: 'pending' },

  // Result
  pips:       { type: Number, default: 0 },
  closedAt:   { type: Date },
  closedPrice: { type: Number },

  // Content
  note:      { type: String, default: '' },             // analyst breakdown
  timeframe: { type: String, default: '4H' },
  session:   { type: String, enum: ['london', 'ny', 'tokyo', 'sydney', ''], default: '' },

  // Access control
  tier:      { type: String, enum: ['all', 'starter', 'pro', 'elite'], default: 'all' },

  // Analyst
  analyst:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  analystName: { type: String, default: 'ForexEdge' },

  // Telegram delivery
  telegramMessageId: { type: String, default: null },
  sentToTelegram:    { type: Boolean, default: false },
}, { timestamps: true });

signalSchema.index({ status: 1, createdAt: -1 });
signalSchema.index({ pair: 1, createdAt: -1 });


// ══════════════════════════════════════════════════════════════
// SUBSCRIPTION EVENT MODEL (audit log)
// ══════════════════════════════════════════════════════════════
const subEventSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  event:     { type: String, required: true },          // e.g. "subscription.created"
  plan:      { type: String },
  amount:    { type: Number },
  currency:  { type: String, default: 'usd' },
  stripeEventId: { type: String },
  metadata:  { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });


// ══════════════════════════════════════════════════════════════
// PERFORMANCE LOG MODEL
// ══════════════════════════════════════════════════════════════
const perfLogSchema = new mongoose.Schema({
  month:      { type: String, required: true },         // "2025-03"
  signals:    { type: Number, default: 0 },
  wins:       { type: Number, default: 0 },
  losses:     { type: Number, default: 0 },
  totalPips:  { type: Number, default: 0 },
  winRate:    { type: Number, default: 0 },             // 0–100
  avgRR:      { type: Number, default: 0 },
}, { timestamps: true });


module.exports = {
  User:      mongoose.model('User', userSchema),
  Signal:    mongoose.model('Signal', signalSchema),
  SubEvent:  mongoose.model('SubEvent', subEventSchema),
  PerfLog:   mongoose.model('PerfLog', perfLogSchema),
};
