-- Evidence-preserving moderation reports. This table intentionally coexists
-- with the legacy username_reports table so the migration is idempotent and
-- can import old incidents without an unsafe table rebuild.
CREATE TABLE IF NOT EXISTS community_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reported_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reporter_username_snapshot TEXT NOT NULL,
  reported_username_snapshot TEXT NOT NULL,
  reported_taps_snapshot INTEGER NOT NULL DEFAULT 0,
  reported_player_ref_snapshot TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('username','cheating','harassment','other')),
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','reviewing','actioned','dismissed')),
  moderator_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  CHECK(reporter_account_id <> reported_account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_community_reports_active_pair
  ON community_reports(reporter_account_id, reported_account_id)
  WHERE status IN ('open','reviewing');
CREATE INDEX IF NOT EXISTS idx_community_reports_status
  ON community_reports(status, created_at ASC);

INSERT OR IGNORE INTO community_reports(
  id, reporter_account_id, reported_account_id,
  reporter_username_snapshot, reported_username_snapshot,
  reported_taps_snapshot, reported_player_ref_snapshot,
  reason, details, status, moderator_note, created_at, updated_at, reviewed_at
)
SELECT
  r.id, r.reporter_account_id, r.reported_account_id,
  reporter.username, reported.username,
  COALESCE(s.taps, 0), COALESCE(p.public_id, ''),
  r.reason, r.details, r.status, r.moderator_note,
  r.created_at, r.updated_at, r.reviewed_at
FROM username_reports r
JOIN accounts reporter ON reporter.id=r.reporter_account_id
JOIN accounts reported ON reported.id=r.reported_account_id
LEFT JOIN scores s ON s.account_id=r.reported_account_id
LEFT JOIN account_profiles p ON p.account_id=r.reported_account_id;
