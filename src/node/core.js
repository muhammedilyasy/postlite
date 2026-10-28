// Node runtime: wires node:sqlite + local disk + scrypt/PBKDF2 passwords + ffmpeg hooks + DNS checks.
import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { createCore } from '../core.js';
import { openDb } from './db.js';
import { createFsStorage } from './storage.js';
import { ffprobe, makePoster } from './ffmpeg.js';
import { ROOT } from './config.js';
import { hashPasswordPbkdf2, verifyPasswordPbkdf2 } from '../crypto.js';

export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

export function makeLogger(level = process.env.LOG_LEVEL || 'info') {
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  return (lvl, msg) => {
    if ((order[lvl] || 20) < (order[level] || 20)) return;
    process.stderr.write(`${new Date().toISOString()} ${lvl.toUpperCase()} ${msg}\n`);
  };
}

// ---- passwords: scrypt (unchanged format) + PBKDF2 (portable, accepted for DBs moved from Workers) ----
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (stored && String(stored).startsWith('pbkdf2$')) return verifyPasswordPbkdf2(password, stored);
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, N, r, p, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, got);
}

export const nodeRuntime = {
  platform: 'node',
  version: VERSION,
  hooks: { ffprobe, makePoster },
  passwords: { hash: async (pw) => hashPassword(pw), verify: verifyPassword, hashPortable: hashPasswordPbkdf2 },
  async resolveHost(host) {
    if (net.isIP(host)) return [host];
    return (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  },
  uptime: () => process.uptime(),
};

/** Node core: SQLite file + data/uploads. */
export function createNodeCore(cfg, { log = makeLogger() } = {}) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDb(cfg.dbFile);
  const storage = createFsStorage(cfg.uploadDir);
  return createCore({ cfg, db, storage, runtime: nodeRuntime, log });
}
