// Brands UI: named sets of channels (accounts) across platforms. Accounts → Brands list (quiet .plist rows
// with real platform marks) → a brand's own page (name & color, channels, delete). Shared helpers for the
// composer picker, filters and analytics.
import { h, mount, api, state, toast, confirmDialog, avatar, PROVIDER_META, MARKS, markOf, refreshCommon, icon } from './core.js';
import { pageHeader, section, setCrumbs, emptyState } from './ui.js';

export const BRAND_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#a1a1aa'];

/** Small color dot (or nothing when the brand has no color). */
export const brandDot = (b, cls = 'bdot') => (b?.color ? h('i', { class: cls, 'aria-hidden': 'true', style: { background: b.color } }) : null);

function mark(kind) { const el = h('span', { class: 'pmark' }); el.innerHTML = MARKS[kind] || ''; return el; }
/** Overlapping platform marks of a brand's channels (one per platform). */
export function brandMarks(providers) {
  const kinds = [...new Set((providers || []).map(markOf))];
  return kinds.length ? h('span', { class: 'pmarks' }, kinds.slice(0, 4).map(mark)) : h('span', { class: 'pmark muted' }, icon('accounts', 16));
}

/** Small text tags: the brands an account belongs to. */
export function brandTags(accountId) {
  const list = (state.brands || []).filter((b) => b.channel_ids.includes(accountId));
  return list.length ? h('span', { class: 'btags' }, list.map((b) => h('span', { class: 'btag' }, brandDot(b), b.name))) : null;
}

const platformList = (providers) => [...new Set((providers || []).map((p) => PROVIDER_META[p]?.label.replace(' Page', '') || p))].join(', ');
const channelsText = (n) => `${n} channel${n === 1 ? '' : 's'}`;

/** Accounts page: the Brands section (list + suggestions). */
export function brandsSection() {
  const brands = state.brands || [];
  const sugg = state.brandSuggestions || [];
  const newBtn = h('a', { class: 'btn small', href: '#/accounts/brands/new' }, icon('plus', 14), 'New brand');
  const rows = brands.map((b) => h('a', { class: 'plist-row plist-link', href: `#/accounts/brands/${b.id}` },
    brandMarks(b.providers),
    h('div', { class: 'plist-text' },
      h('div', { class: 'plist-name' }, brandDot(b), b.name),
      h('div', { class: 'plist-desc' }, b.channels.length ? `${channelsText(b.channels.length)} · ${platformList(b.providers)}` : 'No channels yet')),
    icon('chevron-right', 16)));
  const suggRows = sugg.map((s) => h('div', { class: 'plist-row' },
    brandMarks(s.providers),
    h('div', { class: 'plist-text' },
      h('div', { class: 'plist-name' }, s.name, h('span', { class: 'pl-note' }, 'Suggested')),
      h('div', { class: 'plist-desc' }, `${channelsText(s.account_ids.length)} share this name · ${platformList(s.providers)}`)),
    h('button', { class: 'btn small', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { const r = await api('POST', '/brands', { name: s.name, color: BRAND_COLORS[brands.length % BRAND_COLORS.length], account_ids: s.account_ids }); toast(`Brand “${r.brand.name}” created`, 'success'); location.hash = `#/accounts/brands/${r.brand.id}`; } catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
    }, 'aria-label': `Create brand ${s.name} from these ${s.account_ids.length} channels` }, 'Create', h('span', { class: 'hide-sm' }, ' brand from these'))));
  return h('div', {},
    h('div', { class: 'h-section-row' }, h('h2', { class: 'h-section' }, 'Brands', h('span', { class: 'count' }, brands.length)), newBtn),
    rows.length || suggRows.length
      ? h('div', { class: 'plist' }, rows, suggRows)
      : h('p', { class: 'muted small brands-empty' }, 'Group a brand’s channels (for example its YouTube, Instagram and Facebook) to post to all of them in one click and see their analytics together.'));
}

