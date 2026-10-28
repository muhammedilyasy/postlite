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
import { renderMarkdown } from '../markdown.js';
import { createAccessVerifier, validateAuthConfig, AccessError } from '../access.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const SESSION_DAYS = 14;
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2' };

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
  validateAuthConfig(cfg); // fail closed: access mode without team domain / AUD / allow-list never starts
  const accessMode = cfg.auth.mode === 'cloudflare-access';
  const access = accessMode ? createAccessVerifier({
    teamDomain: cfg.auth.teamDomain, aud: cfg.auth.aud, allowedEmails: cfg.auth.allowedEmails, certsUrl: cfg.auth.certsUrl || undefined,
    clockSkewSec: cfg.auth.clockSkewSec, timeoutMs: cfg.auth.jwksTimeoutMs, minRefreshMs: cfg.auth.jwksMinRefreshMs,
  }) : null;
  const mcp = createMcp(core, { via: 'mcp-http', version: VERSION });
  const loginFails = new Map();
  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${cfg.secureCookies ? '; Secure' : ''}`;
  const publicOrigin = new URL(cfg.publicUrl).origin;
  const logoutTarget = () => (accessMode ? `${new URL(cfg.publicUrl).origin}/cdn-cgi/access/logout` : '/login');
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
  function createSession(req, email = null, accessExp = null) {
    const sid = randomToken(32);
    const csrf = randomToken(24);
    db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    db.run('INSERT INTO sessions(id_hash, csrf, created_at, expires_at, ip, ua, email, access_exp) VALUES(?,?,?,?,?,?,?,?)', sessHash(sid), csrf, Date.now(), Date.now() + SESSION_DAYS * 86400000, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200), email, accessExp);
    return { cookie: `pl_sid=${sid}; ${cookieFlags}; Max-Age=${SESSION_DAYS * 86400}`, session: db.get('SELECT * FROM sessions WHERE id_hash = ?', sessHash(sid)) };
  }
  /** The principal for a web-UI session; in Access mode it carries the verified email (audit log). */
  const sessionPrincipal = (s) => (s?.email ? { ...SESSION_PRINCIPAL, id: s.email, name: s.email, email: s.email } : SESSION_PRINCIPAL);

  // ---- Cloudflare Access ----
  const accessToken = (req) => String(req.headers['cf-access-jwt-assertion'] || '').trim() || parseCookies(req.headers.cookie).CF_Authorization || '';
  /** Verify the Access JWT. Returns { email } or throws AccessError. */
  const accessIdentity = (req) => access.verify(accessToken(req));

  /**
   * Gate for browser pages (/, /docs/setup, /oauth/*, /llms.txt ...). Password mode: needs a session.
   * Access mode: needs a valid Access JWT for an allowed email; creates/reuses the session for that email.
   * Returns { session, setCookie } or null after sending a redirect / denial page.
   */
  async function requireUi(req, res, { redirect = true } = {}) {
    if (!accessMode) {
      const s = getSession(req);
      if (s) return { session: s, setCookie: null };
      if (redirect) send(res, 303, '', { location: '/login' });
      else accessDenied(res, 401, 'Sign in required', 'Sign in to postlite to view this page.', { href: '/login', label: 'Sign in' });
      return null;
    }
    let id;
    try { id = await accessIdentity(req); } catch (e) { accessFailure(res, e); return null; }
    const s = getSession(req);
    const accessExp = id.exp * 1000;
    if (s && s.email === id.email) {
      if ((s.access_exp || 0) < accessExp) db.run('UPDATE sessions SET access_exp = ? WHERE id_hash = ?', accessExp, s.id_hash);
      return { session: { ...s, access_exp: Math.max(s.access_exp || 0, accessExp) }, setCookie: null };
    }
    const created = createSession(req, id.email, accessExp);
    core.audit.record({ principal: sessionPrincipal(created.session), via: 'ui', operation: 'login', target: 'cloudflare-access', status: 200 });
    return { session: created.session, setCookie: created.cookie };
  }

  function accessFailure(res, e) {
    if (!(e instanceof AccessError)) { log('error', e.stack || String(e)); return accessDenied(res, 500, 'Sign-in check failed', 'postlite could not verify your Cloudflare Access session. Try again in a moment.'); }
    if (e.code === 'jwks_unavailable') { log('error', `Cloudflare Access: ${e.message}`); return accessDenied(res, 503, 'Sign-in temporarily unavailable', 'postlite could not reach Cloudflare Access to verify your session. Try again in a moment.'); }
    if (e.code === 'email_not_allowed') return accessDenied(res, 403, 'Access denied', `<strong>${esc(e.email)}</strong> is not allowed to use this postlite instance. Sign out and use an allowed address.`, { href: logoutTarget(), label: 'Sign out of Cloudflare Access' });
    if (e.code !== 'missing') log('warn', `Cloudflare Access token rejected: ${e.code}`);
    return accessDenied(res, 401, 'Sign in with Cloudflare Access', e.code === 'expired' ? 'Your Cloudflare Access session has expired. Reload to sign in again.' : 'This postlite instance is protected by Cloudflare Zero Trust Access. Open it through its public URL to sign in with your email one-time PIN.', { href: `${cfg.publicUrl}/`, label: 'Sign in' });
  }

  const clientIp = (req) => (process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';

  function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return o === publicOrigin || o === `http://${host}` || o === `https://${host}`;
  }

  /** Resolve the caller: Bearer API key, or session cookie (+CSRF on mutations; +Access JWT in access mode). */
  async function authenticate(req) {
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
    if (accessMode) {
      // /api/v1/* is an Access *Bypass* path, so the edge does not check it. The session must come from an
      // Access sign-in, and it is only honoured while that Access token is unexpired; if the browser sends
      // its CF_Authorization cookie / header, that token must be valid and belong to the same email.
      if (!s.email) throw new HttpError(401, 'Not signed in with Cloudflare Access. Reload the page.');
      if (accessToken(req)) {
        let id;
        try { id = await accessIdentity(req); } catch (e) { throw new HttpError(e.code === 'jwks_unavailable' ? 503 : 401, `Cloudflare Access session invalid (${e.code}). Reload the page.`); }
        if (id.email !== s.email) throw new HttpError(401, 'Session does not match your Cloudflare Access identity. Reload the page.');
        if ((s.access_exp || 0) < id.exp * 1000) db.run('UPDATE sessions SET access_exp = ? WHERE id_hash = ?', id.exp * 1000, s.id_hash);
      } else if (!s.access_exp || s.access_exp + cfg.auth.clockSkewSec * 1000 < Date.now()) {
        throw new HttpError(401, 'Your Cloudflare Access session expired. Reload the page to sign in again.');
      }
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (!safeEqual(String(req.headers['x-csrf-token'] || ''), s.csrf) || !originOk(req)) throw new HttpError(403, 'CSRF check failed. Reload the page.');
    }
    return { ...sessionPrincipal(s), csrf: s.csrf };
  }

  function serveFile(res, file, { csp = false, req = null } = {}) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
      const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      const headers = { ...baseHeaders, etag, 'cache-control': file.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache', ...(csp ? { 'content-security-policy': CSP } : {}) };
      if (req && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': st.size });
      fs.createReadStream(file).pipe(res);
    });
  }

  const LOGO = '<svg class="logo-mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 16.5V7.5h4.6a3 3 0 0 1 0 6H8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const pageHead = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><link rel="stylesheet" href="/assets/app.css"><link rel="icon" href="/assets/favicon.svg"><script src="/assets/js/theme.js"></script><title>${esc(title)} · postlite</title></head>`;
  const htmlHeaders = (extra = {}) => ({ 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store', ...extra });

  /** Centered auth card used by /login, access-denied and OAuth result pages. */
  function authCard(title, inner, { tone = '' } = {}) {
    return `${pageHead(title)}<body class="auth-page"><main class="auth-wrap"><a class="auth-brand" href="/">${LOGO}<span>postlite</span></a><section class="auth-card ${tone}">${inner}</section><p class="auth-foot">Self-hosted scheduler for YouTube, Instagram &amp; Facebook</p></main></body></html>`;
  }

  function accessDenied(res, status, title, bodyHtml, action = null, headers = {}) {
    const icon = status === 403 ? 'deny' : status >= 500 ? 'warn' : 'lock';
    const html = authCard(title, `<div class="auth-icon ${icon}" aria-hidden="true"></div><h1>${esc(title)}</h1><p class="muted">${bodyHtml}</p>${action ? `<a class="btn primary block" href="${esc(action.href)}">${esc(action.label)}</a>` : ''}<p class="auth-meta">Cloudflare Zero Trust · ${esc(cfg.auth.teamDomain || '')}</p>`, { tone: status === 403 ? 'danger' : '' });
    send(res, status, html, htmlHeaders(headers));
  }

  function loginPage(res, error = '') {
    const csrf = randomToken(18);
    const needsSetup = !db.getSetting('admin_password');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8')
      .replace('{{CSRF}}', csrf)
      .replace('{{ERROR}}', error ? `<div class="notice error" role="alert">${esc(error)}</div>` : '')
      .replace('{{SETUP}}', needsSetup ? '<div class="notice info">No password set yet. On the server run <code>node bin/postlite.js set-password</code></div>' : '');
    send(res, error ? 401 : 200, html, htmlHeaders({ 'set-cookie': `pl_lcsrf=${csrf}; ${cookieFlags}; Max-Age=1800` }));
  }

  function htmlMessage(res, status, title, body, link = '/', extraHeaders = {}) {
    const ok = status < 400;
    send(res, status, authCard(title, `<div class="auth-icon ${ok ? 'ok' : 'deny'}" aria-hidden="true"></div><h1>${esc(title)}</h1><p class="muted">${body}</p><a class="btn primary block" href="${esc(link)}">Continue</a>`, { tone: ok ? '' : 'danger' }), htmlHeaders(extraHeaders));
  }

  const guideTitle = (file) => (/^#\s+(.+)$/m.exec(fs.readFileSync(file, 'utf8'))?.[1] || path.basename(file, '.md')).replace(/[`*]/g, '');
  /** Setup guides (docs/setup/*.md) rendered as HTML so they work without GitHub. */
  function serveGuide(res, name, extraHeaders = {}) {
    const base = name === '' || name === 'index' || name === 'README' ? 'README' : name;
    if (!/^[A-Za-z0-9-]+$/.test(base)) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
    const dir = path.join(ROOT, 'docs', 'setup');
    const file = path.join(dir, `${base}.md`);
    if (!fs.existsSync(file)) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
    const mapLink = (h) => {
      const m = /^(?:\.\/)?([\w-]+)\.md(#[\w-]*)?$/.exec(h);
      if (m) return `/docs/setup/${m[1] === 'README' ? '' : m[1]}${m[2] || ''}`;
      return h;
    };
    const { html, title } = renderMarkdown(fs.readFileSync(file, 'utf8'), { mapLink });
    const guides = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort((x, y) => (x === 'README.md' ? -1 : y === 'README.md' ? 1 : x.localeCompare(y)));
    const nav = guides.map((f) => { const n = f.slice(0, -3); return `<a href="/docs/setup/${n === 'README' ? '' : n}" class="${n === base ? 'on' : ''}">${esc(n === 'README' ? 'Overview' : guideTitle(path.join(dir, f)))}</a>`; }).join('');
    const page = `${pageHead(title || 'Setup guide')}<body class="doc-page"><header class="doc-top"><a class="brand" href="/">${LOGO}<span>postlite</span></a><nav class="crumbs" aria-label="Breadcrumb"><a href="/docs/setup/">Docs</a><span class="sep">/</span><span>${esc(title || base)}</span></nav><a class="btn small" href="/#/settings/apps">Platform apps</a><a class="btn small primary" href="/">Dashboard</a></header><div class="doc-layout"><aside class="doc-side"><div class="side-label">Setup guides</div>${nav}<div class="side-label">For agents</div><a href="/api/v1/openapi.json">OpenAPI spec</a><a href="/llms.txt">llms.txt</a><a href="/AGENTS.md">Agent guide</a></aside><article class="doc">${html}</article></div></body></html>`;
    return send(res, 200, page, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-cache', ...extraHeaders });
  }

  const agentGuideFile = () => (fs.existsSync(path.join(ROOT, 'AGENTS.md')) ? path.join(ROOT, 'AGENTS.md') : path.join(ROOT, 'docs', 'agent-guide.md'));

  async function handleApi(req, res, url) {
    const p = url.pathname;
    if (p === '/api/v1/openapi.json' && req.method === 'GET') return send(res, 200, openapi(cfg, VERSION), { 'access-control-allow-origin': '*' });
    let principal;
    try { principal = await authenticate(req); } catch (e) { return sendError(res, e, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : e.status === 401 ? { 'www-authenticate': 'Bearer realm="postlite"' } : {}); }
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
    if (p === '/api/v1/session' && req.method === 'GET') return send(res, 200, { csrf: principal.csrf || null, principal: { type: principal.type, name: principal.name, email: principal.email || null, scopes: principal.scopes }, auth_mode: cfg.auth.mode, logout_url: logoutTarget(), version: VERSION });

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
      // ---- Public / bypass paths (Cloudflare Access "Bypass"): the app protects these itself ----
      if (p === '/healthz') return send(res, 200, { ok: true, version: VERSION, uptime_s: Math.round(process.uptime()) });
      if (p.startsWith('/m/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const [, , token, name] = p.split('/');
        return core.media.serve(req, res, token, decodeURIComponent(name || '')); // unguessable per-file token
      }
      // Agent docs are mirrored under /api/v1 so API-key clients can read them through the bypass.
      if (p === '/api/v1/llms.txt' && req.method === 'GET') return serveFile(res, path.join(ROOT, 'docs', 'llms.txt'), { req });
      if (p === '/api/v1/agent-guide.md' && req.method === 'GET') return serveFile(res, agentGuideFile(), { req });
      if (p.startsWith('/api/')) return await handleApi(req, res, url); // Bearer key, or session (+Access JWT)
      if (p === '/mcp' || p === '/mcp/') return await handleMcp(req, res); // Bearer key only
      // Static assets are the open-source UI code (no data) and style the sign-in / denied pages.
      if (p.startsWith('/assets/shared/')) return serveFile(res, path.join(ROOT, 'src', 'shared', path.basename(p)), { req });
      if (p.startsWith('/assets/')) {
        const f = path.join(ROOT, 'public', path.normalize(p.slice('/assets/'.length)).replace(/^(\.\.[/\\])+/, ''));
        if (!f.startsWith(path.join(ROOT, 'public'))) return send(res, 404, 'Not found');
        return serveFile(res, f, { req });
      }
      if (p === '/favicon.ico') return serveFile(res, path.join(ROOT, 'public', 'favicon.svg'), { req });

      // ---- Sign-in ----
      if (p === '/login') {
        if (accessMode) {
          if (req.method !== 'GET' && req.method !== 'HEAD') return accessDenied(res, 405, 'Password sign-in is disabled', 'This instance uses Cloudflare Zero Trust Access. Sign in with your email one-time PIN instead.', { href: `${cfg.publicUrl}/`, label: 'Sign in' }, { allow: 'GET' });
          const ui = await requireUi(req, res);
          if (!ui) return;
          return send(res, 303, '', { location: '/', ...(ui.setCookie ? { 'set-cookie': ui.setCookie } : {}) });
        }
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
          return send(res, 303, '', { location: '/', 'set-cookie': [createSession(req).cookie, `pl_lcsrf=; ${cookieFlags}; Max-Age=0`] });
        }
      }
      if (p === '/logout' && req.method === 'POST') {
        const s = getSession(req);
        const form = new URLSearchParams((await readBody(req, 8192)).toString());
        if (s && (safeEqual(form.get('csrf') || '', s.csrf) || safeEqual(String(req.headers['x-csrf-token'] || ''), s.csrf))) {
          db.run('DELETE FROM sessions WHERE id_hash = ?', s.id_hash);
          if (s.email) core.audit.record({ principal: sessionPrincipal(s), via: 'ui', operation: 'logout', status: 200 });
        }
        return send(res, 303, '', { location: logoutTarget(), 'set-cookie': `pl_sid=; ${cookieFlags}; Max-Age=0` });
      }

      // ---- Everything below is a browser page: session (password mode) or Access JWT (access mode) ----
      const pageGet = req.method === 'GET' || req.method === 'HEAD';
      const withCookie = (ui, h = {}) => (ui.setCookie ? { ...h, 'set-cookie': ui.setCookie } : h);
      let m;
      if ((m = /^\/oauth\/([\w-]+)\/start$/.exec(p)) && req.method === 'GET') {
        const ui = await requireUi(req, res);
        if (!ui) return;
        try {
          const r = core.oauth.start(m[1], { reconnectId: url.searchParams.get('reconnect') || null });
          core.audit.record({ principal: sessionPrincipal(ui.session), via: 'ui', operation: 'oauth_start', target: m[1], status: 200 });
          return send(res, 302, '', withCookie(ui, { location: r.url }));
        } catch (e) {
          if (e.status === 409 && e.extra?.app) return send(res, 302, '', withCookie(ui, { location: `/#/settings/apps/${e.extra.app}` }));
          return htmlMessage(res, e.status || 500, 'Cannot connect', esc(e.message), '/#/accounts', withCookie(ui));
        }
      }
      if ((m = /^\/oauth\/([\w-]+)\/callback$/.exec(p)) && req.method === 'GET') {
        // Password mode keeps the historical behaviour (state parameter protects the callback);
        // Access mode additionally requires the owner's Access identity.
        let ui = { session: null, setCookie: null };
        if (accessMode) { ui = await requireUi(req, res); if (!ui) return; }
        try {
          const r = await core.oauth.callback(m[1], Object.fromEntries(url.searchParams));
          if (r.select) return send(res, 302, '', withCookie(ui, { location: `/#/accounts/select/${r.select}` }));
          core.audit.record({ principal: ui.session?.email ? sessionPrincipal(ui.session) : { type: 'oauth', name: m[1] }, via: 'ui', operation: 'oauth_connected', status: 200, detail: r.connected });
          return htmlMessage(res, 200, 'Account connected', `Connected: ${r.connected.map((c) => esc(c.name)).join(', ')}. You can close this tab.`, '/#/accounts', withCookie(ui));
        } catch (e) { return htmlMessage(res, e.status || 500, 'Connection failed', esc(e.message), '/#/accounts', withCookie(ui)); }
      }
      const isDoc = p === '/llms.txt' || p === '/AGENTS.md' || p === '/docs/agent-guide.md' || /^\/docs\/setup\/?/.test(p);
      if (isDoc && pageGet) {
        // Docs are public in password mode (as before); in Access mode they sit behind Access like every page.
        let ui = { setCookie: null };
        if (accessMode) { ui = await requireUi(req, res); if (!ui) return; }
        if (p === '/llms.txt') return serveFile(res, path.join(ROOT, 'docs', 'llms.txt'), { req });
        if (p === '/AGENTS.md' || p === '/docs/agent-guide.md') return serveFile(res, agentGuideFile(), { req });
        const gm = /^\/docs\/setup\/?(?:([^/]*?)(?:\.md)?)?$/.exec(p);
        if (gm) return serveGuide(res, gm[1] || '', withCookie(ui));
      }
      if (p === '/' || p === '/index.html') {
        const ui = await requireUi(req, res);
        if (!ui) return;
        if (ui.setCookie) {
          // first request after Access sign-in: set the session cookie, then serve the shell
          return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html')), htmlHeaders({ 'set-cookie': ui.setCookie }));
        }
        return serveFile(res, path.join(ROOT, 'public', 'index.html'), { csp: true });
      }
      if (accessMode && pageGet) {
        // unknown paths: don't reveal anything to callers without a valid Access identity
        const ui = await requireUi(req, res);
        if (!ui) return;
      }
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
