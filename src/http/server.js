// HTTP server (node:http, no framework): web UI, login/session/CSRF, OAuth callbacks, public media,
// REST API /api/v1 (session or API key), OpenAPI, MCP Streamable HTTP at /mcp.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { randomToken, sha256, safeEqual, verifyPassword } from '../crypto.js';
import { HttpError } from '../media.js';
import { operations, execute } from '../api/operations.js';
import { coerceQuery } from '../api/schema.js';
import { openapi } from '../api/openapi.js';
import { createMcp } from '../mcp.js';
import { SESSION_PRINCIPAL } from '../apikeys.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const SESSION_DAYS = 14;
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json' };

const routes = operations.map((op) => {
  const names = [];
  const re = new RegExp('^/api/v1' + op.path.replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  return { op, re, names };
});

function parseCookies(h = '') {
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createServer(core) {
  const { cfg, db, log } = core;
  const mcp = createMcp(core, { via: 'mcp-http', version: VERSION });
  const loginFails = new Map();
  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${cfg.secureCookies ? '; Secure' : ''}`;
  const publicOrigin = new URL(cfg.publicUrl).origin;
  // Session ids are stored only as (keyed) hashes; SESSION_SECRET adds a server-side pepper.
  const sessHash = (sid) => (cfg.sessionSecret ? crypto.createHmac('sha256', cfg.sessionSecret).update(sid).digest('hex') : sha256(sid));

  const baseHeaders = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
  };
  const CSP = "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https:";

  function send(res, status, body, headers = {}) {
    if (res.headersSent) return res.end();
    const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(status, { ...baseHeaders, ...(isObj ? { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } : {}), ...headers });
    res.end(isObj ? JSON.stringify(body) : body);
  }
  const sendError = (res, e, headers = {}) => {
    const status = e.status || 500;
    if (status >= 500) log('error', e.stack || String(e));
    send(res, status, { error: { status, message: status >= 500 && !e.status ? 'Internal server error' : e.message, ...(e.extra ? { details: e.extra } : {}) } }, headers);
  };

  // ---- sessions ----
  function getSession(req) {
    const sid = parseCookies(req.headers.cookie).pl_sid;
    if (!sid) return null;
    const s = db.get('SELECT * FROM sessions WHERE id_hash = ?', sessHash(sid));
    if (!s || s.expires_at < Date.now()) return null;
    return s;
  }
  function createSession(req, res) {
    const sid = randomToken(32);
    const csrf = randomToken(24);
    db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    db.run('INSERT INTO sessions(id_hash, csrf, created_at, expires_at, ip, ua) VALUES(?,?,?,?,?,?)', sessHash(sid), csrf, Date.now(), Date.now() + SESSION_DAYS * 86400000, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
    return `pl_sid=${sid}; ${cookieFlags}; Max-Age=${SESSION_DAYS * 86400}`;
  }
  const clientIp = (req) => (process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';

  function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return o === publicOrigin || o === `http://${host}` || o === `https://${host}`;
  }

  /** Resolve the caller: Bearer API key or session cookie (+CSRF on mutations). */
  function authenticate(req) {
    const auth = req.headers.authorization || '';
    if (/^Bearer\s+/i.test(auth)) {
      const p = core.apiKeys.authenticate(auth.replace(/^Bearer\s+/i, ''));
      if (!p) throw new HttpError(401, 'Invalid or revoked API key.');
      const rl = core.apiKeys.rateLimit(p);
      if (!rl.ok) throw Object.assign(new HttpError(429, `Rate limit exceeded for this key (${p.rateLimit}/min). Retry after ${rl.retryAfter}s.`), { retryAfter: rl.retryAfter });
      return p;
    }
    const s = getSession(req);
    if (!s) throw new HttpError(401, 'Not logged in. Use a session or "Authorization: Bearer <API key>".');
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (!safeEqual(String(req.headers['x-csrf-token'] || ''), s.csrf) || !originOk(req)) throw new HttpError(403, 'CSRF check failed. Reload the page.');
    }
    return { ...SESSION_PRINCIPAL, csrf: s.csrf };
  }

  function serveFile(res, file, { csp = false, req = null } = {}) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
      const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      const headers = { ...baseHeaders, etag, 'cache-control': 'no-cache', ...(csp ? { 'content-security-policy': CSP } : {}) };
      if (req && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': st.size });
      fs.createReadStream(file).pipe(res);
    });
  }

  function loginPage(res, error = '') {
    const csrf = randomToken(18);
    const needsSetup = !db.getSetting('admin_password');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8')
      .replace('{{CSRF}}', csrf)
      .replace('{{ERROR}}', error ? `<p class="error">${esc(error)}</p>` : '')
      .replace('{{SETUP}}', needsSetup ? '<p class="hint">No password set yet. On the server run: <code>node bin/postlite.js set-password</code></p>' : '');
    send(res, error ? 401 : 200, html, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `pl_lcsrf=${csrf}; ${cookieFlags}; Max-Age=1800`, 'content-security-policy': CSP, 'cache-control': 'no-store' });
  }

  function htmlMessage(res, status, title, body, link = '/') {
    send(res, status, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/app.css"><title>${esc(title)}</title><body class="center-page"><div class="card narrow"><h1>${esc(title)}</h1><p>${body}</p><p><a class="btn primary" href="${esc(link)}">Continue</a></p></div></body>`, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP });
  }

  async function handleApi(req, res, url) {
    const p = url.pathname;
    if (p === '/api/v1/openapi.json' && req.method === 'GET') return send(res, 200, openapi(cfg, VERSION), { 'access-control-allow-origin': '*' });
    let principal;
    try { principal = authenticate(req); } catch (e) { return sendError(res, e, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : e.status === 401 ? { 'www-authenticate': 'Bearer realm="postlite"' } : {}); }
    const via = principal.type === 'session' ? 'ui' : 'rest';

    // raw media upload
    if (p === '/api/v1/media' && req.method === 'POST' && !/json/i.test(req.headers['content-type'] || '')) {
      try {
        if (!principal.scopes.includes('write') && !principal.scopes.includes('admin')) throw new HttpError(403, 'This API key lacks the "write" scope.');
        const name = String(req.headers['x-filename'] || url.searchParams.get('filename') || 'upload');
        const m = await core.media.save(req, decodeURIComponent(name));
        core.audit.record({ principal, via, operation: 'upload_media', target: m.id, status: 200, detail: { name, size: m.size } });
        return send(res, 200, { media: { ...core.media.view(m), public_url: core.media.publicUrl(m) } });
      } catch (e) { return sendError(res, e); }
    }
    if (p === '/api/v1/analytics/export.csv' && req.method === 'GET') {
      try {
        if (!principal.scopes.includes('analytics') && !principal.scopes.includes('admin')) throw new HttpError(403, 'This API key lacks the "analytics" scope.');
        const q = Object.fromEntries(url.searchParams);
        const to = q.to ? Date.parse(q.to) : Date.now();
        const from = q.from ? Date.parse(q.from) : to - 30 * 86400000;
        let csv;
        if (q.kind === 'account') {
          if (!q.account_id) throw new HttpError(400, 'account_id is required for kind=account');
          csv = core.analytics.csvAccount(q.account_id, from, to);
        } else csv = core.analytics.csvPosts({ integrationId: q.account_id || null, from, to, sort: q.sort || 'views' });
        return send(res, 200, csv, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="postlite-${q.kind === 'account' ? 'account' : 'posts'}-${new Date().toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store' });
      } catch (e) { return sendError(res, e); }
    }
    // UI-only helpers for the OAuth account picker
    let m;
    if ((m = /^\/api\/v1\/oauth\/pending\/([\w-]+)$/.exec(p))) {
      try {
        if (principal.type !== 'session' && !principal.scopes.includes('admin')) throw new HttpError(403, 'admin scope required');
        if (req.method === 'GET') return send(res, 200, core.oauth.pending(m[1]));
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req, 65536)).toString() || '{}');
          const connected = core.oauth.select(m[1], body.external_ids || []);
          core.audit.record({ principal, via, operation: 'select_accounts', status: 200, detail: { connected } });
          return send(res, 200, { connected });
        }
      } catch (e) { return sendError(res, e); }
    }
    if (p === '/api/v1/oauth/providers' && req.method === 'GET') return send(res, 200, { providers: core.oauth.available() });
    if (p === '/api/v1/session' && req.method === 'GET') return send(res, 200, { csrf: principal.csrf || null, principal: { type: principal.type, name: principal.name, scopes: principal.scopes }, version: VERSION });

    for (const r of routes) {
      if (r.op.method !== req.method) continue;
      const mm = r.re.exec(p);
      if (!mm) continue;
      try {
        let input = {};
        if (req.method === 'GET' || req.method === 'DELETE') input = coerceQuery(r.op.input, Object.fromEntries(url.searchParams));
        else {
          const raw = await readBody(req, r.op.name === 'upload_media_base64' ? 40 * 1024 * 1024 : 2 * 1024 * 1024);
          if (raw.length) {
            try { input = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Body must be valid JSON.'); }
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Body must be a JSON object.');
          }
        }
        r.names.forEach((n, i) => { input[n] = decodeURIComponent(mm[i + 1]); });
        for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
        const result = await execute(core, r.op, input, principal, via);
        return send(res, 200, result);
      } catch (e) { return sendError(res, e); }
    }
    return sendError(res, new HttpError(404, `No API route ${req.method} ${p}. See /api/v1/openapi.json.`));
  }

  async function handleMcp(req, res) {
    if (!originOk(req)) return send(res, 403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed' } });
    if (req.method === 'GET') return send(res, 405, 'This server does not offer an SSE stream; use POST.', { allow: 'POST, DELETE', 'content-type': 'text/plain' });
    if (req.method === 'DELETE') return send(res, 204, '');
    if (req.method !== 'POST') return send(res, 405, '', { allow: 'POST, DELETE' });
    const auth = req.headers.authorization || '';
    const principal = /^Bearer\s+/i.test(auth) ? core.apiKeys.authenticate(auth.replace(/^Bearer\s+/i, '')) : null;
    if (!principal) {
      return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: send "Authorization: Bearer <postlite API key>". Create one in Settings → API keys or with `node bin/postlite.js keys create`.' } }, { 'www-authenticate': 'Bearer realm="postlite-mcp"' });
    }
    const rl = core.apiKeys.rateLimit(principal);
    if (!rl.ok) return send(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32029, message: `Rate limit exceeded; retry after ${rl.retryAfter}s` } }, { 'retry-after': String(rl.retryAfter) });
    let body;
    try {
      body = JSON.parse((await readBody(req, 40 * 1024 * 1024)).toString('utf8'));
    } catch {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const out = await mcp.handleAny(body, principal);
    const headers = {};
    const isInit = (Array.isArray(body) ? body : [body]).some((m) => m?.method === 'initialize');
    if (isInit) headers['mcp-session-id'] = randomToken(16);
    if (!out) return send(res, 202, '', headers);
    return send(res, 200, out, headers);
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    try {
      if (p === '/healthz') return send(res, 200, { ok: true, version: VERSION, uptime_s: Math.round(process.uptime()) });
      if (p.startsWith('/m/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const [, , token, name] = p.split('/');
        return core.media.serve(req, res, token, decodeURIComponent(name || ''));
      }
      if (p.startsWith('/api/')) return await handleApi(req, res, url);
      if (p === '/mcp' || p === '/mcp/') return await handleMcp(req, res);
      if (p === '/llms.txt') return serveFile(res, path.join(ROOT, 'docs', 'llms.txt'), { req });
      if (p === '/AGENTS.md' || p === '/docs/agent-guide.md') return serveFile(res, fs.existsSync(path.join(ROOT, 'AGENTS.md')) ? path.join(ROOT, 'AGENTS.md') : path.join(ROOT, 'docs', 'agent-guide.md'), { req });
      if (p.startsWith('/assets/shared/')) return serveFile(res, path.join(ROOT, 'src', 'shared', path.basename(p)), { req });
      if (p.startsWith('/assets/')) {
        const f = path.join(ROOT, 'public', path.normalize(p.slice('/assets/'.length)).replace(/^(\.\.[/\\])+/, ''));
        if (!f.startsWith(path.join(ROOT, 'public'))) return send(res, 404, 'Not found');
        return serveFile(res, f, { req });
      }
      if (p === '/login') {
        if (req.method === 'GET') return loginPage(res);
        if (req.method === 'POST') {
          const ip = clientIp(req);
          const f = loginFails.get(ip) || { n: 0, at: Date.now() };
          if (Date.now() - f.at > 15 * 60000) { f.n = 0; f.at = Date.now(); }
          if (f.n >= 8) return loginPage(res, 'Too many attempts. Wait 15 minutes.');
          const form = new URLSearchParams((await readBody(req, 8192)).toString());
          const cookieCsrf = parseCookies(req.headers.cookie).pl_lcsrf;
          if (!cookieCsrf || !safeEqual(cookieCsrf, form.get('csrf') || '') || !originOk(req)) return loginPage(res, 'Session expired, please try again.');
          const hash = db.getSetting('admin_password');
          if (!hash || !verifyPassword(form.get('password') || '', hash)) {
            f.n++;
            loginFails.set(ip, f);
            return loginPage(res, hash ? 'Wrong password.' : 'No password set. Run: node bin/postlite.js set-password');
          }
          loginFails.delete(ip);
          return send(res, 303, '', { location: '/', 'set-cookie': [createSession(req, res), `pl_lcsrf=; ${cookieFlags}; Max-Age=0`] });
        }
      }
      if (p === '/logout' && req.method === 'POST') {
        const s = getSession(req);
        const form = new URLSearchParams((await readBody(req, 8192)).toString());
        if (s && (safeEqual(form.get('csrf') || '', s.csrf) || safeEqual(String(req.headers['x-csrf-token'] || ''), s.csrf))) db.run('DELETE FROM sessions WHERE id_hash = ?', s.id_hash);
        return send(res, 303, '', { location: '/login', 'set-cookie': `pl_sid=; ${cookieFlags}; Max-Age=0` });
      }
      let m;
      if ((m = /^\/oauth\/([\w-]+)\/start$/.exec(p)) && req.method === 'GET') {
        if (!getSession(req)) return send(res, 303, '', { location: '/login' });
        try {
          const r = core.oauth.start(m[1], { reconnectId: url.searchParams.get('reconnect') || null });
          core.audit.record({ principal: SESSION_PRINCIPAL, via: 'ui', operation: 'oauth_start', target: m[1], status: 200 });
          return send(res, 302, '', { location: r.url });
        } catch (e) { return htmlMessage(res, e.status || 500, 'Cannot connect', esc(e.message), '/#/accounts'); }
      }
      if ((m = /^\/oauth\/([\w-]+)\/callback$/.exec(p)) && req.method === 'GET') {
        try {
          const r = await core.oauth.callback(m[1], Object.fromEntries(url.searchParams));
          if (r.select) return send(res, 302, '', { location: `/#/accounts/select/${r.select}` });
          core.audit.record({ principal: { type: 'oauth', name: m[1] }, via: 'ui', operation: 'oauth_connected', status: 200, detail: r.connected });
          return htmlMessage(res, 200, 'Account connected', `Connected: ${r.connected.map((c) => esc(c.name)).join(', ')}. You can close this tab.`, '/#/accounts');
        } catch (e) { return htmlMessage(res, e.status || 500, 'Connection failed', esc(e.message), '/#/accounts'); }
      }
      if (p === '/' || p === '/index.html') {
        if (!getSession(req)) return send(res, 303, '', { location: '/login' });
        return serveFile(res, path.join(ROOT, 'public', 'index.html'), { csp: true });
      }
      if (p === '/favicon.ico') return serveFile(res, path.join(ROOT, 'public', 'favicon.svg'), { req });
      return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
    } catch (e) {
      return sendError(res, e);
    }
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => sendError(res, e));
  });
  server.requestTimeout = 0; // large uploads
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 5000;
  return server;
}
