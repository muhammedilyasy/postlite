# postlite

**A lightweight, self-hosted social media scheduler for YouTube, Instagram and Facebook Pages.**
Runs as **one Node.js process** (one SQLite file, zero runtime dependencies, no Docker) **or entirely on Cloudflare's free plan** (Workers + D1 + R2 + Cron). Agent-first: everything the web UI does is available through a REST API, an MCP server and a CLI, so you can run your socials from Claude, ChatGPT, Cursor, Hermes or a shell script.

| Dashboard (week) | Posts | Post events |
|---|---|---|
| ![Dashboard with week calendar](docs/screenshots/desktop-dashboard-week.png) | ![Posts list](docs/screenshots/desktop-posts.png) | ![Publish event timeline](docs/screenshots/desktop-post-events.png) |
| **Composer** | **Analytics** | **Mobile** |
| ![Composer with previews](docs/screenshots/desktop-composer.png) | ![Account analytics](docs/screenshots/desktop-analytics-account.png) | ![Mobile dashboard](docs/screenshots/mobile-dashboard.png) |

More in [`docs/screenshots/`](docs/screenshots/) (dark and light theme, desktop and 390 px mobile).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/muhammedilyasy/postlite)

<!-- The Deploy button only works once the repository is public. -->

## Features

- **Platforms**
  - **YouTube** — Google OAuth (offline access + automatic token refresh), resumable chunked uploads that survive restarts, title/description/tags/category/privacy/made-for-kids/notify-subscribers, custom thumbnails, Shorts validation (vertical/square, ≤ 3 min).
  - **Facebook Pages** — Facebook Login with long-lived token exchange and page tokens; text, link, single/multi-photo, video, Reels and Stories; optional first comment.
  - **Instagram** — both *Instagram via Facebook Page* (Facebook Login) and *Instagram API with Instagram Login* (standalone). Image posts, Reels, carousels (2–10 mixed items), Stories, collaborators, Trial Reels, first comment. Container → status polling → `media_publish`, with Meta's limits validated up front (JPEG only, 4:5–1.91:1, caption/hashtag/mention limits…).
- **Scheduler** — in-process, restart-safe, never double-posts (atomic job claiming, persisted publish phases, crash recovery that asks the platform whether a post went live), retries with exponential backoff, clear transient/permanent/auth error classification, missed-post grace window.
- **Web UI** — a developer-console style dashboard: dark by default with an optional light theme, left sidebar, breadcrumbs, a **New** menu, and an account menu. It has a calendar (week / month / list) with drag-and-drop rescheduling, a posts table with status dots and filters, and post detail pages with tabs (overview, publish-attempt event timeline, metrics). The composer has one global caption plus per-account overrides, per-platform settings, drag-and-drop media upload with progress, live validation and previews. There's also an approvals inbox, analytics charts, and settings for API keys, webhooks, the audit log and platform apps. Other details: toasts, skeleton loaders, visible keyboard focus, a mobile drawer, and Inter + JetBrains Mono bundled locally (OFL). No build step, no CDN.
- **Analytics** — periodic sync (default every 6 h) + manual refresh: followers/subscribers over time, views/reach/engagement/profile views, YouTube watch time and average view duration, per-post views/likes/comments/shares/saves/reach, for posts published through postlite *and* recent posts fetched from the accounts. Deprecated metrics and missing permissions show up as "not available" instead of failing. Inline SVG charts, top-posts table, CSV export.
- **Agent-first API** — versioned REST API (`/api/v1`, OpenAPI 3.1 at `/api/v1/openapi.json`), built-in MCP server (stdio + Streamable HTTP at `/mcp`), CLI. Scoped API keys (read / write / publish / analytics / admin), hashed at rest, per-key rate limits, audit log, and **approval mode** (default on) so agent-created posts wait for a human.
- **Webhooks** — `post.published`, `post.failed`, `post.pending_approval`, `account.needs_reconnect`, `analytics.synced`, HMAC-SHA256 signed, retried with backoff.
- **Security** — single admin password (scrypt), or **Cloudflare Zero Trust Access** (email one-time PIN; postlite verifies the RS256 JWT itself and enforces its own `ALLOWED_EMAILS`, see [the guide](docs/setup/cloudflare-access.md)), HttpOnly/SameSite session cookies, CSRF tokens + Origin checks, OAuth `state` + PKCE (Google), OAuth tokens encrypted at rest (AES-256-GCM), unguessable 256-bit media URLs, strict CSP, SSRF guard for media-from-URL.

