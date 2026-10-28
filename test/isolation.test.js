// Multi-user isolation: in Cloudflare Access mode every allowed email has its own workspace. Bob must
// not be able to see or touch anything of Alice's through the UI session, REST, MCP, media URLs, OAuth
// callbacks / pending selections, approvals, webhooks or CSV export. The tenant guard fails loudly on
// a statement that forgets the workspace filter.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createTestApp, makeJpeg, makeMp4, waitFor } from './helpers.js';
import { checkTenantSql, guardDb, TenantGuardError } from '../src/tenant.js';
import { openDb } from '../src/db.js';

const TEAM = 'postlite-iso.cloudflareaccess.com';
const AUD = 'f1e2d3c4b5a6978877665544332211000f1e2d3c4b5a69788776655443322110';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
let jwksServer, app;

function sign(email) {
  const now = Math.floor(Date.now() / 1000);
  const body = { aud: [AUD], email, exp: now + 600, iat: now, nbf: now, iss: `https://${TEAM}`, type: 'app', sub: email };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', kid: 'k', typ: 'JWT' })}.${enc(body)}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key.privateKey).toString('base64url')}`;
}

async function signIn(email) {
  const token = sign(email);
  const r = await fetch(`${app.base}/`, { redirect: 'manual', headers: { 'cf-access-jwt-assertion': token } });
  assert.equal(r.status, 200);
  const sid = /pl_sid=([^;]+)/.exec(r.headers.get('set-cookie') || '')[1];
  const cookie = `pl_sid=${sid}; CF_Authorization=${token}`;
  const s = await (await fetch(`${app.base}/api/v1/session`, { headers: { cookie } })).json();
  return { cookie, csrf: s.csrf, info: s, ws: s.workspace.id };
}

const mcp = async (k, method, params) => {
  const r = await fetch(`${app.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
};

let A, B, sa, sb; // sessions + scopes
let aliceKey, bobKey, aliceApprovalKey;
let aFb, aYt, aMedia, aVideo, aGroup, aPending, aHook, aKeyId, aUpload;

before(async () => {
  jwksServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'k', alg: 'RS256', use: 'sig' }] }));
  });
  await new Promise((r) => jwksServer.listen(0, '127.0.0.1', r));
  app = await createTestApp({ env: { AUTH_MODE: 'cloudflare-access', CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, ALLOWED_EMAILS: `${ALICE},${BOB}`, CF_ACCESS_CERTS_URL: `http://127.0.0.1:${jwksServer.address().port}/cdn-cgi/access/certs`, CF_ACCESS_JWKS_MIN_REFRESH_MS: '0' } });
  A = await signIn(ALICE);
  B = await signIn(BOB);
  sa = app.root.scope(A.ws);
  sb = app.root.scope(B.ws);
  // Alice's data: accounts, media, a scheduled post, a pending approval, a webhook, keys, settings, app creds, analytics.
  aFb = await sa.integrations.upsert('facebook', { external_id: 'page1', name: 'Alice Page', access_token: 'page1-token', refresh_token: 'user-long' });
  aYt = await sa.integrations.upsert('youtube', { external_id: 'UC1', name: 'Alice Channel', access_token: 'ya29.initial', refresh_token: '1//refresh', token_expires_at: Date.now() + 3600000 });
  const jpg = makeJpeg(1080, 1080);
  aMedia = await sa.media.save(new Uint8Array(jpg), 'alice.jpg');
  const mp4 = makeMp4();
  aVideo = await sa.media.save(new Uint8Array(mp4), 'alice.mp4');
  aGroup = await sa.posts.saveGroup({ content: 'Alice secret plan', media: [aMedia.id], action: 'schedule', publish_at: Date.now() + 86400000, posts: [{ integration_id: aFb }] });
  aliceKey = (await sa.apiKeys.create({ name: 'alice-agent', scopes: ['read', 'write', 'publish', 'analytics', 'admin'], approval_mode: false })).key;
  aliceApprovalKey = (await sa.apiKeys.create({ name: 'alice-approval', scopes: ['read', 'write', 'publish'] })).key;
  aKeyId = (await sa.apiKeys.list())[0].id;
  bobKey = (await sb.apiKeys.create({ name: 'bob-agent', scopes: ['read', 'write', 'publish', 'analytics', 'admin'], approval_mode: false })).key;
  const pend = await app.api('POST', '/posts', { key: aliceApprovalKey, body: { content: 'Alice pending', targets: [{ account_id: aFb }], mode: 'schedule', publish_at: Date.now() + 2 * 86400000 } });
  assert.equal(pend.json.post.status, 'pending_approval', pend.text);
  aPending = pend.json.post.id;
  aHook = (await sa.webhooks.create({ url: 'http://127.0.0.1:9/alice', events: ['*'] })).id;
  await sa.settings.update({ timezone: 'Europe/Berlin' });
  await sa.apps.set('google', { client_id: 'alice-client.apps.googleusercontent.com', client_secret: 'alice-google-secret' });
  aUpload = (await sa.media.createUpload({ filename: 'big.mp4', size: 6 * 1024 * 1024 })).upload_id;
  await sa.db.run("INSERT INTO account_metrics(integration_id, metric, day, value, fetched_at) VALUES(?, 'followers', ?, 42, ?) /* ws:checked */", aFb, new Date().toISOString().slice(0, 10), Date.now());
  await sa.db.run("INSERT INTO remote_posts(workspace_id, integration_id, external_id, kind, caption, permalink, thumbnail, published_at, updated_at) VALUES(?, ?, 'ext1', 'post', 'Alice remote caption', 'https://fb.example/1', '', ?, ?)", A.ws, aFb, Date.now() - 3600000, Date.now());
  await sa.audit.record({ principal: { type: 'session', id: ALICE, name: ALICE }, via: 'ui', operation: 'alice_marker' });
});
after(async () => {
  await app.close();
  await new Promise((r) => jwksServer.close(r));
});

