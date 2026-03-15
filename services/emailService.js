// ─────────────────────────────────────────────────────────────
// services/emailService.js — Nodemailer transactional emails
// ─────────────────────────────────────────────────────────────
const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || 465),
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

const EMAIL_TEMPLATES = {
  welcome: (data) => ({
    subject: 'Welcome to ForexEdge — your 14-day trial is active',
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0b0d10">
      <div style="font-size:22px;font-weight:900;margin-bottom:24px">Forex<span style="color:#c8962a">Edge</span></div>
      <h1 style="font-size:28px;margin-bottom:12px">Welcome, ${data.firstName}.</h1>
      <p style="font-size:16px;color:#4a5060;line-height:1.7">Your 14-day free trial is now active. Full access to live forex signals, the course library, and the community.</p>
      <div style="background:#f4f1eb;border-radius:8px;padding:20px;margin:24px 0">
        <div style="font-size:13px;color:#8a8f9a;margin-bottom:4px">Trial ends</div>
        <div style="font-size:18px;font-weight:600">${new Date(data.trialEndsAt).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
      </div>
      <a href="${process.env.FRONTEND_URL}/dashboard" style="display:inline-block;background:#c8962a;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600">Go to your dashboard →</a>
      <hr style="border:none;border-top:1px solid #ebe7de;margin:32px 0"/>
      <p style="font-size:12px;color:#8a8f9a">ForexEdge provides educational forex content only. Not financial advice. Trading involves significant risk.</p>
    </div>`,
  }),
  paymentSuccess: (data) => ({
    subject: 'ForexEdge — payment confirmed',
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0b0d10">
      <div style="font-size:22px;font-weight:900;margin-bottom:24px">Forex<span style="color:#c8962a">Edge</span></div>
      <h1 style="font-size:24px;margin-bottom:12px">Payment confirmed ✓</h1>
      <p style="font-size:16px;color:#4a5060;line-height:1.7">Hi ${data.firstName}, your ${data.plan} subscription payment of $${data.amount} ${data.currency} was successful.</p>
      <a href="${process.env.FRONTEND_URL}/dashboard" style="display:inline-block;background:#c8962a;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:20px">Go to dashboard →</a>
    </div>`,
  }),
  paymentFailed: (data) => ({
    subject: 'ForexEdge — payment failed, action required',
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0b0d10">
      <div style="font-size:22px;font-weight:900;margin-bottom:24px">Forex<span style="color:#c8962a">Edge</span></div>
      <h1 style="font-size:24px;margin-bottom:12px">Payment failed ⚠</h1>
      <p style="font-size:16px;color:#4a5060;line-height:1.7">Hi ${data.firstName}, we couldn't process your payment. Please update your payment method to keep your signal access.</p>
      <a href="${process.env.FRONTEND_URL}/billing" style="display:inline-block;background:#b02a2a;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:20px">Update payment method →</a>
    </div>`,
  }),
  trialEnding: (data) => ({
    subject: 'Your ForexEdge trial ends in 2 days',
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0b0d10">
      <div style="font-size:22px;font-weight:900;margin-bottom:24px">Forex<span style="color:#c8962a">Edge</span></div>
      <h1 style="font-size:24px;margin-bottom:12px">Your trial ends in 2 days.</h1>
      <p style="font-size:16px;color:#4a5060;line-height:1.7">Hi ${data.firstName}, add a payment method before your trial expires to keep receiving signals.</p>
      <a href="${process.env.FRONTEND_URL}/pricing" style="display:inline-block;background:#c8962a;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:20px">Continue with ${data.plan} →</a>
    </div>`,
  }),
  cancelled: (data) => ({
    subject: 'Your ForexEdge subscription has been cancelled',
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0b0d10">
      <div style="font-size:22px;font-weight:900;margin-bottom:24px">Forex<span style="color:#c8962a">Edge</span></div>
      <h1 style="font-size:24px;margin-bottom:12px">Subscription cancelled.</h1>
      <p style="font-size:16px;color:#4a5060;line-height:1.7">Hi ${data.firstName}, your subscription has been cancelled. Your account and history are preserved — you can rejoin anytime.</p>
      <a href="${process.env.FRONTEND_URL}/pricing" style="display:inline-block;background:#c8962a;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:20px">Rejoin ForexEdge →</a>
    </div>`,
  }),
  passwordReset: (data) => ({
    subject: 'Reset your ForexEdge password',
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#0b0d10">
      <div style="font-size:22px;font-weight:900;margin-bottom:24px">Forex<span style="color:#c8962a">Edge</span></div>
      <h1 style="font-size:24px;margin-bottom:12px">Reset your password</h1>
      <p style="font-size:16px;color:#4a5060;line-height:1.7">Hi ${data.firstName}, click below to reset your password. This link expires in 1 hour.</p>
      <a href="${data.resetUrl}" style="display:inline-block;background:#c8962a;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:20px">Reset password →</a>
      <p style="font-size:13px;color:#8a8f9a;margin-top:16px">If you didn't request this, ignore this email.</p>
    </div>`,
  }),
};

async function sendEmail({ to, subject, template, data }) {
  try {
    const t = EMAIL_TEMPLATES[template];
    if (!t) throw new Error(`Unknown email template: ${template}`);
    const { html, subject: defaultSubject } = t(data);
    await getTransporter().sendMail({
      from:    process.env.EMAIL_FROM,
      to,
      subject: subject || defaultSubject,
      html,
    });
  } catch (err) {
    console.error('[Email send error]', err.message);
    throw err;
  }
}

module.exports = { sendEmail };
