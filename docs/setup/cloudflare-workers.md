# postlite on Cloudflare Workers (Free plan)

postlite runs in two ways from the same code:

- **Node**: one process with SQLite on disk and media in `data/uploads`. This is the original setup, described in the main README.
- **Cloudflare Workers**: a Worker, with a **D1** database, an **R2** bucket for media, **static assets** for the UI, and a **Cron Trigger** that runs every minute and drives the scheduler.

This guide covers the Workers setup. Everything here fits Cloudflare's **free** plans: Workers Free, D1 Free, R2 free tier and Zero Trust Free. R2 asks for a payment method even on its free tier.

> Limits below were checked on developers.cloudflare.com on 2026-10-28 and are linked inline. Cloudflare changes them now and then, so re-check before relying on an edge case.

## How it maps to Cloudflare

| postlite piece | Node | Cloudflare Workers |
| --- | --- | --- |
| Database | `node:sqlite` file | D1 (SQLite). Same SQL migrations (`migrations/*.sql`) |
| Media files | `data/uploads/` | R2 bucket (binding `MEDIA`) |
| Media URL for Meta/Google | `PUBLIC_URL/m/<token>/<file>` | Same URL, served by the Worker, which streams from R2 with HTTP Range support |
| Big uploads | Streamed to disk, or resumable multipart sessions | Resumable multipart sessions: each part is ≤ 100 MB and goes through the Worker into R2, or **directly to R2** with presigned URLs |
| Scheduler | In-process loop every 15 s | Cron Trigger every minute, running small resumable steps |
| Webhooks and analytics sync | Background timers | The same cron, in bounded chunks |
| UI | Served from `public/` | Workers static assets. `/assets/*` never wakes the Worker |
| App shell | Content-hashed `?v=<hash>` URLs, import map, modulepreload | Same. The hash is computed at build time (`scripts/cf-assets.mjs`) and the files live under immutable `/assets/v/<hash>/` |
| Crypto | WebCrypto (AES-256-GCM, HMAC, SHA-256, RS256) | WebCrypto (same code) |
| Auth | Password (scrypt) or Cloudflare Access | **Cloudflare Access (recommended)** or password (PBKDF2) |
| Video posters (ffmpeg) | Optional (`FFMPEG_PATH`) | Not available. The UI shows a `<video>` preview instead |
| MCP | Streamable HTTP `/mcp` plus stdio | Streamable HTTP `/mcp`. For stdio, run `postlite mcp` locally with `POSTLITE_URL` (it bridges) |
| CLI | Local or remote | Remote only: `postlite --url https://… --key pl_… <command>` |

## Free-plan fit

