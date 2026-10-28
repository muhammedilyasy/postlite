// Instagram providers:
//   instagram             — Instagram professional account linked to a Facebook Page (Facebook Login, graph.facebook.com)
//   instagram-standalone  — Instagram API with Instagram Login (graph.instagram.com)
// Container flow: create container(s) → poll status_code until FINISHED → media_publish.
// Modeled on Postiz's public Instagram integrations and Meta's Content Publishing docs.
import { request, qs, ProviderError } from './http.js';
import { classifyInstagram } from './meta-errors.js';
import { metaOAuth, insightsWithFallback, shortReason } from './facebook.js';

export const INSTAGRAM_FB_SCOPES = [
  'instagram_basic',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
  'instagram_content_publish',
  'instagram_manage_comments',
  'instagram_manage_insights',
];

export const INSTAGRAM_STANDALONE_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_comments',
  'instagram_business_manage_insights',
];

const stripAt = (h) => String(h || '').trim().replace(/^@+/, '');
const DAY = 86400000;

function makeInstagram(variant) {
  const standalone = variant === 'instagram-standalone';
  const base = (cfg) => (standalone ? `${cfg.urls.igGraph}/${cfg.graphVersion}` : `${cfg.urls.graph}/${cfg.graphVersion}`);
  const opt = (cfg, extra = {}) => ({ classifier: classifyInstagram, timeoutMs: cfg.fetchTimeoutMs, ...extra });
  const profileUrl = (ctx) => `https://www.instagram.com/${ctx.integration.username || ''}`;

  async function containerStatus(ctx, id) {
    const r = await request(`${base(ctx.cfg)}/${id}?` + qs({ fields: 'status_code,status', access_token: ctx.token }), opt(ctx.cfg));
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
      const c = classifyInstagram(String(r.status || ''), 200);
      throw new ProviderError(c?.kind === 'disconnect' ? 'disconnect' : 'permanent', c?.message || (r.status && r.status !== r.status_code ? `Instagram could not process the media: ${r.status}` : 'Instagram could not process the media.'), { body: r });
    }
    return r.status_code || 'IN_PROGRESS';
  }

  async function permalink(ctx, mediaId) {
    try {
      const r = await request(`${base(ctx.cfg)}/${mediaId}?` + qs({ fields: 'permalink', access_token: ctx.token }), opt(ctx.cfg));
      return r.permalink || profileUrl(ctx);
    } catch {
      return profileUrl(ctx); // cosmetic only — never fail a live post over it
    }
  }

  async function mediaPublish(ctx, creationId, label) {
    await ctx.irreversible(label);
    const r = await request(`${base(ctx.cfg)}/${ctx.integration.external_id}/media_publish?` + qs({ access_token: ctx.token }), opt(ctx.cfg, { form: { creation_id: creationId }, irreversible: true, label }));
    return String(r.id);
  }

  return {
    id: variant,
    label: standalone ? 'Instagram (Instagram Login)' : 'Instagram (via Facebook Page)',
    scopes: standalone ? INSTAGRAM_STANDALONE_SCOPES : INSTAGRAM_FB_SCOPES,
    canRefresh: standalone,
    classifier: classifyInstagram,
    isConfigured: (cfg) => (standalone ? !!(cfg.instagram.appId && cfg.instagram.appSecret) : !!(cfg.meta.appId && cfg.meta.appSecret)),

    authUrl(cfg, { state, redirectUri }) {
      if (!standalone) return metaOAuth.authUrl(cfg, { state, redirectUri, scopes: INSTAGRAM_FB_SCOPES });
      return `${cfg.urls.igWww}/oauth/authorize?` + qs({
        enable_fb_login: 0, force_authentication: 1, client_id: cfg.instagram.appId, redirect_uri: redirectUri, response_type: 'code', scope: INSTAGRAM_STANDALONE_SCOPES.join(','), state,
      });
    },

    async exchange(cfg, { code, redirectUri }) {
      if (!standalone) {
        const { userToken, expiresAt } = await metaOAuth.exchange(cfg, { code, redirectUri, scopes: INSTAGRAM_FB_SCOPES, classifier: classifyInstagram });
        const pages = await metaOAuth.pages(cfg, userToken, 'id,name,access_token,instagram_business_account', classifyInstagram);
        const out = [];
        for (const p of pages.filter((x) => x.instagram_business_account?.id)) {
          const igId = String(p.instagram_business_account.id);
          const info = await request(`${base(cfg)}/${igId}?` + qs({ fields: 'username,name,profile_picture_url', access_token: userToken }), opt(cfg));
          out.push({
            external_id: igId,
            name: info.name || info.username || p.name,
            username: info.username || '',
            picture: info.profile_picture_url || '',
            access_token: p.access_token || userToken,
            refresh_token: userToken,
            token_expires_at: null,
            meta: { page_id: String(p.id), page_name: p.name, user_token_expires_at: expiresAt },
          });
        }
        return out;
      }
      const short = await request(`${cfg.urls.igApi}/oauth/access_token`, opt(cfg, {
        form: { client_id: cfg.instagram.appId, client_secret: cfg.instagram.appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code },
      }));
      const granted = Array.isArray(short.permissions) ? short.permissions : String(short.permissions || '').split(',').filter(Boolean);
      const missing = granted.length ? INSTAGRAM_STANDALONE_SCOPES.filter((s) => !granted.includes(s)) : [];
      if (missing.length) throw new ProviderError('permanent', `Missing permissions: ${missing.join(', ')}. Reconnect and allow all requested permissions.`);
      const long = await request(`${cfg.urls.igGraph}/access_token?` + qs({ grant_type: 'ig_exchange_token', client_secret: cfg.instagram.appSecret, access_token: short.access_token }), opt(cfg));
      const me = await request(`${base(cfg)}/me?` + qs({ fields: 'user_id,username,name,profile_picture_url', access_token: long.access_token }), opt(cfg));
      return [{
        external_id: String(me.user_id || me.id || short.user_id),
        name: me.name || me.username,
        username: me.username || '',
        picture: me.profile_picture_url || '',
        access_token: long.access_token,
        refresh_token: long.access_token,
        token_expires_at: Date.now() + (Number(long.expires_in) || 60 * 86400) * 1000,
        meta: {},
      }];
    },

    async refresh(cfg, integration) {
      if (!standalone) throw new ProviderError('auth', 'Instagram (Facebook) tokens cannot be refreshed; reconnect the account.');
      const r = await request(`${cfg.urls.igGraph}/refresh_access_token?` + qs({ grant_type: 'ig_refresh_token', access_token: integration.access_token }), opt(cfg));
      return { access_token: r.access_token, refresh_token: r.access_token, token_expires_at: Date.now() + (Number(r.expires_in) || 60 * 86400) * 1000 };
    },

    async healthCheck(ctx) {
      await request(`${base(ctx.cfg)}/${ctx.integration.external_id}?` + qs({ fields: 'id,username', access_token: ctx.token }), opt(ctx.cfg));
    },

    // ---- publishing -----------------------------------------------------------------------
    async publishStart(ctx) {
      const { cfg, post } = ctx;
      const s = post.settings;
      const isStory = s.post_type === 'story';
      const media = post.media;
      const collaborators = !isStory ? (s.collaborators || []).map(stripAt).filter(Boolean) : [];
      const isCarousel = !isStory && media.length > 1;
      const ig = ctx.integration.external_id;
      const containers = [];
      for (const m of media) {
        const p = {};
        if (isStory) {
          p.media_type = 'STORIES';
          p[m.kind === 'video' ? 'video_url' : 'image_url'] = ctx.mediaUrl(m);
        } else if (isCarousel) {
          p.is_carousel_item = 'true';
          if (m.kind === 'video') { p.media_type = 'VIDEO'; p.video_url = ctx.mediaUrl(m); } else p.image_url = ctx.mediaUrl(m);
        } else {
          p.caption = post.caption;
          if (collaborators.length) p.collaborators = JSON.stringify(collaborators);
          if (m.kind === 'video') {
            p.media_type = 'REELS';
            p.video_url = ctx.mediaUrl(m);
            p.share_to_feed = s.share_to_feed === false ? 'false' : 'true';
            if (s.thumb_offset) p.thumb_offset = String(Math.round(Number(s.thumb_offset)));
            if (s.is_trial_reel) p.trial_params = JSON.stringify({ graduation_strategy: s.graduation_strategy || 'MANUAL' });
          } else {
            p.image_url = ctx.mediaUrl(m);
          }
        }
        const r = await request(`${base(cfg)}/${ig}/media?` + qs({ access_token: ctx.token }), opt(cfg, { form: p, label: 'creating media container' }));
        containers.push(String(r.id));
      }
      return {
        status: 'pending',
        data: { kind: isStory ? 'stories' : isCarousel ? 'carousel' : 'single', containers, carouselId: null, published: 0, lastId: '', collaborators },
      };
    },

    async publishCheck(ctx, data) {
      if (data.carouselId) {
        const st = await containerStatus(ctx, data.carouselId);
        if (st === 'IN_PROGRESS') return { status: 'pending', data };
        if (st === 'PUBLISHED') return { status: 'completed', externalId: data.carouselId, url: profileUrl(ctx) };
        return { status: 'ready', data };
      }
      const list = data.kind === 'stories' ? data.containers.slice(data.published) : data.containers;
      for (const id of list) {
        const st = await containerStatus(ctx, id);
        if (st === 'IN_PROGRESS') return { status: 'pending', data };
        if (st === 'PUBLISHED' && data.kind === 'single') return { status: 'completed', externalId: id, url: profileUrl(ctx) };
      }
      return { status: 'ready', data };
    },

    async publishFinalize(ctx, data) {
      const { cfg, post } = ctx;
      if (data.kind === 'carousel' && !data.carouselId) {
        // Orphan carousel containers are invisible, so re-creating on retry is safe.
        const r = await request(`${base(cfg)}/${ctx.integration.external_id}/media?` + qs({ access_token: ctx.token }), opt(cfg, {
          form: { media_type: 'CAROUSEL', children: data.containers.join(','), caption: post.caption, ...(data.collaborators?.length ? { collaborators: JSON.stringify(data.collaborators) } : {}) },
          label: 'creating carousel container',
        }));
        return { status: 'pending', delayMs: 0, data: { ...data, carouselId: String(r.id) } };
      }
      if (data.kind === 'stories') {
        const cid = data.containers[data.published];
        const id = await mediaPublish(ctx, cid, `publishing story ${data.published + 1}/${data.containers.length}`);
        const published = data.published + 1;
        if (published < data.containers.length) return { status: 'pending', delayMs: 0, data: { ...data, published, lastId: id } };
        return { status: 'completed', externalId: id, url: await permalink(ctx, id) };
      }
      const creation = data.kind === 'carousel' ? data.carouselId : data.containers[0];
      const id = await mediaPublish(ctx, creation, 'publishing to Instagram');
      return { status: 'completed', externalId: id, url: await permalink(ctx, id) };
    },

    /** Crash recovery: containers report PUBLISHED once live, so we can tell whether publish happened. */
    async recover(ctx, data) {
      if (!data) return null;
      if (data.kind === 'stories') {
        const st = await containerStatus(ctx, data.containers[data.published]);
        if (st === 'PUBLISHED') {
          const published = data.published + 1;
          if (published >= data.containers.length) return { status: 'completed', externalId: data.containers[data.published], url: profileUrl(ctx) };
          return { status: 'ready', data: { ...data, published } };
        }
        return { status: 'ready', data };
      }
      const target = data.kind === 'carousel' ? data.carouselId : data.containers[0];
      if (!target) return { status: 'ready', data };
      const st = await containerStatus(ctx, target);
      if (st === 'PUBLISHED') return { status: 'completed', externalId: target, url: profileUrl(ctx) };
      return { status: 'ready', data };
    },

    async comment(ctx, mediaId, message) {
      const r = await request(`${base(ctx.cfg)}/${mediaId}/comments?` + qs({ access_token: ctx.token }), opt(ctx.cfg, { form: { message } }));
      return String(r.id || '');
    },

    // ---- analytics ------------------------------------------------------------------------
    async accountAnalytics(ctx, { since, until }) {
      const ig = ctx.integration.external_id;
      const out = { daily: [], snapshot: {}, unavailable: {} };
      const actx = { ...ctx, graphBase: base(ctx.cfg), classifier: classifyInstagram };
      try {
        const r = await request(`${base(ctx.cfg)}/${ig}?` + qs({ fields: 'followers_count,follows_count,media_count', access_token: ctx.token }), opt(ctx.cfg));
        if (r.followers_count !== undefined) out.snapshot.followers = Number(r.followers_count);
        if (r.follows_count !== undefined) out.snapshot.following = Number(r.follows_count);
        if (r.media_count !== undefined) out.snapshot.media_count = Number(r.media_count);
      } catch (e) {
        if (e.kind === 'auth') throw e;
        out.unavailable.followers = shortReason(e);
      }
      // time-series metrics (reach; follower_count is only kept for the last 30 days by Meta)
      const ts = { reach: 'reach', follower_count: 'new_followers' };
      const s30 = Math.max(since, Date.now() - 29 * DAY);
      await insightsWithFallback(actx, ig, Object.keys(ts), { period: 'day', since: Math.floor(s30 / 1000), until: Math.floor(until / 1000) }, (n, values) => {
        for (const v of values || []) if (v.end_time) out.daily.push({ metric: ts[n], day: String(v.end_time).slice(0, 10), value: Number(v.value) || 0 });
      }, (n, why) => { out.unavailable[ts[n]] = why; });
      // total_value metrics, fetched per day so we can build a daily series
      const tv = { views: 'views', profile_views: 'profile_views', accounts_engaged: 'accounts_engaged', total_interactions: 'interactions', likes: 'likes', comments: 'comments', shares: 'shares', saves: 'saves' };
      const dayStart = (t) => Math.floor(t / DAY) * DAY;
      let names = Object.keys(tv);
      for (let d = dayStart(s30); d < dayStart(until) + DAY && d < Date.now(); d += DAY) {
        const day = new Date(d).toISOString().slice(0, 10);
        const failed = [];
        await insightsWithFallback(actx, ig, names, { metric_type: 'total_value', period: 'day', since: Math.floor(d / 1000), until: Math.floor((d + DAY) / 1000) }, (n, values) => {
          out.daily.push({ metric: tv[n], day, value: Number(values?.[0]?.value) || 0 });
        }, (n, why) => { out.unavailable[tv[n]] = why; failed.push(n); });
        names = names.filter((n) => !failed.includes(n)); // don't keep asking for unavailable metrics
        if (!names.length) break;
      }
      return out;
    },

    async recentPosts(ctx, limit) {
      const r = await request(`${base(ctx.cfg)}/${ctx.integration.external_id}/media?` + qs({ fields: 'id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url', limit, access_token: ctx.token }), opt(ctx.cfg));
      return (r.data || []).map((m) => ({
        external_id: String(m.id), caption: m.caption || '', permalink: m.permalink || '', thumbnail: m.thumbnail_url || (m.media_type === 'IMAGE' || m.media_type === 'CAROUSEL_ALBUM' ? m.media_url : '') || '',
        published_at: Date.parse(m.timestamp) || null, kind: m.media_product_type === 'REELS' ? 'reel' : m.media_product_type === 'STORY' ? 'story' : (m.media_type || 'post').toLowerCase(),
      }));
    },

    /** thumbnail_url for VIDEO / REELS, media_url for images. */
    async thumbnailFor(ctx, item) {
      const m = await request(`${base(ctx.cfg)}/${item.external_id}?` + qs({ fields: 'media_type,thumbnail_url,media_url', access_token: ctx.token }), opt(ctx.cfg));
      return m.thumbnail_url || (m.media_type === 'VIDEO' ? '' : m.media_url) || '';
    },

    async postAnalytics(ctx, item) {
      const metrics = {};
      const unavailable = {};
      const names = { views: 'views', reach: 'reach', likes: 'likes', comments: 'comments', shares: 'shares', saved: 'saves', total_interactions: 'interactions' };
      if (item.kind === 'reel') { names.ig_reels_avg_watch_time = 'avg_watch_ms'; names.ig_reels_video_view_total_time = 'watch_time_ms'; }
      if (item.kind === 'story') { delete names.likes; delete names.saved; delete names.comments; names.replies = 'replies'; }
      const actx = { ...ctx, graphBase: base(ctx.cfg), classifier: classifyInstagram };
      await insightsWithFallback(actx, item.external_id, Object.keys(names), {}, (n, values) => { metrics[names[n]] = Number(values?.[0]?.value) || 0; }, (n, why) => { unavailable[names[n]] = why; });
      return { metrics, unavailable };
    },
  };
}

export const instagram = makeInstagram('instagram');
export const instagramStandalone = makeInstagram('instagram-standalone');
