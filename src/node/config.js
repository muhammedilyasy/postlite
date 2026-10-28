// Node configuration: .env loading and filesystem paths on top of the portable src/config.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig as portableConfig } from '../config.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

export function getConfig(env = process.env) {
  const cfg = portableConfig(env, { platform: 'node' });
  const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');
  cfg.dataDir = dataDir;
  cfg.dbFile = path.join(dataDir, 'postlite.sqlite');
  cfg.uploadDir = path.join(dataDir, 'uploads');
  return cfg;
}
