# Contributing to postlite

Thanks for taking the time. postlite tries to stay small: no build step for the UI and no runtime dependencies. The same core runs on Node (one process, SQLite) and on Cloudflare Workers (D1, R2, Cron).

## Reporting bugs

Open an issue with what you did, what you expected and what happened. Say which build you run (Node or Workers) and which platform the post was for. Remove tokens, emails, page names and other personal data from logs and screenshots before you post them. Report security problems privately through GitHub's security advisory form instead of a public issue.

## Ground rules

- Node 22.13 or newer (built-in `node:sqlite`). No native addons, no Docker requirement, no CDN assets.
- Prefer the standard library. A new runtime dependency needs a strong reason in the pull request.
- Tests never call the real Meta, Google, X or LinkedIn APIs. Extend the fakes in `test/fake/server.js` and `test/fake/x-linkedin.js` instead.
- Code under `src/` (except `src/node/` and `src/workers/`) must stay runtime-agnostic: no `node:*` imports, `Buffer`, `process` or `fs`. Use WebCrypto, `Uint8Array`, `fetch`, `Request`/`Response` and the injected `db`, `storage` and `runtime`. The database interface is async (`get/all/run/batch`), and D1 allows at most 100 bound parameters per query.
- Every query on a tenant table filters by `workspace_id`. The tenant guard in `src/tenant.js` throws otherwise.
- New API capabilities are one entry in `src/api/operations.js`; REST, OpenAPI, MCP and the CLI are generated from it.
- Schema changes are new files in `migrations/NNNN_name.sql`. Never edit one that has shipped. They must run on both node:sqlite and D1.
- Long work on Workers must be resumable: check `budget.has(...)`, save state and return, and the next cron run continues.
- Don't copy code from projects with incompatible licenses (for example AGPL). Using them as a behavioural reference is fine; write your own implementation.
- No secrets, tokens, real account ids or personal data in commits, fixtures or screenshots. Use `example.com` addresses and made-up names.

## Development setup

```sh
cp .env.example .env && node bin/postlite.js gen-secrets   # paste the values into .env
node bin/postlite.js set-password
npm test                                                   # Node tests
npm install && npm run test:workers                        # Workers tests (workerd via wrangler, local D1 and R2)

# full local run against the fake providers:
node test/fake/server.js --port 4199 > /tmp/fake.env       # prints *_URL overrides
set -a; . /tmp/fake.env; set +a; ALLOW_PRIVATE_MEDIA_URLS=1 node bin/postlite.js start
```

The fake consent screens approve automatically, so the Connect buttons work locally.

## Layout

- `src/core.js` wires the portable core. `src/http/app.js` is the whole HTTP app as `Request → Response`.
- `src/node/*` is the Node adapter: node:sqlite and migrations, disk storage, the `node:http` bridge, ffmpeg, stdio MCP and CLI helpers.
- `src/workers/*` is the Workers adapter: the entry point (`fetch` and `scheduled`), D1 and R2. See also `wrangler.jsonc` and `scripts/cf-assets.mjs`, which copies the UI into the static assets directory and computes the asset hashes.
- `migrations/*.sql` holds the schema for both runtimes.
- `src/api/operations.js` defines every API operation.
- `src/providers/*` contains the platform integrations: publish state machine, OAuth, analytics and error classification.
- `src/scheduler.js` handles job claiming, retries and crash recovery.
- `src/shared/*` has validation and time helpers shared with the browser.
- `public/` is the web UI: plain ES modules, no build step. `js/app.js` is the shell and router, `js/ui.js` the shared components, and `app.css` the design tokens. The CSP forbids inline `style="…"` attributes in HTML strings; set styles with `h(..., { style: {...} })` or `el.style`.
- `test/` holds the Node tests and fakes; `test-workers/` the Workers end-to-end tests and CPU benchmark.

## Adding a platform

Implement the provider shape described in `src/providers/index.js` and register it. Add rules to `src/shared/validate.js`, a settings schema in `src/api/operations.js`, fake endpoints, and tests for each post type, the OAuth flow and error classification. Add a setup guide under `docs/setup/`.

## Pull requests

- `npm test` and `npm run test:workers` pass.
- Idle memory stays low (check with `ps -o rss= -p <pid>`).
- UI changes include a desktop and a 390 px mobile screenshot taken with demo data.
- User-visible changes are described in the pull request.

By contributing you agree that your work is released under the [MIT license](LICENSE).
