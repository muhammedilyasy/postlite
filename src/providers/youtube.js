// YouTube provider: Google OAuth (offline + refresh), resumable uploads via plain REST.
// Modeled on Postiz's public YouTube integration and the YouTube Data/Analytics API docs.
import { meteredFetch } from '../meter.js';
import { request, qs, ProviderError, classifyHttp } from './http.js';
import { shortReason } from './facebook.js';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

const REASONS = {
  quotaExceeded: ['permanent', 'YouTube API daily quota is exhausted for this Google Cloud project; reschedule for after midnight Pacific time.'],
  dailyLimitExceeded: ['permanent', 'YouTube API daily quota is exhausted; reschedule for later.'],
  defaultVideoInsertPerDayPerProject: ['permanent', 'YouTube daily upload quota for this project is exhausted; reschedule for later.'],
  uploadLimitExceeded: ['permanent', 'This channel reached its daily upload limit; try again tomorrow.'],
  rateLimitExceeded: ['transient', 'YouTube rate limit reached; will retry.'],
  userRateLimitExceeded: ['transient', 'YouTube rate limit reached; will retry.'],
  backendError: ['transient', 'YouTube backend error; will retry.'],
  invalidTitle: ['permanent', 'YouTube rejected the title (empty, too long or invalid characters).'],
  invalidDescription: ['permanent', 'YouTube rejected the description (it may contain < or >).'],
  invalidTags: ['permanent', 'YouTube rejected the tags (500 characters total max).'],
  invalidCategoryId: ['permanent', 'Invalid YouTube category.'],
  invalidVideoMetadata: ['permanent', 'YouTube rejected the video details; review title, description and tags.'],
  mediaBodyRequired: ['permanent', 'The video file was missing or unreadable; re-upload it.'],
  invalidFilename: ['permanent', 'Invalid video file name.'],
  youtubeSignupRequired: ['disconnect', 'This Google account has no YouTube channel; create one, then reconnect.'],
  imageFormatUnsupported: ['permanent', 'Thumbnail must be JPEG or PNG.'],
  imageTooTall: ['permanent', 'Thumbnail image is too tall.'],
  imageTooWide: ['permanent', 'Thumbnail image is too wide.'],
  mediaBodyTooBig: ['permanent', 'Thumbnail must be under 2 MB.'],
  forbidden: ['permanent', 'YouTube refused the request (custom thumbnails need a phone-verified channel).'],
  insufficientPermissions: ['auth', 'Missing YouTube permissions; reconnect and grant all requested scopes.'],
  authError: ['auth', 'YouTube authorization failed; reconnect the channel.'],
};

export function classifyGoogle(body, status) {
  let j = null;
  try { j = JSON.parse(body); } catch {}
  if (j && typeof j.error === 'string') {
    if (j.error === 'invalid_grant') return { kind: 'auth', message: 'Google refresh token is invalid or revoked; reconnect the YouTube channel.' };
    return { kind: status >= 500 ? 'transient' : 'permanent', message: j.error_description || j.error };
  }
  const reason = j?.error?.errors?.[0]?.reason;
  if (reason && REASONS[reason]) return { kind: REASONS[reason][0], message: REASONS[reason][1] };
  if (status === 401 || j?.error?.status === 'UNAUTHENTICATED') return { kind: 'auth', message: 'YouTube access token expired or invalid.' };
  return null;
}

const authz = (token) => ({ authorization: `Bearer ${token}` });

async function raw(url, init, cfg) {
  let res;
  try {
    res = await meteredFetch(url, { ...init, signal: init.signal || AbortSignal.timeout(cfg.fetchTimeoutMs) });
  } catch (e) {
    throw new ProviderError('transient', `Network error talking to YouTube: ${e.cause?.code || e.message}`);
  }
  return res;
}

async function failFrom(res, fallback) {
  const text = await res.text().catch(() => '');
  const c = classifyHttp(res.status, text, classifyGoogle);
  throw new ProviderError(c.kind, c.message || fallback, { status: res.status, body: text });
}

/** Ask the resumable session where it is: {videoId} if complete, else {uploaded}. */
async function probe(ctx, uploadUri, size) {
  const res = await raw(uploadUri, { method: 'PUT', headers: { ...authz(ctx.token), 'content-range': `bytes */${size}`, 'content-length': '0' } }, ctx.cfg);
  if (res.status === 200 || res.status === 201) return { videoId: String((await res.json()).id) };
  if (res.status === 308) {
    const range = res.headers.get('range');
    await res.arrayBuffer().catch(() => {});
    return { uploaded: range ? Number(range.split('-')[1]) + 1 : 0 };
  }
  if (res.status === 404 || res.status === 410) {
    await res.arrayBuffer().catch(() => {});
    throw new ProviderError('permanent', 'The YouTube upload session expired before the upload finished; post again.');
  }
  return failFrom(res, 'Could not check the YouTube upload status.');
}

