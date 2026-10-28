// Platform apps: developer-app credentials stored encrypted in SQLite, .env fallback, admin-only API,
// secrets never returned, credential Test against the fake providers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { renderMarkdown } from '../src/markdown.js';

let app;
const G_ID = '123456-abcdef.apps.googleusercontent.com';
const G_SECRET = 'GOCSPX-super-secret-value-9876';
const META_ID = '1234567890123';
const META_SECRET = 'meta-db-secret-abcdef123456';

before(async () => {
  // Google has no .env credentials here; Meta and Instagram come from .env (helpers).
  app = await createTestApp({ env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } });
});
after(async () => { await app.close(); });

const key = async (opts) => (await app.core.apiKeys.create({ name: 'apps-test', ...opts })).key;
const statusOf = (list, id) => list.find((a) => a.app === id);

test('status: env fallback vs not configured, redirect URIs from PUBLIC_URL, no secrets', async () => {
  const s = await app.login();
  const r = await app.api('GET', '/platform-apps', { session: s });
  assert.equal(r.status, 200, r.text);
  const meta = statusOf(r.json.platform_apps, 'meta');
  const google = statusOf(r.json.platform_apps, 'google');
  assert.equal(meta.status, 'configured_env');
  assert.equal(meta.client_id, 'meta-app');
  assert.equal(meta.secret_hint, '…cret');
  assert.deepEqual(meta.redirect_uris.map((u) => u.uri), [`${app.base}/oauth/facebook/callback`, `${app.base}/oauth/instagram/callback`]);
  assert.ok(meta.scopes.includes('pages_manage_posts') && meta.scopes.includes('instagram_content_publish'));
  assert.equal(google.status, 'not_configured');
  assert.ok(google.apis.includes('YouTube Data API v3'));
  assert.ok(google.guide.startsWith('/docs/setup/'));
  assert.ok(!r.text.includes('meta-secret'), 'secret leaked in list');
  const prov = await app.api('GET', '/oauth/providers', { session: s });
  assert.equal(prov.json.providers.find((p) => p.provider === 'youtube').configured, false);
  assert.equal(prov.json.providers.find((p) => p.provider === 'youtube').app, 'google');
});

