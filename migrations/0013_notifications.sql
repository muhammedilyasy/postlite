-- postlite migration 13: alerts. In-app notifications per workspace AND per user (the signed-in email;
-- '' = the password-mode administrator), optional email delivery (email_state), and per-user preferences.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_email TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,                      -- post_failed | post_published | account_reconnect | digest | test
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,                               -- in-app route, e.g. #/posts/<id> or #/accounts
  dedupe_key TEXT NOT NULL,                -- one notification (and at most one email) per event
  read_at INTEGER,
  email_state TEXT,                        -- NULL (in-app only) | pending | sent | failed
  email_attempts INTEGER NOT NULL DEFAULT 0,
  email_error TEXT,
  emailed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX notifications_dedupe ON notifications(workspace_id, user_email, dedupe_key);
CREATE INDEX notifications_user ON notifications(workspace_id, user_email, created_at);
CREATE INDEX notifications_email ON notifications(email_state, created_at);

CREATE TABLE notification_prefs (
  workspace_id TEXT NOT NULL,
  user_email TEXT NOT NULL DEFAULT '',
  prefs TEXT NOT NULL DEFAULT '{}',        -- {post_failed, post_published, account_reconnect, digest, digest_time, email}
  digest INTEGER NOT NULL DEFAULT 0,       -- copy of prefs.digest for the cron query
  last_digest_day TEXT,                    -- YYYY-MM-DD (workspace timezone) of the last digest sent
  last_test_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_email)
);
