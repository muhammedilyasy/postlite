// Local-disk media storage for Node (data/uploads). Same interface as the R2 adapter (src/workers/r2.js):
//   put(key, body, {size}) · get(key, {offset, length}) · head(key) · read(key, offset, length) · delete(key)
//   multipart: mpCreate · mpPart · mpComplete · mpAbort · localPath(key) (Node only: ffmpeg/ffprobe)
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomToken } from '../crypto.js';

const safeKey = (key) => {
  const k = String(key || '');
  if (!/^[A-Za-z0-9._/-]+$/.test(k) || k.includes('..') || k.startsWith('/')) throw new Error(`Invalid storage key ${k}`);
  return k;
};

export function createFsStorage(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const full = (key) => path.join(dir, safeKey(key));
  const mpDir = (id) => path.join(dir, '.mp', String(id).replace(/[^\w-]/g, ''));
  const toNode = (body) => (body instanceof Uint8Array ? Readable.from([Buffer.from(body.buffer, body.byteOffset, body.byteLength)]) : Readable.fromWeb(body));

  const api = {
    kind: 'fs',
    localPath: (key) => full(key),
    async put(key, body) {
      const dest = full(key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${randomToken(6)}.part`;
      try {
        await pipeline(toNode(body), fs.createWriteStream(tmp, { mode: 0o640 }));
        fs.renameSync(tmp, dest);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      return { size: fs.statSync(dest).size };
    },
    async head(key) {
      try { const st = fs.statSync(full(key)); return st.isFile() ? { size: st.size } : null; } catch { return null; }
    },
    /** Stream a byte range (inclusive offset, length bytes) as a web ReadableStream. */
    async get(key, { offset = 0, length } = {}) {
      const f = full(key);
      let st;
      try { st = fs.statSync(f); } catch { return null; }
      const end = length === undefined ? st.size - 1 : offset + length - 1;
      return { size: st.size, body: Readable.toWeb(fs.createReadStream(f, { start: offset, end, highWaterMark: 256 * 1024 })) };
    },
    async read(key, offset, length) {
      const fd = fs.openSync(full(key), 'r');
      try {
        const b = Buffer.alloc(length);
        const n = fs.readSync(fd, b, 0, length, offset);
        return new Uint8Array(b.buffer, b.byteOffset, n);
      } finally { fs.closeSync(fd); }
    },
    async delete(key) { fs.rmSync(full(key), { force: true }); },
    async rename(from, to) { fs.renameSync(full(from), full(to)); },

    // ---- multipart (upload sessions) ----
    async mpCreate() {
      const id = randomToken(16);
      fs.mkdirSync(mpDir(id), { recursive: true });
      return id;
    },
    async mpPart(_key, id, n, body) {
      const d = mpDir(id);
      if (!fs.existsSync(d)) throw new Error('Upload session not found');
      const tmp = path.join(d, `${n}.part`);
      await pipeline(toNode(body), fs.createWriteStream(tmp, { mode: 0o640 }));
      fs.renameSync(tmp, path.join(d, String(n)));
      return { etag: `"${n}-${fs.statSync(path.join(d, String(n))).size}"`, size: fs.statSync(path.join(d, String(n))).size };
    },
    async mpComplete(key, id, parts) {
      const d = mpDir(id);
      const dest = full(key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${randomToken(6)}.part`;
      const out = fs.createWriteStream(tmp, { mode: 0o640 });
      try {
        for (const p of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
          const f = path.join(d, String(p.partNumber));
          if (!fs.existsSync(f)) throw new Error(`Part ${p.partNumber} was not uploaded`);
          await pipeline(fs.createReadStream(f), out, { end: false });
        }
        await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
        fs.renameSync(tmp, dest);
      } catch (e) {
        out.destroy();
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      fs.rmSync(d, { recursive: true, force: true });
      return { size: fs.statSync(dest).size };
    },
    async mpAbort(_key, id) { fs.rmSync(mpDir(id), { recursive: true, force: true }); },
  };
  return api;
}
