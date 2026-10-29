// Media library (#/media): grid of uploads with search, type/usage filters, drag-and-drop upload,
// delete (single or every unused item on the page), "use in new post" and pagination.
import { h, mount, api, toast, confirmDialog, uploadFile, fmtBytes, fmtDate, icon, debounce } from './core.js';
import { pageHeader, segmented, emptyState, skeleton, dropdown } from './ui.js';
import { mediaVisual, ensurePoster, REMOVED_NOTE } from './media.js';
import { openComposer } from './composer.js';

const PAGE = 24;
const KINDS = [['', 'All'], ['image', 'Images'], ['video', 'Videos'], ['document', 'PDFs']];
const USAGE = [['', 'Any use'], ['used', 'Used in posts'], ['unused', 'Unused'], ['purged', 'Removed after publishing']];

const go = (p) => { const q = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== '' && v !== undefined && v !== null && v !== 0)); location.hash = `#/media${q.size ? `?${q}` : ''}`; };

export async function renderMedia(root, params = {}) {
  const q = params.q || '', kind = params.kind || '', usage = params.usage || '', page = Math.max(Number(params.page || 1), 1);
  const state = { q, kind, usage, page };
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, accept: 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,application/pdf', onchange: (e) => upload([...e.target.files]) });
  const progress = h('div', { class: 'uploads lib-uploads' });
  const head = pageHeader({ title: 'Media', sub: 'Everything uploaded to this workspace. Originals are removed after publishing; thumbnails stay.', actions: [
    h('button', { class: 'btn primary', onclick: () => fileInput.click() }, icon('upload', 15), 'Upload'), fileInput] });
  const search = h('input', { class: 'input slim search', type: 'search', placeholder: 'Search file names', value: q, 'aria-label': 'Search media by file name' });
  search.addEventListener('input', debounce(() => go({ ...state, q: search.value.trim(), page: 1 }), 300));
  const usageSel = h('select', { class: 'input slim', 'aria-label': 'Usage', onchange: (e) => go({ ...state, usage: e.target.value, page: 1 }) }, USAGE.map(([v, l]) => h('option', { value: v, selected: v === usage }, l)));
  const toolbar = h('div', { class: 'toolbar lib-toolbar' },
    h('div', { class: 'row gap wrap grow' }, search, h('label', { class: 'select-wrap' }, usageSel)),
    segmented(KINDS, kind, (v) => go({ ...state, kind: v, page: 1 }), { label: 'Type' }));
  mount(root, head, toolbar, progress, skeleton('cards', 4));

  async function upload(files) {
    for (const f of files) {
      const bar = h('div', { class: 'bar' }, h('span', { style: { width: '0%' } }));
      const row = h('div', { class: 'upload-row' }, h('span', { class: 'name ellipsis' }, f.name), h('span', { class: 'muted small mono' }, fmtBytes(f.size)), bar);
      progress.append(row);
      try {
        const md = await uploadFile(f, (p) => { bar.firstChild.style.width = `${Math.round(p * 100)}%`; });
        if ((md.kind === 'video' || md.kind === 'image') && !md.poster) await ensurePoster(md, f).catch(() => {});
        row.remove();
      } catch (e) { row.classList.add('error'); row.append(h('span', { class: 'err small' }, e.message)); }
    }
    toast(files.length > 1 ? `${files.length} files uploaded` : 'Uploaded', 'success');
    renderMedia(root, { ...state, page: 1 });
  }

  let data;
  try { data = await api('GET', `/media?limit=${PAGE}&offset=${(page - 1) * PAGE}&counts=true${q ? `&q=${encodeURIComponent(q)}` : ''}${kind ? `&kind=${kind}` : ''}${usage ? `&usage=${usage}` : ''}`); }
  catch (e) { mount(root, head, toolbar, h('div', { class: 'notice error' }, e.message)); return; }
  const refresh = () => renderMedia(root, state);
  const items = data.media;
  const unusedHere = items.filter((m) => m.deletable && !m.used_by_posts && !m.purged);

  const del = async (ids, label) => {
    if (!(await confirmDialog(label, { ok: 'Delete', danger: true }))) return;
    const r = await api('POST', '/media/delete', { media_ids: ids });
    toast(r.skipped.length ? `Deleted ${r.deleted.length}; ${r.skipped.length} kept (${r.skipped[0].reason})` : `Deleted ${r.deleted.length}`, r.skipped.length ? 'info' : 'success', 5000);
    refresh();
  };
  const useInPost = (m) => openComposer({ media: [m], onSaved: () => { location.hash = '#/dashboard'; } });

  const tile = (m) => h('div', { class: `lib-tile ${m.purged ? 'purged' : ''}` },
    h('button', { class: 'lib-thumb', type: 'button', title: m.purged ? REMOVED_NOTE : `Use ${m.name} in a new post`, disabled: m.purged || null, onclick: () => useInPost(m) },
      mediaVisual(m, { alt: m.name || '' }),
      m.kind === 'video' && m.duration ? h('span', { class: 'lib-dur mono' }, `${Math.round(m.duration)}s`) : null),
    h('div', { class: 'lib-meta' },
      h('div', { class: 'lib-name ellipsis', title: m.name }, m.name || 'Untitled'),
      h('div', { class: 'lib-sub muted small' },
        h('span', { class: `lib-use ${m.purged ? 'removed' : m.used_by_posts || m.in_series ? 'used' : ''}` }, m.purged ? 'Removed' : m.in_series ? 'Repeating post' : m.used_by_posts ? `In ${m.used_by_posts} post${m.used_by_posts === 1 ? '' : 's'}` : 'Unused'),
        h('span', { class: 'mono', title: m.purged ? `${REMOVED_NOTE} on ${fmtDate(m.purged_at)}` : null }, m.purged ? fmtDate(m.purged_at).slice(5) : fmtBytes(m.size))),
      h('button', { class: 'icon-btn lib-more', 'aria-label': `Actions for ${m.name}`, 'aria-haspopup': 'menu', onclick: (e) => dropdown(e.currentTarget, [
        m.purged ? null : { label: 'Use in new post', icon: 'edit', onClick: () => useInPost(m) },
        m.purged ? null : { label: 'Open original', icon: 'external', href: m.url, target: '_blank' },
        { label: 'Copy media ID', icon: 'copy', onClick: async () => { await navigator.clipboard.writeText(m.id); toast('Copied media ID', 'success', 1500); } },
        { sep: true },
        { label: m.deletable ? 'Delete' : 'Delete (in use)', icon: 'trash', danger: true, disabled: !m.deletable, onClick: () => del([m.id], `Delete ${m.name}? Published posts keep their links.`) },
      ], { align: 'right' }) }, icon('more', 15))));

  const c = data.counts || {};
  const from = data.total ? (page - 1) * PAGE + 1 : 0, to = Math.min(page * PAGE, data.total);
  const pager = data.total > PAGE ? h('div', { class: 'pager' },
    h('span', { class: 'muted small mono' }, `${from}–${to} of ${data.total}`),
    h('div', { class: 'btn-group' },
      h('button', { class: 'btn small', disabled: page <= 1 || null, onclick: () => go({ ...state, page: page - 1 }) }, icon('chevron-left', 14), 'Previous'),
      h('button', { class: 'btn small', disabled: to >= data.total || null, onclick: () => go({ ...state, page: page + 1 }) }, 'Next', icon('chevron-right', 14)))) : null;

  const drop = h('div', { class: 'lib-drop', hidden: true }, icon('upload', 22), h('strong', {}, 'Drop to upload'));
  const body = items.length ? h('div', { class: 'lib-grid' }, items.map(tile))
    : h('div', { class: 'card' }, q || kind || usage ? emptyState({ icon: 'image', compact: true, title: 'Nothing matches', body: 'Try another search or filter.' })
      : emptyState({ icon: 'image', title: 'No media yet', body: 'Drop images, videos or PDFs here, or use Upload. They become available in the composer.', action: h('button', { class: 'btn primary', onclick: () => fileInput.click() }, icon('upload', 14), 'Upload') }));
  const summary = h('div', { class: 'lib-summary' },
    h('span', { class: 'muted small' }, `${c.all ?? data.total} item${(c.all ?? data.total) === 1 ? '' : 's'} · ${c.used || 0} used · ${c.unused || 0} unused · ${c.purged || 0} original${c.purged === 1 ? '' : 's'} removed after publishing`),
    unusedHere.length ? h('button', { class: 'btn small ghost danger', onclick: () => del(unusedHere.map((m) => m.id), `Delete ${unusedHere.length} unused item${unusedHere.length === 1 ? '' : 's'} on this page?`) }, icon('trash', 13), `Delete unused on this page (${unusedHere.length})`) : null);
  mount(root, head, toolbar, progress, summary, body, pager, drop);

  // Drag and drop anywhere on the page.
  const onOver = (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.hidden = false; } };
  const onLeave = (e) => { if (e.target === drop || !e.relatedTarget) drop.hidden = true; };
  const onDrop = (e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); drop.hidden = true; upload([...e.dataTransfer.files]); };
  root.ondragover = onOver; root.ondragleave = onLeave; root.ondrop = onDrop;
  window.addEventListener('hashchange', () => { root.ondragover = root.ondragleave = root.ondrop = null; }, { once: true });
}
