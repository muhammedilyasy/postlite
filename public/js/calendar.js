// Calendar: week / month / list views with drag & drop rescheduling.
import { h, mount, api, state, toast, confirmDialog, avatar, statusBadge, PROVIDER_META } from './core.js';
import { openComposer } from './composer.js';
import { zonedParts, zonedToUtc, formatLocal } from '/assets/shared/time.js';

const DAY = 86400000;
const view = { mode: localStorage.getItem('pl_view') || (matchMedia('(max-width: 700px)').matches ? 'list' : 'week'), anchor: Date.now(), filter: '' };

const pad = (n) => String(n).padStart(2, '0');
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dayStart(ms, tz) { const p = zonedParts(ms, tz); return zonedToUtc(p.year, p.month, p.day, 0, 0, tz); }
function addDays(ms, n, tz) { const p = zonedParts(ms, tz); const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n)); return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, tz); }
function weekStart(ms, tz) { const p = zonedParts(ms, tz); const idx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday); return addDays(dayStart(ms, tz), -idx, tz); }

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
  const toolbar = h('div', { class: 'cal-toolbar' },
    h('div', { class: 'row gap' },
      view.mode !== 'list' ? [h('button', { class: 'btn icon', title: 'Previous', onclick: () => shift(-1) }, '‹'), h('button', { class: 'btn', onclick: () => { view.anchor = Date.now(); renderCalendar(root); } }, 'Today'), h('button', { class: 'btn icon', title: 'Next', onclick: () => shift(1) }, '›')] : null,
      h('h2', { class: 'cal-title' }, title)),
    h('div', { class: 'row gap wrap' },
      h('select', { class: 'input slim', onchange: (e) => { view.filter = e.target.value; renderCalendar(root); } },
        h('option', { value: '' }, 'All accounts'), state.accounts.map((a) => h('option', { value: a.id, selected: view.filter === a.id }, `${a.name} (${PROVIDER_META[a.provider].label})`))),
      h('div', { class: 'seg' }, ['week', 'month', 'list'].map((m) => h('button', { class: view.mode === m ? 'on' : '', onclick: () => { view.mode = m; localStorage.setItem('pl_view', m); renderCalendar(root); } }, m[0].toUpperCase() + m.slice(1))))));
  mount(root, toolbar, h('div', { class: 'loading' }, 'Loading…'));
  let data;
  try { data = await api('GET', `/calendar?from=${from}&to=${to}`); } catch (e) { root.append(h('div', { class: 'notice error' }, e.message)); return; }
  const entries = data.entries.filter((e) => !view.filter || e.integration_id === view.filter);
  const refresh = () => renderCalendar(root);
  const body = view.mode === 'week' ? weekView(from, entries, tz, refresh) : view.mode === 'month' ? monthView(from, entries, tz, refresh) : listView(entries, data.undated_drafts.filter((e) => !view.filter || e.integration_id === view.filter), tz, refresh);
  mount(root, toolbar, body);
  if (view.mode === 'week') { const sc = root.querySelector('.week-scroll'); if (sc) sc.scrollTop = 7 * 48; }
}

const when = (e) => e.published_at || e.publish_at;

function chip(e, tz, refresh, { compact = false } = {}) {
  const movable = !['published', 'publishing'].includes(e.status);
  const meta = PROVIDER_META[e.provider];
  const el = h('div', {
    class: `chip cs-${e.status}`, draggable: movable, style: { '--pc': meta.color }, title: `${e.account_name} · ${e.status}\n${e.caption.slice(0, 200)}`,
    ondragstart: (ev) => { ev.dataTransfer.setData('text/plain', JSON.stringify({ group: e.group_id, at: e.publish_at })); ev.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); },
    ondragend: () => el.classList.remove('dragging'),
    onclick: () => openComposer({ groupId: e.group_id, onSaved: refresh }),
  },
  avatar({ provider: e.provider, name: e.account_name, picture: e.account_picture }, compact ? 18 : 22),
  h('span', { class: 'chip-time' }, formatLocal(when(e), tz).slice(11)),
  compact ? null : h('span', { class: 'chip-text' }, e.caption.slice(0, 60) || (e.settings?.title ?? '') || '(no caption)'),
  h('span', { class: `sdot s-${e.status}` }),
  h('button', { class: 'chip-menu', title: 'Actions', onclick: (ev) => { ev.stopPropagation(); chipMenu(ev.currentTarget, e, refresh); } }, '⋯'));
  return el;
}

