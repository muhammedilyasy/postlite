import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeJpeg, makeMp4, makePng, waitFor } from './helpers.js';

let app;
before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

async function publish(integrationId, { content = 'Hello', media = [], settings = {} } = {}) {
  const gid = await app.core.posts.saveGroup({ content, media: media.map((m) => m.id), action: 'now', posts: [{ integration_id: integrationId, settings }] });
  await app.core.scheduler.drain(15000);
  return (await app.core.posts.getGroup(gid)).targets[0];
}

test('facebook: text + link post', async () => {
  const fb = await app.seed('facebook');
  const t = await publish(fb, { content: 'Read this', settings: { url: 'https://example.com/a' } });
  assert.equal(t.status, 'published', t.error);
  assert.match(t.published_url, /facebook\.com\/page1\/posts/);
  const pub = app.fake.state.published.at(-1);
  assert.equal(pub.kind, 'link');
  assert.equal(pub.data.link, 'https://example.com/a');
});

test('facebook: multi-photo post uploads unpublished photos then one feed post', async () => {
  const fb = await app.seed('facebook');
  const a = await app.upload(makeJpeg(1200, 800), 'a.jpg');
  const b = await app.upload(makePng(800, 800), 'b.png');
  const before = app.fake.state.calls.length;
  const t = await publish(fb, { content: 'Album', media: [a, b] });
  assert.equal(t.status, 'published', t.error);
  const calls = app.fake.state.calls.slice(before);
  const photos = calls.filter((c) => c.path.endsWith('/page1/photos'));
  assert.equal(photos.length, 2);
  assert.ok(photos.every((c) => c.body.published === false));
  const feed = calls.filter((c) => c.path.endsWith('/page1/feed'));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].body.attached_media.length, 2);
  // Meta fetched our public tokenized media URLs
  assert.ok(app.fake.state.fetchedMedia.some((u) => u.includes(`/m/`) && u.endsWith('.jpg')));
});

