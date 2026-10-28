// Per-invocation resource meter. Cloudflare Workers Free allows 50 external subrequests and 50 D1
// queries per invocation (developers.cloudflare.com/workers/platform/limits/#subrequests,
// developers.cloudflare.com/d1/platform/limits/). Long-running work (scheduler, analytics, webhooks)
// checks the meter between small steps and hands the rest to the next cron tick.
// On Node the meter is unlimited, so behaviour is unchanged.

export function createMeter({ fetches = Infinity, queries = Infinity, storageOps = Infinity } = {}) {
  const m = {
    limits: { fetches, queries, storageOps },
    used: { fetches: 0, queries: 0, storageOps: 0 },
    startedAt: Date.now(),
    /** true when at least `need` of every resource is still available */
    has({ fetches: f = 0, queries: q = 0, storageOps: s = 0 } = {}) {
      return m.used.fetches + f <= m.limits.fetches && m.used.queries + q <= m.limits.queries && m.used.storageOps + s <= m.limits.storageOps;
    },
    reset() { m.used = { fetches: 0, queries: 0, storageOps: 0 }; m.startedAt = Date.now(); },
    snapshot: () => ({ ...m.used }),
  };
  return m;
}

/** Process-wide meter used by the fetch wrapper and the DB/storage adapters. Replaced per cron invocation on Workers. */
export const meter = { current: createMeter() };

export function useMeter(m) {
  meter.current = m;
  return m;
}

/** fetch() that counts against the current invocation's subrequest budget. */
export function meteredFetch(input, init) {
  meter.current.used.fetches++;
  return globalThis.fetch(input, init);
}
