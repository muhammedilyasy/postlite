import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePost, youtubeTagsLength, describeKind } from '../src/shared/validate.js';
import { sniffMime, imageSize, probeMp4 } from '../src/probe.js';
import { makeJpeg, makeMp4, makePng } from './helpers.js';
import { classifyInstagram, classifyFacebook } from '../src/providers/meta-errors.js';
import { classifyGoogle } from '../src/providers/youtube.js';
import { makeCipher, hashPasswordPbkdf2, verifyPasswordPbkdf2 } from '../src/crypto.js';
import { hashPassword, verifyPassword } from '../src/node/core.js';
import { zonedToUtc, parseLocal, nextSlots, formatLocal } from '../src/shared/time.js';
import { validate } from '../src/api/schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const img = (w = 1080, h = 1080, extra = {}) => ({ kind: 'image', mime: 'image/jpeg', size: 200000, width: w, height: h, name: 'i.jpg', ...extra });
const vid = (w = 1080, h = 1920, duration = 30, extra = {}) => ({ kind: 'video', mime: 'video/mp4', size: 5e6, width: w, height: h, duration, name: 'v.mp4', ...extra });

test('youtube rules', async () => {
  assert.deepEqual(validatePost('youtube', { caption: 'd', media: [vid()], settings: { title: 'Good title' } }).errors, []);
  assert.match(validatePost('youtube', { media: [img()], settings: { title: 'x y' } }).errors.join(), /exactly one video/);
  assert.match(validatePost('youtube', { media: [vid()], settings: { title: 'x' } }).errors.join(), /title is required/);
  assert.match(validatePost('youtube', { media: [vid()], settings: { title: 'a'.repeat(101) } }).errors.join(), /100/);
  assert.match(validatePost('youtube', { caption: 'a <b>', media: [vid()], settings: { title: 'ok title' } }).errors.join(), /"<"/);
  assert.match(validatePost('youtube', { media: [vid(1920, 1080, 30)], settings: { title: 'ok', isShort: true } }).errors.join(), /vertical/);
  assert.match(validatePost('youtube', { media: [vid(1080, 1920, 200)], settings: { title: 'ok', isShort: true } }).errors.join(), /3 minutes/);
  assert.equal(youtubeTagsLength(['a b', 'cd']), 3 + 2 + 2);
  assert.match(validatePost('youtube', { media: [vid()], settings: { title: 'ok', tags: Array(60).fill('abcdefghi') } }).errors.join(), /500/);
  assert.match(validatePost('youtube', { caption: 'x'.repeat(5001), media: [vid()], settings: { title: 'ok' } }).errors.join(), /5000/);
  assert.match(validatePost('youtube', { media: [vid()], settings: { title: 'ok' }, thumbnail: img(1280, 720, { mime: 'image/gif' }) }).errors.join(), /JPEG or PNG/);
});

test('facebook rules', async () => {
  assert.deepEqual(validatePost('facebook', { caption: 'hello' }).errors, []);
  assert.match(validatePost('facebook', { caption: '' }).errors.join(), /needs text/);
  assert.match(validatePost('facebook', { media: [img(), vid()] }).errors.join(), /mix/);
  assert.match(validatePost('facebook', { media: Array(11).fill(img()) }).errors.join(), /10 photos/);
  assert.match(validatePost('facebook', { media: [img(1000, 1000, { size: 5e6 })] }).errors.join(), /4 MB/);
  assert.match(validatePost('facebook', { media: [vid(1080, 1920, 120)], settings: { post_type: 'reel' } }).errors.join(), /3–90/);
  assert.deepEqual(validatePost('facebook', { media: [vid(1080, 1920, 30)], settings: { post_type: 'reel' } }).errors, []);
  assert.match(validatePost('facebook', { settings: { post_type: 'story' } }).errors.join(), /at least one/);
  assert.match(validatePost('facebook', { caption: 'x', settings: { url: 'not a url' } }).errors.join(), /valid http/);
  assert.match(validatePost('facebook', { caption: 'x'.repeat(63207) }).errors.join(), /63206/);
});

