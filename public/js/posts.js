// Posts: Render-style list table (all targets, filters, search) and a post detail page with tabs
// (Overview · Events timeline of publish attempts · Metrics).
import { h, mount, api, state, toast, confirmDialog, avatar, statusBadge, PROVIDER_META, icon, fmtNum, relTime, STATUS_LABEL, refreshCommon, debounce, MARKS, fmtDateTime } from './core.js';
import { openComposer, duplicatePost, retryTargets } from './composer.js';
import { pageHeader, emptyState, skeleton, dropdown, idChip, setCrumbs, tabs, section, closeMenus } from './ui.js';
import { lineChart } from './charts.js';
import { formatLocal } from '/assets/shared/time.js';
import { mediaVisual, listThumb, viewOnLink, removedNote } from './media.js';
import { brandDot } from './brands.js';

const fmtTime = fmtDateTime;
// Filter bar (Render-style): compact dropdown buttons in a row, applied filters as removable chips.
// State lives in the URL hash (#/posts?platform=youtube,x&status=failed&type=video&date=last7&q=…),
// so a filtered view survives reload and can be shared.
const PLATFORM_LABEL = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', x: 'X', linkedin: 'LinkedIn' };
const PROVIDER_PLATFORM = { youtube: 'youtube', facebook: 'facebook', instagram: 'instagram', 'instagram-standalone': 'instagram', x: 'x', linkedin: 'linkedin', 'linkedin-page': 'linkedin' };
const STATUS_OPTS = [['scheduled', 'Scheduled'], ['published', 'Published'], ['failed', 'Failed'], ['pending_approval', 'Pending approval'], ['draft', 'Draft'], ['publishing', 'Publishing']];
const TYPE_OPTS = [['video', 'Video'], ['image', 'Image'], ['text', 'Text'], ['carousel', 'Carousel'], ['story', 'Story'], ['reel', 'Reel'], ['short', 'Short'], ['thread', 'Thread'], ['document', 'Document']];
const DATE_OPTS = [['', 'Any time'], ['next7', 'Next 7 days'], ['next30', 'Next 30 days'], ['last7', 'Last 7 days'], ['last30', 'Last 30 days'], ['custom', 'Custom range']];
const LIST_KEYS = ['brand', 'platform', 'account', 'status', 'type', 'by'];

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return ymd(d); };

