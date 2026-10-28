// Cloudflare Zero Trust Access: verify the application token (RS256 JWT) that Access puts in the
// `Cf-Access-Jwt-Assertion` header / `CF_Authorization` cookie. No dependencies: node:crypto + fetch.
// Docs: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
import crypto from 'node:crypto';

const b64urlJson = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export class AccessError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Normalise "myteam", "myteam.cloudflareaccess.com" or "https://myteam.cloudflareaccess.com/" to a hostname. */
export function normalizeTeamDomain(v) {
  let s = String(v || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (s && !s.includes('.')) s = `${s}.cloudflareaccess.com`;
  return s;
}

export const parseEmails = (v) => String(v || '').split(/[,\s;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Fail closed: throw a clear error when access mode is selected but not fully configured. */
export function validateAuthConfig(cfg) {
  const a = cfg.auth;
  if (!['password', 'cloudflare-access'].includes(a.mode)) throw new Error(`AUTH_MODE must be "password" or "cloudflare-access" (got "${a.mode}").`);
  if (a.mode !== 'cloudflare-access') return;
  const missing = [];
  if (!a.teamDomain) missing.push('CF_ACCESS_TEAM_DOMAIN (e.g. myteam.cloudflareaccess.com)');
  if (!a.aud) missing.push('CF_ACCESS_AUD (the Application Audience tag)');
  if (!a.allowedEmails.length) missing.push('ALLOWED_EMAILS (comma-separated list)');
  if (missing.length) throw new Error(`AUTH_MODE=cloudflare-access but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set. Refusing to start. See docs/setup/cloudflare-access.md.`);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(a.teamDomain)) throw new Error(`CF_ACCESS_TEAM_DOMAIN "${a.teamDomain}" is not a hostname like myteam.cloudflareaccess.com.`);
  if (!/^[A-Za-z0-9_-]{16,}$/.test(a.aud)) throw new Error('CF_ACCESS_AUD does not look like an Application Audience tag (copy it from the Access application → Basic information).');
  const bad = a.allowedEmails.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad.length) throw new Error(`ALLOWED_EMAILS contains invalid address(es): ${bad.join(', ')}`);
}

/**
 * @param {{teamDomain:string, aud:string, allowedEmails:string[], certsUrl?:string, clockSkewSec?:number, timeoutMs?:number, cacheMs?:number, fetchImpl?:Function}} opts
 */
export function createAccessVerifier(opts) {
  const issuer = `https://${opts.teamDomain}`;
  const certsUrl = opts.certsUrl || `${issuer}/cdn-cgi/access/certs`;
  const skew = opts.clockSkewSec ?? 60;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const cacheMs = opts.cacheMs ?? 3600000;
  const minRefreshMs = opts.minRefreshMs ?? 10000; // throttle unknown-kid refreshes (forged kids can't DoS the certs URL)
  const doFetch = opts.fetchImpl || fetch;
  const allowed = new Set(opts.allowedEmails.map((e) => e.toLowerCase()));
  let keys = new Map(); // kid -> KeyObject
  let fetchedAt = 0;
  let inflight = null;

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const res = await doFetch(certsUrl, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
        if (!res.ok) throw new AccessError('jwks_unavailable', `Access certs endpoint returned HTTP ${res.status}`);
        const body = await res.json();
        const next = new Map();
        for (const jwk of body.keys || []) {
          if (jwk.kty !== 'RSA' || !jwk.kid || (jwk.use && jwk.use !== 'sig')) continue;
          try { next.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })); } catch {}
        }
        if (!next.size) throw new AccessError('jwks_unavailable', 'Access certs endpoint returned no usable RSA keys');
        keys = next;
        fetchedAt = Date.now();
      } catch (e) {
        if (e instanceof AccessError) throw e;
        throw new AccessError('jwks_unavailable', `Could not fetch Access certs (${e.name === 'TimeoutError' ? 'timeout' : e.message})`);
      } finally { inflight = null; }
    })();
    return inflight;
  }

  async function keyFor(kid) {
    if (!fetchedAt || Date.now() - fetchedAt > cacheMs) await refresh();
    if (keys.has(kid)) return keys.get(kid);
    if (Date.now() - fetchedAt >= minRefreshMs || !keys.size) await refresh(); // key rotation
    return keys.get(kid) || null;
  }

  /** Verify a token. Resolves { email, sub, exp } or throws AccessError(code). */
  async function verify(token) {
    if (!token || typeof token !== 'string') throw new AccessError('missing', 'No Cloudflare Access token');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AccessError('malformed', 'Malformed Access token');
    let header, claims;
    try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { throw new AccessError('malformed', 'Malformed Access token'); }
    if (header.alg !== 'RS256') throw new AccessError('bad_alg', `Unsupported token algorithm ${header.alg}`);
    const key = await keyFor(String(header.kid || ''));
    if (!key) throw new AccessError('unknown_kid', 'Access token signed with an unknown key');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new AccessError('bad_signature', 'Invalid Access token signature');
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(opts.aud)) throw new AccessError('bad_aud', 'Access token audience does not match CF_ACCESS_AUD');
    if (claims.iss !== issuer) throw new AccessError('bad_iss', 'Access token issuer does not match CF_ACCESS_TEAM_DOMAIN');
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw new AccessError('expired', 'Access token expired');
    if (typeof claims.nbf === 'number' && claims.nbf - skew > now) throw new AccessError('not_yet_valid', 'Access token not yet valid');
    if (typeof claims.iat === 'number' && claims.iat - skew > now) throw new AccessError('not_yet_valid', 'Access token issued in the future');
    if (claims.type !== undefined && claims.type !== 'app') throw new AccessError('bad_type', `Access token type "${claims.type}" is not an application token`);
    const email = String(claims.email || '').trim().toLowerCase();
    if (!email) throw new AccessError('no_email', 'Access token has no email claim (service tokens cannot use the web UI)');
    if (!allowed.has(email)) throw Object.assign(new AccessError('email_not_allowed', `${email} is not in ALLOWED_EMAILS`), { email });
    return { email, sub: claims.sub || null, exp: claims.exp };
  }

  return { verify, refresh, issuer, certsUrl, _keys: () => keys };
}
