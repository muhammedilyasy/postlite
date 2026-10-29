// Brands: named sets of channels (accounts) across platforms. CRUD + channels, brand_id shorthand in
// create_post, brand filters for posts/calendar/analytics (aggregated totals + per-channel breakdown),
// suggestions from shared name prefixes, cascade on disconnect, and workspace isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeJpeg } from './helpers.js';
import { suggestBrands } from '../src/brands.js';
import { aggregateSummaries } from '../src/api/operations.js';

let app, key, readKey, fb, ig, yt, igs;
before(async () => {
  app = await createTestApp();
  fb = await app.seed('facebook', { name: 'North Star Explains' });
  ig = await app.seed('instagram', { name: 'North Star Explains' });
  yt = await app.seed('youtube', { name: 'North Star Explains' });
  igs = await app.seed('instagram-standalone', { name: 'Maple Grove' });
  key = (await app.core.apiKeys.create({ name: 'admin', scopes: ['read', 'write', 'publish', 'analytics', 'admin'], approval_mode: false })).key;
  readKey = (await app.core.apiKeys.create({ name: 'reader', scopes: ['read', 'analytics'], approval_mode: false })).key;
});
after(async () => { await app.close(); });

const call = (method, p, body, k = key) => app.api(method, p, { key: k, body });

