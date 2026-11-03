-- Base tables. Every table carries created_ms and network.
-- No table holds a stop level: stops live only inside the guard.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  near_account TEXT UNIQUE,
  private_wallet_id TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,            -- sha256 hex of the cookie value
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_ms INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);
CREATE INDEX sessions_expires ON sessions(expires_ms);

CREATE TABLE sign_in_nonces (
  nonce TEXT PRIMARY KEY,         -- base64 of 32 bytes
  expires_ms INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);
CREATE INDEX sign_in_nonces_expires ON sign_in_nonces(expires_ms);

CREATE TABLE pieces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  shard_id TEXT NOT NULL UNIQUE CHECK (length(shard_id) = 16 AND shard_id NOT GLOB '*[^0-9a-f]*'),
  wallet_id TEXT,
  hl_master TEXT,
  agent TEXT,
  policy_state TEXT NOT NULL DEFAULT 'locked' CHECK (policy_state IN ('unlocked', 'locked', 'exit_unlocked')),
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  coin TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  notional_usd REAL NOT NULL,
  leverage INTEGER NOT NULL,
  hiding TEXT NOT NULL CHECK (hiding IN ('normal', 'whale')),
  state TEXT NOT NULL CHECK (state IN ('planned', 'opening', 'open', 'closing', 'closed', 'failed')),
  plan_json TEXT,
  vrf_hex TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE piece_orders (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions(id),
  piece_id TEXT NOT NULL REFERENCES pieces(id),
  kind TEXT NOT NULL CHECK (kind IN ('open', 'cut', 'close', 'stop', 'tp')),
  size REAL,
  px REAL,
  hl_oid TEXT,
  fee REAL,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE fundings (
  id TEXT PRIMARY KEY,
  piece_id TEXT NOT NULL REFERENCES pieces(id),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'refill')),
  amount REAL NOT NULL,
  fee REAL,
  route TEXT,
  request_id TEXT,
  deposit_address TEXT,
  status TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

-- What each guard tick did, never a stop level.
CREATE TABLE ticks (
  id TEXT PRIMARY KEY,
  coin TEXT NOT NULL,
  shards_json TEXT,
  done_json TEXT,
  band_json TEXT,
  call_id TEXT,
  cost REAL,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE proofs (
  id TEXT PRIMARY KEY,
  uid TEXT,
  call_id TEXT,
  totals_json TEXT,
  onchain_tx TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL UNIQUE,
  limits_json TEXT,
  fee REAL,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE agent_calls (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  op TEXT NOT NULL,
  fee REAL,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT,
  payload_sha256 TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);
CREATE INDEX evidence_kind ON evidence(network, kind);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_ms INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,
  last_error TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);
CREATE INDEX jobs_due ON jobs(state, next_run_ms);
