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
  const target = list.find((t) => /postlite/.test(t.title || '') && !/proxy/i.test(t.title || '')) || list[list.length - 1];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close(), title: target.title };
}

/** CPU ms = sampled time that is not "(idle)" (JS + GC + native/VM work in the isolate). */
function cpuFromProfile(profile) {
  const idle = new Set(profile.nodes.filter((n) => n.callFrame.functionName === '(idle)').map((n) => n.id));
  let busy = 0;
  for (let i = 0; i < profile.samples.length; i++) if (!idle.has(profile.samples[i])) busy += profile.timeDeltas[i] || 0;
  return busy / 1000;
}

/**
 * Start a local Worker. vars: extra Worker vars (strings). Returns helpers.
 */
export async function startWorker({ vars = {}, fake = null, profile = true } = {}) {
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
    } catch { cdp = null; }
  }
  const cpu = { samples: [] }; // { label, ms }

  /** Run fn while sampling the isolate's CPU; records { label, ms }. */
  async function measure(label, fn) {
    if (!cdp) return fn();
    await cdp.send('Profiler.start');
    let result;
    try { result = await fn(); } finally {
      const { profile: p } = await cdp.send('Profiler.stop');
      cpu.samples.push({ label, ms: Math.round(cpuFromProfile(p) * 100) / 100 });
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
  for (const s of samples) (by.get(s.label) || by.set(s.label, []).get(s.label)).push(s.ms);
  return [...by.entries()].map(([label, v]) => {
    const sorted = [...v].sort((a, b) => a - b);
    return { label, n: v.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], max: sorted[sorted.length - 1] };
  });
}
