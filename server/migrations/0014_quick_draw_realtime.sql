-- Authenticated server-push Quick Draw transport with auditable latency data.
ALTER TABLE pvp_matches ADD COLUMN quick_draw_issued_at INTEGER;
ALTER TABLE pvp_round_scores ADD COLUMN raw_reaction_ms INTEGER;
ALTER TABLE pvp_round_scores ADD COLUMN rtt_adjustment_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pvp_round_scores ADD COLUMN reaction_transport TEXT
  CHECK(reaction_transport IN ('websocket','rest'));

CREATE TABLE IF NOT EXISTS pvp_socket_tickets (
  token_hash TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES pvp_matches(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pvp_socket_tickets_account_match
  ON pvp_socket_tickets(account_id, match_id, expires_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_socket_tickets_expiry
  ON pvp_socket_tickets(expires_at_ms);
