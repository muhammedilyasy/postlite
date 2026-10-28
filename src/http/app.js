// Portable HTTP application: web UI, login/session/CSRF, OAuth callbacks, public media,
// REST API /api/v1 (session or API key), OpenAPI, MCP Streamable HTTP at /mcp.
// Takes a standard Request and returns a Response, so it runs unchanged on Cloudflare Workers;
// src/http/server.js bridges node:http to it.
import { randomToken, sha256, hmacHex, safeEqual } from '../crypto.js';
import { HttpError } from '../errors.js';
import { operations, execute } from '../api/operations.js';
import { coerceQuery } from '../api/schema.js';
import { openapi } from '../api/openapi.js';
import { createMcp } from '../mcp.js';
import { SESSION_PRINCIPAL } from '../apikeys.js';
import { renderMarkdown } from '../markdown.js';
import { createAccessVerifier, validateAuthConfig, AccessError } from '../access.js';
import { fromUtf8, toBase64 } from '../bytes.js';

const SESSION_DAYS = 14;

const routes = operations.map((op) => {
  const names = [];
  const re = new RegExp('^/api/v1' + op.path.replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  return { op, re, names };
});

function parseCookies(h = '') {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}

/** Read a request body with a size limit (413 when exceeded). */
async function readBody(req, limit) {
  const len = Number(req.headers.get('content-length'));
  if (len > limit) throw new HttpError(413, 'Request body too large');
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { reader.cancel().catch(() => {}); throw new HttpError(413, 'Request body too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
const readText = async (req, limit) => fromUtf8(await readBody(req, limit));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {object} core
 * @param {{files:{serve:Function, text:Function, list:Function}, version:string}} opts
 *   files.serve(request, relPath, {csp}) → Response   files.text(relPath) → string|null   files.list(dir) → names
 *   files.shellInfo() → {v, modules, shared}   files.versioned(url, v) → content-hashed asset URL
 */
export function createApp(core, { files, version }) {
  const { cfg, db, log } = core;
  validateAuthConfig(cfg); // fail closed: access mode without team domain / AUD / allow-list never starts
  const VERSION = version;
  const accessMode = cfg.auth.mode === 'cloudflare-access';
  const workers = cfg.platform === 'workers';
  const access = accessMode ? createAccessVerifier({
    teamDomain: cfg.auth.teamDomain, aud: cfg.auth.aud, allowedEmails: cfg.auth.allowedEmails, certsUrl: cfg.auth.certsUrl || undefined,
    clockSkewSec: cfg.auth.clockSkewSec, timeoutMs: cfg.auth.jwksTimeoutMs, minRefreshMs: cfg.auth.jwksMinRefreshMs,
  }) : null;
  const mcp = createMcp(core, { via: 'mcp-http', version: VERSION });
  const loginFails = new Map(); // per process (Node) / per isolate (Workers)
  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${cfg.secureCookies ? '; Secure' : ''}`;
  // JSON bodies carrying base64 media: reject oversize bodies before parsing (parsing is CPU-heavy on Workers)
  const b64Limit = Math.max(2 * 1024 * 1024, Math.ceil((cfg.base64MaxMb * 1024 * 1024 * 4) / 3) + 1024 * 1024);
  const publicOrigin = () => (cfg.publicUrl ? new URL(cfg.publicUrl).origin : '');
  const logoutTarget = () => (accessMode ? `${publicOrigin()}/cdn-cgi/access/logout` : '/login');
  // Session ids are stored only as (keyed) hashes; SESSION_SECRET adds a server-side pepper.
  const sessHash = (sid) => (cfg.sessionSecret ? hmacHex(cfg.sessionSecret, sid) : sha256(sid));

  const baseHeaders = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };
  // Workers: the browser may PUT upload parts straight to R2 (presigned S3 URLs).
  const CSP = `default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'${workers ? ' https://*.r2.cloudflarestorage.com' : ''}; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https:`;

  function send(status, body, headers = {}) {
    const isObj = body !== null && typeof body === 'object' && !(body instanceof Uint8Array) && !(body instanceof ReadableStream);
    const h = new Headers();
    for (const [k, v] of Object.entries({ ...baseHeaders, ...(isObj ? { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } : {}), ...headers })) {
      if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
      else if (v !== undefined && v !== null) h.set(k, String(v));
    }
    const noBody = status === 204 || status === 304 || (status >= 300 && status < 400 && (body === '' || body === null));
    return new Response(noBody ? null : isObj ? JSON.stringify(body) : body, { status, headers: h });
  }
  const sendError = (e, headers = {}) => {
    const status = e.status || 500;
    if (status >= 500) log('error', e.stack || String(e));
    return send(status, { error: { status, message: status >= 500 && !e.status ? 'Internal server error' : e.message, ...(e.extra ? { details: e.extra } : {}) } }, headers);
  };

  // ---- sessions ----
  async function getSession(req) {
    const sid = parseCookies(req.headers.get('cookie')).pl_sid;
    if (!sid) return null;
    const s = await db.get('SELECT * FROM sessions WHERE id_hash = ?', await sessHash(sid));
    if (!s || s.expires_at < Date.now()) return null;
    return s;
  }
  async function createSession(req, ctx, email = null, accessExp = null) {
    const sid = randomToken(32);
    const csrf = randomToken(24);
    const h = await sessHash(sid);
    const now = Date.now();
    await db.batch([
      ['DELETE FROM sessions WHERE expires_at < ?', now],
      ['INSERT INTO sessions(id_hash, csrf, created_at, expires_at, ip, ua, email, access_exp) VALUES(?,?,?,?,?,?,?,?)', h, csrf, now, now + SESSION_DAYS * 86400000, clientIp(req, ctx), String(req.headers.get('user-agent') || '').slice(0, 200), email, accessExp],
    ]);
    return { cookie: `pl_sid=${sid}; ${cookieFlags}; Max-Age=${SESSION_DAYS * 86400}`, session: { id_hash: h, csrf, created_at: now, expires_at: now + SESSION_DAYS * 86400000, email, access_exp: accessExp } };
  }
  /** The principal for a web-UI session; in Access mode it carries the verified email (audit log). */
  const sessionPrincipal = (s) => (s?.email ? { ...SESSION_PRINCIPAL, id: s.email, name: s.email, email: s.email } : SESSION_PRINCIPAL);

  // ---- Cloudflare Access ----
  const accessToken = (req) => String(req.headers.get('cf-access-jwt-assertion') || '').trim() || parseCookies(req.headers.get('cookie')).CF_Authorization || '';
  const accessIdentity = (req) => access.verify(accessToken(req));

  /**
   * Gate for browser pages. Password mode: needs a session. Access mode: needs a valid Access JWT for an
   * allowed email; creates/reuses the session for that email. Returns { session, setCookie } or a Response.
   */
  async function requireUi(req, ctx, { redirect = true } = {}) {
    if (!accessMode) {
      const s = await getSession(req);
      if (s) return { session: s, setCookie: null };
      if (redirect) return send(303, '', { location: '/login' });
      return accessDenied(401, 'Sign in required', 'Sign in to postlite to view this page.', { href: '/login', label: 'Sign in' });
    }
    let id;
    try { id = await accessIdentity(req); } catch (e) { return accessFailure(e); }
    const s = await getSession(req);
    const accessExp = id.exp * 1000;
    if (s && s.email === id.email) {
      if ((s.access_exp || 0) < accessExp) await db.run('UPDATE sessions SET access_exp = ? WHERE id_hash = ?', accessExp, s.id_hash);
      return { session: { ...s, access_exp: Math.max(s.access_exp || 0, accessExp) }, setCookie: null };
    }
    const created = await createSession(req, ctx, id.email, accessExp);
    await core.audit.record({ principal: sessionPrincipal(created.session), via: 'ui', operation: 'login', target: 'cloudflare-access', status: 200 });
    return { session: created.session, setCookie: created.cookie };
  }

  function accessFailure(e) {
    if (!(e instanceof AccessError)) { log('error', e.stack || String(e)); return accessDenied(500, 'Sign-in check failed', 'postlite could not verify your Cloudflare Access session. Try again in a moment.'); }
    if (e.code === 'jwks_unavailable') { log('error', `Cloudflare Access: ${e.message}`); return accessDenied(503, 'Sign-in temporarily unavailable', 'postlite could not reach Cloudflare Access to verify your session. Try again in a moment.'); }
    if (e.code === 'email_not_allowed') return accessDenied(403, 'Access denied', `<strong>${esc(e.email)}</strong> is not allowed to use this postlite instance. Sign out and use an allowed address.`, { href: logoutTarget(), label: 'Sign out of Cloudflare Access' });
    if (e.code !== 'missing') log('warn', `Cloudflare Access token rejected: ${e.code}`);
    return accessDenied(401, 'Sign in with Cloudflare Access', e.code === 'expired' ? 'Your Cloudflare Access session has expired. Reload to sign in again.' : 'This postlite instance is protected by Cloudflare Zero Trust Access. Open it through its public URL to sign in with your email one-time PIN.', { href: `${cfg.publicUrl}/`, label: 'Sign in' });
  }

  const clientIp = (req, ctx) => (workers ? req.headers.get('cf-connecting-ip') || '' : (cfg.trustProxy ? String(req.headers.get('x-forwarded-for') || '').split(',')[0].trim() : '') || ctx?.remoteAddress || '');

  function originOk(req) {
    const o = req.headers.get('origin');
    if (!o) return true;
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    return o === publicOrigin() || o === `http://${host}` || o === `https://${host}`;
  }

  const bearer = (req) => {
    const auth = req.headers.get('authorization') || '';
    return /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : null;
  };

  /** Resolve the caller: Bearer API key, or session cookie (+CSRF on mutations; +Access JWT in access mode). */
  async function authenticate(req) {
    const key = bearer(req);
    if (key !== null) {
      const p = await core.apiKeys.authenticate(key);
      if (!p) throw new HttpError(401, 'Invalid or revoked API key.');
      const rl = core.apiKeys.rateLimit(p);
      if (!rl.ok) throw Object.assign(new HttpError(429, `Rate limit exceeded for this key (${p.rateLimit}/min). Retry after ${rl.retryAfter}s.`), { retryAfter: rl.retryAfter });
      return p;
    }
    const s = await getSession(req);
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
        if ((s.access_exp || 0) < id.exp * 1000) await db.run('UPDATE sessions SET access_exp = ? WHERE id_hash = ?', id.exp * 1000, s.id_hash);
      } else if (!s.access_exp || s.access_exp + cfg.auth.clockSkewSec * 1000 < Date.now()) {
        throw new HttpError(401, 'Your Cloudflare Access session expired. Reload the page to sign in again.');
      }
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (!safeEqual(String(req.headers.get('x-csrf-token') || ''), s.csrf) || !originOk(req)) throw new HttpError(403, 'CSRF check failed. Reload the page.');
    }
    return { ...sessionPrincipal(s), csrf: s.csrf };
  }

  const LOGO = '<svg class="logo-mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 16.5V7.5h4.6a3 3 0 0 1 0 6H8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const pageHead = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><link rel="stylesheet" href="/assets/app.css"><link rel="icon" href="/assets/favicon.svg"><script src="/assets/js/theme.js"></script><title>${esc(title)} · postlite</title></head>`;
  const htmlHeaders = (extra = {}) => ({ 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store', ...extra });

  /** Centered auth card used by /login, access-denied and OAuth result pages. */
  function authCard(title, inner, { tone = '' } = {}) {
    return `${pageHead(title)}<body class="auth-page"><main class="auth-wrap"><a class="auth-brand" href="/">${LOGO}<span>postlite</span></a><section class="auth-card ${tone}">${inner}</section><p class="auth-foot">Self-hosted scheduler for YouTube, Instagram &amp; Facebook</p></main></body></html>`;
  }

  function accessDenied(status, title, bodyHtml, action = null, headers = {}) {
    const icon = status === 403 ? 'deny' : status >= 500 ? 'warn' : 'lock';
    const html = authCard(title, `<div class="auth-icon ${icon}" aria-hidden="true"></div><h1>${esc(title)}</h1><p class="muted">${bodyHtml}</p>${action ? `<a class="btn primary block" href="${esc(action.href)}">${esc(action.label)}</a>` : ''}<p class="auth-meta">Cloudflare Zero Trust · ${esc(cfg.auth.teamDomain || '')}</p>`, { tone: status === 403 ? 'danger' : '' });
    return send(status, html, htmlHeaders(headers));
  }

  const setPasswordHint = workers
    ? 'No password set yet. Run <code>node bin/postlite.js hash-password</code> and store the result with <code>wrangler secret put ADMIN_PASSWORD_HASH</code> (or use Cloudflare Access).'
    : 'No password set yet. On the server run <code>node bin/postlite.js set-password</code>';
  const adminHash = async () => (await db.getSetting('admin_password')) || cfg.adminPasswordHash || null;

  async function loginPage(error = '') {
    const csrf = randomToken(18);
    const needsSetup = !(await adminHash());
    const html = String((await files.text('public/login.html')) || '')
      .replace('{{CSRF}}', csrf)
      .replace('{{ERROR}}', error ? `<div class="notice error" role="alert">${esc(error)}</div>` : '')
      .replace('{{SETUP}}', needsSetup ? `<div class="notice info">${setPasswordHint}</div>` : '');
    return send(error ? 401 : 200, html, htmlHeaders({ 'set-cookie': `pl_lcsrf=${csrf}; ${cookieFlags}; Max-Age=1800` }));
  }

  function htmlMessage(status, title, body, link = '/', extraHeaders = {}) {
    const ok = status < 400;
    return send(status, authCard(title, `<div class="auth-icon ${ok ? 'ok' : 'deny'}" aria-hidden="true"></div><h1>${esc(title)}</h1><p class="muted">${body}</p><a class="btn primary block" href="${esc(link)}">Continue</a>`, { tone: ok ? '' : 'danger' }), htmlHeaders(extraHeaders));
  }

  const guideTitle = (md, name) => (/^#\s+(.+)$/m.exec(md || '')?.[1] || name).replace(/[`*]/g, '');
  /** Setup guides (docs/setup/*.md) rendered as HTML so they work without GitHub. */
  async function serveGuide(name, extraHeaders = {}) {
    const base = name === '' || name === 'index' || name === 'README' ? 'README' : name;
    if (!/^[A-Za-z0-9-]+$/.test(base)) return send(404, 'Not found', { 'content-type': 'text/plain' });
    const md = await files.text(`docs/setup/${base}.md`);
    if (md === null || md === undefined) return send(404, 'Not found', { 'content-type': 'text/plain' });
    const mapLink = (h) => {
      const m = /^(?:\.\/)?([\w-]+)\.md(#[\w-]*)?$/.exec(h);
      if (m) return `/docs/setup/${m[1] === 'README' ? '' : m[1]}${m[2] || ''}`;
      return h;
    };
    const { html, title } = renderMarkdown(md, { mapLink });
    const guides = (await files.list('docs/setup')).filter((f) => f.endsWith('.md')).sort((x, y) => (x === 'README.md' ? -1 : y === 'README.md' ? 1 : x.localeCompare(y)));
    const navItems = [];
    for (const f of guides) {
      const n = f.slice(0, -3);
      navItems.push(`<a href="/docs/setup/${n === 'README' ? '' : n}" class="${n === base ? 'on' : ''}">${esc(n === 'README' ? 'Overview' : guideTitle(await files.text(`docs/setup/${f}`), n))}</a>`);
    }
    const page = `${pageHead(title || 'Setup guide')}<body class="doc-page"><header class="doc-top"><a class="brand" href="/">${LOGO}<span>postlite</span></a><nav class="crumbs" aria-label="Breadcrumb"><a href="/docs/setup/">Docs</a><span class="sep">/</span><span>${esc(title || base)}</span></nav><a class="btn small" href="/#/settings/apps">Platform apps</a><a class="btn small primary" href="/">Dashboard</a></header><div class="doc-layout"><aside class="doc-side"><div class="side-label">Setup guides</div>${navItems.join('')}<div class="side-label">For agents</div><a href="/api/v1/openapi.json">OpenAPI spec</a><a href="/llms.txt">llms.txt</a><a href="/AGENTS.md">Agent guide</a></aside><article class="doc">${html}</article></div></body></html>`;
    return send(200, page, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-cache', ...extraHeaders });
  }

  // ---- App shell: content-hashed asset URLs + import map + modulepreload, so a refresh needs no
  // revalidation round trips and the module graph loads in one parallel batch (matters behind a tunnel /
  // high-RTT links). Node: /assets/x.js?v=<hash>; Workers: /assets/v/<hash>/x.js (hash from the build).
  let shellCache = null;
  async function appShell() {
    if (shellCache) return shellCache;
    const info = await files.shellInfo();
    const ver = (u) => files.versioned(u, info.v);
    const imports = Object.fromEntries([...info.modules, ...info.shared].map((u) => [u, ver(u)]));
    const importmap = JSON.stringify({ imports });
    const ihash = toBase64(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(importmap))));
    const preload = info.modules.map((u) => `<link rel="modulepreload" href="${ver(u)}">`).join('');
    const html = String((await files.text('public/index.html')) || '')
      .replace('href="/assets/app.css"', `href="${ver('/assets/app.css')}"`)
      .replace('src="/assets/js/theme.js"', `src="${ver('/assets/js/theme.js')}"`)
      .replace('<script type="module" src="/assets/js/app.js"></script>', `<script type="importmap">${importmap}</script>${preload}<script type="module" src="${ver('/assets/js/app.js')}"></script>`);
    const csp = CSP.replace("script-src 'self'", `script-src 'self' 'sha256-${ihash}'`);
    shellCache = { html, csp, v: info.v };
    return shellCache;
  }
  async function sendShell(extra = {}) {
    const sh = await appShell();
    return send(200, sh.html, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': sh.csp, 'cache-control': 'no-store', ...extra });
  }

  const agentGuide = async (req) => {
    const r = await files.serve(req, 'AGENTS.md');
    return r.status === 404 ? files.serve(req, 'docs/agent-guide.md') : r;
  };

  async function handleApi(req, url) {
    const p = url.pathname;
    if (p === '/api/v1/openapi.json' && req.method === 'GET') return send(200, openapi(cfg, VERSION), { 'access-control-allow-origin': '*' });
    // Upload parts (proxy mode) authenticate with the per-session token in the URL, like presigned URLs.
    let m;
    if ((m = /^\/api\/v1\/media\/uploads\/([\w-]+)\/parts\/(\d+)$/.exec(p)) && req.method === 'PUT') {
      try {
        const len = req.headers.get('content-length');
        const r = await core.media.putPart(m[1], Number(m[2]), url.searchParams.get('token'), req.body, len === null ? undefined : Number(len));
        return send(200, r, { etag: r.etag, 'access-control-expose-headers': 'ETag' });
      } catch (e) { return sendError(e); }
    }
    let principal;
    try { principal = await authenticate(req); } catch (e) { return sendError(e, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : e.status === 401 ? { 'www-authenticate': 'Bearer realm="postlite"' } : {}); }
    const via = principal.type === 'session' ? 'ui' : 'rest';

    // raw media upload (single request; on Workers limited by the 100 MB request body cap — use /media/uploads)
    if (p === '/api/v1/media' && req.method === 'POST' && !/json/i.test(req.headers.get('content-type') || '')) {
      try {
        if (!principal.scopes.includes('write') && !principal.scopes.includes('admin')) throw new HttpError(403, 'This API key lacks the "write" scope.');
        const name = String(req.headers.get('x-filename') || url.searchParams.get('filename') || 'upload');
        const len = req.headers.get('content-length');
        const md = await core.media.save(req.body, decodeURIComponent(name), { size: len === null ? undefined : Number(len) });
        await core.audit.record({ principal, via, operation: 'upload_media', target: md.id, status: 200, detail: { name, size: md.size } });
        return send(200, { media: { ...core.media.view(md), public_url: core.media.publicUrl(md) } });
      } catch (e) { return sendError(e); }
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
          csv = await core.analytics.csvAccount(q.account_id, from, to);
        } else csv = await core.analytics.csvPosts({ integrationId: q.account_id || null, from, to, sort: q.sort || 'views' });
        return send(200, csv, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="postlite-${q.kind === 'account' ? 'account' : 'posts'}-${new Date().toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store' });
      } catch (e) { return sendError(e); }
    }
    // UI-only helpers for the OAuth account picker
    if ((m = /^\/api\/v1\/oauth\/pending\/([\w-]+)$/.exec(p))) {
      try {
        if (principal.type !== 'session' && !principal.scopes.includes('admin')) throw new HttpError(403, 'admin scope required');
        if (req.method === 'GET') return send(200, await core.oauth.pending(m[1]));
        if (req.method === 'POST') {
          const body = JSON.parse((await readText(req, 65536)) || '{}');
          const connected = await core.oauth.select(m[1], body.external_ids || []);
          await core.audit.record({ principal, via, operation: 'select_accounts', status: 200, detail: { connected } });
          return send(200, { connected });
        }
      } catch (e) { return sendError(e); }
    }
    if (p === '/api/v1/oauth/providers' && req.method === 'GET') return send(200, { providers: core.oauth.available() });
    if (p === '/api/v1/session' && req.method === 'GET') {
      return send(200, { csrf: principal.csrf || null, principal: { type: principal.type, name: principal.name, email: principal.email || null, scopes: principal.scopes }, auth_mode: cfg.auth.mode, logout_url: logoutTarget(), version: VERSION, runtime: cfg.platform, upload: { multipart: true, prefer_multipart_over_mb: workers ? 0 : 1024 } });
    }

    for (const r of routes) {
      if (r.op.method !== req.method) continue;
      const mm = r.re.exec(p);
      if (!mm) continue;
      try {
        let input = {};
        if (req.method === 'GET' || req.method === 'DELETE') input = coerceQuery(r.op.input, Object.fromEntries(url.searchParams));
        else {
          const raw = await readText(req, r.op.name === 'upload_media_base64' ? b64Limit : 2 * 1024 * 1024);
          if (raw.length) {
            try { input = JSON.parse(raw); } catch { throw new HttpError(400, 'Body must be valid JSON.'); }
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Body must be a JSON object.');
          }
        }
        r.names.forEach((n, i) => { input[n] = decodeURIComponent(mm[i + 1]); });
        for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
        const result = await execute(core, r.op, input, principal, via);
        return send(200, result);
      } catch (e) { return sendError(e); }
    }
    return sendError(new HttpError(404, `No API route ${req.method} ${p}. See /api/v1/openapi.json.`));
  }

  async function handleMcp(req) {
    if (!originOk(req)) return send(403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed' } });
    if (req.method === 'GET') return send(405, 'This server does not offer an SSE stream; use POST.', { allow: 'POST, DELETE', 'content-type': 'text/plain' });
    if (req.method === 'DELETE') return send(204, '');
    if (req.method !== 'POST') return send(405, '', { allow: 'POST, DELETE' });
    const key = bearer(req);
    const principal = key !== null ? await core.apiKeys.authenticate(key) : null;
    if (!principal) {
      return send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: send "Authorization: Bearer <API key>". Create one in Settings → API keys or with `node bin/postlite.js keys create`.' } }, { 'www-authenticate': 'Bearer realm="postlite-mcp"' });
    }
    const rl = core.apiKeys.rateLimit(principal);
    if (!rl.ok) return send(429, { jsonrpc: '2.0', id: null, error: { code: -32029, message: `Rate limit exceeded; retry after ${rl.retryAfter}s` } }, { 'retry-after': String(rl.retryAfter) });
    let body;
    try {
      body = JSON.parse(await readText(req, b64Limit));
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const out = await mcp.handleAny(body, principal);
    const headers = {};
    const isInit = (Array.isArray(body) ? body : [body]).some((x) => x?.method === 'initialize');
    if (isInit) headers['mcp-session-id'] = randomToken(16);
    if (!out) return send(202, '', headers);
    return send(200, out, headers);
  }

  async function route(req, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    // ---- Public / bypass paths (Cloudflare Access "Bypass"): the app protects these itself ----
    if (p === '/healthz') return send(200, { ok: true, version: VERSION, runtime: cfg.platform, ...(core.runtime.uptime ? { uptime_s: Math.round(core.runtime.uptime()) } : {}) });
    if (p.startsWith('/m/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const [, , token, name] = p.split('/');
      let n = '';
      try { n = decodeURIComponent(name || ''); } catch {}
      return core.media.serve(req, token, n); // unguessable per-file token
    }
    // Agent docs are mirrored under /api/v1 so API-key clients can read them through the bypass.
    if (p === '/api/v1/llms.txt' && req.method === 'GET') return files.serve(req, 'docs/llms.txt');
    if (p === '/api/v1/agent-guide.md' && req.method === 'GET') return agentGuide(req);
    await core.prepare();
    if (p.startsWith('/api/')) return handleApi(req, url); // Bearer key, or session (+Access JWT)
    if (p === '/mcp' || p === '/mcp/') return handleMcp(req); // Bearer key only
    // Static assets are the open-source UI code (no data) and style the sign-in / denied pages.
    if (p.startsWith('/assets/shared/')) return files.serve(req, `src/shared/${p.split('/').pop()}`);
    if (p.startsWith('/assets/')) {
      const rel = p.slice('/assets/'.length).split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
      return files.serve(req, `public/${rel}`);
    }
    if (p === '/favicon.ico') return files.serve(req, 'public/favicon.svg');

    // ---- Sign-in ----
    if (p === '/login') {
      if (accessMode) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return accessDenied(405, 'Password sign-in is disabled', 'This instance uses Cloudflare Zero Trust Access. Sign in with your email one-time PIN instead.', { href: `${cfg.publicUrl}/`, label: 'Sign in' }, { allow: 'GET' });
        const ui = await requireUi(req, ctx);
        if (ui instanceof Response) return ui;
        return send(303, '', { location: '/', ...(ui.setCookie ? { 'set-cookie': ui.setCookie } : {}) });
      }
      if (req.method === 'GET') return loginPage();
      if (req.method === 'POST') {
        const ip = clientIp(req, ctx);
        const f = loginFails.get(ip) || { n: 0, at: Date.now() };
        if (Date.now() - f.at > 15 * 60000) { f.n = 0; f.at = Date.now(); }
        if (f.n >= 8) return loginPage('Too many attempts. Wait 15 minutes.');
        const form = new URLSearchParams(await readText(req, 8192));
        const cookieCsrf = parseCookies(req.headers.get('cookie')).pl_lcsrf;
        if (!cookieCsrf || !safeEqual(cookieCsrf, form.get('csrf') || '') || !originOk(req)) return loginPage('Session expired, please try again.');
        const hash = await adminHash();
        let ok = false;
        if (hash) {
          ok = await core.passwords.verify(form.get('password') || '', hash);
          if (ok === null) return loginPage('This password hash format cannot be checked on Cloudflare Workers. Create a new one with `node bin/postlite.js hash-password`.');
        }
        if (!ok) {
          f.n++;
          loginFails.set(ip, f);
          return loginPage(hash ? 'Wrong password.' : workers ? 'No password set. Set the ADMIN_PASSWORD_HASH secret (node bin/postlite.js hash-password).' : 'No password set. Run: node bin/postlite.js set-password');
        }
        loginFails.delete(ip);
        return send(303, '', { location: '/', 'set-cookie': [(await createSession(req, ctx)).cookie, `pl_lcsrf=; ${cookieFlags}; Max-Age=0`] });
      }
    }
    if (p === '/logout' && req.method === 'POST') {
      const s = await getSession(req);
      const form = new URLSearchParams(await readText(req, 8192));
      if (s && (safeEqual(form.get('csrf') || '', s.csrf) || safeEqual(String(req.headers.get('x-csrf-token') || ''), s.csrf))) {
        await db.run('DELETE FROM sessions WHERE id_hash = ?', s.id_hash);
        if (s.email) await core.audit.record({ principal: sessionPrincipal(s), via: 'ui', operation: 'logout', status: 200 });
      }
      return send(303, '', { location: logoutTarget(), 'set-cookie': `pl_sid=; ${cookieFlags}; Max-Age=0` });
    }

    // ---- Everything below is a browser page: session (password mode) or Access JWT (access mode) ----
    const pageGet = req.method === 'GET' || req.method === 'HEAD';
    const withCookie = (ui, h = {}) => (ui.setCookie ? { ...h, 'set-cookie': ui.setCookie } : h);
    let m;
    if ((m = /^\/oauth\/([\w-]+)\/start$/.exec(p)) && req.method === 'GET') {
      const ui = await requireUi(req, ctx);
      if (ui instanceof Response) return ui;
      try {
        const r = await core.oauth.start(m[1], { reconnectId: url.searchParams.get('reconnect') || null });
        await core.audit.record({ principal: sessionPrincipal(ui.session), via: 'ui', operation: 'oauth_start', target: m[1], status: 200 });
        return send(302, '', withCookie(ui, { location: r.url }));
      } catch (e) {
        if (e.status === 409 && e.extra?.app) return send(302, '', withCookie(ui, { location: `/#/settings/apps/${e.extra.app}` }));
        return htmlMessage(e.status || 500, 'Cannot connect', esc(e.message), '/#/accounts', withCookie(ui));
      }
    }
    if ((m = /^\/oauth\/([\w-]+)\/callback$/.exec(p)) && req.method === 'GET') {
      // Password mode keeps the historical behaviour (state parameter protects the callback);
      // Access mode additionally requires the owner's Access identity.
      let ui = { session: null, setCookie: null };
      if (accessMode) { ui = await requireUi(req, ctx); if (ui instanceof Response) return ui; }
      try {
        const r = await core.oauth.callback(m[1], Object.fromEntries(url.searchParams));
        if (r.select) return send(302, '', withCookie(ui, { location: `/#/accounts/select/${r.select}` }));
        await core.audit.record({ principal: ui.session?.email ? sessionPrincipal(ui.session) : { type: 'oauth', name: m[1] }, via: 'ui', operation: 'oauth_connected', status: 200, detail: r.connected });
        return htmlMessage(200, 'Account connected', `Connected: ${r.connected.map((c) => esc(c.name)).join(', ')}. You can close this tab.`, '/#/accounts', withCookie(ui));
      } catch (e) { return htmlMessage(e.status || 500, 'Connection failed', esc(e.message), '/#/accounts', withCookie(ui)); }
    }
    const isDoc = p === '/llms.txt' || p === '/AGENTS.md' || p === '/docs/agent-guide.md' || /^\/docs\/setup\/?/.test(p);
    if (isDoc && pageGet) {
      // Docs are public in password mode (as before); in Access mode they sit behind Access like every page.
      let ui = { setCookie: null };
      if (accessMode) { ui = await requireUi(req, ctx); if (ui instanceof Response) return ui; }
      if (p === '/llms.txt') return files.serve(req, 'docs/llms.txt');
      if (p === '/AGENTS.md' || p === '/docs/agent-guide.md') return agentGuide(req);
      const gm = /^\/docs\/setup\/?(?:([^/]*?)(?:\.md)?)?$/.exec(p);
      if (gm) return serveGuide(gm[1] || '', withCookie(ui));
    }
    if (p === '/' || p === '/index.html') {
      const ui = await requireUi(req, ctx);
      if (ui instanceof Response) return ui;
      if (ui.setCookie) {
        // first request after Access sign-in: set the session cookie, then serve the shell
        return sendShell({ 'set-cookie': ui.setCookie });
      }
      return sendShell();
    }
    if (accessMode && pageGet) {
      // unknown paths: don't reveal anything to callers without a valid Access identity
      const ui = await requireUi(req, ctx);
      if (ui instanceof Response) return ui;
    }
    return send(404, 'Not found', { 'content-type': 'text/plain' });
  }

  return {
    /** @param {Request} req  @param {{remoteAddress?:string}} [ctx] */
    async fetch(req, ctx = {}) {
      try {
        return await route(req, ctx);
      } catch (e) {
        return sendError(e);
      }
    },
    baseHeaders,
    CSP,
  };
}
