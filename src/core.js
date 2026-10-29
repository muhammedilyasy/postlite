// Wires all services together on top of runtime adapters. Portable: the Node adapter
// (src/node/core.js) passes node:sqlite + local disk; the Workers adapter (src/workers/index.js)
// passes D1 + R2. Nothing in here touches the filesystem, process or node:* modules.
//
// Multi-tenancy: the root core only holds instance-wide machinery (scheduler queue, webhook delivery,
// analytics loop, users/workspaces, API-key authentication). All tenant data is reached through
// core.scope(workspaceId), which returns that workspace's services; every one of them filters by
// workspace_id, and the DB is wrapped by the tenant guard (src/tenant.js).
import { makeCipher } from './crypto.js';
import { createMedia } from './media.js';
import { createIntegrations } from './integrations.js';
import { createPosts } from './posts.js';
import { createScheduler } from './scheduler.js';
import { createAnalytics, createAnalyticsLoop } from './analytics.js';
import { createApiKeys, createAudit } from './apikeys.js';
import { createWebhooks, createWebhookDelivery } from './webhooks.js';
import { isValidTimezone, WEEKDAYS } from './shared/time.js';
import { createOAuth } from './oauth.js';
import { createApps } from './apps.js';
import { guardDb, createWorkspaces, wsSettings, LEGACY_WORKSPACE } from './tenant.js';
import { createRetention } from './retention.js';
import { createBrands } from './brands.js';
import { createWipe } from './wipe.js';
import { createLibrary } from './library.js';
import { createTags } from './tags.js';
import { createSignatures, createTemplates } from './snippets.js';

export function consoleLogger(level = 'info') {
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  return (lvl, msg) => {
    if ((order[lvl] || 20) < (order[level] || 20)) return;
    console.log(`${lvl.toUpperCase()} ${msg}`);
  };
}

const DEFAULT_SLOTS = { mon: ['09:00', '18:00'], tue: ['09:00', '18:00'], wed: ['09:00', '18:00'], thu: ['09:00', '18:00'], fri: ['09:00', '18:00'], sat: ['11:00'], sun: ['11:00'] };

/**
 * @param {{cfg:object, db:object, storage:object, runtime?:object, log?:Function}} deps
 *   runtime: { platform, version, hooks?, resolveHost?, passwords:{hash, verify}, uptime?() }
 */
