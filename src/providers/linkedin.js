// LinkedIn providers: a member's own profile ('linkedin', Share on LinkedIn + OpenID Connect) and Company Pages
// ('linkedin-page', Community Management API). Versioned REST API with the LinkedIn-Version header.
// Docs (checked 2026-10, Marketing version 202610): learn.microsoft.com/linkedin → Share on LinkedIn,
// 3-legged OAuth, Programmatic refresh tokens, Posts API, Images/Videos/Documents API, MultiImage API,
// little Text Format, Comments API, Member Post Statistics, Organization Share Statistics, Network Sizes.
import { request, qs, ProviderError } from './http.js';
import { meteredFetch } from '../meter.js';

const PERSONAL_SCOPES = ['openid', 'profile', 'email', 'w_member_social'];
const PAGE_SCOPES = ['r_organization_social', 'w_organization_social', 'rw_organization_admin'];
const ADMIN_ROLES = new Set(['ADMINISTRATOR', 'CONTENT_ADMINISTRATOR', 'DIRECT_SPONSORED_CONTENT_POSTER']);
const DAY = 86400000;
/** Poll delay, never longer than the scheduler's poll interval (tests use a few ms). */
const wait = (ctx, ms) => Math.min(ms, ctx.cfg.scheduler?.pollMs ?? ms);

/** LinkedIn errors: {status, serviceErrorCode, code, message} or OAuth {error, error_description}. */
export function classifyLinkedIn(body, status) {
  let j = null;
  try { j = JSON.parse(body); } catch {}
  if (!j) return null;
  if (typeof j.error === 'string') {
    if (j.error === 'invalid_grant' || /expired|revoked/i.test(j.error_description || '')) return { kind: 'auth', message: 'LinkedIn authorization expired or was revoked; reconnect the LinkedIn account.' };
    if (j.error === 'invalid_client') return { kind: 'permanent', message: 'LinkedIn rejected the app credentials (Client ID / Client Secret).' };
    if (j.error === 'unauthorized_scope_error') return { kind: 'permanent', message: `LinkedIn: this app is not approved for a requested permission (${j.error_description || ''}). Add the matching product in the LinkedIn Developer Portal or remove the scope.` };
    return { kind: status >= 500 ? 'transient' : 'permanent', message: j.error_description || j.error };
  }
  const msg = String(j.message || '');
  if (status === 401 || j.serviceErrorCode === 65601 || /token.*(expired|invalid|revoked)/i.test(msg)) return { kind: 'auth', message: 'LinkedIn access token expired or was revoked.' };
  if (status === 429) return { kind: 'transient', message: 'LinkedIn rate limit reached; will retry.' };
  if (/duplicate/i.test(msg) || j.code === 'DUPLICATE_POST') return { kind: 'permanent', message: 'LinkedIn refused a duplicate post (same text as a recent post).' };
  if (status === 403) return { kind: 'permanent', message: `LinkedIn: ${msg || 'permission denied'}`, code: 'forbidden' };
  if (status >= 500) return { kind: 'transient', message: `LinkedIn error (HTTP ${status}).` };
  return msg ? { kind: 'permanent', message: `LinkedIn: ${msg}` } : null;
}