test('create / rename / recolor / delete brands; names unique per workspace; write scope required', async () => {
  assert.equal((await call('POST', '/brands', { name: 'Nope' }, readKey)).status, 403);
  const r = await call('POST', '/brands', { name: 'North Star', color: '#3B82F6', account_ids: [fb, ig, yt] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.brand.color, '#3b82f6');
  assert.deepEqual([...r.json.brand.channel_ids].sort(), [fb, ig, yt].sort());
  assert.deepEqual(r.json.brand.providers.sort(), ['facebook', 'instagram', 'youtube']);
  assert.equal((await call('POST', '/brands', { name: 'north star' })).status, 409, 'case-insensitive unique');
  assert.equal((await call('POST', '/brands', { name: 'Bad', color: 'blue' })).status, 400);
  assert.equal((await call('POST', '/brands', { name: 'Bad', account_ids: ['nope'] })).status, 400);
  const tmp = (await call('POST', '/brands', { name: 'Temp' })).json.brand;
  const ren = await call('PATCH', `/brands/${tmp.id}`, { name: 'Temp 2', color: null });
  assert.equal(ren.json.brand.name, 'Temp 2');
  // by name in the path
  assert.equal((await call('PATCH', `/brands/${encodeURIComponent('Temp 2')}`, { color: '#22c55e' })).json.brand.color, '#22c55e');
  assert.equal((await call('DELETE', `/brands/${tmp.id}`)).status, 200);
  assert.equal((await call('GET', '/brands', undefined, readKey)).json.brands.map((b) => b.name).join(), 'North Star');
});

test('channels: replace / add / remove; an account can be in several brands; accounts list shows their brands', async () => {
  const b = (await call('POST', '/brands', { name: 'Maple' })).json.brand;
  let r = await call('PUT', `/brands/${b.id}/channels`, { account_ids: [igs, fb] });
  assert.deepEqual(r.json.brand.channel_ids.sort(), [fb, igs].sort());
  r = await call('PUT', '/brands/Maple/channels', { account_ids: [yt], mode: 'add' });
  assert.equal(r.json.brand.channel_ids.length, 3);
  r = await call('PUT', '/brands/Maple/channels', { account_ids: [fb, yt], mode: 'remove' });
  assert.deepEqual(r.json.brand.channel_ids, [igs]);
  await call('PUT', '/brands/Maple/channels', { account_ids: [fb], mode: 'add' });
  const acc = (await call('GET', '/accounts', undefined, readKey)).json.accounts.find((a) => a.id === fb);
  assert.deepEqual(acc.brands.map((x) => x.name).sort(), ['Maple', 'North Star']);
});

test('create_post with brand_id (id or name) targets every connected channel; skips ones needing reconnect; explicit settings win', async () => {
  const img = await app.upload(makeJpeg(1080, 1080), 'b.jpg');
  await app.core.integrations.markNeedsReconnect(fb, 'expired');
  const r = await call('POST', '/posts', { brand_id: 'North Star', content: 'brand post', media_ids: [img.id], targets: [{ account_id: yt, settings: { title: 'Brand video title' } }], mode: 'draft' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.post.targets.map((t) => t.integration_id).sort(), [ig, yt].sort());
  assert.equal(r.json.post.targets.find((t) => t.integration_id === yt).settings.title, 'Brand video title');
  assert.deepEqual(r.json.brand.skipped.map((s) => s.account_id), [fb]);
  await app.core.db.run("UPDATE integrations SET status = 'active' WHERE id = ? AND workspace_id = 'owner'", fb);
  const v = await call('POST', '/posts/validate', { brand_id: (await call('GET', '/brands')).json.brands.find((b) => b.name === 'North Star').id, content: 'x', media_ids: [img.id] });
  assert.equal(v.json.results.length, 3);
  assert.equal(v.json.brand.channels, 3);
  assert.equal((await call('POST', '/posts', { brand_id: 'Nope', content: 'x' })).status, 404);
  assert.equal((await call('POST', '/posts', { content: 'x' })).status, 400, 'targets or brand_id required');
});

test('list_posts and get_calendar filter by brand', async () => {
  const g1 = (await call('POST', '/posts', { content: 'only maple', targets: [{ account_id: igs }], mode: 'draft' })).json.post;
  const g2 = (await call('POST', '/posts', { content: 'only yt', targets: [{ account_id: yt, settings: { title: 'T' } }], mode: 'draft' })).json.post;
  const maple = (await call('GET', '/posts?brand=Maple&limit=100')).json.posts.map((p) => p.id);
  assert.ok(maple.includes(g1.id));
  assert.ok(!maple.includes(g2.id));
  const u60 = (await call('GET', '/posts?brand=North%20Star&limit=100')).json.posts.map((p) => p.id);
  assert.ok(u60.includes(g2.id) && !u60.includes(g1.id));
  // brand ∩ account filter
  assert.deepEqual((await call('GET', `/posts?brand=Maple&account_id=${yt}`)).json.posts, []);
  const cal = (await call('GET', '/calendar?brand=Maple')).json;
  assert.ok(cal.undated_drafts.every((e) => [igs, fb].includes(e.integration_id)));
  assert.ok(cal.undated_drafts.some((e) => e.group_id === g1.id));
  assert.equal((await call('GET', '/posts?brand=Unknown')).status, 404);
});

test('analytics: brand totals aggregate followers/views/engagement across channels, with a per-channel breakdown and brand top posts', async () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const put = (iid, metric, d, value) => app.root.db.run('INSERT OR REPLACE INTO account_metrics(integration_id, metric, day, value, fetched_at) VALUES(?,?,?,?,?) /* ws:system */', iid, metric, d, value, Date.now());
  for (const [iid, f0, f1, v] of [[fb, 100, 150, 1000], [ig, 200, 260, 3000], [yt, 50, 55, 500], [igs, 999, 999, 99999]]) {
    await put(iid, 'followers', day(5), f0); await put(iid, 'followers', day(1), f1);
    await put(iid, 'views', day(5), v); await put(iid, 'views', day(1), v);
    await put(iid, 'engagements', day(2), 10);
  }
  const r = await call('GET', '/analytics/overview?brand=North%20Star', undefined, readKey);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.accounts.length, 3, 'per-channel breakdown = the brand\'s channels');
  const t = r.json.brand.totals;
  assert.equal(t.followers.value, 150 + 260 + 55);
  assert.equal(t.followers.change, 50 + 60 + 5);
  assert.equal(t.views.value, 2 * (1000 + 3000 + 500));
  assert.equal(t.engagements.value, 30);
  assert.equal(r.json.brand.name, 'North Star');
  assert.equal(r.json.brand.channels, 3);
  await app.root.db.run("INSERT INTO remote_posts(workspace_id, integration_id, external_id, kind, caption, permalink, thumbnail, published_at, updated_at) VALUES('owner', ?, 'rp-igs', 'post', 'maple remote', 'https://ig.example/p', '', ?, ?)", igs, Date.now() - 3600000, Date.now());
  const top = (await call('GET', '/analytics/top-posts?brand=Maple', undefined, readKey)).json.posts;
  assert.ok(top.every((p) => [igs, fb].includes(p.integration_id)));
  assert.ok(top.some((p) => p.external_id === 'rp-igs'));
  const topU = (await call('GET', '/analytics/top-posts?brand=North%20Star', undefined, readKey)).json.posts;
  assert.ok(!topU.some((p) => p.external_id === 'rp-igs'));
  assert.deepEqual(aggregateSummaries([{ avg_view_duration: { value: 10, kind: 'average' } }, { avg_view_duration: { value: 20, kind: 'average' } }]).avg_view_duration.value, 15);
});

