// Analytics: sync of account + post metrics into time-series tables, and queries for the UI/CSV.
// A sync of one account is a resumable state machine stored in `analytics_runs`
// (account metrics in date windows → list posts → post metrics in batches → finish), so on
// Cloudflare Workers it can be spread over several short cron invocations. On Node it runs to the
// end in one go (no windows/batches), which keeps the old behaviour.
import { getProvider } from './providers/index.js';
import { isBudgetError } from './scheduler.js';
import { HttpError } from './errors.js';
import { ytThumb } from './providers/youtube.js';
import { buildNotices } from './notices.js';

const DAY = 86400000;
export const SNAPSHOT_METRICS = new Set(['followers', 'following', 'media_count', 'total_views', 'video_views', 'post_views', 'page_likes']);
export const AVERAGE_METRICS = new Set(['avg_view_sec', 'avg_watch_ms']);
const today = () => new Date().toISOString().slice(0, 10);
const STEP_COST = { fetches: 12, queries: 10 };

/** Multi-row statements, chunked to stay under D1's 100 bound parameters per query. */
function multiRow(head, cols, rows, tail = '') {
  const per = Math.max(1, Math.floor(99 / cols));
  const out = [];
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    out.push([`${head} VALUES ${part.map(() => `(${Array(cols).fill('?').join(',')})`).join(',')} ${tail}`, ...part.flat()]);
  }
  return out;
}

/**
 * Analytics of ONE workspace (ws): sync of its accounts and every read. Child tables (account_metrics,
 * post_metrics, analytics_status/runs) are read through `integration_id IN (this workspace's accounts)`;
 * sync writes are keyed by an account id verified in this workspace first (ws:checked).
 */
