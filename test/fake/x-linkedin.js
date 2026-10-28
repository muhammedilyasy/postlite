// Fake X (api.x.com, x.com) and LinkedIn (api.linkedin.com, www.linkedin.com, upload host) for tests and
// local verification. Never talks to real platforms. Path prefixes:
//   /xapi (api.x.com)  /xwww (x.com consent)  /liapi (api.linkedin.com)  /liwww (www.linkedin.com)  /liup (upload URLs)

const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};
const problem = (res, status, title, detail, type = 'about:blank') => json(res, status, { title, detail, type, status }, { 'content-type': 'application/problem+json' });
const liErr = (res, status, message, extra = {}) => json(res, status, { status, message, ...extra });

export function xLinkedInState() {
  return {
    x: { tokens: new Set(), refresh: null, seq: 0, premium: false, expired: new Set(), media: {}, processingPolls: 1, tweets: [], refreshCalls: 0 },
    li: { tokens: new Set(), seq: 0, refresh: false, scope: null, comments: false, analytics: false, pageAnalytics: true, uploads: {}, assets: {}, posts: [], processingPolls: 1, versions: new Set() },
  };
}

/** Minimal multipart/form-data parser: { fields, files: { name: { size, type } } }. */
function multipart(req, buf) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] || '');
  if (!m) return { fields: {}, files: {} };
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const out = { fields: {}, files: {} };
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    const part = buf.subarray(pos + boundary.length + 2, next - 2);
    const sep = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, sep).toString();
    const body = part.subarray(sep + 4);
    const name = /name="([^"]+)"/.exec(head)?.[1];
    if (name && /filename=/.test(head)) out.files[name] = { size: body.length, type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] || '' };
    else if (name) out.fields[name] = body.toString();
    pos = next;
  }
  return out;
}

