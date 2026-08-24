ALTER TABLE account_profiles ADD COLUMN friend_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_profiles_friend_code
  ON account_profiles(friend_code);

CREATE TABLE IF NOT EXISTS friendships (
  account_low_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  account_high_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(account_low_id, account_high_id),
  CHECK(account_low_id < account_high_id),
  CHECK(requested_by_account_id IN (account_low_id, account_high_id))
);
CREATE INDEX IF NOT EXISTS idx_friendships_high
  ON friendships(account_high_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS pvp_matches (
  id TEXT PRIMARY KEY,
  inviter_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invitee_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('tap','quick_draw')),
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK(duration_seconds IN (0,30,60,90)),
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK(status IN ('invited','active','completed','declined','cancelled')),
  phase TEXT CHECK(phase IN ('tap','quick_draw')),
  round_number INTEGER NOT NULL DEFAULT 0,
  phase_starts_at INTEGER,
  phase_ends_at INTEGER,
  draw_at INTEGER,
  winner_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK(inviter_account_id <> invitee_account_id)
);
CREATE INDEX IF NOT EXISTS idx_pvp_matches_inviter
  ON pvp_matches(inviter_account_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_matches_invitee
  ON pvp_matches(invitee_account_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS pvp_round_scores (
  match_id TEXT NOT NULL REFERENCES pvp_matches(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tap_count INTEGER NOT NULL DEFAULT 0,
  reaction_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(match_id, round_number, account_id)
);

CREATE TABLE IF NOT EXISTS pvp_rewards (
  match_id TEXT PRIMARY KEY,
  winner_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mentality_amount INTEGER NOT NULL DEFAULT 5 CHECK(mentality_amount = 5),
  awarded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pvp_rewards_winner
  ON pvp_rewards(winner_account_id, awarded_at DESC);
