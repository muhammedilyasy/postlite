#!/usr/bin/env node
// postlite CLI: server, admin tasks, MCP stdio, and an HTTP client mirroring the API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadDotEnv, getConfig, ROOT } from '../src/node/config.js';

loadDotEnv();
const [, , cmd, ...restRaw] = process.argv;
// Global remote flags (any position): --url https://postlite.example.com --key pl_...
// They target a remote instance (Node or Cloudflare Workers) over the REST API.
const rest = [];
for (let i = 0; i < restRaw.length; i++) {
  const a = restRaw[i];
  const m = /^--(url|key)(?:=(.*))?$/.exec(a);
  if (!m) { rest.push(a); continue; }
  const v = m[2] !== undefined ? m[2] : restRaw[++i];
  if (m[1] === 'url') process.env.POSTLITE_URL = v;
  else process.env.POSTLITE_API_KEY = v;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const HELP = `postlite — lightweight self-hosted scheduler for YouTube, Instagram & Facebook

Server / admin (run on the server, uses .env):
  postlite start                         Start the web server + scheduler
  postlite set-password                  Set the admin password (prompt, or pipe via stdin)
  postlite gen-secrets                   Print fresh SESSION_SECRET and TOKEN_ENC_KEY values
  postlite hash-password                 Print a portable (PBKDF2) password hash for ADMIN_PASSWORD_HASH (Cloudflare Workers)
  postlite keys create --name NAME [--scopes read,write,publish,analytics,admin] [--no-approval] [--rate 120] [--email E | --workspace ID]
  postlite keys list | postlite keys revoke <id>        (keys/apps act on ONE workspace: --email or --workspace
                                                         when there is more than one)
  postlite apps list | apps set <meta|instagram|google> --id ID   (secret: prompt or stdin)
  postlite apps clear <app> | apps test <app>   Platform developer-app credentials (Settings → Platform apps)
  postlite workspaces list                      Workspaces and the emails that own them
  postlite workspaces attribute --owner EMAIL [--apply] [--db FILE]
                                                Dry-run report (or --apply) assigning existing rows to their owners
  postlite mcp                           MCP over stdio (needs POSTLITE_API_KEY; with POSTLITE_URL it bridges to a remote server)

API client — local or remote instance, Node or Cloudflare Workers
(needs POSTLITE_API_KEY or --key; POSTLITE_URL or --url, default http://127.0.0.1:4100):
  postlite tools                         List all operations / MCP tools
  postlite call <tool> [--json '{...}'] [--field value ...]
  postlite accounts list
  postlite media upload <file>          (resumable multipart upload; works for multi-GB videos on Workers)
  postlite posts list [--status scheduled] [--from 2026-11-01 --to 2026-11-08]
  postlite posts create --content "text" --accounts id1,id2 [--media m1,m2] [--at "2026-11-02T18:00" | --next-slot | --now] [--settings '{"title":"..."}']
  postlite posts schedule <post_id> --at TIME | --next-slot
  postlite posts now <post_id>       postlite posts retry <post_id>      postlite posts delete <post_id>
  postlite posts approve <post_id>   postlite posts reject <post_id> --reason "..."
  postlite analytics overview|top|sync [--account ID]
`;

async function core() {
  const { createNodeCore, makeLogger } = await import('../src/node/core.js');
  const c = createNodeCore(getConfig(), { log: makeLogger(process.env.LOG_LEVEL || 'warn') });
  await c.prepare();
  return c;
}

/** The workspace a CLI admin command acts on: --email, --workspace, or the only workspace there is. */
async function cliScope(c, a) {
  let ws = a.workspace ? String(a.workspace) : null;
  if (a.email) {
    const w = await c.workspaces.byEmail(String(a.email));
    if (!w) throw new Error(`No workspace for ${a.email} yet (it is created on first sign-in).`);
    ws = w.workspace_id;
  }
  if (!ws) {
    const all = await c.workspaces.list();
    if (all.length !== 1) throw new Error(`There are ${all.length} workspaces; pass --email EMAIL or --workspace ID (see "postlite workspaces list").`);
    ws = all[0].id;
  }
  if (!(await c.workspaces.get(ws))) throw new Error(`Unknown workspace ${ws}`);
  const sc = c.scope(ws);
  await sc.prepare();
  return sc;
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  }
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stderr.write('\n');
        resolve(s);
      } else if (ch === '\u0003') process.exit(1);
      else if (ch === '\u007f') s = s.slice(0, -1);
      else s += ch;
    };
    process.stdin.on('data', onData);
  });
}