test('facebook: video post, reel and story; first comment', async () => {
  const fb = await app.seed('facebook');
  const v = await app.upload(makeMp4({ seconds: 20 }), 'v.mp4');
  const t1 = await publish(fb, { content: 'Video', media: [v], settings: { title: 'My video', first_comment: 'first!' } });
  assert.equal(t1.status, 'published', t1.error);
  assert.ok(app.fake.state.calls.some((c) => c.path.endsWith(`/${t1.external_id}/comments`)));
  const t2 = await publish(fb, { content: 'Reel', media: [v], settings: { post_type: 'reel' } });
  assert.equal(t2.status, 'published', t2.error);
  assert.match(t2.published_url, /facebook\.com\/reel\//);
  assert.ok(app.fake.state.published.some((p) => p.kind === 'reel' && p.data.video_state === 'PUBLISHED'));
  const img = await app.upload(makeJpeg(), 's.jpg');
  const t3 = await publish(fb, { media: [img, v], settings: { post_type: 'story' } });
  assert.equal(t3.status, 'published', t3.error);
  const stories = app.fake.state.published.filter((p) => p.kind === 'photo_story' || p.kind === 'video_story');
  assert.equal(stories.length, 2);
});

test('instagram (FB login): single image, reel, carousel with polling, story', async () => {
  const ig = await app.seed('instagram');
  const img = await app.upload(makeJpeg(1080, 1350), 'p.jpg');
  const vid = await app.upload(makeMp4({ seconds: 30 }), 'r.mp4');
  app.fake.state.inProgressPolls = 2;
  const t1 = await publish(ig, { content: 'Hi #test', media: [img], settings: { collaborators: ['@friend'] } });
  assert.equal(t1.status, 'published', t1.error);
  assert.match(t1.published_url, /instagram\.com\/p\//);
  const created = app.fake.state.calls.filter((c) => c.path.endsWith('/ig1/media') && c.method === 'POST').at(-1);
  assert.equal(created.body.collaborators, '["friend"]', 'leading @ stripped');
  const t2 = await publish(ig, { content: 'Reel', media: [vid] });
  assert.equal(t2.status, 'published', t2.error);
  assert.equal(app.fake.state.published.at(-1).kind, 'REELS');
  const t3 = await publish(ig, { content: 'Carousel', media: [img, vid, img] });
  assert.equal(t3.status, 'published', t3.error);
  const car = app.fake.state.published.at(-1);
  assert.equal(car.kind, 'CAROUSEL');
  assert.equal(car.data.children.length, 3);
  const t4 = await publish(ig, { media: [img, vid], settings: { post_type: 'story' } });
  assert.equal(t4.status, 'published', t4.error);
  const statusPolls = app.fake.state.calls.filter((c) => c.query.fields === 'status_code,status');
  assert.ok(statusPolls.length >= 6, 'container status was polled');
  app.fake.state.inProgressPolls = 1;
});

test('instagram: container ERROR is a permanent failure with a clear message', async () => {
  const ig = await app.seed('instagram');
  const vid = await app.upload(makeMp4({ seconds: 10 }), 'bad.mp4');
  app.fake.state.containerError = '2207026';
  const t = await publish(ig, { content: 'x', media: [vid] });
  app.fake.state.containerError = null;
  assert.equal(t.status, 'failed');
  assert.match(t.error, /Unsupported video format/);
  assert.equal(t.attempts, 0, 'permanent errors are not retried');
});

test('instagram standalone uses graph.instagram.com host', async () => {
  const igs = await app.seed('instagram-standalone');
  const img = await app.upload(makeJpeg(1080, 1080), 'q.jpg');
  const before = app.fake.state.calls.length;
  const t = await publish(igs, { content: 'standalone', media: [img] });
  assert.equal(t.status, 'published', t.error);
  const calls = app.fake.state.calls.slice(before);
  assert.ok(calls.some((c) => c.path === '/ig/v25.0/igs1/media'));
  assert.ok(calls.some((c) => c.path === '/ig/v25.0/igs1/media_publish'));
  assert.ok(!calls.some((c) => c.path.startsWith('/fb/')));
});

test('youtube: resumable upload in chunks, metadata, thumbnail; refresh on expiry', async () => {
  const yt = await app.seed('youtube', { access_token: 'ya29.expired', token_expires_at: Date.now() - 1000 });
  const vid = await app.upload(makeMp4({ width: 1080, height: 1920, seconds: 40, mdatBytes: 700000 }), 'short.mp4');
  const thumb = await app.upload(makeJpeg(1280, 720), 'thumb.jpg');
  app.fake.state.ytChunkFailOnce = true; // transient 503 mid-upload → retried, resumes from probe offset
  const t = await publish(yt, { content: 'Desc', media: [vid], settings: { title: 'My Short', privacy: 'unlisted', isShort: true, tags: ['a b', 'c'], notifySubscribers: false, thumbnail: thumb.id } });
  assert.equal(t.status, 'published', t.error);
  assert.match(t.published_url, /youtube\.com\/watch\?v=vid_/);
  const up = Object.values(app.fake.state.uploads).at(-1);
  assert.equal(up.received, up.size);
  assert.ok(up.chunks >= 3, 'uploaded in multiple chunks');
  assert.equal(up.meta.snippet.title, 'My Short');
  assert.deepEqual(up.meta.snippet.tags, ['a b', 'c']);
  assert.equal(up.meta.status.privacyStatus, 'unlisted');
  assert.equal(up.meta.notifySubscribers, 'false');
  assert.ok(app.fake.state.published.some((p) => p.kind === 'thumbnail' && p.id === t.external_id));
  assert.ok(app.fake.state.calls.some((c) => c.path === '/gtoken/token' && c.body.grant_type === 'refresh_token'), 'token refreshed before use');
  assert.equal(t.attempts, 1, 'one transient retry recorded');
});

test('youtube: revoked refresh token marks account needs_reconnect', async () => {
  const yt = await app.seed('youtube', { external_id: 'UC1', access_token: 'ya29.x', token_expires_at: Date.now() - 1000 });
  const vid = await app.upload(makeMp4({ seconds: 5 }), 'v.mp4');
  app.fake.state.googleRefreshInvalid = true;
  const t = await publish(yt, { content: 'd', media: [vid], settings: { title: 'Title' } });
  app.fake.state.googleRefreshInvalid = false;
  assert.equal(t.status, 'failed');
  assert.match(t.error, /reconnect/i);
  assert.equal((await app.core.integrations.get(yt)).status, 'needs_reconnect');
});

test('facebook: revoked token → needs_reconnect, no retry', async () => {
  const fb = await app.seed('facebook', { external_id: 'page2', name: 'Second Page', access_token: 'page2-token' });
  app.fake.state.revoked.add('page2-token');
  const t = await publish(fb, { content: 'x' });
  app.fake.state.revoked.delete('page2-token');
  assert.equal(t.status, 'failed');
  assert.equal((await app.core.integrations.get(fb)).status, 'needs_reconnect');
  assert.equal(t.attempts, 0);
});
