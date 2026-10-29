// Email for alerts. Portable (no node:*): picks a transport from the config, builds RFC 5322 / MIME
// messages and renders the plain text + simple HTML templates. Transports:
//   smtp        Node only: SMTP_HOST/PORT/USER/PASS/FROM through src/node/smtp.js (runtime.smtpSend)
//   resend      RESEND_API_KEY + EMAIL_FROM over HTTPS (Node and Workers)
//   cloudflare  Workers send_email binding (runtime.sendEmailBinding) + EMAIL_FROM
// Nothing configured → alerts stay in-app only.
import { uid } from './crypto.js';

const CRLF = '\r\n';
const enc = new TextEncoder();
const ADDR_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/** "Name <a@b.c>" or "a@b.c" → a@b.c (throws on header injection or junk). */
export function addressOf(s) {
  const v = String(s || '').trim();
  if (/[\r\n]/.test(v)) throw new Error('Email addresses cannot contain line breaks.');
  const m = /<([^<>]+)>\s*$/.exec(v);
  const a = (m ? m[1] : v).trim();
  if (!ADDR_RE.test(a)) throw new Error(`Not an email address: "${v}"`);
  return a;
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64Lines = (str) => b64(enc.encode(str)).replace(/.{1,76}/g, (l) => `${l}${CRLF}`);
/** RFC 2047 encoded-word for non-ASCII header text. */
export const headerText = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(enc.encode(s))}?=`);
function fromHeader(from) {
  const v = String(from).trim();
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(v);
  if (!m || !m[1]) return addressOf(v);
  const name = m[1].replace(/^"|"$/g, '');
  return `${/^[\w .-]*$/.test(name) ? `"${name}"` : headerText(name)} <${addressOf(m[2])}>`;
}

/** A complete multipart/alternative message (CRLF line endings; bodies base64, so no bare dots or long lines). */
export function buildMime({ from, to, subject, text, html, date = new Date(), messageId = null }) {
  const domain = addressOf(from).split('@')[1];
  const boundary = `pl-${uid()}`;
  const head = [
    `From: ${fromHeader(from)}`,
    `To: ${addressOf(to)}`,
    `Subject: ${headerText(String(subject).replace(/[\r\n]+/g, ' '))}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId || uid()}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', b64Lines(body)].join(CRLF);
  return `${head.join(CRLF)}${CRLF}${CRLF}${part('text/plain', text)}${CRLF}${part('text/html', html)}${CRLF}--${boundary}--${CRLF}`;
}

export function emailConfig(E) {
  return {
    smtp: { host: E('SMTP_HOST'), port: Number(E('SMTP_PORT')) || 587, user: E('SMTP_USER'), pass: E('SMTP_PASS'), from: E('SMTP_FROM') || E('EMAIL_FROM'),
      secure: E('SMTP_SECURE'), // '' = auto (465 → implicit TLS, otherwise STARTTLS when offered), '1' implicit TLS, '0' never implicit
      rejectUnauthorized: E('SMTP_TLS_REJECT_UNAUTHORIZED') !== '0', timeoutMs: Number(E('SMTP_TIMEOUT_MS')) || 20000,
      allowPlaintextAuth: E('SMTP_ALLOW_PLAINTEXT_AUTH') === '1' },
    resend: { key: E('RESEND_API_KEY'), url: (E('RESEND_API_URL') || 'https://api.resend.com').replace(/\/+$/, '') },
    from: E('EMAIL_FROM') || E('SMTP_FROM'),
    adminEmail: E('ADMIN_EMAIL'), // password mode has no signed-in email: alerts for the administrator go here
  };
}

