// Reusable content: tags (labels on posts). Settings → Content lists them; the composer, posts list,
// calendar and analytics use the pickers/filters below.
import { h, mount, api, state, toast, confirmDialog, modal, icon } from './core.js';
import { section, dropdown, emptyState, closeMenus } from './ui.js';

export const TAG_COLORS = ['#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#a1a1aa'];

export function tagDot(t, cls = 'bdot') { const el = h('i', { class: cls, 'aria-hidden': 'true' }); el.style.background = t?.color || 'var(--text-3)'; return el; }
/** Small tag label; with onRemove shows an ×. */
export function tagChip(t, { onRemove = null } = {}) {
  return h('span', { class: 'tag-chip' }, tagDot(t), h('span', {}, t.name),
    onRemove ? h('button', { type: 'button', class: 'tc-x', 'aria-label': `Remove tag ${t.name}`, onclick: (e) => { e.stopPropagation(); onRemove(); } }, icon('x', 11)) : null);
}

export async function loadTags() {
  try { state.tags = (await api('GET', '/tags')).tags; } catch { state.tags = state.tags || []; }
  return state.tags;
}

/** <select> filter of tags (value = tag id, '' = all). */
export function tagSelect(value, onChange, { all = 'All tags' } = {}) {
  const sel = h('select', { class: 'input slim', 'aria-label': 'Tag', onchange: (e) => onChange(e.target.value) },
    h('option', { value: '' }, all), (state.tags || []).map((t) => h('option', { value: t.id, selected: t.id === value }, `# ${t.name}`)));
  sel.value = value || '';
  return sel;
}

/** Composer tag picker: selected chips + "Add tag" menu (existing tags, or create one by typing). */
export function tagPicker(selected, onChange) {
  const wrap = h('div', { class: 'tag-picker' });
  const draw = () => {
    const chosen = selected.map((ref) => (state.tags || []).find((t) => t.id === ref || t.name.toLowerCase() === String(ref).toLowerCase()) || { id: ref, name: ref, color: null });
    mount(wrap, chosen.map((t, i) => tagChip(t, { onRemove: () => { selected.splice(i, 1); onChange(selected); draw(); } })),
      h('button', { type: 'button', class: 'btn small ghost', 'aria-haspopup': 'menu', onclick: (e) => open(e.currentTarget) }, icon('tag', 13), selected.length ? 'Add' : 'Add tag'));
  };
  const open = (anchor) => {
    const input = h('input', { class: 'input slim', placeholder: 'New tag name', 'aria-label': 'New tag name' });
    const add = (ref) => { if (!selected.some((x) => String(x).toLowerCase() === String(ref).toLowerCase())) selected.push(ref); onChange(selected); draw(); };
    const avail = (state.tags || []).filter((t) => !selected.includes(t.id) && !selected.some((x) => String(x).toLowerCase() === t.name.toLowerCase()));
    dropdown(anchor, [
      ...avail.map((t) => ({ node: h('button', { type: 'button', class: 'menu-item', role: 'menuitem', tabindex: '-1', onclick: () => { add(t.id); closeMenus(); } }, tagDot(t, 'bdot menu-dot'), h('span', { class: 'mi-label' }, t.name)) })),
      avail.length ? { sep: true } : null,
      { node: h('form', { class: 'menu-form', onsubmit: async (e) => { e.preventDefault(); const n = input.value.trim().replace(/^#/, ''); if (!n) return; try { const { tag } = await api('POST', '/tags', { name: n }); state.tags = [...(state.tags || []), tag]; add(tag.id); closeMenus(); } catch (err) { if (err.status === 409) { add(n); closeMenus(); } else toast(err.message, 'error'); } } },
        h('div', { class: 'row gap' }, input, h('button', { type: 'submit', class: 'btn small' }, 'Create'))) },
    ], { width: 240 });
    setTimeout(() => (avail.length ? null : input.focus()), 30);
  };
  draw();
  return wrap;
}

function colorSwatches(value, onPick) {
  return h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Color' }, TAG_COLORS.map((c) => {
    const b = h('button', { type: 'button', class: `swatch ${c === value ? 'on' : ''}`, role: 'radio', 'aria-checked': c === value ? 'true' : 'false', 'aria-label': c, onclick: () => onPick(c) });
    b.style.background = c;
    return b;
  }));
}

/** Create/edit dialog for a tag. */
function tagDialog(t = null, done = () => {}) {
  let color = t?.color || TAG_COLORS[(state.tags || []).length % TAG_COLORS.length];
  const name = h('input', { class: 'input', value: t?.name || '', placeholder: 'e.g. launch, evergreen, promo', 'aria-label': 'Tag name' });
  const sw = h('div');
  const drawSw = () => mount(sw, colorSwatches(color, (c) => { color = c; drawSw(); }));
  drawSw();
  const m = modal(h('form', { class: 'confirm', onsubmit: async (e) => {
    e.preventDefault();
    try { if (t) await api('PATCH', `/tags/${t.id}`, { name: name.value, color }); else await api('POST', '/tags', { name: name.value, color }); m.close(); toast(t ? 'Tag saved' : 'Tag created', 'success'); done(); } catch (err) { toast(err.message, 'error'); }
  } }, h('h3', { class: 'confirm-title' }, t ? 'Edit tag' : 'New tag'),
  h('label', { class: 'field' }, h('span', {}, 'Name'), name), h('div', { class: 'field' }, h('span', {}, 'Color'), sw),
  h('div', { class: 'row end gap' }, h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, t ? 'Save' : 'Create'))), { label: 'Tag' });
  setTimeout(() => name.focus(), 30);
}

/** Settings → Content → Tags section. */
export async function tagsSection(rerender) {
  const tags = await loadTags();
  return section('Tags', { sub: 'Label posts (launch, evergreen, promo…) and filter posts, the calendar and analytics by them.', actions: h('button', { class: 'btn small', onclick: () => tagDialog(null, rerender) }, icon('plus', 13), 'New tag') },
    tags.length ? h('div', { class: 'plist' }, tags.map((t) => h('div', { class: 'plist-row' },
      tagDot(t, 'bdot lg'),
      h('div', { class: 'plist-text' }, h('div', { class: 'plist-name' }, t.name), h('div', { class: 'plist-desc' }, `${t.posts} post${t.posts === 1 ? '' : 's'}`)),
      h('a', { class: 'btn small ghost', href: `#/posts?tag=${t.id}` }, 'Posts'),
      h('button', { class: 'icon-btn', 'aria-label': `Actions for tag ${t.name}`, 'aria-haspopup': 'menu', onclick: (e) => dropdown(e.currentTarget, [
        { label: 'Edit', icon: 'edit', onClick: () => tagDialog(t, rerender) },
        { label: 'Delete', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog(`Delete the tag “${t.name}”? It is removed from ${t.posts} post${t.posts === 1 ? '' : 's'}; the posts stay.`, { ok: 'Delete', danger: true })) { await api('DELETE', `/tags/${t.id}`); toast('Tag deleted'); rerender(); } } },
      ], { align: 'right' }) }, icon('more', 15)))))
      : emptyState({ icon: 'tag', compact: true, title: 'No tags yet', body: 'Create one here or type a new tag in the composer.' }));
}
