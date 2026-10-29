// Posts & groups service. A "group" is what the composer edits (global caption + media);
// it has one post per selected account, each with optional overrides and platform settings.
// All reads are batch-loaded (few queries per request: Cloudflare D1 allows 50 per invocation on
// the Free plan) and multi-row writes go through db.batch() (atomic on node:sqlite and D1).
import { uid } from './crypto.js';
import { HttpError } from './errors.js';
import { validatePost, defaultSettings } from './shared/validate.js';
import { purgedMessage } from './retention.js';

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const LOCKED = new Set(['published', 'publishing']);
const CHUNK = 90; // D1: max 100 bound parameters per query

export function aggregateStatus(targets) {
  const st = targets.map((t) => t.status);
  if (!st.length) return 'draft';
  for (const s of ['publishing', 'pending_approval']) if (st.includes(s)) return s;
  if (st.every((s) => s === 'published')) return 'published';
  if (st.includes('failed')) return st.includes('published') ? 'partially_failed' : 'failed';
  if (st.includes('scheduled')) return 'scheduled';
  if (st.includes('published')) return 'published';
  return 'draft';
}

async function inChunks(ids, fn) {
  const out = [];
  const list = [...new Set(ids.filter((x) => x !== null && x !== undefined).map(String))];
  for (let i = 0; i < list.length; i += CHUNK) out.push(...(await fn(list.slice(i, i + CHUNK))));
  return out;
}
const marks = (n) => Array(n).fill('?').join(',');

/** Platform (what people say) → providers (how accounts are stored). */
export const PLATFORM_PROVIDERS = { youtube: ['youtube'], facebook: ['facebook'], instagram: ['instagram', 'instagram-standalone'], x: ['x'], linkedin: ['linkedin', 'linkedin-page'] };
export const MEDIA_TYPES = ['video', 'image', 'text', 'carousel', 'story', 'reel', 'short', 'document', 'thread'];

// What a post is, from its settings and effective media (per target; same rules as describeKind()).
const EFFECTIVE_MEDIA = "COALESCE(p.media_override, g.media, '[]')";
const HAS_VIDEO = `EXISTS (SELECT 1 FROM json_each(${EFFECTIVE_MEDIA}) je JOIN media m ON m.id = je.value AND m.workspace_id = p.workspace_id WHERE m.kind = 'video')`;
export const MEDIA_TYPE_SQL = `(CASE
  WHEN json_extract(p.settings, '$.post_type') = 'story' THEN 'story'
  WHEN json_extract(p.settings, '$.post_type') = 'reel' THEN 'reel'
  WHEN json_extract(p.settings, '$.post_type') = 'document' THEN 'document'
  WHEN i.provider = 'youtube' AND json_extract(p.settings, '$.isShort') IN (1, 'true') THEN 'short'
  WHEN json_array_length(COALESCE(json_extract(p.settings, '$.thread'), '[]')) > 0 THEN 'thread'
  WHEN json_array_length(${EFFECTIVE_MEDIA}) > 1 THEN 'carousel'
  WHEN i.provider IN ('instagram', 'instagram-standalone') AND ${HAS_VIDEO} THEN 'reel'
  WHEN ${HAS_VIDEO} THEN 'video'
  WHEN json_array_length(${EFFECTIVE_MEDIA}) = 1 THEN 'image'
  ELSE 'text' END)`;

/** Media rows of a composed post (media + custom thumbnail + thread media). */
export const composedMedia = (c) => [...c.media, ...(c.thumbnail ? [c.thumbnail] : []), ...(c.thread || []).flatMap((t) => t.media)];
/** Throw an actionable 409 when a post would need originals that were deleted after publishing. */
export function assertNotPurged(rows, { retry = false } = {}) {
  const gone = [...new Map(rows.filter((m) => m?.purged_at).map((m) => [m.id, m])).values()];
  if (gone.length) throw new HttpError(409, purgedMessage(gone.map((m) => m.original_name || m.id), { retry }), { purged_media: gone.map((m) => m.id), action: retry ? 'duplicate_and_reupload' : 'reupload' });
}

/** Event-log statement for a post id the caller already verified (scheduler / this workspace's posts). */
export const eventStmt = (postId, level, message) => ['INSERT INTO post_events(post_id, at, level, message) VALUES(?,?,?,?) /* ws:checked */', postId, Date.now(), level, String(message).slice(0, 2000)];

