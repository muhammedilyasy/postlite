// OAuth connect flow shared by the web UI and the API ("get connect URL" for agents).
import { randomToken, pkcePair } from './crypto.js';
import { getProvider, providers } from './providers/index.js';
import { HttpError } from './media.js';

const STATE_TTL = 30 * 60000;

export function createOAuth(core) {
  const { db, cfg, cipher, integrations } = core;
  const redirectUri = (provider) => `${cfg.publicUrl}/oauth/${provider}/callback`;

  return {
    redirectUri,
    available() {
      return Object.values(providers).map((p) => ({ provider: p.id, label: p.label, configured: p.isConfigured(cfg), scopes: p.scopes, redirect_uri: redirectUri(p.id) }));
    },

    start(provider, { autoSelect = false, reconnectId = null } = {}) {
      const p = providers[provider];
      if (!p) throw new HttpError(400, `Unknown provider "${provider}". Use one of: ${Object.keys(providers).join(', ')}`);
      if (!p.isConfigured(cfg)) throw new HttpError(409, `${p.label} is not configured on this server. Set the app ID/secret env vars (see README) and restart.`);
      db.run('DELETE FROM oauth_states WHERE created_at < ?', Date.now() - STATE_TTL);
      const state = randomToken(24);
      const pk = pkcePair();
      db.run('INSERT INTO oauth_states(state, provider, verifier, reconnect_id, data_enc, created_at) VALUES(?,?,?,?,?,?)',
        state, provider, pk.verifier, reconnectId, cipher.encrypt(JSON.stringify({ autoSelect })), Date.now());
      return { url: p.authUrl(cfg, { state, redirectUri: redirectUri(provider), challenge: pk.challenge }), state, expires_in_sec: STATE_TTL / 1000 };
    },

    /** Returns { connected:[...] } or { select: state, accounts:[...] } */
    async callback(provider, { code, state, error, error_description }) {
      const row = db.get('SELECT * FROM oauth_states WHERE state = ?', String(state || ''));
      if (!row || row.provider !== provider || Date.now() - row.created_at > STATE_TTL) throw new HttpError(400, 'This connect link is invalid or expired. Start the connection again.');
      if (error) {
        db.run('DELETE FROM oauth_states WHERE state = ?', row.state);
        throw new HttpError(400, `Authorization was cancelled or denied: ${error_description || error}`);
      }
      if (!code) throw new HttpError(400, 'Missing authorization code.');
      const opts = JSON.parse(cipher.decrypt(row.data_enc) || '{}');
      const p = getProvider(provider);
      let accounts;
      try {
        accounts = await p.exchange(cfg, { code, redirectUri: redirectUri(provider), verifier: row.verifier });
      } catch (e) {
        db.run('DELETE FROM oauth_states WHERE state = ?', row.state);
        throw new HttpError(400, `Could not connect: ${e.message}`);
      }
      if (!accounts.length) {
        db.run('DELETE FROM oauth_states WHERE state = ?', row.state);
        throw new HttpError(400, provider.startsWith('instagram')
          ? 'No Instagram professional account found. Make sure it is a Business/Creator account (and, for the Facebook flavour, linked to a Page you manage).'
          : 'No pages/channels were found for this login.');
      }
      if (row.reconnect_id) {
        const existing = integrations.rawGet(row.reconnect_id);
        const match = existing && accounts.find((a) => a.external_id === existing.external_id);
        db.run('DELETE FROM oauth_states WHERE state = ?', row.state);
        if (!match) throw new HttpError(400, 'The account you logged in with does not have access to this page/channel anymore.');
        integrations.upsert(provider, match);
        return { connected: [{ id: row.reconnect_id, name: match.name }] };
      }
      if (opts.autoSelect || accounts.length === 1) {
        db.run('DELETE FROM oauth_states WHERE state = ?', row.state);
        return { connected: accounts.map((a) => ({ id: integrations.upsert(provider, a), name: a.name })) };
      }
      db.run('UPDATE oauth_states SET data_enc = ? WHERE state = ?', cipher.encrypt(JSON.stringify({ ...opts, accounts })), row.state);
      return { select: row.state, accounts: accounts.map((a) => ({ external_id: a.external_id, name: a.name, username: a.username, picture: a.picture })) };
    },

    pending(state) {
      const row = db.get('SELECT * FROM oauth_states WHERE state = ?', String(state || ''));
      if (!row || Date.now() - row.created_at > STATE_TTL) throw new HttpError(404, 'Selection expired; connect again.');
      const d = JSON.parse(cipher.decrypt(row.data_enc) || '{}');
      return { provider: row.provider, accounts: (d.accounts || []).map((a) => ({ external_id: a.external_id, name: a.name, username: a.username, picture: a.picture })) };
    },

    select(state, externalIds) {
      const row = db.get('SELECT * FROM oauth_states WHERE state = ?', String(state || ''));
      if (!row || Date.now() - row.created_at > STATE_TTL) throw new HttpError(404, 'Selection expired; connect again.');
      const d = JSON.parse(cipher.decrypt(row.data_enc) || '{}');
      const chosen = (d.accounts || []).filter((a) => externalIds.includes(a.external_id));
      if (!chosen.length) throw new HttpError(400, 'Select at least one account.');
      db.run('DELETE FROM oauth_states WHERE state = ?', row.state);
      return chosen.map((a) => ({ id: integrations.upsert(row.provider, a), name: a.name }));
    },
  };
}
