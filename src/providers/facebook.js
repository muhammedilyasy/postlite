// Facebook Pages provider (Facebook Login → Page access tokens).
// Flows modeled on Postiz's public Facebook integration and Meta's Pages API docs.
import { request, qs, ProviderError } from './http.js';
import { classifyFacebook, isMetricUnavailable } from './meta-errors.js';

export const FACEBOOK_SCOPES = [
  'pages_show_list',
  'business_management',
  'pages_manage_posts',
  'pages_manage_engagement',
  'pages_read_engagement',
  'read_insights',
];

const g = (cfg, path) => `${cfg.urls.graph}/${cfg.graphVersion}/${path.replace(/^\//, '')}`;

/** Shared Meta OAuth helpers (Facebook Login) used by the Facebook and Instagram(FB) providers. */
export const metaOAuth = {
  authUrl(cfg, { state, redirectUri, scopes }) {
    return `${cfg.urls.facebookWww}/${cfg.graphVersion}/dialog/oauth?` + qs({
      client_id: cfg.meta.appId, redirect_uri: redirectUri, state, response_type: 'code', scope: scopes.join(','),
    });
  },
  async exchange(cfg, { code, redirectUri, scopes, classifier }) {
    const short = await request(g(cfg, 'oauth/access_token') + '?' + qs({
      client_id: cfg.meta.appId, client_secret: cfg.meta.appSecret, redirect_uri: redirectUri, code,
    }), { classifier });
    const long = await request(g(cfg, 'oauth/access_token') + '?' + qs({
      grant_type: 'fb_exchange_token', client_id: cfg.meta.appId, client_secret: cfg.meta.appSecret, fb_exchange_token: short.access_token,
    }), { classifier });
    const userToken = long.access_token;
    const perms = await request(g(cfg, 'me/permissions') + '?' + qs({ access_token: userToken }), { classifier });
    const granted = (perms.data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
    const missing = scopes.filter((s) => !granted.includes(s));
    if (missing.length) throw new ProviderError('permanent', `Missing permissions: ${missing.join(', ')}. Reconnect and allow all requested permissions.`);
    const expiresAt = long.expires_in ? Date.now() + long.expires_in * 1000 : Date.now() + 59 * 86400000;
    return { userToken, expiresAt };
  },
  /** All pages the user manages: /me/accounts plus Business Manager owned/client pages (deduplicated). */
  async pages(cfg, userToken, fields, classifier) {
    const seen = new Map();
    const crawl = async (url) => {
      let next = url;
      let guard = 0;
      while (next && guard++ < 50) {
        const r = await request(next, { classifier });
        for (const p of r.data || []) if (!seen.has(p.id)) seen.set(p.id, p);
        next = r.paging?.next;
      }
    };
    await crawl(g(cfg, 'me/accounts') + '?' + qs({ fields, limit: 100, access_token: userToken }));
    try {
      let next = g(cfg, 'me/businesses') + '?' + qs({ access_token: userToken });
      let guard = 0;
      while (next && guard++ < 20) {
        const r = await request(next, { classifier });
        for (const b of r.data || []) {
          for (const edge of ['owned_pages', 'client_pages']) {
            try { await crawl(g(cfg, `${b.id}/${edge}`) + '?' + qs({ fields, limit: 100, access_token: userToken })); } catch {}
          }
        }
        next = r.paging?.next;
      }
    } catch {
      // Business Manager API is optional
    }
    return [...seen.values()];
  },
};

const hasVideo = (media) => media.some((m) => m.kind === 'video');

export const facebook = {
  id: 'facebook',
  label: 'Facebook Page',
  scopes: FACEBOOK_SCOPES,
  canRefresh: false,
  classifier: classifyFacebook,
  isConfigured: (cfg) => !!(cfg.meta.appId && cfg.meta.appSecret),

  authUrl(cfg, { state, redirectUri }) {
    return metaOAuth.authUrl(cfg, { state, redirectUri, scopes: FACEBOOK_SCOPES });
  },

  async exchange(cfg, { code, redirectUri }) {
    const { userToken, expiresAt } = await metaOAuth.exchange(cfg, { code, redirectUri, scopes: FACEBOOK_SCOPES, classifier: classifyFacebook });
    const pages = await metaOAuth.pages(cfg, userToken, 'id,username,name,access_token,picture.type(large)', classifyFacebook);
    return pages
      .filter((p) => p.access_token)
      .map((p) => ({
        external_id: String(p.id),
        name: p.name,
        username: p.username || '',
        picture: p.picture?.data?.url || '',
        access_token: p.access_token, // page tokens derived from a long-lived user token do not expire
        refresh_token: userToken,
        token_expires_at: null,
        meta: { user_token_expires_at: expiresAt },
      }));
  },

  async healthCheck(ctx) {
    await request(g(ctx.cfg, ctx.integration.external_id) + '?' + qs({ fields: 'id,name', access_token: ctx.token }), { classifier: classifyFacebook });
  },

  // ---- publishing state machine -------------------------------------------------------------
  async publishStart(ctx) {
    const { cfg, post } = ctx;
    const page = ctx.integration.external_id;
    const s = post.settings;
    const type = s.post_type || 'post';
    const tok = ctx.token;
    const opt = { classifier: classifyFacebook, timeoutMs: cfg.fetchTimeoutMs };

    if (type === 'story') {
      // Upload everything first (invisible), publish one story per finalize call.
      const items = [];
      for (const m of post.media) {
        if (m.kind === 'video') {
          const st = await request(g(cfg, `${page}/video_stories`) + '?' + qs({ access_token: tok }), { ...opt, method: 'POST', form: { upload_phase: 'start' } });
          await request(st.upload_url, { ...opt, method: 'POST', headers: { authorization: `OAuth ${tok}`, file_url: ctx.mediaUrl(m) } });
          items.push({ kind: 'video', mediaId: String(st.video_id) });
        } else {
          const ph = await request(g(cfg, `${page}/photos`) + '?' + qs({ access_token: tok }), { ...opt, json: { url: ctx.mediaUrl(m), published: false } });
          items.push({ kind: 'photo', mediaId: String(ph.id) });
        }
      }
      return { status: 'pending', delayMs: 0, data: { type: 'story', items, published: 0, lastId: '' } };
    }

    if (type === 'reel') {
      const v = post.media[0];
      const st = await request(g(cfg, `${page}/video_reels`) + '?' + qs({ access_token: tok }), { ...opt, method: 'POST', form: { upload_phase: 'start' } });
      await request(st.upload_url, { ...opt, method: 'POST', headers: { authorization: `OAuth ${tok}`, file_url: ctx.mediaUrl(v) } });
      return { status: 'pending', delayMs: 0, data: { type: 'reel', videoId: String(st.video_id) } };
    }

    // Regular feed post
    if (hasVideo(post.media)) {
      await ctx.irreversible('publishing video');
      const r = await request(g(cfg, `${page}/videos`) + '?' + qs({ access_token: tok, fields: 'id,permalink_url' }), {
        ...opt, irreversible: true, label: 'publishing the video',
        json: { file_url: ctx.mediaUrl(post.media[0]), description: post.caption, ...(s.title ? { title: s.title } : {}), published: true },
      });
      const url = r.permalink_url ? (r.permalink_url.startsWith('http') ? r.permalink_url : `https://www.facebook.com${r.permalink_url}`) : `https://www.facebook.com/${page}/videos/${r.id}`;
      return { status: 'completed', externalId: String(r.id), url };
    }
    const attached = [];
    for (const m of post.media) {
      const ph = await request(g(cfg, `${page}/photos`) + '?' + qs({ access_token: tok }), { ...opt, json: { url: ctx.mediaUrl(m), published: false } });
      attached.push({ media_fbid: String(ph.id) });
    }
    await ctx.irreversible('publishing feed post');
    const r = await request(g(cfg, `${page}/feed`) + '?' + qs({ access_token: tok, fields: 'id,permalink_url' }), {
      ...opt, irreversible: true, label: 'publishing the post',
      json: {
        message: post.caption,
        ...(attached.length ? { attached_media: attached } : {}),
        ...(!attached.length && s.url ? { link: s.url } : {}),
        published: true,
      },
    });
    return { status: 'completed', externalId: String(r.id), url: r.permalink_url || `https://www.facebook.com/${r.id}` };
  },

  async videoReady(ctx, videoId) {
    const r = await request(g(ctx.cfg, videoId) + '?' + qs({ fields: 'status', access_token: ctx.token }), { classifier: classifyFacebook });
    const st = r.status || {};
    if (st.video_status === 'error' || st.processing_phase?.status === 'error' || st.uploading_phase?.status === 'error') {
      const why = st.processing_phase?.errors?.[0]?.message || st.uploading_phase?.errors?.[0]?.message || 'Facebook could not process the video.';
      throw new ProviderError('permanent', why);
    }
    // For reels/stories we only need the upload to be complete before finishing.
    return st.uploading_phase?.status === 'complete' || ['ready', 'upload_complete', 'processing'].includes(st.video_status);
  },

  async publishCheck(ctx, data) {
    if (data.type === 'reel') {
      return (await this.videoReady(ctx, data.videoId)) ? { status: 'ready', data } : { status: 'pending', data };
    }
    if (data.type === 'story') {
      for (const it of data.items.slice(data.published)) {
        if (it.kind === 'video' && !(await this.videoReady(ctx, it.mediaId))) return { status: 'pending', data };
      }
      return { status: 'ready', data };
    }
    return { status: 'ready', data };
  },

  async publishFinalize(ctx, data) {
    const { cfg } = ctx;
    const page = ctx.integration.external_id;
    const tok = ctx.token;
    const opt = { classifier: classifyFacebook, timeoutMs: cfg.fetchTimeoutMs, irreversible: true };
    if (data.type === 'reel') {
      await ctx.irreversible('publishing reel');
      await request(g(cfg, `${page}/video_reels`) + '?' + qs({ access_token: tok }), {
        ...opt, method: 'POST', label: 'publishing the reel',
        form: { upload_phase: 'finish', video_id: data.videoId, video_state: 'PUBLISHED', description: ctx.post.caption, ...(ctx.post.settings.title ? { title: ctx.post.settings.title } : {}) },
      });
      return { status: 'completed', externalId: data.videoId, url: `https://www.facebook.com/reel/${data.videoId}` };
    }
    if (data.type === 'story') {
      const it = data.items[data.published];
      await ctx.irreversible(`publishing story ${data.published + 1}/${data.items.length}`);
      const r = it.kind === 'video'
        ? await request(g(cfg, `${page}/video_stories`) + '?' + qs({ access_token: tok }), { ...opt, method: 'POST', label: 'publishing the story', form: { upload_phase: 'finish', video_id: it.mediaId } })
        : await request(g(cfg, `${page}/photo_stories`) + '?' + qs({ access_token: tok }), { ...opt, method: 'POST', label: 'publishing the story', form: { photo_id: it.mediaId } });
      const id = String(r.post_id || r.id || it.mediaId);
      const published = data.published + 1;
      if (published < data.items.length) return { status: 'pending', delayMs: 0, data: { ...data, published, lastId: id } };
      return { status: 'completed', externalId: id, url: `https://www.facebook.com/stories/${page}` };
    }
    throw new ProviderError('permanent', 'Unexpected Facebook publish state.');
  },

  async comment(ctx, objectId, message) {
    const r = await request(g(ctx.cfg, `${objectId}/comments`) + '?' + qs({ access_token: ctx.token }), { classifier: classifyFacebook, json: { message } });
    return String(r.id || '');
  },

  // ---- analytics ---------------------------------------------------------------------------
  async accountAnalytics(ctx, { since, until }) {
    const page = ctx.integration.external_id;
    const out = { daily: [], snapshot: {}, unavailable: {} };
    try {
      const p = await request(g(ctx.cfg, page) + '?' + qs({ fields: 'followers_count,fan_count', access_token: ctx.token }), { classifier: classifyFacebook });
      if (p.followers_count !== undefined) out.snapshot.followers = Number(p.followers_count);
      if (p.fan_count !== undefined) out.snapshot.page_likes = Number(p.fan_count);
    } catch (e) {
      if (e.kind === 'auth') throw e;
      out.unavailable.followers = e.message;
    }
    const metrics = { page_media_view: 'views', page_total_media_view_unique: 'reach', page_post_engagements: 'engagements', page_daily_follows_unique: 'new_followers', page_views_total: 'profile_views' };
    await insightsWithFallback(ctx, page, Object.keys(metrics), { period: 'day', since: Math.floor(since / 1000), until: Math.floor(until / 1000) }, (name, values) => {
      for (const v of values || []) out.daily.push({ metric: metrics[name], day: String(v.end_time || '').slice(0, 10), value: Number(typeof v.value === 'object' ? sumObj(v.value) : v.value) || 0 });
    }, (name, why) => { out.unavailable[metrics[name]] = why; });
    return out;
  },

  async recentPosts(ctx, limit) {
    const r = await request(g(ctx.cfg, `${ctx.integration.external_id}/published_posts`) + '?' + qs({ fields: 'id,message,permalink_url,created_time,full_picture', limit, access_token: ctx.token }), { classifier: classifyFacebook });
    return (r.data || []).map((p) => ({ external_id: String(p.id), caption: p.message || '', permalink: p.permalink_url || '', thumbnail: p.full_picture || '', published_at: Date.parse(p.created_time) || null, kind: 'post' }));
  },

  async postAnalytics(ctx, item) {
    const metrics = {};
    const unavailable = {};
    const isVideo = !String(item.external_id).includes('_');
    if (isVideo) {
      const names = { total_video_views: 'views', fb_reels_total_plays: 'plays', total_video_avg_time_watched: 'avg_watch_ms', post_video_likes_by_reaction_type: 'likes' };
      await insightsWithFallback(ctx, item.external_id, Object.keys(names), {}, (n, values) => { metrics[names[n]] = num(values?.[0]?.value); }, (n, why) => { unavailable[names[n]] = why; }, 'video_insights');
    } else {
      const names = { post_media_view: 'views', post_total_media_view_unique: 'reach', post_reactions_by_type_total: 'likes', post_clicks: 'clicks' };
      await insightsWithFallback(ctx, item.external_id, Object.keys(names), {}, (n, values) => { metrics[names[n]] = num(values?.[0]?.value); }, (n, why) => { unavailable[names[n]] = why; });
      try {
        const r = await request(g(ctx.cfg, item.external_id) + '?' + qs({ fields: 'shares,comments.summary(true).limit(0)', access_token: ctx.token }), { classifier: classifyFacebook });
        metrics.shares = Number(r.shares?.count || 0);
        metrics.comments = Number(r.comments?.summary?.total_count || 0);
      } catch (e) {
        if (e.kind === 'auth') throw e;
        unavailable.comments = e.message;
      }
    }
    return { metrics, unavailable };
  },
};

const sumObj = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);
const num = (v) => (v && typeof v === 'object' ? sumObj(v) : Number(v) || 0);

