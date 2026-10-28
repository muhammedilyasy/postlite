// Settings → Platform apps. A quiet list (like Accounts) that opens one app at a time.
import { h, mount, api, toast, confirmDialog, MARKS, icon, relTime } from './core.js';
import { copyButton, section } from './ui.js';

const STATUS = {
  configured: ['Configured', 's-published'],
  configured_env: ['Configured in .env', 's-published'],
  not_configured: ['Not set up', 's-draft'],
};
const LOGOS = { meta: ['facebook', 'instagram'], instagram: ['instagram'], google: ['youtube'], x: ['x'], linkedin: ['linkedin'], 'linkedin-pages': ['linkedin'] };
const BLURB = {
  meta: 'Facebook Pages and Instagram accounts linked to a Page',
  instagram: 'Instagram accounts that log in directly, no Page needed',
  google: 'YouTube channels, uploads and analytics',
  x: 'X accounts: posts, threads, photos and video (pay-per-use API)',
  linkedin: 'LinkedIn profiles, and Company Pages once the Community Management API is approved',
  'linkedin-pages': 'Optional: a second LinkedIn app that holds Community Management API access',
};
const NAME = { meta: 'Meta', instagram: 'Instagram Login', google: 'Google', x: 'X', linkedin: 'LinkedIn', 'linkedin-pages': 'LinkedIn Pages app' };
const CONSOLE = { meta: 'https://developers.facebook.com/apps', instagram: 'https://developers.facebook.com/apps', google: 'https://console.cloud.google.com/apis/credentials', x: 'https://console.x.com', linkedin: 'https://www.linkedin.com/developers/apps', 'linkedin-pages': 'https://www.linkedin.com/developers/apps' };

const WHY = {
  pages_show_list: 'See the Pages you manage, so you can pick one',
  business_management: 'Reach Pages owned by a Business portfolio',
  pages_manage_posts: 'Publish posts, photos, videos and Reels',
  pages_manage_engagement: 'Add the optional first comment',
  pages_read_engagement: 'Read Page details and post stats',
  read_insights: 'Read Page analytics',
  instagram_basic: 'See the Instagram account linked to the Page',
  instagram_content_publish: 'Publish posts, carousels, Reels and Stories',
  instagram_manage_comments: 'Add the optional first comment',
  instagram_manage_insights: 'Read Instagram analytics',
  instagram_business_basic: 'See your Instagram profile',
  instagram_business_content_publish: 'Publish posts, carousels, Reels and Stories',
  instagram_business_manage_comments: 'Add the optional first comment',
  instagram_business_manage_insights: 'Read Instagram analytics',
  'youtube.upload': 'Upload videos and Shorts',
  'youtube.readonly': 'See your channel and its videos',
  'yt-analytics.readonly': 'Read channel and video analytics',
  'tweet.read': 'Read your posts and their public metrics',
  'tweet.write': 'Publish posts, replies and threads',
  'users.read': 'See your profile (name, @handle, followers)',
  'media.write': 'Upload photos, GIFs and videos',
  'offline.access': 'Stay connected: renew the 2-hour token without logging in again',
  openid: 'Sign in with LinkedIn (identifies your member id)',
  profile: 'See your name and photo',
  email: 'See your email address, to label the account',
  w_member_social: 'Publish posts, images, videos and documents as you',
  r_organization_social: 'Read the Page posts (to find a post after a timeout)',
  w_organization_social: 'Publish posts, images, videos and documents as the Page',
  rw_organization_admin: 'List the Pages you admin and read Page analytics',
};
const shortScope = (s) => s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '');
const mark = (kind) => { const el = h('span', { class: 'pmark' }); el.innerHTML = MARKS[kind]; return el; };
const marks = (app) => h('span', { class: 'pmarks' }, LOGOS[app].map(mark));
const pill = (status) => { const [t, c] = STATUS[status] || STATUS.not_configured; return h('span', { class: `status ${c}` }, h('i', { class: 'sd' }), t); };

function list(apps) {
  return h('div', {},
    h('p', { class: 'muted small apps-intro' }, 'Each platform needs a developer app of your own. Paste its keys here. Secrets are encrypted and never shown again. ',
      h('a', { href: '/docs/setup/', target: '_blank', rel: 'noopener' }, 'Setup guides')),
    h('div', { class: 'plist' }, apps.map((a) => h('a', { class: 'plist-row plist-link', href: `#/settings/apps/${a.app}` },
      marks(a.app),
      h('div', { class: 'plist-text' }, h('div', { class: 'plist-name' }, NAME[a.app] || a.label), h('div', { class: 'plist-desc' }, BLURB[a.app] || '')),
      pill(a.status),
      icon('chevron-right', 16, 'muted')))));
}