test('instagram rules', async () => {
  for (const p of ['instagram', 'instagram-standalone']) {
    assert.deepEqual(validatePost(p, { caption: 'hi', media: [img(1080, 1350)] }).errors, []);
    assert.match(validatePost(p, { caption: 'hi' }).errors.join(), /at least one/);
    assert.match(validatePost(p, { media: Array(11).fill(img()) }).errors.join(), /up to 10/);
    assert.match(validatePost(p, { media: [img(1080, 2000)] }).errors.join(), /4:5 and 1.91:1/);
    assert.deepEqual(validatePost(p, { media: [img(1080, 2000)], settings: { post_type: 'story' } }).errors, [], 'stories are exempt from feed ratio');
    assert.match(validatePost(p, { media: [img(1080, 1080, { mime: 'image/png' })] }).errors.join(), /JPEG/);
    assert.match(validatePost(p, { caption: Array(31).fill('#tag').join(' '), media: [img()] }).errors.join(), /30 hashtags/);
    assert.match(validatePost(p, { caption: Array(21).fill('@user').join(' '), media: [img()] }).errors.join(), /20 @mentions/);
    assert.match(validatePost(p, { caption: 'x'.repeat(2201), media: [img()] }).errors.join(), /2200/);
    assert.match(validatePost(p, { media: [img()], settings: { collaborators: ['a', 'b', 'c', 'd'] } }).errors.join(), /3 collaborators/);
    assert.match(validatePost(p, { media: [img(), vid(1080, 1920, 90)] }).errors.join(), /Carousel videos/);
    assert.match(validatePost(p, { media: [vid(1080, 1920, 16 * 60)] }).errors.join(), /Reel videos/);
    assert.match(validatePost(p, { media: [img(), img()], settings: { is_trial_reel: true } }).errors.join(), /Trial Reels/);
  }
  assert.equal(describeKind('instagram', [img(), img()], {}), 'Carousel (2)');
  assert.equal(describeKind('instagram', [vid()], {}), 'Reel');
});

test('media probing: mime sniffing, image dims, mp4 duration/dims', async () => {
  assert.equal(sniffMime(makeJpeg()), 'image/jpeg');
  assert.equal(sniffMime(makePng()), 'image/png');
  assert.equal(sniffMime(Buffer.from('hello world!')), null);
  assert.deepEqual(imageSize(makeJpeg(1234, 567), 'image/jpeg'), { width: 1234, height: 567 });
  assert.deepEqual(imageSize(makePng(800, 600), 'image/png'), { width: 800, height: 600 });
  const f = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pl-')), 'v.mp4');
  fs.writeFileSync(f, makeMp4({ width: 720, height: 1280, seconds: 12.5 }));
  assert.equal(sniffMime(fs.readFileSync(f)), 'video/mp4');
  const fd = fs.openSync(f, 'r');
  const reader = async (pos, len) => { const b = Buffer.alloc(len); return b.subarray(0, fs.readSync(fd, b, 0, len, pos)); };
  assert.deepEqual(await probeMp4(reader, fs.statSync(f).size), { duration: 12.5, width: 720, height: 1280 });
  fs.closeSync(fd);
});

test('error classification: transient vs permanent vs auth', async () => {
  assert.equal(classifyInstagram('{"error":{"code":9004,"error_subcode":2207052}}', 400).kind, 'transient');
  assert.equal(classifyInstagram('{"error":{"code":9004,"error_subcode":2207026}}', 400).kind, 'permanent');
  assert.equal(classifyInstagram('{"error":{"message":"bad","code":190}}', 400).kind, 'auth');
  assert.equal(classifyInstagram('{"error":{"message":"x","code":4}}', 400).kind, 'transient');
  assert.equal(classifyInstagram('{"error":{"message":"x","code":10}}', 400).kind, 'permanent');
  assert.equal(classifyFacebook('{"error":{"message":"Error validating access token: expired","code":190}}', 400).kind, 'auth');
  assert.equal(classifyFacebook('{"error":{"code":368,"error_subcode":1390008}}', 400).kind, 'transient');
  assert.equal(classifyFacebook('{"error":{"code":1,"message":"unknown"}}', 500).kind, 'transient');
  assert.equal(classifyGoogle('{"error":"invalid_grant"}', 400).kind, 'auth');
  assert.equal(classifyGoogle('{"error":{"code":403,"errors":[{"reason":"quotaExceeded"}]}}', 403).kind, 'permanent');
  assert.equal(classifyGoogle('{"error":{"code":403,"errors":[{"reason":"rateLimitExceeded"}]}}', 403).kind, 'transient');
});

