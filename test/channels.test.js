// Channel ⋮ menu: rename (display name), pause publishing without disconnecting, per-channel time slots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, waitFor, makeMp4 } from './helpers.js';
import { formatLocal } from '../src/shared/time.js';

let app, admin, writer, keyB, fb, yt;

before(async () => {
  app = await createTestApp();
  fb = await app.seed('facebook');
  yt = await app.seed('youtube');
  admin = (await app.core.apiKeys.create({ name: 'admin', scopes: ['read', 'write', 'publish', 'analytics', 'admin'], approval_mode: false, rate_limit_per_min: 5000 })).key;
  writer = (await app.core.apiKeys.create({ name: 'writer', scopes: ['read', 'write', 'publish'], approval_mode: false, rate_limit_per_min: 5000 })).key;
  const wsB = await app.root.workspaces.create('B');
  keyB = (await app.root.scope(wsB).apiKeys.create({ name: 'b', scopes: ['read', 'write', 'publish', 'admin'], approval_mode: false })).key;
});
after(async () => { await app?.close(); });

test('rename: display name everywhere, platform name kept, survives a reconnect, null resets', async () => {
  const r = await app.api('PATCH', `/accounts/${fb}`, { key: writer, body: { display_name: '  Tools  ·  FB ' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.account.name, 'Tools · FB');
  assert.equal(r.json.account.platform_name, 'Test Page');
  const p = await app.api('POST', '/posts', { key: writer, body: { content: 'hi', targets: [{ account_id: fb }], mode: 'draft' } });
  assert.equal(p.json.post.targets[0].account_name, 'Tools · FB');
  await app.seed('facebook', { name: 'Test Page renamed on Facebook' }); // reconnect refreshes the platform name only
  const a = (await app.api('GET', `/accounts/${fb}`, { key: writer })).json.account;
  assert.equal(a.name, 'Tools · FB');
  assert.equal(a.platform_name, 'Test Page renamed on Facebook');
  assert.equal((await app.api('PATCH', `/accounts/${fb}`, { key: writer, body: { display_name: null } })).json.account.name, 'Test Page renamed on Facebook');
  assert.equal((await app.api('PATCH', `/accounts/${fb}`, { key: writer, body: { display_name: 'x'.repeat(81) } })).status, 400);
});

test('pause: needs admin, due posts wait (not failed, not published), post-now refused, resume publishes them', async () => {
  assert.equal((await app.api('PATCH', `/accounts/${fb}`, { key: writer, body: { disabled: true } })).status, 403);
  const off = await app.api('PATCH', `/accounts/${fb}`, { key: admin, body: { disabled: true } });
  assert.equal(off.json.account.disabled, true);
  const now = await app.api('POST', '/posts', { key: admin, body: { content: 'now please', targets: [{ account_id: fb }], mode: 'now' } });
  assert.equal(now.status, 422, now.text);
  assert.match(now.text, /paused/);
  const s = await app.api('POST', '/posts', { key: admin, body: { content: 'waits while paused', targets: [{ account_id: fb }], mode: 'schedule', publish_at: Date.now() + 1500 } });
  assert.equal(s.status, 200, s.text);
  const id = s.json.post.id;
  await new Promise((r) => setTimeout(r, 1800));
  await app.core.scheduler.drain(3000);
  await app.core.scheduler.failMissed();
  let g = (await app.api('GET', `/posts/${id}`, { key: admin })).json.post;
  assert.equal(g.targets[0].status, 'scheduled');
  assert.equal(g.targets[0].account_paused, true);
  assert.equal((await app.api('POST', `/posts/${id}/publish-now`, { key: admin, body: {} })).json.results[0].error.includes('paused'), true);
  // brand posting skips paused channels
  await app.api('POST', '/brands', { key: admin, body: { name: 'Both', account_ids: [fb, yt] } });
  const v = await app.api('POST', '/posts/validate', { key: admin, body: { brand_id: 'Both', content: 'x' } });
  assert.deepEqual(v.json.brand.skipped.map((x) => x.reason), ['publishing paused']);
  // resume → publishes right away
  await app.api('PATCH', `/accounts/${fb}`, { key: admin, body: { disabled: false } });
  await app.core.scheduler.drain(5000);
  await waitFor(async () => (await app.core.posts.getGroup(id)).targets[0].status === 'published', { timeout: 8000, interval: 100 });
  g = (await app.api('GET', `/posts/${id}`, { key: admin })).json.post;
  assert.equal(g.targets[0].status, 'published');
});

test('time slots: per-channel slots drive list_free_slots and next_slot; others keep workspace slots', async () => {
  const tz = (await app.core.settings.get()).timezone;
  const days = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, ['07:15']]));
  assert.equal((await app.api('PATCH', `/accounts/${yt}`, { key: writer, body: { posting_slots: { mon: ['25:00'] } } })).status, 400);
  const r = await app.api('PATCH', `/accounts/${yt}`, { key: writer, body: { posting_slots: days } });
  assert.deepEqual(r.json.account.posting_slots.mon, ['07:15']);
  const own = await app.api('GET', `/slots?count=3&account_id=${yt}`, { key: writer });
  assert.equal(own.json.channel_slots, true);
  assert.ok(own.json.slots.every((x) => x.local.endsWith('07:15')), JSON.stringify(own.json.slots));
  const ws = await app.api('GET', `/slots?count=3&account_id=${fb}`, { key: writer });
  assert.equal(ws.json.channel_slots, false);
  const vid = await app.upload(makeMp4(), 'v.mp4');
  const p = await app.api('POST', '/posts', { key: admin, body: { content: 'queue', media_ids: [vid.id], targets: [{ account_id: yt, settings: { title: 'Queued' } }], mode: 'draft' } });
  const q = await app.api('POST', `/posts/${p.json.post.id}/schedule`, { key: admin, body: { next_slot: true } });
  assert.equal(q.status, 200, q.text);
  assert.equal(formatLocal(q.json.post.publish_at, tz).slice(11), '07:15');
  // that slot is now taken for this channel
  const after2 = await app.api('GET', `/slots?count=1&account_id=${yt}`, { key: writer });
  assert.notEqual(after2.json.slots[0].epoch_ms, q.json.post.publish_at);
  assert.equal((await app.api('PATCH', `/accounts/${yt}`, { key: writer, body: { posting_slots: null } })).json.account.posting_slots, null);
});

test('isolation: another workspace cannot rename, pause or read this channel', async () => {
  assert.equal((await app.api('PATCH', `/accounts/${fb}`, { key: keyB, body: { display_name: 'pwned' } })).status, 404);
  assert.equal((await app.api('PATCH', `/accounts/${fb}`, { key: keyB, body: { disabled: true } })).status, 404);
  assert.equal((await app.core.integrations.get(fb)).disabled, false);
  assert.equal((await app.api('GET', `/slots?account_id=${fb}`, { key: keyB })).json.channel_slots, false);
});
