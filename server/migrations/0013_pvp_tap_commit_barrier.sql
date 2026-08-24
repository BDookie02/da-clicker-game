-- Serialize end-of-round tap commits against GET-triggered settlement.
-- Nullable/default NULL keeps all existing and non-tap matches unchanged.
ALTER TABLE pvp_matches ADD COLUMN tap_commit_barrier_until INTEGER;
