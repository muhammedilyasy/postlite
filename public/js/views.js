// Secondary views: accounts, approvals, analytics, settings (general, API keys, webhooks, audit log, platform apps).
import { h, mount, api, state, toast, confirmDialog, avatar, PROVIDER_META, MARKS, fmtNum, fmtBytes, refreshCommon, modal, icon, relTime } from './core.js';
import { openComposer } from './composer.js';
import { formatLocal } from '/assets/shared/time.js';
import { renderPlatformApps } from './apps.js';
import { pageHeader, tabs, segmented, emptyState, skeleton, dropdown, idChip, copyButton, section, setCrumbs } from './ui.js';
import { lineChart } from './charts.js';
import { mediaVisual, removedNote } from './media.js';
import { brandsSection, brandTags, brandSelect, brandDot } from './brands.js';

const fmtTime = (ms) => (ms ? formatLocal(ms, state.settings.timezone).replace('T', ' ') : '—');
const pill = (cls, text) => h('span', { class: `status ${cls}` }, h('i', { class: 'sd' }), text);
const badge = () => window.dispatchEvent(new Event('pl:badge'));

// ---------------------------------------------------------------- Accounts
export async function renderAccounts(root, params = {}) {
  mount(root, pageHeader({ title: 'Accounts', sub: 'Channels, Pages and profiles postlite can publish to.' }), skeleton('table', 3));
  await refreshCommon();
  if (params.select) return renderSelect(root, params.select);
  const refresh = () => renderAccounts(root);
  const connect = connectList(state.providers);

  const menuFor = (a) => (e) => dropdown(e.currentTarget, [
    { label: 'Check token', icon: 'refresh', onClick: async () => { const r = await api('POST', `/accounts/${a.id}/check`, {}); toast(r.ok ? 'Token OK' : `Problem: ${r.error}`, r.ok ? 'success' : 'error'); refresh(); } },
    { label: 'Reconnect', icon: 'accounts', href: `/oauth/${a.provider}/start?reconnect=${a.id}` },
    { label: 'Analytics', icon: 'analytics', href: `#/analytics?account=${a.id}` },
    { sep: true },
    { label: 'Disconnect', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog(`Disconnect ${a.name}? Its unpublished posts and analytics will be removed.`, { ok: 'Disconnect', danger: true })) { await api('DELETE', `/accounts/${a.id}`); toast('Disconnected'); refresh(); } } },
  ], { align: 'right' });

  const table = state.accounts.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', { class: 'hide-sm' }, 'Platform'), h('th', {}, 'Status'), h('th', { class: 'hide-sm' }, 'Last checked'), h('th', { class: 'w-act' }, h('span', { class: 'sr-only' }, 'Actions')))),
    h('tbody', {}, state.accounts.map((a) => h('tr', {},
      h('td', {}, h('div', { class: 'row gap' }, avatar(a, 30), h('div', { class: 'min0' }, h('div', { class: 'strong ellipsis' }, a.name, brandTags(a.id)), h('div', { class: 'muted small ellipsis' }, a.username ? (a.provider.startsWith('linkedin') ? String(a.username) : `@${String(a.username).replace(/^@/, '')}`) : a.meta?.page_name ? `Page: ${a.meta.page_name}` : idChip(a.id))))),
      h('td', { class: 'hide-sm' }, PROVIDER_META[a.provider].label, a.provider === 'instagram-standalone' ? h('span', { class: 'muted small' }, ' · Instagram Login') : a.provider === 'instagram' ? h('span', { class: 'muted small' }, ' · via Facebook') : a.provider === 'x' && a.meta?.premium ? h('span', { class: 'muted small' }, ' · Premium') : null),
      h('td', {}, a.status === 'active' ? pill('s-published', 'Connected') : pill('s-failed', 'Needs reconnect'), a.status !== 'active' && a.status_message ? h('div', { class: 'err small' }, a.status_message) : null,
        a.status === 'active' && a.token_expires_at && a.provider === 'instagram-standalone' ? h('div', { class: 'muted small' }, `Token renews before ${fmtTime(a.token_expires_at).slice(0, 10)}`) : null,
        a.status === 'active' && a.token_expires_at && a.provider.startsWith('linkedin') && !a.meta?.has_refresh ? h('div', { class: 'muted small' }, `Reconnect before ${fmtTime(a.token_expires_at).slice(0, 10)}`) : null),
      h('td', { class: 'small muted hide-sm' }, a.last_checked_at ? relTime(a.last_checked_at) : 'never'),
      h('td', { class: 'w-act' }, h('div', { class: 'row gap end' },
        a.status !== 'active' ? h('a', { class: 'btn small primary', href: `/oauth/${a.provider}/start?reconnect=${a.id}` }, 'Reconnect') : null,
        h('button', { class: 'icon-btn', 'aria-label': `Actions for ${a.name}`, 'aria-haspopup': 'menu', onclick: menuFor(a) }, icon('more', 16)))))))))
    : h('div', { class: 'card' }, emptyState({ icon: 'accounts', title: 'No accounts connected', body: 'Connect a YouTube channel, Facebook Page, Instagram, X or LinkedIn account below.' }));

  mount(root,
    pageHeader({ title: 'Accounts', sub: 'Channels, Pages and profiles postlite can publish to.', actions: h('a', { class: 'btn', href: '#/settings/apps' }, icon('apps', 15), 'Platform apps') }),
    h('h2', { class: 'h-section' }, 'Connected', h('span', { class: 'count' }, state.accounts.length)),
    table,
    state.accounts.length ? brandsSection() : null,
    h('h2', { class: 'h-section' }, 'Add an account'),
    connect);
}


