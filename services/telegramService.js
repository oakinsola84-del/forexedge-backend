// ─────────────────────────────────────────────────────────────
// services/telegramService.js — Full Telegram bot integration
// ─────────────────────────────────────────────────────────────
const TelegramBot = require('node-telegram-bot-api');
const { User }    = require('../models');

let bot = null;

// ── Bot initialisation ────────────────────────────────────────
function initTelegramBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn('[Telegram] No bot token set — skipping bot init');
    return;
  }

  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  console.log('[Telegram] Bot connected');

  // ── /start command ────────────────────────────────────────
  bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param  = (match[1] || '').trim(); // optional deep link param

    // If deep link includes user ID token, link the account
    if (param.startsWith('link_')) {
      const token = param.slice(5);
      await handleLinkAccount(chatId, token, msg.from);
      return;
    }

    await bot.sendMessage(chatId, `
🎯 *Welcome to ForexEdge Signal Bot*

I'll deliver real-time forex signals directly to your Telegram — entry, take profit, stop loss, and analyst notes the moment they're published.

*Commands:*
/link — Connect your ForexEdge account
/signals — See today's active signals
/performance — View monthly performance stats
/help — Show all commands

To get started, link your ForexEdge account:
➡️ [Connect your account](${process.env.FRONTEND_URL}/settings/telegram)
    `, { parse_mode: 'Markdown', disable_web_page_preview: true });
  });

  // ── /link command ─────────────────────────────────────────
  bot.onText(/\/link/, async (msg) => {
    const chatId = msg.chat.id;
    const deepLink = `${process.env.FRONTEND_URL}/settings/telegram?chatId=${chatId}`;
    await bot.sendMessage(chatId, `
🔗 *Link your ForexEdge account*

Click the button below to connect your Telegram to your ForexEdge account. Once linked, you'll receive:

• ⚡ Instant signal alerts
• 📊 Trade management updates  
• 🔔 Live session reminders
• 📋 Daily market briefings

[→ Link my account](${deepLink})
    `, { parse_mode: 'Markdown', disable_web_page_preview: true });
  });

  // ── /signals command ──────────────────────────────────────
  bot.onText(/\/signals/, async (msg) => {
    const chatId = msg.chat.id;
    const user   = await User.findOne({ telegramChatId: chatId.toString() });

    if (!user) {
      return bot.sendMessage(chatId, '⚠️ Please link your account first using /link');
    }
    if (user.plan === 'free' && user.planStatus !== 'trialing') {
      return bot.sendMessage(chatId,
        '🔒 Signal access requires an active subscription.\n\n'
        + `Subscribe at: ${process.env.FRONTEND_URL}/pricing`
      );
    }

    // Get today's signals from DB
    const { Signal } = require('../models');
    const today = new Date(); today.setHours(0,0,0,0);
    const signals = await Signal.find({
      status: { $in: ['active', 'tp1', 'tp2'] },
      createdAt: { $gte: today },
    }).sort({ createdAt: -1 }).limit(10).lean();

    if (!signals.length) {
      return bot.sendMessage(chatId, '📭 No active signals today yet. Check back soon!');
    }

    const text = signals.map(s => formatSignalMessage(s)).join('\n\n─────────────────\n\n');
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });

  // ── /performance command ──────────────────────────────────
  bot.onText(/\/performance/, async (msg) => {
    const chatId = msg.chat.id;
    const { PerfLog } = require('../models');
    const logs = await PerfLog.find().sort({ month: -1 }).limit(3).lean();

    if (!logs.length) {
      return bot.sendMessage(chatId, '📊 No performance data yet.');
    }

    const rows = logs.map(l =>
      `*${l.month}*: ${l.wins}W ${l.losses}L — Win rate: ${l.winRate?.toFixed(0)}% — ${l.totalPips > 0 ? '+' : ''}${l.totalPips} pips`
    ).join('\n');

    await bot.sendMessage(chatId, `
📊 *ForexEdge Performance*

${rows}

_All signals included — wins and losses_
_Past performance ≠ future results_

[View full stats](${process.env.FRONTEND_URL}/performance)
    `, { parse_mode: 'Markdown', disable_web_page_preview: true });
  });

  // ── /help command ─────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id, `
🤖 *ForexEdge Bot Commands*

/start — Welcome message
/link — Connect your account
/signals — Today's active signals
/performance — Monthly stats
/help — This message

📱 Access your full dashboard:
${process.env.FRONTEND_URL}/dashboard
    `, { parse_mode: 'Markdown', disable_web_page_preview: true });
  });

  // ── Handle inline keyboard callbacks ─────────────────────
  bot.on('callback_query', async (query) => {
    const { data, message } = query;
    await bot.answerCallbackQuery(query.id);

    if (data.startsWith('signal_')) {
      const signalId = data.replace('signal_', '');
      await bot.sendMessage(message.chat.id,
        `[View full signal analysis](${process.env.FRONTEND_URL}/signals/${signalId})`,
        { parse_mode: 'Markdown', disable_web_page_preview: false }
      );
    }
  });

  // ── Handle errors ─────────────────────────────────────────
  bot.on('polling_error', (err) => {
    console.error('[Telegram polling error]', err.code, err.message);
  });

  return bot;
}

// ── Link account via deep link token ─────────────────────────
async function handleLinkAccount(chatId, token, telegramUser) {
  // Token is the user's JWT or a special link token stored in their profile
  // For simplicity: token = base64(userId)
  try {
    const userId = Buffer.from(token, 'base64').toString('utf8');
    const user   = await User.findById(userId);
    if (!user) {
      return bot.sendMessage(chatId, '❌ Invalid link. Please try again from your dashboard.');
    }

    await User.findByIdAndUpdate(userId, {
      telegramChatId:   chatId.toString(),
      telegramUsername: telegramUser.username || null,
      telegramLinked:   true,
    });

    await bot.sendMessage(chatId, `
