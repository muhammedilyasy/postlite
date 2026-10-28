// Remote-instance client helpers for the CLI and the MCP stdio bridge (Node only). Works against a
// Node server or a Cloudflare Workers deployment over the public REST API with an API key.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const trim = (u) => String(u || '').replace(/\/+$/, '');

async function jsonOrThrow(res) {
  const text = await res.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { error: { message: text.slice(0, 300) } }; }
  if (!res.ok) throw Object.assign(new Error(j.error?.message || `HTTP ${res.status}`), { json: j, status: res.status });
  return j;
}

/**
 * Upload a local file through a resumable multipart session (POST /api/v1/media/uploads → PUT parts →
 * complete). Parts go straight to R2 when the Worker hands out presigned URLs.
 */
export async function uploadFileRemote({ url, key, file, filename = path.basename(file), onProgress = null }) {
  const base = trim(url);
  const auth = { authorization: `Bearer ${key}` };
  const size = fs.statSync(file).size;
  let session = await jsonOrThrow(await fetch(`${base}/api/v1/media/uploads`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ filename, size }) }));
  session = session.upload || session;
  const parts = [];
  let done = 0;
  let list = session.parts;
  while (list.length) {
    for (const p of list) {
      const start = (p.part_number - 1) * session.part_size;
      const body = Readable.toWeb(fs.createReadStream(file, { start, end: start + p.size - 1, highWaterMark: 256 * 1024 }));
      const res = await fetch(p.url, { method: 'PUT', headers: { 'content-length': String(p.size), ...(p.url.startsWith(base) ? auth : {}) }, body, duplex: 'half' });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`Part ${p.part_number} failed: HTTP ${res.status} ${text.slice(0, 200)}`), { status: res.status });
      let etag = res.headers.get('etag');
      try { etag = JSON.parse(text).etag || etag; } catch {}
      parts.push({ part_number: p.part_number, etag });
      done += p.size;
      onProgress?.(done / size);
    }
    const last = list[list.length - 1].part_number;
    if (last >= session.part_count) break;
    const more = await jsonOrThrow(await fetch(`${base}/api/v1/media/uploads/${session.upload_id}?from=${last + 1}`, { headers: auth }));
    list = (more.upload || more).parts;
  }
  return jsonOrThrow(await fetch(`${base}/api/v1/media/uploads/${session.upload_id}/complete`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ parts }) }));
}
