# Agent guide — driving postlite with an AI agent

> Intended to live at the repo root as `AGENTS.md` (the build environment blocked writing that filename; copy/rename this file when publishing). Served at `/AGENTS.md` and `/docs/agent-guide.md`.

postlite is **agent-first**: every UI action is an API operation, exposed identically as

| Surface | Where | Auth |
|---|---|---|
| MCP (Streamable HTTP) | `POST https://<host>/mcp` | `Authorization: Bearer pl_…` |
| MCP (stdio) | `node bin/postlite.js mcp` | env `POSTLITE_API_KEY` (+ `POSTLITE_URL` to bridge to a remote server) |
| REST | `https://<host>/api/v1/...` — spec at `/api/v1/openapi.json` | Bearer key |
| CLI | `postlite call <tool> --json '{…}'`, plus shortcuts (`postlite posts create …`) | env `POSTLITE_API_KEY`, `POSTLITE_URL` |

Tool names == REST `operationId`s == CLI `call` names. A compact overview for LLMs lives at `/llms.txt`.

## Keys, scopes, approval

Create keys in **Settings → API keys** or `node bin/postlite.js keys create --name "Claude" [--scopes read,write,publish,analytics] [--no-approval]`.

| Scope | Allows |
|---|---|
| `read` | list/get accounts, posts, media, calendar, settings, slots, validate |
| `write` | create/edit drafts, upload/delete media, duplicate/delete posts |
| `publish` | schedule, reschedule, post now, retry |
| `analytics` | analytics reads, CSV export, `sync_analytics` |
| `admin` | API keys, webhooks, settings, approvals, connect/disconnect accounts, platform app credentials, audit log |

**Approval mode (default ON for new keys):** anything that would publish (`create_post` with mode schedule/now/next_slot, `schedule_post`, `publish_post_now`, `retry_post`, editing a scheduled post) puts the post in `pending_approval`. A human approves under **Approvals** (or a non-approval admin key calls `approve_post`). Rejections come back as drafts with `approval_note` explaining what to change — read it, fix with `update_post`, resubmit. Keys in approval mode can never approve posts or mint keys without approval mode. `reschedule_post` only moves the time and keeps the approval state.

A key belongs to one workspace (the person who created it) and only sees that workspace's accounts, posts, media, analytics, webhooks and settings; ids from other workspaces answer 404. `whoami` returns the `workspace`. On the server CLI, `keys create` takes `--email` (or `--workspace`) when there is more than one workspace.

Each key has a rate limit (default 120 req/min → HTTP 429 + `Retry-After`). Every mutating call is recorded in the audit log with the key name and transport.

## Recommended call sequence

1. `whoami` — learn your scopes, approval mode, timezone.
2. `list_accounts` — ids + status. If `needs_reconnect`, call `get_connect_url` (admin) and ask the human to open the link.
3. `list_platforms` — rules, limits, and the JSON schema of `targets[].settings` per platform.
4. Media: `upload_media_from_url` (public URL), `upload_media_base64` (≤ 25 MB on Node, ≤ 8 MB on Cloudflare Workers), `upload_media_from_path` (stdio only), `POST /api/v1/media` raw body (≤ 100 MB on Workers), or for big files the resumable `create_upload` → PUT each part to its URL (keep the ETag) → `complete_upload`. Check the returned `width`, `height`, `duration`. Videos carry a `poster` frame (ffmpeg on Node); where none could be made you can attach a JPEG with `set_media_poster`. `whoami` tells you the `runtime` (`node` or `workers`).
5. `validate_post` — dry run; returns per-account `errors`, `warnings`, and `will_publish` (e.g. "Reel", "Carousel (3)").
6. `create_post` with `mode`: `"draft"`, `"schedule"` + `publish_at`, `"next_slot"` (first free weekly posting slot), or `"now"`.
7. `get_post` — poll status; targets show `published_url`, `error`, `warning` and an event log.

