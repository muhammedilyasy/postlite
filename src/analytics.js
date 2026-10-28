// Analytics: periodic sync of account + post metrics into time-series tables, and queries for the UI/CSV.
import { getProvider } from './providers/index.js';

const DAY = 86400000;
export const SNAPSHOT_METRICS = new Set(['followers', 'following', 'media_count', 'total_views', 'page_likes']);
export const AVERAGE_METRICS = new Set(['avg_view_sec', 'avg_watch_ms']);
const today = () => new Date().toISOString().slice(0, 10);

export function createAnalytics({ db, cfg, integrations, log = () => {}, onSynced = () => {} }) {
  let running = null;
  let timer = null;

  async function withAuthRetry(id, fn) {
    let integ = await integrations.fresh(id);
    try {
      return await fn(integ);
    } catch (e) {
      const p = getProvider(integ.provider);
      if (e.kind === 'auth' && p.canRefresh) {
        integ = await integrations.refresh(id);
        return fn(integ);
      }
      throw e;
    }
  }

  async function syncIntegration(id) {
    const row = integrations.rawGet(id);
    if (!row) throw new Error('Unknown integration');
    const provider = getProvider(row.provider);
    if (!provider.accountAnalytics) return { skipped: true };
    const status = db.get('SELECT * FROM analytics_status WHERE integration_id = ?', id);
    const t = Date.now();
    const since = Math.max(status?.last_sync_at ? status.last_sync_at - 2 * DAY : 0, t - cfg.analytics.backfillDays * DAY);
    const unavailable = { account: {}, posts: {} };
    try {
      const counts = await withAuthRetry(id, async (integ) => {
        const ctx = { cfg, integration: integ, token: integ.access_token };
        const acc = await provider.accountAnalytics(ctx, { since, until: t });
        Object.assign(unavailable.account, acc.unavailable || {});
        let recent = [];
        try {
          recent = provider.recentPosts ? await provider.recentPosts(ctx, cfg.analytics.recentPosts) : [];
        } catch (e) {
          if (e.kind === 'auth') throw e;
          unavailable.account.recent_posts = e.message;
        }
        // Posts we published that are not in the "recent" window still get tracked.
        const ours = db.all("SELECT p.id, p.external_id, p.published_at, p.published_url, p.settings, COALESCE(p.content_override, g.content) AS caption FROM posts p JOIN groups g ON g.id = p.group_id WHERE p.integration_id = ? AND p.status = 'published' AND p.external_id IS NOT NULL AND p.published_at > ? ORDER BY p.published_at DESC LIMIT 100", id, t - 90 * DAY);
        const items = new Map(recent.map((r) => [r.external_id, r]));
        for (const o of ours) {
          if (!items.has(o.external_id)) {
            const s = JSON.parse(o.settings || '{}');
            items.set(o.external_id, { external_id: o.external_id, permalink: o.published_url, published_at: o.published_at, kind: s.post_type === 'story' ? 'story' : row.provider === 'youtube' ? 'video' : 'post', caption: row.provider === 'youtube' && s.title ? s.title : String(o.caption || '').slice(0, 500) });
          }
        }
        const metricRows = [];
        for (const it of items.values()) {
          if (!provider.postAnalytics) break;
          try {
            const r = await provider.postAnalytics(ctx, it);
            for (const [k, v] of Object.entries(r.metrics || {})) metricRows.push([it.external_id, k, v]);
            for (const [k, v] of Object.entries(r.unavailable || {})) unavailable.posts[k] ||= v;
          } catch (e) {
            if (e.kind === 'auth') throw e;
            unavailable.posts._errors ||= e.message;
          }
        }
        db.tx(() => {
          for (const d of acc.daily || []) {
            if (!d.day) continue;
            db.run('INSERT INTO account_metrics(integration_id, metric, day, value, fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(integration_id, metric, day) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at', id, d.metric, d.day, d.value, t);
          }
          for (const [k, v] of Object.entries(acc.snapshot || {})) {
            db.run('INSERT INTO account_metrics(integration_id, metric, day, value, fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(integration_id, metric, day) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at', id, k, today(), v, t);
          }
          for (const it of items.values()) {
            const link = db.get('SELECT id FROM posts WHERE integration_id = ? AND external_id = ?', id, it.external_id);
            db.run(`INSERT INTO remote_posts(integration_id, external_id, post_id, kind, caption, permalink, thumbnail, published_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(integration_id, external_id) DO UPDATE SET post_id=COALESCE(excluded.post_id, remote_posts.post_id), kind=COALESCE(excluded.kind, remote_posts.kind),
                    caption=CASE WHEN excluded.caption <> '' THEN excluded.caption ELSE remote_posts.caption END, permalink=COALESCE(excluded.permalink, remote_posts.permalink),
                    thumbnail=CASE WHEN excluded.thumbnail <> '' THEN excluded.thumbnail ELSE remote_posts.thumbnail END, published_at=COALESCE(excluded.published_at, remote_posts.published_at), updated_at=excluded.updated_at`,
              id, it.external_id, link?.id || null, it.kind || null, it.caption || '', it.permalink || null, it.thumbnail || '', it.published_at || null, t);
          }
          for (const [ext, metric, value] of metricRows) {
            db.run('INSERT OR REPLACE INTO post_metrics(integration_id, external_id, metric, captured_at, value) VALUES(?,?,?,?,?)', id, ext, metric, t, Number(value) || 0);
          }
          db.run('DELETE FROM post_metrics WHERE integration_id = ? AND captured_at < ?', id, t - 365 * DAY);
          db.run(`INSERT INTO analytics_status(integration_id, last_sync_at, last_error, unavailable) VALUES(?,?,NULL,?)
                  ON CONFLICT(integration_id) DO UPDATE SET last_sync_at=excluded.last_sync_at, last_error=NULL, unavailable=excluded.unavailable`, id, t, JSON.stringify(unavailable));
        });
        return { daily: (acc.daily || []).length, posts: items.size, postMetrics: metricRows.length };
      });
      return { ok: true, ...counts, unavailable };
    } catch (e) {
      db.run(`INSERT INTO analytics_status(integration_id, last_sync_at, last_error, unavailable) VALUES(?,?,?, '{}')
              ON CONFLICT(integration_id) DO UPDATE SET last_error=excluded.last_error`, id, status?.last_sync_at || null, e.message);
      if (e.kind === 'auth' || e.kind === 'disconnect') integrations.markNeedsReconnect(id, e.message);
      log('warn', `analytics sync ${id}: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async function syncAll() {
    if (running) return running;
    running = (async () => {
      const out = {};
      for (const r of db.all("SELECT id FROM integrations WHERE status = 'active'")) out[r.id] = await syncIntegration(r.id);
      try { onSynced(out); } catch {}
      return out;
    })().finally(() => { running = null; });
    return running;
  }

  const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

  function series(integrationId, from, to) {
    const rows = db.all('SELECT metric, day, value FROM account_metrics WHERE integration_id = ? AND day >= ? AND day <= ? ORDER BY day', integrationId, dayStr(from), dayStr(to));
    const out = {};
    for (const r of rows) (out[r.metric] ||= []).push({ day: r.day, value: r.value });
    return out;
  }

  function summary(integrationId, from, to) {
    const s = series(integrationId, from, to);
    const out = {};
    for (const [m, pts] of Object.entries(s)) {
      if (SNAPSHOT_METRICS.has(m)) {
        const first = pts[0].value, last = pts[pts.length - 1].value;
        out[m] = { value: last, change: last - first, kind: 'snapshot' };
      } else if (AVERAGE_METRICS.has(m)) {
        out[m] = { value: Math.round(pts.reduce((a, p) => a + p.value, 0) / pts.length), kind: 'average' };
      } else {
        out[m] = { value: pts.reduce((a, p) => a + p.value, 0), kind: 'sum' };
      }
    }
    return out;
  }

  function latestPostMetrics(integrationId) {
    const rows = db.all(`SELECT pm.external_id, pm.metric, pm.value FROM post_metrics pm
      JOIN (SELECT external_id, metric, MAX(captured_at) AS mc FROM post_metrics WHERE integration_id = ? GROUP BY external_id, metric) l
      ON l.external_id = pm.external_id AND l.metric = pm.metric AND l.mc = pm.captured_at WHERE pm.integration_id = ?`, integrationId, integrationId);
    const map = {};
    for (const r of rows) (map[r.external_id] ||= {})[r.metric] = r.value;
    return map;
  }

  function topPosts({ integrationId = null, from = 0, to = Date.now(), sort = 'views', limit = 50 } = {}) {
    const ids = integrationId ? [integrationId] : db.all('SELECT id FROM integrations').map((r) => r.id);
    const out = [];
    for (const id of ids) {
      const integ = integrations.rawGet(id);
      if (!integ) continue;
      const metrics = latestPostMetrics(id);
      const rows = db.all('SELECT * FROM remote_posts WHERE integration_id = ? AND (published_at IS NULL OR (published_at >= ? AND published_at <= ?))', id, from, to);
      for (const r of rows) {
        out.push({ integration_id: id, provider: integ.provider, account: integ.name, external_id: r.external_id, post_id: r.post_id, kind: r.kind, caption: r.caption, permalink: r.permalink, thumbnail: r.thumbnail, published_at: r.published_at, via_postlite: !!r.post_id, metrics: metrics[r.external_id] || {} });
      }
    }
    out.sort((a, b) => (b.metrics[sort] ?? -1) - (a.metrics[sort] ?? -1));
    return out.slice(0, limit);
  }

  function postSeries(integrationId, externalId) {
    const rows = db.all('SELECT metric, captured_at, value FROM post_metrics WHERE integration_id = ? AND external_id = ? ORDER BY captured_at', integrationId, externalId);
    const out = {};
    for (const r of rows) (out[r.metric] ||= []).push({ t: r.captured_at, value: r.value });
    return out;
  }

  const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // CSV formula-injection guard
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  function csvAccount(integrationId, from, to) {
    const integ = integrations.rawGet(integrationId);
    const rows = db.all('SELECT day, metric, value FROM account_metrics WHERE integration_id = ? AND day >= ? AND day <= ? ORDER BY day, metric', integrationId, dayStr(from), dayStr(to));
    return ['account,provider,day,metric,value', ...rows.map((r) => [integ?.name, integ?.provider, r.day, r.metric, r.value].map(csvCell).join(','))].join('\n') + '\n';
  }

  function csvPosts(opts) {
    const posts = topPosts({ ...opts, limit: 10000 });
    const metrics = [...new Set(posts.flatMap((p) => Object.keys(p.metrics)))].sort();
    const head = ['account', 'provider', 'external_id', 'published_at', 'kind', 'via_postlite', 'permalink', 'caption', ...metrics];
    const lines = posts.map((p) => [p.account, p.provider, p.external_id, p.published_at ? new Date(p.published_at).toISOString() : '', p.kind, p.via_postlite ? 'yes' : 'no', p.permalink, (p.caption || '').slice(0, 300), ...metrics.map((m) => p.metrics[m] ?? '')].map(csvCell).join(','));
    return [head.join(','), ...lines].join('\n') + '\n';
  }

  return {
    syncIntegration,
    syncAll,
    series,
    summary,
    topPosts,
    postSeries,
    csvAccount,
    csvPosts,
    status: (id) => {
      const r = db.get('SELECT * FROM analytics_status WHERE integration_id = ?', id);
      return r ? { last_sync_at: r.last_sync_at, last_error: r.last_error, unavailable: JSON.parse(r.unavailable || '{}') } : null;
    },
    isRunning: () => !!running,
    start() {
      const ms = cfg.analytics.intervalHours * 3600000;
      if (!ms || timer) return;
      timer = setInterval(() => syncAll().catch((e) => log('error', `analytics: ${e.message}`)), ms);
      timer.unref?.();
      // first sync shortly after boot if never synced or stale
      const last = db.get('SELECT MIN(COALESCE(last_sync_at, 0)) AS t FROM analytics_status')?.t || 0;
      if (Date.now() - last > ms) setTimeout(() => syncAll().catch(() => {}), 60000).unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
