// Portable crypto on WebCrypto (globalThis.crypto) — identical on Node and Cloudflare Workers.
//  * random ids/tokens, SHA-256, HMAC-SHA256
//  * AES-256-GCM token encryption, byte-compatible with the earlier node:crypto format
//      v1:<iv b64>:<tag b64>:<ciphertext b64>
//  * PBKDF2-SHA256 password hashes (portable). The Node adapter also keeps scrypt (src/node/password.js).
//  * RS256 verification for Cloudflare Access JWTs
import { utf8, fromUtf8, toHex, fromHex, toBase64, toBase64Url, fromBase64, concatBytes } from './bytes.js';

const subtle = () => globalThis.crypto.subtle;
const KEY_ERROR = 'TOKEN_ENC_KEY must be set (at least 16 chars; recommended: `openssl rand -base64 32`)';

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const randomToken = (bytes = 32) => toBase64Url(randomBytes(bytes));
export const uid = () => globalThis.crypto.randomUUID();

export async function sha256(s) {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', typeof s === 'string' ? utf8(s) : s)));
}
export async function sha256b64url(s) {
  return toBase64Url(new Uint8Array(await subtle().digest('SHA-256', utf8(s))));
}

const hmacKeys = new Map();
async function hmacKey(secret) {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = await subtle().importKey('raw', typeof secret === 'string' ? utf8(secret) : secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    if (hmacKeys.size > 100) hmacKeys.clear();
    if (typeof secret === 'string') hmacKeys.set(secret, k);
  }
  return k;
}
export async function hmacBytes(secret, msg) {
  return new Uint8Array(await subtle().sign('HMAC', await hmacKey(secret), typeof msg === 'string' ? utf8(msg) : msg));
}
export const hmacHex = async (secret, msg) => toHex(await hmacBytes(secret, msg));

/** Constant-time string comparison (leaks only the length, like crypto.timingSafeEqual guarded by a length check). */
export function safeEqual(a, b) {
  const x = utf8(String(a));
  const y = utf8(String(b));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/** Derive the 32-byte key from TOKEN_ENC_KEY exactly like the original node:crypto implementation. */
export async function deriveKeyBytes(material) {
  if (!material || String(material).length < 16) throw new Error(KEY_ERROR);
  const s = String(material);
  if (/^[0-9a-f]{64}$/i.test(s)) return fromHex(s);
  const b = fromBase64(s);
  if (b.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(s)) return b;
  const ikm = await subtle().importKey('raw', utf8(s), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: utf8('postlite'), info: utf8('token-enc') }, ikm, 256));
}

/** AES-256-GCM cipher. encrypt/decrypt are async (WebCrypto). Throws synchronously on a missing key. */
export function makeCipher(material) {
  if (!material || String(material).length < 16) throw new Error(KEY_ERROR);
  let keyP = null;
  const key = () => (keyP ||= deriveKeyBytes(material).then((raw) => subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])));
  return {
    ready: () => key().then(() => true),
    async encrypt(plain) {
      if (plain === null || plain === undefined || plain === '') return null;
      const iv = randomBytes(12);
      const out = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, await key(), utf8(String(plain))));
      return `v1:${toBase64(iv)}:${toBase64(out.subarray(out.length - 16))}:${toBase64(out.subarray(0, out.length - 16))}`;
    },
    async decrypt(blob) {
      if (!blob) return null;
      const [v, iv, tag, ct] = String(blob).split(':');
      if (v !== 'v1') throw new Error('Unknown token encryption format');
      try {
        const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(iv), tagLength: 128 }, await key(), concatBytes([fromBase64(ct), fromBase64(tag)]));
        return fromUtf8(new Uint8Array(plain));
      } catch {
        throw new Error('Unsupported state or unable to authenticate data');
      }
    },
  };
}

export async function pkcePair() {
  const verifier = randomToken(48);
  return { verifier, challenge: await sha256b64url(verifier) };
}

// ---- passwords (portable PBKDF2) ------------------------------------------------------------
// Format: pbkdf2$sha256$<iterations>$<salt b64>$<hash b64>. Workers caps PBKDF2 at 100,000 iterations.
export const PBKDF2_ITERATIONS = 100000;

async function pbkdf2(password, salt, iterations, len = 32) {
  const k = await subtle().importKey('raw', utf8(String(password)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, k, len * 8));
}

export async function hashPasswordPbkdf2(password, iterations = PBKDF2_ITERATIONS) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Verify a PBKDF2 hash. Returns null for formats this function cannot check (e.g. scrypt). */
export async function verifyPasswordPbkdf2(password, stored) {
  if (!stored || !String(stored).startsWith('pbkdf2$')) return null;
  const [, alg, it, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'sha256' || !(Number(it) > 0)) return false;
  const expected = fromBase64(hashB64);
  const got = await pbkdf2(password, fromBase64(saltB64), Number(it), expected.length);
  let d = expected.length ^ got.length;
  for (let i = 0; i < Math.min(expected.length, got.length); i++) d |= expected[i] ^ got[i];
  return d === 0;
}

// ---- RS256 (Cloudflare Access) -------------------------------------------------------------
export function importRsaJwk(jwk) {
  return subtle().importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}
export function verifyRs256(key, signingInput, sigB64url) {
  return subtle().verify('RSASSA-PKCS1-v1_5', key, fromBase64(sigB64url), utf8(signingInput));
}