### Example: create_post

```json
{
  "content": "New tutorial is live! #howto",
  "media_ids": ["9f1c…"],
  "targets": [
    { "account_id": "<youtube id>", "settings": { "title": "How to X in 60s", "isShort": true, "privacy": "public" } },
    { "account_id": "<instagram id>", "settings": { "first_comment": "Full guide in bio" } },
    { "account_id": "<facebook page id>", "content": "Longer FB caption…", "settings": { "post_type": "reel" } }
  ],
  "mode": "schedule",
  "publish_at": "2026-11-02T18:00"
}
```

## X and LinkedIn

- **X threads**: the first post is `content` + `media_ids`; follow-ups go in `settings.thread: [{ "text": "2/ …", "media": ["<media id>"] }]`. Each item is billed as an X post, and a URL in a post makes it much more expensive; prefer one link at the end. Check `validate_post` → `caption_length` (weighted: URLs count 23).
- **LinkedIn documents**: upload a PDF (`upload_media_from_url` works; kind `document`), then `settings: { "post_type": "document", "document_title": "…" }`. PDFs are rejected for every other platform, so give LinkedIn its own post or target override.
- **LinkedIn first comment / analytics** need the Community Management API; without it the post publishes with a `warning` and analytics return one `needs_approval` notice. Don't retry those.
- **Reconnects**: LinkedIn accounts expire after 60 days unless LinkedIn granted refresh tokens; X tokens refresh automatically. On `account.needs_reconnect`, call `get_connect_url` and ask the human.

## Brands

A brand is a named set of channels across platforms (for example "North Star" = its YouTube, Instagram, Facebook and X accounts). An account can be in several brands; brands belong to one workspace.

- "Post this to the North Star brand": `create_post {"brand_id": "North Star", "content": "...", "media_ids": [...], "mode": "next_slot"}`. `brand_id` takes the id or the name. Every connected channel becomes a target; channels that need a reconnect are skipped and listed in `brand.skipped`. Add `targets` for the same accounts to give them settings (a YouTube title, for example). `validate_post` takes `brand_id` too.
- Filters: `list_posts {brand}`, `get_calendar {brand}`, `get_analytics_overview {brand}` (adds `brand.totals`: followers and other snapshots summed with their change, views/engagement summed, averages averaged; `accounts[]` is the per-channel breakdown) and `get_top_posts {brand}`.
- Manage: `list_brands` (also returns `suggestions` from account names that share a prefix; nothing is created automatically), `create_brand {name, color?, account_ids}`, `update_brand {brand_id, name?, color?}`, `set_brand_channels {brand_id, account_ids, mode: replace|add|remove}`, `delete_brand` (the accounts, posts and analytics stay).
- CLI: `postlite brands list`, `postlite brands create --name "North Star" --accounts id1,id2`, `postlite posts create --brand "North Star" --content "..." --next-slot`.

## Channel preferences (the channel ⋮ menu)

- `update_account {account_id, display_name?, disabled?, posting_slots?}`:
  - `display_name` renames the channel inside postlite (`null` = platform name). `list_accounts` returns `name` (what to show), `platform_name` and `display_name`.
  - `disabled: true` pauses publishing without disconnecting (admin scope). Due posts wait: they are not published and not failed. `publish_post_now` and `create_post {mode:"now"}` are refused for that channel, and brand posting skips it (`brand.skipped[].reason = "publishing paused"`). `disabled: false` resumes, and anything that came due meanwhile publishes right away. Targets show `account_paused`.
  - `posting_slots` sets the channel's own weekly slots (same shape as `update_settings`; `null` = workspace slots). `list_free_slots {account_id}` and `mode: "next_slot"` use the selected channels' slots, and only those channels' posts count as taken.

## Tags

