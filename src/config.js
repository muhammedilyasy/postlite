// Portable configuration: turns an env-like object (process.env on Node, the Worker `env` on
// Cloudflare) into a config object. No filesystem access here; src/node/config.js adds the paths.
import { normalizeTeamDomain, parseEmails } from './access.js';

const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : typeof v === 'object' ? '' : String(v));

/**
 * @param {Record<string, any>} env
 * @param {{platform?: 'node'|'workers'}} [opts]
 */
export function getConfig(env = {}, { platform = 'node' } = {}) {
  const E = (k) => str(env[k]);
  const workers = platform === 'workers';
  const port = num(E('PORT'), 4100);
  const host = E('HOST') || '127.0.0.1';
  const publicUrl = trimSlash(E('PUBLIC_URL') || (workers ? '' : `http://${host}:${port}`));
  return {
    platform,
    port,
    host,
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    trustProxy: E('TRUST_PROXY') === '1',
    sessionSecret: E('SESSION_SECRET'),
    tokenEncKey: E('TOKEN_ENC_KEY'),
    adminPasswordHash: E('ADMIN_PASSWORD_HASH'), // optional; DB setting wins (Workers: `node bin/postlite.js hash-password`)
    defaultTimezone: E('DEFAULT_TIMEZONE') || 'Asia/Kolkata',
    maxUploadMb: num(E('MAX_UPLOAD_MB'), 2048),
    base64MaxMb: num(E('BASE64_UPLOAD_MAX_MB'), workers ? 8 : 25),
    ffmpegPath: workers ? '' : E('FFMPEG_PATH'),
    ffprobePath: workers ? '' : E('FFPROBE_PATH'),
    graphVersion: E('GRAPH_API_VERSION') || 'v25.0',
    meta: { appId: E('META_APP_ID'), appSecret: E('META_APP_SECRET') },
    instagram: { appId: E('INSTAGRAM_APP_ID'), appSecret: E('INSTAGRAM_APP_SECRET') },
    google: { clientId: E('GOOGLE_CLIENT_ID'), clientSecret: E('GOOGLE_CLIENT_SECRET') },
    // Upstream base URLs — overridable so tests / local verification can point at fake servers.
    urls: {
      graph: trimSlash(E('GRAPH_BASE_URL') || 'https://graph.facebook.com'),
      facebookWww: trimSlash(E('FACEBOOK_WWW_URL') || 'https://www.facebook.com'),
      igGraph: trimSlash(E('IG_GRAPH_BASE_URL') || 'https://graph.instagram.com'),
      igApi: trimSlash(E('IG_API_BASE_URL') || 'https://api.instagram.com'),
      igWww: trimSlash(E('IG_WWW_URL') || 'https://www.instagram.com'),
      googleAuth: trimSlash(E('GOOGLE_AUTH_URL') || 'https://accounts.google.com'),
      googleToken: trimSlash(E('GOOGLE_TOKEN_URL') || 'https://oauth2.googleapis.com'),
      youtube: trimSlash(E('YOUTUBE_API_BASE_URL') || 'https://www.googleapis.com'),
      ytAnalytics: trimSlash(E('YOUTUBE_ANALYTICS_BASE_URL') || 'https://youtubeanalytics.googleapis.com'),
    },
    scheduler: {
      tickMs: num(E('SCHEDULER_TICK_MS'), 15000),
      graceMinutes: num(E('MISSED_GRACE_MINUTES'), 360),
      maxAttempts: num(E('MAX_ATTEMPTS'), 3),
      backoffBaseMs: num(E('BACKOFF_BASE_MS'), 60000),
      pollMs: num(E('POLL_INTERVAL_MS'), 10000),
      lockTtlMs: num(E('LOCK_TTL_MS'), (workers ? 5 : 15) * 60000),
      maxPendingMs: num(E('MAX_PENDING_MINUTES'), 60) * 60000,
      concurrency: num(E('SCHEDULER_CONCURRENCY'), workers ? 1 : 2),
      stepBudgetMs: num(E('STEP_BUDGET_MS'), 4 * 60000), // max wall time of one upload step (YouTube chunks)
    },
    analytics: {
      intervalHours: num(E('ANALYTICS_INTERVAL_HOURS'), 6),
      backfillDays: num(E('ANALYTICS_BACKFILL_DAYS'), 30),
      recentPosts: num(E('ANALYTICS_RECENT_POSTS'), 25),
      // Chunking (Workers): account metrics are fetched in windows of N days, post metrics N posts per step.
      windowDays: num(E('ANALYTICS_WINDOW_DAYS'), workers ? 5 : 0), // 0 = whole range at once
      postsPerStep: num(E('ANALYTICS_POSTS_PER_STEP'), workers ? 6 : 0), // 0 = all at once
    },
    // Per-invocation budgets on Workers Free (50 subrequests, 50 D1 queries). Ignored on Node.
    budget: {
      fetches: num(E('CF_SUBREQUEST_BUDGET'), 45),
      queries: num(E('CF_D1_QUERY_BUDGET'), 45),
      jobSteps: num(E('CF_MAX_JOB_STEPS'), 6),
      webhooks: num(E('CF_MAX_WEBHOOKS_PER_TICK'), 8),
    },
    // Web UI login: built-in password (default) or Cloudflare Zero Trust Access (docs/setup/cloudflare-access.md).
    auth: {
      mode: String(E('AUTH_MODE') || 'password').trim().toLowerCase(),
      teamDomain: normalizeTeamDomain(E('CF_ACCESS_TEAM_DOMAIN')),
      aud: String(E('CF_ACCESS_AUD')).trim(),
      allowedEmails: parseEmails(E('ALLOWED_EMAILS')),
      certsUrl: E('CF_ACCESS_CERTS_URL'), // testing only; default https://<team>/cdn-cgi/access/certs
      clockSkewSec: num(E('CF_ACCESS_CLOCK_SKEW_SEC'), 60),
      jwksTimeoutMs: num(E('CF_ACCESS_JWKS_TIMEOUT_MS'), 5000),
      jwksMinRefreshMs: num(E('CF_ACCESS_JWKS_MIN_REFRESH_MS'), 10000),
    },
    // Direct-to-R2 uploads with presigned S3 URLs (Workers). Without these, parts go through the Worker.
    r2: {
      accountId: E('R2_ACCOUNT_ID'),
      accessKeyId: E('R2_ACCESS_KEY_ID'),
      secretAccessKey: E('R2_SECRET_ACCESS_KEY'),
      bucket: E('R2_BUCKET_NAME'),
      endpoint: trimSlash(E('R2_S3_ENDPOINT')), // default https://<account>.r2.cloudflarestorage.com
    },
    upload: {
      partSizeMb: num(E('UPLOAD_PART_MB'), workers ? 50 : 50),
      sessionHours: num(E('UPLOAD_SESSION_HOURS'), 24),
    },
    allowPrivateMediaUrls: E('ALLOW_PRIVATE_MEDIA_URLS') === '1',
    webhooks: { backoffMs: num(E('WEBHOOK_BACKOFF_MS'), 30000), maxAttempts: num(E('WEBHOOK_MAX_ATTEMPTS'), 6) },
    youtubeChunkBytes: num(E('YOUTUBE_CHUNK_BYTES'), (workers ? 64 : 8) * 1024 * 1024),
    youtubeMaxBytesPerStep: num(E('YOUTUBE_MAX_BYTES_PER_STEP'), workers ? 512 * 1024 * 1024 : 0), // 0 = unlimited
    fetchTimeoutMs: num(E('FETCH_TIMEOUT_MS'), 120000),
  };
}
