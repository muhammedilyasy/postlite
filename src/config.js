// Configuration: reads process.env (optionally pre-populated from a .env file).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env parser (KEY=VALUE, optional quotes, # comments). Never overrides real env. */
export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

export function getConfig(env = process.env) {
  const port = num(env.PORT, 4100);
  const host = env.HOST || '127.0.0.1';
  const publicUrl = trimSlash(env.PUBLIC_URL || `http://${host}:${port}`);
  const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');
  return {
    port,
    host,
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    dataDir,
    dbFile: path.join(dataDir, 'postlite.sqlite'),
    uploadDir: path.join(dataDir, 'uploads'),
    sessionSecret: env.SESSION_SECRET || '',
    tokenEncKey: env.TOKEN_ENC_KEY || '',
    defaultTimezone: env.DEFAULT_TIMEZONE || 'Asia/Kolkata',
    maxUploadMb: num(env.MAX_UPLOAD_MB, 2048),
    ffmpegPath: env.FFMPEG_PATH || '',
    ffprobePath: env.FFPROBE_PATH || '',
    graphVersion: env.GRAPH_API_VERSION || 'v25.0',
    meta: { appId: env.META_APP_ID || '', appSecret: env.META_APP_SECRET || '' },
    instagram: { appId: env.INSTAGRAM_APP_ID || '', appSecret: env.INSTAGRAM_APP_SECRET || '' },
    google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' },
    // Upstream base URLs — overridable so tests / local verification can point at fake servers.
    urls: {
      graph: trimSlash(env.GRAPH_BASE_URL || 'https://graph.facebook.com'),
      facebookWww: trimSlash(env.FACEBOOK_WWW_URL || 'https://www.facebook.com'),
      igGraph: trimSlash(env.IG_GRAPH_BASE_URL || 'https://graph.instagram.com'),
      igApi: trimSlash(env.IG_API_BASE_URL || 'https://api.instagram.com'),
      igWww: trimSlash(env.IG_WWW_URL || 'https://www.instagram.com'),
      googleAuth: trimSlash(env.GOOGLE_AUTH_URL || 'https://accounts.google.com'),
      googleToken: trimSlash(env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com'),
      youtube: trimSlash(env.YOUTUBE_API_BASE_URL || 'https://www.googleapis.com'),
      ytAnalytics: trimSlash(env.YOUTUBE_ANALYTICS_BASE_URL || 'https://youtubeanalytics.googleapis.com'),
    },
    scheduler: {
      tickMs: num(env.SCHEDULER_TICK_MS, 15000),
      graceMinutes: num(env.MISSED_GRACE_MINUTES, 360),
      maxAttempts: num(env.MAX_ATTEMPTS, 3),
      backoffBaseMs: num(env.BACKOFF_BASE_MS, 60000),
      pollMs: num(env.POLL_INTERVAL_MS, 10000),
      lockTtlMs: num(env.LOCK_TTL_MS, 15 * 60000),
      maxPendingMs: num(env.MAX_PENDING_MINUTES, 60) * 60000,
      concurrency: num(env.SCHEDULER_CONCURRENCY, 2),
    },
    analytics: {
      intervalHours: num(env.ANALYTICS_INTERVAL_HOURS, 6),
      backfillDays: num(env.ANALYTICS_BACKFILL_DAYS, 30),
      recentPosts: num(env.ANALYTICS_RECENT_POSTS, 25),
    },
    allowPrivateMediaUrls: env.ALLOW_PRIVATE_MEDIA_URLS === '1',
    webhooks: { backoffMs: num(env.WEBHOOK_BACKOFF_MS, 30000), maxAttempts: num(env.WEBHOOK_MAX_ATTEMPTS, 6) },
    youtubeChunkBytes: num(env.YOUTUBE_CHUNK_BYTES, 8 * 1024 * 1024),
    fetchTimeoutMs: num(env.FETCH_TIMEOUT_MS, 120000),
  };
}
