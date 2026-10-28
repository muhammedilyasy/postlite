-- postlite migration 5: runtime-agnostic storage keys, resumable upload sessions, chunked analytics runs.
-- Media rows may live under a storage key that differs from the public file name (R2 multipart uploads
-- are written before the file type is known). NULL = use filename (all rows created before this migration).
ALTER TABLE media ADD COLUMN storage_key TEXT;

-- Multipart upload sessions (browser/agent uploads straight to R2 or through /api/v1/media/uploads/*).
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL,
  multipart_id TEXT,
  original_name TEXT,
  declared_size INTEGER,
  part_size INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  mode TEXT NOT NULL,                     -- proxy | presigned
  state TEXT NOT NULL DEFAULT 'open',      -- open | completed | aborted
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX uploads_expiry ON uploads(state, expires_at);

-- Analytics sync progress so one account's sync can be split across several short invocations.
CREATE TABLE analytics_runs (
  integration_id TEXT PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,                     -- account | list | posts | finish
  cursor INTEGER NOT NULL DEFAULT 0,
  until_ms INTEGER NOT NULL,
  since_ms INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Lock-expiry scan for crash recovery runs every cron tick on Workers.
CREATE INDEX jobs_lock ON jobs(state, locked_until);
