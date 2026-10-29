// Tags: workspace-scoped labels with a color, assigned to posts (groups). Used to filter posts, the
// calendar and analytics top posts. Every query filters by workspace_id.
import { uid } from './crypto.js';
import { HttpError } from './errors.js';

const COLOR_RE = /^#[0-9a-f]{6}$/i;
export const TAG_COLORS = ['#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#a1a1aa'];
const marks = (n) => Array(n).fill('?').join(',');

function cleanName(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().replace(/^#/, '');
  if (!n) throw new HttpError(400, 'Tag name is required.');
  if (n.length > 40) throw new HttpError(400, 'Tag name must be at most 40 characters.');
  return n;
}
function cleanColor(c, fallback = null) {
  if (c === undefined) return fallback;
  if (c === null || c === '') return null;
  if (!COLOR_RE.test(String(c))) throw new HttpError(400, 'color must be a hex color like "#3b82f6" (or null).');
  return String(c).toLowerCase();
}

export function createTags({ db, ws }) {
  if (!ws) throw new Error('createTags: workspace id required');
  const view = (t) => t && { id: t.id, name: t.name, color: t.color, posts: t.posts ?? undefined, created_at: t.created_at };

  async function list() {
    const rows = await db.all('SELECT t.*, (SELECT COUNT(*) FROM group_tags gt WHERE gt.tag_id = t.id AND gt.workspace_id = t.workspace_id) AS posts FROM tags t WHERE t.workspace_id = ? ORDER BY t.name COLLATE NOCASE', ws);
    return rows.map(view);
  }
  async function find(ref) {
    const r = String(ref ?? '').trim().replace(/^#/, '');
    if (!r) return null;
    return (await db.get('SELECT * FROM tags WHERE workspace_id = ? AND (id = ? OR name = ? COLLATE NOCASE)', ws, r, r)) || null;
  }
  async function mustFind(ref) {
    const t = await find(ref);
    if (!t) throw new HttpError(404, `Tag "${ref}" not found. Call list_tags.`);
    return t;
  }
  async function create({ name, color } = {}) {
    const n = cleanName(name);
    if (await find(n)) throw new HttpError(409, `A tag named "${n}" already exists.`);
    const all = await db.get('SELECT COUNT(*) AS n FROM tags WHERE workspace_id = ?', ws);
    const id = uid();
    const now = Date.now();
    await db.run('INSERT INTO tags(id, workspace_id, name, color, created_at, updated_at) VALUES(?,?,?,?,?,?)', id, ws, n, cleanColor(color, TAG_COLORS[all.n % TAG_COLORS.length]), now, now);
    return view(await db.get('SELECT * FROM tags WHERE id = ? AND workspace_id = ?', id, ws));
  }
  async function update(ref, { name, color } = {}) {
    const t = await mustFind(ref);
    const n = name === undefined ? t.name : cleanName(name);
    if (n.toLowerCase() !== t.name.toLowerCase()) { const other = await find(n); if (other && other.id !== t.id) throw new HttpError(409, `A tag named "${n}" already exists.`); }
    await db.run('UPDATE tags SET name = ?, color = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', n, cleanColor(color, t.color), Date.now(), t.id, ws);
    return view(await db.get('SELECT * FROM tags WHERE id = ? AND workspace_id = ?', t.id, ws));
  }
  async function remove(ref) {
    const t = await mustFind(ref);
    await db.batch([['DELETE FROM group_tags WHERE tag_id = ? AND workspace_id = ?', t.id, ws], ['DELETE FROM tags WHERE id = ? AND workspace_id = ?', t.id, ws]]);
    return true;
  }
  /** Resolve ids or names; unknown names are created when create=true. */
  async function resolve(refs, { create: make = false } = {}) {
    const out = [];
    for (const r of [...new Set((refs || []).map((x) => String(x).trim()).filter(Boolean))]) {
      const t = (await find(r)) || (make && !/^[0-9a-f-]{36}$/i.test(r) ? await create({ name: r }) : null);
      if (!t) throw new HttpError(404, `Tag "${r}" not found. Call list_tags or create_tag.`);
      if (!out.some((x) => x.id === t.id)) out.push(t);
    }
    return out;
  }
  /** Statements that set a group's tags (replace / add / remove). Caller verified the group. */
  async function setStmts(groupId, refs, mode = 'replace', { create: make = true } = {}) {
    const tags = await resolve(refs, { create: make });
    const now = Date.now();
    const ops = [];
    if (mode === 'replace') ops.push(['DELETE FROM group_tags WHERE group_id = ? AND workspace_id = ?', groupId, ws]);
    for (const t of tags) {
      if (mode === 'remove') ops.push(['DELETE FROM group_tags WHERE group_id = ? AND tag_id = ? AND workspace_id = ?', groupId, t.id, ws]);
      else ops.push(['INSERT INTO group_tags(group_id, tag_id, workspace_id, created_at) VALUES(?,?,?,?) ON CONFLICT(group_id, tag_id) DO NOTHING', groupId, t.id, ws, now]);
    }
    return ops;
  }
  async function setForGroup(groupId, refs, mode = 'replace') {
    const g = await db.get('SELECT id FROM groups WHERE id = ? AND workspace_id = ?', groupId, ws);
    if (!g) throw new HttpError(404, 'Post not found.');
    await db.batch(await setStmts(groupId, refs, mode));
  }
  /** Map groupId → [{id,name,color}] for many groups (chunks of 90 for D1). */
  async function forGroups(ids) {
    const list = [...new Set((ids || []).map(String))];
    const out = new Map();
    for (let i = 0; i < list.length; i += 90) {
      const c = list.slice(i, i + 90);
      const rows = await db.all(`SELECT gt.group_id, t.id, t.name, t.color FROM group_tags gt JOIN tags t ON t.id = gt.tag_id AND t.workspace_id = gt.workspace_id WHERE gt.workspace_id = ? AND gt.group_id IN (${marks(c.length)}) ORDER BY t.name COLLATE NOCASE`, ws, ...c);
      for (const r of rows) (out.get(r.group_id) || out.set(r.group_id, []).get(r.group_id)).push({ id: r.id, name: r.name, color: r.color });
    }
    return out;
  }
  /** Group ids carrying any of the tags (ids or names). */
  async function groupIds(refs) {
    const tags = await resolve(Array.isArray(refs) ? refs : String(refs).split(','));
    if (!tags.length) return [];
    return (await db.all(`SELECT DISTINCT group_id FROM group_tags WHERE workspace_id = ? AND tag_id IN (${marks(tags.length)})`, ws, ...tags.map((t) => t.id))).map((r) => r.group_id);
  }
  return { list, find, mustFind, create, update, remove, resolve, setStmts, setForGroup, forGroups, groupIds };
}
