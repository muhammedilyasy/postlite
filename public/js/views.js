// Secondary views: accounts, approvals, history, analytics, settings (API keys, webhooks, audit).
import { h, mount, api, state, toast, confirmDialog, avatar, statusBadge, PROVIDER_META, fmtNum, refreshCommon, modal } from './core.js';
import { openComposer, relTime } from './composer.js';
import { formatLocal } from '/assets/shared/time.js';

const fmtTime = (ms) => (ms ? formatLocal(ms, state.settings.timezone).replace('T', ' ') : '—');

// ---------------------------------------------------------------- Accounts
export async function renderAccounts(root, params = {}) {
  await refreshCommon();
  if (params.select) return renderSelect(root, params.select);
  const connectBtns = state.providers.map((p) => h('div', { class: 'connect-card', style: { '--pc': PROVIDER_META[p.provider].color } },
    h('div', { class: 'cc-title' }, avatar({ provider: p.provider, name: PROVIDER_META[p.provider].label }, 34), h('strong', {}, p.label)),
    p.configured
      ? h('a', { class: 'btn primary small', href: `/oauth/${p.provider}/start` }, 'Connect')
      : h('div', { class: 'muted small' }, 'Not configured — set the app credentials in .env (see README).'),
    h('details', { class: 'small' }, h('summary', {}, 'Redirect URI & scopes'), h('code', { class: 'block' }, p.redirect_uri), h('div', { class: 'muted' }, p.scopes.join(', ')))));
  mount(root, 
    h('div', { class: 'page-head' }, h('h2', {}, 'Accounts')),
    h('div', { class: 'connect-grid' }, connectBtns),
    h('h3', {}, 'Connected'),
    state.accounts.length ? h('div', { class: 'acc-list' }, state.accounts.map((a) => h('div', { class: `acc-card ${a.status !== 'active' ? 'bad' : ''}` },
      avatar(a, 44),
      h('div', { class: 'acc-info' }, h('strong', {}, a.name), h('div', { class: 'muted small' }, `${PROVIDER_META[a.provider].label}${a.username ? ` · @${String(a.username).replace(/^@/, '')}` : ''}${a.meta?.page_name ? ` · Page: ${a.meta.page_name}` : ''}`),
        a.status !== 'active' ? h('div', { class: 'notice error small' }, a.status_message || 'Needs reconnect') : h('div', { class: 'small ok' }, '● Connected', a.token_expires_at && a.provider === 'instagram-standalone' ? ` · token renews before ${fmtTime(a.token_expires_at).slice(0, 10)}` : '', a.last_checked_at ? ` · checked ${relTime(a.last_checked_at)}` : '')),
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn small', onclick: async (e) => { e.target.disabled = true; try { const r = await api('POST', `/accounts/${a.id}/check`, {}); toast(r.ok ? 'Token OK' : `Problem: ${r.error}`, r.ok ? 'success' : 'error'); renderAccounts(root); } catch (err) { toast(err.message, 'error'); e.target.disabled = false; } } }, 'Check'),
        h('a', { class: `btn small ${a.status !== 'active' ? 'primary' : ''}`, href: `/oauth/${a.provider}/start?reconnect=${a.id}` }, 'Reconnect'),
        h('button', { class: 'btn small ghost danger', onclick: async () => { if (await confirmDialog(`Disconnect ${a.name}? Its unpublished posts and analytics will be removed.`, { ok: 'Disconnect', danger: true })) { await api('DELETE', `/accounts/${a.id}`); toast('Disconnected'); renderAccounts(root); } } }, 'Disconnect'))))) : h('p', { class: 'muted' }, 'No accounts yet. Use a Connect button above.'));
}

async function renderSelect(root, stateId) {
  let data;
  try { data = await api('GET', `/oauth/pending/${stateId}`); } catch (e) { mount(root, h('div', { class: 'notice error' }, e.message)); return; }
  const chosen = new Set(data.accounts.map((a) => a.external_id));
  mount(root, h('div', { class: 'card narrow' },
    h('h2', {}, `Choose ${PROVIDER_META[data.provider].label} accounts`),
    h('p', { class: 'muted' }, 'Select which pages/accounts postlite may publish to.'),
    data.accounts.map((a) => h('label', { class: 'check big' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (e.target.checked ? chosen.add(a.external_id) : chosen.delete(a.external_id)) }), avatar({ ...a, provider: data.provider }, 30), h('span', {}, a.name, a.username ? h('span', { class: 'muted' }, ` @${a.username}`) : null))),
    h('div', { class: 'row end gap' }, h('button', { class: 'btn primary', onclick: async () => {
      try { const r = await api('POST', `/oauth/pending/${stateId}`, { external_ids: [...chosen] }); toast(`Connected ${r.connected.length} account(s)`, 'success'); location.hash = '#/accounts'; } catch (e) { toast(e.message, 'error'); }
    } }, 'Connect selected'))));
}

