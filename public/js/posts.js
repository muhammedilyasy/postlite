// Posts: Render-style list table (all targets, filters, search) and a post detail page with tabs
// (Overview · Events timeline of publish attempts · Metrics).
import { h, mount, api, state, toast, confirmDialog, avatar, statusBadge, PROVIDER_META, icon, fmtNum, relTime, STATUS_LABEL } from './core.js';
import { openComposer } from './composer.js';
import { pageHeader, segmented, emptyState, skeleton, dropdown, idChip, setCrumbs, tabs, section } from './ui.js';
import { lineChart } from './charts.js';
import { formatLocal } from '/assets/shared/time.js';

const fmtTime = (ms) => (ms ? formatLocal(ms, state.settings.timezone).replace('T', ' ') : '—');
const FILTERS = [['', 'All'], ['scheduled', 'Scheduled'], ['published', 'Published'], ['failed', 'Failed'], ['pending_approval', 'Pending'], ['draft', 'Drafts']];

export async function renderPosts(root, params = {}) {
  const status = params.status || '';
  const q = params.q || '';
  const head = pageHeader({ title: 'Posts', sub: 'Every post, per account, with its publish status.', actions: h('button', { class: 'btn primary', onclick: () => openComposer({ onSaved: () => renderPosts(root, params) }) }, icon('plus', 15), 'New post') });
  mount(root, head, skeleton('table', 8));
  const { posts } = await api('GET', '/posts?limit=200');
  const all = posts.flatMap((g) => g.targets.map((t) => ({ g, t })))
    .sort((a, b) => (b.t.published_at || b.t.publish_at || b.t.updated_at) - (a.t.published_at || a.t.publish_at || a.t.updated_at));
  const counts = Object.fromEntries(FILTERS.map(([v]) => [v, v ? all.filter(({ t }) => t.status === v).length : all.length]));
  const go = (p) => { const n = new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}), ...p }); for (const [k, v] of [...n]) if (!v) n.delete(k); location.hash = `#/posts${n.size ? `?${n}` : ''}`; };
  const refresh = () => renderPosts(root, params);
  const search = h('input', { class: 'input slim search', type: 'search', placeholder: 'Search captions, titles, accounts…', value: q, 'aria-label': 'Search posts' });
  const tbody = h('tbody');
  const fill = () => {
    const needle = search.value.trim().toLowerCase();
    const rows = all.filter(({ t }) => (!status || t.status === status) && (!needle || `${t.caption} ${t.settings?.title || ''} ${t.account_name}`.toLowerCase().includes(needle)));
    mount(tbody, rows.length ? rows.map(({ g, t }) => postRow(g, t, refresh)) : h('tr', {}, h('td', { colspan: 5 }, emptyState({ icon: 'posts', compact: true, title: needle || status ? 'No matching posts' : 'No posts yet', body: needle || status ? 'Try another filter.' : 'Create your first post to see it here.' }))));
  };
  search.addEventListener('input', fill);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go({ q: search.value.trim() }); });
  const toolbar = h('div', { class: 'toolbar' }, segmented(FILTERS.map(([v, l]) => [v, l, counts[v]]), status, (v) => go({ status: v }), { label: 'Status' }), search);
  mount(root, head, toolbar, h('div', { class: 'table-wrap' }, h('table', { class: 'table rows-click' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Post'), h('th', { class: 'hide-sm w-acc' }, 'Account'), h('th', { class: 'w-status' }, 'Status'), h('th', { class: 'hide-sm w-when' }, 'When'), h('th', { class: 'w-act' }, h('span', { class: 'sr-only' }, 'Actions')))),
    tbody)));
  fill();
}

