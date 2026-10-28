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

export function createApiKeys({ db }) {
  const buckets = new Map(); // keyId -> { tokens, at }

  const view = (r) => r && {
    id: r.id, name: r.name, prefix: r.prefix, scopes: JSON.parse(r.scopes), approval_mode: !!r.approval_mode,
    rate_limit_per_min: r.rate_limit_per_min, created_at: r.created_at, last_used_at: r.last_used_at, revoked_at: r.revoked_at,
  };

  return {
    /** Returns { key (shown once), ...view } */
    create({ name, scopes = ['read', 'write', 'publish', 'analytics'], approval_mode = true, rate_limit_per_min = 120 }) {
      const bad = scopes.filter((s) => !SCOPES.includes(s));
      if (bad.length) throw new Error(`Unknown scope(s): ${bad.join(', ')}. Valid: ${SCOPES.join(', ')}`);
      if (!scopes.length) throw new Error('At least one scope is required');
      const id = uid();
      const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
      const secret = randomToken(32);
      const key = `pl_${prefix}_${secret}`;
      db.run('INSERT INTO api_keys(id, name, prefix, hash, scopes, approval_mode, rate_limit_per_min, created_at) VALUES(?,?,?,?,?,?,?,?)',
        id, String(name || 'agent').slice(0, 100), prefix, sha256(key), JSON.stringify([...new Set(scopes)]), approval_mode ? 1 : 0, Math.max(1, Number(rate_limit_per_min) || 120), Date.now());
      return { key, ...view(db.get('SELECT * FROM api_keys WHERE id = ?', id)) };
    },
    list: () => db.all('SELECT * FROM api_keys ORDER BY created_at DESC').map(view),
    get: (id) => view(db.get('SELECT * FROM api_keys WHERE id = ?', id)),
    update(id, { name, scopes, approval_mode, rate_limit_per_min }) {
      const r = db.get('SELECT * FROM api_keys WHERE id = ?', id);
      if (!r) return null;
      if (scopes) {
        const bad = scopes.filter((s) => !SCOPES.includes(s));
        if (bad.length) throw new Error(`Unknown scope(s): ${bad.join(', ')}`);
      }
      db.run('UPDATE api_keys SET name=?, scopes=?, approval_mode=?, rate_limit_per_min=? WHERE id=?',
        name ?? r.name, scopes ? JSON.stringify(scopes) : r.scopes, approval_mode === undefined ? r.approval_mode : approval_mode ? 1 : 0, rate_limit_per_min ?? r.rate_limit_per_min, id);
      return view(db.get('SELECT * FROM api_keys WHERE id = ?', id));
    },
    revoke(id) {
      return db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), id).changes > 0;
    },

    /** Authenticate a bearer token. Returns a principal or null. */
    authenticate(token) {
      const m = /^pl_([A-Za-z0-9]{8})_[A-Za-z0-9_-]{20,}$/.exec(String(token || '').trim());
      if (!m) return null;
      const r = db.get('SELECT * FROM api_keys WHERE prefix = ?', m[1]);
      if (!r || r.revoked_at || !safeEqual(r.hash, sha256(String(token).trim()))) return null;
      if (!r.last_used_at || Date.now() - r.last_used_at > 60000) db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', Date.now(), r.id);
      return { type: 'api_key', id: r.id, name: r.name, scopes: JSON.parse(r.scopes), approval: !!r.approval_mode, rateLimit: r.rate_limit_per_min };
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

export function createAudit({ db }) {
  return {
    record({ principal, via, operation, target = null, status = 200, detail = null }) {
      db.run('INSERT INTO audit_log(at, actor_type, actor_id, actor_name, via, operation, target, status, detail) VALUES(?,?,?,?,?,?,?,?,?)',
        Date.now(), principal?.type || 'system', principal?.id || null, principal?.name || null, via, operation, target, status, detail ? JSON.stringify(detail).slice(0, 4000) : null);
    },
    list({ limit = 100, offset = 0, actor_id } = {}) {
      const rows = actor_id
        ? db.all('SELECT * FROM audit_log WHERE actor_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', actor_id, limit, offset)
        : db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset);
      return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
    },
    prune(days = 180) { db.run('DELETE FROM audit_log WHERE at < ?', Date.now() - days * 86400000); },
  };
}