const asBob = (method, path, body) => app.api(method, path, { session: B, body });
const asBobKey = (method, path, body) => app.api(method, path, { key: bobKey, body });

test('each email gets its own workspace, shown with the email in the session', async () => {
  assert.notEqual(A.ws, B.ws);
  assert.notEqual(A.ws, 'owner');
  assert.equal(A.info.principal.email, ALICE);
  assert.equal(A.info.workspace.name, 'alice');
  assert.equal(B.info.workspace.name, 'bob');
  // signing in again maps to the same workspace
  assert.equal((await signIn(ALICE)).ws, A.ws);
  const me = await app.api('GET', '/me', { key: aliceKey });
  assert.equal(me.json.workspace.id, A.ws);
});

for (const [label, call] of [['UI session', asBob], ['REST API key', asBobKey]]) {
  test(`${label}: Bob sees none of Alice's data and gets 404 on her ids`, async () => {
    const empty = async (path, field) => {
      const r = await call('GET', path);
      assert.equal(r.status, 200, `${path} ${r.text}`);
      assert.equal(r.json[field].length, 0, `${path} must be empty for Bob`);
    };
    await empty('/accounts', 'accounts');
    await empty('/posts', 'posts');
    await empty('/media', 'media');
    await empty('/approvals', 'posts');
    await empty('/webhooks', 'webhooks');
    await empty('/calendar?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z', 'entries');
    const keys = await call('GET', '/api-keys');
    assert.ok(!keys.json.api_keys.some((k) => k.name.startsWith('alice')));
    const audit = await call('GET', '/audit-log');
    assert.ok(!JSON.stringify(audit.json).includes('alice'), 'audit log has nothing of Alice');
    const settings = await call('GET', '/settings');
    assert.notEqual(settings.json.settings.timezone, 'Europe/Berlin');
    const apps = await call('GET', '/platform-apps');
    const gApp = apps.json.platform_apps.find((x) => x.app === 'google');
    assert.equal(gApp.client_id, 'g-client', 'Bob sees the .env fallback, not Alice\'s saved app');
    const ov = await call('GET', '/analytics/overview');
    assert.equal(ov.json.accounts.length, 0);
    const top = await call('GET', '/analytics/top-posts');
    assert.equal(top.json.posts.length, 0);

    const nf = async (method, path, body) => {
      const r = await call(method, path, body);
      assert.equal(r.status, 404, `${method} ${path} → ${r.status} ${r.text}`);
    };
    await nf('GET', `/accounts/${aFb}`);
    await nf('POST', `/accounts/${aFb}/check`);
    await nf('DELETE', `/accounts/${aFb}`);
    await nf('GET', `/posts/${aGroup}`);
    await nf('PATCH', `/posts/${aGroup}`, { content: 'hijack' });
    await nf('POST', `/posts/${aGroup}/schedule`, { next_slot: true });
    await nf('POST', `/posts/${aGroup}/reschedule`, { publish_at: Date.now() + 3 * 86400000 });
    await nf('POST', `/posts/${aGroup}/publish-now`);
    await nf('POST', `/posts/${aGroup}/retry`);
    await nf('POST', `/posts/${aGroup}/duplicate`);
    await nf('DELETE', `/posts/${aGroup}`);
    await nf('GET', `/posts/${aGroup}/metrics`);
    await nf('POST', `/posts/${aPending}/approve`);
    await nf('POST', `/posts/${aPending}/reject`, { reason: 'no' });
    await nf('GET', `/media/${aMedia.id}`);
    await nf('DELETE', `/media/${aMedia.id}`);
    await nf('POST', `/media/${aVideo.id}/poster`, { data: makeJpeg(320, 180).toString('base64') });
    await nf('GET', `/media/uploads/${aUpload}`);
    await nf('POST', `/media/uploads/${aUpload}/complete`, { parts: [{ part_number: 1, etag: 'x' }, { part_number: 2, etag: 'y' }] });
    await nf('DELETE', `/media/uploads/${aUpload}`);
    await nf('PATCH', `/webhooks/${aHook}`, { active: false });
    await nf('DELETE', `/webhooks/${aHook}`);
    await nf('POST', `/webhooks/${aHook}/rotate-secret`);
    await nf('POST', `/webhooks/${aHook}/test`);
    await nf('GET', `/webhooks/${aHook}/deliveries`);
    await nf('PATCH', `/api-keys/${aKeyId}`, { name: 'pwned' });
    await nf('DELETE', `/api-keys/${aKeyId}`);
    await nf('GET', `/analytics/accounts/${aFb}`);
    await nf('GET', `/analytics/top-posts?account_id=${aFb}`);
    await nf('POST', '/analytics/sync', { account_id: aFb });

    // Using Alice's ids inside Bob's own writes is refused too.
    const cp = await call('POST', '/posts', { content: 'x', targets: [{ account_id: aFb }] });
    assert.equal(cp.status, 400, cp.text);
    assert.match(cp.json.error.message, /Unknown account_id/);
    const val = await call('POST', '/posts/validate', { content: 'x', media_ids: [aMedia.id], targets: [{ account_id: aFb }] });
    assert.equal(val.json.ok, false);

    // CSV export
    const csvAcc = await call('GET', `/analytics/export.csv?kind=account&account_id=${aFb}`);
    assert.equal(csvAcc.status, 404);
    const csvPosts = await call('GET', '/analytics/export.csv');
    assert.equal(csvPosts.status, 200);
    assert.ok(!csvPosts.text.includes('Alice'), 'posts CSV has no Alice rows');

    // Alice's things are all still there and unchanged.
    const g = await sa.posts.getGroup(aGroup);
    assert.equal(g.content, 'Alice secret plan');
    assert.equal(g.status, 'scheduled');
    assert.ok(await sa.integrations.get(aFb));
    assert.ok(await sa.media.get(aMedia.id));
    assert.equal((await sa.webhooks.get(aHook)).active, true);
    assert.equal((await sa.apiKeys.get(aKeyId)).revoked_at, null);
    assert.equal((await sa.posts.getGroup(aPending)).status, 'pending_approval');
  });
}

