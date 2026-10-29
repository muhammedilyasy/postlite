// Composer: global caption + per-account overrides/settings, media upload, live validation, previews.
import { h, mount, api, state, toast, modal, confirmDialog, uploadFile, avatar, statusBadge, PROVIDER_META, fmtBytes, debounce, icon, relTime, fmtDateTime } from './core.js';
import { segmented } from './ui.js';
import { mediaVisual, ensurePoster, viewOnLink, REMOVED_NOTE } from './media.js';
import { brandDot } from './brands.js';
import { captionTools, hasStyled } from './emoji.js';
import { tagPicker, loadSignatures, withSignature, sigApplies } from './content.js';
import { dropdown } from './ui.js';

const LAST_BRAND = 'pl_last_brand';
import { validatePost, defaultSettings, PLATFORMS, YOUTUBE_CATEGORIES, describeKind, captionLength, xWeightedLength } from '/assets/shared/validate.js';
import { formatLocal, parseLocal } from '/assets/shared/time.js';

export { relTime };
const info = (m) => m && ({ kind: m.kind, mime: m.mime, size: m.size, width: m.width, height: m.height, duration: m.duration, name: m.name });

export async function openComposer({ groupId = null, at = null, media = null, accountIds = null, template = null, onSaved = () => {} } = {}) {
  const tz = state.settings.timezone;
  const st = { id: null, focusEl: null, tags: [], content: '', media: [], publish_at: at, targets: new Map(), locked: new Set(), active: null, status: 'draft', approval_note: null, thumbs: new Map(), serverErrors: {} };
  if (groupId) {
    const { post } = await api('GET', `/posts/${groupId}`);
    Object.assign(st, { id: post.id, content: post.content, media: post.media, publish_at: post.publish_at, status: post.status, approval_note: post.approval_note, tags: (post.tags || []).map((t) => t.id) });
    for (const t of post.targets) {
      st.targets.set(t.integration_id, { content_override: t.content_override, settings: { ...t.settings }, status: t.status, error: t.error, warning: t.warning, published_url: t.published_url, target_id: t.id });
      if (['published', 'publishing'].includes(t.status)) st.locked.add(t.integration_id);
      const extra = [t.settings.thumbnail, ...(Array.isArray(t.settings.thread) ? t.settings.thread.flatMap((x) => x.media || []) : [])].filter(Boolean);
      for (const id of extra) {
        try { st.thumbs.set(id, (await api('GET', `/media/${id}`)).media); } catch {}
      }
    }
    st.active = post.targets[0]?.integration_id || null;
  } else {
    // New post: start with the last brand used (its connected channels); untick any of them freely.
    const lastBrand = (state.brands || []).find((b) => b.id === localStorage.getItem(LAST_BRAND));
    if (lastBrand) selectBrand(lastBrand);
    if (Array.isArray(media)) st.media = media.filter((m) => m && !m.purged); // "Use in new post" from the media library
    if (template) { // "Use template": caption, channels + their settings, brand, tags (never media)
      st.content = template.content || '';
      const tTargets = (template.targets || []).filter((x) => state.accounts.some((a) => a.id === x.account_id));
      if (tTargets.length || template.brand_id) st.targets.clear();
      for (const x of tTargets) { const a = state.accounts.find((y) => y.id === x.account_id); st.targets.set(a.id, { content_override: x.content ?? null, settings: { ...defaultSettings(a.provider), ...(x.settings || {}) } }); }
      const tb = !tTargets.length && (state.brands || []).find((b) => b.id === template.brand_id);
      if (tb) selectBrand(tb);
      st.active = [...st.targets.keys()][0] || null;
      st.tags = (template.tags || []).slice();
    }
    if (Array.isArray(accountIds)) { // "Create post" from a channel menu: exactly these channels
      st.targets.clear();
      for (const id of accountIds) { const a = state.accounts.find((x) => x.id === id); if (a) st.targets.set(a.id, { content_override: null, settings: defaultSettings(a.provider) }); }
      st.active = accountIds[0] || null;
    }
  }

  // Signatures: insert from the caption tools; auto-add ones apply to new posts once their channel is picked.
  const sigs = await loadSignatures();
  const autoDone = new Set();
  function applyAutoSignatures() {
    if (st.id) return;
    const accs = [...st.targets.keys()].map((id) => state.accounts.find((a) => a.id === id)).filter(Boolean);
    for (const sg of sigs) if (!autoDone.has(sg.id) && sigApplies(sg, accs)) { st.content = withSignature(st.content, sg.content); autoDone.add(sg.id); }
  }
  applyAutoSignatures();

  const root = h('div', { class: 'composer' });
  const m = modal(root, { wide: true, label: st.id ? 'Edit post' : 'New post' });

  const accountsById = () => Object.fromEntries(state.accounts.map((a) => [a.id, a]));
  const captionFor = (aid) => { const t = st.targets.get(aid); return t?.content_override ?? st.content; };
  const validation = (aid) => {
    const a = accountsById()[aid];
    if (!a) return { errors: ['Account removed'], warnings: [] };
    const t = st.targets.get(aid);
    const thumb = t.settings.thumbnail ? st.thumbs.get(t.settings.thumbnail) : null;
    const thread = a.provider === 'x' ? (t.settings.thread || []).map((x) => ({ text: x.text || '', media: (x.media || []).map((id) => info(st.thumbs.get(id))).filter(Boolean) })) : null;
    const v = validatePost(a.provider, { caption: captionFor(aid), media: st.media.map(info), settings: t.settings, thumbnail: info(thumb), thread, account: { premium: !!a.meta?.premium } });
    if (a.status !== 'active') v.errors.unshift('Account needs to be reconnected.');
    if (a.disabled) v.warnings.unshift('Publishing to this channel is paused: a scheduled post waits until you resume it, and “Post now” is not possible.');
    if (st.media.some((m) => m?.purged)) v.errors.unshift('Re-upload the media that was removed after publishing.');
    if (st.serverErrors[aid]) v.errors.push(...st.serverErrors[aid].filter((e) => !v.errors.includes(e)));
    return v;
  };
  const allErrors = () => [...st.targets.keys()].filter((aid) => !st.locked.has(aid)).flatMap((aid) => validation(aid).errors.map((e) => ({ aid, e })));
  const footStatus = (errs) => (errs.length ? h('div', { class: 'foot-errors' }, icon('alert', 15), `${errs.length} issue${errs.length > 1 ? 's' : ''} to fix`) : h('div', { class: 'foot-ok' }, st.targets.size ? [icon('check-circle', 15), 'Ready to publish'] : h('span', { class: 'muted' }, 'Pick at least one account')));

  function render() {
    applyAutoSignatures();
    const accs = accountsById();
    const errs = allErrors();
    mount(root,
      h('div', { class: 'composer-head' },
        h('div', {}, h('div', { class: 'eyebrow' }, st.id ? 'Edit post' : 'New post'), h('h2', { class: 'ch-title' }, st.id ? 'Edit post' : 'Compose')),
        st.id ? statusBadge(st.status) : null,
        h('button', { class: 'icon-btn close', 'aria-label': 'Close (Esc)', onclick: () => m.close() }, icon('x', 18))),
      st.approval_note ? h('div', { class: 'notice warn' }, icon('alert', 15), h('span', {}, st.approval_note)) : null,
      h('div', { class: 'composer-body' },
        h('div', { class: 'col-main' },
          h('div', { class: 'label' }, 'Publish to'),
          brandPicker(),
          h('div', { class: 'acc-picker' }, state.accounts.length ? state.accounts.map((a) => {
            const on = st.targets.has(a.id);
            return h('button', {
              type: 'button', class: `acc-pill ${on ? 'on' : ''} ${a.status !== 'active' ? 'warn' : ''} ${a.disabled ? 'paused' : ''}`, disabled: st.locked.has(a.id), 'aria-pressed': on ? 'true' : 'false', title: a.status !== 'active' ? `${a.name}: needs reconnect` : a.disabled ? `${a.name}: publishing paused` : a.name,
              onclick: () => {
                if (on) { st.targets.delete(a.id); if (st.active === a.id) st.active = [...st.targets.keys()][0] || null; }
                else { st.targets.set(a.id, { content_override: null, settings: defaultSettings(a.provider) }); st.active = a.id; }
                render();
              },
            }, avatar(a, 22), h('span', {}, a.name), a.disabled ? h('span', { class: 'pill-note' }, 'paused') : null, on ? icon('check-circle', 14, 'pill-check') : null);
          }) : h('p', { class: 'muted' }, 'No accounts connected yet. ', h('a', { href: '#/accounts', onclick: () => m.close() }, 'Connect one'), '.')),
          h('div', { class: 'cap-head' }, h('label', { class: 'label', for: 'pl-caption' }, 'Caption'), captionTools({ target: () => (st.focusEl?.isConnected ? st.focusEl : root.querySelector('#pl-caption')), styled: styledTargets(), extra: signatureButton() })),
          captionBox(),
          styledNote(),
          counters(),
          h('div', { class: 'label' }, 'Media'),
          mediaBox(),
          h('div', { class: 'label' }, 'Tags'),
          tagPicker(st.tags, (list) => { st.tags = list; }),
          h('label', { class: 'label', for: 'pl-when' }, 'Schedule', h('span', { class: 'label-hint mono' }, tz)),
          h('div', { class: 'row gap wrap' },
            h('input', { id: 'pl-when', type: 'datetime-local', class: 'input when', value: st.publish_at ? formatLocal(st.publish_at, tz) : '', onchange: (e) => { st.publish_at = e.target.value ? parseLocal(e.target.value, tz) : null; render(); } }),
            h('button', { type: 'button', class: 'btn', onclick: async () => { try { const r = await api('GET', '/slots?count=1'); st.publish_at = r.slots[0].epoch_ms; render(); } catch (e) { toast(e.message, 'error'); } } }, icon('clock', 15), 'Next free slot'),
            st.publish_at ? h('span', { class: 'muted small' }, relTime(st.publish_at)) : null)),
        h('div', { class: 'col-side' }, sidePanel(accs))),
      h('div', { class: 'composer-foot' },
        footStatus(errs),
        h('div', { class: 'row gap wrap end' },
          st.id ? h('button', { class: 'btn ghost danger', onclick: del }, icon('trash', 15), 'Delete') : null,
          st.id ? h('button', { class: 'btn ghost', onclick: dup }, 'Duplicate') : null,
          st.targets.size ? h('button', { class: 'btn ghost', title: 'Save caption, channels, settings and tags (not media) to start new posts from', onclick: saveTemplate }, 'Save as template') : null,
          st.status === 'pending_approval' ? [
            h('button', { class: 'btn', onclick: reject }, 'Reject'),
            h('button', { class: 'btn primary', dataset: { act: 'approve' }, onclick: approve, disabled: !!errs.length }, 'Approve'),
          ] : [
            h('button', { class: 'btn', onclick: () => save('draft') }, 'Save draft'),
            h('button', { class: 'btn', dataset: { act: 'now' }, onclick: () => save('now'), disabled: !!errs.length || !st.targets.size }, icon('send', 14), 'Post now'),
            h('button', { class: 'btn primary', dataset: { act: 'schedule' }, onclick: () => save('schedule'), disabled: !!errs.length || !st.targets.size || !st.publish_at }, st.status === 'scheduled' ? 'Update schedule' : 'Schedule'),
          ])));
  }

  function captionBox() {
    const ta = h('textarea', { id: 'pl-caption', class: 'input caption', rows: 6, placeholder: 'Write something… #hashtags and @mentions welcome', onfocus: (e) => { st.focusEl = e.target; } });
    ta.value = st.content;
    ta.addEventListener('input', debounce(() => { st.content = ta.value; refreshLive(); }, 120));
    return ta;
  }
  /** Signature menu: insert a saved snippet at the cursor (or at the end). */
  function signatureButton() {
    return h('button', { type: 'button', class: 'icon-btn', title: 'Insert signature', 'aria-label': 'Insert signature', 'aria-haspopup': 'menu', onclick: (e) => dropdown(e.currentTarget, [
      ...sigs.map((sg) => ({ label: sg.name, hint: sg.auto_add ? 'auto' : '', onClick: () => {
        const ta = st.focusEl?.isConnected ? st.focusEl : root.querySelector('#pl-caption');
        const atEnd = ta.selectionStart === ta.value.length || ta.selectionStart === 0 && !ta.value;
        if (atEnd || ta.selectionStart === undefined) { ta.value = withSignature(ta.value, sg.content); ta.dispatchEvent(new Event('input', { bubbles: true })); }
        else { const s0 = ta.selectionStart; ta.value = ta.value.slice(0, s0) + sg.content + ta.value.slice(ta.selectionEnd); ta.dispatchEvent(new Event('input', { bubbles: true })); }
        ta.focus();
      } })),
      sigs.length ? { sep: true } : null,
      { label: sigs.length ? 'Manage signatures' : 'Create a signature', icon: 'settings', href: '#/settings/content', onClick: () => m.close() },
    ], { width: 240 }) }, icon('edit', 15));
  }
  /** Bold/italic only make sense where the platform has no rich text: LinkedIn and X. */
  function styledTargets() {
    const accs = accountsById();
    return [...st.targets.keys()].some((aid) => /^(linkedin|linkedin-page|x)$/.test(accs[aid]?.provider || ''));
  }
  /** One quiet line when Unicode bold/italic is in use (accessibility + search caveat). */
  function styledNote() {
    const texts = [st.content, ...[...st.targets.values()].map((t) => t.content_override || '')];
    const on = texts.some(hasStyled);
    return h('div', { class: 'cap-note small muted', id: 'cap-note', hidden: !on }, 'Bold and italic use Unicode look-alike letters, which screen readers and search handle poorly.');
  }

  function counters() {
    const box = h('div', { class: 'counters', id: 'counters' });
    fillCounters(box);
    return box;
  }
  function fillCounters(box) {
    const accs = accountsById();
    const seen = new Set();
    mount(box, [...st.targets.keys()].map((aid) => {
      const p = accs[aid]?.provider;
      const custom = st.targets.get(aid).content_override !== null && st.targets.get(aid).content_override !== undefined;
      const { n, max } = captionLength(p, captionFor(aid), { premium: !!accs[aid]?.meta?.premium });
      const key = `${PROVIDER_META[p]?.short}${max}`;
      if (!p || (seen.has(key) && !custom)) return null;
      seen.add(key);
      return h('span', { class: `counter mono ${n > max ? 'over' : n > max * 0.9 ? 'near' : ''}`, style: { '--pc': PROVIDER_META[p].color } }, `${PROVIDER_META[p].short}${custom ? '*' : ''} ${n}/${max}`);
    }));
  }
  function renderSide() {
    const side = root.querySelector('.col-side');
    if (side) mount(side, sidePanel(accountsById()));
    refreshLive();
  }
  function refreshLive() {
    const c = root.querySelector('#counters');
    if (c) fillCounters(c);
    const note = root.querySelector('#cap-note');
    if (note) note.replaceWith(styledNote());
    const accs = accountsById();
    const aid = st.active;
    if (aid && st.targets.has(aid)) {
      const v = root.querySelector('#side-val');
      if (v) v.replaceWith(validationBox(accs[aid], st.targets.get(aid)));
      const pv = root.querySelector('#side-prev');
      if (pv) pv.replaceWith(previewBox(accs[aid], st.targets.get(aid)));
      const tb = root.querySelector('#side-tabs');
      if (tb) tb.replaceWith(tabsBar(accs));
    } else {
      const side = root.querySelector('.col-side');
      if (side && !root.querySelector('.empty-side')) mount(side, sidePanel(accs));
    }
    const foot = root.querySelector('.composer-foot');
    if (foot) {
      const errs = allErrors();
      foot.firstChild.replaceWith(footStatus(errs));
      for (const b of foot.querySelectorAll('[data-act]')) b.disabled = !!errs.length || !st.targets.size || (b.dataset.act === 'schedule' && !st.publish_at);
    }
  }

  /** Brand chips above the accounts: one click selects every connected channel of the brand. */
  function brandPicker() {
    const brands = (state.brands || []).filter((b) => b.channel_ids.length);
    if (!brands.length) return null;
    const last = localStorage.getItem(LAST_BRAND);
    const ordered = [...brands].sort((a, b) => (b.id === last) - (a.id === last));
    return h('div', { class: 'brand-picker', role: 'group', 'aria-label': 'Brands' },
      h('span', { class: 'muted small' }, 'Brand'),
      ordered.map((b) => {
        const usable = b.channel_ids.filter((id) => state.accounts.some((a) => a.id === id && a.status === 'active' && !a.disabled) && !st.locked.has(id));
        const on = usable.length > 0 && usable.every((id) => st.targets.has(id));
        return h('button', {
          type: 'button', class: `brand-chip ${on ? 'on' : ''}`, 'aria-pressed': on ? 'true' : 'false', disabled: !usable.length,
          title: usable.length ? `${on ? 'Selected' : 'Select'}: ${b.channels.filter((c) => usable.includes(c.id)).map((c) => c.name).join(', ')}` : 'No connected channels',
          onclick: () => { selectBrand(b, !on); render(); },
        }, brandDot(b), b.name, h('span', { class: 'bc-n mono' }, usable.length));
      }));
  }
  function selectBrand(b, select = true) {
    const accs = state.accounts.filter((a) => b.channel_ids.includes(a.id) && a.status === 'active' && !a.disabled && !st.locked.has(a.id));
    for (const a of accs) {
      if (select && !st.targets.has(a.id)) st.targets.set(a.id, { content_override: null, settings: defaultSettings(a.provider) });
      if (!select) st.targets.delete(a.id);
    }
    if (select) { localStorage.setItem(LAST_BRAND, b.id); if (!st.active || !st.targets.has(st.active)) st.active = accs[0]?.id || null; }
    else if (st.active && !st.targets.has(st.active)) st.active = [...st.targets.keys()][0] || null;
  }

  function mediaBox() {
    const input = h('input', { type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,application/pdf', hidden: true, onchange: (e) => addFiles([...e.target.files]) });
    const progress = h('div', { class: 'uploads' });
    const drop = h('div', {
      class: 'dropzone', tabindex: 0, role: 'button', 'aria-label': 'Upload media',
      onclick: () => input.click(),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); },
    }, icon('upload', 18), h('div', {}, h('strong', {}, 'Drop images or videos'), ' or click to browse'), h('div', { class: 'muted small' }, 'JPEG · PNG · WebP · GIF · MP4 · MOV · PDF (LinkedIn)'));
    async function addFiles(files) {
      for (const f of files) {
        const bar = h('div', { class: 'bar' }, h('span', { style: { width: '0%' } }));
        const row = h('div', { class: 'upload-row' }, h('span', { class: 'name ellipsis' }, f.name), h('span', { class: 'muted small mono' }, fmtBytes(f.size)), bar);
        progress.append(row);
        try {
          const media = await uploadFile(f, (p) => { bar.firstChild.style.width = `${Math.round(p * 100)}%`; });
          st.media.push(media);
          row.remove();
          render();
          // No server-side poster (Workers / no ffmpeg): grab a frame / make a small thumbnail from the local
          // file and store it (it is what stays visible after the original is deleted post-publishing).
          if ((media.kind === 'video' || media.kind === 'image') && !media.poster) ensurePoster(media, f).then((p) => { if (p && media.kind === 'video') render(); });
        } catch (e) {
          row.classList.add('error');
          row.append(h('span', { class: 'err small' }, e.message));
        }
      }
    }
    /** Replace a media item whose original was removed after publishing with a fresh upload. */
    function reupload(i) {
      const one = h('input', { type: 'file', accept: input.accept, hidden: true });
      one.onchange = async () => {
        const f = one.files[0];
        if (!f) return;
        try {
          const media = await uploadFile(f);
          if ((media.kind === 'video' || media.kind === 'image') && !media.poster) ensurePoster(media, f);
          st.media.splice(i, 1, media);
          render();
          toast('Media replaced', 'success');
        } catch (e) { toast(e.message, 'error'); }
      };
      one.click();
    }
    let dragIdx = null;
    const grid = h('div', { class: 'media-grid' }, st.media.map((md, i) => h('div', {
      class: `media-item${md.purged ? ' reupload' : ''}`, draggable: 'true',
      ondragstart: (e) => { dragIdx = i; e.dataTransfer.effectAllowed = 'move'; },
      ondragover: (e) => e.preventDefault(),
      ondrop: (e) => { e.preventDefault(); e.stopPropagation(); if (dragIdx === null || dragIdx === i) return; const [x] = st.media.splice(dragIdx, 1); st.media.splice(i, 0, x); dragIdx = null; render(); },
    },
    mediaVisual(md),
    md.purged ? h('div', { class: 'reupload-slot', title: REMOVED_NOTE }, h('span', { class: 'small' }, 'Removed after publishing'), h('button', { type: 'button', class: 'btn small', 'aria-label': `Re-upload media (${REMOVED_NOTE})`, onclick: (e) => { e.stopPropagation(); reupload(i); } }, icon('upload', 13), 'Re-upload')) : null,
    md.purged ? null : h('span', { class: 'media-meta mono' }, `${md.kind === 'video' ? `▶ ${md.duration ? `${Math.round(md.duration)}s` : ''}` : ''} ${md.width && md.height ? `${md.width}×${md.height}` : ''}`),
    h('span', { class: 'media-idx mono' }, i + 1),
    h('button', { type: 'button', class: 'icon-btn remove', 'aria-label': `Remove ${md.name || 'media'}`, onclick: (e) => { e.stopPropagation(); st.media.splice(i, 1); render(); } }, icon('x', 14)))));
    return h('div', {}, st.media.length ? grid : null, drop, input, progress);
  }

  function sidePanel(accs) {
    const ids = [...st.targets.keys()];
    if (!ids.length) return h('div', { class: 'empty-side' }, icon('accounts', 22), h('p', { class: 'muted' }, 'Select one or more accounts to see platform settings, validation and a live preview.'));
    if (!st.active || !st.targets.has(st.active)) st.active = ids[0];
    const aid = st.active;
    const a = accs[aid];
    const t = st.targets.get(aid);
    const locked = st.locked.has(aid);
    return h('div', { class: 'side-inner' },
      tabsBar(accs),
      t.status && t.status !== 'draft' ? h('div', { class: 'row gap small side-status' }, statusBadge(t.status), viewOnLink({ ...t, provider: a?.provider }, { cls: 'view-on' })) : null,
      t.error ? h('div', { class: 'notice error' }, icon('x-circle', 15), h('span', {}, t.error)) : null,
      t.warning ? h('div', { class: 'notice warn' }, icon('alert', 15), h('span', {}, t.warning)) : null,
      locked ? h('p', { class: 'muted' }, 'This account was already published and can no longer be edited.') : [
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: t.content_override !== null && t.content_override !== undefined, onchange: (e) => { t.content_override = e.target.checked ? st.content : null; renderSide(); } }), `Custom ${PLATFORMS[a.provider].captionLabel.toLowerCase()} for ${a.name}`),
        t.content_override !== null && t.content_override !== undefined ? (() => {
          const ta = h('textarea', { class: 'input', rows: 4, 'aria-label': `Custom caption for ${a.name}`, onfocus: (e) => { st.focusEl = e.target; } });
          ta.value = t.content_override;
          ta.addEventListener('input', debounce(() => { t.content_override = ta.value; refreshLive(); }, 150));
          return ta;
        })() : null,
        settingsForm(a, t),
      ],
      validationBox(a, t),
      previewBox(a, t));
  }

  function tabsBar(accs) {
    const ids = [...st.targets.keys()];
    return h('div', { class: 'side-tabs', id: 'side-tabs', role: 'tablist' }, ids.map((id) => {
      const vv = validation(id);
      return h('button', { type: 'button', role: 'tab', 'aria-selected': id === st.active ? 'true' : 'false', class: `stab ${id === st.active ? 'on' : ''}`, onclick: () => { st.active = id; renderSide(); } }, avatar(accs[id] || { name: '?' }, 18), h('span', { class: 'ellipsis' }, accs[id]?.name || 'removed'), vv.errors.length && !st.locked.has(id) ? h('span', { class: 'dot err', title: 'Has errors' }) : vv.warnings.length ? h('span', { class: 'dot warn', title: 'Has warnings' }) : null);
    }));
  }

  function validationBox(a, t) {
    const v = validation(a.id);
    return h('div', { class: 'validation', id: 'side-val' },
      h('div', { class: 'kind' }, h('span', { class: 'eyebrow' }, 'Will publish'), describeKind(a.provider, st.media, t.settings)),
      v.errors.map((e) => h('div', { class: 'v-err' }, icon('x-circle', 14), h('span', {}, e))),
      v.warnings.map((w) => h('div', { class: 'v-warn' }, icon('alert', 14), h('span', {}, w))),
      !v.errors.length ? h('div', { class: 'v-ok' }, icon('check-circle', 14), h('span', {}, 'Looks good for ', PROVIDER_META[a.provider].label)) : null);
  }

  function field(label, control, hint) {
    return h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('small', { class: 'muted' }, hint) : null);
  }
  const set = (t, k, v, full = false) => { t.settings[k] = v; if (full) renderSide(); else refreshLive(); };

  function settingsForm(a, t) {
    const s = t.settings;
    const sel = (k, opts) => h('select', { class: 'input', onchange: (e) => set(t, k, e.target.value, true) }, opts.map(([v, l]) => h('option', { value: v, selected: String(s[k]) === String(v) }, l)));
    const txt = (k, ph, extra = {}) => {
      const i = h('input', { class: 'input', placeholder: ph, ...extra });
      i.value = s[k] || '';
      i.addEventListener('input', debounce(() => set(t, k, i.value), 150));
      return i;
    };
    const chk = (k, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!s[k], onchange: (e) => set(t, k, e.target.checked, true) }), label);
    const list = (k, ph) => {
      const i = h('input', { class: 'input', placeholder: ph });
      i.value = (s[k] || []).join(', ');
      i.addEventListener('input', debounce(() => set(t, k, i.value.split(',').map((x) => x.trim()).filter(Boolean)), 200));
      return i;
    };
    const seg = (k, opts) => segmented(opts, s[k], (v) => set(t, k, v, true), { label: k });
    if (a.provider === 'youtube') {
      const thumb = s.thumbnail ? st.thumbs.get(s.thumbnail) : null;
      const thumbInput = h('input', { type: 'file', accept: 'image/jpeg,image/png', hidden: true, onchange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try { const md = await uploadFile(f); st.thumbs.set(md.id, md); set(t, 'thumbnail', md.id, true); } catch (err) { toast(err.message, 'error'); }
      } });
      return h('div', { class: 'settings' },
        field('Title *', txt('title', 'Video title', { maxlength: 100 })),
        h('div', { class: 'grid2' },
          field('Privacy', sel('privacy', [['public', 'Public'], ['unlisted', 'Unlisted'], ['private', 'Private']])),
          field('Made for kids', sel('madeForKids', [['no', 'No'], ['yes', 'Yes']]))),
        field('Category', sel('categoryId', YOUTUBE_CATEGORIES)),
        field('Tags', list('tags', 'comma, separated'), 'Total ≤ 500 characters'),
        chk('notifySubscribers', 'Notify subscribers'),
        chk('isShort', 'This is a Short (vertical, ≤ 3 min)'),
        h('div', { class: 'field' }, h('span', {}, 'Custom thumbnail'), h('div', { class: 'row gap' }, thumb ? h('img', { class: 'thumb-prev', src: thumb.url, alt: '' }) : null, h('button', { type: 'button', class: 'btn small', onclick: () => thumbInput.click() }, thumb ? 'Replace' : 'Upload JPEG/PNG'), thumb ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => set(t, 'thumbnail', null, true) }, 'Remove') : null, thumbInput)),
        h('div', { class: 'notice info small' }, icon('info', 14), h('span', {}, 'Uploads use the separate videos.insert quota (default 100 uploads/day per project); custom thumbnails cost 50 of the 10,000 daily units. See the YouTube setup guide for the API audit.')));
    }
    if (a.provider === 'x') return xSettings(a, t, sel);
    if (a.provider === 'linkedin' || a.provider === 'linkedin-page') {
      return h('div', { class: 'settings' },
        field('Type', seg('post_type', [['post', 'Post'], ['document', 'Document (PDF)']])),
        a.provider === 'linkedin' ? field('Who can see it', sel('visibility', [['PUBLIC', 'Anyone'], ['CONNECTIONS', 'Connections only']])) : null,
        s.post_type === 'document' ? field('Document title', txt('document_title', 'Shown above the pages', { maxlength: 400 })) : null,
        s.post_type !== 'document' && !st.media.length ? [field('Link', txt('url', 'https://…'), 'Text posts only: shown as an article card'), s.url ? field('Link title', txt('url_title', 'Optional')) : null] : null,
        field('First comment', txt('first_comment', 'Optional'), 'Needs the Community Management API on your LinkedIn app'));
    }
    if (a.provider === 'facebook') {
      return h('div', { class: 'settings' },
        field('Type', seg('post_type', [['post', 'Post'], ['reel', 'Reel'], ['story', 'Story']])),
        s.post_type === 'post' ? field('Link', txt('url', 'https://…'), 'Text/link posts only') : null,
        s.post_type !== 'story' ? field('Video title', txt('title', 'Optional')) : null,
        s.post_type !== 'story' ? field('First comment', txt('first_comment', 'Optional')) : null);
    }
    return h('div', { class: 'settings' },
      field('Type', seg('post_type', [['post', 'Post / Reel / Carousel'], ['story', 'Story']])),
      s.post_type !== 'story' ? field('Collaborators', list('collaborators', 'username1, username2'), 'Up to 3 public accounts') : null,
      s.post_type !== 'story' && st.media.length === 1 && st.media[0].kind === 'video' ? [
        chk('share_to_feed', 'Also show Reel in feed'),
        chk('is_trial_reel', 'Trial Reel (non-followers first)'),
        s.is_trial_reel ? field('Graduation', sel('graduation_strategy', [['MANUAL', 'Manual'], ['SS_PERFORMANCE', 'Based on performance']])) : null,
      ] : null,
      s.post_type !== 'story' ? field('First comment', txt('first_comment', 'Optional')) : null);
  }

  /** X: reply settings + thread items (each with its own text, counter and media). */
  function xSettings(a, t, sel) {
    const s = t.settings;
    s.thread ||= [];
    const limit = a.meta?.premium ? 25000 : 280;
    const item = (it, i) => {
      const ta = h('textarea', { class: 'input', rows: 3, placeholder: `Post ${i + 2}`, 'aria-label': `Thread post ${i + 2}` });
      ta.value = it.text || '';
      const cnt = h('span', { class: 'counter mono' });
      const upd = () => { const n = xWeightedLength(ta.value); cnt.textContent = `${n}/${limit}`; cnt.classList.toggle('over', n > limit); };
      upd();
      const live = debounce(refreshLive, 150);
      ta.addEventListener('input', () => { it.text = ta.value; upd(); live(); });
      const file = h('input', { type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime', hidden: true, onchange: async (e) => {
        for (const f of [...e.target.files]) {
          try { const md = await uploadFile(f); st.thumbs.set(md.id, md); (it.media ||= []).push(md.id); if (md.kind === 'video' && !md.poster) ensurePoster(md, f); } catch (err) { toast(err.message, 'error'); }
        }
        renderSide();
      } });
      return h('div', { class: 'thread-item' },
        h('div', { class: 'ti-head' }, h('span', { class: 'mono small muted' }, `${i + 2}/`), cnt,
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove thread post ${i + 2}`, onclick: () => { s.thread.splice(i, 1); renderSide(); } }, icon('x', 14))),
        ta,
        (it.media || []).length ? h('div', { class: 'ti-media' }, it.media.map((id, k) => h('div', { class: 'ti-thumb' }, mediaVisual(st.thumbs.get(id)),
          h('button', { type: 'button', class: 'icon-btn remove', 'aria-label': 'Remove media', onclick: () => { it.media.splice(k, 1); renderSide(); } }, icon('x', 12))))) : null,
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => file.click() }, icon('image', 13), 'Add media'), file);
    };
    return h('div', { class: 'settings' },
      field('Who can reply', sel('reply_settings', [['', 'Everyone'], ['following', 'Accounts you follow'], ['mentionedUsers', 'Only accounts you mention'], ['verified', 'Verified accounts'], ['subscribers', 'Subscribers']])),
      h('div', { class: 'field' }, h('span', {}, 'Thread'),
        s.thread.length ? h('div', { class: 'thread-list' }, s.thread.map(item)) : h('small', { class: 'muted' }, 'The caption above is the first post. Add more to publish a thread.'),
        h('button', { type: 'button', class: 'btn small', onclick: () => { s.thread.push({ text: '', media: [] }); renderSide(); } }, icon('plus', 13), 'Add to thread')));
  }

  function previewBox(a, t) {
    return h('div', { id: 'side-prev', class: 'preview-wrap' }, h('div', { class: 'eyebrow' }, 'Preview'), preview(a, t));
  }

  function preview(a, t) {
    const cap = captionFor(a.id);
    const first = st.media[0];
    const mediaEl = first ? mediaVisual(first, { playable: true }) : null;
    const p = a.provider;
    if (p === 'youtube') {
      return h('div', { class: `preview yt ${t.settings.isShort ? 'short' : ''}` }, h('div', { class: 'pv-media' }, mediaEl || h('div', { class: 'pv-empty' }, icon('play', 20), 'No video')),
        h('div', { class: 'pv-row' }, avatar(a, 28), h('div', {}, h('div', { class: 'pv-title' }, t.settings.title || 'Untitled'), h('div', { class: 'pv-sub' }, `${a.name} · ${t.settings.privacy}`))), cap ? h('div', { class: 'pv-cap' }, cap.slice(0, 160)) : null);
    }
    if (p === 'x') {
      const post = (text, media, first) => h('div', { class: `pv-x ${first ? '' : 'reply'}` }, avatar(a, 30),
        h('div', { class: 'min0' }, h('div', { class: 'pv-x-head' }, h('strong', {}, a.name), h('span', { class: 'muted' }, ` @${a.username || ''}`)),
          h('div', { class: 'pv-cap' }, text || h('span', { class: 'muted' }, 'Write something…')),
          media.length ? h('div', { class: `pv-grid n${Math.min(media.length, 4)}` }, media.slice(0, 4).map((md) => mediaVisual(md))) : null));
      return h('div', { class: 'preview x' }, post(cap, st.media, true),
        (t.settings.thread || []).map((it) => post(it.text, (it.media || []).map((id) => st.thumbs.get(id)).filter(Boolean), false)));
    }
    if (p === 'linkedin' || p === 'linkedin-page') {
      const doc = t.settings.post_type === 'document' && first?.kind === 'document';
      return h('div', { class: 'preview li' }, h('div', { class: 'pv-head' }, avatar(a, 32), h('div', {}, h('strong', {}, a.name), h('div', { class: 'muted small' }, p === 'linkedin-page' ? 'Company Page' : t.settings.visibility === 'CONNECTIONS' ? 'Connections' : 'Anyone'))),
        h('div', { class: 'pv-cap' }, cap.length > 210 ? `${cap.slice(0, 210)}… see more` : cap),
        doc ? h('div', { class: 'pv-doc' }, icon('docs', 18), h('span', {}, t.settings.document_title || first.name || 'Document')) :
        st.media.length > 1 && first?.kind === 'image' ? h('div', { class: 'pv-grid' }, st.media.slice(0, 4).map((md) => h('img', { src: md.url, alt: '' }))) :
        mediaEl ? h('div', { class: 'pv-media' }, mediaEl) : t.settings.url ? h('div', { class: 'pv-link' }, t.settings.url_title || t.settings.url) : null);
    }
    if (p === 'facebook') {
      return h('div', { class: 'preview fb' }, h('div', { class: 'pv-head' }, avatar(a, 32), h('div', {}, h('strong', {}, a.name), h('div', { class: 'muted small' }, st.publish_at ? fmtDateTime(st.publish_at) : 'Now'))),
        h('div', { class: 'pv-cap' }, cap.length > 400 ? `${cap.slice(0, 400)}… See more` : cap),
        st.media.length > 1 && first?.kind === 'image' ? h('div', { class: 'pv-grid' }, st.media.slice(0, 4).map((md) => h('img', { src: md.url, alt: '' }))) : mediaEl ? h('div', { class: 'pv-media' }, mediaEl) : t.settings.url ? h('div', { class: 'pv-link' }, t.settings.url) : null);
    }
    return h('div', { class: `preview ig ${t.settings.post_type === 'story' ? 'story' : ''}` }, h('div', { class: 'pv-head' }, avatar(a, 28), h('strong', {}, a.username || a.name)),
      h('div', { class: 'pv-media square' }, mediaEl || h('div', { class: 'pv-empty' }, icon('image', 20), 'Add media'), st.media.length > 1 ? h('span', { class: 'pv-count' }, `1/${st.media.length}`) : null),
      t.settings.post_type !== 'story' ? h('div', { class: 'pv-cap' }, h('strong', {}, a.username || a.name), ' ', cap.length > 125 ? `${cap.slice(0, 125)}… more` : cap) : null);
  }

  const body = (mode) => ({
    content: st.content,
    media_ids: st.media.map((x) => x.id),
    targets: [...st.targets.entries()].map(([aid, t]) => ({ account_id: aid, content: t.content_override ?? null, settings: t.settings })),
    tags: st.tags,
    mode,
    ...(st.publish_at && mode !== 'now' ? { publish_at: st.publish_at } : {}),
  });

  async function save(mode) {
    if (!st.targets.size) return toast('Select at least one account', 'error');
    st.serverErrors = {};
    try {
      const r = st.id ? await api('PATCH', `/posts/${st.id}`, body(mode)) : await api('POST', '/posts', body(mode));
      toast(mode === 'draft' ? 'Draft saved' : mode === 'now' ? 'Publishing now…' : `Scheduled for ${fmtDateTime(r.post.publish_at)}`, 'success');
      m.close();
      onSaved(r.post);
    } catch (e) {
      if (e.details?.errors) {
        for (const [aid, d] of Object.entries(e.details.errors)) st.serverErrors[aid] = d.errors || d;
        render();
      }
      toast(e.message.split('\n')[0], 'error', 6000);
    }
  }
  async function saveTemplate() {
    const name = await confirmDialog('Name this template. It keeps the caption, channels with their settings and tags; media is not saved.', { ok: 'Save template', input: 'e.g. Weekly short', title: 'Save as template' });
    if (!name || !name.trim()) return;
    const b = body('draft');
    try { await api('POST', '/templates', { name: name.trim(), content: b.content, targets: b.targets.map((t) => ({ account_id: t.account_id, content: t.content, settings: t.settings })), tags: b.tags }); toast('Template saved', 'success'); } catch (e) { toast(e.message, 'error'); }
  }
  async function del() {
    if (!(await confirmDialog('Delete this post? Already-published content stays live on the platforms.', { ok: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/posts/${st.id}`); toast('Deleted'); m.close(); onSaved(null); } catch (e) { toast(e.message, 'error'); }
  }
  async function dup() {
    m.close();
    await duplicatePost(st.id, { onSaved, open: true });
  }
  async function approve() {
    try {
      await api('POST', `/posts/${st.id}/approve`, {});
      toast('Approved', 'success'); m.close(); onSaved(null);
    } catch (e) { toast(e.message, 'error'); }
  }
  async function reject() {
    const reason = await confirmDialog('Reject this post? It goes back to draft with your note for the agent.', { ok: 'Reject', danger: true, input: 'What should change? (optional)' });
    if (reason === null) return;
    try { await api('POST', `/posts/${st.id}/reject`, { reason }); toast('Rejected'); m.close(); onSaved(null); } catch (e) { toast(e.message, 'error'); }
  }
  render();
}

