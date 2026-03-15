// ─────────────────────────────────────────────────────────────
// routes/stripe.js — Stripe subscriptions + webhook handler
// ─────────────────────────────────────────────────────────────
const express  = require('express');
const Stripe   = require('stripe');
const { User, SubEvent } = require('../models');
const { authenticate }   = require('../middleware/auth');
const { sendEmail }      = require('../services/emailService');
const { grantTelegramAccess, revokeTelegramAccess } = require('../services/telegramService');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Price ID map ──────────────────────────────────────────────
const PRICE_IDS = {
  starter: { monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY, annual: process.env.STRIPE_PRICE_STARTER_ANNUAL },
  pro:     { monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,     annual: process.env.STRIPE_PRICE_PRO_ANNUAL     },
  elite:   { monthly: process.env.STRIPE_PRICE_ELITE_MONTHLY,   annual: process.env.STRIPE_PRICE_ELITE_ANNUAL   },
};

// Plan access map (what each tier includes)
const PLAN_HIERARCHY = { free: 0, starter: 1, pro: 2, elite: 3 };

// ── POST /api/stripe/create-checkout ─────────────────────────
// Creates a Stripe Checkout session for new subscriptions
router.post('/create-checkout', authenticate, async (req, res, next) => {
  try {
    const { plan, billing = 'monthly' } = req.body;
    const user = req.user;

    if (!PRICE_IDS[plan]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const priceId = PRICE_IDS[plan][billing];
    if (!priceId) return res.status(400).json({ error: 'Price not configured' });

    // Create or retrieve Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name:  `${user.firstName} ${user.lastName}`,
        metadata: { userId: user._id.toString() },
      });
      customerId = customer.id;
      await User.findByIdAndUpdate(user._id, { stripeCustomerId: customerId });
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer:            customerId,
      payment_method_types: ['card'],
      mode:                'subscription',
      line_items: [{
        price:    priceId,
        quantity: 1,
      }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { userId: user._id.toString(), plan, billing },
      },
      success_url: `${process.env.FRONTEND_URL}/dashboard?subscribed=true&plan=${plan}`,
      cancel_url:  `${process.env.FRONTEND_URL}/pricing?canceled=true`,
      metadata: { userId: user._id.toString(), plan, billing },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) { next(err); }
});

// ── POST /api/stripe/create-portal ───────────────────────────
// Opens Stripe billing portal (cancel, update card, invoices)
router.post('/create-portal', authenticate, async (req, res, next) => {
  try {
    const user = req.user;
    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${process.env.FRONTEND_URL}/dashboard`,
    });

    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// ── GET /api/stripe/subscription ─────────────────────────────
// Get current subscription status
router.get('/subscription', authenticate, async (req, res, next) => {
  try {
    const user = req.user;
    if (!user.stripeSubscriptionId) {
      return res.json({ plan: 'free', status: 'none' });
    }

    const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    res.json({
      plan:       user.plan,
      status:     sub.status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    });
  } catch (err) { next(err); }
});

// ── POST /api/stripe/webhook ──────────────────────────────────
// Raw body required — mounted in server.js BEFORE express.json()
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[Stripe] ${event.type}`);

  try {
    await handleWebhookEvent(event);
  } catch (err) {
    console.error('[Stripe webhook handler error]', err);
  }

  res.json({ received: true });
});

