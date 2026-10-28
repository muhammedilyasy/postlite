// Node adapter for the portable HTTP app (src/http/app.js): node:http ⇄ Request/Response bridge
// and filesystem-backed static files / docs.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ROOT } from '../node/config.js';
import { VERSION } from '../node/core.js';
import { createApp } from './app.js';
import { validateAuthConfig } from '../access.js';

const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2' };
const BASE = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };

/** Files under the repo root (public/, docs/, src/shared/), with ETag revalidation. */
export function nodeFiles(root = ROOT) {
  let shellInfo = null;
  const resolve = (rel) => {
    const f = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    return f.startsWith(root) ? f : null;
  };
  return {
    async serve(req, rel, { csp = null } = {}) {
      const file = resolve(rel);
      let st;
      try { st = file && fs.statSync(file); } catch {}
      if (!st || !st.isFile()) return new Response('Not found', { status: 404, headers: { ...BASE, 'content-type': 'text/plain' } });
      const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      const versioned = /[?&]v=[0-9a-f]{8,}/.test(new URL(req.url).search);
      const headers = { ...BASE, etag, 'cache-control': file.endsWith('.woff2') || versioned ? 'public, max-age=31536000, immutable' : 'no-cache', ...(csp ? { 'content-security-policy': csp } : {}) };
      if (!csp && req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
      return new Response(req.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': String(st.size) } });
    },
    async text(rel) {
      const f = resolve(rel);
      try { return f ? fs.readFileSync(f, 'utf8') : null; } catch { return null; }
    },
    async list(dir) {
      const d = resolve(dir);
      try { return d ? fs.readdirSync(d) : []; } catch { return []; }
    },
    /** Content hash of the UI code + module URLs for the app shell (import map / modulepreload). */
    async shellInfo() {
      if (shellInfo) return shellInfo;
      const jsDir = path.join(root, 'public', 'js');
      const sharedDir = path.join(root, 'src', 'shared');
      const mods = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js') && f !== 'theme.js').map((f) => [`/assets/js/${f}`, path.join(jsDir, f)]);
      const shared = fs.readdirSync(sharedDir).filter((f) => f.endsWith('.js')).map((f) => [`/assets/shared/${f}`, path.join(sharedDir, f)]);
      const all = [...mods, ...shared, ['/assets/app.css', path.join(root, 'public', 'app.css')], ['/assets/js/theme.js', path.join(jsDir, 'theme.js')]];
      const hash = crypto.createHash('sha256');
      for (const [, f] of all) hash.update(fs.readFileSync(f));
      shellInfo = { v: hash.digest('hex').slice(0, 12), modules: mods.map(([u]) => u), shared: shared.map(([u]) => u) };
      return shellInfo;
    },
    /** Node: same path + ?v=<hash>, served with immutable caching. */
    versioned: (url, v) => `${url}?v=${v}`,
  };
}

/** node:http server around the portable app. */
export function createServer(core) {
  validateAuthConfig(core.cfg); // fail closed before listening
  const app = createApp(core, { files: nodeFiles(), version: VERSION });

  async function handle(req, res) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || k.startsWith(':')) continue;
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else headers.set(k, v);
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`http://${req.headers.host || 'local'}${req.url}`, {
      method: req.method, headers, ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
    });
    const response = await app.fetch(request, { remoteAddress: req.socket.remoteAddress || '' });
    const out = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    if (!response.body || req.method === 'HEAD') {
      if (response.body) response.body.cancel().catch(() => {});
      res.end();
      if (hasBody && !req.readableEnded) req.resume();
      return;
    }
    const body = Readable.fromWeb(response.body);
    body.on('error', () => res.destroy());
    res.on('close', () => { if (!res.writableFinished) body.destroy(); });
    body.pipe(res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      core.log('error', e.stack || String(e));
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { status: 500, message: 'Internal server error' } }));
    });
  });
  server.requestTimeout = 0; // large uploads
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 5000;
  return server;
}
