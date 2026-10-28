import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeJpeg, makeMp4 } from './helpers.js';

let app, fb, ig, igs, yt, key;
before(async () => {
  app = await createTestApp();
  fb = await app.seed('facebook');
  ig = await app.seed('instagram');
  igs = await app.seed('instagram-standalone');
  yt = await app.seed('youtube');
  key = (await app.core.apiKeys.create({ name: 'analyst', scopes: ['read', 'analytics'] })).key;
  // publish one post per platform through postlite so analytics can link them
  const img = await app.upload(makeJpeg(1080, 1080), 'a.jpg');
  const vid = await app.upload(makeMp4({ seconds: 20 }), 'v.mp4');
  await app.core.posts.saveGroup({ content: 'tracked', media: [img.id], action: 'now', posts: [{ integration_id: fb, settings: {} }, { integration_id: ig, settings: {} }] });
  await app.core.posts.saveGroup({ content: 'yt', media: [vid.id], action: 'now', posts: [{ integration_id: yt, settings: { title: 'Tracked video' } }] });
  await app.core.scheduler.drain();
});
after(async () => { await app.close(); });

test('sync stores account time series, snapshots and post metrics for all providers', async () => {
  const res = await app.core.analytics.syncAll();
  for (const id of [fb, ig, igs, yt]) assert.equal(res[id].ok, true, JSON.stringify(res[id]));
  const to = Date.now(), from = to - 5 * 86400000;
  const fbSeries = await app.core.analytics.series(fb, from, to);
  assert.ok(fbSeries.views?.length >= 2, 'facebook daily views');
  assert.ok(fbSeries.followers?.length === 1, 'followers snapshot');
  const igSeries = await app.core.analytics.series(ig, from, to);
  assert.ok(igSeries.reach?.length >= 2);
  assert.ok(igSeries.profile_views?.length >= 1, 'total_value metrics fetched per day');
  const ytSeries = await app.core.analytics.series(yt, from, to);
  assert.ok(ytSeries.watch_minutes?.length >= 3);
  assert.equal((await app.core.analytics.summary(yt, from, to)).followers.value, 100);
  // deprecated metric (page_views_total) is reported as unavailable, not fatal
  const st = await app.core.analytics.status(fb);
  assert.match(st.unavailable.account.profile_views, /valid insights metric/);
  assert.equal(st.last_error, null);
  // posts: ours (linked) + fetched recent ones
  const top = await app.core.analytics.topPosts({ from: 0, to: Date.now() + 1000, limit: 100 });
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
  const g = (await app.core.posts.listGroups({ status: 'published' }))[0];
  const pm = await app.api('GET', `/posts/${g.id}/metrics`, { key });
  assert.equal(pm.status, 200);
  assert.ok(pm.json.targets.some((t) => t.latest && Object.keys(t.latest).length));
  const csv = await fetch(`${app.base}/api/v1/analytics/export.csv?kind=posts`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  const text = await csv.text();
  assert.match(text.split('\n')[0], /^account,provider,external_id/);
  const csv2 = await (await fetch(`${app.base}/api/v1/analytics/export.csv?kind=account&account_id=${fb}`, { headers: { authorization: `Bearer ${key}` } })).text();
  assert.match(csv2, /Test Page,facebook,\d{4}-\d\d-\d\d,views,/);
  const noScope = (await app.core.apiKeys.create({ name: 'r', scopes: ['read'] })).key;
  assert.equal((await fetch(`${app.base}/api/v1/analytics/export.csv?kind=posts`, { headers: { authorization: `Bearer ${noScope}` } })).status, 403);
});

test('analytics auth failure marks account; YouTube 401 triggers refresh then succeeds', async () => {
  app.fake.state.expiredYtTokens.add((await app.core.integrations.secret(yt)).access_token);
  const r = await app.core.analytics.syncIntegration(yt);
  assert.equal(r.ok, true, r.error);
  assert.ok(app.fake.state.calls.some((c) => c.path === '/gtoken/token' && c.body.grant_type === 'refresh_token'));
  const id = await app.seed('facebook', { external_id: 'page2', name: 'P2', access_token: 'page2-token' });
  app.fake.state.revoked.add('page2-token');
  const r2 = await app.core.analytics.syncIntegration(id);
  app.fake.state.revoked.delete('page2-token');
  assert.equal(r2.ok, false);
  assert.equal((await app.core.integrations.get(id)).status, 'needs_reconnect');
});

test('missing analytics permission degrades gracefully (YouTube Analytics 403)', async () => {
  app.fake.state.failNext['^/yta/'] = { status: 403, body: { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'insufficientPermissions' }] } }, times: 100 };
  const r = await app.core.analytics.syncIntegration(yt);
  delete app.fake.state.failNext['^/yta/'];
  assert.equal(r.ok, true);
  assert.match(r.unavailable.account.watch_minutes, /yt-analytics\.readonly/);
  assert.equal(r.unavailable.notices[0].code, 'missing_permission');
  assert.equal(r.unavailable.notices[0].action, 'reconnect');
});

