// HomeRecord — Database migration
// Run: node src/db/migrate.js
require('dotenv').config();
const db = require('./index');

async function migrate() {
  console.log('🗄️  Running HomeRecord database migration…\n');

  await db.query(`
    -- Enable UUID generation
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    -- ── USERS ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      user_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email         VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name     VARCHAR(255),
      role          VARCHAR(50)  DEFAULT 'buyer'
                    CHECK (role IN ('buyer','agent','investor','lender','admin')),
      plan          VARCHAR(50)  DEFAULT 'free'
                    CHECK (plan IN ('free','pro','enterprise')),
      email_verified BOOLEAN DEFAULT FALSE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── PROPERTIES ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS properties (
      property_id    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      parcel_number  VARCHAR(100) UNIQUE,
      address_full   TEXT NOT NULL,
      street_number  VARCHAR(20),
      street_dir     VARCHAR(5),
      street_name    VARCHAR(100),
      street_type    VARCHAR(20),
      city           VARCHAR(100),
      state          VARCHAR(2) DEFAULT 'IL',
      zip            VARCHAR(10),
      lat            DECIMAL(10,7),
      lng            DECIMAL(10,7),
      property_type  VARCHAR(50)
                     CHECK (property_type IN ('sfr','multi','commercial','condo','townhome','land','other')),
      year_built     SMALLINT,
      sq_ft          INTEGER,
      lot_sq_ft      INTEGER,
      bedrooms       SMALLINT,
      bathrooms      DECIMAL(3,1),
      score_overall  SMALLINT CHECK (score_overall BETWEEN 0 AND 100),
      score_repair   SMALLINT CHECK (score_repair  BETWEEN 0 AND 100),
      score_permits  SMALLINT CHECK (score_permits BETWEEN 0 AND 100),
      score_disaster SMALLINT CHECK (score_disaster BETWEEN 0 AND 100),
      score_ownership SMALLINT CHECK (score_ownership BETWEEN 0 AND 100),
      last_synced_at TIMESTAMPTZ,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_properties_address ON properties (address_full);
    CREATE INDEX IF NOT EXISTS idx_properties_zip     ON properties (zip);

    -- ── PROPERTY EVENTS (master timeline) ──────────────────────────────────
    CREATE TABLE IF NOT EXISTS property_events (
      event_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      property_id     UUID NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
      event_type      VARCHAR(50) NOT NULL
                      CHECK (event_type IN ('repair','permit','violation','sale','damage','ownership','other')),
      event_date      DATE,
      title           TEXT NOT NULL,
      description     TEXT,
      cost_estimate   NUMERIC(12,2),
      status          VARCHAR(50) DEFAULT 'unknown'
                      CHECK (status IN ('open','resolved','unknown')),
      flag_severity   VARCHAR(20) DEFAULT 'none'
                      CHECK (flag_severity IN ('none','info','warning','critical')),
      source_type     VARCHAR(50)
                      CHECK (source_type IN ('city_permit','county_deed','mls','fema','homeowner','contractor','manual')),
      source_ref_id   VARCHAR(255),
      category        VARCHAR(100),
      deep_dive_available BOOLEAN DEFAULT FALSE,
      unlock_price_cents  INTEGER DEFAULT 0,
      verified_by     UUID,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_events_property   ON property_events (property_id);
    CREATE INDEX IF NOT EXISTS idx_events_type       ON property_events (event_type);
    CREATE INDEX IF NOT EXISTS idx_events_date       ON property_events (event_date DESC);
    CREATE INDEX IF NOT EXISTS idx_events_flag       ON property_events (flag_severity);

    -- ── VERIFICATIONS ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS verifications (
      verification_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      event_id        UUID REFERENCES property_events(event_id) ON DELETE CASCADE,
      method          VARCHAR(50)
                      CHECK (method IN ('public_record','doc_upload','api_match','manual')),
      confidence      VARCHAR(50)
                      CHECK (confidence IN ('verified','likely','self_reported')),
      verified_at     TIMESTAMPTZ DEFAULT NOW(),
      verified_by_user_id UUID REFERENCES users(user_id),
      source_url      TEXT,
      doc_hash        VARCHAR(64)
    );

    -- ── DEEP DIVE DETAILS ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS deep_dive_details (
      detail_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      event_id            UUID NOT NULL REFERENCES property_events(event_id) ON DELETE CASCADE,
      contractor_name     TEXT,
      contractor_license  VARCHAR(100),
      contractor_phone    VARCHAR(30),
      materials_used      JSONB,
      warranty_term       VARCHAR(100),
      warranty_expires    DATE,
      warranty_transferable BOOLEAN,
      warranty_reg_number VARCHAR(100),
      inspection_result   VARCHAR(20)
                          CHECK (inspection_result IN ('passed','failed','pending','na')),
      inspector_notes     TEXT,
      documents           JSONB DEFAULT '[]',
      raw_api_data        JSONB,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── OWNERSHIP HISTORY ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ownership_history (
      ownership_id    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      property_id     UUID NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
      owner_name      TEXT,
      transfer_date   DATE,
      sale_price      NUMERIC(14,2),
      transfer_type   VARCHAR(50)
                      CHECK (transfer_type IN ('sale','foreclosure','gift','estate','other')),
      deed_number     VARCHAR(100),
      source          VARCHAR(50),
      verified_by     UUID,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── DISASTER RISK ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS disaster_risk (
      risk_id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      property_id         UUID NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
      fema_flood_zone     VARCHAR(20),
      flood_claims_count  SMALLINT DEFAULT 0,
      fire_incidents_count SMALLINT DEFAULT 0,
      earthquake_zone     VARCHAR(20),
      environmental_flags JSONB DEFAULT '[]',
      last_updated        TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── PROPERTY SCORES (versioned) ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS property_scores (
      score_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      property_id       UUID NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
      score_overall     SMALLINT,
      score_repair      SMALLINT,
      score_permits     SMALLINT,
      score_disaster    SMALLINT,
      score_ownership   SMALLINT,
      algorithm_version VARCHAR(20) DEFAULT 'v1.0',
      computed_at       TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── DATA SUBMISSIONS (homeowner self-reporting) ─────────────────────────
    CREATE TABLE IF NOT EXISTS data_submissions (
      submission_id    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      property_id      UUID NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
      submitted_by     UUID NOT NULL REFERENCES users(user_id),
      event_type       VARCHAR(50),
      raw_data         JSONB NOT NULL,
      review_status    VARCHAR(20) DEFAULT 'pending'
                       CHECK (review_status IN ('pending','approved','rejected','needs_info')),
      reviewer_id      UUID REFERENCES users(user_id),
      reviewer_notes   TEXT,
      created_event_id UUID,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_submissions_status ON data_submissions (review_status);
    CREATE INDEX IF NOT EXISTS idx_submissions_prop   ON data_submissions (property_id);

    -- ── REPORT PURCHASES ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS report_purchases (
      purchase_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id          UUID REFERENCES users(user_id),
      property_id      UUID NOT NULL REFERENCES properties(property_id),
      amount_cents     INTEGER NOT NULL,
      stripe_charge_id VARCHAR(255),
      stripe_pi_id     VARCHAR(255),
      status           VARCHAR(20) DEFAULT 'pending'
                       CHECK (status IN ('pending','completed','refunded','failed')),
      purchased_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_purchases_user     ON report_purchases (user_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_property ON report_purchases (property_id);
  `);

  console.log('✅ All tables created successfully.\n');
  console.log('Next: run  npm run db:seed  to add sample data');
  process.exit(0);
}

migrate().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
