// Render-style building blocks: page headers, tabs, empty states, skeletons, dropdown menus, ID chips.
import { h, icon, toast } from './core.js';

/** Page header: optional mono eyebrow, big title, subtitle, actions on the right. */
export function pageHeader({ eyebrow = null, title, sub = null, actions = null, meta = null }) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'ph-text' },
      eyebrow ? h('div', { class: 'eyebrow' }, eyebrow) : null,
      h('h1', { class: 'ph-title' }, title),
      sub ? h('p', { class: 'ph-sub' }, sub) : null,
      meta ? h('div', { class: 'ph-meta' }, meta) : null),
    actions ? h('div', { class: 'ph-actions' }, actions) : null);
}

/** Underline tabs; items: [{ id, label, href, count? }]. */
export function tabs(items, active, { label = 'Sections' } = {}) {
  return h('nav', { class: 'tabs-u', 'aria-label': label },
    items.map((t) => h('a', { href: t.href, class: t.id === active ? 'on' : '', 'aria-current': t.id === active ? 'page' : null },
      t.icon ? icon(t.icon, 15) : null, t.label, t.count !== undefined && t.count !== null ? h('span', { class: 'count' }, t.count) : null)));
}

/** Segmented control (Render's boxed filter group). */
export function segmented(options, value, onPick, { label = 'Filter' } = {}) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([v, l, n]) => h('button', { type: 'button', class: v === value ? 'on' : '', 'aria-pressed': v === value ? 'true' : 'false', onclick: () => onPick(v) }, l, n !== undefined ? h('span', { class: 'count' }, n) : null)));
}

export function emptyState({ icon: ic = 'inbox', title, body = null, action = null, compact = false }) {
  return h('div', { class: `empty ${compact ? 'compact' : ''}` },
    h('div', { class: 'empty-ic' }, icon(ic, 22)),
    h('h3', {}, title),
    body ? h('p', { class: 'muted' }, body) : null,
    action);
}

/** Skeleton placeholders: kind = 'table' | 'cards' | 'calendar' | 'detail'. */
export function skeleton(kind = 'table', n = 6) {
  const bar = (w, cls = '') => h('span', { class: `sk ${cls}`, style: { width: w } });
  if (kind === 'cards') return h('div', { class: 'sk-cards', 'aria-busy': 'true', 'aria-label': 'Loading' }, Array.from({ length: n }, () => h('div', { class: 'card sk-card' }, bar('40%', 'lg'), bar('85%'), bar('65%'), bar('30%'))));
  if (kind === 'calendar') return h('div', { class: 'card sk-cal', 'aria-busy': 'true', 'aria-label': 'Loading' }, Array.from({ length: 35 }, () => h('div', { class: 'sk-cell' }, bar('30%'), Math.random() > 0.6 ? bar('80%') : null)));
  if (kind === 'detail') return h('div', { 'aria-busy': 'true', 'aria-label': 'Loading' }, bar('25%', 'lg'), h('div', { class: 'card sk-card' }, bar('90%'), bar('70%'), bar('80%'), bar('40%')));
  return h('div', { class: 'table-wrap sk-table', 'aria-busy': 'true', 'aria-label': 'Loading' },
    h('div', { class: 'sk-row head' }, bar('12%'), bar('18%'), bar('30%'), bar('10%')),
    Array.from({ length: n }, (_, i) => h('div', { class: 'sk-row' }, bar(`${10 + (i % 3) * 3}%`), bar(`${16 + (i % 2) * 6}%`), bar(`${28 + (i % 4) * 8}%`), bar('9%', 'pill'))));
}

let openMenu = null;
export function closeMenus() { if (openMenu) openMenu(); }

/**
 * Dropdown menu anchored to an element. items: [{ label, icon, onClick, href, danger, sep, hint, disabled }].
 * Keyboard: arrows move, Enter activates, Esc closes and returns focus to the anchor.
 */