// ── Webhook event handlers ────────────────────────────────────
async function handleWebhookEvent(event) {
  const { type, data } = event;
  const obj = data.object;

  switch (type) {

    // ── Trial started / subscription created ─────────────────
    case 'customer.subscription.created': {
      const userId = obj.metadata?.userId;
      if (!userId) break;
      const plan    = obj.metadata?.plan || 'starter';
      const status  = obj.status;         // 'trialing' or 'active'

      await User.findByIdAndUpdate(userId, {
        plan,
        planStatus:          status,
        stripeSubscriptionId: obj.id,
        trialEndsAt: obj.trial_end ? new Date(obj.trial_end * 1000) : null,
        subEndsAt:   new Date(obj.current_period_end * 1000),
      });

      await SubEvent.create({ userId, event: type, plan, stripeEventId: event.id });

      // Grant Telegram access
      const user = await User.findById(userId);
      if (user?.telegramChatId) await grantTelegramAccess(user, plan);
      break;
    }

    // ── Payment succeeded (subscription renewed) ──────────────
    case 'invoice.payment_succeeded': {
      const customerId = obj.customer;
      const user = await User.findOne({ stripeCustomerId: customerId });
      if (!user) break;

      await User.findByIdAndUpdate(user._id, {
        planStatus: 'active',
        subEndsAt:  new Date(obj.period_end * 1000),
      });

      await SubEvent.create({
        userId:        user._id,
        event:         type,
        plan:          user.plan,
        amount:        obj.amount_paid / 100,
        currency:      obj.currency,
        stripeEventId: event.id,
      });

      // Send receipt email
      await sendEmail({
        to:       user.email,
        subject:  'ForexEdge — payment confirmed',
        template: 'paymentSuccess',
        data: {
          firstName: user.firstName,
          plan:      user.plan,
          amount:    (obj.amount_paid / 100).toFixed(2),
          currency:  obj.currency.toUpperCase(),
        },
      }).catch(console.error);
      break;
    }

    // ── Payment failed ────────────────────────────────────────
    case 'invoice.payment_failed': {
      const customerId = obj.customer;
      const user = await User.findOne({ stripeCustomerId: customerId });
      if (!user) break;

      await User.findByIdAndUpdate(user._id, { planStatus: 'past_due' });
      await SubEvent.create({ userId: user._id, event: type, stripeEventId: event.id });

      await sendEmail({
        to:       user.email,
        subject:  'ForexEdge — payment failed, action required',
        template: 'paymentFailed',
        data:     { firstName: user.firstName },
      }).catch(console.error);
      break;
    }

    // ── Subscription cancelled ────────────────────────────────
    case 'customer.subscription.deleted': {
      const userId = obj.metadata?.userId;
      const user   = await User.findOne(userId
        ? { _id: userId }
        : { stripeCustomerId: obj.customer }
      );
      if (!user) break;

      await User.findByIdAndUpdate(user._id, {
        plan:                'free',
        planStatus:          'canceled',
        stripeSubscriptionId: null,
      });

      await SubEvent.create({ userId: user._id, event: type, stripeEventId: event.id });

      // Revoke Telegram access to paid channels
      if (user.telegramChatId) await revokeTelegramAccess(user);

      await sendEmail({
        to:       user.email,
        subject:  'Your ForexEdge subscription has been cancelled',
        template: 'cancelled',
        data:     { firstName: user.firstName },
      }).catch(console.error);
      break;
    }

    // ── Trial ending in 2 days ────────────────────────────────
    case 'customer.subscription.trial_will_end': {
      const userId = obj.metadata?.userId;
      const user   = await User.findById(userId);
      if (!user) break;

      await sendEmail({
        to:       user.email,
        subject:  'Your ForexEdge trial ends in 2 days',
        template: 'trialEnding',
        data:     { firstName: user.firstName, plan: user.plan },
      }).catch(console.error);
      break;
    }

    // ── Plan changed ──────────────────────────────────────────
    case 'customer.subscription.updated': {
      const userId = obj.metadata?.userId;
      if (!userId) break;
      const plan = obj.metadata?.plan || 'starter';

      await User.findByIdAndUpdate(userId, { plan, planStatus: obj.status });
      await SubEvent.create({ userId, event: type, plan, stripeEventId: event.id });

      const user = await User.findById(userId);
      if (user?.telegramChatId) await grantTelegramAccess(user, plan);
      break;
    }

    default:
      break;
  }
}

module.exports = router;
