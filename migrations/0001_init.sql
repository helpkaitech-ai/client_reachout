PRAGMA foreign_keys = ON;
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
CREATE TABLE leads (
 id TEXT PRIMARY KEY, company TEXT NOT NULL, website TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT '',
 email TEXT UNIQUE, phone TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
 industry TEXT NOT NULL DEFAULT '', timezone TEXT NOT NULL DEFAULT 'UTC', source_url TEXT NOT NULL DEFAULT '',
 contact_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', verification TEXT NOT NULL DEFAULT 'unverified',
 verification_note TEXT NOT NULL DEFAULT '', eligibility TEXT NOT NULL DEFAULT 'pending', eligibility_note TEXT NOT NULL DEFAULT '',
 research TEXT, research_at TEXT, opportunity TEXT, score INTEGER NOT NULL DEFAULT 0,
 last_inbound_at TEXT, last_sent_at TEXT, next_followup_at TEXT, followup_count INTEGER NOT NULL DEFAULT 0,
 thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX leads_business ON leads(domain, lower(company), city) WHERE domain <> '';
CREATE INDEX leads_status ON leads(status);
CREATE TABLE drafts (
 id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), kind TEXT NOT NULL CHECK(kind IN ('initial','followup','reply')),
 subject TEXT NOT NULL, body TEXT NOT NULL, artifact TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '[]',
 rationale TEXT NOT NULL DEFAULT '', warnings TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
 version INTEGER NOT NULL DEFAULT 1, approved_version INTEGER, approved_hash TEXT, approved_at TEXT,
 send_after TEXT, provider_id TEXT, message_id TEXT, in_reply_to TEXT, inbound_id TEXT UNIQUE,
 error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX drafts_status ON drafts(status,send_after);
CREATE UNIQUE INDEX one_active_draft ON drafts(lead_id) WHERE status IN ('pending','approved','sending','uncertain');
CREATE TABLE messages (
 id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id), direction TEXT NOT NULL,
 subject TEXT NOT NULL, body TEXT NOT NULL, rfc_id TEXT, classification TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE suppressions(email TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, lead_id TEXT, payload TEXT NOT NULL DEFAULT '{}',
 state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX jobs_state ON jobs(state,created_at);
CREATE TABLE expenses(id TEXT PRIMARY KEY, provider TEXT NOT NULL, month TEXT NOT NULL, reserved REAL NOT NULL,
 actual REAL, state TEXT NOT NULL DEFAULT 'reserved', reference TEXT, note TEXT, created_at TEXT NOT NULL);
CREATE INDEX expenses_month ON expenses(provider,month);
CREATE TABLE runs(id TEXT PRIMARY KEY, provider_id TEXT, state TEXT NOT NULL, campaign TEXT NOT NULL,
 expense_id TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT);
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, entity_id TEXT, detail TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE leases(name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE daily_usage(day TEXT PRIMARY KEY, new_slots INTEGER NOT NULL DEFAULT 0, send_slots INTEGER NOT NULL DEFAULT 0, research_slots INTEGER NOT NULL DEFAULT 0);
CREATE TABLE notifications(id TEXT PRIMARY KEY, channel TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
CREATE TABLE auth_attempts(key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at TEXT NOT NULL);
CREATE TABLE integration_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
