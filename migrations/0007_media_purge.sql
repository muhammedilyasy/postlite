-- postlite migration 7: delete media originals after publishing (keep the poster/thumbnail JPEG).
-- purged_at = when the original bytes were removed from storage; purged_bytes = bytes freed.
-- The per-workspace policy lives in workspace_settings key 'media_retention'
-- (immediate | 7d | 30d | never). Missing = immediate; existing workspaces get the explicit default.
ALTER TABLE media ADD COLUMN purged_at INTEGER;
ALTER TABLE media ADD COLUMN purged_bytes INTEGER;
CREATE INDEX media_ws_purged ON media(workspace_id, purged_at);
INSERT OR IGNORE INTO workspace_settings(workspace_id, key, value) SELECT id, 'media_retention', 'immediate' FROM workspaces;