function mark(kind) { const el = h('span', { class: `pmark pm-${kind}` }); el.innerHTML = MARKS[kind]; return el; }

function connectList(providers) {
  const by = Object.fromEntries(providers.map((p) => [p.provider, p]));
  const rows = [
    { kind: 'youtube', name: 'YouTube', desc: 'Videos and Shorts on your channel', opts: [by.youtube] },
    { kind: 'facebook', name: 'Facebook', desc: 'Posts, Reels and Stories on a Page you manage', opts: [by.facebook] },
    { kind: 'instagram', name: 'Instagram', desc: 'Posts, carousels, Reels and Stories on a Business or Creator account', opts: [by.instagram, by['instagram-standalone']] },
    { kind: 'x', name: 'X', desc: 'Posts, threads, photos and video on your X account', opts: [by.x] },
    { kind: 'linkedin', name: 'LinkedIn', desc: 'Posts, images, video and PDF documents on your profile or a Company Page', opts: [by.linkedin, by['linkedin-page']] },
  ].filter((r) => r.opts.some(Boolean));
  const optLabel = (p) => ({ instagram: 'Through a Facebook Page', 'instagram-standalone': 'With Instagram login', linkedin: 'My profile', 'linkedin-page': 'A Company Page I admin' }[p.provider] || p.label);
  const action = (r) => {
    const opts = r.opts.filter(Boolean);
    const ready = opts.filter((p) => p.configured);
    if (!ready.length) return h('a', { class: 'btn small', href: `#/settings/apps/${opts[0]?.app || ''}` }, 'Set up');
    if (ready.length === 1) return h('a', { class: 'btn small primary', href: `/oauth/${ready[0].provider}/start` }, 'Connect');
    return h('button', { class: 'btn small primary', 'aria-haspopup': 'menu', onclick: (e) => dropdown(e.currentTarget, ready.map((p) => ({ label: optLabel(p), href: `/oauth/${p.provider}/start` })), { align: 'right', width: 230 }) }, 'Connect', icon('chevron-down', 14));
  };
  const note = (r) => {
    const opts = r.opts.filter(Boolean);
    return opts.some((p) => p.configured) ? null : h('span', { class: 'pl-note' }, 'Needs a developer app');
  };
  return h('div', { class: 'plist' }, rows.map((r) => h('div', { class: 'plist-row' },
    mark(r.kind),
    h('div', { class: 'plist-text' }, h('div', { class: 'plist-name' }, r.name, note(r)), h('div', { class: 'plist-desc' }, r.desc)),
    action(r))));
}

async function renderSelect(root, stateId) {
  let data;
  try { data = await api('GET', `/oauth/pending/${stateId}`); } catch (e) { mount(root, h('div', { class: 'notice error' }, e.message)); return; }
  const chosen = new Set(data.accounts.map((a) => a.external_id));
  setCrumbs([['postlite', '#/dashboard'], ['Accounts', '#/accounts'], ['Choose accounts']]);
  mount(root, pageHeader({ eyebrow: 'Connect', title: `Choose ${PROVIDER_META[data.provider].label} accounts`, sub: 'Select which Pages / accounts postlite may publish to.' }),
    h('div', { class: 'card narrow-card' },
      h('div', { class: 'check-list' }, data.accounts.map((a) => h('label', { class: 'check big' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (e.target.checked ? chosen.add(a.external_id) : chosen.delete(a.external_id)) }), avatar({ ...a, provider: data.provider }, 30), h('span', {}, a.name, a.username ? h('span', { class: 'muted' }, ` @${a.username}`) : null)))),
      h('div', { class: 'row end gap card-foot' }, h('a', { class: 'btn', href: '#/accounts' }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
        try { const r = await api('POST', `/oauth/pending/${stateId}`, { external_ids: [...chosen] }); toast(`Connected ${r.connected.length} account(s)`, 'success'); location.hash = '#/accounts'; } catch (e) { toast(e.message, 'error'); }
      } }, 'Connect selected'))));
}

