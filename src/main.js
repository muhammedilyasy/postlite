// Node server entry: load config, create core, start HTTP + background loops, handle shutdown.
import { getConfig } from './node/config.js';
import { createNodeCore, makeLogger } from './node/core.js';
import { createServer } from './http/server.js';
import { validateAuthConfig } from './access.js';

export async function start({ env = process.env } = {}) {
  const cfg = getConfig(env);
  const log = makeLogger(env.LOG_LEVEL || 'info');
  if (!cfg.tokenEncKey) {
    log('error', 'TOKEN_ENC_KEY is not set. Run `node bin/postlite.js gen-secrets` and put the values in .env');
    process.exit(1);
  }
  try { validateAuthConfig(cfg); } catch (e) {
    log('error', e.message);
    process.exit(1);
  }
  const core = createNodeCore(cfg, { log });
  const server = createServer(core);
  await new Promise((resolve) => server.listen(cfg.port, cfg.host, resolve));
  await core.startBackground();
  log('info', `postlite listening on http://${cfg.host}:${cfg.port} (public URL ${cfg.publicUrl})`);
  if (cfg.auth.mode === 'cloudflare-access') log('info', `auth: Cloudflare Access (${cfg.auth.teamDomain}), ${cfg.auth.allowedEmails.length} allowed email(s); password login disabled`);
  else if (!(await core.db.getSetting('admin_password'))) log('warn', 'No admin password yet: run `node bin/postlite.js set-password`');
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
