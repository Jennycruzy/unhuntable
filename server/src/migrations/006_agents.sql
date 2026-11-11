-- AI agents trade through the owner's ready pieces with their own key and limits, and pay
-- per call with x402. The key itself is never stored, only its sha256.
-- The first schema had two empty tables for this that nothing ever used; they go.
DROP TABLE agent_calls;
DROP TABLE agents;
CREATE TABLE agent_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  max_notional_usd REAL NOT NULL,
  coins_json TEXT NOT NULL,
  daily_opens INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  revoked_ms INTEGER,
  network TEXT NOT NULL
);
CREATE INDEX agent_keys_user ON agent_keys(user_id);
CREATE TABLE agent_calls (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES agent_keys(id),
  op TEXT NOT NULL,
  position_id TEXT,
  price TEXT,
  payer TEXT,
  paid_tx TEXT,
  result TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);
CREATE INDEX agent_calls_key ON agent_calls(key_id, created_ms);
ALTER TABLE positions ADD COLUMN agent_key_id TEXT;
