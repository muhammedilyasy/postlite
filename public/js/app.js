// App shell (sidebar + top bar) and hash router.
import { h, mount, bootstrap, state, toast, icon, CSRF, api } from './core.js';
import { dropdown, setCrumbs, closeMenus } from './ui.js';
import { renderDashboard } from './calendar.js';
import { openComposer } from './composer.js';
import { renderPosts, renderPostDetail } from './posts.js';
import { renderAccounts, renderApprovals, renderAnalytics, renderSettings } from './views.js';
import { renderBrand } from './brands.js';

const NAV = [
  ['dashboard', 'Dashboard', 'dashboard'],
  ['posts', 'Posts', 'posts'],
  ['new', 'New post', 'plus'],
  ['accounts', 'Accounts', 'accounts'],
  ['analytics', 'Analytics', 'analytics'],
  ['approvals', 'Approvals', 'approvals'],
  ['settings', 'Settings', 'settings'],
];

const LOGO = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 16.5V7.5h4.6a3 3 0 0 1 0 6H8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function newPost(opts = {}) { closeDrawer(); return openComposer({ onSaved: () => route(), ...opts }); }

// ---- theme ----
const THEMES = [['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'System', 'monitor']];
function applyTheme(t) {
  localStorage.setItem('pl_theme', t);
  const eff = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.documentElement.setAttribute('data-theme', eff);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', eff === 'light' ? '#ffffff' : '#0b0b0c');
}

function userEmail() { return state.me?.principal?.email || null; }

function userMenu(btn) {
  const email = userEmail();
  const theme = localStorage.getItem('pl_theme') || 'dark';
  const logoutForm = h('form', { method: 'post', action: '/logout', hidden: true }, h('input', { type: 'hidden', name: 'csrf', value: CSRF }));
  document.body.append(logoutForm);
  dropdown(btn, [
    ...THEMES.map(([v, l, ic]) => ({ label: `${l} theme`, icon: ic, active: theme === v, hint: theme === v ? '✓' : '', onClick: () => applyTheme(v) })),
    { sep: true },
    { label: 'Setup guides', icon: 'docs', href: '/docs/setup/', target: '_blank' },
    { label: 'API keys', icon: 'key', href: '#/settings/api-keys' },
    { sep: true },
    { label: 'Sign out', icon: 'logout', onClick: () => logoutForm.submit() },
  ], { align: 'right', width: 240, header: h('div', {}, h('div', { class: 'mh-name' }, email || 'Administrator'), h('div', { class: 'mh-sub' }, `${state.me?.workspace?.name ? `${state.me.workspace.name} workspace` : 'Workspace'} · ${state.me?.auth_mode === 'cloudflare-access' ? 'Cloudflare Access' : 'password sign-in'}`)) });
}

function newMenu(btn) {
  dropdown(btn, [
    { label: 'Post', icon: 'edit', hint: 'N', onClick: () => newPost() },
    { label: 'Scheduled for next free slot', icon: 'clock', onClick: async () => { const r = await api('GET', '/slots?count=1'); newPost({ at: r.slots[0]?.epoch_ms }); } },
    { sep: true },
    { label: 'Connect account', icon: 'accounts', href: '#/accounts' },
    { label: 'API key', icon: 'key', href: '#/settings/api-keys' },
    { label: 'Webhook', icon: 'webhook', href: '#/settings/webhooks' },
  ], { align: 'right', width: 250 });
}

function openDrawer() { document.body.classList.add('drawer-open'); document.querySelector('.sidebar .nav a.on, .sidebar .nav a')?.focus(); }
function closeDrawer() { document.body.classList.remove('drawer-open'); }

function shell() {
  const email = userEmail();
  const initial = (email || 'A').slice(0, 1).toUpperCase();
  const app = document.getElementById('app');
  app.replaceChildren(
    h('a', { class: 'skip', href: '#view' , onclick: (e) => { e.preventDefault(); document.getElementById('view').focus(); } }, 'Skip to content'),
    h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Main navigation' },
      h('div', { class: 'sb-top' },
        h('a', { class: 'brand', href: '#/dashboard', html: `${LOGO}<span>postlite</span>` }),
        h('button', { class: 'icon-btn sb-close', 'aria-label': 'Close menu', onclick: closeDrawer }, icon('x', 18))),
      h('div', { class: 'sb-workspace' }, h('span', { class: 'ws-dot' }), h('span', { class: 'ws-name' }, new URL(state.settings.public_url).host)),
      h('nav', { class: 'nav' }, NAV.map(([id, label, ic]) => id === 'new'
        ? h('button', { class: 'nav-new', onclick: () => newPost() }, icon(ic, 16), h('span', {}, label), h('kbd', {}, 'N'))
        : h('a', { href: `#/${id}`, 'data-nav': id, onclick: closeDrawer }, icon(ic, 16), h('span', { class: 'nl' }, label), id === 'approvals' ? h('span', { class: 'nbadge', id: 'approval-badge', hidden: true }) : null))),
      h('div', { class: 'sb-foot' },
        h('a', { href: '/docs/setup/', target: '_blank', rel: 'noopener' }, icon('docs', 16), 'Docs'),
        h('a', { href: '/api/v1/openapi.json', target: '_blank', rel: 'noopener' }, icon('link', 16), 'API'),
        h('div', { class: 'sb-version mono' }, `v${state.me.version}`))),
    h('div', { class: 'scrim', onclick: closeDrawer }),
    h('div', { class: 'main-col' },
      h('header', { class: 'topbar' },
        h('button', { class: 'icon-btn hamburger', 'aria-label': 'Open menu', 'aria-controls': 'sidebar', onclick: openDrawer }, icon('menu', 18)),
        h('nav', { class: 'crumbs', id: 'crumbs', 'aria-label': 'Breadcrumb' }),
        h('div', { class: 'top-actions' },
          h('button', { class: 'btn primary', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e) => newMenu(e.currentTarget) }, icon('plus', 15), h('span', { class: 'hide-xs' }, 'New'), icon('chevron-down', 14, 'caret')),
          h('button', { class: 'user-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Account menu${email ? ` for ${email}` : ''}`, onclick: (e) => userMenu(e.currentTarget) },
            h('span', { class: 'user-av' }, initial), h('span', { class: 'user-email' }, email || 'admin'), icon('chevron-down', 14)))),
      h('main', { id: 'view', tabindex: '-1' })));
}

const CRUMB = { dashboard: 'Dashboard', posts: 'Posts', accounts: 'Accounts', analytics: 'Analytics', approvals: 'Approvals', settings: 'Settings' };

export async function route() {
  closeMenus();
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  let parts = (path || 'dashboard').split('/');
  if (parts[0] === 'calendar') parts = ['dashboard'];
  if (parts[0] === 'history') { location.replace(`#/posts${query ? `?${query}` : ''}`); return; }
  if (parts[0] === 'new') { history.replaceState(null, '', '#/dashboard'); parts = ['dashboard']; setTimeout(() => newPost(), 0); }
  const view = document.getElementById('view');
  document.querySelectorAll('[data-nav]').forEach((a) => { const on = a.dataset.nav === parts[0]; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  setCrumbs([['postlite', '#/dashboard'], [CRUMB[parts[0]] || 'Dashboard', `#/${parts[0]}`]]);
  view.scrollTop = 0;
  window.scrollTo(0, 0);
  try {
    switch (parts[0]) {
      case 'posts': return parts[1] ? await renderPostDetail(view, parts[1], params) : await renderPosts(view, params);
      case 'accounts': return parts[1] === 'brands' && parts[2] ? await renderBrand(view, parts[2]) : await renderAccounts(view, parts[1] === 'select' ? { select: parts[2] } : params);
      case 'approvals': return await renderApprovals(view);
      case 'analytics': return await renderAnalytics(view, params);
      case 'settings': return await renderSettings(view, { tab: parts[1] || '', focus: parts[2] || null });
      default: return await renderDashboard(view, params);
    }
  } catch (e) {
    mount(view, h('div', { class: 'notice error' }, icon('x-circle', 16), h('span', {}, e.message)));
  } finally {
    updateBadge();
  }
}

export async function updateBadge() {
  try {
    const { posts } = await api('GET', '/approvals');
    const b = document.getElementById('approval-badge');
    if (b) { b.textContent = posts.length || ''; b.hidden = !posts.length; }
  } catch {}
}

(async () => {
  if (!(await bootstrap())) return;
  applyTheme(localStorage.getItem('pl_theme') || 'dark');
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (localStorage.getItem('pl_theme') === 'system') applyTheme('system'); });
  shell();
  window.addEventListener('hashchange', route);
  window.addEventListener('pl:badge', updateBadge);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) closeDrawer();
    if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.querySelector('.modal-back') && !document.querySelector('.menu')) { e.preventDefault(); newPost(); }
  });
  await route();
  if (!state.accounts.length && !location.hash.includes('accounts')) toast('No accounts connected yet. Add one in Accounts.', 'info', 6000);
  setInterval(updateBadge, 60000);
})();
