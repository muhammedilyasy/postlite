// Wires all services together on top of runtime adapters. Portable: the Node adapter
// (src/node/core.js) passes node:sqlite + local disk; the Workers adapter (src/workers/index.js)
// passes D1 + R2. Nothing in here touches the filesystem, process or node:* modules.
import { makeCipher } from './crypto.js';
import { createMedia } from './media.js';
import { createIntegrations } from './integrations.js';
import { createPosts } from './posts.js';
import { createScheduler } from './scheduler.js';
import { createAnalytics } from './analytics.js';
import { createApiKeys, createAudit } from './apikeys.js';
import { createWebhooks } from './webhooks.js';
import { isValidTimezone, WEEKDAYS } from './shared/time.js';
import { createOAuth } from './oauth.js';
import { createApps } from './apps.js';

export function consoleLogger(level = 'info') {
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  return (lvl, msg) => {
    if ((order[lvl] || 20) < (order[level] || 20)) return;
    console.log(`${lvl.toUpperCase()} ${msg}`);
  };
}

/**
 * @param {{cfg:object, db:object, storage:object, runtime?:object, log?:Function}} deps
 *   runtime: { platform, version, hooks?, resolveHost?, passwords:{hash, verify}, uptime?() }
 */
export function createCore({ cfg, db, storage, runtime = {}, log = consoleLogger() }) {
  const workers = cfg.platform === 'workers';
  const cipher = makeCipher(cfg.tokenEncKey);
  // Installs live getters for cfg.meta / cfg.instagram / cfg.google (DB overrides env; refreshed by apps.sync()).
  const apps = createApps({ db, cfg, cipher });
  const webhooks = createWebhooks({ db, cipher, log, deliverOnEmit: !workers, ...(cfg.webhooks || {}) });
  const media = createMedia({ db, cfg, storage, hooks: runtime.hooks || {} });
  const integrations = createIntegrations({ db, cfg, cipher, log, onNeedsReconnect: (d) => webhooks.emit('account.needs_reconnect', d) });
  const posts = createPosts({ db, media, integrations });
  const postPayload = async (postId) => {
    const p = await posts.get(postId);
    return p && { post_id: p.group_id, target_id: p.id, account_id: p.integration_id, provider: p.provider, account_name: p.account_name, status: p.status, published_url: p.published_url, external_id: p.external_id, error: p.error, warning: p.warning, publish_at: p.publish_at };
  };
  const scheduler = createScheduler({
    db, cfg, media, integrations, posts, log, workerTag: workers ? 'cf' : 'w',
    onPublished: async (id) => webhooks.emit('post.published', await postPayload(id)),
    onFailed: async (id) => webhooks.emit('post.failed', await postPayload(id)),
  });
  const analytics = createAnalytics({ db, cfg, integrations, log, onSynced: (r) => webhooks.emit('analytics.synced', { accounts: r }) });
  const apiKeys = createApiKeys({ db });
  const audit = createAudit({ db });

  const DEFAULT_SLOTS = { mon: ['09:00', '18:00'], tue: ['09:00', '18:00'], wed: ['09:00', '18:00'], thu: ['09:00', '18:00'], fri: ['09:00', '18:00'], sat: ['11:00'], sun: ['11:00'] };
  const settings = {
    async get() {
      const rows = await db.all("SELECT key, value FROM settings WHERE key IN ('timezone','posting_slots')");
      const by = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      return {
        timezone: by.timezone || cfg.defaultTimezone,
        posting_slots: JSON.parse(by.posting_slots || 'null') || DEFAULT_SLOTS,
        public_url: cfg.publicUrl,
        analytics_interval_hours: cfg.analytics.intervalHours,
        graph_api_version: cfg.graphVersion,
        runtime: cfg.platform,
      };
    },
    async update({ timezone, posting_slots } = {}) {
      if (timezone !== undefined) {
        if (!isValidTimezone(timezone)) throw new Error(`Unknown timezone "${timezone}". Use an IANA name like "Asia/Kolkata" or "Europe/Berlin".`);
        await db.setSetting('timezone', timezone);
      }
      if (posting_slots !== undefined) {
        const clean = {};
        for (const [d, times] of Object.entries(posting_slots || {})) {
          if (!WEEKDAYS.includes(d)) throw new Error(`Unknown weekday "${d}". Use: ${WEEKDAYS.join(', ')}`);
          if (!Array.isArray(times)) throw new Error(`posting_slots.${d} must be an array of "HH:MM" strings`);
          for (const t of times) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`Invalid time "${t}" for ${d}; use 24h "HH:MM"`);
          clean[d] = [...new Set(times)].sort();
        }
        await db.setSetting('posting_slots', JSON.stringify(clean));
      }
      return settings.get();
    },
  };

  /** Hash/verify the admin password with the runtime's scheme (scrypt on Node, PBKDF2 portable). */
  const passwords = runtime.passwords;

  const core = {
    cfg, db, storage, runtime, cipher, log, apps, media, integrations, posts, scheduler, analytics, apiKeys, audit, webhooks, settings, passwords,
    /** Per-request / per-tick preparation: refresh cached platform-app credentials. */
    async prepare() { await apps.sync(); },

    /** Housekeeping: token refresh/health, audit pruning, expired upload sessions. */
    async maintenance({ budget = null } = {}) {
      await integrations.maintain({ budget }).catch((e) => log('warn', `maintenance: ${e.message}`));
      await audit.prune();
      await media.cleanupUploads().catch(() => {});
    },

    /**
     * One Cloudflare Cron Trigger invocation: scheduler steps, then webhooks, analytics and (daily)
     * maintenance, each only while the invocation budget lasts.
     */
    async cron({ budget }) {
      await apps.sync({ maxAgeMs: 0 });
      const out = { scheduler: await scheduler.runOnce({ budget }) };
      out.webhooks = await webhooks.deliverDue({ limit: cfg.budget.webhooks, budget });
      if (budget.has({ fetches: 15, queries: 15 })) out.analytics = Object.keys(await analytics.syncDue({ budget })).length;
      const last = Number((await db.getSetting('maintenance_at', '0')) || 0);
      if (Date.now() - last > 12 * 3600000 && budget.has({ fetches: 10, queries: 15 })) {
        await db.setSetting('maintenance_at', String(Date.now()));
        await core.maintenance({ budget });
        out.maintenance = true;
      }
      return out;
    },

    startBackground() {
      return (async () => {
        await apps.sync({ maxAgeMs: 0 });
        const missed = await scheduler.boot();
        if (missed) log('warn', `${missed} post(s) missed their schedule while the server was down`);
        scheduler.start();
        analytics.start();
        webhooks.start();
        const maint = setInterval(() => { core.maintenance().catch(() => {}); }, 12 * 3600000);
        maint.unref?.();
        core._maint = maint;
      })();
    },
    async stop() {
      clearInterval(core._maint);
      analytics.stop();
      webhooks.stop();
      await scheduler.stop();
      db.close();
    },
  };
  core.oauth = createOAuth(core);
  return core;
}
