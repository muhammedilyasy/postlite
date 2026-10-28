# Facebook Pages + Instagram (via Facebook Login) — Meta app setup

*Last verified against Meta's official documentation: **2026-10-28**. Meta renames dashboard labels often.
If a label here doesn't match what you see, use the linked official page.*

This Meta app powers two postlite connections:

- **Facebook** — publishes to Facebook Pages you manage (feed posts, photos, videos, Reels, Stories).
- **Instagram (via Facebook Page)** — publishes to an Instagram **professional** (Business or Creator)
  account that is **linked to a Facebook Page**.

If your Instagram account has no Facebook Page, use [Instagram Login](instagram-standalone.md) instead.

> **Exact values:** `https://YOUR-DOMAIN` is a placeholder. Open **Settings → Platform apps → Meta app**
> in postlite to copy the exact redirect URIs for your `PUBLIC_URL`.

## What you'll end up with

| Item | Value |
| --- | --- |
| App type / use cases | Business app with **Manage everything on your Page** + **Manage messaging & content on Instagram** |
| Login product | Facebook Login for Business (added automatically by the use cases) |
| Redirect URIs | `https://YOUR-DOMAIN/oauth/facebook/callback` and `https://YOUR-DOMAIN/oauth/instagram/callback` |
| Credentials for postlite | **App ID** and **App Secret** (App settings → Basic) |

## 1. Prerequisites