/**
 * Request several insights metrics at once; if Graph rejects the batch (deprecated metric,
 * missing permission), retry metrics one by one and report the failing ones as unavailable.
 */
export async function insightsWithFallback(ctx, objectId, metricNames, params, onMetric, onUnavailable, edge = 'insights', host) {
  const base = host || ctx.graphBase || `${ctx.cfg.urls.graph}/${ctx.cfg.graphVersion}`;
  const classifier = ctx.classifier || classifyFacebook;
  const call = (names) => request(`${base}/${objectId}/${edge}?` + qs({ metric: names.join(','), ...params, access_token: ctx.token }), { classifier });
  const consume = (r, names) => {
    const got = new Set();
    for (const m of r.data || []) {
      got.add(m.name);
      onMetric(m.name, m.values || (m.total_value ? [{ value: m.total_value.value }] : []));
    }
    for (const n of names) if (!got.has(n)) onUnavailable(n, 'Not returned by the API for this object');
  };
  try {
    consume(await call(metricNames), metricNames);
  } catch (e) {
    if (e.kind === 'auth') throw e;
    if (metricNames.length === 1) return onUnavailable(metricNames[0], shortReason(e));
    for (const n of metricNames) {
      try {
        consume(await call([n]), [n]);
      } catch (e2) {
        if (e2.kind === 'auth') throw e2;
        onUnavailable(n, isMetricUnavailable(e2) ? shortReason(e2) : `Error: ${e2.message}`);
      }
    }
  }
}

export const shortReason = (e) => String(e?.message || 'Not available').slice(0, 200);
