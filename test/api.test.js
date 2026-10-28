import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeJpeg, makeMp4, waitFor } from './helpers.js';

let app, fb, ig, yt;
before(async () => {
  app = await createTestApp();
  fb = await app.seed('facebook');
  ig = await app.seed('instagram');
  yt = await app.seed('youtube');
  app.core.scheduler.start();
});
after(async () => { await app.close(); });

const key = async (opts) => (await app.core.apiKeys.create({ name: 'test', ...opts })).key;

test('API keys: hashed at rest, bearer auth, revoked keys rejected', async () => {
  const k = await key({ scopes: ['read'] });
  const row = await app.core.db.get('SELECT hash FROM api_keys ORDER BY created_at DESC LIMIT 1 /* ws:system */');
  assert.ok(!row.hash.includes(k.split('_')[2]));
  assert.equal((await app.api('GET', '/accounts', { key: k })).status, 200);
  assert.equal((await app.api('GET', '/accounts', { key: k + 'x' })).status, 401);
  const id = (await app.core.apiKeys.list())[0].id;
  await app.core.apiKeys.revoke(id);
  const r = await app.api('GET', '/accounts', { key: k });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /Bearer/);
});

test('scopes are enforced with helpful messages', async () => {
  const ro = await key({ scopes: ['read'] });
  const r = await app.api('POST', '/posts', { key: ro, body: { content: 'x', targets: [{ account_id: fb }] } });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /"write" scope/);
  const w = await key({ scopes: ['read', 'write'], approval_mode: false });
  const draft = await app.api('POST', '/posts', { key: w, body: { content: 'draft only', targets: [{ account_id: fb }] } });
  assert.equal(draft.status, 200, draft.text);
  assert.equal(draft.json.post.status, 'draft');
  const sch = await app.api('POST', '/posts', { key: w, body: { content: 'x', targets: [{ account_id: fb }], mode: 'now' } });
  assert.equal(sch.status, 403);
  assert.match(sch.json.error.message, /"publish" scope/);
  assert.equal((await app.api('GET', '/analytics/overview', { key: w })).status, 403);
  assert.equal((await app.api('GET', '/api-keys', { key: w })).status, 403);
  assert.equal((await app.api('GET', '/me', { key: w })).json.principal.scopes.join(','), 'read,write');
});

test('per-key rate limiting returns 429 + Retry-After', async () => {
  const k = await key({ scopes: ['read'], rate_limit_per_min: 3 });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await app.api('GET', '/me', { key: k })).status);
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
  assert.equal(codes[4], 429);
  const r = await app.api('GET', '/me', { key: k });
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
});

