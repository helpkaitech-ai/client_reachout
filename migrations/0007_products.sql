CREATE TABLE products (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, website TEXT NOT NULL, description TEXT NOT NULL,
 remarks TEXT NOT NULL DEFAULT '', sender_email TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL DEFAULT 'draft', analysis TEXT NOT NULL DEFAULT '{}', approved_revision INTEGER,
 error TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX products_state ON products(state,enabled);
CREATE INDEX leads_created ON leads(created_at);
