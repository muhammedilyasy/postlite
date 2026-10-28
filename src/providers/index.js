// Provider registry. To add a platform, implement the same shape as ./facebook.js:
//   id, label, scopes, canRefresh, isConfigured(cfg), authUrl(cfg, {state, redirectUri, challenge}),
//   exchange(cfg, {code, redirectUri, verifier}) → accounts[], refresh?(cfg, integration), healthCheck(ctx),
//   publishStart(ctx) / publishCheck(ctx, data) / publishFinalize(ctx, data) / recover?(ctx, data),
//   comment?(ctx, externalId, message), accountAnalytics?(ctx, range), recentPosts?(ctx, n), postAnalytics?(ctx, item)
//   Optional: refreshMarginMs (renew this long before expiry), canRefreshFor(integration) (refresh token present?)
import { facebook } from './facebook.js';
import { instagram, instagramStandalone } from './instagram.js';
import { youtube } from './youtube.js';
import { x } from './x.js';
import { linkedin, linkedinPage } from './linkedin.js';

export const providers = {
  youtube,
  facebook,
  instagram,
  'instagram-standalone': instagramStandalone,
  x,
  linkedin,
  'linkedin-page': linkedinPage,
};

export function getProvider(id) {
  const p = providers[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