test('input validation errors are actionable', async () => {
  const k = await key({ approval_mode: false });
  const r = await app.api('POST', '/posts', { key: k, body: { content: 'x', targets: [{ account_id: fb }], scheduled_at: 'tomorrow' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /Unknown field "scheduled_at"/);
  const r2 = await app.api('POST', '/posts', { key: k, body: { content: 'no media', targets: [{ account_id: ig }], mode: 'now' } });
  assert.equal(r2.status, 422);
  assert.match(r2.json.error.message, /Test IG \(instagram\): Instagram needs at least one photo or video/);
  const r3 = await app.api('POST', '/posts', { key: k, body: { content: 'x', targets: [{ account_id: yt, settings: { privacy: 'secret' } }] } });
  assert.equal(r3.status, 400);
  assert.match(r3.json.error.message, /privacy must be one of/);
  const r4 = await app.api('POST', '/posts', { key: k, body: { content: 'x', targets: [{ account_id: 'nope' }] } });
  assert.match(r4.json.error.message, /list_accounts/);
});

test('validate_post dry run reports per-platform results', async () => {
  const k = await key({ scopes: ['read', 'write'] });
  const v = await app.upload(makeMp4({ width: 1920, height: 1080, seconds: 30 }), 'land.mp4');
  const r = await app.api('POST', '/posts/validate', { key: k, body: { content: 'Hello', media_ids: [v.id], targets: [{ account_id: yt, settings: { title: 'Landscape', isShort: true } }, { account_id: ig }, { account_id: fb }] } });
  assert.equal(r.status, 200, r.text);
  const by = Object.fromEntries(r.json.results.map((x) => [x.provider, x]));
  assert.match(by.youtube.errors.join(), /vertical/);
  assert.equal(by.instagram.ok, true);
  assert.equal(by.instagram.will_publish, 'Reel');
  assert.equal(by.facebook.will_publish, 'Video post');
  assert.equal(r.json.ok, false);
});

test('full REST flow without approval: upload, schedule, reschedule, publish-now, published', async () => {
  const k = await key({ approval_mode: false });
  const up = await fetch(`${app.base}/api/v1/media`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'x-filename': 'photo.jpg', 'content-type': 'image/jpeg' }, body: makeJpeg(1080, 1080) });
  const media = (await up.json()).media;
  assert.ok(media.public_url.includes('/m/'));
  const create = await app.api('POST', '/posts', { key: k, body: { content: 'API post #api', media_ids: [media.id], targets: [{ account_id: fb }, { account_id: ig, settings: { first_comment: 'nice' } }], mode: 'schedule', publish_at: new Date(Date.now() + 3600000).toISOString() } });
  assert.equal(create.status, 200, create.text);
  const post = create.json.post;
  assert.equal(post.status, 'scheduled');
  const re = await app.api('POST', `/posts/${post.id}/reschedule`, { key: k, body: { publish_at: Date.now() + 7200000 } });
  assert.equal(re.status, 200);
  const list = await app.api('GET', `/posts?status=scheduled&provider=instagram`, { key: k });
  assert.ok(list.json.posts.some((p) => p.id === post.id));
  const now = await app.api('POST', `/posts/${post.id}/publish-now`, { key: k, body: {} });
  assert.equal(now.status, 200, now.text);
  const done = await waitFor(async () => {
    const g = (await app.api('GET', `/posts/${post.id}`, { key: k })).json.post;
    return g.status === 'published' ? g : null;
  });
  assert.ok(done.targets.every((t) => t.published_url));
  assert.ok(done.targets[0].events.length > 0);
  const audit = (await app.api('GET', '/audit-log', { session: await app.login() })).json.entries;
  assert.ok(audit.some((e) => e.operation === 'create_post' && e.actor_type === 'api_key'));
  assert.ok(audit.some((e) => e.operation === 'upload_media' && e.actor_type === 'api_key'));
});

