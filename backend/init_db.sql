-- OpenRemit + Fireline database schema
-- Run: sqlite3 backend/openremit.db < backend/init_db.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar        TEXT,
  wallet_address TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id                      TEXT PRIMARY KEY,
  status                  TEXT NOT NULL,
  payment_type            TEXT NOT NULL,
  sender_wallet_address   TEXT NOT NULL,
  receiver_wallet_address TEXT NOT NULL,
  debit_amount            TEXT,
  receive_amount          TEXT,
  asset_code              TEXT NOT NULL,
  asset_scale             INTEGER NOT NULL,
  receive_asset_code      TEXT,
  receive_asset_scale     INTEGER,
  incoming_payment_url    TEXT,
  quote_url               TEXT,
  outgoing_payment_url    TEXT,
  quote_expires_at        INTEGER,
  grant_continue_uri      TEXT,
  grant_continue_token    TEXT,
  grant_interact_nonce    TEXT,
  user_id                 TEXT REFERENCES users(id),
  error_message           TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_requests (
  id            TEXT PRIMARY KEY,
  requester_id  TEXT NOT NULL REFERENCES users(id),
  payer_id      TEXT NOT NULL REFERENCES users(id),
  payment_type  TEXT NOT NULL,
  amount        TEXT NOT NULL,
  asset_code    TEXT NOT NULL,
  asset_scale   INTEGER NOT NULL,
  note          TEXT,
  status        TEXT NOT NULL,
  transaction_id TEXT REFERENCES transactions(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id            TEXT PRIMARY KEY,
  author_name   TEXT NOT NULL,
  author_avatar TEXT,
  title         TEXT NOT NULL,
  excerpt       TEXT NOT NULL,
  body          TEXT NOT NULL,
  category      TEXT,
  price         TEXT NOT NULL,
  streaming     INTEGER,
  free_to_read  INTEGER,
  stream_limit  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS post_unlocks (
  id                 TEXT PRIMARY KEY,
  post_id            TEXT NOT NULL REFERENCES posts(id),
  user_id            TEXT NOT NULL REFERENCES users(id),
  method             TEXT,
  transaction_id     TEXT REFERENCES transactions(id),
  wm_incoming_payment TEXT,
  wm_amount_value    TEXT,
  wm_asset_code      TEXT,
  wm_asset_scale     INTEGER,
  status             TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- Fireline: Community Fire-Relief Mutual

CREATE TABLE IF NOT EXISTS groups (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  pool_wallet_address     TEXT NOT NULL,
  backstop_wallet_address TEXT NOT NULL,
  fixed_payout_amount     TEXT NOT NULL,
  reserve_floor           TEXT NOT NULL,
  covariate_threshold     INTEGER NOT NULL,
  design_capacity         TEXT NOT NULL,
  pool_balance            TEXT NOT NULL,
  asset_code              TEXT NOT NULL,
  asset_scale             INTEGER NOT NULL,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fire_events (
  id             TEXT PRIMARY KEY,
  group_id       TEXT NOT NULL REFERENCES groups(id),
  location       TEXT NOT NULL,
  occurred_at    INTEGER NOT NULL,
  reported_at    INTEGER NOT NULL,
  classification TEXT NOT NULL,
  claim_count    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id),
  event_id        TEXT NOT NULL REFERENCES fire_events(id),
  claimant_wallet TEXT NOT NULL,
  status          TEXT NOT NULL,
  payout_amount   TEXT,
  payout_source   TEXT,
  transaction_id  TEXT REFERENCES transactions(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
