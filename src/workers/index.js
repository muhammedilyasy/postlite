// Cloudflare Workers entry point: D1 + R2 + static assets + Cron Trigger.
//   fetch      → the same portable HTTP app as Node (src/http/app.js)
//   scheduled  → one bounded scheduler/webhook/analytics pass per minute (src/core.js cron())
// Bindings (wrangler.jsonc): DB (D1), MEDIA (R2), ASSETS (static assets). Secrets: TOKEN_ENC_KEY, …
import { getConfig } from '../config.js';
import { createCore, consoleLogger } from '../core.js';
import { createApp } from '../http/app.js';
import { createD1 } from './d1.js';
import { createR2Storage } from './r2.js';
import { createMeter, useMeter } from '../meter.js';
import { hashPasswordPbkdf2, verifyPasswordPbkdf2 } from '../crypto.js';
import pkg from '../../package.json';

const VERSION = pkg.version;
const INTERNAL = 'https://assets.invalid';

/** Static files and docs from the Workers static-assets binding (layout built by scripts/cf-assets.mjs). */
function assetFiles(env) {
  const textCache = new Map();
  let manifest = null;
  const BASE = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };
  const map = (rel) => {
    if (rel.startsWith('public/')) {
      const r = rel.slice('public/'.length);
      return r === 'index.html' || r === 'login.html' ? `/_internal/${r}` : `/assets/${r}`;
    }
    if (rel.startsWith('src/shared/')) return `/assets/shared/${rel.slice('src/shared/'.length)}`;
    if (rel.startsWith('docs/')) return `/_internal/${rel}`;
    return null; // e.g. AGENTS.md (not shipped)
  };
  const fetchAsset = async (rel, headers = {}) => {
    const p = map(rel);
    if (!p || !env.ASSETS) return null;
    const r = await env.ASSETS.fetch(new Request(`${INTERNAL}${p}`, { headers }));
    return r.status === 404 ? null : r;
  };
  return {
    async serve(req, rel, { csp = null } = {}) {
      const inm = req.headers.get('if-none-match');
      const r = await fetchAsset(rel, inm && !csp ? { 'if-none-match': inm } : {});
      if (!r) return new Response('Not found', { status: 404, headers: { ...BASE, 'content-type': 'text/plain' } });
      const h = new Headers(r.headers);
      for (const [k, v] of Object.entries(BASE)) h.set(k, v);
      if (csp) { h.set('content-security-policy', csp); h.set('cache-control', 'no-cache'); }
      return new Response(req.method === 'HEAD' ? null : r.body, { status: r.status, headers: h });
    },
    async text(rel) {
      if (textCache.has(rel)) return textCache.get(rel);
      const r = await fetchAsset(rel);
      const t = r && r.ok ? await r.text() : null;
      textCache.set(rel, t);
      return t;
    },
    async list(dir) {
      if (!manifest) {
        const r = env.ASSETS ? await env.ASSETS.fetch(new Request(`${INTERNAL}/_internal/manifest.json`)) : null;
        manifest = r && r.ok ? await r.json() : {};
      }
      return manifest[dir] || [];
    },
  };
}

const runtime = {
  platform: 'workers',
  version: VERSION,
  hooks: {}, // no ffmpeg/ffprobe on Workers: posters are skipped, the JS MP4 parser reads duration/size
  passwords: { hash: (pw) => hashPasswordPbkdf2(pw), verify: verifyPasswordPbkdf2 },
};

const instances = new WeakMap();

function instance(env) {
  let inst = instances.get(env);
  if (inst) return inst;
  const vars = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') vars[k] = v;
  const cfg = getConfig(vars, { platform: 'workers' });
  const log = consoleLogger(vars.LOG_LEVEL || 'info');
  const problems = [];
  if (!cfg.tokenEncKey || cfg.tokenEncKey.length < 16) problems.push('TOKEN_ENC_KEY secret is not set (wrangler secret put TOKEN_ENC_KEY; generate with `openssl rand -base64 32`).');
  if (!env.DB) problems.push('D1 binding "DB" is missing.');
  if (!env.MEDIA) problems.push('R2 binding "MEDIA" is missing.');
  if (problems.length) {
    inst = { problems };
  } else {
    const db = createD1(env.DB);
    const storage = createR2Storage(env.MEDIA);
    const core = createCore({ cfg, db, storage, runtime, log });
    inst = { cfg, core, log, app: null, files: assetFiles(env) };
  }
  instances.set(env, inst);
  return inst;
}

async function ensurePublicUrl(inst, origin) {
  const { cfg, core } = inst;
  if (cfg.publicUrl) return;
  // PUBLIC_URL not configured: use the URL the Worker is reached at (and remember it for cron runs).
  const saved = await core.db.getSetting('detected_public_url');
  cfg.publicUrl = origin || saved || '';
  cfg.secureCookies = cfg.publicUrl.startsWith('https://');
  if (origin && origin !== saved) await core.db.setSetting('detected_public_url', origin);
}

const budgetMeter = (cfg) => createMeter({ fetches: cfg.budget.fetches, queries: cfg.budget.queries, storageOps: 900 });

export default {
  async fetch(request, env, ctx) {
    const inst = instance(env);
    if (inst.problems) {
      return new Response(`postlite is not configured yet:\n- ${inst.problems.join('\n- ')}\nSee docs/setup/cloudflare-workers.md\n`, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    useMeter(budgetMeter(inst.cfg));
    try {
      await ensurePublicUrl(inst, new URL(request.url).origin);
      if (!inst.app) inst.app = createApp(inst.core, { files: inst.files, version: VERSION });
    } catch (e) {
      const msg = /no such table/i.test(String(e.message)) ? 'The D1 database has no tables yet. Run: npx wrangler d1 migrations apply DB --remote' : e.message;
      inst.log('error', msg);
      return new Response(`postlite: ${msg}\n`, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return inst.app.fetch(request, { waitUntil: (p) => ctx.waitUntil(p) });
  },

  async scheduled(controller, env, ctx) {
    const inst = instance(env);
    if (inst.problems) { console.log(`postlite cron skipped: ${inst.problems.join(' ')}`); return; }
    const meter = useMeter(budgetMeter(inst.cfg));
    await ensurePublicUrl(inst, '');
    if (!inst.cfg.publicUrl) { inst.log('warn', 'cron: PUBLIC_URL unknown (set the PUBLIC_URL var or open the app once); skipping'); return; }
    const out = await inst.core.cron({ budget: meter });
    inst.log('info', `cron ${controller.cron || ''}: ${JSON.stringify(out)} used=${JSON.stringify(meter.snapshot())}`);
  },
};
