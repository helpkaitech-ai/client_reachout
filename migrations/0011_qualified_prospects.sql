CREATE TABLE qualified_prospects (
 lead_id TEXT PRIMARY KEY REFERENCES leads(id),
 draft_id TEXT NOT NULL REFERENCES drafts(id),
 admitted_at TEXT NOT NULL
);
CREATE INDEX qualified_prospects_date ON qualified_prospects(admitted_at);
CREATE TABLE discovery_cycles (
 id TEXT PRIMARY KEY, created_at TEXT NOT NULL, completed_at TEXT,
 product_revision INTEGER NOT NULL DEFAULT 0, target INTEGER NOT NULL
);
CREATE TABLE discovery_cycle_batches (
 batch_id TEXT PRIMARY KEY REFERENCES discovery_batches(id),
 cycle_id TEXT NOT NULL REFERENCES discovery_cycles(id)
);
CREATE INDEX discovery_cycle_batches_cycle ON discovery_cycle_batches(cycle_id);
-- Historical drafts and research remain available in the audit export.
-- A refusal is not an email waiting to be sent.
UPDATE drafts SET status='rejected',approved_hash=NULL,approved_at=NULL
 WHERE kind='initial' AND status='pending'
 AND (trim(subject)='' OR length(trim(body))<30 OR quality_hold<>'');
UPDATE leads SET status='not_qualified'
 WHERE last_sent_at IS NULL AND json_valid(dossier)
 AND json_extract(dossier,'$.qualified')=0
 AND NOT EXISTS(SELECT 1 FROM drafts WHERE lead_id=leads.id AND status IN ('pending','approved','sending','uncertain','sent'));
