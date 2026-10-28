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

Each key has a rate limit (default 120 req/min → HTTP 429 + `Retry-After`). Every mutating call is recorded in the audit log with the key name and transport.

## Recommended call sequence

1. `whoami` — learn your scopes, approval mode, timezone.
2. `list_accounts` — ids + status. If `needs_reconnect`, call `get_connect_url` (admin) and ask the human to open the link.
3. `list_platforms` — rules, limits, and the JSON schema of `targets[].settings` per platform.
4. Media: `upload_media_from_url` (public URL), `upload_media_base64` (≤ 25 MB), `upload_media_from_path` (stdio only), or `POST /api/v1/media` raw body. Check the returned `width`, `height`, `duration`.
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
- No build step, no runtime dependencies. Node ≥ 22.13 (`node:sqlite`).
- `npm test` runs everything against fake providers (`test/fake/server.js`); never call real Meta/Google APIs in tests.
- New operations go in `src/api/operations.js` (they appear automatically in REST, OpenAPI, MCP and CLI).
- New platforms implement the provider shape documented in `src/providers/index.js`.
