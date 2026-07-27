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
