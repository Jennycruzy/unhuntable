-- Money flows: wallets with labels and seeds, policy states, deposits, going home, refills
-- and per-user settings. SQLite cannot change a CHECK in place, so pieces and positions are
-- rebuilt: create the new table, copy, drop the old one, rename. The migration runner runs
-- this in one transaction with foreign keys checked after.
-- No column holds a stop or take-profit level.

-- pieces: every wallet a user has with us. kind 'balance' is the private balance (no shard),
-- kind 'piece' is one Hyperliquid account. policy_state 'none' until a policy is read back.
CREATE TABLE pieces_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT,
  seed TEXT,
  kind TEXT NOT NULL DEFAULT 'piece' CHECK (kind IN ('balance', 'piece')),
  shard_id TEXT UNIQUE CHECK (shard_id IS NULL OR (length(shard_id) = 16 AND shard_id NOT GLOB '*[^0-9a-f]*')),
  wallet_id TEXT,
  wallet_pubkey TEXT,
  key_hash TEXT,
  hl_master TEXT,
  hl_address TEXT,
  agent TEXT,
  policy_state TEXT NOT NULL DEFAULT 'none' CHECK (policy_state IN ('none', 'locked', 'unlocked')),
  policy_json TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL,
  CHECK (kind = 'balance' OR shard_id IS NOT NULL),
  UNIQUE (user_id, label)
);
INSERT INTO pieces_new (id, user_id, kind, shard_id, wallet_id, hl_master, hl_address, agent, policy_state, created_ms, network)
  SELECT id, user_id, 'piece', shard_id, wallet_id, hl_master, hl_master, agent,
         CASE policy_state WHEN 'exit_unlocked' THEN 'unlocked' ELSE policy_state END,
         created_ms, network
  FROM pieces;
DROP TABLE pieces;
ALTER TABLE pieces_new RENAME TO pieces;

ALTER TABLE users ADD COLUMN pieces_public_key TEXT;

CREATE TABLE positions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  coin TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  notional_usd REAL NOT NULL,
  leverage INTEGER NOT NULL,
  hiding TEXT NOT NULL CHECK (hiding IN ('normal', 'whale')),
  state TEXT NOT NULL CHECK (state IN ('planned', 'funding', 'policy_wait', 'opening', 'open', 'closing', 'closed', 'failed')),
  plan_json TEXT,
  vrf_hex TEXT,
  vrf_proof TEXT,
  vrf_alpha TEXT,
  guard TEXT NOT NULL DEFAULT 'ok' CHECK (guard IN ('ok', 'unreachable')),
  start_ms INTEGER,
  close_now INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);
INSERT INTO positions_new (id, user_id, coin, side, notional_usd, leverage, hiding, state, plan_json, vrf_hex, created_ms, network)
  SELECT id, user_id, coin, side, notional_usd, leverage, hiding, state, plan_json, vrf_hex, created_ms, network FROM positions;
DROP TABLE positions;
ALTER TABLE positions_new RENAME TO positions;

-- Which piece holds which part of a position. has_stop and has_tp say only whether one is set.
CREATE TABLE position_pieces (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions(id),
  piece_id TEXT NOT NULL REFERENCES pieces(id),
  idx INTEGER NOT NULL,
  size REAL NOT NULL,
  funding_usd REAL NOT NULL,
  entry_offset_ms INTEGER NOT NULL,
  reused INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned', 'funding', 'funded', 'ready', 'opening', 'open', 'closing', 'closed', 'failed')),
  funding_request_id TEXT,
  entry_px REAL,
  liq_distance REAL,
  band_lo REAL,
  band_hi REAL,
  has_stop INTEGER NOT NULL DEFAULT 0,
  has_tp INTEGER NOT NULL DEFAULT 0,
  close_at_ms INTEGER,
  last_tick_ms INTEGER,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL,
  UNIQUE (position_id, idx)
);

CREATE TABLE deposits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  route TEXT NOT NULL CHECK (route IN ('near', 'aurora')),
  chain TEXT NOT NULL,
  token TEXT NOT NULL,
  amount_in TEXT,
  amount_out TEXT,
  deposit_address TEXT NOT NULL,
  quote_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'seen', 'done', 'refunded', 'expired')),
  expires_ms INTEGER,
  min_amount TEXT,
  balance_before TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE homes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK (state IN ('unlock_wait', 'moving', 'relock_wait', 'done', 'failed')),
  labels_json TEXT NOT NULL,
  fee_usd REAL,
  arrived_usdc TEXT,
  had_failure INTEGER NOT NULL DEFAULT 0,
  unlock_json TEXT,
  relock_json TEXT,
  updated_ms INTEGER,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE home_steps (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id),
  piece_id TEXT REFERENCES pieces(id),
  step TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('done', 'skipped', 'failed', 'waiting')),
  detail TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE refills (
  id TEXT PRIMARY KEY,
  piece_id TEXT NOT NULL REFERENCES pieces(id),
  amount REAL NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'done', 'failed')),
  request_id TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  auto_refill INTEGER NOT NULL DEFAULT 0,
  refill_cap_usd_per_day REAL NOT NULL DEFAULT 0,
  exit_addresses_json TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

ALTER TABLE alerts ADD COLUMN position_id TEXT REFERENCES positions(id);

-- Every guard call: which op, for which shard, and whether it answered.
CREATE TABLE guard_calls (
  id TEXT PRIMARY KEY,
  op TEXT NOT NULL,
  shard_id TEXT,
  ok INTEGER NOT NULL,
  error TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);
