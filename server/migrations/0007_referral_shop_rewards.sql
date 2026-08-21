CREATE TABLE IF NOT EXISTS referral_rewards (
  referred_account_id INTEGER PRIMARY KEY REFERENCES referral_claims(referred_account_id) ON DELETE CASCADE,
  referrer_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reward_index INTEGER NOT NULL CHECK(reward_index BETWEEN 1 AND 10),
  cosmetic_id TEXT NOT NULL,
  awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(referrer_account_id, reward_index),
  UNIQUE(referrer_account_id, cosmetic_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer
  ON referral_rewards(referrer_account_id, reward_index ASC);
