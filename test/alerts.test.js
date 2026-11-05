// Alerts: SMTP client protocol (fake server checks STARTTLS / implicit TLS, AUTH PLAIN/LOGIN, dot-stuffing,
// timeouts), Resend over HTTP (fake endpoint), in-app notifications from the scheduler and token health,
// batching + dedupe, daily digest, preferences, test email, and per-user isolation in Cloudflare Access mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createTestApp, waitFor } from './helpers.js';
import { smtpSend, dotStuff } from '../src/node/smtp.js';
import { buildMime, addressOf, renderEmail } from '../src/email.js';

// ---------------------------------------------------------------- fake SMTP server
let cert = null;
function makeCert() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pl-smtp-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'pipe' });
    return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * mode: 'starttls' (plain + STARTTLS), 'implicit' (TLS from the first byte), 'plain' (no TLS at all), 'silent' (never greets).
 * auth: ['PLAIN','LOGIN'] advertised mechanisms. Records every session: { commands, tlsAtAuth, user, pass, from, to, data }.
 */
function fakeSmtp({ mode = 'starttls', auth = ['PLAIN', 'LOGIN'], user = 'mailer', pass = 'p@ss:word' } = {}) {
  const sessions = [];
  const handle = (socket, secureFromStart) => {
    if (mode === 'silent') return;
    const s = { commands: [], tls: secureFromStart, tlsAtAuth: null, messages: [] };
    sessions.push(s);
    let sock = socket, buf = '', state = 'cmd', data = [], loginStep = 0, loginUser = '';
    const send = (l) => sock.write(`${l}\r\n`);
    const onLine = (line) => {
      if (state === 'data') {
        if (line === '.') { state = 'cmd'; s.messages.push({ from: s.from, to: s.to, data: data.join('\r\n') + '\r\n' }); data = []; return send('250 2.0.0 queued'); }
        data.push(line.startsWith('.') ? line.slice(1) : line);
        return;
      }
      if (loginStep === 1) { loginUser = Buffer.from(line, 'base64').toString(); loginStep = 2; return send('334 UGFzc3dvcmQ6'); }
      if (loginStep === 2) { loginStep = 0; s.user = loginUser; s.pass = Buffer.from(line, 'base64').toString(); return send(s.user === user && s.pass === pass ? '235 2.7.0 ok' : '535 5.7.8 bad credentials'); }
      const verb = line.split(' ')[0].toUpperCase();
      s.commands.push(verb === 'AUTH' ? `AUTH ${line.split(' ')[1]}` : verb);
      if (verb === 'EHLO') {
        const ext = [...(mode === 'starttls' && !s.tls ? ['STARTTLS'] : []), ...(auth.length ? [`AUTH ${auth.join(' ')}`] : []), '8BITMIME'];
        send('250-fake.smtp.test greets you');
        ext.forEach((e, i) => send(`250${i === ext.length - 1 ? ' ' : '-'}${e}`));
      } else if (verb === 'STARTTLS') {
        send('220 2.0.0 ready');
        sock.removeAllListeners('data');
        const t = new tls.TLSSocket(sock, { isServer: true, key: cert.key, cert: cert.cert });
        t.on('data', onData);
        t.on('error', () => {});
        sock = t; s.tls = true;
      } else if (verb === 'AUTH') {
        s.tlsAtAuth = s.tls;
        const [, mech, arg] = line.split(' ');
        if (mech.toUpperCase() === 'PLAIN') {
          const [, u, p] = Buffer.from(arg, 'base64').toString().split('\0');
          s.user = u; s.pass = p;
          send(u === user && p === pass ? '235 2.7.0 ok' : '535 5.7.8 bad credentials');
        } else { loginStep = 1; send('334 VXNlcm5hbWU6'); }
      } else if (verb === 'MAIL') { s.from = /<(.*)>/.exec(line)[1]; send('250 2.1.0 ok'); }
      else if (verb === 'RCPT') { s.to = /<(.*)>/.exec(line)[1]; send('250 2.1.5 ok'); }
      else if (verb === 'DATA') { state = 'data'; send('354 end with <CRLF>.<CRLF>'); }
      else if (verb === 'QUIT') { send('221 bye'); sock.end(); }
      else send('502 5.5.1 unknown');
    };
    function onData(d) {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); onLine(line); }
    }
    sock.on('data', onData);
    sock.on('error', () => {});
    send('220 fake.smtp.test ESMTP');
  };
  const server = mode === 'implicit'
    ? tls.createServer({ key: cert.key, cert: cert.cert }, (s) => handle(s, true))
    : net.createServer((s) => handle(s, false));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, sessions,
    messages: () => sessions.flatMap((x) => x.messages),
    close: () => new Promise((r) => { server.close(() => r()); for (const x of server._conns || []) x.destroy(); }),
  })));
}

