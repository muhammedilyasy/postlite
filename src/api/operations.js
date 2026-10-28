// Operation registry — the single source of truth for the REST API (/api/v1), the OpenAPI spec,
// the MCP tools and the CLI. Each operation declares its HTTP route, required scope, JSON schema
// input and an agent-oriented description.
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';
import { HttpError } from '../media.js';
import { validate } from './schema.js';
import { PLATFORMS, LIMITS, YOUTUBE_CATEGORIES, defaultSettings, validatePost, describeKind } from '../shared/validate.js';
import { parseLocal, nextSlots, formatLocal } from '../shared/time.js';
import { SCOPES, SCOPE_HELP } from '../apikeys.js';
import { WEBHOOK_EVENTS } from '../webhooks.js';
import { providers } from '../providers/index.js';

const DAY = 86400000;
const S = (o) => ({ type: 'object', additionalProperties: false, ...o });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const id = (what) => str(`${what} id (UUID)`, { minLength: 1 });
const timeInput = (d) => ({ type: ['string', 'integer'], description: d });
const TIME_HELP = 'ISO-8601 with offset ("2026-11-02T09:30:00+05:30"), epoch milliseconds, or local "YYYY-MM-DDTHH:mm" interpreted in the server timezone (see get_settings).';

export const SETTINGS_SCHEMAS = {
  youtube: S({
    properties: {
      title: str('Video title (2–100 chars, required to publish). No < or >.', { maxLength: 100 }),
      privacy: { type: 'string', enum: ['public', 'unlisted', 'private'], description: 'Default public. Unverified Google projects can only upload private videos until audited.' },
      madeForKids: { type: 'string', enum: ['yes', 'no'], description: 'COPPA self-declaration. Default "no".' },
      notifySubscribers: { type: 'boolean', description: 'Send notification to subscribers. Default true.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags; total length ≤ 500 chars (tags with spaces count +2).' },
      categoryId: { type: 'string', enum: YOUTUBE_CATEGORIES.map(([i]) => i), description: `Category id. Default "22" (People & Blogs). ${YOUTUBE_CATEGORIES.map(([i, n]) => `${i}=${n}`).join(', ')}` },
      isShort: { type: 'boolean', description: 'Mark as a Short: validates vertical/square video ≤ 3 minutes. YouTube decides Shorts by format.' },
      thumbnail: { type: ['string', 'null'], description: 'Media id of a JPEG/PNG custom thumbnail (≤ 2 MB). Needs a phone-verified channel.' },
    },
  }),
  facebook: S({
    properties: {
      post_type: { type: 'string', enum: ['post', 'reel', 'story'], description: 'post = text/link/photos/video feed post; reel = one vertical video 3–90s; story = photos/videos as stories.' },
      url: str('Link to attach (text/link posts only).'),
      title: str('Video title (video posts/reels).'),
      first_comment: str('Optional first comment posted right after publishing.'),
    },
  }),
  instagram: S({
    properties: {
      post_type: { type: 'string', enum: ['post', 'story'], description: 'post: 1 image = image post, 1 video = Reel, 2–10 items = carousel. story: each item becomes a story.' },
      collaborators: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Up to 3 public usernames to invite as collaborators (not for stories).' },
      is_trial_reel: { type: 'boolean', description: 'Publish a single video as a Trial Reel (shown to non-followers first).' },
      graduation_strategy: { type: 'string', enum: ['MANUAL', 'SS_PERFORMANCE'], description: 'Trial Reel graduation strategy.' },
      share_to_feed: { type: 'boolean', description: 'Reels: also show in the main feed. Default true.' },
      thumb_offset: { type: 'integer', minimum: 0, description: 'Reels: cover frame offset in milliseconds.' },
      first_comment: str('Optional first comment (not for stories).'),
    },
  }),
};
SETTINGS_SCHEMAS['instagram-standalone'] = SETTINGS_SCHEMAS.instagram;

const TARGET = S({
  required: ['account_id'],
  properties: {
    account_id: str('Connected account id from list_accounts.'),
    content: { type: ['string', 'null'], description: 'Per-account caption override. Omit/null to use the global content.' },
    media_ids: { type: ['array', 'null'], items: { type: 'string' }, description: 'Per-account media override (ordered). Omit/null to use global media_ids.' },
    settings: { type: 'object', description: 'Platform settings — see list_platforms for the schema per provider (e.g. YouTube title/privacy, Instagram post_type).' },
  },
});

const POST_BODY = {
  content: str('Global caption/description used by every target unless overridden.'),
  media_ids: { type: 'array', items: { type: 'string' }, description: 'Ordered media ids (from upload_media_from_url / upload_media_base64 / list_media).' },
  targets: { type: 'array', items: TARGET, minItems: 1, description: 'One entry per account to publish to.' },
  mode: { type: 'string', enum: ['draft', 'schedule', 'now', 'next_slot'], description: 'draft (default without publish_at), schedule (needs publish_at), now, or next_slot (next free posting slot).' },
  publish_at: timeInput(`When to publish. ${TIME_HELP}`),
};

// ---------------------------------------------------------------------------------------------

function need(principal, scope) {
  if (!principal) throw new HttpError(401, 'Authentication required.');
  if (principal.scopes.includes('admin') || principal.scopes.includes(scope)) return;
  throw new HttpError(403, `This API key lacks the "${scope}" scope (${SCOPE_HELP[scope]}). Ask the owner to grant it in Settings → API keys.`, { required_scope: scope });
}

function parseTime(v, tz, field = 'publish_at') {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  if (/^\d{10,13}$/.test(String(v))) return parseTime(Number(v), tz, field);
  const t = parseLocal(v, tz);
  if (Number.isNaN(t)) throw new HttpError(400, `${field} "${v}" is not a valid time. ${TIME_HELP}`);
  return t;
}

function range(input, tz, defDays = 30) {
  const to = parseTime(input.to, tz, 'to') ?? Date.now();
  const from = parseTime(input.from, tz, 'from') ?? to - defDays * DAY;
  if (from > to) throw new HttpError(400, '"from" must be before "to".');
  return { from, to };
}

function friendlyValidation(core, e) {
  if (e instanceof HttpError && e.status === 422 && e.extra?.errors) {
    const lines = [];
    const by = {};
    for (const [accId, errs] of Object.entries(e.extra.errors)) {
      const a = core.integrations.get(accId);
      const label = a ? `${a.name} (${a.provider})` : accId;
      by[accId] = { account: label, errors: errs };
      for (const x of errs) lines.push(`• ${label}: ${x}`);
    }
    return new HttpError(422, `Validation failed:\n${lines.join('\n')}\nFix the content/settings (call list_platforms for the rules) or use validate_post to dry-run.`, { errors: by });
  }
  return e;
}

