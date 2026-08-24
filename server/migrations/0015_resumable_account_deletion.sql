-- Bound referral tombstone work across account-deletion requests. The account,
-- its claims, and its session remain intact until every live claim involving
-- it has a provider-specific replay fingerprint.
CREATE TABLE IF NOT EXISTS account_deletion_jobs (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  referral_cursor INTEGER NOT NULL DEFAULT -1,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
