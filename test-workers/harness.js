// Workers test harness: runs the REAL Worker (wrangler.jsonc → src/workers/index.js, bundled by
// wrangler/esbuild) in local workerd via `wrangler dev`, with local D1 (migrations applied by
// `wrangler d1 migrations apply --local`) and local R2, against the fake platform server.
// Cron Triggers are fired through wrangler's --test-scheduled endpoint (/__scheduled).
// CPU time per invocation is sampled through the V8 inspector (Profiler domain) of the workerd isolate.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFake } from '../test/fake/server.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
export const hasWrangler = () => fs.existsSync(WRANGLER);

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP client over the inspector WebSocket (Node ≥ 22 has a global WebSocket). */
async function connectInspector(port) {
  let list;
  for (let i = 0; i < 50; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (list.length) break; } catch {}
    await sleep(200);
  }
  if (process.env.DEBUG_CPU) console.error('targets', JSON.stringify(list));
  const target = list.find((t) => /postlite/.test(t.title || '') && !/proxy/i.test(t.title || '')) || list[list.length - 1];
  // The `ws` package (a wrangler dependency) lets us send an Origin header; wrangler's inspector proxy
  // only accepts devtools / localhost origins.
  const { default: WS } = await import('ws');
  const ws = new WS(target.webSocketDebuggerUrl, { origin: 'http://localhost', headers: { host: `localhost:${port}` } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const m = JSON.parse(String(data));
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close(), title: target.title };
}

/** Descendant PIDs of `root` whose command is workerd (the local Workers runtime). */
function workerdPids(root) {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
      (kids.get(ppid) || kids.set(ppid, []).get(ppid)).push(Number(d));
    } catch {}
  }
  const out = [];
  const walk = (p) => { for (const c of kids.get(p) || []) { try { if (/workerd/.test(fs.readFileSync(`/proc/${c}/cmdline`, 'utf8'))) out.push(c); } catch {} walk(c); } };
  walk(root);
  return out;
}

/** On-CPU nanoseconds of all threads of the given processes (/proc/<pid>/task/<tid>/schedstat). */
function cpuNs(pids) {
  let ns = 0;
  for (const pid of pids) {
    let tasks = [];
    try { tasks = fs.readdirSync(`/proc/${pid}/task`); } catch { continue; }
    for (const t of tasks) { try { ns += Number(fs.readFileSync(`/proc/${pid}/task/${t}/schedstat`, 'utf8').split(' ')[0]); } catch {} }
  }
  return ns;
}

