// Server entry: load config, create core, start HTTP + background loops, handle shutdown.
import { getConfig } from './config.js';
import { createCore, makeLogger } from './core.js';
import { createServer } from './http/server.js';

export async function start({ env = process.env } = {}) {
  const cfg = getConfig(env);
  const log = makeLogger(env.LOG_LEVEL || 'info');
  if (!cfg.tokenEncKey) {
    log('error', 'TOKEN_ENC_KEY is not set. Run `node bin/postlite.js gen-secrets` and put the values in .env');
    process.exit(1);
  }
  const core = createCore(cfg, { log });
  const server = createServer(core);
  await new Promise((resolve) => server.listen(cfg.port, cfg.host, resolve));
  core.startBackground();
  log('info', `postlite listening on http://${cfg.host}:${cfg.port} (public URL ${cfg.publicUrl})`);
  if (!core.db.getSetting('admin_password')) log('warn', 'No admin password yet: run `node bin/postlite.js set-password`');
  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log('info', `${sig} received, shutting down`);
    server.close();
    server.closeAllConnections?.();
    await core.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return { core, server };
}
