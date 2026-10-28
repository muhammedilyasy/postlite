// Cloudflare Zero Trust Access mode: RS256 JWT verification against a fake JWKS, allow-list,
// session mapping, bypass paths, fail-closed config. Password mode is covered by http.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createTestApp, makeJpeg } from './helpers.js';
import { getConfig } from '../src/config.js';
import { createServer } from '../src/http/server.js';
import { validateAuthConfig, normalizeTeamDomain, parseEmails, createAccessVerifier } from '../src/access.js';

const TEAM = 'postlite-test.cloudflareaccess.com';
const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
const OWNER = 'owner@example.com';
const OTHER = 'teammate@example.com';

const keyPair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { current: [] };
let certsHits = 0;
let jwksServer, certsUrl, app;
const k1 = { kid: 'kid-one', ...keyPair() };
const k2 = { kid: 'kid-two', ...keyPair() };
const pub = (k) => ({ ...k.publicKey.export({ format: 'jwk' }), kid: k.kid, alg: 'RS256', use: 'sig' });

function sign(claims = {}, { key = k1, kid = key.kid, alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { aud: [AUD], email: OWNER, exp: now + 600, iat: now, nbf: now, iss: `https://${TEAM}`, type: 'app', identity_nonce: 'x', sub: 'u-1', country: 'IN', ...claims };
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg, kid, typ: 'JWT' })}.${enc(body)}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key.privateKey).toString('base64url')}`;
}

before(async () => {
  jwks.current = [pub(k1)];
  jwksServer = http.createServer((req, res) => {
    certsHits++;
    if (req.url !== '/cdn-cgi/access/certs') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: jwks.current, public_cert: {}, public_certs: [] }));
  });
  await new Promise((r) => jwksServer.listen(0, '127.0.0.1', r));
  certsUrl = `http://127.0.0.1:${jwksServer.address().port}/cdn-cgi/access/certs`;
  app = await createTestApp({ env: { AUTH_MODE: 'cloudflare-access', CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, ALLOWED_EMAILS: `${OTHER.toUpperCase()}, ${OWNER}`, CF_ACCESS_CERTS_URL: certsUrl, CF_ACCESS_JWKS_MIN_REFRESH_MS: '0'} });
});
after(async () => {
  await app.close();
  await new Promise((r) => jwksServer.close(r));
});

const page = (path, token, extra = {}) => fetch(`${app.base}${path}`, { redirect: 'manual', headers: { ...(token ? { 'cf-access-jwt-assertion': token } : {}), ...extra } });

/** Sign in via Access: GET / with a token sets pl_sid; then read the CSRF token from /api/v1/session. */
async function accessLogin(token = sign()) {
  const r = await page('/', token);
  assert.equal(r.status, 200);
  const sid = /pl_sid=([^;]+)/.exec(r.headers.get('set-cookie') || '')?.[1];
  assert.ok(sid, 'session cookie set');
  const cookie = `pl_sid=${sid}; CF_Authorization=${token}`;
  const s = await (await fetch(`${app.base}/api/v1/session`, { headers: { cookie } })).json();
  return { cookie, csrf: s.csrf, sid, session: s };
}

test('valid token: page served, session mapped to the email, audit log records it', async () => {
  const s = await accessLogin();
  assert.equal(s.session.principal.email, OWNER);
  assert.equal(s.session.auth_mode, 'cloudflare-access');
  assert.equal(s.session.logout_url, `${app.base}/cdn-cgi/access/logout`);
  // same identity + existing session => reused, no new cookie
  const again = await page('/', sign(), { cookie: `pl_sid=${s.sid}` });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('set-cookie'), null);
  // CF_Authorization cookie works as a fallback for the header
  assert.equal((await page('/', null, { cookie: `CF_Authorization=${sign()}; pl_sid=${s.sid}` })).status, 200);
  // mutating UI request: CSRF still required, email lands in the audit log
  const noCsrf = await fetch(`${app.base}/api/v1/settings`, { method: 'PATCH', headers: { cookie: s.cookie, 'content-type': 'application/json' }, body: '{"timezone":"UTC"}' });
  assert.equal(noCsrf.status, 403);
  const ok = await app.api('PATCH', '/settings', { session: s, body: { timezone: 'UTC' } });
  assert.equal(ok.status, 200, ok.text);
  const entries = app.core.audit.list({ limit: 20 });
  assert.ok(entries.some((e) => e.operation === 'update_settings' && e.actor_name === OWNER && e.actor_id === OWNER));
  assert.ok(entries.some((e) => e.operation === 'login' && e.actor_name === OWNER));
  // the allow-list is case-insensitive
  const other = await accessLogin(sign({ email: 'TeamMate@Example.com' }));
  assert.equal(other.session.principal.email, OTHER);
});