/** Self time per function (ms), top 12 — to see where CPU goes. */
function topFunctions(profile) {
  const node = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const n = node.get(profile.samples[i]);
    const k = `${n.callFrame.functionName || '(anon)'} ${String(n.callFrame.url).split('/').slice(-1)[0]}:${n.callFrame.lineNumber}`;
    self.set(k, (self.get(k) || 0) + (profile.timeDeltas[i] || 0) / 1000);
  }
  return [...self.entries()].filter(([k]) => !k.startsWith('(idle)')).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${v.toFixed(2)}ms ${k}`);
}

/**
 * From a V8 CPU profile: busy = every sample that is not "(idle)" (JS + GC + "(program)" native/VM work —
 * an upper bound, since "(program)" includes runtime bookkeeping); js = JS + GC only.
 */
function cpuFromProfile(profile) {
  const name = new Map(profile.nodes.map((n) => [n.id, n.callFrame.functionName]));
  let busy = 0, js = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = name.get(profile.samples[i]);
    const d = profile.timeDeltas[i] || 0;
    if (n === '(idle)') continue;
    busy += d;
    if (n !== '(program)') js += d;
  }
  return { busy: busy / 1000, js: js / 1000 };
}

/**
 * Start a local Worker. vars: extra Worker vars (strings). Returns helpers.
 */
export async function startWorker({ vars = {}, fake = null, profile = !process.env.NO_PROFILE } = {}) {
  fake ||= await startFake();
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'postlite-cf-'));
  const port = await freePort();
  const inspectorPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    TOKEN_ENC_KEY: 'test-token-encryption-key-0123456789',
    SESSION_SECRET: 'workers-test-session-secret',
    AUTH_MODE: 'password',
    PUBLIC_URL: base,
    DEFAULT_TIMEZONE: 'UTC',
    META_APP_ID: 'meta-app', META_APP_SECRET: 'meta-secret',
    INSTAGRAM_APP_ID: 'ig-app', INSTAGRAM_APP_SECRET: 'ig-secret',
    GOOGLE_CLIENT_ID: 'g-client', GOOGLE_CLIENT_SECRET: 'g-secret',
    POLL_INTERVAL_MS: '0', BACKOFF_BASE_MS: '50', MAX_ATTEMPTS: '3',
    ALLOW_PRIVATE_MEDIA_URLS: '1', WEBHOOK_BACKOFF_MS: '50', ANALYTICS_BACKFILL_DAYS: '3',
    LOG_LEVEL: 'info',
    ...fake.env(),
    ...vars,
  };
  const envFile = path.join(dir, 'test.env');
  // Values containing "$" go through --var (wrangler's .env loader expands $NAME references).
  const dollar = Object.entries(env).filter(([, v]) => String(v).includes('$'));
  fs.writeFileSync(envFile, Object.entries(env).filter(([, v]) => !String(v).includes('$')).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join('\n'));
  const persist = path.join(dir, 'state');
  const cmdEnv = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
  execFileSync(WRANGLER, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist], { cwd: ROOT, env: cmdEnv, stdio: 'pipe' });
  const logFile = path.join(dir, 'wrangler.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(WRANGLER, ['dev', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspectorPort), '--persist-to', persist,
    '--test-scheduled', '--show-interactive-dev-session=false', '--env-file', envFile, '--log-level', 'info', ...dollar.flatMap(([k, v]) => ['--var', `${k}:${v}`])], { cwd: ROOT, env: cmdEnv, stdio: ['ignore', out, out] });
  let ok = false;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`${base}/healthz`); if (r.ok) { ok = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await sleep(200);
  }
  if (!ok) { child.kill('SIGTERM'); throw new Error(`wrangler dev did not start:\n${fs.readFileSync(logFile, 'utf8').slice(-3000)}`); }

  let cdp = null;
  if (profile) {
    try {
      cdp = await connectInspector(inspectorPort);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 50 });
    } catch (e) { if (process.env.DEBUG_CPU) console.error('inspector:', e); cdp = null; }
  }
  const cpu = { samples: [] }; // { label, ms }

  const pids = fs.existsSync('/proc/self/task') ? workerdPids(child.pid) : [];
  /**
   * Run fn and record CPU for it:
   *  proc_ms  – real on-CPU time of every workerd thread (Linux schedstat). Upper bound: it also includes
   *             the local D1 (SQLite) and R2 simulators and the dev proxy, which are not billed to a Worker.
   *  ms/js_ms – V8 sampling profile of the Worker isolate (busy / JS-only). Inflated by the profiler itself.
   */
  async function measure(label, fn) {
    const t0 = pids.length ? cpuNs(pids) : 0;
    if (!cdp) {
      const r = await fn();
      if (pids.length) cpu.samples.push({ label, proc_ms: Math.round((cpuNs(pids) - t0) / 1e4) / 100 });
      return r;
    }
    await cdp.send('Profiler.start');
    let result;
    try { result = await fn(); } finally {
      const t1 = pids.length ? cpuNs(pids) : 0;
      const { profile: p } = await cdp.send('Profiler.stop');
      const c = cpuFromProfile(p);
      cpu.samples.push({ label, proc_ms: Math.round((t1 - t0) / 1e4) / 100, ms: Math.round(c.busy * 100) / 100, js_ms: Math.round(c.js * 100) / 100 });
      if (process.env.CPU_TOP) cpu.top = (cpu.top || []).concat([{ label, top: topFunctions(p) }]);
    }
    return result;
  }

  const w = {
    base, fake, dir, env, cpu, measure, logFile,
    log: () => fs.readFileSync(logFile, 'utf8'),
    /** Fire one Cron Trigger invocation (scheduled handler). */
    cron: (label = 'cron') => measure(label, async () => { const r = await fetch(`${base}/__scheduled?cron=*+*+*+*+*`); await r.text(); return r.status; }),
    /** Run cron until fn() is truthy (or tries run out). */
    async cronUntil(fn, { tries = 60, wait = 30, label = 'cron' } = {}) {
      for (let i = 0; i < tries; i++) {
        await w.cron(label);
        const v = await fn();
        if (v) return v;
        await sleep(wait);
      }
      throw new Error(`cronUntil: condition not met after ${tries} cron runs`);
    },
    async api(method, p, { key, session, body, headers = {}, raw = false, label = null } = {}) {
      const h = { ...headers };
      if (key) h.authorization = `Bearer ${key}`;
      if (session) { h.cookie = session.cookie; h['x-csrf-token'] = session.csrf; }
      if (body !== undefined && !raw) h['content-type'] = 'application/json';
      const run = async () => {
        const res = await fetch(`${base}/api/v1${p}`, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), ...(raw && body instanceof ReadableStream ? { duplex: 'half' } : {}) });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { status: res.status, json, text, headers: res.headers };
      };
      return label ? measure(label, run) : run();
    },
    async stop() {
      try { cdp?.close(); } catch {}
      child.kill('SIGTERM');
      await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 5000); } });
      await fake.close?.();
      if (!process.env.KEEP_CF_STATE) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return w;
}

export function cpuSummary(samples) {
  const by = new Map();
  for (const s of samples) (by.get(s.label) || by.set(s.label, []).get(s.label)).push(s);
  const stat = (v) => { v = v.filter((x) => x !== undefined); if (!v.length) return {}; const s = [...v].sort((a, b) => a - b); return { median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] }; };
  return [...by.entries()].map(([label, v]) => ({ label, n: v.length, ...stat(v.map((x) => x.ms)), js: stat(v.map((x) => x.js_ms)), proc: stat(v.map((x) => x.proc_ms)) }));
}

/**
 * CPU bench mode (CPU_BENCH=1): same interface as startWorker(), but runs the real Worker module in a
 * Node worker thread with D1/R2/ASSETS shims (test-workers/bench-thread.js) and reports the Worker's
 * own CPU per invocation (thread CPU minus time inside the binding shims).
 */
export async function startBench({ vars = {}, fake = null } = {}) {
  const { Worker } = await import('node:worker_threads');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'cf-assets.mjs')], { stdio: 'pipe' });
  fake ||= await startFake();
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'postlite-bench-'));
  const base0 = { TOKEN_ENC_KEY: 'test-token-encryption-key-0123456789', SESSION_SECRET: 'workers-test-session-secret', AUTH_MODE: 'password', DEFAULT_TIMEZONE: 'UTC',
    META_APP_ID: 'meta-app', META_APP_SECRET: 'meta-secret', INSTAGRAM_APP_ID: 'ig-app', INSTAGRAM_APP_SECRET: 'ig-secret', GOOGLE_CLIENT_ID: 'g-client', GOOGLE_CLIENT_SECRET: 'g-secret',
    POLL_INTERVAL_MS: '0', BACKOFF_BASE_MS: '50', MAX_ATTEMPTS: '3', ALLOW_PRIVATE_MEDIA_URLS: '1', WEBHOOK_BACKOFF_MS: '50', ANALYTICS_BACKFILL_DAYS: '3', LOG_LEVEL: 'warn' };
  // port is unknown until the server listens: PUBLIC_URL is filled from the first request's origin
  const env = { ...base0, ...fake.env(), ...vars };
  delete env.PUBLIC_URL;
  const th = new Worker(path.join(ROOT, 'test-workers', 'bench-thread.js'), { workerData: { root: ROOT, vars: env, dbFile: path.join(dir, 'd1.sqlite') } });
  th.on('message', async (m) => { // subrequests of the Worker under test (see bench-thread.js)
    if (m.type !== 'fetch') return;
    try {
      const r = await fetch(m.url, { method: m.method, headers: m.headers, body: m.body || undefined, redirect: m.redirect === 'manual' ? 'manual' : 'follow' });
      const body = new Uint8Array(await r.arrayBuffer());
      th.postMessage({ type: 'fetch-reply', id: m.id, status: r.status, headers: [...r.headers], body }, [body.buffer]);
    } catch (e) {
      th.postMessage({ type: 'fetch-reply', id: m.id, error: String(e.cause?.message || e.message) });
    }
  });
  const waitMsg = (type) => new Promise((resolve) => { const h = (m) => { if (m.type === type) { th.off('message', h); resolve(m); } }; th.on('message', h); });
  const { port } = await waitMsg('ready');
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/healthz`);
  const cpu = { samples: [] };
  async function measure(label, fn) {
    th.postMessage({ type: 'reset' });
    await waitMsg('reset-ok');
    const r = await fn();
    th.postMessage({ type: 'read' });
    const { samples } = await waitMsg('cpu');
    // the first invocation in fn is the one being measured; others (e.g. Meta fetching /m/ media) are separate
    const own = samples.filter((s) => !(s.path || '').startsWith('/m/'));
    for (const s of own.length ? own : samples) cpu.samples.push({ label, ms: Math.round(s.us / 10) / 100 });
    for (const s of samples.filter((x) => (x.path || '').startsWith('/m/'))) cpu.samples.push({ label: 'GET /m/<token> (media for Meta/Google)', ms: Math.round(s.us / 10) / 100 });
    return r;
  }
  const w = {
    base, fake, dir, env, cpu, measure, bench: true, log: () => '',
    cron: (label = 'cron') => measure(label, async () => { const r = await fetch(`${base}/__scheduled`); await r.text(); return r.status; }),
    async cronUntil(fn, { tries = 60, wait = 30, label = 'cron' } = {}) {
      for (let i = 0; i < tries; i++) { await w.cron(label); const v = await fn(); if (v) return v; await sleep(wait); }
      throw new Error(`cronUntil: condition not met after ${tries} cron runs`);
    },
    async api(method, p, { key, session, body, headers = {}, raw = false, label = null } = {}) {
      const h = { ...headers };
      if (key) h.authorization = `Bearer ${key}`;
      if (session) { h.cookie = session.cookie; h['x-csrf-token'] = session.csrf; }
      if (body !== undefined && !raw) h['content-type'] = 'application/json';
      const run = async () => {
        const res = await fetch(`${base}/api/v1${p}`, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { status: res.status, json, text, headers: res.headers };
      };
      return label ? measure(label, run) : run();
    },
    async stop() {
      th.postMessage({ type: 'close' });
      await new Promise((r) => { th.once('exit', r); setTimeout(r, 3000); });
      await fake.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return w;
}
