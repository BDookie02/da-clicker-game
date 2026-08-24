ALTER TABLE pvp_matches ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pvp_matches ADD COLUMN result_reason TEXT CHECK(result_reason IN (
  'no_input','incomplete_round','tie_limit','stale_timeout',
  'friend_removed','blocked_player','cancelled_by_inviter','rollout_recovery'
));

-- This migration is the first deployment of the locking model. Any match
-- created by an older Worker has no atomic player locks and cannot safely be
-- resumed under the new concurrency rules, so close it without a winner or
-- reward before accepting new invitations.
UPDATE pvp_matches SET status='cancelled',result_reason='rollout_recovery',updated_at=datetime('now'),
  state_revision=state_revision+1
WHERE status IN ('invited','active');

-- Stale cleanup runs on state fetch and invite. These indexes keep it scoped
-- to the two live status ranges instead of scanning retained match history.
CREATE INDEX IF NOT EXISTS idx_pvp_matches_status_created
  ON pvp_matches(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pvp_matches_status_updated
  ON pvp_matches(status, updated_at);

-- One active/invited match may own a player at a time.  Invitations acquire
-- both rows in the same D1 batch as the match insert, so a competing invite
-- fails atomically instead of racing a separate "busy" SELECT.
CREATE TABLE IF NOT EXISTS pvp_player_locks (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL REFERENCES pvp_matches(id) ON DELETE CASCADE,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pvp_player_locks_match
  ON pvp_player_locks(match_id);

-- Every terminal transition, including moderation/blocking code outside the
-- multiplayer module, releases both players without relying on a later poll.
CREATE TRIGGER IF NOT EXISTS trg_pvp_release_locks_terminal
AFTER UPDATE OF status ON pvp_matches
WHEN NEW.status IN ('completed','declined','cancelled')
BEGIN
  DELETE FROM pvp_player_locks WHERE match_id=NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_pvp_release_locks_deleted
AFTER DELETE ON pvp_matches
BEGIN
  DELETE FROM pvp_player_locks WHERE match_id=OLD.id;
END;
