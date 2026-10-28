-- postlite migration 4 (applied by the Node migrator via PRAGMA user_version and by wrangler d1 migrations)
-- Cloudflare Access mode: a session belongs to one verified email.
ALTER TABLE sessions ADD COLUMN email TEXT;
ALTER TABLE sessions ADD COLUMN access_exp INTEGER;