/** #/accounts/brands/<id|new>: one brand's page. */
export async function renderBrand(root, id) {
  await refreshCommon();
  const isNew = id === 'new';
  const b = isNew ? { id: null, name: '', color: BRAND_COLORS[5], channel_ids: [] } : (state.brands || []).find((x) => x.id === id);
  setCrumbs([['postlite', '#/dashboard'], ['Accounts', '#/accounts'], [isNew ? 'New brand' : b?.name || 'Brand']]);
  const back = h('a', { class: 'back-link small', href: '#/accounts' }, icon('chevron-left', 14), 'Accounts');
  if (!b) { mount(root, back, h('div', { class: 'card' }, emptyState({ icon: 'accounts', title: 'Brand not found', body: 'It may have been deleted.' }))); return; }
  let color = b.color;
  const chosen = new Set(b.channel_ids);
  const name = h('input', { class: 'input', value: b.name, placeholder: 'e.g. North Star', maxlength: 60, 'aria-label': 'Brand name' });
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Color' });
  const drawSw = () => mount(swatches, [null, ...BRAND_COLORS].map((c) => h('button', {
    type: 'button', class: `swatch ${c === color ? 'on' : ''} ${c ? '' : 'none'}`, role: 'radio', 'aria-checked': c === color ? 'true' : 'false', 'aria-label': c || 'No color', title: c || 'No color',
    style: c ? { background: c } : null, onclick: () => { color = c; drawSw(); },
  })));
  drawSw();
  const save = h('button', { class: 'btn primary', onclick: async () => {
    try {
      if (isNew) {
        const r = await api('POST', '/brands', { name: name.value, color, account_ids: [...chosen] });
        toast('Brand created', 'success');
        location.hash = `#/accounts/brands/${r.brand.id}`;
      } else {
        await api('PATCH', `/brands/${b.id}`, { name: name.value, color });
        toast('Saved', 'success');
        renderBrand(root, b.id);
      }
    } catch (e) { toast(e.message, 'error'); }
  } }, isNew ? 'Create brand' : 'Save');

  const toggle = async (a, on) => {
    if (on) chosen.add(a.id); else chosen.delete(a.id);
    if (isNew) return;
    try { await api('PUT', `/brands/${b.id}/channels`, { account_ids: [a.id], mode: on ? 'add' : 'remove' }); toast(on ? `Added ${a.name}` : `Removed ${a.name}`, 'success', 1800); await refreshCommon(); } catch (e) { toast(e.message, 'error'); }
  };
  const channels = state.accounts.length ? h('div', { class: 'plist' }, state.accounts.map((a) => h('label', { class: 'plist-row check-row' },
    avatar(a, 28),
    h('div', { class: 'plist-text' }, h('div', { class: 'plist-name' }, a.name), h('div', { class: 'plist-desc' }, PROVIDER_META[a.provider]?.label, a.status !== 'active' ? ' · needs reconnect' : '')),
    h('input', { type: 'checkbox', checked: chosen.has(a.id), 'aria-label': `${a.name} (${PROVIDER_META[a.provider]?.label}) in this brand`, onchange: (e) => toggle(a, e.target.checked) }))))
    : h('p', { class: 'muted' }, 'Connect an account first.');

  mount(root, h('div', { class: 'app-detail' },
    back,
    pageHeader({ eyebrow: 'Brand', title: isNew ? 'New brand' : b.name }),
    h('div', { class: 'stack' },
      section('Name and color', { sub: 'Shown in the composer, post filters and analytics.' },
        h('div', { class: 'form-row' }, h('label', { class: 'field grow' }, h('span', {}, 'Name'), name)),
        h('div', { class: 'field' }, h('span', {}, 'Color'), swatches),
        h('div', { class: 'row end' }, save)),
      section('Channels', { sub: 'The accounts in this brand. An account can be in several brands.' }, channels),
      isNew ? null : section('Delete', { sub: 'Removes the brand only. Its accounts, posts and analytics stay.' },
        h('div', { class: 'row end' }, h('button', { class: 'btn danger-outline', onclick: async () => {
          if (!(await confirmDialog(`Delete the brand “${b.name}”?`, { ok: 'Delete', danger: true }))) return;
          try { await api('DELETE', `/brands/${b.id}`); toast('Brand deleted'); location.hash = '#/accounts'; } catch (e) { toast(e.message, 'error'); }
        } }, 'Delete brand'))))));
}

/** <select> of brands for filters (value = brand id, '' = all). */
export function brandSelect(value, onChange, { all = 'All brands' } = {}) {
  const sel = h('select', { class: 'input slim', 'aria-label': 'Brand', onchange: (e) => onChange(e.target.value) },
    h('option', { value: '' }, all), (state.brands || []).map((b) => h('option', { value: b.id, selected: b.id === value }, b.name)));
  sel.value = value || '';
  return sel;
}
