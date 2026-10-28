-- postlite migration 6: users + isolated workspaces. Every tenant row carries workspace_id.
-- Existing rows go to the legacy 'owner' workspace (password mode uses it; in Cloudflare Access mode
-- `postlite workspaces attribute --apply` assigns it to the owner and moves other people's rows out).
-- Child tables (jobs, post_events, metrics, analytics_*, webhook_deliveries) inherit the workspace of
-- their parent row and are always queried through it.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,              -- lower-case
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

-- Per-workspace settings: timezone, posting_slots, platform_app.<app> (+ .test).
CREATE TABLE workspace_settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (workspace_id, key)
);

INSERT INTO workspaces(id, name, created_at) VALUES ('owner', 'Owner', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

ALTER TABLE integrations ADD COLUMN workspace_id TEXT;
ALTER TABLE media ADD COLUMN workspace_id TEXT;
ALTER TABLE groups ADD COLUMN workspace_id TEXT;
ALTER TABLE posts ADD COLUMN workspace_id TEXT;
ALTER TABLE api_keys ADD COLUMN workspace_id TEXT;
ALTER TABLE webhooks ADD COLUMN workspace_id TEXT;
ALTER TABLE audit_log ADD COLUMN workspace_id TEXT;
ALTER TABLE uploads ADD COLUMN workspace_id TEXT;
ALTER TABLE oauth_states ADD COLUMN workspace_id TEXT;
ALTER TABLE remote_posts ADD COLUMN workspace_id TEXT;

UPDATE integrations SET workspace_id = 'owner';
UPDATE media SET workspace_id = 'owner';
UPDATE groups SET workspace_id = 'owner';
UPDATE posts SET workspace_id = 'owner';
UPDATE api_keys SET workspace_id = 'owner';
UPDATE webhooks SET workspace_id = 'owner';
UPDATE audit_log SET workspace_id = 'owner';
UPDATE uploads SET workspace_id = 'owner';
UPDATE remote_posts SET workspace_id = 'owner';
DELETE FROM oauth_states;

CREATE INDEX integrations_ws ON integrations(workspace_id, provider);
CREATE INDEX media_ws ON media(workspace_id, created_at);
CREATE INDEX groups_ws ON groups(workspace_id);
CREATE INDEX posts_ws ON posts(workspace_id, status);
CREATE INDEX api_keys_ws ON api_keys(workspace_id);
CREATE INDEX webhooks_ws ON webhooks(workspace_id);
CREATE INDEX audit_ws ON audit_log(workspace_id, id);
CREATE INDEX uploads_ws ON uploads(workspace_id);
CREATE INDEX remote_posts_ws ON remote_posts(workspace_id);

-- Settings that used to be instance-wide become the legacy workspace's settings.
INSERT INTO workspace_settings(workspace_id, key, value)
  SELECT 'owner', key, value FROM settings WHERE key IN ('timezone', 'posting_slots') OR key LIKE 'platform_app.%';
DELETE FROM settings WHERE key IN ('timezone', 'posting_slots') OR key LIKE 'platform_app.%';
