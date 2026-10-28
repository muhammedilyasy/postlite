import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeJpeg, PASSWORD, waitFor } from './helpers.js';

let app;
before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

test('login: wrong password rejected, CSRF required, session cookie flags', async () => {
  const r1 = await fetch(`${app.base}/login`);
  const cookie = /pl_lcsrf=([^;]+)/.exec(r1.headers.get('set-cookie'))[1];
  assert.match(r1.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const html = await r1.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const bad = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `pl_lcsrf=${cookie}` }, body: new URLSearchParams({ password: 'wrong', csrf }) });
  assert.equal(bad.status, 401);
  const noCsrf = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `pl_lcsrf=${cookie}` }, body: new URLSearchParams({ password: PASSWORD, csrf: 'forged' }) });
  assert.equal(noCsrf.status, 401);
  const ok = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `pl_lcsrf=${cookie}` }, body: new URLSearchParams({ password: PASSWORD, csrf }) });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get('set-cookie'), /pl_sid=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
});

test('app shell and API require a session; mutations require CSRF header', async () => {
  const r = await fetch(`${app.base}/`, { redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal((await app.api('GET', '/accounts')).status, 401);
  const s = await app.login();
  assert.equal((await app.api('GET', '/accounts', { session: s })).status, 200);
  const noCsrf = await fetch(`${app.base}/api/v1/settings`, { method: 'PATCH', headers: { cookie: s.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ timezone: 'UTC' }) });
  assert.equal(noCsrf.status, 403);
  const badOrigin = await fetch(`${app.base}/api/v1/settings`, { method: 'PATCH', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ timezone: 'UTC' }) });
  assert.equal(badOrigin.status, 403);
  const ok = await app.api('PATCH', '/settings', { session: s, body: { timezone: 'Europe/Berlin' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.settings.timezone, 'Europe/Berlin');
  const sess = await app.api('GET', '/session', { session: s });
  assert.equal(sess.json.auth_mode, 'password');
  assert.equal(sess.json.logout_url, '/login');
  assert.equal(sess.json.principal.name, 'admin (web UI)');
  // password mode ignores Access headers entirely: no session => still redirected to /login
  assert.equal((await fetch(`${app.base}/`, { redirect: 'manual', headers: { 'cf-access-jwt-assertion': 'x.y.z' } })).status, 303);
  const shell = await fetch(`${app.base}/`, { headers: { cookie: s.cookie } });
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /default-src 'self'/);
});

