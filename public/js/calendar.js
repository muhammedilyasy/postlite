// Dashboard: KPI strip + calendar (week / month / list) with drag & drop rescheduling.
import { h, mount, api, state, toast, confirmDialog, avatar, statusBadge, PROVIDER_META, icon, fmtNum } from './core.js';
import { openComposer } from './composer.js';
import { pageHeader, segmented, emptyState, skeleton, dropdown } from './ui.js';
import { zonedParts, zonedToUtc, formatLocal } from '/assets/shared/time.js';
import { listThumb } from './media.js';

const DAY = 86400000;
const view = { mode: localStorage.getItem('pl_view') || (matchMedia('(max-width: 760px)').matches ? 'list' : 'week'), anchor: Date.now(), filter: '' };

const pad = (n) => String(n).padStart(2, '0');
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dayStart(ms, tz) { const p = zonedParts(ms, tz); return zonedToUtc(p.year, p.month, p.day, 0, 0, tz); }
function addDays(ms, n, tz) { const p = zonedParts(ms, tz); const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n)); return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, tz); }
function weekStart(ms, tz) { const p = zonedParts(ms, tz); const idx = WD.indexOf(p.weekday); return addDays(dayStart(ms, tz), -idx, tz); }

const openPost = (id) => { location.hash = `#/posts/${id}`; };

async function kpiStrip(root) {
  const now = Date.now();
  const host = h('div', { class: 'kpi-strip' }, ['Scheduled · next 7 days', 'Published · last 30 days', 'Failed · last 30 days', 'Pending approval'].map((l) => h('div', { class: 'kpi-tile' }, h('div', { class: 'kt-label' }, l), h('span', { class: 'sk lg', style: { width: '40%' } }))));
  root.append(host);
  try {
    const [cal, appr] = await Promise.all([api('GET', `/calendar?from=${now - 30 * DAY}&to=${now + 7 * DAY}`), api('GET', '/approvals')]);
    const e = cal.entries;
    const tiles = [
      ['scheduled', 'Scheduled', 'next 7 days', e.filter((x) => x.status === 'scheduled' && x.publish_at >= now).length, '#/posts?status=scheduled'],
      ['published', 'Published', 'last 30 days', e.filter((x) => x.status === 'published').length, '#/posts?status=published'],
      ['failed', 'Failed', 'last 30 days', e.filter((x) => x.status === 'failed').length, '#/posts?status=failed'],
      ['pending_approval', 'Pending approval', 'from agents', appr.posts.length, '#/approvals'],
    ];
    mount(host, tiles.map(([s, l, sub, n, href]) => h('a', { class: `kpi-tile k-${s}`, href },
      h('div', { class: 'kt-label' }, h('i', { class: `sd s-${s}` }), l, h('span', { class: 'kt-sub' }, sub)),
      h('div', { class: 'kt-value' }, fmtNum(n)))));
  } catch { host.remove(); }
}

export async function renderDashboard(root) {
  const tz = state.settings.timezone;
  mount(root, pageHeader({ title: 'Dashboard', sub: `Everything scheduled across ${state.accounts.length} connected account${state.accounts.length === 1 ? '' : 's'} · ${tz}`, actions: [
    h('a', { class: 'btn', href: '#/posts' }, icon('posts', 15), 'All posts'),
    h('button', { class: 'btn primary', onclick: () => openComposer({ onSaved: () => renderDashboard(root) }) }, icon('plus', 15), 'New post'),
  ] }));
  kpiStrip(root);
  const cal = h('div', { class: 'cal-host' });
  root.append(cal);
  await renderCalendar(cal);
}

