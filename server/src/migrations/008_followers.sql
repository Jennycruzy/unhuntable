-- Followers: a trader sells keys. A copy key copies the trader's crypto trades into the
-- follower's own pieces; a viewing key shows the trader's closed trades. Nobody, key holders
-- included, ever sees a trader's open positions, stops or piece accounts.
-- Keys are paid day by day with private transfers (Confidential Intents) from the follower's
-- private balance to the trader's, only while the key is on.
CREATE TABLE traders (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  handle TEXT NOT NULL UNIQUE,
  copy_usd_day REAL NOT NULL,
  view_usd_day REAL NOT NULL,
  open INTEGER NOT NULL DEFAULT 1,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE follow_keys (
  id TEXT PRIMARY KEY,
  trader_id TEXT NOT NULL REFERENCES users(id),
  holder_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('copy', 'view')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'paused', 'stopped')),
  usd_day REAL NOT NULL,
  copy_usd REAL,
  paid_through_ms INTEGER,
  pause_reason TEXT,
  created_ms INTEGER NOT NULL,
  ended_ms INTEGER,
  network TEXT NOT NULL
);
CREATE INDEX follow_keys_trader ON follow_keys(trader_id, state);
CREATE INDEX follow_keys_holder ON follow_keys(holder_id, state);

CREATE TABLE key_payments (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES follow_keys(id),
  amount_usd REAL NOT NULL,
  request_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('sent', 'done', 'failed')),
  period_end_ms INTEGER NOT NULL,
  error TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);
CREATE INDEX key_payments_key ON key_payments(key_id, created_ms);

CREATE TABLE copies (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES follow_keys(id),
  leader_position_id TEXT NOT NULL REFERENCES positions(id),
  follower_position_id TEXT REFERENCES positions(id),
  state TEXT NOT NULL CHECK (state IN ('waiting', 'opened', 'needs_app', 'skipped', 'closing', 'closed')),
  reason TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL,
  UNIQUE (key_id, leader_position_id)
);
CREATE INDEX copies_leader ON copies(leader_position_id);

-- The guard's signed totals for one trader (EAS off-chain attestation), newest first.
CREATE TABLE trader_records (
  id TEXT PRIMARY KEY,
  trader_id TEXT NOT NULL REFERENCES users(id),
  eas_json TEXT NOT NULL,
  totals_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);
CREATE INDEX trader_records_trader ON trader_records(trader_id, created_ms);

-- A copy points at the trader's position it copies. result_json: realized result read from
-- Hyperliquid's fills once the position is closed.
ALTER TABLE positions ADD COLUMN copy_of TEXT;
ALTER TABLE positions ADD COLUMN result_json TEXT;
