// Brands: named sets of connected accounts ("channels") across platforms, e.g. "North Star" = its YouTube,
// Instagram, Facebook and X accounts. Workspace-scoped (every query filters by workspace_id); an account
// can belong to several brands. The internal `groups` table is something else (a post + its targets).
import { uid } from './crypto.js';
import { HttpError } from './errors.js';

const COLOR_RE = /^#[0-9a-f]{6}$/i;
export const BRAND_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#a1a1aa'];
const marks = (n) => Array(n).fill('?').join(',');

function cleanName(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new HttpError(400, 'Brand name is required.');
  if (n.length > 60) throw new HttpError(400, 'Brand name must be at most 60 characters.');
  return n;
}
function cleanColor(color) {
  if (color === null || color === undefined || color === '') return null;
  if (!COLOR_RE.test(String(color))) throw new HttpError(400, 'color must be a hex color like "#3b82f6" (or null for none).');
  return String(color).toLowerCase();
}

/**
 * Suggest brands from account names that share a word prefix ("North Star Explains", "North Star Tools" →
 * "North Star"), or the same name on several platforms. Never creates anything.
 */
export function suggestBrands(accounts, existing = []) {
  const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);
  const cand = new Map(); // lower prefix -> { name, ids:Set }
  for (const a of accounts) {
    const w = words(a.name);
    for (let k = 1; k <= w.length; k++) {
      const name = w.slice(0, k).join(' ');
      if (name.length < 3 || (k === 1 && name.length < 4 && w.length > 1)) continue;
      const key = name.toLowerCase();
      const c = cand.get(key) || cand.set(key, { name, ids: new Set() }).get(key);
      c.ids.add(a.id);
    }
  }
  const sig = (ids) => [...ids].sort().join(',');
  const taken = new Set(existing.map((b) => sig(b.channel_ids)));
  const names = new Set(existing.map((b) => b.name.toLowerCase()));
  // Keep the longest prefix for each member set ("North" and "North Star" with the same accounts → "North Star").
  const best = new Map();
  for (const c of cand.values()) {
    if (c.ids.size < 2) continue;
    const s = sig(c.ids);
    const cur = best.get(s);
    if (!cur || c.name.length > cur.name.length) best.set(s, c);
  }
  return [...best.entries()]
    .filter(([s, c]) => !taken.has(s) && !names.has(c.name.toLowerCase()))
    .map(([, c]) => ({ name: c.name, account_ids: [...c.ids], providers: [...new Set(accounts.filter((a) => c.ids.has(a.id)).map((a) => a.provider))] }))
    // broader sets first (a whole brand), then by name
    .sort((a, b) => b.account_ids.length - a.account_ids.length || a.name.localeCompare(b.name))
    .slice(0, 5);
}

