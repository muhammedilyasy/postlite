# Sign-in with Cloudflare Zero Trust Access (email one-time PIN)

*Last verified against Cloudflare's official documentation on 2026-10-28. Cloudflare moves menu items
from time to time. If a label below does not match, the linked Cloudflare page has the current path.*

By default postlite signs you in with a single admin password. You can put the web UI behind
**Cloudflare Zero Trust Access** instead. Cloudflare then emails a one-time PIN to an allowed address,
and only after that does a request reach postlite. postlite checks Cloudflare's signed token again on
every request, and it has its own allow-list (`ALLOWED_EMAILS`) as a second line of defence.

This guide uses `postlite.example.com` and two allowed people. Swap in your own hostname and addresses.

| | |
| --- | --- |
| Allowed emails | `teammate@example.com`, `owner@example.com` |
| Protected (Allow policy) | `postlite.example.com` (everything not listed below) |
| Public (Bypass), protected by postlite itself | `/m/*`, `/api/v1/*`, `/mcp`, `/healthz` |
| Cost | The Zero Trust **Free** plan is enough (up to 50 users) |

> **Order matters.** Create the Access applications first. Then set the `.env` values and restart postlite.
> If you switch postlite to `AUTH_MODE=cloudflare-access` before Access exists, postlite rejects every
> browser request (fail closed) and you are locked out until you switch back to `AUTH_MODE=password`.

## How it fits together

1. Your browser opens `https://postlite.example.com/`. Cloudflare Access sees no session and shows its
   login page. You enter your email address and Cloudflare emails you a PIN.
2. After you enter the PIN, Access checks the **Allow** policy (the two emails) and sets a
   `CF_Authorization` cookie. Every request it forwards to postlite carries a signed JWT in the
   `Cf-Access-Jwt-Assertion` header.
3. postlite verifies that JWT on every page request (RS256 signature against
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, plus `aud`, `iss`, `exp` and `nbf`) and checks that
   the email is in `ALLOWED_EMAILS`. Then it creates or reuses a postlite session for that email. CSRF
   protection stays on, and the audit log records the email.
