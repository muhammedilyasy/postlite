// One-off data migration for instances that ran as a single shared workspace: attribute every existing
// row to the person who created it, using the evidence the database already holds:
//   * audit log: Access-session actors (emails) for oauth_connected / select_accounts / create_api_key /
//     create_webhook / create_post / uploads, and API-key actors (a key belongs to whoever created it)
//   * groups.created_by and uploads.created_by (API-key name or email)
//   * which account each post targets (a post always lives with the account it publishes to)
//   * which posts use each media item
// Password-mode actions ("admin (web UI)", CLI) are the owner's. Anything without evidence goes to the
// owner's workspace and is listed as UNATTRIBUTABLE so he can reassign it.
//
// Dry run (default) opens the database READ-ONLY and prints the report. --apply migrates the schema if
// needed and moves rows out of the legacy 'owner' workspace in ONE transaction (rows already in another
// workspace are never touched, so re-running is safe). Platform-app credentials and scheduling settings
// are copied to every workspace (tokens obtained with those apps keep refreshing).
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openDb } from './db.js';

const LEGACY = 'owner';
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));
const norm = (s) => String(s || '').trim().toLowerCase();
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const short = (s, n = 60) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Compute the attribution from a node:sqlite handle (schema v5 or v6). Pure: no writes. */
export function computeAttribution(db, ownerEmail) {
  const owner = norm(ownerEmail);
  if (!isEmail(owner)) throw new Error('--owner EMAIL is required (the person who gets everything unattributable).');
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const has = (table, col) => all(`PRAGMA table_info(${table})`).some((c) => c.name === col);
  const v6 = has('integrations', 'workspace_id');
  const legacyOnly = (t) => (v6 ? ` WHERE workspace_id = '${LEGACY}' OR workspace_id IS NULL` : '');

  const rows = {
    integrations: all(`SELECT id, provider, name, created_at FROM integrations${legacyOnly('integrations')}`),
    api_keys: all(`SELECT id, name, created_at, revoked_at FROM api_keys${legacyOnly('api_keys')}`),
    webhooks: all(`SELECT id, url, created_at FROM webhooks${legacyOnly('webhooks')}`),
    groups: all(`SELECT id, content, media, created_by, created_at FROM groups${legacyOnly('groups')}`),
    posts: all(`SELECT id, group_id, integration_id, media_override, settings, status FROM posts${legacyOnly('posts')}`),
    media: all(`SELECT id, original_name, kind, created_at FROM media${legacyOnly('media')}`),
    uploads: all(`SELECT id, created_by, original_name, state FROM uploads${legacyOnly('uploads')}`),
    audit_log: all(`SELECT id, at, actor_type, actor_id, actor_name, operation, target, detail FROM audit_log${legacyOnly('audit_log')} ORDER BY id`),
  };
  const remoteCount = all(`SELECT integration_id, COUNT(*) n FROM remote_posts${legacyOnly('remote_posts')} GROUP BY integration_id`);
  const sessions = all('SELECT email FROM sessions WHERE email IS NOT NULL');
  const users = has('users', 'email') ? all('SELECT email FROM users') : [];

  // who[table][id] = { email, how }
  const who = Object.fromEntries(Object.keys(rows).map((t) => [t, new Map()]));
  const conflicts = [];
  const set = (t, id, email, how, { override = false } = {}) => {
    if (!id) return;
    const cur = who[t].get(String(id));
    if (cur && cur.email !== email) {
      if (!override) { conflicts.push({ table: t, id: String(id), kept: cur, other: { email, how } }); return; }
      conflicts.push({ table: t, id: String(id), kept: { email, how }, other: cur });
    }
    if (!cur || override) who[t].set(String(id), { email, how });
  };
  const byId = (t) => new Map(rows[t].map((r) => [String(r.id), r]));
  const keysById = byId('api_keys');

  // 1) API keys: created by whom (audit create_api_key: session email, password-mode admin or CLI).
  for (const a of rows.audit_log) {
    if (a.operation !== 'create_api_key' || Number(a.at) <= 0) continue;
    const d = parse(a.detail, {});
    const actor = a.actor_type === 'session' && isEmail(a.actor_id) ? norm(a.actor_id) : a.actor_type === 'session' || a.actor_type === 'cli' ? owner : null;
    if (!actor) continue; // created by another key: resolved below
    const how = isEmail(a.actor_id) ? `audit #${a.id}: create_api_key by ${actor}` : `audit #${a.id}: create_api_key by ${a.actor_type === 'cli' ? 'server CLI' : 'password-mode admin'} (owner)`;
    const cand = a.target && keysById.has(String(a.target)) ? [keysById.get(String(a.target))]
      : rows.api_keys.filter((k) => k.name === d?.name && Math.abs(Number(k.created_at) - Number(a.at)) < 5000);
    if (cand.length === 1) set('api_keys', cand[0].id, actor, how);
  }
  // keys created by keys inherit the creator key's owner
  for (const a of rows.audit_log) {
    if (a.operation !== 'create_api_key' || a.actor_type !== 'api_key') continue;
    const parent = who.api_keys.get(String(a.actor_id));
    const d = parse(a.detail, {});
    const cand = rows.api_keys.filter((k) => k.name === d?.name && Math.abs(Number(k.created_at) - Number(a.at)) < 5000);
    if (parent && cand.length === 1) set('api_keys', cand[0].id, parent.email, `audit #${a.id}: created by key "${keysById.get(String(a.actor_id))?.name}" (${parent.email})`);
  }

  // Actor of an audit row → email (or null when unknown).
  const actorEmail = (a) => {
    if (a.actor_type === 'session' && isEmail(a.actor_id)) return { email: norm(a.actor_id), how: `audit #${a.id}: ${a.operation} by ${norm(a.actor_id)}` };
    if (a.actor_type === 'session' || a.actor_type === 'cli') return { email: owner, how: `audit #${a.id}: ${a.operation} by ${a.actor_type === 'cli' ? 'server CLI' : 'password-mode admin'} (owner)` };
    if (a.actor_type === 'api_key') {
      const k = who.api_keys.get(String(a.actor_id));
      if (k) return { email: k.email, how: `audit #${a.id}: ${a.operation} by key "${keysById.get(String(a.actor_id))?.name || a.actor_id}" (${k.email})` };
    }
    return null;
  };

  // 2) Accounts, media, groups, webhooks from audit operations.
  const MEDIA_OPS = new Set(['complete_upload', 'upload_media_base64', 'upload_media_from_url', 'upload_media', 'upload_media_from_path', 'set_media_poster']);
  const hooksByUrl = (url, at) => rows.webhooks.filter((w) => w.url === url && Math.abs(Number(w.created_at) - Number(at)) < 5000);
  for (const a of rows.audit_log) {
    if (a.status && Number(a.status) >= 300) continue;
    const act = actorEmail(a);
    if (!act) continue;
    const d = parse(a.detail, null);
    if (a.operation === 'oauth_connected' && Array.isArray(d)) for (const c of d) set('integrations', c.id, act.email, act.how);
    if (a.operation === 'select_accounts' && Array.isArray(d?.connected)) for (const c of d.connected) set('integrations', c.id, act.email, act.how);
    if (MEDIA_OPS.has(a.operation) && a.target) set('media', a.target, act.email, act.how);
    if (a.operation === 'create_post' && a.target) set('groups', a.target, act.email, act.how);
    if (a.operation === 'create_webhook' && d?.url) { const c = hooksByUrl(d.url, a.at); if (c.length === 1) set('webhooks', c[0].id, act.email, act.how); }
  }

  // 3) groups.created_by: an email, an API-key name (unique), or the password-mode admin.
  for (const g of rows.groups) {
    if (who.groups.has(String(g.id)) || !g.created_by) continue;
    if (isEmail(g.created_by)) { set('groups', g.id, norm(g.created_by), `groups.created_by = ${norm(g.created_by)}`); continue; }
    if (/^admin \(web UI\)$/.test(g.created_by)) { set('groups', g.id, owner, 'groups.created_by = password-mode admin (owner)'); continue; }
    const ks = rows.api_keys.filter((k) => k.name === g.created_by);
    const owners = [...new Set(ks.map((k) => who.api_keys.get(String(k.id))?.email).filter(Boolean))];
    if (owners.length === 1) set('groups', g.id, owners[0], `groups.created_by = key "${g.created_by}" (${owners[0]})`);
  }

  // 4) Posts live with the account they publish to. A group follows its posts; a group whose posts point at
  //    accounts of different people is split (one group per person).
  // An account without evidence is the owner's; its posts follow it either way (a post must sit in the
  // workspace of the account it publishes to, or the scheduler would not find it).
  const integOf = (id) => who.integrations.get(String(id)) || { email: owner, how: 'account unattributable (owner)' };
  const postsByGroup = new Map();
  for (const p of rows.posts) (postsByGroup.get(p.group_id) || postsByGroup.set(p.group_id, []).get(p.group_id)).push(p);
  const splits = [];
  for (const p of rows.posts) {
    const i = integOf(p.integration_id);
    set('posts', p.id, i.email, `targets an account of ${i.email}${who.integrations.has(String(p.integration_id)) ? '' : ' (account unattributable)'}`);
  }
  for (const g of rows.groups) {
    const ps = postsByGroup.get(g.id) || [];
    const owners = [...new Set(ps.map((p) => who.posts.get(String(p.id))?.email).filter(Boolean))];
    if (owners.length === 1) set('groups', g.id, owners[0], `its posts target ${owners[0]}'s accounts`, { override: true });
    else if (owners.length > 1) {
      const ge = who.groups.get(String(g.id));
      if (!ge || !owners.includes(ge.email)) set('groups', g.id, owners[0], 'split: kept by the first account owner', { override: true });
      splits.push({ group: g.id, owners });
    }
  }

  // 5) Media without audit evidence: whoever's posts use it.
  const mediaUse = new Map();
  for (const g of rows.groups) {
    const ge = who.groups.get(String(g.id));
    const ids = [...parse(g.media, []), ...(postsByGroup.get(g.id) || []).flatMap((p) => [...(parse(p.media_override, []) || []), parse(p.settings, {})?.thumbnail].filter(Boolean))];
    if (ge) for (const m of ids) (mediaUse.get(String(m)) || mediaUse.set(String(m), new Set()).get(String(m))).add(ge.email);
  }
  for (const m of rows.media) {
    const users = [...(mediaUse.get(String(m.id)) || [])];
    const cur = who.media.get(String(m.id));
    if (!cur && users.length === 1) set('media', m.id, users[0], `used by ${users[0]}'s posts`);
    else if (cur && users.length && !users.includes(cur.email)) conflicts.push({ table: 'media', id: String(m.id), kept: cur, other: { email: users.join(','), how: 'used by posts of' } });
  }

  // 6) Upload sessions: created_by key name / email, or the media they produced.
  for (const u of rows.uploads) {
    const m = who.media.get(String(u.id));
    if (m) { set('uploads', u.id, m.email, `produced media ${u.id} (${m.email})`); continue; }
    if (isEmail(u.created_by)) { set('uploads', u.id, norm(u.created_by), `uploads.created_by = ${norm(u.created_by)}`); continue; }
    const ks = rows.api_keys.filter((k) => k.name === u.created_by);
    const owners = [...new Set(ks.map((k) => who.api_keys.get(String(k.id))?.email).filter(Boolean))];
    if (owners.length === 1) set('uploads', u.id, owners[0], `uploads.created_by = key "${u.created_by}" (${owners[0]})`);
  }

  // 7) Audit rows belong to their actor.
  for (const a of rows.audit_log) {
    const act = actorEmail(a);
    if (act) who.audit_log.set(String(a.id), { email: act.email, how: 'actor' });
  }

  // Emails that get a workspace: every signed-in email seen anywhere, plus the owner.
  const emails = new Set([owner]);
  for (const s of sessions) emails.add(norm(s.email));
  for (const u of users) emails.add(norm(u.email));
  for (const a of rows.audit_log) if (a.actor_type === 'session' && isEmail(a.actor_id)) emails.add(norm(a.actor_id));
  for (const t of Object.keys(who)) for (const v of who[t].values()) emails.add(v.email);

  // Final assignment (unattributed → owner) + report.
  const DESC = {
    integrations: (r) => `${r.provider} "${short(r.name, 40)}"`,
    api_keys: (r) => `key "${short(r.name, 30)}"${r.revoked_at ? ' (revoked)' : ''}`,
    webhooks: (r) => short(r.url, 60),
    groups: (r) => `post "${short(r.content, 50)}"`,
    posts: (r) => `target of post ${r.group_id} (${r.status})`,
    media: (r) => `${r.kind} "${short(r.original_name, 40)}"`,
    uploads: (r) => `upload "${short(r.original_name, 40)}" (${r.state})`,
    audit_log: (r) => `${r.operation} by ${r.actor_type}:${short(r.actor_name || r.actor_id, 30)}`,
  };
  const assignment = {};
  const counts = Object.fromEntries([...emails].map((e) => [e, {}]));
  const unattributable = [];
  for (const [t, list] of Object.entries(rows)) {
    assignment[t] = new Map();
    for (const r of list) {
      const w = who[t].get(String(r.id));
      const email = w?.email || owner;
      assignment[t].set(String(r.id), email);
      counts[email][t] = (counts[email][t] || 0) + 1;
      if (!w) unattributable.push({ table: t, id: String(r.id), what: DESC[t](r) });
    }
  }
  // Children that follow their account (counted for the report).
  for (const r of remoteCount) {
    const email = assignment.integrations.get(String(r.integration_id)) || owner;
    counts[email].remote_posts = (counts[email].remote_posts || 0) + r.n;
  }
  const how = Object.fromEntries(Object.keys(who).map((t) => [t, Object.fromEntries([...who[t]].map(([id, v]) => [id, v]))]));
  return { owner, emails: [...emails], assignment, counts, unattributable, conflicts, splits, how, v6 };
}