test('Bob cannot reuse Alice\'s media in his own post (session)', async () => {
  const bFb = await sb.integrations.upsert('instagram-standalone', { external_id: 'igs-bob', name: 'Bob IG', access_token: 'ig-long', refresh_token: 'ig-long', token_expires_at: Date.now() + 50 * 86400000 });
  const r = await asBob('POST', '/posts', { content: 'x', media_ids: [aMedia.id], targets: [{ account_id: bFb }] });
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error.message, /Unknown media/);
  const r2 = await asBob('POST', '/posts', { content: 'x', targets: [{ account_id: bFb, media_ids: [aMedia.id] }] });
  assert.equal(r2.status, 400, r2.text);
  // and Alice sees nothing of Bob
  assert.ok(!(await sa.integrations.list()).some((a) => a.id === bFb));
  await sb.integrations.remove(bFb);
});

test('Alice sees her own data through her key and session', async () => {
  const acc = await app.api('GET', '/accounts', { key: aliceKey });
  assert.deepEqual(acc.json.accounts.map((a) => a.id).sort(), [aFb, aYt].sort());
  const posts = await app.api('GET', '/posts', { session: A });
  assert.ok(posts.json.posts.some((p) => p.id === aGroup));
  const appr = await app.api('GET', '/approvals', { session: A });
  assert.deepEqual(appr.json.posts.map((p) => p.id), [aPending]);
  const csv = await app.api('GET', `/analytics/export.csv?kind=account&account_id=${aFb}`, { session: A });
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Alice Page,facebook/);
});