test('token encryption at rest + password hashing', async () => {
  const c = makeCipher('some-long-test-secret-value');
  const enc = await c.encrypt('EAAB-secret-token');
  assert.ok(!enc.includes('EAAB'));
  assert.equal(await c.decrypt(enc), 'EAAB-secret-token');
  const other = makeCipher('a-different-secret-value-xyz');
  await assert.rejects(() => other.decrypt(enc));
  assert.throws(() => makeCipher(''), /TOKEN_ENC_KEY/);
  const h = hashPassword('pw-1234567890');
  assert.ok(await verifyPassword('pw-1234567890', h));
  assert.ok(!(await verifyPassword('nope', h)));
  // portable PBKDF2 hashes (Cloudflare Workers) verify on Node too
  const ph = await hashPasswordPbkdf2('pw-1234567890', 1000);
  assert.ok(await verifyPassword('pw-1234567890', ph));
  assert.equal(await verifyPasswordPbkdf2('nope', ph), false);
  assert.equal(await verifyPasswordPbkdf2('x', h), null, 'scrypt hashes are not PBKDF2');
});

test('timezone conversion and posting slots', async () => {
  assert.equal(new Date(zonedToUtc(2026, 11, 2, 9, 30, 'Asia/Kolkata')).toISOString(), '2026-11-02T04:00:00.000Z');
  assert.equal(new Date(parseLocal('2026-03-29T03:30', 'Europe/Berlin')).toISOString(), '2026-03-29T01:30:00.000Z');
  assert.equal(parseLocal('2026-11-02T09:30:00Z', 'Asia/Kolkata'), Date.parse('2026-11-02T09:30:00Z'));
  assert.equal(formatLocal(Date.parse('2026-11-02T04:00:00Z'), 'Asia/Kolkata'), '2026-11-02T09:30');
  const from = Date.parse('2026-11-02T00:00:00Z'); // Monday
  const slots = nextSlots({ mon: ['09:00', '18:00'], tue: ['10:00'] }, 'Asia/Kolkata', { from, count: 3 });
  assert.deepEqual(slots.map((t) => formatLocal(t, 'Asia/Kolkata')), ['2026-11-02T09:00', '2026-11-02T18:00', '2026-11-03T10:00']);
  const skip = nextSlots({ mon: ['09:00', '18:00'] }, 'Asia/Kolkata', { from, count: 1, isTaken: (t) => formatLocal(t, 'Asia/Kolkata').endsWith('09:00') });
  assert.equal(formatLocal(skip[0], 'Asia/Kolkata'), '2026-11-02T18:00');
});

test('schema validator gives actionable messages', async () => {
  const s = { type: 'object', additionalProperties: false, required: ['targets'], properties: { targets: { type: 'array', minItems: 1 }, publish_at: { type: 'string' } } };
  const errs = validate(s, { scheduled_at: 'x' });
  assert.ok(errs.some((e) => /targets is required/.test(e)));
  assert.ok(errs.some((e) => /Unknown field "scheduled_at"/.test(e)));
  assert.ok(validate(s, { targets: [], publish_atx: 1 }).some((e) => /did you mean "publish_at"/.test(e)));
});

test('web UI: every ES module parses, imports resolve to shipped files, no inline style attributes (CSP)', async () => {
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  const dir = path.join(import.meta.dirname, '..', 'public', 'js');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 9);
  for (const f of files) {
    const file = path.join(dir, f);
    execFileSync(process.execPath, ['--check', file]); // throws on syntax errors
    const src = fs.readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
      const target = spec.startsWith('/assets/shared/') ? path.join(import.meta.dirname, '..', 'src', 'shared', path.basename(spec)) : path.join(dir, spec);
      assert.ok(fs.existsSync(target), `${f} imports missing ${spec}`);
    }
    assert.doesNotMatch(src, /style="/, `${f}: inline style="" is blocked by the CSP`);
  }
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'app.css'), 'utf8');
  for (const font of css.matchAll(/url\("\/assets\/(fonts\/[^"]+)"\)/g)) assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', 'public', font[1])), font[1]);
  assert.match(css, /\[data-theme="light"\]/);
});
