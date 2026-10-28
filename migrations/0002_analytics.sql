-- postlite migration 2 (applied by the Node migrator via PRAGMA user_version and by wrangler d1 migrations)
CREATE TABLE account_metrics (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  day TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  value REAL NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (integration_id, metric, day)
);

CREATE TABLE remote_posts (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  post_id TEXT,
  kind TEXT,
  caption TEXT,
  permalink TEXT,
  thumbnail TEXT,
  published_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (integration_id, external_id)
);

CREATE TABLE post_metrics (
  integration_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (integration_id, external_id, metric, captured_at)
);
CREATE INDEX post_metrics_lookup ON post_metrics(integration_id, external_id, metric);

CREATE TABLE analytics_status (
  integration_id TEXT PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  last_sync_at INTEGER,
  last_error TEXT,
  unavailable TEXT NOT NULL DEFAULT '{}'
);
