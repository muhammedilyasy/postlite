// Per-channel ⋮ menu (Accounts rows and the calendar's channel list): create post, copy channel ID,
// rename, add to brand, edit time slots, pause/resume publishing, reconnect, disconnect.
import { h, api, state, toast, confirmDialog, modal, icon, refreshCommon } from './core.js';
import { dropdown } from './ui.js';
import { openComposer } from './composer.js';
import { brandDot } from './brands.js';

const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

/** Small modal with one text input; resolves the value or null. */
function promptDialog({ title, label, value = '', hint = null, ok = 'Save', allowEmpty = true }) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value, 'aria-label': label });
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal(h('form', { class: 'confirm', onsubmit: (e) => { e.preventDefault(); if (allowEmpty || input.value.trim()) finish(input.value); } },
      h('h3', { class: 'confirm-title' }, title),
      h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', { class: 'muted' }, hint) : null),
      h('div', { class: 'row end gap' }, h('button', { type: 'button', class: 'btn', onclick: () => finish(null) }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, ok))),
    { label: title, onClose: () => { if (!done) { done = true; resolve(null); } } });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

async function rename(a, refresh) {
  const v = await promptDialog({ title: `Rename ${a.name}`, label: 'Name in postlite', value: a.display_name || '', hint: `Leave empty to use the platform name (“${a.platform_name || a.name}”). Only postlite shows this name.` });
  if (v === null) return;
  await api('PATCH', `/accounts/${a.id}`, { display_name: v.trim() || null });
  toast(v.trim() ? 'Renamed' : 'Platform name restored', 'success');
  await refreshCommon(); refresh();
}

async function addToBrand(a, refresh) {
  const brands = state.brands || [];
  const boxes = brands.map((b) => ({ b, input: h('input', { type: 'checkbox', checked: b.channel_ids.includes(a.id) }) }));
  const newName = h('input', { class: 'input', placeholder: 'New brand name (optional)', 'aria-label': 'New brand name' });
  let done = false;
  const m = modal(h('div', { class: 'confirm' },
    h('h3', { class: 'confirm-title' }, `Brands for ${a.name}`),
    brands.length ? h('div', { class: 'plist compact' }, boxes.map(({ b, input }) => h('label', { class: 'plist-row check' }, input, brandDot(b), h('span', { class: 'plist-text' }, b.name), h('span', { class: 'muted small mono' }, b.channel_ids.length)))) : h('p', { class: 'muted small' }, 'No brands yet. Name one to create it with this channel.'),
    h('label', { class: 'field' }, h('span', {}, 'Create a brand'), newName),
    h('div', { class: 'row end gap' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
      if (done) return; done = true;
      try {
        for (const { b, input } of boxes) {
          const has = b.channel_ids.includes(a.id);
          if (input.checked !== has) await api('PUT', `/brands/${b.id}/channels`, { account_ids: [a.id], mode: input.checked ? 'add' : 'remove' });
        }
        if (newName.value.trim()) await api('POST', '/brands', { name: newName.value.trim(), account_ids: [a.id] });
        m.close(); toast('Brands updated', 'success'); await refreshCommon(); refresh();
      } catch (e) { done = false; toast(e.message, 'error'); }
    } }, 'Save'))), { label: 'Add to brand' });
}

async function editSlots(a, refresh) {
  const ws = state.settings.posting_slots || {};
  const own = !!a.posting_slots;
  const useOwn = h('input', { type: 'checkbox', checked: own });
  const inputs = Object.fromEntries(DAYS.map(([d]) => { const i = h('input', { class: 'input', placeholder: 'e.g. 09:00, 18:30', 'aria-label': `Time slots ${d}` }); i.value = ((a.posting_slots || ws)[d] || []).join(', '); return [d, i]; }));
  const grid = h('div', { class: 'slots' }, DAYS.map(([d, l]) => h('label', { class: 'slot-row' }, h('span', { class: 'mono' }, l.toUpperCase()), inputs[d])));
  const sync = () => { for (const i of Object.values(inputs)) i.disabled = !useOwn.checked; grid.classList.toggle('muted-block', !useOwn.checked); };
  useOwn.addEventListener('change', sync);
  sync();
  const m = modal(h('div', { class: 'confirm wide-confirm' },
    h('h3', { class: 'confirm-title' }, `Time slots for ${a.name}`),
    h('p', { class: 'muted small' }, '“Next free slot” and the queue use these times for this channel. 24h HH:MM in ', h('span', { class: 'mono' }, state.settings.timezone), '.'),
    h('label', { class: 'check' }, useOwn, 'Use this channel’s own time slots (off = the workspace slots shown below)'),
    grid,
    h('div', { class: 'row end gap' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
      try {
        const slots = useOwn.checked ? Object.fromEntries(DAYS.map(([d]) => [d, inputs[d].value.split(',').map((x) => x.trim()).filter(Boolean)])) : null;
        await api('PATCH', `/accounts/${a.id}`, { posting_slots: slots });
        m.close(); toast('Time slots saved', 'success'); await refreshCommon(); refresh();
      } catch (e) { toast(e.message, 'error', 6000); }
    } }, 'Save'))), { label: 'Edit time slots' });
}

async function togglePause(a, refresh) {
  if (!a.disabled) {
    const ok = await confirmDialog(`Pause publishing to ${a.name}? Scheduled posts for this channel wait instead of publishing. The account stays connected and nothing is deleted.`, { ok: 'Pause publishing', title: 'Pause channel' });
    if (!ok) return;
  }
  await api('PATCH', `/accounts/${a.id}`, { disabled: !a.disabled });
  toast(a.disabled ? 'Publishing resumed. Posts that came due meanwhile publish now.' : 'Publishing paused', 'success', 5000);
  await refreshCommon(); refresh();
}

/** The ⋮ menu for one channel. */
export function channelMenu(anchor, a, { refresh = () => {} } = {}) {
  dropdown(anchor, [
    { label: 'Create post', icon: 'edit', onClick: () => openComposer({ accountIds: [a.id], onSaved: refresh }) },
    { label: 'Copy channel ID', icon: 'copy', onClick: async () => { try { await navigator.clipboard.writeText(a.id); toast('Copied channel ID', 'success', 1500); } catch { toast(a.id, 'info', 6000); } } },
    { sep: true },
    { label: 'Rename', icon: 'edit', onClick: () => rename(a, refresh) },
    { label: 'Add to brand', icon: 'grid', onClick: () => addToBrand(a, refresh) },
    { label: 'Edit time slots', icon: 'clock', hint: a.posting_slots ? 'custom' : '', onClick: () => editSlots(a, refresh) },
    { label: a.disabled ? 'Resume publishing' : 'Pause publishing', icon: a.disabled ? 'send' : 'pause', onClick: () => togglePause(a, refresh) },
    { sep: true },
    { label: 'Check token', icon: 'refresh', onClick: async () => { const r = await api('POST', `/accounts/${a.id}/check`, {}); toast(r.ok ? 'Token OK' : `Problem: ${r.error}`, r.ok ? 'success' : 'error'); refresh(); } },
    { label: 'Reconnect', icon: 'accounts', href: `/oauth/${a.provider}/start?reconnect=${a.id}` },
    { label: 'Analytics', icon: 'analytics', href: `#/analytics?account=${a.id}` },
    { sep: true },
    { label: 'Disconnect', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog(`Disconnect ${a.name}? Its unpublished posts and analytics will be removed.`, { ok: 'Disconnect', danger: true })) { await api('DELETE', `/accounts/${a.id}`); toast('Disconnected'); await refreshCommon(); refresh(); } } },
  ], { align: 'right', width: 230 });
}