test('YouTube Analytics API disabled: Data API fallback, one actionable notice, derived daily views', async () => {
  const body = { error: { code: 403, message: 'YouTube Analytics API has not been used in project 123456789012 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/youtubeanalytics.googleapis.com/overview?project=123456789012 then retry.', errors: [{ message: 'disabled', domain: 'usageLimits', reason: 'accessNotConfigured' }], status: 'PERMISSION_DENIED' } };
  app.fake.state.failNext['^/yta/'] = { status: 403, body, times: 100 };
  // a total-views snapshot from an earlier day: today's daily views = current total − that
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await app.core.db.run('INSERT OR REPLACE INTO account_metrics(integration_id, metric, day, value, fetched_at) VALUES(?,?,?,?,?) /* ws:system */', yt, 'video_views', y, 600, Date.now());
  await app.core.db.run('INSERT OR REPLACE INTO account_metrics(integration_id, metric, day, value, fetched_at) VALUES(?,?,?,?,?) /* ws:system */', yt, 'followers', y, 90, Date.now());
  const before = app.fake.state.calls.filter((c) => c.path.startsWith('/yta/')).length;
  const r = await app.core.analytics.syncIntegration(yt, { restart: true });
  const ytaCalls = app.fake.state.calls.filter((c) => c.path.startsWith('/yta/')).length - before;
  delete app.fake.state.failNext['^/yta/'];
  assert.equal(r.ok, true, r.error);
  assert.equal(ytaCalls, 1, 'post metrics skip the disabled Analytics API');
  const st = await app.core.analytics.status(yt);
  assert.equal(st.unavailable.notices.length, 1);
  const n = st.unavailable.notices[0];
  assert.equal(n.code, 'api_disabled');
  assert.equal(n.url, 'https://console.developers.google.com/apis/api/youtubeanalytics.googleapis.com/overview?project=123456789012');
  assert.match(n.text, /Turn on YouTube Analytics API in Google Cloud to see watch time/);
  assert.match(st.unavailable.account.watch_minutes, /Needs YouTube Analytics API/);
  assert.equal(st.unavailable.sources.total_views, 'data_api');
  assert.equal(st.unavailable.sources.views, 'data_api');
  const to = Date.now();
  const sum = await app.core.analytics.summary(yt, to - 3 * 86400000, to);
  assert.equal(sum.total_views.value, 5000);
  assert.equal(sum.followers.value, 100);
  const series = await app.core.analytics.series(yt, to - 3 * 86400000, to);
  const today = new Date().toISOString().slice(0, 10);
  const vids = (await app.core.analytics.topPosts({ integrationId: yt, from: 0, to: Date.now() + 1000 })).length;
  assert.equal(sum.video_views.value, 321 * vids, 'Σ video views from videos.list');
  assert.equal(series.views.find((p) => p.day === today)?.value, 321 * vids - 600, 'views since the previous snapshot');
  assert.equal(series.net_followers.find((p) => p.day === today)?.value, 10);
  const top = await app.core.analytics.topPosts({ integrationId: yt, from: 0, to: to + 1000 });
  assert.ok(top.every((p) => p.metrics.views === 321 && p.metrics.likes === 12 && p.metrics.comments === 3));
  // the REST overview carries the notice for the UI
  const ov = await app.api('GET', '/analytics/overview', { key });
  assert.equal(ov.json.accounts.find((a) => a.account_id === yt).sync.unavailable.notices[0].code, 'api_disabled');
});

test('Meta daily insights are dated by period start (end_time − 1 day); no future days are kept', async () => {
  await app.core.db.run('INSERT OR REPLACE INTO account_metrics(integration_id, metric, day, value, fetched_at) VALUES(?,?,?,?,?) /* ws:system */', fb, 'views', '2999-01-01', 1, Date.now());
  const r = await app.core.analytics.syncIntegration(fb, { restart: true, backfill: true });
  assert.equal(r.ok, true, r.error);
  const today = new Date().toISOString().slice(0, 10);
  const rows = await app.core.db.all('SELECT day FROM account_metrics WHERE integration_id = ? AND day > ? /* ws:system */', fb, today);
  assert.deepEqual(rows, []);
});
