// Platform apps: the owner's developer-app credentials (Meta, Instagram Login, Google) managed in the
// UI/API instead of .env. Stored in the settings table with the secret AES-GCM encrypted (TOKEN_ENC_KEY).
// Resolution order per app: saved in DB (both id + secret) → .env → not configured.
// createApps() replaces cfg.meta / cfg.instagram / cfg.google with live getters, so every OAuth start,
// token exchange/refresh and publish reads the current value — no restart needed. Because the DB and
// WebCrypto are async, the saved values are cached in memory: sync() reloads them (each HTTP request,
// cron tick and CLI command calls it; at most once per second) and set()/clear() update the cache.
import { HttpError } from './errors.js';
import { request, qs } from './providers/http.js';
import { providers } from './providers/index.js';

const LINK_META = 'https://developers.facebook.com/apps';
const LINK_GCP = 'https://console.cloud.google.com';

export const APPS = {
  meta: {
    label: 'Meta app (Facebook Pages + Instagram via Facebook Login)',
    guide: '/docs/setup/facebook-and-instagram',
    cfgKey: 'meta', idKey: 'appId', secretKey: 'appSecret', env: ['META_APP_ID', 'META_APP_SECRET'],
    idLabel: 'App ID', secretLabel: 'App Secret',
    providers: ['facebook', 'instagram'],
    idPattern: /^\d{5,25}$/, idHint: 'Meta App IDs are numeric (App settings → Basic).',
    products: ['Facebook Login for Business (or Facebook Login)', 'Use cases: "Manage everything on your Page" and "Manage messaging & content on Instagram"'],
    apis: ['Graph API (Pages API, Instagram Graph API)'],
    links: { 'Meta for Developers – My Apps': LINK_META },
    steps: [
      `Open ${LINK_META} → Create app → type "Business" (or "Other" → "Business").`,
      'Add the product "Facebook Login for Business" (or "Facebook Login") and, for Instagram, the Instagram use case via Facebook Login.',
      'Facebook Login → Settings → "Valid OAuth Redirect URIs": paste BOTH redirect URIs shown here.',
      'App settings → Basic: set Privacy Policy URL and App Domain (your PUBLIC_URL host); copy App ID and App Secret here.',
      'In Development mode only app roles (admins/testers) can connect; request Advanced Access / App Review for the permissions listed before going Live.',
      'Save, press Test, then Accounts → Connect.',
    ],
  },
  instagram: {
    label: 'Instagram app (Instagram Login, no Facebook Page needed)',
    guide: '/docs/setup/instagram-standalone',
    cfgKey: 'instagram', idKey: 'appId', secretKey: 'appSecret', env: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
    idLabel: 'Instagram App ID', secretLabel: 'Instagram App Secret',
    providers: ['instagram-standalone'],
    idPattern: /^\d{5,25}$/, idHint: 'Instagram App IDs are numeric (Instagram → API setup with Instagram login).',
    products: ['Instagram → "API setup with Instagram login" (Instagram API with Instagram Login)'],
    apis: ['Instagram Graph API (graph.instagram.com)'],
    links: { 'Meta for Developers – My Apps': LINK_META },
    steps: [
      `Open ${LINK_META} → Create app (Business) or reuse your Meta app → add the "Instagram" product.`,
      'Instagram → "API setup with Instagram login" → section 3 "Set up Instagram business login" → Business login settings → OAuth redirect URIs: paste the redirect URI shown here.',
      'Copy the "Instagram app ID" and "Instagram app secret" from that page (they differ from the Meta App ID/Secret).',
      'Add your Instagram professional (Business/Creator) account as an Instagram tester under App roles while in Development mode.',
      'Save, press Test, then Accounts → Connect Instagram (Instagram Login).',
    ],
  },
  google: {
    label: 'Google Cloud OAuth client (YouTube)',
    guide: '/docs/setup/youtube',
    cfgKey: 'google', idKey: 'clientId', secretKey: 'clientSecret', env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    idLabel: 'Client ID', secretLabel: 'Client Secret',
    providers: ['youtube'],
    idPattern: /^[\w.-]+\.apps\.googleusercontent\.com$/, idHint: 'Google client IDs end with ".apps.googleusercontent.com".',
    products: ['OAuth consent screen (Google Auth Platform), External, with your Google account as a test user', 'OAuth 2.0 Client ID of type "Web application"'],
    apis: ['YouTube Data API v3', 'YouTube Analytics API'],
    links: {
      'Google Cloud – Credentials': `${LINK_GCP}/apis/credentials`,
      'Enable YouTube Data API v3': `${LINK_GCP}/apis/library/youtube.googleapis.com`,
      'Enable YouTube Analytics API': `${LINK_GCP}/apis/library/youtubeanalytics.googleapis.com`,
      'OAuth consent screen': `${LINK_GCP}/apis/credentials/consent`,
    },
    steps: [
      `Open ${LINK_GCP} → create/select a project.`,
      'APIs & Services → Library: enable "YouTube Data API v3" and "YouTube Analytics API".',
      'OAuth consent screen: User type External; add the scopes listed here; add your Google account under Test users (or publish the app).',
      'Credentials → Create credentials → OAuth client ID → Web application → "Authorized redirect URIs": paste the redirect URI shown here.',
      'Copy the Client ID and Client Secret here, Save, press Test, then Accounts → Connect YouTube.',
      'Publish the app (Audience → In production) to avoid 7-day refresh-token expiry in Testing. If uploads get locked as private, request the YouTube API audit (see the full guide).',
    ],
  },
};

