// Media library on top of a storage adapter (local disk on Node, R2 on Workers).
// Meta/Google fetch files via PUBLIC_URL/m/<unguessable token>/<id>.<ext> (no session needed; the
// token is 256-bit random), served with Range support from local disk or streamed from R2.
// Uploads: one streamed request (save) or a multipart upload session (createUpload → parts →
// completeUpload). On Workers the parts go straight to R2 with presigned S3 URLs when R2 API
// credentials are configured, otherwise through the Worker (each part < 100 MB request limit).
import { uid, randomToken, hmacHex, safeEqual } from './crypto.js';
import { concatBytes } from './bytes.js';
import { sniffMime, imageSize, probeMp4, EXT_BY_MIME } from './probe.js';
import { presignUrl } from './sigv4.js';
import { HttpError } from './errors.js';

export { HttpError };

const HEAD_BYTES = 65536;
const MiB = 1024 * 1024;

/** Read up to n bytes from the front of a web stream without losing them. */
async function peek(stream, n) {
  const reader = stream.getReader();
  const chunks = [];
  let got = 0;
  let done = false;
  while (got < n) {
    const r = await reader.read();
    if (r.done) { done = true; break; }
    const v = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value);
    chunks.push(v);
    got += v.length;
  }
  return { head: concatBytes(chunks).subarray(0, n), chunks, reader, done };
}

