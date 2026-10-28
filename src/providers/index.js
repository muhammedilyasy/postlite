// Provider registry. To add a platform, implement the same shape as ./facebook.js:
//   id, label, scopes, canRefresh, isConfigured(cfg), authUrl(cfg, {state, redirectUri, challenge}),
//   exchange(cfg, {code, redirectUri, verifier}) → accounts[], refresh?(cfg, integration), healthCheck(ctx),
//   publishStart(ctx) / publishCheck(ctx, data) / publishFinalize(ctx, data) / recover?(ctx, data),
//   comment?(ctx, externalId, message), accountAnalytics?(ctx, range), recentPosts?(ctx, n), postAnalytics?(ctx, item)
import { facebook } from './facebook.js';
import { instagram, instagramStandalone } from './instagram.js';
import { youtube } from './youtube.js';

export const providers = {
  youtube,
  facebook,
  instagram,
  'instagram-standalone': instagramStandalone,
};

export function getProvider(id) {
  const p = providers[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
