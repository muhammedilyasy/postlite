// "Delete my workspace data" (Settings → Danger zone / delete_workspace_data). Removes everything one
// workspace owns: accounts and their tokens, posts and their history, media files (originals, posters,
// thumbnails, unfinished uploads), API keys, webhooks, brands, analytics, audit log and workspace settings.
// It keeps the workspace row and the user's email binding, so the person can still sign in (their
// Cloudflare Access login is never touched), and it never reads or writes another workspace's rows:
// every statement filters by workspace_id or by ids selected through it.
import { HttpError } from './errors.js';
import { normEmail } from './tenant.js';

/**
 * Tables with a workspace_id column, children first. Feature migrations add their tables here
 * (tests check that every tenant table is listed).
 */
export const WIPE_TABLES = ['brand_channels', 'brands', 'remote_posts', 'posts', 'groups', 'media', 'uploads', 'oauth_states', 'api_keys', 'webhooks', 'integrations', 'audit_log', 'workspace_settings'];

// Child rows reached through a parent of this workspace (no workspace_id column of their own).
const CHILDREN = [
  ['jobs', 'post_id IN (SELECT id FROM posts WHERE workspace_id = ?)'],
  ['post_events', 'post_id IN (SELECT id FROM posts WHERE workspace_id = ?)'],
  ['webhook_deliveries', 'webhook_id IN (SELECT id FROM webhooks WHERE workspace_id = ?)'],
  ['account_metrics', 'integration_id IN (SELECT id FROM integrations WHERE workspace_id = ?)'],
  ['post_metrics', 'integration_id IN (SELECT id FROM integrations WHERE workspace_id = ?)'],
  ['analytics_status', 'integration_id IN (SELECT id FROM integrations WHERE workspace_id = ?)'],
  ['analytics_runs', 'integration_id IN (SELECT id FROM integrations WHERE workspace_id = ?)'],
];

export function createWipe({ db, storage, ws, workspaces }) {
  if (!ws) throw new Error('createWipe: workspace id required');

  /** What the person must type: the email(s) bound to this workspace, else the workspace name. */
  async function confirmation() {
    const emails = (await db.all('SELECT email FROM users WHERE workspace_id = ? ORDER BY created_at', ws)).map((r) => r.email);
    const w = await workspaces.get(ws);
    return { emails, name: w?.name || ws, expected: emails[0] || w?.name || ws };
  }

  /** Row counts per table (what would be deleted). */
  async function preview() {
    const out = {};
    for (const t of WIPE_TABLES) out[t] = (await db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE workspace_id = ?`, ws)).n;
    return out;
  }

  /**
   * Delete everything. `confirm` must equal the signed-in email (sessions), one of the workspace's emails,
   * or — when no email is bound (password mode) — the workspace name. Case-insensitive.
   */
  async function wipe({ confirm, principal = null }) {
    const c = await confirmation();
    const typed = normEmail(confirm);
    const ok = principal?.email ? typed === normEmail(principal.email)
      : c.emails.length ? c.emails.some((e) => e === typed)
        : typed === String(c.name).trim().toLowerCase();
    if (!ok) throw new HttpError(400, `Type ${principal?.email ? 'your email' : c.emails.length ? 'the workspace owner\'s email' : 'the workspace name'} exactly to confirm (expected "${principal?.email || c.expected}").`, { expected: principal?.email || c.expected });
    const counts = await preview();
    // Files first (best effort; a missing file never blocks the wipe).
    const media = await db.all('SELECT id, filename, storage_key, poster, purged_at FROM media WHERE workspace_id = ?', ws);
    let files = 0;
    for (const m of media) {
      if (!m.purged_at) { await storage.delete(m.storage_key || m.filename).then(() => files++, () => {}); }
      if (m.poster) await storage.delete(m.poster).then(() => files++, () => {});
    }
    const ups = await db.all("SELECT storage_key, multipart_id FROM uploads WHERE workspace_id = ? AND state = 'open'", ws);
    for (const u of ups) await Promise.resolve().then(() => storage.mpAbort(u.storage_key, u.multipart_id)).catch(() => {});
    await db.batch([
      ...CHILDREN.map(([t, where]) => [`DELETE FROM ${t} WHERE ${where} /* ws:checked */`, ws]),
      ...WIPE_TABLES.map((t) => [`DELETE FROM ${t} WHERE workspace_id = ?`, ws]),
    ]);
    return { deleted: counts, files_deleted: files, kept: ['your sign-in (Cloudflare Access / password)', 'the empty workspace'] };
  }

  return { confirmation, preview, wipe };
}
