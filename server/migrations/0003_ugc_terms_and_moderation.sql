-- Idempotent UGC/legal migration. Existing account rows are preserved.
-- account_profiles rows are created lazily by the Worker at the next online
-- login/account/community request, which avoids unsafe ALTER TABLE defaults.
CREATE TABLE IF NOT EXISTS account_profiles (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  public_id TEXT NOT NULL UNIQUE,
  terms_version TEXT,
  terms_accepted_at TEXT,
  leaderboard_status TEXT NOT NULL DEFAULT 'active'
    CHECK(leaderboard_status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_blocks (
  blocker_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  blocked_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(blocker_account_id, blocked_account_id),
  CHECK(blocker_account_id <> blocked_account_id)
);
CREATE INDEX IF NOT EXISTS idx_account_blocks_blocked
  ON account_blocks(blocked_account_id);

CREATE TABLE IF NOT EXISTS username_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reported_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(reason IN ('username','cheating','harassment','other')),
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','reviewing','actioned','dismissed')),
  moderator_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  UNIQUE(reporter_account_id, reported_account_id),
  CHECK(reporter_account_id <> reported_account_id)
);
CREATE INDEX IF NOT EXISTS idx_username_reports_status
  ON username_reports(status, created_at ASC);
