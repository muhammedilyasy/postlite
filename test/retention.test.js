// Delete media after publishing: reference counting across posts/targets, blocking states (drafts,
// scheduled, publishing incl. IG containers and YouTube resumable sessions, retries), the workspace
// setting (immediate / 7d / 30d / never), 410 on purged /m/ URLs, UI data, duplicates, retries,
// workspace isolation and the scheduler-loop cleanup with its audit entry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestApp, makeJpeg, makeMp4, waitFor } from './helpers.js';

const FFMPEG = (() => { for (const b of [process.env.FFMPEG_PATH, '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) { try { if (b) { execFileSync(b, ['-version'], { stdio: 'ignore' }); return b; } } catch {} } return null; })();

const MIN = 60000;
const DAY = 86400000;
let app, key, writeKey, fb, ig, yt;

before(async () => {
  app = await createTestApp({ env: { MEDIA_PURGE_INTERVAL_MINUTES: '100000' } }); // loop runs once at start; tests call run() with explicit times
  fb = await app.seed('facebook');
  ig = await app.seed('instagram');
  yt = await app.seed('youtube');
  key = (await app.core.apiKeys.create({ name: 'admin', scopes: ['read', 'write', 'publish', 'admin'], approval_mode: false })).key;
  writeKey = (await app.core.apiKeys.create({ name: 'writer', scopes: ['read', 'write', 'publish'], approval_mode: false })).key;
});
after(async () => { await app.close(); });

const R = () => app.core.retention;
const later = (ms) => Date.now() + ms;
/** Upload an image (or video) with a preview so it can be purged without ffmpeg. */
async function media(kind = 'image', name = `${kind}-${Math.random().toString(36).slice(2, 7)}`) {
  const m = await app.upload(kind === 'video' ? makeMp4({ seconds: 10 }) : makeJpeg(1080, 1080, 20000), `${name}.${kind === 'video' ? 'mp4' : 'jpg'}`);
  await app.core.media.setPoster(m.id, makeJpeg(320, 320));
  return app.core.media.get(m.id);
}
async function publish(targets, mediaRows, extra = {}) {
  const gid = await app.core.posts.saveGroup({ content: 'retention', media: mediaRows.map((m) => m.id), action: 'now', posts: targets.map((t) => (typeof t === 'string' ? { integration_id: t } : t)), ...extra });
  const g = await settle(app.core, gid);
  for (const t of g.targets) assert.equal(t.status, 'published', t.error);
  return g;
}
/** Tick until every target of the group is done (drain() would also wait for unrelated future jobs). */
async function settle(sc, gid, sched = app.root.scheduler) {
  return waitFor(async () => {
    await sched.tick();
    const g = await sc.posts.getGroup(gid);
    return g.targets.every((t) => ['published', 'failed'].includes(t.status)) && sched.activeCount() === 0 && g;
  }, { timeout: 15000 });
}
const keptReason = async (id, now) => (await R().plan({ now })).kept.find((k) => k.media_id === id)?.reason;
const isEligible = async (id, now) => (await R().plan({ now })).eligible.some((e) => e.media_id === id);
const file = (m) => path.join(app.cfg.uploadDir, m.filename);
const sys = (sql, ...p) => app.root.db.run(`${sql} /* ws:system */`, ...p);

test('published on several accounts: kept during the safety window, then purged; poster stays; /m/ original → 410', async () => {
  const m = await media('image');
  const g = await publish([fb, ig], [m]);
  assert.match(await keptReason(m.id, Date.now()), /safety window after publishing, until/);
  assert.match(await keptReason(m.id, later(29 * MIN)), /safety window/);
  const r = await R().run({ now: later(31 * MIN) });
  const hit = r.purged.find((p) => p.media_id === m.id);
  assert.ok(hit, JSON.stringify(r.kept.find((k) => k.media_id === m.id)));
  assert.equal(hit.bytes, m.size);
  assert.ok(!fs.existsSync(file(m)), 'original removed from disk');
  const row = await app.core.media.get(m.id);
  assert.ok(row.purged_at);
  assert.equal(row.purged_bytes, m.size);
  // idempotent: a second run does not count it again
  assert.ok(!(await R().run({ now: later(32 * MIN) })).purged.some((p) => p.media_id === m.id));
  // /m/ URLs: original is 410 Gone, the thumbnail is still served
  const orig = await fetch(`${app.base}/m/${m.token}/${m.filename}`);
  assert.equal(orig.status, 410);
  assert.equal((await fetch(`${app.base}/m/${m.token}/${m.poster}`)).status, 200);
  assert.equal((await fetch(`${app.base}/m/${m.token}/${m.filename}`, { method: 'HEAD' })).status, 410);
  // UI/API data: published links per target, media marked purged with its thumbnail, no original URL
  const post = (await app.api('GET', `/posts/${g.id}`, { key })).json.post;
  assert.equal(post.targets.length, 2);
  for (const t of post.targets) assert.match(t.published_url, /^https?:\/\//);
  assert.equal(post.media[0].purged, true);
  assert.equal(post.media[0].url, null);
  assert.match(post.media[0].poster, /\.thumb\.jpg$/);
  const got = (await app.api('GET', `/media/${m.id}`, { key })).json.media;
  assert.equal(got.public_url, null);
  assert.equal(got.purged_bytes, m.size);
  // calendar + list carry the same data
  const cal = (await app.api('GET', `/calendar?from=${Date.now() - DAY}&to=${Date.now() + DAY}`, { key })).json.entries.filter((e) => e.group_id === g.id);
  assert.equal(cal.length, 2);
  assert.ok(cal.every((e) => e.published_url && e.media[0].purged && e.media[0].poster));
  const list = (await app.api('GET', '/posts?limit=200', { key })).json.posts.find((p) => p.id === g.id);
  assert.ok(list.targets.every((t) => t.published_url));
});

test('never purged while ANY referencing target is draft / pending approval / scheduled / publishing / retrying', async () => {
  const m = await media('image');
  await publish([fb], [m]);
  const now = later(31 * MIN);
  assert.ok(await isEligible(m.id, now));
  // a second post (another group) reuses the same media and is scheduled for tomorrow
  const g2 = await app.core.posts.saveGroup({ content: 'reuse', media: [m.id], action: 'schedule', publish_at: Date.now() + DAY, posts: [{ integration_id: ig }] });
  assert.equal(await keptReason(m.id, now), 'used by a scheduled post');
  const t2 = (await app.core.posts.getGroup(g2)).targets[0].id;
  for (const [status, job, want] of [
    ['draft', null, 'used by a draft'],
    ['pending_approval', null, 'used by a post awaiting approval'],
    ['publishing', 'queued', /publishing/],
    ['failed', 'queued', 'a failed post using it will be retried'],
    ['failed', 'dead', /failed recently; kept for retries until/],
  ]) {
    await sys('UPDATE posts SET status = ?, updated_at = ? WHERE id = ?', status, Date.now(), t2);
    if (job) await sys("INSERT INTO jobs(post_id, state, run_at, phase, attempts, created_at, updated_at) VALUES(?, ?, ?, 'start', 1, ?, ?) ON CONFLICT(post_id) DO UPDATE SET state = excluded.state", t2, job, Date.now() + DAY, Date.now(), Date.now());
    else await sys('DELETE FROM jobs WHERE post_id = ?', t2);
    const reason = await keptReason(m.id, now);
    if (want instanceof RegExp) assert.match(reason || '', want, status); else assert.equal(reason, want, status);
    assert.ok(await R().blockedNow(m.id, now), `${status}: re-check before delete also blocks`);
    const r = await R().run({ now });
    assert.ok(!r.purged.some((p) => p.media_id === m.id), `${status} must block`);
    assert.ok(fs.existsSync(file(m)));
  }
  // a permanently failed target older than the retry window no longer blocks (published one did go live)
  assert.ok(await isEligible(m.id, later(25 * 3600000)), 'failed + dead job + 24 h → finished');
  // deleting the blocking post frees it right away (after the window)
  await app.core.posts.deleteGroup(g2);
  assert.ok((await R().run({ now })).purged.some((p) => p.media_id === m.id));
});

test('media that never went live is never deleted (library uploads, drafts, only-failed posts)', async () => {
  const lib = await media('image');
  assert.equal(await keptReason(lib.id, later(400 * DAY)), 'not used by any post (library upload)');
  const m = await media('image');
  const gid = await app.core.posts.saveGroup({ content: 'x', media: [m.id], action: 'draft', posts: [{ integration_id: fb }] });
  const t = (await app.core.posts.getGroup(gid)).targets[0].id;
  await sys("UPDATE posts SET status = 'failed', updated_at = ? WHERE id = ?", Date.now() - 3 * DAY, t);
  assert.equal(await keptReason(m.id, later(400 * DAY)), 'never published (its posts only failed)');
});

test('Instagram: kept while the container is IN_PROGRESS (Meta still fetching /m/), purged only after FINISHED + publish + grace', async () => {
  const v = await media('video');
  app.fake.state.inProgressPolls = 1000;
  const gid = await app.core.posts.saveGroup({ content: 'reel', media: [v.id], action: 'now', posts: [{ integration_id: ig }] });
  const tid = (await app.core.posts.getGroup(gid)).targets[0].id;
  await waitFor(async () => { await app.core.scheduler.tick(); return (await app.root.db.get("SELECT phase FROM jobs WHERE post_id = ? AND phase = 'check' /* ws:system */", tid)); });
  assert.match(await keptReason(v.id, later(DAY)), /publishing/);
  assert.equal((await R().run({ now: later(DAY) })).purged.some((p) => p.media_id === v.id), false);
  assert.equal((await fetch(`${app.base}/m/${v.token}/${v.filename}`, { method: 'HEAD' })).status, 200, 'Meta can still fetch it');
  app.fake.state.inProgressPolls = 0;
  const t = (await settle(app.core, gid)).targets[0];
  assert.equal(t.status, 'published', t.error);
  assert.match(await keptReason(v.id, Date.now() + 10 * MIN), /safety window/);
  assert.ok((await R().run({ now: t.published_at + 31 * MIN })).purged.some((p) => p.media_id === v.id));
  app.fake.state.inProgressPolls = 1;
});

test('YouTube: kept while a resumable upload session is in progress; a purged video cannot be streamed', async () => {
  const v = await media('video');
  const gid = await app.core.posts.saveGroup({ content: 'yt', media: [v.id], action: 'schedule', publish_at: Date.now() + DAY, posts: [{ integration_id: yt, settings: { title: 'Session test' } }] });
  const tid = (await app.core.posts.getGroup(gid)).targets[0].id;
  // the state a YouTube upload persists between steps: post publishing, job in 'check' with the session URI + offset
  await sys("UPDATE posts SET status = 'publishing' WHERE id = ?", tid);
  await sys("UPDATE jobs SET phase = 'check', pending_data = ?, run_at = ? WHERE post_id = ?", JSON.stringify({ session: `${app.fake.base || 'http://fake'}/upload/session/1`, uploaded: 262144 }), Date.now() + DAY, tid);
  assert.match(await keptReason(v.id, later(30 * DAY)), /publishing/);
  // another, already-published post with the same video does not unblock it
  await publish([fb], [v]);
  assert.match(await keptReason(v.id, later(30 * DAY)), /publishing/);
  // upload finished → published
  await sys("UPDATE posts SET status = 'published', published_at = ?, published_url = 'https://www.youtube.com/watch?v=x' WHERE id = ?", Date.now(), tid);
  await sys("UPDATE jobs SET state = 'done', pending_data = NULL WHERE post_id = ?", tid);
  assert.ok((await R().run({ now: later(31 * MIN) })).purged.some((p) => p.media_id === v.id));
  const row = await app.core.media.get(v.id);
  await assert.rejects(() => app.core.media.open(row, 0, 10), (e) => e.status === 410);
});

test('settings: Never keeps everything; 7 days waits a week; per-workspace API with admin scope', async () => {
  const a = await media('image');
  await publish([fb], [a]);
  let r = await app.api('PATCH', '/storage', { key: writeKey, body: { delete_media_after: 'never' } });
  assert.equal(r.status, 403, 'admin scope required');
  r = await app.api('PATCH', '/storage', { key, body: { delete_media_after: 'never' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.storage.delete_media_after, 'never');
  assert.equal(await keptReason(a.id, later(400 * DAY)), 'workspace setting: never delete');
  assert.equal((await R().run({ now: later(400 * DAY) })).files, 0);
  await app.api('PATCH', '/storage', { key, body: { delete_media_after: '7d' } });
  assert.match(await keptReason(a.id, later(DAY)), /setting: keep 7 days after publishing/);
  assert.equal((await R().run({ now: later(6 * DAY) })).purged.some((p) => p.media_id === a.id), false);
  assert.ok((await R().run({ now: later(8 * DAY) })).purged.some((p) => p.media_id === a.id));
  await app.api('PATCH', '/storage', { key, body: { delete_media_after: '30d' } });
  const b = await media('image');
  await publish([fb], [b]);
  assert.equal(await isEligible(b.id, later(29 * DAY)), false);
  assert.equal(await isEligible(b.id, later(31 * DAY)), true);
  assert.equal((await app.api('PATCH', '/storage', { key, body: { delete_media_after: 'sometimes' } })).status, 400);
  await app.api('PATCH', '/storage', { key, body: { delete_media_after: 'immediate' } });
  const s = (await app.api('GET', '/storage', { key: writeKey })).json.storage;
  assert.equal(s.delete_media_after, 'immediate');
  assert.ok(s.freed_bytes > 0 && s.purged_files > 0 && s.used_bytes > 0);
  assert.equal(s.options.length, 4);
});

test('clean up now (write scope): dry run changes nothing, then purges what is eligible; audit has counts and bytes only', async () => {
  const m = await media('image');
  const g = await publish([fb], [m]);
  // make it eligible by moving the publish time back past the safety window
  await sys('UPDATE posts SET published_at = ? WHERE group_id = ?', Date.now() - 40 * MIN, g.id);
  const dry = await app.api('POST', '/storage/cleanup', { key: writeKey, body: { dry_run: true } });
  assert.equal(dry.status, 200, dry.text);
  assert.ok(dry.json.report.eligible.some((e) => e.media_id === m.id));
  assert.equal(dry.json.report.purged_files, 0);
  assert.ok(fs.existsSync(file(m)));
  assert.equal((await app.core.media.get(m.id)).purged_at, null);
  assert.ok(dry.json.report.kept.every((k) => k.reason && k.media_id));
  const real = await app.api('POST', '/storage/cleanup', { key: writeKey, body: {} });
  assert.equal(real.status, 200, real.text);
  assert.ok(real.json.report.purged.some((p) => p.media_id === m.id));
  assert.ok(!fs.existsSync(file(m)));
  const entry = (await app.core.audit.list({ limit: 20 })).find((e) => e.operation === 'media_purge');
  assert.ok(entry, 'purge logged');
  assert.deepEqual(Object.keys(entry.detail).sort(), ['bytes', 'files']);
  assert.equal(entry.detail.files, real.json.report.purged_files);
});

test('duplicate with purged media → draft with a re-upload placeholder; scheduling it or retrying a failed target gives an actionable 409', async () => {
  const m = await media('image');
  const g = await publish([fb], [m]);
  await R().run({ now: later(31 * MIN) });
  assert.ok((await app.core.media.get(m.id)).purged_at);
  const dup = await app.api('POST', `/posts/${g.id}/duplicate`, { key });
  assert.equal(dup.status, 200, dup.text);
  assert.equal(dup.json.post.status, 'draft');
  assert.deepEqual(dup.json.needs_reupload.map((x) => x.media_id), [m.id]);
  assert.equal(dup.json.post.media[0].purged, true);
  assert.ok(dup.json.post.media[0].poster, 'the placeholder still shows the thumbnail');
  const sched = await app.api('POST', `/posts/${dup.json.post.id}/schedule`, { key, body: { publish_at: Date.now() + DAY } });
  assert.equal(sched.status, 409, sched.text);
  assert.match(sched.json.error.message, /deleted after publishing.*Re-upload/s);
  // re-upload → update the draft → schedulable
  const fresh = await media('image');
  const upd = await app.api('PATCH', `/posts/${dup.json.post.id}`, { key, body: { media_ids: [fresh.id], mode: 'schedule', publish_at: Date.now() + DAY } });
  assert.equal(upd.status, 200, upd.text);
  // a failed target whose media is already purged (the other target was published)
  const m2 = await media('image');
  const g2 = await publish([fb, ig], [m2]);
  const igT = g2.targets.find((t) => t.integration_id === ig);
  await sys("UPDATE posts SET status = 'failed', error = 'boom', updated_at = ? WHERE id = ?", Date.now() - 2 * DAY, igT.id);
  await sys("UPDATE jobs SET state = 'dead' WHERE post_id = ?", igT.id);
  assert.ok((await R().run({ now: later(31 * MIN) })).purged.some((p) => p.media_id === m2.id));
  const retry = await app.api('POST', `/posts/${g2.id}/retry`, { key, body: {} });
  assert.equal(retry.status, 200);
  assert.match(retry.json.results[0].error, /Cannot retry: the original file .* deleted after publishing.*Duplicate the post, re-upload/s);
});

test('workspaces are isolated: settings, stats and cleanup only touch their own media', async () => {
  const wsB = await app.root.workspaces.create('bob');
  const sb = app.root.scope(wsB);
  const bFb = await sb.integrations.upsert('facebook', { external_id: 'page-bob', name: 'Bob Page', access_token: 'page1-token', refresh_token: 'user-long' });
  const bKey = (await sb.apiKeys.create({ name: 'bob', scopes: ['read', 'write', 'publish', 'admin'], approval_mode: false })).key;
  const bm = await sb.media.save(new Uint8Array(makeJpeg(800, 800, 5000)), 'bob.jpg');
  await sb.media.setPoster(bm.id, makeJpeg(200, 200));
  await settle(sb, await sb.posts.saveGroup({ content: 'bob', media: [bm.id], action: 'now', posts: [{ integration_id: bFb }] }));
  const am = await media('image');
  await publish([fb], [am]);
  // Bob chooses Never; Alice (owner) stays on immediate
  assert.equal((await app.api('PATCH', '/storage', { key: bKey, body: { delete_media_after: 'never' } })).status, 200);
  assert.equal((await app.api('GET', '/storage', { key })).json.storage.delete_media_after, 'immediate');
  // Alice's cleanup never sees Bob's media
  const plan = await R().plan({ now: later(DAY) });
  assert.ok(![...plan.eligible, ...plan.kept].some((x) => x.media_id === bm.id));
  const all = await app.root.purgeMedia({ dryRun: true });
  const bobReport = all.find((r) => r.workspace_id === wsB);
  assert.equal(bobReport.kept.find((k) => k.media_id === bm.id).reason, 'workspace setting: never delete');
  assert.equal((await app.api('GET', `/media/${am.id}`, { key: bKey })).status, 404);
  // Bob's cleanup-now cannot purge Alice's eligible media
  await sys("UPDATE posts SET published_at = ? WHERE status = 'published'", Date.now() - DAY);
  const bRun = await app.api('POST', '/storage/cleanup', { key: bKey, body: {} });
  assert.equal(bRun.json.report.purged_files, 0);
  assert.ok(fs.existsSync(file(am)));
  const bStats = (await app.api('GET', '/storage', { key: bKey })).json.storage;
  assert.equal(bStats.files, 1);
  assert.equal(bStats.used_bytes, bm.size);
});

test('the scheduler loop purges eligible media on its own (Node) and can move originals to a trash dir', async () => {
  const app2 = await createTestApp({ env: { MEDIA_PURGE_GRACE_MINUTES: '0', MEDIA_PURGE_INTERVAL_MINUTES: '0.001', MEDIA_PURGE_TRASH_DIR: 'uploads-trash-test' } });
  try {
    const f = await app2.seed('facebook');
    const m = await app2.upload(makeJpeg(1080, 1080, 9000), 'loop.jpg');
    await app2.core.media.setPoster(m.id, makeJpeg(200, 200));
    await app2.core.posts.saveGroup({ content: 'loop', media: [m.id], action: 'now', posts: [{ integration_id: f }] });
    await app2.core.scheduler.drain(15000);
    await waitFor(async () => { await app2.core.scheduler.tick(); return (await app2.core.media.get(m.id)).purged_at; });
    const trashed = path.join(app2.cfg.dataDir, 'uploads-trash-test', m.filename);
    assert.ok(fs.existsSync(trashed), 'original moved into the trash dir');
    assert.equal(fs.statSync(trashed).size, m.size);
    assert.ok(!fs.existsSync(path.join(app2.cfg.uploadDir, m.filename)));
    assert.ok(fs.existsSync(path.join(app2.cfg.uploadDir, `${m.id}.thumb.jpg`)), 'thumbnail stays');
    const e = (await app2.core.audit.list({ limit: 10 })).find((x) => x.operation === 'media_purge');
    assert.equal(e.actor_type, 'system');
    assert.deepEqual(e.detail, { files: 1, bytes: m.size });
  } finally {
    await app2.close();
  }
});

test('Node + ffmpeg: an image without a thumbnail gets a ≤480 px JPEG preview before its original is deleted; without ffmpeg it waits', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
  const app3 = await createTestApp({ env: { FFMPEG_PATH: FFMPEG, MEDIA_PURGE_INTERVAL_MINUTES: '100000' } });
  try {
    const f = await app3.seed('facebook');
    const src = path.join(app3.dir, 'real.jpg');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1600x1200', '-frames:v', '1', src]);
    const m = await app3.upload(fs.readFileSync(src), 'real.jpg');
    assert.equal(m.poster, null);
    const gid = await app3.core.posts.saveGroup({ content: 'img', media: [m.id], action: 'now', posts: [{ integration_id: f }] });
    await settle(app3.core, gid, app3.root.scheduler);
    const dry = await app3.core.retention.run({ dryRun: true, now: later(31 * MIN) });
    assert.equal(dry.eligible.find((e) => e.media_id === m.id).preview, 'generate');
    const r = await app3.core.retention.run({ now: later(31 * MIN) });
    assert.ok(r.purged.some((x) => x.media_id === m.id), JSON.stringify(r.kept));
    const row = await app3.core.media.get(m.id);
    assert.equal(row.poster, `${m.id}.thumb.jpg`);
    const thumb = fs.readFileSync(path.join(app3.cfg.uploadDir, row.poster));
    const { imageSize } = await import('../src/probe.js');
    const dim = imageSize(new Uint8Array(thumb), 'image/jpeg');
    assert.equal(Math.max(dim.width, dim.height), 480);
    assert.ok(thumb.length < m.size);
    // without ffmpeg (Workers / bare Node) an image lacking a thumbnail is kept until the browser uploads one
    app3.cfg.ffmpegPath = '';
    const n = await app3.upload(makeJpeg(1080, 1080, 5000), 'nothumb.jpg');
    await settle(app3.core, await app3.core.posts.saveGroup({ content: 'img2', media: [n.id], action: 'now', posts: [{ integration_id: f }] }), app3.root.scheduler);
    assert.match((await app3.core.retention.plan({ now: later(31 * MIN) })).kept.find((k) => k.media_id === n.id).reason, /waiting for a preview thumbnail/);
  } finally {
    await app3.close();
  }
});
