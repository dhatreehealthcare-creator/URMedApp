-- P7-06: sanitized operational events and bounded administrative alerts.
CREATE TABLE IF NOT EXISTS operational_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('auth','payment','webhook','scheduled_job','email','storage','database','backup','security')),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','failed')),
  provider TEXT NOT NULL DEFAULT '',
  vendor_id INTEGER REFERENCES vendors(id),
  profile_id INTEGER REFERENCES account_profiles(id),
  reference_type TEXT NOT NULL DEFAULT '',
  reference_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0,1)),
  request_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(event_key) BETWEEN 1 AND 240),
  CHECK (length(provider) <= 80),
  CHECK (length(reference_type) <= 80),
  CHECK (length(reference_id) <= 160),
  CHECK (length(error_code) <= 100),
  CHECK (length(request_id) <= 160),
  CHECK (length(detail_json) <= 8000)
);
CREATE INDEX IF NOT EXISTS operational_events_category_idx ON operational_events(category, occurred_at DESC);
CREATE INDEX IF NOT EXISTS operational_events_status_idx ON operational_events(status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS operational_events_vendor_idx ON operational_events(vendor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS operational_events_provider_idx ON operational_events(provider, occurred_at DESC);

CREATE TABLE IF NOT EXISTS operational_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('auth','payment','webhook','scheduled_job','email','storage','database','backup','security')),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  provider TEXT NOT NULL DEFAULT '',
  vendor_id INTEGER REFERENCES vendors(id),
  occurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (occurrence_count >= 0 AND occurrence_count <= 10000),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  sample_event_id INTEGER REFERENCES operational_events(id),
  last_error_code TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  resolved_at TEXT,
  resolution_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(fingerprint) BETWEEN 1 AND 240),
  CHECK (length(provider) <= 80),
  CHECK (length(resolution_reason) <= 500)
);
CREATE INDEX IF NOT EXISTS operational_alerts_status_idx ON operational_alerts(status, last_seen DESC);
CREATE INDEX IF NOT EXISTS operational_alerts_vendor_idx ON operational_alerts(vendor_id, status, last_seen DESC);

CREATE TRIGGER IF NOT EXISTS operational_events_immutable_update
BEFORE UPDATE ON operational_events
BEGIN SELECT RAISE(ABORT, 'operational_event_immutable'); END;
CREATE TRIGGER IF NOT EXISTS operational_events_immutable_delete
BEFORE DELETE ON operational_events
BEGIN SELECT RAISE(ABORT, 'operational_event_immutable'); END;
CREATE TRIGGER IF NOT EXISTS operational_alerts_shape_guard
BEFORE UPDATE ON operational_alerts
WHEN NEW.fingerprint <> OLD.fingerprint
  OR NEW.category <> OLD.category
  OR NEW.vendor_id IS NOT OLD.vendor_id
  OR NEW.occurrence_count < OLD.occurrence_count
  OR NEW.version <= OLD.version
BEGIN SELECT RAISE(ABORT, 'operational_alert_shape_immutable'); END;
