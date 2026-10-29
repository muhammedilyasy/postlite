// Fake Meta Graph / Instagram / Google OAuth / YouTube Data+Analytics server for tests and local
// end-to-end verification. Never talks to real platforms. Path prefixes:
//   /fb (graph.facebook.com)  /www (www.facebook.com)  /ig (graph.instagram.com)  /igapi (api.instagram.com)
//   /igwww (www.instagram.com)  /gauth (accounts.google.com)  /gtoken (oauth2.googleapis.com)
//   /yt (www.googleapis.com)  /yta (youtubeanalytics.googleapis.com)  /rupload (rupload.facebook.com)
//   /xapi /xwww (X)  /liapi /liwww /liup (LinkedIn) — see ./x-linkedin.js
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { xLinkedInState, makeXLinkedInHandler } from './x-linkedin.js';

const VER = process.env.GRAPH_API_VERSION || 'v25.0';

export function createFakeState() {
  return {
    calls: [],
    seq: 0,
    tokens: new Set(['page1-token', 'page2-token', 'user-long', 'ig-long', 'ig-long-2', 'ya29.initial']),
    revoked: new Set(),
    missingPermissions: [],
    containers: {},        // id -> { status, polls, owner, mediaType, children }
    inProgressPolls: 1,    // container status checks that return IN_PROGRESS before FINISHED
    containerError: null,  // e.g. '2207026' → next containers end in ERROR
    mediaFetchFails: false,
    videoStatusPolls: 0,
    uploads: {},           // youtube session id -> { size, received, meta, videoId }
    ytChunkFailOnce: false,
    ytFailNextStart: null, // { status, body }
    googleRefreshInvalid: false,
    ytTokenCounter: 0,
    expiredYtTokens: new Set(),
    failNext: {},          // pathRegex string -> { status, body, times }
    deprecatedMetrics: new Set(['page_views_total']),
    published: [],         // {platform, kind, id, data}
    fetchedMedia: [],
    hangOnce: null,        // path regex: drop the connection once (simulates unknown outcome)
    // Developer-app credentials the fake platforms accept (client_credentials, test exchanges, Google code exchange).
    apps: { meta: { id: 'meta-app', secret: 'meta-secret' }, instagram: { id: 'ig-app', secret: 'ig-secret' }, google: { id: 'g-client', secret: 'g-secret' }, x: { id: 'x-client-id-123', secret: 'x-client-secret' }, linkedin: { id: 'liclient123', secret: 'li-secret-xyz' }, linkedinPages: null },
    xl: xLinkedInState(),
  };
}

const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};
const graphErr = (res, status, code, message, sub) => json(res, status, { error: { message, type: 'OAuthException', code, ...(sub ? { error_subcode: sub } : {}), fbtrace_id: 'FAKE' } });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function parseBody(req, buf) {
  const ct = req.headers['content-type'] || '';
  if (!buf.length) return {};
  if (ct.includes('application/json')) { try { return JSON.parse(buf.toString()); } catch { return {}; } }
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(buf.toString()));
  return { _raw: buf.length };
}

async function fetchMedia(state, url) {
  state.fetchedMedia.push(url);
  if (state.mediaFetchFails) return false;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    await r.arrayBuffer();
    return r.ok;
  } catch {
    return false;
  }
}

