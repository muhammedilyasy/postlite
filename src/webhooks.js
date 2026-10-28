// Outbound webhooks with HMAC-SHA256 signatures and a retrying delivery queue.
//   Header  X-Postlite-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
//   Header  X-Postlite-Event: <event>,  X-Postlite-Delivery: <delivery id>
// Node delivers right after an event (and every 5 s); Workers delivers from the Cron Trigger.
import { uid, randomToken, hmacHex, safeEqual } from './crypto.js';
import { meteredFetch } from './meter.js';

export const WEBHOOK_EVENTS = ['post.published', 'post.failed', 'post.pending_approval', 'account.needs_reconnect', 'analytics.synced'];

export function sign(secret, timestamp, body) {
  return hmacHex(secret, `${timestamp}.${body}`);
}

/** Verify helper for receivers (exported for docs/tests). Async (WebCrypto). */
export async function verifySignature(secret, header, body, toleranceSec = 300) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) return false;
  return safeEqual(await sign(secret, parts.t, body), parts.v1);
}

/** Instance-wide delivery queue (system work across workspaces: each delivery already belongs to one webhook). */
export function createWebhookDelivery({ db, cipher, log = () => {}, maxAttempts = 6, backoffMs = 30000 }) {
  let timer = null;
  let busy = false;
  const api = {
    /** Deliver due webhooks. Workers passes a budget/limit so a cron tick stays inside its allowance. */
    async deliverDue({ limit = 20, budget = null } = {}) {
      if (busy) return 0;
      busy = true;
      let n = 0;
      try {
        const due = await db.all("SELECT d.*, w.url, w.secret_enc FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.state = 'pending' AND d.next_attempt_at <= ? ORDER BY d.id LIMIT ? /* ws:system */", Date.now(), limit);
        for (const d of due) {
          if (budget && !budget.has({ fetches: 2, queries: 2 })) break;
          n++;
          const t = Math.floor(Date.now() / 1000);
          const secret = await cipher.decrypt(d.secret_enc);
          let status = 0, err = null;
          try {
            const res = await meteredFetch(d.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'user-agent': 'postlite-webhooks/1', 'x-postlite-event': d.event, 'x-postlite-delivery': String(d.id), 'x-postlite-signature': `t=${t},v1=${await sign(secret, t, d.payload)}` },
              body: d.payload,
              signal: AbortSignal.timeout(10000),
            });
            status = res.status;
            await res.arrayBuffer().catch(() => {});
          } catch (e) {
            err = e.cause?.code || e.message;
          }
          const attempts = d.attempts + 1;
          if (status >= 200 && status < 300) {
            await db.run("UPDATE webhook_deliveries SET state='delivered', attempts=?, last_status=?, last_error=NULL, delivered_at=? WHERE id=? /* ws:system */", attempts, status, Date.now(), d.id);
          } else if (attempts >= maxAttempts) {
            await db.run("UPDATE webhook_deliveries SET state='failed', attempts=?, last_status=?, last_error=? WHERE id=? /* ws:system */", attempts, status || null, err || `HTTP ${status}`, d.id);
            log('warn', `webhook delivery ${d.id} failed permanently`);
          } else {
            await db.run('UPDATE webhook_deliveries SET attempts=?, last_status=?, last_error=?, next_attempt_at=? WHERE id=? /* ws:system */', attempts, status || null, err || `HTTP ${status}`, Date.now() + backoffMs * 4 ** (attempts - 1), d.id);
          }
        }
      } finally {
        busy = false;
      }
      return n;
    },
    start(ms = 5000) {
      if (timer) return;
      timer = setInterval(() => api.deliverDue().catch(() => {}), ms);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
  return api;
}

