// Video thumbnails: stored posters, the poster endpoint (client-generated frames), platform thumbnails
// for analytics posts, and a static check that the UI never renders a <video> without a poster path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestApp, makeJpeg, makeMp4 } from './helpers.js';

let app, key, fb, ig, yt;
before(async () => {
  app = await createTestApp();
  fb = await app.seed('facebook');
  ig = await app.seed('instagram');
  yt = await app.seed('youtube');
  key = (await app.core.apiKeys.create({ name: 'thumbs', scopes: ['read', 'write', 'analytics'], approval_mode: false })).key;
});
after(async () => { await app.close(); });

test('poster endpoint: a client-generated JPEG becomes the video poster (REST + MCP schema)', async () => {
  const vid = await app.upload(makeMp4({ seconds: 8 }), 'clip.mp4');
  assert.equal(vid.poster, null, 'no ffmpeg in tests → no server-side poster');
  const jpg = makeJpeg(640, 360);
  const r = await app.api('POST', `/media/${vid.id}/poster`, { key, body: { data: `data:image/jpeg;base64,${jpg.toString('base64')}` } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.media.poster, new RegExp(`^/m/${vid.token}/${vid.id}\\.poster\\.jpg$`));
  const img = await fetch(`${app.base}${r.json.media.poster}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await img.arrayBuffer()).length, jpg.length);
  // listed with the poster everywhere media is returned
  const list = await app.api('GET', '/media', { key });
  assert.equal(list.json.media.find((m) => m.id === vid.id).poster, r.json.media.poster);
  // an existing poster is kept unless replace=true
  const other = makeJpeg(320, 180);
  await app.api('POST', `/media/${vid.id}/poster`, { key, body: { data: other.toString('base64') } });
  assert.equal(Buffer.from(await (await fetch(`${app.base}${r.json.media.poster}`)).arrayBuffer()).length, jpg.length);
  const rep = await app.api('POST', `/media/${vid.id}/poster`, { key, body: { data: other.toString('base64'), replace: true } });
  assert.equal(rep.status, 200);
  assert.equal(Buffer.from(await (await fetch(`${app.base}${r.json.media.poster}`)).arrayBuffer()).length, other.length);
});

test('poster endpoint rejects non-JPEG data, documents, oversized image thumbnails and unknown media', async () => {
  const vid = await app.upload(makeMp4({ seconds: 5 }), 'b.mp4');
  const png = await app.api('POST', `/media/${vid.id}/poster`, { key, body: { data: Buffer.from('89504e470d0a1a0a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000', 'hex').toString('base64') } });
  assert.equal(png.status, 415);
  const image = await app.upload(makeJpeg(100, 100), 'i.jpg');
  // images accept a small JPEG thumbnail (kept after the original is deleted post-publishing)
  assert.equal((await app.api('POST', `/media/${image.id}/poster`, { key, body: { data: makeJpeg(2000, 2000).toString('base64') } })).status, 400);
  const thumb = await app.api('POST', `/media/${image.id}/poster`, { key, body: { data: makeJpeg(100, 100).toString('base64') } });
  assert.equal(thumb.status, 200, thumb.text);
  assert.match(thumb.json.media.poster, /\.thumb\.jpg$/);
  assert.equal((await app.api('POST', '/media/nope/poster', { key, body: { data: makeJpeg(10, 10).toString('base64') } })).status, 404);
});

test('analytics posts carry platform thumbnails: YouTube hqdefault, Facebook video frames, Instagram reels', async () => {
  // one post per platform through postlite so analytics also tracks "our" posts (no thumbnail in the list)
  const img = await app.upload(makeJpeg(1080, 1080), 'a.jpg');
  const vid = await app.upload(makeMp4({ seconds: 20 }), 'v.mp4');
  await app.core.posts.saveGroup({ content: 'tracked', media: [img.id], action: 'now', posts: [{ integration_id: fb }, { integration_id: ig }] });
  await app.core.posts.saveGroup({ content: 'yt', media: [vid.id], action: 'now', posts: [{ integration_id: yt, settings: { title: 'Tracked video' } }] });
  await app.core.scheduler.drain();
  await app.core.analytics.syncAll();
  const top = (await app.api('GET', '/analytics/top-posts?limit=100', { key })).json.posts;
  const by = (id) => top.find((p) => p.external_id === id);
  assert.equal(by('oldvid1').thumbnail, 'https://i.ytimg.com/vi/oldvid1/hqdefault.jpg', 'YouTube video without snippet thumbnails');
  assert.equal(by('page1_900').thumbnail, 'https://example.invalid/fb900.jpg');
  assert.equal(by('page1_901').thumbnail, 'https://example.invalid/fb901.jpg', 'Facebook reel: attachment frame when full_picture is empty');
  assert.equal(by('igold1').thumbnail, 'https://example.invalid/t.jpg', 'Instagram reel thumbnail_url');
  for (const p of top) assert.ok(p.thumbnail, `${p.provider} ${p.external_id} has a thumbnail`);
  const ytOurs = top.find((p) => p.provider === 'youtube' && p.via_postlite);
  assert.match(ytOurs.thumbnail, /^https:\/\/i\.ytimg\.com\/vi\/.+\/hqdefault\.jpg$/);
});

test('UI: no <video> is rendered outside the poster-aware helper', () => {
  const dir = path.join(import.meta.dirname, '..', 'public', 'js');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'media.js')) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/h\(\s*'video'/.test(src) && !/createElement\(\s*'video'/.test(src), `${f} renders a <video> directly; use mediaVisual() from media.js`);
  }
  const media = fs.readFileSync(path.join(dir, 'media.js'), 'utf8');
  assert.match(media, /poster: md\.poster/, 'stored poster used as the video poster attribute');
  assert.match(media, /#t=0\.5/, 'last fallback: first frame via #t=0.5');
  assert.match(media, /preload: md\.poster \? 'none' : 'metadata'/);
  assert.match(media, /\/media\/\$\{md\.id\}\/poster/, 'client-generated posters are uploaded');
  for (const f of ['posts.js', 'calendar.js', 'composer.js', 'views.js']) assert.match(fs.readFileSync(path.join(dir, f), 'utf8'), /from '\.\/media\.js'/, `${f} uses the media helper`);
});
