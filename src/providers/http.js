// Provider error model + HTTP helper with error classification.
//
// kinds:
//   transient        → retry with backoff (429, 5xx, rate limits, temporary upstream issues)
//   permanent        → fail the post, show message (bad content, policy, limits)
//   auth             → token expired/invalid: refresh if possible, else mark integration "needs reconnect"
//   disconnect       → account action required on the platform: mark "needs reconnect", fail
//   unknown_outcome  → an irreversible call got no response: never retry blindly (could double-post)

export class ProviderError extends Error {
  constructor(kind, message, { status = 0, body = '', code } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.body = typeof body === 'string' ? body.slice(0, 2000) : JSON.stringify(body).slice(0, 2000);
    this.code = code;
  }
}

export const isProviderError = (e) => e instanceof ProviderError;

/** Classify a non-2xx upstream response using a provider-specific classifier and generic fallbacks. */
export function classifyHttp(status, body, classifier) {
  const specific = classifier ? classifier(body, status) : null;
  if (specific) return specific;
  if (status === 401) return { kind: 'auth', message: 'Access token rejected (401). Please reconnect the account.' };
  if (status === 429) return { kind: 'transient', message: 'Rate limited by the platform (429).' };
  if (status >= 500) return { kind: 'transient', message: `Platform error (HTTP ${status}).` };
  let msg = '';
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message || j?.error_description || j?.message || (typeof j?.error === 'string' ? j.error : '');
  } catch {}
  return { kind: 'permanent', message: msg || `Request failed (HTTP ${status}).` };
}

/**
 * fetch wrapper.
 * @param {string} url
 * @param {object} opts  fetch options + { json, form, timeoutMs, classifier, irreversible, raw, label }
 */
export async function request(url, opts = {}) {
  const { json, form, timeoutMs = 120000, classifier, irreversible = false, raw = false, label = '', ...init } = opts;
  init.headers = { ...(init.headers || {}) };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['content-type'] = 'application/json';
    init.method = init.method || 'POST';
  } else if (form !== undefined) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== null) p.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    init.body = p;
    init.method = init.method || 'POST';
  }
  if (!init.signal) init.signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const what = label || new URL(url).pathname;
    if (irreversible) {
      throw new ProviderError('unknown_outcome', `No response from the platform while ${what} — the post may or may not have been published. Check the account before retrying.`);
    }
    throw new ProviderError('transient', `Network error during ${what}: ${e.cause?.code || e.message}`);
  }
  if (raw) return res;
  const text = await res.text();
  if (res.status >= 200 && res.status < 300) {
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { _text: text }; }
  }
  const c = classifyHttp(res.status, text, classifier);
  throw new ProviderError(c.kind, c.message, { status: res.status, body: text, code: c.code });
}

export const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.append(k, String(v));
  return p.toString();
};