/** Pick the configured transport. runtime: { smtpSend?(opts), sendEmailBinding?(from, to, raw) }. */
export function createMailer(cfg, runtime = {}) {
  const c = cfg.email || {};
  const kind = () => {
    if (c.smtp?.host && c.smtp.from && runtime.smtpSend) return 'smtp';
    if (c.resend?.key && c.from) return 'resend';
    if (runtime.sendEmailBinding && c.from) return 'cloudflare';
    return null;
  };
  const LABEL = { smtp: 'SMTP', resend: 'Resend', cloudflare: 'Cloudflare Email' };
  return {
    status() {
      const k = kind();
      return k ? { configured: true, transport: k, transport_label: LABEL[k], from: k === 'smtp' ? c.smtp.from : c.from, server: k === 'smtp' ? `${c.smtp.host}:${c.smtp.port}` : null }
        : { configured: false, transport: null, transport_label: null, from: null, server: null };
    },
    async send({ to, subject, text, html }) {
      const k = kind();
      if (!k) throw new Error('Email is not configured on this server.');
      const rcpt = addressOf(to);
      if (k === 'resend') {
        const r = await fetch(`${c.resend.url}/emails`, {
          method: 'POST', signal: AbortSignal.timeout(15000),
          headers: { authorization: `Bearer ${c.resend.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: c.from, to: [rcpt], subject, text, html }),
        });
        const body = await r.text();
        if (!r.ok) throw new Error(`Resend ${r.status}: ${body.slice(0, 200)}`);
        let id = null; try { id = JSON.parse(body).id || null; } catch {}
        return { transport: k, id };
      }
      const from = k === 'smtp' ? c.smtp.from : c.from;
      const raw = buildMime({ from, to: rcpt, subject, text, html });
      if (k === 'smtp') { await runtime.smtpSend({ ...c.smtp, from: addressOf(from), to: rcpt, raw }); return { transport: k }; }
      await runtime.sendEmailBinding(addressOf(from), rcpt, raw);
      return { transport: k };
    },
  };
}

// ---------------------------------------------------------------- templates
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
export const absLink = (publicUrl, link) => (link ? `${String(publicUrl || '').replace(/\/+$/, '')}/${String(link).replace(/^\/+/, '')}` : String(publicUrl || ''));

/**
 * One email for a batch of notifications of one user.
 * items: [{kind, title, body, link, created_at}]
 */
export function renderEmail(items, { publicUrl, when = (ms) => new Date(ms).toISOString() }) {
  const one = items.length === 1;
  const failed = items.filter((i) => i.kind === 'post_failed').length;
  const subject = one ? `postlite: ${items[0].title}`
    : failed ? `postlite: ${failed} post${failed > 1 ? 's' : ''} failed${items.length > failed ? ` and ${items.length - failed} more alert${items.length - failed > 1 ? 's' : ''}` : ''}`
      : `postlite: ${items.length} alerts`;
  const settings = absLink(publicUrl, '#/settings/notifications');
  const text = [
    ...items.map((i) => [i.title, i.body, i.link ? `Open: ${absLink(publicUrl, i.link)}` : null, when(i.created_at)].filter(Boolean).join('\n')),
    `--\nChange which alerts you get: ${settings}`,
  ].join('\n\n');
  const row = (i) => `<tr><td style="padding:14px 0;border-top:1px solid #e5e5e5">
<div style="font-weight:600;color:#111">${esc(i.title)}</div>
${i.body ? `<div style="color:#444;white-space:pre-line;margin-top:4px">${esc(i.body)}</div>` : ''}
<div style="margin-top:6px;color:#777;font-size:12px">${esc(when(i.created_at))}${i.link ? ` · <a href="${esc(absLink(publicUrl, i.link))}" style="color:#3b5bdb">Open in postlite</a>` : ''}</div>
</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#fafafa;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:8px 20px">
<tr><td style="padding:12px 0;font-weight:600">postlite</td></tr>
${items.map(row).join('\n')}
<tr><td style="padding:14px 0;border-top:1px solid #e5e5e5;color:#777;font-size:12px"><a href="${esc(settings)}" style="color:#777">Notification settings</a></td></tr>
</table></body></html>`;
  return { subject, text, html };
}
