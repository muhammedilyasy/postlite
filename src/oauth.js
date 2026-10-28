// OAuth connect flow shared by the web UI and the API ("get connect URL" for agents).
import { randomToken, pkcePair } from './crypto.js';
import { getProvider, providers } from './providers/index.js';
import { HttpError } from './errors.js';
import { appForProvider } from './apps.js';

const STATE_TTL = 30 * 60000;

/** Which workspace started this OAuth flow (system lookup; the callback route then checks the caller). */
export async function oauthStateWorkspace(db, state) {
  const row = await db.get('SELECT workspace_id, created_at FROM oauth_states WHERE state = ? /* ws:system */', String(state || ''));
  return row && Date.now() - row.created_at <= STATE_TTL ? row.workspace_id : null;
}

/** OAuth connect flow of ONE workspace: states, pending selections and connected accounts stay in it. */
export function createOAuth(core) {
  const { db, cfg, cipher, integrations, workspaceId: ws } = core;
  if (!ws) throw new Error('createOAuth: workspace id required');
  const redirectUri = (provider) => `${cfg.publicUrl}/oauth/${provider}/callback`;
  const getState = async (state) => {
    const row = await db.get('SELECT * FROM oauth_states WHERE state = ? AND workspace_id = ?', String(state || ''), ws);
    if (!row || Date.now() - row.created_at > STATE_TTL) throw new HttpError(404, 'Selection expired; connect again.');
    return row;
  };
  const del = (state) => db.run('DELETE FROM oauth_states WHERE state = ? AND workspace_id = ?', state, ws);

  return {
    redirectUri,
    available() {
      return Object.values(providers).map((p) => ({ provider: p.id, label: p.label, configured: p.isConfigured(cfg), app: appForProvider(p.id), scopes: p.scopes, redirect_uri: redirectUri(p.id) }));
    },

    async start(provider, { autoSelect = false, reconnectId = null } = {}) {
      const p = providers[provider];
      if (!p) throw new HttpError(400, `Unknown provider "${provider}". Use one of: ${Object.keys(providers).join(', ')}`);
      if (!p.isConfigured(cfg)) throw new HttpError(409, `${p.label} is not configured on this server. Add the developer-app credentials in Settings → Platform apps (or set_platform_app); no restart needed.`, { app: appForProvider(provider) });
      if (reconnectId && !(await integrations.rawGet(reconnectId))) throw new HttpError(404, 'Account to reconnect not found.');
      const state = randomToken(24);
      const pk = await pkcePair();
      await db.batch([
        ['DELETE FROM oauth_states WHERE created_at < ? /* ws:system */', Date.now() - STATE_TTL],
        ['INSERT INTO oauth_states(state, workspace_id, provider, verifier, reconnect_id, data_enc, created_at) VALUES(?,?,?,?,?,?,?)',
          state, ws, provider, pk.verifier, reconnectId, await cipher.encrypt(JSON.stringify({ autoSelect })), Date.now()],
      ]);
      return { url: p.authUrl(cfg, { state, redirectUri: redirectUri(provider), challenge: pk.challenge }), state, expires_in_sec: STATE_TTL / 1000 };
    },

    /** Returns { connected:[...] } or { select: state, accounts:[...] } */
    async callback(provider, { code, state, error, error_description }) {
      const row = await db.get('SELECT * FROM oauth_states WHERE state = ? AND workspace_id = ?', String(state || ''), ws);
      if (!row || row.provider !== provider || Date.now() - row.created_at > STATE_TTL) throw new HttpError(400, 'This connect link is invalid or expired. Start the connection again.');
      if (error) {
        await del(row.state);
        throw new HttpError(400, `Authorization was cancelled or denied: ${error_description || error}`);
      }
      if (!code) throw new HttpError(400, 'Missing authorization code.');
      const opts = JSON.parse((await cipher.decrypt(row.data_enc)) || '{}');
      const p = getProvider(provider);
      let accounts;
      try {
        accounts = await p.exchange(cfg, { code, redirectUri: redirectUri(provider), verifier: row.verifier });
      } catch (e) {
        await del(row.state);
        throw new HttpError(400, `Could not connect: ${e.message}`);
      }
      if (!accounts.length) {
        await del(row.state);
        throw new HttpError(400, provider.startsWith('instagram')
          ? 'No Instagram professional account found. Make sure it is a Business/Creator account (and, for the Facebook flavour, linked to a Page you manage).'
          : provider === 'linkedin-page' ? 'No LinkedIn Pages found where this member is an admin or content admin.'
            : 'No pages/channels were found for this login.');
      }
      if (row.reconnect_id) {
        const existing = await integrations.rawGet(row.reconnect_id);
        const match = existing && accounts.find((a) => a.external_id === existing.external_id);
        await del(row.state);
        if (!match) throw new HttpError(400, 'The account you logged in with does not have access to this page/channel anymore.');
        await integrations.upsert(provider, match);
        return { connected: [{ id: row.reconnect_id, name: match.name }] };
      }
      if (opts.autoSelect || accounts.length === 1) {
        await del(row.state);
        const connected = [];
        for (const a of accounts) connected.push({ id: await integrations.upsert(provider, a), name: a.name });
        return { connected };
      }
      await db.run('UPDATE oauth_states SET data_enc = ? WHERE state = ? AND workspace_id = ?', await cipher.encrypt(JSON.stringify({ ...opts, accounts })), row.state, ws);
      return { select: row.state, accounts: accounts.map((a) => ({ external_id: a.external_id, name: a.name, username: a.username, picture: a.picture })) };
    },

    async pending(state) {
      const row = await getState(state);
      const d = JSON.parse((await cipher.decrypt(row.data_enc)) || '{}');
      return { provider: row.provider, accounts: (d.accounts || []).map((a) => ({ external_id: a.external_id, name: a.name, username: a.username, picture: a.picture })) };
    },

    async select(state, externalIds) {
      const row = await getState(state);
      const d = JSON.parse((await cipher.decrypt(row.data_enc)) || '{}');
      const chosen = (d.accounts || []).filter((a) => externalIds.includes(a.external_id));
      if (!chosen.length) throw new HttpError(400, 'Select at least one account.');
      await del(row.state);
      const out = [];
      for (const a of chosen) out.push({ id: await integrations.upsert(row.provider, a), name: a.name });
      return out;
    },
  };
}