export async function renderCalendar(root) {
  const tz = state.settings.timezone;
  let from, to, title;
  if (view.mode === 'week') {
    from = weekStart(view.anchor, tz); to = addDays(from, 7, tz);
    const a = zonedParts(from, tz), b = zonedParts(to - 1, tz);
    title = `${MONTHS[a.month - 1].slice(0, 3)} ${a.day} – ${a.month !== b.month ? `${MONTHS[b.month - 1].slice(0, 3)} ` : ''}${b.day}, ${b.year}`;
  } else if (view.mode === 'month') {
    const p = zonedParts(view.anchor, tz);
    const first = zonedToUtc(p.year, p.month, 1, 0, 0, tz);
    from = weekStart(first, tz); to = addDays(from, 42, tz);
    title = `${MONTHS[p.month - 1]} ${p.year}`;
  } else {
    from = dayStart(Date.now() - DAY, tz); to = addDays(from, 45, tz);
    title = 'Upcoming';
  }
  const shift = (dir) => {
    if (view.mode === 'week') view.anchor = addDays(view.anchor, 7 * dir, tz);
    else if (view.mode === 'month') { const p = zonedParts(view.anchor, tz); view.anchor = zonedToUtc(p.year, p.month + dir, 1, 12, 0, tz); }
    renderCalendar(root);
  };
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'row gap' },
      view.mode !== 'list' ? h('div', { class: 'btn-group' },
        h('button', { class: 'btn icon', 'aria-label': 'Previous', onclick: () => shift(-1) }, icon('chevron-left', 16)),
        h('button', { class: 'btn', onclick: () => { view.anchor = Date.now(); renderCalendar(root); } }, 'Today'),
        h('button', { class: 'btn icon', 'aria-label': 'Next', onclick: () => shift(1) }, icon('chevron-right', 16))) : null,
      h('h2', { class: 'toolbar-title' }, title)),
    h('div', { class: 'row gap wrap' },
      h('label', { class: 'select-wrap' }, h('span', { class: 'sr-only' }, 'Account'),
        h('select', { class: 'input slim', onchange: (e) => { view.filter = e.target.value; renderCalendar(root); } },
          h('option', { value: '' }, 'All accounts'), state.accounts.map((a) => h('option', { value: a.id, selected: view.filter === a.id }, `${a.name} · ${PROVIDER_META[a.provider].label}`)))),
      segmented([['week', 'Week'], ['month', 'Month'], ['list', 'List']], view.mode, (m) => { view.mode = m; localStorage.setItem('pl_view', m); renderCalendar(root); }, { label: 'Calendar view' })));
  mount(root, toolbar, skeleton(view.mode === 'list' ? 'table' : 'calendar', 6));
  let data;
  try { data = await api('GET', `/calendar?from=${from}&to=${to}`); } catch (e) { mount(root, toolbar, h('div', { class: 'notice error' }, e.message)); return; }
  const entries = data.entries.filter((e) => !view.filter || e.integration_id === view.filter);
  const refresh = () => renderCalendar(root);
  const body = view.mode === 'week' ? weekView(from, entries, tz, refresh) : view.mode === 'month' ? monthView(from, entries, tz, refresh) : listView(entries, data.undated_drafts.filter((e) => !view.filter || e.integration_id === view.filter), tz, refresh);
  mount(root, toolbar, body);
  if (view.mode === 'week') { const sc = root.querySelector('.week-scroll'); if (sc) sc.scrollTop = 7 * 52; }
}

const when = (e) => e.published_at || e.publish_at;

function chip(e, tz, refresh, { compact = false } = {}) {
  const movable = !['published', 'publishing'].includes(e.status);
  const meta = PROVIDER_META[e.provider];
  const el = h('div', {
    class: `chip cs-${e.status}`, draggable: movable ? 'true' : null, tabindex: '0', role: 'button', style: { '--pc': meta.color },
    'aria-label': `${e.account_name}, ${e.status.replace('_', ' ')}, ${formatLocal(when(e), tz).slice(11)}: ${e.caption.slice(0, 80)}`,
    title: `${e.account_name} · ${e.status}\n${e.caption.slice(0, 200)}`,
    ondragstart: (ev) => { ev.dataTransfer.setData('text/plain', JSON.stringify({ group: e.group_id, at: e.publish_at })); ev.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); },
    ondragend: () => el.classList.remove('dragging'),
    onclick: () => openComposer({ groupId: e.group_id, onSaved: refresh }),
    onkeydown: (ev) => { if (ev.key === 'Enter') openComposer({ groupId: e.group_id, onSaved: refresh }); },
  },
  h('i', { class: `sd s-${e.status}`, 'aria-hidden': 'true' }),
  h('span', { class: 'chip-time mono' }, formatLocal(when(e), tz).slice(11)),
  avatar({ provider: e.provider, name: e.account_name, picture: e.account_picture }, compact ? 16 : 18),
  e.media?.[0] ? listThumb(e.media[0], { cls: 'chip-thumb', size: 10 }) : null,
  h('span', { class: 'chip-text' }, e.caption.slice(0, 60) || (e.settings?.title ?? '') || '(no caption)'),
  h('button', { class: 'chip-menu', 'aria-label': 'Post actions', 'aria-haspopup': 'menu', onclick: (ev) => { ev.stopPropagation(); chipMenu(ev.currentTarget, e, refresh); } }, icon('more', 14)));
  return el;
}