export function makeXLinkedInHandler(state, getBase) {
  const S = state.xl;
  const X = S.x;
  const L = S.li;

  function consent(res, q, code) {
    const loc = new URL(q.get('redirect_uri'));
    loc.searchParams.set('code', code);
    loc.searchParams.set('state', q.get('state'));
    res.writeHead(302, { location: loc.toString() });
    res.end();
  }

  // ------------------------------------------------------------------ X
  function xIssue() {
    const n = ++X.seq;
    const t = { access_token: `x-at-${n}`, refresh_token: `x-rt-${n}`, expires_in: 7200, token_type: 'bearer', scope: 'tweet.read tweet.write users.read media.write offline.access' };
    X.tokens.add(t.access_token);
    X.refresh = t.refresh_token;
    return t;
  }

  async function x(req, res, url, q, body, buf) {
    const path = url.pathname.slice('/xapi'.length);
    if (path === '/2/oauth2/token') {
      const a = state.apps.x;
      const basic = Buffer.from(String(req.headers.authorization || '').replace(/^Basic\s+/i, ''), 'base64').toString();
      if (basic !== `${a.id}:${a.secret}`) return json(res, 401, { error: 'unauthorized_client', error_description: 'Missing valid authorization header' });
      if (body.grant_type === 'authorization_code') {
        if (body.code !== 'x-code' || !body.code_verifier) return json(res, 400, { error: 'invalid_request', error_description: 'Value passed for the authorization code was invalid.' });
        return json(res, 200, xIssue());
      }
      if (body.grant_type === 'refresh_token') {
        X.refreshCalls++;
        if (body.refresh_token !== X.refresh) return json(res, 400, { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' });
        return json(res, 200, xIssue());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!X.tokens.has(tok) || X.expired.has(tok)) return problem(res, 401, 'Unauthorized', 'Unauthorized');
    if (path === '/2/users/me') return json(res, 200, { data: { id: 'x1', name: 'X Test', username: 'xtest', profile_image_url: 'https://example.invalid/x.jpg', subscription_type: X.premium ? 'Premium' : 'None', public_metrics: { followers_count: 500 + X.tweets.length, following_count: 10, tweet_count: 42 + X.tweets.length } } });
    if (path === '/2/media/upload/initialize' && req.method === 'POST') {
      if (!body.total_bytes || !body.media_type || !body.media_category) return problem(res, 400, 'Invalid Request', 'media_type, total_bytes and media_category are required');
      const id = String(1880000000000000000n + BigInt(++X.seq));
      X.media[id] = { total: Number(body.total_bytes), received: 0, segs: [], type: body.media_type, category: body.media_category, polls: 0 };
      return json(res, 200, { data: { id, media_key: `3_${id}`, expires_after_secs: 86400 } });
    }
    let m = /^\/2\/media\/upload\/(\d+)\/(append|finalize)$/.exec(path);
    if (m && req.method === 'POST') {
      const md = X.media[m[1]];
      if (!md) return problem(res, 400, 'Invalid Request', 'unknown media id');
      if (m[2] === 'append') {
        const mp = multipart(req, buf);
        const seg = Number(mp.fields.segment_index);
        if (seg !== md.segs.length) return problem(res, 400, 'Invalid Request', `segment_index ${seg} out of order`);
        if (!mp.files.media || mp.files.media.size > 8 * 1024 * 1024) return problem(res, 400, 'Invalid Request', 'media segment missing or > 8 MB');
        md.segs.push(mp.files.media.size);
        md.received += mp.files.media.size;
        res.writeHead(204);
        return res.end();
      }
      if (md.received !== md.total) return problem(res, 400, 'Invalid Request', `received ${md.received} of ${md.total} bytes`);
      md.done = true;
      const video = md.category === 'tweet_video';
      return json(res, 200, { data: { id: m[1], media_key: `3_${m[1]}`, size: md.total, expires_after_secs: 86400, ...(video ? { processing_info: { state: 'pending', check_after_secs: 1 } } : {}) } });
    }
    if (path === '/2/media/upload' && req.method === 'GET') {
      const md = X.media[q.get('media_id')];
      if (q.get('command') !== 'STATUS' || !md) return problem(res, 400, 'Invalid Request', 'bad status request');
      md.polls++;
      return json(res, 200, { data: { id: q.get('media_id'), processing_info: md.polls > X.processingPolls ? { state: 'succeeded', progress_percent: 100 } : { state: 'in_progress', check_after_secs: 1, progress_percent: 50 } } });
    }
    if (path === '/2/tweets' && req.method === 'POST') {
      if (typeof body.text !== 'string') return problem(res, 400, 'Invalid Request', 'text is required');
      if (body.text && X.tweets.some((t) => t.text === body.text && !t.data.reply)) return problem(res, 403, 'Forbidden', 'You are not allowed to create a Tweet with duplicate content.');
      for (const id of body.media?.media_ids || []) {
        const md = X.media[id];
        if (!md?.done) return problem(res, 400, 'Invalid Request', `media ${id} not ready`);
        if (md.category === 'tweet_video' && md.polls <= X.processingPolls) return problem(res, 400, 'Invalid Request', `media ${id} still processing`);
      }
      if (body.reply && !X.tweets.some((t) => t.id === body.reply.in_reply_to_tweet_id)) return problem(res, 400, 'Invalid Request', 'reply target does not exist');
      const id = String(1890000000000000000n + BigInt(++X.seq));
      X.tweets.push({ id, text: body.text, data: body, created_at: new Date().toISOString() });
      state.published.push({ platform: 'x', kind: body.reply ? 'reply' : body.media ? 'media' : 'text', id, data: body });
      if (X.hangAfterCreate) { X.hangAfterCreate = false; req.socket.destroy(); return; } // created, but the answer is lost
      return json(res, 201, { data: { id, text: body.text, edit_history_tweet_ids: [id] } });
    }
    m = /^\/2\/users\/(\w+)\/tweets$/.exec(path);
    if (m) {
      const list = X.tweets.filter((t) => !t.data.reply).slice().reverse().slice(0, Number(q.get('max_results')) || 10);
      return json(res, 200, { data: list.map((t, i) => ({ id: t.id, text: t.text, created_at: t.created_at, public_metrics: { impression_count: 1000 + i, like_count: 10, reply_count: 2, retweet_count: 3, quote_count: 1, bookmark_count: 4 } })), meta: { result_count: list.length } });
    }
    m = /^\/2\/tweets\/(\d+)$/.exec(path);
    if (m) {
      const t = X.tweets.find((x) => x.id === m[1]);
      if (!t) return json(res, 200, { errors: [{ detail: `Could not find tweet with id: [${m[1]}].`, title: 'Not Found Error' }] });
      const f = String(q.get('tweet.fields') || '');
      return json(res, 200, { data: { id: t.id, text: t.text, public_metrics: { impression_count: 2000, like_count: 20, reply_count: 2, retweet_count: 5, quote_count: 1, bookmark_count: 3 }, ...(f.includes('non_public_metrics') ? { non_public_metrics: { impression_count: 2000, url_link_clicks: 7, user_profile_clicks: 5, engagements: 30 } } : {}) } });
    }
    return problem(res, 404, 'Not Found', `fake x: ${req.method} ${path}`);
  }

  // ------------------------------------------------------------------ LinkedIn
  async function liwww(req, res, url, q, body) {
    const path = url.pathname.slice('/liwww'.length);
    if (path === '/oauth/v2/authorization') return consent(res, q, 'li-code');
    if (path === '/oauth/v2/accessToken') {
      const a = state.apps.linkedin;
      const pa = state.apps.linkedinPages;
      const okClient = (body.client_id === a.id && body.client_secret === a.secret) || (pa && body.client_id === pa.id && body.client_secret === pa.secret);
      if (!okClient) return json(res, 401, { error: 'invalid_client', error_description: 'Client authentication failed' });
      const n = ++L.seq;
      const page = String(body.redirect_uri || '').includes('linkedin-page');
      const issue = () => {
        const t = { access_token: `li-at-${n}`, expires_in: 5184000, scope: L.scope || (page ? 'r_organization_social,w_organization_social,rw_organization_admin' : 'email,openid,profile,w_member_social') };
        if (L.refresh) Object.assign(t, { refresh_token: `li-rt-${n}`, refresh_token_expires_in: 31536000 });
        L.tokens.add(t.access_token);
        return t;
      };
      if (body.grant_type === 'authorization_code') {
        if (body.code !== 'li-code') return json(res, 400, { error: 'invalid_request', error_description: 'Unable to retrieve access token: authorization code not found' });
        return json(res, 200, issue());
      }
      if (body.grant_type === 'refresh_token') {
        if (!L.refresh || !String(body.refresh_token || '').startsWith('li-rt-')) return json(res, 400, { error: 'invalid_grant', error_description: 'The provided authorization grant or refresh token is invalid, expired or revoked' });
        return json(res, 200, issue());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    return json(res, 404, { error: 'fake liwww', path });
  }

  async function liapi(req, res, url, q, body) {
    const path = url.pathname.slice('/liapi'.length);
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!L.tokens.has(tok)) return liErr(res, 401, 'Invalid access token', { serviceErrorCode: 65600, code: 'INVALID_ACCESS_TOKEN' });
    if (path === '/v2/userinfo') return json(res, 200, { sub: 'li-member-1', name: 'Li Member', given_name: 'Li', family_name: 'Member', email: 'li@example.com', picture: 'https://example.invalid/li.jpg' });
    if (!path.startsWith('/rest/')) return liErr(res, 404, `fake li ${path}`);
    const ver = req.headers['linkedin-version'];
    if (!/^\d{6}$/.test(String(ver || '')) || req.headers['x-restli-protocol-version'] !== '2.0.0') return liErr(res, 400, 'A version must be present. Please specify a version by adding the LinkedIn-Version header.', { code: 'VERSION_MISSING' });
    L.versions.add(ver);
    const r = path.slice('/rest'.length);
    const base = getBase();
    const action = q.get('action');
    if (r === '/organizationAcls') return json(res, 200, { elements: [{ organization: 'urn:li:organization:9001', role: 'ADMINISTRATOR', state: 'APPROVED' }, { organization: 'urn:li:organization:9002', role: 'ANALYST', state: 'APPROVED' }] });
    let m = /^\/organizations\/(\d+)$/.exec(r);
    if (m) return json(res, 200, { id: Number(m[1]), localizedName: m[1] === '9001' ? 'Acme Corp' : `Org ${m[1]}`, vanityName: 'acme' });
    if ((r === '/images' || r === '/documents') && action === 'initializeUpload') {
      const owner = body.initializeUploadRequest?.owner;
      if (!/^urn:li:(person|organization):/.test(String(owner))) return liErr(res, 422, 'owner is required');
      const n = ++L.seq;
      const urn = r === '/images' ? `urn:li:image:IMG${n}` : `urn:li:document:DOC${n}`;
      L.uploads[`u${n}`] = { urn, received: 0, parts: 1 };
      L.assets[urn] = { status: 'WAITING_UPLOAD', polls: 0, owner };
      return json(res, 200, { value: { uploadUrlExpiresAt: Date.now() + 86400000, uploadUrl: `${base}/liup/u${n}`, [r === '/images' ? 'image' : 'document']: urn } });
    }
    if (r === '/videos' && action === 'initializeUpload') {
      const ir = body.initializeUploadRequest || {};
      const size = Number(ir.fileSizeBytes);
      if (!size || !ir.owner) return liErr(res, 422, 'fileSizeBytes and owner are required');
      const n = ++L.seq;
      const urn = `urn:li:video:VID${n}`;
      const PART = 4 * 1024 * 1024;
      const parts = [];
      for (let a = 0; a < size; a += PART) parts.push({ uploadUrl: `${base}/liup/v${n}p${parts.length}`, firstByte: a, lastByte: Math.min(a + PART, size) - 1 });
      parts.forEach((p, i) => { L.uploads[`v${n}p${i}`] = { urn, size: p.lastByte - p.firstByte + 1, received: 0 }; });
      L.assets[urn] = { status: 'WAITING_UPLOAD', polls: 0, parts: parts.length, token: `tok${n}` };
      return json(res, 200, { value: { uploadUrlsExpireAt: Date.now() + 86400000, video: urn, uploadInstructions: parts, uploadToken: `tok${n}` } });
    }
    if (r === '/videos' && action === 'finalizeUpload') {
      const f = body.finalizeUploadRequest || {};
      const a = L.assets[f.video];
      if (!a || f.uploadToken !== a.token || (f.uploadedPartIds || []).length !== a.parts || f.uploadedPartIds.some((e) => !e)) return liErr(res, 400, 'Invalid finalize request');
      a.status = 'PROCESSING';
      res.writeHead(200);
      return res.end();
    }
    m = /^\/(videos|documents|images)\/(.+)$/.exec(r);
    if (m && req.method === 'GET') {
      const urn = decodeURIComponent(m[2]);
      const a = L.assets[urn];
      if (!a) return liErr(res, 404, 'Not found');
      if (a.status === 'PROCESSING' || (a.status === 'UPLOADED')) { a.polls++; if (a.polls > L.processingPolls) a.status = 'AVAILABLE'; }
      return json(res, 200, { id: urn, status: a.status });
    }
    if (r === '/posts' && req.method === 'POST') {
      if (!body.author || typeof body.commentary !== 'string' || body.lifecycleState !== 'PUBLISHED' || !body.distribution) return liErr(res, 422, 'author, commentary, distribution and lifecycleState are required');
      const ids = [body.content?.media?.id, ...(body.content?.multiImage?.images || []).map((i) => i.id)].filter(Boolean);
      for (const id of ids) {
        const a = L.assets[id];
        if (!a || a.status === 'WAITING_UPLOAD') return liErr(res, 400, `Asset ${id} was not uploaded`);
        if (/:video:|:document:/.test(id) && a.status !== 'AVAILABLE') return liErr(res, 400, `Asset ${id} is still processing`);
      }
      const n = ++L.seq;
      const urn = `urn:li:share:70000000000${n}`;
      L.posts.push({ id: urn, ...body, createdAt: Date.now(), publishedAt: Date.now() });
      state.published.push({ platform: body.author.includes('organization') ? 'linkedin-page' : 'linkedin', kind: body.content?.multiImage ? 'multiImage' : body.content?.media?.id?.split(':')[2] || (body.content?.article ? 'article' : 'text'), id: urn, data: body });
      res.writeHead(201, { 'x-restli-id': urn, 'content-type': 'application/json' });
      return res.end('');
    }
    if (r === '/posts' && req.method === 'GET') {
      const author = q.get('author');
      return json(res, 200, { elements: L.posts.filter((p) => p.author === author).slice().reverse().map((p) => ({ id: p.id, commentary: p.commentary, createdAt: p.createdAt, publishedAt: p.publishedAt, content: p.content })) });
    }
    m = /^\/socialActions\/(.+)\/comments$/.exec(r);
    if (m && req.method === 'POST') {
      if (!L.comments) return liErr(res, 403, 'Not enough permissions to access: partnerApiSocialActions.CREATE.20261001', { serviceErrorCode: 100 });
      const id = `urn:li:comment:(${decodeURIComponent(m[1])},${++L.seq})`;
      state.published.push({ platform: 'linkedin', kind: 'comment', id, data: body });
      return json(res, 201, { id, commentUrn: id, message: body.message });
    }
    if (r === '/memberFollowersCount') return L.analytics ? json(res, 200, { elements: [{ memberFollowersCount: 321 }] }) : liErr(res, 403, 'Not enough permissions to access: memberFollowersCount.FINDER-me');
    if (r === '/memberCreatorPostAnalytics') {
      if (!L.analytics) return liErr(res, 403, 'Not enough permissions to access: memberCreatorPostAnalytics.FINDER-entity');
      if (q.get('q') === 'me') {
        const els = [];
        for (let i = 3; i >= 1; i--) { const d = new Date(Date.now() - i * 86400000); els.push({ count: 4 + i, metricType: q.get('queryType'), dateRange: { start: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() } } }); }
        return json(res, 200, { elements: els });
      }
      const counts = { IMPRESSION: 900, MEMBERS_REACHED: 400, REACTION: 25, COMMENT: 6, RESHARE: 2 };
      return json(res, 200, { elements: [{ count: counts[q.get('queryType')] ?? 0, metricType: q.get('queryType') }] });
    }
    if (r.startsWith('/networkSizes/')) return json(res, 200, { firstDegreeSize: 1500 });
    if (r === '/organizationalEntityShareStatistics') {
      if (!L.pageAnalytics) return liErr(res, 403, 'Not enough permissions to access: organizationalEntityShareStatistics.FINDER-organizationalEntity');
      const raw = url.search;
      if (/timeIntervals=/.test(raw)) {
        const els = [];
        for (let i = 3; i >= 1; i--) { const s = Math.floor((Date.now() - i * 86400000) / 86400000) * 86400000; els.push({ timeRange: { start: s, end: s + 86400000 }, totalShareStatistics: { impressionCount: 100 + i, uniqueImpressionsCount: 60, clickCount: 5, likeCount: 7, commentCount: 1, shareCount: 1, engagement: 0.05 } }); }
        return json(res, 200, { elements: els });
      }
      return json(res, 200, { elements: [{ totalShareStatistics: { impressionCount: 777, uniqueImpressionsCount: 500, clickCount: 40, likeCount: 30, commentCount: 4, shareCount: 3 } }] });
    }
    return liErr(res, 404, `fake li: ${req.method} ${r}`);
  }

  async function liup(req, res, url, buf) {
    const id = url.pathname.split('/').pop();
    const u = L.uploads[id];
    if (!u || req.method !== 'PUT') return liErr(res, 404, 'unknown upload');
    if (!String(req.headers.authorization || '').startsWith('Bearer li-at-')) return liErr(res, 401, 'upload needs the bearer token');
    if (u.size !== undefined && buf.length !== u.size) return liErr(res, 400, `part size ${buf.length} != ${u.size}`);
    u.received = buf.length;
    const a = L.assets[u.urn];
    if (a && !a.parts) a.status = u.urn.includes(':document:') ? 'PROCESSING' : 'AVAILABLE';
    res.writeHead(201, { etag: `"etag-${id}"` });
    return res.end();
  }

  return async function handle(seg, req, res, url, q, body, buf) {
    if (seg === 'xwww') { consent(res, q, 'x-code'); return true; }
    if (seg === 'xapi') { await x(req, res, url, q, body, buf); return true; }
    if (seg === 'liwww') { await liwww(req, res, url, q, body); return true; }
    if (seg === 'liapi') { await liapi(req, res, url, q, body); return true; }
    if (seg === 'liup') { await liup(req, res, url, buf); return true; }
    return false;
  };
}