// ---------------------------------------------------------------- Approvals
export async function renderApprovals(root) {
  const { posts } = await api('GET', '/approvals');
  const refresh = () => renderApprovals(root);
  mount(root, h('div', { class: 'page-head' }, h('h2', {}, 'Approvals'), h('p', { class: 'muted' }, 'Posts created by AI agents whose API key is in approval mode.')),
    posts.length ? posts.map((g) => h('div', { class: 'approval card' },
      h('div', { class: 'row gap wrap' }, g.targets.map((t) => avatar({ provider: t.provider, name: t.account_name, picture: t.account_picture }, 28)), h('span', { class: 'muted small' }, `by ${g.created_by || 'agent'} · ${g.publish_at ? `${fmtTime(g.publish_at)} (${relTime(g.publish_at)})` : 'no time'}`)),
      h('p', { class: 'caption-prev' }, g.content || '(no caption)'),
      g.media.length ? h('div', { class: 'media-strip' }, g.media.map((m) => (m.kind === 'video' ? h('video', { src: m.url, muted: true, preload: 'metadata' }) : h('img', { src: m.url, alt: '' })))) : null,
      h('div', { class: 'row gap end wrap' },
        h('button', { class: 'btn', onclick: () => openComposer({ groupId: g.id, onSaved: refresh }) }, 'Review / edit'),
        h('button', { class: 'btn ghost danger', onclick: async () => { const reason = await confirmDialog('Reject and send back to draft?', { ok: 'Reject', danger: true, input: 'Note for the agent (optional)' }); if (reason !== null) { await api('POST', `/posts/${g.id}/reject`, { reason }); toast('Rejected'); refresh(); updateBadge(); } } }, 'Reject'),
        h('button', { class: 'btn primary', onclick: async () => { try { await api('POST', `/posts/${g.id}/approve`, {}); toast('Approved', 'success'); refresh(); updateBadge(); } catch (e) { toast(e.message, 'error', 6000); } } }, 'Approve')))) : h('div', { class: 'empty' }, h('p', {}, '🎉 Nothing waiting for approval.')));
}

export async function updateBadge() {
  try {
    const { posts } = await api('GET', '/approvals');
    const b = document.getElementById('approval-badge');
    if (b) { b.textContent = posts.length || ''; b.hidden = !posts.length; }
  } catch {}
}

// ---------------------------------------------------------------- History
export async function renderHistory(root, params = {}) {
  const status = params.status || '';
  const { posts } = await api('GET', `/posts?limit=200${status ? `&status=${status}` : ''}`);
  const refresh = () => renderHistory(root, params);
  const rows = posts.flatMap((g) => g.targets.map((t) => ({ g, t }))).filter(({ t }) => !status || t.status === status)
    .sort((a, b) => (b.t.published_at || b.t.publish_at || b.t.updated_at) - (a.t.published_at || a.t.publish_at || a.t.updated_at));
  mount(root, 
    h('div', { class: 'page-head' }, h('h2', {}, 'History'),
      h('div', { class: 'seg' }, [['', 'All'], ['published', 'Published'], ['failed', 'Failed'], ['scheduled', 'Scheduled'], ['draft', 'Drafts'], ['pending_approval', 'Pending']].map(([v, l]) => h('button', { class: status === v ? 'on' : '', onclick: () => { location.hash = `#/history${v ? `?status=${v}` : ''}`; } }, l)))),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['When', 'Account', 'Content', 'Status', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map(({ g, t }) => h('tr', {},
        h('td', { class: 'nowrap' }, fmtTime(t.published_at || t.publish_at)),
        h('td', {}, h('div', { class: 'row gap' }, avatar({ provider: t.provider, name: t.account_name, picture: t.account_picture }, 24), t.account_name)),
        h('td', { class: 'content-cell' }, h('div', { class: 'ellipsis2' }, t.caption || t.settings?.title || '(no caption)'), t.error ? h('div', { class: 'err small' }, t.error) : null, t.warning ? h('div', { class: 'warn small' }, t.warning) : null),
        h('td', {}, statusBadge(t.status)),
        h('td', { class: 'nowrap' },
          t.published_url ? h('a', { class: 'btn small ghost', href: t.published_url, target: '_blank', rel: 'noopener' }, 'Open ↗') : null,
          t.status === 'failed' ? h('button', { class: 'btn small', onclick: async () => { try { await api('POST', `/posts/${g.id}/retry`, { target_ids: [t.id] }); toast('Retrying…', 'success'); setTimeout(refresh, 1000); } catch (e) { toast(e.message, 'error'); } } }, 'Retry') : null,
          h('button', { class: 'btn small ghost', onclick: () => openComposer({ groupId: g.id, onSaved: refresh }) }, 'Details'))))))) : h('div', { class: 'empty' }, h('p', {}, 'No posts here yet.')));
}