test('/api/v1 with a session: bound to the Access identity and the Access token lifetime', async () => {
  const s = await accessLogin();
  // CF_Authorization not forwarded (bypass path): the session works while its Access token is unexpired
  assert.equal((await fetch(`${app.base}/api/v1/accounts`, { headers: { cookie: `pl_sid=${s.sid}` } })).status, 200);
  // a token for another email, or an invalid token, is rejected even with a valid session
  assert.equal((await fetch(`${app.base}/api/v1/accounts`, { headers: { cookie: `pl_sid=${s.sid}; CF_Authorization=${sign({ email: OTHER })}` } })).status, 401);
  assert.equal((await fetch(`${app.base}/api/v1/accounts`, { headers: { cookie: `pl_sid=${s.sid}; CF_Authorization=${sign({ aud: ['nope-nope-nope-nope'] })}` } })).status, 401);
  assert.equal((await fetch(`${app.base}/api/v1/accounts`, { headers: { cookie: s.cookie } })).status, 200);
  // once the Access token behind the session has expired, the bare session cookie stops working
  app.core.db.run('UPDATE sessions SET access_exp = ? WHERE email = ?', Date.now() - 3600000, OWNER);
  assert.equal((await fetch(`${app.base}/api/v1/accounts`, { headers: { cookie: `pl_sid=${s.sid}` } })).status, 401);
  // ...until a fresh Access token is seen again
  assert.equal((await fetch(`${app.base}/api/v1/accounts`, { headers: { cookie: s.cookie } })).status, 200);
  assert.equal((await fetch(`${app.base}/api/v1/accounts`, { headers: { cookie: `pl_sid=${s.sid}` } })).status, 200);
  // password-mode sessions (no email) are never accepted in access mode
  const legacy = 'legacy-session-id-0123456789abcdef';
  const crypto2 = await import('node:crypto');
  app.core.db.run('INSERT INTO sessions(id_hash, csrf, created_at, expires_at) VALUES(?,?,?,?)', crypto2.createHash('sha256').update(legacy).digest('hex'), 'c', Date.now(), Date.now() + 86400000);
  assert.equal((await fetch(`${app.base}/api/v1/accounts`, { headers: { cookie: `pl_sid=${legacy}` } })).status, 401);
  // a session for another email is replaced, not reused
  const r = await page('/', sign({ email: OTHER }), { cookie: `pl_sid=${s.sid}` });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') || '', /pl_sid=/);
});

test('rejected tokens: wrong aud, wrong iss, expired, not yet valid, bad signature, alg none, email not allowed, missing', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    'wrong aud': [sign({ aud: ['someone-elses-app-aud-0000000000000000'] }), 401],
    'wrong iss': [sign({ iss: 'https://evil.cloudflareaccess.com' }), 401],
    expired: [sign({ exp: now - 3600, iat: now - 7200, nbf: now - 7200 }), 401],
    'not yet valid': [sign({ nbf: now + 3600 }), 401],
    'bad signature': [`${sign().split('.').slice(0, 2).join('.')}.${sign({ email: OTHER }).split('.')[2]}`, 401],
    'signed by unknown key': [sign({}, { key: { privateKey: keyPair().privateKey }, kid: 'kid-one' }), 401],
    'alg none': [`${Buffer.from('{"alg":"none","kid":"kid-one"}').toString('base64url')}.${sign().split('.')[1]}.`, 401],
    'email not allowed': [sign({ email: 'intruder@example.com' }), 403],
    'no email (service token)': [sign({ email: undefined }), 401],
    'global org token': [sign({ type: 'org' }), 401],
    garbage: ['not-a-jwt', 401],
  };
  for (const [name, [tok, status]] of Object.entries(cases)) {
    const r = await page('/', tok);
    assert.equal(r.status, status, name);
    assert.equal(r.headers.get('set-cookie'), null, `${name}: no session`);
    const html = await r.text();
    if (status === 403) { assert.match(html, /intruder@example\.com/); assert.match(html, /cdn-cgi\/access\/logout/); }
  }
  // clock skew: expired 30 s ago is still accepted (60 s skew)
  assert.equal((await page('/', sign({ exp: now - 30 }))).status, 200);
  // missing token everywhere that is behind Access
  for (const path of ['/', '/login', '/docs/setup/', '/llms.txt', '/oauth/youtube/start', '/oauth/youtube/callback?code=x&state=y', '/nope']) {
    const r = await page(path);
    assert.equal(r.status, 401, path);
    assert.match(await r.text(), /Cloudflare Access/);
  }
  assert.equal((await fetch(`${app.base}/api/v1/accounts`)).status, 401);
});

test('kid rotation: unknown kid triggers a JWKS refresh', async () => {
  await accessLogin(); // primes the cache with kid-one
  const before = certsHits;
  jwks.current = [pub(k1), pub(k2)];
  assert.equal((await page('/', sign({}, { key: k2 }))).status, 200);
  assert.ok(certsHits > before, 'refetched certs');
  jwks.current = [pub(k2)]; // old key retired
  const hits = certsHits;
  assert.equal((await page('/', sign({}, { key: k2 }))).status, 200);
  assert.equal(certsHits, hits, 'known kid served from cache');
  jwks.current = [pub(k1), pub(k2)];
});

