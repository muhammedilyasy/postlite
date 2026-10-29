-- postlite migration 10: tags on posts (workspace-scoped labels with a color), many-to-many with groups.
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX tags_ws_name ON tags(workspace_id, name COLLATE NOCASE);

CREATE TABLE group_tags (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, tag_id)
);
CREATE INDEX group_tags_ws ON group_tags(workspace_id, tag_id);