function chipMenu(anchor, e, refresh) {
  const locked = ['published', 'publishing'].includes(e.status);
  dropdown(anchor, [
    { label: 'Edit', icon: 'edit', onClick: () => openComposer({ groupId: e.group_id, onSaved: refresh }) },
    { label: 'Details & events', icon: 'audit', onClick: () => openPost(e.group_id) },
    { label: 'Duplicate', icon: 'copy', onClick: async () => { await api('POST', `/posts/${e.group_id}/duplicate`, {}); toast('Duplicated as draft', 'success'); refresh(); } },
    !locked && e.status !== 'pending_approval' ? { label: 'Post now', icon: 'send', onClick: async () => { await api('POST', `/posts/${e.group_id}/publish-now`, { target_ids: [e.id] }); toast('Publishing…', 'success'); setTimeout(refresh, 800); } } : null,
    e.status === 'failed' ? { label: 'Retry', icon: 'refresh', onClick: async () => { await api('POST', `/posts/${e.group_id}/retry`, { target_ids: [e.id] }); toast('Retrying…', 'success'); setTimeout(refresh, 800); } } : null,
    e.published_url ? { label: 'Open live post', icon: 'external', href: e.published_url, target: '_blank' } : null,
    { sep: true },
    { label: 'Delete', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog('Delete this post on all accounts? Already-published content stays live.', { ok: 'Delete', danger: true })) { await api('DELETE', `/posts/${e.group_id}`); toast('Deleted'); refresh(); } } },
  ], { align: 'right' });
}

function dropTarget(el, computeTime, refresh) {
  el.addEventListener('dragover', (ev) => { ev.preventDefault(); el.classList.add('drop'); });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    el.classList.remove('drop');
    let d;
    try { d = JSON.parse(ev.dataTransfer.getData('text/plain')); } catch { return; }
    const at = computeTime(d.at);
    if (at < Date.now()) return toast('Cannot move a post into the past', 'error');
    try { await api('POST', `/posts/${d.group}/reschedule`, { publish_at: at }); toast('Rescheduled', 'success'); refresh(); } catch (e) { toast(e.message, 'error'); }
  });
}

function weekView(from, entries, tz, refresh) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i, tz));
  const todayStart = dayStart(Date.now(), tz);
  const head = h('div', { class: 'week-head' }, h('div', { class: 'wh tz mono' }, tz.split('/').pop().replace('_', ' ')), days.map((d, i) => { const p = zonedParts(d, tz); return h('div', { class: `wh ${d === todayStart ? 'today' : ''}` }, h('span', { class: 'wd' }, WD[i]), h('span', { class: 'dn' }, p.day)); }));
  const grid = h('div', { class: 'week-grid' });
  const nowP = zonedParts(Date.now(), tz);
  for (let hr = 0; hr < 24; hr++) {
    grid.append(h('div', { class: 'hour-label mono' }, `${pad(hr)}:00`));
    for (const d of days) {
      const p = zonedParts(d, tz);
      const slotStart = zonedToUtc(p.year, p.month, p.day, hr, 0, tz);
      const isNow = d === todayStart && hr === nowP.hour;
      const cell = h('div', { class: `cell ${slotStart + 3600000 < Date.now() ? 'past' : ''} ${d === todayStart ? 'today' : ''}`, ondblclick: () => openComposer({ at: Math.max(slotStart, Date.now() + 5 * 60000), onSaved: refresh }) },
        isNow ? h('div', { class: 'now-line', style: { top: `${(nowP.minute / 60) * 100}%` } }) : null);
      for (const e of entries.filter((x) => when(x) >= slotStart && when(x) < slotStart + 3600000)) cell.append(chip(e, tz, refresh));
      dropTarget(cell, (old) => { const mins = old ? zonedParts(old, tz).minute : 0; return slotStart + mins * 60000; }, refresh);
      grid.append(cell);
    }
  }
  return h('div', { class: 'card cal week' }, h('div', { class: 'week-scroll' }, head, grid), legend('Drag posts to reschedule · double-click a slot to create a post'));
}

function legend(hint) {
  return h('div', { class: 'cal-foot' }, h('div', { class: 'legend' }, [['published', 'Published'], ['scheduled', 'Scheduled'], ['pending_approval', 'Pending approval'], ['failed', 'Failed'], ['draft', 'Draft']].map(([s, l]) => h('span', {}, h('i', { class: `sd s-${s}` }), l))), h('span', { class: 'muted small hide-sm' }, hint));
}

