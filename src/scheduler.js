// In-process scheduler: jobs table + atomic claiming + phased publish state machine.
//
// Guarantees:
//  * A job is claimed with a single conditional UPDATE inside BEGIN IMMEDIATE, so two loops (or two
//    processes sharing the DB) can never run the same job concurrently.
//  * Every phase result (pending data) is persisted before the next upstream call, so a crash resumes
//    from the last safe point.
//  * Irreversible upstream calls set jobs.inflight first. If the process dies mid-call, recovery asks
//    the provider whether the post went live (IG container status, YouTube session probe); when that
//    is impossible (Facebook), the post is failed with an explicit "check before retrying" message
//    instead of risking a duplicate.
import { randomToken } from './crypto.js';
import { isProviderError } from './providers/http.js';
import { getProvider } from './providers/index.js';

export function createScheduler({ db, cfg, media, integrations, posts, log = () => {}, onPublished = () => {}, onFailed = () => {} }) {
  const S = cfg.scheduler;
  const workerId = `w-${process.pid}-${randomToken(4)}`;
  const active = new Set();
  let timer = null;
  let ticking = false;

  const now = () => Date.now();

  function claim() {
    return db.tx(() => {
      const t = now();
      const row = db.get("SELECT * FROM jobs WHERE state = 'queued' AND run_at <= ? ORDER BY run_at, id LIMIT 1", t);
      if (!row) return null;
      const r = db.run("UPDATE jobs SET state='running', locked_by=?, locked_until=?, updated_at=? WHERE id=? AND state='queued'", workerId, t + S.lockTtlMs, t, row.id);
      if (r.changes !== 1) return null;
      db.run("UPDATE posts SET status='publishing', updated_at=? WHERE id=?", t, row.post_id);
      return { ...row, state: 'running', locked_by: workerId };
    });
  }

  /** Release jobs whose lock expired (or all running jobs at boot). */
  function recoverStale({ boot = false } = {}) {
    const t = now();
    const rows = boot
      ? db.all("SELECT * FROM jobs WHERE state = 'running'")
      : db.all("SELECT * FROM jobs WHERE state = 'running' AND locked_until < ?", t);
    for (const j of rows) {
      if (active.has(j.id)) continue;
      const phase = j.inflight ? 'recover' : j.phase;
      db.run("UPDATE jobs SET state='queued', phase=?, run_at=?, locked_by=NULL, locked_until=NULL, updated_at=? WHERE id=? AND state='running'", phase, t, t, j.id);
      posts.event(j.post_id, 'warn', j.inflight ? `Publishing was interrupted during "${JSON.parse(j.inflight).label}"; checking whether it went live` : 'Publishing was interrupted; resuming');
      log('warn', `recovered stale job ${j.id} (phase ${phase})`);
    }
  }

  /** At boot: fail scheduled posts that are older than the grace window (server was down). */
  function failMissed() {
    const cutoff = now() - S.graceMinutes * 60000;
    const rows = db.all("SELECT * FROM jobs WHERE state = 'queued' AND phase = 'start' AND attempts = 0 AND run_at < ?", cutoff);
    for (const j of rows) {
      fail(j, `Missed: the server was not running at the scheduled time (more than ${S.graceMinutes} minutes ago). Use Retry to publish now.`);
    }
    return rows.length;
  }

  function persist(job, fields) {
    const sets = Object.keys(fields).map((k) => `${k}=?`).join(', ');
    db.run(`UPDATE jobs SET ${sets}, updated_at=? WHERE id=?`, ...Object.values(fields), now(), job.id);
    Object.assign(job, fields);
  }

  function fail(job, message) {
    db.tx(() => {
      db.run("UPDATE posts SET status='failed', error=?, updated_at=? WHERE id=?", String(message).slice(0, 2000), now(), job.post_id);
      db.run("UPDATE jobs SET state='dead', inflight=NULL, last_error=?, locked_by=NULL, locked_until=NULL, updated_at=? WHERE id=?", String(message).slice(0, 2000), now(), job.id);
    });
    posts.event(job.post_id, 'error', message);
    log('warn', `post ${job.post_id} failed: ${message}`);
    try { onFailed(job.post_id, message); } catch {}
  }

  async function complete(job, ctx, provider, r) {
    const t = now();
    db.tx(() => {
      db.run("UPDATE posts SET status='published', external_id=?, published_url=?, published_at=?, error=NULL, warning=?, attempts=?, updated_at=? WHERE id=?",
        r.externalId || null, r.url || null, t, r.warning || null, job.attempts, t, job.post_id);
      db.run("UPDATE jobs SET state='done', inflight=NULL, pending_data=NULL, locked_by=NULL, locked_until=NULL, updated_at=? WHERE id=?", t, job.id);
    });
    posts.event(job.post_id, 'info', `Published${r.url ? `: ${r.url}` : ''}`);
    if (r.warning) posts.event(job.post_id, 'warn', r.warning);
    log('info', `post ${job.post_id} published ${r.externalId || ''}`);
    // First comment (best effort, never fails the post).
    const fc = String(ctx.post.settings.first_comment || '').trim();
    if (fc && provider.comment && r.externalId && ctx.post.settings.post_type !== 'story') {
      try {
        await provider.comment(ctx, r.externalId, fc);
        posts.event(job.post_id, 'info', 'First comment added');
      } catch (e) {
        const w = [r.warning, `Post is live, but the first comment failed: ${e.message}`].filter(Boolean).join(' · ');
        db.run('UPDATE posts SET warning=? WHERE id=?', w, job.post_id);
        posts.event(job.post_id, 'warn', w);
      }
    }
    try { onPublished(job.post_id); } catch {}
  }

  function buildCtx(job, post, integ) {
    const c = posts.composed(post);
    return {
      cfg,
      integration: integ,
      token: integ.access_token,
      post: { id: post.id, caption: c.caption, media: c.media, settings: c.settings, thumbnail: c.thumbnail },
      thumbnail: c.thumbnail,
      mediaUrl: (m) => media.publicUrl(m),
      mediaPath: (m) => media.path(m),
      irreversible: async (label) => persist(job, { inflight: JSON.stringify({ label, at: now(), data: job.pending_data ? 1 : 0 }) }),
      heartbeat: async () => persist(job, { locked_until: now() + S.lockTtlMs }),
    };
  }

  async function run(job) {
    const post = db.get('SELECT p.*, i.provider FROM posts p JOIN integrations i ON i.id = p.integration_id WHERE p.id = ?', job.post_id);
    if (!post) {
      db.run('DELETE FROM jobs WHERE id = ?', job.id);
      return;
    }
    const provider = getProvider(post.provider);
    let refreshed = false;
    let recovering = false;
    let ctx;
    for (let guard = 0; guard < 60; guard++) {
      try {
        if (!ctx) {
          const integ = await integrations.fresh(post.integration_id);
          if (integ.status !== 'active') return fail(job, `${integ.name}: account needs to be reconnected (${integ.status_message || 'token invalid'}).`);
          ctx = buildCtx(job, post, integ);
        }
        const data = job.pending_data ? JSON.parse(job.pending_data) : null;
        let r;
        if (job.phase === 'start') r = await provider.publishStart(ctx);
        else if (job.phase === 'check') r = await provider.publishCheck(ctx, data);
        else if (job.phase === 'finalize') r = await provider.publishFinalize(ctx, data);
        else if (job.phase === 'recover') {
          r = provider.recover ? await provider.recover(ctx, data) : null;
          if (!r) return fail(job, `Publishing was interrupted during "${safeLabel(job.inflight)}" and the platform cannot confirm whether the post went live. Check the account before retrying to avoid a duplicate.`);
          persist(job, { inflight: null });
        } else throw new Error(`Unknown phase ${job.phase}`);

        if (r.status === 'completed') return await complete(job, ctx, provider, r);
        if (r.status === 'ready') {
          persist(job, { phase: 'finalize', pending_data: JSON.stringify(r.data), inflight: null });
          continue;
        }
        if (r.status === 'pending') {
          const pendingSince = job.pending_since || now();
          if (now() - pendingSince > S.maxPendingMs) return fail(job, 'Timed out waiting for the platform to process the media.');
          if (r.delayMs === 0) {
            persist(job, { phase: 'check', pending_data: JSON.stringify(r.data), pending_since: pendingSince, inflight: null, locked_until: now() + S.lockTtlMs });
            continue;
          }
          const runAt = now() + (r.delayMs ?? S.pollMs);
          persist(job, { state: 'queued', phase: 'check', pending_data: JSON.stringify(r.data), pending_since: pendingSince, run_at: runAt, inflight: null, locked_by: null, locked_until: null });
          return;
        }
        throw new Error(`Provider returned unknown status ${r.status}`);
      } catch (e) {
        const kind = isProviderError(e) ? e.kind : 'transient';
        if (!isProviderError(e)) log('error', `job ${job.id} crashed: ${e.stack || e}`);
        if (kind === 'auth' && provider.canRefresh && !refreshed) {
          refreshed = true;
          try {
            const integ = await integrations.refresh(post.integration_id);
            ctx = buildCtx(job, post, integ);
            persist(job, { inflight: null });
            continue;
          } catch (e2) {
            if (e2.kind === 'transient') return retry(job, e2);
            return fail(job, `${e2.message} — reconnect the account.`);
          }
        }
        if (kind === 'unknown_outcome' && provider.recover && !recovering) {
          // Ask the platform whether the irreversible call went through before deciding anything.
          recovering = true;
          posts.event(job.post_id, 'warn', `${e.message} Checking with the platform…`);
          persist(job, { phase: 'recover' });
          continue;
        }
        if (kind === 'auth' || kind === 'disconnect') {
          integrations.markNeedsReconnect(post.integration_id, e.message);
          return fail(job, e.message);
        }
        if (kind === 'transient') return retry(job, e);
        return fail(job, e.message);
      }
    }
    // Too many immediate phase transitions in one claim: hand back to the queue.
    persist(job, { state: 'queued', run_at: now() + S.pollMs, locked_by: null, locked_until: null });
  }

  function retry(job, e) {
    const attempts = job.attempts + 1;
    if (attempts >= S.maxAttempts) return fail(job, `Failed after ${attempts} attempts: ${e.message}`);
    const delay = Math.round(S.backoffBaseMs * 2 ** (attempts - 1) * (1 + Math.random() * 0.1));
    const runAt = now() + delay;
    db.tx(() => {
      db.run("UPDATE jobs SET state='queued', attempts=?, run_at=?, inflight=NULL, last_error=?, locked_by=NULL, locked_until=NULL, updated_at=? WHERE id=?", attempts, runAt, e.message, now(), job.id);
      db.run('UPDATE posts SET attempts=?, error=?, updated_at=? WHERE id=?', attempts, `Attempt ${attempts}/${S.maxAttempts} failed: ${e.message} — retrying at ${new Date(runAt).toISOString()}`, now(), job.post_id);
    });
    posts.event(job.post_id, 'warn', `Attempt ${attempts} failed (${e.message}); retrying in ${Math.round(delay / 1000)}s`);
  }

  const safeLabel = (s) => { try { return JSON.parse(s).label; } catch { return 'publishing'; } };

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      recoverStale();
      while (active.size < S.concurrency) {
        const job = claim();
        if (!job) break;
        active.add(job.id);
        const p = run(job)
          .catch((e) => log('error', `job ${job.id}: ${e.stack || e}`))
          .finally(() => active.delete(job.id));
        p.job = job.id;
      }
    } finally {
      ticking = false;
    }
  }

  /** Wait until no job is running and nothing is due (tests / CLI). */
  async function drain(maxMs = 30000) {
    const end = now() + maxMs;
    while (now() < end) {
      await tick();
      const open = db.get("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running')").n;
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
    recoverStale,
    failMissed,
    boot() {
      recoverStale({ boot: true });
      return failMissed();
    },
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch((e) => log('error', `tick: ${e.stack || e}`)), S.tickMs);
      timer.unref?.();
      setImmediate(() => tick().catch(() => {}));
    },
    /** Notify the loop that something became due right now (post-now) to avoid waiting a full tick. */
    poke() { if (timer) setImmediate(() => tick().catch(() => {})); },
    async stop(waitMs = 10000) {
      if (timer) clearInterval(timer);
      timer = null;
      const end = now() + waitMs;
      while (active.size && now() < end) await new Promise((r) => setTimeout(r, 50));
    },
    activeCount: () => active.size,
  };
}
