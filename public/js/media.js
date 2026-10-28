// Media visuals: every video shows a poster frame, never a blank/black box.
//   1. the stored poster (ffmpeg on Node at upload time) as <img> or as the <video poster>;
//   2. no poster yet (Cloudflare Workers has no ffmpeg; old uploads): the browser grabs a frame (~1 s in),
//      uploads it as the media's poster (POST /media/{id}/poster) and swaps it in — once per media item;
//   3. until then / if that fails: the video itself at #t=0.5 with preload=metadata, which paints a frame.
import { h, api, icon } from './core.js';

const inflight = new Map(); // media id -> Promise<poster url | null>
const failed = new Set();

const once = (el, ev, ms = 15000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { cleanup(); reject(new Error(`${ev} timeout`)); }, ms);
  const ok = () => { cleanup(); resolve(); };
  const bad = () => { cleanup(); reject(new Error('video error')); };
  const cleanup = () => { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
  el.addEventListener(ev, ok);
  el.addEventListener('error', bad);
});

/** Grab one frame of a video (URL or blob: URL) as a JPEG Blob, scaled to at most 720 px. */
export async function capturePoster(src, at = 1) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = src;
  try {
    await once(v, 'loadeddata');
    const t = Number.isFinite(v.duration) && v.duration > 0 ? Math.min(at, v.duration / 2) : at;
    if (Math.abs(v.currentTime - t) > 0.01) { v.currentTime = t; await once(v, 'seeked'); }
    const w = v.videoWidth;
    const hh = v.videoHeight;
    if (!w || !hh) throw new Error('no video frame');
    const scale = Math.min(1, 720 / Math.max(w, hh));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(hh * scale);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    if (!blob) throw new Error('canvas export failed');
    return blob;
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^;]+;base64,/, ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/**
 * Make sure a video media item has a poster: generate one from `source` (a File/Blob at upload time,
 * else the media URL) and store it on the server. Resolves with the poster URL (or null). Deduped.
 */
export function ensurePoster(md, source = null) {
  if (!md || md.kind !== 'video') return Promise.resolve(null);
  if (md.poster) return Promise.resolve(md.poster);
  if (failed.has(md.id)) return Promise.resolve(null);
  if (inflight.has(md.id)) return inflight.get(md.id);
  const p = (async () => {
    const url = source ? URL.createObjectURL(source) : md.url;
    try {
      const blob = await capturePoster(url);
      const { media } = await api('POST', `/media/${md.id}/poster`, { data: await toBase64(blob) });
      md.poster = media.poster;
      return md.poster;
    } catch {
      failed.add(md.id);
      return null;
    } finally {
      if (source) URL.revokeObjectURL(url);
      inflight.delete(md.id);
    }
  })();
  inflight.set(md.id, p);
  return p;
}

/**
 * The visual for one media item.
 *   playable: a <video controls> (poster attribute set) instead of a still image, for previews.
 *   cls: class for the element (e.g. "lthumb").
 */
export function mediaVisual(md, { playable = false, cls = null, alt = '' } = {}) {
  if (!md) return null;
  if (md.kind !== 'video') return h('img', { class: cls, src: md.url, alt, loading: 'lazy' });
  if (md.poster && !playable) return h('img', { class: cls, src: md.poster, alt, loading: 'lazy' });
  const v = h('video', {
    class: cls, src: md.poster ? md.url : `${md.url}#t=0.5`, poster: md.poster || null, muted: true, playsinline: true,
    preload: md.poster ? 'none' : 'metadata', controls: playable || null,
  });
  v.muted = true;
  if (!md.poster) {
    ensurePoster(md).then((poster) => {
      if (!poster || !v.isConnected) return;
      if (playable) { v.poster = poster; return; }
      v.replaceWith(h('img', { class: cls, src: poster, alt, loading: 'lazy' }));
    });
  }
  return v;
}

/** Small list thumbnail (posts list, calendar, approvals): poster/image, else a placeholder mark. */
export function listThumb(md, { cls = 'lthumb', size = 14 } = {}) {
  if (!md) return h('span', { class: `${cls} ph` }, icon('image', size));
  const el = mediaVisual(md, { cls });
  if (el.tagName === 'IMG') el.addEventListener('error', () => el.replaceWith(h('span', { class: `${cls} ph` }, icon(md.kind === 'video' ? 'play' : 'image', size))));
  return el;
}
