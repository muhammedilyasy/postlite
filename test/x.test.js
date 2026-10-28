// X (Twitter): OAuth 2.0 PKCE connect, rotating refresh, text/photo/video posts, threads, failures,
// recovery after a lost response, workspace isolation of OAuth state, and analytics — all against the fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeJpeg, makeMp4 } from './helpers.js';

let app, xid;
before(async () => {
  app = await createTestApp();
  const r = await app.connect('x');
  assert.equal(r.status, 200, r.text);
  xid = r.accounts[0].id;
});
after(async () => { await app.close(); });

const X = () => app.fake.state.xl.x;
async function publish(content, { media = [], settings = {} } = {}) {
  const gid = await app.core.posts.saveGroup({ content, media: media.map((m) => m.id), action: 'now', posts: [{ integration_id: xid, settings }] });
  await app.core.scheduler.drain(15000);
  return (await app.core.posts.getGroup(gid)).targets[0];
}

test('connect: PKCE + confidential client, refresh token stored, 2-hour expiry, profile', async () => {
  const a = await app.core.integrations.get(xid);
  assert.equal(a.username, 'xtest');
  assert.equal(a.status, 'active');
  assert.ok(a.token_expires_at - Date.now() < 2.1 * 3600000);
  const start = app.fake.state.calls.find((c) => c.path === '/xwww/i/oauth2/authorize');
  assert.equal(start.query.code_challenge_method, 'S256');
  assert.match(start.query.scope, /offline\.access/);
  assert.match(start.query.scope, /media\.write/);
  const tok = app.fake.state.calls.find((c) => c.path === '/xapi/2/oauth2/token' && c.body.grant_type === 'authorization_code');
  assert.ok(tok.body.code_verifier);
  const sec = await app.core.integrations.secret(xid);
  assert.match(sec.refresh_token, /^x-rt-/);
});

test('OAuth state is bound to the workspace that started it', async () => {
  const st = await app.core.oauth.start('x');
  const w = await app.root.workspaces.forEmail('other@example.com');
  await assert.rejects(app.root.scope(w.workspace_id).oauth.callback('x', { code: 'x-code', state: st.state }), /invalid or expired/);
  // the other workspace cannot see, post to or read analytics of this workspace's X / LinkedIn accounts
  const other = app.root.scope(w.workspace_id);
  assert.equal((await other.integrations.list()).filter((a) => a.provider === 'x').length, 0);
  await assert.rejects(other.posts.saveGroup({ content: 'not yours', action: 'now', posts: [{ integration_id: xid }] }), /not found|unknown|account/i);
  assert.equal(await other.integrations.secret(xid), null);
});

test('text post', async () => {
  const t = await publish('Hello from postlite');
  assert.equal(t.status, 'published', t.error);
  assert.match(t.published_url, /^https:\/\/x\.com\/xtest\/status\/\d+$/);
  assert.equal(app.fake.state.published.at(-1).data.text, 'Hello from postlite');
});

test('photos and video: chunked upload v2 (initialize/append/finalize), video waits for processing', async () => {
  const a = await app.upload(makeJpeg(1200, 800), 'a.jpg');
  const b = await app.upload(makeJpeg(800, 800), 'b.jpg');
  const t1 = await publish('Two photos', { media: [a, b] });
  assert.equal(t1.status, 'published', t1.error);
  assert.equal(app.fake.state.published.at(-1).data.media.media_ids.length, 2);
  const v = await app.upload(makeMp4({ seconds: 12, mdatBytes: 9 * 1024 * 1024 }), 'v.mp4');
  const before = app.fake.state.calls.length;
  const t2 = await publish('A video', { media: [v] });
  assert.equal(t2.status, 'published', t2.error);
  const calls = app.fake.state.calls.slice(before);
  assert.equal(calls.filter((c) => /\/append$/.test(c.path)).length, 3, '9+ MB in 4 MB segments');
  assert.ok(calls.some((c) => c.path === '/xapi/2/media/upload' && c.query.command === 'STATUS'));
  const init = calls.find((c) => c.path === '/xapi/2/media/upload/initialize');
  assert.equal(init.body.media_category, 'tweet_video');
});

test('thread: replies chain under the first post, each with its own media', async () => {
  const img = await app.upload(makeJpeg(900, 900), 't.jpg');
  const t = await publish('1/ A thread', { settings: { thread: [{ text: '2/ with a photo', media: [img.id] }, { text: '3/ the end' }] } });
  assert.equal(t.status, 'published', t.error);
  const pubs = app.fake.state.published.filter((p) => p.platform === 'x').slice(-3);
  assert.equal(pubs[0].data.text, '1/ A thread');
  assert.equal(pubs[1].data.reply.in_reply_to_tweet_id, pubs[0].id);
  assert.equal(pubs[1].data.media.media_ids.length, 1);
  assert.equal(pubs[2].data.reply.in_reply_to_tweet_id, pubs[1].id);
  assert.equal(t.external_id, pubs[0].id);
});