// ---------------------------------------------------------------- Approvals
export async function renderApprovals(root) {
  const head = pageHeader({ title: 'Approvals', sub: 'Posts created by AI agents whose API key is in approval mode wait here for a human.' });
  mount(root, head, skeleton('cards', 2));
  const { posts } = await api('GET', '/approvals');
  const refresh = () => { renderApprovals(root); badge(); };
  mount(root, head,
    posts.length ? h('div', { class: 'stack' }, posts.map((g) => h('article', { class: 'card approval' },
      h('div', { class: 'ap-head' },
        h('div', { class: 'row gap wrap' }, pill('s-pending_approval', 'Pending approval'), h('span', { class: 'muted small' }, 'by ', h('strong', {}, g.created_by || 'agent')), h('span', { class: 'dot-sep' }), h('span', { class: 'muted small mono' }, g.publish_at ? `${fmtTime(g.publish_at)} (${relTime(g.publish_at)})` : 'no time'), idChip(g.id)),
        h('div', { class: 'row gap' }, g.targets.map((t) => avatar({ provider: t.provider, name: t.account_name, picture: t.account_picture }, 24)))),
      h('p', { class: 'caption-prev' }, g.content || h('span', { class: 'muted' }, '(no caption)')),
      g.media.length ? h('div', { class: 'media-strip' }, g.media.map((m) => h('div', { class: 'ms-item' }, mediaVisual(m)))) : null,
      removedNote(g.media),
      h('div', { class: 'ap-foot' },
        h('a', { class: 'btn ghost', href: `#/posts/${g.id}` }, 'Details'),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn', onclick: () => openComposer({ groupId: g.id, onSaved: refresh }) }, icon('edit', 14), 'Review & edit'),
          h('button', { class: 'btn danger-outline', onclick: async () => { const reason = await confirmDialog('Reject and send back to draft?', { ok: 'Reject', danger: true, input: 'Note for the agent (optional)' }); if (reason !== null) { await api('POST', `/posts/${g.id}/reject`, { reason }); toast('Rejected'); refresh(); } } }, 'Reject'),
          h('button', { class: 'btn primary', onclick: async () => { try { await api('POST', `/posts/${g.id}/approve`, {}); toast('Approved', 'success'); refresh(); } catch (e) { toast(e.message, 'error', 6000); } } }, 'Approve')))))) 
      : h('div', { class: 'card' }, emptyState({ icon: 'approvals', title: 'Nothing waiting for approval', body: 'When an agent with an approval-mode API key creates a post, it lands here.', action: h('a', { class: 'btn', href: '#/settings/api-keys' }, icon('key', 14), 'Manage API keys') })));
}

// ---------------------------------------------------------------- Analytics
const METRIC_LABELS = { followers: 'Followers', views: 'Views', reach: 'Reach', engagements: 'Engagements', new_followers: 'New followers', lost_followers: 'Lost followers', profile_views: 'Profile views', watch_minutes: 'Watch time (min)', avg_view_sec: 'Avg view (s)', likes: 'Likes', comments: 'Comments', shares: 'Shares', saves: 'Saves', interactions: 'Interactions', accounts_engaged: 'Accounts engaged', total_views: 'Total views', media_count: 'Posts', page_likes: 'Page likes', following: 'Following', plays: 'Plays', clicks: 'Clicks', avg_watch_ms: 'Avg watch (ms)', watch_time_ms: 'Watch time (ms)', replies: 'Replies', net_followers: 'Net followers', video_views: 'Video views', impressions: 'Impressions', reposts: 'Reposts', quotes: 'Quotes', bookmarks: 'Bookmarks', clicks_url: 'Link clicks' };

/** One actionable line per account when metrics are missing for a fixable reason (API off, permission not granted). */
function analyticsNotice(a, accountId) {
  const n = (a.sync?.unavailable?.notices || []).find((x) => x.action) || (a.sync?.unavailable?.notices || [])[0];
  if (!n) return null;
  const link = n.action === 'open' && n.url ? h('a', { href: n.url, target: '_blank', rel: 'noopener' }, n.api ? `Turn on ${n.api}` : 'Open console')
    : n.action === 'reconnect' ? h('a', { href: `/oauth/${a.provider}/start?reconnect=${accountId}` }, 'Reconnect')
    : n.action === 'guide' && n.url ? h('a', { href: n.url, target: '_blank', rel: 'noopener' }, 'How to get access') : null;
  return h('div', { class: 'notice warn small an-notice' }, icon('alert', 14), h('span', {}, n.text, link ? [' ', link] : null));
}
const label = (m) => METRIC_LABELS[m] || m;

