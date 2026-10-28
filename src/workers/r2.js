// R2 media storage for Cloudflare Workers (binding MEDIA). Same interface as src/node/storage.js.
// R2 put() needs a known length, so unknown-length streams go through a multipart upload.
// API: developers.cloudflare.com/r2/api/workers/workers-api-reference/
import { meter } from '../meter.js';

const MIN_PART = 5 * 1024 * 1024; // R2/S3 minimum part size (except the last part)

export function createR2Storage(bucket, { streamPartBytes = 10 * 1024 * 1024 } = {}) {
  if (!bucket || typeof bucket.put !== 'function') throw new Error('R2 binding "MEDIA" is missing. Add an r2_buckets binding named MEDIA in wrangler.jsonc.');
  const op = (n = 1) => { meter.current.used.storageOps += n; };

  /** Upload a stream of unknown length in fixed-size parts (buffers one part in memory at a time). */
  async function putChunked(key, stream) {
    op();
    const mp = await bucket.createMultipartUpload(key);
    const parts = [];
    const size = Math.max(MIN_PART, streamPartBytes);
    let buf = new Uint8Array(size);
    let fill = 0;
    let total = 0;
    const flush = async () => {
      op();
      parts.push(await mp.uploadPart(parts.length + 1, buf.subarray(0, fill)));
      total += fill;
      buf = new Uint8Array(size);
      fill = 0;
    };
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let off = 0;
        while (off < value.length) {
          const n = Math.min(size - fill, value.length - off);
          buf.set(value.subarray(off, off + n), fill);
          fill += n;
          off += n;
          if (fill === size) await flush();
        }
      }
      if (fill > 0 || !parts.length) await flush();
      op();
      await mp.complete(parts);
      return { size: total };
    } catch (e) {
      try { await mp.abort(); } catch {}
      throw e;
    }
  }

  return {
    kind: 'r2',
    localPath: null,
    async put(key, body, { size } = {}) {
      if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
        op();
        const r = await bucket.put(key, body);
        return { size: r.size };
      }
      if (typeof size === 'number' && size >= 0 && typeof FixedLengthStream === 'function') {
        const fixed = new FixedLengthStream(size);
        const pump = body.pipeTo(fixed.writable);
        op();
        const [r] = await Promise.all([bucket.put(key, fixed.readable), pump]);
        return { size: r.size };
      }
      return putChunked(key, body);
    },
    async head(key) {
      op();
      const o = await bucket.head(key);
      return o ? { size: o.size } : null;
    },
    async get(key, { offset = 0, length } = {}) {
      op();
      const o = await bucket.get(key, length === undefined && !offset ? undefined : { range: length === undefined ? { offset } : { offset, length } });
      if (!o) return null;
      // Known-length body so outgoing fetch() sends Content-Length (YouTube chunk PUTs) instead of chunked encoding.
      const n = length === undefined ? o.size - offset : Math.min(length, o.size - offset);
      if (typeof FixedLengthStream === 'function') {
        const fixed = new FixedLengthStream(n);
        o.body.pipeTo(fixed.writable).catch(() => {});
        return { size: o.size, body: fixed.readable };
      }
      return { size: o.size, body: o.body };
    },
    async read(key, offset, length) {
      op();
      const o = await bucket.get(key, { range: { offset, length } });
      if (!o) throw new Error(`Object ${key} not found`);
      return new Uint8Array(await o.arrayBuffer());
    },
    async delete(key) { op(); await bucket.delete(key); },

    // ---- multipart (upload sessions; ids are interchangeable with the S3 API) ----
    async mpCreate(key) { op(); return (await bucket.createMultipartUpload(key)).uploadId; },
    async mpPart(key, id, n, body, size) {
      op();
      let value = body;
      if (!(body instanceof Uint8Array) && typeof size === 'number' && typeof FixedLengthStream === 'function') {
        const fixed = new FixedLengthStream(size);
        body.pipeTo(fixed.writable).catch(() => {});
        value = fixed.readable;
      }
      const part = await bucket.resumeMultipartUpload(key, id).uploadPart(n, value);
      return { etag: part.etag, size };
    },
    async mpComplete(key, id, parts) {
      op();
      const o = await bucket.resumeMultipartUpload(key, id).complete(parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })));
      return { size: o.size };
    },
    async mpAbort(key, id) { op(); try { await bucket.resumeMultipartUpload(key, id).abort(); } catch {} },
  };
}
