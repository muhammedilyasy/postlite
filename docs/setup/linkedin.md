# LinkedIn (profiles and Company Pages)

postlite posts to LinkedIn through **your own LinkedIn app**:

- **LinkedIn profile** (`linkedin`): your personal posts. Self-serve, no review: the *Share on LinkedIn* and
  *Sign In with LinkedIn using OpenID Connect* products.
- **LinkedIn Page** (`linkedin-page`): Company Pages you admin. Needs the **Community Management API**, which
  LinkedIn reviews.

Supported: text (with clickable #hashtags), 1 image, 2–20 images (multi-image), 1 video, a **PDF document** post,
an article link card, and an optional first comment.

*Checked against Microsoft Learn (LinkedIn API version 202610) on 2026-10-28.*

## What is free and what needs approval

| Capability | Product / permission | Access |
| --- | --- | --- |
| Sign in, member id, name, photo | Sign In with LinkedIn using OpenID Connect: `openid profile email` | Self-serve ([docs](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2)) |
| Post on your profile: text, images, video, documents | Share on LinkedIn: `w_member_social` | Self-serve ([docs](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin)) |
| Post as a Company Page | Community Management API: `w_organization_social`, `r_organization_social`, `rw_organization_admin` | **Application + review** ([docs](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview)) |
| First comment | `w_member_social_feed` / `w_organization_social_feed` (Community Management API) | **Review** ([Comments API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api)) |
| Profile post analytics, follower count | `r_member_postAnalytics`, `r_member_profileAnalytics` (Community Management API) | **Review** ([Member Post Statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics)) |
| Page analytics (impressions, clicks, reactions…) | `rw_organization_admin` | **Review** ([Organization Share Statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics)) |
| Refresh tokens (365 days) | Programmatic refresh tokens | **Approved Marketing partners only** ([docs](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)) |

Consequences you will see in postlite:

- **Reconnect every 60 days.** Member access tokens last 60 days. Without refresh tokens (most apps), the account shows
  *Reconnect before …* and turns **Needs reconnect** when it expires. Reconnecting takes one click while you are signed in to LinkedIn.
- Without the Community Management API, a profile's Analytics tab shows one notice instead of numbers; published posts
  are still listed with their links. A first comment is skipped with a warning; the post itself is published.
- The Community Management API is granted per **app**, and LinkedIn asks that it be on an app **without other products**.
  If yours is on a second app, add it as **LinkedIn Pages app** in Platform apps (`LINKEDIN_PAGES_CLIENT_ID/SECRET`);
  Pages then connect through it while profiles keep using the first app.

## 1. Create the app

1. Open the [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps) → **Create app**.
2. App name, a **LinkedIn Page** for the app (required; any Page you admin) and a logo. Accept the terms.
3. **Settings → Verify:** send the verification link to a Page admin and approve it.

## 2. Add the products

**Products** tab → **Request access** for:

- **Share on LinkedIn** (granted instantly),
- **Sign In with LinkedIn using OpenID Connect** (granted instantly).

For Company Pages, request **Community Management API** (preferably on a separate app, see above). LinkedIn first grants
the *Development tier* (limited calls, your own Pages), then reviews you for the *Standard tier* after a screencast
of the integration. The **Auth** tab lists the scopes you actually have; postlite only asks for those.

## 3. Redirect URLs

**Auth** tab → *OAuth 2.0 settings* → **Authorized redirect URLs for your app**: add both (copy them from
**Settings → Platform apps → LinkedIn**):

```
https://YOUR-DOMAIN/oauth/linkedin/callback
https://YOUR-DOMAIN/oauth/linkedin-page/callback
```

## 4. Add the keys to postlite

**Auth** tab → copy the **Client ID** and **Primary Client Secret** into **Settings → Platform apps → LinkedIn**,
**Save**, **Test** (a dummy-code token request: "accepted" means ID and secret match). Then **Accounts → Add an
account → LinkedIn → My profile** or **A Company Page I admin**.

`.env` alternative: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` (and optionally `LINKEDIN_PAGES_CLIENT_ID`,
`LINKEDIN_PAGES_CLIENT_SECRET`). Once LinkedIn approves more scopes, list them in `LINKEDIN_EXTRA_SCOPES`
(profile) or `LINKEDIN_PAGE_EXTRA_SCOPES` (Pages), for example `r_member_postAnalytics w_member_social_feed`,
and reconnect.

## Permissions postlite asks for

| Scope | Why |
| --- | --- |
| `openid`, `profile`, `email` | Identify the member (`sub`), show the name, photo and email on the Accounts page |
| `w_member_social` | Publish posts, images, videos and documents as you |
| `rw_organization_admin` | List the Pages where you are an admin or content admin; read Page analytics |
| `w_organization_social` | Publish as the Page |
| `r_organization_social` | Read the Page's posts (used to find a post after a lost response) |

## Limits postlite checks before publishing

- **Text:** 3,000 characters. postlite converts it to LinkedIn's *little text format*: reserved characters
  (`| { } @ [ ] ( ) < > # \ * _ ~`) are escaped so nothing is cut off, and `#hashtags` become clickable hashtags
  ([little text format](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format)).
  Mentions are sent as plain text.
- **Images:** JPG, PNG or GIF, under 36,152,320 pixels; 2–20 images become a multi-image post
  ([Images API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api),
  [MultiImage](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api)).
- **Video:** one MP4, 3 seconds to 30 minutes, 75 KB to 500 MB
  ([Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api)).
- **Document:** one PDF (choose *Document* in the composer), up to 100 MB and 300 pages
  ([Documents API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api)).
- Page posts are always public; profile posts can be *Anyone* or *Connections only*.

## How publishing works

All calls go to `https://api.linkedin.com/rest/…` with `LinkedIn-Version: 202610` (override with `LINKEDIN_API_VERSION`;
LinkedIn supports each monthly version for at least a year, see [versioning](https://learn.microsoft.com/en-us/linkedin/marketing/versioning))
and `X-Restli-Protocol-Version: 2.0.0`.

1. **Upload:** `POST /rest/images|documents?action=initializeUpload` → `PUT` the bytes to the returned URL. Videos use
   `/rest/videos?action=initializeUpload` with the file size; LinkedIn returns 4 MB parts, postlite uploads them one
   scheduler step at a time (fits the Workers free plan), collects the ETags and calls `finalizeUpload`.
2. **Wait:** videos and documents are polled until `AVAILABLE`.
3. **Post:** `POST /rest/posts` with `author` (`urn:li:person:…` or `urn:li:organization:…`), `commentary`,
   `visibility`, `distribution`, `lifecycleState: PUBLISHED` and `content` (media, multiImage or article). The post URN
   comes back in the `x-restli-id` header ([Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)).
4. **First comment** (if approved): `POST /rest/socialActions/{postUrn}/comments`.

If the response is lost after LinkedIn created the post, postlite looks for it among the Page's recent posts. Profile
posts cannot be listed with self-serve permissions, so those fail with *check LinkedIn before retrying*.

## Analytics

| | Profile (with `r_member_postAnalytics`) | Company Page (`rw_organization_admin`) |
| --- | --- | --- |
| Followers | `memberFollowersCount` | `networkSizes` (Page followers) |
| Daily | Reactions per day (`memberCreatorPostAnalytics`) | Impressions, unique impressions, clicks, likes, comments, shares (`organizationalEntityShareStatistics`, daily) |
| Per post | Impressions, members reached, reactions, comments, reshares | Impressions, unique impressions, clicks, likes, comments, shares |
| Without approval | One notice; posts listed without numbers | One notice |

LinkedIn returns Page statistics for roughly the last 12 months only.

## Troubleshooting

| Message | Fix |
| --- | --- |
| *Bummer, something went wrong* / redirect error | The redirect URL must be listed exactly on the **Auth** tab. |
| *unauthorized_scope_error* | The app lacks a product for a requested scope. Add *Share on LinkedIn* / *OpenID Connect*, or wait for Community Management approval before connecting a Page. |
| *No LinkedIn Pages found* | Your member needs the **Super admin** or **Content admin** role on the Page. |
| *LinkedIn access tokens last 60 days…* | Reconnect the account (Accounts → Reconnect). |