test('approval mode: agent posts wait for a human; approval-mode keys cannot approve or escalate', async () => {
  const agent = await key({ name: 'agent', approval_mode: true, scopes: ['read', 'write', 'publish', 'admin'] });
  const media = await app.upload(makeJpeg(1080, 1080), 'a.jpg');
  const r = await app.api('POST', '/posts', { key: agent, body: { content: 'needs approval', media_ids: [media.id], targets: [{ account_id: ig }], mode: 'now' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.post.status, 'pending_approval');
  assert.match(r.json.note, /approval/);
  const pid = r.json.post.id;
  assert.equal((await app.core.db.get('SELECT COUNT(*) n FROM jobs WHERE post_id = ? /* ws:system */', r.json.post.targets[0].id)).n, 0, 'no job until approved');
  await app.core.scheduler.drain();
  assert.equal((await app.core.posts.getGroup(pid)).status, 'pending_approval');
  const self = await app.api('POST', `/posts/${pid}/approve`, { key: agent, body: {} });
  assert.equal(self.status, 403);
  const esc = await app.api('POST', '/api-keys', { key: agent, body: { name: 'sneaky', approval_mode: false } });
  assert.equal(esc.status, 403);
  const pend = await app.api('GET', '/approvals', { key: agent });
  assert.ok(pend.json.posts.some((p) => p.id === pid));
  // human rejects with a reason, agent edits & resubmits, human approves via UI session
  const s = await app.login();
  const rej = await app.api('POST', `/posts/${pid}/reject`, { session: s, body: { reason: 'Add a call to action' } });
  assert.equal(rej.json.post.status, 'draft');
  assert.match(rej.json.post.approval_note, /call to action/);
  const upd = await app.api('PATCH', `/posts/${pid}`, { key: agent, body: { content: 'needs approval — link in bio!', mode: 'now' } });
  assert.equal(upd.json.post.status, 'pending_approval');
  const ok = await app.api('POST', `/posts/${pid}/approve`, { session: s, body: {} });
  assert.equal(ok.status, 200, ok.text);
  const g = await waitFor(async () => { const x = await app.core.posts.getGroup(pid); return x.status === 'published' ? x : null; });
  assert.equal(g.targets[0].status, 'published');
  // admin key without approval mode can approve too
  const admin = await key({ scopes: ['admin'], approval_mode: false });
  const r2 = await app.api('POST', '/posts', { key: agent, body: { content: 'second', targets: [{ account_id: fb }], mode: 'next_slot' } });
  assert.equal(r2.json.post.status, 'pending_approval');
  const ap = await app.api('POST', `/posts/${r2.json.post.id}/approve`, { key: admin, body: {} });
  assert.equal(ap.status, 200);
  assert.equal(ap.json.post.status, 'scheduled');
});

test('slots, settings, duplicate, delete, calendar, platforms, openapi', async () => {
  const k = await key({ approval_mode: false, scopes: ['read', 'write', 'publish', 'admin'] });
  const set = await app.api('PATCH', '/settings', { key: k, body: { timezone: 'Asia/Kolkata', posting_slots: { mon: ['09:00'], tue: ['09:00'], wed: ['09:00'], thu: ['09:00'], fri: ['09:00'], sat: [], sun: [] } } });
  assert.equal(set.status, 200, set.text);
  const bad = await app.api('PATCH', '/settings', { key: k, body: { posting_slots: { monday: ['9'] } } });
  assert.match(bad.json.error.message, /Unknown weekday/);
  const slots = await app.api('GET', '/slots?count=3', { key: k });
  assert.equal(slots.json.slots.length, 3);
  assert.ok(slots.json.slots.every((s) => s.local.endsWith('09:00')));
  const c = await app.api('POST', '/posts', { key: k, body: { content: 'slot post', targets: [{ account_id: fb }], mode: 'next_slot' } });
  assert.equal(c.json.post.publish_at, slots.json.slots[0].epoch_ms);
  const slots2 = await app.api('GET', '/slots?count=1', { key: k });
  assert.equal(slots2.json.slots[0].epoch_ms, slots.json.slots[1].epoch_ms, 'taken slot skipped');
  const dup = await app.api('POST', `/posts/${c.json.post.id}/duplicate`, { key: k, body: {} });
  assert.equal(dup.json.post.status, 'draft');
  const cal = await app.api('GET', `/calendar?from=${Date.now()}&to=${Date.now() + 14 * 86400000}`, { key: k });
  assert.ok(cal.json.entries.some((e) => e.group_id === c.json.post.id));
  assert.equal((await app.api('DELETE', `/posts/${dup.json.post.id}`, { key: k })).status, 200);
  assert.equal((await app.api('GET', `/posts/${dup.json.post.id}`, { key: k })).status, 404);
  const pl = await app.api('GET', '/platforms', { key: k });
  assert.equal(pl.json.platforms.length, 4);
  assert.ok(pl.json.platforms.find((p) => p.provider === 'youtube').settings_schema.properties.isShort);
  const spec = await (await fetch(`${app.base}/api/v1/openapi.json`)).json();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/api/v1/posts'].post.requestBody);
  assert.ok(Object.keys(spec.paths).length > 30);
});

test('media from URL (SSRF guard can be disabled for local tests) and base64', async () => {
  const k = await key({ approval_mode: false });
  const src = await app.upload(makeJpeg(500, 500), 'src.jpg');
  const r = await app.api('POST', '/media/from-url', { key: k, body: { url: app.core.media.publicUrl(src) } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.media.width, 500);
  const b = await app.api('POST', '/media/base64', { key: k, body: { filename: 'b.jpg', data: makeJpeg(10, 20).toString('base64') } });
  assert.equal(b.json.media.height, 20);
  app.cfg.allowPrivateMediaUrls = false;
  const blocked = await app.api('POST', '/media/from-url', { key: k, body: { url: 'http://127.0.0.1:1/x.jpg' } });
  app.cfg.allowPrivateMediaUrls = true;
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.error.message, /private address/);
});

test('connect URL for agents + disconnect', async () => {
  const admin = await key({ scopes: ['admin'], approval_mode: false });
  const r = await app.api('POST', '/accounts/connect', { key: admin, body: { provider: 'facebook' } });
  assert.equal(r.status, 200, r.text);
  // human opens the URL (fake consent auto-approves) → all pages auto-connected
  const consent = await fetch(r.json.url, { redirect: 'manual' });
  const cb = await fetch(consent.headers.get('location'));
  assert.equal(cb.status, 200);
  const pages = (await app.core.integrations.list()).filter((a) => a.provider === 'facebook');
  assert.ok(pages.some((p) => p.external_id === 'page2'));
  const p2 = pages.find((p) => p.external_id === 'page2');
  assert.equal((await app.api('DELETE', `/accounts/${p2.id}`, { key: admin })).status, 200);
  assert.ok(!await app.core.integrations.get(p2.id));
});