const RESERVED = /[|{}@[\]()<>#\\*_~]/g;
const esc = (s) => String(s).replace(RESERVED, (c) => `\\${c}`);
/**
 * Plain text → LinkedIn "little text" commentary: every reserved character is backslash-escaped (an
 * unescaped one can cut the post off), and #words become hashtag templates so they stay clickable.
 */
export function littleText(text) {
  const s = String(text || '');
  const re = /(^|[^\p{L}\p{N}_&/])#([\p{L}\p{N}_]+)/gu;
  let out = '';
  let last = 0;
  for (const m of s.matchAll(re)) {
    const at = m.index + m[1].length;
    out += esc(s.slice(last, at)) + `{hashtag|\\#|${esc(m[2])}}`;
    last = at + 1 + m[2].length;
  }
  return out + esc(s.slice(last));
}

export function makeLinkedIn(kind) {
  const page = kind === 'linkedin-page';
  const creds = (cfg) => (page && cfg.linkedinPages?.clientId && cfg.linkedinPages?.clientSecret ? cfg.linkedinPages : cfg.linkedin);
  const extra = (cfg) => String((page ? cfg.linkedinPageExtraScopes : cfg.linkedinExtraScopes) || '').split(/[\s,]+/).filter(Boolean);
  const scopes = (cfg) => [...new Set([...(page ? PAGE_SCOPES : PERSONAL_SCOPES), ...extra(cfg)])];
  const H = (ctx, extraH = {}) => ({ authorization: `Bearer ${ctx.token}`, 'LinkedIn-Version': ctx.cfg.linkedinVersion, 'X-Restli-Protocol-Version': '2.0.0', ...extraH });
  const rest = (cfg, path) => `${cfg.urls.linkedinApi}/rest${path}`;
  const opt = (ctx, more = {}) => ({ headers: H(ctx), classifier: classifyLinkedIn, ...more });
  const author = (integ) => integ.meta?.urn || (page ? `urn:li:organization:${integ.external_id}` : `urn:li:person:${integ.external_id}`);

  async function token(cfg, form) {
    const c = creds(cfg);
    const t = await request(`${cfg.urls.linkedinWww}/oauth/v2/accessToken`, { classifier: classifyLinkedIn, form: { ...form, client_id: c.clientId, client_secret: c.clientSecret } });
    const now = Date.now();
    return {
      access_token: t.access_token, refresh_token: t.refresh_token || null,
      token_expires_at: now + (Number(t.expires_in) || 60 * 86400) * 1000,
      refresh_expires_at: t.refresh_token_expires_in ? now + Number(t.refresh_token_expires_in) * 1000 : null,
      scope: String(t.scope || '').split(/[\s,]+/).filter(Boolean),
    };
  }

  /** PUT bytes to a LinkedIn upload URL (streamed); returns the ETag (video parts need it). */
  async function putBytes(ctx, url, md, start, end) {
    const body = await ctx.openMedia(md, start, end);
    let res;
    try {
      res = await meteredFetch(url, { method: 'PUT', headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/octet-stream', 'content-length': String(end - start + 1) }, body, duplex: 'half', signal: AbortSignal.timeout(ctx.cfg.fetchTimeoutMs || 300000) });
    } catch (e) {
      throw new ProviderError('transient', `Network error uploading to LinkedIn: ${e.cause?.code || e.message}`);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const c = classifyLinkedIn(text, res.status) || { kind: res.status >= 500 ? 'transient' : 'permanent', message: `LinkedIn upload failed (HTTP ${res.status}).` };
      throw new ProviderError(c.kind, c.message, { status: res.status, body: text });
    }
    return String(res.headers.get('etag') || '').replace(/^W\//, '').replace(/"/g, '');
  }

  const kindOf = (post) => (post.settings.post_type === 'document' ? 'document' : post.media.some((m) => m.kind === 'video') ? 'video' : post.media.length ? 'image' : 'none');

  const provider = {
    id: kind,
    label: page ? 'LinkedIn Page' : 'LinkedIn',
    get scopes() { return page ? PAGE_SCOPES : PERSONAL_SCOPES; },
    canRefresh: true,
    /** LinkedIn issues refresh tokens only to approved partners; without one the 60-day token cannot be renewed. */
    canRefreshFor: (integ) => !!(integ.refresh_token || integ.meta?.has_refresh),
    classifier: classifyLinkedIn,
    isConfigured: (cfg) => !!(creds(cfg)?.clientId && creds(cfg)?.clientSecret),

    authUrl(cfg, { state, redirectUri }) {
      return `${cfg.urls.linkedinWww}/oauth/v2/authorization?` + qs({ response_type: 'code', client_id: creds(cfg).clientId, redirect_uri: redirectUri, state, scope: scopes(cfg).join(' ') });
    },

    async exchange(cfg, { code, redirectUri }) {
      const t = await token(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      const need = page ? ['w_organization_social'] : ['w_member_social'];
      const missing = t.scope.length ? need.filter((s) => !t.scope.includes(s)) : [];
      if (missing.length) throw new ProviderError('permanent', `LinkedIn did not grant ${missing.join(', ')}. Add the ${page ? 'Community Management API' : '"Share on LinkedIn"'} product to the app, then connect again.`);
      const meta = { scopes: t.scope, has_refresh: !!t.refresh_token, refresh_expires_at: t.refresh_expires_at };
      const ctx = { cfg, token: t.access_token };
      if (!page) {
        const u = await request(`${cfg.urls.linkedinApi}/v2/userinfo`, { headers: { authorization: `Bearer ${t.access_token}` }, classifier: classifyLinkedIn });
        if (!u.sub) throw new ProviderError('permanent', 'LinkedIn did not return the member id. Add the "Sign In with LinkedIn using OpenID Connect" product to the app.');
        return [{ external_id: String(u.sub), name: u.name || [u.given_name, u.family_name].filter(Boolean).join(' ') || 'LinkedIn member', username: u.email || '', picture: u.picture || '',
          access_token: t.access_token, refresh_token: t.refresh_token || '', token_expires_at: t.token_expires_at, meta: { ...meta, urn: `urn:li:person:${u.sub}` } }];
      }
      const acl = await request(rest(cfg, '/organizationAcls?') + qs({ q: 'roleAssignee', state: 'APPROVED', count: 100 }), opt(ctx));
      const orgs = [...new Set((acl.elements || []).filter((e) => ADMIN_ROLES.has(e.role)).map((e) => String(e.organization || e.organizationTarget || '')).filter((u) => u.startsWith('urn:li:organization:')))];
      const out = [];
      for (const urn of orgs.slice(0, 50)) {
        const id = urn.split(':').pop();
        let o = {};
        try { o = await request(rest(cfg, `/organizations/${id}`), opt(ctx)); } catch (e) { if (e.kind === 'auth') throw e; }
        out.push({ external_id: id, name: o.localizedName || `LinkedIn Page ${id}`, username: o.vanityName ? `linkedin.com/company/${o.vanityName}` : '', picture: '',
          access_token: t.access_token, refresh_token: t.refresh_token || '', token_expires_at: t.token_expires_at, meta: { ...meta, urn } });
      }
      return out;
    },

    async refresh(cfg, integration) {
      if (!integration.refresh_token) {
        throw new ProviderError('auth', 'LinkedIn access tokens last 60 days and LinkedIn gives refresh tokens only to approved partner apps. Reconnect the account.');
      }
      const t = await token(cfg, { grant_type: 'refresh_token', refresh_token: integration.refresh_token });
      return { access_token: t.access_token, refresh_token: t.refresh_token || integration.refresh_token, token_expires_at: t.token_expires_at };
    },

    async healthCheck(ctx) {
      if (!page) {
        const u = await request(`${ctx.cfg.urls.linkedinApi}/v2/userinfo`, { headers: { authorization: `Bearer ${ctx.token}` }, classifier: classifyLinkedIn });
        if (String(u.sub) !== String(ctx.integration.external_id)) throw new ProviderError('disconnect', 'The LinkedIn login belongs to a different member now; reconnect.');
        return;
      }
      await request(rest(ctx.cfg, `/organizations/${ctx.integration.external_id}`), opt(ctx));
    },

    // ---- publishing ----------------------------------------------------------------------------
    async publishStart(ctx) {
      return { status: 'pending', delayMs: 0, data: { m: 0, assets: [], cur: null, wait: null, kind: kindOf(ctx.post) } };
    },

    /** Waits until an uploaded video/document is AVAILABLE before the post references it. */
    async publishCheck(ctx, data) {
      if (!data.wait) return { status: 'ready', data };
      const type = data.wait.startsWith('urn:li:video:') ? 'videos' : 'documents';
      const r = await request(rest(ctx.cfg, `/${type}/${encodeURIComponent(data.wait)}`), opt(ctx));
      if (r.status === 'PROCESSING_FAILED') throw new ProviderError('permanent', `LinkedIn could not process the ${type === 'videos' ? 'video' : 'document'}${r.processingFailureReason ? `: ${r.processingFailureReason}` : ''}.`);
      if (r.status && r.status !== 'AVAILABLE') return { status: 'pending', delayMs: wait(ctx, 5000), data };
      return { status: 'ready', data: { ...data, wait: null } };
    },

    async publishFinalize(ctx, data) {
      const { cfg, post } = ctx;
      const owner = author(ctx.integration);
      const out = { ...data, assets: [...data.assets] };
      const started = Date.now();
      const media = out.kind === 'none' ? [] : post.media;
      while (out.m < media.length) {
        const md = media[out.m];
        const size = ctx.mediaSize(md);
        if (out.kind === 'video') {
          if (!out.cur) {
            const r = await request(rest(cfg, '/videos?action=initializeUpload'), opt(ctx, { json: { initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } } }));
            const v = r.value || {};
            out.cur = { urn: v.video, token: v.uploadToken || '', parts: (v.uploadInstructions || []).map((p) => [p.uploadUrl, Number(p.firstByte), Number(p.lastByte)]), etags: [] };
          }
          while (out.cur.etags.length < out.cur.parts.length) {
            if (ctx.budgetLow?.() || Date.now() - started > (cfg.scheduler?.stepBudgetMs ?? 240000)) return { status: 'pending', delayMs: 0, data: out };
            const [url, a, b] = out.cur.parts[out.cur.etags.length];
            out.cur.etags.push(await putBytes(ctx, url, md, a, b));
            await ctx.heartbeat?.();
          }
          await request(rest(cfg, '/videos?action=finalizeUpload'), opt(ctx, { json: { finalizeUploadRequest: { video: out.cur.urn, uploadToken: out.cur.token, uploadedPartIds: out.cur.etags } } }));
          out.assets.push(out.cur.urn);
          out.wait = out.cur.urn;
        } else {
          const type = out.kind === 'document' ? 'documents' : 'images';
          const r = await request(rest(cfg, `/${type}?action=initializeUpload`), opt(ctx, { json: { initializeUploadRequest: { owner } } }));
          const v = r.value || {};
          await putBytes(ctx, v.uploadUrl, md, 0, size - 1);
          const urn = v.image || v.document;
          out.assets.push(urn);
          if (type === 'documents') out.wait = urn;
        }
        out.cur = null;
        out.m++;
        if (out.wait) return { status: 'pending', delayMs: wait(ctx, 3000), data: out };
        if (ctx.budgetLow?.()) return { status: 'pending', delayMs: 0, data: out };
      }
      const s = post.settings;
      const body = {
        author: owner,
        commentary: littleText(post.caption),
        visibility: page ? 'PUBLIC' : s.visibility || 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      };
      if (out.kind === 'document') body.content = { media: { id: out.assets[0], title: String(s.document_title || post.media[0]?.name || 'Document').slice(0, 400) } };
      else if (out.kind === 'video') body.content = { media: { id: out.assets[0] } };
      else if (out.assets.length === 1) body.content = { media: { id: out.assets[0] } };
      else if (out.assets.length > 1) body.content = { multiImage: { images: out.assets.map((id) => ({ id })) } };
      else if (s.url) body.content = { article: { source: s.url, title: String(s.url_title || s.url).slice(0, 400) } };
      await ctx.irreversible('creating the LinkedIn post');
      const res = await request(rest(cfg, '/posts'), opt(ctx, { json: body, irreversible: true, raw: true, label: 'creating the LinkedIn post' }));
      const text = await res.text().catch(() => '');
      if (res.status !== 201 && !res.ok) {
        const c = classifyLinkedIn(text, res.status) || { kind: res.status >= 500 ? 'transient' : 'permanent', message: `LinkedIn post failed (HTTP ${res.status}).` };
        // a 5xx after the POST may still have created the post: let recovery decide
        throw new ProviderError(c.kind === 'transient' ? 'unknown_outcome' : c.kind, c.message, { status: res.status, body: text });
      }
      const urn = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id') || (() => { try { return JSON.parse(text).id; } catch { return ''; } })();
      if (!urn) throw new ProviderError('unknown_outcome', 'LinkedIn accepted the post but did not return its id.');
      return { status: 'completed', externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
    },

    /**
     * Interrupted post creation: Pages can list their own posts (r_organization_social) and look for it;
     * member posts cannot be listed without a restricted permission, so the post fails with "check first".
     */
    async recover(ctx, data) {
      if (!page || !data) return null;
      const want = littleText(ctx.post.caption);
      const r = await request(rest(ctx.cfg, '/posts?') + qs({ q: 'author', author: author(ctx.integration), count: 5, sortBy: 'LAST_MODIFIED' }), opt(ctx));
      const hit = (r.elements || []).find((p) => p.commentary === want && Date.now() - Number(p.createdAt || p.publishedAt || 0) < DAY);
      if (hit) return { status: 'completed', externalId: hit.id, url: `https://www.linkedin.com/feed/update/${hit.id}/` };
      return { status: 'ready', data };
    },

    /** First comment (Comments API). Needs w_member_social_feed / w_organization_social_feed (Community Management). */
    async comment(ctx, postUrn, message) {
      try {
        const res = await request(rest(ctx.cfg, `/socialActions/${encodeURIComponent(postUrn)}/comments`), opt(ctx, { json: { actor: author(ctx.integration), object: postUrn, message: { text: String(message) } } }));
        return String(res.id || res.commentUrn || '');
      } catch (e) {
        if (e.status === 403) throw new ProviderError('permanent', `LinkedIn first comments need the Community Management API permission ${page ? 'w_organization_social_feed' : 'w_member_social_feed'} on your LinkedIn app.`);
        throw e;
      }
    },

    // ---- analytics ---------------------------------------------------------------------------
    async accountAnalytics(ctx, { since, until }) {
      const out = { daily: [], snapshot: {}, unavailable: {}, sources: {}, notices: [], flags: {} };
      const approval = (what, scope) => ({ code: 'needs_approval', action: 'guide', url: '/docs/setup/linkedin#analytics', metrics: what,
        text: `LinkedIn shares ${page ? 'Page' : 'post'} analytics only with apps approved for the Community Management API (${scope}). Published posts still show here.` });
      const day = (ms) => new Date(ms).toISOString().slice(0, 10);
      if (!page) {
        try {
          const f = await request(rest(ctx.cfg, '/memberFollowersCount?q=me'), opt(ctx));
          const n = f.elements?.[0]?.memberFollowersCount;
          if (n !== undefined) out.snapshot.followers = Number(n);
        } catch (e) {
          if (e.kind === 'auth' && e.status === 401) throw e;
          out.unavailable.followers = 'Needs r_member_profileAnalytics (Community Management API)';
        }
        const s = new Date(Math.max(since, until - 365 * DAY)), u = new Date(until);
        const range = `(start:(day:${s.getUTCDate()},month:${s.getUTCMonth() + 1},year:${s.getUTCFullYear()}),end:(day:${u.getUTCDate()},month:${u.getUTCMonth() + 1},year:${u.getUTCFullYear()}))`;
        try {
          const r = await request(rest(ctx.cfg, `/memberCreatorPostAnalytics?q=me&queryType=REACTION&aggregation=DAILY&dateRange=${range}`), opt(ctx));
          for (const el of r.elements || []) {
            const st = el.dateRange?.start;
            if (st) out.daily.push({ metric: 'likes', day: `${st.year}-${String(st.month).padStart(2, '0')}-${String(st.day).padStart(2, '0')}`, value: Number(el.count) || 0 });
          }
        } catch (e) {
          if (e.kind === 'auth' && e.status === 401) throw e;
          out.flags.liPostAnalyticsOff = true;
          for (const m of ['views', 'reach', 'likes', 'comments', 'shares']) out.unavailable[m] = 'Needs r_member_postAnalytics (Community Management API)';
          out.notices.push(approval(['views', 'reach', 'likes', 'comments', 'shares', 'followers'], 'r_member_postAnalytics'));
        }
        out.derived = { net_followers: 'followers' };
        return out;
      }
      const org = author(ctx.integration);
      try {
        const n = await request(rest(ctx.cfg, `/networkSizes/${encodeURIComponent(org)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`), opt(ctx));
        if (n.firstDegreeSize !== undefined) out.snapshot.followers = Number(n.firstDegreeSize);
      } catch (e) {
        if (e.kind === 'auth' && e.status === 401) throw e;
        out.unavailable.followers = `LinkedIn: ${e.message}`.slice(0, 200);
      }
      const start = Math.max(since, until - 360 * DAY);
      try {
        const r = await request(rest(ctx.cfg, `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(org)}&timeIntervals=(timeRange:(start:${start},end:${until}),timeGranularityType:DAY)`), opt(ctx));
        const map = { impressionCount: 'views', uniqueImpressionsCount: 'reach', clickCount: 'clicks', likeCount: 'likes', commentCount: 'comments', shareCount: 'shares' };
        for (const el of r.elements || []) {
          const d = day(Number(el.timeRange?.start));
          for (const [k, m] of Object.entries(map)) if (el.totalShareStatistics?.[k] !== undefined) out.daily.push({ metric: m, day: d, value: Number(el.totalShareStatistics[k]) || 0 });
        }
      } catch (e) {
        if (e.kind === 'auth' && e.status === 401) throw e;
        out.flags.liPostAnalyticsOff = true;
        for (const m of ['views', 'reach', 'clicks', 'likes', 'comments', 'shares']) out.unavailable[m] = 'Needs rw_organization_admin (Community Management API)';
        out.notices.push(approval(['views', 'reach', 'clicks', 'likes', 'comments', 'shares'], 'rw_organization_admin'));
      }
      return out;
    },

    /** Pages can list their own posts; member posts need a restricted permission, so only postlite's own are tracked. */
    async recentPosts(ctx, limit) {
      if (!page) return [];
      const r = await request(rest(ctx.cfg, '/posts?') + qs({ q: 'author', author: author(ctx.integration), count: Math.min(50, limit), sortBy: 'LAST_MODIFIED' }), opt(ctx));
      return (r.elements || []).map((p) => ({
        external_id: String(p.id), caption: String(p.commentary || '').replace(/\\([|{}@[\]()<>#\\*_~])/g, '$1').replace(/\{hashtag\|\\?#\|([^}]+)\}/g, '#$1').slice(0, 500),
        permalink: `https://www.linkedin.com/feed/update/${p.id}/`, published_at: Number(p.publishedAt || p.createdAt) || null, thumbnail: '',
        kind: p.content?.media?.id?.includes(':video:') ? 'video' : p.content?.multiImage ? 'carousel' : p.content?.media ? 'post' : 'post',
      }));
    },

    async postAnalytics(ctx, item) {
      const metrics = {};
      const unavailable = {};
      if (ctx.flags?.liPostAnalyticsOff) return { metrics, unavailable: { views: 'Needs the Community Management API (LinkedIn analytics)' } };
      const urn = String(item.external_id);
      if (page) {
        const key = urn.includes(':ugcPost:') ? 'ugcPosts' : 'shares';
        const r = await request(rest(ctx.cfg, `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(author(ctx.integration))}&${key}=List(${encodeURIComponent(urn)})`), opt(ctx));
        const t = r.elements?.[0]?.totalShareStatistics || {};
        const map = { impressionCount: 'views', uniqueImpressionsCount: 'reach', clickCount: 'clicks', likeCount: 'likes', commentCount: 'comments', shareCount: 'shares' };
        for (const [k, m] of Object.entries(map)) if (t[k] !== undefined) metrics[m] = Number(t[k]) || 0;
        return { metrics, unavailable };
      }
      const ent = urn.includes(':ugcPost:') ? `(ugc:${encodeURIComponent(urn)})` : `(share:${encodeURIComponent(urn)})`;
      const types = { IMPRESSION: 'views', MEMBERS_REACHED: 'reach', REACTION: 'likes', COMMENT: 'comments', RESHARE: 'shares' };
      for (const [q, m] of Object.entries(types)) {
        try {
          const r = await request(rest(ctx.cfg, `/memberCreatorPostAnalytics?q=entity&entity=${ent}&queryType=${q}&aggregation=TOTAL`), opt(ctx));
          metrics[m] = Number(r.elements?.[0]?.count) || 0;
        } catch (e) {
          if (e.kind === 'auth' && e.status === 401) throw e;
          if (e.status === 403) { if (ctx.flags) ctx.flags.liPostAnalyticsOff = true; unavailable[m] = 'Needs r_member_postAnalytics (Community Management API)'; break; }
          unavailable[m] = `LinkedIn: ${e.message}`.slice(0, 200);
        }
      }
      return { metrics, unavailable };
    },
  };
  return provider;
}

export const linkedin = makeLinkedIn('linkedin');
export const linkedinPage = makeLinkedIn('linkedin-page');