// ---------------------------------------------------------------- Analytics
const METRIC_LABELS = { followers: 'Followers', views: 'Views', reach: 'Reach', engagements: 'Engagements', new_followers: 'New followers', lost_followers: 'Lost followers', profile_views: 'Profile views', watch_minutes: 'Watch time (min)', avg_view_sec: 'Avg view (s)', likes: 'Likes', comments: 'Comments', shares: 'Shares', saves: 'Saves', interactions: 'Interactions', accounts_engaged: 'Accounts engaged', total_views: 'Total views', media_count: 'Posts', page_likes: 'Page likes', following: 'Following', plays: 'Plays', clicks: 'Clicks', avg_watch_ms: 'Avg watch (ms)', watch_time_ms: 'Watch time (ms)', replies: 'Replies' };
const label = (m) => METRIC_LABELS[m] || m;

function sparkChart(points, color = '#6d5efc') {
  const W = 320, H = 120, P = 6;
  if (!points.length) return h('div', { class: 'muted small' }, 'No data');
  if (points.length < 2) return h('div', { class: 'chart-single' }, h('div', { class: 'kv' }, fmtNum(points[0].value)), h('div', { class: 'muted small' }, `as of ${points[0].day}`));
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => P + (i * (W - 2 * P)) / Math.max(1, points.length - 1);
  const y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${d} L${x(points.length - 1).toFixed(1)},${H - P} L${x(0).toFixed(1)},${H - P} Z`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart" role="img"><path d="${area}" fill="${color}" fill-opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  return h('div', { class: 'chart-wrap', html: svg }, h('div', { class: 'chart-axis muted small' }, h('span', {}, points[0].day || ''), h('span', {}, `max ${fmtNum(max)}`), h('span', {}, points.at(-1).day || '')));
}

export async function renderAnalytics(root, params = {}) {
  const days = Number(params.days || 30);
  const acc = params.account || '';
  const sort = params.sort || 'views';
  const to = Date.now(), from = to - days * 86400000;
  const go = (p) => { location.hash = `#/analytics?${new URLSearchParams({ days, account: acc, sort, ...p })}`; };
  mount(root, h('div', { class: 'loading' }, 'Loading analytics…'));
  let ov, accData = null, top;
  try {
    [ov, top] = await Promise.all([api('GET', `/analytics/overview?from=${from}&to=${to}`), api('GET', `/analytics/top-posts?from=${to - Math.max(days, 90) * 86400000}&to=${to}&sort=${encodeURIComponent(sort)}&limit=25${acc ? `&account_id=${acc}` : ''}`)]);
    if (acc) accData = await api('GET', `/analytics/accounts/${acc}?from=${from}&to=${to}`);
  } catch (e) { mount(root, h('div', { class: 'notice error' }, e.message)); return; }
  const toolbar = h('div', { class: 'page-head' }, h('h2', {}, 'Analytics'),
    h('div', { class: 'row gap wrap' },
      h('select', { class: 'input slim', onchange: (e) => go({ account: e.target.value }) }, h('option', { value: '' }, 'All accounts'), state.accounts.map((a) => h('option', { value: a.id, selected: a.id === acc }, `${a.name} (${PROVIDER_META[a.provider].label})`))),
      h('div', { class: 'seg' }, [7, 30, 90].map((d) => h('button', { class: d === days ? 'on' : '', onclick: () => go({ days: d }) }, `${d}d`))),
      h('button', { class: 'btn', onclick: async (e) => { e.target.disabled = true; e.target.textContent = 'Syncing…'; try { await api('POST', '/analytics/sync', acc ? { account_id: acc } : {}); toast('Analytics updated', 'success'); } catch (err) { toast(err.message, 'error'); } renderAnalytics(root, params); } }, '↻ Sync now'),
      h('a', { class: 'btn ghost', href: `/api/v1/analytics/export.csv?kind=posts&from=${new Date(from).toISOString()}${acc ? `&account_id=${acc}` : ''}` }, 'CSV: posts'),
      acc ? h('a', { class: 'btn ghost', href: `/api/v1/analytics/export.csv?kind=account&account_id=${acc}&from=${new Date(from).toISOString()}` }, 'CSV: daily') : null));

  const cards = (acc ? ov.accounts.filter((a) => a.account_id === acc) : ov.accounts).map((a) => {
    const s = a.summary;
    const keys = ['followers', 'views', 'reach', 'watch_minutes', 'engagements', 'interactions', 'profile_views', 'new_followers'].filter((k) => s[k]);
    return h('div', { class: 'card acc-kpi', style: { '--pc': PROVIDER_META[a.provider].color } },
      h('div', { class: 'row gap' }, avatar({ provider: a.provider, name: a.name, picture: state.accounts.find((x) => x.id === a.account_id)?.picture }, 28), h('strong', {}, a.name), h('a', { class: 'small', href: `#/analytics?days=${days}&account=${a.account_id}` }, 'details →')),
      keys.length ? h('div', { class: 'kpis' }, keys.slice(0, 6).map((k) => h('div', { class: 'kpi' }, h('div', { class: 'kv' }, fmtNum(s[k].value)), h('div', { class: 'kl' }, label(k)), s[k].change ? h('div', { class: `kc ${s[k].change > 0 ? 'up' : 'down'}` }, `${s[k].change > 0 ? '+' : ''}${fmtNum(s[k].change)}`) : null))) : h('p', { class: 'muted small' }, a.sync?.last_sync_at ? 'No metrics in this range.' : 'Not synced yet — click “Sync now”.'),
      a.sync?.last_error ? h('div', { class: 'notice error small' }, a.sync.last_error) : null,
      a.sync?.last_sync_at ? h('div', { class: 'muted small' }, `Synced ${relTime(a.sync.last_sync_at)}`) : null);
  });

  let charts = null;
  if (accData) {
    const color = PROVIDER_META[state.accounts.find((x) => x.id === acc)?.provider]?.color;
    const un = accData.sync?.unavailable || {};
    const unav = Object.entries({ ...(un.account || {}) });
    charts = h('div', {},
      h('div', { class: 'chart-grid' }, Object.entries(accData.series).map(([metric, pts]) => h('div', { class: 'card chart-card' }, h('div', { class: 'row between' }, h('strong', {}, label(metric)), h('span', { class: 'muted' }, fmtNum(accData.summary[metric]?.value))), sparkChart(pts, color)))),
      unav.length ? h('details', { class: 'card small' }, h('summary', {}, `${unav.length} metric(s) not available for this account`), h('ul', {}, unav.map(([k, v]) => h('li', {}, h('strong', {}, label(k)), ': ', v)))) : null);
  }

  const metricCols = ['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'watch_minutes'];
  const topTable = h('div', { class: 'card' },
    h('div', { class: 'row between wrap' }, h('h3', {}, 'Top posts'), h('label', { class: 'row gap small' }, 'Sort by', h('select', { class: 'input slim', onchange: (e) => go({ sort: e.target.value }) }, metricCols.map((m) => h('option', { value: m, selected: m === sort }, label(m)))))),
    top.posts.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Post'), h('th', {}, 'Published'), metricCols.map((m) => h('th', { class: 'num' }, label(m))))),
      h('tbody', {}, top.posts.map((p) => h('tr', {},
        h('td', {}, h('div', { class: 'row gap' }, p.thumbnail ? h('img', { class: 'lthumb', src: p.thumbnail, alt: '', onerror: (e) => e.target.remove() }) : avatar({ provider: p.provider, name: p.account }, 24),
          h('div', {}, h('div', { class: 'ellipsis2' }, p.caption || p.kind || p.external_id), h('div', { class: 'muted small' }, p.account, p.via_postlite ? ' · via postlite' : '', p.permalink ? [' · ', h('a', { href: p.permalink, target: '_blank', rel: 'noopener' }, 'open ↗')] : null)))),
        h('td', { class: 'nowrap small' }, fmtTime(p.published_at).slice(0, 10)),
        metricCols.map((m) => h('td', { class: 'num' }, p.metrics[m] === undefined ? h('span', { class: 'muted', title: 'Not available' }, '—') : fmtNum(p.metrics[m])))))))) : h('p', { class: 'muted' }, 'No post metrics yet. Sync to fetch them.'));

  mount(root, toolbar, h('div', { class: 'kpi-grid' }, cards), charts, topTable);
}

