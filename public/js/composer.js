// Composer: global caption + per-account overrides/settings, media upload, live validation, previews.
import { h, mount, api, state, toast, modal, confirmDialog, uploadFile, avatar, statusBadge, PROVIDER_META, fmtBytes, debounce, icon, relTime } from './core.js';
import { segmented } from './ui.js';
import { mediaVisual, ensurePoster } from './media.js';
import { validatePost, defaultSettings, PLATFORMS, YOUTUBE_CATEGORIES, describeKind, charCount } from '/assets/shared/validate.js';
import { formatLocal, parseLocal } from '/assets/shared/time.js';

export { relTime };
const info = (m) => m && ({ kind: m.kind, mime: m.mime, size: m.size, width: m.width, height: m.height, duration: m.duration, name: m.name });

export async function openComposer({ groupId = null, at = null, onSaved = () => {} } = {}) {
  const tz = state.settings.timezone;
  const st = { id: null, content: '', media: [], publish_at: at, targets: new Map(), locked: new Set(), active: null, status: 'draft', approval_note: null, thumbs: new Map(), serverErrors: {} };
  if (groupId) {
    const { post } = await api('GET', `/posts/${groupId}`);
    Object.assign(st, { id: post.id, content: post.content, media: post.media, publish_at: post.publish_at, status: post.status, approval_note: post.approval_note });
    for (const t of post.targets) {
      st.targets.set(t.integration_id, { content_override: t.content_override, settings: { ...t.settings }, status: t.status, error: t.error, warning: t.warning, published_url: t.published_url, target_id: t.id });
      if (['published', 'publishing'].includes(t.status)) st.locked.add(t.integration_id);
      if (t.settings.thumbnail) {
        try { st.thumbs.set(t.settings.thumbnail, (await api('GET', `/media/${t.settings.thumbnail}`)).media); } catch {}
      }
    }
    st.active = post.targets[0]?.integration_id || null;
  }

  const root = h('div', { class: 'composer' });
  const m = modal(root, { wide: true, label: st.id ? 'Edit post' : 'New post' });

  const accountsById = () => Object.fromEntries(state.accounts.map((a) => [a.id, a]));
  const captionFor = (aid) => { const t = st.targets.get(aid); return t?.content_override ?? st.content; };
  const validation = (aid) => {
    const a = accountsById()[aid];
    if (!a) return { errors: ['Account removed'], warnings: [] };
    const t = st.targets.get(aid);
    const thumb = t.settings.thumbnail ? st.thumbs.get(t.settings.thumbnail) : null;
    const v = validatePost(a.provider, { caption: captionFor(aid), media: st.media.map(info), settings: t.settings, thumbnail: info(thumb) });
    if (a.status !== 'active') v.errors.unshift('Account needs to be reconnected.');
    if (st.serverErrors[aid]) v.errors.push(...st.serverErrors[aid].filter((e) => !v.errors.includes(e)));
    return v;
  };
  const allErrors = () => [...st.targets.keys()].filter((aid) => !st.locked.has(aid)).flatMap((aid) => validation(aid).errors.map((e) => ({ aid, e })));
  const footStatus = (errs) => (errs.length ? h('div', { class: 'foot-errors' }, icon('alert', 15), `${errs.length} issue${errs.length > 1 ? 's' : ''} to fix`) : h('div', { class: 'foot-ok' }, st.targets.size ? [icon('check-circle', 15), 'Ready to publish'] : h('span', { class: 'muted' }, 'Pick at least one account')));

  function render() {
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
          h('div', { class: 'acc-picker' }, state.accounts.length ? state.accounts.map((a) => {
            const on = st.targets.has(a.id);
            return h('button', {
              type: 'button', class: `acc-pill ${on ? 'on' : ''} ${a.status !== 'active' ? 'warn' : ''}`, disabled: st.locked.has(a.id), 'aria-pressed': on ? 'true' : 'false', title: a.status !== 'active' ? `${a.name}: needs reconnect` : a.name,
              onclick: () => {
                if (on) { st.targets.delete(a.id); if (st.active === a.id) st.active = [...st.targets.keys()][0] || null; }
                else { st.targets.set(a.id, { content_override: null, settings: defaultSettings(a.provider) }); st.active = a.id; }
                render();
              },
            }, avatar(a, 22), h('span', {}, a.name), on ? icon('check-circle', 14, 'pill-check') : null);
          }) : h('p', { class: 'muted' }, 'No accounts connected yet. ', h('a', { href: '#/accounts', onclick: () => m.close() }, 'Connect one'), '.')),
          h('label', { class: 'label', for: 'pl-caption' }, 'Caption'),
          captionBox(),
          counters(),
          h('div', { class: 'label' }, 'Media'),
          mediaBox(),
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
    const ta = h('textarea', { id: 'pl-caption', class: 'input caption', rows: 6, placeholder: 'Write something… #hashtags and @mentions welcome' });
    ta.value = st.content;
    ta.addEventListener('input', debounce(() => { st.content = ta.value; refreshLive(); }, 120));
    return ta;
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
      const key = `${PROVIDER_META[p]?.short}${PLATFORMS[p]?.maxCaption}`;
      if (!p || (seen.has(key) && !custom)) return null;
      seen.add(key);
      const n = charCount(captionFor(aid));
      const max = PLATFORMS[p].maxCaption;
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

  function mediaBox() {
    const input = h('input', { type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime', hidden: true, onchange: (e) => addFiles([...e.target.files]) });
    const progress = h('div', { class: 'uploads' });
    const drop = h('div', {
      class: 'dropzone', tabindex: 0, role: 'button', 'aria-label': 'Upload media',
      onclick: () => input.click(),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); },
    }, icon('upload', 18), h('div', {}, h('strong', {}, 'Drop images or videos'), ' or click to browse'), h('div', { class: 'muted small' }, 'JPEG · PNG · WebP · GIF · MP4 · MOV'));
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
          // No server-side poster (Workers / no ffmpeg): grab a frame from the local file and store it.
          if (media.kind === 'video' && !media.poster) ensurePoster(media, f).then((p) => { if (p) render(); });
        } catch (e) {
          row.classList.add('error');
          row.append(h('span', { class: 'err small' }, e.message));
        }
      }
    }
    let dragIdx = null;
    const grid = h('div', { class: 'media-grid' }, st.media.map((md, i) => h('div', {
      class: 'media-item', draggable: 'true',
      ondragstart: (e) => { dragIdx = i; e.dataTransfer.effectAllowed = 'move'; },
      ondragover: (e) => e.preventDefault(),
      ondrop: (e) => { e.preventDefault(); e.stopPropagation(); if (dragIdx === null || dragIdx === i) return; const [x] = st.media.splice(dragIdx, 1); st.media.splice(i, 0, x); dragIdx = null; render(); },
    },
    mediaVisual(md),
    h('span', { class: 'media-meta mono' }, `${md.kind === 'video' ? `▶ ${md.duration ? `${Math.round(md.duration)}s` : ''}` : ''} ${md.width && md.height ? `${md.width}×${md.height}` : ''}`),
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
      t.status && t.status !== 'draft' ? h('div', { class: 'row gap small side-status' }, statusBadge(t.status), t.published_url ? h('a', { href: t.published_url, target: '_blank', rel: 'noopener' }, 'View live', icon('external', 12)) : null) : null,
      t.error ? h('div', { class: 'notice error' }, icon('x-circle', 15), h('span', {}, t.error)) : null,
      t.warning ? h('div', { class: 'notice warn' }, icon('alert', 15), h('span', {}, t.warning)) : null,
      locked ? h('p', { class: 'muted' }, 'This account was already published and can no longer be edited.') : [
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: t.content_override !== null && t.content_override !== undefined, onchange: (e) => { t.content_override = e.target.checked ? st.content : null; renderSide(); } }), `Custom ${PLATFORMS[a.provider].captionLabel.toLowerCase()} for ${a.name}`),
        t.content_override !== null && t.content_override !== undefined ? (() => {
          const ta = h('textarea', { class: 'input', rows: 4, 'aria-label': `Custom caption for ${a.name}` });
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
    if (p === 'facebook') {
      return h('div', { class: 'preview fb' }, h('div', { class: 'pv-head' }, avatar(a, 32), h('div', {}, h('strong', {}, a.name), h('div', { class: 'muted small' }, st.publish_at ? formatLocal(st.publish_at, tz).replace('T', ' ') : 'Now'))),
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
    mode,
    ...(st.publish_at && mode !== 'now' ? { publish_at: st.publish_at } : {}),
  });

  async function save(mode) {
    if (!st.targets.size) return toast('Select at least one account', 'error');
    st.serverErrors = {};
    try {
      const r = st.id ? await api('PATCH', `/posts/${st.id}`, body(mode)) : await api('POST', '/posts', body(mode));
      toast(mode === 'draft' ? 'Draft saved' : mode === 'now' ? 'Publishing now…' : `Scheduled for ${formatLocal(r.post.publish_at, tz).replace('T', ' ')}`, 'success');
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
  async function del() {
    if (!(await confirmDialog('Delete this post? Already-published content stays live on the platforms.', { ok: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/posts/${st.id}`); toast('Deleted'); m.close(); onSaved(null); } catch (e) { toast(e.message, 'error'); }
  }
  async function dup() {
    try { const r = await api('POST', `/posts/${st.id}/duplicate`, {}); toast('Duplicated as draft', 'success'); m.close(); onSaved(r.post); openComposer({ groupId: r.post.id, onSaved }); } catch (e) { toast(e.message, 'error'); }
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