export function dropdown(anchor, items, { align = 'left', width = 220, header = null } = {}) {
  closeMenus();
  const menu = h('div', { class: 'menu', role: 'menu', style: { minWidth: `${width}px` } },
    header ? h('div', { class: 'menu-head' }, header) : null,
    items.filter(Boolean).map((it) => {
      if (it.sep) return h('div', { class: 'menu-sep', role: 'separator' });
      if (it.label === undefined && it.node) return it.node;
      const tag = it.href ? 'a' : 'button';
      return h(tag, {
        class: `menu-item ${it.danger ? 'danger' : ''} ${it.active ? 'on' : ''}`, role: 'menuitem', tabindex: '-1', href: it.href, target: it.target, rel: it.target ? 'noopener' : null, disabled: it.disabled,
        onclick: async (ev) => { if (!it.href) ev.preventDefault(); ev.stopPropagation(); close(); if (it.onClick) { try { await it.onClick(); } catch (e) { toast(e.message, 'error'); } } },
      }, it.icon ? icon(it.icon, 15) : h('span', { class: 'ic-sp' }), h('span', { class: 'mi-label' }, it.label), it.hint ? h('span', { class: 'mi-hint' }, it.hint) : null);
    }));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = Math.max(width, menu.offsetWidth);
  const left = align === 'right' ? Math.max(8, r.right - mw) : Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + menu.offsetHeight > window.innerHeight - 8 && r.top - menu.offsetHeight - 6 > 8) top = r.top - menu.offsetHeight - 6;
  Object.assign(menu.style, { top: `${top + window.scrollY}px`, left: `${Math.max(8, left) + window.scrollX}px` });
  anchor.setAttribute('aria-expanded', 'true');
  const focusables = () => [...menu.querySelectorAll('.menu-item:not([disabled])')];
  const onKey = (e) => {
    const f = focusables();
    const i = f.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); } else if (e.key === 'ArrowDown') { e.preventDefault(); f[(i + 1) % f.length]?.focus(); } else if (e.key === 'ArrowUp') { e.preventDefault(); f[(i - 1 + f.length) % f.length]?.focus(); } else if (e.key === 'Tab') close();
  };
  const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  function close() {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDoc, true);
    window.removeEventListener('resize', close);
    if (openMenu === close) openMenu = null;
  }
  openMenu = close;
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDoc, true);
  window.addEventListener('resize', close);
  requestAnimationFrame(() => focusables()[0]?.focus({ preventScroll: true }));
  return close;
}

/** Monospace, click-to-copy identifier (Render shows srv-… ids like this). */
export function idChip(id, { short = 8, prefix = '' } = {}) {
  const s = String(id || '');
  return h('button', { type: 'button', class: 'id-chip', title: `Copy ${s}`, onclick: async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(s); toast('Copied ID', 'success', 1500); } catch { toast(s, 'info'); } } }, `${prefix}${s.length > short ? s.slice(0, short) : s}`);
}

export function copyButton(text, label = 'Copy') {
  return h('button', { type: 'button', class: 'btn small ghost', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied', 'success', 1500); } catch { toast('Copy failed — select the text manually', 'error'); } } }, icon('copy', 14), label);
}

/** A bordered section card with a header row. */
export function section(title, { actions = null, sub = null, cls = '' } = {}, ...body) {
  return h('section', { class: `card section ${cls}` },
    h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title' }, title), sub ? h('p', { class: 'muted small' }, sub) : null), actions ? h('div', { class: 'row gap wrap' }, actions) : null),
    h('div', { class: 'section-body' }, body));
}

/** Breadcrumbs in the top bar. crumbs: [[label, href?], ...] */
export function setCrumbs(crumbs) {
  const el = document.getElementById('crumbs');
  if (!el) return;
  el.replaceChildren(...crumbs.flatMap(([label, href], i) => {
    const last = i === crumbs.length - 1;
    const node = href && !last ? h('a', { href }, label) : h('span', { 'aria-current': last ? 'page' : null }, label);
    return i ? [h('span', { class: 'sep', 'aria-hidden': 'true' }, '/'), node] : [node];
  }));
  document.title = `${crumbs.at(-1)?.[0] || 'Dashboard'} · postlite`;
}
