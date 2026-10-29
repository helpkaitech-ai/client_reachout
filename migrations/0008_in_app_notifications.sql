CREATE TABLE app_notifications (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, product_id TEXT NOT NULL DEFAULT '',
 workspace_name TEXT NOT NULL, lead_id TEXT NOT NULL, draft_id TEXT,
 title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX app_notifications_recent ON app_notifications(created_at DESC,id);
CREATE INDEX app_notifications_unread ON app_notifications(read_at,created_at DESC);
UPDATE settings SET data=json_set(data,'$.followupDays',json('[4,10,18]'))
 WHERE json_extract(data,'$.followupDays')='[4,10]';
