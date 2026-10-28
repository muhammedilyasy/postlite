// End-to-end tests of the Cloudflare Workers build: the real Worker bundle in local workerd
// (wrangler dev), local D1 + R2, Cron Triggers fired via /__scheduled, fake Meta/Google platforms.
// Run: npm run test:workers   (needs the wrangler devDependency: npm install)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startWorker, hasWrangler, sleep, cpuSummary } from './harness.js';
import { makeJpeg, makeMp4 } from '../test/helpers.js';
import { hashPasswordPbkdf2 } from '../src/crypto.js';
import { verifySignature } from '../src/webhooks.js';

const PASSWORD = 'workers correct horse battery';
const skip = !hasWrangler() && 'wrangler devDependency not installed (npm install)';
let w, session, admin, agent;
const acct = {};

before(async () => {
  if (skip) return;
  w = await startWorker({
    vars: {
      ADMIN_PASSWORD_HASH: await hashPasswordPbkdf2(PASSWORD),
      UPLOAD_PART_MB: '5',
      YOUTUBE_CHUNK_BYTES: String(1024 * 1024),
      // Small per-invocation budget so a multi-MB YouTube upload must span several cron invocations.
      CF_SUBREQUEST_BUDGET: '16',
      MISSED_GRACE_MINUTES: '0.08',
    },
  });
});

after(async () => {
  if (!w) return;
  const summary = cpuSummary(w.cpu.samples);
  const out = path.join(process.env.CPU_REPORT_DIR || w.dir, '..', 'postlite-workers-cpu.json');
  fs.writeFileSync(out, JSON.stringify({ samples: w.cpu.samples, summary }, null, 2));
  console.log(`\nCPU per invocation (ms, V8 inspector samples):\n${summary.map((s) => `  ${s.label.padEnd(28)} n=${String(s.n).padStart(3)} median=${s.median} p95=${s.p95} max=${s.max}`).join('\n')}\n  report: ${out}`);
  await w.stop();
});

