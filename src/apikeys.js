// API keys (hashed at rest, scoped, per-key rate limit, approval mode) + audit log.
import { uid, randomToken, sha256, safeEqual } from './crypto.js';

export const SCOPES = ['read', 'write', 'publish', 'analytics', 'admin'];
export const SCOPE_HELP = {
  read: 'List/read accounts, posts, media, calendar, settings.',
  write: 'Create/edit/delete drafts and media.',
  publish: 'Schedule, reschedule, post now, retry (subject to approval mode).',
  analytics: 'Read analytics and trigger analytics sync.',
  admin: 'Manage API keys, webhooks, settings, approvals and account connections.',
};

/** The web UI session principal: full access, no approval gate. */
export const SESSION_PRINCIPAL = Object.freeze({ type: 'session', id: 'admin', name: 'admin (web UI)', scopes: SCOPES, approval: false });

const BUCKETS = new Map(); // keyId -> { tokens, at }  (shared by every workspace view of the same process)

/**
 * API keys. With `ws` the CRUD methods only see that workspace's keys; authenticate() and rateLimit()
 * are instance-wide (a key is found by its prefix and carries its workspace in the principal).
 */
export function createApiKeys({ db, ws = null }) {
  // Token buckets live in memory: per process on Node, per isolate on Workers (best effort there).
  const buckets = BUCKETS;
  const needWs = () => { if (!ws) throw new Error('apiKeys: workspace scope required'); };

  const view = (r) => r && {
    id: r.id, name: r.name, prefix: r.prefix, scopes: JSON.parse(r.scopes), approval_mode: !!r.approval_mode,
    rate_limit_per_min: r.rate_limit_per_min, created_at: r.created_at, last_used_at: r.last_used_at, revoked_at: r.revoked_at,
  };

  return {
    /** Returns { key (shown once), ...view } */
    async create({ name, scopes = ['read', 'write', 'publish', 'analytics'], approval_mode = true, rate_limit_per_min = 120 }) {
      needWs();
      const bad = scopes.filter((s) => !SCOPES.includes(s));
      if (bad.length) throw new Error(`Unknown scope(s): ${bad.join(', ')}. Valid: ${SCOPES.join(', ')}`);
      if (!scopes.length) throw new Error('At least one scope is required');
      const id = uid();
      const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
      const secret = randomToken(32);
      const key = `pl_${prefix}_${secret}`;
      await db.run('INSERT INTO api_keys(id, workspace_id, name, prefix, hash, scopes, approval_mode, rate_limit_per_min, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        id, ws, String(name || 'agent').slice(0, 100), prefix, await sha256(key), JSON.stringify([...new Set(scopes)]), approval_mode ? 1 : 0, Math.max(1, Number(rate_limit_per_min) || 120), Date.now());
      return { key, ...view(await db.get('SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?', id, ws)) };
    },
    list: async () => { needWs(); return (await db.all('SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC', ws)).map(view); },
    get: async (id) => { needWs(); return view(await db.get('SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?', id, ws)); },
    async update(id, { name, scopes, approval_mode, rate_limit_per_min }) {
      needWs();
      const r = await db.get('SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?', id, ws);
      if (!r) return null;
      if (scopes) {
        const bad = scopes.filter((s) => !SCOPES.includes(s));
        if (bad.length) throw new Error(`Unknown scope(s): ${bad.join(', ')}`);
      }
      await db.run('UPDATE api_keys SET name=?, scopes=?, approval_mode=?, rate_limit_per_min=? WHERE id=? AND workspace_id=?',
        name ?? r.name, scopes ? JSON.stringify(scopes) : r.scopes, approval_mode === undefined ? r.approval_mode : approval_mode ? 1 : 0, rate_limit_per_min ?? r.rate_limit_per_min, id, ws);
      return view(await db.get('SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?', id, ws));
    },
    async revoke(id) {
      needWs();
      return (await db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL', Date.now(), id, ws)).changes > 0;
    },

    /** Authenticate a bearer token. Returns a principal or null. */
    async authenticate(token) {
      const m = /^pl_([A-Za-z0-9]{8})_[A-Za-z0-9_-]{20,}$/.exec(String(token || '').trim());
      if (!m) return null;
      // Instance-wide lookup by prefix: the key itself tells which workspace it belongs to.
      const r = await db.get('SELECT k.*, w.name AS workspace_name FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id WHERE k.prefix = ? AND k.workspace_id IS NOT NULL', m[1]);
      if (!r || r.revoked_at || !safeEqual(r.hash, await sha256(String(token).trim()))) return null;
      if (!r.last_used_at || Date.now() - r.last_used_at > 60000) await db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ? AND workspace_id = ?', Date.now(), r.id, r.workspace_id);
      return { type: 'api_key', id: r.id, name: r.name, scopes: JSON.parse(r.scopes), approval: !!r.approval_mode, rateLimit: r.rate_limit_per_min, workspace_id: r.workspace_id, workspace_name: r.workspace_name };
    },

    /** Token bucket per key. Returns { ok, retryAfter }. */
    rateLimit(principal) {
      if (principal.type !== 'api_key') return { ok: true };
      const cap = principal.rateLimit || 120;
      const now = Date.now();
      const b = buckets.get(principal.id) || { tokens: cap, at: now };
      b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 60000) * cap);
      b.at = now;
      if (b.tokens < 1) {
        buckets.set(principal.id, b);
        return { ok: false, retryAfter: Math.ceil(((1 - b.tokens) / cap) * 60) };
      }
      b.tokens -= 1;
      buckets.set(principal.id, b);
      return { ok: true, remaining: Math.floor(b.tokens), limit: cap };
    },
  };
}

/** Audit log of one workspace (prune() is instance-wide maintenance). */
export function createAudit({ db, ws = null }) {
  const needWs = () => { if (!ws) throw new Error('audit: workspace scope required'); };
  return {
    record({ principal, via, operation, target = null, status = 200, detail = null }) {
      needWs();
      return db.run('INSERT INTO audit_log(workspace_id, at, actor_type, actor_id, actor_name, via, operation, target, status, detail) VALUES(?,?,?,?,?,?,?,?,?,?)',
        ws, Date.now(), principal?.type || 'system', principal?.id || null, principal?.name || null, via, operation, target, status, detail ? JSON.stringify(detail).slice(0, 4000) : null);
    },
    async list({ limit = 100, offset = 0, actor_id } = {}) {
      needWs();
      const rows = actor_id
        ? await db.all('SELECT * FROM audit_log WHERE workspace_id = ? AND actor_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', ws, actor_id, limit, offset)
        : await db.all('SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', ws, limit, offset);
      return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
    },
    prune(days = 180) { return db.run('DELETE FROM audit_log WHERE at < ? /* ws:system */', Date.now() - days * 86400000); },
  };
}
