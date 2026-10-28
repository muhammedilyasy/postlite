// LinkedIn: personal profile (Share on LinkedIn + OIDC) and Company Pages (Community Management API) against
// the fake: connect, versioned headers, text/image/multi-image/video/document/article posts, little-text escaping,
// first comment with and without the permission, token expiry without refresh tokens, analytics degradation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeJpeg, makeMp4, makePng } from './helpers.js';
import { littleText } from '../src/providers/linkedin.js';

let app, me, page;
before(async () => {
  app = await createTestApp();
  const r = await app.connect('linkedin');
  assert.equal(r.status, 200, r.text);
  me = r.accounts[0].id;
  // Pages: the member admins one org (the ANALYST role on another is ignored) → connected directly
  const p = await app.connect('linkedin-page');
  assert.equal(p.status, 200, p.text);
  assert.equal(p.accounts.length, 1);
  page = p.accounts[0].id;
});
after(async () => { await app.close(); });

const L = () => app.fake.state.xl.li;
const pubs = () => app.fake.state.published.filter((p) => p.platform.startsWith('linkedin'));
async function publish(account, content, { media = [], settings = {} } = {}) {
  const gid = await app.core.posts.saveGroup({ content, media: media.map((m) => m.id), action: 'now', posts: [{ integration_id: account, settings }] });
  await app.core.scheduler.drain(20000);
  return (await app.core.posts.getGroup(gid)).targets[0];
}

test('connect: OIDC member id + 60-day token; Pages found through organizationAcls', async () => {
  const a = await app.core.integrations.get(me);
  assert.equal(a.external_id, 'li-member-1');
  assert.equal(a.name, 'Li Member');
  assert.ok(a.token_expires_at - Date.now() > 59 * 86400000);
  assert.equal(a.meta.has_refresh, false);
  const p = await app.core.integrations.get(page);
  assert.equal(p.name, 'Acme Corp');
  assert.equal(p.meta.urn, 'urn:li:organization:9001');
  const auth = app.fake.state.calls.filter((c) => c.path === '/liwww/oauth/v2/authorization');
  assert.match(auth[0].query.scope, /w_member_social/);
  assert.match(auth[1].query.scope, /w_organization_social/);
});

test('little text: reserved characters escaped, #hashtags stay clickable', () => {
  assert.equal(littleText('Q3 (up 40%) #growth @team [x] a_b ~ * | {y} <z> \\'), 'Q3 \\(up 40%\\) {hashtag|\\#|growth} \\@team \\[x\\] a\\_b \\~ \\* \\| \\{y\\} \\<z\\> \\\\');
  assert.equal(littleText('C# and url.com/#anchor'), 'C\\# and url.com/\\#anchor');
});

test('text post: versioned REST headers, author URN, little text', async () => {
  const t = await publish(me, 'Hello LinkedIn (test) #postlite');
  assert.equal(t.status, 'published', t.error);
  assert.match(t.published_url, /linkedin\.com\/feed\/update\/urn:li:share:/);
  const p = pubs().at(-1);
  assert.equal(p.data.author, 'urn:li:person:li-member-1');
  assert.equal(p.data.commentary, 'Hello LinkedIn \\(test\\) {hashtag|\\#|postlite}');
  assert.equal(p.data.visibility, 'PUBLIC');
  assert.ok(L().versions.has('202610'));
});

test('single image, multi-image and article posts', async () => {
  const a = await app.upload(makeJpeg(1200, 800), 'a.jpg');
  const b = await app.upload(makePng(800, 800), 'b.png');
  const t1 = await publish(me, 'One image', { media: [a] });
  assert.equal(t1.status, 'published', t1.error);
  assert.match(pubs().at(-1).data.content.media.id, /^urn:li:image:/);
  const t2 = await publish(me, 'Two images', { media: [a, b] });
  assert.equal(t2.status, 'published', t2.error);
  assert.equal(pubs().at(-1).data.content.multiImage.images.length, 2);
  const t3 = await publish(page, 'Read our post', { settings: { url: 'https://example.com/blog', url_title: 'Blog' } });
  assert.equal(t3.status, 'published', t3.error);
  assert.deepEqual(pubs().at(-1).data.content.article, { source: 'https://example.com/blog', title: 'Blog' });
  assert.equal(pubs().at(-1).data.author, 'urn:li:organization:9001');
});

