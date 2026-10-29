-- Historical data remains intact. Legacy providers never participate in new work.
ALTER TABLE runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'legacy';
CREATE TABLE legacy_jobs AS SELECT * FROM jobs WHERE kind IN ('contact','verify','discovery');
UPDATE jobs SET state='archived',error='Retired provider task; history retained by OpenAI migration' WHERE kind IN ('contact','verify','discovery') AND state NOT IN ('complete','cancelled');
UPDATE runs SET state='legacy_held',error=COALESCE(error,'Archived during provider migration; historical costs retained') WHERE state IN ('submitting','running','importing','uncertain');
ALTER TABLE leads ADD COLUMN contact_status TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE leads ADD COLUMN contact_evidence TEXT NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN dossier TEXT NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN solution TEXT NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN research_stage TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN next_run_at TEXT;
CREATE TABLE ai_attempts (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, stage TEXT NOT NULL, retry_version INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL, expense_id TEXT, model TEXT NOT NULL, request_id TEXT, response_id TEXT,
 output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(job_id,stage,retry_version)
);
CREATE INDEX ai_attempts_job ON ai_attempts(job_id,stage);
CREATE TABLE discovery_batches (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, campaign TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued', candidates INTEGER NOT NULL DEFAULT 0,
 imported INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0,
 error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE discovery_candidates (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES discovery_batches(id),
 entity_key TEXT NOT NULL, data TEXT NOT NULL, outcome TEXT NOT NULL, lead_id TEXT,
 created_at TEXT NOT NULL, UNIQUE(batch_id,entity_key)
);
CREATE TABLE business_facts (
 id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), job_id TEXT NOT NULL,
 claim TEXT NOT NULL, source_url TEXT NOT NULL, excerpt TEXT NOT NULL,
 evidence_type TEXT NOT NULL, observed_at TEXT NOT NULL, UNIQUE(lead_id,job_id,claim,source_url)
);
CREATE TABLE research_claims(day TEXT NOT NULL,lead_id TEXT NOT NULL,PRIMARY KEY(day,lead_id));
CREATE TABLE pipeline_results(job_id TEXT PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX business_facts_lead ON business_facts(lead_id);
-- Keep every-minute queue and prospect lookups bounded as history grows.
CREATE INDEX jobs_lead_state ON jobs(lead_id,state);
CREATE INDEX jobs_due ON jobs(state,next_run_at);
CREATE INDEX drafts_lead_history ON drafts(lead_id,created_at);
CREATE INDEX expenses_reference ON expenses(reference);
CREATE INDEX ai_attempts_expense ON ai_attempts(expense_id);
CREATE INDEX ai_attempts_checkpoint ON ai_attempts(job_id,stage,state,created_at);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX leads_thread ON leads(thread_id);
CREATE TABLE inbox_seen(id TEXT PRIMARY KEY,observed_at TEXT NOT NULL);