async function login() {
  const r1 = await fetch(`${w.base}/login`);
  const csrfCookie = /pl_lcsrf=([^;]+)/.exec(r1.headers.get('set-cookie'))[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await r1.text())[1];
  const r2 = await w.measure('login (PBKDF2 100k)', () => fetch(`${w.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `pl_lcsrf=${csrfCookie}`, origin: w.base }, body: new URLSearchParams({ password: PASSWORD, csrf }) }));
  const sid = /pl_sid=([^;]+)/.exec(r2.headers.get('set-cookie') || '')?.[1];
  if (!sid) throw new Error(`login failed ${r2.status}: ${/notice error[^>]*>([^<]*)/.exec(await r2.text())?.[1]}`);
  const s = await (await fetch(`${w.base}/api/v1/session`, { headers: { cookie: `pl_sid=${sid}` } })).json();
  return { cookie: `pl_sid=${sid}`, csrf: s.csrf, info: s };
}

const posts = (gid) => w.api('GET', `/posts/${gid}`, { key: admin }).then((r) => r.json.post);

test('health, static assets from the assets binding, password login (PBKDF2) on Workers', { skip }, async () => {
  const h = await (await fetch(`${w.base}/healthz`)).json();
  assert.equal(h.runtime, 'workers');
  const css = await fetch(`${w.base}/assets/app.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${w.base}/assets/shared/validate.js`)).status, 200);
  assert.equal((await fetch(`${w.base}/_internal/index.html`)).status, 404, 'internal templates are not public');
  const bad = await fetch(`${w.base}/`, { redirect: 'manual' });
  assert.equal(bad.status, 303);
  session = await login();
  assert.equal(session.info.runtime, 'workers');
  const page = await fetch(`${w.base}/`, { headers: { cookie: session.cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /r2\.cloudflarestorage\.com/);
  const guide = await fetch(`${w.base}/docs/setup/cloudflare-workers`);
  assert.equal(guide.status, 200);
  assert.match(await guide.text(), /Cloudflare Workers/);
});

test('API keys: admin + approval-mode agent key', { skip }, async () => {
  const a = await w.api('POST', '/api-keys', { session, body: { name: 'cf-admin', scopes: ['read', 'write', 'publish', 'analytics', 'admin'], approval_mode: false } });
  assert.equal(a.status, 200, a.text);
  admin = a.json.api_key.key;
  const g = await w.api('POST', '/api-keys', { key: admin, body: { name: 'cf-agent' } });
  agent = g.json.api_key.key;
  assert.equal(g.json.api_key.approval_mode, true);
  const me = await w.api('GET', '/me', { key: agent, label: 'REST GET /me' });
  assert.equal(me.json.runtime, 'workers');
});

async function oauthRoundTrip(provider) {
  const start = await fetch(`${w.base}/oauth/${provider}/start`, { redirect: 'manual', headers: { cookie: session.cookie } });
  assert.equal(start.status, 302, `start ${provider}`);
  const consent = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = consent.headers.get('location');
  assert.ok(cb.startsWith(`${w.base}/oauth/${provider}/callback`), cb);
  return w.measure(`oauth callback`, () => fetch(cb, { redirect: 'manual', headers: { cookie: session.cookie } }));
}

test('connect accounts through the fake OAuth flows (FB page picker, IG, IG standalone, YouTube)', { skip }, async () => {
  const fb = await oauthRoundTrip('facebook');
  assert.equal(fb.status, 302);
  const state = /select\/([\w-]+)/.exec(fb.headers.get('location'))[1];
  const sel = await w.api('POST', `/oauth/pending/${state}`, { session, body: { external_ids: ['page1'] } });
  assert.equal(sel.json.connected.length, 1);
  for (const p of ['instagram', 'instagram-standalone', 'youtube']) {
    const r = await oauthRoundTrip(p);
    assert.equal(r.status, 200, `${p}: ${await r.text()}`);
  }
  const list = (await w.api('GET', '/accounts', { key: admin })).json.accounts;
  for (const a of list) acct[a.provider] = a.id;
  assert.deepEqual(Object.keys(acct).sort(), ['facebook', 'instagram', 'instagram-standalone', 'youtube']);
});

let img1, img2, video;
const VIDEO_BYTES = 12 * 1024 * 1024 + 12345;

test('uploads: raw POST to R2, resumable multipart upload (multi-MB, in parts), upload-from-URL streaming', { skip }, async () => {
  const r1 = await w.api('POST', '/media?filename=a.jpg', { session, body: makeJpeg(1080, 1080, 40000), raw: true, headers: { 'content-type': 'image/jpeg' }, label: 'REST raw upload 40KB' });
  assert.equal(r1.status, 200, r1.text);
  img1 = r1.json.media;
  assert.equal(img1.width, 1080);
  const served = await fetch(`${w.base}${img1.url}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(served.status, 206);
  assert.equal((await served.arrayBuffer()).byteLength, 10);

  const mp4 = makeMp4({ width: 1080, height: 1920, seconds: 42, mdatBytes: VIDEO_BYTES - makeMp4({ mdatBytes: 0 }).length });
  assert.equal(mp4.length, VIDEO_BYTES);
  const s = await w.api('POST', '/media/uploads', { key: admin, body: { filename: 'big.mp4', size: mp4.length }, label: 'REST create_upload' });
  assert.equal(s.status, 200, s.text);
  const up = s.json.upload;
  assert.equal(up.mode, 'proxy');
  assert.equal(up.part_count, 3);
  const parts = [];
  for (const p of up.parts) {
    const start = (p.part_number - 1) * up.part_size;
    const res = await w.measure('upload part (5 MB → R2)', () => fetch(p.url, { method: 'PUT', body: mp4.subarray(start, start + p.size) }));
    const j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j));
    parts.push({ part_number: p.part_number, etag: j.etag });
  }
  const done = await w.api('POST', `/media/uploads/${up.upload_id}/complete`, { key: admin, body: { parts }, label: 'REST complete_upload' });
  assert.equal(done.status, 200, done.text);
  video = done.json.media;
  assert.equal(video.size, VIDEO_BYTES);
  assert.equal(video.kind, 'video');
  assert.equal(video.duration, 42);
  assert.equal(video.width, 1080);
  assert.equal(video.poster, null, 'no ffmpeg poster on Workers');

  const bad = await w.api('PUT', `/media/uploads/${up.upload_id}/parts/1?token=nope`, { body: 'x', raw: true });
  assert.ok([403, 409].includes(bad.status));

  const fromUrl = await w.api('POST', '/media/from-url', { key: admin, body: { url: `${w.base}${img1.url}`, filename: 'copy.jpg' }, label: 'REST upload_media_from_url' });
  assert.equal(fromUrl.status, 200, fromUrl.text);
  img2 = fromUrl.json.media;
  assert.equal(img2.size, img1.size);
});

