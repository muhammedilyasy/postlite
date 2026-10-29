// Repeating posts: rule math (DST, month ends), rolling generation, edit/stop, media purge guard, isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeMp4 } from './helpers.js';
import { occurrenceAt, cleanRule, AHEAD } from '../src/series.js';

const DAY = 86400000;
let app, key, keyB, fb, ig, vid;

before(async () => {
  app = await createTestApp();
  fb = await app.seed('facebook');
  ig = await app.seed('instagram');
  vid = await app.upload(makeMp4(), 'v.mp4');
  key = (await app.core.apiKeys.create({ name: 'rep', scopes: ['read', 'write', 'publish'], approval_mode: false, rate_limit_per_min: 5000 })).key;
  const wsB = await app.root.workspaces.create('B');
  keyB = (await app.root.scope(wsB).apiKeys.create({ name: 'b', scopes: ['read', 'write', 'publish'], approval_mode: false })).key;
});
after(async () => { await app?.close(); });

test('occurrenceAt keeps the wall time across DST and clamps month ends', () => {
  const tz = 'Europe/Berlin';
  const first = Date.parse('2026-03-27T09:00:00+01:00'); // Friday before the DST switch
  assert.equal(new Date(occurrenceAt({ frequency: 'daily' }, first, 3, tz)).toISOString(), '2026-03-30T07:00:00.000Z'); // 09:00 CEST
  assert.equal(new Date(occurrenceAt({ frequency: 'weekly' }, first, 1, tz)).toISOString(), '2026-04-03T07:00:00.000Z');
  assert.equal(occurrenceAt({ frequency: 'every_n_days', interval_days: 3 }, Date.UTC(2026, 0, 1, 12), 2, 'UTC'), Date.UTC(2026, 0, 7, 12));
  assert.equal(occurrenceAt({ frequency: 'biweekly' }, Date.UTC(2026, 0, 1, 12), 1, 'UTC'), Date.UTC(2026, 0, 15, 12));
  const jan31 = Date.UTC(2026, 0, 31, 10);
  assert.equal(new Date(occurrenceAt({ frequency: 'monthly' }, jan31, 1, 'UTC')).toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(new Date(occurrenceAt({ frequency: 'monthly' }, jan31, 2, 'UTC')).toISOString(), '2026-03-31T10:00:00.000Z');
  assert.equal(new Date(occurrenceAt({ frequency: 'monthly' }, jan31, 12, 'UTC')).toISOString(), '2027-01-31T10:00:00.000Z');
  assert.throws(() => cleanRule({ frequency: 'every_n_days', interval_days: 7 }), /2 to 6/);
  assert.throws(() => cleanRule({ frequency: 'hourly' }), /frequency/);
  assert.throws(() => cleanRule({ frequency: 'daily', count: 1 }), /count/);
});

test('create_post {repeat}: first occurrence + rolling ahead, own groups, tags copied, calendar shows them', async () => {
  const first = Date.now() + 3600000;
  const r = await app.api('POST', '/posts', { key, body: { content: 'Daily tip', tags: ['tips'], media_ids: [vid.id], targets: [{ account_id: ig }], mode: 'schedule', publish_at: first, repeat: { frequency: 'daily' } } });
  assert.equal(r.status, 200, r.text);
  const sid = r.json.post.series_id;
  assert.ok(sid);
  assert.equal(r.json.post.series_index, 0);
  const s = (await app.api('GET', `/series/${sid}`, { key })).json.series;
  assert.equal(s.status, 'active');
  assert.equal(s.rule, 'Every day');
  assert.equal(s.occurrences.length, AHEAD, 'first + rolling ahead until 3 are in the future');
  assert.deepEqual(s.occurrences.map((o) => o.publish_at), [0, 1, 2].map((k) => first + k * DAY));
  assert.ok(s.occurrences.every((o) => o.status === 'scheduled'));
  const occ2 = (await app.api('GET', `/posts/${s.occurrences[2].id}`, { key })).json.post;
  assert.deepEqual(occ2.tags.map((t) => t.name), ['tips']);
  assert.equal(occ2.series_id, sid);
  const cal = await app.api('GET', `/calendar?from=${first - 1000}&to=${first + 3 * DAY}`, { key });
  assert.equal(cal.json.entries.filter((e) => s.occurrences.some((o) => o.id === e.group_id)).length, 3);
  // Fill is idempotent
  assert.equal(await app.core.series.fill(sid), 0);
  // Mode must be schedule
  assert.equal((await app.api('POST', '/posts', { key, body: { content: 'x', targets: [{ account_id: fb }], mode: 'draft', repeat: { frequency: 'daily' } } })).status, 400);
  // An end before the first occurrence is rejected and leaves no one-off post behind
  const before = (await app.api('GET', '/posts?limit=200', { key })).json.posts.length;
  const bad = await app.api('POST', '/posts', { key, body: { content: 'too late', targets: [{ account_id: fb }], mode: 'schedule', publish_at: first + 5 * DAY, repeat: { frequency: 'daily', until: first + DAY } } });
  assert.equal(bad.status, 400, bad.text);
  assert.equal((await app.api('GET', '/posts?limit=200', { key })).json.posts.length, before);
});

test('rolling: when occurrences pass, fill() tops up; count and until end the series', async () => {
  const first = Date.now() + 3600000;
  const r = await app.api('POST', '/posts', { key, body: { content: 'Weekly x4', targets: [{ account_id: fb }], mode: 'schedule', publish_at: first, repeat: { frequency: 'weekly', count: 4 } } });
  const sid = r.json.post.series_id;
  let s = (await app.api('GET', `/series/${sid}`, { key })).json.series;
  assert.equal(s.occurrences.length, 3);
  // Pretend 2 weeks passed: fill as of then.
  await app.core.series.fill(sid, { now: first + 14 * DAY + 1000 });
  s = (await app.api('GET', `/series/${sid}`, { key })).json.series;
  assert.equal(s.occurrences.length, 4, 'count=4 caps the series');
  assert.equal(s.status, 'ended');
  const u = await app.api('POST', '/posts', { key, body: { content: 'Until', targets: [{ account_id: fb }], mode: 'schedule', publish_at: first, repeat: { frequency: 'daily', until: first + 1 * DAY + 60000 } } });
  const su = (await app.api('GET', `/series/${u.json.post.series_id}`, { key })).json.series;
  assert.equal(su.occurrences.length, 2);
  assert.equal(su.status, 'ended');
});

test('update_series: content applies to future occurrences; rule change regenerates; stop deletes future ones', async () => {
  const first = Date.now() + 3600000;
  const r = await app.api('POST', '/posts', { key, body: { content: 'Old caption', targets: [{ account_id: fb }], mode: 'schedule', publish_at: first, repeat: { frequency: 'daily' } } });
  const sid = r.json.post.series_id;
  const u = await app.api('PATCH', `/series/${sid}`, { key, body: { content: 'New caption' } });
  assert.equal(u.status, 200, u.text);
  for (const o of u.json.series.occurrences.filter((x) => x.index > 0)) assert.equal((await app.api('GET', `/posts/${o.id}`, { key })).json.post.content, 'New caption');
  assert.equal((await app.api('GET', `/posts/${r.json.post.id}`, { key })).json.post.content, 'Old caption', 'occurrence #0 is the post itself; edit it directly');
  const w = await app.api('PATCH', `/series/${sid}`, { key, body: { frequency: 'every_n_days', interval_days: 2 } });
  assert.equal(w.status, 200, w.text);
  const times = w.json.series.occurrences.map((o) => o.publish_at);
  assert.equal(times[0], first);
  assert.equal(times[1], first + 2 * DAY);
  assert.equal(times[2], first + 4 * DAY);
  assert.equal(w.json.series.rule, 'Every 2 days');
  // A bad content edit is refused before anything changes
  assert.equal((await app.api('PATCH', `/series/${sid}`, { key, body: { targets: [{ account_id: 'nope' }] } })).status, 400);
  const st = await app.api('POST', `/series/${sid}/stop`, { key, body: {} });
  assert.equal(st.status, 200, st.text);
  assert.equal(st.json.removed_occurrences, 2);
  assert.equal(st.json.series.status, 'stopped');
  assert.equal(st.json.series.occurrences.length, 1, 'the original post stays');
  assert.equal(await app.core.series.fill(sid), 0);
  assert.equal((await app.api('PATCH', `/series/${sid}`, { key, body: { content: 'x' } })).status, 409);
});

test('media of an active series is never purged or bulk-deleted; stopping releases it', async () => {
  const img = await app.upload(makeMp4(), 'loop.mp4');
  const r = await app.api('POST', '/posts', { key, body: { content: 'Loop', media_ids: [img.id], targets: [{ account_id: ig }], mode: 'schedule', publish_at: Date.now() + 3600000, repeat: { frequency: 'monthly' } } });
  const sid = r.json.post.series_id;
  // Delete every generated occurrence: only the series still references the file.
  for (const o of (await app.core.series.get(sid)).occurrences) await app.core.posts.deleteGroup(o.id);
  const plan = await app.core.retention.plan({ mode: 'immediate', now: Date.now() + 365 * DAY });
  assert.match(plan.kept.find((k) => k.media_id === img.id).reason, /repeating/);
  const del = await app.api('POST', '/media/delete', { key, body: { media_ids: [img.id] } });
  assert.equal(del.json.skipped[0]?.reason, 'used by a repeating post');
  await app.api('POST', `/series/${sid}/stop`, { key, body: {} });
  const plan2 = await app.core.retention.plan({ mode: 'immediate', now: Date.now() + 365 * DAY });
  assert.doesNotMatch(plan2.kept.find((k) => k.media_id === img.id)?.reason || '', /repeating/);
});

test('isolation: series of one workspace are invisible and untouchable from another; fillSeries works per workspace', async () => {
  const mine = (await app.api('GET', '/series', { key })).json.series;
  assert.ok(mine.length >= 4);
  assert.deepEqual((await app.api('GET', '/series', { key: keyB })).json.series, []);
  const sid = mine.find((s) => s.status === 'active').id;
  assert.equal((await app.api('GET', `/series/${sid}`, { key: keyB })).status, 404);
  assert.equal((await app.api('PATCH', `/series/${sid}`, { key: keyB, body: { content: 'pwned' } })).status, 404);
  assert.equal((await app.api('POST', `/series/${sid}/stop`, { key: keyB, body: {} })).status, 404);
  assert.equal((await app.core.series.get(sid)).status, 'active');
  assert.equal(typeof (await app.root.fillSeries()), 'number');
});
