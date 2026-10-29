// Brands on Cloudflare Workers (D1): create a brand from connected channels, post to it with brand_id and let
// the cron publish to every channel, filter posts/calendar/analytics by brand, rename and delete.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, hasWrangler } from './harness.js';
import { hashPasswordPbkdf2 } from '../src/crypto.js';

const PASSWORD = 'workers brands correct horse';
const skip = !hasWrangler() && 'wrangler devDependency not installed (npm install)';
let w, session, admin, fb, ig;

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
  admin = (await w.api('POST', '/api-keys', { session, body: { name: 'brands-admin', scopes: ['read', 'write', 'publish', 'analytics', 'admin'], approval_mode: false } })).json.api_key.key;
  const sel = await oauth('facebook');
  const state = /select\/([\w-]+)/.exec(sel.headers.get('location'))[1];
  await w.api('POST', `/oauth/pending/${state}`, { session, body: { external_ids: ['page1'] } });
  await oauth('instagram');
  const accts = (await w.api('GET', '/accounts', { key: admin })).json.accounts;
  fb = accts.find((a) => a.provider === 'facebook').id;
  ig = accts.find((a) => a.provider === 'instagram').id;
});
after(async () => { if (w) await w.stop(); });

test('Workers/D1: brand CRUD, brand_id posting through the cron, brand filters for posts, calendar and analytics', { skip }, async () => {
  const c = await w.api('POST', '/brands', { key: admin, body: { name: 'CF Brand', color: '#22c55e', account_ids: [fb, ig] } });
  assert.equal(c.status, 200, c.text);
  const brand = c.json.brand;
  assert.equal(brand.channels.length, 2);
  assert.equal((await w.api('POST', '/brands', { key: admin, body: { name: 'cf brand' } })).status, 409);
  const acc = (await w.api('GET', '/accounts', { key: admin })).json.accounts;
  assert.ok(acc.every((a) => a.brands.some((b) => b.id === brand.id)));

  const p = await w.api('POST', '/posts', { key: admin, body: { brand_id: 'CF Brand', content: 'cf brand post https://example.com', targets: [{ account_id: fb, settings: { url: 'https://example.com' } }], mode: 'now' } });
  // IG needs media: brand posts are validated per channel like any post
  assert.equal(p.status, 422, p.text);
  assert.match(p.text, /Instagram|media/i);
  await w.api('PUT', `/brands/${brand.id}/channels`, { key: admin, body: { account_ids: [ig], mode: 'remove' } });
  const p2 = await w.api('POST', '/posts', { key: admin, body: { brand_id: brand.id, content: 'cf brand post', mode: 'now' } });
  assert.equal(p2.status, 200, p2.text);
  assert.equal(p2.json.brand.channels, 1);
  await w.cronUntil(async () => (await w.api('GET', `/posts/${p2.json.post.id}`, { key: admin })).json.post.targets.every((t) => t.status === 'published'));

  const listed = (await w.api('GET', `/posts?brand=${encodeURIComponent('CF Brand')}`, { key: admin })).json.posts.map((x) => x.id);
  assert.ok(listed.includes(p2.json.post.id));
  const other = (await w.api('POST', '/brands', { key: admin, body: { name: 'Empty' } })).json.brand;
  assert.deepEqual((await w.api('GET', `/posts?brand=${other.id}`, { key: admin })).json.posts, []);
  const cal = (await w.api('GET', `/calendar?brand=${brand.id}&from=${Date.now() - 86400000}&to=${Date.now() + 86400000}`, { key: admin })).json;
  assert.ok(cal.entries.length >= 1 && cal.entries.every((e) => e.integration_id === fb));
  const ov = (await w.api('GET', `/analytics/overview?brand=${brand.id}`, { key: admin })).json;
  assert.equal(ov.brand.channels, 1);
  assert.equal(ov.accounts.length, 1);
  assert.equal((await w.api('GET', `/analytics/top-posts?brand=${brand.id}`, { key: admin })).status, 200);

  assert.equal((await w.api('PATCH', `/brands/${brand.id}`, { key: admin, body: { name: 'CF Brand 2' } })).json.brand.name, 'CF Brand 2');
  assert.equal((await w.api('DELETE', `/brands/${brand.id}`, { key: admin })).status, 200);
  assert.ok(!(await w.api('GET', '/brands', { key: admin })).json.brands.some((b) => b.id === brand.id));
});