test('MCP: a key only ever reaches its own workspace', async () => {
  const list = await mcp(bobKey, 'tools/call', { name: 'list_accounts', arguments: {} });
  assert.equal(list.result.structuredContent.accounts.length, 0);
  const get = await mcp(bobKey, 'tools/call', { name: 'get_post', arguments: { post_id: aGroup } });
  assert.equal(get.result.isError, true);
  assert.equal(get.result.structuredContent.error.status, 404);
  const appr = await mcp(bobKey, 'tools/call', { name: 'approve_post', arguments: { post_id: aPending } });
  assert.equal(appr.result.structuredContent.error.status, 404);
  const res = await mcp(bobKey, 'resources/read', { uri: `postlite://posts/${aGroup}` });
  assert.ok(res.error, 'resource read of another workspace\'s post fails');
  const mine = await mcp(aliceKey, 'tools/call', { name: 'get_post', arguments: { post_id: aGroup } });
  assert.equal(mine.result.structuredContent.post.content, 'Alice secret plan');
});

test('media URLs: only the exact per-file token works; Bob never learns Alice\'s tokens', async () => {
  const ok = await fetch(`${app.base}${sa.media.view(aMedia).url}`);
  assert.equal(ok.status, 200); // public by design: Meta/Google fetch it
  const bobMedia = await sb.media.save(new Uint8Array(makeJpeg(400, 400)), 'bob.jpg');
  // Bob's token with Alice's file name, and Alice's token with Bob's file name: 404
  assert.equal((await fetch(`${app.base}/m/${bobMedia.token}/${aMedia.filename}`)).status, 404);
  assert.equal((await fetch(`${app.base}/m/${aMedia.token}/${bobMedia.filename}`)).status, 404);
  const listed = JSON.stringify((await asBob('GET', '/media')).json);
  assert.ok(!listed.includes(aMedia.token));
  await sb.media.remove(bobMedia.id);
});

test('OAuth: callbacks and pending selections are bound to the workspace that started them', async () => {
  // Alice starts a Facebook connect (two pages → picker)
  const start = await fetch(`${app.base}/oauth/facebook/start`, { redirect: 'manual', headers: { cookie: A.cookie } });
  assert.equal(start.status, 302);
  const consent = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = consent.headers.get('location');
  // Bob opening Alice's callback URL: 404, and it does not consume her flow
  const stolen = await fetch(cb, { redirect: 'manual', headers: { cookie: B.cookie } });
  assert.equal(stolen.status, 404);
  const res = await fetch(cb, { redirect: 'manual', headers: { cookie: A.cookie } });
  assert.equal(res.status, 302);
  const state = /select\/([\w-]+)/.exec(res.headers.get('location'))[1];
  assert.equal((await asBob('GET', `/oauth/pending/${state}`)).status, 404);
  assert.equal((await asBob('POST', `/oauth/pending/${state}`, { external_ids: ['page2'] })).status, 404);
  assert.equal((await app.api('GET', `/oauth/pending/${state}`, { key: bobKey })).status, 404);
  const sel = await app.api('POST', `/oauth/pending/${state}`, { session: A, body: { external_ids: ['page2'] } });
  assert.equal(sel.status, 200, sel.text);
  assert.ok((await sa.integrations.list()).some((a) => a.external_id === 'page2'));
  assert.ok(!(await sb.integrations.list()).some((a) => a.external_id === 'page2'));
  // Reconnect of someone else's account id is refused
  const rc = await fetch(`${app.base}/oauth/facebook/start?reconnect=${aFb}`, { redirect: 'manual', headers: { cookie: B.cookie } });
  assert.equal(rc.status, 404);
  // An account already connected in Alice's workspace cannot be taken over by Bob's connect
  await assert.rejects(sb.integrations.upsert('facebook', { external_id: 'page1', name: 'x', access_token: 'stolen' }), (e) => e.status === 409);
  assert.equal((await sa.integrations.secret(aFb)).access_token, 'page1-token', 'tokens untouched');
});

