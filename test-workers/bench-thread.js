// CPU bench for the Worker code, run inside a Node worker thread (see bench.js).
// Loads the REAL Worker entry (src/workers/index.js) with binding shims:
//   DB     → D1 API over node:sqlite (migrations/*.sql applied)
//   MEDIA  → R2 API in memory (put/get/head/delete/multipart)
//   ASSETS → .cf-assets/ directory (built by scripts/cf-assets.mjs)
// Each invocation (fetch / scheduled) is timed with process.threadCpuUsage(); time spent inside the
// shims is subtracted, because on Cloudflare D1/R2 run outside the isolate and waiting on them is not
// CPU time (developers.cloudflare.com/workers/platform/limits/#cpu-time). What remains is the Worker's
// own JS (+ WebCrypto) CPU per invocation — the number the 10 ms Free-plan limit applies to.
import { parentPort, workerData } from 'node:worker_threads';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { root, vars, dbFile } = workerData;
import { AsyncLocalStorage } from 'node:async_hooks';

const tcpu = () => { const u = process.threadCpuUsage(); return u.user + u.system; }; // µs
// Invocations can overlap on this thread (e.g. Meta fetches /m/<token> media while a cron step waits for
// Meta's reply), so CPU is attributed per invocation: shim time goes to the invocation that called the
// shim (AsyncLocalStorage), and a nested invocation's whole CPU is subtracted from the ones it overlapped.
const als = new AsyncLocalStorage();
const active = new Set();
let orphan = 0;
const charge = (us) => { const c = als.getStore(); if (c) c.excluded += us; else orphan += us; };
const shim = (fn) => function (...a) {
  const t = tcpu();
  try { return fn.apply(this, a); } finally { charge(tcpu() - t); }
};

