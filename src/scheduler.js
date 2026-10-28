// Scheduler: jobs table + atomic claiming + phased publish state machine. Runtime-agnostic:
//  * Node: an in-process loop (tick every SCHEDULER_TICK_MS, up to SCHEDULER_CONCURRENCY jobs at once).
//  * Workers: a Cron Trigger calls runOnce() every minute; each invocation advances jobs in small
//    resumable steps and stops before the per-invocation budget (CPU / subrequests / D1 queries) runs out.
//
// Guarantees:
//  * A job is claimed with a single conditional UPDATE … RETURNING (inside an atomic batch together with
//    the post status), so two loops, processes or Worker invocations can never run the same job concurrently.
//  * Every phase result (pending data) is persisted before the next upstream call, so a crash resumes
//    from the last safe point (YouTube: the resumable session URI and uploaded byte count).
//  * Irreversible upstream calls set jobs.inflight first. If the process dies mid-call, recovery asks
//    the provider whether the post went live (IG container status, YouTube session probe); when that
//    is impossible (Facebook), the post is failed with an explicit "check before retrying" message
//    instead of risking a duplicate.
import { randomToken } from './crypto.js';
import { isProviderError } from './providers/http.js';
import { getProvider } from './providers/index.js';

// Worst-case cost of one job step, used to stop before a Workers invocation runs out of budget.
const STEP_COST = { fetches: 14, queries: 14 };