4. Four path groups skip Access (**Bypass**) because machines call them, and machines can't type a PIN.
   postlite still guards each of them itself (see [Why the bypass paths are needed](#why-the-bypass-paths-are-needed)).

## 1. Turn on Zero Trust and pick a team name

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com/). Use the account that owns the
   `example.com` zone, and turn on two-factor authentication for it if you haven't yet.
2. In the left sidebar select **Zero Trust**. This opens Cloudflare One at `one.dash.cloudflare.com`.
3. On the onboarding screen, choose a **team name**, for example `myteam`. Your team domain becomes
   `myteam.cloudflareaccess.com`. You'll need it for `CF_ACCESS_TEAM_DOMAIN`.
4. Choose the **Zero Trust Free** plan and finish checkout. Cloudflare still asks for payment details,
   but it doesn't charge for the free plan.
5. To look up the team name later, go to **Zero Trust → Settings**.

Source: [Get started](https://developers.cloudflare.com/cloudflare-one/setup/)

## 2. Add the One-time PIN login method

New organizations start with the *Cloudflare* identity provider only. One-time PIN is no longer added
automatically.

1. Go to **Zero Trust → Integrations → Identity providers**.
2. Under **Your identity providers**, select **Add new identity provider**.
3. Select **One-time PIN**. It needs no further configuration. Save it.

Source: [One-time PIN login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)

## 3. Create the policies

Policies are reusable, so create them once and attach them to applications.

### 3a. Allow policy: the two owners

1. Go to **Zero Trust → Access controls → Policies** and select **Add a policy**.
2. **Policy name:** `postlite owners`
3. **Action:** `Allow`
4. **Session duration:** `Same as application session timeout`
5. Under **Rules**, add an **Include** rule:
   - **Selector:** `Emails`
   - **Value:** `teammate@example.com` and `owner@example.com`. Add each address as its own value.
6. Select **Save**.

### 3b. Bypass policy: everyone (only for the machine endpoints)

1. **Add a policy** again.
2. **Policy name:** `postlite public endpoints`
3. **Action:** `Bypass`
4. **Include** rule → **Selector:** `Everyone`
5. Select **Save**.

Bypass turns Access off for matching traffic, and Cloudflare doesn't log those requests. Bypass
policies can't use identity selectors such as email, so `Everyone` is the right selector here.

Sources: [Manage Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/),
[Policy actions: Allow, Bypass](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/#actions)

## 4. Create the self-hosted application for the UI

1. Go to **Zero Trust → Access controls → Applications** and select **Create new application**.
2. Select **Self-hosted and private**.
3. **Application name:** `postlite`
4. Select **Add public hostname**:
   - **Subdomain:** `postlite`
   - **Domain:** `example.com`
   - **Path:** leave it empty. An empty path protects the whole hostname.
5. Under **Access policies**, select **Select existing policies** and add `postlite owners`.
6. Under authentication / **Login methods**, enable **One-time PIN**. Turn off the other providers for
   this app, then turn on **Apply instant authentication**. With only one method enabled, users go
   straight to the PIN screen.
7. **Session Duration:** `24 hours`. See [Session duration](#session-duration-recommendation).
8. Optional, under **Additional settings → Cookie settings**: keep **SameSite** at its default or `Lax`.
   Don't use `Strict`. With `Strict`, the browser drops the Access cookie when Google or Meta redirect you back to
   `/oauth/*/callback`.
9. Select **Create**.

Source: [Publish a self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

## 5. Create the Bypass application for the machine endpoints

Create **one** more self-hosted application with four public hostnames that share the Bypass policy. If
your dashboard only allows one hostname per app, create four apps with the same settings instead.

1. **Create new application → Self-hosted and private**.
2. **Application name:** `postlite – public endpoints`
3. Select **Add public hostname** four times:

   | Subdomain | Domain | Path |
   | --- | --- | --- |
   | `postlite` | `example.com` | `m/*` |
   | `postlite` | `example.com` | `api/v1/*` |
   | `postlite` | `example.com` | `mcp` |
   | `postlite` | `example.com` | `healthz` |

4. Under **Access policies**, add the existing `postlite public endpoints` (Bypass) policy.
5. Select **Create**.

When two applications cover the same hostname, the **more specific path wins**, so these paths skip
Access and everything else stays behind the `postlite` app. Don't add `/oauth/*`, `/login` or `/docs` to
the bypass app. The OAuth callbacks need your Access cookie, because postlite checks that you are a
signed-in owner before it stores the account tokens.

Source: [Application paths: policy inheritance and wildcards](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)

### Why the bypass paths are needed

| Path | Who calls it | Why Access must not block it | How postlite protects it |
| --- | --- | --- | --- |
| `/m/*` | Meta's and Google's servers fetch your images and videos by URL when they publish | Their fetchers can't sign in, so they would get the Access login page and the post would fail with "media could not be downloaded" | Every file has its own unguessable 256-bit token in the URL. A wrong token or file name returns 404. Only GET and HEAD are allowed. |
| `/api/v1/*` | AI agents, scripts, the CLI, and the postlite UI's own API calls | Bearer-key clients can't do a PIN login | Requires an API key (`Authorization: Bearer pl_…`), or a postlite session that was created by an Access sign-in. The browser's `CF_Authorization` cookie must match that session's email, and the session only lives as long as the Access token behind it. Mutations need a CSRF token. `/api/v1/openapi.json`, `/api/v1/llms.txt` and `/api/v1/agent-guide.md` are public read-only docs (no data). |
| `/mcp` | MCP clients such as Claude Desktop, Claude Code and Cursor | Same as the API: bearer keys only | Every MCP call needs a valid API key, and the per-key rate limit and approval mode still apply. An Access JWT alone is *not* accepted. |
| `/healthz` | Uptime monitors | Monitors can't sign in | Returns only `{ok, version, uptime_s}`. |

> **Don't turn on "Protect with Access" in the Cloudflare Tunnel settings** for this hostname. That
> option makes `cloudflared` demand an Access token on *every* request, including the bypass paths, and
> publishing would break. postlite validates the token itself.

## 6. Copy the Application Audience (AUD) tag and the team domain

1. Go to **Zero Trust → Access controls → Applications**.
2. Select **Configure** on the **`postlite`** application (the UI app, *not* the bypass app).
3. Open **Additional settings** and copy the **Application Audience (AUD) Tag**. It is a long hex
   string. It only changes if you delete and re-create the application.
4. Your team domain is `<team name>.cloudflareaccess.com`. You can check the team name in **Zero Trust → Settings**.

Source: [Validate JWTs: get your AUD tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag)

## 7. Configure postlite

Edit the `.env` file on the server (`~/apps/postlite/.env`, which stays `chmod 600`):

```bash
AUTH_MODE=cloudflare-access
CF_ACCESS_TEAM_DOMAIN=myteam.cloudflareaccess.com
CF_ACCESS_AUD=paste-the-application-audience-tag-here
ALLOWED_EMAILS=teammate@example.com,owner@example.com
```

Keep only **one** `AUTH_MODE=` line. postlite's `.env` loader uses the first value it finds, so an older
`AUTH_MODE=password` line above the new one would win. Then restart postlite:

```bash
systemctl --user restart postlite
journalctl --user -u postlite -n 20 --no-pager
# expect: auth: Cloudflare Access (myteam.cloudflareaccess.com), 2 allowed email(s); password login disabled
```

postlite **refuses to start** if `AUTH_MODE=cloudflare-access` is set but the team domain, AUD tag or
`ALLOWED_EMAILS` is missing or malformed. The error message names the missing variable.

What changes in access mode:

- `/login` redirects you into the app when you're signed in through Access. Otherwise it shows a
  "Sign in with Cloudflare Access" page. Password login (`POST /login`) is disabled, and so is
  `node bin/postlite.js set-password`.
- **Sign out** ends the postlite session and sends you to `https://postlite.example.com/cdn-cgi/access/logout`,
  which revokes your Access session.
- The audit log (Settings → Audit log) shows the signed-in email for every UI action, plus `login` and `logout` entries.
- An email that passes Access but is *not* in `ALLOWED_EMAILS` gets postlite's own **Access denied** page (HTTP 403).
- If postlite can't reach Cloudflare's certs endpoint, it answers 503 and lets nobody in. Signing keys are
  cached for an hour and re-fetched straight away when a token carries an unknown key id (Cloudflare
  rotates keys every 6 weeks).

## 8. Verify

From any machine (`--doh-url` avoids stale local DNS caches):

```bash
H=https://postlite.example.com
DOH="--doh-url https://1.1.1.1/dns-query"
# UI is behind Access: expect 302 to myteam.cloudflareaccess.com
curl $DOH -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $H/
# Bypass paths reach postlite directly:
curl $DOH -s $H/healthz                                   # {"ok":true,...}
curl $DOH -s -o /dev/null -w '%{http_code}\n' $H/api/v1/accounts       # 401 from postlite (JSON), not a redirect
curl $DOH -s -o /dev/null -w '%{http_code}\n' $H/api/v1/openapi.json   # 200
curl $DOH -s -X POST -o /dev/null -w '%{http_code}\n' $H/mcp -H 'content-type: application/json' -d '{}'  # 401
curl $DOH -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $POSTLITE_API_KEY" $H/api/v1/accounts  # 200
```

In a browser:

1. Open `https://postlite.example.com/`, enter one of the two allowed emails, then type the PIN from the email.
2. You should land on the dashboard with your email in the top-right account menu. **Settings → General**
   shows *Sign-in: Cloudflare Zero Trust Access*.
3. Open a published post's media URL (`/m/…`) in a private window. It loads without a login.
4. Try a different email. Cloudflare refuses to send a working PIN or shows *That account does not have access*.
5. Use **Sign out** in the account menu. The next visit asks for a new PIN.
6. In Cloudflare, **Zero Trust → Insights → Logs → Access authentication** (the name may vary) lists the logins.

To test the policy without logging in, open the `postlite owners` policy → **Policy tester**.

## Session duration recommendation

| Setting | Where | Recommended |
| --- | --- | --- |
| Application session (the `postlite` app) | Applications → `postlite` → Configure → **Session Duration** | **24 hours** (the default) |
| Global session | **Zero Trust → Access controls → Access settings → Set your global session duration** | **1 week** |

With these values you type a PIN about once a week. Cloudflare quietly re-issues the 24-hour postlite token
while the global session is valid. postlite honours its own session only as long as the Access token
behind it, so a stolen postlite cookie stops working within 24 hours. For a stricter setup, use 8 hours for
the app and 24 hours globally.

Source: [Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)

## Workspaces (one per email)

Every email on the allow-list gets its own workspace the first time it signs in. A workspace holds its own
connected accounts, posts, media, analytics, approvals, API keys, webhooks, audit log, timezone/posting slots
and platform-app credentials (Settings → Platform apps; `.env` app keys are the fallback for every workspace).
Nobody can see or change another person's data, and an API key only reaches the workspace it was created in.
The account menu shows the signed-in email and the workspace name.

A page or channel can be connected in one workspace at a time; connecting it again from another workspace is
refused until it is disconnected there.

### Upgrading from the single shared workspace

Instances that ran before workspaces existed keep all their data in one legacy workspace. Assign it to the
right people before (or right after) the upgrade:

```sh
# 1. back up
sqlite3 data/postlite.sqlite "VACUUM INTO 'data/postlite.pre-workspaces.sqlite'"
# 2. dry run: read-only report of who owns what, and what cannot be attributed
node bin/postlite.js workspaces attribute --owner you@example.com
# 3. apply (stop the service first; one transaction; safe to re-run)
systemctl --user stop postlite
node bin/postlite.js workspaces attribute --owner you@example.com --apply
systemctl --user start postlite
```

The report uses the audit log (who connected which account, who created which API key, which key created
which post or upload), `created_by` on posts and uploads, and which account each post targets. Rows without
evidence go to `--owner` and are listed as UNATTRIBUTABLE. Platform-app credentials and scheduling settings
are copied to every workspace, so tokens obtained with those apps keep refreshing.

## Roll back

Set `AUTH_MODE=password` in `.env` and run `systemctl --user restart postlite`. Password login works
again (set or reset the password with `node bin/postlite.js set-password`). The Access applications
can stay in place, or you can delete them in **Zero Trust → Access controls → Applications**.

## Reference

| Variable | Example | Notes |
| --- | --- | --- |
| `AUTH_MODE` | `cloudflare-access` | `password` (default) or `cloudflare-access` |
| `CF_ACCESS_TEAM_DOMAIN` | `myteam.cloudflareaccess.com` | `https://` and a trailing `/` are stripped. A bare team name gets `.cloudflareaccess.com` appended. |
| `CF_ACCESS_AUD` | 64 hex characters | The AUD tag of the **UI** application |
| `ALLOWED_EMAILS` | `a@x.com,b@y.com` | Comma-separated, case-insensitive. It must match the Allow policy. |
| `CF_ACCESS_CLOCK_SKEW_SEC` | `60` | Optional. Tolerance for `exp` / `nbf`. |
| `CF_ACCESS_JWKS_TIMEOUT_MS` | `5000` | Optional. Timeout for fetching the signing keys. |

Further reading: [Application token format](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/) ·
[Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) ·
[Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