function postRow(g, t, refresh) {
  const open = () => { location.hash = `#/posts/${g.id}`; };
  const thumb = g.media?.[0] ? (g.media[0].poster || (g.media[0].kind === 'image' ? g.media[0].url : '')) : '';
  const at = t.published_at || t.publish_at;
  return h('tr', { tabindex: '0', onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
    h('td', {}, h('div', { class: 'cell-post' },
      thumb ? h('img', { class: 'lthumb', src: thumb, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : h('span', { class: 'lthumb ph' }, icon(g.media?.[0]?.kind === 'video' ? 'play' : 'image', 14)),
      h('div', { class: 'cp-text' },
        h('a', { class: 'cp-title ellipsis', href: `#/posts/${g.id}`, onclick: (e) => e.stopPropagation() }, t.settings?.title || t.caption || '(no caption)'),
        h('div', { class: 'cp-sub' }, idChip(g.id), h('span', { class: 'dot-sep' }), h('span', { class: 'show-sm' }, t.account_name), h('span', { class: 'hide-sm' }, at ? relTime(at) : 'no date')),
        t.error ? h('div', { class: 'err small ellipsis' }, t.error) : t.warning ? h('div', { class: 'warn small ellipsis' }, t.warning) : null))),
    h('td', { class: 'hide-sm' }, h('div', { class: 'row gap' }, avatar({ provider: t.provider, name: t.account_name, picture: t.account_picture }, 22), h('span', { class: 'ellipsis' }, t.account_name))),
    h('td', {}, statusBadge(t.status)),
    h('td', { class: 'mono small nowrap hide-sm' }, fmtTime(at)),
    h('td', { class: 'w-act' }, h('div', { class: 'row gap end' },
      t.status === 'failed' ? h('button', { class: 'btn small hide-sm', onclick: async (e) => { e.stopPropagation(); try { await api('POST', `/posts/${g.id}/retry`, { target_ids: [t.id] }); toast('Retrying…', 'success'); setTimeout(refresh, 1000); } catch (err) { toast(err.message, 'error'); } } }, icon('refresh', 13), 'Retry') : null,
      t.published_url ? h('a', { class: 'icon-btn', href: t.published_url, target: '_blank', rel: 'noopener', 'aria-label': 'Open live post', onclick: (e) => e.stopPropagation() }, icon('external', 15)) : null)));
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
    { label: 'Duplicate as draft', icon: 'copy', onClick: async () => { const r = await api('POST', `/posts/${id}/duplicate`, {}); toast('Duplicated', 'success'); location.hash = `#/posts/${r.post.id}`; } },
    canPostNow ? { label: 'Post now', icon: 'send', onClick: async () => { await api('POST', `/posts/${id}/publish-now`, {}); toast('Publishing…', 'success'); setTimeout(refresh, 1000); } } : null,
    { sep: true },
    { label: 'Delete post', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog('Delete this post on all accounts? Already-published content stays live on the platforms.', { ok: 'Delete', danger: true })) { await api('DELETE', `/posts/${id}`); toast('Deleted'); location.hash = '#/posts'; } } },
  ], { align: 'right' }) }, icon('more', 16));
  const head = pageHeader({
    eyebrow: 'Post', title,
    meta: [statusBadge(post.status), idChip(post.id, { short: 12 }), h('span', { class: 'muted small' }, post.publish_at ? `${post.publish_at > Date.now() ? 'Publishes' : 'Scheduled for'} ${fmtTime(post.publish_at)} · ${relTime(post.publish_at)}` : 'No publish time')],
    actions: [
      failed.length ? h('button', { class: 'btn', onclick: async () => { try { await api('POST', `/posts/${id}/retry`, { target_ids: failed.map((t) => t.id) }); toast('Retrying failed accounts…', 'success'); setTimeout(refresh, 1000); } catch (e) { toast(e.message, 'error'); } } }, icon('refresh', 15), `Retry failed (${failed.length})`) : null,
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
          t.status === 'failed' ? h('button', { class: 'btn small', onclick: async () => { try { await api('POST', `/posts/${post.id}/retry`, { target_ids: [t.id] }); toast('Retrying…', 'success'); setTimeout(refresh, 1000); } catch (e) { toast(e.message, 'error'); } } }, 'Retry') : null,
          t.published_url ? h('a', { class: 'btn small ghost', href: t.published_url, target: '_blank', rel: 'noopener' }, 'Open', icon('external', 13)) : null))))))));
  const content = section('Content', {},
    h('div', { class: 'caption-box' }, post.content || h('span', { class: 'muted' }, '(no caption)')),
    post.media.length ? h('div', { class: 'media-strip' }, post.media.map((m) => h('a', { href: m.url, target: '_blank', rel: 'noopener', class: 'ms-item' }, m.kind === 'video' ? (m.poster ? h('img', { src: m.poster, alt: '' }) : h('video', { src: m.url, muted: true, preload: 'metadata' })) : h('img', { src: m.url, alt: '' }), h('span', { class: 'ms-meta mono' }, `${m.kind}${m.width ? ` · ${m.width}×${m.height}` : ''}`)))) : null);
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
    return section(t?.account_name || m.provider, { sub: PROVIDER_META[m.provider]?.label, actions: m.published_url ? h('a', { class: 'btn small ghost', href: m.published_url, target: '_blank', rel: 'noopener' }, 'Open', icon('external', 13)) : null },
      latest.length ? [
        h('div', { class: 'kpis' }, latest.slice(0, 8).map(([k, v]) => h('div', { class: 'kpi' }, h('div', { class: 'kl' }, k.replace(/_/g, ' ')), h('div', { class: 'kv' }, fmtNum(v))))),
        h('div', { class: 'chart-grid' }, Object.entries(m.series || {}).filter(([, pts]) => pts.length > 1).slice(0, 4).map(([k, pts]) => h('div', { class: 'chart-card' }, h('div', { class: 'cc-head' }, h('strong', {}, k.replace(/_/g, ' '))), lineChart(pts.map((p) => ({ day: p.day || formatLocal(p.t ?? p.at, state.settings.timezone).replace('T', ' ').slice(0, 16), value: p.value })), { color, height: 120, label: k })))),
      ] : emptyState({ icon: 'analytics', compact: true, title: m.note || 'No metrics yet', body: m.status && m.status !== 'published' ? `Status: ${STATUS_LABEL[m.status] || m.status}` : 'Metrics are fetched by the analytics sync.' }));
  });
  mount(body, h('div', { class: 'stack' }, cards));
}
