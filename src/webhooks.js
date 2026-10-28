// Outbound webhooks with HMAC-SHA256 signatures and retrying delivery queue.
//   Header  X-Postlite-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
//   Header  X-Postlite-Event: <event>,  X-Postlite-Delivery: <delivery id>
import crypto from 'node:crypto';
import { uid, randomToken } from './crypto.js';

export const WEBHOOK_EVENTS = ['post.published', 'post.failed', 'post.pending_approval', 'account.needs_reconnect', 'analytics.synced'];

export function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Verify helper for receivers (exported for docs/tests). */
export function verifySignature(secret, header, body, toleranceSec = 300) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) return false;
  const expected = sign(secret, parts.t, body);
  return expected.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

export function createWebhooks({ db, cipher, log = () => {}, maxAttempts = 6, backoffMs = 30000 }) {
  let timer = null;
  let busy = false;
  const view = (r) => r && { id: r.id, url: r.url, events: JSON.parse(r.events), active: !!r.active, description: r.description, created_at: r.created_at };

  const api = {
    create({ url, events = WEBHOOK_EVENTS, description = '' }) {
      if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('url must be an http(s) URL');
      const bad = events.filter((e) => !WEBHOOK_EVENTS.includes(e) && e !== '*');
      if (bad.length) throw new Error(`Unknown event(s): ${bad.join(', ')}. Valid: ${WEBHOOK_EVENTS.join(', ')}`);
      const id = uid();
      const secret = `whsec_${randomToken(24)}`;
      db.run('INSERT INTO webhooks(id, url, secret_enc, events, active, description, created_at) VALUES(?,?,?,?,1,?,?)', id, url, cipher.encrypt(secret), JSON.stringify(events), description, Date.now());
      return { ...view(db.get('SELECT * FROM webhooks WHERE id = ?', id)), secret };
    },
    list: () => db.all('SELECT * FROM webhooks ORDER BY created_at DESC').map(view),
    get: (id) => view(db.get('SELECT * FROM webhooks WHERE id = ?', id)),
    update(id, { url, events, active, description }) {
      const r = db.get('SELECT * FROM webhooks WHERE id = ?', id);
      if (!r) return null;
      if (events) {
        const bad = events.filter((e) => !WEBHOOK_EVENTS.includes(e) && e !== '*');
        if (bad.length) throw new Error(`Unknown event(s): ${bad.join(', ')}`);
      }
      db.run('UPDATE webhooks SET url=?, events=?, active=?, description=? WHERE id=?', url ?? r.url, events ? JSON.stringify(events) : r.events, active === undefined ? r.active : active ? 1 : 0, description ?? r.description, id);
      return view(db.get('SELECT * FROM webhooks WHERE id = ?', id));
    },
    rotateSecret(id) {
      const secret = `whsec_${randomToken(24)}`;
      if (!db.run('UPDATE webhooks SET secret_enc=? WHERE id=?', cipher.encrypt(secret), id).changes) return null;
      return { id, secret };
    },
    remove: (id) => db.run('DELETE FROM webhooks WHERE id = ?', id).changes > 0,
    deliveries: (id, limit = 50) => db.all('SELECT id, event, state, attempts, last_status, last_error, created_at, delivered_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?', id, limit),

    /** Queue an event for every subscribed webhook. */
    emit(event, data) {
      const hooks = db.all('SELECT * FROM webhooks WHERE active = 1');
      const payload = JSON.stringify({ id: uid(), event, created_at: new Date().toISOString(), data });
      let n = 0;
      for (const h of hooks) {
        const ev = JSON.parse(h.events);
        if (!ev.includes(event) && !ev.includes('*')) continue;
        db.run('INSERT INTO webhook_deliveries(webhook_id, event, payload, state, attempts, next_attempt_at, created_at) VALUES(?,?,?,?,0,?,?)', h.id, event, payload, 'pending', Date.now(), Date.now());
        n++;
      }
      if (n) setImmediate(() => api.deliverDue().catch(() => {}));
      return n;
    },

    async deliverDue() {
      if (busy) return;
      busy = true;
      try {
        const due = db.all("SELECT d.*, w.url, w.secret_enc FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.state = 'pending' AND d.next_attempt_at <= ? ORDER BY d.id LIMIT 20", Date.now());
        for (const d of due) {
          const t = Math.floor(Date.now() / 1000);
          const secret = cipher.decrypt(d.secret_enc);
          let status = 0, err = null;
          try {
            const res = await fetch(d.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'user-agent': 'postlite-webhooks/1', 'x-postlite-event': d.event, 'x-postlite-delivery': String(d.id), 'x-postlite-signature': `t=${t},v1=${sign(secret, t, d.payload)}` },
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
            db.run("UPDATE webhook_deliveries SET state='delivered', attempts=?, last_status=?, last_error=NULL, delivered_at=? WHERE id=?", attempts, status, Date.now(), d.id);
          } else if (attempts >= maxAttempts) {
            db.run("UPDATE webhook_deliveries SET state='failed', attempts=?, last_status=?, last_error=? WHERE id=?", attempts, status || null, err || `HTTP ${status}`, d.id);
            log('warn', `webhook delivery ${d.id} failed permanently`);
          } else {
            db.run('UPDATE webhook_deliveries SET attempts=?, last_status=?, last_error=?, next_attempt_at=? WHERE id=?', attempts, status || null, err || `HTTP ${status}`, Date.now() + backoffMs * 4 ** (attempts - 1), d.id);
          }
        }
      } finally {
        busy = false;
      }
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