// ---------------------------------------------------------------- Settings
export async function renderSettings(root) {
  await refreshCommon();
  const s = state.settings;
  const [keys, hooks, audit] = await Promise.all([api('GET', '/api-keys'), api('GET', '/webhooks'), api('GET', '/audit-log?limit=50')]);
  const refresh = () => renderSettings(root);
  const tzs = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [s.timezone];
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const slotInputs = Object.fromEntries(days.map((d) => { const i = h('input', { class: 'input slim', placeholder: 'e.g. 09:00, 18:30' }); i.value = (s.posting_slots[d] || []).join(', '); return [d, i]; }));

  const general = h('div', { class: 'card' }, h('h3', {}, 'General'),
    h('label', { class: 'field' }, h('span', {}, 'Timezone'), h('select', { class: 'input', id: 'tz' }, tzs.map((t) => h('option', { value: t, selected: t === s.timezone }, t)))),
    h('div', { class: 'label' }, 'Posting slots (used by “Next free slot” and agents’ next_slot mode)'),
    h('div', { class: 'slots' }, days.map((d) => h('label', { class: 'slot-row' }, h('span', {}, d.toUpperCase()), slotInputs[d]))),
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: async () => {
      try {
        await api('PATCH', '/settings', { timezone: root.querySelector('#tz').value, posting_slots: Object.fromEntries(days.map((d) => [d, slotInputs[d].value.split(',').map((x) => x.trim()).filter(Boolean)])) });
        toast('Settings saved', 'success'); refresh();
      } catch (e) { toast(e.message, 'error', 6000); }
    } }, 'Save')),
    h('p', { class: 'muted small' }, `Public URL: ${s.public_url} · Graph API ${s.graph_api_version} · analytics sync every ${s.analytics_interval_hours}h`));

  const scopeBoxes = Object.fromEntries(['read', 'write', 'publish', 'analytics', 'admin'].map((sc) => [sc, h('input', { type: 'checkbox', checked: sc !== 'admin' })]));
  const keyName = h('input', { class: 'input', placeholder: 'e.g. Claude Desktop' });
  const approval = h('input', { type: 'checkbox', checked: true });
  const rate = h('input', { class: 'input slim', type: 'number', value: 120, min: 1 });
  const apiKeys = h('div', { class: 'card' }, h('h3', {}, 'API keys (for AI agents & scripts)'),
    h('p', { class: 'muted small' }, 'Agents use these with the REST API (', h('a', { href: '/api/v1/openapi.json', target: '_blank' }, 'OpenAPI'), '), the MCP server at ', h('code', {}, `${s.public_url}/mcp`), ' or the CLI. See ', h('a', { href: '/llms.txt', target: '_blank' }, 'llms.txt'), '.'),
    h('div', { class: 'key-form' },
      h('label', { class: 'field' }, h('span', {}, 'Name'), keyName),
      h('div', { class: 'row gap wrap' }, Object.entries(scopeBoxes).map(([sc, cb]) => h('label', { class: 'check', title: keys.scopes[sc] }, cb, sc))),
      h('label', { class: 'check' }, approval, h('span', {}, h('strong', {}, 'Approval mode'), ' — posts created by this key wait for your approval')),
      h('label', { class: 'row gap small' }, 'Rate limit / min', rate),
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = await api('POST', '/api-keys', { name: keyName.value || 'agent', scopes: Object.entries(scopeBoxes).filter(([, cb]) => cb.checked).map(([k]) => k), approval_mode: approval.checked, rate_limit_per_min: Number(rate.value) || 120 });
          const mcpCfg = JSON.stringify({ mcpServers: { postlite: { type: 'http', url: `${s.public_url}/mcp`, headers: { Authorization: `Bearer ${r.api_key.key}` } } } }, null, 2);
          modal(h('div', {}, h('h3', {}, 'Your new API key'), h('p', { class: 'muted' }, 'Copy it now — it will not be shown again.'), h('code', { class: 'block select' }, r.api_key.key),
            h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(r.api_key.key).then(() => toast('Copied', 'success')) }, 'Copy key'),
            h('p', { class: 'small' }, 'MCP client config (Streamable HTTP):'), h('pre', { class: 'block' }, mcpCfg)));
          refresh();
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Create key')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Name', 'Key', 'Scopes', 'Approval', 'Last used', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, keys.api_keys.map((k) => h('tr', { class: k.revoked_at ? 'revoked' : '' },
        h('td', {}, k.name), h('td', {}, h('code', {}, `pl_${k.prefix}_…`)), h('td', { class: 'small' }, k.scopes.join(', ')),
        h('td', {}, k.revoked_at ? '—' : h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: k.approval_mode, onchange: async (e) => { await api('PATCH', `/api-keys/${k.id}`, { approval_mode: e.target.checked }); toast('Updated'); } }), h('span', {}))),
        h('td', { class: 'small' }, k.revoked_at ? 'revoked' : k.last_used_at ? relTime(k.last_used_at) : 'never'),
        h('td', {}, k.revoked_at ? null : h('button', { class: 'btn small ghost danger', onclick: async () => { if (await confirmDialog(`Revoke "${k.name}"?`, { ok: 'Revoke', danger: true })) { await api('DELETE', `/api-keys/${k.id}`); refresh(); } } }, 'Revoke'))))))));

  const hookUrl = h('input', { class: 'input', placeholder: 'https://example.com/hooks/postlite' });
  const evBoxes = Object.fromEntries(['post.published', 'post.failed', 'post.pending_approval', 'account.needs_reconnect', 'analytics.synced'].map((e) => [e, h('input', { type: 'checkbox', checked: true })]));
  const webhooks = h('div', { class: 'card' }, h('h3', {}, 'Webhooks'),
    h('p', { class: 'muted small' }, 'Signed with HMAC-SHA256: header X-Postlite-Signature: t=<unix>,v1=<hex of HMAC(secret, "t.body")>. Failed deliveries are retried with backoff.'),
    h('div', { class: 'key-form' }, h('label', { class: 'field' }, h('span', {}, 'URL'), hookUrl),
      h('div', { class: 'row gap wrap' }, Object.entries(evBoxes).map(([e, cb]) => h('label', { class: 'check' }, cb, e))),
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = await api('POST', '/webhooks', { url: hookUrl.value, events: Object.entries(evBoxes).filter(([, cb]) => cb.checked).map(([k]) => k) });
          modal(h('div', {}, h('h3', {}, 'Webhook created'), h('p', {}, 'Signing secret (shown once):'), h('code', { class: 'block select' }, r.webhook.secret)));
          refresh();
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Add webhook')),
    hooks.webhooks.map((w) => h('div', { class: 'hook-row' }, h('div', {}, h('code', {}, w.url), h('div', { class: 'muted small' }, w.events.join(', '))),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn small', onclick: async () => { const r = await api('POST', `/webhooks/${w.id}/test`, {}); const d = r.deliveries[0]; toast(d?.state === 'delivered' ? `Delivered (HTTP ${d.last_status})` : `Not delivered: ${d?.last_error || d?.last_status}`, d?.state === 'delivered' ? 'success' : 'error'); } }, 'Send test'),
        h('button', { class: 'btn small ghost', onclick: async () => { const r = await api('GET', `/webhooks/${w.id}/deliveries`); modal(h('div', {}, h('h3', {}, 'Recent deliveries'), h('table', { class: 'table' }, h('tbody', {}, r.deliveries.map((d) => h('tr', {}, h('td', {}, d.event), h('td', {}, d.state), h('td', {}, d.last_status || d.last_error || ''), h('td', { class: 'small' }, fmtTime(d.created_at)))))))); } }, 'Log'),
        h('button', { class: 'btn small ghost danger', onclick: async () => { if (await confirmDialog('Delete webhook?', { ok: 'Delete', danger: true })) { await api('DELETE', `/webhooks/${w.id}`); refresh(); } } }, 'Delete')))));

  const auditCard = h('div', { class: 'card' }, h('h3', {}, 'Audit log'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table small' }, h('thead', {}, h('tr', {}, ['When', 'Who', 'Via', 'Action', 'Result'].map((x) => h('th', {}, x)))),
      h('tbody', {}, audit.entries.map((e) => h('tr', {}, h('td', { class: 'nowrap' }, fmtTime(e.at)), h('td', {}, e.actor_name || e.actor_type), h('td', {}, e.via), h('td', {}, e.operation, e.target ? h('span', { class: 'muted' }, ` ${String(e.target).slice(0, 8)}`) : null), h('td', { class: e.status >= 400 ? 'err' : 'ok' }, e.status)))))));

  mount(root, h('div', { class: 'page-head' }, h('h2', {}, 'Settings')), h('div', { class: 'settings-grid' }, general, apiKeys, webhooks, auditCard));
}
