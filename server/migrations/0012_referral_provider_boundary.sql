-- Provider metadata belongs to the live, account-linked claim row. The
-- permanent replay ledger continues to retain only a keyed evidence HMAC.
-- Defaults preserve rows written before the provider-neutral boundary.
ALTER TABLE referral_claims
  ADD COLUMN attribution_provider TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE referral_claims
  ADD COLUMN attribution_version TEXT NOT NULL DEFAULT 'legacy';
