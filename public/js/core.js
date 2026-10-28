// Tiny DOM + API helpers for the postlite UI (no framework, no build step).
import { icon } from './icons.js';

export let CSRF = null;
export const state = { settings: null, accounts: [], providers: [], me: null };

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) if (sv !== undefined) el.style.setProperty(sk.startsWith('--') ? sk : sk.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), sv); }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, k === 'draggable' || k === 'contenteditable' || k.startsWith('aria-') ? 'true' : '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (method !== 'GET') opts.headers['x-csrf-token'] = CSRF;
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(`/api/v1${path}`, opts);
  if (res.status === 401) { location.href = '/login'; throw new ApiError(401, 'Logged out'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, j.error?.message || `HTTP ${res.status}`, j.error?.details);
  return j;
}

export async function bootstrap() {
  const r = await fetch('/api/v1/session');
  const s = await r.json().catch(() => ({}));
  if (!s.csrf) { location.href = '/login'; return false; }
  CSRF = s.csrf;
  state.me = s;
  await refreshCommon();
  return true;
}

export async function refreshCommon() {
  const [st, acc, prov] = await Promise.all([api('GET', '/settings'), api('GET', '/accounts'), api('GET', '/oauth/providers')]);
  state.settings = st.settings;
  state.accounts = acc.accounts;
  state.providers = prov.providers;
}

/** XHR PUT of one part; resolves with its ETag (header for direct-to-R2, JSON for the proxy route). */
function putPart(url, blob, onProgress, proxied) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (proxied) xhr.setRequestHeader('x-csrf-token', CSRF);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(j.etag || xhr.getResponseHeader('etag'));
      else reject(new ApiError(xhr.status, j.error?.message || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
    xhr.send(blob);
  });
}

/**
 * Large files: resumable multipart session (POST /media/uploads → PUT parts, 3 in parallel → complete).
 * On Cloudflare Workers this keeps every request under the 100 MB body limit, and with R2 API
 * credentials configured the parts go straight to R2 via presigned URLs.
 */
