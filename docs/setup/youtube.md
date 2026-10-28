# YouTube — Google Cloud project and OAuth client setup

*Last verified against Google's official documentation: **2026-10-28**. The Google Cloud console now groups
OAuth settings under **Google Auth Platform** (Branding, Audience, Data Access, Clients). Older
guides call this the "OAuth consent screen".*

> **Exact values:** `https://YOUR-DOMAIN` is a placeholder. Go to **Settings → Platform apps → Google Cloud OAuth client**
> in postlite to copy the exact redirect URI.

## What you'll end up with

| Item | Value |
| --- | --- |
| Google Cloud project | One project for your postlite instance |
| Enabled APIs | **YouTube Data API v3**, **YouTube Analytics API** |
| OAuth client | Type **Web application** |
| Authorized redirect URI | `https://YOUR-DOMAIN/oauth/youtube/callback` |
| Scopes | `https://www.googleapis.com/auth/youtube.upload`, `https://www.googleapis.com/auth/youtube.readonly`, `https://www.googleapis.com/auth/yt-analytics.readonly` |
| Credentials for postlite | **Client ID** (`…apps.googleusercontent.com`) and **Client secret** |

## 1. Create a project

1. Open <https://console.cloud.google.com/> and sign in with the Google account that will own the project.
2. Use the project picker → **New project**. Name it, for example "postlite", then click **Create** and select it.

## 2. Enable the APIs

1. Go to **APIs & Services → Library**.
2. Enable **YouTube Data API v3**: <https://console.cloud.google.com/apis/library/youtube.googleapis.com>.
   postlite uses it for uploads, thumbnails, channel info and video statistics.
3. Enable **YouTube Analytics API**: <https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com>.
   postlite uses it for channel analytics such as views, watch time and subscribers.

## 3. Configure the Google Auth Platform (consent screen)

