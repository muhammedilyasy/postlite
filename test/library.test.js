// Media library: search/filters/paging, usage, bulk delete that keeps what unfinished posts need, isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeJpeg, makeMp4 } from './helpers.js';

let app, key, keyB, fb, ids;

before(async () => {
  app = await createTestApp();
  fb = await app.seed('facebook');
  key = (await app.core.apiKeys.create({ name: 'lib', scopes: ['read', 'write', 'publish'], approval_mode: false })).key;
  const up = (buf, name) => app.upload(buf, name);
  const a = await up(makeJpeg(1080, 1080), 'beach-sunset.jpg');
  const b = await up(makeJpeg(800, 800), 'logo.jpg');
  const c = await up(makeMp4(), 'teaser.mp4');
  const d = await up(makeJpeg(640, 640), 'old-campaign.jpg');
  const e = await up(makeJpeg(640, 640), 'published-only.jpg');
  ids = { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id };
  await app.core.posts.saveGroup({ content: 'draft uses a', media: [a.id], action: 'draft', posts: [{ integration_id: fb }] });
  const g = await app.core.posts.saveGroup({ content: 'published e', media: [e.id], action: 'draft', posts: [{ integration_id: fb }] });
  await app.core.db.run("UPDATE posts SET status='published', published_at=? WHERE group_id=? AND workspace_id='owner'", Date.now(), g);
  await app.core.db.run("UPDATE media SET purged_at=?, purged_bytes=size WHERE id=? AND workspace_id='owner'", Date.now(), d.id);
  const wsB = await app.root.workspaces.create('B');
  keyB = (await app.root.scope(wsB).apiKeys.create({ name: 'b', scopes: ['read', 'write'], approval_mode: false })).key;
});
after(async () => { await app?.close(); });

test('list_media: newest first with usage, filters, search and paging', async () => {
  const all = await app.api('GET', '/media?counts=true', { key });
  assert.equal(all.status, 200, all.text);
  assert.equal(all.json.total, 5);
  assert.deepEqual(all.json.counts, { all: 5, image: 4, video: 1, document: 0, used: 2, unused: 2, purged: 1 });
  const byId = Object.fromEntries(all.json.media.map((m) => [m.id, m]));
  assert.equal(byId[ids.a].used_by_posts, 1);
  assert.equal(byId[ids.a].in_use, true);
  assert.equal(byId[ids.a].deletable, false);
  assert.equal(byId[ids.e].in_use, false); // only a published post uses it
  assert.equal(byId[ids.e].deletable, true);
  assert.equal(byId[ids.d].purged, true);
  assert.equal(byId[ids.d].url, null);
  assert.equal((await app.api('GET', '/media?kind=video', { key })).json.media.map((m) => m.id).join(), ids.c);
  assert.deepEqual((await app.api('GET', '/media?usage=unused', { key })).json.media.map((m) => m.id).sort(), [ids.b, ids.c].sort());
  assert.deepEqual((await app.api('GET', '/media?usage=used', { key })).json.media.map((m) => m.id).sort(), [ids.a, ids.e].sort());
  assert.deepEqual((await app.api('GET', '/media?usage=purged', { key })).json.media.map((m) => m.id), [ids.d]);
  assert.deepEqual((await app.api('GET', '/media?q=SUNSET', { key })).json.media.map((m) => m.id), [ids.a]);
  const p1 = await app.api('GET', '/media?limit=2&offset=0', { key });
  const p3 = await app.api('GET', '/media?limit=2&offset=4', { key });
  assert.equal(p1.json.media.length, 2);
  assert.equal(p3.json.media.length, 1);
  assert.equal(p3.json.total, 5);
  assert.equal((await app.api('GET', '/media?kind=gif', { key })).status, 400);
});

test('delete_media_bulk deletes unused/published-only media and keeps what drafts need', async () => {
  const r = await app.api('POST', '/media/delete', { key, body: { media_ids: [ids.a, ids.b, ids.e] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.deleted.sort(), [ids.b, ids.e].sort());
  assert.deepEqual(r.json.skipped, [{ media_id: ids.a, reason: 'used by an unpublished post' }]);
  assert.ok(await app.core.media.get(ids.a));
  assert.equal(await app.core.media.get(ids.b), null);
});

test('isolation: another workspace sees none of it and cannot delete it', async () => {
  const b = await app.api('GET', '/media?counts=true', { key: keyB });
  assert.equal(b.json.total, 0);
  assert.equal(b.json.counts.all, 0);
  const d = await app.api('POST', '/media/delete', { key: keyB, body: { media_ids: [ids.c] } });
  assert.deepEqual(d.json.deleted, []);
  assert.equal(d.json.skipped[0].reason, 'not found');
  assert.ok(await app.core.media.get(ids.c));
});