/** Posts of ONE workspace (ws). Every read joins/filters by workspace_id. */
export function createPosts({ db, media, integrations, ws }) {
  if (!ws) throw new Error('createPosts: workspace id required');
  const event = (postId, level, message) => db.run(...eventStmt(postId, level, message));

  const SELECT = `SELECT p.*, i.provider, COALESCE(i.display_name, i.name) AS name, i.picture, i.status AS istatus, i.disabled_at AS idisabled, i.meta AS imeta, j.state AS job_state, j.run_at
                  FROM posts p JOIN integrations i ON i.id = p.integration_id AND i.workspace_id = p.workspace_id LEFT JOIN jobs j ON j.post_id = p.id`;
  // Every use is `${SELECT} WHERE p.workspace_id = ? AND …`.

  const mediaIdsOf = (post, group) => {
    const settings = parse(post.settings, {});
    const ids = post.media_override !== null && post.media_override !== undefined ? parse(post.media_override, []) : parse(group?.media, []);
    const thread = Array.isArray(settings.thread) ? settings.thread.flatMap((t) => (Array.isArray(t?.media) ? t.media : [])) : [];
    return [...ids, ...(settings.thumbnail ? [settings.thumbnail] : []), ...thread];
  };
  const loadMedia = async (ids) => new Map((await inChunks(ids, (c) => db.all(`SELECT * FROM media WHERE workspace_id = ? AND id IN (${marks(c.length)})`, ws, ...c))).map((m) => [m.id, m]));
  const loadGroupsRaw = async (ids) => new Map((await inChunks(ids, (c) => db.all(`SELECT * FROM groups WHERE workspace_id = ? AND id IN (${marks(c.length)})`, ws, ...c))).map((g) => [g.id, g]));

  function composeWith(post, g, mediaMap) {
    const settings = { ...defaultSettings(post.provider), ...parse(post.settings, {}) };
    const mediaIds = post.media_override !== null && post.media_override !== undefined ? parse(post.media_override, []) : parse(g.media, []);
    const caption = post.content_override !== null && post.content_override !== undefined ? post.content_override : g.content;
    const mediaRows = mediaIds.map((id) => mediaMap.get(String(id))).filter(Boolean);
    const thumbnail = settings.thumbnail ? mediaMap.get(String(settings.thumbnail)) || null : null;
    // X threads: follow-up posts with their own text and media (settings.thread = [{ text, media: [ids] }]).
    const thread = Array.isArray(settings.thread) ? settings.thread.map((t) => ({ text: String(t?.text || ''), media: (Array.isArray(t?.media) ? t.media : []).map((id) => mediaMap.get(String(id))).filter(Boolean) })) : [];
    return { caption, settings, media: mediaRows, thumbnail, thread };
  }

  /** Effective caption/media/settings of a post (loads its group and media). */
  async function composed(post, group) {
    const g = group || (await db.get('SELECT * FROM groups WHERE id = ? AND workspace_id = ?', post.group_id, ws));
    return composeWith(post, g, await loadMedia(mediaIdsOf(post, g)));
  }

  function validateComposed(provider, c, accountMeta = null) {
    const toInfo = (m) => ({ kind: m.kind, mime: m.mime, size: m.size, width: m.width, height: m.height, duration: m.duration, name: m.original_name });
    const meta = typeof accountMeta === 'string' ? parse(accountMeta, {}) : accountMeta || {};
    return validatePost(provider, { caption: c.caption, media: c.media.map(toInfo), settings: c.settings, thumbnail: c.thumbnail ? toInfo(c.thumbnail) : null,
      thread: provider === 'x' ? (c.thread || []).map((t) => ({ text: t.text, media: t.media.map(toInfo) })) : null, account: { premium: !!meta.premium } });
  }

  const postViewWith = (p, g, mediaMap) => {
    const c = composeWith(p, g, mediaMap);
    return {
      id: p.id, group_id: p.group_id, integration_id: p.integration_id, account_id: p.integration_id, provider: p.provider, account_name: p.name, account_picture: p.picture, account_status: p.istatus,
      content_override: p.content_override, media_override: parse(p.media_override, null), settings: c.settings,
      caption: c.caption, media: c.media.map(media.view), publish_at: p.publish_at, status: p.status, external_id: p.external_id,
      published_url: p.published_url, published_at: p.published_at, error: p.error, warning: p.warning, attempts: p.attempts, account_paused: !!p.idisabled,
      job_state: p.job_state || null, next_run_at: p.run_at || null, created_at: p.created_at, updated_at: p.updated_at,
    };
  };

  /** Views for post rows (from SELECT) with 2–3 queries total. */
  async function postViews(rows) {
    if (!rows.length) return [];
    const groups = await loadGroupsRaw(rows.map((r) => r.group_id));
    const mediaMap = await loadMedia(rows.flatMap((r) => mediaIdsOf(r, groups.get(r.group_id))));
    return rows.filter((r) => groups.has(r.group_id)).map((r) => postViewWith(r, groups.get(r.group_id), mediaMap));
  }

  /** Full group views for ids (order preserved, missing skipped) with ~4 queries total. */
  async function loadGroups(ids) {
    const list = [...new Set((ids || []).map(String))];
    if (!list.length) return [];
    const groups = await loadGroupsRaw(list);
    const targets = await inChunks(list, (c) => db.all(`${SELECT} WHERE p.workspace_id = ? AND p.group_id IN (${marks(c.length)}) ORDER BY i.provider, p.created_at, p.id`, ws, ...c));
    const mediaIds = [...[...groups.values()].flatMap((g) => parse(g.media, [])), ...targets.flatMap((t) => mediaIdsOf(t, groups.get(t.group_id)))];
    const mediaMap = await loadMedia(mediaIds);
    const byGroup = new Map();
    for (const t of targets) {
      const g = groups.get(t.group_id);
      if (g) (byGroup.get(g.id) || byGroup.set(g.id, []).get(g.id)).push(postViewWith(t, g, mediaMap));
    }
    return list.filter((id) => groups.has(id)).map((id) => {
      const g = groups.get(id);
      const tv = byGroup.get(id) || [];
      return {
        id: g.id, content: g.content, media: parse(g.media, []).map((m) => mediaMap.get(String(m))).filter(Boolean).map(media.view), publish_at: g.publish_at, status: aggregateStatus(tv),
        created_by: g.created_by, approval_note: g.approval_note, created_at: g.created_at, updated_at: g.updated_at, targets: tv,
      };
    });
  }

  const upsertJobStmt = (postId, runAt) => [`INSERT INTO jobs(post_id, state, run_at, phase, attempts, created_at, updated_at) VALUES(?, 'queued', ?, 'start', 0, ?, ?)
            ON CONFLICT(post_id) DO UPDATE SET state='queued', run_at=excluded.run_at, phase='start', pending_data=NULL, pending_since=NULL, attempts=0,
            locked_by=NULL, locked_until=NULL, inflight=NULL, last_error=NULL, updated_at=excluded.updated_at WHERE jobs.state <> 'running' /* ws:checked */`, postId, runAt, Date.now(), Date.now()];

  async function assertNotRunning(postIds) {
    if (!postIds.length) return;
    const rows = await inChunks(postIds, (c) => db.all(`SELECT post_id FROM jobs WHERE state = 'running' AND post_id IN (${marks(c.length)}) /* ws:checked */`, ...c));
    if (rows.length) throw new HttpError(409, 'This post is being published right now; try again in a moment.');
  }

  const api = {
    composed,
    validateComposed,
    event,
    eventStmt,
    loadGroups,

    async getGroup(id) {
      const [g] = await loadGroups([id]);
      return g || null;
    },

    /**
     * Create or update a group.
     * input: { content, media:[ids], publish_at, action:'draft'|'schedule'|'now', posts:[{integration_id, content_override, media_override, settings}] }
     */
    async saveGroup(input, groupId = null, { principal = null } = {}) {
      const approval = !!principal?.approval;
      const action = input.action || 'draft';
      if (!['draft', 'schedule', 'now'].includes(action)) throw new HttpError(400, 'Invalid action');
      const now = Date.now();
      const publishAt = action === 'now' ? now : input.publish_at ? Number(input.publish_at) : null;
      if (action === 'schedule' && !publishAt) throw new HttpError(400, 'Pick a date and time to schedule.');
      if (action === 'schedule' && publishAt < now - 60000) throw new HttpError(400, 'The scheduled time is in the past. Use "Post now" or pick a future time.');
      const list = Array.isArray(input.posts) ? input.posts : [];
      if (!list.length) throw new HttpError(400, 'Select at least one account.');
      const content = String(input.content ?? '');
      const mediaIds = (input.media || []).map(String);

      // Load everything needed for validation up front (3 queries).
      const integ = new Map((await inChunks(list.map((p) => p.integration_id), (c) => db.all(`SELECT * FROM integrations WHERE workspace_id = ? AND id IN (${marks(c.length)})`, ws, ...c))).map((r) => [r.id, r]));
      const thumbs = [...list.map((p) => p.settings?.thumbnail), ...list.flatMap((p) => (Array.isArray(p.settings?.thread) ? p.settings.thread.flatMap((t) => (Array.isArray(t?.media) ? t.media : [])) : []))].filter(Boolean);
      const overrides = list.flatMap((p) => (Array.isArray(p.media_override) ? p.media_override.map(String) : []));
      const mediaMap = await loadMedia([...mediaIds, ...overrides, ...thumbs]);
      for (const mid of [...mediaIds, ...overrides, ...thumbs.map(String)]) if (!mediaMap.has(mid)) throw new HttpError(400, `Unknown media ${mid}`);

      // Validate everything before touching the DB.
      const plan = [];
      const errors = {};
      const g0 = { content, media: JSON.stringify(mediaIds) };
      for (const p of list) {
        const ig = integ.get(String(p.integration_id));
        if (!ig) throw new HttpError(400, `Unknown account ${p.integration_id}`);
        const settings = { ...defaultSettings(ig.provider), ...(p.settings || {}) };
        const content_override = p.content_override === undefined || p.content_override === null ? null : String(p.content_override);
        const media_override = Array.isArray(p.media_override) ? p.media_override.map(String) : null;
        const fake = { provider: ig.provider, settings: JSON.stringify(settings), content_override, media_override: media_override && JSON.stringify(media_override) };
        const c = composeWith(fake, g0, mediaMap);
        if (action !== 'draft') {
          if (ig.status !== 'active') (errors[ig.id] ||= []).push(`${ig.name}: account needs to be reconnected.`);
          if (ig.disabled_at && action === 'now') (errors[ig.id] ||= []).push(`${ig.display_name || ig.name}: publishing to this channel is paused. Resume it (channel menu → Enable) or schedule the post; scheduled posts wait until it is resumed.`);
          const v = validateComposed(ig.provider, c, ig.meta);
          if (v.errors.length) (errors[ig.id] ||= []).push(...v.errors);
        }
        plan.push({ integ: ig, settings, content_override, media_override });
      }
      if (Object.keys(errors).length) throw new HttpError(422, 'Please fix the validation errors.', { errors });
      // Drafts may keep a removed original as a "re-upload" placeholder (duplicates); anything that publishes may not.
      if (action !== 'draft') assertNotPurged(plan.flatMap((p) => composedMedia(composeWith({ provider: p.integ.provider, settings: JSON.stringify(p.settings), content_override: p.content_override, media_override: p.media_override && JSON.stringify(p.media_override) }, g0, mediaMap))));

      let gid = groupId;
      const ops = [];
      let existing = [];
      if (gid) {
        const g = await db.get('SELECT id FROM groups WHERE id = ? AND workspace_id = ?', gid, ws);
        if (!g) throw new HttpError(404, 'Post not found');
        existing = await db.all('SELECT * FROM posts WHERE group_id = ? AND workspace_id = ?', gid, ws);
        await assertNotRunning(existing.map((e) => e.id));
        ops.push(['UPDATE groups SET content=?, media=?, publish_at=?, updated_at=? WHERE id=? AND workspace_id=?', content, JSON.stringify(mediaIds), publishAt, now, gid, ws]);
      } else {
        gid = uid();
        ops.push(['INSERT INTO groups(id, workspace_id, content, media, publish_at, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)', gid, ws, content, JSON.stringify(mediaIds), publishAt, principal?.name || null, now, now]);
      }
      const keep = new Set(plan.map((p) => p.integ.id));
      for (const e of existing) {
        if (!keep.has(e.integration_id) && !LOCKED.has(e.status)) ops.push(["DELETE FROM posts WHERE id = ? AND workspace_id = ? AND status NOT IN ('published','publishing')", e.id, ws]);
      }
      const status = action === 'draft' ? 'draft' : approval ? 'pending_approval' : 'scheduled';
      if (approval && action !== 'draft') ops.push(['UPDATE groups SET approval_note = NULL WHERE id = ? AND workspace_id = ?', gid, ws]);
      for (const p of plan) {
        const e = existing.find((x) => x.integration_id === p.integ.id);
        if (e && LOCKED.has(e.status)) continue; // published/publishing posts are immutable
        const id = e ? e.id : uid();
        if (e) {
          ops.push(["UPDATE posts SET content_override=?, media_override=?, settings=?, publish_at=?, status=?, error=NULL, warning=NULL, attempts=0, updated_at=? WHERE id=? AND workspace_id=? AND status NOT IN ('published','publishing')",
            p.content_override, p.media_override && JSON.stringify(p.media_override), JSON.stringify(p.settings), publishAt, status, now, id, ws]);
        } else {
          ops.push(['INSERT INTO posts(id, workspace_id, group_id, integration_id, content_override, media_override, settings, publish_at, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            id, ws, gid, p.integ.id, p.content_override, p.media_override && JSON.stringify(p.media_override), JSON.stringify(p.settings), publishAt, status, now, now]);
        }
        if (status === 'scheduled') {
          ops.push(upsertJobStmt(id, publishAt));
          ops.push(eventStmt(id, 'info', action === 'now' ? 'Queued for immediate publishing' : `Scheduled for ${new Date(publishAt).toISOString()}`));
        } else {
          ops.push(["DELETE FROM jobs WHERE post_id = ? AND state <> 'running' /* ws:checked */", id]);
          if (status === 'pending_approval') ops.push(eventStmt(id, 'info', `Awaiting approval (requested by ${principal?.name || 'agent'})`));
        }
      }
      await db.batch(ops);
      return gid;
    },

    /** Approve pending posts of a group (optionally only some targets / at a new time). Past times publish now. */
    async approve(groupId, { target_ids = null, publish_at = null, principal = null } = {}) {
      const g = await db.get('SELECT * FROM groups WHERE id = ? AND workspace_id = ?', groupId, ws);
      if (!g) throw new HttpError(404, 'Post not found');
      const pend = (await db.all("SELECT p.*, i.provider, i.status AS istatus, i.meta AS imeta FROM posts p JOIN integrations i ON i.id = p.integration_id AND i.workspace_id = p.workspace_id WHERE p.group_id = ? AND p.workspace_id = ? AND p.status = 'pending_approval'", groupId, ws))
        .filter((p) => !target_ids || target_ids.includes(p.id));
      if (!pend.length) throw new HttpError(409, 'Nothing is awaiting approval in this post.');
      const mediaMap = await loadMedia(pend.flatMap((p) => mediaIdsOf(p, g)));
      const errors = {};
      for (const p of pend) {
        const v = validateComposed(p.provider, composeWith(p, g, mediaMap), p.imeta);
        if (v.errors.length) errors[p.integration_id] = v.errors;
        if (p.istatus !== 'active') (errors[p.integration_id] ||= []).push('Account needs to be reconnected.');
      }
      if (Object.keys(errors).length) throw new HttpError(422, 'Cannot approve: validation errors.', { errors });
      assertNotPurged(pend.flatMap((p) => composedMedia(composeWith(p, g, mediaMap))));
      const now = Date.now();
      const ops = [];
      for (const p of pend) {
        const at = Math.max(Number(publish_at || p.publish_at || now), now);
        ops.push(["UPDATE posts SET status='scheduled', publish_at=?, updated_at=? WHERE id=? AND workspace_id=?", at, now, p.id, ws]);
        ops.push(upsertJobStmt(p.id, at));
        ops.push(eventStmt(p.id, 'info', `Approved by ${principal?.name || 'admin'}; scheduled for ${new Date(at).toISOString()}`));
      }
      ops.push(['UPDATE groups SET approval_note = NULL WHERE id = ? AND workspace_id = ?', groupId, ws]);
      await db.batch(ops);
      return pend.length;
    },

    async reject(groupId, { reason = '', principal = null } = {}) {
      const pend = await db.all("SELECT id FROM posts WHERE group_id = ? AND workspace_id = ? AND status = 'pending_approval'", groupId, ws);
      if (!pend.length) throw new HttpError(409, 'Nothing is awaiting approval in this post.');
      const ops = [];
      for (const p of pend) {
        ops.push(["UPDATE posts SET status='draft', updated_at=? WHERE id=? AND workspace_id=?", Date.now(), p.id, ws]);
        ops.push(eventStmt(p.id, 'warn', `Rejected by ${principal?.name || 'admin'}${reason ? `: ${reason}` : ''}`));
      }
      ops.push(['UPDATE groups SET approval_note = ? WHERE id = ? AND workspace_id = ?', `Rejected${reason ? `: ${reason}` : ''}`, groupId, ws]);
      await db.batch(ops);
      return pend.length;
    },

    /** Groups with at least one target matching the filters. */
    /**
     * Groups whose targets match every filter (filters are AND-ed; values inside one filter are OR-ed).
     * Each group carries matched_target_ids so a list can show only the matching accounts.
     * platform/provider/status/account/media_type/created_by accept arrays; q searches caption,
     * title and account name; from/to apply to the published (else scheduled, else updated) time.
     */
    async listGroups({ from = null, to = null, status = null, provider = null, platform = null, integration_id = null, media_type = null, created_by = null, q = null, sort = null, limit = 50, offset = 0 } = {}) {
      const list = (v) => (v === null || v === undefined || v === '' ? [] : (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean));
      const where = ['p.workspace_id = ?'];
      const args = [ws];
      const anyOf = (expr, vals) => { if (vals.length) { where.push(`${expr} IN (${marks(vals.length)})`); args.push(...vals); } };
      if (from !== null && from !== undefined) { where.push('COALESCE(p.published_at, p.publish_at, p.updated_at) >= ?'); args.push(Number(from)); }
      if (to !== null && to !== undefined) { where.push('COALESCE(p.published_at, p.publish_at, p.updated_at) < ?'); args.push(Number(to)); }
      anyOf('p.status', list(status));
      const providers = [...list(provider), ...list(platform).flatMap((x) => PLATFORM_PROVIDERS[x] || [x])];
      anyOf('i.provider', [...new Set(providers)]);
      anyOf('p.integration_id', list(integration_id));
      anyOf(MEDIA_TYPE_SQL, list(media_type));
      const who = list(created_by);
      if (who.length) {
        const ors = [];
        for (const w of who) {
          if (w === 'human') { ors.push('(g.created_by IS NULL OR g.created_by NOT IN (SELECT name FROM api_keys WHERE workspace_id = ?))'); args.push(ws); }
          else if (w === 'agent') { ors.push('g.created_by IN (SELECT name FROM api_keys WHERE workspace_id = ?)'); args.push(ws); }
          else if (w.startsWith('key:')) { ors.push('g.created_by IN (SELECT name FROM api_keys WHERE workspace_id = ? AND id = ?)'); args.push(ws, w.slice(4)); }
          else throw new HttpError(400, `created_by must be "human", "agent" or "key:<api key id>" (got "${w}").`);
        }
        where.push(`(${ors.join(' OR ')})`);
      }
      const needle = String(q || '').trim();
      if (needle) {
        const like = `%${needle.replace(/[!%_]/g, (c) => `!${c}`)}%`;
        where.push("(g.content LIKE ? ESCAPE '!' OR COALESCE(p.content_override, '') LIKE ? ESCAPE '!' OR COALESCE(json_extract(p.settings, '$.title'), '') LIKE ? ESCAPE '!' OR i.name LIKE ? ESCAPE '!' OR COALESCE(i.display_name, '') LIKE ? ESCAPE '!')");
        args.push(like, like, like, like, like);
      }
      const dir = sort === 'asc' || sort === 'desc' ? sort.toUpperCase() : from !== null && from !== undefined ? 'ASC' : 'DESC';
      const rows = await db.all(`SELECT p.group_id, ${dir === 'ASC' ? 'MIN' : 'MAX'}(COALESCE(p.published_at, p.publish_at, p.updated_at)) AS t, GROUP_CONCAT(p.id) AS ids
        FROM posts p JOIN integrations i ON i.id = p.integration_id AND i.workspace_id = p.workspace_id JOIN groups g ON g.id = p.group_id AND g.workspace_id = p.workspace_id
        WHERE ${where.join(' AND ')} GROUP BY p.group_id ORDER BY t ${dir} LIMIT ? OFFSET ?`, ...args, Math.min(Number(limit) || 50, 500), Number(offset) || 0);
      const matched = new Map(rows.map((r) => [r.group_id, String(r.ids || '').split(',').filter(Boolean)]));
      return (await loadGroups(rows.map((r) => r.group_id))).map((g) => ({ ...g, matched_target_ids: matched.get(g.id) || [] }));
    },

    async pendingApprovals() {
      return loadGroups((await db.all("SELECT DISTINCT group_id FROM posts WHERE workspace_id = ? AND status = 'pending_approval'", ws)).map((r) => r.group_id));
    },

    async deleteGroup(id) {
      const posts = await db.all('SELECT id FROM posts WHERE group_id = ? AND workspace_id = ?', id, ws);
      await assertNotRunning(posts.map((p) => p.id));
      await db.run('DELETE FROM groups WHERE id = ? AND workspace_id = ?', id, ws);
    },

    async duplicateGroup(id) {
      const g = await api.getGroup(id);
      if (!g) throw new HttpError(404, 'Not found');
      const posts = await db.all('SELECT * FROM posts WHERE group_id = ? AND workspace_id = ?', id, ws);
      const now = Date.now();
      const nid = uid();
      const ops = [['INSERT INTO groups(id, workspace_id, content, media, publish_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?)', nid, ws, g.content, JSON.stringify(g.media.map((m) => m.id)), g.publish_at, now, now]];
      for (const p of posts) {
        ops.push(['INSERT INTO posts(id, workspace_id, group_id, integration_id, content_override, media_override, settings, publish_at, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          uid(), ws, nid, p.integration_id, p.content_override, p.media_override, p.settings, p.publish_at, 'draft', now, now]);
      }
      await db.batch(ops);
      return nid;
    },

    /** Move every not-yet-published post of a group to a new time (calendar drag & drop). */
    async rescheduleGroup(id, publishAt) {
      publishAt = Number(publishAt);
      if (!publishAt) throw new HttpError(400, 'publish_at required');
      if (publishAt < Date.now() - 60000) throw new HttpError(400, 'Cannot move a post into the past.');
      const posts = await db.all('SELECT * FROM posts WHERE group_id = ? AND workspace_id = ?', id, ws);
      if (!posts.length) throw new HttpError(404, 'Not found');
      await assertNotRunning(posts.map((p) => p.id));
      const ops = [['UPDATE groups SET publish_at=?, updated_at=? WHERE id=? AND workspace_id=?', publishAt, Date.now(), id, ws]];
      for (const p of posts) {
        if (LOCKED.has(p.status)) continue;
        ops.push(["UPDATE posts SET publish_at=?, updated_at=? WHERE id=? AND workspace_id=? AND status NOT IN ('published','publishing')", publishAt, Date.now(), p.id, ws]);
        if (p.status === 'scheduled' || p.status === 'pending_approval') {
          ops.push(["UPDATE jobs SET run_at=?, updated_at=? WHERE post_id=? AND state='queued' /* ws:checked */", publishAt, Date.now(), p.id]);
          ops.push(eventStmt(p.id, 'info', `Rescheduled to ${new Date(publishAt).toISOString()}`));
        }
      }
      await db.batch(ops);
    },

    /** Retry a failed post, or publish a draft/scheduled post immediately. */
    async publishNow(postId, { retry = false, principal = null } = {}) {
      const p = await db.get('SELECT p.*, i.provider, i.status AS istatus, i.meta AS imeta, i.disabled_at AS idisabled FROM posts p JOIN integrations i ON i.id = p.integration_id AND i.workspace_id = p.workspace_id WHERE p.id = ? AND p.workspace_id = ?', postId, ws);
      if (!p) throw new HttpError(404, 'Not found');
      if (LOCKED.has(p.status)) throw new HttpError(409, `Post is already ${p.status}.`);
      if (retry && p.status !== 'failed') throw new HttpError(409, 'Only failed posts can be retried.');
      if (p.istatus !== 'active') throw new HttpError(409, 'Reconnect the account first.');
      if (p.idisabled) throw new HttpError(409, 'Publishing to this channel is paused. Enable the channel first (channel menu → Enable publishing).');
      const c = await composed(p);
      assertNotPurged(composedMedia(c), { retry });
      const v = validateComposed(p.provider, c, p.imeta);
      if (v.errors.length) throw new HttpError(422, 'Please fix the validation errors.', { errors: { [p.integration_id]: v.errors } });
      const now = Date.now();
      if (principal?.approval) {
        await db.batch([
          ["UPDATE posts SET status='pending_approval', publish_at=?, error=NULL, attempts=0, updated_at=? WHERE id=? AND workspace_id=? AND status NOT IN ('published','publishing')", now, now, postId, ws],
          ["DELETE FROM jobs WHERE post_id = ? AND state <> 'running' /* ws:checked */", postId],
          eventStmt(postId, 'info', `${retry ? 'Retry' : 'Publish now'} requested by ${principal.name}; awaiting approval`),
        ]);
        return 'pending_approval';
      }
      await db.batch([
        ["UPDATE posts SET status='scheduled', publish_at=?, error=NULL, attempts=0, updated_at=? WHERE id=? AND workspace_id=? AND status NOT IN ('published','publishing')", now, now, postId, ws],
        upsertJobStmt(postId, now),
        eventStmt(postId, 'info', retry ? 'Retry requested' : 'Publish now requested'),
      ]);
      return 'scheduled';
    },

    async deletePost(postId) {
      const p = await db.get('SELECT id, group_id FROM posts WHERE id = ? AND workspace_id = ?', postId, ws);
      if (!p) return;
      await assertNotRunning([p.id]);
      await db.batch([
        ['DELETE FROM posts WHERE id = ? AND workspace_id = ?', p.id, ws],
        ['DELETE FROM groups WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM posts WHERE group_id = ?)', p.group_id, ws, p.group_id],
      ]);
    },

    /** Calendar range: posts whose scheduled or published time is in [from, to). Drafts without a date are included separately. */
    async listRange(from, to) {
      return postViews(await db.all(`${SELECT} WHERE p.workspace_id = ? AND COALESCE(p.published_at, p.publish_at) >= ? AND COALESCE(p.published_at, p.publish_at) < ? ORDER BY COALESCE(p.published_at, p.publish_at)`, ws, from, to));
    },
    async listDrafts() {
      return postViews(await db.all(`${SELECT} WHERE p.workspace_id = ? AND p.status = 'draft' AND p.publish_at IS NULL ORDER BY p.updated_at DESC LIMIT 200`, ws));
    },
    async history({ status, limit = 100, offset = 0 } = {}) {
      const where = status ? 'WHERE p.workspace_id = ? AND p.status = ?' : "WHERE p.workspace_id = ? AND p.status IN ('published','failed','publishing')";
      const args = status ? [ws, status, limit, offset] : [ws, limit, offset];
      return postViews(await db.all(`${SELECT} ${where} ORDER BY COALESCE(p.published_at, p.updated_at) DESC LIMIT ? OFFSET ?`, ...args));
    },
    async get(postId) {
      const r = await db.get(`${SELECT} WHERE p.id = ? AND p.workspace_id = ?`, postId, ws);
      return r ? (await postViews([r]))[0] || null : null;
    },
    events: (postId) => db.all('SELECT e.at, e.level, e.message FROM post_events e JOIN posts p ON p.id = e.post_id WHERE e.post_id = ? AND p.workspace_id = ? ORDER BY e.id', postId, ws),
    /** Events for several posts in one query: Map postId → events. */
    async eventsMany(postIds) {
      const rows = await inChunks(postIds, (c) => db.all(`SELECT e.post_id, e.at, e.level, e.message FROM post_events e JOIN posts p ON p.id = e.post_id WHERE p.workspace_id = ? AND e.post_id IN (${marks(c.length)}) ORDER BY e.id`, ws, ...c));
      const out = new Map(postIds.map((id) => [id, []]));
      for (const r of rows) out.get(r.post_id)?.push({ at: r.at, level: r.level, message: r.message });
      return out;
    },
  };
  return api;
}