function nextSlotTime(core, from = Date.now()) {
  const s = core.settings.get();
  const taken = new Set(core.db.all("SELECT publish_at FROM posts WHERE status IN ('scheduled','pending_approval') AND publish_at >= ?", from).map((r) => Math.floor(r.publish_at / 60000)));
  const [t] = nextSlots(s.posting_slots, s.timezone, { from, count: 1, isTaken: (ms) => taken.has(Math.floor(ms / 60000)) });
  if (!t) throw new HttpError(409, 'No free posting slot in the next 60 days. Add slots with update_settings(posting_slots).');
  return t;
}

function groupOrThrow(core, postId) {
  const g = core.posts.getGroup(postId);
  if (!g) throw new HttpError(404, `Post ${postId} not found. Use list_posts to find ids.`);
  return g;
}

/** Turn API input into posts.saveGroup input (merging with an existing post for updates). */
function toSaveInput(core, input, existing, principal) {
  const tz = core.settings.get().timezone;
  let mode = input.mode;
  if (!mode) {
    if (input.publish_at !== undefined) mode = 'schedule';
    else if (existing && ['scheduled', 'pending_approval'].includes(existing.status)) mode = 'schedule';
    else mode = 'draft';
  }
  if (mode !== 'draft') need(principal, 'publish');
  let publish_at = parseTime(input.publish_at, tz) ?? existing?.publish_at ?? null;
  if (mode === 'next_slot') { publish_at = nextSlotTime(core); mode = 'schedule'; }
  if (mode === 'schedule' && !publish_at) throw new HttpError(400, 'mode "schedule" needs publish_at. Or use mode "next_slot" / "now".');
  const prevTargets = Object.fromEntries((existing?.targets || []).map((t) => [t.integration_id, t]));
  const targets = (input.targets || existing?.targets?.map((t) => ({ account_id: t.integration_id })) || []).map((t) => {
    const a = core.integrations.get(t.account_id);
    if (!a) throw new HttpError(400, `Unknown account_id "${t.account_id}". Call list_accounts to get valid ids.`);
    const prev = prevTargets[t.account_id];
    const settings = { ...(prev?.settings || defaultSettings(a.provider)), ...(t.settings || {}) };
    const errs = validate(SETTINGS_SCHEMAS[a.provider], t.settings || {}, `targets[${a.name}].settings`);
    if (errs.length) throw new HttpError(400, `Invalid settings for ${a.name} (${a.provider}):\n• ${errs.join('\n• ')}`, { errors: errs });
    return {
      integration_id: a.id,
      content_override: t.content !== undefined ? t.content : prev?.content_override ?? null,
      media_override: t.media_ids !== undefined ? t.media_ids : prev?.media_override ?? null,
      settings,
    };
  });
  return {
    content: input.content ?? existing?.content ?? '',
    media: input.media_ids ?? existing?.media?.map((m) => m.id) ?? [],
    publish_at,
    action: mode,
    posts: targets,
  };
}

const withNote = (core, g, principal) => ({
  post: g,
  ...(g.status === 'pending_approval' ? { note: `Awaiting human approval (key "${principal?.name}" is in approval mode). The owner can approve in the web UI (Approvals) or via approve_post with an admin key.` } : {}),
});

async function fetchMediaFromUrl(core, url, filename) {
  let current = String(url);
  for (let hop = 0; hop < 4; hop++) {
    let u;
    try { u = new URL(current); } catch { throw new HttpError(400, `Invalid URL: ${current}`); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Only http(s) URLs are allowed.');
    if (!core.cfg.allowPrivateMediaUrls) {
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
      if (!addrs.length) throw new HttpError(400, `Cannot resolve host ${host}.`);
      for (const { address } of addrs) if (isPrivateIp(address)) throw new HttpError(400, `Refusing to fetch from private address ${address} (set ALLOW_PRIVATE_MEDIA_URLS=1 to allow).`);
    }
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(300000) }).catch((e) => { throw new HttpError(502, `Download failed: ${e.cause?.code || e.message}`); });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { current = new URL(res.headers.get('location'), current).toString(); continue; }
    if (!res.ok || !res.body) throw new HttpError(502, `Download failed: HTTP ${res.status} from ${u.host}.`);
    const name = filename || decodeURIComponent(u.pathname.split('/').pop() || 'download');
    return core.media.save(Readable.fromWeb(res.body), name);
  }
  throw new HttpError(400, 'Too many redirects.');
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || (l.startsWith('::ffff:') && isPrivateIp(l.slice(7)));
}

function mediaInUse(core, mediaId) {
  const like = `%${mediaId}%`;
  return core.db.get(`SELECT 1 FROM posts p JOIN groups g ON g.id = p.group_id WHERE p.status IN ('draft','scheduled','pending_approval','publishing','failed')
    AND (g.media LIKE ? OR p.media_override LIKE ? OR p.settings LIKE ?) LIMIT 1`, like, like, like);
}

const mediaOut = (core, m) => m && { ...core.media.view(m), public_url: core.media.publicUrl(m) };

function platformInfo(core) {
  const accounts = core.integrations.list();
  return Object.entries(PLATFORMS).map(([pid, meta]) => ({
    provider: pid,
    label: meta.label,
    configured: providers[pid].isConfigured(core.cfg),
    connected_accounts: accounts.filter((a) => a.provider === pid).length,
    caption_limit: meta.maxCaption,
    limits: LIMITS[pid === 'instagram-standalone' ? 'instagram' : pid],
    default_settings: defaultSettings(pid),
    settings_schema: SETTINGS_SCHEMAS[pid],
    rules: RULES[pid],
    example_target: EXAMPLES[pid],
  }));
}

const RULES = {
  youtube: ['Exactly one video (MP4/MOV).', 'settings.title is required (2–100 chars).', 'Description = caption, ≤ 5000 chars, no < or >.', 'Shorts: vertical/square and ≤ 3 minutes.', 'Uploads count against YouTube\'s videos.insert quota bucket (default 100 uploads/day per Google Cloud project); thumbnails.set costs 50 of the 10,000 daily units.', 'Unverified Google Cloud projects upload as private until they pass the API audit.'],
  facebook: ['Text, link, 1–10 photos, or one video per feed post (no photo+video mix).', 'Reels: one vertical video 3–90 s.', 'Stories: at least one photo/video; caption not shown.', 'Photos ≤ 4 MB.'],
  instagram: ['At least one media item; JPEG images only.', 'Carousel: 2–10 items (images and videos ≤ 60 s).', 'Single video becomes a Reel (3 s–15 min).', 'Feed images aspect ratio 4:5 to 1.91:1.', 'Caption ≤ 2200 chars, ≤ 30 hashtags, ≤ 20 @mentions.', 'Stories: each item becomes its own story (videos ≤ 60 s).', 'Media must be reachable by Meta at PUBLIC_URL over HTTPS.'],
};
RULES['instagram-standalone'] = RULES.instagram;
const EXAMPLES = {
  youtube: { account_id: '<youtube account id>', settings: { title: 'My first Short', privacy: 'public', isShort: true, tags: ['shorts', 'howto'] } },
  facebook: { account_id: '<facebook page id>', settings: { post_type: 'post', first_comment: 'Link in bio!' } },
  instagram: { account_id: '<instagram account id>', settings: { post_type: 'post', collaborators: ['partner_brand'] } },
  'instagram-standalone': { account_id: '<instagram account id>', settings: { post_type: 'story' } },
};

