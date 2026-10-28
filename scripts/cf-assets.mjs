#!/usr/bin/env node
// Assemble the Workers static-assets directory (.cf-assets/) from the repo. This is a plain file COPY,
// not a UI build: the UI stays vanilla JS with no build step. Wrangler runs it automatically before
// `wrangler dev` / `wrangler deploy` (wrangler.jsonc → build.command).
//
//   .cf-assets/assets/**            ← public/** (served directly by Cloudflare, free, never hits the Worker)
//   .cf-assets/assets/shared/*.js   ← src/shared/*.js (validation + time helpers shared with the server)
//   .cf-assets/_internal/**         ← index.html, login.html, docs (read by the Worker via the ASSETS binding)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.cf-assets');
const INTERNAL_HTML = new Set(['index.html', 'login.html']);

function copyDir(src, dest, filter = () => true) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (filter(s)) fs.copyFileSync(s, d);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
const pub = path.join(ROOT, 'public');
copyDir(pub, path.join(OUT, 'assets'), (f) => !(path.dirname(f) === pub && INTERNAL_HTML.has(path.basename(f))));
copyDir(path.join(ROOT, 'src', 'shared'), path.join(OUT, 'assets', 'shared'), (f) => f.endsWith('.js'));
fs.mkdirSync(path.join(OUT, '_internal', 'docs', 'setup'), { recursive: true });
for (const f of INTERNAL_HTML) fs.copyFileSync(path.join(pub, f), path.join(OUT, '_internal', f));
for (const f of ['llms.txt', 'agent-guide.md']) fs.copyFileSync(path.join(ROOT, 'docs', f), path.join(OUT, '_internal', 'docs', f));
const guides = fs.readdirSync(path.join(ROOT, 'docs', 'setup')).filter((f) => f.endsWith('.md')).sort();
for (const f of guides) fs.copyFileSync(path.join(ROOT, 'docs', 'setup', f), path.join(OUT, '_internal', 'docs', 'setup', f));
fs.writeFileSync(path.join(OUT, '_internal', 'manifest.json'), JSON.stringify({ 'docs/setup': guides }));
// Same security headers the Node server sends for /assets/* (Workers static assets `_headers` file).
fs.writeFileSync(path.join(OUT, '_headers'), [
  '/assets/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: same-origin',
  '  X-Frame-Options: DENY',
  '/assets/fonts/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
].join('\n'));
let n = 0;
(function count(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? count(path.join(d, e.name)) : n++; })(OUT);
console.log(`cf-assets: ${n} files → ${path.relative(ROOT, OUT)}/`);