async function uploadMultipart(file, onProgress) {
  const { upload } = await api('POST', '/media/uploads', { filename: file.name, size: file.size });
  const loaded = new Map();
  const report = () => onProgress?.([...loaded.values()].reduce((a, b) => a + b, 0) / file.size);
  const parts = [];
  let next = 0;
  const all = [...upload.parts];
  while (all.length < upload.part_count) { // part URLs come in pages of 100
    const more = await api('GET', `/media/uploads/${upload.upload_id}?from=${all.length + 1}`);
    if (!more.upload.parts.length) break;
    all.push(...more.upload.parts);
  }
  const worker = async () => {
    while (next < all.length) {
      const p = all[next++];
      const start = (p.part_number - 1) * upload.part_size;
      for (let attempt = 1; ; attempt++) {
        try {
          const etag = await putPart(p.url, file.slice(start, start + p.size), (n) => { loaded.set(p.part_number, n); report(); }, upload.mode !== 'presigned');
          parts.push({ part_number: p.part_number, etag });
          break;
        } catch (e) {
          if (attempt >= 3 || (e.status >= 400 && e.status < 500)) throw e;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
  } catch (e) {
    api('DELETE', `/media/uploads/${upload.upload_id}`).catch(() => {});
    throw e;
  }
  parts.sort((a, b) => a.part_number - b.part_number);
  const done = await api('POST', `/media/uploads/${upload.upload_id}/complete`, { parts });
  return done.media;
}

const MULTIPART_OVER = 90 * 1024 * 1024;

/** Upload with progress via XHR (fetch has no upload progress). */
export function uploadFile(file, onProgress) {
  if (file.size > MULTIPART_OVER) return uploadMultipart(file, onProgress);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1/media?filename=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('x-csrf-token', CSRF);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(j.media);
      else reject(new ApiError(xhr.status, j.error?.message || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
    xhr.send(file);
  });
}

// ---- toasts / modal / confirm ----
const TOAST_ICON = { success: 'check-circle', error: 'x-circle', info: 'info', warn: 'alert' };
export function toast(msg, kind = 'info', ms = 4000) {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(host); }
  const close = () => { t.classList.remove('show'); setTimeout(() => t.remove(), 220); };
  const t = h('div', { class: `toast ${kind}` }, icon(TOAST_ICON[kind] || 'info', 16), h('span', { class: 'toast-msg' }, msg), h('button', { class: 'toast-x', 'aria-label': 'Dismiss', onclick: () => close() }, icon('x', 14)));
  host.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(close, ms);
}

export function modal(content, { wide = false, onClose, label = 'Dialog' } = {}) {
  const prevFocus = document.activeElement;
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': label, tabindex: '-1' }, content);
  back.append(box);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.classList.remove('show');
    setTimeout(() => back.remove(), 160);
    document.removeEventListener('keydown', onKey);
    onClose?.();
    prevFocus?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.menu')) close();
    if (e.key === 'Tab') { // keep focus inside the dialog
      const f = [...box.querySelectorAll('button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    }
  };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  requestAnimationFrame(() => { back.classList.add('show'); (box.querySelector('[autofocus]') || box).focus({ preventScroll: true }); });
  return { close, box };
}

export function confirmDialog(message, { ok = 'Confirm', danger = false, input = null, title = null } = {}) {
  return new Promise((resolve) => {
    const field = input ? h('textarea', { class: 'input', rows: 3, placeholder: input, autofocus: true }) : null;
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal(h('div', { class: 'confirm' },
      h('h3', { class: 'confirm-title' }, title || (danger ? 'Are you sure?' : 'Confirm')),
      h('p', { class: 'muted' }, message),
      field,
      h('div', { class: 'row end gap' },
        h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, autofocus: !field, onclick: () => finish(field ? field.value : true) }, ok))),
    { onClose: () => { if (!done) { done = true; resolve(null); } } });
  });
}

// ---- formatting ----
// Brand marks (simple monochrome glyphs, used only to identify the platform).
export const MARKS = {
  youtube: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8ZM9.7 15.1V8.9L15.5 12l-5.8 3.1Z"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.5 21v-7.6h2.6l.4-3h-3V8.5c0-.9.3-1.5 1.5-1.5h1.6V4.3c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4v2.2H7.8v3h2.6V21h3.1Z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M7.5 3h9A4.5 4.5 0 0 1 21 7.5v9a4.5 4.5 0 0 1-4.5 4.5h-9A4.5 4.5 0 0 1 3 16.5v-9A4.5 4.5 0 0 1 7.5 3Z"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17.3" cy="6.7" r="1.1" fill="currentColor"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
  linkedin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zm1.78 13.02H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/></svg>',
};

export const PROVIDER_META = {
  youtube: { label: 'YouTube', short: 'YT', color: '#ff3b3b' },
  facebook: { label: 'Facebook', short: 'FB', color: '#3b82f6' },
  instagram: { label: 'Instagram', short: 'IG', color: '#e1306c' },
  'instagram-standalone': { label: 'Instagram', short: 'IG', color: '#c13584' },
  x: { label: 'X', short: 'X', color: '#a1a1aa' },
  linkedin: { label: 'LinkedIn', short: 'in', color: '#0a66c2' },
  'linkedin-page': { label: 'LinkedIn Page', short: 'in', color: '#0a66c2' },
};
/** Brand mark key for a provider (the two Instagram logins share one mark, as do LinkedIn profiles and Pages). */
export const markOf = (provider) => ({ 'instagram-standalone': 'instagram', 'linkedin-page': 'linkedin' }[provider] || provider);

export function avatar(account, size = 28) {
  const m = PROVIDER_META[account.provider] || {};
  const initials = (account.name || account.account_name || '?').trim().slice(0, 1).toUpperCase();
  const pic = account.picture || account.account_picture;
  return h('span', { class: 'avatar', style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, '--pc': m.color }, title: `${account.name || account.account_name} · ${m.label}` },
    pic ? h('img', { src: pic, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : null,
    h('span', { class: 'initial' }, initials),
    size >= 20 ? (() => { const b = h('span', { class: 'badge-p' }); b.innerHTML = MARKS[markOf(account.provider)] || ''; return b; })() : null);
}

export const STATUS_LABEL = { published: 'Published', scheduled: 'Scheduled', failed: 'Failed', pending_approval: 'Pending approval', draft: 'Draft', publishing: 'Publishing', partially_failed: 'Partially failed', missed: 'Missed' };
/** Render-style status pill with a colored dot. */
export const statusBadge = (s) => h('span', { class: `status s-${s}` }, h('i', { class: 'sd', 'aria-hidden': 'true' }), STATUS_LABEL[s] || String(s).replace(/_/g, ' '));
export const fmtNum = (n) => (n === null || n === undefined ? '—' : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n * 10) / 10));
export const fmtBytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
export const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/** replaceChildren that ignores null/false (avoids rendering the text "null"). */
export const mount = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));

export function relTime(ms) {
  const d = ms - Date.now();
  const abs = Math.abs(d);
  if (abs < 60000) return 'just now';
  const u = abs < 3600000 ? [Math.round(abs / 60000), 'min'] : abs < 86400000 ? [Math.round(abs / 3600000), 'h'] : [Math.round(abs / 86400000), 'd'];
  return d >= 0 ? `in ${u[0]} ${u[1]}` : `${u[0]} ${u[1]} ago`;
}

export { icon };