// ---------------------------------------------------------------------------------------------

/** @type {Array<{name:string,method:string,path:string,scope:string|null,summary:string,description:string,input:object,handler:Function,readOnly?:boolean,destructive?:boolean,mcp?:boolean,tags:string[]}>} */
export const operations = [
  // ---- meta ----
  {
    name: 'whoami', method: 'GET', path: '/me', scope: null, tags: ['meta'], readOnly: true,
    summary: 'Identify the caller and server settings',
    description: 'Returns the authenticated principal (API key name, scopes, approval mode), server time, timezone and public URL. Call this first to learn what you are allowed to do.',
    input: S({ properties: {} }),
    handler: (core, _i, p) => ({ principal: { type: p.type, id: p.id, name: p.name, scopes: p.scopes, approval_mode: !!p.approval }, server_time: new Date().toISOString(), timezone: core.settings.get().timezone, public_url: core.cfg.publicUrl, scope_help: SCOPE_HELP }),
  },
  {
    name: 'list_platforms', method: 'GET', path: '/platforms', scope: 'read', tags: ['meta'], readOnly: true,
    summary: 'Supported platforms, rules and per-platform settings schemas',
    description: 'Lists YouTube, Facebook Pages, Instagram (via Facebook) and Instagram (Instagram Login) with caption limits, media rules, the JSON schema of targets[].settings, defaults and an example target. Read this before composing posts.',
    input: S({ properties: {} }),
    handler: (core) => ({ platforms: platformInfo(core) }),
  },
  // ---- accounts ----
  {
    name: 'list_accounts', method: 'GET', path: '/accounts', scope: 'read', tags: ['accounts'], readOnly: true,
    summary: 'List connected accounts',
    description: 'Connected YouTube channels, Facebook Pages and Instagram accounts with status ("active" or "needs_reconnect"). Use the "id" as account_id in targets.',
    input: S({ properties: { provider: { type: 'string', enum: Object.keys(PLATFORMS), description: 'Filter by provider.' } } }),
    handler: (core, i) => ({ accounts: core.integrations.list().filter((a) => !i.provider || a.provider === i.provider) }),
  },
  {
    name: 'get_account', method: 'GET', path: '/accounts/{account_id}', scope: 'read', tags: ['accounts'], readOnly: true,
    summary: 'Get one account', description: 'Details and token health of one connected account.',
    input: S({ required: ['account_id'], properties: { account_id: id('Account') } }),
    handler: (core, i) => {
      const a = core.integrations.get(i.account_id);
      if (!a) throw new HttpError(404, `Account ${i.account_id} not found. Call list_accounts.`);
      return { account: a, analytics: core.analytics.status(a.id) };
    },
  },
  {
    name: 'check_account', method: 'POST', path: '/accounts/{account_id}/check', scope: 'read', tags: ['accounts'],
    summary: 'Verify an account token now', description: 'Calls the platform to verify the token still works; refreshes it if possible. Marks the account "needs_reconnect" when revoked/expired.',
    input: S({ required: ['account_id'], properties: { account_id: id('Account') } }),
    handler: async (core, i) => {
      if (!core.integrations.get(i.account_id)) throw new HttpError(404, 'Account not found.');
      const r = await core.integrations.check(i.account_id);
      return { ...r, account: core.integrations.get(i.account_id) };
    },
  },
  {
    name: 'get_connect_url', method: 'POST', path: '/accounts/connect', scope: 'admin', tags: ['accounts'],
    summary: 'Get an OAuth URL to connect (or reconnect) an account',
    description: 'Returns a one-time URL (valid 30 min) that a HUMAN must open in a browser to authorize postlite. All pages/channels returned by the login are connected automatically. Use reconnect_account_id to repair an account in "needs_reconnect". Example: {"provider":"youtube"}.',
    input: S({ required: ['provider'], properties: { provider: { type: 'string', enum: Object.keys(PLATFORMS) }, reconnect_account_id: str('Existing account id to reconnect.') } }),
    handler: (core, i) => {
      const r = core.oauth.start(i.provider, { autoSelect: true, reconnectId: i.reconnect_account_id || null });
      return { url: r.url, expires_in_sec: r.expires_in_sec, instructions: 'Open this URL in a browser logged into the right account and approve all permissions. Then call list_accounts.', redirect_uri: core.oauth.redirectUri(i.provider) };
    },
  },
  {
    name: 'disconnect_account', method: 'DELETE', path: '/accounts/{account_id}', scope: 'admin', tags: ['accounts'], destructive: true,
    summary: 'Disconnect an account', description: 'Removes the account, its stored tokens, its unpublished posts and analytics. Irreversible.',
    input: S({ required: ['account_id'], properties: { account_id: id('Account') } }),
    handler: (core, i) => {
      if (!core.integrations.get(i.account_id)) throw new HttpError(404, 'Account not found.');
      core.integrations.remove(i.account_id);
      return { deleted: true };
    },
  },
  // ---- media ----
  {
    name: 'list_media', method: 'GET', path: '/media', scope: 'read', tags: ['media'], readOnly: true,
    summary: 'List uploaded media', description: 'Recently uploaded media with kind, mime, size, width/height and duration (seconds).',
    input: S({ properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } } }),
    handler: (core, i) => ({ media: core.db.all('SELECT * FROM media ORDER BY created_at DESC LIMIT ?', i.limit || 100).map((m) => mediaOut(core, m)) }),
  },
  {
    name: 'get_media', method: 'GET', path: '/media/{media_id}', scope: 'read', tags: ['media'], readOnly: true,
    summary: 'Get media details', description: 'Metadata of one media item including its public URL (what Meta/Google fetch).',
    input: S({ required: ['media_id'], properties: { media_id: id('Media') } }),
    handler: (core, i) => {
      const m = core.media.get(i.media_id);
      if (!m) throw new HttpError(404, 'Media not found.');
      return { media: mediaOut(core, m) };
    },
  },
  {
    name: 'upload_media_from_url', method: 'POST', path: '/media/from-url', scope: 'write', tags: ['media'],
    summary: 'Import media from a URL',
    description: 'Downloads an image (JPEG/PNG/GIF/WebP) or video (MP4/MOV) from a public URL and stores it. Returns the media id plus detected width/height/duration for validation. Example: {"url":"https://example.com/clip.mp4"}.',
    input: S({ required: ['url'], properties: { url: str('Public http(s) URL of the file.'), filename: str('Optional display name.') } }),
    handler: async (core, i) => ({ media: mediaOut(core, await fetchMediaFromUrl(core, i.url, i.filename)) }),
  },
  {
    name: 'upload_media_base64', method: 'POST', path: '/media/base64', scope: 'write', tags: ['media'],
    summary: 'Upload small media as base64',
    description: 'Upload a file (≤ 25 MB) as base64 when no URL is available. For big videos use upload_media_from_url, the REST endpoint POST /api/v1/media (raw body), or the CLI "postlite media upload <file>".',
    input: S({ required: ['data', 'filename'], properties: { data: str('Base64 file content (no data: prefix needed).'), filename: str('File name, e.g. "photo.jpg".') } }),
    handler: async (core, i) => {
      const b64 = String(i.data).replace(/^data:[^;]+;base64,/, '');
      if (b64.length > 34 * 1024 * 1024) throw new HttpError(413, 'Too large for base64 upload (max ~25 MB). Use upload_media_from_url or the raw REST upload.');
      return { media: mediaOut(core, await core.media.save(Readable.from([Buffer.from(b64, 'base64')]), i.filename)) };
    },
  },
  {
    name: 'delete_media', method: 'DELETE', path: '/media/{media_id}', scope: 'write', tags: ['media'], destructive: true,
    summary: 'Delete media', description: 'Deletes a media file. Refused while an unpublished post still uses it.',
    input: S({ required: ['media_id'], properties: { media_id: id('Media') } }),
    handler: (core, i) => {
      if (!core.media.get(i.media_id)) throw new HttpError(404, 'Media not found.');
      if (mediaInUse(core, i.media_id)) throw new HttpError(409, 'This media is used by an unpublished post. Remove it from the post first.');
      core.media.remove(i.media_id);
      return { deleted: true };
    },
  },
  // ---- posts ----
  {
    name: 'list_posts', method: 'GET', path: '/posts', scope: 'read', tags: ['posts'], readOnly: true,
    summary: 'List posts', description: `List posts (each with per-account "targets") filtered by time range, status, provider or account. Times: ${TIME_HELP} Status values: draft, pending_approval, scheduled, publishing, published, failed.`,
    input: S({ properties: {
      from: timeInput('Start of range (inclusive).'), to: timeInput('End of range (exclusive).'),
      status: { type: 'string', enum: ['draft', 'pending_approval', 'scheduled', 'publishing', 'published', 'failed'] },
      provider: { type: 'string', enum: Object.keys(PLATFORMS) }, account_id: str('Filter by account.'),
      limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 },
    } }),
    handler: (core, i) => {
      const tz = core.settings.get().timezone;
      return { posts: core.posts.listGroups({ from: parseTime(i.from, tz, 'from'), to: parseTime(i.to, tz, 'to'), status: i.status, provider: i.provider, integration_id: i.account_id, limit: i.limit, offset: i.offset }) };
    },
  },
  {
    name: 'get_post', method: 'GET', path: '/posts/{post_id}', scope: 'read', tags: ['posts'], readOnly: true,
    summary: 'Get a post with its targets and event log', description: 'Full post: global content/media, per-account targets (status, published_url, error) and the publish event log.',
    input: S({ required: ['post_id'], properties: { post_id: id('Post') } }),
    handler: (core, i) => {
      const g = groupOrThrow(core, i.post_id);
      return { post: { ...g, targets: g.targets.map((t) => ({ ...t, events: core.posts.events(t.id) })) } };
    },
  },
  {
    name: 'validate_post', method: 'POST', path: '/posts/validate', scope: 'read', tags: ['posts'], readOnly: true,
    summary: 'Dry-run validation of a post',
    description: 'Checks content + media + settings against every target platform\'s rules WITHOUT saving. Returns errors/warnings per account and what will be published (e.g. "Reel", "Carousel (3)"). Same input as create_post.',
    input: S({ required: ['targets'], properties: { ...POST_BODY } }),
    handler: (core, i) => {
      const results = [];
      for (const t of i.targets) {
        const a = core.integrations.get(t.account_id);
        if (!a) { results.push({ account_id: t.account_id, ok: false, errors: ['Unknown account_id — call list_accounts.'], warnings: [] }); continue; }
        const serr = validate(SETTINGS_SCHEMAS[a.provider], t.settings || {}, 'settings');
        const settings = { ...defaultSettings(a.provider), ...(t.settings || {}) };
        const mediaIds = t.media_ids ?? i.media_ids ?? [];
        const missing = mediaIds.filter((m) => !core.media.get(m));
        const media = core.media.getMany(mediaIds);
        const caption = t.content ?? i.content ?? '';
        const thumb = settings.thumbnail ? core.media.get(settings.thumbnail) : null;
        const info = (m) => ({ kind: m.kind, mime: m.mime, size: m.size, width: m.width, height: m.height, duration: m.duration, name: m.original_name });
        const v = validatePost(a.provider, { caption, media: media.map(info), settings, thumbnail: thumb && info(thumb) });
        const errors = [...serr, ...missing.map((m) => `Unknown media id ${m}`), ...v.errors, ...(a.status !== 'active' ? ['Account needs to be reconnected (get_connect_url with reconnect_account_id).'] : [])];
        results.push({ account_id: a.id, account: a.name, provider: a.provider, ok: !errors.length, will_publish: describeKind(a.provider, media, settings), caption_length: [...caption].length, caption_limit: PLATFORMS[a.provider].maxCaption, errors, warnings: v.warnings });
      }
      return { ok: results.every((r) => r.ok), results };
    },
  },
  {
    name: 'create_post', method: 'POST', path: '/posts', scope: 'write', tags: ['posts'],
    summary: 'Create a post (draft, scheduled, next free slot or immediate)',
    description: 'Creates one post for one or more accounts. mode: "draft" (default), "schedule" (+publish_at), "next_slot" or "now". Scheduling needs the "publish" scope; keys in approval mode create posts as "pending_approval" until a human approves. ' +
      'Example: {"content":"New video is live! #howto","media_ids":["<video id>"],"targets":[{"account_id":"<yt id>","settings":{"title":"How to X","isShort":true}},{"account_id":"<ig id>"}],"mode":"schedule","publish_at":"2026-11-02T18:00"}. Validation errors are returned per account with the exact rule that failed.',
    input: S({ required: ['targets'], properties: { ...POST_BODY } }),
    handler: (core, i, p) => {
      const gid = core.posts.saveGroup(toSaveInput(core, i, null, p), null, { principal: p });
      const g = core.posts.getGroup(gid);
      if (g.status === 'pending_approval') core.webhooks.emit('post.pending_approval', { post_id: gid, requested_by: p.name });
      core.scheduler.poke();
      return withNote(core, g, p);
    },
    wrapError: true,
  },
  {
    name: 'update_post', method: 'PATCH', path: '/posts/{post_id}', scope: 'write', tags: ['posts'],
    summary: 'Edit a post', description: 'Partially update content, media, targets (replaces the target list if given; per-target settings are merged), mode or publish_at. Published/publishing targets are immutable. Editing a scheduled post with an approval-mode key sends it back to pending_approval.',
    input: S({ required: ['post_id'], properties: { post_id: id('Post'), ...POST_BODY, targets: { ...POST_BODY.targets, minItems: 1 } } }),
    handler: (core, i, p) => {
      const g = groupOrThrow(core, i.post_id);
      core.posts.saveGroup(toSaveInput(core, i, g, p), g.id, { principal: p });
      const ng = core.posts.getGroup(g.id);
      if (ng.status === 'pending_approval' && g.status !== 'pending_approval') core.webhooks.emit('post.pending_approval', { post_id: g.id, requested_by: p.name });
      core.scheduler.poke();
      return withNote(core, ng, p);
    },
    wrapError: true,
  },
  {
    name: 'schedule_post', method: 'POST', path: '/posts/{post_id}/schedule', scope: 'publish', tags: ['posts'],
    summary: 'Schedule a draft', description: `Schedule a draft (or change the time) using publish_at, or set next_slot=true to use the next free posting slot. ${TIME_HELP}`,
    input: S({ required: ['post_id'], properties: { post_id: id('Post'), publish_at: timeInput('When to publish.'), next_slot: { type: 'boolean' } } }),
    handler: (core, i, p) => {
      const g = groupOrThrow(core, i.post_id);
      if (!i.publish_at && !i.next_slot) throw new HttpError(400, 'Provide publish_at or next_slot=true.');
      core.posts.saveGroup(toSaveInput(core, { mode: i.next_slot ? 'next_slot' : 'schedule', publish_at: i.publish_at }, g, p), g.id, { principal: p });
      const ng = core.posts.getGroup(g.id);
      if (ng.status === 'pending_approval') core.webhooks.emit('post.pending_approval', { post_id: g.id, requested_by: p.name });
      return withNote(core, ng, p);
    },
    wrapError: true,
  },
  {
    name: 'reschedule_post', method: 'POST', path: '/posts/{post_id}/reschedule', scope: 'publish', tags: ['posts'],
    summary: 'Move a post to a new time', description: 'Moves all unpublished targets of a post (keeps content and approval state). Same as drag & drop in the calendar.',
    input: S({ required: ['post_id', 'publish_at'], properties: { post_id: id('Post'), publish_at: timeInput(`New time. ${TIME_HELP}`) } }),
    handler: (core, i) => {
      groupOrThrow(core, i.post_id);
      core.posts.rescheduleGroup(i.post_id, parseTime(i.publish_at, core.settings.get().timezone));
      return { post: core.posts.getGroup(i.post_id) };
    },
  },
  {
    name: 'publish_post_now', method: 'POST', path: '/posts/{post_id}/publish-now', scope: 'publish', tags: ['posts'],
    summary: 'Publish a post immediately', description: 'Queues every not-yet-published target (or only target_ids) for immediate publishing. Approval-mode keys put them in pending_approval instead.',
    input: S({ required: ['post_id'], properties: { post_id: id('Post'), target_ids: { type: 'array', items: { type: 'string' } } } }),
    handler: (core, i, p) => {
      const g = groupOrThrow(core, i.post_id);
      const results = [];
      for (const t of g.targets) {
        if (i.target_ids && !i.target_ids.includes(t.id)) continue;
        if (['published', 'publishing'].includes(t.status)) continue;
        try { results.push({ target_id: t.id, status: core.posts.publishNow(t.id, { principal: p }) }); } catch (e) { results.push({ target_id: t.id, error: friendlyValidation(core, e).message }); }
      }
      core.scheduler.poke();
      return { results, ...withNote(core, core.posts.getGroup(g.id), p) };
    },
  },
  {
    name: 'retry_post', method: 'POST', path: '/posts/{post_id}/retry', scope: 'publish', tags: ['posts'],
    summary: 'Retry failed targets', description: 'Re-queues failed targets of a post for immediate publishing. Check the error first — if it says the post "may have been published", verify on the platform to avoid duplicates.',
    input: S({ required: ['post_id'], properties: { post_id: id('Post'), target_ids: { type: 'array', items: { type: 'string' } } } }),
    handler: (core, i, p) => {
      const g = groupOrThrow(core, i.post_id);
      const failed = g.targets.filter((t) => t.status === 'failed' && (!i.target_ids || i.target_ids.includes(t.id)));
      if (!failed.length) throw new HttpError(409, 'No failed targets to retry.');
      const results = failed.map((t) => {
        try { return { target_id: t.id, status: core.posts.publishNow(t.id, { retry: true, principal: p }) }; } catch (e) { return { target_id: t.id, error: friendlyValidation(core, e).message }; }
      });
      core.scheduler.poke();
      return { results, post: core.posts.getGroup(g.id) };
    },
  },
  {
    name: 'duplicate_post', method: 'POST', path: '/posts/{post_id}/duplicate', scope: 'write', tags: ['posts'],
    summary: 'Duplicate a post as a draft', description: 'Copies content, media, targets and settings into a new draft.',
    input: S({ required: ['post_id'], properties: { post_id: id('Post') } }),
    handler: (core, i) => ({ post: core.posts.getGroup(core.posts.duplicateGroup(i.post_id)) }),
  },
  {
    name: 'delete_post', method: 'DELETE', path: '/posts/{post_id}', scope: 'write', tags: ['posts'], destructive: true,
    summary: 'Delete a post', description: 'Deletes a post and cancels its scheduled targets. Does NOT delete anything already live on the platforms.',
    input: S({ required: ['post_id'], properties: { post_id: id('Post') } }),
    handler: (core, i) => { groupOrThrow(core, i.post_id); core.posts.deleteGroup(i.post_id); return { deleted: true }; },
  },
  {
    name: 'delete_post_target', method: 'DELETE', path: '/posts/{post_id}/targets/{target_id}', scope: 'write', tags: ['posts'], destructive: true,
    summary: 'Remove one account from a post', description: 'Removes one target (account) from a post.',
    input: S({ required: ['post_id', 'target_id'], properties: { post_id: id('Post'), target_id: id('Target') } }),
    handler: (core, i) => {
      const g = groupOrThrow(core, i.post_id);
      if (!g.targets.some((t) => t.id === i.target_id)) throw new HttpError(404, 'Target not found in this post.');
      core.posts.deletePost(i.target_id);
      return { post: core.posts.getGroup(i.post_id) };
    },
  },
  {
    name: 'get_calendar', method: 'GET', path: '/calendar', scope: 'read', tags: ['posts'], readOnly: true,
    summary: 'Calendar entries in a time range', description: `Flat list of per-account entries between from and to (default: next 7 days) plus undated drafts. ${TIME_HELP}`,
    input: S({ properties: { from: timeInput('Start.'), to: timeInput('End.') } }),
    handler: (core, i) => {
      const tz = core.settings.get().timezone;
      const from = parseTime(i.from, tz, 'from') ?? Date.now() - DAY;
      const to = parseTime(i.to, tz, 'to') ?? from + 8 * DAY;
      return { timezone: tz, from, to, entries: core.posts.listRange(from, to), undated_drafts: core.posts.listDrafts() };
    },
  },
  // ---- approvals ----
  {
    name: 'list_pending_approvals', method: 'GET', path: '/approvals', scope: 'read', tags: ['approvals'], readOnly: true,
    summary: 'Posts awaiting approval', description: 'Posts created/changed by approval-mode API keys that need a human decision.',
    input: S({ properties: {} }),
    handler: (core) => ({ posts: core.posts.pendingApprovals() }),
  },
  {
    name: 'approve_post', method: 'POST', path: '/posts/{post_id}/approve', scope: 'admin', tags: ['approvals'],
    summary: 'Approve a pending post', description: 'Approves pending targets (all or target_ids), optionally at a new time. Times in the past publish immediately. Requires an admin key that is NOT in approval mode (or the web UI).',
    input: S({ required: ['post_id'], properties: { post_id: id('Post'), target_ids: { type: 'array', items: { type: 'string' } }, publish_at: timeInput('Optional new time.') } }),
    handler: (core, i, p) => {
      if (p.approval) throw new HttpError(403, 'Keys in approval mode cannot approve posts. A human must approve in the web UI (Approvals) or with a non-approval admin key.');
      groupOrThrow(core, i.post_id);
      const n = core.posts.approve(i.post_id, { target_ids: i.target_ids, publish_at: parseTime(i.publish_at, core.settings.get().timezone), principal: p });
      core.scheduler.poke();
      return { approved: n, post: core.posts.getGroup(i.post_id) };
    },
    wrapError: true,
  },
  {
    name: 'reject_post', method: 'POST', path: '/posts/{post_id}/reject', scope: 'admin', tags: ['approvals'],
    summary: 'Reject a pending post', description: 'Sends pending targets back to draft with a reason the agent can read (approval_note).',
    input: S({ required: ['post_id'], properties: { post_id: id('Post'), reason: str('Why it was rejected / what to change.') } }),
    handler: (core, i, p) => {
      if (p.approval) throw new HttpError(403, 'Keys in approval mode cannot reject posts.');
      groupOrThrow(core, i.post_id);
      const n = core.posts.reject(i.post_id, { reason: i.reason || '', principal: p });
      return { rejected: n, post: core.posts.getGroup(i.post_id) };
    },
  },
  // ---- settings & slots ----
  {
    name: 'get_settings', method: 'GET', path: '/settings', scope: 'read', tags: ['settings'], readOnly: true,
    summary: 'Get settings (timezone, posting slots)', description: 'Timezone used for local times and the weekly posting slots used by mode "next_slot".',
    input: S({ properties: {} }),
    handler: (core) => ({ settings: core.settings.get() }),
  },
  {
    name: 'update_settings', method: 'PATCH', path: '/settings', scope: 'admin', tags: ['settings'],
    summary: 'Update timezone and/or posting slots', description: 'Example: {"timezone":"Asia/Kolkata","posting_slots":{"mon":["09:00","18:30"],"sat":[]}}. Weekdays: mon..sun; times are 24h HH:MM in the timezone.',
    input: S({ properties: { timezone: str('IANA timezone, e.g. "Asia/Kolkata".'), posting_slots: { type: 'object', description: 'Map weekday → ["HH:MM", ...].', additionalProperties: { type: 'array', items: { type: 'string' } } } } }),
    handler: (core, i) => {
      try { return { settings: core.settings.update(i) }; } catch (e) { throw new HttpError(400, e.message); }
    },
  },
  {
    name: 'list_free_slots', method: 'GET', path: '/slots', scope: 'read', tags: ['settings'], readOnly: true,
    summary: 'Next free posting slots', description: 'Next N posting slots not already taken by a scheduled/pending post. Use for "plan a week of posts".',
    input: S({ properties: { count: { type: 'integer', minimum: 1, maximum: 100 }, from: timeInput('Start searching from (default now).') } }),
    handler: (core, i) => {
      const s = core.settings.get();
      const from = parseTime(i.from, s.timezone, 'from') ?? Date.now();
      const taken = new Set(core.db.all("SELECT publish_at FROM posts WHERE status IN ('scheduled','pending_approval') AND publish_at >= ?", from).map((r) => Math.floor(r.publish_at / 60000)));
      const slots = nextSlots(s.posting_slots, s.timezone, { from, count: i.count || 7, isTaken: (ms) => taken.has(Math.floor(ms / 60000)) });
      return { timezone: s.timezone, slots: slots.map((t) => ({ at: new Date(t).toISOString(), local: formatLocal(t, s.timezone), epoch_ms: t })) };
    },
  },
  // ---- analytics ----
  {
    name: 'get_analytics_overview', method: 'GET', path: '/analytics/overview', scope: 'analytics', tags: ['analytics'], readOnly: true,
    summary: 'Analytics summary for all accounts', description: 'Per-account totals for the range (followers + change, views, reach, engagement, watch time...) and which metrics are not available (permissions/deprecations). Default range: last 30 days.',
    input: S({ properties: { from: timeInput('Start.'), to: timeInput('End.') } }),
    handler: (core, i) => {
      const { from, to } = range(i, core.settings.get().timezone);
      return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), accounts: core.integrations.list().map((a) => ({ account_id: a.id, name: a.name, provider: a.provider, summary: core.analytics.summary(a.id, from, to), sync: core.analytics.status(a.id) })) };
    },
  },
  {
    name: 'get_account_analytics', method: 'GET', path: '/analytics/accounts/{account_id}', scope: 'analytics', tags: ['analytics'], readOnly: true,
    summary: 'Account metrics time series', description: 'Daily series per metric (followers, views, reach, profile_views, watch_minutes, ...) and totals for the range.',
    input: S({ required: ['account_id'], properties: { account_id: id('Account'), from: timeInput('Start.'), to: timeInput('End.') } }),
    handler: (core, i) => {
      if (!core.integrations.get(i.account_id)) throw new HttpError(404, 'Account not found.');
      const { from, to } = range(i, core.settings.get().timezone);
      return { account_id: i.account_id, summary: core.analytics.summary(i.account_id, from, to), series: core.analytics.series(i.account_id, from, to), sync: core.analytics.status(i.account_id) };
    },
  },
  {
    name: 'get_top_posts', method: 'GET', path: '/analytics/top-posts', scope: 'analytics', tags: ['analytics'], readOnly: true,
    summary: 'Top posts by a metric', description: 'Posts (published via postlite AND recent posts fetched from the accounts) ranked by latest metric value. sort: views, likes, comments, shares, saves, reach, watch_minutes...',
    input: S({ properties: { account_id: str('Limit to one account.'), from: timeInput('Published after.'), to: timeInput('Published before.'), sort: str('Metric to sort by (default views).'), limit: { type: 'integer', minimum: 1, maximum: 500 } } }),
    handler: (core, i) => {
      const { from, to } = range(i, core.settings.get().timezone, 90);
      return { posts: core.analytics.topPosts({ integrationId: i.account_id || null, from, to, sort: i.sort || 'views', limit: i.limit || 20 }) };
    },
  },
  {
    name: 'get_post_metrics', method: 'GET', path: '/posts/{post_id}/metrics', scope: 'analytics', tags: ['analytics'], readOnly: true,
    summary: 'Metrics of a published post', description: 'Latest metrics and snapshot history for each published target of a post.',
    input: S({ required: ['post_id'], properties: { post_id: id('Post') } }),
    handler: (core, i) => {
      const g = groupOrThrow(core, i.post_id);
      return {
        targets: g.targets.map((t) => {
          if (!t.external_id) return { target_id: t.id, provider: t.provider, status: t.status, metrics: null, note: 'Not published yet.' };
          const series = core.analytics.postSeries(t.integration_id, t.external_id);
          const latest = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v[v.length - 1].value]));
          return { target_id: t.id, provider: t.provider, published_url: t.published_url, latest, series, unavailable: core.analytics.status(t.integration_id)?.unavailable?.posts || {}, ...(Object.keys(latest).length ? {} : { note: 'No metrics yet — run sync_analytics.' }) };
        }),
      };
    },
  },
  {
    name: 'sync_analytics', method: 'POST', path: '/analytics/sync', scope: 'analytics', tags: ['analytics'],
    summary: 'Sync analytics now', description: 'Fetches fresh account and post metrics from the platforms (all accounts or one). Can take a while for many accounts.',
    input: S({ properties: { account_id: str('Only this account.') } }),
    handler: async (core, i) => {
      if (i.account_id) {
        if (!core.integrations.get(i.account_id)) throw new HttpError(404, 'Account not found.');
        const r = await core.analytics.syncIntegration(i.account_id);
        core.webhooks.emit('analytics.synced', { accounts: { [i.account_id]: r } });
        return { results: { [i.account_id]: r } };
      }
      return { results: await core.analytics.syncAll() };
    },
  },
  // ---- webhooks ----
  {
    name: 'list_webhooks', method: 'GET', path: '/webhooks', scope: 'admin', tags: ['webhooks'], readOnly: true,
    summary: 'List webhooks', description: `Outbound webhooks. Events: ${WEBHOOK_EVENTS.join(', ')}.`,
    input: S({ properties: {} }),
    handler: (core) => ({ webhooks: core.webhooks.list() }),
  },
  {
    name: 'create_webhook', method: 'POST', path: '/webhooks', scope: 'admin', tags: ['webhooks'],
    summary: 'Create a webhook', description: 'Returns the signing secret ONCE. Deliveries are POSTed as JSON with header X-Postlite-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>; failed deliveries are retried with backoff.',
    input: S({ required: ['url'], properties: { url: str('Receiver URL.'), events: { type: 'array', items: { type: 'string', enum: [...WEBHOOK_EVENTS, '*'] } }, description: str('Label.') } }),
    handler: (core, i) => { try { return { webhook: core.webhooks.create(i) }; } catch (e) { throw new HttpError(400, e.message); } },
  },
  {
    name: 'update_webhook', method: 'PATCH', path: '/webhooks/{webhook_id}', scope: 'admin', tags: ['webhooks'],
    summary: 'Update a webhook', description: 'Change url, events, description or active flag.',
    input: S({ required: ['webhook_id'], properties: { webhook_id: id('Webhook'), url: str('URL'), events: { type: 'array', items: { type: 'string' } }, active: { type: 'boolean' }, description: str('Label') } }),
    handler: (core, i) => {
      let w;
      try { w = core.webhooks.update(i.webhook_id, i); } catch (e) { throw new HttpError(400, e.message); }
      if (!w) throw new HttpError(404, 'Webhook not found.');
      return { webhook: w };
    },
  },
  {
    name: 'delete_webhook', method: 'DELETE', path: '/webhooks/{webhook_id}', scope: 'admin', tags: ['webhooks'], destructive: true,
    summary: 'Delete a webhook', description: 'Deletes a webhook and its delivery log.',
    input: S({ required: ['webhook_id'], properties: { webhook_id: id('Webhook') } }),
    handler: (core, i) => { if (!core.webhooks.remove(i.webhook_id)) throw new HttpError(404, 'Webhook not found.'); return { deleted: true }; },
  },
  {
    name: 'rotate_webhook_secret', method: 'POST', path: '/webhooks/{webhook_id}/rotate-secret', scope: 'admin', tags: ['webhooks'],
    summary: 'Rotate webhook secret', description: 'Generates a new signing secret (returned once).',
    input: S({ required: ['webhook_id'], properties: { webhook_id: id('Webhook') } }),
    handler: (core, i) => { const r = core.webhooks.rotateSecret(i.webhook_id); if (!r) throw new HttpError(404, 'Webhook not found.'); return r; },
  },
  {
    name: 'list_webhook_deliveries', method: 'GET', path: '/webhooks/{webhook_id}/deliveries', scope: 'admin', tags: ['webhooks'], readOnly: true,
    summary: 'Webhook delivery log', description: 'Recent deliveries with status, attempts and last error.',
    input: S({ required: ['webhook_id'], properties: { webhook_id: id('Webhook') } }),
    handler: (core, i) => ({ deliveries: core.webhooks.deliveries(i.webhook_id) }),
  },
  {
    name: 'test_webhook', method: 'POST', path: '/webhooks/{webhook_id}/test', scope: 'admin', tags: ['webhooks'],
    summary: 'Send a test event', description: 'Queues a "ping" delivery to this webhook only.',
    input: S({ required: ['webhook_id'], properties: { webhook_id: id('Webhook') } }),
    handler: async (core, i) => {
      const w = core.webhooks.get(i.webhook_id);
      if (!w) throw new HttpError(404, 'Webhook not found.');
      const payload = JSON.stringify({ id: `ping-${Date.now()}`, event: 'ping', created_at: new Date().toISOString(), data: { hello: 'from postlite' } });
      core.db.run("INSERT INTO webhook_deliveries(webhook_id, event, payload, state, attempts, next_attempt_at, created_at) VALUES(?, 'ping', ?, 'pending', 0, ?, ?)", w.id, payload, Date.now(), Date.now());
      await core.webhooks.deliverDue();
      return { deliveries: core.webhooks.deliveries(w.id, 1) };
    },
  },
  // ---- API keys & audit ----
  {
    name: 'list_api_keys', method: 'GET', path: '/api-keys', scope: 'admin', tags: ['api-keys'], readOnly: true,
    summary: 'List API keys', description: 'Keys with scopes, approval mode, rate limit, last use. Secrets are never shown again.',
    input: S({ properties: {} }),
    handler: (core) => ({ api_keys: core.apiKeys.list(), scopes: SCOPE_HELP }),
  },
  {
    name: 'create_api_key', method: 'POST', path: '/api-keys', scope: 'admin', tags: ['api-keys'],
    summary: 'Create an API key', description: `Creates a key (returned ONCE). Scopes: ${SCOPES.join(', ')}. approval_mode defaults to true (agent posts need human approval). A key cannot create a key with more power than itself.`,
    input: S({ required: ['name'], properties: { name: str('Label, e.g. "Claude Desktop".'), scopes: { type: 'array', items: { type: 'string', enum: SCOPES } }, approval_mode: { type: 'boolean' }, rate_limit_per_min: { type: 'integer', minimum: 1, maximum: 10000 } } }),
    handler: (core, i, p) => {
      const scopes = i.scopes || ['read', 'write', 'publish', 'analytics'];
      if (p.type === 'api_key') {
        const extra = scopes.filter((s) => !p.scopes.includes(s));
        if (extra.length) throw new HttpError(403, `Cannot grant scopes you do not have: ${extra.join(', ')}`);
        if (p.approval && i.approval_mode === false) throw new HttpError(403, 'An approval-mode key cannot create keys without approval mode.');
      }
      try { return { api_key: core.apiKeys.create({ ...i, scopes, approval_mode: i.approval_mode ?? true }), warning: 'Store the key now — it will not be shown again.' }; } catch (e) { throw new HttpError(400, e.message); }
    },
  },
  {
    name: 'update_api_key', method: 'PATCH', path: '/api-keys/{key_id}', scope: 'admin', tags: ['api-keys'],
    summary: 'Update an API key', description: 'Change name, scopes, approval mode or rate limit. Approval-mode keys cannot modify keys.',
    input: S({ required: ['key_id'], properties: { key_id: id('API key'), name: str('Label'), scopes: { type: 'array', items: { type: 'string', enum: SCOPES } }, approval_mode: { type: 'boolean' }, rate_limit_per_min: { type: 'integer', minimum: 1 } } }),
    handler: (core, i, p) => {
      if (p.approval) throw new HttpError(403, 'Approval-mode keys cannot modify API keys.');
      let k;
      try { k = core.apiKeys.update(i.key_id, i); } catch (e) { throw new HttpError(400, e.message); }
      if (!k) throw new HttpError(404, 'API key not found.');
      return { api_key: k };
    },
  },
  {
    name: 'revoke_api_key', method: 'DELETE', path: '/api-keys/{key_id}', scope: 'admin', tags: ['api-keys'], destructive: true,
    summary: 'Revoke an API key', description: 'Immediately revokes a key.',
    input: S({ required: ['key_id'], properties: { key_id: id('API key') } }),
    handler: (core, i) => { if (!core.apiKeys.revoke(i.key_id)) throw new HttpError(404, 'API key not found or already revoked.'); return { revoked: true }; },
  },
  {
    name: 'list_audit_log', method: 'GET', path: '/audit-log', scope: 'admin', tags: ['api-keys'], readOnly: true,
    summary: 'Audit log of agent/API actions', description: 'Who did what via REST/MCP/UI, newest first.',
    input: S({ properties: { limit: { type: 'integer', minimum: 1, maximum: 1000 }, offset: { type: 'integer', minimum: 0 }, actor_id: str('Filter by API key id.') } }),
    handler: (core, i) => ({ entries: core.audit.list(i) }),
  },
];

