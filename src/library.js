// Media library: search/filter/paginate a workspace's uploads with how each one is used, and bulk delete
// of media no unfinished post needs. Workspace-scoped; usage is computed from the workspace's posts
// (group media, per-account overrides, YouTube thumbnails, X thread media) and repeating-post templates.
import { HttpError } from './errors.js';
import { targetMediaIds } from './retention.js';

export const MEDIA_KINDS = ['image', 'video', 'document'];
export const MEDIA_USAGE = ['used', 'unused', 'purged'];
const UNFINISHED = new Set(['draft', 'pending_approval', 'scheduled', 'publishing', 'failed']);
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function createLibrary({ db, ws, media, extraRefs = async () => [] }) {
  if (!ws) throw new Error('createLibrary: workspace id required');

  /** Map media id → { posts:Set(group ids), unfinished:boolean, series:boolean }. */
  async function usageMap() {
    const targets = await db.all(`SELECT p.group_id, p.status, p.media_override, p.settings, g.media AS gmedia
      FROM posts p JOIN groups g ON g.id = p.group_id AND g.workspace_id = p.workspace_id WHERE p.workspace_id = ?`, ws);
    const map = new Map();
    const get = (id) => map.get(id) || map.set(id, { posts: new Set(), unfinished: false, series: false }).get(id);
    for (const t of targets) for (const id of targetMediaIds(t)) { const u = get(id); u.posts.add(t.group_id); if (UNFINISHED.has(t.status)) u.unfinished = true; }
    // Drafts can have no targets yet: their group media still counts.
    const loose = await db.all('SELECT g.id, g.media FROM groups g WHERE g.workspace_id = ? AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.group_id = g.id AND p.workspace_id = g.workspace_id)', ws);
    for (const g of loose) for (const id of parse(g.media, [])) { const u = get(String(id)); u.posts.add(g.id); u.unfinished = true; }
    for (const id of await extraRefs()) { const u = get(String(id)); u.series = true; u.unfinished = true; }
    return map;
  }

  const out = (m, u) => ({ ...media.view(m), used_by_posts: u ? u.posts.size : 0, in_use: !!u?.unfinished, in_series: !!u?.series, deletable: !u?.unfinished });

  /**
   * List with filters. q = filename contains; kind = image|video|document; usage = used|unused|purged.
   * Returns { media, total, limit, offset }.
   */
  async function list({ q = '', kind = null, usage = null, limit = 48, offset = 0 } = {}) {
    limit = Math.min(Math.max(Number(limit) || 48, 1), 200);
    offset = Math.max(Number(offset) || 0, 0);
    if (kind && !MEDIA_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${MEDIA_KINDS.join(', ')}.`);
    if (usage && !MEDIA_USAGE.includes(usage)) throw new HttpError(400, `usage must be one of ${MEDIA_USAGE.join(', ')}.`);
    const where = ['workspace_id = ?'];
    const args = [ws];
    const needle = String(q || '').trim();
    if (needle) { where.push("original_name LIKE ? ESCAPE '!'"); args.push(`%${needle.replace(/[!%_]/g, (c) => `!${c}`)}%`); }
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (usage === 'purged') where.push('purged_at IS NOT NULL');
    const sqlBase = `FROM media WHERE ${where.join(' AND ')}`;
    const map = await usageMap();
    if (usage === 'used' || usage === 'unused') {
      // Usage lives outside SQL: filter in memory (bounded), then page.
      const rows = await db.all(`SELECT * ${sqlBase} ORDER BY created_at DESC, id LIMIT 5000`, ...args);
      const keep = rows.filter((m) => (usage === 'used' ? map.has(m.id) : !map.has(m.id) && !m.purged_at));
      return { media: keep.slice(offset, offset + limit).map((m) => out(m, map.get(m.id))), total: keep.length, limit, offset };
    }
    const [{ n }] = await db.all(`SELECT COUNT(*) AS n ${sqlBase}`, ...args);
    const rows = await db.all(`SELECT * ${sqlBase} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, ...args, limit, offset);
    return { media: rows.map((m) => out(m, map.get(m.id))), total: n, limit, offset };
  }

  /** Counts for the filter chips. */
  async function counts() {
    const rows = await db.all('SELECT id, kind, purged_at FROM media WHERE workspace_id = ?', ws);
    const map = await usageMap();
    const c = { all: rows.length, image: 0, video: 0, document: 0, used: 0, unused: 0, purged: 0 };
    for (const m of rows) { c[m.kind] = (c[m.kind] || 0) + 1; if (m.purged_at) c.purged++; if (map.has(m.id)) c.used++; else if (!m.purged_at) c.unused++; }
    return c;
  }

  /** Delete several items; anything an unfinished post or an active repeating series needs is skipped. */
  async function deleteMany(ids) {
    const list = [...new Set((ids || []).map(String))].slice(0, 200);
    const map = await usageMap();
    const deleted = [], skipped = [];
    for (const id of list) {
      const u = map.get(id);
      if (u?.unfinished) { skipped.push({ media_id: id, reason: u.series ? 'used by a repeating post' : 'used by an unpublished post' }); continue; }
      if (await media.remove(id)) deleted.push(id); else skipped.push({ media_id: id, reason: 'not found' });
    }
    return { deleted, skipped };
  }

  return { list, counts, deleteMany, usageMap };
}
