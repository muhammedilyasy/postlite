// App shell + hash router.
import { h, mount, bootstrap, state, toast } from './core.js';
import { renderCalendar } from './calendar.js';
import { openComposer } from './composer.js';
import { renderAccounts, renderApprovals, renderHistory, renderAnalytics, renderSettings, updateBadge } from './views.js';
import { CSRF } from './core.js';

const I = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const NAV = [
  ['calendar', 'Calendar', I('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>')],
  ['approvals', 'Approvals', I('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>')],
  ['history', 'History', I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>')],
  ['analytics', 'Analytics', I('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>')],
  ['accounts', 'Accounts', I('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>')],
  ['settings', 'Settings', I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>')],
];

function shell() {
  const app = document.getElementById('app');
  app.replaceChildren(
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/calendar' }, h('span', { class: 'logo' }, '◆'), 'postlite'),
      h('nav', { class: 'nav' }, NAV.map(([id, label, icon]) => h('a', { href: `#/${id}`, 'data-nav': id }, h('span', { class: 'ni', html: icon }), h('span', { class: 'nl' }, label), id === 'approvals' ? h('span', { class: 'nbadge', id: 'approval-badge', hidden: true }) : null))),
      h('div', { class: 'top-actions' },
        h('button', { class: 'btn primary', onclick: () => openComposer({ onSaved: () => route() }) }, '+ New post'),
        h('form', { method: 'post', action: '/logout', class: 'logout' }, h('input', { type: 'hidden', name: 'csrf', value: CSRF }), h('button', { class: 'btn ghost small', title: 'Sign out', html: I('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>') })))),
    h('main', { id: 'view' }));
}

async function route() {
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  const parts = (path || 'calendar').split('/');
  const view = document.getElementById('view');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === parts[0]));
  try {
    switch (parts[0]) {
      case 'accounts': return await renderAccounts(view, parts[1] === 'select' ? { select: parts[2] } : params);
      case 'approvals': return await renderApprovals(view);
      case 'history': return await renderHistory(view, params);
      case 'analytics': return await renderAnalytics(view, params);
      case 'settings': return await renderSettings(view, { tab: parts[1] || '', focus: parts[2] || null });
      default: return await renderCalendar(view);
    }
  } catch (e) {
    mount(view, h('div', { class: 'notice error' }, e.message));
  } finally {
    updateBadge();
  }
}

(async () => {
  await bootstrap();
  shell();
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.querySelector('.modal-back')) openComposer({ onSaved: () => route() });
  });
  await route();
  if (!state.accounts.length && !location.hash.includes('accounts')) toast('Connect an account to get started → Accounts', 'info', 6000);
  setInterval(updateBadge, 60000);
})();
