// Feature batch on Cloudflare Workers (D1 + R2 + cron), against the fake providers: settings time format,
// delete-workspace-data, and (added per feature) channel preferences, tags, signatures, templates,
// repeating posts, media library and alerts. Every new table is exercised through D1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, hasWrangler } from './harness.js';
import { hashPasswordPbkdf2 } from '../src/crypto.js';
import { makeJpeg } from '../test/helpers.js';
import { startFake } from '../test/fake/server.js';

const PASSWORD = 'workers features correct horse';
const skip = !hasWrangler() && 'wrangler devDependency not installed (npm install)';
let w, session, admin, fb;

async function oauth(provider) {
  const start = await fetch(`${w.base}/oauth/${provider}/start`, { redirect: 'manual', headers: { cookie: session.cookie } });
  const cb = (await fetch(start.headers.get('location'), { redirect: 'manual' })).headers.get('location');
  return fetch(cb, { redirect: 'manual', headers: { cookie: session.cookie } });
}

before(async () => {
  if (skip) return;
  const fake = await startFake();
  // Alerts by email through Resend (fake endpoint); password mode → ADMIN_EMAIL is the recipient.
  w = await startWorker({ fake, profile: false, vars: { ADMIN_PASSWORD_HASH: await hashPasswordPbkdf2(PASSWORD), RESEND_API_KEY: 're_test_key', RESEND_API_URL: `${fake.url}/resend`, EMAIL_FROM: 'postlite <alerts@example.com>', ADMIN_EMAIL: 'owner@example.com', NOTIFY_BATCH_SECONDS: '0' } });
  const r1 = await fetch(`${w.base}/login`);
  const csrfCookie = /pl_lcsrf=([^;]+)/.exec(r1.headers.get('set-cookie'))[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await r1.text())[1];
  const r2 = await fetch(`${w.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `pl_lcsrf=${csrfCookie}`, origin: w.base }, body: new URLSearchParams({ password: PASSWORD, csrf }) });
  const sid = /pl_sid=([^;]+)/.exec(r2.headers.get('set-cookie') || '')[1];
  session = { cookie: `pl_sid=${sid}`, csrf: (await (await fetch(`${w.base}/api/v1/session`, { headers: { cookie: `pl_sid=${sid}` } })).json()).csrf };
  admin = (await w.api('POST', '/api-keys', { session, body: { name: 'features-admin', scopes: ['read', 'write', 'publish', 'analytics', 'admin'], approval_mode: false } })).json.api_key.key;
  const sel = await oauth('facebook');
  const state = /select\/([\w-]+)/.exec(sel.headers.get('location'))[1];
  await w.api('POST', `/oauth/pending/${state}`, { session, body: { external_ids: ['page1'] } });
  fb = (await w.api('GET', '/accounts', { key: admin })).json.accounts.find((a) => a.provider === 'facebook').id;
});
after(async () => { if (w) await w.stop(); });

test('Workers/D1: time format setting', { skip }, async () => {
  const r = await w.api('PATCH', '/settings', { key: admin, body: { time_format: '12h' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await w.api('GET', '/settings', { key: admin })).json.settings.time_format, '12h');
});

test('Workers/D1: media library filters, usage and bulk delete', { skip }, async () => {
  const up = async (name) => (await w.api('POST', '/media/base64', { key: admin, body: { data: makeJpeg(640, 640).toString('base64'), filename: name } })).json.media.id;
  const used = await up('used-one.jpg');
  const free = await up('free-one.jpg');
  const d = await w.api('POST', '/posts', { key: admin, body: { content: 'draft with media', media_ids: [used], targets: [{ account_id: fb }], mode: 'draft' } });
  assert.equal(d.status, 200, d.text);
  const all = await w.api('GET', '/media?counts=true', { key: admin });
  assert.equal(all.status, 200, all.text);
  assert.ok(all.json.counts.used >= 1 && all.json.counts.unused >= 1);
  assert.deepEqual((await w.api('GET', '/media?usage=unused&q=free-one', { key: admin })).json.media.map((m) => m.id), [free]);
  const r = await w.api('POST', '/media/delete', { key: admin, body: { media_ids: [used, free] } });
  assert.deepEqual(r.json.deleted, [free]);
  assert.equal(r.json.skipped[0].media_id, used);
});

test('Workers/D1: channel preferences — rename, pause holds due posts through the cron, resume publishes, own slots', { skip }, async () => {
  const r = await w.api('PATCH', `/accounts/${fb}`, { key: admin, body: { display_name: 'CF Page', posting_slots: { mon: ['06:45'], tue: ['06:45'], wed: ['06:45'], thu: ['06:45'], fri: ['06:45'], sat: ['06:45'], sun: ['06:45'] } } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.account.name, 'CF Page');
  const slots = await w.api('GET', `/slots?count=2&account_id=${fb}`, { key: admin });
  assert.ok(slots.json.channel_slots && slots.json.slots.every((x) => x.local.endsWith('06:45')), slots.text);
  await w.api('PATCH', `/accounts/${fb}`, { key: admin, body: { disabled: true } });
  const p = await w.api('POST', '/posts', { key: admin, body: { content: 'held while paused', targets: [{ account_id: fb }], mode: 'schedule', publish_at: Date.now() + 1000 } });
  assert.equal(p.status, 200, p.text);
  await new Promise((res) => setTimeout(res, 1500));
  await w.cron();
  await w.cron();
  let g = (await w.api('GET', `/posts/${p.json.post.id}`, { key: admin })).json.post;
  assert.equal(g.targets[0].status, 'scheduled');
  assert.equal(g.targets[0].account_name, 'CF Page');
  await w.api('PATCH', `/accounts/${fb}`, { key: admin, body: { disabled: false } });
  await w.cronUntil(async () => (await w.api('GET', `/posts/${p.json.post.id}`, { key: admin })).json.post.targets[0].status === 'published');
  await w.api('PATCH', `/accounts/${fb}`, { key: admin, body: { posting_slots: null } });
});

test('Workers/D1: tags — create, assign on create_post, filter posts/calendar, set_post_tags, delete', { skip }, async () => {
  const t = await w.api('POST', '/tags', { key: admin, body: { name: 'cf-launch', color: '#22c55e' } });
  assert.equal(t.status, 200, t.text);
  const p = await w.api('POST', '/posts', { key: admin, body: { content: 'tagged on workers', tags: ['cf-launch', 'cf-new'], targets: [{ account_id: fb }], mode: 'schedule', publish_at: Date.now() + 3600000 } });
  assert.equal(p.status, 200, p.text);
  assert.deepEqual(p.json.post.tags.map((x) => x.name).sort(), ['cf-launch', 'cf-new']);
  const listed = (await w.api('GET', '/posts?tag=cf-launch', { key: admin })).json.posts;
  assert.deepEqual(listed.map((x) => x.id), [p.json.post.id]);
  const cal = await w.api('GET', `/calendar?from=${Date.now()}&to=${Date.now() + 7200000}&tag=cf-new`, { key: admin });
  assert.ok(cal.json.entries.some((e) => e.group_id === p.json.post.id));
  const r = await w.api('PUT', `/posts/${p.json.post.id}/tags`, { key: admin, body: { tags: ['cf-new'], mode: 'remove' } });
  assert.deepEqual(r.json.post.tags.map((x) => x.name), ['cf-launch']);
  assert.equal((await w.api('DELETE', '/tags/cf-launch', { key: admin })).status, 200);
  assert.deepEqual((await w.api('GET', `/posts/${p.json.post.id}`, { key: admin })).json.post.tags, []);
});

test('Workers/D1: signatures and templates — auto-add, insert, save from a post, start a post from it', { skip }, async () => {
  assert.equal((await w.api('POST', '/signatures', { key: admin, body: { name: 'cf-sig', content: '— cf team', auto_add: true, platforms: ['facebook'] } })).status, 200);
  const p = await w.api('POST', '/posts', { key: admin, body: { content: 'cf hello', auto_signatures: true, tags: ['cf-t'], targets: [{ account_id: fb, settings: { post_type: 'post' } }], mode: 'draft' } });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.post.content, 'cf hello\n\n— cf team');
  const t = await w.api('POST', '/templates', { key: admin, body: { name: 'cf-tpl', from_post_id: p.json.post.id } });
  assert.equal(t.status, 200, t.text);
  assert.deepEqual(t.json.template.tags, ['cf-t']);
  const n = await w.api('POST', '/posts', { key: admin, body: { template_id: 'cf-tpl', mode: 'draft' } });
  assert.equal(n.status, 200, n.text);
  assert.equal(n.json.post.content, 'cf hello\n\n— cf team');
  assert.deepEqual(n.json.post.targets.map((x) => x.integration_id), [fb]);
  assert.equal((await w.api('GET', '/templates', { key: admin })).json.templates.length, 1);
  assert.equal((await w.api('DELETE', '/signatures/cf-sig', { key: admin })).status, 200);
});

test('Workers/D1: repeating posts — create with repeat, rolling occurrences, cron fill, update, stop', { skip }, async () => {
  const first = Date.now() + 3600000;
  const r = await w.api('POST', '/posts', { key: admin, body: { content: 'cf weekly', targets: [{ account_id: fb, settings: { post_type: 'post' } }], mode: 'schedule', publish_at: first, repeat: { frequency: 'weekly', count: 5 } } });
  assert.equal(r.status, 200, r.text);
  const sid = r.json.post.series_id;
  let s = (await w.api('GET', `/series/${sid}`, { key: admin })).json.series;
  assert.equal(s.occurrences.length, 3);
  assert.deepEqual(s.occurrences.map((o) => o.publish_at), [0, 7, 14].map((d) => first + d * 86400000));
  const u = await w.api('PATCH', `/series/${sid}`, { key: admin, body: { content: 'cf weekly v2' } });
  assert.equal(u.status, 200, u.text);
  const third = (await w.api('GET', `/posts/${s.occurrences[2].id}`, { key: admin })).json.post;
  assert.equal(third.content, 'cf weekly v2');
  assert.equal(third.series_id, sid);
  const st = await w.api('POST', `/series/${sid}/stop`, { key: admin, body: {} });
  assert.equal(st.status, 200, st.text);
  assert.equal(st.json.removed_occurrences, 2);
  s = (await w.api('GET', '/series', { key: admin })).json.series;
  assert.equal(s[0].status, 'stopped');
});

test('Workers/D1: alerts — failed post via cron → in-app notification + one Resend email (deduped), mark read, prefs, test email, digest', { skip }, async () => {
  const p0 = (await w.api('GET', '/notifications/prefs', { key: admin })).json;
  assert.deepEqual([p0.email.configured, p0.email.transport, p0.email.to], [true, 'resend', 'owner@example.com']);
  const before = (w.fake.state.emails || []).length;
  // A permanent platform error (no token side effects): the post fails once, for good.
  w.fake.state.failNext['/page1/feed$'] = { status: 400, body: { error: { message: '(#100) Invalid parameter', type: 'OAuthException', code: 100 } }, times: 1 };
  const r = await w.api('POST', '/posts', { key: admin, body: { content: 'cf alert', targets: [{ account_id: fb, settings: { post_type: 'post' } }], mode: 'now' } });
  assert.equal(r.status, 200, r.text);
  const gid = r.json.post.id;
  const n = await w.cronUntil(async () => (await w.api('GET', '/notifications', { key: admin })).json.notifications.find((x) => x.kind === 'post_failed' && x.link === `#/posts/${gid}`), { tries: 30 });
  assert.match(n.title, /Post failed on/);
  await w.cronUntil(async () => (w.fake.state.emails || []).length > before, { tries: 10 });
  await w.cron(); await w.cron();
  const mails = w.fake.state.emails.slice(before);
  assert.equal(mails.filter((m) => m.text.includes(`#/posts/${gid}`)).length, 1, 'one email per failure');
  assert.deepEqual(mails[0].to, ['owner@example.com']);
  const all = await w.api('POST', '/notifications/read', { key: admin, body: { all: true } });
  assert.deepEqual([all.status, all.json.unread], [200, 0]);
  const up = await w.api('PATCH', '/notifications/prefs', { key: admin, body: { digest: true, digest_time: '00:00' } });
  assert.equal(up.status, 200, up.text);
  await w.cronUntil(async () => (await w.api('GET', '/notifications', { key: admin })).json.notifications.find((x) => x.kind === 'digest'), { tries: 5 });
  const te = await w.api('POST', '/notifications/test', { key: admin, body: {} });
  assert.equal(te.status, 200, te.text);
  assert.ok(w.fake.state.emails.some((m) => m.subject === 'postlite: Test email from postlite'));
  await w.api('PATCH', '/notifications/prefs', { key: admin, body: { digest: false } });
});

// Runs last: wipes the workspace.
test('Workers/D1: delete workspace data removes accounts, posts and keys, then the key stops working', { skip }, async () => {
  const p = await w.api('POST', '/posts', { key: admin, body: { content: 'to be wiped', targets: [{ account_id: fb }], mode: 'schedule', publish_at: Date.now() + 86400000 } });
  assert.equal(p.status, 200, p.text);
  const sum = await w.api('GET', '/workspace/data', { key: admin });
  assert.equal(sum.status, 200, sum.text);
  assert.ok(sum.json.counts.integrations >= 1 && sum.json.counts.groups >= 1);
  assert.equal((await w.api('POST', '/workspace/delete-data', { key: admin, body: { confirm: 'wrong' } })).status, 400);
  const r = await w.api('POST', '/workspace/delete-data', { key: admin, body: { confirm: sum.json.confirm_with } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await w.api('GET', '/accounts', { key: admin })).status, 401);
  const s = await w.api('GET', '/accounts', { session });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.accounts.length, 0);
});
