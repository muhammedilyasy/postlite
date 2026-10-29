-- postlite migration 8: Brands = named sets of connected accounts (channels) across platforms.
-- Not to be confused with `groups` (a post and its per-account targets). Workspace-scoped; an account can
-- belong to several brands. brand_channels carries workspace_id too so every query filters by workspace.
CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX brands_ws_name ON brands(workspace_id, name COLLATE NOCASE);

CREATE TABLE brand_channels (
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (brand_id, integration_id)
);
CREATE INDEX brand_channels_ws ON brand_channels(workspace_id, integration_id);
