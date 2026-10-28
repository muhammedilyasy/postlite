// Posts list filters: platform, account, status, date range, media type, created by, search; workspace-scoped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeJpeg, makeMp4 } from './helpers.js';

let app, fb, ig, yt, agentKey, agentKeyId, otherKey;
const ids = {};
before(async () => {
  app = await createTestApp();
  fb = await app.seed('facebook');
  ig = await app.seed('instagram');
  yt = await app.seed('youtube');
  const k = await app.core.apiKeys.create({ name: 'writer-bot', scopes: ['read', 'write'], approval_mode: false });
  agentKey = k.key; agentKeyId = k.id || k.api_key?.id;
  otherKey = (await app.core.apiKeys.create({ name: 'other-bot', scopes: ['read', 'write'], approval_mode: false })).key;
  const img = await app.upload(makeJpeg(1080, 1080), 'a.jpg');
  const img2 = await app.upload(makeJpeg(1080, 1080), 'b.jpg');
  const vid = await app.upload(makeMp4({ seconds: 20 }), 'v.mp4');
  const day = 86400000;
  const save = (input, principal) => app.core.posts.saveGroup({ action: 'schedule', publish_at: Date.now() + day, ...input }, null, principal ? { principal } : {});
  ids.text = await save({ content: 'Plain text update', posts: [{ integration_id: fb }] });
  ids.carousel = await save({ content: 'Two photos', media: [img.id, img2.id], publish_at: Date.now() + 3 * day, posts: [{ integration_id: ig }] });
  ids.story = await save({ content: '', media: [img.id], posts: [{ integration_id: fb, settings: { post_type: 'story' } }] });
  ids.short = await save({ content: 'desc', media: [vid.id], publish_at: Date.now() + 10 * day, posts: [{ integration_id: yt, settings: { title: 'My Short', isShort: true } }] });
  ids.reel = await save({ content: 'reel time', media: [vid.id], posts: [{ integration_id: ig }] });
  ids.image = await save({ content: 'one photo 100%_off', media: [img.id], posts: [{ integration_id: fb }] });
  // created through the REST API with an agent key
  const r = await app.api('POST', '/posts', { key: agentKey, body: { content: 'From the agent', mode: 'draft', targets: [{ account_id: fb }] } });
  assert.ok(r.status < 300, r.text);
  ids.agent = r.json.post.id;
  const r2 = await app.api('POST', '/posts', { key: otherKey, body: { content: 'From the other agent', mode: 'draft', targets: [{ account_id: fb }] } });
  ids.other = r2.json.post.id;
  const keys = await app.core.apiKeys.list();
  agentKeyId = keys.find((x) => x.name === 'writer-bot').id;
});
after(async () => { await app.close(); });

const list = async (qs) => {
  const r = await app.api('GET', `/posts?limit=100&${qs}`, { key: agentKey });
  assert.equal(r.status, 200, r.text);
  return r.json.posts;
};
const idsOf = (posts) => posts.map((p) => p.id).sort();
const want = (...names) => names.map((n) => ids[n]).sort();

test('media_type filter classifies text, image, carousel, story, reel, short', async () => {
  assert.deepEqual(idsOf(await list('media_type=text')), want('text', 'agent', 'other'));
  assert.deepEqual(idsOf(await list('media_type=carousel')), want('carousel'));
  assert.deepEqual(idsOf(await list('media_type=story')), want('story'));
  assert.deepEqual(idsOf(await list('media_type=short')), want('short'));
  assert.deepEqual(idsOf(await list('media_type=reel')), want('reel'));
  assert.deepEqual(idsOf(await list('media_type=image')), want('image'));
  assert.deepEqual(idsOf(await list('media_type=short,reel')), want('short', 'reel'));
});

test('platform / account / status filters; instagram covers both logins', async () => {
  assert.deepEqual(idsOf(await list('platform=instagram')), want('carousel', 'reel'));
  assert.deepEqual(idsOf(await list(`account_id=${yt}`)), want('short'));
  assert.deepEqual(idsOf(await list('platform=youtube,instagram')), want('carousel', 'reel', 'short'));
  assert.deepEqual(idsOf(await list('status=draft')), want('agent', 'other'));
  assert.deepEqual(idsOf(await list('status=draft&platform=youtube')), []);
  const one = (await list('platform=instagram'))[0];
  assert.ok(one.matched_target_ids.length >= 1);
});

test('created_by: human vs any agent vs one API key', async () => {
  assert.deepEqual(idsOf(await list('created_by=agent')), want('agent', 'other'));
  assert.deepEqual(idsOf(await list(`created_by=key:${agentKeyId}`)), want('agent'));
  assert.deepEqual(idsOf(await list('created_by=human')), want('text', 'carousel', 'story', 'short', 'reel', 'image'));
  const bad = await app.api('GET', '/posts?created_by=robots', { key: agentKey });
  assert.equal(bad.status, 400);
});

test('date range and search (LIKE wildcards are literal)', async () => {
  const d = 86400000;
  const from = new Date(Date.now() + 2 * d).toISOString();
  const to = new Date(Date.now() + 5 * d).toISOString();
  assert.deepEqual(idsOf(await list(`from=${from}&to=${to}`)), want('carousel'));
  assert.deepEqual(idsOf(await list('q=my%20short')), want('short'), 'YouTube title');
  assert.deepEqual(idsOf(await list('q=100%25_')), want('image'));
  assert.deepEqual(idsOf(await list('q=o_o')), [], 'underscore is not a wildcard (would match "photo")');
  assert.deepEqual(idsOf(await list('q=test%20page&media_type=text&created_by=human')), want('text'), 'account name');
});

test('filters stay inside the workspace; MCP shares the operation', async () => {
  const w = await app.root.workspaces.forEmail('someone-else@example.com');
  const other = app.root.scope(w.workspace_id);
  const theirKey = (await other.apiKeys.create({ name: 'writer-bot', scopes: ['read'] })).key;
  const r = await app.api('GET', '/posts?created_by=agent&media_type=text', { key: theirKey });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.posts, []);
  const r2 = await app.api('GET', `/posts?account_id=${fb}`, { key: theirKey });
  assert.deepEqual(r2.json.posts, []);
  const m = await (await fetch(`${app.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${agentKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_posts', arguments: { media_type: ['short'], platform: 'youtube' } } }) })).json();
  const out = JSON.parse(m.result.content[0].text);
  assert.deepEqual(out.posts.map((p) => p.id), [ids.short]);
});
