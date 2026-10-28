// Dependency-free media probing: image dimensions (JPEG/PNG/GIF/WebP) and MP4/MOV duration + dimensions.
import fs from 'node:fs';
import { execFile } from 'node:child_process';

export const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
};
export const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

/** Sniff mime from magic bytes (never trust the client-provided type). */
export function sniffMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  return null;
}

export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/webp') {
      const chunk = buf.subarray(12, 16).toString('latin1');
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    if (mime === 'image/jpeg') {
      let o = 2;
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) { o++; continue; }
        const marker = buf[o + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { o += marker === 0xff ? 1 : 2; continue; }
        const len = buf.readUInt16BE(o + 2);
        if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
        }
        o += 2 + len;
      }
    }
  } catch {}
  return { width: null, height: null };
}

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return b.subarray(0, n);
}

function* boxes(buf, start = 0, end = buf.length) {
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    const type = buf.subarray(o + 4, o + 8).toString('latin1');
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); header = 16; }
    if (size === 0) size = end - o;
    if (size < header) return;
    yield { type, start: o + header, end: Math.min(o + size, end) };
    o += size;
  }
}

/** Parse MP4/MOV `moov` for duration and the first video track's display size. */
export function probeMp4(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    let pos = 0;
    let moov = null;
    while (pos + 8 <= total) {
      const h = readAt(fd, pos, 16);
      let size = h.readUInt32BE(0);
      const type = h.subarray(4, 8).toString('latin1');
      let header = 8;
      if (size === 1) { size = Number(h.readBigUInt64BE(8)); header = 16; }
      if (size === 0) size = total - pos;
      if (size < 8) break;
      if (type === 'moov') {
        if (size > 64 * 1024 * 1024) break;
        moov = readAt(fd, pos + header, size - header);
        break;
      }
      pos += size;
    }
    if (!moov) return { duration: null, width: null, height: null };
    let duration = null, width = null, height = null;
    for (const b of boxes(moov)) {
      if (b.type === 'mvhd') {
        const v = moov[b.start];
        const ts = v === 1 ? moov.readUInt32BE(b.start + 20) : moov.readUInt32BE(b.start + 12);
        const d = v === 1 ? Number(moov.readBigUInt64BE(b.start + 24)) : moov.readUInt32BE(b.start + 16);
        if (ts) duration = d / ts;
      }
      if (b.type === 'trak' && width === null) {
        let tk = null, isVideo = false;
        for (const c of boxes(moov, b.start, b.end)) {
          if (c.type === 'tkhd') tk = c;
          if (c.type === 'mdia') {
            for (const m of boxes(moov, c.start, c.end)) {
              if (m.type === 'hdlr' && moov.subarray(m.start + 8, m.start + 12).toString('latin1') === 'vide') isVideo = true;
            }
          }
        }
        if (tk && isVideo) {
          const w = moov.readUInt32BE(tk.end - 8) / 65536;
          const hgt = moov.readUInt32BE(tk.end - 4) / 65536;
          const mStart = tk.end - 8 - 36;
          const a = moov.readInt32BE(mStart), bb = moov.readInt32BE(mStart + 4);
          const rotated = a === 0 && Math.abs(bb) === 65536;
          width = Math.round(rotated ? hgt : w);
          height = Math.round(rotated ? w : hgt);
        }
      }
    }
    return { duration: duration === null ? null : Math.round(duration * 1000) / 1000, width, height };
  } catch {
    return { duration: null, width: null, height: null };
  } finally {
    fs.closeSync(fd);
  }
}

/** Optional ffprobe fallback (when FFPROBE_PATH is configured and the JS parser found nothing). */
export function ffprobe(bin, file) {
  return new Promise((resolve) => {
    execFile(bin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { timeout: 30000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(out);
        resolve({ width: j.streams?.[0]?.width ?? null, height: j.streams?.[0]?.height ?? null, duration: j.format?.duration ? Number(j.format.duration) : null });
      } catch { resolve(null); }
    });
  });
}

/** Optional poster frame (JPEG) for video previews via ffmpeg. */
export function makePoster(bin, file, out) {
  return new Promise((resolve) => {
    execFile(bin, ['-y', '-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', out], { timeout: 60000 }, (err) => resolve(!err && fs.existsSync(out)));
  });
}