export function formatReport(res, { apply = false } = {}) {
  const L = [];
  const TABLES = ['integrations', 'groups', 'posts', 'media', 'uploads', 'remote_posts', 'api_keys', 'webhooks', 'audit_log'];
  L.push(`postlite workspace attribution — ${apply ? 'APPLIED' : 'DRY RUN (read-only)'}`);
  L.push(`owner (receives unattributable rows): ${res.owner}`);
  L.push('');
  L.push(`${'email'.padEnd(30)} ${TABLES.map((t) => t.replace('remote_posts', 'remote').replace('integrations', 'accounts').padStart(9)).join(' ')}`);
  for (const e of res.emails) L.push(`${e.padEnd(30)} ${TABLES.map((t) => String(res.counts[e]?.[t] || 0).padStart(9)).join(' ')}`);
  L.push('');
  L.push('Evidence used (first rule per row):');
  const evidence = new Map();
  for (const [t, m] of Object.entries(res.how)) for (const [id, v] of Object.entries(m)) {
    if (t === 'audit_log' || !res.assignment[t]?.has(id)) continue; // evidence about rows that no longer exist
    const k = `${t}: ${v.how.replace(/#\d+/, '#n').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')}`;
    evidence.set(k, (evidence.get(k) || 0) + 1);
  }
  for (const [k, n] of [...evidence].sort()) L.push(`  ${String(n).padStart(4)} × ${k}`);
  L.push('');
  L.push(`UNATTRIBUTABLE → ${res.owner} (${res.unattributable.length}):`);
  if (!res.unattributable.length) L.push('  none');
  for (const u of res.unattributable) L.push(`  ${u.table.padEnd(12)} ${u.id}  ${u.what}`);
  if (res.conflicts.length) {
    L.push('');
    L.push(`Conflicting evidence (${res.conflicts.length}; first rule kept):`);
    for (const c of res.conflicts) L.push(`  ${c.table} ${c.id}: kept ${c.kept.email} (${c.kept.how}); other ${c.other.email} (${c.other.how})`);
  }
  if (res.splits.length) {
    L.push('');
    L.push(`Posts targeting accounts of several people (split into one post per person): ${res.splits.length}`);
    for (const s of res.splits) L.push(`  group ${s.group}: ${s.owners.join(', ')}`);
  }
  L.push('');
  L.push('Platform-app credentials and timezone/posting slots: copied to every workspace.');
  return `${L.join('\n')}\n`;
}