test('public media URLs: unguessable token, wrong token 404, Range support', async () => {
  const m = await app.upload(makeJpeg(100, 100, 5000), 'pic.jpg');
  assert.ok(m.token.length >= 40);
  const url = app.core.media.publicUrl(m);
  assert.match(url, new RegExp(`/m/${m.token}/${m.id}\\.jpg$`));
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/jpeg');
  assert.equal((await full.arrayBuffer()).byteLength, m.size);
  const part = await fetch(url, { headers: { range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${m.size}`);
  assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal((await fetch(url.replace(m.token, 'x'.repeat(43)))).status, 404);
  assert.equal((await fetch(`${app.base}/m/${m.token}/other.jpg`)).status, 404);
});

test('raw upload via API rejects unsupported types', async () => {
  const s = await app.login();
  const res = await fetch(`${app.base}/api/v1/media?filename=x.txt`, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' }, body: 'just text' });
  assert.equal(res.status, 415);
  const ok = await fetch(`${app.base}/api/v1/media?filename=x.jpg`, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'image/jpeg' }, body: makeJpeg(640, 480) });
  const j = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(j.media.width, 640);
});

async function oauthRoundTrip(provider, session) {
  const start = await fetch(`${app.base}/oauth/${provider}/start`, { redirect: 'manual', headers: { cookie: session.cookie } });
  assert.equal(start.status, 302, `start ${provider}`);
  const authUrl = start.headers.get('location');
  const consent = await fetch(authUrl, { redirect: 'manual' }); // fake consent screen auto-approves
  const cb = consent.headers.get('location');
  assert.ok(cb.startsWith(`${app.base}/oauth/${provider}/callback`), cb);
  return { authUrl, res: await fetch(cb, { redirect: 'manual', headers: { cookie: session.cookie } }) };
}

test('OAuth: Facebook with page picker (long-lived token exchange + permission check)', async () => {
  const s = await app.login();
  const { authUrl, res } = await oauthRoundTrip('facebook', s);
  assert.match(authUrl, /\/v25\.0\/dialog\/oauth\?/);
  assert.match(decodeURIComponent(authUrl), /pages_manage_posts/);
  assert.equal(res.status, 302);
  const state = /select\/([\w-]+)/.exec(res.headers.get('location'))[1];
  const pending = await app.api('GET', `/oauth/pending/${state}`, { session: s });
  assert.deepEqual(pending.json.accounts.map((a) => a.external_id), ['page1', 'page2']);
  assert.ok(!JSON.stringify(pending.json).includes('page1-token'), 'tokens never leave the server');
  const sel = await app.api('POST', `/oauth/pending/${state}`, { session: s, body: { external_ids: ['page1'] } });
  assert.equal(sel.json.connected.length, 1);
  assert.ok(app.fake.state.calls.some((c) => c.query.grant_type === 'fb_exchange_token'));
  const row = await app.core.db.get("SELECT * FROM integrations WHERE provider='facebook' AND external_id='page1' /* ws:system */");
  assert.ok(row.access_token_enc.startsWith('v1:') && !row.access_token_enc.includes('page1-token'), 'token encrypted at rest');
});

test('OAuth: missing permissions are reported', async () => {
  const s = await app.login();
  app.fake.state.missingPermissions = ['pages_manage_posts'];
  const { res } = await oauthRoundTrip('facebook', s);
  app.fake.state.missingPermissions = [];
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Missing permissions: pages_manage_posts/);
});

test('OAuth: Instagram via Facebook (single linked account auto-connects)', async () => {
  const s = await app.login();
  const { res } = await oauthRoundTrip('instagram', s);
  assert.equal(res.status, 200);
  const a = (await app.core.integrations.list()).find((x) => x.provider === 'instagram' && x.external_id === 'ig1');
  assert.equal(a.username, 'testig');
  assert.equal(a.meta.page_id, 'page1');
});

test('OAuth: Instagram standalone (Instagram Login) + token refresh', async () => {
  const s = await app.login();
  const { authUrl, res } = await oauthRoundTrip('instagram-standalone', s);
  assert.match(authUrl, /igwww\/oauth\/authorize/);
  assert.equal(res.status, 200);
  const a = (await app.core.integrations.list()).find((x) => x.provider === 'instagram-standalone');
  assert.equal(a.external_id, 'igs1');
  assert.equal((await app.core.integrations.secret(a.id)).access_token, 'ig-long');
  await app.core.integrations.refresh(a.id);
  assert.equal((await app.core.integrations.secret(a.id)).access_token, 'ig-long-2');
});

test('OAuth: YouTube (offline access, PKCE, scope check, refresh token stored)', async () => {
  const s = await app.login();
  const { authUrl, res } = await oauthRoundTrip('youtube', s);
  const u = new URL(authUrl);
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(res.status, 200);
  const a = (await app.core.integrations.list()).find((x) => x.provider === 'youtube');
  assert.equal(a.name, 'Test Channel');
  const tokenCall = app.fake.state.calls.find((c) => c.path === '/gtoken/token' && c.body.grant_type === 'authorization_code');
  assert.ok(tokenCall.body.code_verifier);
  assert.equal((await app.core.integrations.secret(a.id)).refresh_token, '1//refresh');
});

test('OAuth: invalid state is rejected', async () => {
  const r = await fetch(`${app.base}/oauth/facebook/callback?code=x&state=forged`);
  assert.equal(r.status, 400);
});

test('token health check marks revoked accounts', async () => {
  const id = await app.seed('facebook', { external_id: 'page2', name: 'Second Page', access_token: 'page2-token' });
  app.fake.state.revoked.add('page2-token');
  const r = await app.core.integrations.check(id);
  app.fake.state.revoked.delete('page2-token');
  assert.equal(r.ok, false);
  assert.equal((await app.core.integrations.get(id)).status, 'needs_reconnect');
});

test('app shell: content-hashed asset URLs, import map allowed by CSP hash, modulepreload, immutable ?v= assets', async () => {
  const s = await app.login();
  const r = await fetch(`${app.base}/`, { headers: { cookie: s.cookie } });
  const html = await r.text();
  const v = /app\.js\?v=([0-9a-f]{12})/.exec(html)[1];
  const map = /<script type="importmap">([^<]+)<\/script>/.exec(html)[1];
  assert.equal(JSON.parse(map).imports['/assets/js/core.js'], `/assets/js/core.js?v=${v}`);
  assert.equal(JSON.parse(map).imports['/assets/shared/time.js'], `/assets/shared/time.js?v=${v}`);
  const { createHash } = await import('node:crypto');
  assert.ok(r.headers.get('content-security-policy').includes(`'sha256-${createHash('sha256').update(map).digest('base64')}'`));
  assert.match(html, /<link rel="modulepreload" href="\/assets\/js\/apps\.js\?v=/);
  assert.match(html, /app\.css\?v=/);
  const a = await fetch(`${app.base}/assets/js/core.js?v=${v}`);
  assert.match(a.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${app.base}/assets/js/core.js`)).headers.get('cache-control'), 'no-cache');
});

test('resumable multipart upload sessions on Node (REST parts + CLI remote upload helper)', async () => {
  const { makeMp4 } = await import('./helpers.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const key = (await app.api('POST', '/api-keys', { session: await app.login(), body: { name: 'mp', scopes: ['read', 'write'], approval_mode: false } })).json.api_key.key;
  const mp4 = makeMp4({ width: 720, height: 1280, seconds: 9, mdatBytes: 6 * 1024 * 1024 });
  const s = await app.api('POST', '/media/uploads', { key, body: { filename: 'clip.mp4', size: mp4.length } });
  assert.equal(s.status, 200, s.text);
  const up = s.json.upload;
  assert.equal(up.mode, 'proxy');
  assert.equal(up.part_count, 1); // 50 MB default parts
  const res = await fetch(up.parts[0].url, { method: 'PUT', body: mp4 });
  const { etag } = await res.json();
  assert.equal(res.status, 200);
  const status = await app.api('GET', `/media/uploads/${up.upload_id}`, { key });
  assert.equal(status.json.upload.state, 'open');
  const done = await app.api('POST', `/media/uploads/${up.upload_id}/complete`, { key, body: { parts: [{ part_number: 1, etag }] } });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.media.size, mp4.length);
  assert.equal(done.json.media.duration, 9);
  assert.equal((await app.api('POST', `/media/uploads/${up.upload_id}/complete`, { key, body: { parts: [{ part_number: 1, etag }] } })).status, 409);
  // CLI helper used by `postlite media upload` (local or remote instance, Node or Workers)
  const { uploadFileRemote } = await import('../src/node/remote.js');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), 'v.mp4');
  fs.writeFileSync(f, mp4);
  const j = await uploadFileRemote({ url: app.base, key, file: f, filename: 'v.mp4' });
  assert.equal(j.media.size, mp4.length);
  const served = await fetch(`${app.base}${j.media.url}`, { headers: { range: 'bytes=0-15' } });
  assert.equal(served.status, 206);
});
