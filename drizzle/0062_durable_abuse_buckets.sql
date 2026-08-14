-- P7-03: durable fixed-window abuse-control counters. Subject identities are
-- SHA-256 hashes; raw IPs and profile identifiers are never stored.
CREATE TABLE IF NOT EXISTS abuse_rate_limit_buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  route_key TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(route_key, subject_hash, window_start_ms),
  CHECK(length(route_key) BETWEEN 1 AND 40),
  CHECK(length(subject_hash) = 64),
  CHECK(window_start_ms >= 0 AND expires_at_ms > window_start_ms),
  CHECK(request_count >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS abuse_rate_limit_expiry_idx
  ON abuse_rate_limit_buckets(expires_at_ms);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS abuse_rate_limit_update_guard
BEFORE UPDATE ON abuse_rate_limit_buckets
WHEN NEW.route_key <> OLD.route_key
  OR NEW.subject_hash <> OLD.subject_hash
  OR NEW.window_start_ms <> OLD.window_start_ms
  OR NEW.request_count < OLD.request_count
  OR NEW.request_count < 0
BEGIN
  SELECT RAISE(ABORT, 'abuse_rate_limit_bucket_immutable');
END;