const decodeParts = (raw) => {
  const out = {};
  for (const m of raw.matchAll(/Content-Type: (text\/\w+); charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)) out[m[1]] = Buffer.from(m[2].replace(/\r\n/g, ''), 'base64').toString('utf8');
  return out;
};

const SMTP_BASE = { host: '127.0.0.1', user: 'mailer', pass: 'p@ss:word', from: 'alerts@example.com', to: 'owner@example.com', rejectUnauthorized: false, timeoutMs: 3000 };

before(() => { cert = makeCert(); });

test('SMTP: STARTTLS then AUTH PLAIN, envelope, multi-line EHLO, dot-stuffing round trip', async () => {
  const srv = await fakeSmtp({ mode: 'starttls', auth: ['PLAIN', 'LOGIN'] });
  const raw = 'Subject: dots\r\n\r\n.leading dot\n..two dots\nplain\r\n.\r\nend';
  const r = await smtpSend({ ...SMTP_BASE, port: srv.port, raw });
  assert.equal(r.code, 250);
  const s = srv.sessions[0];
  assert.deepEqual(s.commands, ['EHLO', 'STARTTLS', 'EHLO', 'AUTH PLAIN', 'MAIL', 'RCPT', 'DATA']);
  assert.equal(s.tlsAtAuth, true, 'credentials only after TLS');
  assert.equal(s.user, 'mailer');
  assert.equal(s.pass, 'p@ss:word');
  assert.equal(s.from, 'alerts@example.com');
  assert.equal(s.to, 'owner@example.com');
  assert.equal(s.messages[0].data, raw.replace(/\r?\n/g, '\r\n') + '\r\n', 'server sees the original text after un-stuffing');
  assert.equal(dotStuff('.a\n.\nb'), '..a\r\n..\r\nb');
  await srv.close();
});

test('SMTP: implicit TLS (465-style) with AUTH LOGIN only', async () => {
  const srv = await fakeSmtp({ mode: 'implicit', auth: ['LOGIN'] });
  await smtpSend({ ...SMTP_BASE, port: srv.port, secure: '1', raw: 'Subject: hi\r\n\r\nhello' });
  const s = srv.sessions[0];
  assert.deepEqual(s.commands, ['EHLO', 'AUTH LOGIN', 'MAIL', 'RCPT', 'DATA']);
  assert.equal(s.tlsAtAuth, true);
  assert.equal(s.pass, 'p@ss:word');
  await srv.close();
});

test('SMTP: refuses clear-text AUTH, reports bad credentials, times out on a silent server, rejects header injection', async () => {
  const plain = await fakeSmtp({ mode: 'plain' });
  await assert.rejects(smtpSend({ ...SMTP_BASE, port: plain.port, raw: 'x' }), /refusing to send the SMTP password/);
  assert.ok(!plain.sessions[0].commands.includes('AUTH PLAIN'));
  await plain.close();
  const bad = await fakeSmtp({ mode: 'starttls' });
  await assert.rejects(smtpSend({ ...SMTP_BASE, pass: 'wrong', port: bad.port, raw: 'x' }), /AUTH PLAIN failed: 535/);
  await bad.close();
  const silent = await fakeSmtp({ mode: 'silent' });
  const t0 = Date.now();
  await assert.rejects(smtpSend({ ...SMTP_BASE, port: silent.port, timeoutMs: 300, raw: 'x' }), /timeout/i);
  assert.ok(Date.now() - t0 < 3000);
  await silent.close();
  await assert.rejects(smtpSend({ ...SMTP_BASE, port: 1, to: 'a@b.c>\r\nRCPT TO:<evil@x.y', raw: 'x' }), /Invalid envelope/);
  assert.throws(() => addressOf('a@b.c\r\nBcc: x@y.z'), /line breaks/);
});