export function createScheduler({ db, cfg, media, integrations, posts, log = () => {}, onPublished = () => {}, onFailed = () => {}, workerTag = 'w' }) {
  const S = cfg.scheduler;
  const workerId = `${workerTag}-${randomToken(6)}`;
  const active = new Set();
  let timer = null;
  let ticking = false;

  const now = () => Date.now();

  /** Atomically claim the next due job (one UPDATE … RETURNING + post status, in one batch). */
  async function claim() {
    const t = now();
    const lock = `${workerId}:${randomToken(4)}`;
    const [jobs] = await db.batch([
      [`UPDATE jobs SET state='running', locked_by=?, locked_until=?, updated_at=?
        WHERE id = (SELECT id FROM jobs WHERE state = 'queued' AND run_at <= ? ORDER BY run_at, id LIMIT 1) AND state='queued' RETURNING *`, lock, t + S.lockTtlMs, t, t],
      ["UPDATE posts SET status='publishing', updated_at=? WHERE id IN (SELECT post_id FROM jobs WHERE locked_by = ? AND state='running')", t, lock],
    ]);
    const row = jobs.rows[0];
    return row ? { ...row } : null;
  }

  /** Release jobs whose lock expired (or all running jobs at boot). */
  async function recoverStale({ boot = false } = {}) {
    const t = now();
    const rows = boot
      ? await db.all("SELECT * FROM jobs WHERE state = 'running'")
      : await db.all("SELECT * FROM jobs WHERE state = 'running' AND locked_until < ?", t);
    for (const j of rows) {
      if (active.has(j.id)) continue;
      const phase = j.inflight ? 'recover' : j.phase;
      const r = await db.run("UPDATE jobs SET state='queued', phase=?, run_at=?, locked_by=NULL, locked_until=NULL, updated_at=? WHERE id=? AND state='running' AND locked_by IS ?", phase, t, t, j.id, j.locked_by);
      if (!r.changes) continue;
      await posts.event(j.post_id, 'warn', j.inflight ? `Publishing was interrupted during "${JSON.parse(j.inflight).label}"; checking whether it went live` : 'Publishing was interrupted; resuming');
      log('warn', `recovered stale job ${j.id} (phase ${phase})`);
    }
  }

  /** Fail scheduled posts that are older than the grace window (server down / cron not running). */
  async function failMissed() {
    const cutoff = now() - S.graceMinutes * 60000;
    const rows = await db.all("SELECT * FROM jobs WHERE state = 'queued' AND phase = 'start' AND attempts = 0 AND run_at < ?", cutoff);
    for (const j of rows) {
      await fail(j, `Missed: the server was not running at the scheduled time (more than ${S.graceMinutes} minutes ago). Use Retry to publish now.`, { onlyIfQueued: true });
    }
    return rows.length;
  }

  async function persist(job, fields) {
    const keys = Object.keys(fields);
    await db.run(`UPDATE jobs SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...Object.values(fields), now(), job.id);
    Object.assign(job, fields);
  }

  async function fail(job, message, { onlyIfQueued = false } = {}) {
    const msg = String(message).slice(0, 2000);
    const t = now();
    const res = await db.batch([
      [`UPDATE jobs SET state='dead', inflight=NULL, last_error=?, locked_by=NULL, locked_until=NULL, updated_at=? WHERE id=?${onlyIfQueued ? " AND state='queued'" : ''}`, msg, t, job.id],
      [`UPDATE posts SET status='failed', error=?, updated_at=? WHERE id=?${onlyIfQueued ? " AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND state='dead')" : ''}`, msg, t, job.post_id, ...(onlyIfQueued ? [job.id] : [])],
      posts.eventStmt(job.post_id, 'error', message),
    ]);
    if (onlyIfQueued && !res[0].changes) return;
    log('warn', `post ${job.post_id} failed: ${message}`);
    try { await onFailed(job.post_id, message); } catch {}
  }

  async function complete(job, ctx, provider, r) {
    const t = now();
    await db.batch([
      ["UPDATE posts SET status='published', external_id=?, published_url=?, published_at=?, error=NULL, warning=?, attempts=?, updated_at=? WHERE id=?",
        r.externalId || null, r.url || null, t, r.warning || null, job.attempts, t, job.post_id],
      ["UPDATE jobs SET state='done', inflight=NULL, pending_data=NULL, locked_by=NULL, locked_until=NULL, updated_at=? WHERE id=?", t, job.id],
      posts.eventStmt(job.post_id, 'info', `Published${r.url ? `: ${r.url}` : ''}`),
      r.warning ? posts.eventStmt(job.post_id, 'warn', r.warning) : null,
    ]);
    log('info', `post ${job.post_id} published ${r.externalId || ''}`);
    // First comment (best effort, never fails the post).
    const fc = String(ctx.post.settings.first_comment || '').trim();
    if (fc && provider.comment && r.externalId && ctx.post.settings.post_type !== 'story') {
      try {
        await provider.comment(ctx, r.externalId, fc);
        await posts.event(job.post_id, 'info', 'First comment added');
      } catch (e) {
        const w = [r.warning, `Post is live, but the first comment failed: ${e.message}`].filter(Boolean).join(' · ');
        await db.batch([['UPDATE posts SET warning=? WHERE id=?', w, job.post_id], posts.eventStmt(job.post_id, 'warn', w)]);
      }
    }
    try { await onPublished(job.post_id); } catch {}
  }

  function buildCtx(job, post, integ, c, budget) {
    return {
      cfg,
      integration: integ,
      token: integ.access_token,
      post: { id: post.id, caption: c.caption, media: c.media, settings: c.settings, thumbnail: c.thumbnail },
      thumbnail: c.thumbnail,
      mediaUrl: (m) => media.publicUrl(m),
      mediaSize: (m) => media.size(m),
      openMedia: (m, start, end) => media.open(m, start, end),
      mediaPath: (m) => media.localPath(m), // Node only (null on Workers)
      budgetLow: () => !!budget && !budget.has({ fetches: 3, queries: 6 }),
      irreversible: async (label) => persist(job, { inflight: JSON.stringify({ label, at: now(), data: job.pending_data ? 1 : 0 }) }),
      heartbeat: async () => persist(job, { locked_until: now() + S.lockTtlMs }),
    };
  }

  /**
   * Advance one claimed job as far as possible.
   * @param {object} job
   * @param {{budget?: object}} [opts] Workers: stop between phases when the invocation budget runs low.
   */
  async function run(job, { budget = null } = {}) {
    const post = await db.get('SELECT p.*, i.provider FROM posts p JOIN integrations i ON i.id = p.integration_id WHERE p.id = ?', job.post_id);
    if (!post) {
      await db.run('DELETE FROM jobs WHERE id = ?', job.id);
      return;
    }
    const provider = getProvider(post.provider);
    let refreshed = false;
    let recovering = false;
    let ctx;
    let c;
    for (let guard = 0; guard < 60; guard++) {
      if (budget && guard > 0 && !budget.has(STEP_COST)) break; // hand the rest to the next invocation
      try {
        if (!ctx) {
          const integ = await integrations.fresh(post.integration_id);
          if (integ.status !== 'active') return fail(job, `${integ.name}: account needs to be reconnected (${integ.status_message || 'token invalid'}).`);
          c ||= await posts.composed(post);
          ctx = buildCtx(job, post, integ, c, budget);
        }
        const data = job.pending_data ? JSON.parse(job.pending_data) : null;
        let r;
        if (job.phase === 'start') r = await provider.publishStart(ctx);
        else if (job.phase === 'check') r = await provider.publishCheck(ctx, data);
        else if (job.phase === 'finalize') r = await provider.publishFinalize(ctx, data);
        else if (job.phase === 'recover') {
          r = provider.recover ? await provider.recover(ctx, data) : null;
          if (!r) return fail(job, `Publishing was interrupted during "${safeLabel(job.inflight)}" and the platform cannot confirm whether the post went live. Check the account before retrying to avoid a duplicate.`);
          await persist(job, { inflight: null });
        } else throw new Error(`Unknown phase ${job.phase}`);

        if (r.status === 'completed') return await complete(job, ctx, provider, r);
        if (r.status === 'ready') {
          await persist(job, { phase: 'finalize', pending_data: JSON.stringify(r.data), inflight: null });
          continue;
        }
        if (r.status === 'pending') {
          const pendingSince = job.pending_since || now();
          if (now() - pendingSince > S.maxPendingMs) return fail(job, 'Timed out waiting for the platform to process the media.');
          if (r.delayMs === 0) {
            await persist(job, { phase: 'check', pending_data: JSON.stringify(r.data), pending_since: pendingSince, inflight: null, locked_until: now() + S.lockTtlMs });
            continue;
          }
          const runAt = now() + (r.delayMs ?? S.pollMs);
          await persist(job, { state: 'queued', phase: 'check', pending_data: JSON.stringify(r.data), pending_since: pendingSince, run_at: runAt, inflight: null, locked_by: null, locked_until: null });
          return;
        }
        throw new Error(`Provider returned unknown status ${r.status}`);
      } catch (e) {
        if (isBudgetError(e)) {
          // Workers subrequest/query limit hit mid-step: nothing irreversible was confirmed; resume next tick.
          log('warn', `job ${job.id}: invocation budget exhausted (${e.message}); resuming next tick`);
          await persist(job, { state: 'queued', run_at: now(), locked_by: null, locked_until: null }).catch(() => {});
          return;
        }
        const kind = isProviderError(e) ? e.kind : 'transient';
        if (!isProviderError(e)) log('error', `job ${job.id} crashed: ${e.stack || e}`);
        if (kind === 'auth' && provider.canRefresh && !refreshed) {
          refreshed = true;
          try {
            const integ = await integrations.refresh(post.integration_id);
            ctx = buildCtx(job, post, integ, c, budget);
            await persist(job, { inflight: null });
            continue;
          } catch (e2) {
            if (e2.kind === 'transient') return retry(job, e2);
            return fail(job, `${e2.message} — reconnect the account.`);
          }
        }
        if (kind === 'unknown_outcome' && provider.recover && !recovering) {
          // Ask the platform whether the irreversible call went through before deciding anything.
          recovering = true;
          await posts.event(job.post_id, 'warn', `${e.message} Checking with the platform…`);
          await persist(job, { phase: 'recover' });
          continue;
        }
        if (kind === 'auth' || kind === 'disconnect') {
          await integrations.markNeedsReconnect(post.integration_id, e.message);
          return fail(job, e.message);
        }
        if (kind === 'transient') return retry(job, e);
        return fail(job, e.message);
      }
    }
    // Too many immediate phase transitions in one claim (or budget reached): hand back to the queue.
    await persist(job, { state: 'queued', run_at: budget ? now() : now() + S.pollMs, locked_by: null, locked_until: null });
  }

  async function retry(job, e) {
    const attempts = job.attempts + 1;
    if (attempts >= S.maxAttempts) return fail(job, `Failed after ${attempts} attempts: ${e.message}`);
    const delay = Math.round(S.backoffBaseMs * 2 ** (attempts - 1) * (1 + Math.random() * 0.1));
    const runAt = now() + delay;
    await db.batch([
      ["UPDATE jobs SET state='queued', attempts=?, run_at=?, inflight=NULL, last_error=?, locked_by=NULL, locked_until=NULL, updated_at=? WHERE id=?", attempts, runAt, e.message, now(), job.id],
      ['UPDATE posts SET attempts=?, error=?, updated_at=? WHERE id=?', attempts, `Attempt ${attempts}/${S.maxAttempts} failed: ${e.message} — retrying at ${new Date(runAt).toISOString()}`, now(), job.post_id],
      posts.eventStmt(job.post_id, 'warn', `Attempt ${attempts} failed (${e.message}); retrying in ${Math.round(delay / 1000)}s`),
    ]);
  }

  const safeLabel = (s) => { try { return JSON.parse(s).label; } catch { return 'publishing'; } };

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await recoverStale();
      while (active.size < S.concurrency) {
        const job = await claim();
        if (!job) break;
        active.add(job.id);
        run(job)
          .catch((e) => log('error', `job ${job.id}: ${e.stack || e}`))
          .finally(() => active.delete(job.id));
      }
    } finally {
      ticking = false;
    }
  }

  /**
   * One bounded scheduler pass (Cloudflare Cron Trigger): recover expired locks, fail missed posts,
   * then claim and advance jobs sequentially while the invocation budget lasts.
   * @returns {Promise<{steps:number}>}
   */
  async function runOnce({ budget, maxSteps = cfg.budget?.jobSteps ?? 6 } = {}) {
    await recoverStale();
    await failMissed();
    let steps = 0;
    while (steps < maxSteps && (!budget || budget.has(STEP_COST))) {
      const job = await claim();
      if (!job) break;
      steps++;
      active.add(job.id);
      try { await run(job, { budget }); } catch (e) { log('error', `job ${job.id}: ${e.stack || e}`); } finally { active.delete(job.id); }
    }
    return { steps };
  }

  /** Wait until no job is running and nothing is due (tests / CLI). */
  async function drain(maxMs = 30000) {
    const end = now() + maxMs;
    while (now() < end) {
      await tick();
      const open = (await db.get("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running')")).n;
      if (!active.size && !open) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  return {
    workerId,
    tick,
    drain,
    claim,
    run,
    runOnce,
    recoverStale,
    failMissed,
    async boot() {
      await recoverStale({ boot: true });
      return failMissed();
    },
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch((e) => log('error', `tick: ${e.stack || e}`)), S.tickMs);
      timer.unref?.();
      setTimeout(() => tick().catch(() => {}), 0);
    },
    /** Notify the loop that something became due right now (post-now) to avoid waiting a full tick. */
    poke() { if (timer) setTimeout(() => tick().catch(() => {}), 0); },
    async stop(waitMs = 10000) {
      if (timer) clearInterval(timer);
      timer = null;
      const end = now() + waitMs;
      while (active.size && now() < end) await new Promise((r) => setTimeout(r, 50));
    },
    activeCount: () => active.size,
  };
}

/** Workers throws plain Errors when an invocation exceeds its subrequest / D1 query allowance. */
export const isBudgetError = (e) => /too many (subrequests|api requests)|subrequest limit|query limit|exceeded.*(subrequests|queries)/i.test(String(e?.message || e));
