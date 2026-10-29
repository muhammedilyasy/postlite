// Media retention: delete the original bytes of uploaded media once every post that uses them is done,
// keep the small poster/thumbnail JPEG, and mark the row (purged_at, purged_bytes). Portable (Node disk
// and Workers R2 go through the same storage interface).
//
// A media file is eligible when ALL of these hold (per workspace):
//   * at least one post target references it (group media, per-account override, YouTube custom
//     thumbnail, X thread media) and at least one of those targets is published — media that never went
//     live (library uploads, drafts, posts that only failed) is never removed;
//   * every referencing target is finished: published, or failed with no retry queued and older than the
//     failed-retry window. draft / pending_approval / scheduled / publishing (YouTube resumable session,
//     X chunked upload, LinkedIn multipart, IG/FB containers fetching our /m/ URL) and failed targets with
//     a queued retry all block it, as does any queued/running job;
//   * the workspace setting allows it: immediate (after the safety grace, default 30 min, counted from
//     the last target that finished), 7d, 30d or never;
//   * a preview exists or can be made (video poster / image thumbnail; PDFs need none).
// The order of a purge is: re-check blockers for that one file → mark the row (conditional, so
// concurrent runs never double-count) → delete (or, on Node with a trash dir, move) the bytes.
import { HttpError } from './errors.js';
import { wsSettings } from './tenant.js';

const DAY = 86400000;
export const RETENTION_MODES = ['immediate', '7d', '30d', 'never'];
export const RETENTION_LABELS = { immediate: 'Immediately (default)', '7d': 'After 7 days', '30d': 'After 30 days', never: 'Never' };
const DELAY = { immediate: 0, '7d': 7 * DAY, '30d': 30 * DAY };
const SETTING = 'media_retention';
const BLOCKING = { draft: 'used by a draft', pending_approval: 'used by a post awaiting approval', scheduled: 'used by a scheduled post', publishing: 'a post using it is publishing (upload or platform processing in progress)' };

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Media ids a target uses (group media + override + custom thumbnail + thread media). Conservative: union. */
export function targetMediaIds(t) {
  const s = parse(t.settings, {});
  const ids = [...parse(t.gmedia, []), ...(t.media_override ? parse(t.media_override, []) : [])];
  if (s.thumbnail) ids.push(s.thumbnail);
  if (Array.isArray(s.thread)) for (const it of s.thread) if (Array.isArray(it?.media)) ids.push(...it.media);
  return [...new Set(ids.map(String))];
}

/** Message used when a post needs bytes that were already removed. */
export const purgedMessage = (names, { retry = false } = {}) => `${retry ? 'Cannot retry: t' : 'T'}he original file${names.length > 1 ? 's' : ''} ${names.map((n) => `"${n}"`).join(', ')} ${names.length > 1 ? 'were' : 'was'} deleted after publishing to save storage (Settings → General → Storage). ${retry ? 'Duplicate the post, re-upload the file and publish the copy.' : 'Re-upload the file (the post keeps a thumbnail) before scheduling.'}`;