/**
 * Duplicate a post as a draft. When some originals were deleted after publishing, the copy opens in the
 * composer with a "Re-upload media" slot for each of them (always, or when open=true).
 */
export async function duplicatePost(groupId, { onSaved = () => {}, open = false } = {}) {
  try {
    const r = await api('POST', `/posts/${groupId}/duplicate`, {});
    const needs = r.needs_reupload?.length || 0;
    toast(needs ? `Duplicated as draft. Re-upload ${needs === 1 ? 'the removed file' : `${needs} removed files`} before scheduling.` : 'Duplicated as draft', needs ? 'info' : 'success', needs ? 6000 : undefined);
    onSaved(r.post);
    if (open || needs) openComposer({ groupId: r.post.id, onSaved });
    return r;
  } catch (e) { toast(e.message, 'error'); return null; }
}

/** Retry failed targets; shows the server's per-target reason (e.g. media removed after publishing). */
export async function retryTargets(groupId, targetIds, refresh = () => {}) {
  try {
    const r = await api('POST', `/posts/${groupId}/retry`, { target_ids: targetIds });
    const errs = (r.results || []).filter((x) => x.error);
    if (errs.length) toast(errs[0].error, 'error', 9000);
    else toast(targetIds.length > 1 ? 'Retrying failed accounts…' : 'Retrying…', 'success');
    setTimeout(refresh, 1000);
  } catch (e) { toast(e.message, 'error', 8000); }
}