export async function renderAnalytics(root, params = {}) {
  const days = Number(params.days || 30);
  const brand = (state.brands || []).some((b) => b.id === params.brand) ? params.brand : '';
  const brandObj = brand ? state.brands.find((b) => b.id === brand) : null;
  const acc = params.account && (!brandObj || brandObj.channel_ids.includes(params.account)) ? params.account : '';
  const sort = params.sort || 'views';
  const to = Date.now(), from = to - days * 86400000;
  const go = (p) => { const q = { days, account: acc, brand, sort, ...p }; for (const k of Object.keys(q)) if (q[k] === '' || q[k] === undefined) delete q[k]; location.hash = `#/analytics?${new URLSearchParams(q)}`; };
  const head = pageHeader({ title: 'Analytics', sub: 'Account and post metrics synced from the platforms.', actions: [
    h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; b.lastChild.textContent = 'Syncing…'; try { await api('POST', '/analytics/sync', acc ? { account_id: acc } : {}); toast('Analytics updated', 'success'); } catch (err) { toast(err.message, 'error'); } renderAnalytics(root, params); } }, icon('refresh', 15), h('span', {}, 'Sync now')),
    h('button', { class: 'btn icon', 'aria-label': 'Export CSV', 'aria-haspopup': 'menu', title: 'Export CSV', onclick: (e) => dropdown(e.currentTarget, [
      { label: 'Posts CSV', icon: 'download', href: `/api/v1/analytics/export.csv?kind=posts&from=${new Date(from).toISOString()}${acc ? `&account_id=${acc}` : brand ? `&brand=${encodeURIComponent(brand)}` : ''}` },
      acc ? { label: 'Daily account CSV', icon: 'download', href: `/api/v1/analytics/export.csv?kind=account&account_id=${acc}&from=${new Date(from).toISOString()}` } : null,
    ], { align: 'right' }) }, icon('download', 15)),
  ] });
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'row gap wrap' },
    (state.brands || []).length ? h('label', { class: 'select-wrap' }, h('span', { class: 'sr-only' }, 'Brand'), brandSelect(brand, (v) => go({ brand: v, account: '' }))) : null,
    h('label', { class: 'select-wrap' }, h('span', { class: 'sr-only' }, 'Account'), h('select', { class: 'input slim', onchange: (e) => go({ account: e.target.value }) }, h('option', { value: '' }, brandObj ? `All ${brandObj.name} channels` : 'All accounts'), state.accounts.filter((a) => !brandObj || brandObj.channel_ids.includes(a.id)).map((a) => h('option', { value: a.id, selected: a.id === acc }, `${a.name} · ${PROVIDER_META[a.provider].label}`))))),
    segmented([[7, '7d'], [30, '30d'], [90, '90d']], days, (d) => go({ days: d }), { label: 'Range' }));
  mount(root, head, toolbar, skeleton('cards', 3));
  let ov, accData = null, top;
  try {
    const bq = brand ? `&brand=${encodeURIComponent(brand)}` : '';
    [ov, top] = await Promise.all([api('GET', `/analytics/overview?from=${from}&to=${to}${bq}`), api('GET', `/analytics/top-posts?from=${to - Math.max(days, 90) * 86400000}&to=${to}&sort=${encodeURIComponent(sort)}&limit=25${acc ? `&account_id=${acc}` : bq}`)]);
    if (acc) accData = await api('GET', `/analytics/accounts/${acc}?from=${from}&to=${to}`);
  } catch (e) { mount(root, head, toolbar, h('div', { class: 'notice error' }, e.message)); return; }

  const list = acc ? ov.accounts.filter((a) => a.account_id === acc) : ov.accounts;
  const cards = list.map((a) => {
    const s = a.summary;
    const keys = ['followers', 'views', 'video_views', 'total_views', 'reach', 'watch_minutes', 'impressions', 'engagements', 'interactions', 'profile_views', 'new_followers', 'media_count'].filter((k) => s[k]);
    return h('div', { class: 'card acc-kpi', style: { '--pc': PROVIDER_META[a.provider].color } },
      h('div', { class: 'ak-head' }, avatar({ provider: a.provider, name: a.name, picture: state.accounts.find((x) => x.id === a.account_id)?.picture }, 26), h('strong', { class: 'ellipsis' }, a.name), acc ? null : h('a', { class: 'small', href: `#/analytics?days=${days}&account=${a.account_id}${brand ? `&brand=${brand}` : ''}` }, 'Details')),
      keys.length ? h('div', { class: 'kpis' }, keys.slice(0, 6).map((k) => h('div', { class: 'kpi' }, h('div', { class: 'kl' }, label(k)), h('div', { class: 'kv' }, fmtNum(s[k].value)), s[k].change ? h('div', { class: `kc mono ${s[k].change > 0 ? 'up' : 'down'}` }, `${s[k].change > 0 ? '↑ ' : '↓ '}${fmtNum(Math.abs(s[k].change))}`) : null))) : h('p', { class: 'muted small' }, a.sync?.last_sync_at ? 'No metrics in this range.' : 'Not synced yet — click “Sync now”.'),
      a.sync?.last_error ? h('div', { class: 'notice error small' }, a.sync.last_error) : analyticsNotice(a, a.account_id),
      a.sync?.last_sync_at ? h('div', { class: 'muted small ak-foot mono' }, `synced ${relTime(a.sync.last_sync_at)}`) : null);
  });

  // Brand: one totals strip across its channels, then the per-channel cards as the breakdown.
  let brandTotals = null;
  if (ov.brand && !acc) {
    const t = ov.brand.totals;
    const keys = ['followers', 'views', 'video_views', 'total_views', 'reach', 'engagements', 'interactions', 'likes', 'comments', 'watch_minutes', 'impressions', 'profile_views'].filter((k) => t[k]);
    brandTotals = h('div', { class: 'card acc-kpi brand-totals' },
      h('div', { class: 'ak-head' }, brandDot(brandObj), h('strong', {}, ov.brand.name), h('span', { class: 'muted small' }, `Total across ${ov.brand.channels} channel${ov.brand.channels === 1 ? '' : 's'}`)),
      keys.length ? h('div', { class: 'kpis' }, keys.slice(0, 6).map((k) => h('div', { class: 'kpi' }, h('div', { class: 'kl' }, label(k)), h('div', { class: 'kv' }, fmtNum(t[k].value)),
        t[k].change ? h('div', { class: `kc mono ${t[k].change > 0 ? 'up' : 'down'}` }, `${t[k].change > 0 ? '↑ ' : '↓ '}${fmtNum(Math.abs(t[k].change))}`) : null))) : h('p', { class: 'muted small' }, 'No metrics in this range yet.'));
  }

  let charts = null;
  if (accData) {
    const un = accData.sync?.unavailable || {};
    const covered = new Set((un.notices || []).flatMap((n) => n.metrics || []));
    const unav = Object.entries({ ...(un.account || {}) }).filter(([k]) => !covered.has(k));
    charts = h('div', { class: 'stack' },
      h('div', { class: 'chart-grid' }, Object.entries(accData.series).map(([metric, pts]) => h('div', { class: 'card chart-card' }, h('div', { class: 'cc-head' }, h('strong', {}, label(metric)), h('span', { class: 'cc-val' }, fmtNum(accData.summary[metric]?.value))), lineChart(pts, { color: 'var(--accent)', label: label(metric) })))),
      unav.length ? h('details', { class: 'card small pad' }, h('summary', {}, `${unav.length} metric(s) not available for this account`), h('ul', {}, unav.map(([k, v]) => h('li', {}, h('strong', {}, label(k)), ': ', v)))) : null);
  }

  const metricCols = ['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'watch_minutes'];
  const topTable = section('Top posts', { actions: h('label', { class: 'row gap small' }, h('span', { class: 'muted' }, 'Sort by'), h('select', { class: 'input slim', onchange: (e) => go({ sort: e.target.value }) }, metricCols.map((m) => h('option', { value: m, selected: m === sort }, label(m))))) },
    top.posts.length ? h('div', { class: 'table-wrap flush' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Post'), h('th', { class: 'hide-sm' }, 'Published'), metricCols.map((m) => h('th', { class: `num ${m === sort ? 'sorted' : ''} ${['shares', 'saves', 'watch_minutes', 'reach'].includes(m) ? 'hide-sm' : ''}` }, label(m))))),
      h('tbody', {}, top.posts.map((p) => h('tr', {},
        h('td', {}, h('div', { class: 'cell-post' }, p.thumbnail ? h('img', { class: 'lthumb', src: p.thumbnail, alt: '', onerror: (e) => e.target.remove() }) : avatar({ provider: p.provider, name: p.account }, 24),
          h('div', { class: 'cp-text' }, h('div', { class: 'cp-title ellipsis' }, p.caption || p.kind || p.external_id), h('div', { class: 'muted small' }, p.account, p.via_postlite ? ' · via postlite' : '', p.permalink ? [' · ', h('a', { href: p.permalink, target: '_blank', rel: 'noopener' }, 'open')] : null)))),
        h('td', { class: 'nowrap small mono hide-sm' }, fmtTime(p.published_at).slice(0, 10)),
        metricCols.map((m) => h('td', { class: `num mono ${['shares', 'saves', 'watch_minutes', 'reach'].includes(m) ? 'hide-sm' : ''}` }, p.metrics[m] === undefined ? h('span', { class: 'muted', title: 'Not available' }, '—') : fmtNum(p.metrics[m])))))))) : emptyState({ icon: 'analytics', compact: true, title: 'No post metrics yet', body: 'Sync to fetch them.' }));

  mount(root, head, toolbar,
    brandTotals,
    brandTotals ? h('h2', { class: 'h-section' }, 'By channel') : null,
    cards.length ? h('div', { class: `kpi-grid ${acc ? 'single' : ''}` }, cards) : h('div', { class: 'card' }, emptyState({ icon: 'analytics', title: 'No accounts to analyse', body: 'Connect an account first.', action: h('a', { class: 'btn', href: '#/accounts' }, 'Accounts') })),
    charts, topTable);
}

