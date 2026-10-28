// Portable byte helpers (Node and Cloudflare Workers): no Buffer, only Uint8Array/TextEncoder/atob/btoa.
const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s) => enc.encode(String(s));
export const fromUtf8 = (b) => dec.decode(b);

export function concatBytes(list) {
  let n = 0;
  for (const b of list) n += b.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const b of list) { out.set(b, o); o += b.length; }
  return out;
}

export function toHex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function toBase64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

export const toBase64Url = (bytes) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const B64 = new Int16Array(128).fill(-1);
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => { B64[c.charCodeAt(0)] = i; });
B64['-'.charCodeAt(0)] = 62;
B64['_'.charCodeAt(0)] = 63;

/**
 * Lenient base64/base64url decoder with the same semantics as Node's Buffer.from(s, 'base64'):
 * both alphabets accepted, unknown characters skipped, decoding stops at the first '='.
 */
export function fromBase64(str) {
  const s = String(str);
  const out = new Uint8Array(Math.ceil((s.length * 3) / 4));
  let acc = 0, bits = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) break; // '='
    const v = c < 128 ? B64[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

export const fromBase64Url = fromBase64;

/** Big-endian / little-endian readers over a Uint8Array (DataView without allocation churn). */
export const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
export const latin1 = (b, start, end) => {
  let s = '';
  for (let i = start; i < end && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};