export function createRetention({ db, cfg, storage, ws, hooks = {}, audit = null, log = () => {} }) {
  if (!ws) throw new Error('createRetention: workspace id required');
  const store = wsSettings(db, ws);
  const P = () => cfg.mediaPurge;
  const keyOf = (m) => m.storage_key || m.filename;

  async function getMode() {
    const v = await store.get(SETTING, null);
    return RETENTION_MODES.includes(v) ? v : 'immediate';
  }
  async function setMode(mode) {
    if (!RETENTION_MODES.includes(mode)) throw new HttpError(400, `delete_media_after must be one of: ${RETENTION_MODES.join(', ')}.`);
    await store.set(SETTING, mode);
    return mode;
  }

  /** Can this runtime make a preview for m right now (Node + ffmpeg + local file)? */
  const canMakePreview = (m) => !!(cfg.ffmpegPath && storage.localPath && (m.kind === 'video' ? hooks.makePoster : hooks.makeThumb));
  const needsPreview = (m) => (m.kind === 'video' || m.kind === 'image') && !m.poster;

  function classify(t, now) {
    if (t.job_state === 'queued' || t.job_state === 'running') return { block: t.status === 'failed' ? 'a failed post using it will be retried' : BLOCKING[t.status] || 'a post using it is queued for publishing' };
    if (t.status === 'published') return { done: t.published_at || t.updated_at, published: true };
    if (t.status === 'failed') {
      const until = t.updated_at + P().failedGraceHours * 3600000;
      if (now < until) return { block: `a post using it failed recently; kept for retries until ${iso(until)}` };
      return { done: t.updated_at };
    }
    return { block: BLOCKING[t.status] || `used by a post in state "${t.status}"` };
  }

  /**
   * Decide for every not-yet-purged media item of the workspace. Read-only (2–3 queries).
   * @returns {{mode, eligible: object[], kept: object[]}}
   */
  async function plan({ now = Date.now(), mode = null } = {}) {
    mode ||= await getMode();
    const targets = await db.all(`SELECT p.id, p.group_id, p.status, p.media_override, p.settings, p.published_at, p.updated_at, g.media AS gmedia, j.state AS job_state
      FROM posts p JOIN groups g ON g.id = p.group_id AND g.workspace_id = p.workspace_id LEFT JOIN jobs j ON j.post_id = p.id WHERE p.workspace_id = ?`, ws);
    const rows = await db.all('SELECT * FROM media WHERE workspace_id = ? AND purged_at IS NULL ORDER BY created_at, id', ws);
    const refs = new Map();
    for (const t of targets) for (const id of targetMediaIds(t)) (refs.get(id) || refs.set(id, []).get(id)).push(t);
    const eligible = [];
    const kept = [];
    for (const m of rows) {
      const base = { media_id: m.id, name: m.original_name, kind: m.kind, bytes: m.size };
      const ts = refs.get(m.id) || [];
      const keep = (reason, extra = {}) => kept.push({ ...base, reason, posts: [...new Set(ts.map((t) => t.group_id))], ...extra });
      if (!ts.length) { keep('not used by any post (library upload)'); continue; }
      const states = ts.map((t) => classify(t, now));
      const blocker = states.find((s) => s.block);
      if (blocker) { keep(blocker.block); continue; }
      if (!states.some((s) => s.published)) { keep('never published (its posts only failed)'); continue; }
      if (mode === 'never') { keep('workspace setting: never delete'); continue; }
      const finished = Math.max(...states.map((s) => s.done || 0));
      const at = finished + Math.max(DELAY[mode], P().graceMinutes * 60000);
      if (now < at) { keep(mode === 'immediate' ? `safety window after publishing, until ${iso(at)}` : `setting: keep ${mode === '7d' ? '7' : '30'} days after publishing, until ${iso(at)}`, { eligible_at: at }); continue; }
      if (needsPreview(m) && !canMakePreview(m)) { keep(m.kind === 'video' ? 'waiting for a poster frame (opens in the web UI once to make one)' : 'waiting for a preview thumbnail (opens in the web UI once to make one)'); continue; }
      eligible.push({ ...base, media: m, posts: [...new Set(ts.map((t) => t.group_id))], finished_at: finished, preview: m.poster ? 'kept' : needsPreview(m) ? 'generate' : 'none' });
    }
    return { mode, eligible, kept };
  }

  /** Still blocked right now? (one indexed query per file, just before deleting it) */
  async function blockedNow(id, now) {
    const like = `%${id}%`;
    return db.get(`SELECT p.id FROM posts p JOIN groups g ON g.id = p.group_id AND g.workspace_id = p.workspace_id LEFT JOIN jobs j ON j.post_id = p.id
      WHERE p.workspace_id = ? AND (g.media LIKE ? OR p.media_override LIKE ? OR p.settings LIKE ?)
        AND (p.status NOT IN ('published','failed') OR j.state IN ('queued','running') OR (p.status = 'failed' AND p.updated_at > ?)) LIMIT 1`,
    ws, like, like, like, now - P().failedGraceHours * 3600000);
  }

  async function makePreview(m) {
    const local = storage.localPath(keyOf(m));
    const name = m.kind === 'video' ? `${m.id}.poster.jpg` : `${m.id}.thumb.jpg`;
    const ok = m.kind === 'video' ? await hooks.makePoster(cfg.ffmpegPath, local, storage.localPath(name)) : await hooks.makeThumb(cfg.ffmpegPath, local, storage.localPath(name));
    if (!ok) return null;
    await db.run('UPDATE media SET poster = ? WHERE id = ? AND workspace_id = ? AND poster IS NULL', name, m.id, ws);
    return name;
  }

  /**
   * Purge what is eligible now (bounded). Idempotent: a file is only counted by the run that marked it.
   * @param {{dryRun?:boolean, limit?:number, now?:number, principal?:object, via?:string, budget?:object}} opts
   */
  async function run({ dryRun = false, limit = P().batch, now = Date.now(), principal = null, via = 'scheduler', budget = null } = {}) {
    const p = await plan({ now });
    const out = { workspace_id: ws, mode: p.mode, dry_run: dryRun, eligible_files: p.eligible.length, eligible_bytes: p.eligible.reduce((n, e) => n + (e.bytes || 0), 0), purged: [], files: 0, bytes: 0, kept: p.kept, skipped: [] };
    if (dryRun) { out.eligible = p.eligible.map(({ media, ...e }) => e); return out; }
    for (const e of p.eligible.slice(0, limit)) {
      if (budget && !budget.has({ fetches: 2, queries: 4 })) break;
      const m = e.media;
      if (await blockedNow(m.id, now)) { out.skipped.push({ media_id: m.id, reason: 'became in use again' }); continue; }
      if (needsPreview(m) && !(await makePreview(m).catch(() => null))) { out.skipped.push({ media_id: m.id, reason: 'could not make a preview' }); continue; }
      const head = await storage.head(keyOf(m)).catch(() => null);
      const bytes = head ? head.size : 0;
      const r = await db.run('UPDATE media SET purged_at = ?, purged_bytes = ? WHERE id = ? AND workspace_id = ? AND purged_at IS NULL', now, bytes, m.id, ws);
      if (!r.changes) continue; // another run got it
      try {
        if (head) await (storage.discard ? storage.discard(keyOf(m)) : storage.delete(keyOf(m)));
      } catch (err) {
        log('warn', `media purge ${m.id}: could not remove ${keyOf(m)}: ${err.message}`);
      }
      out.purged.push({ media_id: m.id, name: m.original_name, kind: m.kind, bytes });
      out.files++;
      out.bytes += bytes;
    }
    if (out.files && audit) {
      await audit.record({ principal: principal || { type: 'system', name: 'media cleanup' }, via, operation: 'media_purge', status: 200, detail: { files: out.files, bytes: out.bytes } }).catch(() => {});
    }
    if (out.files) log('info', `media purge ${ws}: ${out.files} file(s), ${out.bytes} bytes freed`);
    return out;
  }

  async function stats() {
    const [live, gone] = await Promise.all([
      db.get('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM media WHERE workspace_id = ? AND purged_at IS NULL', ws),
      db.get('SELECT COUNT(*) AS n, COALESCE(SUM(purged_bytes), 0) AS b FROM media WHERE workspace_id = ? AND purged_at IS NOT NULL', ws),
    ]);
    return { files: live.n, used_bytes: live.b, purged_files: gone.n, freed_bytes: gone.b };
  }

  return { getMode, setMode, plan, run, stats, blockedNow };
}
