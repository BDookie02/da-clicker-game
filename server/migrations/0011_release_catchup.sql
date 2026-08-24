-- Final idempotent catch-up used while the API is in deployment maintenance.
-- It closes both migration races even if 0009/0010 were previously applied by
-- hand before the maintenance-first release procedure existed.

-- Install compatibility protection before scanning existing rows. If an old
-- in-flight request reaches D1 after this migration begins, its legacy write
-- is repaired in the same SQLite statement rather than escaping a one-time
-- catch-up scan.
CREATE TRIGGER IF NOT EXISTS trg_referral_claim_legacy_ledger
AFTER INSERT ON referral_claims
WHEN NOT EXISTS (
  SELECT 1 FROM referral_claim_ledger WHERE referred_account_id=NEW.referred_account_id
)
BEGIN
  INSERT INTO referral_claim_ledger(
    evidence_key,referred_account_id,referrer_account_id,claimed_at
  ) VALUES(
    'legacy_' || lower(hex(randomblob(32))),NEW.referred_account_id,
    NEW.referrer_account_id,NEW.claimed_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_reward_legacy_ledger
AFTER INSERT ON referral_rewards
BEGIN
  INSERT OR IGNORE INTO referral_reward_ledger(
    evidence_key,referrer_account_id,reward_index,cosmetic_id,awarded_at
  )
  SELECT evidence_key,NEW.referrer_account_id,NEW.reward_index,
    NEW.cosmetic_id,NEW.awarded_at
  FROM referral_claim_ledger
  WHERE referred_account_id=NEW.referred_account_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_pvp_acquire_locks_insert
AFTER INSERT ON pvp_matches
WHEN NEW.status IN ('invited','active')
BEGIN
  INSERT INTO pvp_player_locks(account_id,match_id)
    VALUES(NEW.inviter_account_id,NEW.id);
  INSERT INTO pvp_player_locks(account_id,match_id)
    VALUES(NEW.invitee_account_id,NEW.id);
END;

INSERT INTO referral_claim_ledger(
  evidence_key,referred_account_id,referrer_account_id,claimed_at
)
SELECT 'legacy_' || lower(hex(randomblob(32))),
  rc.referred_account_id,rc.referrer_account_id,rc.claimed_at
FROM referral_claims rc
WHERE NOT EXISTS (
  SELECT 1 FROM referral_claim_ledger cl
  WHERE cl.referred_account_id=rc.referred_account_id
);

INSERT OR IGNORE INTO referral_reward_ledger(
  evidence_key,referrer_account_id,reward_index,cosmetic_id,awarded_at
)
SELECT cl.evidence_key,rr.referrer_account_id,rr.reward_index,
  rr.cosmetic_id,rr.awarded_at
FROM referral_rewards rr
JOIN referral_claim_ledger cl ON cl.referred_account_id=rr.referred_account_id;

UPDATE pvp_matches SET status='cancelled',result_reason='rollout_recovery',updated_at=datetime('now'),
  state_revision=state_revision+1
WHERE status IN ('invited','active')
  AND 2<>(SELECT COUNT(*) FROM pvp_player_locks l WHERE l.match_id=pvp_matches.id);
