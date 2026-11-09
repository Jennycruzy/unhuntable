-- Pieces whose Hyperliquid account is controlled by NEAR Chain Signatures through the
-- signer contract. Such a piece has no OutLayer wallet: its piece key (made from the
-- user's 12 words, kept only in the browser) authorises each action, and our relay only
-- pays the gas.
ALTER TABLE pieces ADD COLUMN control TEXT NOT NULL DEFAULT 'outlayer' CHECK (control IN ('outlayer', 'near'));
ALTER TABLE pieces ADD COLUMN piece_key TEXT CHECK (piece_key IS NULL OR (length(piece_key) = 64 AND piece_key NOT GLOB '*[^0-9a-f]*'));

-- One Hyperliquid action for a chain-signature piece: what the piece key signed, and what
-- happened to it. state: unsigned (waiting for the browser), signed, sent (NEAR signed it),
-- done (Hyperliquid took it), failed.
CREATE TABLE chainsig_requests (
  id TEXT PRIMARY KEY,
  piece_id TEXT NOT NULL REFERENCES pieces(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('approve_agent', 'home_to_spot', 'home_send')),
  home_id TEXT,
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
CREATE INDEX chainsig_requests_piece ON chainsig_requests(piece_id, purpose, state);

-- Going home with chain-signature pieces: the browser signs their moves; with OutLayer
-- pieces the wallet approves the unlock. Moving starts when both are in.
ALTER TABLE homes ADD COLUMN policies_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE homes ADD COLUMN sigs_ok INTEGER NOT NULL DEFAULT 1;