/** Hash params → filter state. */
function readFilters(params) {
  const f = { q: params.q || '', date: params.date || '', from: params.from || '', to: params.to || '' };
  for (const k of LIST_KEYS) f[k] = String(params[k] || '').split(',').filter(Boolean);
  if (!f.date && (f.from || f.to)) f.date = 'custom';
  // old links: #/posts?status=failed still work
  return f;
}
function writeHash(f) {
  const n = new URLSearchParams();
  for (const k of LIST_KEYS) if (f[k].length) n.set(k, f[k].join(','));
  if (f.date && f.date !== 'custom') n.set('date', f.date);
  if (f.date === 'custom') { if (f.from) n.set('from', f.from); if (f.to) n.set('to', f.to); }
  if (f.q) n.set('q', f.q);
  const hash = `#/posts${n.size ? `?${String(n).replace(/%2C/g, ',').replace(/%3A/g, ':')}` : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}
/** Date filter → [fromDay, toDayInclusive] (local YYYY-MM-DD) or null. */
function dateRange(f) {
  const today = ymd(new Date());
  switch (f.date) {
    case 'next7': return [today, addDays(today, 6)];
    case 'next30': return [today, addDays(today, 29)];
    case 'last7': return [addDays(today, -6), today];
    case 'last30': return [addDays(today, -29), today];
    case 'custom': return f.from || f.to ? [f.from || '', f.to || ''] : null;
    default: return null;
  }
}
function apiQuery(f) {
  const n = new URLSearchParams({ limit: '200', sort: 'desc' });
  const brands = f.brand.filter((id) => (state.brands || []).some((b) => b.id === id));
  if (brands.length) n.set('brand', brands.join(','));
  if (f.platform.length) n.set('platform', f.platform.join(','));
  if (f.account.length) n.set('account_id', f.account.join(','));
  if (f.status.length) n.set('status', f.status.join(','));
  if (f.type.length) n.set('media_type', f.type.join(','));
  if (f.by.length) n.set('created_by', f.by.join(','));
  const r = dateRange(f);
  if (r?.[0]) n.set('from', `${r[0]}T00:00`);
  if (r?.[1]) n.set('to', `${addDays(r[1], 1)}T00:00`); // to is exclusive
  if (f.q) n.set('q', f.q);
  return `/posts?${n}`;
}

/** A compact filter button: "Platform", "Platform: YouTube", "Platform: 2". */
function filterButton(label, valueText, active, onOpen) {
  return h('button', { type: 'button', class: `fbtn ${active ? 'on' : ''}`, 'aria-haspopup': 'menu', onclick: (e) => onOpen(e.currentTarget) },
    h('span', { class: 'fb-l' }, label), valueText ? h('span', { class: 'fb-v' }, valueText) : null, icon('chevron-down', 13));
}

/** Checkbox menu that stays open while the user ticks several values. */
function checkMenu(anchor, options, selected, onChange, { width = 220, header = null } = {}) {
  const sel = new Set(selected);
  dropdown(anchor, options.map(([v, l, extra]) => ({ node: h('label', { class: 'menu-item menu-check', tabindex: '-1' },
    h('input', { type: 'checkbox', checked: sel.has(v), onchange: (e) => { if (e.target.checked) sel.add(v); else sel.delete(v); onChange([...sel]); } }),
    extra || null, h('span', { class: 'mi-label' }, l)) })), { width, header });
}

export async function renderPosts(root, params = {}) {
  const f = readFilters(params);
  const head = pageHeader({ title: 'Posts', sub: 'Every post, per account, with its publish status.', actions: h('button', { class: 'btn primary', onclick: () => openComposer({ onSaved: () => load() }) }, icon('plus', 15), 'New post') });
  mount(root, head, skeleton('table', 8));
  await refreshCommon();
  let keys = [];
  try { keys = (await api('GET', '/api-keys')).api_keys || []; } catch {}
  const platforms = [...new Set(state.providers.map((p) => PROVIDER_PLATFORM[p.provider]).filter(Boolean))];
  for (const a of state.accounts) { const pl = PROVIDER_PLATFORM[a.provider]; if (pl && !platforms.includes(pl)) platforms.push(pl); }

  const bar = h('div', { class: 'fbar', role: 'toolbar', 'aria-label': 'Filters' });
  const chips = h('div', { class: 'fchips' });
  const meta = h('div', { class: 'muted small fcount', 'aria-live': 'polite' });
  const tbody = h('tbody');
  const search = h('input', { class: 'input slim search', type: 'search', placeholder: 'Search captions, titles, accounts…', value: f.q, 'aria-label': 'Search posts' });
  const reload = debounce(() => { f.q = search.value.trim(); apply(); }, 250);
  search.addEventListener('input', reload);

  const accountsFor = () => state.accounts.filter((a) => !f.platform.length || f.platform.includes(PROVIDER_PLATFORM[a.provider]));
  const byLabel = (v) => (v === 'human' ? 'People (web UI)' : v === 'agent' ? 'Any API key' : v.startsWith('key:') ? `Key: ${keys.find((k) => k.id === v.slice(4))?.name || v.slice(4, 12)}` : v);
  const groups = [
    ...((state.brands || []).length || f.brand.length ? [{ key: 'brand', label: 'Brand', opts: () => state.brands.map((b) => [b.id, b.name, brandDot(b, 'bdot menu-dot')]), text: (v) => state.brands.find((b) => b.id === v)?.name || 'Removed brand', width: 240 }] : []),
    { key: 'platform', label: 'Platform', opts: () => platforms.map((p) => [p, PLATFORM_LABEL[p] || p, mark(p)]), text: (v) => PLATFORM_LABEL[v] || v },
    { key: 'account', label: 'Account', opts: () => accountsFor().map((a) => [a.id, a.name, avatar(a, 18)]), text: (v) => state.accounts.find((a) => a.id === v)?.name || 'Removed account', width: 260 },
    { key: 'status', label: 'Status', opts: () => STATUS_OPTS, text: (v) => STATUS_OPTS.find((o) => o[0] === v)?.[1] || v },
    { key: 'type', label: 'Type', opts: () => TYPE_OPTS.filter(([v]) => (v !== 'thread' || platforms.includes('x')) && (v !== 'document' || platforms.includes('linkedin'))), text: (v) => TYPE_OPTS.find((o) => o[0] === v)?.[1] || v },
    { key: 'by', label: 'Created by', opts: () => [['human', 'People (web UI)'], ['agent', 'Any API key'], ...keys.map((k) => [`key:${k.id}`, k.name + (k.revoked_at ? ' (revoked)' : '')])], text: byLabel, width: 240 },
  ];

  function dateMenu(anchor) {
    const fromI = h('input', { class: 'input slim', type: 'date', value: f.from, 'aria-label': 'From date' });
    const toI = h('input', { class: 'input slim', type: 'date', value: f.to, 'aria-label': 'To date' });
    dropdown(anchor, [
      ...DATE_OPTS.filter(([v]) => v !== 'custom').map(([v, l]) => ({ label: l, active: f.date === v, onClick: () => { f.date = v; f.from = ''; f.to = ''; apply(); } })),
      { sep: true },
      { node: h('div', { class: 'menu-form' }, h('div', { class: 'muted small' }, 'Custom range (published or scheduled)'),
        h('div', { class: 'row gap' }, fromI, toI),
        h('button', { type: 'button', class: 'btn small', onclick: () => { f.date = 'custom'; f.from = fromI.value; f.to = toI.value; apply(); closeMenus(); } }, 'Apply')) },
    ], { width: 280 });
  }
  const dateText = () => {
    if (!f.date) return '';
    if (f.date === 'custom') return `${f.from || '…'} → ${f.to || '…'}`;
    return DATE_OPTS.find((o) => o[0] === f.date)?.[1] || f.date;
  };

  function drawBar() {
    mount(bar, groups.map((g) => {
      const v = f[g.key];
      const txt = v.length === 1 ? g.text(v[0]) : v.length > 1 ? `${v.length}` : '';
      return filterButton(g.label, txt, v.length > 0, (a) => checkMenu(a, g.opts(), v, (nv) => { f[g.key] = nv; if (g.key === 'platform') f.account = f.account.filter((id) => accountsFor().some((x) => x.id === id)); apply({ keepMenu: true }); }, { width: g.width || 220 }));
    }), filterButton('Date', dateText(), !!f.date, dateMenu));
    const applied = [
      ...groups.flatMap((g) => f[g.key].map((v) => [g.label, g.text(v), () => { f[g.key] = f[g.key].filter((x) => x !== v); apply(); }])),
      ...(f.date ? [['Date', dateText(), () => { f.date = ''; f.from = ''; f.to = ''; apply(); }]] : []),
      ...(f.q ? [['Search', `“${f.q}”`, () => { f.q = ''; search.value = ''; apply(); }]] : []),
    ];
    mount(chips, applied.length ? [
      applied.map(([l, v, rm]) => h('span', { class: 'fchip' }, h('span', { class: 'muted' }, `${l}:`), h('span', { class: 'fc-v' }, v),
        h('button', { type: 'button', class: 'fc-x', 'aria-label': `Remove filter ${l} ${v}`, onclick: rm }, icon('x', 12)))),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => { for (const k of LIST_KEYS) f[k] = []; f.date = f.from = f.to = f.q = ''; search.value = ''; apply(); } }, 'Clear'),
    ] : null);
    chips.hidden = !applied.length;
  }

  let seq = 0;
  async function load() {
    const my = ++seq;
    let posts;
    try { ({ posts } = await api('GET', apiQuery(f))); } catch (e) { if (my === seq) mount(tbody, h('tr', {}, h('td', { colspan: 5 }, h('div', { class: 'notice error' }, e.message)))); return; }
    if (my !== seq) return;
    const rows = posts.flatMap((g) => g.targets.filter((t) => !g.matched_target_ids || g.matched_target_ids.includes(t.id)).map((t) => ({ g, t })))
      .sort((a, b) => (b.t.published_at || b.t.publish_at || b.t.updated_at) - (a.t.published_at || a.t.publish_at || a.t.updated_at));
    const filtered = LIST_KEYS.some((k) => f[k].length) || f.date || f.q;
    meta.textContent = `${rows.length} ${rows.length === 1 ? 'post' : 'posts'}${posts.length >= 200 ? ' (newest 200)' : ''}`;
    mount(tbody, rows.length ? rows.map(({ g, t }) => postRow(g, t, load)) : h('tr', {}, h('td', { colspan: 5 }, emptyState({ icon: 'posts', compact: true, title: filtered ? 'No matching posts' : 'No posts yet', body: filtered ? 'Try removing a filter.' : 'Create your first post to see it here.' }))));
  }
  function apply({ keepMenu = false } = {}) {
    if (!keepMenu) closeMenus();
    writeHash(f);
    drawBar();
    load();
  }

  mount(root, head,
    h('div', { class: 'ftoolbar' }, bar, search),
    chips,
    h('div', { class: 'table-wrap' }, h('table', { class: 'table rows-click' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Post'), h('th', { class: 'hide-sm w-acc' }, 'Account'), h('th', { class: 'w-status' }, 'Status'), h('th', { class: 'hide-sm w-when' }, 'When'), h('th', { class: 'w-act' }, h('span', { class: 'sr-only' }, 'Actions')))),
      tbody)),
    meta);
  drawBar();
  mount(tbody, h('tr', {}, h('td', { colspan: 5 }, skeleton('table', 4))));
  await load();
}

function mark(kind) { const el = h('span', { class: `pmark pmark-xs pm-${kind}` }); el.innerHTML = MARKS[kind] || ''; return el; }

function postRow(g, t, refresh) {
  const open = () => { location.hash = `#/posts/${g.id}`; };
  const at = t.published_at || t.publish_at;
  return h('tr', { tabindex: '0', onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
    h('td', {}, h('div', { class: 'cell-post' },
      listThumb(g.media?.[0]),
      h('div', { class: 'cp-text' },
        h('a', { class: 'cp-title ellipsis', href: `#/posts/${g.id}`, onclick: (e) => e.stopPropagation() }, t.settings?.title || t.caption || '(no caption)'),
        h('div', { class: 'cp-sub' }, idChip(g.id), h('span', { class: 'dot-sep' }), h('span', { class: 'show-sm' }, t.account_name), h('span', { class: 'hide-sm' }, at ? relTime(at) : 'no date')),
        t.error ? h('div', { class: 'err small ellipsis' }, t.error) : t.warning ? h('div', { class: 'warn small ellipsis' }, t.warning) : null))),
    h('td', { class: 'hide-sm' }, h('div', { class: 'row gap' }, avatar({ provider: t.provider, name: t.account_name, picture: t.account_picture }, 22), h('span', { class: 'ellipsis' }, t.account_name))),
    h('td', {}, statusBadge(t.status)),
    h('td', { class: 'mono small nowrap hide-sm' }, fmtTime(at)),
    h('td', { class: 'w-act' }, h('div', { class: 'row gap end' },
      t.status === 'failed' ? h('button', { class: 'btn small hide-sm', onclick: (e) => { e.stopPropagation(); retryTargets(g.id, [t.id], refresh); } }, icon('refresh', 13), 'Retry') : null,
      viewOnLink(t, { cls: 'icon-btn', iconOnly: true }))));
}

// ------------------------------------------------------------------ detail
export async function renderPostDetail(root, id, params = {}) {
  const tab = ['overview', 'events', 'metrics'].includes(params.tab) ? params.tab : 'overview';
  mount(root, skeleton('detail'));
  const { post } = await api('GET', `/posts/${id}`);
  const line = (post.content || '').split('\n')[0];
  const title = post.targets.find((t) => t.settings?.title)?.settings.title || (line.length > 80 ? `${line.slice(0, 78).trimEnd()}…` : line) || '(no caption)';
  setCrumbs([['postlite', '#/dashboard'], ['Posts', '#/posts'], [title.length > 40 ? `${title.slice(0, 40)}…` : title]]);
  const refresh = () => renderPostDetail(root, id, params);
  const failed = post.targets.filter((t) => t.status === 'failed');
  const canPostNow = post.targets.some((t) => !['published', 'publishing', 'pending_approval'].includes(t.status));
  const moreBtn = h('button', { class: 'btn icon', 'aria-label': 'More actions', 'aria-haspopup': 'menu', onclick: (e) => dropdown(e.currentTarget, [
    { label: 'Duplicate as draft', icon: 'copy', onClick: () => duplicatePost(id, { onSaved: (p) => { if (p) location.hash = `#/posts/${p.id}`; } }) },
    canPostNow ? { label: 'Post now', icon: 'send', onClick: async () => { await api('POST', `/posts/${id}/publish-now`, {}); toast('Publishing…', 'success'); setTimeout(refresh, 1000); } } : null,
    { sep: true },
    { label: 'Delete post', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog('Delete this post on all accounts? Already-published content stays live on the platforms.', { ok: 'Delete', danger: true })) { await api('DELETE', `/posts/${id}`); toast('Deleted'); location.hash = '#/posts'; } } },
  ], { align: 'right' }) }, icon('more', 16));
  const head = pageHeader({
    eyebrow: 'Post', title,
    meta: [statusBadge(post.status), idChip(post.id, { short: 12 }), h('span', { class: 'muted small' }, post.publish_at ? `${post.publish_at > Date.now() ? 'Publishes' : 'Scheduled for'} ${fmtTime(post.publish_at)} · ${relTime(post.publish_at)}` : 'No publish time')],
    actions: [
      failed.length ? h('button', { class: 'btn', onclick: () => retryTargets(id, failed.map((t) => t.id), refresh) }, icon('refresh', 15), `Retry failed (${failed.length})`) : null,
      post.status === 'pending_approval' ? h('a', { class: 'btn', href: '#/approvals' }, icon('approvals', 15), 'Review') : null,
      h('button', { class: 'btn primary', onclick: () => openComposer({ groupId: id, onSaved: (p) => (p ? refresh() : (location.hash = '#/posts')) }) }, icon('edit', 15), 'Edit'),
      moreBtn,
    ],
  });
  const evCount = post.targets.reduce((n, t) => n + (t.events?.length || 0), 0);
  const nav = tabs([
    { id: 'overview', label: 'Overview', href: `#/posts/${id}` },
    { id: 'events', label: 'Events', href: `#/posts/${id}?tab=events`, count: evCount },
    { id: 'metrics', label: 'Metrics', href: `#/posts/${id}?tab=metrics` },
  ], tab, { label: 'Post sections' });
  const body = h('div', { class: 'tab-body' });
  mount(root, head, nav, body);
  if (tab === 'events') return mount(body, eventsTimeline(post));
  if (tab === 'metrics') return metricsTab(body, post);
  return mount(body, overview(post, refresh));
}

