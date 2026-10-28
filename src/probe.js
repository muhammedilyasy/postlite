// Dependency-free, runtime-agnostic media probing: sniff the type from magic bytes, image dimensions
// (JPEG/PNG/GIF/WebP) and MP4/MOV duration + display size by walking the `moov` box through an
// async range reader (local file on Node, R2 ranged GETs on Workers).
import { view, latin1 } from './bytes.js';

export const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
};
export const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'application/pdf': 'pdf' };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Sniff mime from magic bytes (never trust the client-provided type). */
export function sniffMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && PNG_SIG.every((b, i) => buf[i] === b)) return 'image/png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(latin1(buf, 0, 6))) return 'image/gif';
  if (buf.length >= 12 && latin1(buf, 0, 4) === 'RIFF' && latin1(buf, 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && latin1(buf, 4, 8) === 'ftyp') return latin1(buf, 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  if (buf.length >= 5 && latin1(buf, 0, 5) === '%PDF-') return 'application/pdf'; // LinkedIn document posts
  return null;
}

export function imageSize(buf, mime) {
  try {
    const d = view(buf);
    if (mime === 'image/png') return { width: d.getUint32(16), height: d.getUint32(20) };
    if (mime === 'image/gif') return { width: d.getUint16(6, true), height: d.getUint16(8, true) };
    if (mime === 'image/webp') {
      const chunk = latin1(buf, 12, 16);
      if (chunk === 'VP8 ') return { width: d.getUint16(26, true) & 0x3fff, height: d.getUint16(28, true) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = d.getUint32(21, true);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') return { width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1, height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
    }
    if (mime === 'image/jpeg') {
      let o = 2;
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) { o++; continue; }
        const marker = buf[o + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { o += marker === 0xff ? 1 : 2; continue; }
        const len = d.getUint16(o + 2);
        if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: d.getUint16(o + 5), width: d.getUint16(o + 7) };
        }
        o += 2 + len;
      }
    }
  } catch {}
  return { width: null, height: null };
}

function* boxes(buf, start = 0, end = buf.length) {
  const d = view(buf);
  let o = start;
  while (o + 8 <= end) {
    let size = d.getUint32(o);
    const type = latin1(buf, o + 4, o + 8);
    let header = 8;
    if (size === 1) { size = Number(d.getBigUint64(o + 8)); header = 16; }
    if (size === 0) size = end - o;
    if (size < header) return;
    yield { type, start: o + header, end: Math.min(o + size, end) };
    o += size;
  }
}

/**
 * Parse MP4/MOV `moov` for duration and the first video track's display size.
 * @param {(pos:number, len:number) => Promise<Uint8Array>} read  ranged reader
 * @param {number} total  file size
 */
export async function probeMp4(read, total) {
  try {
    let pos = 0;
    let moov = null;
    while (pos + 8 <= total) {
      const h = await read(pos, 16);
      if (h.length < 8) break;
      const hd = view(h);
      let size = hd.getUint32(0);
      const type = latin1(h, 4, 8);
      let header = 8;
      if (size === 1) { size = Number(hd.getBigUint64(8)); header = 16; }
      if (size === 0) size = total - pos;
      if (size < 8) break;
      if (type === 'moov') {
        if (size > 64 * 1024 * 1024) break;
        moov = await read(pos + header, size - header);
        break;
      }
      pos += size;
    }
    if (!moov) return { duration: null, width: null, height: null };
    const d = view(moov);
    let duration = null, width = null, height = null;
    for (const b of boxes(moov)) {
      if (b.type === 'mvhd') {
        const v = moov[b.start];
        const ts = v === 1 ? d.getUint32(b.start + 20) : d.getUint32(b.start + 12);
        const dur = v === 1 ? Number(d.getBigUint64(b.start + 24)) : d.getUint32(b.start + 16);
        if (ts) duration = dur / ts;
      }
      if (b.type === 'trak' && width === null) {
        let tk = null, isVideo = false;
        for (const c of boxes(moov, b.start, b.end)) {
          if (c.type === 'tkhd') tk = c;
          if (c.type === 'mdia') {
            for (const m of boxes(moov, c.start, c.end)) {
              if (m.type === 'hdlr' && latin1(moov, m.start + 8, m.start + 12) === 'vide') isVideo = true;
            }
          }
        }
        if (tk && isVideo) {
          const w = d.getUint32(tk.end - 8) / 65536;
          const hgt = d.getUint32(tk.end - 4) / 65536;
          const mStart = tk.end - 8 - 36;
          const a = d.getInt32(mStart), bb = d.getInt32(mStart + 4);
          const rotated = a === 0 && Math.abs(bb) === 65536;
          width = Math.round(rotated ? hgt : w);
          height = Math.round(rotated ? w : hgt);
        }
      }
    }
    return { duration: duration === null ? null : Math.round(duration * 1000) / 1000, width, height };
  } catch {
    return { duration: null, width: null, height: null };
  }
}
