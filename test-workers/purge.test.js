// Delete media after publishing on Cloudflare Workers: the cron step purges originals from R2 once every
// post using them is done, keeps the poster/thumbnail, returns 410 for the original /m/ URL, and waits for a
// client-made poster (no ffmpeg on Workers). Real Worker bundle in local workerd (D1 + R2).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, hasWrangler } from './harness.js';
import { makeJpeg, makeMp4 } from '../test/helpers.js';
import { hashPasswordPbkdf2 } from '../src/crypto.js';

const PASSWORD = 'workers purge correct horse';
const skip = !hasWrangler() && 'wrangler devDependency not installed (npm install)';
let w, session, admin, fb, ig;

before(async () => {
  if (skip) return;
  w = await startWorker({ profile: false, vars: { ADMIN_PASSWORD_HASH: await hashPasswordPbkdf2(PASSWORD), MEDIA_PURGE_GRACE_MINUTES: '0', MEDIA_PURGE_INTERVAL_MINUTES: '0' } });
  const r1 = await fetch(`${w.base}/login`);
  const csrfCookie = /pl_lcsrf=([^;]+)/.exec(r1.headers.get('set-cookie'))[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await r1.text())[1];
  const r2 = await fetch(`${w.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `pl_lcsrf=${csrfCookie}`, origin: w.base }, body: new URLSearchParams({ password: PASSWORD, csrf }) });
  const sid = /pl_sid=([^;]+)/.exec(r2.headers.get('set-cookie') || '')[1];
  const s = await (await fetch(`${w.base}/api/v1/session`, { headers: { cookie: `pl_sid=${sid}` } })).json();
  session = { cookie: `pl_sid=${sid}`, csrf: s.csrf };
  admin = (await w.api('POST', '/api-keys', { session, body: { name: 'purge-admin', scopes: ['read', 'write', 'publish', 'admin'], approval_mode: false } })).json.api_key.key;
  const start = await fetch(`${w.base}/oauth/facebook/start`, { redirect: 'manual', headers: { cookie: session.cookie } });
  const cb = (await fetch(start.headers.get('location'), { redirect: 'manual' })).headers.get('location');
  const sel = await fetch(cb, { redirect: 'manual', headers: { cookie: session.cookie } });
  const state = /select\/([\w-]+)/.exec(sel.headers.get('location'))[1];
  await w.api('POST', `/oauth/pending/${state}`, { session, body: { external_ids: ['page1'] } });
  const igStart = await fetch(`${w.base}/oauth/instagram/start`, { redirect: 'manual', headers: { cookie: session.cookie } });
  const igCb = (await fetch(igStart.headers.get('location'), { redirect: 'manual' })).headers.get('location');
  await fetch(igCb, { redirect: 'manual', headers: { cookie: session.cookie } });
  const accts = (await w.api('GET', '/accounts', { key: admin })).json.accounts;
  fb = accts.find((a) => a.provider === 'facebook').id;
  ig = accts.find((a) => a.provider === 'instagram').id;
});
after(async () => { if (w) await w.stop(); });

const upload = async (buf, name, type) => (await w.api('POST', `/media?filename=${name}`, { session, body: buf, raw: true, headers: { 'content-type': type } })).json.media;
const media = async (id) => (await w.api('GET', `/media/${id}`, { key: admin })).json.media;
const post = async (gid) => (await w.api('GET', `/posts/${gid}`, { key: admin })).json.post;

test('Workers cron: shared media is kept while another post is scheduled, then purged from R2; poster stays; 410 on the original', { skip }, async () => {
  const img = await upload(makeJpeg(1080, 1080, 30000), 'cf.jpg', 'image/jpeg');
  assert.equal((await w.api('POST', `/media/${img.id}/poster`, { key: admin, body: { data: makeJpeg(300, 300).toString('base64') } })).status, 200);
  const pub = await w.api('POST', '/posts', { key: admin, body: { content: 'cf purge', media_ids: [img.id], targets: [{ account_id: fb }, { account_id: ig }], mode: 'now' } });
  assert.equal(pub.status, 200, pub.text);
  const later = await w.api('POST', '/posts', { key: admin, body: { content: 'cf later', media_ids: [img.id], targets: [{ account_id: fb }], mode: 'schedule', publish_at: Date.now() + 86400000 } });
  assert.equal(later.status, 200, later.text);
  await w.cronUntil(async () => (await post(pub.json.post.id)).targets.every((t) => t.status === 'published'));
  await w.cron();
  await w.cron();
  assert.equal((await media(img.id)).purged, false, 'a scheduled post still needs it');
  const dry = await w.api('POST', '/storage/cleanup', { key: admin, body: { dry_run: true } });
  assert.equal(dry.json.report.kept.find((k) => k.media_id === img.id).reason, 'used by a scheduled post');
  assert.equal((await w.api('DELETE', `/posts/${later.json.post.id}`, { key: admin })).status, 200);
  await w.cronUntil(async () => (await media(img.id)).purged, { tries: 10 });
  const m = await media(img.id);
  assert.equal(m.url, null);
  assert.equal(m.purged_bytes, img.size);
  assert.equal((await fetch(`${w.base}${img.url}`)).status, 410);
  assert.equal((await fetch(`${w.base}${m.poster}`)).status, 200, 'thumbnail still served from R2');
  const p = await post(pub.json.post.id);
  assert.ok(p.targets.every((t) => t.published_url), 'published links shown instead of the file');
  const st = (await w.api('GET', '/storage', { key: admin })).json.storage;
  assert.ok(st.freed_bytes >= img.size);
  const audit = (await w.api('GET', '/audit-log?limit=50', { key: admin })).json.entries.find((e) => e.operation === 'media_purge');
  assert.ok(audit && audit.detail.files >= 1 && audit.detail.bytes >= img.size);
});

test('Workers: a video without a poster waits for the browser-made frame; Never mode keeps everything', { skip }, async () => {
  const v = await upload(makeMp4({ seconds: 8, mdatBytes: 200000 }), 'cf.mp4', 'video/mp4');
  const g = await w.api('POST', '/posts', { key: admin, body: { content: 'cf video', media_ids: [v.id], targets: [{ account_id: fb }], mode: 'now' } });
  await w.cronUntil(async () => (await post(g.json.post.id)).targets.every((t) => t.status === 'published'));
  await w.cron();
  const dry = await w.api('POST', '/storage/cleanup', { key: admin, body: { dry_run: true } });
  assert.match(dry.json.report.kept.find((k) => k.media_id === v.id).reason, /waiting for a poster frame/);
  assert.equal((await w.api('PATCH', '/storage', { key: admin, body: { delete_media_after: 'never' } })).status, 200);
  await w.api('POST', `/media/${v.id}/poster`, { key: admin, body: { data: makeJpeg(320, 568).toString('base64') } });
  await w.cron();
  await w.cron();
  assert.equal((await media(v.id)).purged, false, 'Never mode');
  assert.equal((await w.api('PATCH', '/storage', { key: admin, body: { delete_media_after: 'immediate' } })).status, 200);
  const now = await w.api('POST', '/storage/cleanup', { key: admin, body: {} });
  assert.ok(now.json.report.purged.some((x) => x.media_id === v.id), now.text);
  assert.equal((await fetch(`${w.base}${v.url}`, { headers: { range: 'bytes=0-9' } })).status, 410);
});