function overview(post, refresh) {
  const targets = section('Accounts', { sub: `${post.targets.length} target${post.targets.length === 1 ? '' : 's'}` },
    h('div', { class: 'table-wrap flush' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', {}, 'Status'), h('th', { class: 'hide-sm' }, 'Attempts'), h('th', { class: 'hide-sm' }, 'Time'), h('th', { class: 'w-act' }, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', {}, post.targets.map((t) => h('tr', {},
        h('td', { class: 'nowrap' }, h('div', { class: 'row gap' }, avatar({ provider: t.provider, name: t.account_name, picture: t.account_picture }, 24), h('div', {}, h('div', { class: 'strong' }, t.account_name), h('div', { class: 'muted small' }, PROVIDER_META[t.provider]?.label, t.settings?.post_type ? ` · ${t.settings.post_type}` : '')))),
        h('td', {}, statusBadge(t.status), t.error ? h('div', { class: 'err small' }, t.error) : null, t.warning ? h('div', { class: 'warn small' }, t.warning) : null),
        h('td', { class: 'mono hide-sm' }, String(t.attempts ?? 0)),
        h('td', { class: 'mono small nowrap hide-sm' }, fmtTime(t.published_at || t.publish_at)),
        h('td', { class: 'w-act' }, h('div', { class: 'row gap end' },
          t.status === 'failed' ? h('button', { class: 'btn small', onclick: () => retryTargets(post.id, [t.id], refresh) }, 'Retry') : null,
          viewOnLink(t, { cls: 'btn small ghost view-on' })))))))));
  const content = section('Content', {},
    h('div', { class: 'caption-box' }, post.content || h('span', { class: 'muted' }, '(no caption)')),
    post.media.length ? h('div', { class: 'media-strip' }, post.media.map((m) => h(m.purged ? 'div' : 'a', m.purged ? { class: 'ms-item' } : { href: m.url, target: '_blank', rel: 'noopener', class: 'ms-item' }, mediaVisual(m), h('span', { class: 'ms-meta mono' }, `${m.kind}${m.width ? ` · ${m.width}×${m.height}` : ''}`)))) : null,
    removedNote(post.media));
  const info = section('Details', {}, h('dl', { class: 'kv-list' },
    h('dt', {}, 'Status'), h('dd', {}, statusBadge(post.status)),
    h('dt', {}, 'Post ID'), h('dd', {}, idChip(post.id, { short: 40 })),
    h('dt', {}, 'Publish at'), h('dd', { class: 'mono' }, fmtTime(post.publish_at)),
    h('dt', {}, 'Created by'), h('dd', {}, post.created_by || 'web UI'),
    post.approval_note ? [h('dt', {}, 'Approval note'), h('dd', {}, post.approval_note)] : null,
    h('dt', {}, 'Media'), h('dd', {}, `${post.media.length} file${post.media.length === 1 ? '' : 's'}`)));
  return h('div', { class: 'detail-grid' }, h('div', { class: 'stack' }, targets, content), h('div', { class: 'stack' }, info, section('Latest events', { actions: h('a', { class: 'btn small ghost', href: `#/posts/${post.id}?tab=events` }, 'View all') }, eventsTimeline(post, 5))));
}

