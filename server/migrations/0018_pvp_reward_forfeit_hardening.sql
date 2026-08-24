-- Preserve reward/cooldown history independently of accounts and matches, and
-- add the unordered pair needed for the rolling one-reward-per-pair gate.
-- Pair columns remain nullable only so a legacy reward whose match was already
-- deleted can be preserved truthfully rather than assigned a fabricated pair.
DROP INDEX IF EXISTS idx_pvp_rewards_winner;
ALTER TABLE pvp_rewards RENAME TO pvp_rewards_before_0018;

CREATE TABLE pvp_rewards (
  match_id TEXT PRIMARY KEY,
  winner_account_id INTEGER NOT NULL,
  pair_low_account_id INTEGER,
  pair_high_account_id INTEGER,
  mentality_amount INTEGER NOT NULL DEFAULT 5 CHECK(mentality_amount = 5),
  awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK((pair_low_account_id IS NULL AND pair_high_account_id IS NULL)
    OR (pair_low_account_id IS NOT NULL AND pair_high_account_id IS NOT NULL
      AND pair_low_account_id < pair_high_account_id))
);

INSERT INTO pvp_rewards(
  match_id,winner_account_id,pair_low_account_id,pair_high_account_id,
  mentality_amount,awarded_at
)
SELECT old.match_id,old.winner_account_id,
  CASE WHEN match.inviter_account_id<match.invitee_account_id
    THEN match.inviter_account_id ELSE match.invitee_account_id END,
  CASE WHEN match.inviter_account_id<match.invitee_account_id
    THEN match.invitee_account_id ELSE match.inviter_account_id END,
  old.mentality_amount,old.awarded_at
FROM pvp_rewards_before_0018 old
LEFT JOIN pvp_matches match ON match.id=old.match_id;

DROP TABLE pvp_rewards_before_0018;

CREATE INDEX idx_pvp_rewards_winner
  ON pvp_rewards(winner_account_id, awarded_at DESC);
CREATE INDEX idx_pvp_rewards_pair
  ON pvp_rewards(pair_low_account_id, pair_high_account_id, awarded_at DESC)
  WHERE pair_low_account_id IS NOT NULL AND pair_high_account_id IS NOT NULL;

-- Serialize authenticated mutations against resumable account deletion. A
-- mutating request can acquire this lease only before its deletion job exists;
-- deletion can create that job only when no live lease exists for the account.
CREATE TABLE IF NOT EXISTS account_mutation_leases (
  request_id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  acquired_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_mutation_leases_account
  ON account_mutation_leases(account_id, acquired_at_ms);