test('unconfigured Connect redirects to the Platform apps card instead of failing', async () => {
  const s = await app.login();
  const r = await fetch(`${app.base}/oauth/youtube/start`, { redirect: 'manual', headers: { cookie: s.cookie } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/#/settings/apps/google');
  const k = await key({ scopes: ['admin'], approval_mode: false });
  const api = await app.api('POST', '/accounts/connect', { key: k, body: { provider: 'youtube' } });
  assert.equal(api.status, 409);
  assert.match(api.json.error.message, /Platform apps/);
});

test('save encrypts the secret, takes effect immediately (no restart) and OAuth uses it', async () => {
  const s = await app.login();
  const bad = await app.api('POST', '/platform-apps/google', { session: s, body: { client_id: 'not-a-google-id', client_secret: G_SECRET } });
  assert.equal(bad.status, 400);
  const noSecret = await app.api('POST', '/platform-apps/google', { session: s, body: { client_id: G_ID } });
  assert.equal(noSecret.status, 400);
  const r = await app.api('POST', '/platform-apps/google', { session: s, body: { client_id: G_ID, client_secret: G_SECRET } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.platform_app.status, 'configured');
  assert.equal(r.json.platform_app.secret_hint, '…9876');
  assert.ok(!r.text.includes(G_SECRET));
  // at rest: encrypted, not plaintext
  const raw = (await app.core.db.get("SELECT value FROM workspace_settings WHERE workspace_id = 'owner' AND key = 'platform_app.google'")).value;
  assert.ok(!raw.includes(G_SECRET));
  assert.match(JSON.parse(raw).secret_enc, /^v1:/);
  assert.equal(app.core.cfg.google.clientSecret, G_SECRET); // live getter
  // full YouTube connect with the DB credentials (fake checks client id/secret on code exchange)
  app.fake.state.apps.google = { id: G_ID, secret: G_SECRET };
  const start = await fetch(`${app.base}/oauth/youtube/start`, { redirect: 'manual', headers: { cookie: s.cookie } });
  const authUrl = start.headers.get('location');
  assert.equal(new URL(authUrl).searchParams.get('client_id'), G_ID);
  const cb = (await fetch(authUrl, { redirect: 'manual' })).headers.get('location');
  const done = await fetch(cb, { redirect: 'manual', headers: { cookie: s.cookie } });
  assert.equal(done.status, 200, await done.text());
  assert.ok((await app.core.integrations.list()).some((a) => a.provider === 'youtube'));
  // changing only the id keeps the stored secret
  const r2 = await app.api('POST', '/platform-apps/google', { session: s, body: { client_id: `9${G_ID}` } });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(app.core.cfg.google.clientSecret, G_SECRET);
  await app.api('POST', '/platform-apps/google', { session: s, body: { client_id: G_ID } });
});

test('DB overrides .env; clearing falls back to .env', async () => {
  const s = await app.login();
  assert.equal(app.core.cfg.meta.appId, 'meta-app');
  const r = await app.api('POST', '/platform-apps/meta', { session: s, body: { client_id: META_ID, client_secret: META_SECRET } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.platform_app.source, 'db');
  assert.equal(r.json.platform_app.env_fallback, true);
  assert.equal(app.core.cfg.meta.appId, META_ID);
  assert.equal(app.core.cfg.meta.appSecret, META_SECRET);
  const c = await app.api('DELETE', '/platform-apps/meta', { session: s });
  assert.equal(c.status, 200);
  assert.equal(c.json.platform_app.status, 'configured_env');
  assert.equal(app.core.cfg.meta.appId, 'meta-app');
});

test('Test button: Meta client_credentials + GET /app, Google and Instagram dummy-code checks', async () => {
  const s = await app.login();
  const ok = await app.api('POST', '/platform-apps/meta/test', { session: s, body: {} });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.result.ok, true);
  assert.equal(ok.json.result.verified, true);
  assert.match(ok.json.result.message, /Fake Meta App/);
  assert.equal(ok.json.platform_app.last_test.ok, true);

  await app.api('POST', '/platform-apps/meta', { session: s, body: { client_id: META_ID, client_secret: 'wrong-secret-1234' } });
  app.fake.state.apps.meta = { id: META_ID, secret: META_SECRET };
  const bad = await app.api('POST', '/platform-apps/meta/test', { session: s, body: {} });
  assert.equal(bad.json.result.ok, false);
  assert.match(bad.json.result.message, /client secret/i);
  assert.ok(!bad.text.includes('wrong-secret-1234'));
  await app.api('POST', '/platform-apps/meta', { session: s, body: { client_id: META_ID, client_secret: META_SECRET } });
  assert.equal((await app.api('POST', '/platform-apps/meta/test', { session: s, body: {} })).json.result.ok, true);
  await app.api('DELETE', '/platform-apps/meta', { session: s });
  app.fake.state.apps.meta = { id: 'meta-app', secret: 'meta-secret' };

  const g = await app.api('POST', '/platform-apps/google/test', { session: s, body: {} });
  assert.equal(g.json.result.ok, true, g.text);
  assert.equal(g.json.result.verified, true);
  app.fake.state.apps.google = { id: G_ID, secret: 'other-secret' };
  const g2 = await app.api('POST', '/platform-apps/google/test', { session: s, body: {} });
  assert.equal(g2.json.result.ok, false);
  assert.match(g2.json.result.message, /invalid_client|rejected/);
  app.fake.state.apps.google = { id: G_ID, secret: G_SECRET };

  const ig = await app.api('POST', '/platform-apps/instagram/test', { session: s, body: {} });
  assert.equal(ig.json.result.ok, true, ig.text);
  app.fake.state.apps.instagram = { id: 'ig-app', secret: 'nope' };
  const ig2 = await app.api('POST', '/platform-apps/instagram/test', { session: s, body: {} });
  assert.equal(ig2.json.result.ok, false);
  app.fake.state.apps.instagram = { id: 'ig-app', secret: 'ig-secret' };
});

test('scopes: admin only; approval-mode keys cannot change credentials; audit has no secret', async () => {
  const w = await key({ scopes: ['read', 'write', 'publish', 'analytics'], approval_mode: false });
  assert.equal((await app.api('GET', '/platform-apps', { key: w })).status, 403);
  assert.equal((await app.api('POST', '/platform-apps/meta', { key: w, body: { client_id: META_ID, client_secret: META_SECRET } })).status, 403);
  const appr = await key({ scopes: ['admin'], approval_mode: true });
  assert.equal((await app.api('GET', '/platform-apps', { key: appr })).status, 200);
  const r = await app.api('POST', '/platform-apps/meta', { key: appr, body: { client_id: META_ID, client_secret: META_SECRET } });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /Approval-mode/);
  assert.equal((await app.api('DELETE', '/platform-apps/google', { key: appr })).status, 403);
  const admin = await key({ scopes: ['admin'], approval_mode: false });
  const ok = await app.api('POST', '/platform-apps/instagram', { key: admin, body: { client_id: '987654321', client_secret: 'ig-db-secret-zyx987' } });
  assert.equal(ok.status, 200, ok.text);
  await app.api('DELETE', '/platform-apps/instagram', { key: admin });
  const audit = JSON.stringify(await app.core.audit.list({ limit: 1000 }));
  for (const sec of [G_SECRET, META_SECRET, 'ig-db-secret-zyx987', 'wrong-secret-1234']) assert.ok(!audit.includes(sec), `audit leaked ${sec}`);
  assert.ok((await app.core.audit.list({ limit: 1000 })).some((e) => e.operation === 'set_platform_app' && e.target === 'instagram' && e.detail.client_secret === '[redacted]'));
});

test('MCP: platform app tools exist and never return secrets', async () => {
  const k = await key({ scopes: ['admin'], approval_mode: false });
  const rpc = async (method, params) => (await fetch(`${app.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
  for (const t of ['list_platform_apps', 'set_platform_app', 'clear_platform_app', 'test_platform_app']) assert.ok(tools.includes(t), t);
  const set = await rpc('tools/call', { name: 'set_platform_app', arguments: { app: 'meta', client_id: META_ID, client_secret: META_SECRET } });
  assert.ok(!set.result.isError, JSON.stringify(set));
  const list = await rpc('tools/call', { name: 'list_platform_apps', arguments: {} });
  const txt = JSON.stringify(list);
  assert.ok(txt.includes(META_ID));
  assert.ok(!txt.includes(META_SECRET) && !JSON.stringify(set).includes(META_SECRET));
  await rpc('tools/call', { name: 'clear_platform_app', arguments: { app: 'meta' } });
});

test('setup guides are served as HTML inside the app', async () => {
  const r = await fetch(`${app.base}/docs/setup/youtube`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const html = await r.text();
  assert.match(html, /<h1[^>]*>/);
  assert.match(html, /YouTube Data API v3/);
  assert.equal((await fetch(`${app.base}/docs/setup/`)).status, 200);
  assert.equal((await fetch(`${app.base}/docs/setup/facebook-and-instagram.md`)).status, 200);
  assert.equal((await fetch(`${app.base}/docs/setup/..%2F..%2F.env`)).status, 404);
});

test('markdown renderer escapes HTML and unsafe links', async () => {
  const { html, title } = renderMarkdown('# T <b>\n\nHi <script>alert(1)</script> [x](javascript:alert(1)) [g](youtube.md#a) <https://e.com/x>\n\n| a | b |\n| --- | --- |\n| `<i>` | **c** |\n\n1. one\n   - nested\n2. two');
  assert.equal(title, 'T <b>');
  assert.ok(!html.includes('<script>') && !html.includes('<b>'));
  assert.ok(!/href="javascript/i.test(html));
  assert.match(html, /href="youtube.md#a"/);
  assert.match(html, /<a href="https:\/\/e.com\/x"/);
  assert.match(html, /<td><code>&lt;i&gt;<\/code><\/td>/);
  assert.match(html, /<ol><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ol>/);
});