export const youtube = {
  id: 'youtube',
  label: 'YouTube',
  scopes: YOUTUBE_SCOPES,
  canRefresh: true,
  classifier: classifyGoogle,
  isConfigured: (cfg) => !!(cfg.google.clientId && cfg.google.clientSecret),

  authUrl(cfg, { state, redirectUri, challenge }) {
    return `${cfg.urls.googleAuth}/o/oauth2/v2/auth?` + qs({
      client_id: cfg.google.clientId, redirect_uri: redirectUri, response_type: 'code', scope: YOUTUBE_SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
      ...(challenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
    });
  },

  async exchange(cfg, { code, redirectUri, verifier }) {
    const t = await request(`${cfg.urls.googleToken}/token`, {
      classifier: classifyGoogle,
      form: { code, client_id: cfg.google.clientId, client_secret: cfg.google.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', ...(verifier ? { code_verifier: verifier } : {}) },
    });
    const granted = String(t.scope || '').split(/\s+/);
    const missing = YOUTUBE_SCOPES.filter((s) => !granted.includes(s));
    if (t.scope && missing.length) throw new ProviderError('permanent', `Missing Google permissions: ${missing.map((s) => s.split('/').pop()).join(', ')}. Reconnect and tick all checkboxes.`);
    if (!t.refresh_token) throw new ProviderError('permanent', 'Google did not return a refresh token. Remove postlite from https://myaccount.google.com/permissions and connect again.');
    const ch = await request(`${cfg.urls.youtube}/youtube/v3/channels?` + qs({ part: 'snippet,statistics', mine: 'true' }), { headers: authz(t.access_token), classifier: classifyGoogle });
    if (!ch.items?.length) throw new ProviderError('permanent', 'No YouTube channel found for this Google account.');
    return ch.items.map((c) => ({
      external_id: String(c.id),
      name: c.snippet?.title || 'YouTube channel',
      username: c.snippet?.customUrl || '',
      picture: c.snippet?.thumbnails?.default?.url || '',
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      token_expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000,
      meta: {},
    }));
  },

  async refresh(cfg, integration) {
    const t = await request(`${cfg.urls.googleToken}/token`, {
      classifier: classifyGoogle,
      form: { client_id: cfg.google.clientId, client_secret: cfg.google.clientSecret, refresh_token: integration.refresh_token, grant_type: 'refresh_token' },
    });
    return { access_token: t.access_token, refresh_token: t.refresh_token || integration.refresh_token, token_expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  },

  async healthCheck(ctx) {
    const r = await request(`${ctx.cfg.urls.youtube}/youtube/v3/channels?` + qs({ part: 'id', mine: 'true' }), { headers: authz(ctx.token), classifier: classifyGoogle });
    if (!(r.items || []).some((c) => String(c.id) === ctx.integration.external_id)) throw new ProviderError('disconnect', 'This channel is no longer accessible with the connected Google account.');
  },

  // ---- publishing -----------------------------------------------------------------------
  async publishStart(ctx) {
    const { cfg, post } = ctx;
    const s = post.settings;
    const video = post.media[0];
    const size = ctx.mediaSize(video);
    const url = `${cfg.urls.youtube}/upload/youtube/v3/videos?` + qs({ uploadType: 'resumable', part: 'snippet,status', notifySubscribers: s.notifySubscribers === false ? 'false' : 'true' });
    const tags = (s.tags || []).map((t) => String(t).trim()).filter(Boolean);
    const res = await raw(url, {
      method: 'POST',
      headers: { ...authz(ctx.token), 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': video.mime, 'x-upload-content-length': String(size) },
      body: JSON.stringify({
        snippet: { title: s.title, description: post.caption, ...(tags.length ? { tags } : {}), categoryId: String(s.categoryId || '22') },
        status: { privacyStatus: s.privacy || 'public', selfDeclaredMadeForKids: s.madeForKids === 'yes' },
      }),
    }, cfg);
    if (!res.ok) return failFrom(res, 'Could not start the YouTube upload.');
    await res.arrayBuffer().catch(() => {});
    const uploadUri = res.headers.get('location');
    if (!uploadUri) throw new ProviderError('transient', 'YouTube did not return an upload session URL.');
    return { status: 'pending', delayMs: 0, data: { uploadUri, size, uploaded: 0, videoId: null, thumbnailId: post.thumbnail?.id || null } };
  },

  async publishCheck(ctx, data) {
    if (data.videoId) return { status: 'ready', data };
    const p = await probe(ctx, data.uploadUri, data.size);
    if (p.videoId) return { status: 'ready', data: { ...data, videoId: p.videoId } };
    return { status: 'ready', data: { ...data, uploaded: p.uploaded } };
  },

  async publishFinalize(ctx, data) {
    const { cfg } = ctx;
    let videoId = data.videoId;
    if (!videoId) {
      const p = await probe(ctx, data.uploadUri, data.size);
      if (p.videoId) videoId = p.videoId;
      else {
        let uploaded = p.uploaded;
        const chunk = Math.max(256 * 1024, Math.floor(cfg.youtubeChunkBytes / (256 * 1024)) * 256 * 1024);
        const started = Date.now();
        const video = ctx.post.media[0];
        while (uploaded < data.size) {
          if (Date.now() - started > (cfg.scheduler?.stepBudgetMs ?? 4 * 60000)) return { status: 'pending', delayMs: 0, data: { ...data, uploaded } };
          // Workers: stop between chunks when the invocation's subrequest budget runs low; the next tick resumes.
          if (ctx.budgetLow?.()) return { status: 'pending', delayMs: 0, data: { ...data, uploaded } };
          const end = Math.min(uploaded + chunk, data.size) - 1;
          // Stream the byte range from storage (local file or R2); never hold a whole chunk in memory.
          const body = await ctx.openMedia(video, uploaded, end);
          const res = await raw(data.uploadUri, {
            method: 'PUT',
            headers: { ...authz(ctx.token), 'content-type': ctx.post.media[0].mime, 'content-length': String(end - uploaded + 1), 'content-range': `bytes ${uploaded}-${end}/${data.size}` },
            body,
            duplex: 'half',
          }, cfg);
          await ctx.heartbeat?.();
          if (res.status === 308) {
            const range = res.headers.get('range');
            await res.arrayBuffer().catch(() => {});
            if (!range) return { status: 'pending', delayMs: 0, data: { ...data, uploaded } };
            uploaded = Number(range.split('-')[1]) + 1;
            continue;
          }
          if (res.status === 200 || res.status === 201) {
            videoId = String((await res.json()).id);
            break;
          }
          return failFrom(res, 'YouTube upload failed.');
        }
        if (!videoId) return { status: 'pending', data: { ...data, uploaded } };
      }
    }
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    let warning = null;
    if (data.thumbnailId && ctx.thumbnail) {
      try {
        const tsize = ctx.mediaSize(ctx.thumbnail);
        const res = await raw(`${cfg.urls.youtube}/upload/youtube/v3/thumbnails/set?` + qs({ videoId, uploadType: 'media' }), {
          method: 'POST', headers: { ...authz(ctx.token), 'content-type': ctx.thumbnail.mime, 'content-length': String(tsize) }, body: await ctx.openMedia(ctx.thumbnail, 0, tsize - 1), duplex: 'half',
        }, cfg);
        if (!res.ok) await failFrom(res, 'Thumbnail upload failed.');
        await res.arrayBuffer().catch(() => {});
      } catch (e) {
        warning = `Video is live, but the custom thumbnail was not set: ${e.message}`;
      }
    }
    return { status: 'completed', externalId: videoId, url, warning };
  },

  async recover(ctx, data) {
    if (!data?.uploadUri) return null;
    return { status: 'ready', data };
  },

  // ---- analytics ------------------------------------------------------------------------
  async accountAnalytics(ctx, { since, until }) {
    const { cfg } = ctx;
    const out = { daily: [], snapshot: {}, unavailable: {} };
    const ch = await request(`${cfg.urls.youtube}/youtube/v3/channels?` + qs({ part: 'statistics', id: ctx.integration.external_id }), { headers: authz(ctx.token), classifier: classifyGoogle });
    const st = ch.items?.[0]?.statistics || {};
    if (st.hiddenSubscriberCount) out.unavailable.followers = 'Subscriber count is hidden on this channel';
    else if (st.subscriberCount !== undefined) out.snapshot.followers = Number(st.subscriberCount);
    if (st.viewCount !== undefined) out.snapshot.total_views = Number(st.viewCount);
    if (st.videoCount !== undefined) out.snapshot.media_count = Number(st.videoCount);
    const metrics = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost', 'likes', 'comments', 'shares'];
    const names = { views: 'views', estimatedMinutesWatched: 'watch_minutes', averageViewDuration: 'avg_view_sec', subscribersGained: 'new_followers', subscribersLost: 'lost_followers', likes: 'likes', comments: 'comments', shares: 'shares' };
    try {
      const r = await request(`${cfg.urls.ytAnalytics}/v2/reports?` + qs({
        ids: 'channel==MINE', startDate: new Date(since).toISOString().slice(0, 10), endDate: new Date(until).toISOString().slice(0, 10),
        metrics: metrics.join(','), dimensions: 'day', sort: 'day',
      }), { headers: authz(ctx.token), classifier: classifyGoogle });
      const cols = (r.columnHeaders || []).map((c) => c.name);
      for (const row of r.rows || []) {
        const day = row[cols.indexOf('day')];
        cols.forEach((c, i) => { if (c !== 'day' && names[c]) out.daily.push({ metric: names[c], day, value: Number(row[i]) || 0 }); });
      }
    } catch (e) {
      if (e.kind === 'auth' && e.status === 401) throw e;
      for (const m of metrics) out.unavailable[names[m]] = `YouTube Analytics API: ${shortReason(e)}`;
    }
    return out;
  },

  async recentPosts(ctx, limit) {
    const { cfg } = ctx;
    const ch = await request(`${cfg.urls.youtube}/youtube/v3/channels?` + qs({ part: 'contentDetails', id: ctx.integration.external_id }), { headers: authz(ctx.token), classifier: classifyGoogle });
    const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return [];
    const r = await request(`${cfg.urls.youtube}/youtube/v3/playlistItems?` + qs({ part: 'snippet,contentDetails', playlistId: uploads, maxResults: Math.min(50, limit) }), { headers: authz(ctx.token), classifier: classifyGoogle });
    return (r.items || []).map((i) => ({
      external_id: String(i.contentDetails?.videoId || i.snippet?.resourceId?.videoId),
      caption: i.snippet?.title || '',
      permalink: `https://www.youtube.com/watch?v=${i.contentDetails?.videoId || i.snippet?.resourceId?.videoId}`,
      thumbnail: i.snippet?.thumbnails?.medium?.url || i.snippet?.thumbnails?.default?.url || '',
      published_at: Date.parse(i.contentDetails?.videoPublishedAt || i.snippet?.publishedAt) || null,
      kind: 'video',
    }));
  },

  async postAnalytics(ctx, item) {
    const { cfg } = ctx;
    const metrics = {};
    const unavailable = {};
    const v = await request(`${cfg.urls.youtube}/youtube/v3/videos?` + qs({ part: 'statistics', id: item.external_id }), { headers: authz(ctx.token), classifier: classifyGoogle });
    const st = v.items?.[0]?.statistics;
    if (st) {
      metrics.views = Number(st.viewCount || 0);
      if (st.likeCount !== undefined) metrics.likes = Number(st.likeCount); else unavailable.likes = 'Likes are hidden for this video';
      if (st.commentCount !== undefined) metrics.comments = Number(st.commentCount); else unavailable.comments = 'Comments disabled';
    } else unavailable.views = 'Video not found (deleted or private)';
    try {
      const start = item.published_at ? new Date(item.published_at).toISOString().slice(0, 10) : '2006-01-01';
      const r = await request(`${cfg.urls.ytAnalytics}/v2/reports?` + qs({
        ids: 'channel==MINE', startDate: start, endDate: new Date().toISOString().slice(0, 10),
        metrics: 'estimatedMinutesWatched,averageViewDuration,shares,subscribersGained', filters: `video==${item.external_id}`,
      }), { headers: authz(ctx.token), classifier: classifyGoogle });
      const cols = (r.columnHeaders || []).map((c) => c.name);
      const row = r.rows?.[0];
      const map = { estimatedMinutesWatched: 'watch_minutes', averageViewDuration: 'avg_view_sec', shares: 'shares', subscribersGained: 'new_followers' };
      if (row) cols.forEach((c, i) => { if (map[c]) metrics[map[c]] = Number(row[i]) || 0; });
    } catch (e) {
      if (e.kind === 'auth' && e.status === 401) throw e;
      unavailable.watch_minutes = `YouTube Analytics API: ${shortReason(e)}`;
    }
    return { metrics, unavailable };
  },
};
