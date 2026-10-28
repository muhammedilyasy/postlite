// Local media storage. Files live in data/uploads/<id>.<ext>; Meta/Google fetch them via
// PUBLIC_URL/m/<unguessable token>/<id>.<ext> (no session needed, token is 256-bit random).
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { uid, randomToken } from './crypto.js';
import { sniffMime, imageSize, probeMp4, ffprobe, makePoster, EXT_BY_MIME } from './probe.js';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function createMedia({ db, cfg }) {
  fs.mkdirSync(cfg.uploadDir, { recursive: true });
  const filePath = (m) => path.join(cfg.uploadDir, m.filename);
  const view = (m) => m && {
    id: m.id, name: m.original_name, mime: m.mime, kind: m.kind, size: m.size, width: m.width, height: m.height, duration: m.duration,
    url: `/m/${m.token}/${m.filename}`, poster: m.poster ? `/m/${m.token}/${m.poster}` : null, created_at: m.created_at,
  };

  return {
    path: filePath,
    view,
    publicUrl: (m) => `${cfg.publicUrl}/m/${m.token}/${m.filename}`,
    get: (id) => db.get('SELECT * FROM media WHERE id = ?', id),
    getMany(ids) {
      return (ids || []).map((id) => db.get('SELECT * FROM media WHERE id = ?', id)).filter(Boolean);
    },
    list: (limit = 100) => db.all('SELECT * FROM media ORDER BY created_at DESC LIMIT ?', limit).map(view),

    async save(stream, originalName = 'upload') {
      const id = uid();
      const tmp = path.join(cfg.uploadDir, `.${id}.part`);
      const max = cfg.maxUploadMb * 1024 * 1024;
      let size = 0;
      let head = Buffer.alloc(0);
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          if (size > max) return cb(new HttpError(413, `File exceeds MAX_UPLOAD_MB (${cfg.maxUploadMb} MB)`));
          if (head.length < 65536) head = Buffer.concat([head, chunk.subarray(0, 65536 - head.length)]);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(stream, counter, fs.createWriteStream(tmp, { mode: 0o640 }));
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e instanceof HttpError ? e : new HttpError(400, `Upload failed: ${e.message}`);
      }
      const mime = sniffMime(head);
      if (!mime || !EXT_BY_MIME[mime]) {
        fs.rmSync(tmp, { force: true });
        throw new HttpError(415, 'Unsupported file type. Use JPEG, PNG, GIF, WebP, MP4 or MOV.');
      }
      if (size === 0) {
        fs.rmSync(tmp, { force: true });
        throw new HttpError(400, 'Empty file');
      }
      const filename = `${id}.${EXT_BY_MIME[mime]}`;
      const full = path.join(cfg.uploadDir, filename);
      fs.renameSync(tmp, full);
      const kind = mime.startsWith('video/') ? 'video' : 'image';
      let info = { width: null, height: null, duration: null };
      if (kind === 'image') {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(Math.min(size, 512 * 1024));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        info = { ...imageSize(buf, mime), duration: null };
      } else {
        info = probeMp4(full);
        if ((!info.width || !info.duration) && cfg.ffprobePath) info = (await ffprobe(cfg.ffprobePath, full)) || info;
      }
      let poster = null;
      if (kind === 'video' && cfg.ffmpegPath) {
        const pname = `${id}.poster.jpg`;
        if (await makePoster(cfg.ffmpegPath, full, path.join(cfg.uploadDir, pname))) poster = pname;
      }
      const row = {
        id, token: randomToken(32), filename, original_name: String(originalName).slice(0, 200), mime, kind, size,
        width: info.width, height: info.height, duration: info.duration, poster, created_at: Date.now(),
      };
      db.run('INSERT INTO media(id, token, filename, original_name, mime, kind, size, width, height, duration, poster, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        row.id, row.token, row.filename, row.original_name, row.mime, row.kind, row.size, row.width, row.height, row.duration, row.poster, row.created_at);
      return row;
    },

    remove(id) {
      const m = db.get('SELECT * FROM media WHERE id = ?', id);
      if (!m) return false;
      db.run('DELETE FROM media WHERE id = ?', id);
      fs.rmSync(filePath(m), { force: true });
      if (m.poster) fs.rmSync(path.join(cfg.uploadDir, m.poster), { force: true });
      return true;
    },

    /** Public media endpoint with Range support (Meta and Google fetchers use ranges). */
    serve(req, res, token, name) {
      const m = db.get('SELECT * FROM media WHERE token = ?', token);
      if (!m || (name !== m.filename && name !== m.poster)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Not found');
      }
      const isPoster = name === m.poster;
      const full = path.join(cfg.uploadDir, name);
      let st;
      try { st = fs.statSync(full); } catch { res.writeHead(404); return res.end(); }
      const headers = {
        'content-type': isPoster ? 'image/jpeg' : m.mime, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff', 'content-disposition': 'inline',
      };
      const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (range) {
        let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
        let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
        if (range[1] === '') end = st.size - 1;
        if (start < 0) start = 0;
        if (start >= st.size || end < start) {
          res.writeHead(416, { 'content-range': `bytes */${st.size}` });
          return res.end();
        }
        end = Math.min(end, st.size - 1);
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(full, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, 'content-length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(full).pipe(res);
    },
  };
}
