// X (Twitter) provider: OAuth 2.0 Authorization Code with PKCE + refresh tokens (offline.access), POST /2/tweets,
// chunked media upload v2 (/2/media/upload/initialize → /{id}/append → /{id}/finalize → status), threads as
// reply chains, and post metrics. Docs (checked 2026-10): docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code,
// docs.x.com/x-api/media/quickstart/media-upload-chunked, docs.x.com/x-api/posts/create-post, docs.x.com/x-api/fundamentals/metrics.
// X API access is pay-per-use (credits): every read and every post is billed, so analytics stay small on purpose.
import { request, qs, ProviderError, classifyHttp } from './http.js';

export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];
const SEGMENT = 4 * 1024 * 1024; // docs: keep each APPEND segment ≤ 5 MB (server max 8 MB)

/** X API v2 errors: problem+json {title, detail, status}, {errors:[{message}]}, or OAuth {error, error_description}. */
export function classifyX(body, status) {
  let j = null;
  try { j = JSON.parse(body); } catch {}
  if (!j) return null;
  if (typeof j.error === 'string') {
    if (j.error === 'invalid_request' && /token/i.test(j.error_description || '')) return { kind: 'auth', message: 'X refresh token is invalid or was already used; reconnect the X account.' };
    if (j.error === 'invalid_client' || j.error === 'unauthorized_client') return { kind: 'permanent', message: `X rejected the app credentials (${j.error_description || j.error}). Check the Client ID and Secret in Platform apps.` };
    return { kind: status >= 500 ? 'transient' : 'permanent', message: j.error_description || j.error };
  }
  const detail = j.detail || j.errors?.[0]?.message || j.title || '';
  const type = String(j.type || '');
  if (status === 401) return { kind: 'auth', message: 'X access token expired or was revoked.' };
  if (status === 402 || /credits?|usage-capped|UsageCapExceeded|payment/i.test(`${type} ${detail} ${j.title || ''}`)) return { kind: 'permanent', message: 'Your X API credits are used up (or the usage cap was hit). Buy credits in the X Developer Console, then retry.' };
  if (status === 429) return { kind: 'transient', message: 'X rate limit reached; will retry.' };
  if (/duplicate content/i.test(detail)) return { kind: 'permanent', message: 'X refused a duplicate post (same text as a recent post).' };
  if (status === 403 && /client-not-enrolled|not enrolled|project/i.test(`${type} ${detail}`)) return { kind: 'permanent', message: 'This X app is not attached to a Project with API access. In the X Developer Console, put the app in a Project and buy credits.' };
  if (status === 403 && /scope|permission|not permitted/i.test(detail)) return { kind: 'auth', message: `X refused the request: ${detail} Reconnect and approve every permission.` };
  if (status >= 500) return { kind: 'transient', message: `X error (HTTP ${status}).` };
  return detail ? { kind: 'permanent', message: `X: ${detail}` } : null;
}

const authz = (token) => ({ authorization: `Bearer ${token}` });
const basic = (cfg) => ({ authorization: `Basic ${btoa(`${cfg.x.clientId}:${cfg.x.clientSecret}`)}` });
const api = (cfg, path) => `${cfg.urls.xApi}${path}`;
const opt = (ctx, extra = {}) => ({ headers: authz(ctx.token), classifier: classifyX, ...extra });
const category = (m) => (m.kind === 'video' ? 'tweet_video' : m.mime === 'image/gif' ? 'tweet_gif' : 'tweet_image');
const wait = (ctx, ms) => Math.min(ms, ctx.cfg.scheduler?.pollMs ?? ms);
const premium = (u) => !!u?.subscription_type && u.subscription_type !== 'None';

