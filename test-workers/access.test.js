// Cloudflare Access mode on the real Worker (workerd): RS256 JWT verified with WebCrypto against a
// local JWKS endpoint (CF_ACCESS_CERTS_URL), email allow-list, session binding, key rotation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startWorker, hasWrangler } from './harness.js';

const TEAM = 'myteam.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef0123456789abcdef';
const OWNER = 'owner@example.com';
const skip = !hasWrangler() && 'wrangler devDependency not installed (npm install)';
const keyPair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const k1 = { kid: 'kid-one', ...keyPair() };
const k2 = { kid: 'kid-two', ...keyPair() };
const pub = (k) => ({ ...k.publicKey.export({ format: 'jwk' }), kid: k.kid, alg: 'RS256', use: 'sig' });
const jwks = { current: [pub(k1)] };
let w, jwksServer;

function sign(claims = {}, { key = k1 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { aud: [AUD], email: OWNER, exp: now + 600, iat: now, nbf: now, iss: `https://${TEAM}`, type: 'app', sub: 'u-1', ...claims };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', kid: key.kid, typ: 'JWT' })}.${enc(body)}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key.privateKey).toString('base64url')}`;
}

before(async () => {
  if (skip) return;
  jwksServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: jwks.current }));
  });
  await new Promise((r) => jwksServer.listen(0, '127.0.0.1', r));
  w = await startWorker({
    vars: {
      AUTH_MODE: 'cloudflare-access', CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, ALLOWED_EMAILS: OWNER,
      // R2 S3 API credentials → uploads switch to presigned direct-to-R2 mode (fake endpoint; local R2 has no S3 API)
      R2_ACCESS_KEY_ID: 'test-r2-key-id', R2_SECRET_ACCESS_KEY: 'test-r2-secret', R2_BUCKET_NAME: 'postlite-media', R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      CF_ACCESS_CERTS_URL: `http://127.0.0.1:${jwksServer.address().port}/cdn-cgi/access/certs`, CF_ACCESS_JWKS_MIN_REFRESH_MS: '0',
    },
  });
});
after(async () => { await w?.stop(); jwksServer?.close(); });

const page = (p, token, extra = {}) => fetch(`${w.base}${p}`, { redirect: 'manual', headers: { ...(token ? { 'cf-access-jwt-assertion': token } : {}), ...extra } });

test('Access JWT (RS256 via WebCrypto + local JWKS): sign-in, allow-list, forged/expired tokens, key rotation', { skip }, async () => {
  assert.equal((await page('/', null)).status, 401);
  const r = await w.measure('Access sign-in (RS256)', () => page('/', sign()));
  assert.equal(r.status, 200);
  const sid = /pl_sid=([^;]+)/.exec(r.headers.get('set-cookie'))[1];
  const s = await (await fetch(`${w.base}/api/v1/session`, { headers: { cookie: `pl_sid=${sid}; CF_Authorization=${sign()}` } })).json();
  assert.equal(s.principal.email, OWNER);
  assert.equal(s.auth_mode, 'cloudflare-access');
  assert.equal(s.logout_url, `${w.base}/cdn-cgi/access/logout`);
  // CSRF-protected mutation through Access
  const ok = await fetch(`${w.base}/api/v1/settings`, { method: 'PATCH', headers: { cookie: `pl_sid=${sid}`, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: '{"timezone":"UTC"}' });
  assert.equal(ok.status, 200);
  assert.ok([401, 403].includes((await page('/', sign({ email: 'intruder@example.com' }))).status), 'not on the allow-list');
  assert.ok([401, 403].includes((await page('/', sign({ aud: ['other-aud-xxxxxxxxxxxxxxxx'] }))).status), 'wrong audience');
  assert.ok([401, 403].includes((await page('/', sign({ exp: Math.floor(Date.now() / 1000) - 3600 }))).status), 'expired');
  assert.ok([401, 403].includes((await page('/', sign({}, { key: k2 }))).status), 'unknown signer');
  // Access rotates keys: the Worker refetches the JWKS for an unknown kid
  jwks.current = [pub(k1), pub(k2)];
  assert.equal((await page('/', sign({}, { key: k2 }))).status, 200, 'rotated key accepted');
  // machine endpoints stay reachable for Bypass paths
  assert.equal((await fetch(`${w.base}/healthz`)).status, 200);
  assert.equal((await fetch(`${w.base}/api/v1/accounts`)).status, 401);
});

test('presigned mode: with R2 API credentials, create_upload returns SigV4-signed part URLs straight to R2', { skip }, async () => {
  const r = await page('/', sign());
  const sid = /pl_sid=([^;]+)/.exec(r.headers.get('set-cookie'))[1];
  const cookie = `pl_sid=${sid}; CF_Authorization=${sign()}`;
  const s = await (await fetch(`${w.base}/api/v1/session`, { headers: { cookie } })).json();
  const up = await fetch(`${w.base}/api/v1/media/uploads`, { method: 'POST', headers: { cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json', origin: w.base }, body: JSON.stringify({ filename: 'v.mp4', size: 300 * 1024 * 1024 }) });
  const j = await up.json();
  assert.equal(up.status, 200, JSON.stringify(j));
  assert.equal(j.upload.mode, 'presigned');
  assert.ok(j.upload.parts.length >= 2);
  const u = new URL(j.upload.parts[0].url);
  assert.equal(u.origin, 'https://acct.r2.cloudflarestorage.com');
  assert.match(u.pathname, /^\/postlite-media\/uploads\//);
  assert.equal(u.searchParams.get('partNumber'), '1');
  assert.ok(u.searchParams.get('uploadId'));
  assert.equal(u.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.match(u.searchParams.get('X-Amz-Credential'), /^test-r2-key-id\/\d{8}\/auto\/s3\/aws4_request$/);
  assert.match(u.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
});
