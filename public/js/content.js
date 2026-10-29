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

// ---------------------------------------------------------------- signatures
const PLATFORM_OPTS = [['youtube', 'YouTube'], ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['linkedin', 'LinkedIn'], ['x', 'X']];
const PROV_PLATFORM = { youtube: 'youtube', facebook: 'facebook', instagram: 'instagram', 'instagram-standalone': 'instagram', linkedin: 'linkedin', 'linkedin-page': 'linkedin', x: 'x' };

export async function loadSignatures() { try { state.signatures = (await api('GET', '/signatures')).signatures; } catch { state.signatures = []; } return state.signatures; }
export async function loadTemplates() { try { state.templates = (await api('GET', '/templates')).templates; } catch { state.templates = []; } return state.templates; }

/** Text that signature `sig` adds after `text` (same rule as the server's appendSignature). */
export function withSignature(text, sig) {
  const t = String(text || '').replace(/\s+$/, '');
  const s2 = String(sig || '').trim();
  if (!s2 || t.endsWith(s2)) return t;
  return t ? `${t}\n\n${s2}` : s2;
}
/** Does an auto-add signature apply to any of these accounts? */
export function sigApplies(sg, accounts) {
  if (!sg.auto_add || !accounts.length) return false;
  if (!sg.platforms.length && !sg.account_ids.length) return true;
  return accounts.some((a) => sg.account_ids.includes(a.id) || sg.platforms.includes(PROV_PLATFORM[a.provider]));
}
const scopeText = (sg) => {
  if (!sg.auto_add) return 'Insert from the composer';
  const parts = [...sg.platforms.map((p) => PLATFORM_OPTS.find((o) => o[0] === p)?.[1] || p), ...sg.account_ids.map((id) => state.accounts.find((a) => a.id === id)?.name || 'removed channel')];
  return `Added automatically${parts.length ? ` for ${parts.join(', ')}` : ' to every new post'}`;
};

