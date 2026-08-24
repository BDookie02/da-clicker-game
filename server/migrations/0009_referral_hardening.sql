-- Add an auditable normalized proof result to live referral claims. New claims
-- are accepted only after the provider-specific proof adapter verifies them.
ALTER TABLE referral_claims ADD COLUMN proof_provider TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE referral_claims ADD COLUMN proof_app_version_code INTEGER;

-- New evidence is HMAC-SHA256'd by the Worker before insertion. SQL cannot
-- recover the server secret, so migrated live claims remain protected by the
-- legacy table until deletion; account deletion inserts their HMAC first.
CREATE TABLE IF NOT EXISTS referral_evidence_fingerprints (
  evidence_hash TEXT PRIMARY KEY,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Preserve lifetime claim/reward state independently of a live account while
-- retaining no plaintext referral code or install timestamps. Legacy rows get
-- opaque random keys solely to join their already-earned rewards.
CREATE TABLE IF NOT EXISTS referral_claim_ledger (
  evidence_key TEXT PRIMARY KEY,
  referred_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  referrer_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_claim_ledger_referred
  ON referral_claim_ledger(referred_account_id)
  WHERE referred_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referral_claim_ledger_referrer
  ON referral_claim_ledger(referrer_account_id, claimed_at ASC);

INSERT INTO referral_claim_ledger(
  evidence_key,referred_account_id,referrer_account_id,claimed_at
)
SELECT 'legacy_' || lower(hex(randomblob(32))),
  referred_account_id,referrer_account_id,claimed_at
FROM referral_claims;

CREATE TABLE IF NOT EXISTS referral_reward_ledger (
  evidence_key TEXT PRIMARY KEY REFERENCES referral_claim_ledger(evidence_key) ON DELETE RESTRICT,
  referrer_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reward_index INTEGER NOT NULL CHECK(reward_index BETWEEN 1 AND 10),
  cosmetic_id TEXT NOT NULL,
  awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(referrer_account_id, reward_index),
  UNIQUE(referrer_account_id, cosmetic_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_reward_ledger_referrer
  ON referral_reward_ledger(referrer_account_id, reward_index ASC);

INSERT OR IGNORE INTO referral_reward_ledger(
  evidence_key,referrer_account_id,reward_index,cosmetic_id,awarded_at
)
SELECT cl.evidence_key,rr.referrer_account_id,rr.reward_index,
  rr.cosmetic_id,rr.awarded_at
FROM referral_rewards rr
JOIN referral_claim_ledger cl ON cl.referred_account_id=rr.referred_account_id;
