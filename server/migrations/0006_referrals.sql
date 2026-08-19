CREATE TABLE IF NOT EXISTS referral_codes (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS referral_claims (
  referred_account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  referrer_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  referral_code TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('android','ios')),
  click_timestamp INTEGER NOT NULL,
  install_timestamp INTEGER NOT NULL,
  install_version TEXT NOT NULL DEFAULT '',
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(referred_account_id <> referrer_account_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_claims_referrer
  ON referral_claims(referrer_account_id, claimed_at ASC);