// ---- HTTP client ---------------------------------------------------------------------------
const API_URL = (process.env.POSTLITE_URL || `http://127.0.0.1:${process.env.PORT || 4100}`).replace(/\/+$/, '');
async function callTool(name, input = {}) {
  const { opsByName } = await import('../src/api/operations.js');
  const op = opsByName[name];
  if (!op) throw new Error(`Unknown tool "${name}". Run "postlite tools".`);
  const key = process.env.POSTLITE_API_KEY;
  if (!key) throw new Error('Set POSTLITE_API_KEY (create one with "postlite keys create --name cli").');
  let p = op.path;
  const body = { ...input };
  p = p.replace(/\{(\w+)\}/g, (_, n) => {
    if (body[n] === undefined) throw new Error(`Missing --${n}`);
    const v = encodeURIComponent(body[n]);
    delete body[n];
    return v;
  });
  let url = `${API_URL}/api/v1${p}`;
  const init = { method: op.method, headers: { authorization: `Bearer ${key}` } };
  if (op.method === 'GET' || op.method === 'DELETE') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v !== undefined) q.set(k, Array.isArray(v) ? v.join(',') : String(v));
    if ([...q].length) url += `?${q}`;
  } else {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j.error?.message || `HTTP ${res.status}`);
    e.json = j;
    throw e;
  }
  return j;
}