const LEVEL = { info: ['info', 'ev-info'], warn: ['alert', 'ev-warn'], error: ['x-circle', 'ev-err'] };
function eventIcon(ev) {
  if (ev.level === 'info' && /^Published/.test(ev.message)) return ['check-circle', 'ev-ok'];
  if (ev.level === 'info' && /scheduled|Approved|Awaiting/i.test(ev.message)) return ['clock', 'ev-sched'];
  return LEVEL[ev.level] || LEVEL.info;
}

/** Render-like event list: icon by outcome, message, account, mono timestamp; newest first. */
function eventsTimeline(post, limit = 0) {
  let evs = post.targets.flatMap((t) => (t.events || []).map((ev) => ({ ...ev, t }))).sort((a, b) => b.at - a.at);
  if (limit) evs = evs.slice(0, limit);
  if (!evs.length) return emptyState({ icon: 'clock', compact: true, title: 'No events yet', body: 'Publish attempts, retries and results appear here.' });
  return h('ol', { class: 'timeline' }, evs.map((ev) => {
    const [ic, cls] = eventIcon(ev);
    return h('li', { class: `tl-item ${cls}` },
      h('span', { class: 'tl-icon' }, icon(ic, 16)),
      h('div', { class: 'tl-body' },
        h('div', { class: 'tl-msg' }, linkify(ev.message)),
        h('div', { class: 'tl-meta' }, avatar({ provider: ev.t.provider, name: ev.t.account_name, picture: ev.t.account_picture }, 16), h('span', {}, ev.t.account_name), h('span', { class: 'dot-sep' }), h('time', { class: 'mono', datetime: new Date(ev.at).toISOString(), title: `${new Date(ev.at).toISOString()} · ${relTime(ev.at)}` }, limit ? relTime(ev.at) : fmtTime(ev.at)))));
  }));
}

