#!/usr/bin/env node
// postlite CLI: server, admin tasks, MCP stdio, and an HTTP client mirroring the API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadDotEnv, getConfig, ROOT } from '../src/config.js';

loadDotEnv();
const [, , cmd, ...rest] = process.argv;

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
  postlite keys create --name NAME [--scopes read,write,publish,analytics,admin] [--no-approval] [--rate 120]
  postlite keys list | postlite keys revoke <id>
  postlite apps list | apps set <meta|instagram|google> --id ID   (secret: prompt or stdin)
  postlite apps clear <app> | apps test <app>   Platform developer-app credentials (Settings → Platform apps)
  postlite mcp                           MCP over stdio (needs POSTLITE_API_KEY; with POSTLITE_URL it bridges to a remote server)

API client (needs POSTLITE_API_KEY, optional POSTLITE_URL, default http://127.0.0.1:4100):
  postlite tools                         List all operations / MCP tools
  postlite call <tool> [--json '{...}'] [--field value ...]
  postlite accounts list
  postlite media upload <file>
  postlite posts list [--status scheduled] [--from 2026-11-01 --to 2026-11-08]
  postlite posts create --content "text" --accounts id1,id2 [--media m1,m2] [--at "2026-11-02T18:00" | --next-slot | --now] [--settings '{"title":"..."}']
  postlite posts schedule <post_id> --at TIME | --next-slot
  postlite posts now <post_id>       postlite posts retry <post_id>      postlite posts delete <post_id>
  postlite posts approve <post_id>   postlite posts reject <post_id> --reason "..."
  postlite analytics overview|top|sync [--account ID]
`;

async function core() {
  const { createCore, makeLogger } = await import('../src/core.js');
  return createCore(getConfig(), { log: makeLogger(process.env.LOG_LEVEL || 'warn') });
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
      const pw = a.password ? String(a.password) : await readSecret('New admin password: ');
      if (!pw || pw.length < 10) { console.error('Password must be at least 10 characters.'); process.exit(1); }
      const c = await core();
      const { hashPassword } = await import('../src/crypto.js');
      c.db.setSetting('admin_password', hashPassword(pw));
      c.db.run('DELETE FROM sessions');
      console.error('Admin password updated (all sessions logged out).');
      return c.stop();
    }
    case 'gen-secrets':
      console.log(`SESSION_SECRET=${crypto.randomBytes(32).toString('base64url')}`);
      console.log(`TOKEN_ENC_KEY=${crypto.randomBytes(32).toString('base64')}`);
      return;
    case 'keys': {
      const c = await core();
      const sub = a._[0];
      if (sub === 'create') {
        const k = c.apiKeys.create({ name: a.name || 'agent', scopes: a.scopes ? String(a.scopes).split(',') : undefined, approval_mode: !a['no-approval'], rate_limit_per_min: a.rate ? Number(a.rate) : undefined });
        c.audit.record({ principal: { type: 'cli', name: 'cli' }, via: 'cli', operation: 'create_api_key', target: k.id, detail: { name: k.name, scopes: k.scopes, approval_mode: k.approval_mode } });
        console.error(`Created key "${k.name}" scopes=${k.scopes.join(',')} approval_mode=${k.approval_mode}. Store it now; it is not shown again:`);
        console.log(k.key);
      } else if (sub === 'list') print(c.apiKeys.list());
      else if (sub === 'revoke') { if (!c.apiKeys.revoke(a._[1])) { console.error('Not found'); process.exitCode = 1; } else console.error('Revoked'); }
      else console.error(HELP);
      return c.stop();
    }
    case 'apps': {
      const c = await core();
      const [sub, app] = a._;
      const audit = (operation, detail) => c.audit.record({ principal: { type: 'cli', name: 'cli' }, via: 'cli', operation, target: app, detail });
      const view = (s) => ({ app: s.app, status: s.status, client_id: s.client_id, secret: s.secret_hint ? `saved • ${s.secret_hint}` : null, redirect_uris: s.redirect_uris.map((u) => u.uri), last_test: s.last_test });
      try {
        if (sub === 'list' || !sub) print(c.apps.list().map(view));
        else if (sub === 'set') {
          if (!a.id) throw new Error('Usage: postlite apps set <meta|instagram|google> --id APP_ID   (the secret is read from a prompt or stdin)');
          const secret = await readSecret(`${app} app secret (leave empty to keep the saved one): `);
          print(view(c.apps.set(app, { client_id: String(a.id), client_secret: secret || undefined })));
          audit('set_platform_app', { app, client_id: String(a.id), client_secret: secret ? '[redacted]' : undefined });
        } else if (sub === 'clear') { print(view(c.apps.clear(app))); audit('clear_platform_app', { app }); }
        else if (sub === 'test') print(await c.apps.test(app));
        else console.error(HELP);
      } catch (e) { console.error(e.message); process.exitCode = 1; }
      return c.stop();
    }
    case 'mcp': {
      const key = process.env.POSTLITE_API_KEY;
      if (!key) { console.error('Set POSTLITE_API_KEY to an API key (postlite keys create --name "my agent").'); process.exit(1); }
      const { runStdio, runBridge } = await import('../src/mcp.js');
      if (process.env.POSTLITE_URL) return runBridge({ url: process.env.POSTLITE_URL, key });
      const c = await core();
      const principal = c.apiKeys.authenticate(key);
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
      if (!key) throw new Error('Set POSTLITE_API_KEY');
      const res = await fetch(`${API_URL}/api/v1/media?filename=${encodeURIComponent(path.basename(file))}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream' }, body: fs.createReadStream(file), duplex: 'half' });
      const j = await res.json();
      if (!res.ok) throw Object.assign(new Error(j.error?.message || res.status), { json: j });
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
