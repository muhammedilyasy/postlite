-- postlite migration 1 (applied by the Node migrator via PRAGMA user_version and by wrangler d1 migrations)
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT, ua TEXT
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  verifier TEXT,
  reconnect_id TEXT,
  data_enc TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT, username TEXT, picture TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',      -- active | needs_reconnect | disabled
  status_message TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  UNIQUE(provider, external_id)
);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL,               -- image | video
  size INTEGER NOT NULL,
  width INTEGER, height INTEGER,
  duration REAL,
  poster TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '[]',
  publish_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  content_override TEXT,
  media_override TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  publish_at INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | scheduled | publishing | published | failed
  external_id TEXT,
  published_url TEXT,
  published_at INTEGER,
  error TEXT,
  warning TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX posts_group ON posts(group_id);
CREATE INDEX posts_publish ON posts(publish_at);
CREATE INDEX posts_status ON posts(status);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | dead
  run_at INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'start',   -- start | check | finalize
  pending_data TEXT,
  pending_since INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_by TEXT,
  locked_until INTEGER,
  inflight TEXT,                         -- set while an irreversible upstream call is in flight
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_due ON jobs(state, run_at);

CREATE TABLE post_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX post_events_post ON post_events(post_id);
