-- postlite migration 9: per-channel preferences (the channel ⋮ menu).
--   display_name   rename shown in postlite (the platform name stays in `name` and is refreshed on reconnect)
--   disabled_at    publishing paused without disconnecting: due posts wait (not failed) until resumed
--   posting_slots  this channel's own weekly slots for "next free slot" (JSON like workspace posting_slots; NULL = workspace slots)
ALTER TABLE integrations ADD COLUMN display_name TEXT;
ALTER TABLE integrations ADD COLUMN disabled_at INTEGER;
ALTER TABLE integrations ADD COLUMN posting_slots TEXT;