| Resource | Free limit | What postlite uses |
| --- | --- | --- |
| Worker requests | 100,000 per day ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)) | UI and API calls, plus 1,440 cron runs per day, plus a few `/m/` fetches per post. Static assets don't count: "Requests to static assets are free and unlimited" |
| CPU time | **10 ms** per HTTP request and per Cron Trigger. Each isolate has "some built-in flexibility" for occasional overruns ([limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)) | Measured below. Waiting on `fetch`, D1 or R2 does not count |
| Memory | 128 MB per isolate ([limits](https://developers.cloudflare.com/workers/platform/limits/#memory)) | Media is streamed and never buffered whole, except one R2 part (≤ 10 MiB) when the length is unknown |
| Subrequests | 50 external `fetch()` calls per invocation ([limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)) | A per-invocation budget (`CF_SUBREQUEST_BUDGET`, default 45) stops long work between steps. The next cron tick resumes it |
| D1 queries | 50 per invocation on Free ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)) | Budgeted the same way (`CF_D1_QUERY_BUDGET`, default 45). Reads are batched |
| Request body | 100 MB on the Free plan ([limits](https://developers.cloudflare.com/workers/platform/limits/#request-limits)) | Upload parts default to 50 MB. Presigned uploads bypass the Worker completely |
| Cron Triggers | 5 per account ([limits](https://developers.cloudflare.com/workers/platform/limits/)) | 1 (`* * * * *`). Changes can take up to 15 minutes to propagate ([cron docs](https://developers.cloudflare.com/workers/configuration/cron-triggers/)) |
| D1 storage and rows | 10 databases, 500 MB each, 5 GB per account. 100 bound parameters per query. 5 M rows read and 100 k rows written per day ([limits](https://developers.cloudflare.com/d1/platform/limits/), [pricing](https://developers.cloudflare.com/d1/platform/pricing/)) | 1 database, typically a few MB. Batched reads use at most 90 parameters per query. An idle cron tick writes nothing |
| R2 | 10 GB-month storage, 1 M Class A and 10 M Class B operations per month, free egress ([pricing](https://developers.cloudflare.com/r2/pricing/)). Multipart: up to 10,000 parts, up to 5 GiB per part ([limits](https://developers.cloudflare.com/r2/platform/limits/)) | Media only. Delete old media in the UI to stay under 10 GB |
| Static assets | 20,000 files, 25 MiB per file ([limits](https://developers.cloudflare.com/workers/platform/limits/)) | About 100 files |
| Zero Trust Access | Free for up to 50 users | 1 Access app plus 1 Bypass app |

**Why D1 plus Cron, and not Durable Objects, Queues or Workflows?** All three are available on Workers Free:

- [SQLite-backed Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/): 100,000 requests and 13,000 GB-s per day.
- [Queues](https://developers.cloudflare.com/queues/platform/pricing/): 10,000 operations per day, with 24 h retention.
- [Workflows](https://developers.cloudflare.com/workflows/reference/pricing/): 3,000 steps per day, 10 ms CPU per invocation, and 3 days of state retention.

postlite doesn't need any of them. Its publish pipeline is already a persisted state machine, `start → check (poll) → finalize`, with atomic claims. A D1 table plus a one-minute cron covers it with fewer moving parts and fewer quotas to hit. It also keeps the code identical to Node.

### What needs Workers Paid ($5/month)

Nothing is required. Workers Paid helps in a few cases:

- **Very heavy single requests.** Examples: rendering the long setup guides, an analytics CSV export with thousands of rows, or a base64 upload close to the 8 MB cap. The Free plan's built-in flexibility usually absorbs occasional spikes. On Paid the limit is 30 s by default.
- **More than about 100 k requests per day**, for example a busy agent polling the API.
- **Faster large YouTube uploads.** Each cron run pushes up to `YOUTUBE_MAX_BYTES_PER_STEP` (512 MB) in 64 MB chunks.

If you upgrade, raise `CF_SUBREQUEST_BUDGET` and `CF_D1_QUERY_BUDGET`. Nothing else changes.

### Measured CPU time

`npm run test:workers` runs the real Worker bundle in workerd (`wrangler dev`). `CPU_BENCH=1 npm run test:workers` runs the same end-to-end scenario with the same Worker entry in a Node worker thread and measures the Worker's own CPU per invocation. That number excludes time inside D1/R2 shims and network I/O, as Cloudflare's CPU-time definition does. Results on a Linux server, with cold JIT (upper bounds):

| Invocation | median | max |
| --- | --- | --- |
| Cron tick (publish / webhook / analytics step) | ~3 ms | ~11 ms, plus one ~120 ms outlier (see below) |
| `GET /m/<token>` (Meta/Google fetching media) | ~1 ms | ~1 ms |
| REST/MCP calls (create post, list 50 posts, calendar, tools/list, tools/call) | 1–3 ms | ~5 ms |
| OAuth callback (token exchange plus account upsert) | ~6 ms | ~8 ms |
| Upload part (5 MB → R2) / complete upload | 3–8 ms | ~9 ms |
| Password login (PBKDF2-SHA256, 100k iterations, native WebCrypto) | ~5 ms | ~5 ms |

The outlier is the first cron tick after the test creates four posts at once. In that tick it starts all four publishes and the first analytics sync, and it pushes several MB of video through Node's JavaScript streams (about 45 ms of that is Node GC). On Workers, `R2 → fetch()` is a native stream pipe that never enters the JS heap. Isolate-level samples from workerd are also collected (`postlite-workers-cpu.json`), but they include wall time spent waiting, so they overstate.

## Setup (about 20 minutes)

Requirements: a Cloudflare account, Node ≥ 22.13 on your machine, and a domain on Cloudflare (recommended; `*.workers.dev` also works).

### 1. Get the code and log in

```sh
git clone <your fork url> postlite && cd postlite
npm install            # dev dependency only: wrangler (the Node server itself has no dependencies)
npx wrangler login
```

Or use the **Deploy to Cloudflare** button in the README. It forks the repo, provisions D1 and R2, and runs `npm run deploy`. After that, continue at step 3.

### 2. Create the database and bucket, then deploy

```sh
npx wrangler r2 bucket create postlite-media   # once (skip if the Deploy button made it)
npm run cf:deploy
```

`cf:deploy` runs `wrangler deploy` and then `wrangler d1 migrations apply DB --remote`. On the first deploy, Wrangler [provisions](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) the D1 database (`database_name: postlite`) and writes its ID. If your Wrangler version doesn't, run `npx wrangler d1 create postlite` and paste the `database_id` into `wrangler.jsonc` → `d1_databases[0]`.

Migrations are plain SQL files in `migrations/`. The Node server applies the same files on boot (tracking them with `PRAGMA user_version`). Wrangler tracks them in `d1_migrations`.

### 3. Secrets

```sh
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENC_KEY    # encrypts OAuth tokens. Never change it later
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
```

Until `TOKEN_ENC_KEY` is set, the Worker answers with a short "not configured yet" message. Platform app credentials (Meta, Instagram, Google) are best pasted into **Settings → Platform apps** in the UI, where they're stored encrypted in D1. Alternatively, set them with `wrangler secret put META_APP_ID` and so on ([secrets](https://developers.cloudflare.com/workers/configuration/secrets/)).

**Moving from Node?** Use the same `TOKEN_ENC_KEY` value. The ciphertext format (`v1:<iv>:<tag>:<data>`, AES-256-GCM) is identical, so tokens encrypted by Node decrypt on Workers.

### 4. Custom domain and `PUBLIC_URL`

1. Go to *Workers & Pages → postlite → Settings → Domains & Routes → Add → Custom domain*, for example `postlite.example.com`.
2. Set `PUBLIC_URL` in `wrangler.jsonc` → `vars` to `https://postlite.example.com` and run `npm run cf:deploy` again.

If you leave `PUBLIC_URL` empty, the Worker uses the first URL it is opened at. Set it explicitly anyway: OAuth redirect URIs and media URLs are built from it.

### 5. Sign-in: Cloudflare Access (recommended)

Follow [cloudflare-access.md](cloudflare-access.md). It works the same for the Worker:

1. Create a **self-hosted Access application** for `postlite.example.com` with an **Allow** policy for your email (one-time PIN).
2. Create a second application with a **Bypass** policy for the machine endpoints:
   - `postlite.example.com/m/*`: Meta and Google fetch media here (unguessable 256-bit token URLs).
   - `postlite.example.com/api/v1/*`: API keys.
   - `postlite.example.com/mcp`: API keys.
   - `postlite.example.com/healthz`.
3. Put the values into `wrangler.jsonc` → `vars`, then run `npm run cf:deploy`:

   ```jsonc
   "AUTH_MODE": "cloudflare-access",
   "CF_ACCESS_TEAM_DOMAIN": "myteam.cloudflareaccess.com",
   "CF_ACCESS_AUD": "<Application Audience (AUD) tag>",
   "ALLOWED_EMAILS": "you@example.com"
   ```

postlite verifies the `Cf-Access-Jwt-Assertion` header itself. It checks the RS256 signature with WebCrypto against `https://<team>/cdn-cgi/access/certs` (keys cached and refetched on rotation), plus `aud`, `iss`, `exp`/`nbf` and `ALLOWED_EMAILS` ([validating Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)).

**Password mode instead:** create a portable hash and store it as a secret:

```sh
node bin/postlite.js hash-password | npx wrangler secret put ADMIN_PASSWORD_HASH
# wrangler.jsonc → vars: "AUTH_MODE": "password"
```

Password hashes on Workers use PBKDF2-SHA256 with 100k iterations through native WebCrypto (about 5 ms per login). The Node server accepts these hashes too.

### 6. Platform apps and redirect URIs

Same as Node. Use your Worker URL in the redirect URIs:

| App | Redirect URI(s) |
| --- | --- |
| Meta | `https://postlite.example.com/oauth/facebook/callback`, `…/oauth/instagram/callback` |
| Instagram Login | `…/oauth/instagram-standalone/callback` |
| Google | `…/oauth/youtube/callback` |

Step-by-step guides: [Meta](facebook-and-instagram.md), [Instagram standalone](instagram-standalone.md), [YouTube](youtube.md).

### 7. Optional: direct-to-R2 uploads (presigned URLs)

By default, upload parts go through the Worker (`PUT /api/v1/media/uploads/<id>/parts/<n>`, ≤ 100 MB each). To let browsers and agents upload **straight to R2**:

1. Go to *R2 → Manage API tokens → Create API token* with **Object Read & Write** on the `postlite-media` bucket, then store the keys:

   ```sh
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   ```

   In `vars`, set `"R2_ACCOUNT_ID": "<account id>"` and `"R2_BUCKET_NAME": "postlite-media"`.

2. Add a CORS policy to the bucket ([R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)) so browsers can PUT parts and read the ETag:

   ```json
   [{ "AllowedOrigins": ["https://postlite.example.com"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
   ```

`create_upload` then returns SigV4 presigned `UploadPart` URLs ([R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), valid from 1 s up to 7 days; postlite uses the session lifetime, 24 h by default). The web UI switches to multipart for files over 90 MB and uploads 3 parts in parallel.

**Why media is served by the Worker and not by a public bucket:** `/m/<token>` keeps the 256-bit unguessable URL scheme and HTTP Range support, and needs no public bucket. Cloudflare describes `r2.dev` URLs as "for non-production use cases" ([public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)), and a public bucket would expose every object. Presigned GET URLs expire, which is a problem because Meta sometimes fetches late. Each fetch costs one Worker request and one Class B operation, well inside the free tier.

### 8. Check it

```sh
curl -s https://postlite.example.com/healthz          # {"ok":true,"runtime":"workers",...}
npx wrangler tail                                      # watch cron runs: "cron * * * * *: {...} used={...}"
```

## Agents and the CLI against a Worker

```sh
POSTLITE_URL=https://postlite.example.com POSTLITE_API_KEY=pl_… node bin/postlite.js posts list
node bin/postlite.js --url https://postlite.example.com --key pl_… media upload ./clip.mp4   # resumable multipart
POSTLITE_URL=https://postlite.example.com POSTLITE_API_KEY=pl_… node bin/postlite.js mcp     # stdio bridge for MCP clients
```

REST (`/api/v1`, OpenAPI at `/api/v1/openapi.json`) and MCP over Streamable HTTP (`/mcp`) are identical on Node and Workers.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars && $EDITOR .dev.vars
npx wrangler d1 migrations apply DB --local
npm run cf:dev                         # http://localhost:8787. Trigger cron: curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
npm run test:workers                   # end-to-end in workerd against the fake Meta/Google servers
CPU_BENCH=1 npm run test:workers       # same scenario, in-process, prints CPU per invocation
```

## Caveats

- **Publish timing.** Cron runs once a minute, so a post publishes within about 0–60 s of its time. On Node it's 0–15 s.
- **Long publishes span cron runs.** Instagram container polling and YouTube uploads advance a step per run. Interrupted runs resume: the YouTube session URI and byte offset are persisted, and the next run asks YouTube how far it got.
- **No double posts.** Jobs are claimed with an atomic `UPDATE … RETURNING` in D1, so overlapping cron invocations can't claim the same job. Irreversible calls are marked *in flight* first. The recovery logic is the same as on Node.
- **Rate limits for API keys** are counted per isolate, so they are best-effort on Workers.
- **No ffmpeg**, so no poster images. Duration and dimensions of MP4/MOV come from a built-in parser.
- **Base64 uploads** are capped at 8 MB on Workers (JSON parsing costs CPU). Use `create_upload` or upload-from-URL for anything bigger.
- **Logs.** `wrangler tail` or Workers Logs (enabled in `wrangler.jsonc`; 200,000 log events/day on Free).
- **Backups.** Use `npx wrangler d1 export postlite --remote --output backup.sql`. D1 Time Travel keeps 7 days on Free. R2 objects need your own copy, for example with `rclone`.
