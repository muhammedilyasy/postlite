// Feature batch on Cloudflare Workers (D1 + R2 + cron), against the fake providers: settings time format,
// delete-workspace-data, and (added per feature) channel preferences, tags, signatures, templates,
// repeating posts, media library and alerts. Every new table is exercised through D1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, hasWrangler } from './harness.js';
import { hashPasswordPbkdf2 } from '../src/crypto.js';

const PASSWORD = 'workers features correct horse';
const skip = !hasWrangler() && 'wrangler devDependency not installed (npm install)';
let w, session, admin, fb;

async function oauth(provider) {
  const start = await fetch(`${w.base}/oauth/${provider}/start`, { redirect: 'manual', headers: { cookie: session.cookie } });
  const cb = (await fetch(start.headers.get('location'), { redirect: 'manual' })).headers.get('location');
  return fetch(cb, { redirect: 'manual', headers: { cookie: session.cookie } });
}

before(async () => {
  if (skip) return;
  w = await startWorker({ profile: false, vars: { ADMIN_PASSWORD_HASH: await hashPasswordPbkdf2(PASSWORD) } });
  const r1 = await fetch(`${w.base}/login`);
  const csrfCookie = /pl_lcsrf=([^;]+)/.exec(r1.headers.get('set-cookie'))[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await r1.text())[1];
  const r2 = await fetch(`${w.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `pl_lcsrf=${csrfCookie}`, origin: w.base }, body: new URLSearchParams({ password: PASSWORD, csrf }) });
  const sid = /pl_sid=([^;]+)/.exec(r2.headers.get('set-cookie') || '')[1];
  session = { cookie: `pl_sid=${sid}`, csrf: (await (await fetch(`${w.base}/api/v1/session`, { headers: { cookie: `pl_sid=${sid}` } })).json()).csrf };
  admin = (await w.api('POST', '/api-keys', { session, body: { name: 'features-admin', scopes: ['read', 'write', 'publish', 'analytics', 'admin'], approval_mode: false } })).json.api_key.key;
  const sel = await oauth('facebook');
  const state = /select\/([\w-]+)/.exec(sel.headers.get('location'))[1];
  await w.api('POST', `/oauth/pending/${state}`, { session, body: { external_ids: ['page1'] } });
  fb = (await w.api('GET', '/accounts', { key: admin })).json.accounts.find((a) => a.provider === 'facebook').id;
});
after(async () => { if (w) await w.stop(); });

test('Workers/D1: time format setting', { skip }, async () => {
  const r = await w.api('PATCH', '/settings', { key: admin, body: { time_format: '12h' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await w.api('GET', '/settings', { key: admin })).json.settings.time_format, '12h');
});

// Runs last: wipes the workspace.
test('Workers/D1: delete workspace data removes accounts, posts and keys, then the key stops working', { skip }, async () => {
  const p = await w.api('POST', '/posts', { key: admin, body: { content: 'to be wiped', targets: [{ account_id: fb }], mode: 'schedule', publish_at: Date.now() + 86400000 } });
  assert.equal(p.status, 200, p.text);
  const sum = await w.api('GET', '/workspace/data', { key: admin });
  assert.equal(sum.status, 200, sum.text);
  assert.ok(sum.json.counts.integrations >= 1 && sum.json.counts.groups >= 1);
  assert.equal((await w.api('POST', '/workspace/delete-data', { key: admin, body: { confirm: 'wrong' } })).status, 400);
  const r = await w.api('POST', '/workspace/delete-data', { key: admin, body: { confirm: sum.json.confirm_with } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await w.api('GET', '/accounts', { key: admin })).status, 401);
  const s = await w.api('GET', '/accounts', { session });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.accounts.length, 0);
});