Official references: [Manage App Audience](https://support.google.com/cloud/answer/15549945)
· [OAuth 2.0 for web server apps (YouTube)](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps)
· [Using OAuth 2.0 — refresh token expiration](https://developers.google.com/identity/protocols/oauth2)

1. Open **Google Auth Platform** (<https://console.cloud.google.com/auth/overview>) and click **Get started** if prompted.
2. **Branding:** enter the app name, user support email, developer contact email and, ideally, app home page / privacy policy
   links on `YOUR-DOMAIN`. Add `YOUR-DOMAIN`'s parent domain under **Authorized domains**.
3. **Audience:** choose **External**. Choose **Internal** only for a Google Workspace organization whose users all belong to it.
4. **Audience → Test users:** **add every Google account that will connect a channel.** This is
   usually your own account, or the Brand Account manager. Testing status allows up to 100 test users.
5. **Data Access → Add or remove scopes:** add the three YouTube scopes listed above. Google classifies them as
   *sensitive* scopes.

### Publishing status: Testing vs In production

| | Testing | In production |
| --- | --- | --- |
| Who can connect | Only listed **test users** (max 100) | Any Google account |
| Consent screen | "Google hasn't verified this app" warning; test users click **Continue** | Unverified-app warning until verification is complete |
| **Refresh token lifetime** | **Expires 7 days after consent.** The channel shows *Needs reconnect* weekly. | Long-lived; it expires only if revoked, unused for 6 months, the password changes, etc. |
| Verification | Not needed | Required for sensitive scopes before the app can be shown to the public without warnings; also lifts the user cap |

**Recommendation for a personal instance:** click **Audience → Publish app** to set the status to **In production**.
You don't need to submit for verification if only you or a few people you know connect. You will
click through the "unverified app" screen once per consent, and the app is limited to 100 users. This avoids the
7-day refresh-token expiry that applies in **Testing**. To make the app available to the public, submit it for
[sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).
You'll need a scope justification, a demo video and a privacy policy.

## 4. Create the OAuth client

1. Go to **Google Auth Platform → Clients → Create client**: <https://console.cloud.google.com/auth/clients>.
   The older path is **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. **Application type:** **Web application**. Name: "postlite".
3. **Authorized JavaScript origins:** leave empty.
4. **Authorized redirect URIs → Add URI:**
   ```
   https://YOUR-DOMAIN/oauth/youtube/callback
   ```
   The scheme, host, path and trailing slash must match **exactly**.
5. Click **Create**. Copy the **Client ID** and **Client secret**. Newer consoles show the secret in full only once, so
   download the JSON if offered.
6. In postlite, go to **Settings → Platform apps → Google Cloud OAuth client**, paste both values, then click **Save** and **Test**.
   Test calls the token endpoint with a dummy code: `invalid_grant` means the client ID and secret are valid;
   `invalid_client` means they are wrong.

## 5. Connect in postlite

1. Go to **Accounts → Connect YouTube**. postlite requests offline access (`access_type=offline`, `prompt=consent`, PKCE),
   so Google issues a refresh token.
2. Choose the Google account or **Brand Account** that owns the channel. If you see "Google hasn't verified this app",
   click **Continue**. This is expected for your own unverified project.
3. Grant **all** requested permissions. postlite checks the granted scopes.

## 6. Upload restrictions, audit and quota

Official references: [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)
· [Quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
· [Quota and Compliance Audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)
· [Revision history](https://developers.google.com/youtube/v3/revision_history)

- **Private-until-audit (history and current status).** Since 28 July 2020, videos uploaded through
  `videos.insert` from **unverified API projects** created after that date were locked to **private**. To lift
  that restriction, the project had to pass a YouTube API compliance audit. The current `videos.insert` reference
  (last updated 2026-10-15) says instead: *"Videos uploaded from unverified API projects are not restricted
  to private viewing mode."* If your uploads still end up locked as private, and YouTube emails you that the video was
  "locked as private", request the audit as described below.
- **Requesting the audit / more quota:** fill in the **YouTube API Services – Audit and Quota Extension Form**:
  <https://support.google.com/youtube/contact/yt_api_form>. You'll describe your API client (postlite, self-hosted,
  uploads only to your own channel), give the Cloud project number, and show how you comply with the
  [YouTube API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service) and
  [Developer Policies](https://developers.google.com/youtube/terms/developer-policies). Screenshots or a screencast
  of the connect and upload flow help.
- **Quota (defaults):** each project gets **100 `videos.insert` calls per day** in a separate *Video Uploads*
  bucket (1 unit per upload), **100 `search.list` calls per day**, and **10,000 units per day** for all other
  methods. `thumbnails.set` costs **50 units**; `videos.list` and `channels.list` cost 1 unit each. Quotas reset at
  **midnight Pacific Time**. You can check usage at <https://console.cloud.google.com/iam-admin/quotas>.
- **Custom thumbnails** need a phone-verified channel (YouTube setting) to be accepted.

## 7. Common errors

| Error | Fix |
| --- | --- |
| **Error 400: redirect_uri_mismatch** | The redirect URI sent by postlite isn't in **Authorized redirect URIs** for this client. Copy it from postlite's Platform apps page; scheme, host, path and trailing slash must match. If you changed `PUBLIC_URL`, update the client. Changes can take a few minutes to apply. |
| **Error 403: access_denied** ("… has not completed the Google verification process") | The project is in **Testing** and the Google account isn't a **test user**. Add it under Audience → Test users, or publish the app (section 3). |
| `access_denied` in the callback | You clicked **Cancel** or unticked a scope. Connect again and grant everything. |
| **invalid_client** (Test or Connect) | Wrong Client ID or Client secret, or the client was deleted. Copy them again; deleted clients can be restored within 30 days. |
| **invalid_grant** on refresh → *Needs reconnect* | The refresh token expired (Testing status: 7 days), was revoked, or the account password changed. Publish the app to In production, then **Reconnect**. |
| **quotaExceeded** / *uploadLimitExceeded* | The daily quota or upload bucket is used up. postlite marks the post failed with a clear message; reschedule it for after midnight PT, or request more quota. |
| **accessNotConfigured** / "YouTube Data API v3 has not been used in project … or it is disabled" | Enable the API (section 2) in the **same** project as the OAuth client and wait a few minutes. |
| **youtubeSignupRequired** | The Google account has no YouTube channel. Create one, then connect again. |
| **forbidden** on `thumbnails.set` | The channel isn't verified for custom thumbnails. Verify it at <https://www.youtube.com/verify>. |

## Official links

- Google Cloud console: <https://console.cloud.google.com/>
- YouTube Data API overview: <https://developers.google.com/youtube/v3/getting-started>
- OAuth 2.0 for web server apps: <https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps>
- Manage App Audience (Testing / In production): <https://support.google.com/cloud/answer/15549945>
- Quota calculator: <https://developers.google.com/youtube/v3/determine_quota_cost>
- Audit and Quota Extension Form: <https://support.google.com/youtube/contact/yt_api_form>

[← All setup guides](README.md)