/** Media rows of thread item i (0 = the main post). */
const mediaOf = (ctx, i) => (i === 0 ? ctx.post.media : ctx.post.thread?.[i - 1]?.media || []);
const textOf = (ctx, i) => (i === 0 ? ctx.post.caption : ctx.post.thread?.[i - 1]?.text || '');
const norm = (s) => String(s || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();

async function tokenRequest(cfg, form) {
  const t = await request(api(cfg, '/2/oauth2/token'), { classifier: classifyX, headers: basic(cfg), form: { ...form, client_id: cfg.x.clientId } });
  return { access_token: t.access_token, refresh_token: t.refresh_token, token_expires_at: Date.now() + (Number(t.expires_in) || 7200) * 1000, scope: t.scope || '' };
}

export const x = {
  id: 'x',
  label: 'X',
  scopes: X_SCOPES,
  canRefresh: true,
  refreshMarginMs: 5 * 60000, // access tokens last 2 hours
  classifier: classifyX,
  isConfigured: (cfg) => !!(cfg.x.clientId && cfg.x.clientSecret),

  authUrl(cfg, { state, redirectUri, challenge }) {
    return `${cfg.urls.xWww}/i/oauth2/authorize?` + qs({ response_type: 'code', client_id: cfg.x.clientId, redirect_uri: redirectUri, scope: X_SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' });
  },

  async exchange(cfg, { code, redirectUri, verifier }) {
    const t = await tokenRequest(cfg, { code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: verifier });
    const granted = t.scope.split(/\s+/).filter(Boolean);
    const missing = X_SCOPES.filter((s) => !granted.includes(s));
    if (granted.length && missing.length) throw new ProviderError('permanent', `X did not grant: ${missing.join(', ')}. Connect again and approve every permission.`);
    if (!t.refresh_token) throw new ProviderError('permanent', 'X did not return a refresh token (offline.access). Connect again.');
    const me = await request(api(cfg, '/2/users/me?') + qs({ 'user.fields': 'profile_image_url,subscription_type,verified_type,public_metrics' }), { headers: authz(t.access_token), classifier: classifyX });
    const u = me.data || {};
    return [{
      external_id: String(u.id), name: u.name || u.username || 'X account', username: u.username || '', picture: u.profile_image_url || '',
      access_token: t.access_token, refresh_token: t.refresh_token, token_expires_at: t.token_expires_at,
      meta: { premium: premium(u), subscription_type: u.subscription_type || 'None' },
    }];
  },

  /** X rotates refresh tokens: the new one replaces the old (integrations.refresh is single-flight per account). */
  async refresh(cfg, integration) {
    if (!integration.refresh_token) throw new ProviderError('auth', 'No X refresh token stored; reconnect the X account.');
    const t = await tokenRequest(cfg, { refresh_token: integration.refresh_token, grant_type: 'refresh_token' });
    return { access_token: t.access_token, refresh_token: t.refresh_token || integration.refresh_token, token_expires_at: t.token_expires_at };
  },

  async healthCheck(ctx) {
    const me = await request(api(ctx.cfg, '/2/users/me'), opt(ctx));
    if (String(me.data?.id) !== String(ctx.integration.external_id)) throw new ProviderError('disconnect', 'The X login now belongs to a different account; reconnect.');
  },

  // ---- publishing: item 0 = the post, items 1.. = thread replies -----------------------------------
  async publishStart(ctx) {
    const n = 1 + (ctx.post.thread?.length || 0);
    return { status: 'pending', delayMs: 0, data: { n, i: 0, m: 0, cur: null, mediaIds: [], tweetIds: [], processing: null } };
  },

  /** Waits for video processing (finalize → processing_info), then hands back to finalize. */
  async publishCheck(ctx, data) {
    if (!data.processing) return { status: 'ready', data };
    const r = await request(api(ctx.cfg, '/2/media/upload?') + qs({ command: 'STATUS', media_id: data.processing.id }), opt(ctx));
    const p = r.data?.processing_info || {};
    if (p.state === 'failed') throw new ProviderError('permanent', `X could not process the video: ${p.error?.message || p.error?.name || 'processing failed'}.`);
    if (p.state && p.state !== 'succeeded') return { status: 'pending', delayMs: wait(ctx, Math.max(1, Number(p.check_after_secs) || 5) * 1000), data };
    return { status: 'ready', data: { ...data, processing: null } };
  },

  async publishFinalize(ctx, data) {
    const { cfg } = ctx;
    const started = Date.now();
    const out = { ...data, mediaIds: [...data.mediaIds], tweetIds: [...data.tweetIds] };
    while (out.i < out.n) {
      const items = mediaOf(ctx, out.i);
      // 1) upload this item's media, one chunked session at a time
      while (out.m < items.length) {
        const md = items[out.m];
        const size = ctx.mediaSize(md);
        if (!out.cur) {
          const init = await request(api(cfg, '/2/media/upload/initialize'), opt(ctx, { json: { media_type: md.mime, total_bytes: size, media_category: category(md) } }));
          out.cur = { id: String(init.data?.id), sent: 0, seg: 0 };
          if (!init.data?.id) throw new ProviderError('transient', 'X did not return a media id.');
        }
        while (out.cur.sent < size) {
          if (ctx.budgetLow?.() || Date.now() - started > (cfg.scheduler?.stepBudgetMs ?? 240000)) return { status: 'pending', delayMs: 0, data: out };
          const end = Math.min(out.cur.sent + SEGMENT, size) - 1;
          const bytes = await new Response(await ctx.openMedia(md, out.cur.sent, end)).arrayBuffer();
          const fd = new FormData();
          fd.append('segment_index', String(out.cur.seg));
          fd.append('media', new Blob([bytes], { type: md.mime }), 'segment');
          await request(api(cfg, `/2/media/upload/${out.cur.id}/append`), opt(ctx, { method: 'POST', body: fd, label: 'uploading media to X' }));
          out.cur.sent = end + 1;
          out.cur.seg++;
          await ctx.heartbeat?.();
        }
        const fin = await request(api(cfg, `/2/media/upload/${out.cur.id}/finalize`), opt(ctx, { method: 'POST' }));
        const id = out.cur.id;
        (out.mediaIds[out.i] ||= []).push(id);
        out.m++;
        out.cur = null;
        const p = fin.data?.processing_info;
        if (p && p.state !== 'succeeded') return { status: 'pending', delayMs: wait(ctx, Math.max(1, Number(p.check_after_secs) || 2) * 1000), data: { ...out, processing: { id } } };
      }
      // 2) create the post (a reply to the previous one inside a thread)
      const body = { text: textOf(ctx, out.i) };
      if (out.mediaIds[out.i]?.length) body.media = { media_ids: out.mediaIds[out.i] };
      if (out.i > 0) body.reply = { in_reply_to_tweet_id: out.tweetIds[out.i - 1] };
      else if (ctx.post.settings.reply_settings) body.reply_settings = ctx.post.settings.reply_settings;
      const label = out.i === 0 ? 'creating the post on X' : `posting thread reply ${out.i + 1}/${out.n}`;
      await ctx.irreversible(label);
      const r = await request(api(cfg, '/2/tweets'), opt(ctx, { json: body, irreversible: true, label }));
      out.tweetIds.push(String(r.data?.id));
      out.i++;
      out.m = 0;
      // persist after every post so an interruption never re-posts an item that already went live
      if (out.i < out.n) return { status: 'pending', delayMs: 0, data: out };
    }
    const handle = ctx.integration.username || 'i';
    return { status: 'completed', externalId: out.tweetIds[0], url: `https://x.com/${handle}/status/${out.tweetIds[0]}` };
  },

  /** After an interrupted POST /2/tweets: look for the item among the account's latest posts (owned read). */
  async recover(ctx, data) {
    if (!data || data.i >= data.n) return data ? { status: 'ready', data } : null;
    const want = norm(textOf(ctx, data.i));
    const r = await request(api(ctx.cfg, `/2/users/${ctx.integration.external_id}/tweets?`) + qs({ max_results: 5, 'tweet.fields': 'created_at,text' }), opt(ctx));
    const hit = (r.data || []).find((t) => norm(t.text) === want);
    if (!hit) return { status: 'ready', data }; // not live: posting again is safe (X also rejects exact duplicates)
    const next = { ...data, tweetIds: [...data.tweetIds, String(hit.id)], i: data.i + 1, m: 0, cur: null };
    return { status: 'ready', data: next };
  },

  // ---- analytics --------------------------------------------------------------------------
  async accountAnalytics(ctx) {
    const out = { daily: [], snapshot: {}, unavailable: {}, sources: {}, notices: [] };
    const me = await request(api(ctx.cfg, '/2/users/me?') + qs({ 'user.fields': 'public_metrics' }), opt(ctx));
    const pm = me.data?.public_metrics || {};
    if (pm.followers_count !== undefined) out.snapshot.followers = Number(pm.followers_count);
    if (pm.following_count !== undefined) out.snapshot.following = Number(pm.following_count);
    if (pm.tweet_count !== undefined) out.snapshot.media_count = Number(pm.tweet_count);
    // The X API has no account-level daily series; net followers come from the daily snapshots.
    out.derived = { net_followers: 'followers' };
    out.rollup = { post_views: 'views' }; // Σ impressions of the recent posts in this sync
    return out;
  },

  /** Latest posts with public metrics in ONE owned read (X bills reads per post; owned reads are cheapest). */
  async recentPosts(ctx, limit) {
    const n = Math.max(5, Math.min(100, ctx.cfg.xAnalyticsPosts || limit || 10));
    const r = await request(api(ctx.cfg, `/2/users/${ctx.integration.external_id}/tweets?`) + qs({
      max_results: n, exclude: 'retweets,replies', 'tweet.fields': 'created_at,public_metrics,attachments', expansions: 'attachments.media_keys', 'media.fields': 'type,preview_image_url,url',
    }), opt(ctx));
    const media = new Map((r.includes?.media || []).map((m) => [m.media_key, m]));
    const handle = ctx.integration.username || 'i';
    return (r.data || []).map((t) => {
      const ms = (t.attachments?.media_keys || []).map((k) => media.get(k)).filter(Boolean);
      return {
        external_id: String(t.id), caption: t.text || '', permalink: `https://x.com/${handle}/status/${t.id}`, published_at: Date.parse(t.created_at) || null,
        thumbnail: ms[0]?.preview_image_url || ms[0]?.url || '', kind: ms.some((m) => m.type === 'video') ? 'video' : ms.length ? 'photo' : 'post',
        public_metrics: t.public_metrics || null,
      };
    });
  },

  async postAnalytics(ctx, item) {
    const metrics = {};
    const unavailable = {};
    const put = (pm) => {
      if (!pm) return;
      if (pm.impression_count !== undefined) { metrics.views = Number(pm.impression_count); metrics.impressions = Number(pm.impression_count); }
      if (pm.like_count !== undefined) metrics.likes = Number(pm.like_count);
      if (pm.reply_count !== undefined) metrics.comments = Number(pm.reply_count);
      if (pm.retweet_count !== undefined) metrics.reposts = Number(pm.retweet_count);
      if (pm.quote_count !== undefined) metrics.quotes = Number(pm.quote_count);
      if (pm.bookmark_count !== undefined) metrics.bookmarks = Number(pm.bookmark_count);
    };
    put(item.public_metrics);
    // Non-public metrics (link/profile clicks, engagements) exist only for your own posts from the last 30 days.
    const recent = item.published_at && Date.now() - item.published_at < 29 * 86400000;
    if (!item.public_metrics || recent) {
      const fields = recent ? 'public_metrics,non_public_metrics' : 'public_metrics';
      try {
        const r = await request(api(ctx.cfg, `/2/tweets/${item.external_id}?`) + qs({ 'tweet.fields': fields }), opt(ctx));
        put(r.data?.public_metrics);
        const np = r.data?.non_public_metrics;
        if (np) {
          if (np.url_link_clicks !== undefined) metrics.clicks = Number(np.url_link_clicks);
          if (np.user_profile_clicks !== undefined) metrics.profile_clicks = Number(np.user_profile_clicks);
          if (np.engagements !== undefined) metrics.engagements = Number(np.engagements);
        }
        if (r.errors?.length && !r.data) unavailable.views = `X: ${r.errors[0].detail || r.errors[0].message || 'post not found'}`;
      } catch (e) {
        if (e.kind === 'auth' && e.status === 401) throw e;
        unavailable.clicks = `X: ${e.message}`.slice(0, 200);
      }
    } else unavailable.clicks = 'X shares link clicks only for posts from the last 30 days';
    return { metrics, unavailable };
  },
};