// ---------------------------------------------------------------- Settings
const SETTINGS_TABS = [
  { id: '', label: 'General', href: '#/settings', icon: 'settings' },
  { id: 'api-keys', label: 'API keys', href: '#/settings/api-keys', icon: 'key' },
  { id: 'webhooks', label: 'Webhooks', href: '#/settings/webhooks', icon: 'webhook' },
  { id: 'audit', label: 'Audit log', href: '#/settings/audit', icon: 'audit' },
  { id: 'apps', label: 'Platform apps', href: '#/settings/apps', icon: 'apps' },
];

export async function renderSettings(root, { tab = '', focus = null } = {}) {
  if (!SETTINGS_TABS.some((t) => t.id === tab)) tab = '';
  const cur = SETTINGS_TABS.find((t) => t.id === tab);
  setCrumbs([['postlite', '#/dashboard'], ['Settings', '#/settings'], ...(tab ? [[cur.label]] : [])]);
  const body = h('div', { class: 'tab-body' });
  mount(root, pageHeader({ title: 'Settings' }), tabs(SETTINGS_TABS, tab, { label: 'Settings sections' }), body);
  mount(body, skeleton('table', 4));
  if (tab === 'apps') return renderPlatformApps(body, focus);
  if (tab === 'api-keys') return renderKeys(body);
  if (tab === 'webhooks') return renderHooks(body);
  if (tab === 'audit') return renderAudit(body);
  return renderGeneral(body);
}

