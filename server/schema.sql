PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  lower_username TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Legal/community state lives beside (rather than inside) accounts so this
-- launch migration remains safe for databases that already have account rows.
-- Legacy accounts receive a profile lazily on their next online request.
CREATE TABLE IF NOT EXISTS account_profiles (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  public_id TEXT NOT NULL UNIQUE,
  friend_code TEXT UNIQUE,
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

-- Evidence-preserving replacement for the original username_reports table.
-- The legacy table remains readable for migration only. A reporter may create
-- a new incident after the prior one is resolved, while duplicate active
-- incidents are still suppressed.
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

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

CREATE TABLE IF NOT EXISTS cloud_saves (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  save_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scores (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  taps INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scores_taps ON scores(taps DESC, updated_at ASC);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK(platform IN ('android','ios')),
  product_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  purchase_token_hash TEXT,
  mentality_amount INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_purchases_account ON purchases(account_id, verified_at DESC);

-- Platform-neutral financial enrichment is kept separate from the immutable
-- entitlement ledger. Google order totals use Money (whole units + nanos), so
-- both values are stored exactly instead of deriving a price from catalog UI.
CREATE TABLE IF NOT EXISTS purchase_financials (
  platform TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  purchase_type TEXT NOT NULL DEFAULT 'unknown',
  quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity >= 1),
  region_code TEXT,
  paid_currency TEXT,
  paid_units TEXT,
  paid_nanos INTEGER,
  financial_status TEXT NOT NULL DEFAULT 'unavailable',
  financial_synced_at TEXT,
  revoked_at TEXT,
  revocation_source TEXT,
  revocation_reason TEXT,
  revoked_quantity INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(platform, transaction_id),
  FOREIGN KEY(platform, transaction_id) REFERENCES purchases(platform, transaction_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_purchase_financials_status
  ON purchase_financials(platform, financial_status, financial_synced_at);

-- Every Google void/refund signal receives a deterministic external event key.
-- This makes overlap windows and retried scheduled runs idempotent while
-- preserving the authoritative revocation evidence.
CREATE TABLE IF NOT EXISTS purchase_reversals (
  external_event_key TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  event_time TEXT NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  quantity INTEGER,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(platform, transaction_id) REFERENCES purchases(platform, transaction_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_purchase_reversals_transaction
  ON purchase_reversals(platform, transaction_id, event_time DESC);

-- Durable pagination/window state for scheduled platform reconciliation.
CREATE TABLE IF NOT EXISTS purchase_reconciliation_state (
  platform TEXT PRIMARY KEY,
  cursor_time_ms INTEGER NOT NULL DEFAULT 0,
  window_end_ms INTEGER,
  page_token TEXT,
  last_success_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Android currency packs are consumable. Keep delivery separate from the
-- immutable purchase ledger so a transient Google consume failure can be
-- retried without granting twice or permanently blocking that SKU.
CREATE TABLE IF NOT EXISTS purchase_consumptions (
  platform TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  consume_attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(platform, transaction_id),
  FOREIGN KEY(platform, transaction_id) REFERENCES purchases(platform, transaction_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ad_rewards (
  transaction_id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('m','boost','offline')),
  ad_network TEXT NOT NULL,
  ad_unit TEXT NOT NULL,
  reward_amount INTEGER NOT NULL,
  reward_item TEXT NOT NULL,
  rewarded_at INTEGER NOT NULL,
  verified_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ad_rewards_account ON ad_rewards(account_id, verified_at DESC);

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
  proof_provider TEXT NOT NULL DEFAULT 'legacy',
  proof_app_version_code INTEGER,
  attribution_provider TEXT NOT NULL DEFAULT 'legacy',
  attribution_version TEXT NOT NULL DEFAULT 'legacy',
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(referred_account_id <> referrer_account_id)
);
CREATE INDEX IF NOT EXISTS idx_referral_claims_referrer
  ON referral_claims(referrer_account_id, claimed_at ASC);

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

-- Permanent, privacy-preserving referral ledgers. The legacy claim/reward
-- tables above retain live-account detail only. HMAC evidence fingerprints
-- permanently block replay without retaining a referral code or timestamps.
CREATE TABLE IF NOT EXISTS referral_evidence_fingerprints (
  evidence_hash TEXT PRIMARY KEY,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

-- Resumable deletion keeps each Worker invocation and D1 batch bounded while
-- every live plaintext claim is converted to replay tombstones first.
CREATE TABLE IF NOT EXISTS account_deletion_jobs (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  referral_cursor INTEGER NOT NULL DEFAULT -1,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every authenticated mutation request owns a short-lived database lease
-- before it may reach a route handler. Account deletion can begin only when no
-- live lease exists, closing the check-then-mutate race without making hot
-- read-only multiplayer polls issue database writes.
CREATE TABLE IF NOT EXISTS account_mutation_leases (
  request_id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  acquired_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_mutation_leases_account
  ON account_mutation_leases(account_id, acquired_at_ms);

-- The replay-pepper-v1 fixed-context tag pins the permanent anti-replay pepper.
-- Rotatable active ledger-signing keys are intentionally not registered here.
CREATE TABLE IF NOT EXISTS referral_evidence_key_registry (
  key_id TEXT PRIMARY KEY,
  verification_tag TEXT NOT NULL,
  legacy_unversioned INTEGER NOT NULL DEFAULT 0 CHECK(legacy_unversioned IN (0,1)),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Durable fixed-window throttles protect registration and referral proof
-- quotas across Worker isolates without retaining raw IPs or referral codes.
CREATE TABLE IF NOT EXISTS request_rate_limits (
  bucket TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK(request_count >= 1),
  PRIMARY KEY(bucket, subject_hash)
);
CREATE INDEX IF NOT EXISTS idx_request_rate_limits_window
  ON request_rate_limits(window_started_at);

-- Compatibility triggers keep privacy/replay ledgers complete even if an
-- already-running request (or an emergency rollback Worker) writes through
-- the pre-hardening referral tables. Current code writes the HMAC key first,
-- so these triggers are no-ops on the normal path.
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

CREATE TABLE IF NOT EXISTS friendships (
  account_low_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  account_high_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(account_low_id, account_high_id),
  CHECK(account_low_id < account_high_id),
  CHECK(requested_by_account_id IN (account_low_id, account_high_id))
);
CREATE INDEX IF NOT EXISTS idx_friendships_high
  ON friendships(account_high_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS pvp_matches (
  id TEXT PRIMARY KEY,
  inviter_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invitee_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('tap','quick_draw')),
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK(duration_seconds IN (0,30,60,90)),
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK(status IN ('invited','active','completed','declined','cancelled')),
  phase TEXT CHECK(phase IN ('tap','quick_draw')),
  round_number INTEGER NOT NULL DEFAULT 0,
  phase_starts_at INTEGER,
  phase_ends_at INTEGER,
  draw_at INTEGER,
  quick_draw_issued_at INTEGER,
  winner_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  state_revision INTEGER NOT NULL DEFAULT 0,
  tap_commit_barrier_until INTEGER,
  result_reason TEXT CHECK(result_reason IN (
    'no_input','incomplete_round','tie_limit','stale_timeout',
    'friend_removed','blocked_player','cancelled_by_inviter','rollout_recovery'
  )),
  CHECK(inviter_account_id <> invitee_account_id)
);
CREATE INDEX IF NOT EXISTS idx_pvp_matches_inviter
  ON pvp_matches(inviter_account_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_matches_invitee
  ON pvp_matches(invitee_account_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_matches_status_created
  ON pvp_matches(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pvp_matches_status_updated
  ON pvp_matches(status, updated_at);

CREATE TABLE IF NOT EXISTS pvp_round_scores (
  match_id TEXT NOT NULL REFERENCES pvp_matches(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tap_count INTEGER NOT NULL DEFAULT 0,
  reaction_ms INTEGER,
  raw_reaction_ms INTEGER,
  rtt_adjustment_ms INTEGER NOT NULL DEFAULT 0,
  reaction_transport TEXT CHECK(reaction_transport IN ('websocket','rest')),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(match_id, round_number, account_id)
);

CREATE TABLE IF NOT EXISTS pvp_rewards (
  match_id TEXT PRIMARY KEY,
  -- These numeric IDs deliberately have no foreign keys. The compact
  -- anti-farming record must survive deletion of either participant and the
  -- match while the account rows themselves are deleted normally.
  winner_account_id INTEGER NOT NULL,
  pair_low_account_id INTEGER,
  pair_high_account_id INTEGER,
  mentality_amount INTEGER NOT NULL DEFAULT 5 CHECK(mentality_amount = 5),
  awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK((pair_low_account_id IS NULL AND pair_high_account_id IS NULL)
    OR (pair_low_account_id IS NOT NULL AND pair_high_account_id IS NOT NULL
      AND pair_low_account_id < pair_high_account_id))
);
CREATE INDEX IF NOT EXISTS idx_pvp_rewards_winner
  ON pvp_rewards(winner_account_id, awarded_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_rewards_pair
  ON pvp_rewards(pair_low_account_id, pair_high_account_id, awarded_at DESC)
  WHERE pair_low_account_id IS NOT NULL AND pair_high_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pvp_socket_tickets (
  token_hash TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES pvp_matches(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pvp_socket_tickets_account_match
  ON pvp_socket_tickets(account_id, match_id, expires_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_socket_tickets_expiry
  ON pvp_socket_tickets(expires_at_ms);

CREATE TABLE IF NOT EXISTS pvp_player_locks (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL REFERENCES pvp_matches(id) ON DELETE CASCADE,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pvp_player_locks_match
  ON pvp_player_locks(match_id);

-- Lock acquisition belongs to the database transaction that creates a match.
-- This protects both current code and a temporarily running older Worker from
-- creating overlapping or lockless invitations during deploy/rollback.
CREATE TRIGGER IF NOT EXISTS trg_pvp_acquire_locks_insert
AFTER INSERT ON pvp_matches
WHEN NEW.status IN ('invited','active')
BEGIN
  INSERT INTO pvp_player_locks(account_id,match_id)
    VALUES(NEW.inviter_account_id,NEW.id);
  INSERT INTO pvp_player_locks(account_id,match_id)
    VALUES(NEW.invitee_account_id,NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_pvp_release_locks_terminal
AFTER UPDATE OF status ON pvp_matches
WHEN NEW.status IN ('completed','declined','cancelled')
BEGIN
  DELETE FROM pvp_player_locks WHERE match_id=NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_pvp_release_locks_deleted
AFTER DELETE ON pvp_matches
BEGIN
  DELETE FROM pvp_player_locks WHERE match_id=OLD.id;
END;