test('validation: 280 weighted chars (URLs count 23), Premium gets 25,000; media rules', async () => {
  const long = 'a'.repeat(281);
  await assert.rejects(app.core.posts.saveGroup({ content: long, action: 'now', posts: [{ integration_id: xid }] }), (e) => /limit is 280/.test(JSON.stringify(e.extra || e.message)));
  const okUrl = `${'b'.repeat(250)} https://example.com/${'x'.repeat(200)}`;
  const v = await app.api('POST', '/posts/validate', { session: await app.login(), body: { content: okUrl, targets: [{ account_id: xid }] } });
  assert.equal(v.json.results[0].ok, true, JSON.stringify(v.json));
  assert.equal(v.json.results[0].caption_length, 274);
  const pdf = await app.core.media.save(new TextEncoder().encode('%PDF-1.4\n%fake\n'), 'doc.pdf');
  const bad = await app.api('POST', '/posts/validate', { session: await app.login(), body: { content: 'x', media_ids: [pdf.id], targets: [{ account_id: xid, settings: { thread: [{ text: '' }] } }] } });
  assert.match(bad.json.results[0].errors.join(' '), /Documents \(PDF\) can only be posted to LinkedIn/);
  assert.match(bad.json.results[0].errors.join(' '), /Thread post 2 is empty/);
  // X Premium (subscription_type) is detected on (re)connect and lifts the limit
  X().premium = true;
  const r = await app.connect('x', { reconnect: xid });
  assert.equal(r.status, 200, r.text);
  assert.equal((await app.core.integrations.get(xid)).meta.premium, true);
  const t = await publish('p'.repeat(400));
  assert.equal(t.status, 'published', t.error);
  X().premium = false;
});

test('expired access token: refresh (rotating) then publish; concurrent refreshes are single-flight', async () => {
  const sec = await app.core.integrations.secret(xid);
  X().expired.add(sec.access_token);
  const t = await publish('After refresh');
  assert.equal(t.status, 'published', t.error);
  const after = await app.core.integrations.secret(xid);
  assert.notEqual(after.refresh_token, sec.refresh_token, 'refresh token rotated');
  const n = X().refreshCalls;
  const [a, b] = await Promise.all([app.core.integrations.refresh(xid), app.core.integrations.refresh(xid)]);
  assert.equal(X().refreshCalls, n + 1);
  assert.equal(a.access_token, b.access_token);
});

test('failures: duplicate text is permanent; used-up credits explain what to do', async () => {
  await publish('Same words twice');
  const dup = await publish('Same words twice');
  assert.equal(dup.status, 'failed');
  assert.match(dup.error, /duplicate/i);
  app.fake.state.failNext['^/xapi/2/tweets$'] = { status: 402, body: { title: 'Payment Required', detail: 'Your account has no credits left.', type: 'https://api.x.com/2/problems/credits', status: 402 }, times: 1 };
  const t = await publish('No credits');
  assert.equal(t.status, 'failed');
  assert.match(t.error, /credits are used up/);
});

test('lost response after the post was created: recovery finds it instead of posting twice', async () => {
  X().hangAfterCreate = true;
  const before = X().tweets.length;
  const t = await publish('Lost answer');
  assert.equal(t.status, 'published', t.error);
  assert.equal(X().tweets.length, before + 1, 'posted exactly once');
});

test('revoked refresh token marks the account for reconnect', async () => {
  const sec = await app.core.integrations.secret(xid);
  X().expired.add(sec.access_token);
  X().refresh = 'something-else';
  const t = await publish('Will fail');
  assert.equal(t.status, 'failed');
  assert.equal((await app.core.integrations.get(xid)).status, 'needs_reconnect');
  const r = await app.connect('x', { reconnect: xid });
  assert.equal(r.status, 200, r.text);
  assert.equal((await app.core.integrations.get(xid)).status, 'active');
});

test('analytics: followers snapshot, recent posts in one owned read, non-public metrics for recent posts', async () => {
  const r = await app.core.analytics.syncIntegration(xid, { restart: true });
  assert.equal(r.ok, true, r.error);
  const to = Date.now();
  const sum = await app.core.analytics.summary(xid, to - 86400000, to);
  assert.ok(sum.followers.value >= 500);
  assert.ok(sum.post_views.value > 0);
  const top = await app.core.analytics.topPosts({ integrationId: xid, from: 0, to: to + 1000 });
  assert.ok(top.length >= 3);
  const ours = top.find((p) => p.via_postlite);
  assert.ok(ours.metrics.views >= 1000);
  assert.equal(ours.metrics.clicks, 7);
  assert.equal(app.fake.state.calls.filter((c) => /^\/xapi\/2\/users\/x1\/tweets$/.test(c.path) && c.query['tweet.fields']?.includes('public_metrics')).length >= 1, true);
});
