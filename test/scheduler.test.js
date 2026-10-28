import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeJpeg, makeMp4 } from './helpers.js';
import { createScheduler } from '../src/scheduler.js';
import { openDb } from '../src/db.js';
import { createPosts } from '../src/posts.js';

let app;
before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

const group = (fb, content, at = Date.now()) => app.core.posts.saveGroup({ content, media: [], action: at <= Date.now() ? 'now' : 'schedule', publish_at: at, posts: [{ integration_id: fb, settings: {} }] });
const target = (gid) => app.core.posts.getGroup(gid).targets[0];
const feedCalls = (content) => app.fake.state.published.filter((p) => p.platform === 'facebook' && p.data.message === content).length;

test('claim is atomic: a claimed job cannot be claimed again', () => {
  const fb = app.seed('facebook');
  const gid = group(fb, 'claim-test');
  const s = app.core.scheduler;
  const j1 = s.claim();
  const j2 = s.claim();
  assert.ok(j1);
  assert.equal(j2, null);
  assert.equal(target(gid).status, 'publishing');
  // release for other tests
  app.core.db.run("UPDATE jobs SET state='queued', locked_by=NULL WHERE id=?", j1.id);
});

test('two schedulers sharing the DB file never double-post', async () => {
  const fb = app.seed('facebook');
  await app.core.scheduler.drain();
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(group(fb, `race-${i}`));
  // second process-like scheduler with its own DB connection
  const db2 = openDb(app.cfg.dbFile);
  const posts2 = createPosts({ db: db2, media: app.core.media, integrations: app.core.integrations });
  const s2 = createScheduler({ db: db2, cfg: app.cfg, media: app.core.media, integrations: app.core.integrations, posts: posts2 });
  await Promise.all([app.core.scheduler.drain(), s2.drain(), app.core.scheduler.tick(), s2.tick()]);
  await app.core.scheduler.drain();
  db2.close();
  for (let i = 0; i < 6; i++) assert.equal(feedCalls(`race-${i}`), 1, `race-${i} published exactly once`);
  for (const gid of ids) assert.equal(target(gid).status, 'published');
});

test('transient errors retry with exponential backoff, then fail after max attempts', async () => {
  const fb = app.seed('facebook');
  app.fake.state.failNext['/page1/feed$'] = { status: 500, body: { error: { message: 'An unexpected error has occurred. Please retry your request later.', type: 'OAuthException', code: 2, is_transient: true } }, times: 2 };
  const gid = group(fb, 'retry-me');
  const t0 = Date.now();
  await app.core.scheduler.drain();
  const t = target(gid);
  assert.equal(t.status, 'published');
  assert.equal(t.attempts, 2);
  assert.ok(Date.now() - t0 >= 30 + 60, 'waited backoff (30ms then 60ms)');
  const ev = app.core.posts.events(t.id).map((e) => e.message).join('\n');
  assert.match(ev, /Attempt 1 failed/);
  assert.match(ev, /Attempt 2 failed/);

  app.fake.state.failNext['/page1/feed$'] = { status: 503, body: { error: { message: 'Service unavailable', code: 2 } }, times: 5 };
  const gid2 = group(fb, 'always-fails');
  await app.core.scheduler.drain();
  const t2 = target(gid2);
  assert.equal(t2.status, 'failed');
  assert.match(t2.error, /Failed after 3 attempts/);
  delete app.fake.state.failNext['/page1/feed$'];
});

test('permanent errors fail immediately', async () => {
  const fb = app.seed('facebook');
  app.fake.state.failNext['/page1/feed$'] = { status: 400, body: { error: { message: 'Duplicate', code: 506, error_subcode: 1366051 } }, times: 1 };
  const gid = group(fb, 'dup');
  await app.core.scheduler.drain();
  const t = target(gid);
  assert.equal(t.status, 'failed');
  assert.equal(t.attempts, 0);
  assert.match(t.error, /already posted/);
});

test('restart recovery: overdue posts within grace publish; older ones are marked missed', async () => {
  const fb = app.seed('facebook');
  await app.core.scheduler.drain();
  const recent = group(fb, 'overdue-recent', Date.now() + 60000);
  const old = group(fb, 'overdue-old', Date.now() + 60000);
  // Simulate the server being down: push run times into the past.
  app.core.db.run('UPDATE jobs SET run_at = ? WHERE post_id = ?', Date.now() - 10 * 60000, target(recent).id);
  app.core.db.run('UPDATE jobs SET run_at = ? WHERE post_id = ?', Date.now() - 7 * 3600000, target(old).id);
  const missed = app.core.scheduler.boot();
  assert.equal(missed, 1);
  await app.core.scheduler.drain();
  assert.equal(target(recent).status, 'published');
  assert.equal(target(old).status, 'failed');
  assert.match(target(old).error, /Missed/);
});

