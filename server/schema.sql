CREATE TABLE IF NOT EXISTS names (
  name TEXT NOT NULL,
  lower_name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS scores (
  lower_name TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  taps INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scores_taps ON scores (taps DESC);
