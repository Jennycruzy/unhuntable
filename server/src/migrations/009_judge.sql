-- Judge mode: a judge with the access code opens one small real trade on our own demo
-- account, with no wallet and no money. One run at a time, a few a day, each closed by
-- itself after ten minutes. The run's token is kept only as a hash.
CREATE TABLE judge_runs (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  position_id TEXT NOT NULL REFERENCES positions(id),
  state TEXT NOT NULL CHECK (state IN ('live', 'done')),
  has_stop INTEGER NOT NULL DEFAULT 0,
  open_ms INTEGER,
  created_ms INTEGER NOT NULL,
  ends_ms INTEGER NOT NULL,
  done_ms INTEGER,
  network TEXT NOT NULL
);
CREATE INDEX judge_runs_state ON judge_runs(state, ends_ms);
