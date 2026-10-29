-- postlite migration 11: signatures (saved snippets, optionally auto-added per platform/account) and
-- post templates ("sets": a composed post without media to start new posts from). Workspace-scoped.
CREATE TABLE signatures (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  auto_add INTEGER NOT NULL DEFAULT 0,   -- 1 = added to new posts automatically
  providers TEXT NOT NULL DEFAULT '[]',   -- auto-add only for these platforms ([] = any)
  account_ids TEXT NOT NULL DEFAULT '[]', -- ... or these channels ([] = any)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX signatures_ws_name ON signatures(workspace_id, name COLLATE NOCASE);

CREATE TABLE post_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,                     -- {content, targets:[{account_id, content, settings}], brand_id, tags}
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX post_templates_ws_name ON post_templates(workspace_id, name COLLATE NOCASE);