test('MIME + template: base64 utf-8 parts, encoded subject, links back to the post', () => {
  const msg = renderEmail([{ kind: 'post_failed', title: 'Post failed on Café Page', body: '“Hello”\nToken expired', link: '#/posts/g1', created_at: Date.UTC(2026, 9, 29, 9) }], { publicUrl: 'https://pl.example.com' });
  assert.equal(msg.subject, 'postlite: Post failed on Café Page');
  assert.match(msg.text, /Open: https:\/\/pl\.example\.com\/#\/posts\/g1/);
  assert.match(msg.html, /href="https:\/\/pl\.example\.com\/#\/posts\/g1"/);
  const raw = buildMime({ from: 'postlite <alerts@example.com>', to: 'owner@example.com', ...msg });
  assert.match(raw, /^From: "postlite" <alerts@example\.com>\r\n/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.ok(raw.split('\r\n').every((l) => l.length <= 998));
  assert.ok(!/\r\n\.\r\n/.test(raw));
  assert.equal(decodeParts(raw)['text/plain'], msg.text);
});

// ---------------------------------------------------------------- app: SMTP transport
test('alerts over SMTP: failed post → one in-app notification + one email (deduped), batched emails, reconnect, mark read, digest, test email', async () => {
  const srv = await fakeSmtp({ mode: 'starttls' });
  const app = await createTestApp({ env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(srv.port), SMTP_USER: 'mailer', SMTP_PASS: 'p@ss:word', SMTP_FROM: 'postlite <alerts@example.com>', SMTP_TLS_REJECT_UNAUTHORIZED: '0', NOTIFY_BATCH_SECONDS: '0', ADMIN_EMAIL: 'owner@example.com' } });
  try {
    const key = (await app.core.apiKeys.create({ name: 'al', scopes: ['read', 'write', 'publish'], approval_mode: false })).key;
    const fb = await app.seed('facebook');
    const p0 = await app.api('GET', '/notifications/prefs', { key });
    assert.equal(p0.status, 200, p0.text);
    assert.deepEqual(p0.json.prefs, { post_failed: true, post_published: false, account_reconnect: true, digest: false, digest_time: '09:00', email: true });
    assert.equal(p0.json.email.configured, true);
    assert.equal(p0.json.email.transport, 'smtp');
    assert.equal(p0.json.email.to, 'owner@example.com');

    // A successful post: published alerts are off by default.
    await app.core.posts.saveGroup({ content: 'fine', media: [], action: 'now', posts: [{ integration_id: fb, settings: {} }] });
    await app.core.scheduler.drain();
    assert.equal((await app.api('GET', '/notifications', { key })).json.unread, 0);

    // A failing post (token revoked → also needs reconnect).
    app.fake.state.revoked.add('page1-token');
    const gid = await app.core.posts.saveGroup({ content: 'Launch day', media: [], action: 'now', posts: [{ integration_id: fb, settings: {} }] });
    await app.core.scheduler.drain();
    app.fake.state.revoked.delete('page1-token');
    const list = await waitFor(async () => { const r = (await app.api('GET', '/notifications', { key })).json; return r.notifications.length >= 2 && r; });
    const failed = list.notifications.find((n) => n.kind === 'post_failed');
    assert.equal(failed.link, `#/posts/${gid}`);
    assert.match(failed.title, /Post failed on Test Page/);
    assert.match(failed.body, /Launch day/);
    assert.ok(list.notifications.find((n) => n.kind === 'account_reconnect'));
    assert.equal(list.unread, 2);
    // Both go out as ONE email (batch), to the administrator address.
    await waitFor(async () => { await app.root.deliverNotifications(); return srv.messages().length === 1; });
    const mail = srv.messages()[0];
    assert.equal(mail.to, 'owner@example.com');
    assert.equal(mail.from, 'alerts@example.com');
    assert.match(mail.data, /^Subject: postlite: 1 post failed and 1 more alert/m);
    const parts = decodeParts(mail.data);
    assert.match(parts['text/plain'], new RegExp(`Open: ${app.base}/#/posts/${gid}`));
    assert.match(parts['text/html'], /needs reconnecting/);
    assert.equal((await app.api('GET', '/notifications', { key })).json.notifications.find((n) => n.id === failed.id).email, 'sent');

    // Dedupe: the same failure reported again creates nothing and sends nothing.
    const t = (await app.core.posts.getGroup(gid)).targets[0];
    const again = await app.core.notifications.postFailed({ post_id: gid, target_id: t.id, account_name: 'Test Page', error: 'x' });
    assert.equal(again, 0);
    await app.root.deliverNotifications({ force: true });
    assert.equal(srv.messages().length, 1);

    // Mark read: one, then all.
    const m1 = await app.api('POST', '/notifications/read', { key, body: { ids: [failed.id] } });
    assert.deepEqual([m1.status, m1.json.marked, m1.json.unread], [200, 1, 1]);
    assert.equal((await app.api('POST', '/notifications/read', { key, body: { all: true } })).json.unread, 0);
    assert.equal((await app.api('POST', '/notifications/read', { key, body: {} })).status, 400);
    assert.equal((await app.api('GET', '/notifications?limit=0', { key })).json.notifications.length, 0);

    // Preferences: published on, email off → in-app only.
    const up = await app.api('PATCH', '/notifications/prefs', { key, body: { post_published: true, email: false } });
    assert.equal(up.status, 200, up.text);
    assert.equal((await app.api('PATCH', '/notifications/prefs', { key, body: { digest_time: '25:00' } })).status, 400);
    await app.core.integrations.upsert('facebook', { external_id: 'page1', name: 'Test Page', access_token: 'page1-token', refresh_token: 'user-long' });
    await app.core.posts.saveGroup({ content: 'yay', media: [], action: 'now', posts: [{ integration_id: fb, settings: {} }] });
    await app.core.scheduler.drain();
    const pub = await waitFor(async () => (await app.api('GET', '/notifications', { key })).json.notifications.find((n) => n.kind === 'post_published'));
    assert.equal(pub.email, null);

    // Daily digest at 00:00 local: once per day, bundles the day, emailed right away.
    await app.api('PATCH', '/notifications/prefs', { key, body: { digest: true, digest_time: '00:00', email: true } });
    const d1 = await app.root.deliverNotifications();
    assert.equal(d1.digests, 1);
    assert.equal((await app.root.deliverNotifications()).digests, 0);
    const digest = (await app.api('GET', '/notifications', { key })).json.notifications.find((n) => n.kind === 'digest');
    assert.match(digest.body, /Last 24 hours: 2 posts published, 1 post failed\./);
    assert.equal(srv.messages().length, 2);
    assert.match(srv.messages()[1].data, /^Subject: postlite: Daily digest for /m);

    // Test email
    const te = await app.api('POST', '/notifications/test', { key, body: {} });
    assert.equal(te.status, 200, te.text);
    assert.deepEqual([te.json.to, te.json.transport], ['owner@example.com', 'smtp']);
    assert.equal(srv.messages().length, 3);
    assert.equal((await app.api('POST', '/notifications/test', { key, body: {} })).status, 429);
    // mark_read is not audited (UI clicks); prefs changes are.
    const ops = (await app.core.audit.list({ limit: 100 })).map((e) => e.operation);
    assert.ok(ops.includes('update_notification_prefs'));
    assert.ok(!ops.includes('mark_read'));
  } finally {
    await app.close();
    await srv.close();
  }
});

// ---------------------------------------------------------------- app: Resend + nothing configured
test('alerts over Resend (fake endpoint), retries then marks failed; without email config alerts stay in-app and the test button is refused', async () => {
  const app = await createTestApp({ env: { NOTIFY_BATCH_SECONDS: '0', ADMIN_EMAIL: 'owner@example.com' } });
  try {
    const key = (await app.core.apiKeys.create({ name: 'al', scopes: ['read', 'write'], approval_mode: false })).key;
    let p = (await app.api('GET', '/notifications/prefs', { key })).json;
    assert.equal(p.email.configured, false);
    assert.match(p.email.reason, /not set up/);
    assert.equal((await app.api('POST', '/notifications/test', { key, body: {} })).status, 409);
    await app.core.notifications.notify({ kind: 'post_failed', key: 'k1', title: 'in-app only' });
    assert.equal((await app.api('GET', '/notifications', { key })).json.notifications[0].email, null);

    Object.assign(app.cfg.email, { from: 'postlite <alerts@example.com>' });
    Object.assign(app.cfg.email.resend, { key: 're_test_key', url: `${app.fake.url}/resend` });
    p = (await app.api('GET', '/notifications/prefs', { key })).json;
    assert.deepEqual([p.email.configured, p.email.transport], [true, 'resend']);
    const te = await app.api('POST', '/notifications/test', { key, body: {} });
    assert.equal(te.status, 200, te.text);
    const sent = app.fake.state.emails;
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ['owner@example.com']);
    assert.equal(sent[0].from, 'postlite <alerts@example.com>');
    assert.match(sent[0].html, /settings\/notifications/);

    await app.core.notifications.notify({ kind: 'post_failed', key: 'k2', title: 'Post failed on Page', link: '#/posts/abc' });
    await app.root.deliverNotifications();
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, new RegExp(`${app.base}/#/posts/abc`));

    // Broken key: three attempts, then the row is marked failed with the reason (never resent).
    app.cfg.email.resend.key = 're_wrong';
    await app.core.notifications.notify({ kind: 'post_failed', key: 'k3', title: 'Another failure' });
    for (let i = 0; i < 4; i++) await app.root.deliverNotifications();
    const row = (await app.api('GET', '/notifications', { key })).json.notifications.find((n) => n.title === 'Another failure');
    assert.equal(row.email, 'failed');
    assert.match(row.email_error, /Resend 401/);
    assert.equal(app.fake.state.calls.filter((c) => c.path === '/resend/emails').length, 2 + 3);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- isolation (Cloudflare Access mode)
const TEAM = 'postlite-alerts.cloudflareaccess.com';
const AUD = 'a1e2d3c4b5a6978877665544332211000f1e2d3c4b5a69788776655443322110';
const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function jwt(email) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', kid: 'k', typ: 'JWT' })}.${enc({ aud: [AUD], email, exp: now + 600, iat: now, nbf: now, iss: `https://${TEAM}`, type: 'app', sub: email })}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), kp.privateKey).toString('base64url')}`;
}

test('isolation: notifications and preferences are per workspace and per user; email goes to the Access identity', async () => {
  const jwks = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: [{ ...kp.publicKey.export({ format: 'jwk' }), kid: 'k', alg: 'RS256', use: 'sig' }] })); });
  await new Promise((r) => jwks.listen(0, '127.0.0.1', r));
  const app = await createTestApp({ env: { AUTH_MODE: 'cloudflare-access', CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, ALLOWED_EMAILS: 'alice@example.com,bob@example.com', CF_ACCESS_CERTS_URL: `http://127.0.0.1:${jwks.address().port}/cdn-cgi/access/certs`, CF_ACCESS_JWKS_MIN_REFRESH_MS: '0', NOTIFY_BATCH_SECONDS: '0', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'alerts@example.com' } });
  app.cfg.email.resend.url = `${app.fake.url}/resend`;
  const signIn = async (email) => {
    const token = jwt(email);
    const r = await fetch(`${app.base}/`, { redirect: 'manual', headers: { 'cf-access-jwt-assertion': token } });
    const sid = /pl_sid=([^;]+)/.exec(r.headers.get('set-cookie') || '')[1];
    const cookie = `pl_sid=${sid}; CF_Authorization=${token}`;
    const s = await (await fetch(`${app.base}/api/v1/session`, { headers: { cookie } })).json();
    return { cookie, csrf: s.csrf, ws: s.workspace.id };
  };
  try {
    const A = await signIn('alice@example.com');
    const B = await signIn('bob@example.com');
    assert.notEqual(A.ws, B.ws);
    const sa = app.root.scope(A.ws);
    const sb = app.root.scope(B.ws);
    const aFb = await sa.integrations.upsert('facebook', { external_id: 'page1', name: 'Alice Page', access_token: 'page1-token', refresh_token: 'user-long' });
    app.fake.state.revoked.add('page1-token');
    const gid = await sa.posts.saveGroup({ content: 'Alice secret', media: [], action: 'now', posts: [{ integration_id: aFb, settings: {} }] });
    await app.root.scheduler.drain();
    app.fake.state.revoked.delete('page1-token');
    const al = await waitFor(async () => { const r = (await app.api('GET', '/notifications', { session: A })).json; return r.notifications.length && r; });
    assert.equal(al.notifications.find((n) => n.kind === 'post_failed').link, `#/posts/${gid}`);
    const aliceIds = al.notifications.map((n) => n.id);
    // Bob sees nothing and cannot mark Alice's notifications read.
    const bl = await app.api('GET', '/notifications', { session: B });
    assert.deepEqual([bl.json.notifications.length, bl.json.unread], [0, 0]);
    const bm = await app.api('POST', '/notifications/read', { session: B, body: { ids: aliceIds } });
    assert.equal(bm.json.marked, 0);
    assert.equal((await app.api('GET', '/notifications', { session: A })).json.unread, al.unread);
    const bobKey = (await sb.apiKeys.create({ name: 'b', scopes: ['read', 'write'], approval_mode: false })).key;
    assert.equal((await app.api('GET', '/notifications', { key: bobKey })).json.notifications.length, 0);
    // Preferences are per user.
    await app.api('PATCH', '/notifications/prefs', { session: B, body: { post_failed: false, digest: true } });
    const ap = (await app.api('GET', '/notifications/prefs', { session: A })).json;
    assert.deepEqual([ap.prefs.post_failed, ap.prefs.digest, ap.email.to], [true, false, 'alice@example.com']);
    assert.equal((await app.api('GET', '/notifications/prefs', { session: B })).json.email.to, 'bob@example.com');
    // Email goes only to Alice's Access identity.
    await app.root.deliverNotifications();
    // The background delivery loop may have claimed the batch first; wait for it to land.
    const to = (await waitFor(() => (app.fake.state.emails || []).length && app.fake.state.emails)).map((e) => e.to[0]);
    assert.ok(to.length >= 1);
    assert.ok(to.every((t) => t === 'alice@example.com'), JSON.stringify(to));
    assert.ok((app.fake.state.emails || []).every((e) => !/Bob/i.test(e.text)));
    // Bob's test email goes to Bob.
    assert.equal((await app.api('POST', '/notifications/test', { session: B, body: {} })).json.to, 'bob@example.com');
    // Wiping Bob's workspace removes his prefs/notifications only.
    await sb.notifications.notify({ kind: 'account_reconnect', key: 'bob1', title: 'Bob alert' }); // Bob turned post_failed off above, so use a kind he still receives
    // Bob turned the digest on above, so after 09:00 workspace time a digest may also be waiting; count only this alert.
    assert.equal((await app.api('GET', '/notifications', { session: B })).json.notifications.filter((n) => n.kind === 'account_reconnect').length, 1);
    const wiped = await sb.wipe.wipe({ confirm: 'bob@example.com' });
    assert.ok(wiped.deleted.notifications >= 1, JSON.stringify(wiped.deleted));
    assert.equal((await app.api('GET', '/notifications', { session: B })).json.unread, 0);
    assert.ok((await app.api('GET', '/notifications', { session: A })).json.notifications.length >= 1);
    assert.equal((await app.api('GET', '/notifications/prefs', { session: A })).json.prefs.post_failed, true);
  } finally {
    await app.close();
    await new Promise((r) => jwks.close(r));
  }
});
