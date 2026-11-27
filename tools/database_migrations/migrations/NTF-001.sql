-- Local-only notification event model, including recoverable processing leases.
-- D1 syntax/locking behavior must be independently validated before any production use.
CREATE TABLE IF NOT EXISTS notification_events (
    id TEXT PRIMARY KEY,
    event_key TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','processed','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    processing_execution_id TEXT,
    lease_expires_at TEXT,
    fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_key, generation),
    CHECK ((status = 'processing' AND processing_execution_id IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR status <> 'processing')
);
CREATE INDEX IF NOT EXISTS idx_notification_events_claim
    ON notification_events(status, lease_expires_at, created_at);
