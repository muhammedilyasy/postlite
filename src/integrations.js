// Integrations (connected accounts): storage with encrypted tokens, refresh, health status.
import { uid } from './crypto.js';
import { getProvider } from './providers/index.js';
import { ProviderError } from './providers/http.js';

const REFRESH_MARGIN_MS = 5 * 60000;

export function createIntegrations({ db, cfg, cipher, log = () => {}, onNeedsReconnect = () => {} }) {
  const publicRow = (r) => r && {
    id: r.id, provider: r.provider, external_id: r.external_id, name: r.name, username: r.username, picture: r.picture,
    status: r.status, status_message: r.status_message, token_expires_at: r.token_expires_at, meta: safeMeta(JSON.parse(r.meta || '{}')),
    created_at: r.created_at, updated_at: r.updated_at, last_checked_at: r.last_checked_at,
  };
  const safeMeta = (m) => ({ page_id: m.page_id, page_name: m.page_name, user_token_expires_at: m.user_token_expires_at });

  const api = {
    list: () => db.all('SELECT * FROM integrations ORDER BY provider, name').map(publicRow),
    get: (id) => publicRow(db.get('SELECT * FROM integrations WHERE id = ?', id)),
    rawGet: (id) => db.get('SELECT * FROM integrations WHERE id = ?', id),

    /** Decrypted view for provider calls. */
    secret(id) {
      const r = db.get('SELECT * FROM integrations WHERE id = ?', id);
      if (!r) return null;
      return { ...r, meta: JSON.parse(r.meta || '{}'), access_token: cipher.decrypt(r.access_token_enc), refresh_token: cipher.decrypt(r.refresh_token_enc) };
    },

    /** Insert or update (reconnect) an account returned by provider.exchange(). */
    upsert(provider, a) {
      const now = Date.now();
      const existing = db.get('SELECT id FROM integrations WHERE provider = ? AND external_id = ?', provider, a.external_id);
      const enc = [cipher.encrypt(a.access_token), cipher.encrypt(a.refresh_token)];
      if (existing) {
        db.run(`UPDATE integrations SET name=?, username=?, picture=?, access_token_enc=?, refresh_token_enc=?, token_expires_at=?, status='active', status_message=NULL, meta=?, updated_at=? WHERE id=?`,
          a.name || '', a.username || '', a.picture || '', enc[0], enc[1], a.token_expires_at ?? null, JSON.stringify(a.meta || {}), now, existing.id);
        return existing.id;
      }
      const id = uid();
      db.run(`INSERT INTO integrations(id, provider, external_id, name, username, picture, access_token_enc, refresh_token_enc, token_expires_at, status, meta, created_at, updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?)`,
        id, provider, a.external_id, a.name || '', a.username || '', a.picture || '', enc[0], enc[1], a.token_expires_at ?? null, JSON.stringify(a.meta || {}), now, now);
      return id;
    },

    remove(id) {
      // Unpublished posts for this account are removed with it (FK cascade); published history goes too.
      db.run('DELETE FROM integrations WHERE id = ?', id);
    },

    markNeedsReconnect(id, message) {
      const before = db.get('SELECT status, name, provider FROM integrations WHERE id = ?', id);
      if (before && before.status !== 'needs_reconnect') {
        try { onNeedsReconnect({ account_id: id, name: before.name, provider: before.provider, message: String(message || '') }); } catch {}
      }
      db.run(`UPDATE integrations SET status='needs_reconnect', status_message=?, updated_at=? WHERE id=?`, String(message || 'Reconnect required').slice(0, 500), Date.now(), id);
      log('warn', `integration ${id} needs reconnect: ${message}`);
    },
    markActive(id) {
      db.run(`UPDATE integrations SET status='active', status_message=NULL, last_checked_at=?, updated_at=? WHERE id=?`, Date.now(), Date.now(), id);
    },

    saveTokens(id, t) {
      db.run('UPDATE integrations SET access_token_enc=?, refresh_token_enc=COALESCE(?, refresh_token_enc), token_expires_at=?, updated_at=? WHERE id=?',
        cipher.encrypt(t.access_token), t.refresh_token ? cipher.encrypt(t.refresh_token) : null, t.token_expires_at ?? null, Date.now(), id);
    },

    /** Refresh tokens when the provider supports it. Marks needs_reconnect on unrecoverable failure. */
    async refresh(id) {
      const integ = api.secret(id);
      const p = getProvider(integ.provider);
      if (!p.canRefresh || !p.refresh) throw new ProviderError('auth', 'Token expired and this platform does not support refresh; reconnect the account.');
      try {
        const t = await p.refresh(cfg, integ);
        api.saveTokens(id, t);
        return api.secret(id);
      } catch (e) {
        if (e.kind === 'transient') throw e;
        api.markNeedsReconnect(id, `Token refresh failed: ${e.message}`);
        throw new ProviderError('auth', `Token refresh failed: ${e.message}`);
      }
    },

    /** Return decrypted integration with a fresh access token (refreshing proactively when close to expiry). */
    async fresh(id) {
      let integ = api.secret(id);
      if (!integ) throw new ProviderError('permanent', 'The connected account was removed.');
      const p = getProvider(integ.provider);
      if (p.canRefresh && integ.token_expires_at && integ.token_expires_at - Date.now() < (integ.provider === 'youtube' ? REFRESH_MARGIN_MS : 10 * 86400000)) {
        integ = await api.refresh(id);
      }
      return integ;
    },

    /** Health check: verifies the token works; updates status. */
    async check(id) {
      const integ = await api.fresh(id).catch((e) => { throw e; });
      const p = getProvider(integ.provider);
      try {
        await p.healthCheck({ cfg, integration: integ, token: integ.access_token });
        api.markActive(id);
        return { ok: true };
      } catch (e) {
        if (e.kind === 'auth' && p.canRefresh) {
          try {
            const r = await api.refresh(id);
            await p.healthCheck({ cfg, integration: r, token: r.access_token });
            api.markActive(id);
            return { ok: true };
          } catch (e2) {
            api.markNeedsReconnect(id, e2.message);
            return { ok: false, error: e2.message };
          }
        }
        if (e.kind === 'auth' || e.kind === 'disconnect') {
          api.markNeedsReconnect(id, e.message);
          return { ok: false, error: e.message };
        }
        db.run('UPDATE integrations SET last_checked_at=? WHERE id=?', Date.now(), id);
        return { ok: false, error: e.message, transient: e.kind === 'transient' };
      }
    },

    /** Periodic maintenance: refresh soon-to-expire tokens and flag expiring Meta user tokens. */
    async maintain() {
      for (const r of db.all("SELECT id, provider, token_expires_at, meta FROM integrations WHERE status = 'active'")) {
        try {
          const p = getProvider(r.provider);
          if (p.canRefresh && r.token_expires_at && r.token_expires_at - Date.now() < 10 * 86400000 && r.provider !== 'youtube') await api.refresh(r.id);
          const m = JSON.parse(r.meta || '{}');
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
