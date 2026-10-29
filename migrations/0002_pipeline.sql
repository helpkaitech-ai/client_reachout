ALTER TABLE drafts ADD COLUMN quality_hold TEXT NOT NULL DEFAULT '';
ALTER TABLE drafts ADD COLUMN send_immediately INTEGER NOT NULL DEFAULT 0;
CREATE INDEX drafts_daily_kind ON drafts(kind,created_at,status);