function signatureDialog(sg = null, done = () => {}) {
  const name = h('input', { class: 'input', value: sg?.name || '', placeholder: 'e.g. Sign-off, IG hashtags', 'aria-label': 'Signature name' });
  const content = h('textarea', { class: 'input', rows: 4, placeholder: '— The North Star team · example.com', 'aria-label': 'Signature text' });
  content.value = sg?.content || '';
  const auto = h('input', { type: 'checkbox', checked: !!sg?.auto_add });
  const connected = [...new Set(state.accounts.map((a) => PROV_PLATFORM[a.provider]))];
  const plats = PLATFORM_OPTS.filter(([v]) => connected.includes(v) || sg?.platforms.includes(v)).map(([v, l]) => ({ v, box: h('input', { type: 'checkbox', checked: !!sg?.platforms.includes(v) }), l }));
  const chans = state.accounts.map((a) => ({ a, box: h('input', { type: 'checkbox', checked: !!sg?.account_ids.includes(a.id) }) }));
  const scope = h('div', { class: 'sig-scope' },
    h('div', { class: 'muted small' }, 'Only for these platforms or channels (none ticked = every channel):'),
    h('div', { class: 'check-row' }, plats.map((x) => h('label', { class: 'check' }, x.box, x.l))),
    chans.length ? h('details', { class: 'sig-chans' }, h('summary', { class: 'small' }, 'Specific channels'), h('div', { class: 'check-col' }, chans.map((x) => h('label', { class: 'check' }, x.box, x.a.name, h('span', { class: 'muted small' }, ` · ${x.a.provider}`))))) : null);
  const sync = () => { scope.hidden = !auto.checked; };
  auto.addEventListener('change', sync); sync();
  const m = modal(h('form', { class: 'confirm wide-confirm', onsubmit: async (e) => {
    e.preventDefault();
    const body = { name: name.value, content: content.value, auto_add: auto.checked, platforms: plats.filter((x) => x.box.checked).map((x) => x.v), account_ids: chans.filter((x) => x.box.checked).map((x) => x.a.id) };
    try { if (sg) await api('PATCH', `/signatures/${sg.id}`, body); else await api('POST', '/signatures', body); m.close(); toast('Signature saved', 'success'); done(); } catch (err) { toast(err.message, 'error'); }
  } }, h('h3', { class: 'confirm-title' }, sg ? 'Edit signature' : 'New signature'),
  h('label', { class: 'field' }, h('span', {}, 'Name'), name), h('label', { class: 'field' }, h('span', {}, 'Text'), content),
  h('label', { class: 'check' }, auto, 'Add automatically to new posts'), scope,
  h('div', { class: 'row end gap' }, h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Save'))), { label: 'Signature' });
  setTimeout(() => name.focus(), 30);
}

export async function signaturesSection(rerender) {
  const list = await loadSignatures();
  return section('Signatures', { sub: 'Saved sign-offs, links and hashtag blocks. Insert them from the composer, or add them automatically per platform or channel.', actions: h('button', { class: 'btn small', onclick: () => signatureDialog(null, rerender) }, icon('plus', 13), 'New signature') },
    list.length ? h('div', { class: 'plist' }, list.map((sg) => h('div', { class: 'plist-row' },
      h('div', { class: 'plist-text' }, h('div', { class: 'plist-name' }, sg.name, sg.auto_add ? h('span', { class: 'pl-note' }, 'Auto') : null), h('div', { class: 'plist-desc keep-sm' }, `${scopeText(sg)} · “${sg.content.replace(/\s+/g, ' ').slice(0, 60)}${sg.content.length > 60 ? '…' : ''}”`)),
      h('button', { class: 'icon-btn', 'aria-label': `Actions for signature ${sg.name}`, 'aria-haspopup': 'menu', onclick: (e) => dropdown(e.currentTarget, [
        { label: 'Edit', icon: 'edit', onClick: () => signatureDialog(sg, rerender) },
        { label: 'Delete', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog(`Delete the signature “${sg.name}”? Posts that already contain it keep their text.`, { ok: 'Delete', danger: true })) { await api('DELETE', `/signatures/${sg.id}`); toast('Signature deleted'); rerender(); } } },
      ], { align: 'right' }) }, icon('more', 15)))))
      : emptyState({ icon: 'edit', compact: true, title: 'No signatures yet', body: 'For example a sign-off, your link-in-bio line or a block of hashtags.' }));
}

// ---------------------------------------------------------------- templates
export async function templatesSection(rerender, openWith) {
  const list = await loadTemplates();
  return section('Templates', { sub: 'Saved posts to start from: caption, channels and their settings, brand and tags. Media is never saved in a template. Save one from the composer.' },
    list.length ? h('div', { class: 'plist' }, list.map((t) => {
      const chans = t.targets.map((x) => state.accounts.find((a) => a.id === x.account_id)).filter(Boolean);
      return h('div', { class: 'plist-row' },
        h('div', { class: 'plist-text' }, h('div', { class: 'plist-name' }, t.name), h('div', { class: 'plist-desc' }, `${chans.length ? `${chans.length} channel${chans.length === 1 ? '' : 's'}` : t.brand_id ? 'Brand' : 'No channels'} · “${(t.content || '').replace(/\s+/g, ' ').slice(0, 60) || 'no caption'}”`)),
        h('button', { class: 'btn small', onclick: () => openWith(t) }, 'Use'),
        h('button', { class: 'icon-btn', 'aria-label': `Actions for template ${t.name}`, 'aria-haspopup': 'menu', onclick: (e) => dropdown(e.currentTarget, [
          { label: 'Rename', icon: 'edit', onClick: async () => { const n = await confirmDialog('New name for this template', { ok: 'Rename', input: t.name, title: 'Rename template' }); if (n && n.trim()) { await api('PATCH', `/templates/${t.id}`, { name: n.trim() }); rerender(); } } },
          { label: 'Delete', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog(`Delete the template “${t.name}”? Posts made from it stay.`, { ok: 'Delete', danger: true })) { await api('DELETE', `/templates/${t.id}`); toast('Template deleted'); rerender(); } } },
        ], { align: 'right' }) }, icon('more', 15)));
    }))
      : emptyState({ icon: 'posts', compact: true, title: 'No templates yet', body: 'In the composer, use “Save as template” to keep a post’s caption, channels and settings for next time.' }));
}
