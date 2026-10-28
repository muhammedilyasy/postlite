// Cloudflare D1 adapter implementing the same async DB interface as src/node/db.js.
// D1 batch() runs the statements as one SQL transaction
// (developers.cloudflare.com/d1/worker-api/d1-database/#batch).
import { meter } from '../meter.js';

const norm = (v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v);
const returnsRows = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

export function createD1(d1) {
  if (!d1 || typeof d1.prepare !== 'function') throw new Error('D1 binding "DB" is missing. Add a d1_databases binding named DB in wrangler.jsonc.');
  const count = (n = 1) => { meter.current.used.queries += n; };
  const prep = (sql, p) => d1.prepare(sql).bind(...p.map(norm));
  const api = {
    kind: 'd1',
    raw: d1,
    async get(sql, ...p) { count(); return (await prep(sql, p).first()) ?? null; },
    async all(sql, ...p) { count(); return (await prep(sql, p).all()).results || []; },
    async run(sql, ...p) {
      count();
      if (returnsRows(sql)) { const r = await prep(sql, p).all(); return { changes: (r.results || []).length, lastRowId: 0, rows: r.results || [] }; }
      const r = await prep(sql, p).run();
      return { changes: Number(r.meta?.changes || 0), lastRowId: Number(r.meta?.last_row_id || 0) };
    },
    async batch(list) {
      const items = list.filter(Boolean);
      if (!items.length) return [];
      count(items.length);
      const res = await d1.batch(items.map(([sql, ...p]) => prep(sql, p)));
      return res.map((r) => ({ rows: r.results || [], changes: Number(r.meta?.changes || 0), lastRowId: Number(r.meta?.last_row_id || 0) }));
    },
    async exec(sql) { count(); await d1.exec(sql); },
    async getSetting(key, def = null) {
      const r = await api.get('SELECT value FROM settings WHERE key = ?', key);
      return r ? r.value : def;
    },
    async setSetting(key, value) {
      await api.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
    },
    close() {},
  };
  return api;
}
