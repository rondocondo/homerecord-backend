# HomeRecord — Backend API

The Node.js/Express/PostgreSQL backend that powers HomeRecord.

---

## Stack
- **Node.js + Express** — API server
- **PostgreSQL** — main database
- **Stripe** — payment processing ($39/report)
- **JWT** — authentication
- **Chicago Open Data API** — free live permit data

---

## Quick start (local development)

### 1. Install dependencies
```bash
cd homerecord-backend
npm install
```

### 2. Set up PostgreSQL
```bash
# macOS
brew install postgresql@15
brew services start postgresql@15
createdb homerecord
createuser homerecord
psql -c "ALTER USER homerecord WITH PASSWORD 'yourpassword';"
psql -c "GRANT ALL PRIVILEGES ON DATABASE homerecord TO homerecord;"

# Ubuntu/Debian
sudo apt install postgresql
sudo -u postgres createdb homerecord
sudo -u postgres createuser homerecord
sudo -u postgres psql -c "ALTER USER homerecord WITH PASSWORD 'yourpassword';"
```

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env — fill in DB password, JWT secret, Stripe keys
```

### 4. Run database migration
```bash
npm run db:migrate
# Creates all tables: users, properties, property_events,
# verifications, deep_dive_details, ownership_history,
# disaster_risk, property_scores, data_submissions, report_purchases
```

### 5. Start the server
```bash
npm run dev        # development (auto-restarts on changes)
npm start          # production
```

Server runs at: **http://localhost:3001**
Health check:   **http://localhost:3001/health**

---

## API endpoints

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login, get JWT token |
| GET  | `/api/auth/me` | Get current user (auth required) |

### Properties
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/api/properties/search?address=4821 N ELMWOOD` | Search properties |
| GET  | `/api/properties/:id` | Get property details |
| GET  | `/api/properties/:id/events` | Get full timeline |
| POST | `/api/properties/:id/sync` | Sync with Chicago API |

### Reports
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/api/reports/:propertyId` | Full report (requires purchase or Pro plan) |

### Payments
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payments/create-intent` | Create Stripe payment intent ($39) |
| POST | `/api/payments/webhook` | Stripe webhook (raw body) |

### Submissions (homeowner portal)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/submissions` | Submit a repair/permit record |
| GET  | `/api/submissions/mine` | Get my submissions |

### Admin
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET   | `/api/admin/submissions?status=pending` | Review queue |
| PATCH | `/api/admin/submissions/:id` | Approve / reject / request info |
| GET   | `/api/admin/stats` | Dashboard stats |

---

## Authentication

All protected routes require a JWT token in the Authorization header:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

Get a token by calling `POST /api/auth/login`.

---

## Stripe setup (payments)

1. Create a free Stripe account at stripe.com
2. Copy your test keys to `.env`
3. Set up a webhook at stripe.com/webhooks pointing to:
   `https://your-domain.com/api/payments/webhook`
4. Select event: `payment_intent.succeeded`
5. Copy webhook signing secret to `.env`

---

## Deploying to production

### Option A — Railway (easiest, ~$5/mo)
```bash
npm install -g @railway/cli
railway login
railway init
railway add postgresql
railway up
```
Set environment variables in the Railway dashboard.

### Option B — Render (free tier available)
1. Push this folder to GitHub
2. Create a new Web Service on render.com
3. Add a PostgreSQL database
4. Set environment variables
5. Deploy

### Option C — DigitalOcean App Platform
Similar to Render — connect GitHub repo, add managed PostgreSQL, deploy.

---

## Project structure

```
homerecord-backend/
├── src/
│   ├── server.js              # Express app entry point
│   ├── db/
│   │   ├── index.js           # PostgreSQL connection pool
│   │   ├── migrate.js         # Creates all tables
│   │   └── seed.js            # Sample data (optional)
│   ├── middleware/
│   │   └── auth.js            # JWT + admin middleware
│   ├── routes/
│   │   ├── auth.js            # Register, login, me
│   │   ├── properties.js      # Search, events, sync
│   │   ├── reports.js         # Full report delivery
│   │   └── submissions.js     # Submissions + payments + admin
│   └── services/
│       └── chicagoData.js     # Chicago Open Data integration
├── .env.example
├── package.json
└── README.md
```

---

## Next steps
- [ ] Add FEMA flood zone lookup service
- [ ] Add county assessor (ownership/sale history) integration
- [ ] Build background sync job (cron) to refresh permit data
- [ ] Add email notifications (submission approved/rejected)
- [ ] Add S3 document upload for homeowner files
- [ ] Build the React frontend that consumes this API