export const opsByName = Object.fromEntries(operations.map((o) => [o.name, o]));

/**
 * Execute an operation with auth, validation and audit.
 * @returns {Promise<any>} result; throws HttpError
 */
export async function execute(core, op, input, principal, via) {
  if (!principal) throw new HttpError(401, 'Authentication required. Send "Authorization: Bearer <API key>".');
  if (op.scope) need(principal, op.scope);
  const errs = validate(op.input, input || {});
  if (errs.length) {
    const e = new HttpError(400, `Invalid input for ${op.name}:\n• ${errs.join('\n• ')}`, { errors: errs, input_schema: op.input });
    if (!op.readOnly) core.audit.record({ principal, via, operation: op.name, status: 400, detail: { errors: errs } });
    throw e;
  }
  try {
    const result = await op.handler(core, input || {}, principal);
    if (!op.readOnly || principal.type === 'api_key') {
      if (!op.readOnly) core.audit.record({ principal, via, operation: op.name, target: targetOf(input, result), status: 200, detail: summarize(input) });
    }
    return result;
  } catch (e0) {
    const e = op.wrapError ? friendlyValidation(core, e0) : e0;
    if (!op.readOnly) core.audit.record({ principal, via, operation: op.name, target: targetOf(input), status: e.status || 500, detail: { error: e.message } });
    throw e;
  }
}

const targetOf = (input, result) => input?.post_id || input?.account_id || input?.media_id || input?.webhook_id || input?.key_id || result?.post?.id || result?.media?.id || null;
function summarize(input) {
  if (!input) return null;
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = k === 'data' ? `<${String(v).length} base64 chars>` : typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v;
  return out;
}