export function createAnalytics({ db, cfg, integrations, ws, log = () => {}, onSynced = () => {} }) {
  if (!ws) throw new Error('createAnalytics: workspace id required');
  let running = null;
  const A = cfg.analytics;
  const OWN = 'integration_id IN (SELECT id FROM integrations WHERE workspace_id = ?)';

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

  const saveRun = (r) => db.run('UPDATE analytics_runs SET phase=?, cursor=?, data=?, updated_at=? WHERE integration_id=? /* ws:checked */', r.phase, r.cursor, JSON.stringify(r.data), Date.now(), r.integration_id);

  async function startRun(id, { backfill = false } = {}) {
    const status = await db.get('SELECT * FROM analytics_status WHERE integration_id = ? /* ws:checked */', id);
    const t = Date.now();
    const since = Math.max(status?.last_sync_at && !backfill ? status.last_sync_at - 2 * DAY : 0, t - A.backfillDays * DAY);
    const data = { unavailable: { account: {}, posts: {}, sources: {}, notices: [] }, flags: {}, daily: 0, postMetrics: 0, items: [], prevSync: status?.last_sync_at || null };
    await db.run(`INSERT INTO analytics_runs(integration_id, phase, cursor, until_ms, since_ms, data, started_at, updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(integration_id) DO UPDATE SET phase=excluded.phase, cursor=excluded.cursor, until_ms=excluded.until_ms, since_ms=excluded.since_ms, data=excluded.data, started_at=excluded.started_at, updated_at=excluded.updated_at /* ws:checked */`,
    id, 'account', since, t, since, JSON.stringify(data), t, t);
    return { integration_id: id, phase: 'account', cursor: since, until_ms: t, since_ms: since, data, started_at: t };
  }

  /** Run one step of a sync. Returns the final result when the run finished, else null. */
  async function step(run, row, provider, budget = null) {
    const id = run.integration_id;
    const t = run.until_ms;
    const un = run.data.unavailable;
    if (run.phase === 'account') {
      const end = A.windowDays > 0 ? Math.min(run.cursor + A.windowDays * DAY, t) : t;
      const acc = await withAuthRetry(id, (integ) => provider.accountAnalytics({ cfg, integration: integ, token: integ.access_token }, { since: run.cursor, until: end }));
      Object.assign(un.account, acc.unavailable || {});
      Object.assign((un.sources ||= {}), acc.sources || {});
      un.notices ||= [];
      for (const n of acc.notices || []) if (!un.notices.some((x) => x.code === n.code)) un.notices.push(n);
      Object.assign((run.data.flags ||= {}), acc.flags || {});
      const daily = (acc.daily || []).filter((d) => d.day);
      run.data.daily += (acc.daily || []).length;
      const rows = [...daily.map((d) => [id, d.metric, d.day, d.value, t]), ...Object.entries(acc.snapshot || {}).map(([k, v]) => [id, k, today(), v, t])];
      run.cursor = end;
      Object.assign((run.data.derived ||= {}), acc.derived || {});
      Object.assign((run.data.rollup ||= {}), acc.rollup || {});
      Object.assign((run.data.snap ||= {}), acc.snapshot || {});
      if (end >= t) { run.phase = 'list'; run.cursor = 0; }
      await db.batch([
        ...multiRow('INSERT INTO account_metrics(integration_id, metric, day, value, fetched_at)', 5, rows, 'ON CONFLICT(integration_id, metric, day) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at /* ws:checked */'),
        ['UPDATE analytics_runs SET phase=?, cursor=?, data=?, updated_at=? WHERE integration_id=? /* ws:checked */', run.phase, run.cursor, JSON.stringify(run.data), Date.now(), id],
      ]);
      return null;
    }
    if (run.phase === 'list') {
      let recent = [];
      try {
        recent = provider.recentPosts ? await withAuthRetry(id, (integ) => provider.recentPosts({ cfg, integration: integ, token: integ.access_token }, A.recentPosts)) : [];
      } catch (e) {
        if (e.kind === 'auth' || isBudgetError(e)) throw e;
        un.account.recent_posts = e.message;
      }
      // Posts we published that are not in the "recent" window still get tracked.
      const ours = await db.all("SELECT p.id, p.external_id, p.published_at, p.published_url, p.settings, COALESCE(p.content_override, g.content) AS caption FROM posts p JOIN groups g ON g.id = p.group_id AND g.workspace_id = p.workspace_id WHERE p.workspace_id = ? AND p.integration_id = ? AND p.status = 'published' AND p.external_id IS NOT NULL AND p.published_at > ? ORDER BY p.published_at DESC LIMIT 100", ws, id, t - 90 * DAY);
      const items = new Map(recent.map((r) => [r.external_id, r]));
      for (const o of ours) {
        if (!items.has(o.external_id)) {
          const s = JSON.parse(o.settings || '{}');
          items.set(o.external_id, { external_id: o.external_id, permalink: o.published_url, published_at: o.published_at, kind: s.post_type === 'story' ? 'story' : row.provider === 'youtube' ? 'video' : 'post', caption: row.provider === 'youtube' && s.title ? s.title : String(o.caption || '').slice(0, 500) });
        }
      }
      run.data.items = [...items.values()];
      run.phase = 'posts';
      run.cursor = 0;
      await saveRun(run);
      return null;
    }
    if (run.phase === 'posts') {
      const items = run.data.items;
      const n = A.postsPerStep > 0 ? A.postsPerStep : items.length;
      const slice = items.slice(run.cursor, run.cursor + n);
      const metricRows = [];
      if (provider.postAnalytics && slice.length) {
        await withAuthRetry(id, async (integ) => {
          const ctx = { cfg, integration: integ, token: integ.access_token, flags: run.data.flags || {} };
          for (const it of slice) {
            try {
              const r = await provider.postAnalytics(ctx, it);
              for (const [k, v] of Object.entries(r.metrics || {})) metricRows.push([id, it.external_id, k, t, Number(v) || 0]);
              for (const [k, v] of Object.entries(r.unavailable || {})) un.posts[k] ||= v;
              for (const [k, v] of Object.entries(r.sources || {})) (un.sources ||= {})[`post_${k}`] ||= v;
            } catch (e) {
              if (e.kind === 'auth' || isBudgetError(e)) throw e;
              un.posts._errors ||= e.message;
            }
          }
        });
      }
      // Thumbnails for items the list did not give one (our own posts outside the recent window, videos
      // without full_picture): asked once; afterwards the stored thumbnail is kept.
      if (provider.thumbnailFor && slice.some((it) => !it.thumbnail)) {
        const have = new Map((await db.all(`SELECT external_id, thumbnail FROM remote_posts WHERE workspace_id = ? AND integration_id = ? AND external_id IN (${slice.map(() => '?').join(',')})`, ws, id, ...slice.map((i) => i.external_id))).map((r) => [r.external_id, r.thumbnail]));
        const integ = await integrations.fresh(id);
        for (const it of slice) {
          if (it.thumbnail || have.get(it.external_id)) continue;
          if (budget && !budget.has({ fetches: 3, queries: 3 })) break;
          try { it.thumbnail = (await provider.thumbnailFor({ cfg, integration: integ, token: integ.access_token }, it)) || ''; } catch (e) { if (e.kind === 'auth' || isBudgetError(e)) throw e; }
        }
      }
      const links = slice.length ? await db.all(`SELECT id, external_id FROM posts WHERE workspace_id = ? AND integration_id = ? AND external_id IN (${slice.map(() => '?').join(',')})`, ws, id, ...slice.map((i) => i.external_id)) : [];
      const linkBy = new Map(links.map((l) => [l.external_id, l.id]));
      const remote = slice.map((it) => [ws, id, it.external_id, linkBy.get(it.external_id) || null, it.kind || null, it.caption || '', it.permalink || null, it.thumbnail || '', it.published_at || null, t]);
      run.data.postMetrics += metricRows.length;
      run.cursor += slice.length;
      if (run.cursor >= items.length) run.phase = 'finish';
      await db.batch([
        ...multiRow('INSERT INTO remote_posts(workspace_id, integration_id, external_id, post_id, kind, caption, permalink, thumbnail, published_at, updated_at)', 10, remote,
          `ON CONFLICT(integration_id, external_id) DO UPDATE SET post_id=COALESCE(excluded.post_id, remote_posts.post_id), kind=COALESCE(excluded.kind, remote_posts.kind),
           caption=CASE WHEN excluded.caption <> '' THEN excluded.caption ELSE remote_posts.caption END, permalink=COALESCE(excluded.permalink, remote_posts.permalink),
           thumbnail=CASE WHEN excluded.thumbnail <> '' THEN excluded.thumbnail ELSE remote_posts.thumbnail END, published_at=COALESCE(excluded.published_at, remote_posts.published_at), updated_at=excluded.updated_at`),
        ...multiRow('INSERT OR REPLACE INTO post_metrics(integration_id, external_id, metric, captured_at, value)', 5, metricRows, '/* ws:checked */'),
        ['UPDATE analytics_runs SET phase=?, cursor=?, data=?, updated_at=? WHERE integration_id=? /* ws:checked */', run.phase, run.cursor, JSON.stringify(run.data), Date.now(), id],
      ]);
      return null;
    }
    // finish
    un.notices = buildNotices(un, { provider: row.provider, label: { youtube: 'channel', facebook: 'Page' }[row.provider] || 'account' });
    const extra = [];
    // Roll-ups: an account snapshot summed from this run's post metrics (e.g. YouTube "video views" = Σ views of its videos).
    const snap = { ...(run.data.snap || {}) };
    for (const [metric, postMetric] of Object.entries(run.data.rollup || {})) {
      const r = await db.get('SELECT COUNT(*) AS n, SUM(value) AS v FROM post_metrics WHERE integration_id = ? AND metric = ? AND captured_at = ? /* ws:checked */', id, postMetric, t);
      if (r?.n) { snap[metric] = Number(r.v) || 0; extra.push([id, metric, today(), snap[metric], t]); }
    }
    // Fallback daily series derived from snapshots (YouTube without the Analytics API): today's value = current
    // total − the last total stored before today, i.e. the change since the previous sync day.
    for (const [metric, base] of Object.entries(run.data.derived || {})) {
      if (snap[base] === undefined) continue;
      const prev = await db.get('SELECT value FROM account_metrics WHERE integration_id = ? AND metric = ? AND day < ? ORDER BY day DESC LIMIT 1 /* ws:checked */', id, base, today());
      if (prev) extra.push([id, metric, today(), metric === 'views' ? Math.max(0, snap[base] - prev.value) : snap[base] - prev.value, t]);
    }
    await db.batch([
      ...multiRow('INSERT INTO account_metrics(integration_id, metric, day, value, fetched_at)', 5, extra, 'ON CONFLICT(integration_id, metric, day) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at /* ws:checked */'),
      ['DELETE FROM post_metrics WHERE integration_id = ? AND captured_at < ? /* ws:checked */', id, t - 365 * DAY],
      // days after today can only come from a mis-dated period (Meta's end_time); never keep them
      ['DELETE FROM account_metrics WHERE integration_id = ? AND day > ? /* ws:checked */', id, dayStr(t)],
      [`INSERT INTO analytics_status(integration_id, last_sync_at, last_error, unavailable) VALUES(?,?,NULL,?)
        ON CONFLICT(integration_id) DO UPDATE SET last_sync_at=excluded.last_sync_at, last_error=NULL, unavailable=excluded.unavailable /* ws:checked */`, id, t, JSON.stringify(un)],
      ['DELETE FROM analytics_runs WHERE integration_id = ? /* ws:checked */', id],
    ]);
    return { ok: true, daily: run.data.daily, posts: run.data.items.length, postMetrics: run.data.postMetrics, unavailable: un };
  }

  /**
   * Sync one account (start or resume its run). Without a budget it runs to completion.
   * With a budget (Workers) it may return { ok: true, pending: true } and continue on the next call.
   */
  async function syncIntegration(id, { budget = null, restart = false, backfill = false } = {}) {
    const row = await integrations.rawGet(id);
    if (!row) throw new Error('Unknown integration');
    const provider = getProvider(row.provider);
    if (!provider.accountAnalytics) return { skipped: true };
    let run = restart ? null : await db.get('SELECT * FROM analytics_runs WHERE integration_id = ? /* ws:checked */', id);
    if (run) run = { ...run, data: JSON.parse(run.data || '{}') };
    else run = await startRun(id, { backfill });
    try {
      for (;;) {
        if (budget && !budget.has(STEP_COST)) return { ok: true, pending: true, phase: run.phase };
        const done = await step(run, row, provider, budget);
        if (done) return done;
      }
    } catch (e) {
      if (isBudgetError(e)) {
        log('warn', `analytics sync ${id}: invocation budget exhausted in phase ${run.phase}; resuming next tick`);
        return { ok: true, pending: true, phase: run.phase };
      }
      await db.batch([
        [`INSERT INTO analytics_status(integration_id, last_sync_at, last_error, unavailable) VALUES(?,?,?, '{}')
          ON CONFLICT(integration_id) DO UPDATE SET last_error=excluded.last_error /* ws:checked */`, id, run.data.prevSync || null, e.message],
        ['DELETE FROM analytics_runs WHERE integration_id = ? /* ws:checked */', id],
      ]);
      if (e.kind === 'auth' || e.kind === 'disconnect') await integrations.markNeedsReconnect(id, e.message);
      log('warn', `analytics sync ${id}: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async function syncAll() {
    if (running) return running;
    running = (async () => {
      const out = {};
      for (const r of await db.all("SELECT id FROM integrations WHERE workspace_id = ? AND status = 'active'", ws)) out[r.id] = await syncIntegration(r.id, { restart: true });
      try { await onSynced(out); } catch {}
      return out;
    })().finally(() => { running = null; });
    return running;
  }

  /**
   * Workers cron: continue unfinished runs, then start runs for accounts whose last sync is older
   * than ANALYTICS_INTERVAL_HOURS, while the budget lasts. Emits analytics.synced per finished account.
   */
  async function syncDue({ budget = null, force = false } = {}) {
    const ms = A.intervalHours * 3600000;
    if (!ms && !force) return {};
    const due = await db.all(`SELECT i.id, r.integration_id AS running FROM integrations i
      LEFT JOIN analytics_status s ON s.integration_id = i.id LEFT JOIN analytics_runs r ON r.integration_id = i.id
      WHERE i.workspace_id = ? AND i.status = 'active' AND (r.integration_id IS NOT NULL OR s.last_sync_at IS NULL OR s.last_sync_at < ?)
      ORDER BY (r.integration_id IS NULL), COALESCE(s.last_sync_at, 0) LIMIT 10`, ws, Date.now() - (force ? 0 : ms));
    const out = {};
    for (const d of due) {
      if (budget && !budget.has(STEP_COST)) break;
      const r = await syncIntegration(d.id, { budget });
      out[d.id] = r;
      if (!r.pending) { try { await onSynced({ [d.id]: r }); } catch {} }
      if (r.pending) break;
    }
    return out;
  }

  const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

  async function series(integrationId, from, to) {
    const rows = await db.all(`SELECT metric, day, value FROM account_metrics WHERE integration_id = ? AND ${OWN} AND day >= ? AND day <= ? ORDER BY day`, integrationId, ws, dayStr(from), dayStr(to));
    const out = {};
    for (const r of rows) (out[r.metric] ||= []).push({ day: r.day, value: r.value });
    return out;
  }

  const summarize = (s) => {
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
  };
  const summary = async (integrationId, from, to) => summarize(await series(integrationId, from, to));

  async function latestPostMetrics(integrationId) {
    const rows = await db.all(`SELECT pm.external_id, pm.metric, pm.value FROM post_metrics pm
      JOIN (SELECT external_id, metric, MAX(captured_at) AS mc FROM post_metrics WHERE integration_id = ? GROUP BY external_id, metric) l
      ON l.external_id = pm.external_id AND l.metric = pm.metric AND l.mc = pm.captured_at WHERE pm.integration_id = ? AND pm.${OWN}`, integrationId, integrationId, ws);
    const map = {};
    for (const r of rows) (map[r.external_id] ||= {})[r.metric] = r.value;
    return map;
  }

  async function topPosts({ integrationId = null, integrationIds = null, from = 0, to = Date.now(), sort = 'views', limit = 50 } = {}) {
    let integs;
    if (integrationIds) {
      const want = new Set(integrationIds);
      integs = (await db.all('SELECT * FROM integrations WHERE workspace_id = ?', ws)).filter((r) => want.has(r.id));
    } else if (integrationId) {
      const one = await integrations.rawGet(integrationId);
      if (!one) throw new HttpError(404, 'Account not found.');
      integs = [one];
    } else integs = await db.all('SELECT * FROM integrations WHERE workspace_id = ?', ws);
    const out = [];
    for (const integ of integs) {
      const id = integ.id;
      const metrics = await latestPostMetrics(id);
      const rows = await db.all('SELECT * FROM remote_posts WHERE workspace_id = ? AND integration_id = ? AND (published_at IS NULL OR (published_at >= ? AND published_at <= ?))', ws, id, from, to);
      for (const r of rows) {
        out.push({ integration_id: id, provider: integ.provider, account: integ.display_name || integ.name, external_id: r.external_id, post_id: r.post_id, kind: r.kind, caption: r.caption, permalink: r.permalink, thumbnail: r.thumbnail || (integ.provider === 'youtube' ? ytThumb(null, r.external_id) : ''), published_at: r.published_at, via_postlite: !!r.post_id, metrics: metrics[r.external_id] || {} });
      }
    }
    out.sort((a, b) => (b.metrics[sort] ?? -1) - (a.metrics[sort] ?? -1));
    return out.slice(0, limit);
  }

  async function postSeries(integrationId, externalId) {
    const rows = await db.all(`SELECT metric, captured_at, value FROM post_metrics WHERE integration_id = ? AND ${OWN} AND external_id = ? ORDER BY captured_at`, integrationId, ws, externalId);
    const out = {};
    for (const r of rows) (out[r.metric] ||= []).push({ t: r.captured_at, value: r.value });
    return out;
  }

  const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // CSV formula-injection guard
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  async function csvAccount(integrationId, from, to) {
    const integ = await integrations.rawGet(integrationId);
    if (!integ) throw new HttpError(404, 'Account not found.');
    const rows = await db.all(`SELECT day, metric, value FROM account_metrics WHERE integration_id = ? AND ${OWN} AND day >= ? AND day <= ? ORDER BY day, metric`, integrationId, ws, dayStr(from), dayStr(to));
    return ['account,provider,day,metric,value', ...rows.map((r) => [integ?.display_name || integ?.name, integ?.provider, r.day, r.metric, r.value].map(csvCell).join(','))].join('\n') + '\n';
  }

  async function csvPosts(opts) {
    const posts = await topPosts({ ...opts, limit: 10000 });
    const metrics = [...new Set(posts.flatMap((p) => Object.keys(p.metrics)))].sort();
    const head = ['account', 'provider', 'external_id', 'published_at', 'kind', 'via_postlite', 'permalink', 'caption', ...metrics];
    const lines = posts.map((p) => [p.account, p.provider, p.external_id, p.published_at ? new Date(p.published_at).toISOString() : '', p.kind, p.via_postlite ? 'yes' : 'no', p.permalink, (p.caption || '').slice(0, 300), ...metrics.map((m) => p.metrics[m] ?? '')].map(csvCell).join(','));
    return [head.join(','), ...lines].join('\n') + '\n';
  }

  const statusView = (r) => (r ? { last_sync_at: r.last_sync_at, last_error: r.last_error, unavailable: JSON.parse(r.unavailable || '{}') } : null);

  return {
    syncIntegration,
    syncAll,
    syncDue,
    series,
    summary,
    topPosts,
    postSeries,
    csvAccount,
    csvPosts,
    status: async (id) => statusView(await db.get(`SELECT * FROM analytics_status WHERE integration_id = ? AND ${OWN}`, id, ws)),
    /** status for many accounts in one query: Map id → status */
    async statusMany(ids) {
      if (!ids.length) return new Map();
      const rows = await db.all(`SELECT * FROM analytics_status WHERE ${OWN} AND integration_id IN (${ids.map(() => '?').join(',')})`, ws, ...ids);
      return new Map(rows.map((r) => [r.integration_id, statusView(r)]));
    },
    isRunning: () => !!running,
  };
}

/**
 * Instance-wide analytics loop: every active account of every workspace, each synced with its own
 * workspace's tokens and app credentials (scopeFor(ws).analytics).
 */
export function createAnalyticsLoop({ db, cfg, scopeFor, log = () => {} }) {
  let timer = null;
  let running = null;
  const A = cfg.analytics;
  const byWs = (rows) => {
    const m = new Map();
    for (const r of rows) (m.get(r.workspace_id) || m.set(r.workspace_id, []).get(r.workspace_id)).push(r.id);
    return m;
  };
  async function syncAll() {
    if (running) return running;
    running = (async () => {
      const out = {};
      const rows = await db.all("SELECT id, workspace_id FROM integrations WHERE status = 'active' AND workspace_id IS NOT NULL /* ws:system */");
      for (const [ws] of byWs(rows)) Object.assign(out, await scopeFor(ws).analytics.syncAll());
      return out;
    })().finally(() => { running = null; });
    return running;
  }
  /** Workers cron: resume unfinished runs, then start due ones, while the budget lasts. */
  async function syncDue({ budget = null } = {}) {
    const ms = A.intervalHours * 3600000;
    if (!ms) return {};
    const due = await db.all(`SELECT i.id, i.workspace_id FROM integrations i
      LEFT JOIN analytics_status s ON s.integration_id = i.id LEFT JOIN analytics_runs r ON r.integration_id = i.id
      WHERE i.status = 'active' AND i.workspace_id IS NOT NULL AND (r.integration_id IS NOT NULL OR s.last_sync_at IS NULL OR s.last_sync_at < ?)
      ORDER BY (r.integration_id IS NULL), COALESCE(s.last_sync_at, 0) LIMIT 10`, Date.now() - ms);
    const out = {};
    for (const d of due) {
      if (budget && !budget.has(STEP_COST)) break;
      const sc = scopeFor(d.workspace_id);
      await sc.apps.sync();
      const r = await sc.analytics.syncIntegration(d.id, { budget });
      out[d.id] = r;
      if (!r.pending) { try { await sc.webhooks.emit('analytics.synced', { accounts: { [d.id]: r } }); } catch {} }
      if (r.pending) break;
    }
    return out;
  }
  return {
    syncAll,
    syncDue,
    isRunning: () => !!running,
    start() {
      const ms = A.intervalHours * 3600000;
      if (!ms || timer) return;
      timer = setInterval(() => syncAll().catch((e) => log('error', `analytics: ${e.message}`)), ms);
      timer.unref?.();
      // first sync shortly after boot if never synced or stale
      db.get('SELECT MIN(COALESCE(last_sync_at, 0)) AS t FROM analytics_status /* ws:system */').then((r) => {
        if (Date.now() - (r?.t || 0) > ms) setTimeout(() => syncAll().catch(() => {}), 60000).unref?.();
      }).catch(() => {});
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