async function renderGeneral(body) {
  await refreshCommon();
  const s = state.settings;
  // Chromium lists legacy names (Asia/Calcutta), so always include the saved zone or Save would silently change it.
  const tzs = [...new Set([s.timezone, 'UTC', ...(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [])])].sort((x, y) => x.localeCompare(y));
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const slotInputs = Object.fromEntries(days.map((d) => { const i = h('input', { class: 'input', placeholder: 'e.g. 09:00, 18:30', 'aria-label': `Posting slots ${d}` }); i.value = (s.posting_slots[d] || []).join(', '); return [d, i]; }));
  const tzSel = h('select', { class: 'input', id: 'tz' }, tzs.map((t) => h('option', { value: t, selected: t === s.timezone }, t)));
  tzSel.value = s.timezone;
  const save = h('button', { class: 'btn primary', onclick: async () => {
    try {
      await api('PATCH', '/settings', { timezone: tzSel.value, posting_slots: Object.fromEntries(days.map((d) => [d, slotInputs[d].value.split(',').map((x) => x.trim()).filter(Boolean)])) });
      toast('Settings saved', 'success'); renderGeneral(body);
    } catch (e) { toast(e.message, 'error', 6000); }
  } }, 'Save changes');
  const me = state.me;
  const storage = await storageSection(() => renderGeneral(body));
  mount(body, h('div', { class: 'stack' },
    section('Timezone', { sub: 'Used for the calendar, the composer and posting slots.' }, h('div', { class: 'form-row' }, h('label', { class: 'field grow' }, h('span', {}, 'Timezone'), tzSel))),
    section('Posting slots', { sub: 'Used by “Next free slot” and agents’ next_slot mode. 24h times, comma separated.' },
      h('div', { class: 'slots' }, days.map((d) => h('label', { class: 'slot-row' }, h('span', { class: 'mono' }, d.toUpperCase()), slotInputs[d])))),
    h('div', { class: 'row end' }, save),
    storage,
    section('Instance', {}, h('dl', { class: 'kv-list' },
      h('dt', {}, 'Public URL'), h('dd', { class: 'mono' }, s.public_url),
      h('dt', {}, 'MCP endpoint'), h('dd', { class: 'mono' }, `${s.public_url}/mcp`),
      h('dt', {}, 'Graph API'), h('dd', { class: 'mono' }, s.graph_api_version),
      h('dt', {}, 'Analytics sync'), h('dd', {}, `every ${s.analytics_interval_hours} h`),
      h('dt', {}, 'Sign-in'), h('dd', {}, me.auth_mode === 'cloudflare-access' ? ['Cloudflare Zero Trust Access · ', h('span', { class: 'mono' }, me.principal.email || '')] : ['Password · ', h('a', { href: '/docs/setup/cloudflare-access', target: '_blank', rel: 'noopener' }, 'switch to Cloudflare Access')]),
      h('dt', {}, 'Version'), h('dd', { class: 'mono' }, me.version)))));
}

/** General → Storage: delete-after-publishing policy, storage used / freed, clean up now. */
async function storageSection(rerender) {
  let s;
  try { ({ storage: s } = await api('GET', '/storage')); } catch { return null; }
  const sel = h('select', { class: 'input', 'aria-label': 'Delete media after publishing', onchange: async (e) => {
    try { await api('PATCH', '/storage', { delete_media_after: e.target.value }); toast('Storage setting saved', 'success'); } catch (err) { toast(err.message, 'error'); e.target.value = s.delete_media_after; }
  } }, s.options.map((o) => h('option', { value: o.value, selected: o.value === s.delete_media_after }, o.label)));
  sel.value = s.delete_media_after;
  const clean = h('button', { class: 'btn small', onclick: async () => {
    clean.disabled = true;
    try {
      const { report } = await api('POST', '/storage/cleanup', {});
      toast(report.purged_files ? `Freed ${fmtBytes(report.freed_bytes)} (${report.purged_files} file${report.purged_files === 1 ? '' : 's'})` : 'Nothing to clean up right now', report.purged_files ? 'success' : 'info');
      rerender();
    } catch (e) { toast(e.message, 'error'); clean.disabled = false; }
  } }, 'Clean up now');
  const files = (n) => `${n} file${n === 1 ? '' : 's'}`;
  return section('Storage', { sub: `Uploaded files are deleted once every post using them is published, after a ${s.safety_grace_minutes}-minute safety window. Thumbnails and the published links stay.`, actions: clean },
    h('dl', { class: 'kv-list' },
      h('dt', {}, 'Delete media after publishing'), h('dd', {}, sel),
      h('dt', {}, 'Stored'), h('dd', {}, `${fmtBytes(s.used_bytes)} · ${files(s.files)}`),
      h('dt', {}, 'Freed so far'), h('dd', {}, `${fmtBytes(s.freed_bytes)} · ${files(s.purged_files)}`)));
}