function coerceFlags(flags) {
  const out = {};
  for (const [k, v] of Object.entries(flags)) {
    if (k === '_' || k === 'json') continue;
    if (v === 'true' || v === true) out[k] = true;
    else if (v === 'false') out[k] = false;
    else if (/^-?\d+$/.test(v) && !/(_id|id)$/.test(k)) out[k] = Number(v);
    else if (/^[[{]/.test(v)) { try { out[k] = JSON.parse(v); } catch { out[k] = v; } }
    else out[k] = v;
  }
  return out;
}

const print = (j) => process.stdout.write(JSON.stringify(j, null, 2) + '\n');

async function main() {
  const a = parseArgs(rest);
  switch (cmd) {
    case 'start': {
      const { start } = await import('../src/main.js');
      return start();
    }
    case 'set-password': {
      if (getConfig().auth.mode === 'cloudflare-access') { console.error('AUTH_MODE=cloudflare-access: password login is disabled; sign-in is handled by Cloudflare Access (ALLOWED_EMAILS). Set AUTH_MODE=password to use a password.'); process.exit(1); }
      const pw = a.password ? String(a.password) : await readSecret('New admin password: ');
      if (!pw || pw.length < 10) { console.error('Password must be at least 10 characters.'); process.exit(1); }
      const c = await core();
      const { hashPassword } = await import('../src/node/core.js');
      await c.db.setSetting('admin_password', hashPassword(pw));
      await c.db.run('DELETE FROM sessions');
      console.error('Admin password updated (all sessions logged out).');
      return c.stop();
    }
    case 'hash-password': {
      const pw = a.password ? String(a.password) : await readSecret('Admin password to hash: ');
      if (!pw || pw.length < 10) { console.error('Password must be at least 10 characters.'); process.exit(1); }
      const { hashPasswordPbkdf2 } = await import('../src/crypto.js');
      console.error('Store this as the Worker secret ADMIN_PASSWORD_HASH (wrangler secret put ADMIN_PASSWORD_HASH):');
      console.log(await hashPasswordPbkdf2(pw));
      return;
    }
    case 'gen-secrets':
      console.log(`SESSION_SECRET=${crypto.randomBytes(32).toString('base64url')}`);
      console.log(`TOKEN_ENC_KEY=${crypto.randomBytes(32).toString('base64')}`);
      return;
    case 'workspaces': {
      const sub = a._[0] || 'list';
      if (sub === 'attribute') {
        const { runAttribution } = await import('../src/node/attribute.js');
        const cfg = getConfig();
        const out = await runAttribution({ dbFile: a.db ? String(a.db) : cfg.dbFile, owner: a.owner ? String(a.owner) : '', apply: !!a.apply, tokenEncKey: cfg.tokenEncKey });
        process.stdout.write(out.text);
        return;
      }
      const c = await core();
      print(await c.workspaces.list());
      return c.stop();
    }
    case 'keys': {
      const c0 = await core();
      const c = await cliScope(c0, a);
      const sub = a._[0];
      if (sub === 'create') {
        const k = await c.apiKeys.create({ name: a.name || 'agent', scopes: a.scopes ? String(a.scopes).split(',') : undefined, approval_mode: !a['no-approval'], rate_limit_per_min: a.rate ? Number(a.rate) : undefined });
        await c.audit.record({ principal: { type: 'cli', name: 'cli' }, via: 'cli', operation: 'create_api_key', target: k.id, detail: { name: k.name, scopes: k.scopes, approval_mode: k.approval_mode } });
        console.error(`Created key "${k.name}" scopes=${k.scopes.join(',')} approval_mode=${k.approval_mode}. Store it now; it is not shown again:`);
        console.log(k.key);
      } else if (sub === 'list') print(await c.apiKeys.list());
      else if (sub === 'revoke') { if (!(await c.apiKeys.revoke(a._[1]))) { console.error('Not found'); process.exitCode = 1; } else console.error('Revoked'); }
      else console.error(HELP);
      return c0.stop();
    }
    case 'apps': {
      const c0 = await core();
      const c = await cliScope(c0, a);
      const [sub, app] = a._;
      const audit = (operation, detail) => c.audit.record({ principal: { type: 'cli', name: 'cli' }, via: 'cli', operation, target: app, detail });
      const view = (s) => ({ app: s.app, status: s.status, client_id: s.client_id, secret: s.secret_hint ? `saved • ${s.secret_hint}` : null, redirect_uris: s.redirect_uris.map((u) => u.uri), last_test: s.last_test });
      try {
        if (sub === 'list' || !sub) print(c.apps.list().map(view));
        else if (sub === 'set') {
          if (!a.id) throw new Error('Usage: postlite apps set <meta|instagram|google> --id APP_ID   (the secret is read from a prompt or stdin)');
          const secret = await readSecret(`${app} app secret (leave empty to keep the saved one): `);
          print(view(await c.apps.set(app, { client_id: String(a.id), client_secret: secret || undefined })));
          await audit('set_platform_app', { app, client_id: String(a.id), client_secret: secret ? '[redacted]' : undefined });
        } else if (sub === 'clear') { print(view(await c.apps.clear(app))); await audit('clear_platform_app', { app }); }
        else if (sub === 'test') print(await c.apps.test(app));
        else console.error(HELP);
      } catch (e) { console.error(e.message); process.exitCode = 1; }
      return c.stop();
    }
    case 'mcp': {
      const key = process.env.POSTLITE_API_KEY;
      if (!key) { console.error('Set POSTLITE_API_KEY to an API key (postlite keys create --name "my agent").'); process.exit(1); }
      const { runStdio, runBridge } = await import('../src/node/mcp-stdio.js');
      if (process.env.POSTLITE_URL) return runBridge({ url: process.env.POSTLITE_URL, key });
      const c = await core();
      const principal = await c.apiKeys.authenticate(key);
      if (!principal) { console.error('Invalid or revoked POSTLITE_API_KEY'); process.exit(1); }
      const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
      await runStdio(c, principal, { version });
      return c.stop();
    }
    case 'tools': {
      const { operations } = await import('../src/api/operations.js');
      for (const o of operations) console.log(`${o.name.padEnd(26)} ${o.method.padEnd(6)} /api/v1${o.path.padEnd(42)} ${o.scope || '-'}  ${o.summary}`);
      return;
    }
    case 'call': {
      const name = a._[0];
      const input = { ...(a.json ? JSON.parse(a.json) : {}), ...coerceFlags(a) };
      return print(await callTool(name, input));
    }
    case 'accounts':
      return print(await callTool('list_accounts', coerceFlags(a)));
    case 'media': {
      if (a._[0] !== 'upload' || !a._[1]) throw new Error('Usage: postlite media upload <file>');
      const file = a._[1];
      const key = process.env.POSTLITE_API_KEY;
      if (!key) throw new Error('Set POSTLITE_API_KEY (or pass --key)');
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
      const { uploadFileRemote } = await import('../src/node/remote.js');
      const tty = process.stderr.isTTY;
      const j = await uploadFileRemote({ url: API_URL, key, file, filename: a.filename ? String(a.filename) : path.basename(file), onProgress: tty ? (p) => process.stderr.write(`\ruploading ${Math.round(p * 100)}%`) : null });
      if (tty) process.stderr.write('\n');
      return print(j);
    }
    case 'posts': {
      const sub = a._[0];
      const pid = a._[1];
      const f = coerceFlags(a);
      if (sub === 'list') return print(await callTool('list_posts', { ...f, ...(f.account ? { account_id: f.account } : {}), account: undefined }));
      if (sub === 'get') return print(await callTool('get_post', { post_id: pid }));
      if (sub === 'create') {
        const accounts = String(a.accounts || a.account || '').split(',').filter(Boolean);
        const settings = a.settings ? JSON.parse(a.settings) : undefined;
        return print(await callTool('create_post', {
          content: a.content ? String(a.content) : '',
          media_ids: a.media ? String(a.media).split(',') : [],
          targets: accounts.map((id) => ({ account_id: id, ...(settings ? { settings } : {}) })),
          mode: a.now ? 'now' : a['next-slot'] ? 'next_slot' : a.at ? 'schedule' : 'draft',
          ...(a.at ? { publish_at: String(a.at) } : {}),
        }));
      }
      if (sub === 'schedule') return print(await callTool('schedule_post', { post_id: pid, ...(a.at ? { publish_at: String(a.at) } : {}), ...(a['next-slot'] ? { next_slot: true } : {}) }));
      if (sub === 'reschedule') return print(await callTool('reschedule_post', { post_id: pid, publish_at: String(a.at) }));
      if (sub === 'now') return print(await callTool('publish_post_now', { post_id: pid }));
      if (sub === 'retry') return print(await callTool('retry_post', { post_id: pid }));
      if (sub === 'delete') return print(await callTool('delete_post', { post_id: pid }));
      if (sub === 'approve') return print(await callTool('approve_post', { post_id: pid }));
      if (sub === 'reject') return print(await callTool('reject_post', { post_id: pid, reason: a.reason ? String(a.reason) : '' }));
      if (sub === 'validate') return print(await callTool('validate_post', JSON.parse(a.json || '{}')));
      throw new Error('Unknown posts subcommand. See postlite help.');
    }
    case 'analytics': {
      const sub = a._[0] || 'overview';
      const extra = a.account ? { account_id: String(a.account) } : {};
      if (sub === 'overview') return print(await callTool('get_analytics_overview', { ...(a.from ? { from: String(a.from) } : {}), ...(a.to ? { to: String(a.to) } : {}) }));
      if (sub === 'top') return print(await callTool('get_top_posts', { ...extra, ...(a.sort ? { sort: String(a.sort) } : {}) }));
      if (sub === 'sync') return print(await callTool('sync_analytics', extra));
      if (sub === 'account') return print(await callTool('get_account_analytics', extra));
      throw new Error('Usage: postlite analytics overview|top|sync|account');
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    default:
      console.error(`Unknown command "${cmd}".\n`);
      process.stdout.write(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  if (e.json?.error?.details) console.error(JSON.stringify(e.json.error.details, null, 2));
  process.exit(1);
});