test('suggestions from shared name prefixes (never auto-created); disconnecting an account removes it from its brands', async () => {
  const s = suggestBrands([
    { id: 'a', name: 'North Star Explains', provider: 'youtube' }, { id: 'b', name: 'North Star Explains', provider: 'facebook' },
    { id: 'c', name: 'North Star Tools', provider: 'facebook' }, { id: 'd', name: 'North Star WP', provider: 'x' }, { id: 'e', name: 'Maple Grove', provider: 'instagram' },
  ], []);
  assert.equal(s[0].name, 'North Star');
  assert.deepEqual(s[0].account_ids.sort(), ['a', 'b', 'c', 'd']);
  assert.ok(s.some((x) => x.name === 'North Star Explains' && x.account_ids.length === 2));
  assert.ok(!s.some((x) => x.name === 'Under'), 'longest shared prefix wins');
  assert.ok(!s.some((x) => x.name.startsWith('Maple')), 'one account is not a brand');
  // an existing brand with the same channels is not suggested again
  const live = (await call('GET', '/brands')).json;
  assert.ok(!live.suggestions.some((x) => x.name === 'North Star Explains' || x.name === 'North Star'), JSON.stringify(live.suggestions));
  const before = live.brands.length;
  assert.equal((await call('GET', '/brands')).json.brands.length, before, 'listing never creates');
  const extra = await app.seed('facebook', { external_id: 'page-extra', name: 'Extra Page' });
  await call('PUT', '/brands/Maple/channels', { account_ids: [extra], mode: 'add' });
  assert.equal((await call('DELETE', `/accounts/${extra}`)).status, 200);
  assert.ok(!(await call('GET', '/brands')).json.brands.find((b) => b.name === 'Maple').channel_ids.includes(extra));
});

test('workspace isolation: another workspace cannot see, use or modify these brands', async () => {
  const wsB = await app.root.workspaces.create('bob');
  const sb = app.root.scope(wsB);
  const bFb = await sb.integrations.upsert('facebook', { external_id: 'page-bob', name: 'Bob Page', access_token: 'page1-token', refresh_token: 'user-long' });
  const bKey = (await sb.apiKeys.create({ name: 'bob', scopes: ['read', 'write', 'publish', 'analytics', 'admin'], approval_mode: false })).key;
  const aliceBrand = (await call('GET', '/brands')).json.brands.find((b) => b.name === 'North Star');
  assert.deepEqual((await call('GET', '/brands', undefined, bKey)).json.brands, []);
  assert.equal((await call('PATCH', `/brands/${aliceBrand.id}`, { name: 'hijack' }, bKey)).status, 404);
  assert.equal((await call('DELETE', `/brands/${aliceBrand.id}`, undefined, bKey)).status, 404);
  assert.equal((await call('POST', '/posts', { brand_id: aliceBrand.id, content: 'x' }, bKey)).status, 404);
  assert.equal((await call('GET', `/posts?brand=${aliceBrand.id}`, undefined, bKey)).status, 404);
  // Bob may use the same name; he cannot put Alice's accounts in it
  const bb = await call('POST', '/brands', { name: 'North Star', account_ids: [bFb] }, bKey);
  assert.equal(bb.status, 200, bb.text);
  assert.equal((await call('PUT', `/brands/${bb.json.brand.id}/channels`, { account_ids: [fb], mode: 'add' }, bKey)).status, 400);
  assert.equal((await call('PUT', `/brands/${aliceBrand.id}/channels`, { account_ids: [bFb] })).status, 400, 'nor Alice Bob\'s');
  assert.deepEqual((await call('GET', '/brands', undefined, bKey)).json.brands[0].channel_ids, [bFb]);
  assert.equal((await call('GET', '/brands')).json.brands.find((b) => b.name === 'North Star').channel_ids.length, 3);
});
