// Analytics notices: turn "why is this metric missing" reasons into ONE actionable line per account.
// Providers report missing metrics as { metric: reason } (analytics_status.unavailable). Reasons that
// share a cause the owner can fix (an API switched off in Google Cloud, a permission not granted) are
// grouped into a notice { code, text, url?, action?, metrics[] } so the UI shows one clear sentence
// with a link instead of a "not available" next to every number.

const GOOGLE_CONSOLE = /https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"'\\<>]+/;

/** Google "API has not been used in project N before or it is disabled" (reason accessNotConfigured / SERVICE_DISABLED). */
export function googleApiDisabled(err) {
  const text = `${err?.message || ''} ${err?.body || ''}`;
  if (!/has not been used in project|it is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(text)) return null;
  let url = (GOOGLE_CONSOLE.exec(text) || [])[0] || '';
  url = url.replace(/[.,;)\]]+$/, '');
  const project = (/project[= ](\d{4,})/i.exec(text) || [])[1] || '';
  if (!url && project) url = `https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com?project=${project}`;
  return { url, project };
}

/** Readable list: "a", "a and b", "a, b and c". */
export const listWords = (words) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

const PERMISSION = /Missing permission|requires? .{0,60}permission|insufficientPermissions|insufficient (?:scope|permission)|not authorized to access|scope/i;

/**
 * Notices from an `unavailable` blob ({ account, posts, notices? }). Provider-set notices win;
 * otherwise permission-type reasons become one "reconnect and allow" notice.
 */
export function buildNotices(un, { provider, label } = {}) {
  const out = [...(un?.notices || [])];
  const covered = new Set(out.flatMap((n) => n.metrics || []));
  const perm = [];
  for (const scope of ['account', 'posts']) {
    for (const [m, why] of Object.entries(un?.[scope] || {})) {
      if (m.startsWith('_') || covered.has(m)) continue;
      if (PERMISSION.test(String(why))) perm.push(m);
    }
  }
  if (perm.length && !out.some((n) => n.code === 'missing_permission')) {
    out.push({ code: 'missing_permission', action: 'reconnect', metrics: [...new Set(perm)],
      text: `Reconnect this ${label || provider || 'account'} and allow every permission postlite asks for to see ${listWords([...new Set(perm)].slice(0, 4).map((m) => m.replace(/_/g, ' ')))}.` });
  }
  return out;
}