## Resource usage

Measured on a Linux server with Node 26 (RSS from `ps`), publishing to the bundled fake providers:

| State | RSS |
|---|---|
| Idle after boot | ~68 MB |
| Peak while publishing a 22 MB YouTube Short + FB/IG posts | ~105 MB |
| After uploads, publishing and an analytics sync | ~104 MB |

No Redis, no Postgres, no Temporal, no Elasticsearch, no Docker.

## Two ways to run it

| | **Node** (VPS, home server) | **Cloudflare Workers** (Free plan) |
| --- | --- | --- |
| Setup | `node bin/postlite.js start` behind HTTPS | `npm run cf:deploy` or the Deploy button. [Guide](docs/setup/cloudflare-workers.md) |
| Database | `node:sqlite` file | D1 (same SQL migrations) |
| Media | `data/uploads/`, served at `/m/<token>` | R2, streamed by the Worker at `/m/<token>` |
| Big uploads | Raw streaming POST, or resumable multipart | Resumable multipart (≤ 100 MB per part through the Worker, or presigned direct-to-R2) |
| Scheduler | In-process, 15 s tick | Cron Trigger every minute, resumable steps within the free CPU and subrequest limits |
| Publish latency | 0–15 s | 0–60 s |
| UI, REST, OpenAPI, MCP over HTTP, webhooks, analytics, approval mode, audit log | ✓ | ✓ (identical) |
| Sign-in | Password (scrypt) or Cloudflare Access | Cloudflare Access (recommended) or password (PBKDF2) |
| MCP stdio, local CLI | ✓ | Through a local `postlite` pointed at the Worker (`--url/--key`) |
| Video posters (ffmpeg) | Optional | — (`<video>` preview fallback) |
| Cost | Your server | $0 on Workers Free + D1 Free + R2 free tier (10 GB) |

Both are built from the same runtime-agnostic core (`src/`) with thin adapters (`src/node/`, `src/workers/`).

## Quick start (no Docker)

Requirements: **Node.js ≥ 22.13** (uses the built-in `node:sqlite`). Nothing else.

```sh
git clone <your fork url> postlite && cd postlite
cp .env.example .env
node bin/postlite.js gen-secrets          # paste SESSION_SECRET and TOKEN_ENC_KEY into .env
$EDITOR .env                              # PUBLIC_URL (+ optional app credentials; or paste them in Settings → Platform apps)
node bin/postlite.js set-password         # admin password for the web UI (or use Cloudflare Access, below)
node bin/postlite.js start                # http://127.0.0.1:4100
```

There is no `npm install` step (no dependencies). Put it behind HTTPS (below) — Meta only fetches media from public HTTPS URLs and Instagram requires HTTPS redirect URIs.

### Run as a service

```sh
mkdir -p ~/.config/systemd/user && cp deploy/postlite.service ~/.config/systemd/user/
# adjust WorkingDirectory/EnvironmentFile if the checkout is not at ~/apps/postlite
systemctl --user daemon-reload && systemctl --user enable --now postlite
loginctl enable-linger "$USER"
```

### Reverse proxy

`deploy/Caddyfile` (automatic HTTPS) or `deploy/nginx.conf`. Both raise the upload size limit and disable buffering for uploads and MCP. postlite itself listens on `127.0.0.1` only.

### Sign-in with Cloudflare Zero Trust Access (optional)

Instead of the admin password, you can put the UI behind Cloudflare Access (free plan, email one-time PIN) and allow only specific
addresses. postlite validates the Access JWT on every request (signature, `aud`, `iss`, `exp`/`nbf`) and checks `ALLOWED_EMAILS`. It
refuses to start if access mode is half-configured. `/m/*`, `/api/v1/*`, `/mcp` and `/healthz` stay reachable for platforms
and agents through Access *Bypass* rules, and postlite still protects them with media tokens and API keys.

