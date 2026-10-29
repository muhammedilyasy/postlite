// Signatures (saved text snippets, optionally auto-added to new posts for some platforms/channels) and
// post templates ("sets": caption + per-channel settings + channel/brand selection + tags, never media).
// Workspace-scoped; every query filters by workspace_id.
import { uid } from './crypto.js';
import { HttpError } from './errors.js';
import { PLATFORM_PROVIDERS } from './posts.js';

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
function cleanName(name, what) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new HttpError(400, `${what} name is required.`);
  if (n.length > 60) throw new HttpError(400, `${what} name must be at most 60 characters.`);
  return n;
}
const PLATFORMS = Object.keys(PLATFORM_PROVIDERS);

/** Append a signature to text with one blank line between (no duplicate if it is already at the end). */
export function appendSignature(text, sig) {
  const t = String(text || '').replace(/\s+$/, '');
  const s = String(sig || '').trim();
  if (!s) return t;
  if (t.endsWith(s)) return t;
  return t ? `${t}\n\n${s}` : s;
}

export function createSignatures({ db, ws }) {
  if (!ws) throw new Error('createSignatures: workspace id required');
  const view = (r) => r && { id: r.id, name: r.name, content: r.content, auto_add: !!r.auto_add, platforms: parse(r.providers, []), account_ids: parse(r.account_ids, []), created_at: r.created_at, updated_at: r.updated_at };
  const list = async () => (await db.all('SELECT * FROM signatures WHERE workspace_id = ? ORDER BY name COLLATE NOCASE', ws)).map(view);
  async function find(ref) {
    const r = String(ref ?? '').trim();
    return r ? view(await db.get('SELECT * FROM signatures WHERE workspace_id = ? AND (id = ? OR name = ? COLLATE NOCASE)', ws, r, r)) : null;
  }
  async function mustFind(ref) { const s = await find(ref); if (!s) throw new HttpError(404, `Signature "${ref}" not found. Call list_signatures.`); return s; }
  function clean(input, prev = null) {
    const content = input.content === undefined ? prev?.content : String(input.content).replace(/\s+$/, '');
    if (!content || !content.trim()) throw new HttpError(400, 'Signature content is required.');
    if (content.length > 2000) throw new HttpError(400, 'Signature content must be at most 2000 characters.');
    const platforms = input.platforms === undefined ? prev?.platforms || [] : [...new Set(input.platforms || [])];
    for (const p of platforms) if (!PLATFORMS.includes(p)) throw new HttpError(400, `Unknown platform "${p}". Use: ${PLATFORMS.join(', ')}.`);
    const accountIds = input.account_ids === undefined ? prev?.account_ids || [] : [...new Set((input.account_ids || []).map(String))];
    return { content, auto_add: input.auto_add === undefined ? !!prev?.auto_add : !!input.auto_add, platforms, accountIds };
  }
  async function checkAccounts(ids) {
    if (!ids.length) return;
    const rows = await db.all(`SELECT id FROM integrations WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`, ws, ...ids);
    if (rows.length !== ids.length) throw new HttpError(400, 'Unknown account_ids (call list_accounts).');
  }
  async function create(input = {}) {
    const name = cleanName(input.name, 'Signature');
    if (await find(name)) throw new HttpError(409, `A signature named "${name}" already exists.`);
    const c = clean(input);
    await checkAccounts(c.accountIds);
    const id = uid(), now = Date.now();
    await db.run('INSERT INTO signatures(id, workspace_id, name, content, auto_add, providers, account_ids, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id, ws, name, c.content, c.auto_add ? 1 : 0, JSON.stringify(c.platforms), JSON.stringify(c.accountIds), now, now);
    return find(id);
  }
  async function update(ref, input = {}) {
    const s = await mustFind(ref);
    const name = input.name === undefined ? s.name : cleanName(input.name, 'Signature');
    if (name.toLowerCase() !== s.name.toLowerCase() && (await find(name))) throw new HttpError(409, `A signature named "${name}" already exists.`);
    const c = clean(input, s);
    await checkAccounts(c.accountIds);
    await db.run('UPDATE signatures SET name = ?, content = ?, auto_add = ?, providers = ?, account_ids = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', name, c.content, c.auto_add ? 1 : 0, JSON.stringify(c.platforms), JSON.stringify(c.accountIds), Date.now(), s.id, ws);
    return find(s.id);
  }
  async function remove(ref) { const s = await mustFind(ref); await db.run('DELETE FROM signatures WHERE id = ? AND workspace_id = ?', s.id, ws); return true; }
  /** Auto-add signatures that apply to any of these channels ({id, provider}); empty scope = every channel. */
  async function autoFor(accounts) {
    const all = (await list()).filter((s) => s.auto_add);
    return all.filter((s) => {
      if (!s.platforms.length && !s.account_ids.length) return accounts.length > 0;
      return accounts.some((a) => s.account_ids.includes(a.id) || s.platforms.some((p) => (PLATFORM_PROVIDERS[p] || []).includes(a.provider)));
    });
  }
  return { list, find, mustFind, create, update, remove, autoFor };
}

export function createTemplates({ db, ws }) {
  if (!ws) throw new Error('createTemplates: workspace id required');
  const view = (r) => r && { id: r.id, name: r.name, ...parse(r.data, {}), created_at: r.created_at, updated_at: r.updated_at };
  const list = async () => (await db.all('SELECT * FROM post_templates WHERE workspace_id = ? ORDER BY name COLLATE NOCASE', ws)).map(view);
  async function find(ref) {
    const r = String(ref ?? '').trim();
    return r ? view(await db.get('SELECT * FROM post_templates WHERE workspace_id = ? AND (id = ? OR name = ? COLLATE NOCASE)', ws, r, r)) : null;
  }
  async function mustFind(ref) { const t = await find(ref); if (!t) throw new HttpError(404, `Template "${ref}" not found. Call list_templates.`); return t; }
  /** Keep only what a template stores: no media, no times, no ids of posts. */
  async function cleanData(input) {
    const targets = (input.targets || []).map((t) => {
      const settings = { ...(t.settings || {}) };
      delete settings.thumbnail; // media never goes into a template
      if (Array.isArray(settings.thread)) settings.thread = settings.thread.map((x) => ({ text: String(x?.text || ''), media: [] }));
      return { account_id: String(t.account_id), ...(t.content !== undefined && t.content !== null ? { content: String(t.content) } : {}), settings };
    });
    const ids = targets.map((t) => t.account_id);
    if (ids.length) {
      const rows = await db.all(`SELECT id FROM integrations WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`, ws, ...ids);
      if (rows.length !== new Set(ids).size) throw new HttpError(400, 'Unknown account_id in targets (call list_accounts).');
    }
    const content = String(input.content ?? '');
    if (content.length > 70000) throw new HttpError(400, 'Template content is too long.');
    return { content, targets, brand_id: input.brand_id || null, tags: [...new Set((input.tags || []).map(String))] };
  }
  async function create(input) {
    const name = cleanName(input.name, 'Template');
    if (await find(name)) throw new HttpError(409, `A template named "${name}" already exists.`);
    const data = await cleanData(input);
    const id = uid(), now = Date.now();
    await db.run('INSERT INTO post_templates(id, workspace_id, name, data, created_at, updated_at) VALUES(?,?,?,?,?,?)', id, ws, name, JSON.stringify(data), now, now);
    return find(id);
  }
  async function update(ref, input) {
    const t = await mustFind(ref);
    const name = input.name === undefined ? t.name : cleanName(input.name, 'Template');
    if (name.toLowerCase() !== t.name.toLowerCase() && (await find(name))) throw new HttpError(409, `A template named "${name}" already exists.`);
    const data = await cleanData({ content: input.content ?? t.content, targets: input.targets ?? t.targets, brand_id: input.brand_id !== undefined ? input.brand_id : t.brand_id, tags: input.tags ?? t.tags });
    await db.run('UPDATE post_templates SET name = ?, data = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', name, JSON.stringify(data), Date.now(), t.id, ws);
    return find(t.id);
  }
  async function remove(ref) { const t = await mustFind(ref); await db.run('DELETE FROM post_templates WHERE id = ? AND workspace_id = ?', t.id, ws); return true; }
  return { list, find, mustFind, create, update, remove };
}