test('cron publishes FB multi-photo, IG, IG standalone carousel and a chunked YouTube upload across invocations', { skip }, async () => {
  const create = (targets, media, content) => w.api('POST', '/posts', { key: admin, body: { content, media_ids: media, targets, mode: 'now' }, label: 'REST create_post' });
  const fb = await create([{ account_id: acct.facebook }], [img1.id, img2.id], 'cf multi photo');
  const ig = await create([{ account_id: acct.instagram }], [img1.id], 'cf ig');
  const igs = await create([{ account_id: acct['instagram-standalone'] }], [img1.id, img2.id], 'cf carousel');
  const yt = await create([{ account_id: acct.youtube, settings: { title: 'Workers upload', isShort: true } }], [video.id], 'cf yt');
  for (const r of [fb, ig, igs, yt]) assert.equal(r.status, 200, r.text);
  const ids = [fb, ig, igs, yt].map((r) => r.json.post.id);
  let crons = 0;
  await w.cronUntil(async () => { crons++; const all = await Promise.all(ids.map(posts)); return all.every((p) => p.status === 'published' || p.status === 'failed'); }, { label: 'cron publish step' });
  const all = await Promise.all(ids.map(posts));
  for (const p of all) assert.equal(p.status, 'published', JSON.stringify(p.targets[0].error));
  assert.ok(crons >= 3, `YouTube upload spanned several cron invocations (${crons})`);
  const fbPost = w.fake.state.published.find((x) => x.platform === 'facebook' && x.data.message === 'cf multi photo');
  assert.equal(fbPost.data.attached_media.length, 2);
  const upload = Object.values(w.fake.state.uploads).find((u) => u.size === VIDEO_BYTES);
  assert.equal(upload.received, VIDEO_BYTES, 'every byte of the video reached YouTube');
  const ev = (await posts(ids[3])).targets[0];
  assert.match(ev.published_url, /youtube\.com\/watch/);
  assert.ok(w.fake.state.fetchedMedia.some((u) => u.startsWith(`${w.base}/m/`)), 'Meta fetched media from the Worker /m/ route (R2)');
});

test('no double post: concurrent cron invocations race for the same due jobs', { skip }, async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await w.api('POST', '/posts', { key: admin, body: { content: `cf-race-${i}`, targets: [{ account_id: acct.facebook }], mode: 'now' } })).json.post.id);
  await Promise.all(Array.from({ length: 6 }, () => fetch(`${w.base}/__scheduled?cron=*+*+*+*+*`).then((r) => r.text())));
  await w.cronUntil(async () => (await Promise.all(ids.map(posts))).every((p) => p.status === 'published'), { label: 'cron publish step' });
  for (let i = 0; i < 5; i++) assert.equal(w.fake.state.published.filter((p) => p.platform === 'facebook' && p.data.message === `cf-race-${i}`).length, 1, `cf-race-${i} exactly once`);
});

test('transient failures retry with backoff across cron runs', { skip }, async () => {
  w.fake.state.failNext['/page1/feed$'] = { status: 500, body: { error: { message: 'An unexpected error has occurred. Please retry your request later.', code: 2, is_transient: true } }, times: 2 };
  const id = (await w.api('POST', '/posts', { key: admin, body: { content: 'cf-retry', targets: [{ account_id: acct.facebook }], mode: 'now' } })).json.post.id;
  const p = await w.cronUntil(async () => { const x = await posts(id); return x.status === 'published' ? x : null; }, { wait: 120, label: 'cron publish step' });
  assert.equal(p.targets[0].attempts, 2);
  assert.match(p.targets[0].events.map((e) => e.message).join('\n'), /Attempt 2 failed/);
});

test('missed-post grace: a post the cron never reached in time is failed as missed', { skip }, async () => {
  const id = (await w.api('POST', '/posts', { key: admin, body: { content: 'cf-missed', targets: [{ account_id: acct.facebook }], mode: 'schedule', publish_at: Date.now() + 500 } })).json.post.id;
  await sleep(6500);
  await w.cron('cron publish step');
  const p = await posts(id);
  assert.equal(p.status, 'failed');
  assert.match(p.targets[0].error, /Missed/);
});

