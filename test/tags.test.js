// Tags: CRUD, assign on create/update/set_post_tags, filters for posts, calendar and analytics top posts, isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

let app, key, keyB, fb;

before(async () => {
  app = await createTestApp();
  fb = await app.seed('facebook');
  key = (await app.core.apiKeys.create({ name: 'tags', scopes: ['read', 'write', 'publish', 'analytics'], approval_mode: false, rate_limit_per_min: 5000 })).key;
  const wsB = await app.root.workspaces.create('B');
  keyB = (await app.root.scope(wsB).apiKeys.create({ name: 'b', scopes: ['read', 'write', 'analytics'], approval_mode: false })).key;
});
after(async () => { await app?.close(); });

test('tag CRUD: unique names (case-insensitive), colors, leading # dropped', async () => {
  const a = await app.api('POST', '/tags', { key, body: { name: '#Launch', color: '#22C55E' } });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.tag.name, 'Launch');
  assert.equal(a.json.tag.color, '#22c55e');
  assert.equal((await app.api('POST', '/tags', { key, body: { name: 'launch' } })).status, 409);
  assert.equal((await app.api('POST', '/tags', { key, body: { name: 'x', color: 'red' } })).status, 400);
  const b = await app.api('POST', '/tags', { key, body: { name: 'evergreen' } });
  assert.match(b.json.tag.color, /^#[0-9a-f]{6}$/);
  const u = await app.api('PATCH', '/tags/evergreen', { key, body: { name: 'Evergreen' } });
  assert.equal(u.json.tag.name, 'Evergreen');
});

test('assign tags on create/update, set_post_tags add/remove, duplicate keeps tags', async () => {
  const p = await app.api('POST', '/posts', { key, body: { content: 'launch day', tags: ['Launch', 'new-one'], targets: [{ account_id: fb }], mode: 'schedule', publish_at: Date.now() + 3600000 } });
  assert.equal(p.status, 200, p.text);
  assert.deepEqual(p.json.post.tags.map((t) => t.name), ['Launch', 'new-one']);
  const id = p.json.post.id;
  const u = await app.api('PATCH', `/posts/${id}`, { key, body: { tags: ['Evergreen'] } });
  assert.deepEqual(u.json.post.tags.map((t) => t.name), ['Evergreen']);
  const add = await app.api('PUT', `/posts/${id}/tags`, { key, body: { tags: ['launch'], mode: 'add' } });
  assert.deepEqual(add.json.post.tags.map((t) => t.name), ['Evergreen', 'Launch']);
  const rm = await app.api('PUT', `/posts/${id}/tags`, { key, body: { tags: ['Evergreen'], mode: 'remove' } });
  assert.deepEqual(rm.json.post.tags.map((t) => t.name), ['Launch']);
  const dup = await app.api('POST', `/posts/${id}/duplicate`, { key, body: {} });
  assert.deepEqual(dup.json.post.tags.map((t) => t.name), ['Launch']);
  const list = (await app.api('GET', '/tags', { key })).json.tags;
  assert.equal(list.find((t) => t.name === 'Launch').posts, 2);
});

test('filters: list_posts, get_calendar and get_top_posts by tag', async () => {
  const other = await app.api('POST', '/posts', { key, body: { content: 'untagged', targets: [{ account_id: fb }], mode: 'schedule', publish_at: Date.now() + 7200000 } });
  const tagged = (await app.api('GET', '/posts?tag=launch', { key })).json.posts;
  assert.ok(tagged.length >= 1 && tagged.every((g) => g.tags.some((t) => t.name === 'Launch')));
  assert.ok(!tagged.some((g) => g.id === other.json.post.id));
  const cal = await app.api('GET', `/calendar?from=${Date.now()}&to=${Date.now() + 86400000}&tag=Launch`, { key });
  assert.ok(cal.json.entries.length >= 1);
  assert.ok(!cal.json.entries.some((e) => e.group_id === other.json.post.id));
  // top posts: only postlite posts with the tag
  const pub = await app.api('POST', '/posts', { key, body: { content: 'published launch', tags: ['Launch'], targets: [{ account_id: fb }], mode: 'draft' } });
  const target = pub.json.post.targets[0].id;
  await app.core.db.run("UPDATE posts SET status='published', published_at=?, external_id='ext-tag-1' WHERE id=? AND workspace_id='owner'", Date.now() - 1000, target);
  await app.core.db.run("INSERT INTO remote_posts(workspace_id, integration_id, external_id, post_id, kind, caption, published_at, updated_at) VALUES('owner', ?, 'ext-tag-1', ?, 'post', 'published launch', ?, ?)", fb, target, Date.now() - 1000, Date.now());
  await app.core.db.run("INSERT INTO remote_posts(workspace_id, integration_id, external_id, post_id, kind, caption, published_at, updated_at) VALUES('owner', ?, 'ext-other', NULL, 'post', 'not via postlite', ?, ?)", fb, Date.now() - 1000, Date.now());
  const top = (await app.api('GET', '/analytics/top-posts?tag=Launch', { key })).json.posts;
  assert.deepEqual(top.map((x) => x.external_id), ['ext-tag-1']);
  assert.equal((await app.api('GET', '/analytics/top-posts', { key })).json.posts.length, 2);
  assert.equal((await app.api('GET', '/posts?tag=nope', { key })).json.posts.length, 0);
});

test('delete_tag removes it from posts; isolation: other workspaces never see or use these tags', async () => {
  const bList = await app.api('GET', '/tags', { key: keyB });
  assert.deepEqual(bList.json.tags, []);
  assert.equal((await app.api('PATCH', '/tags/Launch', { key: keyB, body: { name: 'pwned' } })).status, 404);
  const someId = (await app.api('GET', '/tags', { key })).json.tags[0].id;
  assert.equal((await app.api('DELETE', `/tags/${someId}`, { key: keyB })).status, 404);
  assert.equal((await app.api('GET', '/posts?tag=Launch', { key: keyB })).json.posts.length, 0);
  // Bob tagging his own post with Alice's tag id: not found (ids are never shared)
  const fbB = await app.root.scope((await app.root.db.get("SELECT workspace_id FROM api_keys WHERE name = 'b' AND workspace_id IS NOT NULL")).workspace_id).integrations.upsert('facebook', { external_id: 'pageB', name: 'B Page', access_token: 't', refresh_token: 'r' });
  const pb = await app.api('POST', '/posts', { key: keyB, body: { content: 'b', targets: [{ account_id: fbB }], mode: 'draft' } });
  assert.equal((await app.api('PUT', `/posts/${pb.json.post.id}/tags`, { key: keyB, body: { tags: [someId] } })).status, 404);
  assert.equal((await app.api('DELETE', '/tags/Launch', { key })).status, 200);
  const posts = (await app.api('GET', '/posts', { key })).json.posts;
  assert.ok(posts.every((g) => !g.tags.some((t) => t.name === 'Launch')));
});
