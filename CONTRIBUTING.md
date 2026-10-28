# Contributing to postlite

Thanks for helping! postlite aims to stay **small**: no build step for the UI, no runtime dependencies. It runs on Node (one process, SQLite) and on Cloudflare Workers (D1, R2, Cron) from the same core.

## Ground rules
- Node ≥ 22.13 (built-in `node:sqlite`). No native addons, no Docker requirement, no CDN assets.
- Prefer the standard library. A new runtime dependency needs a strong reason in the PR description.
- Never call real Meta/Google APIs from tests. Extend `test/fake/server.js` instead.
- Code under `src/` (except `src/node/`) must stay **runtime-agnostic**. No `node:*` imports, `Buffer`, `process` or `fs` there; use WebCrypto, `Uint8Array`, `fetch`, `Request`/`Response` and the injected `db` / `storage` / `runtime`. The DB interface is async (`get/all/run/batch`), and D1 allows at most 100 bound parameters per query.
- Schema changes are new files in `migrations/NNNN_name.sql`. Never edit an applied one. They must run on both node:sqlite and D1.
- Long work on Workers must be resumable between steps: check `budget.has(...)`, persist state and return; the next cron tick continues.
- Don't copy code from other projects with incompatible licenses (e.g. AGPL). Behavioural references are fine; write your own implementation.
- No secrets, tokens, real account ids or personal data in commits, fixtures or screenshots.

## Dev setup
```sh
cp .env.example .env && node bin/postlite.js gen-secrets   # paste into .env
node bin/postlite.js set-password
npm test                                                   # Node tests
npm install && npm run test:workers                        # Workers tests (workerd via wrangler, local D1/R2)
# full local run against fake providers:
node test/fake/server.js --port 4199 > /tmp/fake.env       # prints *_URL overrides
set -a; . /tmp/fake.env; set +a; ALLOW_PRIVATE_MEDIA_URLS=1 node bin/postlite.js start
```
The fake consent screens auto-approve, so “Connect” buttons work locally.

## Layout
- `src/core.js` — wires the portable core; `src/http/app.js` — the whole HTTP app as `Request → Response`
- `src/node/*` — Node adapter: node:sqlite DB + migrator, disk storage, `node:http` bridge, ffmpeg, stdio MCP, CLI helpers
- `src/workers/*` — Workers adapter: entry (`fetch` + `scheduled`), D1, R2; `wrangler.jsonc`; `scripts/cf-assets.mjs` copies the UI into the static-assets dir and computes the app-shell hash
- `migrations/*.sql` — schema for both runtimes
- `test-workers/` — Workers end-to-end tests + CPU bench
- `src/api/operations.js` — every API operation (REST + OpenAPI + MCP + CLI are generated from it)
- `src/providers/*` — platform integrations (publish state machine, OAuth, analytics, error classification)
- `src/scheduler.js` — job claiming, retries, crash recovery
- `src/shared/*` — validation + time helpers shared with the browser
- `public/` — the web UI (vanilla ES modules, no build step): `js/app.js` shell + hash router, `js/ui.js` shared components (page headers, tabs, menus, empty states, skeletons), `js/icons.js` inline SVG icons, `js/charts.js` SVG charts, `js/theme.js` pre-paint theme switch; `app.css` holds the design tokens (dark default, `[data-theme="light"]`); `fonts/` bundles Inter and JetBrains Mono (OFL). The CSP forbids inline `style="…"` attributes in HTML strings; set styles through `h(..., { style: {...} })` or `el.style`.

## Adding a platform
Implement the provider shape described in `src/providers/index.js`, register it, add rules to `src/shared/validate.js`, a settings schema in `src/api/operations.js`, fake endpoints, and tests for each post type + OAuth + error classification.

## Pull requests
- `npm test` and `npm run test:workers` must pass.
- Keep idle RSS low (check with `ps -o rss= -p <pid>`).
- Describe user-visible changes in the PR.