function monthView(from, entries, tz, refresh) {
  const cur = zonedParts(view.anchor, tz).month;
  const todayStart = dayStart(Date.now(), tz);
  return h('div', { class: 'card cal month' },
    h('div', { class: 'month-head' }, WD.map((d) => h('div', {}, d))),
    h('div', { class: 'month-grid' }, Array.from({ length: 42 }, (_, i) => {
      const d = addDays(from, i, tz);
      const p = zonedParts(d, tz);
      const items = entries.filter((x) => when(x) >= d && when(x) < addDays(d, 1, tz));
      const cell = h('div', { class: `mcell ${p.month !== cur ? 'other' : ''} ${d === todayStart ? 'today' : ''}`, ondblclick: () => openComposer({ at: Math.max(zonedToUtc(p.year, p.month, p.day, 10, 0, tz), Date.now() + 5 * 60000), onSaved: refresh }) },
        h('div', { class: 'mday' }, h('span', {}, p.day)),
        items.slice(0, 3).map((e) => chip(e, tz, refresh, { compact: true })),
        items.length > 3 ? h('button', { class: 'more', onclick: () => { view.mode = 'week'; view.anchor = d; renderCalendar(document.querySelector('.cal-host')); } }, `+${items.length - 3} more`) : null);
      dropTarget(cell, (old) => { const o = old ? zonedParts(old, tz) : { hour: 10, minute: 0 }; return zonedToUtc(p.year, p.month, p.day, o.hour, o.minute, tz); }, refresh);
      return cell;
    })),
    legend('Drag posts between days · double-click a day to create a post'));
}

function listView(entries, drafts, tz, refresh) {
  const groups = new Map();
  for (const e of entries) {
    const k = formatLocal(when(e), tz).slice(0, 10);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  if (!groups.size && !drafts.length) {
    return h('div', { class: 'card' }, emptyState({ icon: 'calendar', title: 'Nothing scheduled', body: 'Posts scheduled for the next six weeks show up here.', action: h('button', { class: 'btn primary', onclick: () => openComposer({ onSaved: refresh }) }, icon('plus', 15), 'Create a post') }));
  }
  const table = (rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'table rows-click' },
    h('thead', {}, h('tr', {}, h('th', { class: 'w-time hide-sm' }, 'Time'), h('th', {}, 'Post'), h('th', { class: 'hide-sm' }, 'Account'), h('th', { class: 'w-status' }, 'Status'), h('th', { class: 'w-act' }, h('span', { class: 'sr-only' }, 'Actions')))),
    h('tbody', {}, rows.map((e) => listRow(e, tz, refresh)))));
  return h('div', { class: 'list' },
    drafts.length ? h('section', { class: 'list-day' }, h('h3', { class: 'day-label' }, 'Drafts', h('span', { class: 'count' }, drafts.length)), table(drafts)) : null,
    [...groups.entries()].map(([day, items]) => h('section', { class: 'list-day' }, h('h3', { class: 'day-label' }, new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }), h('span', { class: 'count' }, items.length)), table(items))));
}

function listRow(e, tz, refresh) {
  return h('tr', { tabindex: '0', onclick: () => openPost(e.group_id), onkeydown: (ev) => { if (ev.key === 'Enter') openPost(e.group_id); } },
    h('td', { class: 'mono nowrap hide-sm' }, when(e) ? formatLocal(when(e), tz).slice(11) : '—'),
    h('td', {}, h('div', { class: 'cell-post' }, listThumb(e.media?.[0]),
      h('div', { class: 'cp-text' }, h('div', { class: 'cp-title ellipsis' }, e.settings?.title || e.caption || '(no caption)'), h('div', { class: 'muted small ellipsis show-sm' }, when(e) ? `${formatLocal(when(e), tz).slice(11)} · ${e.account_name}` : e.account_name)))),
    h('td', { class: 'hide-sm' }, h('div', { class: 'row gap' }, avatar({ provider: e.provider, name: e.account_name, picture: e.account_picture }, 22), h('span', { class: 'ellipsis' }, e.account_name))),
    h('td', {}, statusBadge(e.status)),
    h('td', { class: 'w-act' }, h('button', { class: 'icon-btn', 'aria-label': 'Post actions', 'aria-haspopup': 'menu', onclick: (ev) => { ev.stopPropagation(); chipMenu(ev.currentTarget, e, refresh); } }, icon('more', 16))));
}
