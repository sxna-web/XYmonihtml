-- Local-only notification inbox/preferences/delivery model.
CREATE TABLE IF NOT EXISTS user_notifications (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    recipient_type TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    tenant_admin_id TEXT,
    category TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    action_route TEXT,
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','read','acknowledged','resolved','archived')),
    due_at TEXT,
    remind_at TEXT,
    snoozed_until TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(event_id) REFERENCES notification_events(id)
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_recipient
    ON user_notifications(recipient_type, recipient_id, status, created_at);
CREATE TABLE IF NOT EXISTS notification_preferences (
    recipient_type TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    preferences_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(recipient_type, recipient_id)
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','suppressed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_code TEXT,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(event_id) REFERENCES notification_events(id)
);
