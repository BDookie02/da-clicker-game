-- Safe to apply to both an existing D1 database and a fresh database.
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
