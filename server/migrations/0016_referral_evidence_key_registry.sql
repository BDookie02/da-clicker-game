-- Pin the permanent anti-replay pepper with a non-secret fixed-context HMAC
-- tag. Active ledger-signing keys rotate separately and are intentionally not
-- registered here; future Workers fail closed if the permanent pepper changes.
CREATE TABLE IF NOT EXISTS referral_evidence_key_registry (
  key_id TEXT PRIMARY KEY,
  verification_tag TEXT NOT NULL,
  legacy_unversioned INTEGER NOT NULL DEFAULT 0 CHECK(legacy_unversioned IN (0,1)),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