function linkify(msg) {
  const parts = String(msg).split(/(https?:\/\/[^\s)]+)/g);
  return parts.map((p) => (/^https?:\/\//.test(p) ? h('a', { href: p, target: '_blank', rel: 'noopener' }, p) : p));
}

async function metricsTab(body, post) {
  mount(body, skeleton('cards', 2));
  let r;
  try { r = await api('GET', `/posts/${post.id}/metrics`); } catch (e) { mount(body, h('div', { class: 'notice error' }, e.message)); return; }
  const cards = r.targets.map((m) => {
    const t = post.targets.find((x) => x.id === m.target_id);
    const color = PROVIDER_META[m.provider]?.color;
    const latest = Object.entries(m.latest || {});
    return section(t?.account_name || m.provider, { sub: PROVIDER_META[m.provider]?.label, actions: viewOnLink(m, { cls: 'btn small ghost view-on' }) },
      latest.length ? [
        h('div', { class: 'kpis' }, latest.slice(0, 8).map(([k, v]) => h('div', { class: 'kpi' }, h('div', { class: 'kl' }, k.replace(/_/g, ' ')), h('div', { class: 'kv' }, fmtNum(v))))),
        h('div', { class: 'chart-grid' }, Object.entries(m.series || {}).filter(([, pts]) => pts.length > 1).slice(0, 4).map(([k, pts]) => h('div', { class: 'chart-card' }, h('div', { class: 'cc-head' }, h('strong', {}, k.replace(/_/g, ' '))), lineChart(pts.map((p) => ({ day: p.day || formatLocal(p.t ?? p.at, state.settings.timezone).replace('T', ' ').slice(0, 16), value: p.value })), { color, height: 120, label: k })))),
      ] : emptyState({ icon: 'analytics', compact: true, title: m.note || 'No metrics yet', body: m.status && m.status !== 'published' ? `Status: ${STATUS_LABEL[m.status] || m.status}` : 'Metrics are fetched by the analytics sync.' }));
  });
  mount(body, h('div', { class: 'stack' }, cards));
}