// ---- D1 shim ----
const sqlite = new DatabaseSync(dbFile);
sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF');
for (const f of fs.readdirSync(path.join(root, 'migrations')).filter((x) => /^\d{4}_.+\.sql$/.test(x)).sort()) sqlite.exec(fs.readFileSync(path.join(root, 'migrations', f), 'utf8'));
const isRows = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
function stmt(sql, params = []) {
  return {
    bind: (...p) => stmt(sql, p),
    first: shim(async () => sqlite.prepare(sql).get(...params) ?? null),
    all: shim(async () => ({ results: sqlite.prepare(sql).all(...params), meta: {} })),
    run: shim(async () => { const r = sqlite.prepare(sql).run(...params); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }),
    _exec() {
      if (isRows(sql)) { const rows = sqlite.prepare(sql).all(...params); return { results: rows, meta: { changes: rows.length } }; }
      const r = sqlite.prepare(sql).run(...params);
      return { results: [], meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    },
  };
}
const DB = {
  prepare: (sql) => stmt(sql),
  batch: shim(async (list) => {
    sqlite.exec('BEGIN');
    try { const out = list.map((s) => s._exec()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  }),
  exec: shim(async (sql) => { sqlite.exec(sql); }),
};

// ---- R2 shim (in memory) ----
const objects = new Map();
const uploads = new Map();
const collect = async (body) => {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  const chunks = [];
  let n = 0;
  for await (const c of body) { chunks.push(c); n += c.length; }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};
const timedCollect = async (body) => { // bytes arriving over a stream are I/O, copying them is shim work
  const t = tcpu();
  const r = await collect(body);
  charge(tcpu() - t);
  return r;
};
const obj = (key, data, range) => {
  const off = range?.offset || 0;
  const len = range?.length ?? data.length - off;
  const slice = data.subarray(off, off + len);
  return { key, size: data.length, etag: `e${data.length}`, httpEtag: `"e${data.length}"`, body: new Blob([slice]).stream(), arrayBuffer: async () => slice.slice().buffer, text: async () => new TextDecoder().decode(slice) };
};
const MEDIA = {
  put: async (key, body) => { const d = await timedCollect(body); objects.set(key, d); return { key, size: d.length, etag: `e${d.length}` }; },
  get: shim(async (key, opts) => { const d = objects.get(key); return d ? obj(key, d, opts?.range) : null; }),
  head: shim(async (key) => { const d = objects.get(key); return d ? { key, size: d.length, etag: `e${d.length}` } : null; }),
  delete: shim(async (keys) => { for (const k of [].concat(keys)) objects.delete(k); }),
  createMultipartUpload: shim(async (key) => { const id = `mp-${uploads.size + 1}-${Date.now()}`; uploads.set(id, new Map()); return MEDIA.resumeMultipartUpload(key, id); }),
  resumeMultipartUpload: (key, id) => ({
    uploadId: id, key,
    uploadPart: async (n, body) => { const d = await timedCollect(body); uploads.get(id).set(n, d); return { partNumber: n, etag: `p${n}-${d.length}` }; },
    complete: shim(async (parts) => {
      const m = uploads.get(id);
      const ds = parts.map((p) => m.get(p.partNumber));
      const out = new Uint8Array(ds.reduce((a, b) => a + b.length, 0));
      let o = 0;
      for (const d of ds) { out.set(d, o); o += d.length; }
      objects.set(key, out);
      uploads.delete(id);
      return { key, size: out.length };
    }),
    abort: shim(async () => { uploads.delete(id); }),
  }),
};

// ---- ASSETS shim ----
const assetsDir = path.join(root, '.cf-assets');
const ASSETS = {
  fetch: shim(async (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname);
    const f = path.join(assetsDir, p);
    if (!f.startsWith(assetsDir) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return new Response('Not found', { status: 404 });
    const extra = p.startsWith('/assets/v/') ? { 'cache-control': 'public, max-age=31536000, immutable' } : {}; // _headers rule
    const type = /\.js$/.test(f) ? 'text/javascript' : /\.css$/.test(f) ? 'text/css' : /\.json$/.test(f) ? 'application/json' : /\.html$/.test(f) ? 'text/html' : /\.svg$/.test(f) ? 'image/svg+xml' : 'text/plain';
    return new Response(fs.readFileSync(f), { headers: { 'content-type': type, etag: `"${fs.statSync(f).size}"`, ...extra } });
  }),
};

// fetch() is a native runtime API on Workers (no JS HTTP client in the isolate). Node's fetch is undici,
// written in JS, which would dominate the numbers, so subrequests are performed by the main thread:
// this thread only pays for building the Request and reading the Response (as on Workers).
const nodeFetch = globalThis.fetch;
const pending = new Map();
let fetchSeq = 0;
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const body = req.body ? await timedCollect(req.body) : null;
  const id = ++fetchSeq;
  const reply = await new Promise((resolve) => {
    pending.set(id, resolve);
    parentPort.postMessage({ type: 'fetch', id, url: req.url, method: req.method, redirect: req.redirect, headers: [...req.headers], body });
  });
  if (reply.error) throw new TypeError(`fetch failed: ${reply.error}`);
  return new Response(reply.body && [101, 204, 205, 304].includes(reply.status) ? null : reply.body, { status: reply.status, headers: reply.headers });
};

// Workers-only globals used by the R2 adapter
globalThis.FixedLengthStream = class extends TransformStream { constructor() { super(); } };

const { default: worker } = await import(path.join(root, 'src/workers/index.js'));
const env = { ...vars, DB, MEDIA, ASSETS };

let samples = []; // invocations since the last reset
const PROFILE = process.env.BENCH_PROFILE ? new (await import('node:inspector/promises')).Session() : null;
if (PROFILE) { PROFILE.connect(); await PROFILE.post('Profiler.enable'); await PROFILE.post('Profiler.setSamplingInterval', { interval: 100 }); }
function top(profile) {
  const node = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const n = node.get(profile.samples[i]);
    const k = `${n.callFrame.functionName || '(anon)'} ${String(n.callFrame.url).split('/').slice(-2).join('/')}:${n.callFrame.lineNumber}`;
    self.set(k, (self.get(k) || 0) + (profile.timeDeltas[i] || 0) / 1000);
  }
  return [...self.entries()].filter(([k]) => !k.startsWith('(idle)')).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${v.toFixed(2)}ms ${k}`);
}
async function invoke(label, fn) {
  if (PROFILE && !active.size) await PROFILE.post('Profiler.start');
  const waits = [];
  const c = { excluded: 0, foreign: 0 };
  active.add(c);
  const t0 = tcpu();
  const { res, body } = await als.run(c, async () => {
    const r = await fn({ waitUntil: (p) => waits.push(p), passThroughOnException() {} });
    // response bodies streamed from R2 are I/O on Cloudflare: drain them as shim time
    let b = null;
    if (r instanceof Response) { const t = tcpu(); b = new Uint8Array(await r.arrayBuffer()); if (r.headers.get('content-type')?.match(/^(image|video)\//)) c.excluded += tcpu() - t; }
    return { res: r, body: b };
  });
  const raw = tcpu() - t0;
  active.delete(c);
  for (const o of active) o.foreign += raw;
  const spent = Math.max(0, raw - c.excluded - c.foreign);
  const excluded = c.excluded + c.foreign;
  if (process.env.BENCH_LOG && spent > 8000) console.error(`[bench] ${label} ${fn.path || ""} ${(spent / 1000).toFixed(1)}ms raw ${(raw / 1000).toFixed(1)} shims ${(c.excluded / 1000).toFixed(1)} nested ${(c.foreign / 1000).toFixed(1)} orphan ${(orphan / 1000).toFixed(1)}`);
  if (PROFILE && !active.size) {
    const { profile } = await PROFILE.post('Profiler.stop');
    if (spent > 15000) console.error(`\n[bench] ${label} ${fn.path || ''} ${(spent / 1000).toFixed(1)}ms (shims excluded ${(excluded / 1000).toFixed(1)}ms)\n  ${top(profile).join('\n  ')}`);
  }
  await Promise.allSettled(waits);
  samples.push({ label, path: label === 'fetch' ? fn.path : undefined, us: spent });
  return { res, body };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host}${req.url}`;
    if (req.url.startsWith('/__scheduled')) {
      await invoke('scheduled', (ctx) => worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, env, ctx));
      res.writeHead(200); return res.end('ran');
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const reqBody = hasBody ? await collect(req) : null; // network receive: not Worker CPU
    const request = new Request(url, { method: req.method, headers: Object.entries(req.headers).flatMap(([k, v]) => [].concat(v).map((x) => [k, x])), body: hasBody ? reqBody : undefined, redirect: 'manual' });
    const call = (ctx) => worker.fetch(request, env, ctx);
    call.path = new URL(url).pathname;
    const { res: r, body } = await invoke('fetch', call);
    const headers = {};
    r.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
    const cookies = r.headers.getSetCookie?.() || [];
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(r.status, headers);
    res.end(Buffer.from(body));
  } catch (e) {
    res.writeHead(500); res.end(String(e.stack || e));
  }
});
server.listen(0, '127.0.0.1', async () => {
  // Warm up Node's lazily-loaded fetch (undici) and WebCrypto so their one-time JS initialisation is not
  // billed to the first measured invocation: on Workers both are native runtime APIs.
  const port = server.address().port;
  const warm = http.createServer((q, r) => r.end('{}')).listen(0, '127.0.0.1');
  await new Promise((r) => warm.once('listening', r));
  for (let i = 0; i < 3; i++) await (await nodeFetch(`http://127.0.0.1:${warm.address().port}/`, { method: 'PUT', body: new Uint8Array(1024) })).text();
  await crypto.subtle.digest('SHA-256', new Uint8Array(8));
  await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  warm.close();
  parentPort.postMessage({ type: 'ready', port });
});
parentPort.on('message', (m) => {
  if (m.type === 'fetch-reply') { pending.get(m.id)?.(m); pending.delete(m.id); }
  if (m.type === 'reset') { samples = []; parentPort.postMessage({ type: 'reset-ok' }); }
  if (m.type === 'read') parentPort.postMessage({ type: 'cpu', samples });
  if (m.type === 'close') server.close(() => process.exit(0));
});
