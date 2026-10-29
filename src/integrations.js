// Integrations (connected accounts): storage with encrypted tokens, refresh, health status.
import { uid } from './crypto.js';
import { getProvider } from './providers/index.js';
import { ProviderError } from './providers/http.js';
import { HttpError } from './errors.js';

const REFRESH_MARGIN_MS = 5 * 60000;
const LONG_MARGIN_MS = 10 * 86400000;
/** How long before expiry a token is renewed: short-lived (YouTube 1 h, X 2 h) vs long-lived (Meta/LinkedIn 60 days). */
const marginFor = (p, provider) => p.refreshMarginMs ?? (provider === 'youtube' ? REFRESH_MARGIN_MS : LONG_MARGIN_MS);
const canRefreshFor = (p, integ) => !!p.canRefresh && (!p.canRefreshFor || p.canRefreshFor(integ));
// One refresh at a time per account (X rotates refresh tokens: a second concurrent refresh would use a dead token).
const inflight = new Map();

/** Connected accounts of ONE workspace (ws). Every statement filters by workspace_id. */
export function createIntegrations({ db, cfg, cipher, ws, log = () => {}, onNeedsReconnect = () => {} }) {
  if (!ws) throw new Error('createIntegrations: workspace id required');
  const safeMeta = (m) => ({ page_id: m.page_id, page_name: m.page_name, user_token_expires_at: m.user_token_expires_at, premium: m.premium, has_refresh: m.has_refresh, refresh_expires_at: m.refresh_expires_at, urn: m.urn });
  const publicRow = (r) => r && {
    id: r.id, provider: r.provider, external_id: r.external_id, name: r.display_name || r.name, platform_name: r.name, display_name: r.display_name || null, username: r.username, picture: r.picture,
    status: r.status, status_message: r.status_message, disabled: !!r.disabled_at, disabled_at: r.disabled_at || null, posting_slots: r.posting_slots ? JSON.parse(r.posting_slots) : null, token_expires_at: r.token_expires_at, meta: safeMeta(JSON.parse(r.meta || '{}')),
    created_at: r.created_at, updated_at: r.updated_at, last_checked_at: r.last_checked_at,
  };

  const api = {
    list: async () => (await db.all('SELECT * FROM integrations WHERE workspace_id = ? ORDER BY provider, COALESCE(display_name, name)', ws)).map(publicRow),
    get: async (id) => publicRow(await db.get('SELECT * FROM integrations WHERE id = ? AND workspace_id = ?', String(id ?? ''), ws)),
    rawGet: (id) => db.get('SELECT * FROM integrations WHERE id = ? AND workspace_id = ?', String(id ?? ''), ws),

    /** Decrypted view for provider calls. */
    async secret(id) {
      const r = await db.get('SELECT * FROM integrations WHERE id = ? AND workspace_id = ?', String(id ?? ''), ws);
      if (!r) return null;
      const [access_token, refresh_token] = await Promise.all([cipher.decrypt(r.access_token_enc), cipher.decrypt(r.refresh_token_enc)]);
      return { ...r, meta: JSON.parse(r.meta || '{}'), access_token, refresh_token };
    },

    /** Insert or update (reconnect) an account returned by provider.exchange(). */
    async upsert(provider, a) {
      const now = Date.now();
      // (provider, external_id) is unique instance-wide (schema since v1). An account connected in another
      // workspace is never taken over: its tokens stay where they are and this connect is refused.
      const existing = await db.get('SELECT id, workspace_id FROM integrations WHERE provider = ? AND external_id = ? /* ws:system */', provider, a.external_id);
      if (existing && existing.workspace_id !== ws) throw new HttpError(409, `${a.name || 'This account'} is already connected in another postlite workspace. Disconnect it there first.`);
      const enc = await Promise.all([cipher.encrypt(a.access_token), cipher.encrypt(a.refresh_token)]);
      if (existing) {
        await db.run(`UPDATE integrations SET name=?, username=?, picture=?, access_token_enc=?, refresh_token_enc=?, token_expires_at=?, status='active', status_message=NULL, meta=?, updated_at=? WHERE id=? AND workspace_id=?`,
          a.name || '', a.username || '', a.picture || '', enc[0], enc[1], a.token_expires_at ?? null, JSON.stringify(a.meta || {}), now, existing.id, ws);
        return existing.id;
      }
      const id = uid();
      await db.run(`INSERT INTO integrations(id, workspace_id, provider, external_id, name, username, picture, access_token_enc, refresh_token_enc, token_expires_at, status, meta, created_at, updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`,
        id, ws, provider, a.external_id, a.name || '', a.username || '', a.picture || '', enc[0], enc[1], a.token_expires_at ?? null, JSON.stringify(a.meta || {}), now, now);
      return id;
    },

    /** Channel preferences: rename (null = platform name), pause publishing, own posting slots (null = workspace slots). */
    async setPrefs(id, { display_name, disabled, posting_slots } = {}) {
      const r = await api.rawGet(id);
      if (!r) throw new HttpError(404, 'Account not found.');
      const sets = [], args = [];
      if (display_name !== undefined) {
        const n = display_name === null ? null : String(display_name).replace(/\s+/g, ' ').trim();
        if (n !== null && n.length > 80) throw new HttpError(400, 'display_name must be at most 80 characters.');
        sets.push('display_name = ?'); args.push(n || null);
      }
      if (disabled !== undefined) { sets.push('disabled_at = ?'); args.push(disabled ? (r.disabled_at || Date.now()) : null); }
      if (posting_slots !== undefined) { sets.push('posting_slots = ?'); args.push(posting_slots === null ? null : JSON.stringify(posting_slots)); }
      if (!sets.length) return api.get(id);
      await db.run(`UPDATE integrations SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND workspace_id = ?`, ...args, Date.now(), id, ws);
      // Resumed: posts that came due while paused publish now (instead of being failed as missed).
      if (disabled === false && r.disabled_at) {
        const t = Date.now();
        await db.run("UPDATE jobs SET run_at = ?, updated_at = ? WHERE state = 'queued' AND phase = 'start' AND run_at < ? AND post_id IN (SELECT id FROM posts WHERE integration_id = ? AND workspace_id = ?)", t, t, t, id, ws);
      }
      return api.get(id);
    },

    async remove(id) {
      // Unpublished posts for this account are removed with it (FK cascade); published history goes too.
      await db.run('DELETE FROM integrations WHERE id = ? AND workspace_id = ?', id, ws);
    },

    async markNeedsReconnect(id, message) {
      const before = await db.get('SELECT status, name, provider FROM integrations WHERE id = ? AND workspace_id = ?', id, ws);
      if (before && before.status !== 'needs_reconnect') {
        try { await onNeedsReconnect({ account_id: id, name: before.name, provider: before.provider, message: String(message || '') }); } catch {}
      }
      await db.run(`UPDATE integrations SET status='needs_reconnect', status_message=?, updated_at=? WHERE id=? AND workspace_id=?`, String(message || 'Reconnect required').slice(0, 500), Date.now(), id, ws);
      log('warn', `integration ${id} needs reconnect: ${message}`);
    },
    async markActive(id) {
      await db.run(`UPDATE integrations SET status='active', status_message=NULL, last_checked_at=?, updated_at=? WHERE id=? AND workspace_id=?`, Date.now(), Date.now(), id, ws);
    },

    async saveTokens(id, t) {
      const [a, r] = await Promise.all([cipher.encrypt(t.access_token), t.refresh_token ? cipher.encrypt(t.refresh_token) : null]);
      await db.run('UPDATE integrations SET access_token_enc=?, refresh_token_enc=COALESCE(?, refresh_token_enc), token_expires_at=?, updated_at=? WHERE id=? AND workspace_id=?',
        a, r, t.token_expires_at ?? null, Date.now(), id, ws);
    },

    /** Refresh tokens when the provider supports it. Marks needs_reconnect on unrecoverable failure. */
    async refresh(id) {
      const key = `${ws}:${id}`;
      if (inflight.has(key)) return inflight.get(key);
      const run = (async () => {
        const integ = await api.secret(id);
        if (!integ) throw new ProviderError('permanent', 'The connected account was removed.');
        const p = getProvider(integ.provider);
        if (!p.canRefresh || !p.refresh) throw new ProviderError('auth', 'Token expired and this platform does not support refresh; reconnect the account.');
        try {
          const t = await p.refresh(cfg, integ);
          await api.saveTokens(id, t);
          return api.secret(id);
        } catch (e) {
          if (e.kind === 'transient') throw e;
          // Another process (Workers isolate, CLI) may have rotated the token meanwhile: use it instead of giving up.
          const now = await api.secret(id);
          if (now && now.refresh_token && now.refresh_token !== integ.refresh_token) return now;
          await api.markNeedsReconnect(id, `Token refresh failed: ${e.message}`);
          throw new ProviderError('auth', `Token refresh failed: ${e.message}`);
        }
      })().finally(() => inflight.delete(key));
      inflight.set(key, run);
      return run;
    },

    /** Return decrypted integration with a fresh access token (refreshing proactively when close to expiry). */
    async fresh(id) {
      let integ = await api.secret(id);
      if (!integ) throw new ProviderError('permanent', 'The connected account was removed.');
      const p = getProvider(integ.provider);
      if (canRefreshFor(p, integ) && integ.token_expires_at && integ.token_expires_at - Date.now() < marginFor(p, integ.provider)) {
        integ = await api.refresh(id);
      }
      return integ;
    },

    /** Health check: verifies the token works; updates status. */
    async check(id) {
      const integ = await api.fresh(id);
      const p = getProvider(integ.provider);
      try {
        await p.healthCheck({ cfg, integration: integ, token: integ.access_token });
        await api.markActive(id);
        return { ok: true };
      } catch (e) {
        if (e.kind === 'auth' && canRefreshFor(p, integ)) {
          try {
            const r = await api.refresh(id);
            await p.healthCheck({ cfg, integration: r, token: r.access_token });
            await api.markActive(id);
            return { ok: true };
          } catch (e2) {
            await api.markNeedsReconnect(id, e2.message);
            return { ok: false, error: e2.message };
          }
        }
        if (e.kind === 'auth' || e.kind === 'disconnect') {
          await api.markNeedsReconnect(id, e.message);
          return { ok: false, error: e.message };
        }
        await db.run('UPDATE integrations SET last_checked_at=? WHERE id=? AND workspace_id=?', Date.now(), id, ws);
        return { ok: false, error: e.message, transient: e.kind === 'transient' };
      }
    },

    /** Periodic maintenance: refresh soon-to-expire tokens and flag expiring Meta user tokens. */
    async maintain({ budget = null } = {}) {
      for (const r of await db.all("SELECT id, provider, token_expires_at, meta FROM integrations WHERE workspace_id = ? AND status = 'active'", ws)) {
        if (budget && !budget.has({ fetches: 4, queries: 6 })) break;
        try {
          const p = getProvider(r.provider);
          const m = JSON.parse(r.meta || '{}');
          // Long-lived tokens are renewed ahead of time here; short-lived ones (YouTube, X) just before use.
          if (canRefreshFor(p, { meta: m }) && r.token_expires_at && marginFor(p, r.provider) >= LONG_MARGIN_MS && r.token_expires_at - Date.now() < LONG_MARGIN_MS) await api.refresh(r.id);
          if (m.user_token_expires_at && m.user_token_expires_at < Date.now()) {
            // Page tokens normally outlive the user token; verify instead of assuming.
            await api.check(r.id);
          }
        } catch (e) {
          log('warn', `maintenance for ${r.id}: ${e.message}`);
        }
      }
    },
  };
  return api;
}