async function renderKeys(body) {
  const keys = await api('GET', '/api-keys');
  const s = state.settings;
  const refresh = () => renderKeys(body);
  const scopeBoxes = Object.fromEntries(['read', 'write', 'publish', 'analytics', 'admin'].map((sc) => [sc, h('input', { type: 'checkbox', checked: sc !== 'admin' })]));
  const keyName = h('input', { class: 'input', placeholder: 'e.g. Claude Desktop' });
  const approval = h('input', { type: 'checkbox', checked: true });
  const rate = h('input', { class: 'input slim', type: 'number', value: 120, min: 1, 'aria-label': 'Rate limit per minute' });
  const form = section('Create an API key', { sub: h('span', {}, 'Agents use keys with the REST API (', h('a', { href: '/api/v1/openapi.json', target: '_blank' }, 'OpenAPI'), '), the MCP server at ', h('code', {}, `${s.public_url}/mcp`), ' or the CLI. See ', h('a', { href: '/llms.txt', target: '_blank' }, 'llms.txt'), '.') },
    h('div', { class: 'key-form' },
      h('label', { class: 'field' }, h('span', {}, 'Name'), keyName),
      h('div', { class: 'field' }, h('span', {}, 'Scopes'), h('div', { class: 'row gap wrap scope-row' }, Object.entries(scopeBoxes).map(([sc, cb]) => h('label', { class: 'check chip-check', title: keys.scopes[sc] }, cb, h('span', { class: 'mono' }, sc))))),
      h('label', { class: 'check' }, approval, h('span', {}, h('strong', {}, 'Approval mode'), h('span', { class: 'muted' }, ' — posts created by this key wait for your approval'))),
      h('div', { class: 'row gap between wrap' }, h('label', { class: 'row gap small' }, h('span', { class: 'muted' }, 'Rate limit / min'), rate),
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            const r = await api('POST', '/api-keys', { name: keyName.value || 'agent', scopes: Object.entries(scopeBoxes).filter(([, cb]) => cb.checked).map(([k]) => k), approval_mode: approval.checked, rate_limit_per_min: Number(rate.value) || 120 });
            const mcpCfg = JSON.stringify({ mcpServers: { postlite: { type: 'http', url: `${s.public_url}/mcp`, headers: { Authorization: ['Bearer', r.api_key.key].join(' ') } } } }, null, 2);
            modal(h('div', { class: 'confirm' }, h('h3', { class: 'confirm-title' }, 'Your new API key'), h('div', { class: 'notice warn' }, icon('alert', 15), h('span', {}, 'Copy it now — it will not be shown again.')), h('code', { class: 'block select' }, r.api_key.key),
              h('div', { class: 'row gap' }, copyButton(r.api_key.key, 'Copy key')),
              h('div', { class: 'label' }, 'MCP client config (Streamable HTTP)'), h('pre', { class: 'block' }, mcpCfg), copyButton(mcpCfg, 'Copy config')));
            refresh();
          } catch (e) { toast(e.message, 'error'); }
        } }, icon('plus', 15), 'Create key'))));
  const list = keys.api_keys.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Name', 'Key', 'Scopes', 'Approval', 'Last used', ''].map((x, i) => h('th', { class: i === 2 || i === 4 ? 'hide-sm' : i === 5 ? 'w-act' : '' }, x)))),
    h('tbody', {}, keys.api_keys.map((k) => h('tr', { class: k.revoked_at ? 'revoked' : '' },
      h('td', {}, h('div', { class: 'strong' }, k.name), k.revoked_at ? pill('s-draft', 'Revoked') : null), h('td', {}, h('code', {}, `pl_${k.prefix}_…`)), h('td', { class: 'small hide-sm' }, h('div', { class: 'scope-chips' }, k.scopes.map((sc) => h('span', { class: 'scope-chip mono' }, sc)))),
      h('td', {}, k.revoked_at ? '—' : h('label', { class: 'switch', title: 'Approval mode' }, h('input', { type: 'checkbox', checked: k.approval_mode, 'aria-label': `Approval mode for ${k.name}`, onchange: async (e) => { await api('PATCH', `/api-keys/${k.id}`, { approval_mode: e.target.checked }); toast('Updated', 'success'); } }), h('span', {}))),
      h('td', { class: 'small muted hide-sm' }, k.revoked_at ? `revoked ${relTime(k.revoked_at)}` : k.last_used_at ? relTime(k.last_used_at) : 'never'),
      h('td', { class: 'w-act' }, k.revoked_at ? null : h('button', { class: 'btn small danger-outline', onclick: async () => { if (await confirmDialog(`Revoke "${k.name}"? Agents using it stop working immediately.`, { ok: 'Revoke', danger: true })) { await api('DELETE', `/api-keys/${k.id}`); refresh(); } } }, 'Revoke')))))))
    : h('div', { class: 'card' }, emptyState({ icon: 'key', compact: true, title: 'No API keys yet', body: 'Create one above to let an agent schedule posts.' }));
  mount(body, h('div', { class: 'stack' }, form, h('h2', { class: 'h-section' }, 'Keys', h('span', { class: 'count' }, keys.api_keys.filter((k) => !k.revoked_at).length)), list));
}