- `list_tags`, `create_tag {name, color?}`, `update_tag {tag_id, name?, color?}`, `delete_tag` (the posts stay). `tag_id` takes the id or the name.
- Assign: `create_post {..., tags: ["launch", "promo"]}` (unknown names are created), `update_post {tags}` replaces them, `set_post_tags {post_id, tags, mode: replace|add|remove}` works on published posts too. Posts carry `tags: [{id, name, color}]`.
- Filter: `list_posts {tag}`, `get_calendar {tag}`, `get_top_posts {tag}` (only posts published through postlite carry tags) and the CSV export (`&tag=`).

## Signatures and templates

- Signatures are saved snippets: `list_signatures`, `create_signature {name, content, auto_add?, platforms?, account_ids?}`, `update_signature`, `delete_signature`. Add one to a post with `create_post {signature: "Sign-off"}`; `create_post {auto_signatures: true}` appends every auto-add signature whose platforms/account_ids match the selected channels (empty scope = every channel), like the web composer does for new posts. A signature already at the end is never added twice.
- Templates ("sets") keep caption, channels with per-channel settings, brand and tags, never media: `list_templates`, `get_template`, `create_template {name, from_post_id}` or `{name, content, targets, brand_id?, tags?}`, `update_template`, `delete_template`. Start a post with `create_post {template_id, media_ids, publish_at, mode}`; anything you pass overrides the template, and targets for channels that no longer exist are dropped.

## Media library

- `list_media {q?, kind?: image|video|document, usage?: used|unused|purged, limit?, offset?, counts?}` pages through uploads newest first. Each item has `used_by_posts`, `in_use` (an unfinished post or an active repeating post needs it), `deletable` and `purged`. `total` is the number of matches; `counts` (with `counts: true`) gives totals per kind and usage.
- Reuse media: pass its id in `create_post {media_ids}` (not when `purged`: re-upload first).
- Clean up: `list_media {usage: "unused"}` → `delete_media_bulk {media_ids}`; items still needed are skipped with a reason.

## Media is deleted after publishing

Each workspace deletes the original file of an upload once every post that uses it is finished (setting `delete_media_after`: `immediate` = 30 minutes after the last target published, `7d`, `30d` or `never`; `get_storage` / `update_storage_settings` with an admin key). Drafts, posts awaiting approval, scheduled, publishing (YouTube resumable sessions, X/LinkedIn chunked uploads, Instagram/Facebook containers that fetch `/m/` URLs) and failed posts with a retry queued (or failed in the last 24 h) keep the file. Media that never went live is never deleted.

- A purged media item has `purged: true`, `url: null`, `public_url: null`, and keeps `poster` (a small JPEG). Its `/m/` URL answers **410 Gone**.
- Show people the published post instead: `targets[].published_url`.
- `duplicate_post` on a post with purged media returns `needs_reupload: [{media_id, name, kind}]`. Upload the file again and `update_post {media_ids}` before scheduling. Scheduling or `retry_post` with purged media fails with a 409 that says exactly that.
- `cleanup_media {dry_run: true}` lists what is eligible now and why everything else is kept; without `dry_run` it deletes the eligible originals (write scope). The scheduler also runs it every few minutes.

## Settings and deleting workspace data