test('video: multipart upload by uploadInstructions, ETags to finalize, waits for AVAILABLE', async () => {
  const v = await app.upload(makeMp4({ seconds: 20, mdatBytes: 9 * 1024 * 1024 }), 'v.mp4');
  const before = app.fake.state.calls.length;
  const t = await publish(page, 'Video', { media: [v] });
  assert.equal(t.status, 'published', t.error);
  const calls = app.fake.state.calls.slice(before);
  assert.equal(calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/liup/')).length, 3);
  const fin = calls.find((c) => c.query.action === 'finalizeUpload');
  assert.equal(fin.body.finalizeUploadRequest.uploadedPartIds.length, 3);
  assert.ok(calls.some((c) => c.method === 'GET' && c.path.startsWith('/liapi/rest/videos/')));
  assert.match(pubs().at(-1).data.content.media.id, /^urn:li:video:/);
});

test('document (PDF) post', async () => {
  const pdf = await app.core.media.save(new TextEncoder().encode(`%PDF-1.4\n${'x'.repeat(5000)}\n%%EOF`), 'deck.pdf');
  assert.equal(pdf.kind, 'document');
  const t = await publish(me, 'Our deck', { media: [pdf], settings: { post_type: 'document', document_title: 'Deck' } });
  assert.equal(t.status, 'published', t.error);
  assert.deepEqual(pubs().at(-1).data.content.media, { id: pubs().at(-1).data.content.media.id, title: 'Deck' });
  assert.match(pubs().at(-1).data.content.media.id, /^urn:li:document:/);
  await assert.rejects(app.core.posts.saveGroup({ content: 'x', media: [pdf.id], action: 'now', posts: [{ integration_id: me }] }), (e) => /Switch the type to Document/.test(JSON.stringify(e.extra || e.message)));
});

test('validation: 3000 characters, Page posts are public, video limits', async () => {
  await assert.rejects(app.core.posts.saveGroup({ content: 'y'.repeat(3001), action: 'now', posts: [{ integration_id: me }] }), (e) => /limit is 3000/.test(JSON.stringify(e.extra || e.message)));
  await assert.rejects(app.core.posts.saveGroup({ content: 'hi', action: 'now', posts: [{ integration_id: page, settings: { visibility: 'CONNECTIONS' } }] }), (e) => /always public/.test(JSON.stringify(e.extra || e.message)));
  const tiny = await app.upload(makeMp4({ seconds: 2, mdatBytes: 200000 }), 'tiny.mp4');
  await assert.rejects(app.core.posts.saveGroup({ content: 'hi', media: [tiny.id], action: 'now', posts: [{ integration_id: me }] }), (e) => /3 seconds to 30 minutes/.test(JSON.stringify(e.extra || e.message)));
});

test('first comment: published with a warning without the Community Management permission; added when granted', async () => {
  const t = await publish(me, 'With a comment', { settings: { first_comment: 'Sources: …' } });
  assert.equal(t.status, 'published', t.error);
  assert.match(t.warning, /w_member_social_feed/);
  L().comments = true;
  const t2 = await publish(page, 'With a comment 2', { settings: { first_comment: 'Hello (again)' } });
  assert.equal(t2.status, 'published', t2.error);
  assert.equal(t2.warning, null);
  const c = app.fake.state.published.filter((p) => p.kind === 'comment').at(-1);
  assert.equal(c.data.actor, 'urn:li:organization:9001');
  assert.equal(c.data.message.text, 'Hello (again)');
});

test('expired token without a refresh token: account needs reconnect, then reconnect works', async () => {
  const sec = await app.core.integrations.secret(me);
  L().tokens.delete(sec.access_token);
  const t = await publish(me, 'After expiry');
  assert.equal(t.status, 'failed');
  assert.match(t.error, /60 days/);
  assert.equal((await app.core.integrations.get(me)).status, 'needs_reconnect');
  // approved partners get refresh tokens: then expiry is handled by a refresh
  L().refresh = true;
  const r = await app.connect('linkedin', { reconnect: me });
  assert.equal(r.status, 200, r.text);
  const s2 = await app.core.integrations.secret(me);
  assert.match(s2.refresh_token, /^li-rt-/);
  L().tokens.delete(s2.access_token);
  const t2 = await publish(me, 'After refresh');
  assert.equal(t2.status, 'published', t2.error);
  L().refresh = false;
});

test('maintenance does not flag a LinkedIn account early when it has no refresh token', async () => {
  const p = await app.core.integrations.get(page);
  await app.core.db.run('UPDATE integrations SET token_expires_at = ? WHERE id = ? /* ws:system */', Date.now() + 5 * 86400000, page);
  await app.core.integrations.maintain();
  assert.equal((await app.core.integrations.get(page)).status, 'active');
  await app.core.db.run('UPDATE integrations SET token_expires_at = ? WHERE id = ? /* ws:system */', p.token_expires_at, page);
});

test('analytics: member analytics need approval (one notice); Pages get followers and daily stats', async () => {
  const r = await app.core.analytics.syncIntegration(me, { restart: true });
  assert.equal(r.ok, true, r.error);
  const st = await app.core.analytics.status(me);
  assert.equal(st.unavailable.notices.length, 1);
  assert.equal(st.unavailable.notices[0].code, 'needs_approval');
  assert.match(st.unavailable.notices[0].text, /Community Management API/);
  const before = app.fake.state.calls.filter((c) => c.path === '/liapi/rest/memberCreatorPostAnalytics').length;
  await app.core.analytics.syncIntegration(me, { restart: true });
  assert.equal(app.fake.state.calls.filter((c) => c.path === '/liapi/rest/memberCreatorPostAnalytics').length - before, 1, 'no per-post calls once the API said no');
  // once approved
  L().analytics = true;
  const r2 = await app.core.analytics.syncIntegration(me, { restart: true });
  assert.equal(r2.ok, true, r2.error);
  const to = Date.now();
  assert.equal((await app.core.analytics.summary(me, to - 86400000, to)).followers.value, 321);
  const ours = (await app.core.analytics.topPosts({ integrationId: me, from: 0, to: to + 1000 })).find((p) => p.via_postlite);
  assert.equal(ours.metrics.views, 900);
  // Page
  const r3 = await app.core.analytics.syncIntegration(page, { restart: true });
  assert.equal(r3.ok, true, r3.error);
  const sp = await app.core.analytics.summary(page, to - 5 * 86400000, to + 1000);
  assert.equal(sp.followers.value, 1500);
  assert.ok(sp.views.value > 300);
  const pt = (await app.core.analytics.topPosts({ integrationId: page, from: 0, to: to + 1000 })).find((p) => p.via_postlite);
  assert.equal(pt.metrics.views, 777);
});