async function renderHooks(body) {
  const hooks = await api('GET', '/webhooks');
  const refresh = () => renderHooks(body);
  const hookUrl = h('input', { class: 'input', placeholder: 'https://example.com/hooks/postlite', type: 'url' });
  const evBoxes = Object.fromEntries(['post.published', 'post.failed', 'post.pending_approval', 'account.needs_reconnect', 'analytics.synced'].map((e) => [e, h('input', { type: 'checkbox', checked: true })]));
  const form = section('Add a webhook', { sub: 'Signed with HMAC-SHA256: header X-Postlite-Signature: t=<unix>,v1=<hex of HMAC(secret, "t.body")>. Failed deliveries are retried with backoff.' },
    h('div', { class: 'key-form' }, h('label', { class: 'field' }, h('span', {}, 'Endpoint URL'), hookUrl),
      h('div', { class: 'field' }, h('span', {}, 'Events'), h('div', { class: 'row gap wrap scope-row' }, Object.entries(evBoxes).map(([e, cb]) => h('label', { class: 'check chip-check' }, cb, h('span', { class: 'mono' }, e))))),
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = await api('POST', '/webhooks', { url: hookUrl.value, events: Object.entries(evBoxes).filter(([, cb]) => cb.checked).map(([k]) => k) });
          modal(h('div', { class: 'confirm' }, h('h3', { class: 'confirm-title' }, 'Webhook created'), h('p', { class: 'muted' }, 'Signing secret (shown once):'), h('code', { class: 'block select' }, r.webhook.secret), copyButton(r.webhook.secret, 'Copy secret')));
          refresh();
        } catch (e) { toast(e.message, 'error'); }
      } }, icon('plus', 15), 'Add webhook'))));
  const list = hooks.webhooks.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Endpoint'), h('th', { class: 'hide-sm' }, 'Events'), h('th', { class: 'w-act' }, ''))),
    h('tbody', {}, hooks.webhooks.map((w) => h('tr', {},
      h('td', {}, h('code', { class: 'url' }, w.url), h('div', { class: 'muted small' }, idChip(w.id))),
      h('td', { class: 'hide-sm' }, h('div', { class: 'scope-chips' }, w.events.map((e) => h('span', { class: 'scope-chip mono' }, e)))),
      h('td', { class: 'w-act' }, h('div', { class: 'row gap end' },
        h('button', { class: 'btn small', onclick: async () => { const r = await api('POST', `/webhooks/${w.id}/test`, {}); const d = r.deliveries[0]; toast(d?.state === 'delivered' ? `Delivered (HTTP ${d.last_status})` : `Not delivered: ${d?.last_error || d?.last_status}`, d?.state === 'delivered' ? 'success' : 'error'); } }, 'Send test'),
        h('button', { class: 'icon-btn', 'aria-label': 'Webhook actions', 'aria-haspopup': 'menu', onclick: (e) => dropdown(e.currentTarget, [
          { label: 'Delivery log', icon: 'audit', onClick: async () => { const r = await api('GET', `/webhooks/${w.id}/deliveries`); modal(h('div', { class: 'confirm' }, h('h3', { class: 'confirm-title' }, 'Recent deliveries'), r.deliveries.length ? h('div', { class: 'table-wrap flush' }, h('table', { class: 'table small' }, h('thead', {}, h('tr', {}, ['Event', 'State', 'Result', 'When'].map((x) => h('th', {}, x)))), h('tbody', {}, r.deliveries.map((d) => h('tr', {}, h('td', { class: 'mono' }, d.event), h('td', {}, pill(d.state === 'delivered' ? 's-published' : d.state === 'failed' ? 's-failed' : 's-scheduled', d.state)), h('td', { class: 'mono' }, d.last_status || d.last_error || ''), h('td', { class: 'mono nowrap' }, fmtTime(d.created_at)))))))
            : emptyState({ icon: 'webhook', compact: true, title: 'No deliveries yet' }))); } },
          { sep: true },
          { label: 'Delete', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog('Delete this webhook?', { ok: 'Delete', danger: true })) { await api('DELETE', `/webhooks/${w.id}`); refresh(); } } },
        ], { align: 'right' }) }, icon('more', 16)))))))))
    : h('div', { class: 'card' }, emptyState({ icon: 'webhook', compact: true, title: 'No webhooks', body: 'Get notified when posts publish or fail.' }));
  mount(body, h('div', { class: 'stack' }, form, h('h2', { class: 'h-section' }, 'Endpoints', h('span', { class: 'count' }, hooks.webhooks.length)), list));
}

async function renderAudit(body) {
  const audit = await api('GET', '/audit-log?limit=100');
  mount(body, audit.entries.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table small' }, h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Actor'), h('th', { class: 'hide-sm' }, 'Via'), h('th', {}, 'Action'), h('th', { class: 'num' }, 'Result'))),
    h('tbody', {}, audit.entries.map((e) => h('tr', {},
      h('td', { class: 'nowrap mono' }, fmtTime(e.at)),
      h('td', {}, h('div', { class: 'row gap' }, h('span', { class: `actor-ic ${e.actor_type}` }, icon(e.actor_type === 'api_key' ? 'key' : e.actor_type === 'session' ? 'shield' : 'settings', 13)), h('span', { class: 'ellipsis' }, e.actor_name || e.actor_type))),
      h('td', { class: 'hide-sm' }, h('span', { class: 'scope-chip mono' }, e.via)),
      h('td', { class: 'mono' }, e.operation, e.target ? h('span', { class: 'muted' }, ` ${String(e.target).slice(0, 10)}`) : null),
      h('td', { class: 'num' }, h('span', { class: `code-badge ${e.status >= 400 ? 'bad' : 'good'}` }, e.status)))))))
    : h('div', { class: 'card' }, emptyState({ icon: 'audit', title: 'No audit entries yet' })));
}
