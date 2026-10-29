-- postlite migration 12: repeating posts. A series stores the post to repeat (caption, media, per-channel
-- targets, tags) and the rule; each occurrence is its own post group (groups.series_id / series_index),
-- generated a few occurrences ahead so the calendar shows them. Workspace-scoped.
CREATE TABLE series (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '[]',
  targets TEXT NOT NULL DEFAULT '[]',      -- [{integration_id, content_override, media_override, settings}]
  tags TEXT NOT NULL DEFAULT '[]',
  frequency TEXT NOT NULL,                 -- daily | every_n_days | weekly | biweekly | monthly
  interval_days INTEGER,                   -- every_n_days: 2..6
  first_at INTEGER NOT NULL,               -- occurrence #0 (anchor of the rule, wall time in timezone)
  timezone TEXT NOT NULL,
  until_at INTEGER,                        -- optional end date (no occurrence after it)
  max_count INTEGER,                       -- optional number of occurrences
  generated INTEGER NOT NULL DEFAULT 0,    -- occurrences created so far
  next_index INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,                         -- time of the next occurrence to create (NULL = none left)
  status TEXT NOT NULL DEFAULT 'active',   -- active | stopped | ended
  approval INTEGER NOT NULL DEFAULT 0,     -- created by an approval-mode key: occurrences wait for approval
  created_by TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX series_ws ON series(workspace_id, status);
ALTER TABLE groups ADD COLUMN series_id TEXT;
ALTER TABLE groups ADD COLUMN series_index INTEGER;
CREATE INDEX groups_series ON groups(series_id);
