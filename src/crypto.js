// Crypto helpers: password hashing (scrypt), token encryption (AES-256-GCM), random ids.
import crypto from 'node:crypto';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const uid = () => crypto.randomUUID();

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, N, r, p, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, got);
}

/** Derive a 32-byte key from TOKEN_ENC_KEY (hex/base64 32 bytes used directly, anything else via HKDF). */
export function deriveKey(material) {
  if (!material || String(material).length < 16) {
    throw new Error('TOKEN_ENC_KEY must be set (at least 16 chars; recommended: `openssl rand -base64 32`)');
  }
  const s = String(material);
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'base64');
  if (b.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(s)) return b;
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(s), Buffer.from('postlite'), Buffer.from('token-enc'), 32));
}

export function makeCipher(material) {
  const key = deriveKey(material);
  return {
    encrypt(plain) {
      if (plain === null || plain === undefined || plain === '') return null;
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
    },
    decrypt(blob) {
      if (!blob) return null;
      const [v, iv, tag, ct] = String(blob).split(':');
      if (v !== 'v1') throw new Error('Unknown token encryption format');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    },
  };
}

export function pkcePair() {
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