export const APP_IDS = Object.keys(APPS);
export const appForProvider = (provider) => APP_IDS.find((a) => APPS[a].providers.includes(provider)) || null;

const KEY = (app) => `platform_app.${app}`;
const TEST_KEY = (app) => `platform_app.${app}.test`;
const TEST_CODE = 'postlite-credential-test';

export function createApps({ db, cfg, cipher }) {
  // .env values captured once; DB values (when saved) take precedence.
  const envVals = Object.fromEntries(APP_IDS.map((a) => {
    const d = APPS[a];
    const v = cfg[d.cfgKey] || {};
    return [a, { id: String(v[d.idKey] || ''), secret: String(v[d.secretKey] || '') }];
  }));

  // cache: app -> { saved: {id, secret_enc, updated_at} | null, secret: string|null, test: object|null }
  let cache = Object.fromEntries(APP_IDS.map((a) => [a, { saved: null, secret: null, test: null }]));
  let loadedAt = 0;
  let loading = null;

  const parseSaved = (raw) => {
    if (!raw) return null;
    try { const r = JSON.parse(raw); return r.id && r.secret_enc ? r : null; } catch { return null; }
  };

  /** Reload saved credentials from the settings table (decrypting the secrets). */
  async function sync({ maxAgeMs = 1000 } = {}) {
    if (Date.now() - loadedAt < maxAgeMs) return;
    if (loading) return loading;
    loading = (async () => {
      const rows = await db.all("SELECT key, value FROM settings WHERE key LIKE 'platform_app.%'");
      const by = new Map(rows.map((r) => [r.key, r.value]));
      const next = {};
      for (const app of APP_IDS) {
        const saved = parseSaved(by.get(KEY(app)));
        let secret = null;
        if (saved) { try { secret = (await cipher.decrypt(saved.secret_enc)) || ''; } catch { secret = null; /* key changed → fall back to env */ } }
        let test = null;
        try { test = JSON.parse(by.get(TEST_KEY(app)) || 'null'); } catch {}
        next[app] = { saved, secret, test };
      }
      cache = next;
      loadedAt = Date.now();
    })().finally(() => { loading = null; });
    return loading;
  }

  /** Effective credentials { id, secret, source } (synchronous, from the cache). */
  function resolve(app) {
    const c = cache[app];
    if (c.saved && c.secret !== null) return { id: c.saved.id, secret: c.secret, source: 'db' };
    const e = envVals[app];
    if (e.id && e.secret) return { ...e, source: 'env' };
    return { id: '', secret: '', source: 'none' };
  }

  for (const app of APP_IDS) {
    const d = APPS[app];
    Object.defineProperty(cfg, d.cfgKey, {
      configurable: true, enumerable: true,
      get() { const r = resolve(app); return { [d.idKey]: r.id, [d.secretKey]: r.secret }; },
      set() { /* ignore: managed by platform apps */ },
    });
  }

  const check = (app) => {
    if (!APPS[app]) throw new HttpError(400, `Unknown platform app "${app}". Use one of: ${APP_IDS.join(', ')}`);
    return APPS[app];
  };
  const redirectUris = (app) => APPS[app].providers.map((p) => ({ provider: p, label: providers[p].label, uri: `${cfg.publicUrl}/oauth/${p}/callback` }));
  const hint = (secret) => (secret ? `…${secret.slice(-4)}` : null);
  const scrub = (msg, secret) => (secret ? String(msg).split(secret).join('***') : String(msg));

  const api = {
    sync,
    resolve,

    /** Public status — never includes the secret (only its last 4 chars). */
    status(app) {
      const d = check(app);
      const r = resolve(app);
      const s = cache[app].saved;
      const env = envVals[app];
      return {
        app, label: d.label,
        status: r.source === 'db' ? 'configured' : r.source === 'env' ? 'configured_env' : 'not_configured',
        source: r.source,
        configured: r.source !== 'none',
        client_id: r.id || null,
        secret_saved: !!r.secret,
        secret_hint: hint(r.secret),
        saved_in_app: !!s,
        updated_at: s?.updated_at || null,
        env_fallback: !!(env.id && env.secret),
        env_vars: d.env,
        id_label: d.idLabel, secret_label: d.secretLabel, id_hint: d.idHint,
        providers: d.providers,
        redirect_uris: redirectUris(app),
        scopes: [...new Set(d.providers.flatMap((p) => providers[p].scopes))],
        products: d.products, apis: d.apis, steps: d.steps, links: d.links, guide: d.guide,
        last_test: cache[app].test,
      };
    },
    list: () => APP_IDS.map((a) => api.status(a)),

    async set(app, { client_id, client_secret } = {}) {
      const d = check(app);
      const id = String(client_id ?? '').trim();
      const secretIn = client_secret === undefined || client_secret === null ? '' : String(client_secret).trim();
      if (!id) throw new HttpError(400, `${d.idLabel} is required.`);
      if (!d.idPattern.test(id)) throw new HttpError(400, `"${id.slice(0, 80)}" does not look like a valid ${d.idLabel}. ${d.idHint}`);
      if (secretIn && (/\s/.test(secretIn) || secretIn.length < 8 || secretIn.length > 512)) throw new HttpError(400, `${d.secretLabel} looks invalid (8–512 chars, no spaces).`);
      await sync({ maxAgeMs: 0 });
      const prev = cache[app].saved;
      let secret_enc;
      if (secretIn) secret_enc = await cipher.encrypt(secretIn);
      else if (prev) secret_enc = prev.secret_enc; // keep the stored secret when only the id changes
      else throw new HttpError(400, `${d.secretLabel} is required.`);
      const saved = { id, secret_enc, updated_at: Date.now() };
      await db.batch([
        ['INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY(app), JSON.stringify(saved)],
        ['DELETE FROM settings WHERE key = ?', TEST_KEY(app)],
      ]);
      cache[app] = { saved, secret: secretIn || cache[app].secret, test: null };
      return api.status(app);
    },

    async clear(app) {
      check(app);
      await db.run('DELETE FROM settings WHERE key IN (?, ?)', KEY(app), TEST_KEY(app));
      cache[app] = { saved: null, secret: null, test: null };
      return api.status(app);
    },

    /** Validate credentials without a user login. Returns { ok, verified, message }. */
    async test(app) {
      check(app);
      await sync({ maxAgeMs: 0 });
      const r = resolve(app);
      let out;
      if (r.source === 'none') out = { ok: false, verified: false, message: 'Not configured: save the app ID and secret first.' };
      else {
        try { out = await TESTERS[app](cfg, r, redirectUris(app)[0].uri); } catch (e) { out = { ok: false, verified: false, message: `Could not reach the platform: ${e.message}` }; }
        out.message = scrub(out.message, r.secret);
      }
      const rec = { ...out, source: r.source, at: Date.now() };
      await db.setSetting(TEST_KEY(app), JSON.stringify(rec));
      cache[app].test = rec;
      return rec;
    },
  };
  return api;
}

const timeout = (cfg) => ({ timeoutMs: Math.min(cfg.fetchTimeoutMs || 20000, 20000) });
const errText = (e) => {
  try {
    const j = JSON.parse(e.body || '{}');
    return [j.error?.message, j.error_message, typeof j.error === 'string' ? j.error : '', j.error_description].filter(Boolean).join(' — ') || e.message;
  } catch { return e.message; }
};
const errCode = (e) => { try { const j = JSON.parse(e.body || '{}'); return typeof j.error === 'string' ? j.error : j.error?.code ?? j.code; } catch { return null; } };

const TESTERS = {
  // App access token via client_credentials, then GET /app — proves both id and secret.
  async meta(cfg, { id, secret }) {
    const base = `${cfg.urls.graph}/${cfg.graphVersion}`;
    let tok;
    try {
      tok = await request(`${base}/oauth/access_token?` + qs({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }), timeout(cfg));
    } catch (e) {
      if (e.kind === 'transient') throw e;
      return { ok: false, verified: true, message: `Meta rejected the credentials: ${errText(e)}` };
    }
    const appInfo = await request(`${base}/app?` + qs({ fields: 'id,name', access_token: tok.access_token }), timeout(cfg)).catch((e) => ({ _err: errText(e) }));
    if (appInfo._err) return { ok: false, verified: true, message: `Got an app token but GET /app failed: ${appInfo._err}` };
    if (String(appInfo.id) !== String(id)) return { ok: false, verified: true, message: `Token belongs to app ${appInfo.id}, not ${id}.` };
    return { ok: true, verified: true, message: `Credentials valid — app "${appInfo.name || appInfo.id}" (${appInfo.id}).`, app_name: appInfo.name || null };
  },

  // No client_credentials grant for Instagram Login: exchange a dummy code; the API checks the client
  // before the code, so "invalid code" means id+secret were accepted.
  async instagram(cfg, { id, secret }, redirectUri) {
    try {
      await request(`${cfg.urls.igApi}/oauth/access_token`, { form: { client_id: id, client_secret: secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: TEST_CODE }, ...timeout(cfg) });
      return { ok: true, verified: false, message: 'Unexpected success with a dummy code; credentials will be verified on first connect.' };
    } catch (e) {
      if (e.kind === 'transient') throw e;
      const msg = errText(e);
      if (/client|secret|platform app|app id|application/i.test(msg)) return { ok: false, verified: true, message: `Instagram rejected the app credentials: ${msg}` };
      if (/code|redirect/i.test(msg)) return { ok: true, verified: true, message: 'App ID and secret accepted by Instagram (test exchange stopped at the dummy authorization code, as expected).' };
      return { ok: true, verified: false, message: `Could not fully verify (${msg}). Credentials will be verified on first connect.` };
    }
  },

  // Google: token endpoint with a dummy code → invalid_grant means the client authenticated; invalid_client means wrong id/secret.
  async google(cfg, { id, secret }, redirectUri) {
    try {
      await request(`${cfg.urls.googleToken}/token`, { form: { client_id: id, client_secret: secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: TEST_CODE }, ...timeout(cfg) });
      return { ok: true, verified: false, message: 'Unexpected success with a dummy code; credentials will be verified on first connect.' };
    } catch (e) {
      if (e.kind === 'transient') throw e;
      const code = errCode(e);
      if (code === 'invalid_client' || code === 'unauthorized_client') return { ok: false, verified: true, message: `Google rejected the client: ${errText(e)}` };
      if (code === 'invalid_grant') return { ok: true, verified: true, message: 'Client ID and secret accepted by Google. Enabled APIs, consent screen and redirect URI are verified on first connect.' };
      if (code === 'redirect_uri_mismatch') return { ok: false, verified: true, message: `Client accepted, but the redirect URI is not authorized: add ${redirectUri} under Authorized redirect URIs.` };
      return { ok: true, verified: false, message: `Will be verified on first connect (${errText(e)}).` };
    }
  },
};