```sh
AUTH_MODE=cloudflare-access
CF_ACCESS_TEAM_DOMAIN=myteam.cloudflareaccess.com
CF_ACCESS_AUD=<Application Audience (AUD) tag>
ALLOWED_EMAILS=you@example.com,partner@example.com
```

The click-by-click dashboard guide is in [docs/setup/cloudflare-access.md](docs/setup/cloudflare-access.md).

### Run on Cloudflare instead

```sh
npm install && npx wrangler login
npx wrangler r2 bucket create postlite-media
npm run cf:deploy                                           # deploy + D1 migrations
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENC_KEY
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
```

Then add a custom domain, the Access app and its Bypass paths, and your platform apps. The step-by-step guide covers all of it, with the free-plan limits cited: [docs/setup/cloudflare-workers.md](docs/setup/cloudflare-workers.md).

### Backups

Everything lives in `data/`: `data/postlite.sqlite` + `data/uploads/`. Run `deploy/backup.sh /path/to/backups` (consistent snapshot via `VACUUM INTO`, safe while running) or stop the service and copy `data/`. Keep `TOKEN_ENC_KEY` with your backups — stored OAuth tokens are encrypted with it.

## Platform setup

postlite publishes through **your own developer apps**. Create each app once, then paste its ID and secret into
**Settings → Platform apps** in the web UI. Secrets are encrypted with `TOKEN_ENC_KEY`, never shown again (only
`saved • …last4`), and take effect immediately with no restart. Each card shows the exact redirect URI(s) for
your `PUBLIC_URL` with copy buttons, the scopes, products and APIs to enable, a checklist and a **Test** button.
If a platform isn't configured, its **Connect** button on the Accounts page links to that card.

**Step-by-step guides** (checked against the official Meta and Google docs on 2026-10-28; also served by your instance at `/docs/setup/`):

- [Setup index + 10-minute quickstart](docs/setup/README.md)
- [Facebook Pages + Instagram via Facebook Login (Meta app)](docs/setup/facebook-and-instagram.md)
- [Instagram without a Facebook Page (Instagram Login)](docs/setup/instagram-standalone.md)
- [YouTube (Google Cloud project + OAuth client)](docs/setup/youtube.md)
- [Sign-in with Cloudflare Zero Trust Access (email one-time PIN)](docs/setup/cloudflare-access.md)
- [Run on Cloudflare Workers (Free plan): D1, R2, Cron, Access](docs/setup/cloudflare-workers.md)

Redirect URIs are always `PUBLIC_URL/oauth/<provider>/callback`:

| App | Redirect URI(s) | Credentials |
| --- | --- | --- |
| Meta | `…/oauth/facebook/callback`, `…/oauth/instagram/callback` | App ID / App Secret |
| Instagram Login | `…/oauth/instagram-standalone/callback` | Instagram app ID / secret (not the Meta App ID) |
| Google | `…/oauth/youtube/callback` | OAuth Client ID / secret (Web application) |

**`.env` fallback.** You can still set `META_APP_ID`/`META_APP_SECRET`, `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET` and
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in `.env`. Values saved in the UI override them; **Clear** returns to `.env`.
Admin API keys can manage credentials with `list_platform_apps`, `set_platform_app`, `clear_platform_app` and `test_platform_app`
(REST `/api/v1/platform-apps`, MCP, CLI `call`). On the server, use `node bin/postlite.js apps set google --id …`; it reads the secret from
a prompt or stdin. Approval-mode keys can't change credentials, and the audit log records changes with the secret redacted.

Key gotchas (details in the guides):

- **Meta:** in *Use cases → Customize*, add every optional permission postlite requests, or the login dialog shows "Invalid Scopes".
  Development mode is enough for accounts whose owners have a role on the app. App Review + Business Verification is needed only
  when people without a role connect.
