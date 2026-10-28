// Node database adapter: node:sqlite (WAL) behind the async DB interface shared with Cloudflare D1.
//   get(sql, ...p) → row | null      all(sql, ...p) → rows      run(sql, ...p) → { changes, lastRowId }
//   batch([[sql, ...p], ...]) → [{ rows, changes }]  (atomic, like D1 batch())
// Migrations are the SQL files in /migrations (also used by `wrangler d1 migrations apply`); the
// applied count is tracked in PRAGMA user_version.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from './config.js';
import { meter } from '../meter.js';

export const MIGRATIONS_DIR = path.join(ROOT, 'migrations');

export function migrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
}

const norm = (v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v);
const returnsRows = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

export function openDb(file, { migrationsDir = MIGRATIONS_DIR } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const files = migrationFiles(migrationsDir);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = version; i < files.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(migrationsDir, files[i]), 'utf8'));
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${files[i]} failed: ${e.message}`);
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
  const count = (n = 1) => { meter.current.used.queries += n; };
  const runSync = (sql, params) => {
    const r = stmt(sql).run(...params.map(norm));
    return { changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
  };
  const api = {
    kind: 'sqlite',
    raw: db,
    async get(sql, ...p) { count(); return stmt(sql).get(...p.map(norm)) ?? null; },
    async all(sql, ...p) { count(); return stmt(sql).all(...p.map(norm)); },
    async run(sql, ...p) {
      count();
      if (returnsRows(sql)) { const rows = stmt(sql).all(...p.map(norm)); return { changes: rows.length, lastRowId: 0, rows }; }
      return runSync(sql, p);
    },
    /** Atomic batch (BEGIN IMMEDIATE … COMMIT), same semantics as D1 batch(). */
    async batch(list) {
      const items = list.filter(Boolean);
      if (!items.length) return [];
      count(items.length);
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = items.map(([sql, ...p]) => {
          if (returnsRows(sql)) { const rows = stmt(sql).all(...p.map(norm)); return { rows, changes: rows.length }; }
          return { rows: [], ...runSync(sql, p) };
        });
        db.exec('COMMIT');
        return out;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }
    },
    async exec(sql) { count(); db.exec(sql); },
    async getSetting(key, def = null) {
      const r = await api.get('SELECT value FROM settings WHERE key = ?', key);
      return r ? r.value : def;
    },
    async setSetting(key, value) {
      await api.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
    },
    close: () => db.close(),
  };
  return api;
}