test('password login and set-password are disabled; /login redirects into the app; logout goes to Access', async () => {
  const post = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=correct+horse+battery&csrf=x' });
  assert.equal(post.status, 405);
  assert.doesNotMatch(post.headers.get('set-cookie') || '', /pl_sid=/);
  const login = await page('/login', sign());
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/');
  const s = await accessLogin();
  const out = await fetch(`${app.base}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: s.csrf }) });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get('location'), `${app.base}/cdn-cgi/access/logout`);
  assert.equal((await fetch(`${app.base}/api/v1/accounts`, { headers: { cookie: s.cookie } })).status, 401, 'session gone');
});

test('bypass paths work without Access but still enforce their own auth', async () => {
  assert.equal((await fetch(`${app.base}/healthz`)).status, 200);
  // tokenized media: right token 200, wrong token 404
  const m = await app.upload(makeJpeg(100, 100), 'p.jpg');
  assert.equal((await fetch(`${app.base}/m/${m.token}/${m.id}.jpg`)).status, 200);
  assert.equal((await fetch(`${app.base}/m/${'x'.repeat(43)}/${m.id}.jpg`)).status, 404);
  // REST: no Access JWT needed, but an API key is
  assert.equal((await fetch(`${app.base}/api/v1/accounts`)).status, 401);
  assert.equal((await fetch(`${app.base}/api/v1/accounts`, { headers: { 'cf-access-jwt-assertion': sign() } })).status, 401, 'an Access JWT alone is not an API credential');
  const { key } = app.core.apiKeys.create({ name: 'agent', scopes: ['read'] });
  assert.equal((await app.api('GET', '/accounts', { key })).status, 200);
  assert.equal((await app.api('GET', '/accounts', { key: 'pl_abcdefgh_wrongwrongwrongwrongwrong' })).status, 401);
  // OpenAPI + agent docs are public through the /api/v1 bypass
  const spec = await fetch(`${app.base}/api/v1/openapi.json`);
  assert.equal(spec.status, 200);
  assert.ok((await spec.json()).paths);
  assert.equal((await fetch(`${app.base}/api/v1/llms.txt`)).status, 200);
  assert.equal((await fetch(`${app.base}/api/v1/agent-guide.md`)).status, 200);
  // MCP: bearer only
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await fetch(`${app.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': sign() }, body: JSON.stringify(rpc) })).status, 401);
  const ok = await fetch(`${app.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(rpc) });
  assert.equal(ok.status, 200);
  // static UI assets stay reachable (they style the sign-in page)
  assert.equal((await fetch(`${app.base}/assets/app.css`)).status, 200);
});

test('JWKS endpoint down: fail closed with 503, never open', async () => {
  const saved = jwks.current;
  jwks.current = [];
  const r = await page('/', sign({}, { kid: 'kid-unknown-forces-refresh' }));
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('set-cookie'), null);
  jwks.current = saved;
});

test('JWKS fetch has a timeout', async () => {
  const hang = http.createServer(() => {}); // never answers
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, allowedEmails: [OWNER], certsUrl: `http://127.0.0.1:${hang.address().port}/cdn-cgi/access/certs`, timeoutMs: 150 });
  const t0 = Date.now();
  await assert.rejects(v.verify(sign()), (e) => e.code === 'jwks_unavailable' && /timeout/.test(e.message));
  assert.ok(Date.now() - t0 < 2000);
  hang.closeAllConnections();
  await new Promise((r) => hang.close(r));
});

test('fail closed: access mode without team domain, AUD or allow-list refuses to start', () => {
  const base = { TOKEN_ENC_KEY: 'x'.repeat(32), AUTH_MODE: 'cloudflare-access', CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, ALLOWED_EMAILS: OWNER };
  assert.doesNotThrow(() => validateAuthConfig(getConfig(base)));
  assert.throws(() => validateAuthConfig(getConfig({ ...base, CF_ACCESS_TEAM_DOMAIN: '' })), /CF_ACCESS_TEAM_DOMAIN/);
  assert.throws(() => validateAuthConfig(getConfig({ ...base, CF_ACCESS_AUD: '' })), /CF_ACCESS_AUD/);
  assert.throws(() => validateAuthConfig(getConfig({ ...base, ALLOWED_EMAILS: '' })), /ALLOWED_EMAILS/);
  assert.throws(() => validateAuthConfig(getConfig({ ...base, AUTH_MODE: 'cloudflare' })), /AUTH_MODE/);
  assert.throws(() => createServer({ cfg: getConfig({ ...base, CF_ACCESS_AUD: '' }), db: null, log: () => {} }), /Refusing to start/);
  assert.doesNotThrow(() => validateAuthConfig(getConfig({ TOKEN_ENC_KEY: 'x' })), 'password is the default');
  assert.equal(getConfig({}).auth.mode, 'password');
  assert.equal(normalizeTeamDomain('https://MyTeam.cloudflareaccess.com/'), 'myteam.cloudflareaccess.com');
  assert.equal(normalizeTeamDomain('myteam'), 'myteam.cloudflareaccess.com');
  assert.deepEqual(parseEmails(' A@x.com, b@Y.org ;c@z.io'), ['a@x.com', 'b@y.org', 'c@z.io']);
});
