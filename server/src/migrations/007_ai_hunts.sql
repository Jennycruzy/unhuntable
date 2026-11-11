-- NEAR AI Hunter: an AI model in a NEAR AI Cloud TEE tries to find the other pieces of one
-- of the owner's positions from Hyperliquid's public data. Each run keeps the lineup it was
-- shown (owner only), what it named, the score, and the exact request and answer bytes with
-- the enclave's signature so the check can be redone.
CREATE TABLE ai_hunts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed')),
  verdict TEXT CHECK (verdict IN ('held', 'partly', 'caught')),
  lineup_json TEXT,
  answer_json TEXT,
  score_json TEXT,
  proof_json TEXT,
  request_text TEXT,
  response_text TEXT,
  error TEXT,
  created_ms INTEGER NOT NULL,
  done_ms INTEGER,
  network TEXT NOT NULL
);
CREATE INDEX ai_hunts_user ON ai_hunts(user_id, created_ms);
CREATE INDEX ai_hunts_position ON ai_hunts(position_id, created_ms);
