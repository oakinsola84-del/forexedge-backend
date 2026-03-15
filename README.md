# ForexEdge Backend

Node.js + Express + MongoDB backend for the ForexEdge forex education platform.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Database | MongoDB (Mongoose) |
| Auth | JWT (access + refresh tokens) |
| Payments | Stripe (subscriptions + webhooks) |
| Telegram | node-telegram-bot-api |
| Forex Data | Twelve Data API |
| Email | Nodemailer + Resend |
| Scheduler | node-cron |

---

## Quick Start

### 1. Clone and install
```bash
git clone https://github.com/yourname/forexedge-backend
cd forexedge-backend
npm install
```

### 2. Environment variables
```bash
cp .env.example .env
# Fill in all values in .env
```

### 3. Set up MongoDB Atlas (free)
1. Go to [mongodb.com/atlas](https://mongodb.com/atlas)
2. Create a free cluster
3. Get connection string → paste into `MONGODB_URI`

### 4. Set up Stripe
1. Create account at [stripe.com](https://stripe.com)
2. Get test keys from Dashboard → Developers → API keys
3. Create 6 products/prices (Starter/Pro/Elite × Monthly/Annual)
4. Copy each Price ID into `.env`
5. Set up webhook: `stripe listen --forward-to localhost:4000/api/stripe/webhook`

### 5. Create Telegram bot
1. Open Telegram, message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`, follow prompts
3. Copy the token into `TELEGRAM_BOT_TOKEN`
4. Create a private channel for signals, get the channel ID

### 6. Get Twelve Data API key
1. Sign up at [twelvedata.com](https://twelvedata.com)
2. Free tier: 800 requests/day
3. Copy key into `TWELVE_DATA_KEY`

### 7. Run development server
```bash
npm run dev
# Server starts on http://localhost:4000
# Health check: http://localhost:4000/health
```

---

## API Reference

### Auth
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | None | Create account |
| POST | `/api/auth/login` | None | Login |
| POST | `/api/auth/refresh` | None | Refresh access token |
| POST | `/api/auth/forgot-password` | None | Send reset email |
| POST | `/api/auth/reset-password` | None | Reset password |
| POST | `/api/auth/logout` | None | Invalidate refresh token |

### Signals
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/signals` | Required | Get signals (filtered by plan) |
| GET | `/api/signals/:id` | Required | Get single signal |
| POST | `/api/signals` | Analyst/Admin | Create signal + send to Telegram |
| PATCH | `/api/signals/:id/status` | Analyst/Admin | Update status (TP/SL/close) |
| GET | `/api/signals/stats/performance` | Required | Monthly performance logs |

### Forex
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/forex/prices` | None | All cached live prices |
| GET | `/api/forex/price/:pair` | None | Single pair price |
| GET | `/api/forex/candles` | None | Historical candles |

### Stripe
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/stripe/create-checkout` | Required | Create Stripe Checkout session |
| POST | `/api/stripe/create-portal` | Required | Open billing portal |
| GET | `/api/stripe/subscription` | Required | Get subscription status |
| POST | `/api/stripe/webhook` | Stripe sig | Webhook handler |

### Users
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/users/me` | Required | Get current user |
| PATCH | `/api/users/me` | Required | Update profile |
| POST | `/api/users/link-telegram` | Required | Generate Telegram link token |
| GET | `/api/users` | Admin | List all users |

### Telegram
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/telegram/send-test` | Required | Send test message to linked Telegram |
| DELETE | `/api/telegram/unlink` | Required | Unlink Telegram account |

---

## Deployment

### Railway (recommended — easiest)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
# Set env vars in Railway dashboard
```

### Render
1. Connect GitHub repo at render.com
2. Build command: `npm install`
3. Start command: `node server.js`
4. Set all environment variables in dashboard

### Fly.io
```bash
flyctl launch
flyctl secrets set MONGODB_URI=... STRIPE_SECRET_KEY=... # etc
flyctl deploy
```

### Stripe webhook in production
```bash
# Register your webhook endpoint in Stripe Dashboard:
# https://dashboard.stripe.com/webhooks
# URL: https://your-backend.railway.app/api/stripe/webhook
# Events to listen for:
#   customer.subscription.created
#   customer.subscription.updated
#   customer.subscription.deleted
#   customer.subscription.trial_will_end
#   invoice.payment_succeeded
#   invoice.payment_failed
```

---

## Security checklist

- [x] Helmet.js headers
- [x] CORS restricted to frontend domain
- [x] Rate limiting on all API routes
- [x] Stricter rate limiting on auth endpoints
- [x] JWT with short expiry + refresh token rotation
- [x] Passwords hashed with bcrypt (12 rounds)
- [x] Stripe webhook signature verification
- [x] Input validation with express-validator
- [x] MongoDB injection protection (Mongoose)
- [x] No API keys in frontend code
- [ ] Add HTTPS (handled by hosting platform)
- [ ] Add Redis for session caching at scale
- [ ] Add Sentry for error monitoring

---

## Folder structure

```
forexedge-backend/
├── server.js               # Entry point
├── package.json
├── .env.example            # Environment template
├── models/
│   └── index.js            # User, Signal, SubEvent, PerfLog
├── routes/
│   ├── auth.js             # Register, login, tokens
│   ├── users.js            # Profile management
│   ├── signals.js          # Signal CRUD
│   ├── forex.js            # Live price endpoints
│   ├── stripe.js           # Payments + webhooks
│   └── telegram.js         # Bot management
├── middleware/
│   ├── auth.js             # JWT + role/plan guards
│   └── rateLimiter.js      # Rate limiting + error handler
└── services/
    ├── forexService.js     # Price cache + Twelve Data
    ├── telegramService.js  # Bot + signal broadcasting
    ├── emailService.js     # Transactional emails
    └── signalCron.js       # Scheduled jobs
```