function chipMenu(anchor, e, refresh) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  const item = (label, fn, cls = '') => h('button', { class: cls, onclick: async (ev) => { ev.stopPropagation(); close(); try { await fn(); } catch (err) { toast(err.message, 'error'); } } }, label);
  const menu = h('div', { class: 'menu' },
    item('Edit', () => openComposer({ groupId: e.group_id, onSaved: refresh })),
    item('Duplicate', async () => { await api('POST', `/posts/${e.group_id}/duplicate`, {}); toast('Duplicated as draft', 'success'); refresh(); }),
    !['published', 'publishing'].includes(e.status) && e.status !== 'pending_approval' ? item('Post now', async () => { await api('POST', `/posts/${e.group_id}/publish-now`, { target_ids: [e.id] }); toast('Publishing…', 'success'); setTimeout(refresh, 800); }) : null,
    e.status === 'failed' ? item('Retry', async () => { await api('POST', `/posts/${e.group_id}/retry`, { target_ids: [e.id] }); toast('Retrying…', 'success'); setTimeout(refresh, 800); }) : null,
    e.published_url ? item('Open live post ↗', () => window.open(e.published_url, '_blank', 'noopener')) : null,
    item('Delete', async () => { if (await confirmDialog('Delete this post (all accounts)?', { ok: 'Delete', danger: true })) { await api('DELETE', `/posts/${e.group_id}`); toast('Deleted'); refresh(); } }, 'danger'));
  const r = anchor.getBoundingClientRect();
  Object.assign(menu.style, { top: `${r.bottom + window.scrollY + 4}px`, left: `${Math.min(r.left, window.innerWidth - 190)}px` });
  document.body.append(menu);
  setTimeout(() => document.addEventListener('click', close), 0);
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
  const head = h('div', { class: 'week-head' }, h('div', {}), days.map((d, i) => { const p = zonedParts(d, tz); return h('div', { class: `wh ${d === todayStart ? 'today' : ''}` }, h('span', {}, WD[i]), h('strong', {}, p.day)); }));
  const grid = h('div', { class: 'week-grid' });
  for (let hr = 0; hr < 24; hr++) {
    grid.append(h('div', { class: 'hour-label' }, `${pad(hr)}:00`));
    for (const d of days) {
      const p = zonedParts(d, tz);
      const slotStart = zonedToUtc(p.year, p.month, p.day, hr, 0, tz);
      const cell = h('div', { class: `cell ${slotStart + 3600000 < Date.now() ? 'past' : ''}`, ondblclick: () => openComposer({ at: Math.max(slotStart, Date.now() + 5 * 60000), onSaved: refresh }) });
      for (const e of entries.filter((x) => when(x) >= slotStart && when(x) < slotStart + 3600000)) cell.append(chip(e, tz, refresh));
      dropTarget(cell, (old) => { const mins = old ? zonedParts(old, tz).minute : 0; return slotStart + mins * 60000; }, refresh);
      grid.append(cell);
    }
  }
  return h('div', { class: 'week' }, head, h('div', { class: 'week-scroll' }, grid), h('p', { class: 'muted small hint' }, 'Drag posts to reschedule · double-click a slot to create a post'));
}

function monthView(from, entries, tz, refresh) {
  const cur = zonedParts(view.anchor, tz).month;
  const todayStart = dayStart(Date.now(), tz);
  return h('div', { class: 'month' },
    h('div', { class: 'month-head' }, WD.map((d) => h('div', {}, d))),
    h('div', { class: 'month-grid' }, Array.from({ length: 42 }, (_, i) => {
      const d = addDays(from, i, tz);
      const p = zonedParts(d, tz);
      const items = entries.filter((x) => when(x) >= d && when(x) < addDays(d, 1, tz));
      const cell = h('div', { class: `mcell ${p.month !== cur ? 'other' : ''} ${d === todayStart ? 'today' : ''}`, ondblclick: () => openComposer({ at: Math.max(zonedToUtc(p.year, p.month, p.day, 10, 0, tz), Date.now() + 5 * 60000), onSaved: refresh }) },
        h('div', { class: 'mday' }, p.day),
        items.slice(0, 4).map((e) => chip(e, tz, refresh, { compact: true })),
        items.length > 4 ? h('button', { class: 'more', onclick: () => { view.mode = 'week'; view.anchor = d; renderCalendar(document.getElementById('view')); } }, `+${items.length - 4} more`) : null);
      dropTarget(cell, (old) => { const o = old ? zonedParts(old, tz) : { hour: 10, minute: 0 }; return zonedToUtc(p.year, p.month, p.day, o.hour, o.minute, tz); }, refresh);
      return cell;
    })));
}

function listView(entries, drafts, tz, refresh) {
  const groups = new Map();
  for (const e of entries) {
    const k = formatLocal(when(e), tz).slice(0, 10);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return h('div', { class: 'list' },
    drafts.length ? h('section', {}, h('h3', {}, 'Drafts (no date)'), drafts.map((e) => listRow(e, tz, refresh))) : null,
    groups.size ? [...groups.entries()].map(([day, items]) => h('section', {}, h('h3', {}, new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })), items.map((e) => listRow(e, tz, refresh))))
      : h('div', { class: 'empty' }, h('p', {}, 'Nothing scheduled in the next weeks.'), h('button', { class: 'btn primary', onclick: () => openComposer({ onSaved: refresh }) }, '+ Create a post')));
}

function listRow(e, tz, refresh) {
  return h('div', { class: 'lrow', onclick: () => openComposer({ groupId: e.group_id, onSaved: refresh }) },
    h('span', { class: 'ltime' }, when(e) ? formatLocal(when(e), tz).slice(11) : '—'),
    avatar({ provider: e.provider, name: e.account_name, picture: e.account_picture }, 30),
    h('div', { class: 'ltext' }, h('div', { class: 'lname' }, e.account_name), h('div', { class: 'muted ellipsis' }, e.caption || e.settings?.title || '(no caption)')),
    e.media?.[0] ? h('img', { class: 'lthumb', src: e.media[0].poster || (e.media[0].kind === 'image' ? e.media[0].url : ''), alt: '', onerror: (ev) => ev.target.remove() }) : null,
    statusBadge(e.status),
    h('button', { class: 'chip-menu', onclick: (ev) => { ev.stopPropagation(); chipMenu(ev.currentTarget, e, refresh); } }, '⋯'));
}