/** Apply: move rows out of the legacy workspace (one transaction). `raw` is a node:sqlite handle at v6. */
export function applyAttribution(raw, res) {
  const now = Date.now();
  const get = (sql, ...p) => raw.prepare(sql).get(...p);
  const run = (sql, ...p) => raw.prepare(sql).run(...p);
  const local = (e) => e.split('@')[0];
  raw.exec('BEGIN IMMEDIATE');
  try {
    // users / workspaces: the owner claims the legacy workspace, everybody else gets (or keeps) their own.
    const wsOf = {};
    for (const email of res.emails) {
      const u = get('SELECT workspace_id FROM users WHERE email = ?', email);
      if (email === res.owner) {
        if (u && u.workspace_id !== LEGACY) throw new Error(`${email} already owns workspace ${u.workspace_id}; refusing to re-home the legacy data.`);
        if (!u) run('INSERT INTO users(id, email, workspace_id, created_at) VALUES(?,?,?,?)', randomUUID(), email, LEGACY, now);
        run('UPDATE workspaces SET name = ? WHERE id = ?', local(email), LEGACY);
        wsOf[email] = LEGACY;
      } else if (u) wsOf[email] = u.workspace_id;
      else {
        const id = randomUUID();
        run('INSERT INTO workspaces(id, name, created_at) VALUES(?,?,?)', id, local(email), now);
        run('INSERT INTO users(id, email, workspace_id, created_at) VALUES(?,?,?,?)', randomUUID(), email, id, now);
        wsOf[email] = id;
      }
    }
    const moved = {};
    const legacy = `(workspace_id = '${LEGACY}' OR workspace_id IS NULL)`;
    // Groups split across people: clone the group for every extra person.
    const extraGroup = new Map(); // `${group}|${email}` -> new group id
    for (const s of res.splits) {
      const g = get(`SELECT * FROM groups WHERE id = ? AND ${legacy}`, s.group);
      if (!g) continue;
      const keep = res.assignment.groups.get(s.group);
      for (const email of s.owners) {
        if (email === keep) continue;
        const nid = randomUUID();
        run('INSERT INTO groups(id, content, media, publish_at, created_at, updated_at, created_by, approval_note, workspace_id) VALUES(?,?,?,?,?,?,?,?,?)', nid, g.content, g.media, g.publish_at, g.created_at, g.updated_at, g.created_by, g.approval_note, wsOf[email]);
        extraGroup.set(`${s.group}|${email}`, nid);
      }
    }
    for (const t of ['integrations', 'api_keys', 'webhooks', 'groups', 'posts', 'media', 'uploads', 'audit_log']) {
      moved[t] = 0;
      for (const [id, email] of res.assignment[t]) {
        const ws = wsOf[email];
        if (ws === LEGACY) continue;
        moved[t] += Number(run(`UPDATE ${t} SET workspace_id = ? WHERE id = ? AND ${legacy}`, ws, t === 'audit_log' ? Number(id) : id).changes);
      }
    }
    for (const [key, nid] of extraGroup) {
      const [gid, email] = key.split('|');
      for (const [pid, e] of res.assignment.posts) if (e === email) run('UPDATE posts SET group_id = ? WHERE id = ? AND group_id = ?', nid, pid, gid);
    }
    // Analytics rows follow their account.
    moved.remote_posts = Number(run(`UPDATE remote_posts SET workspace_id = (SELECT workspace_id FROM integrations i WHERE i.id = remote_posts.integration_id) WHERE ${legacy}`).changes);
    // Instance settings copied to every workspace that has none yet.
    const src = raw.prepare(`SELECT key, value FROM workspace_settings WHERE workspace_id = '${LEGACY}' AND (key IN ('timezone','posting_slots') OR key LIKE 'platform_app.%')`).all();
    let copied = 0;
    for (const ws of new Set(Object.values(wsOf))) {
      if (ws === LEGACY) continue;
      for (const r of src) copied += Number(run('INSERT INTO workspace_settings(workspace_id, key, value) VALUES(?,?,?) ON CONFLICT(workspace_id, key) DO NOTHING', ws, r.key, r.value).changes);
    }
    // Sanity: every post must sit in its account's workspace, every group in its posts' workspace.
    const bad = get('SELECT COUNT(*) n FROM posts p JOIN integrations i ON i.id = p.integration_id WHERE p.workspace_id IS NOT i.workspace_id').n
      + get('SELECT COUNT(*) n FROM posts p JOIN groups g ON g.id = p.group_id WHERE p.workspace_id IS NOT g.workspace_id').n;
    if (bad) throw new Error(`${bad} post(s) would end up outside their account's/post's workspace; nothing was changed.`);
    run("INSERT INTO settings(key, value) VALUES('attribution_applied_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(now));
    raw.exec('COMMIT');
    return { wsOf, moved, copied };
  } catch (e) {
    raw.exec('ROLLBACK');
    throw e;
  }
}

export async function runAttribution({ dbFile, owner, apply = false }) {
  if (!apply) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const res = computeAttribution(db, owner);
      return { res, text: formatReport(res) };
    } finally { db.close(); }
  }
  const wrapped = openDb(dbFile); // applies pending migrations (0006 creates workspaces)
  const raw = wrapped.raw;
  try {
    const res = computeAttribution(raw, owner);
    const out = applyAttribution(raw, res);
    const lines = [formatReport(res, { apply: true }), 'Workspaces:'];
    for (const [e, w] of Object.entries(out.wsOf)) lines.push(`  ${e.padEnd(30)} ${w}`);
    lines.push(`Moved out of the legacy workspace: ${JSON.stringify(out.moved)}; settings rows copied: ${out.copied}`);
    return { res, out, text: `${lines.join('\n')}\n` };
  } finally { wrapped.close(); }
}