/** Webhooks of ONE workspace: CRUD, delivery log and emit() (queues only this workspace's hooks). */
export function createWebhooks({ db, cipher, ws, delivery, deliverOnEmit = true }) {
  if (!ws) throw new Error('createWebhooks: workspace id required');
  const view = (r) => r && { id: r.id, url: r.url, events: JSON.parse(r.events), active: !!r.active, description: r.description, created_at: r.created_at };
  const row = (id) => db.get('SELECT * FROM webhooks WHERE id = ? AND workspace_id = ?', String(id ?? ''), ws);

  const api = {
    async create({ url, events = WEBHOOK_EVENTS, description = '' }) {
      if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('url must be an http(s) URL');
      const bad = events.filter((e) => !WEBHOOK_EVENTS.includes(e) && e !== '*');
      if (bad.length) throw new Error(`Unknown event(s): ${bad.join(', ')}. Valid: ${WEBHOOK_EVENTS.join(', ')}`);
      const id = uid();
      const secret = `whsec_${randomToken(24)}`;
      await db.run('INSERT INTO webhooks(id, workspace_id, url, secret_enc, events, active, description, created_at) VALUES(?,?,?,?,?,1,?,?)', id, ws, url, await cipher.encrypt(secret), JSON.stringify(events), description, Date.now());
      return { ...view(await row(id)), secret };
    },
    list: async () => (await db.all('SELECT * FROM webhooks WHERE workspace_id = ? ORDER BY created_at DESC', ws)).map(view),
    get: async (id) => view(await row(id)),
    async update(id, { url, events, active, description }) {
      const r = await row(id);
      if (!r) return null;
      if (events) {
        const bad = events.filter((e) => !WEBHOOK_EVENTS.includes(e) && e !== '*');
        if (bad.length) throw new Error(`Unknown event(s): ${bad.join(', ')}`);
      }
      await db.run('UPDATE webhooks SET url=?, events=?, active=?, description=? WHERE id=? AND workspace_id=?', url ?? r.url, events ? JSON.stringify(events) : r.events, active === undefined ? r.active : active ? 1 : 0, description ?? r.description, r.id, ws);
      return view(await row(id));
    },
    async rotateSecret(id) {
      const secret = `whsec_${randomToken(24)}`;
      if (!(await db.run('UPDATE webhooks SET secret_enc=? WHERE id=? AND workspace_id=?', await cipher.encrypt(secret), String(id ?? ''), ws)).changes) return null;
      return { id, secret };
    },
    remove: async (id) => (await db.run('DELETE FROM webhooks WHERE id = ? AND workspace_id = ?', String(id ?? ''), ws)).changes > 0,
    deliveries: (id, limit = 50) => db.all(`SELECT d.id, d.event, d.state, d.attempts, d.last_status, d.last_error, d.created_at, d.delivered_at FROM webhook_deliveries d
      JOIN webhooks w ON w.id = d.webhook_id WHERE d.webhook_id = ? AND w.workspace_id = ? ORDER BY d.id DESC LIMIT ?`, String(id ?? ''), ws, limit),

    /** Queue an event for every subscribed webhook of this workspace (one INSERT … SELECT). */
    async emit(event, data) {
      const payload = JSON.stringify({ id: uid(), event, created_at: new Date().toISOString(), data });
      const t = Date.now();
      const r = await db.run(`INSERT INTO webhook_deliveries(webhook_id, event, payload, state, attempts, next_attempt_at, created_at)
        SELECT w.id, ?, ?, 'pending', 0, ?, ? FROM webhooks w WHERE w.workspace_id = ? AND w.active = 1 AND EXISTS (SELECT 1 FROM json_each(w.events) e WHERE e.value IN (?, '*'))`, event, payload, t, t, ws, event);
      if (r.changes && deliverOnEmit) setTimeout(() => delivery.deliverDue().catch(() => {}), 0);
      return r.changes;
    },
    /** Queue a "ping" for one webhook of this workspace. */
    async ping(id) {
      const w = await row(id);
      if (!w) return null;
      const payload = JSON.stringify({ id: `ping-${Date.now()}`, event: 'ping', created_at: new Date().toISOString(), data: { hello: 'from postlite' } });
      await db.run("INSERT INTO webhook_deliveries(webhook_id, event, payload, state, attempts, next_attempt_at, created_at) SELECT id, 'ping', ?, 'pending', 0, ?, ? FROM webhooks WHERE id = ? AND workspace_id = ?", payload, Date.now(), Date.now(), w.id, ws);
      return w;
    },
    // Instance-wide delivery loop (pass-through).
    deliverDue: (o) => delivery.deliverDue(o),
    start: (ms) => delivery.start(ms),
    stop: () => delivery.stop(),
  };
  return api;
}
