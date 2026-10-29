// Alerts UI: the top-bar bell (unread count + dropdown of recent notifications) and
// Settings → Notifications (per-user preferences, digest time, email status, test email).
import { h, mount, api, state, toast, icon, relTime } from './core.js';
import { dropdown, closeMenus, section } from './ui.js';

let unread = 0;
const KIND_ICON = { post_failed: 'x-circle', post_published: 'check-circle', account_reconnect: 'alert', digest: 'posts', test: 'mail' };

function paintBadge() {
  const b = document.getElementById('bell-count');
  const btn = document.getElementById('bell-btn');
  if (b) { b.textContent = unread > 99 ? '99+' : String(unread || ''); b.hidden = !unread; }
  btn?.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
}

export async function refreshBell() {
  try { unread = (await api('GET', '/notifications?limit=0')).unread; paintBadge(); } catch {}
}

export function bellButton() {
  return h('button', { class: 'icon-btn bell-btn', id: 'bell-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Notifications', onclick: (e) => openBell(e.currentTarget) },
    icon('bell', 17), h('span', { class: 'bell-count', id: 'bell-count', hidden: true }));
}

async function openBell(btn) {
  let data;
  try { data = await api('GET', '/notifications?limit=15'); } catch (e) { toast(e.message, 'error'); return; }
  unread = data.unread; paintBadge();
  const open = async (n) => {
    closeMenus();
    if (!n.read) { try { unread = (await api('POST', '/notifications/read', { ids: [n.id] })).unread; paintBadge(); } catch {} }
    if (n.link) location.hash = n.link.replace(/^#?/, '#');
  };
  const markAll = h('button', { class: 'btn small ghost', disabled: !data.unread, onclick: async (e) => {
    e.stopPropagation();
    try { unread = (await api('POST', '/notifications/read', { all: true })).unread; paintBadge(); closeMenus(); } catch (err) { toast(err.message, 'error'); }
  } }, 'Mark all read');
  const header = h('div', { class: 'bell-head' }, h('span', { class: 'mh-name' }, 'Notifications'), markAll);
  const items = data.notifications.length
    ? data.notifications.map((n) => ({ node: h('button', { class: `menu-item notif-item${n.read ? '' : ' unread'}`, role: 'menuitem', tabindex: '-1', onclick: () => open(n) },
      h('span', { class: `notif-ic k-${n.kind}` }, icon(KIND_ICON[n.kind] || 'info', 14)),
      h('span', { class: 'notif-text' },
        h('span', { class: 'notif-title' }, n.title),
        n.body ? h('span', { class: 'notif-body' }, n.body.split('\n')[0]) : null,
        h('span', { class: 'notif-time' }, relTime(n.created_at))),
      n.read ? null : h('span', { class: 'notif-dot', 'aria-label': 'unread' })) }))
    : [{ node: h('div', { class: 'notif-empty' }, 'No notifications yet. Failed posts and accounts that need reconnecting show up here.') }];
  dropdown(btn, [...items, { sep: true }, { label: 'Notification settings', icon: 'settings', href: '#/settings/notifications' }], { align: 'right', width: 360, header });
  document.querySelector('.menu')?.classList.add('bell-menu');
}

// ---------------------------------------------------------------- Settings → Notifications
const ROWS = [
  ['post_failed', 'Failed posts', 'When a post could not be published to a channel.'],
  ['account_reconnect', 'Account needs reconnecting', 'When a channel’s access expired or was revoked.'],
  ['post_published', 'Published posts', 'Every time a post goes live.'],
];

export async function renderNotificationSettings(body) {
  const { prefs, email, timezone } = await api('GET', '/notifications/prefs');
  const save = async (patch) => {
    try { Object.assign(prefs, (await api('PATCH', '/notifications/prefs', patch)).prefs); toast('Saved', 'success', 1200); } catch (e) { toast(e.message, 'error'); renderNotificationSettings(body); }
  };
  const sw = (key, label) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!prefs[key], 'aria-label': label, onchange: (e) => save({ [key]: e.target.checked }) }), h('span'));
  const time = h('input', { type: 'time', class: 'input slim', value: prefs.digest_time, 'aria-label': 'Digest time', onchange: (e) => e.target.value && save({ digest_time: e.target.value }) });
  const alerts = section('Alerts', { sub: 'Shown under the bell in the top bar. Only you get these; other people have their own settings.' },
    h('div', { class: 'plist' },
      ROWS.map(([k, name, desc]) => h('div', { class: 'plist-row' }, h('div', { class: 'plist-text' }, h('div', { class: 'plist-name' }, name), h('div', { class: 'plist-desc keep-sm' }, desc)), sw(k, name))),
      h('div', { class: 'plist-row' },
        h('div', { class: 'plist-text' }, h('div', { class: 'plist-name' }, 'Daily digest'), h('div', { class: 'plist-desc keep-sm' }, `A summary of the last 24 hours, daily at this time (${timezone}).`)),
        time, sw('digest', 'Daily digest'))));

  const test = h('button', { class: 'btn', disabled: !email.can_send, title: email.can_send ? '' : email.reason, onclick: async () => {
    test.disabled = true;
    try { const r = await api('POST', '/notifications/test', {}); toast(`Test email sent to ${r.to}`, 'success'); } catch (e) { toast(e.message, 'error', 6000); } finally { test.disabled = false; }
  } }, icon('mail', 14), 'Send test email');
  const line = email.configured
    ? (email.to ? `Sent to ${email.to} through ${email.transport_label}${email.server ? ` (${email.server})` : ''}.` : email.reason)
    : 'Email is not set up on this server, so alerts stay in postlite.';
  const emailSec = section('Email', { sub: line, actions: test },
    h('div', { class: 'plist' }, h('div', { class: 'plist-row' },
      h('div', { class: 'plist-text' }, h('div', { class: 'plist-name' }, 'Also send alerts by email', email.configured ? null : h('span', { class: 'pl-note' }, 'Not set up')),
        h('div', { class: 'plist-desc keep-sm' }, 'Alerts that arrive together are bundled into one email; each failure is emailed once.')),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: email.configured && !!prefs.email, disabled: !email.configured, 'aria-label': 'Also send alerts by email', onchange: (e) => save({ email: e.target.checked }) }), h('span')))),
    email.configured ? null : h('details', { class: 'app-details' }, h('summary', {}, 'How to set up email'),
      h('p', { class: 'muted small' }, 'The server owner adds one of these to the server configuration and restarts postlite:'),
      h('pre', { class: 'block' }, 'SMTP_HOST=smtp.example.com\nSMTP_PORT=587\nSMTP_USER=…\nSMTP_PASS=…\nSMTP_FROM=postlite <alerts@example.com>\n\n# or\nRESEND_API_KEY=…\nEMAIL_FROM=postlite <alerts@example.com>')));
  mount(body, h('div', { class: 'stack' }, alerts, emailSec));
}

