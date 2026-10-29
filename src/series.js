// Repeating posts. A series keeps the post to repeat and a rule (daily, every N days, weekly, every two
// weeks, monthly; optional end date or count). Each occurrence is its own post group, created rolling
// ahead (AHEAD future occurrences) by fill(), which runs on create/edit and from the background loop /
// cron. Media of an active series is never purged (retention.js and the media library check series.media).
import { uid } from './crypto.js';
import { HttpError } from './errors.js';
import { zonedParts, zonedToUtc } from './shared/time.js';

export const FREQUENCIES = ['daily', 'every_n_days', 'weekly', 'biweekly', 'monthly'];
export const AHEAD = 3;
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const DAY = 86400000;

export function describeRule(r) {
  const n = Number(r.interval_days);
  const base = { daily: 'Every day', every_n_days: `Every ${n} days`, weekly: 'Every week', biweekly: 'Every two weeks', monthly: 'Every month' }[r.frequency] || r.frequency;
  return base;
}

/** Occurrence k of a rule anchored at first (wall time in tz, so DST does not shift the hour). */
export function occurrenceAt(rule, first, k, tz) {
  const sub = ((first % 60000) + 60000) % 60000; // keep seconds/ms of the first occurrence
  return occurrenceMinute(rule, first, k, tz) + sub;
}
function occurrenceMinute(rule, first, k, tz) {
  const p = zonedParts(first, tz);
  if (rule.frequency === 'monthly') {
    const m0 = p.month - 1 + k;
    const y = p.year + Math.floor(m0 / 12), m = ((m0 % 12) + 12) % 12;
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return zonedToUtc(y, m + 1, Math.min(p.day, dim), p.hour, p.minute, tz);
  }
  const step = { daily: 1, every_n_days: Number(rule.interval_days), weekly: 7, biweekly: 14 }[rule.frequency];
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day) + k * step * DAY);
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), p.hour, p.minute, tz);
}

/** Validate a repeat rule from the API: {frequency, interval_days?, until?, count?}. */
export function cleanRule(r = {}, { parseTime = (x) => Number(x), prev = null } = {}) {
  const frequency = r.frequency ?? prev?.frequency;
  if (!FREQUENCIES.includes(frequency)) throw new HttpError(400, `repeat.frequency must be one of ${FREQUENCIES.join(', ')}.`);
  let interval = null;
  if (frequency === 'every_n_days') {
    interval = Number(r.interval_days ?? prev?.interval_days);
    if (!Number.isInteger(interval) || interval < 2 || interval > 6) throw new HttpError(400, 'repeat.interval_days must be 2 to 6 for every_n_days (use daily, weekly or biweekly otherwise).');
  }
  const until = r.until === undefined ? prev?.until_at ?? null : r.until === null || r.until === '' ? null : parseTime(r.until);
  if (until !== null && !Number.isFinite(until)) throw new HttpError(400, 'repeat.until must be a date/time.');
  const count = r.count === undefined ? prev?.max_count ?? null : r.count === null || r.count === '' ? null : Number(r.count);
  if (count !== null && (!Number.isInteger(count) || count < 2 || count > 1000)) throw new HttpError(400, 'repeat.count must be 2 to 1000 occurrences (including the first).');
  return { frequency, interval_days: interval, until_at: until, max_count: count };
}

