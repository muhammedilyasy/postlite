// SQLite (node:sqlite, WAL) — schema, migrations and small query helpers.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT, ua TEXT
  );

  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    verifier TEXT,
    reconnect_id TEXT,
    data_enc TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE integrations (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    name TEXT, username TEXT, picture TEXT,
    access_token_enc TEXT,
    refresh_token_enc TEXT,
    token_expires_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',      -- active | needs_reconnect | disabled
    status_message TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    UNIQUE(provider, external_id)
  );

  CREATE TABLE media (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    original_name TEXT,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL,               -- image | video
    size INTEGER NOT NULL,
    width INTEGER, height INTEGER,
    duration REAL,
    poster TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT '',
    media TEXT NOT NULL DEFAULT '[]',
    publish_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
    content_override TEXT,
    media_override TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    publish_at INTEGER,
    status TEXT NOT NULL DEFAULT 'draft',  -- draft | scheduled | publishing | published | failed
    external_id TEXT,
    published_url TEXT,
    published_at INTEGER,
    error TEXT,
    warning TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX posts_group ON posts(group_id);
  CREATE INDEX posts_publish ON posts(publish_at);
  CREATE INDEX posts_status ON posts(status);

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | dead
    run_at INTEGER NOT NULL,
    phase TEXT NOT NULL DEFAULT 'start',   -- start | check | finalize
    pending_data TEXT,
    pending_since INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    locked_by TEXT,
    locked_until INTEGER,
    inflight TEXT,                         -- set while an irreversible upstream call is in flight
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_due ON jobs(state, run_at);

  CREATE TABLE post_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE INDEX post_events_post ON post_events(post_id);
  `,
  `
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
  `,
  `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL,
    scopes TEXT NOT NULL,
    approval_mode INTEGER NOT NULL DEFAULT 1,
    rate_limit_per_min INTEGER NOT NULL DEFAULT 120,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    actor_name TEXT,
    via TEXT NOT NULL,
    operation TEXT NOT NULL,
    target TEXT,
    status INTEGER,
    detail TEXT
  );
  CREATE INDEX audit_at ON audit_log(at);

  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    events TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',   -- pending | delivered | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_status INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX webhook_due ON webhook_deliveries(state, next_attempt_at);

  ALTER TABLE groups ADD COLUMN created_by TEXT;
  ALTER TABLE groups ADD COLUMN approval_note TEXT;
  `,
  `
  -- Cloudflare Access mode: a session belongs to one verified email.
  ALTER TABLE sessions ADD COLUMN email TEXT;
  ALTER TABLE sessions ADD COLUMN access_exp INTEGER;
  `,
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return wrap(db);
}

function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const api = {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    exec: (sql) => db.exec(sql),
    /** Run fn inside BEGIN IMMEDIATE (write lock acquired up front → no lost updates across processes). */
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }
    },
    getSetting(key, def = null) {
      const r = stmt('SELECT value FROM settings WHERE key = ?').get(key);
      return r ? r.value : def;
    },
    setSetting(key, value) {
      stmt('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
    },
    close: () => db.close(),
  };
  return api;
}