function testLine(t) {
  if (!t) return null;
  const cls = t.ok ? (t.verified ? 'ok' : 'warn') : 'err';
  return h('div', { class: `small ${cls} app-test` }, icon(t.ok ? (t.verified ? 'check-circle' : 'info') : 'x-circle', 14), h('span', {}, t.message), t.at ? h('span', { class: 'muted' }, ` · ${relTime(t.at)}`) : null);
}

function detail(a, refresh) {
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'error', 7000); } finally { btn.disabled = false; } };
  const idIn = h('input', { class: 'input mono-input', autocomplete: 'off', spellcheck: 'false', placeholder: a.id_hint });
  idIn.value = a.saved_in_app ? a.client_id : '';
  const secretIn = h('input', { class: 'input mono-input', type: 'password', autocomplete: 'new-password', spellcheck: 'false',
    placeholder: a.secret_saved ? `•••• ${a.secret_hint}  (leave empty to keep)` : 'Paste secret' });

  const save = h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, async () => {
    const body = { client_id: idIn.value.trim() };
    if (secretIn.value.trim()) body.client_secret = secretIn.value.trim();
    await api('POST', `/platform-apps/${a.app}`, body);
    secretIn.value = '';
    toast('Saved', 'success');
    refresh(a.app);
  }) }, 'Save');
  const test = h('button', { class: 'btn', disabled: !a.configured, onclick: (e) => busy(e.currentTarget, async () => {
    const r = await api('POST', `/platform-apps/${a.app}/test`, {});
    toast(r.result.message, r.result.ok ? 'success' : 'error', 7000);
    refresh(a.app);
  }) }, 'Test');

  const head = h('div', { class: 'app-detail-head' },
    h('a', { class: 'back-link small', href: '#/settings/apps' }, icon('chevron-left', 14), 'Platform apps'),
    h('div', { class: 'app-title' }, marks(a.app),
      h('div', { class: 'min0' }, h('h2', { class: 'app-name' }, NAME[a.app] || a.label), h('div', { class: 'muted small' }, BLURB[a.app] || '')),
      pill(a.status)));

  const creds = section('Credentials', { sub: a.status === 'configured_env' ? `Currently read from .env (${a.env_vars.join(', ')}). Saving here takes over.` : 'Takes effect immediately, no restart needed.' },
    h('div', { class: 'form-narrow' },
      h('label', { class: 'field' }, h('span', {}, a.id_label), idIn),
      h('label', { class: 'field' }, h('span', {}, a.secret_label), secretIn),
      h('div', { class: 'row gap' }, save, test),
      testLine(a.last_test)));

  const redirects = section(a.redirect_uris.length > 1 ? 'Redirect URIs' : 'Redirect URI', { sub: 'Add exactly this in your developer app.' },
    h('div', { class: 'uri-list' }, a.redirect_uris.map((u) => h('div', { class: 'uri-row' },
      h('div', { class: 'min0' }, a.redirect_uris.length > 1 ? h('div', { class: 'muted small' }, u.label) : null, h('code', { class: 'uri select' }, u.uri)),
      copyButton(u.uri)))));

  const setup = section('Setup', { sub: 'Create the app once, then paste its keys above.' },
    h('div', { class: 'row gap wrap' },
      h('a', { class: 'btn', href: a.guide, target: '_blank', rel: 'noopener' }, 'Step-by-step guide', icon('external', 13)),
      h('a', { class: 'btn ghost', href: CONSOLE[a.app], target: '_blank', rel: 'noopener' }, 'Developer console', icon('external', 13))),
    h('details', { class: 'app-perms' }, h('summary', {}, `Permissions requested (${a.scopes.length})`),
      h('div', { class: 'perm-list' }, a.scopes.map((sc) => h('div', { class: 'perm-row' },
        h('code', { class: 'perm-name' }, shortScope(sc)),
        h('span', { class: 'perm-why' }, WHY[shortScope(sc)] || '')))),
      a.apis.length ? h('p', { class: 'muted small perm-apis' }, 'Turn on: ', a.apis.join(', ')) : null));

  const danger = a.saved_in_app ? section('Remove credentials', { sub: a.env_fallback ? 'postlite falls back to the .env values.' : 'Connecting and token refresh stop until new keys are saved.' },
    h('button', { class: 'btn danger-outline', onclick: (e) => busy(e.currentTarget, async () => {
      if (!(await confirmDialog(`Remove the saved ${a.label} credentials?`, { ok: 'Remove', danger: true }))) return;
      await api('DELETE', `/platform-apps/${a.app}`);
      toast('Removed');
      refresh(a.app);
    }) }, 'Remove')) : null;

  return h('div', { class: 'stack app-detail' }, head, creds, redirects, setup, danger);
}

export async function renderPlatformApps(root, focus = null) {
  const { platform_apps: apps } = await api('GET', '/platform-apps');
  const refresh = (f) => renderPlatformApps(root, f);
  const a = focus && apps.find((x) => x.app === focus);
  mount(root, a ? detail(a, refresh) : list(apps));
}