export function createSeries({ db, ws, posts, tags, settings, log = () => {} }) {
  if (!ws) throw new Error('createSeries: workspace id required');
  const tzOf = async () => (await settings.get()).timezone || 'UTC';

  async function occurrences(id, { limit = 200 } = {}) {
    const rows = await db.all('SELECT id, series_index FROM groups WHERE workspace_id = ? AND series_id = ? ORDER BY series_index LIMIT ?', ws, id, limit);
    const groups = await posts.loadGroups(rows.map((r) => r.id));
    return groups.map((g) => ({ id: g.id, index: g.series_index, publish_at: g.publish_at, status: g.status }));
  }
  function view(r, occ = null) {
    if (!r) return null;
    return {
      id: r.id, status: r.status, frequency: r.frequency, interval_days: r.interval_days, rule: describeRule(r),
      first_at: r.first_at, until: r.until_at, count: r.max_count, timezone: r.timezone, generated: r.generated, next_at: r.status === 'active' ? r.next_at : null,
      content: r.content, media_ids: parse(r.media, []), targets: parse(r.targets, []).map((t) => ({ account_id: t.integration_id, content: t.content_override, settings: t.settings, media_override: t.media_override })),
      tags: parse(r.tags, []), approval: !!r.approval, created_by: r.created_by, last_error: r.last_error, created_at: r.created_at, updated_at: r.updated_at,
      ...(occ ? { occurrences: occ } : {}),
    };
  }
  async function getRow(id) { return db.get('SELECT * FROM series WHERE id = ? AND workspace_id = ?', String(id || ''), ws); }
  async function mustGet(id) { const r = await getRow(id); if (!r) throw new HttpError(404, 'Repeating series not found. Call list_series.'); return r; }

  /** Turn an existing scheduled group into occurrence #0 of a new series. */
  async function createFromGroup(groupId, rule, { principal = null } = {}) {
    const g = await db.get('SELECT * FROM groups WHERE id = ? AND workspace_id = ?', groupId, ws);
    if (!g) throw new HttpError(404, 'Post not found.');
    if (g.series_id) throw new HttpError(409, 'This post already repeats. Use update_series.');
    if (!g.publish_at) throw new HttpError(400, 'A repeating post needs a scheduled time for its first occurrence.');
    const targets = await db.all('SELECT integration_id, content_override, media_override, settings FROM posts WHERE group_id = ? AND workspace_id = ?', groupId, ws);
    const tagIds = (await tags.forGroups([groupId])).get(groupId)?.map((t) => t.id) || [];
    const tz = await tzOf();
    const id = uid(), now = Date.now();
    if (rule.until_at !== null && rule.until_at < g.publish_at) throw new HttpError(400, 'repeat.until is before the first occurrence.');
    await db.batch([
      ['INSERT INTO series(id, workspace_id, content, media, targets, tags, frequency, interval_days, first_at, timezone, until_at, max_count, generated, next_index, next_at, status, approval, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, ws, g.content, g.media, JSON.stringify(targets.map((t) => ({ ...t, media_override: parse(t.media_override, null), settings: parse(t.settings, {}) }))), JSON.stringify(tagIds), rule.frequency, rule.interval_days, g.publish_at, tz, rule.until_at, rule.max_count, 1, 1, occurrenceAt(rule, g.publish_at, 1, tz), 'active', principal?.approval ? 1 : 0, principal?.name || null, now, now],
      ['UPDATE groups SET series_id = ?, series_index = 0 WHERE id = ? AND workspace_id = ?', id, groupId, ws],
    ]);
    await fill(id);
    return view(await getRow(id), await occurrences(id));
  }

  /** Create occurrences until AHEAD are in the future (or the series ends). Returns how many were created. */
  async function fillOne(r, now = Date.now()) {
    let made = 0;
    let { generated, next_index: idx, next_at: at } = r;
    const rule = r;
    const future = (await db.get("SELECT COUNT(*) AS n FROM groups WHERE workspace_id = ? AND series_id = ? AND publish_at > ?", ws, r.id, now)).n;
    let need = AHEAD - future;
    const ended = () => at === null || (r.max_count && generated >= r.max_count) || (r.until_at && at > r.until_at);
    let error = null;
    while (need > 0 && !ended()) {
      if (at < now - 60000) { idx += 1; at = occurrenceAt(rule, r.first_at, idx, r.timezone); continue; } // missed while down: skip, never post late
      const input = { content: r.content, media: parse(r.media, []), publish_at: at, action: 'schedule', posts: parse(r.targets, []).map((t) => ({ integration_id: t.integration_id, content_override: t.content_override, media_override: t.media_override, settings: t.settings })) };
      let gid;
      try {
        gid = await posts.saveGroup(input, null, { principal: { name: r.created_by || 'repeat', approval: !!r.approval } });
      } catch (e) {
        // Keep the occurrence as a draft so it shows up, and note why (e.g. a channel needs reconnecting).
        error = e.extra?.errors ? Object.values(e.extra.errors).flat().join(' ') : e.message;
        try { gid = await posts.saveGroup({ ...input, action: 'draft' }, null, { principal: { name: r.created_by || 'repeat' } }); } catch (e2) { error = e2.message; break; }
      }
      const tagIds = parse(r.tags, []);
      await db.batch([
        ['UPDATE groups SET series_id = ?, series_index = ? WHERE id = ? AND workspace_id = ?', r.id, idx, gid, ws],
        ...(tagIds.length ? [[`INSERT INTO group_tags(group_id, tag_id, workspace_id, created_at) SELECT ?, id, workspace_id, ? FROM tags WHERE workspace_id = ? AND id IN (${tagIds.map(() => '?').join(',')}) ON CONFLICT(group_id, tag_id) DO NOTHING`, gid, Date.now(), ws, ...tagIds]] : []),
      ]);
      made++; generated++; need--; idx += 1;
      at = occurrenceAt(rule, r.first_at, idx, r.timezone);
    }
    const status = ended() ? 'ended' : r.status;
    await db.run('UPDATE series SET generated = ?, next_index = ?, next_at = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
      generated, idx, ended() ? null : at, status, error, Date.now(), r.id, ws);
    return made;
  }
  async function fill(id = null, { now = Date.now() } = {}) {
    const rows = id ? [await mustGet(id)].filter((r) => r.status === 'active') : await db.all("SELECT * FROM series WHERE workspace_id = ? AND status = 'active'", ws);
    let n = 0;
    for (const r of rows) { try { n += await fillOne(r, now); } catch (e) { log('warn', `series ${r.id}: ${e.message}`); } }
    return n;
  }

  /** Future occurrences that have not started publishing (safe to rewrite or delete). */
  async function futureGroups(id, { includeFirst = false } = {}) {
    const rows = await db.all(`SELECT g.id, g.series_index, g.publish_at FROM groups g WHERE g.workspace_id = ? AND g.series_id = ? AND g.publish_at > ?
      AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.group_id = g.id AND p.workspace_id = g.workspace_id AND p.status IN ('published','publishing'))${includeFirst ? '' : ' AND g.series_index > 0'} ORDER BY g.series_index`, ws, id, Date.now());
    return rows;
  }

  async function update(id, input = {}, { principal = null, parseTime } = {}) {
    const r = await mustGet(id);
    if (r.status === 'stopped') throw new HttpError(409, 'This series is stopped. Create a new repeating post instead.');
    const ruleChange = ['frequency', 'interval_days', 'until', 'count'].some((k) => input[k] !== undefined);
    const rule = ruleChange ? cleanRule(input, { parseTime, prev: r }) : r;
    const contentChange = ['content', 'media_ids', 'targets', 'tags'].some((k) => input[k] !== undefined);
    const now = Date.now();
    const set = { ...r };
    if (contentChange) {
      if (input.content !== undefined) set.content = String(input.content);
      if (input.media_ids !== undefined) set.media = JSON.stringify(input.media_ids.map(String));
      if (input.targets !== undefined) set.targets = JSON.stringify(input.targets.map((t) => ({ integration_id: t.account_id, content_override: t.content ?? null, media_override: t.media_ids ?? null, settings: t.settings || {} })));
      if (input.tags !== undefined) set.tags = JSON.stringify((await tags.resolve(input.tags, { create: true })).map((t) => t.id));
      // Validate by saving the next future occurrence first (or a throwaway draft check through saveGroup).
      const fut = await futureGroups(r.id);
      const asInput = (at) => ({ content: set.content, media: parse(set.media, []), publish_at: at, action: 'schedule', posts: parse(set.targets, []).map((t) => ({ ...t })) });
      for (const f of fut) {
        await posts.saveGroup(asInput(f.publish_at), f.id, { principal: principal ? { ...principal, approval: principal.approval || !!r.approval } : { name: r.created_by, approval: !!r.approval } });
        if (input.tags !== undefined) await tags.setForGroup(f.id, parse(set.tags, []), 'replace');
      }
    }
    if (ruleChange) {
      if (rule.until_at !== null && rule.until_at < r.first_at) throw new HttpError(400, 'repeat.until is before the first occurrence.');
      // Rewrite the schedule: drop future occurrences that have not published, keep the history, continue from now.
      const fut = await futureGroups(r.id);
      for (const f of fut) await posts.deleteGroup(f.id);
      const kept = (await db.get('SELECT COUNT(*) AS n, MAX(series_index) AS mx, MAX(publish_at) AS last FROM groups WHERE workspace_id = ? AND series_id = ?', ws, r.id));
      let idx = 1;
      const after = Math.max(now, kept.last || 0);
      while (occurrenceAt(rule, r.first_at, idx, r.timezone) <= after && idx < 100000) idx++;
      Object.assign(set, { frequency: rule.frequency, interval_days: rule.interval_days, until_at: rule.until_at, max_count: rule.max_count, generated: kept.n, next_index: Math.max(idx, (kept.mx ?? 0) + 1), status: 'active' });
      set.next_at = occurrenceAt(rule, r.first_at, set.next_index, r.timezone);
    }
    await db.run('UPDATE series SET content = ?, media = ?, targets = ?, tags = ?, frequency = ?, interval_days = ?, until_at = ?, max_count = ?, generated = ?, next_index = ?, next_at = ?, status = ?, last_error = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?',
      set.content, set.media, set.targets, set.tags, set.frequency, set.interval_days, set.until_at, set.max_count, set.generated, set.next_index, set.next_at, set.status, now, r.id, ws);
    await fill(r.id);
    return view(await getRow(r.id), await occurrences(r.id));
  }

  /** Stop repeating. delete_future (default true) removes generated occurrences that have not published. */
  async function stop(id, { delete_future = true } = {}) {
    const r = await mustGet(id);
    let removed = 0;
    if (delete_future) for (const f of await futureGroups(r.id)) { await posts.deleteGroup(f.id); removed++; }
    await db.run("UPDATE series SET status = 'stopped', next_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?", Date.now(), r.id, ws);
    return { series: view(await getRow(r.id), await occurrences(r.id)), removed_occurrences: removed };
  }

  async function list({ status = null } = {}) {
    const rows = status ? await db.all('SELECT * FROM series WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC', ws, status) : await db.all('SELECT * FROM series WHERE workspace_id = ? ORDER BY (status = \'active\') DESC, created_at DESC', ws);
    const next = new Map((await db.all("SELECT series_id, MIN(publish_at) AS at FROM groups WHERE workspace_id = ? AND series_id IS NOT NULL AND publish_at > ? GROUP BY series_id", ws, Date.now())).map((x) => [x.series_id, x.at]));
    return rows.map((r) => ({ ...view(r), next_post_at: next.get(r.id) ?? null }));
  }
  async function get(id) { const r = await mustGet(id); return view(r, await occurrences(r.id)); }

  /** Media ids an active series still needs (never purged / deletable). */
  async function activeMediaIds() {
    const rows = await db.all("SELECT media, targets FROM series WHERE workspace_id = ? AND status = 'active'", ws);
    const out = new Set();
    for (const r of rows) {
      for (const m of parse(r.media, [])) out.add(String(m));
      for (const t of parse(r.targets, [])) {
        for (const m of t.media_override || []) out.add(String(m));
        if (t.settings?.thumbnail) out.add(String(t.settings.thumbnail));
        for (const x of t.settings?.thread || []) for (const m of x?.media || []) out.add(String(m));
      }
    }
    return [...out];
  }
  return { createFromGroup, fill, update, stop, list, get, activeMediaIds, occurrences };
}
