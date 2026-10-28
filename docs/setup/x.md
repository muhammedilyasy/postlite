# X (Twitter)

postlite publishes to X through **your own X developer app** with OAuth 2.0 (Authorization Code + PKCE).
It supports text posts, up to 4 photos, an animated GIF, video (chunked upload), **threads** (a reply chain under
the first post) and "who can reply". Analytics come from the post metrics X returns to the account owner.

*Checked against the official X developer docs on 2026-10-28.*

## What it costs: X API is pay-per-use

The X API is billed **pay-per-usage**: no subscription; you buy **credits** in the
[Developer Console](https://console.x.com) and each request is charged (Enterprise plans exist for high volume)
([pricing](https://docs.x.com/x-api/getting-started/pricing), [usage and billing](https://docs.x.com/x-api/fundamentals/post-cap)).
Rates at the time of writing (always check the console):

| What postlite does | X billing unit | Price |
| --- | --- | --- |
| Publish a post (each thread item is one post) | Post: Create | $0.015 per request |
| Publish a post **that contains a URL** | Post: Create (with URL) | $0.20 per request |
| Read your recent posts with metrics (analytics) | Owned Reads (`GET /2/users/{id}/tweets` for the app owner) | $0.001 per post |
| Read one post's metrics | Posts: Read | $0.005 per post |
| Read your profile (connect, follower count) | User: Read | $0.010 per request |

- Requests fail with HTTP 402 when the credits run out; postlite shows *"X API credits are used up"* and does not retry.
- The same post fetched twice in one UTC day is billed once; pay-per-use is capped at 3 million post reads per month.
- postlite keeps analytics cheap: one Owned Read for your latest `X_ANALYTICS_RECENT_POSTS` posts (default 10) per sync,
  plus a lookup of non-public metrics only for posts from the last 30 days. Set it to `0` to sync only the follower count.
- Owned Read pricing only applies when the connected X account **owns the developer app**. Other accounts cost the
  normal Posts: Read rate.

## 1. Create the app

1. Sign in at [console.x.com](https://console.x.com) with the X account that should own the app.
2. Create a **Project** and an **App** inside it (v2 endpoints need an app inside a project).
3. **Billing → Credits:** buy a small amount (a few dollars covers hundreds of posts). Set a spending alert.

## 2. User authentication settings

App → **User authentication settings → Set up** ([OAuth 2.0 docs](https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code)):

| Field | Value |
| --- | --- |
| App permissions | **Read and write** |
| Type of App | **Web App, Automated App or Bot** (a *confidential client*: postlite keeps the secret on the server) |
| Callback URI / Redirect URL | `https://YOUR-DOMAIN/oauth/x/callback`, copied from **Settings → Platform apps → X** |
| Website URL | Your `PUBLIC_URL` |

Save. X then shows the **OAuth 2.0 Client ID and Client Secret** once (also under *Keys and tokens*). The
*API Key / API Key Secret* (OAuth 1.0a consumer keys) and the *Bearer token* are **not** used by postlite.

## 3. Add the keys to postlite

**Settings → Platform apps → X**: paste the Client ID and Client Secret, **Save**, then **Test**. The test calls the token
endpoint with a dummy code: "accepted" means the ID and secret match. Then **Accounts → Add an account → X → Connect**.

`.env` alternative: `X_CLIENT_ID=…` and `X_CLIENT_SECRET=…`.

## Permissions postlite asks for

| Scope | Why |
| --- | --- |
| `tweet.read` | Read your posts and their metrics |
| `tweet.write` | Publish posts, replies and threads |
| `users.read` | Your profile: name, @handle, follower count, Premium status |
| `media.write` | Upload photos, GIFs and videos ([media upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked)) |
| `offline.access` | A refresh token, so the connection survives the 2-hour access token |

Access tokens last **2 hours**. postlite refreshes them before use; X rotates the refresh token on each refresh and
postlite stores the new one. If X revokes it (password change, app removed under *Connected apps*), the account shows
**Needs reconnect**.

## Limits postlite checks before publishing

From [Create Post](https://docs.x.com/x-api/posts/create-post), [counting characters](https://docs.x.com/resources/fundamentals/counting-characters)
and [media best practices](https://docs.x.com/x-api/media/quickstart/best-practices):

- **280 weighted characters.** URLs count as 23, emoji and CJK characters as 2. **X Premium** accounts may post up to
  25,000 (postlite detects Premium from `subscription_type` when you connect; reconnect after subscribing).
- **Media:** up to 4 photos (5 MB each), **or** 1 animated GIF (15 MB), **or** 1 video (MP4/MOV, 0.5 s–20 min,
  ≤ 8 GB; Premium: up to 125 min, 16 GB). Limits follow the connected account, not your API plan. Media types
  cannot be mixed in one post.
- **Threads:** add items under *Thread* in the composer (or `settings.thread` in the API). Each item is a separate post
  that replies to the previous one, can carry its own media, and is billed as a post.
- **Duplicate text** within a short window is refused by X (`403 duplicate content`); postlite fails the post with that message.

## How publishing works

1. Media upload v2: `POST /2/media/upload/initialize` → `/{id}/append` in 4 MB segments (resumable: each segment is
   one scheduler step, which fits the Workers free plan) → `/{id}/finalize` → poll `GET /2/media/upload?command=STATUS`
   until video processing has `succeeded`.
2. `POST /2/tweets` with `text`, `media.media_ids` and, for thread items, `reply.in_reply_to_tweet_id`.
3. If the connection drops after X accepted a post, postlite looks the post up in your recent posts before trying again,
   so it is never published twice.

## Analytics

| Metric | Source | Who gets it |
| --- | --- | --- |
| Followers, post count | `users/me` `public_metrics` | Everyone |
| Views (impressions), likes, replies, reposts, quotes, bookmarks | `public_metrics` | Everyone |
| Link clicks, profile clicks, engagements | `non_public_metrics` | The post's author, posts from the **last 30 days** only |
| Organic vs promoted split | `organic_metrics` / `promoted_metrics` | Not used (needs the author context and ads data) |

See [metrics](https://docs.x.com/x-api/fundamentals/metrics). X has no daily account-level views API for this
access level, so postlite charts follower changes from its own snapshots and post metrics from each sync.

## Troubleshooting

| Message | Fix |
| --- | --- |
| *X rejected the app credentials* | Use the **OAuth 2.0** Client ID/Secret, not the API Key. Regenerate the secret if unsure. |
| *Something went wrong* on X's consent page | The callback URI in the app settings must match exactly (scheme, host, path, no trailing slash). |
| *X API credits are used up* | Buy credits in the console, then **Retry** the post. |
| *You are not permitted to perform this action* (403) | App permissions must be **Read and write**; change it, then reconnect the account. |