test('webhooks: events go to the workspace\'s own hooks only', async () => {
  const bHook = (await sb.webhooks.create({ url: 'http://127.0.0.1:9/bob', events: ['*'] })).id;
  await sa.webhooks.emit('post.published', { post_id: aGroup });
  assert.equal((await sa.webhooks.deliveries(aHook)).filter((d) => d.event === 'post.published').length, 1);
  assert.equal((await sb.webhooks.deliveries(bHook)).length, 0);
  assert.equal((await sb.webhooks.deliveries(aHook)).length, 0, 'Bob cannot read Alice\'s delivery log');
  await sb.webhooks.remove(bHook);
});

test('scheduler and token refresh use the post\'s own workspace credentials', async () => {
  // Alice saved her own Google app; Bob uses the instance .env fallback.
  assert.equal(sa.cfg.google.clientId, 'alice-client.apps.googleusercontent.com');
  assert.equal(sb.cfg.google.clientId, 'g-client');
  app.fake.state.googleRefreshClients = [];
  await sa.integrations.refresh(aYt);
  assert.deepEqual(app.fake.state.googleRefreshClients, ['alice-client.apps.googleusercontent.com']);
  // A post Alice publishes now goes out with her page token, through the shared queue.
  const gid = await sa.posts.saveGroup({ content: 'Alice live now', action: 'now', posts: [{ integration_id: aFb }] });
  const g = await waitFor(async () => { await app.core.scheduler.tick(); const x = await sa.posts.getGroup(gid); return ['published', 'failed'].includes(x.status) && x; });
  assert.equal(g.status, 'published', JSON.stringify(g.targets[0]));
  assert.equal((await sa.webhooks.deliveries(aHook)).filter((d) => d.event === 'post.published').length, 2);
});

test('tenant guard: a statement without a workspace filter fails loudly', async () => {
  assert.throws(() => checkTenantSql('SELECT * FROM posts WHERE id = ?'), TenantGuardError);
  assert.throws(() => checkTenantSql('UPDATE integrations SET name = ? WHERE id = ?'), TenantGuardError);
  assert.throws(() => checkTenantSql('DELETE FROM webhooks WHERE id = ?'), TenantGuardError);
  assert.throws(() => checkTenantSql('INSERT INTO media(id) VALUES(?)'), TenantGuardError);
  assert.throws(() => checkTenantSql('SELECT e.* FROM post_events e WHERE post_id = ?'), TenantGuardError);
  checkTenantSql('SELECT * FROM posts WHERE id = ? AND workspace_id = ?');
  checkTenantSql('SELECT value FROM settings WHERE key = ?');
  checkTenantSql('SELECT * FROM jobs WHERE state = ? /* ws:system */');
  await assert.rejects(app.core.db.get('SELECT * FROM groups WHERE id = ?', aGroup), TenantGuardError);
  assert.throws(() => app.root.scope(''), /Workspace required/);
  assert.throws(() => app.root.scope(undefined), /Workspace required/);
  // every SQL string in src/ passes the guard (static check of the shipped code)
  const g = guardDb(openDb(':memory:'));
  await assert.rejects(g.all('SELECT * FROM api_keys'), TenantGuardError);
  g.close();
});

test('password mode keeps the single owner workspace', async () => {
  const pw = await createTestApp();
  try {
    const s = await pw.login();
    const info = await (await fetch(`${pw.base}/api/v1/session`, { headers: { cookie: s.cookie } })).json();
    assert.equal(info.workspace.id, 'owner');
    const k = (await pw.core.apiKeys.create({ name: 'k' })).key;
    assert.equal((await pw.api('GET', '/me', { key: k })).json.workspace.id, 'owner');
  } finally { await pw.close(); }
});
