# Platform setup guides

postlite publishes through **your own developer apps** on each platform. You create the app once,
paste its ID and secret into **Settings → Platform apps** in postlite, and connect your accounts.
The credentials are encrypted in postlite's database. You don't need to edit `.env` or restart.

> **Exact values:** these guides use `https://YOUR-DOMAIN` as a placeholder. The **Platform apps** page
> in your postlite instance shows the exact redirect URIs for your `PUBLIC_URL` and has copy buttons.
> Paste those values, not the placeholders.

| Platform | Developer app you need | Guide |
| --- | --- | --- |
| Facebook Pages + Instagram (via a linked Facebook Page) | Meta app with Facebook Login for Business | [facebook-and-instagram.md](facebook-and-instagram.md) |
| Instagram without a Facebook Page | Meta app with the Instagram product ("API setup with Instagram login") | [instagram-standalone.md](instagram-standalone.md) |
| YouTube | Google Cloud project + OAuth client (Web application) | [youtube.md](youtube.md) |

You only need the platforms you actually use. For Instagram, choose **one** of the two options: link
your Instagram professional account to a Facebook Page and use the Meta app, or use Instagram Login
without a Page.

## 10-minute quickstart

1. **Check `PUBLIC_URL`.** It must be the public HTTPS address of postlite, for example `https://YOUR-DOMAIN`.
   Meta downloads media from this URL, and every redirect URI is built from it.
2. **Open Settings → Platform apps** in postlite. Each card shows the redirect URI(s), scopes, products
   and APIs to set up, plus a checklist.
3. **YouTube** (about 5 minutes) — [full guide](youtube.md):
   1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project.
   2. Enable **YouTube Data API v3** and **YouTube Analytics API**.
   3. Set up the Google Auth Platform: Branding, Audience **External**, and add yourself as a **Test user**.
   4. Under Clients, create a **Web application** client and paste the redirect URI from postlite.
   5. Paste the Client ID and Client secret into the YouTube card, then click **Save** and **Test**.
4. **Facebook Pages + Instagram** (about 5 minutes) — [full guide](facebook-and-instagram.md):
   1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and click **Create app**.
   2. Add the use cases **Manage everything on your Page** and **Manage messaging & content on Instagram**.
   3. In each use case, click **Customize** and add the permissions listed on the Meta card in postlite.
   4. In Facebook Login for Business → Settings → **Valid OAuth Redirect URIs**, paste both redirect URIs.
   5. In App settings → Basic, copy the **App ID** and **App Secret** into the Meta card, then click **Save** and **Test**.
5. Go to **Accounts → Connect** and approve **all** requested permissions.
6. Create a test post as a draft, then click **Publish now**.

## How postlite stores app credentials

- Credentials saved in the UI or API are stored in SQLite. The secret is encrypted with
  AES-256-GCM using `TOKEN_ENC_KEY`.
- No API ever returns a secret. The UI only shows `saved • …last4`.
- Values saved in the app **override** `.env`. **Clear** returns to the `.env` values
  (`META_APP_ID`/`META_APP_SECRET`, `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET`,
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) if they exist.
- Agents with an `admin` API key can also manage credentials with the `list_platform_apps`, `set_platform_app`,
  `clear_platform_app` and `test_platform_app` tools. API keys in approval mode cannot change credentials.
- If you change `TOKEN_ENC_KEY`, postlite can no longer decrypt saved secrets. Paste them again.

## What "Test" checks

| App | Check (no user login needed) |
| --- | --- |
| Meta | Gets an app access token (`grant_type=client_credentials`) and reads `GET /app`. This proves the App ID and App Secret match. |
| Instagram Login | Exchanges a dummy code at `api.instagram.com/oauth/access_token`. An error about the code means the app ID and secret were accepted. |
| Google | Exchanges a dummy code at `oauth2.googleapis.com/token`. `invalid_grant` means the client ID and secret are valid; `invalid_client` means they are wrong. |

Test can't verify redirect URIs, permissions, enabled APIs or test users. The first **Connect** checks those.

*Guides last checked against the official documentation on 2026-10-28.*