- **Instagram:** the account must be Business/Creator; for the Facebook Login variant it must be linked to a Page you manage.
- **Google:** in *Testing* status refresh tokens expire after 7 days. For personal use, publish the app (*In production*) and click through the
  unverified-app screen. Uploads use their own `videos.insert` bucket (default 100/day); other calls share 10,000 units/day.
  Google's current `videos.insert` reference says uploads from unverified projects are no longer locked to private. If yours are, request the
  [API audit](https://support.google.com/youtube/contact/yt_api_form).

## Using it from AI agents

- REST: `https://social.example.com/api/v1/...` — `GET /api/v1/openapi.json` (no auth) for the full spec.
- MCP: `https://social.example.com/mcp` with `Authorization: Bearer <key>` (Streamable HTTP), or `node bin/postlite.js mcp` (stdio; with `POSTLITE_URL` set it bridges to a remote server and lets the agent upload local files).
- CLI: `POSTLITE_URL=… POSTLITE_API_KEY=… node bin/postlite.js posts create --content "Hi" --accounts <id> --next-slot` (or `--url … --key …`). This works against Node and Workers instances. `media upload` uses resumable multipart sessions.
- Docs for agents: [`docs/agent-guide.md`](docs/agent-guide.md) (served at `/AGENTS.md` and `/api/v1/agent-guide.md`) and `/llms.txt` (also `/api/v1/llms.txt`, which stays public behind Cloudflare Access). Client configs: [`examples/agents/`](examples/agents/).

Create keys in **Settings → API keys** or `node bin/postlite.js keys create --name "Claude"`. New keys default to **approval mode**.

## How publishing works

Each post target becomes a job. The scheduler (Node: in-process tick every 15 s; Workers: a Cron Trigger every minute) claims due jobs with an atomic conditional `UPDATE … RETURNING`, then walks a provider state machine — `start → check (poll) → finalize` — persisting each phase result before the next platform call. Irreversible calls (Facebook feed/reel/story publish, Instagram `media_publish`) are marked *in flight* first; if the process dies mid-call, recovery asks the platform (Instagram container status, YouTube upload-session probe) and only fails with "check before retrying" when the platform cannot tell (Facebook). Transient errors (429/5xx/rate limits) retry with exponential backoff (3 attempts by default); permanent errors fail immediately with a readable message; expired/revoked tokens trigger a refresh (YouTube, Instagram Login) or mark the account *needs reconnect*. On boot, overdue posts within `MISSED_GRACE_MINUTES` (default 6 h) publish; older ones are marked *missed* so nothing surprises you days later.

## Development

```sh
npm test                 # Node: node:test unit + integration against local fake Meta/Google servers
npm install              # dev dependency for the Workers path only (wrangler)
npm run test:workers     # Workers: the real Worker in workerd (wrangler dev) with local D1 + R2, cron-driven, same fakes
CPU_BENCH=1 npm run test:workers   # same scenario, prints the Worker's CPU time per invocation
node test/fake/server.js --port 4199    # run the fake providers for manual testing (prints env overrides)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Known limitations

- Real Meta/Google APIs are **not** exercised by the test suite (fake servers only). Verify with your own app credentials before relying on it.
- Facebook *Login for Business* configurations (`config_id`) are not used; postlite uses the classic `scope` dialog like Postiz.
- Instagram accepts only JPEG images via the API; postlite validates instead of converting.
- Video posters in the UI need `FFMPEG_PATH`; without it, and always on Workers, a `<video>` preview is shown.
- On Workers, posts publish up to ~60 s after their time (1-minute cron), and API-key rate limits are best-effort (per isolate). See the [Workers caveats](docs/setup/cloudflare-workers.md#caveats).
- Single admin role; with Cloudflare Access several allowed emails share it (no per-user permissions, no multi-tenant).
- MCP over HTTP returns JSON responses (no server-initiated SSE stream).

## NOTICE

postlite is an independent, clean-room implementation. Its platform behaviour (endpoints, parameters, OAuth scopes, Graph API version, error handling, token refresh and publish flows) was modelled on the public integrations of [Postiz](https://github.com/gitroomhq/postiz-app) (AGPL-3.0) and on the official Meta Graph API / Instagram Platform and Google YouTube Data & Analytics API documentation. No Postiz source code is included. The MCP tool surface took high-level inspiration from TryPost's tool list; no code was copied. postlite is not affiliated with Meta, Google, Postiz or TryPost.

## License

[MIT](LICENSE)