test('webhooks are delivered (signed) from the cron', { skip }, async () => {
  const got = [];
  const recv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push({ headers: req.headers, body: b }); res.end('ok'); }); });
  await new Promise((r) => recv.listen(0, '127.0.0.1', r));
  const hook = await w.api('POST', '/webhooks', { key: admin, body: { url: `http://127.0.0.1:${recv.address().port}/hook`, events: ['post.published'] } });
  assert.equal(hook.status, 200, hook.text);
  await w.api('POST', '/posts', { key: admin, body: { content: 'cf-hooked', targets: [{ account_id: acct.facebook }], mode: 'now' } });
  await w.cronUntil(async () => got.some((g) => g.body.includes('cf-hooked') || g.headers['x-postlite-event'] === 'post.published'), { label: 'cron publish step' });
  const d = got.find((g) => g.headers['x-postlite-event'] === 'post.published');
  assert.ok(await verifySignature(hook.json.webhook.secret, d.headers['x-postlite-signature'], d.body));
  recv.close();
});

test('analytics sync runs from the cron in chunks and fills account/post metrics', { skip }, async () => {
  await w.cronUntil(async () => {
    const o = (await w.api('GET', '/analytics/overview', { key: admin })).json;
    return o.accounts.every((a) => a.sync?.last_sync_at) ? o : null;
  }, { label: 'cron analytics step' });
  const top = (await w.api('GET', '/analytics/top-posts?limit=50', { key: admin, label: 'REST get_top_posts' })).json.posts;
  assert.ok(top.length > 0);
  const csv = await fetch(`${w.base}/api/v1/analytics/export.csv`, { headers: { authorization: `Bearer ${admin}` } });
  assert.equal(csv.status, 200);
});

test('MCP over Streamable HTTP with an approval-mode key; human approval; cron publishes', { skip }, async () => {
  const rpc = (key, method, params, label) => w.measure(label || `MCP ${method}`, async () => {
    const r = await fetch(`${w.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: r.status, json: await r.json(), session: r.headers.get('mcp-session-id') };
  });
  const init = await rpc(agent, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.ok(init.session);
  const tools = await rpc(agent, 'tools/list', {});
  const names = tools.json.result.tools.map((t) => t.name);
  for (const n of ['create_post', 'create_upload', 'complete_upload', 'list_accounts']) assert.ok(names.includes(n), n);
  const c = await rpc(agent, 'tools/call', { name: 'create_post', arguments: { content: 'cf-mcp-approval', targets: [{ account_id: acct.facebook }], mode: 'now' } }, 'MCP tools/call create_post');
  assert.equal(c.json.result.isError, false, JSON.stringify(c.json));
  const post = c.json.result.structuredContent.post;
  assert.equal(post.status, 'pending_approval');
  const deny = await rpc(agent, 'tools/call', { name: 'approve_post', arguments: { post_id: post.id } });
  assert.equal(deny.json.result.isError, true, 'approval-mode keys cannot approve');
  await w.cron('cron publish step');
  assert.equal((await posts(post.id)).status, 'pending_approval');
  const ok = await w.api('POST', `/posts/${post.id}/approve`, { key: admin, body: {} });
  assert.equal(ok.status, 200, ok.text);
  await w.cronUntil(async () => (await posts(post.id)).status === 'published', { label: 'cron publish step' });
  const unauth = await fetch(`${w.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
});

test('REST parity: OpenAPI, platforms, calendar, base64 cap, audit log', { skip }, async () => {
  const spec = await (await fetch(`${w.base}/api/v1/openapi.json`)).json();
  assert.ok(spec.paths['/media/uploads']);
  const plats = await w.api('GET', '/platforms', { key: admin, label: 'REST list_platforms' });
  assert.equal(plats.json.platforms.length, 4);
  const cal = await w.api('GET', '/calendar', { key: admin, label: 'REST get_calendar' });
  assert.equal(cal.status, 200);
  const list = await w.api('GET', '/posts?limit=50', { key: admin, label: 'REST list_posts (50)' });
  assert.ok(list.json.posts.length >= 10);
  const big = await w.api('POST', '/media/base64', { key: admin, body: { filename: 'x.jpg', data: 'A'.repeat(12 * 1024 * 1024) } });
  assert.equal(big.status, 413);
  const audit = await w.api('GET', '/audit-log?limit=200', { key: admin });
  assert.ok(audit.json.entries.some((e) => e.operation === 'create_post' && e.actor_name === 'cf-agent'));
});