export function createBrands({ db, ws }) {
  if (!ws) throw new Error('createBrands: workspace id required');

  async function list() {
    const [brands, links] = await Promise.all([
      db.all('SELECT * FROM brands WHERE workspace_id = ? ORDER BY name COLLATE NOCASE', ws),
      db.all(`SELECT bc.brand_id, i.id, i.provider, COALESCE(i.display_name, i.name) AS name, i.picture, i.status, i.disabled_at FROM brand_channels bc
        JOIN integrations i ON i.id = bc.integration_id AND i.workspace_id = bc.workspace_id WHERE bc.workspace_id = ? ORDER BY i.provider, COALESCE(i.display_name, i.name)`, ws),
    ]);
    return brands.map((b) => {
      const channels = links.filter((l) => l.brand_id === b.id).map(({ brand_id, ...c }) => c);
      return { id: b.id, name: b.name, color: b.color, channel_ids: channels.map((c) => c.id), channels, providers: [...new Set(channels.map((c) => c.provider))], created_at: b.created_at, updated_at: b.updated_at };
    });
  }

  /** A brand by id or (case-insensitive) name, with its channels. */
  async function find(ref) {
    const r = String(ref ?? '').trim();
    if (!r) return null;
    const all = await list();
    return all.find((b) => b.id === r) || all.find((b) => b.name.toLowerCase() === r.toLowerCase()) || null;
  }
  async function mustFind(ref) {
    const b = await find(ref);
    if (!b) throw new HttpError(404, `Brand "${ref}" not found. Call list_brands for ids and names.`);
    return b;
  }

  async function checkAccounts(ids) {
    const list = [...new Set((ids || []).map(String))];
    if (!list.length) return list;
    const rows = await db.all(`SELECT id FROM integrations WHERE workspace_id = ? AND id IN (${marks(list.length)})`, ws, ...list);
    const ok = new Set(rows.map((r) => r.id));
    const bad = list.filter((id) => !ok.has(id));
    if (bad.length) throw new HttpError(400, `Unknown account_id(s): ${bad.join(', ')}. Call list_accounts.`);
    return list;
  }

  async function nameFree(name, exceptId = null) {
    const row = await db.get('SELECT id FROM brands WHERE workspace_id = ? AND name = ? COLLATE NOCASE', ws, name);
    if (row && row.id !== exceptId) throw new HttpError(409, `A brand named "${name}" already exists.`);
  }

  const api = {
    list,
    find,
    mustFind,
    async create({ name, color = null, account_ids = [] } = {}) {
      const n = cleanName(name);
      const c = cleanColor(color);
      await nameFree(n);
      const ids = await checkAccounts(account_ids);
      const id = uid();
      const now = Date.now();
      await db.batch([
        ['INSERT INTO brands(id, workspace_id, name, color, created_at, updated_at) VALUES(?,?,?,?,?,?)', id, ws, n, c, now, now],
        ...ids.map((iid) => ['INSERT INTO brand_channels(brand_id, integration_id, workspace_id, created_at) VALUES(?,?,?,?)', id, iid, ws, now]),
      ]);
      return mustFind(id);
    },
    async update(ref, { name, color } = {}) {
      const b = await mustFind(ref);
      const n = name === undefined ? b.name : cleanName(name);
      const c = color === undefined ? b.color : cleanColor(color);
      if (n.toLowerCase() !== b.name.toLowerCase()) await nameFree(n, b.id);
      await db.run('UPDATE brands SET name = ?, color = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', n, c, Date.now(), b.id, ws);
      return mustFind(b.id);
    },
    async remove(ref) {
      const b = await mustFind(ref);
      await db.batch([
        ['DELETE FROM brand_channels WHERE brand_id = ? AND workspace_id = ?', b.id, ws],
        ['DELETE FROM brands WHERE id = ? AND workspace_id = ?', b.id, ws],
      ]);
      return true;
    },
    /** mode: replace (default) | add | remove */
    async setChannels(ref, accountIds, mode = 'replace') {
      const b = await mustFind(ref);
      const ids = await checkAccounts(accountIds);
      const now = Date.now();
      const ops = [];
      if (mode === 'replace') ops.push(['DELETE FROM brand_channels WHERE brand_id = ? AND workspace_id = ?', b.id, ws]);
      if (mode === 'remove') for (const iid of ids) ops.push(['DELETE FROM brand_channels WHERE brand_id = ? AND integration_id = ? AND workspace_id = ?', b.id, iid, ws]);
      else for (const iid of ids) ops.push(['INSERT INTO brand_channels(brand_id, integration_id, workspace_id, created_at) VALUES(?,?,?,?) ON CONFLICT(brand_id, integration_id) DO NOTHING', b.id, iid, ws, now]);
      ops.push(['UPDATE brands SET updated_at = ? WHERE id = ? AND workspace_id = ?', now, b.id, ws]);
      await db.batch(ops);
      return mustFind(b.id);
    },
    /** Account ids of one or more brands (ids or names, comma-separated string or array); union. */
    async accountIds(refs) {
      const list = (Array.isArray(refs) ? refs : String(refs ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);
      const out = new Set();
      for (const r of list) for (const id of (await mustFind(r)).channel_ids) out.add(id);
      return [...out];
    },
    /** Map account id → [{id, name, color}] for tags on account rows. */
    async byAccount() {
      const m = new Map();
      for (const b of await list()) for (const id of b.channel_ids) (m.get(id) || m.set(id, []).get(id)).push({ id: b.id, name: b.name, color: b.color });
      return m;
    },
    async suggestions(accounts) {
      return suggestBrands(accounts, await list());
    },
  };
  return api;
}
