# Contributing to postlite

Thanks for helping! postlite aims to stay **small**: one Node process, SQLite, no build step, no runtime dependencies.

## Ground rules
- Node ≥ 22.13 (built-in `node:sqlite`). No native addons, no Docker requirement, no CDN assets.
- Prefer the standard library. A new runtime dependency needs a strong reason in the PR description.
- Never call real Meta/Google APIs from tests. Extend `test/fake/server.js` instead.
- Don't copy code from other projects with incompatible licenses (e.g. AGPL). Behavioural references are fine; write your own implementation.
- No secrets, tokens, real account ids or personal data in commits, fixtures or screenshots.

## Dev setup
```sh
cp .env.example .env && node bin/postlite.js gen-secrets   # paste into .env
node bin/postlite.js set-password
npm test                                                   # all tests, ~10 s
# full local run against fake providers:
node test/fake/server.js --port 4199 > /tmp/fake.env       # prints *_URL overrides
set -a; . /tmp/fake.env; set +a; ALLOW_PRIVATE_MEDIA_URLS=1 node bin/postlite.js start
```
The fake consent screens auto-approve, so “Connect” buttons work locally.

## Layout
- `src/api/operations.js` — every API operation (REST + OpenAPI + MCP + CLI are generated from it)
- `src/providers/*` — platform integrations (publish state machine, OAuth, analytics, error classification)
- `src/scheduler.js` — job claiming, retries, crash recovery
- `src/shared/*` — validation + time helpers shared with the browser
- `public/` — the web UI (vanilla ES modules, no build step): `js/app.js` shell + hash router, `js/ui.js` shared components (page headers, tabs, menus, empty states, skeletons), `js/icons.js` inline SVG icons, `js/charts.js` SVG charts, `js/theme.js` pre-paint theme switch; `app.css` holds the design tokens (dark default, `[data-theme="light"]`); `fonts/` bundles Inter and JetBrains Mono (OFL). The CSP forbids inline `style="…"` attributes in HTML strings; set styles through `h(..., { style: {...} })` or `el.style`.

## Adding a platform
Implement the provider shape described in `src/providers/index.js`, register it, add rules to `src/shared/validate.js`, a settings schema in `src/api/operations.js`, fake endpoints, and tests for each post type + OAuth + error classification.

## Pull requests
- `npm test` must pass.
- Keep idle RSS low (check with `ps -o rss= -p <pid>`).
- Describe user-visible changes in the PR.
