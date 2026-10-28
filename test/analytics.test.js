import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeJpeg, makeMp4 } from './helpers.js';

let app, fb, ig, igs, yt, key;
before(async () => {
  app = await createTestApp();
  fb = app.seed('facebook');
  ig = app.seed('instagram');
  igs = app.seed('instagram-standalone');
  yt = app.seed('youtube');
  key = app.core.apiKeys.create({ name: 'analyst', scopes: ['read', 'analytics'] }).key;
  // publish one post per platform through postlite so analytics can link them
  const img = await app.upload(makeJpeg(1080, 1080), 'a.jpg');
  const vid = await app.upload(makeMp4({ seconds: 20 }), 'v.mp4');
  app.core.posts.saveGroup({ content: 'tracked', media: [img.id], action: 'now', posts: [{ integration_id: fb, settings: {} }, { integration_id: ig, settings: {} }] });
  app.core.posts.saveGroup({ content: 'yt', media: [vid.id], action: 'now', posts: [{ integration_id: yt, settings: { title: 'Tracked video' } }] });
  await app.core.scheduler.drain();
});
after(async () => { await app.close(); });

test('sync stores account time series, snapshots and post metrics for all providers', async () => {
  const res = await app.core.analytics.syncAll();
  for (const id of [fb, ig, igs, yt]) assert.equal(res[id].ok, true, JSON.stringify(res[id]));
  const to = Date.now(), from = to - 5 * 86400000;
  const fbSeries = app.core.analytics.series(fb, from, to);
  assert.ok(fbSeries.views?.length >= 2, 'facebook daily views');
  assert.ok(fbSeries.followers?.length === 1, 'followers snapshot');
  const igSeries = app.core.analytics.series(ig, from, to);
  assert.ok(igSeries.reach?.length >= 2);
  assert.ok(igSeries.profile_views?.length >= 1, 'total_value metrics fetched per day');
  const ytSeries = app.core.analytics.series(yt, from, to);
  assert.ok(ytSeries.watch_minutes?.length >= 3);
  assert.equal(app.core.analytics.summary(yt, from, to).followers.value, 100);
  // deprecated metric (page_views_total) is reported as unavailable, not fatal
  const st = app.core.analytics.status(fb);
  assert.match(st.unavailable.account.profile_views, /valid insights metric/);
  assert.equal(st.last_error, null);
  // posts: ours (linked) + fetched recent ones
  const top = app.core.analytics.topPosts({ from: 0, to: Date.now() + 1000, limit: 100 });
  assert.ok(top.some((p) => p.via_postlite && p.provider === 'facebook' && p.metrics.views >= 0));
  assert.ok(top.some((p) => p.external_id === 'igold1' && !p.via_postlite));
  const ytPost = top.find((p) => p.provider === 'youtube' && p.via_postlite);
  assert.equal(ytPost.metrics.views, 321);
  assert.ok(ytPost.metrics.watch_minutes >= 0);
  assert.ok(ytPost.metrics.avg_view_sec >= 0);
});

test('analytics REST endpoints + CSV export + scope', async () => {
  const ov = await app.api('GET', '/analytics/overview', { key });
  assert.equal(ov.status, 200);
  assert.equal(ov.json.accounts.length, 4);
  const acc = await app.api('GET', `/analytics/accounts/${ig}?from=${Date.now() - 5 * 86400000}`, { key });
  assert.ok(acc.json.series.reach);
  const top = await app.api('GET', '/analytics/top-posts?sort=views&limit=5', { key });
  assert.ok(top.json.posts.length > 0);
  const g = app.core.posts.listGroups({ status: 'published' })[0];
  const pm = await app.api('GET', `/posts/${g.id}/metrics`, { key });
  assert.equal(pm.status, 200);
  assert.ok(pm.json.targets.some((t) => t.latest && Object.keys(t.latest).length));
  const csv = await fetch(`${app.base}/api/v1/analytics/export.csv?kind=posts`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  const text = await csv.text();
  assert.match(text.split('\n')[0], /^account,provider,external_id/);
  const csv2 = await (await fetch(`${app.base}/api/v1/analytics/export.csv?kind=account&account_id=${fb}`, { headers: { authorization: `Bearer ${key}` } })).text();
  assert.match(csv2, /Test Page,facebook,\d{4}-\d\d-\d\d,views,/);
  const noScope = app.core.apiKeys.create({ name: 'r', scopes: ['read'] }).key;
  assert.equal((await fetch(`${app.base}/api/v1/analytics/export.csv?kind=posts`, { headers: { authorization: `Bearer ${noScope}` } })).status, 403);
});

test('analytics auth failure marks account; YouTube 401 triggers refresh then succeeds', async () => {
  app.fake.state.expiredYtTokens.add(app.core.integrations.secret(yt).access_token);
  const r = await app.core.analytics.syncIntegration(yt);
  assert.equal(r.ok, true, r.error);
  assert.ok(app.fake.state.calls.some((c) => c.path === '/gtoken/token' && c.body.grant_type === 'refresh_token'));
  const id = app.seed('facebook', { external_id: 'page2', name: 'P2', access_token: 'page2-token' });
  app.fake.state.revoked.add('page2-token');
  const r2 = await app.core.analytics.syncIntegration(id);
  app.fake.state.revoked.delete('page2-token');
  assert.equal(r2.ok, false);
  assert.equal(app.core.integrations.get(id).status, 'needs_reconnect');
});

test('missing analytics permission degrades gracefully (YouTube Analytics 403)', async () => {
  app.fake.state.failNext['^/yta/'] = { status: 403, body: { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'insufficientPermissions' }] } }, times: 100 };
  const r = await app.core.analytics.syncIntegration(yt);
  delete app.fake.state.failNext['^/yta/'];
  assert.equal(r.ok, true);
  assert.match(r.unavailable.account.watch_minutes, /YouTube Analytics API/);
});
