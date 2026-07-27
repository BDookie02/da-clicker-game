-- Exact, platform-extensible purchase financials and durable reconciliation.
-- Google Money is stored as currency + whole units + nanos so no catalog price
-- or floating-point conversion becomes the financial source of truth.
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

CREATE TABLE IF NOT EXISTS purchase_reconciliation_state (
  platform TEXT PRIMARY KEY,
  cursor_time_ms INTEGER NOT NULL DEFAULT 0,
  window_end_ms INTEGER,
  page_token TEXT,
  last_success_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
