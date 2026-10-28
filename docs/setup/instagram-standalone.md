# Instagram without a Facebook Page — Instagram API with Instagram Login

*Last verified against Meta's official documentation: **2026-10-28**.*

Use this option when your Instagram **professional** (Business or Creator) account is **not** linked to a
Facebook Page, or when you want to log in with Instagram credentials. postlite calls this connection
**Instagram (Instagram Login)**. In the API it is the provider `instagram-standalone`.

If your Instagram account is already linked to a Page, you can use the [Meta app via Facebook Login](facebook-and-instagram.md) instead.
You only need one of the two options.

> **Exact values:** `https://YOUR-DOMAIN` is a placeholder. Go to **Settings → Platform apps → Instagram app** in postlite
> to copy the exact redirect URI.

## What you'll end up with

| Item | Value |
| --- | --- |
| Meta app | **Business** type app with the **Instagram** product → **API setup with Instagram login** |
| Redirect URI | `https://YOUR-DOMAIN/oauth/instagram-standalone/callback` |
| Credentials for postlite | **Instagram App ID** and **Instagram App Secret**. These are **not** the Meta App ID and App Secret. |
| Scopes | `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_insights` |

## 1. Prerequisites

- An Instagram **Business or Creator** account. Personal accounts can't use the API. Switch in the Instagram app:
  **Settings → Account type and tools → Switch to professional account**
  ([Business](https://help.instagram.com/502981923235522), [Creator](https://help.instagram.com/1158274571010880)).
- A Meta developer account: [register](https://developers.facebook.com/docs/development/register).
- postlite reachable over HTTPS at `PUBLIC_URL`. Instagram downloads your media from postlite.

## 2. Create the app and add Instagram

Official guide: [Create a Meta app for the Instagram API](https://developers.facebook.com/docs/instagram-platform/create-an-instagram-app).

1. Go to <https://developers.facebook.com/apps> → **Create app**. You can also add Instagram to the Meta app you already
   use for Facebook, if it is a Business app. In that case, skip to step 4.
2. **Use case:** select **Other** → **Next**. **App type:** select **Business** → **Next**. Only Business
   apps can add the Instagram product.
3. Enter an app name and contact email, then create the app. You can connect a business portfolio now or later.
   Meta requires a verified business before the app can be published or go Live.
4. In the dashboard, find the **Instagram** product and click **Set up**. **API setup with Instagram login** is
   added automatically.

## 3. Set up Instagram business login (redirect URI)

Official guide: [Business Login for Instagram](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login).

1. Go to **Instagram → API setup with Instagram login → 3. Set up Instagram business login** and click **Set up**.
2. Enter the **Redirect URL** `https://YOUR-DOMAIN/oauth/instagram-standalone/callback`, then click **Save**.
3. Open **Business login settings**:
   - **OAuth redirect URIs:** make sure the same URI is listed. Meta may add a trailing slash. The URI must match postlite's
     exactly, so remove the slash if the dashboard added one.
   - **Deauthorize callback URL** and **Data deletion request URL:** required for App Review. For personal use, any page
     on your domain that explains how to request deletion is fine.
   - Click **Save**.
4. On the same page, copy the **Instagram app ID** and **Instagram app secret**. They are shown in the
   *Business login settings* section and are **different** from the Meta App ID/Secret under App settings → Basic.
   Using the Meta App ID here causes the error *"Invalid platform app"*.

You don't need the **Embed URL** that Meta shows. postlite builds its own authorization URL.

## 4. Save in postlite

1. Go to **Settings → Platform apps → Instagram app**. Paste the Instagram App ID and Instagram App Secret, then click **Save**.
2. Click **Test**. postlite exchanges a dummy authorization code. The expected answer is a *code* error, which means
   the app ID and secret were accepted. *"Invalid platform app"* or a *client secret* error means the values are wrong.

## 5. Testers and access levels

Official references: [Instagram Platform overview — access levels](https://developers.facebook.com/docs/instagram-platform/overview)
· [App roles](https://developers.facebook.com/docs/development/build-and-test/app-roles)
· [Instagram App Review](https://developers.facebook.com/docs/instagram-platform/app-review)

- New apps have **Standard Access**. With Standard Access, the app works only for Instagram accounts you own or manage that are **added
  to the app**. That is enough for a personal postlite instance.
- Add your account: go to **Instagram → API setup with Instagram login → Generate access tokens → Add account**
  (or **App roles → Roles → Instagram Testers**). The account must be public. The account owner then accepts the
  invitation in Instagram: on the web, go to **Settings → Apps and websites → Tester invites**.
- To serve accounts you **don't** own or manage (public or open-source deployments where users bring their own
  accounts), you need **Advanced Access**. That requires **App Review** for the four permissions above (with screencasts), plus
  **Business Verification**. Each person who self-hosts postlite should create their own app.

## 6. Connect in postlite

1. Go to **Accounts → Connect Instagram (Instagram Login)**. postlite sends `enable_fb_login=0`, so the
   Instagram login page doesn't offer "Log in with Facebook". Log in with the Instagram professional account you want to connect.
   If you are already logged in to Instagram with a different account, log out first.
2. Approve all four permissions.

## 7. Token lifetime

From [Business Login → long-lived tokens](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login)
and [Refresh Access Token](https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token):

- The authorization code is valid for **1 hour** and can be used once. postlite exchanges it immediately.
- The short-lived token is exchanged for a **long-lived token valid for 60 days**. This requires the app secret.
- A long-lived token can be refreshed once it is **at least 24 hours old** and not yet expired. Each refresh gives
  another 60 days. postlite refreshes automatically about **10 days before expiry**. The Accounts page shows "token renews before …".
- If the token expires (for example, postlite was offline for more than 60 days) or the user revokes access, the account shows
  **Needs reconnect**. Click **Reconnect**.
- Refreshing tokens needs the Instagram App Secret. If you **Clear** the Instagram app in postlite and there are no `.env`
  values, refreshes will fail.

## 8. Common errors

| Error | Fix |
| --- | --- |
| *Invalid platform app* | You pasted the Meta App ID instead of the **Instagram app ID**, or the Instagram product isn't set up. |
| *Error validating client secret* | Wrong Instagram app secret. Copy it again from Business login settings. |
| *Invalid redirect_uri* / *redirect_uri mismatch* | The OAuth redirect URI in Business login settings doesn't exactly match postlite's (check for a trailing slash, `http` vs `https`, and the host). |
| *Insufficient developer role* / the account can't log in | The account isn't added as an Instagram tester, or hasn't accepted the invite (section 5). |
| *Matching code was not found or was already used* | The code is older than 1 hour or was used twice. Start **Connect** again. |
| *The user is not an Instagram Business* | Switch the account to Business or Creator. |

## 9. Media rules

These are the same as Instagram via Facebook Login. See [Instagram media rules](facebook-and-instagram.md#10-instagram-media-rules-instagram-api-with-facebook-login).
With Instagram Login, the API host is `graph.instagram.com`, and resumable video uploads (`rupload`) are only available with
Facebook Login. postlite uses URL-based uploads for Instagram Login, so `PUBLIC_URL` must be publicly reachable.

## Official links

- Instagram API with Instagram Login: <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login>
- Business Login for Instagram: <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login>
- Create a Meta app for the Instagram API: <https://developers.facebook.com/docs/instagram-platform/create-an-instagram-app>
- Content Publishing: <https://developers.facebook.com/docs/instagram-platform/content-publishing>
- Refresh Access Token: <https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token>

[← All setup guides](README.md)
