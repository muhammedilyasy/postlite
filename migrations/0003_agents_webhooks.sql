-- postlite migration 3 (applied by the Node migrator via PRAGMA user_version and by wrangler d1 migrations)
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  approval_mode INTEGER NOT NULL DEFAULT 1,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 120,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  via TEXT NOT NULL,
  operation TEXT NOT NULL,
  target TEXT,
  status INTEGER,
  detail TEXT
);
CREATE INDEX audit_at ON audit_log(at);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  events TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',   -- pending | delivered | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_status INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX webhook_due ON webhook_deliveries(state, next_attempt_at);

ALTER TABLE groups ADD COLUMN created_by TEXT;
ALTER TABLE groups ADD COLUMN approval_note TEXT;
