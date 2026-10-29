// Alerts: in-app notifications per workspace and per user, per-user preferences, batched + deduped email
// and a daily digest. A "user" is the signed-in email (Cloudflare Access) of this workspace; '' is the
// password-mode administrator (emails go to ADMIN_EMAIL). Events come from the scheduler (failed /
// published targets), token health (needs_reconnect) and the digest loop (Node interval / Workers cron).
import { uid } from './crypto.js';
import { HttpError } from './errors.js';
import { normEmail } from './tenant.js';
import { zonedParts } from './shared/time.js';
import { renderEmail } from './email.js';

export const ALERT_KINDS = ['post_failed', 'post_published', 'account_reconnect', 'digest'];
export const DEFAULT_PREFS = { post_failed: true, post_published: false, account_reconnect: true, digest: false, digest_time: '09:00', email: true };
const MAX_EMAIL_ATTEMPTS = 3;
const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const PROVIDER = { facebook: 'Facebook', instagram: 'Instagram', 'instagram-standalone': 'Instagram', youtube: 'YouTube', x: 'X', linkedin: 'LinkedIn', 'linkedin-page': 'LinkedIn' };

export function createNotifications({ db, ws, cfg, settings, mailer, kick = () => {}, log = () => {} }) {
  if (!ws) throw new Error('createNotifications: workspace id required');
  const batchMs = () => cfg.notify?.batchMs ?? 60000;

  async function recipients() {
    const rows = await db.all('SELECT email FROM users WHERE workspace_id = ? ORDER BY created_at', ws);
    return rows.length ? rows.map((r) => normEmail(r.email)) : [''];
  }
  /** Which user a credential acts for: the session email; API keys / password sessions → the workspace's first user. */
  async function userFor(principal) {
    if (principal?.email) return normEmail(principal.email);
    return (await recipients())[0];
  }
  const addressFor = (user) => user || cfg.email?.adminEmail || null;

  async function prefsRow(user) { return db.get('SELECT * FROM notification_prefs WHERE workspace_id = ? AND user_email = ?', ws, user); }
  async function getPrefs(user) { return { ...DEFAULT_PREFS, ...parse((await prefsRow(user))?.prefs) }; }
  async function updatePrefs(user, patch = {}) {
    const cur = await getPrefs(user);
    for (const k of [...ALERT_KINDS, 'email']) if (patch[k] !== undefined) {
      if (typeof patch[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false.`);
      cur[k] = patch[k];
    }
    if (patch.digest_time !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch.digest_time))) throw new HttpError(400, 'digest_time must be "HH:MM" (24h, workspace timezone).');
      cur.digest_time = patch.digest_time;
    }
    await db.run(`INSERT INTO notification_prefs(workspace_id, user_email, prefs, digest, updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(workspace_id, user_email) DO UPDATE SET prefs = excluded.prefs, digest = excluded.digest, updated_at = excluded.updated_at`,
    ws, user, JSON.stringify(cur), cur.digest ? 1 : 0, Date.now());
    return cur;
  }

  function emailStatus(user, prefs) {
    const st = mailer.status();
    const to = addressFor(user);
    return { ...st, to, enabled: !!prefs?.email, can_send: st.configured && !!to,
      reason: !st.configured ? 'Email is not set up on this server; alerts stay in postlite.' : !to ? 'No email address for this sign-in (set ADMIN_EMAIL in password mode).' : null };
  }

  /** Create one notification per recipient whose preferences want it (deduped by key). */
  async function notify({ kind, title, body = '', link = null, key, users = null, force = false }) {
    let pending = 0, created = 0;
    const st = mailer.status();
    for (const user of users || (await recipients())) {
      const p = await getPrefs(user);
      if (!force && !p[kind]) continue;
      const email = st.configured && p.email && addressFor(user) ? 'pending' : null;
      const r = await db.run(`INSERT INTO notifications(id, workspace_id, user_email, kind, title, body, link, dedupe_key, email_state, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id, user_email, dedupe_key) DO NOTHING`, uid(), ws, user, kind, clip(title, 200), String(body || '').slice(0, 4000), link, String(key).slice(0, 300), email, Date.now());
      if (r.changes) { created++; if (email) pending++; }
    }
    if (pending) kick();
    return created;
  }

  const view = (r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, read: !!r.read_at, read_at: r.read_at, email: r.email_state, email_error: r.email_error || null, created_at: r.created_at });
  async function list(user, { limit = 20, unread_only = false, before = null } = {}) {
    const rows = limit > 0 ? await db.all(`SELECT * FROM notifications WHERE workspace_id = ? AND user_email = ?${unread_only ? ' AND read_at IS NULL' : ''}${before ? ' AND created_at < ?' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ws, user, ...(before ? [Number(before)] : []), Math.min(Number(limit) || 20, 200)) : [];
    const unread = (await db.get('SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND user_email = ? AND read_at IS NULL', ws, user)).n;
    return { notifications: rows.map(view), unread };
  }
  async function markRead(user, { ids = null, all = false } = {}) {
    const now = Date.now();
    if (all) return (await db.run('UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND user_email = ? AND read_at IS NULL', now, ws, user)).changes;
    const list = (ids || []).map(String).slice(0, 200);
    if (!list.length) throw new HttpError(400, 'Pass ids (notification ids) or all: true.');
    return (await db.run(`UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND user_email = ? AND read_at IS NULL AND id IN (${list.map(() => '?').join(',')})`, now, ws, user, ...list)).changes;
  }

  async function whenFmt() {
    const s = await settings.get();
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: s.timezone, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: s.time_format === '12h', timeZoneName: 'short' });
    return (ms) => f.format(new Date(ms));
  }

  /** Send this user's pending emails as ONE message (claimed atomically, so a row is emailed at most once). */
  async function flushEmail(user, { now = Date.now(), force = false } = {}) {
    const to = addressFor(user);
    if (!mailer.status().configured || !to) {
      await db.run("UPDATE notifications SET email_state = NULL, email_error = 'email not configured' WHERE workspace_id = ? AND user_email = ? AND email_state = 'pending'", ws, user);
      return 0;
    }
    const claimed = (await db.run(`UPDATE notifications SET email_state = 'sending', email_attempts = email_attempts + 1, emailed_at = ?
      WHERE id IN (SELECT id FROM notifications WHERE workspace_id = ? AND user_email = ? AND (
        (email_state = 'pending' AND created_at <= ?) OR (email_state = 'sending' AND emailed_at < ?)) ORDER BY created_at LIMIT 50) AND workspace_id = ? RETURNING *`,
    now, ws, user, force ? now : now - batchMs(), now - 15 * 60000, ws)).rows || [];
    if (!claimed.length) return 0;
    claimed.sort((a, b) => (a.kind === 'digest') - (b.kind === 'digest') || a.created_at - b.created_at);
    const ids = claimed.map((r) => r.id);
    const inList = ids.map(() => '?').join(',');
    try {
      const msg = renderEmail(claimed, { publicUrl: cfg.publicUrl, when: await whenFmt() });
      await mailer.send({ to, ...msg });
      await db.run(`UPDATE notifications SET email_state = 'sent', email_error = NULL, emailed_at = ? WHERE workspace_id = ? AND id IN (${inList})`, Date.now(), ws, ...ids);
      return claimed.length;
    } catch (e) {
      log('warn', `alert email to ${to}: ${e.message}`);
      await db.run(`UPDATE notifications SET email_state = CASE WHEN email_attempts >= ? THEN 'failed' ELSE 'pending' END, email_error = ? WHERE workspace_id = ? AND id IN (${inList})`,
        MAX_EMAIL_ATTEMPTS, String(e.message).slice(0, 300), ws, ...ids);
      return 0;
    }
  }

  async function sendTest(user) {
    const st = emailStatus(user, await getPrefs(user));
    if (!st.configured) throw new HttpError(409, 'Email is not set up on this server. Add SMTP_* or RESEND_API_KEY + EMAIL_FROM to the server configuration, then restart.');
    if (!st.to) throw new HttpError(409, st.reason);
    const row = await prefsRow(user);
    if (row?.last_test_at && Date.now() - row.last_test_at < 20000) throw new HttpError(429, 'A test email was just sent. Try again in a few seconds.');
    if (!row) await updatePrefs(user, {});
    await db.run('UPDATE notification_prefs SET last_test_at = ? WHERE workspace_id = ? AND user_email = ?', Date.now(), ws, user);
    const item = { kind: 'test', title: 'Test email from postlite', body: `Email alerts work. They are sent to ${st.to} through ${st.transport_label}.`, link: '#/settings/notifications', created_at: Date.now() };
    try {
      const r = await mailer.send({ to: st.to, ...renderEmail([item], { publicUrl: cfg.publicUrl, when: await whenFmt() }) });
      return { sent: true, to: st.to, transport: r.transport };
    } catch (e) {
      throw new HttpError(502, `The test email could not be sent: ${e.message}`);
    }
  }

  // ---- events ----
  async function postFailed(p) {
    if (!p) return 0;
    const row = await db.get('SELECT updated_at, content_override FROM posts WHERE id = ? AND workspace_id = ?', p.target_id, ws);
    const g = await db.get('SELECT content FROM groups WHERE id = ? AND workspace_id = ?', p.post_id, ws);
    const caption = clip(row?.content_override || g?.content, 90);
    return notify({ kind: 'post_failed', key: `post_failed:${p.target_id}:${row?.updated_at || ''}`, link: `#/posts/${p.post_id}`,
      title: `Post failed on ${p.account_name || PROVIDER[p.provider] || 'an account'}`,
      body: [caption ? `“${caption}”` : null, clip(p.error, 400) || null].filter(Boolean).join('\n') });
  }
  async function postPublished(p) {
    if (!p) return 0;
    const g = await db.get('SELECT content FROM groups WHERE id = ? AND workspace_id = ?', p.post_id, ws);
    const caption = clip(g?.content, 90);
    return notify({ kind: 'post_published', key: `post_published:${p.target_id}`, link: `#/posts/${p.post_id}`,
      title: `Published on ${p.account_name || PROVIDER[p.provider] || 'an account'}`, body: [caption ? `“${caption}”` : null, p.published_url || null].filter(Boolean).join('\n') });
  }
  async function accountReconnect(d) {
    const day = new Date().toISOString().slice(0, 10);
    return notify({ kind: 'account_reconnect', key: `reconnect:${d.account_id}:${day}`, link: `#/accounts?focus=${d.account_id}`,
      title: `${d.name || 'An account'} (${PROVIDER[d.provider] || d.provider}) needs reconnecting`,
      body: `Scheduled posts for it will fail until you reconnect it in Accounts.${d.message ? `\n${clip(d.message, 300)}` : ''}` });
  }

  /** Daily digest for one user, once per local day after digest_time. Returns true when one was created. */
  async function digestIfDue(user, { now = Date.now() } = {}) {
    const p = await getPrefs(user);
    if (!p.digest) return false;
    const { timezone } = await settings.get();
    const z = zonedParts(now, timezone);
    const today = `${z.year}-${pad(z.month)}-${pad(z.day)}`;
    if (`${pad(z.hour)}:${pad(z.minute)}` < p.digest_time) return false;
    const claim = await db.run('UPDATE notification_prefs SET last_digest_day = ? WHERE workspace_id = ? AND user_email = ? AND (last_digest_day IS NULL OR last_digest_day <> ?)', today, ws, user, today);
    if (!claim.changes) return false;
    const since = now - DAY;
    const pub = await db.all(`SELECT p.group_id, i.name FROM posts p JOIN integrations i ON i.id = p.integration_id AND i.workspace_id = p.workspace_id
      WHERE p.workspace_id = ? AND p.status = 'published' AND p.published_at >= ? ORDER BY p.published_at DESC LIMIT 50`, ws, since);
    const failed = await db.all(`SELECT p.group_id, p.error, i.name FROM posts p JOIN integrations i ON i.id = p.integration_id AND i.workspace_id = p.workspace_id
      WHERE p.workspace_id = ? AND p.status = 'failed' AND p.updated_at >= ? ORDER BY p.updated_at DESC LIMIT 20`, ws, since);
    const reconnect = await db.all("SELECT name, provider FROM integrations WHERE workspace_id = ? AND status = 'needs_reconnect' ORDER BY name", ws);
    const upcoming = (await db.get("SELECT COUNT(*) AS n FROM posts WHERE workspace_id = ? AND status = 'scheduled' AND publish_at > ? AND publish_at <= ?", ws, now, now + DAY)).n;
    const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
    const lines = [
      `Last 24 hours: ${n(pub.length, 'post')} published, ${n(failed.length, 'post')} failed.`,
      ...failed.slice(0, 10).map((f) => `• Failed on ${f.name}: ${clip(f.error, 140) || 'unknown error'}`),
      reconnect.length ? `Needs reconnecting: ${reconnect.map((a) => `${a.name} (${PROVIDER[a.provider] || a.provider})`).join(', ')}.` : null,
      `Next 24 hours: ${n(upcoming, 'post')} scheduled.`,
    ].filter(Boolean);
    await notify({ kind: 'digest', users: [user], key: `digest:${today}`, link: failed.length ? '#/posts?status=failed' : '#/posts', title: `Daily digest for ${today}`, body: lines.join('\n') });
    if (mailer.status().configured && p.email) await flushEmail(user, { now, force: true });
    return true;
  }

  return { recipients, userFor, getPrefs, updatePrefs, emailStatus, notify, list, markRead, flushEmail, sendTest, postFailed, postPublished, accountReconnect, digestIfDue };
}