/** Re-assemble peeked chunks + the rest of the stream, counting bytes and enforcing a maximum. */
function rejoin({ chunks, reader, done }, max, tooBig) {
  let i = 0;
  let size = 0;
  let finished = done;
  return new ReadableStream({
    async pull(ctrl) {
      let v;
      if (i < chunks.length) v = chunks[i++];
      else if (finished) { ctrl.close(); return; }
      else {
        const r = await reader.read();
        if (r.done) { finished = true; ctrl.close(); return; }
        v = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value);
      }
      size += v.length;
      if (size > max) {
        reader.cancel().catch(() => {});
        ctrl.error(tooBig());
        return;
      }
      ctrl.enqueue(v);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

/**
 * @param {{db:any, cfg:any, storage:any, hooks?:{ffprobe?:Function, makePoster?:Function}}} deps
 */
export function createMedia({ db, cfg, storage, hooks = {}, ws = null }) {
  // ws = workspace id. Without it (root core) only the token-authorized paths work: serve(), putPart()
  // and cleanupUploads(); every library method needs a workspace.
  const W = () => { if (!ws) throw new Error('media: workspace scope required'); return ws; };
  const keyOf = (m) => m.storage_key || m.filename;
  const view = (m) => m && {
    id: m.id, name: m.original_name, mime: m.mime, kind: m.kind, size: m.size, width: m.width, height: m.height, duration: m.duration,
    url: `/m/${m.token}/${m.filename}`, poster: m.poster ? `/m/${m.token}/${m.poster}` : null, created_at: m.created_at,
  };
  const maxBytes = () => cfg.maxUploadMb * MiB;
  const tooBig = () => new HttpError(413, `File exceeds MAX_UPLOAD_MB (${cfg.maxUploadMb} MB)`);
  const reader = (key, total) => (pos, len) => storage.read(key, pos, Math.max(0, Math.min(len, total - pos)));

  /** Probe dimensions/duration and (Node + ffmpeg) make a poster; insert the media row. */
  async function finalize({ id, key, filename, mime, size, originalName }) {
    const kind = mime.startsWith('video/') ? 'video' : 'image';
    let info = { width: null, height: null, duration: null };
    if (kind === 'image') info = { ...imageSize(await storage.read(key, 0, Math.min(size, 512 * 1024)), mime), duration: null };
    else {
      info = await probeMp4(reader(key, size), size);
      const local = storage.localPath?.(key);
      if ((!info.width || !info.duration) && cfg.ffprobePath && local && hooks.ffprobe) info = (await hooks.ffprobe(cfg.ffprobePath, local)) || info;
    }
    let poster = null;
    const local = storage.localPath?.(key);
    if (kind === 'video' && cfg.ffmpegPath && local && hooks.makePoster) {
      const pname = `${id}.poster.jpg`;
      if (await hooks.makePoster(cfg.ffmpegPath, local, storage.localPath(pname))) poster = pname;
    }
    const row = {
      id, token: randomToken(32), filename, original_name: String(originalName || 'upload').slice(0, 200), mime, kind, size,
      width: info.width, height: info.height, duration: info.duration, poster, created_at: Date.now(), storage_key: key === filename ? null : key,
    };
    await db.run('INSERT INTO media(id, workspace_id, token, filename, original_name, mime, kind, size, width, height, duration, poster, created_at, storage_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      row.id, W(), row.token, row.filename, row.original_name, row.mime, row.kind, row.size, row.width, row.height, row.duration, row.poster, row.created_at, row.storage_key);
    return row;
  }

  const uploadSecret = () => `${cfg.tokenEncKey}:upload-parts`;
  const partToken = (id) => hmacHex(uploadSecret(), id);
  const presignMode = () => storage.kind === 'r2' && !!(cfg.r2.accessKeyId && cfg.r2.secretAccessKey && cfg.r2.bucket && (cfg.r2.accountId || cfg.r2.endpoint));
  const s3Url = (key) => `${cfg.r2.endpoint || `https://${cfg.r2.accountId}.r2.cloudflarestorage.com`}/${cfg.r2.bucket}/${key}`;

  async function partList(u, from = 1, count = 100) {
    const out = [];
    const tok = u.mode === 'proxy' ? await partToken(u.id) : null;
    const last = Math.min(u.part_count, from + count - 1);
    for (let n = from; n <= last; n++) {
      const size = n < u.part_count ? u.part_size : u.declared_size - u.part_size * (u.part_count - 1);
      const url = u.mode === 'presigned'
        ? await presignUrl({ method: 'PUT', url: s3Url(u.storage_key), accessKeyId: cfg.r2.accessKeyId, secretAccessKey: cfg.r2.secretAccessKey, expires: Math.max(60, Math.floor((u.expires_at - Date.now()) / 1000)), query: { partNumber: String(n), uploadId: u.multipart_id } })
        : `${cfg.publicUrl}/api/v1/media/uploads/${u.id}/parts/${n}?token=${tok}`;
      out.push({ part_number: n, size, method: 'PUT', url });
    }
    return out;
  }

  const uploadView = async (u, from = 1) => ({
    upload_id: u.id, mode: u.mode, state: u.state, size: u.declared_size, part_size: u.part_size, part_count: u.part_count, expires_at: u.expires_at,
    parts: u.state === 'open' ? await partList(u, from) : [],
    complete: { method: 'POST', path: `/api/v1/media/uploads/${u.id}/complete`, body: { parts: [{ part_number: 1, etag: '<ETag of part 1>' }] } },
    instructions: u.mode === 'presigned'
      ? 'PUT each byte range to its part URL (direct to Cloudflare R2), keep the ETag response header of every part, then POST the list to complete.'
      : 'PUT each byte range to its part URL, keep the "etag" from each JSON response, then POST the list to complete.',
  });

  async function getOpenUpload(id) {
    const u = await db.get('SELECT * FROM uploads WHERE id = ? AND workspace_id = ?', String(id || ''), W());
    if (!u) throw new HttpError(404, 'Upload session not found.');
    if (u.state !== 'open') throw new HttpError(409, `Upload session is ${u.state}.`);
    if (u.expires_at < Date.now()) throw new HttpError(410, 'Upload session expired; start a new upload.');
    return u;
  }

  const api = {
    key: keyOf,
    view,
    localPath: (m) => storage.localPath?.(keyOf(m)) || null,
    publicUrl: (m) => `${cfg.publicUrl}/m/${m.token}/${m.filename}`,
    get: (id) => db.get('SELECT * FROM media WHERE id = ? AND workspace_id = ?', String(id ?? ''), W()),
    /** Rows for ids in the given order (missing ids skipped). One query. */
    async getMany(ids) {
      const list = (ids || []).map(String);
      if (!list.length) return [];
      const rows = await db.all(`SELECT * FROM media WHERE workspace_id = ? AND id IN (${list.map(() => '?').join(',')})`, W(), ...list);
      const by = new Map(rows.map((r) => [r.id, r]));
      return list.map((i) => by.get(i)).filter(Boolean);
    },
    list: async (limit = 100) => (await db.all('SELECT * FROM media WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?', W(), limit)).map(view),
    rows: (limit = 100) => db.all('SELECT * FROM media WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?', W(), limit),
    size: (m) => m.size,
    /** Web ReadableStream of bytes [start, end] (inclusive) — used for YouTube chunk uploads. */
    async open(m, start = 0, end = m.size - 1) {
      const r = await storage.get(keyOf(m), { offset: start, length: end - start + 1 });
      if (!r) throw new Error(`Media file ${m.filename} is missing from storage`);
      return r.body;
    },

    /**
     * Store one streamed upload. `body` is a web ReadableStream or a Uint8Array.
     * @param {{size?:number}} [opts] declared length (Content-Length) when known
     */
    async save(body, originalName = 'upload', { size: declared } = {}) {
      W();
      if (typeof declared === 'number' && declared > maxBytes()) throw tooBig();
      const stream = body instanceof Uint8Array ? new ReadableStream({ start(c) { if (body.length) c.enqueue(body); c.close(); } }) : body;
      if (!stream) throw new HttpError(400, 'Empty file');
      const pk = await peek(stream, HEAD_BYTES);
      if (!pk.head.length) { pk.reader.cancel().catch(() => {}); throw new HttpError(400, 'Empty file'); }
      const mime = sniffMime(pk.head);
      if (!mime || !EXT_BY_MIME[mime]) {
        pk.reader.cancel().catch(() => {});
        throw new HttpError(415, 'Unsupported file type. Use JPEG, PNG, GIF, WebP, MP4 or MOV.');
      }
      const id = uid();
      const filename = `${id}.${EXT_BY_MIME[mime]}`;
      let size;
      try {
        ({ size } = await storage.put(filename, rejoin(pk, maxBytes(), tooBig), { size: typeof declared === 'number' ? declared : undefined }));
      } catch (e) {
        await storage.delete(filename).catch(() => {});
        throw e instanceof HttpError ? e : new HttpError(400, `Upload failed: ${e.message}`);
      }
      if (size > maxBytes()) { await storage.delete(filename).catch(() => {}); throw tooBig(); }
      try {
        return await finalize({ id, key: filename, filename, mime, size, originalName });
      } catch (e) {
        await storage.delete(filename).catch(() => {});
        throw e;
      }
    },

    // ---- multipart upload sessions -------------------------------------------------------
    async createUpload({ filename = 'upload', size, principal = null } = {}) {
      size = Number(size);
      if (!(size > 0)) throw new HttpError(400, 'size (bytes) is required and must be > 0.');
      if (size > maxBytes()) throw tooBig();
      W();
      const partSize = Math.max(5 * MiB, Math.round(cfg.upload.partSizeMb * MiB));
      const partCount = Math.ceil(size / partSize);
      if (partCount > 10000) throw new HttpError(400, 'Too many parts; raise UPLOAD_PART_MB.');
      const id = uid();
      const key = `uploads/${id}`;
      const multipartId = await storage.mpCreate(key);
      const now = Date.now();
      const u = { id, storage_key: key, multipart_id: multipartId, original_name: String(filename).slice(0, 200), declared_size: size, part_size: partSize, part_count: partCount, mode: presignMode() ? 'presigned' : 'proxy', state: 'open', created_by: principal?.name || null, created_at: now, expires_at: now + cfg.upload.sessionHours * 3600000 };
      await db.run('INSERT INTO uploads(id, workspace_id, storage_key, multipart_id, original_name, declared_size, part_size, part_count, mode, state, created_by, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        u.id, ws, u.storage_key, u.multipart_id, u.original_name, u.declared_size, u.part_size, u.part_count, u.mode, u.state, u.created_by, u.created_at, u.expires_at);
      return uploadView(u);
    },

    async getUpload(id, { from = 1 } = {}) {
      const u = await db.get('SELECT * FROM uploads WHERE id = ? AND workspace_id = ?', String(id || ''), W());
      if (!u) throw new HttpError(404, 'Upload session not found.');
      return uploadView(u, Number(from) || 1);
    },

    /** Proxy mode: store one part sent through the app. */
    async putPart(id, n, token, body, size) {
      // Authorized by the per-session HMAC token in the URL (like a presigned URL), not by a workspace.
      const u = await db.get('SELECT * FROM uploads WHERE id = ? /* ws:system */', String(id || ''));
      if (!u || !token || !safeEqual(String(token), await partToken(u.id))) throw new HttpError(u ? 403 : 404, u ? 'Invalid upload part token.' : 'Upload session not found.');
      if (u.state !== 'open') throw new HttpError(409, `Upload session is ${u.state}.`);
      if (u.expires_at < Date.now()) throw new HttpError(410, 'Upload session expired; start a new upload.');
      n = Number(n);
      if (!Number.isInteger(n) || n < 1 || n > u.part_count) throw new HttpError(400, `Part number must be 1..${u.part_count}.`);
      const expected = n < u.part_count ? u.part_size : u.declared_size - u.part_size * (u.part_count - 1);
      if (typeof size === 'number' && size !== expected) throw new HttpError(400, `Part ${n} must be exactly ${expected} bytes (got ${size}).`);
      if (!body) throw new HttpError(400, 'Empty part body.');
      const r = await storage.mpPart(u.storage_key, u.multipart_id, n, body, expected);
      return { part_number: n, etag: r.etag, size: expected };
    },

    async completeUpload(id, parts) {
      const u = await getOpenUpload(id);
      const list = (Array.isArray(parts) ? parts : []).map((p) => ({ partNumber: Number(p.part_number ?? p.partNumber), etag: String(p.etag || '') }));
      if (list.length !== u.part_count || list.some((p) => !p.etag || !(p.partNumber >= 1))) throw new HttpError(400, `Send all ${u.part_count} parts as [{ "part_number": n, "etag": "..." }].`);
      let size;
      try {
        ({ size } = await storage.mpComplete(u.storage_key, u.multipart_id, list));
      } catch (e) {
        throw new HttpError(400, `Could not complete the upload: ${e.message}`);
      }
      const fail = async (err) => {
        await storage.delete(u.storage_key).catch(() => {});
        await db.run("UPDATE uploads SET state='aborted' WHERE id=? AND workspace_id=?", u.id, ws);
        throw err;
      };
      if (size > maxBytes()) return fail(tooBig());
      if (size !== u.declared_size) return fail(new HttpError(400, `Uploaded ${size} bytes but the session declared ${u.declared_size}.`));
      const mime = sniffMime(await storage.read(u.storage_key, 0, Math.min(HEAD_BYTES, size)));
      if (!mime || !EXT_BY_MIME[mime]) return fail(new HttpError(415, 'Unsupported file type. Use JPEG, PNG, GIF, WebP, MP4 or MOV.'));
      const filename = `${u.id}.${EXT_BY_MIME[mime]}`;
      let key = u.storage_key;
      if (storage.rename) { await storage.rename(key, filename); key = filename; }
      const row = await finalize({ id: u.id, key, filename, mime, size, originalName: u.original_name });
      await db.run("UPDATE uploads SET state='completed' WHERE id=? AND workspace_id=?", u.id, ws);
      return row;
    },

    async abortUpload(id) {
      const u = await db.get('SELECT * FROM uploads WHERE id = ? AND workspace_id = ?', String(id || ''), W());
      if (!u) throw new HttpError(404, 'Upload session not found.');
      if (u.state === 'open') await storage.mpAbort(u.storage_key, u.multipart_id);
      await db.run("UPDATE uploads SET state='aborted' WHERE id=? AND workspace_id=? AND state='open'", u.id, ws);
      return true;
    },

    /** Abort expired sessions (maintenance). */
    async cleanupUploads(limit = 20) {
      const rows = await db.all("SELECT * FROM uploads WHERE state = 'open' AND expires_at < ? LIMIT ? /* ws:system */", Date.now(), limit);
      for (const u of rows) {
        await storage.mpAbort(u.storage_key, u.multipart_id).catch(() => {});
        await db.run("UPDATE uploads SET state='aborted' WHERE id=? /* ws:system */", u.id);
      }
      await db.run("DELETE FROM uploads WHERE state <> 'open' AND created_at < ? /* ws:system */", Date.now() - 7 * 86400000);
      return rows.length;
    },

    /**
     * Store a poster frame (JPEG) for a video that has none (Workers has no ffmpeg; the browser grabs a
     * frame at upload time or when it first renders the video). Refuses to replace an existing poster
     * unless replace=true.
     */
    async setPoster(id, bytes, { replace = false } = {}) {
      const m = await db.get('SELECT * FROM media WHERE id = ? AND workspace_id = ?', String(id ?? ''), W());
      if (!m) throw new HttpError(404, 'Media not found.');
      if (m.kind !== 'video') throw new HttpError(400, 'Only videos have a poster frame.');
      if (m.poster && !replace) return m;
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
      if (b.length < 100 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) throw new HttpError(415, 'Poster must be a JPEG image.');
      if (b.length > 2 * MiB) throw new HttpError(413, 'Poster must be at most 2 MB.');
      const info = imageSize(b, 'image/jpeg');
      if (!info?.width || !info?.height) throw new HttpError(400, 'Could not read the poster image size.');
      const pname = `${m.id}.poster.jpg`;
      await storage.put(pname, new ReadableStream({ start(c) { c.enqueue(b); c.close(); } }), { size: b.length });
      await db.run('UPDATE media SET poster = ? WHERE id = ? AND workspace_id = ?', pname, m.id, ws);
      return { ...m, poster: pname };
    },

    async remove(id) {
      const m = await db.get('SELECT * FROM media WHERE id = ? AND workspace_id = ?', String(id ?? ''), W());
      if (!m) return false;
      await db.run('DELETE FROM media WHERE id = ? AND workspace_id = ?', m.id, ws);
      await storage.delete(keyOf(m)).catch(() => {});
      if (m.poster) await storage.delete(m.poster).catch(() => {});
      return true;
    },

    /** Public media endpoint with Range support (Meta and Google fetchers use ranges). Returns a Response. */
    async serve(request, token, name) {
      // Public by unguessable per-file token (Meta/Google fetch these without a session).
      const m = await db.get('SELECT * FROM media WHERE token = ? /* ws:system */', String(token || ''));
      if (!m || (name !== m.filename && name !== m.poster)) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      const isPoster = name === m.poster;
      const key = isPoster ? m.poster : keyOf(m);
      const st = isPoster || storage.kind === 'fs' ? await storage.head(key) : { size: m.size };
      if (!st) return new Response(null, { status: 404 });
      const size = st.size;
      const headers = {
        'content-type': isPoster ? 'image/jpeg' : m.mime, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff', 'content-disposition': 'inline',
      };
      const head = request.method === 'HEAD';
      const rh = request.headers.get('range');
      const range = rh && /^bytes=(\d*)-(\d*)$/.exec(rh);
      if (range) {
        let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
        let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1;
        if (range[1] === '') end = size - 1;
        if (start < 0) start = 0;
        if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        end = Math.min(end, size - 1);
        const h = { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) };
        if (head) return new Response(null, { status: 206, headers: h });
        const r = await storage.get(key, { offset: start, length: end - start + 1 });
        if (!r) return new Response(null, { status: 404 });
        return new Response(r.body, { status: 206, headers: h });
      }
      const h = { ...headers, 'content-length': String(size) };
      if (head) return new Response(null, { status: 200, headers: h });
      const r = await storage.get(key);
      if (!r) return new Response(null, { status: 404 });
      return new Response(r.body, { status: 200, headers: h });
    },
  };
  return api;
}