export function createCore({ cfg, db: rawDb, storage, runtime = {}, log = consoleLogger() }) {
  const workers = cfg.platform === 'workers';
  const cipher = makeCipher(cfg.tokenEncKey);
  const db = guardDb(rawDb, { log });
  const workspaces = createWorkspaces({ db });
  const delivery = createWebhookDelivery({ db, cipher, log, ...(cfg.webhooks || {}) });
  const rootMedia = createMedia({ db, cfg, storage, hooks: runtime.hooks || {} }); // token-authorized paths only
  const apiKeys = createApiKeys({ db }); // authenticate() + rateLimit() only
  const scopes = new Map();

  /** Services of one workspace. Cached per process/isolate. */
  function scope(ws) {
    if (!ws || typeof ws !== 'string') throw new Error('Workspace required: every tenant operation must run inside a workspace scope.');
    let sc = scopes.get(ws);
    if (sc) return sc;
    // Per-workspace config: inherits the instance config; meta/instagram/google become getters for this
    // workspace's platform apps (instance .env as fallback).
    const wcfg = Object.create(cfg);
    const apps = createApps({ db, cfg: wcfg, cipher, ws, envCfg: cfg });
    const webhooks = createWebhooks({ db, cipher, ws, delivery, deliverOnEmit: !workers });
    const media = createMedia({ db, cfg: wcfg, storage, hooks: runtime.hooks || {}, ws });
    const integrations = createIntegrations({ db, cfg: wcfg, cipher, ws, log, onNeedsReconnect: (d) => webhooks.emit('account.needs_reconnect', d) });
    const posts = createPosts({ db, media, integrations, ws, tagsFor: (ids) => sc.tags.forGroups(ids) });
    const analytics = createAnalytics({ db, cfg: wcfg, integrations, ws, log, onSynced: (r) => webhooks.emit('analytics.synced', { accounts: r }) });
    analytics.start = () => analyticsLoop.start();
    analytics.stop = () => analyticsLoop.stop();
    const store = wsSettings(db, ws);
    const settings = {
      async get() {
        const by = await store.all(['timezone', 'posting_slots', 'time_format']);
        return {
          timezone: by.timezone || cfg.defaultTimezone,
          time_format: by.time_format === '12h' ? '12h' : '24h',
          posting_slots: JSON.parse(by.posting_slots || 'null') || DEFAULT_SLOTS,
          public_url: cfg.publicUrl,
          analytics_interval_hours: cfg.analytics.intervalHours,
          graph_api_version: cfg.graphVersion,
          runtime: cfg.platform,
        };
      },
      async update({ timezone, posting_slots, time_format } = {}) {
        if (time_format !== undefined) {
          if (!['12h', '24h'].includes(time_format)) throw new Error('time_format must be "12h" or "24h".');
          await store.set('time_format', time_format);
        }
        if (timezone !== undefined) {
          if (!isValidTimezone(timezone)) throw new Error(`Unknown timezone "${timezone}". Use an IANA name like "Asia/Kolkata" or "Europe/Berlin".`);
          await store.set('timezone', timezone);
        }
        if (posting_slots !== undefined) {
          const clean = {};
          for (const [d, times] of Object.entries(posting_slots || {})) {
            if (!WEEKDAYS.includes(d)) throw new Error(`Unknown weekday "${d}". Use: ${WEEKDAYS.join(', ')}`);
            if (!Array.isArray(times)) throw new Error(`posting_slots.${d} must be an array of "HH:MM" strings`);
            for (const t of times) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`Invalid time "${t}" for ${d}; use 24h "HH:MM"`);
            clean[d] = [...new Set(times)].sort();
          }
          await store.set('posting_slots', JSON.stringify(clean));
        }
        return settings.get();
      },
    };
    sc = {
      root: core, workspaceId: ws, cfg: wcfg, db, storage, runtime, cipher, log, passwords: runtime.passwords,
      apps, media, integrations, posts, analytics, webhooks, settings,
      apiKeys: createApiKeys({ db, ws }),
      audit: createAudit({ db, ws }),
      scheduler,
      workspace: () => workspaces.get(ws),
      /** Per-request preparation: refresh this workspace's cached platform-app credentials. */
      async prepare() { await apps.sync(); },
      stop: () => core.stop(),
    };
    sc.brands = createBrands({ db, ws });
    sc.tags = createTags({ db, ws });
    sc.signatures = createSignatures({ db, ws });
    sc.templates = createTemplates({ db, ws });
    sc.wipe = createWipe({ db, storage, ws, workspaces });
    sc.library = createLibrary({ db, ws, media, extraRefs: async () => (sc.series ? sc.series.activeMediaIds() : []) });
    sc.retention = createRetention({ db, cfg: wcfg, storage, ws, hooks: runtime.hooks || {}, audit: sc.audit, log });
    sc.oauth = createOAuth(sc);
    scopes.set(ws, sc);
    return sc;
  }

  const postPayload = async (sc, postId) => {
    const p = await sc.posts.get(postId);
    return p && { post_id: p.group_id, target_id: p.id, account_id: p.integration_id, provider: p.provider, account_name: p.account_name, status: p.status, published_url: p.published_url, external_id: p.external_id, error: p.error, warning: p.warning, publish_at: p.publish_at };
  };
  const scheduler = createScheduler({
    db, cfg, scopeFor: scope, log, workerTag: workers ? 'cf' : 'w',
    // Node: the media retention purge runs from the scheduler loop (Workers: a cron step, see cron()).
    housekeeping: !workers && cfg.mediaPurge?.enabled ? { intervalMs: cfg.mediaPurge.intervalMs, run: () => core.purgeMedia() } : null,
    onPublished: async (id, ws) => { if (ws) { const sc = scope(ws); await sc.webhooks.emit('post.published', await postPayload(sc, id)); } },
    onFailed: async (id, ws) => { if (ws) { const sc = scope(ws); await sc.webhooks.emit('post.failed', await postPayload(sc, id)); } },
  });
  const analyticsLoop = createAnalyticsLoop({ db, cfg, scopeFor: scope, log });
  const allWorkspaceIds = async () => (await db.all('SELECT id FROM workspaces ORDER BY created_at')).map((r) => r.id);

  const core = {
    cfg, db, storage, runtime, cipher, log, workspaces, scheduler, apiKeys, passwords: runtime.passwords,
    media: { serve: rootMedia.serve, putPart: rootMedia.putPart, cleanupUploads: rootMedia.cleanupUploads },
    webhooks: delivery,
    analytics: analyticsLoop,
    scope,
    LEGACY_WORKSPACE,
    /** Kept for callers that prepare per request; workspace credentials sync inside scope().prepare(). */
    async prepare() {},

    /**
     * Media retention: per workspace, delete originals that are eligible now (bounded batches, idempotent).
     * dryRun = report only (nothing is generated, marked, moved or deleted).
     */
    async purgeMedia({ budget = null, dryRun = false, limit, workspaces: only = null } = {}) {
      const out = [];
      for (const ws of only || (await allWorkspaceIds())) {
        if (budget && !budget.has({ fetches: 2, queries: 8 })) break;
        try {
          out.push(await scope(ws).retention.run({ dryRun, budget, ...(limit ? { limit } : {}) }));
        } catch (e) {
          log('warn', `media purge ${ws}: ${e.message}`);
        }
      }
      return out;
    },

    /** Housekeeping: token refresh/health (per workspace), audit pruning, expired upload sessions. */
    async maintenance({ budget = null } = {}) {
      for (const ws of await allWorkspaceIds()) {
        if (budget && !budget.has({ fetches: 4, queries: 6 })) break;
        const sc = scope(ws);
        await sc.apps.sync().catch(() => {});
        await sc.integrations.maintain({ budget }).catch((e) => log('warn', `maintenance ${ws}: ${e.message}`));
      }
      await createAudit({ db }).prune();
      await rootMedia.cleanupUploads().catch(() => {});
    },

    /**
     * One Cloudflare Cron Trigger invocation: scheduler steps, then webhooks, analytics and (daily)
     * maintenance, each only while the invocation budget lasts.
     */
    async cron({ budget }) {
      const out = { scheduler: await scheduler.runOnce({ budget }) };
      out.webhooks = await delivery.deliverDue({ limit: cfg.budget.webhooks, budget });
      if (budget.has({ fetches: 15, queries: 15 })) out.analytics = Object.keys(await analyticsLoop.syncDue({ budget })).length;
      if (cfg.mediaPurge?.enabled && budget.has({ fetches: 6, queries: 14 })) {
        const lastPurge = Number((await db.getSetting('media_purge_at', '0')) || 0);
        if (Date.now() - lastPurge >= cfg.mediaPurge.intervalMs) {
          await db.setSetting('media_purge_at', String(Date.now()));
          out.media_purged = (await core.purgeMedia({ budget })).reduce((n, r) => n + r.files, 0);
        }
      }
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
        const missed = await scheduler.boot();
        if (missed) log('warn', `${missed} post(s) missed their schedule while the server was down`);
        scheduler.start();
        analyticsLoop.start();
        delivery.start();
        const maint = setInterval(() => { core.maintenance().catch(() => {}); }, 12 * 3600000);
        maint.unref?.();
        core._maint = maint;
      })();
    },
    async stop() {
      clearInterval(core._maint);
      analyticsLoop.stop();
      delivery.stop();
      await scheduler.stop();
      rawDb.close();
    },
  };
  return core;
}
