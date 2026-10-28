// Test helpers: temp app instance wired to the fake providers, synthetic media files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFake } from './fake/server.js';
import { getConfig } from '../src/node/config.js';
import { createNodeCore as createCore, hashPassword } from '../src/node/core.js';
import { createServer } from '../src/http/server.js';

export const PASSWORD = 'correct horse battery';

/** Minimal JPEG with an SOF0 header (enough for sniffing + dimension parsing). */
export function makeJpeg(width = 1080, height = 1080, padBytes = 2000) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(padBytes, 0x11), Buffer.from([0xff, 0xd9])]);
}

export function makePng(width = 800, height = 600) {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function box(type, ...payload) {
  const body = Buffer.concat(payload);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}

/** Synthetic MP4: ftyp + moov(mvhd, trak(tkhd, mdia(hdlr vide))) + mdat. */
export function makeMp4({ width = 1080, height = 1920, seconds = 20, mdatBytes = 300000 } = {}) {
  const ftyp = box('ftyp', Buffer.from('isom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2mp41'));
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16); // duration
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(0x00010000, 40); // matrix a = 1.0
  tkhd.writeUInt32BE(0x00010000, 56); // matrix d = 1.0
  tkhd.writeUInt32BE(0x40000000, 72); // matrix w
  tkhd.writeUInt32BE(width * 65536, 76);
  tkhd.writeUInt32BE(height * 65536, 80);
  const hdlr = Buffer.alloc(25);
  hdlr.write('vide', 8, 'latin1');
  const moov = box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd), box('mdia', box('hdlr', hdlr))));
  return Buffer.concat([ftyp, moov, box('mdat', Buffer.alloc(mdatBytes, 7))]);
}

export async function createTestApp({ env = {}, listen = true } = {}) {
  const fake = await startFake();
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'postlite-test-'));
  const cfg = getConfig({
    DATA_DIR: dir,
    PORT: '0',
    TOKEN_ENC_KEY: 'test-token-encryption-key-0123456789',
    META_APP_ID: 'meta-app', META_APP_SECRET: 'meta-secret',
    INSTAGRAM_APP_ID: 'ig-app', INSTAGRAM_APP_SECRET: 'ig-secret',
    GOOGLE_CLIENT_ID: 'g-client', GOOGLE_CLIENT_SECRET: 'g-secret',
    X_CLIENT_ID: 'x-client-id-123', X_CLIENT_SECRET: 'x-client-secret', LINKEDIN_CLIENT_ID: 'liclient123', LINKEDIN_CLIENT_SECRET: 'li-secret-xyz',
    SCHEDULER_TICK_MS: '50', POLL_INTERVAL_MS: '20', BACKOFF_BASE_MS: '30', MAX_ATTEMPTS: '3',
    YOUTUBE_CHUNK_BYTES: String(256 * 1024),
    ALLOW_PRIVATE_MEDIA_URLS: '1',
    WEBHOOK_BACKOFF_MS: '20',
    WEBHOOK_MAX_ATTEMPTS: '4',
    ANALYTICS_BACKFILL_DAYS: '3',
    ...fake.env(),
    ...env,
  });
  const root = createCore(cfg, { log: () => {} });
  // Tests talk to the password-mode owner workspace unless they create others (see isolation tests).
  const core = root.scope('owner');
  await root.db.setSetting('admin_password', hashPassword(PASSWORD));
  await core.prepare();
  let server = null;
  let base = null;
  if (listen) {
    server = createServer(root);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    cfg.publicUrl = base; // media URLs must point at the live test server so the fake can fetch them
  }
  const app = {
    fake, core, root, cfg, dir, server, base,
    seed(provider, extra = {}) {
      const defaults = {
        facebook: { external_id: 'page1', name: 'Test Page', access_token: 'page1-token', refresh_token: 'user-long' },
        instagram: { external_id: 'ig1', name: 'Test IG', username: 'testig', access_token: 'page1-token', refresh_token: 'user-long', meta: { page_id: 'page1' } },
        'instagram-standalone': { external_id: 'igs1', name: 'Standalone IG', username: 'standalone_ig', access_token: 'ig-long', refresh_token: 'ig-long', token_expires_at: Date.now() + 50 * 86400000 },
        youtube: { external_id: 'UC1', name: 'Test Channel', access_token: 'ya29.initial', refresh_token: '1//refresh', token_expires_at: Date.now() + 3600000 },
      }[provider];
      if (!defaults) throw new Error(`seed(${provider}): connect X/LinkedIn through the OAuth flow (app.connect)`);
      return core.integrations.upsert(provider, { ...defaults, ...extra });
    },
    async upload(buf, name) {
      return core.media.save(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), name);
    },
    /** Full OAuth connect against the fake (consent auto-approves). Returns { status, location, accounts }. */
    async connect(provider, { reconnect = null, session = null } = {}) {
      const s = session || await app.login();
      const r1 = await fetch(`${base}/oauth/${provider}/start${reconnect ? `?reconnect=${reconnect}` : ''}`, { redirect: 'manual', headers: { cookie: s.cookie } });
      const auth = r1.headers.get('location');
      if (!auth) return { status: r1.status, text: await r1.text() };
      const r2 = await fetch(auth, { redirect: 'manual' });
      const cb = r2.headers.get('location');
      const r3 = await fetch(cb, { redirect: 'manual', headers: { cookie: s.cookie } });
      const text = await r3.text();
      return { status: r3.status, location: r3.headers.get('location'), text, accounts: (await core.integrations.list()).filter((a) => a.provider === provider) };
    },
    async login() {
      const r1 = await fetch(`${base}/login`);
      const csrfCookie = /pl_lcsrf=([^;]+)/.exec(r1.headers.get('set-cookie'))[1];
      const html = await r1.text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
      const r2 = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `pl_lcsrf=${csrfCookie}` }, body: new URLSearchParams({ password: PASSWORD, csrf }) });
      const sid = /pl_sid=([^;]+)/.exec(r2.headers.get('set-cookie') || '')?.[1];
      if (!sid) throw new Error(`login failed ${r2.status}`);
      const s = await (await fetch(`${base}/api/v1/session`, { headers: { cookie: `pl_sid=${sid}` } })).json();
      return { cookie: `pl_sid=${sid}`, csrf: s.csrf };
    },
    async api(method, p, { key, session, body, headers = {} } = {}) {
      const h = { ...headers };
      if (key) h.authorization = `Bearer ${key}`;
      if (session) { h.cookie = session.cookie; h['x-csrf-token'] = session.csrf; }
      if (body !== undefined) h['content-type'] = 'application/json';
      const res = await fetch(`${base}/api/v1${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, text, headers: res.headers };
    },
    async close() {
      await core.scheduler.stop(2000);
      core.webhooks.stop();
      core.analytics.stop();
      if (server) await new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
      core.db.close();
      await fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return app;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 8000, interval = 25 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`waitFor timed out (last=${JSON.stringify(last)})`);
}