test('crash mid-pipeline (no irreversible call in flight) resumes from persisted phase', async () => {
  const ig = app.seed('instagram');
  const img = await app.upload(makeJpeg(1080, 1080), 'c.jpg');
  const gid = app.core.posts.saveGroup({ content: 'resume', media: [img.id], action: 'now', posts: [{ integration_id: ig, settings: {} }] });
  // Run only the start phase: claim + run start manually by simulating a crash after containers were created.
  const job = app.core.scheduler.claim();
  const ig1 = app.core.integrations.secret(ig);
  const prov = (await import('../src/providers/index.js')).getProvider('instagram');
  const r = await prov.publishStart({ cfg: app.cfg, integration: ig1, token: ig1.access_token, post: { caption: 'resume', media: [img], settings: { post_type: 'post' } }, mediaUrl: (m) => app.core.media.publicUrl(m), irreversible: async () => {} });
  app.core.db.run("UPDATE jobs SET phase='check', pending_data=?, locked_until=? WHERE id=?", JSON.stringify(r.data), Date.now() - 1, job.id);
  const containersBefore = Object.keys(app.fake.state.containers).length;
  await app.core.scheduler.drain(); // recoverStale releases the expired lock
  assert.equal(target(gid).status, 'published');
  assert.equal(Object.keys(app.fake.state.containers).length, containersBefore, 'no new containers created on resume');
});

test('IG: crash during media_publish → recovery sees PUBLISHED and never re-publishes', async () => {
  const ig = app.seed('instagram');
  const img = await app.upload(makeJpeg(1080, 1080), 'd.jpg');
  app.fake.state.hangOnce = '/ig1/media_publish';
  const gid = app.core.posts.saveGroup({ content: 'hang-ig', media: [img.id], action: 'now', posts: [{ integration_id: ig, settings: {} }] });
  await app.core.scheduler.drain();
  const t = target(gid);
  // The connection drop is an unknown outcome → the job is handed to recovery, which confirms PUBLISHED.
  // Depending on timing the first run fails as unknown_outcome; we must not double publish either way.
  const pubs = app.fake.state.published.filter((p) => p.data?.caption === 'hang-ig' || p.id === 'lost');
  assert.equal(pubs.length, 1, 'published exactly once');
  assert.equal(t.status, 'published', 'recovery confirmed the publish via container status');
});

test('IG recovery path: stale inflight job is checked via container status', async () => {
  const ig = app.seed('instagram');
  const img = await app.upload(makeJpeg(1080, 1080), 'e.jpg');
  const gid = app.core.posts.saveGroup({ content: 'recover-ig', media: [img.id], action: 'now', posts: [{ integration_id: ig, settings: {} }] });
  const job = app.core.scheduler.claim();
  const integ = app.core.integrations.secret(ig);
  const prov = (await import('../src/providers/index.js')).getProvider('instagram');
  const ctx = { cfg: app.cfg, integration: integ, token: integ.access_token, post: { caption: 'recover-ig', media: [img], settings: { post_type: 'post' } }, mediaUrl: (m) => app.core.media.publicUrl(m), irreversible: async () => {} };
  const r = await prov.publishStart(ctx);
  // container finishes and is published "by a previous process" that then crashed before saving
  await prov.publishCheck(ctx, r.data); await prov.publishCheck(ctx, r.data);
  const c = app.fake.state.containers[r.data.containers[0]];
  c.status = 'PUBLISHED';
  app.core.db.run("UPDATE jobs SET phase='finalize', pending_data=?, inflight=?, locked_until=? WHERE id=?", JSON.stringify(r.data), JSON.stringify({ label: 'publishing to Instagram' }), Date.now() - 1, job.id);
  const publishCalls = app.fake.state.calls.filter((x) => x.path.endsWith('media_publish')).length;
  await app.core.scheduler.drain();
  assert.equal(target(gid).status, 'published');
  assert.equal(app.fake.state.calls.filter((x) => x.path.endsWith('media_publish')).length, publishCalls, 'media_publish not called again');
});