1. **Register as a Meta developer** with your personal Facebook account: [developers.facebook.com/docs/development/register](https://developers.facebook.com/docs/development/register).
2. **A Facebook Page** that you manage with full control, or with the task access needed to create content.
3. **For Instagram:** an Instagram **Business or Creator** account, linked to that Page (see section 6).
4. **postlite reachable over HTTPS** at `PUBLIC_URL`. Meta downloads images and videos from postlite, so the
   media URLs must be public.

## 2. Create the app

Official guide: [Create an App with Meta](https://developers.facebook.com/docs/development/create-an-app/).

1. Go to <https://developers.facebook.com/apps/creation/> (or **My Apps → Create app**).
2. **App details:** enter an app name, for example "postlite – YOUR-DOMAIN", and a contact email. Click **Next**.
3. **Use cases:** select
   - **Manage everything on your Page**, and
   - **Manage messaging & content on Instagram** (needed only for Instagram via a Facebook Page).
   Use cases that conflict are greyed out. **You can't remove a use case later**, so don't add
   **Authenticate and request data from users with Facebook Login**. It is incompatible with the Page use case.
4. **Business:** connect a business portfolio, or choose *I don't want to connect a business portfolio yet*.
   Personal use works without one. You need a **verified** business portfolio for Advanced Access (section 8).
5. Review the summary and click **Go to dashboard**.

## 3. Add the permissions postlite requests

When you add a use case, Meta adds only its *required* permissions. The others are optional, and **you must add
them yourself**. If you skip this, the login dialog shows **"Invalid Scopes"**.

In the App Dashboard, open **Use cases**. Click **Customize** next to each use case and **Add** these permissions:

**Manage everything on your Page** (Facebook connection)

| Permission | Why postlite needs it |
| --- | --- |
| `pages_show_list` | List the Pages you manage so you can choose which ones to connect (required by the use case). |
| `business_management` | See Pages owned through a business portfolio (required by the use case). |
| `pages_manage_posts` | Create, edit and delete posts, photos, videos and Reels on the Page. |
| `pages_manage_engagement` | Post the optional **first comment** on Page posts. |
| `pages_read_engagement` | Read Page content and metadata; Page access tokens and insights need it. |
| `read_insights` | Page and post analytics (views, reach, engagement). |

**Manage messaging & content on Instagram** (Instagram via Facebook Page)

| Permission | Why postlite needs it |
| --- | --- |
| `instagram_basic` | Read the Instagram profile and media linked to your Page. |
| `instagram_content_publish` | Publish posts, Reels, carousels and Stories. |
| `instagram_manage_comments` | Post the optional **first comment** and invite collaborators. |
| `instagram_manage_insights` | Account and media insights. |
| `pages_show_list`, `pages_read_engagement` | Find the Page that is linked to the Instagram account. |

The **Platform apps** card in postlite always shows the exact scope list that the current version requests.

## 4. Configure Facebook Login for Business (redirect URIs)

Official reference: [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business)
· [Manually build a login flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow)

1. Left menu: **Facebook Login for Business → Settings**. On older apps, this is **Facebook Login → Settings**.
2. Under **Client OAuth settings**:
   - **Client OAuth login:** On
   - **Web OAuth login:** On
   - **Enforce HTTPS:** On
   - **Use Strict Mode for redirect URIs:** On (recommended)
   - **Valid OAuth Redirect URIs:** add **both** of these:
     ```
     https://YOUR-DOMAIN/oauth/facebook/callback
     https://YOUR-DOMAIN/oauth/instagram/callback
     ```
3. Click **Save changes**.

postlite uses Meta's server-side ("manual") login flow. It sends the permission list in the `scope`
parameter, so you **don't need a Configuration ID**. Meta's docs recommend `config_id` for new
integrations, but `scope` is still accepted for user access tokens.

## 5. App settings → Basic

Official reference: [Basic settings](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/basic-settings).

1. **App domains:** `YOUR-DOMAIN`, without `https://`.
2. **Privacy Policy URL** and **User data deletion** (instructions URL or callback): required to switch to
   Live mode. For a personal instance, a short page on your site is enough.
3. **Category** and **App icon**: required for App Review.
4. Copy the **App ID**. Click **Show** next to **App Secret** and copy it.
5. In postlite, go to **Settings → Platform apps → Meta app**. Paste both values, click **Save**, then click **Test**.
   The test gets an app access token and reads `GET /app`. If it fails, re-copy the secret.
   You can also reset it under App settings → Basic → **Reset**.

## 6. Prepare the Instagram account (Instagram via Facebook Page only)

Official references: [Instagram Platform overview](https://developers.facebook.com/docs/instagram-platform/overview)
· [Set up a Business account](https://help.instagram.com/502981923235522)
· [Set up a Creator account](https://help.instagram.com/1158274571010880)
· [Link an Instagram account to your Facebook Page](https://www.facebook.com/help/1148909221857370/)

1. **Switch to a professional account.** In the Instagram app, go to **Settings → Account type and tools → Switch to professional account**
   and choose **Business** or **Creator**. Personal accounts can't be published to through the API.
2. **Link the account to your Facebook Page.** In the Instagram app, go to **Edit profile → Page → Connect or create**.
   On Facebook, switch into the Page, then go to **Settings → Linked accounts → Instagram → Connect account**.
   If the Page belongs to a business portfolio, the Instagram account must be in **the same portfolio**.
3. The Facebook user who clicks **Connect** in postlite must have a task (for example, full control or content access) on that Page.
4. If Meta asks for **Page Publishing Authorization (PPA)** for the Page, complete it. Without it, publishing fails.

## 7. Connect in postlite

1. Go to **Accounts → Connect Facebook**, or **Connect Instagram (via Facebook Page)**.
2. Log in with the Facebook user who manages the Page. Select **all** Pages and Instagram accounts you
   want, and **leave every permission switched on**. postlite checks the granted permissions and asks you
   to reconnect if any are missing.
3. postlite exchanges the code for a long-lived user token and stores **Page tokens**, which don't expire under normal use.
   If Meta revokes access (password change, removed permissions), the account shows **Needs reconnect**.

## 8. Development mode, Live mode and App Review

Official references: [App modes](https://developers.facebook.com/docs/development/build-and-test/app-modes)
· [App roles](https://developers.facebook.com/docs/development/build-and-test/app-roles)
· [Access levels](https://developers.facebook.com/docs/graph-api/overview/access-levels)
· [App Review](https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review)
· [Business verification](https://developers.facebook.com/docs/development/release/business-verification)

- **Every new app starts in Development mode.** In this mode, only people with a **role** on the app (Admin,
  Developer, Tester) can log in and grant permissions. Posts made in Development mode are visible only to those people
  until the app goes Live.
- **Personal / self-hosted single-owner use:** an app in Development mode with **Standard Access** is
  enough. Add yourself, and anyone else who connects Pages, under **App roles → Roles**. Testers must accept
  the invitation at <https://developers.facebook.com/requests>.
- **Public or open-source deployments serving other people's Pages:** if the people connecting don't have a
  role on your app, you need **Advanced Access**. That means **App Review** for every permission listed
  above (with screencasts that show how postlite uses each one), **Business Verification**, a
  Privacy Policy URL, and data-deletion instructions. Then switch the app to **Live**. Each person who self-hosts
  postlite should create **their own** Meta app. Don't share an App Secret.

## 9. Common errors

| Error | Cause and fix |
| --- | --- |
| **URL Blocked: This redirect failed because the redirect URI is not whitelisted in the app's Client OAuth Settings** | The redirect URI isn't in **Valid OAuth Redirect URIs**, or doesn't match exactly (`https`, host, path, trailing slash). Copy both URIs from postlite's Platform apps page. Check that Client OAuth login and Web OAuth login are on. If you changed `PUBLIC_URL`, update the URIs. |
| **Invalid Scopes: …** | A permission postlite requests isn't added to your app's use cases. Add it under **Use cases → Customize** (section 3). Deprecated names like `manage_pages` are never requested by postlite. |
| **App not active** / "This app is not currently accessible" | The app is in Development mode and the person logging in has no app role, or the app is restricted. Add them under **App roles**, or finish App Review and go Live. |
| **Can't load URL: The domain of this URL isn't included in the app's domains** | Add `YOUR-DOMAIN` to **App domains** (App settings → Basic), and add the redirect URIs. |
| "Missing permissions: …" (from postlite) | Someone switched off a permission in the login dialog. Click **Reconnect** and keep everything on. |
| "No Instagram professional account found" | The Instagram account is personal, or isn't linked to a Page that the logged-in user manages (section 6). |
| Test: "Error validating client secret" | The App Secret is wrong or was reset. Copy it again from App settings → Basic. |
| `(#10) Application does not have permission for this action` | The permission isn't approved for your access level. Use an account with an app role, or get Advanced Access. |
| `(#200) … Page Publishing Authorization` | Complete PPA for the Page in Facebook's Page settings. |

## 10. Instagram media rules (Instagram API with Facebook Login)

From [Content Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing) and the
[IG User Media reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media).
postlite validates these rules before it schedules a post.

- **Images:** JPEG only (no PNG, MPO or JPS), ≤ 8 MB, aspect ratio **4:5 to 1.91:1**, width ≤ 1440 px (larger images are scaled down).
- **Reels:** MP4/MOV (H.264/HEVC, AAC audio), 3 s – 15 min, ≤ 300 MB, 23–60 fps, ≤ 1920 px wide; 9:16 recommended.
- **Stories:** video 3–60 s, ≤ 100 MB; images ≤ 8 MB; 9:16 recommended.
- **Carousels:** Meta's documentation now allows up to 20 images and/or videos. postlite enforces 2–10 items, the long-standing
  limit. All items are cropped to the first item's aspect ratio (1:1 by default).
- **Captions:** ≤ 2,200 characters, ≤ 30 hashtags, ≤ 20 @mentions.
- **Rate limit:** 100 API-published posts per account in a rolling 24 hours (a carousel counts as one post).
  You can check usage with `GET /<IG_ID>/content_publishing_limit`.
- **Media must be on a public server** when the post publishes. Meta fetches media with cURL from `PUBLIC_URL`.
- Shopping tags and filters aren't supported by the API.

## Official links

- Meta App Dashboard: <https://developers.facebook.com/apps>
- Create an app: <https://developers.facebook.com/docs/development/create-an-app/>
- Facebook Login for Business: <https://developers.facebook.com/docs/facebook-login/facebook-login-for-business>
- Pages API overview: <https://developers.facebook.com/docs/pages-api/overview>
- Permissions reference: <https://developers.facebook.com/docs/permissions>
- Instagram API with Facebook Login — get started: <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/get-started>
- Content Publishing: <https://developers.facebook.com/docs/instagram-platform/content-publishing>
- App modes: <https://developers.facebook.com/docs/development/build-and-test/app-modes>

[← All setup guides](README.md)