- `get_settings` / `update_settings {timezone?, time_format?: "24h"|"12h", posting_slots?}` (admin to change). `time_format` only changes how times are shown (UI, alert emails); API times stay ISO-8601 / epoch ms and slot times are always 24h `HH:MM`.
- `get_workspace_data_summary` (admin) lists row counts and `confirm_with`, the text `delete_workspace_data` expects (the workspace owner's email, or the workspace name when no email is bound).
- `delete_workspace_data {confirm}` (admin, never with an approval-mode key) deletes everything this workspace owns: accounts and tokens, posts and history, media files, API keys (including yours), webhooks, brands, tags, signatures, templates, repeating series, notifications, analytics, the audit log and settings. It never touches another workspace and never removes anyone's sign-in. Posts already live on the platforms stay live. Only call it when the human asked for exactly this, and repeat what will be deleted before you do.

## Workflows

**Plan a week of posts** — `get_settings` → `list_free_slots {count: 7}` → `list_accounts` → `list_platforms` → per slot: write caption, `validate_post`, `create_post {mode: "schedule", publish_at: slot.at}` → summarize as a table. (MCP prompt: `plan_week`.)

**Upload a video and schedule a Short** — `upload_media_from_url {url}` → confirm `height > width` and `duration ≤ 180` → `validate_post` with YouTube `{title, isShort: true}` (+ Instagram target = Reel) → `create_post {mode: "next_slot"}`. (MCP prompt: `schedule_short`.)

**Recover failures** — `list_posts {status: "failed"}` → `get_post` → read `targets[].error`: content errors → `update_post` then `retry_post`; "reconnect" → `get_connect_url {provider, reconnect_account_id}` and ask the human; "may have been published" → **do not retry**, ask the human to check the platform.

**Platform not configured** — `get_connect_url` returns 409 "not configured" → `list_platform_apps` shows the status, the exact redirect URIs, scopes and the guide link (`/docs/setup/...`). Ask the human to create the developer app and paste the credentials in **Settings → Platform apps**. Don't ask for secrets in chat. `set_platform_app` exists for automation but stores whatever you send, and approval-mode keys can't use it. After saving, `test_platform_app {app}` checks the credentials without a user login (`verified:false` = checked on first connect).

**Weekly analytics report** — `sync_analytics` → `get_analytics_overview {from: "<7 days ago>"}` → `get_top_posts {sort: "views", limit: 5}`. Metrics a platform cannot provide are listed under `sync.unavailable` — report them as "not available". (MCP prompt: `weekly_report`.)

## MCP resources
`postlite://accounts`, `postlite://calendar/upcoming`, `postlite://analytics/summary`, `postlite://platforms`, `postlite://approvals`, `postlite://settings`; templates `postlite://posts/{post_id}`, `postlite://analytics/accounts/{account_id}`.

## Webhooks
Events: `post.published`, `post.failed`, `post.pending_approval`, `account.needs_reconnect`, `analytics.synced`. Body: `{"id","event","created_at","data"}`. Verify `X-Postlite-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC_SHA256(secret, "<t>.<raw body>")`; reject if `|now - t| > 300 s`. Failed deliveries are retried with exponential backoff (default 6 attempts).

## Client configs
See `examples/agents/` for Claude Desktop, Claude Code, Cursor and Hermes.

## For agents editing this repo
- No UI build step, no runtime dependencies. Two deployment targets from one core: Node ≥ 22.13 (`node:sqlite`, disk) and Cloudflare Workers (D1, R2, Cron; `wrangler.jsonc`).
- `src/` is runtime-agnostic. Only `src/node/` may import `node:*`, and only `src/workers/` touches Workers bindings. Use WebCrypto, `Uint8Array`, `fetch`, `Request`/`Response` and the async `db` (`get/all/run/batch`, ≤ 100 bound params per query) and `storage` interfaces.
- Schema: add `migrations/NNNN_name.sql`. The Node migrator and `wrangler d1 migrations apply` both use it.
- Long work must be resumable on Workers (free plan: 10 ms CPU, 50 subrequests, 50 D1 queries per invocation). Check `budget.has(...)` between steps, persist progress and return; the next cron tick continues.
- `npm test` runs the Node suite against fake providers (`test/fake/server.js`); never call real Meta/Google APIs in tests. `npm run test:workers` runs the real Worker in workerd (local D1/R2) against the same fakes; `CPU_BENCH=1` prints CPU per invocation.
- New operations go in `src/api/operations.js` (they appear automatically in REST, OpenAPI, MCP and CLI).
- New platforms implement the provider shape documented in `src/providers/index.js`.