test('FB: lost response on the feed call → failed with "check before retrying", never auto-retried', async () => {
  const fb = app.seed('facebook');
  app.fake.state.hangOnce = '/page1/feed';
  const gid = group(fb, 'hang-fb');
  await app.core.scheduler.drain();
  const t = target(gid);
  assert.equal(t.status, 'failed');
  assert.match(t.error, /may or may not have been published|cannot confirm/);
  assert.equal(t.attempts, 0);
});

test('FB: stale inflight job without provider recovery fails safely', async () => {
  const fb = app.seed('facebook');
  const gid = group(fb, 'stale-fb', Date.now() + 3600000);
  const t = target(gid);
  app.core.db.run("UPDATE jobs SET state='running', inflight=?, locked_until=? WHERE post_id=?", JSON.stringify({ label: 'publishing feed post' }), Date.now() - 1, t.id);
  await app.core.scheduler.drain();
  assert.equal(target(gid).status, 'failed');
  assert.match(target(gid).error, /interrupted during "publishing feed post"/);
  assert.equal(feedCalls('stale-fb'), 0);
});

test('YouTube: crash mid-upload resumes from the session offset', async () => {
  const yt = app.seed('youtube');
  const vid = await app.upload(makeMp4({ seconds: 20, mdatBytes: 900000 }), 'big.mp4');
  const gid = app.core.posts.saveGroup({ content: 'resume yt', media: [vid.id], action: 'now', posts: [{ integration_id: yt, settings: { title: 'Resume test' } }] });
  const job = app.core.scheduler.claim();
  const integ = app.core.integrations.secret(yt);
  const prov = (await import('../src/providers/index.js')).getProvider('youtube');
  const ctx = { cfg: app.cfg, integration: integ, token: integ.access_token, post: { caption: 'resume yt', media: [vid], settings: { title: 'Resume test' } }, mediaPath: (m) => app.core.media.path(m) };
  const r = await prov.publishStart(ctx);
  // upload first chunk manually then "crash"
  const fs = await import('node:fs');
  const buf = fs.readFileSync(app.core.media.path(vid)).subarray(0, 256 * 1024);
  await fetch(r.data.uploadUri, { method: 'PUT', headers: { authorization: `Bearer ${integ.access_token}`, 'content-range': `bytes 0-${buf.length - 1}/${r.data.size}` }, body: buf });
  app.core.db.run("UPDATE jobs SET phase='check', pending_data=?, locked_until=? WHERE id=?", JSON.stringify(r.data), Date.now() - 1, job.id);
  await app.core.scheduler.drain();
  const t = target(gid);
  assert.equal(t.status, 'published', t.error);
  const up = app.fake.state.uploads[r.data.uploadUri.split('/').pop()];
  assert.equal(up.received, up.size);
});

test('rescheduling and deleting update the job; running jobs are protected', async () => {
  const fb = app.seed('facebook');
  const gid = group(fb, 'move-me', Date.now() + 3600000);
  const newAt = Date.now() + 7200000;
  app.core.posts.rescheduleGroup(gid, newAt);
  const job = app.core.db.get('SELECT * FROM jobs WHERE post_id = ?', target(gid).id);
  assert.equal(job.run_at, newAt);
  app.core.db.run("UPDATE jobs SET state='running' WHERE id=?", job.id);
  assert.throws(() => app.core.posts.deleteGroup(gid), /being published/);
  app.core.db.run("UPDATE jobs SET state='queued' WHERE id=?", job.id);
  app.core.posts.deleteGroup(gid);
  assert.equal(app.core.db.get('SELECT COUNT(*) n FROM jobs WHERE id=?', job.id).n, 0);
});

test('pending media processing times out', async () => {
  const ig = app.seed('instagram');
  const img = await app.upload(makeJpeg(1080, 1080), 'slow.jpg');
  app.fake.state.inProgressPolls = 1e9;
  app.cfg.scheduler.maxPendingMs = 150;
  const gid = app.core.posts.saveGroup({ content: 'slow', media: [img.id], action: 'now', posts: [{ integration_id: ig, settings: {} }] });
  await app.core.scheduler.drain();
  app.fake.state.inProgressPolls = 1;
  app.cfg.scheduler.maxPendingMs = 3600000;
  const t = target(gid);
  assert.equal(t.status, 'failed');
  assert.match(t.error, /Timed out waiting/);
});
