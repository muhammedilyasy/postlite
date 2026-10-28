import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp, makeJpeg, makeMp4, waitFor } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let app, yt, ig;
before(async () => {
  app = await createTestApp();
  yt = await app.seed('youtube');
  ig = await app.seed('instagram');
  app.core.scheduler.start();
});
after(async () => { await app.close(); });

/** Minimal MCP client over a child process' stdio. */
function stdioClient(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/postlite.js'), 'mcp'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map();
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  let id = 0;
  return {
    request(method, params) {
      const mid = ++id;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout ${method}; stderr: ${stderr}`)), 15000);
        waiting.set(mid, (m) => { clearTimeout(t); resolve(m); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
      });
    },
    notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
    close() { child.stdin.end(); return new Promise((r) => child.on('exit', r)); },
  };
}

function httpClient(key) {
  let id = 0;
  let session = null;
  return async function request(method, params, { raw = false } = {}) {
    const res = await fetch(`${app.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    session = res.headers.get('mcp-session-id') || session;
    if (raw) return res;
    return res.json();
  };
}

const childEnv = (key, extra = {}) => ({
  DATA_DIR: app.dir, TOKEN_ENC_KEY: 'test-token-encryption-key-0123456789', PUBLIC_URL: app.base, POSTLITE_API_KEY: key, LOG_LEVEL: 'silent',
  ALLOW_PRIVATE_MEDIA_URLS: '1', ...app.fake.env(), ...extra,
});

test('MCP over HTTP: auth, initialize, tools/list, tools/call end-to-end publish to YouTube (Short)', async () => {
  const unauth = await httpClient(null)('initialize', {}, { raw: true });
  assert.equal(unauth.status, 401);
  const key = (await app.core.apiKeys.create({ name: 'Claude', approval_mode: false })).key;
  const rpc = httpClient(key);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'postlite');
  assert.match(init.result.instructions, /list_platforms/);
  const tools = (await rpc('tools/list', {})).result.tools;
  const names = tools.map((t) => t.name);
  for (const n of ['create_post', 'validate_post', 'list_accounts', 'upload_media_from_url', 'get_top_posts', 'approve_post', 'create_webhook', 'list_free_slots']) assert.ok(names.includes(n), n);
  assert.ok(tools.every((t) => t.inputSchema?.type === 'object' && t.description.length > 20));
  assert.ok(!names.includes('upload_media_from_path'), 'local path upload is stdio-only');

  const src = await app.upload(makeMp4({ width: 1080, height: 1920, seconds: 45, mdatBytes: 400000 }), 'src.mp4');
  const up = await rpc('tools/call', { name: 'upload_media_from_url', arguments: { url: app.core.media.publicUrl(src), filename: 'short.mp4' } });
  assert.equal(up.result.isError, false, up.result.content[0].text);
  const media = up.result.structuredContent.media;
  assert.equal(media.duration, 45);

  // invalid input → isError with guidance (not a protocol error)
  const bad = await rpc('tools/call', { name: 'create_post', arguments: { content: 'x', media_ids: [media.id], targets: [{ account_id: yt, settings: { isShort: true } }], mode: 'now' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /YouTube title is required/);

  const ok = await rpc('tools/call', { name: 'create_post', arguments: { content: 'My first Short #shorts', media_ids: [media.id], targets: [{ account_id: yt, settings: { title: 'Agent Short', isShort: true } }], mode: 'now' } });
  assert.equal(ok.result.isError, false, ok.result.content[0].text);
  const postId = ok.result.structuredContent.post.id;
  const done = await waitFor(async () => {
    const r = await rpc('tools/call', { name: 'get_post', arguments: { post_id: postId } });
    const p = r.result.structuredContent.post;
    return p.status === 'published' ? p : null;
  });
  assert.match(done.targets[0].published_url, /youtube\.com\/watch/);

  const unknown = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.error.code, -32602);
  const res = await rpc('resources/read', { uri: 'postlite://accounts' });
  assert.ok(JSON.parse(res.result.contents[0].text).accounts.length >= 2);
  const prompts = await rpc('prompts/get', { name: 'schedule_short', arguments: { video: 'https://x/y.mp4' } });
  assert.match(prompts.result.messages[0].content.text, /isShort/);
  const notif = await fetch(`${app.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(notif.status, 202);
  const evil = await fetch(`${app.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(evil.status, 403);
});

test('MCP over HTTP: scope errors are tool errors with a fix hint', async () => {
  const key = (await app.core.apiKeys.create({ name: 'readonly', scopes: ['read'] })).key;
  const rpc = httpClient(key);
  const r = await rpc('tools/call', { name: 'sync_analytics', arguments: {} });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /"analytics" scope/);
});

test('MCP over stdio (in-process): approval mode flow + local file upload + publish', async () => {
  const key = (await app.core.apiKeys.create({ name: 'Hermes', approval_mode: true })).key;
  const c = stdioClient(childEnv(key));
  try {
    const init = await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    c.notify('notifications/initialized');
    const tools = (await c.request('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(tools.includes('upload_media_from_path'));
    const fs = await import('node:fs');
    const file = path.join(app.dir, 'local.jpg');
    fs.writeFileSync(file, makeJpeg(1080, 1350));
    const up = await c.request('tools/call', { name: 'upload_media_from_path', arguments: { path: file } });
    assert.equal(up.result.isError, false, up.result.content[0].text);
    const mid = up.result.structuredContent.media.id;
    const who = await c.request('tools/call', { name: 'whoami', arguments: {} });
    assert.equal(who.result.structuredContent.principal.approval_mode, true);
    const cr = await c.request('tools/call', { name: 'create_post', arguments: { content: 'From stdio', media_ids: [mid], targets: [{ account_id: ig }], mode: 'now' } });
    assert.equal(cr.result.isError, false, cr.result.content[0].text);
    const post = cr.result.structuredContent.post;
    assert.equal(post.status, 'pending_approval');
    assert.match(cr.result.structuredContent.note, /approval/);
    // human approves in the UI
    const s = await app.login();
    const ap = await app.api('POST', `/posts/${post.id}/approve`, { session: s, body: {} });
    assert.equal(ap.status, 200, ap.text);
    const done = await waitFor(async () => {
      const r = await c.request('tools/call', { name: 'get_post', arguments: { post_id: post.id } });
      return r.result.structuredContent.post.status === 'published' ? r.result.structuredContent.post : null;
    });
    assert.match(done.targets[0].published_url, /instagram\.com/);
    const audit = await app.core.audit.list({ limit: 50 });
    assert.ok(audit.some((e) => e.via === 'mcp-stdio' && e.operation === 'create_post' && e.actor_name === 'Hermes'));
  } finally {
    await c.close();
  }
});

test('MCP stdio bridge mode forwards to a remote server', async () => {
  const key = (await app.core.apiKeys.create({ name: 'bridge', approval_mode: false })).key;
  const c = stdioClient({ POSTLITE_URL: app.base, POSTLITE_API_KEY: key, LOG_LEVEL: 'silent' });
  try {
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'postlite');
    const tools = (await c.request('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(tools.includes('upload_media_from_path'), 'bridge adds local upload tool');
    const fs = await import('node:fs');
    const file = path.join(app.dir, 'bridge.jpg');
    fs.writeFileSync(file, makeJpeg(640, 640));
    const up = await c.request('tools/call', { name: 'upload_media_from_path', arguments: { path: file } });
    assert.equal(up.result.isError, false, up.result.content[0].text);
    const acc = await c.request('tools/call', { name: 'list_accounts', arguments: {} });
    assert.ok(acc.result.structuredContent.accounts.length >= 2);
  } finally {
    await c.close();
  }
});

test('CLI mirrors the API (posts create/list via HTTP)', async () => {
  const key = (await app.core.apiKeys.create({ name: 'cli', approval_mode: false })).key;
  const run = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin/postlite.js'), ...args], { env: { ...process.env, POSTLITE_URL: app.base, POSTLITE_API_KEY: key } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, out, err }));
  });
  const fb = await app.seed('facebook');
  const c = await run(['posts', 'create', '--content', 'from the cli', '--accounts', fb, '--at', new Date(Date.now() + 86400000).toISOString()]);
  assert.equal(c.code, 0, c.err);
  const created = JSON.parse(c.out).post;
  assert.equal(created.status, 'scheduled');
  const l = await run(['posts', 'list', '--status', 'scheduled']);
  assert.ok(JSON.parse(l.out).posts.some((p) => p.id === created.id));
  const bad = await run(['call', 'create_post', '--json', '{"targets":[{"account_id":"x"}],"mode":"now"}']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /list_accounts/);
});
