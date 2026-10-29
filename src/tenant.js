// Multi-tenancy: workspaces, users and the tenant guard.
//
// Every row of tenant data belongs to exactly one workspace. Parent tables carry a workspace_id
// column; child tables (jobs, post_events, metrics, analytics_*, webhook_deliveries) are reached only
// through their parent. guardDb() wraps the DB so that any statement touching a tenant table must
// either filter by workspace_id or carry an explicit, reviewed marker:
//   /* ws:system */   cross-workspace system work (scheduler claim, webhook delivery, maintenance)
//   /* ws:checked */  a child-table write keyed by a parent id that was already verified in this workspace
// A statement without either throws, so a forgotten filter fails loudly (tests and production).
import { uid } from './crypto.js';

export const LEGACY_WORKSPACE = 'owner';

export const TENANT_TABLES = ['integrations', 'media', 'groups', 'posts', 'jobs', 'post_events', 'api_keys', 'audit_log', 'webhooks', 'webhook_deliveries',
  'uploads', 'oauth_states', 'remote_posts', 'account_metrics', 'post_metrics', 'analytics_status', 'analytics_runs', 'workspace_settings', 'brands', 'brand_channels', 'tags', 'group_tags', 'signatures', 'post_templates'];
const TENANT_RE = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\\s+(${TENANT_TABLES.join('|')})\\b`, 'i');
const MARK_RE = /\/\*\s*ws:(system|checked)\s*\*\//;

export class TenantGuardError extends Error {}

/** Throws when SQL touches a tenant table without a workspace filter or a reviewed marker. */
export function checkTenantSql(sql) {
  const m = TENANT_RE.exec(sql);
  if (!m) return;
  if (/\bworkspace_id\b/.test(sql) || MARK_RE.test(sql)) return;
  throw new TenantGuardError(`Tenant guard: statement on "${m[1]}" has no workspace filter: ${sql.replace(/\s+/g, ' ').slice(0, 200)}`);
}

/** Wrap the async DB interface with the tenant guard. Checked statements are cached by text. */
export function guardDb(db, { log = () => {} } = {}) {
  const ok = new Set();
  const check = (sql) => {
    if (ok.has(sql)) return;
    try { checkTenantSql(sql); } catch (e) { log('error', e.message); throw e; }
    ok.add(sql);
  };
  return {
    ...db,
    guarded: true,
    async get(sql, ...p) { check(sql); return db.get(sql, ...p); },
    async all(sql, ...p) { check(sql); return db.all(sql, ...p); },
    async run(sql, ...p) { check(sql); return db.run(sql, ...p); },
    async batch(list) { for (const it of list) if (it) check(it[0]); return db.batch(list); },
    exec: (sql) => db.exec(sql),
    getSetting: (k, d) => db.getSetting(k, d),
    setSetting: (k, v) => db.setSetting(k, v),
    close: () => db.close(),
  };
}

export const normEmail = (e) => String(e || '').trim().toLowerCase();
const defaultName = (email) => normEmail(email).split('@')[0] || 'Workspace';

/** Users and workspaces (global, not tenant data). */
export function createWorkspaces({ db }) {
  const cache = new Map(); // email -> { user_id, workspace_id, name }
  const api = {
    get: (id) => db.get('SELECT * FROM workspaces WHERE id = ?', id),
    list: () => db.all('SELECT w.*, (SELECT GROUP_CONCAT(email) FROM users u WHERE u.workspace_id = w.id) AS emails FROM workspaces w ORDER BY created_at'),
    users: () => db.all('SELECT * FROM users ORDER BY created_at'),
    async byEmail(email) {
      const e = normEmail(email);
      return db.get('SELECT u.id AS user_id, u.email, u.workspace_id, w.name FROM users u JOIN workspaces w ON w.id = u.workspace_id WHERE u.email = ?', e);
    },
    /** The workspace of a signed-in email; created on first sign-in. */
    async forEmail(email, { create = true } = {}) {
      const e = normEmail(email);
      if (!e) throw new Error('email required');
      const hit = cache.get(e);
      if (hit) return hit;
      let row = await api.byEmail(e);
      if (!row && create) {
        const ws = uid();
        const now = Date.now();
        await db.batch([
          ['INSERT INTO workspaces(id, name, created_at) VALUES(?,?,?)', ws, defaultName(e), now],
          ['INSERT INTO users(id, email, workspace_id, created_at) VALUES(?,?,?,?) ON CONFLICT(email) DO NOTHING', uid(), e, ws, now],
        ]);
        row = await api.byEmail(e);
        // Lost a race with a concurrent first request: drop the unused workspace.
        if (row && row.workspace_id !== ws) await db.run('DELETE FROM workspaces WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE workspace_id = ?)', ws, ws);
      }
      if (!row) return null;
      const out = { user_id: row.user_id, email: e, workspace_id: row.workspace_id, name: row.name };
      cache.set(e, out);
      return out;
    },
    /** Bind an email to an existing workspace (attribution script / CLI). */
    async assign(email, workspaceId, { name } = {}) {
      const e = normEmail(email);
      const now = Date.now();
      await db.batch([
        ['INSERT INTO users(id, email, workspace_id, created_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET workspace_id = excluded.workspace_id', uid(), e, workspaceId, now],
        name ? ['UPDATE workspaces SET name = ? WHERE id = ?', name, workspaceId] : null,
      ]);
      cache.delete(e);
      return api.forEmail(e, { create: false });
    },
    async create(name) {
      const id = uid();
      await db.run('INSERT INTO workspaces(id, name, created_at) VALUES(?,?,?)', id, String(name || 'Workspace').slice(0, 100), Date.now());
      return id;
    },
    clearCache() { cache.clear(); },
  };
  return api;
}

/** Per-workspace key/value settings (timezone, posting slots, platform apps). */
export function wsSettings(db, ws) {
  return {
    async get(key, def = null) {
      const r = await db.get('SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = ?', ws, key);
      return r ? r.value : def;
    },
    async all(keys) {
      const rows = await db.all(`SELECT key, value FROM workspace_settings WHERE workspace_id = ? AND key IN (${keys.map(() => '?').join(',')})`, ws, ...keys);
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    like: (prefix) => db.all('SELECT key, value FROM workspace_settings WHERE workspace_id = ? AND key LIKE ?', ws, `${prefix}%`),
    setStmt: (key, value) => ['INSERT INTO workspace_settings(workspace_id, key, value) VALUES(?,?,?) ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value', ws, key, String(value)],
    delStmt: (key) => ['DELETE FROM workspace_settings WHERE workspace_id = ? AND key = ?', ws, key],
    async set(key, value) { await db.run(...this.setStmt(key, value)); },
    async del(key) { await db.run(...this.delStmt(key)); },
  };
}
