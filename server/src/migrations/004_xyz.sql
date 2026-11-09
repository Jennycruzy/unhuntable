-- trade.xyz (HIP-3 stocks on Hyperliquid) keeps its own margin balance. A chain-signature
-- piece moves its USDC onto it before opening (xyz_in, signed with the position) and back
-- before going home (home_from_xyz). position_id ties an xyz_in request to its position.
CREATE TABLE chainsig_requests_new (
  id TEXT PRIMARY KEY,
  piece_id TEXT NOT NULL REFERENCES pieces(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('approve_agent', 'home_to_spot', 'home_send', 'xyz_in', 'home_from_xyz')),
  home_id TEXT,
  position_id TEXT,
  counter INTEGER NOT NULL,
  action_json TEXT NOT NULL,
  signature TEXT,
  state TEXT NOT NULL CHECK (state IN ('unsigned', 'signed', 'sent', 'done', 'failed')),
  near_tx TEXT,
  mpc_json TEXT,
  error TEXT,
  created_ms INTEGER NOT NULL,
  network TEXT NOT NULL
);
INSERT INTO chainsig_requests_new (id, piece_id, purpose, home_id, counter, action_json, signature, state, near_tx, mpc_json, error, created_ms, network)
  SELECT id, piece_id, purpose, home_id, counter, action_json, signature, state, near_tx, mpc_json, error, created_ms, network FROM chainsig_requests;
DROP TABLE chainsig_requests;
ALTER TABLE chainsig_requests_new RENAME TO chainsig_requests;
CREATE INDEX chainsig_requests_piece ON chainsig_requests(piece_id, purpose, state);
CREATE INDEX chainsig_requests_position ON chainsig_requests(position_id, piece_id);
