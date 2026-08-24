-- Durable fixed-window throttles protect account registration and expensive
-- referral proof verification across Worker isolates. subject_hash values are
-- scope-separated HMACs; raw IP addresses and referral codes are never stored.
CREATE TABLE IF NOT EXISTS request_rate_limits (
  bucket TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK(request_count >= 1),
  PRIMARY KEY(bucket, subject_hash)
);
CREATE INDEX IF NOT EXISTS idx_request_rate_limits_window
  ON request_rate_limits(window_started_at);