export function startFake({ port = 0, host = '127.0.0.1', state = createFakeState() } = {}) {
  let base = '';
  const nid = (p) => `${p}_${++state.seq}`;
  const xl = makeXLinkedInHandler(state, () => base);

  async function graph(req, res, url, q, body, prefix) {
    const parts = url.pathname.split('/').filter(Boolean); // [prefix, ver, ...]
    const p = parts.slice(2);
    const tok = q.get('access_token') || body.access_token || (req.headers.authorization || '').replace(/^(OAuth|Bearer)\s+/i, '');
    const path = '/' + p.join('/');

    // OAuth (FB)
    if (path === '/oauth/access_token') {
      if (q.get('grant_type') === 'client_credentials') {
        const a = state.apps.meta;
        if (q.get('client_id') !== a.id) return graphErr(res, 400, 101, 'Error validating application. Invalid application ID.');
        if (q.get('client_secret') !== a.secret) return graphErr(res, 400, 1, 'Error validating client secret.');
        return json(res, 200, { access_token: `${a.id}|app-token`, token_type: 'bearer' });
      }
      if (q.get('grant_type') === 'fb_exchange_token') return json(res, 200, { access_token: 'user-long', token_type: 'bearer', expires_in: 5183944 });
      if (q.get('code') === 'bad') return graphErr(res, 400, 100, 'Invalid verification code format.');
      return json(res, 200, { access_token: 'user-short', token_type: 'bearer', expires_in: 3600 });
    }
    if (prefix === 'ig' && parts[1] === 'access_token') return json(res, 200, { access_token: 'ig-long', token_type: 'bearer', expires_in: 5184000 });
    if (prefix === 'ig' && parts[1] === 'refresh_access_token') return json(res, 200, { access_token: 'ig-long-2', token_type: 'bearer', expires_in: 5184000 });

    if (path === '/app' && tok === `${state.apps.meta.id}|app-token`) return json(res, 200, { id: state.apps.meta.id, name: 'Fake Meta App' });
    if (state.revoked.has(tok)) return graphErr(res, 400, 190, 'Error validating access token: The session has been invalidated because the user changed their password.', 460);
    if (!state.tokens.has(tok) && tok !== 'user-short') return graphErr(res, 400, 190, 'Invalid OAuth access token - Cannot parse access token');

    if (path === '/me/permissions') {
      const all = ['pages_show_list', 'business_management', 'pages_manage_posts', 'pages_manage_engagement', 'pages_read_engagement', 'read_insights', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights'];
      return json(res, 200, { data: all.map((permission) => ({ permission, status: state.missingPermissions.includes(permission) ? 'declined' : 'granted' })) });
    }
    if (path === '/me' && prefix === 'ig') return json(res, 200, { user_id: 'igs1', id: 'igs1', username: 'standalone_ig', name: 'Standalone IG', profile_picture_url: 'https://example.invalid/p.jpg' });
    if (path === '/me') return json(res, 200, { id: 'user1', name: 'Test User', picture: { data: { url: '' } } });
    if (path === '/me/accounts') {
      return json(res, 200, { data: [
        { id: 'page1', name: 'Test Page', username: 'testpage', access_token: 'page1-token', instagram_business_account: { id: 'ig1' }, picture: { data: { url: 'https://example.invalid/page1.jpg' } } },
        { id: 'page2', name: 'Second Page', access_token: 'page2-token', picture: { data: { url: '' } } },
      ] });
    }
    if (path === '/me/businesses') return json(res, 200, { data: [] });

    // ---- publishing: Facebook Pages
    if (req.method === 'POST' && p[1] === 'photos') {
      if (!(await fetchMedia(state, body.url))) return graphErr(res, 400, 324, 'Missing or invalid image file', 2069019);
      return json(res, 200, { id: nid('photo') });
    }
    if (req.method === 'POST' && p[1] === 'feed') {
      if (state.hangOnce && new RegExp(state.hangOnce).test(path)) { state.hangOnce = null; req.socket.destroy(); return; }
      const id = `${p[0]}_${++state.seq}`;
      state.published.push({ platform: 'facebook', kind: body.attached_media ? 'photos' : body.link ? 'link' : 'text', id, data: body });
      return json(res, 200, { id, permalink_url: `https://www.facebook.com/${p[0]}/posts/${state.seq}` });
    }
    if (req.method === 'POST' && p[1] === 'videos') {
      if (!(await fetchMedia(state, body.file_url))) return graphErr(res, 400, 351, 'Sorry, there was a problem with your video file');
      const id = nid('video');
      state.published.push({ platform: 'facebook', kind: 'video', id, data: body });
      return json(res, 200, { id });
    }
    if (req.method === 'POST' && (p[1] === 'video_reels' || p[1] === 'video_stories')) {
      const phase = body.upload_phase || q.get('upload_phase');
      if (phase === 'start') {
        const id = nid(p[1] === 'video_reels' ? 'reel' : 'vstory');
        state.containers[id] = { status: 'uploading', polls: 0 };
        return json(res, 200, { video_id: id, upload_url: `${base}/rupload/${VER}/${id}` });
      }
      if (phase === 'finish') {
        const vid = body.video_id || q.get('video_id');
        state.published.push({ platform: 'facebook', kind: p[1] === 'video_reels' ? 'reel' : 'video_story', id: vid, data: body });
        return json(res, 200, p[1] === 'video_reels' ? { success: true } : { success: true, post_id: nid('story') });
      }
    }
    if (req.method === 'POST' && p[1] === 'photo_stories') {
      const id = nid('story');
      state.published.push({ platform: 'facebook', kind: 'photo_story', id, data: body });
      return json(res, 200, { success: true, post_id: id });
    }
    if (req.method === 'POST' && p[1] === 'comments') return json(res, 200, { id: nid('comment') });

    // ---- publishing: Instagram containers
    if (req.method === 'POST' && p[1] === 'media') {
      const mediaUrl = body.image_url || body.video_url;
      if (body.media_type === 'CAROUSEL') {
        const kids = String(body.children || '').split(',');
        if (kids.length < 2 || kids.length > 10) return graphErr(res, 400, 100, 'The carousel has too little or too many attachments');
        const id = nid('carousel');
        state.containers[id] = { status: 'IN_PROGRESS', polls: 0, owner: p[0], mediaType: 'CAROUSEL', children: kids, caption: body.caption, collaborators: body.collaborators };
        return json(res, 200, { id });
      }
      const ok = mediaUrl ? await fetchMedia(state, mediaUrl) : false;
      const id = nid('container');
      state.containers[id] = { status: ok ? 'IN_PROGRESS' : 'ERROR', err: ok ? state.containerError : '2207052', polls: 0, owner: p[0], mediaType: body.media_type || 'IMAGE', caption: body.caption, collaborators: body.collaborators, carouselItem: body.is_carousel_item === 'true' };
      return json(res, 200, { id });
    }
    if (req.method === 'POST' && p[1] === 'media_publish') {
      if (state.hangOnce && new RegExp(state.hangOnce).test(path)) {
        state.hangOnce = null;
        const c = state.containers[body.creation_id];
        if (c) c.status = 'PUBLISHED';
        state.published.push({ platform: 'instagram', kind: c?.mediaType, id: 'lost', data: body });
        req.socket.destroy();
        return;
      }
      const c = state.containers[body.creation_id];
      if (!c) return graphErr(res, 400, 100, 'Invalid parameter', 2207006);
      if (c.status === 'PUBLISHED') return graphErr(res, 400, 9007, 'Media already published', 2207027);
      if (c.status !== 'FINISHED') return graphErr(res, 400, 9007, 'Media ID is not available', 2207027);
      c.status = 'PUBLISHED';
      const id = nid('igmedia');
      state.published.push({ platform: 'instagram', kind: c.mediaType, id, data: { ...body, caption: c.caption, collaborators: c.collaborators, children: c.children } });
      return json(res, 200, { id });
    }

    // ---- reads / insights
    if (p[1] === 'insights' || p[1] === 'video_insights') {
      const metrics = String(q.get('metric') || '').split(',').filter(Boolean);
      const bad = metrics.find((m) => state.deprecatedMetrics.has(m));
      if (bad) return graphErr(res, 400, 100, `(#100) The value must be a valid insights metric: ${bad}`);
      const since = Number(q.get('since')) || Math.floor(Date.now() / 1000) - 3 * 86400;
      const until = Number(q.get('until')) || Math.floor(Date.now() / 1000);
      if (q.get('metric_type') === 'total_value') return json(res, 200, { data: metrics.map((name, i) => ({ name, period: 'day', total_value: { value: 10 + i } })) });
      if (q.get('period') === 'day') {
        const values = [];
        for (let t = since; t < until; t += 86400) values.push({ value: 5 + (values.length % 3), end_time: new Date((t + 86400) * 1000).toISOString().replace('Z', '+0000') });
        return json(res, 200, { data: metrics.map((name) => ({ name, period: 'day', values })) });
      }
      return json(res, 200, { data: metrics.map((name, i) => ({ name, period: 'lifetime', values: [{ value: name.includes('reactions') ? { like: 3, love: 2 } : 100 + i }] })) });
    }
    if (p[1] === 'published_posts') {
      return json(res, 200, { data: [
        { id: 'page1_900', message: 'Older post', permalink_url: 'https://facebook.com/page1/posts/900', created_time: new Date(Date.now() - 5 * 86400000).toISOString(), full_picture: 'https://example.invalid/fb900.jpg' },
        // video/reel post: no full_picture, the frame is on the attachment
        { id: 'page1_901', message: 'Older reel', permalink_url: 'https://facebook.com/reel/901', created_time: new Date(Date.now() - 4 * 86400000).toISOString(), attachments: { data: [{ type: 'video_inline', media: { image: { src: 'https://example.invalid/fb901.jpg' } } }] } },
      ] });
    }
    if (req.method === 'GET' && p[1] === 'media') return json(res, 200, { data: [{ id: 'igold1', caption: 'Older reel', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://instagram.com/reel/old1', timestamp: new Date(Date.now() - 3 * 86400000).toISOString(), thumbnail_url: 'https://example.invalid/t.jpg' }] });

    if (req.method === 'GET' && p.length === 1) {
      const id = p[0];
      const fields = q.get('fields') || '';
      const c = state.containers[id];
      if (c && fields.includes('status_code')) {
        if (c.status === 'IN_PROGRESS') {
          c.polls++;
          if (c.polls > state.inProgressPolls) c.status = c.err ? 'ERROR' : 'FINISHED';
          else return json(res, 200, { id, status_code: 'IN_PROGRESS', status: 'In Progress' });
        }
        if (c.status === 'ERROR') return json(res, 200, { id, status_code: 'ERROR', status: `Error: (#${c.err || 2207032}) Media upload failed` });
        return json(res, 200, { id, status_code: c.status, status: c.status });
      }
      if (c && fields.includes('status')) {
        c.polls++;
        const done = c.polls > state.videoStatusPolls;
        return json(res, 200, { id, status: { video_status: done ? 'ready' : 'processing', uploading_phase: { status: done || c.uploaded ? 'complete' : 'in_progress' } } });
      }
      if (fields.includes('thumbnails')) return json(res, 200, { id, picture: `https://example.invalid/${id}-small.jpg`, thumbnails: { data: [{ uri: `https://example.invalid/${id}-a.jpg`, is_preferred: false }, { uri: `https://example.invalid/${id}-pref.jpg`, is_preferred: true }] } });
      if (fields.includes('thumbnail_url')) return json(res, 200, { id, media_type: 'VIDEO', thumbnail_url: `https://example.invalid/${id}-ig.jpg` });
      if (fields === 'full_picture') return json(res, 200, { id, full_picture: `https://example.invalid/${id}-full.jpg` });
      if (fields.includes('permalink')) return json(res, 200, { id, permalink: `https://www.instagram.com/p/${id}/` });
      if (fields.includes('followers_count') || fields.includes('fan_count')) return json(res, 200, { id, followers_count: 1234 + state.seq, fan_count: 1200, follows_count: 50, media_count: 42 });
      if (fields.includes('shares')) return json(res, 200, { id, shares: { count: 4 }, comments: { summary: { total_count: 7 } } });
      if (id === 'ig1' || id === 'igs1') return json(res, 200, { id, username: id === 'ig1' ? 'testig' : 'standalone_ig', name: 'Test IG', profile_picture_url: 'https://example.invalid/ig.jpg' });
      return json(res, 200, { id, name: id === 'page1' ? 'Test Page' : id });
    }
    return graphErr(res, 400, 100, `Unsupported request ${req.method} ${path}`);
  }

  function ytAuth(req, res) {
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (state.expiredYtTokens.has(tok) || !tok.startsWith('ya29.')) {
      json(res, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED', errors: [{ reason: 'authError' }] } });
      return false;
    }
    return true;
  }

  async function handler(req, res) {
    const url = new URL(req.url, base);
    const q = url.searchParams;
    const isUploadChunk = req.method === 'PUT' && url.pathname.startsWith('/yt/upload/session/');
    const buf = await readBody(req);
    const body = isUploadChunk ? {} : parseBody(req, buf);
    state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(q), body, headers: { 'content-range': req.headers['content-range'], file_url: req.headers.file_url, authorization: req.headers.authorization } });
    const seg = url.pathname.split('/')[1];

    for (const [re, f] of Object.entries(state.failNext)) {
      if (f.times > 0 && new RegExp(re).test(url.pathname)) {
        f.times--;
        return json(res, f.status, typeof f.body === 'string' ? JSON.parse(f.body) : f.body);
      }
    }

    // Fake Resend (https://resend.com/docs/api-reference/emails/send-email): POST /resend/emails
    if (url.pathname === '/resend/emails' && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer re_test_key') return json(res, 401, { statusCode: 401, name: 'validation_error', message: 'API key is invalid' });
      if (!body?.from || !Array.isArray(body.to) || !body.subject || !body.text || !body.html) return json(res, 422, { statusCode: 422, name: 'validation_error', message: 'missing field' });
      const id = `re_${++state.seq}`;
      (state.emails ||= []).push({ id, ...body });
      return json(res, 200, { id });
    }
    if (url.pathname === '/__emails') return json(res, 200, { emails: state.emails || [] });
    if (url.pathname === '/__state') return json(res, 200, { published: state.published, calls: state.calls.length, fetchedMedia: state.fetchedMedia });

    // Consent screens: auto-approve and redirect back with a code.
    if (seg === 'www' || seg === 'igwww' || seg === 'gauth') {
      const redirect = q.get('redirect_uri');
      const loc = new URL(redirect);
      loc.searchParams.set('code', seg === 'gauth' ? 'google-code' : 'fb-code');
      loc.searchParams.set('state', q.get('state'));
      res.writeHead(302, { location: loc.toString() });
      return res.end();
    }
    if (seg === 'fb' || seg === 'ig') return graph(req, res, url, q, body, seg);
    if (seg === 'igapi' && url.pathname === '/igapi/oauth/access_token') {
      const a = state.apps.instagram;
      if (body.client_id !== a.id) return json(res, 400, { error_type: 'OAuthException', code: 400, error_message: 'Invalid platform app' });
      if (body.client_secret !== a.secret) return json(res, 400, { error_type: 'OAuthException', code: 400, error_message: 'Error validating client secret.' });
      if (body.code !== 'fb-code') return json(res, 400, { error_type: 'OAuthException', code: 400, error_message: 'Invalid authorization code' });
      return json(res, 200, { access_token: 'ig-short', user_id: 'igs1', permissions: ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments', 'instagram_business_manage_insights'] });
    }
    if (seg === 'rupload') {
      const id = url.pathname.split('/').pop();
      const ok = await fetchMedia(state, req.headers.file_url);
      if (!ok) return json(res, 400, { debug_info: { message: 'Could not fetch file_url' } });
      if (state.containers[id]) state.containers[id].uploaded = true;
      return json(res, 200, { success: true });
    }
    if (seg === 'gtoken') {
      if (body.grant_type === 'authorization_code') {
        if (body.client_id !== state.apps.google.id || body.client_secret !== state.apps.google.secret) return json(res, 401, { error: 'invalid_client', error_description: 'Unauthorized' });
        if (body.code !== 'google-code') return json(res, 400, { error: 'invalid_grant', error_description: 'Bad Request' });
        state.tokens.add('ya29.initial');
        return json(res, 200, { access_token: 'ya29.initial', refresh_token: '1//refresh', expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly' });
      }
      if (body.grant_type === 'refresh_token') {
        (state.googleRefreshClients ||= []).push(body.client_id);
        if (state.googleRefreshInvalid) return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return json(res, 200, { access_token: `ya29.refreshed${++state.ytTokenCounter}`, expires_in: 3599, token_type: 'Bearer' });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (seg === 'yt') {
      if (url.pathname.startsWith('/yt/upload/session/')) {
        const sid = url.pathname.split('/').pop();
        const up = state.uploads[sid];
        if (!up) return json(res, 404, { error: { code: 404, message: 'Not Found' } });
        if (!ytAuth(req, res)) return;
        const cr = req.headers['content-range'] || '';
        const probe = /^bytes \*\/(\d+)$/.exec(cr);
        const done = () => {
          if (!up.videoId) {
            up.videoId = nid('vid');
            state.published.push({ platform: 'youtube', kind: 'video', id: up.videoId, data: up.meta });
          }
          return json(res, 200, { id: up.videoId, kind: 'youtube#video', snippet: up.meta.snippet, status: up.meta.status });
        };
        if (probe) {
          if (up.received >= up.size) return done();
          if (up.received === 0) { res.writeHead(308); return res.end(); }
          res.writeHead(308, { range: `bytes=0-${up.received - 1}` });
          return res.end();
        }
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
        if (!m) return json(res, 400, { error: { code: 400, message: 'bad content-range' } });
        if (state.ytChunkFailOnce) {
          state.ytChunkFailOnce = false;
          return json(res, 503, { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } });
        }
        if (Number(m[1]) !== up.received) return json(res, 400, { error: { code: 400, message: `offset mismatch ${m[1]} != ${up.received}` } });
        if (buf.length !== Number(m[2]) - Number(m[1]) + 1) return json(res, 400, { error: { code: 400, message: 'length mismatch' } });
        up.received += buf.length;
        up.chunks = (up.chunks || 0) + 1;
        if (up.received >= up.size) return done();
        res.writeHead(308, { range: `bytes=0-${up.received - 1}` });
        return res.end();
      }
      if (!ytAuth(req, res)) return;
      if (url.pathname === '/yt/upload/youtube/v3/videos' && req.method === 'POST') {
        if (state.ytFailNextStart) {
          const f = state.ytFailNextStart;
          state.ytFailNextStart = null;
          return json(res, f.status, f.body);
        }
        const sid = nid('session');
        state.uploads[sid] = { size: Number(req.headers['x-upload-content-length']), received: 0, meta: { ...body, notifySubscribers: q.get('notifySubscribers') } };
        res.writeHead(200, { location: `${base}/yt/upload/session/${sid}` });
        return res.end();
      }
      if (url.pathname === '/yt/upload/youtube/v3/thumbnails/set') {
        state.published.push({ platform: 'youtube', kind: 'thumbnail', id: q.get('videoId'), data: { bytes: buf.length } });
        return json(res, 200, { items: [{ default: { url: 'https://example.invalid/t.jpg' } }] });
      }
      if (url.pathname === '/yt/youtube/v3/channels') {
        return json(res, 200, { items: [{ id: 'UC1', snippet: { title: 'Test Channel', customUrl: '@testchannel', thumbnails: { default: { url: 'https://example.invalid/c.jpg' } } }, statistics: { subscriberCount: '100', viewCount: '5000', videoCount: '12', hiddenSubscriberCount: false }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
      }
      if (url.pathname === '/yt/youtube/v3/playlistItems') return json(res, 200, { items: [{ snippet: { title: 'Old video', publishedAt: new Date(Date.now() - 10 * 86400000).toISOString(), thumbnails: {} }, contentDetails: { videoId: 'oldvid1', videoPublishedAt: new Date(Date.now() - 10 * 86400000).toISOString() } }] });
      if (url.pathname === '/yt/youtube/v3/videos') return json(res, 200, { items: String(q.get('id')).split(',').map((id) => ({ id, statistics: { viewCount: '321', likeCount: '12', commentCount: '3' } })) });
    }
    if (await xl(seg, req, res, url, q, body, buf)) return;
    if (seg === 'yta') {
      if (!ytAuth(req, res)) return;
      if (q.get('dimensions') === 'day') {
        const cols = ['day', ...String(q.get('metrics')).split(',')];
        const rows = [];
        const start = new Date(q.get('startDate')); const end = new Date(q.get('endDate'));
        for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) rows.push([d.toISOString().slice(0, 10), ...cols.slice(1).map((_, i) => 10 + i)]);
        return json(res, 200, { kind: 'youtubeAnalytics#resultTable', columnHeaders: cols.map((name) => ({ name })), rows });
      }
      const cols = String(q.get('metrics')).split(',');
      return json(res, 200, { columnHeaders: cols.map((name) => ({ name })), rows: [cols.map((_, i) => 50 + i)] });
    }
    return json(res, 404, { error: 'fake: unknown route', path: url.pathname });
  }

  const server = http.createServer((req, res) => handler(req, res).catch((e) => json(res, 500, { error: String(e) })));
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      base = `http://${host}:${server.address().port}`;
      resolve({
        url: base,
        state,
        server,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
        env: () => ({
          GRAPH_BASE_URL: `${base}/fb`, FACEBOOK_WWW_URL: `${base}/www`, IG_GRAPH_BASE_URL: `${base}/ig`, IG_API_BASE_URL: `${base}/igapi`, IG_WWW_URL: `${base}/igwww`,
          GOOGLE_AUTH_URL: `${base}/gauth`, GOOGLE_TOKEN_URL: `${base}/gtoken`, YOUTUBE_API_BASE_URL: `${base}/yt`, YOUTUBE_ANALYTICS_BASE_URL: `${base}/yta`,
          // Credentials the fake accepts (state.apps); real servers use Settings → Platform apps or .env.
          META_APP_ID: state.apps.meta.id, META_APP_SECRET: state.apps.meta.secret,
          INSTAGRAM_APP_ID: state.apps.instagram.id, INSTAGRAM_APP_SECRET: state.apps.instagram.secret,
          GOOGLE_CLIENT_ID: state.apps.google.id, GOOGLE_CLIENT_SECRET: state.apps.google.secret,
          X_API_BASE_URL: `${base}/xapi`, X_WWW_URL: `${base}/xwww`, LINKEDIN_API_BASE_URL: `${base}/liapi`, LINKEDIN_WWW_URL: `${base}/liwww`,
          X_CLIENT_ID: state.apps.x.id, X_CLIENT_SECRET: state.apps.x.secret, LINKEDIN_CLIENT_ID: state.apps.linkedin.id, LINKEDIN_CLIENT_SECRET: state.apps.linkedin.secret,
        }),
      });
    });
  });
}

// Standalone: node test/fake/server.js [--port 4199]
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 4199;
  startFake({ port }).then((f) => {
    process.stderr.write(`fake providers on ${f.url}\n`);
    for (const [k, v] of Object.entries(f.env())) process.stdout.write(`${k}=${v}\n`);
  });
}