✅ *Account linked successfully!*

Welcome, ${user.firstName}! 

You'll now receive:
• ⚡ Signal alerts in real time
• 📊 TP/SL update notifications
• 🔔 Live session reminders
• 📋 Daily market briefings

Your plan: *${user.plan.toUpperCase()}*

Type /signals to see today's active signals.
    `, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[Link account error]', err);
    bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
}

// ── Send new signal to Telegram channel ──────────────────────
async function sendSignalToTelegram(signal) {
  if (!bot) return null;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return null;

  const text = formatSignalMessage(signal);
  const msg  = await bot.sendMessage(channelId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '📊 View analysis', callback_data: `signal_${signal._id}` },
        { text: '📱 Open dashboard', url: `${process.env.FRONTEND_URL}/signals` },
      ]],
    },
  });

  // Also send to all individual subscribers with matching plan
  const subscribers = await User.find({
    telegramChatId: { $ne: null },
    telegramLinked: true,
    plan: { $ne: 'free' },
  }).lean();

  for (const user of subscribers) {
    try {
      await bot.sendMessage(user.telegramChatId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '📱 Open dashboard', url: `${process.env.FRONTEND_URL}/signals` },
          ]],
        },
      });
    } catch (err) {
      // User blocked bot or chat not found — unlink
      if (err.code === 403) {
        await User.findByIdAndUpdate(user._id, { telegramLinked: false });
      }
    }
  }

  return msg?.message_id?.toString();
}

// ── Notify signal result (TP hit / SL hit) ────────────────────
async function notifySignalResult(signal) {
  if (!bot) return;

  const isWin = signal.status.startsWith('tp');
  const emoji  = isWin ? '✅' : '❌';
  const result = isWin ? `TP Hit` : 'SL Hit';
  const pips   = signal.pips >= 0 ? `+${signal.pips}` : `${signal.pips}`;

  const text = `
${emoji} *${signal.pair} — ${result}*

${isWin ? '🟢' : '🔴'} *${pips} pips*
Direction: ${signal.direction.toUpperCase()}
Entry: \`${signal.entry}\`
Closed at: \`${signal.closedPrice || '—'}\`
R:R: ${signal.rr}

_${isWin
  ? 'Another clean result. Well executed — stay disciplined for the next one.'
  : 'Stop loss respected. Capital preserved. That\'s risk management working as intended.'
}_

[View full log](${process.env.FRONTEND_URL}/performance)
  `;

  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (channelId) {
    await bot.sendMessage(channelId, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
  }
}

// ── Daily market briefing ─────────────────────────────────────
async function sendDailyBriefing(briefingText) {
  if (!bot) return;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return;

  await bot.sendMessage(channelId, `
🌅 *ForexEdge — Daily Market Briefing*

${briefingText}

📊 [View signals](${process.env.FRONTEND_URL}/signals) | 📱 [Dashboard](${process.env.FRONTEND_URL}/dashboard)

_Educational content only. Not financial advice._
  `, { parse_mode: 'Markdown', disable_web_page_preview: true });
}

// ── Grant / revoke Telegram channel access ────────────────────
async function grantTelegramAccess(user, plan) {
  if (!bot || !user.telegramChatId) return;
  // For private channels: use invite links or chat member approval
  // This is simplified — in production, manage invite links per tier
  await bot.sendMessage(user.telegramChatId, `
🎉 *${plan.toUpperCase()} plan activated!*

Your signal access is now live. You'll receive alerts for all signals immediately.

Type /signals to see what's active right now.
  `, { parse_mode: 'Markdown' });
}

async function revokeTelegramAccess(user) {
  if (!bot || !user.telegramChatId) return;
  await bot.sendMessage(user.telegramChatId, `
ℹ️ *Subscription cancelled*

Your paid signal access has ended. You can re-subscribe anytime at:
${process.env.FRONTEND_URL}/pricing

Thank you for being a ForexEdge member.
  `, { parse_mode: 'Markdown', disable_web_page_preview: true });
}

// ── Format signal message ─────────────────────────────────────
function formatSignalMessage(signal) {
  const dir    = signal.direction.toUpperCase();
  const emoji  = signal.direction === 'long' ? '🟢' : '🔴';
  const status = {
    active: '⚡ ACTIVE',
    tp1:    '✅ TP1 HIT',
    tp2:    '✅ TP2 HIT',
    sl:     '❌ SL HIT',
    closed: '⚪ CLOSED',
  }[signal.status] || '⚡ ACTIVE';

  return `
${emoji} *${signal.pair} — ${dir}* ${status}

📍 *Entry:* \`${signal.entry}\`
🎯 *TP1:* \`${signal.tp1}\`${signal.tp2 ? `\n🎯 *TP2:* \`${signal.tp2}\`` : ''}
🛑 *Stop loss:* \`${signal.sl}\`
⚖️ *Risk:Reward:* ${signal.rr}
👤 *Analyst:* ${signal.analystName}
${signal.note ? `\n💬 _${signal.note}_` : ''}

_Educational only • Not financial advice_`.trim();
}

module.exports = {
  initTelegramBot,
  sendSignalToTelegram,
  notifySignalResult,
  sendDailyBriefing,
  grantTelegramAccess,
  revokeTelegramAccess,
  getBot: () => bot,
};
