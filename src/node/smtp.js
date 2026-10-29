// Minimal SMTP client (RFC 5321) over node:net / node:tls, no dependencies.
//   - port 465 (or SMTP_SECURE=1): implicit TLS; otherwise plain TCP + STARTTLS when the server offers it
//   - AUTH PLAIN (preferred) or AUTH LOGIN; credentials are never sent without TLS unless
//     SMTP_ALLOW_PLAINTEXT_AUTH=1 (e.g. a relay on localhost)
//   - multi-line replies, dot-stuffing, CRLF normalisation, one timeout for every reply
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';

/** Normalise line endings to CRLF and escape lines starting with "." (RFC 5321 §4.5.2). */
export function dotStuff(raw) {
  const s = String(raw).replace(/\r?\n|\r/g, '\r\n');
  return s.replace(/(^|\r\n)\./g, '$1..');
}

class SmtpError extends Error {
  constructor(message, code = null) { super(message); this.code = code; }
}

/**
 * Send one message. opts: { host, port, secure, user, pass, from, to, raw, timeoutMs, rejectUnauthorized,
 * allowPlaintextAuth, name }. Resolves { code, message } of the final reply to DATA.
 */
export async function smtpSend(opts) {
  const { host, port = 587, user = '', pass = '', from, to, raw, timeoutMs = 20000, rejectUnauthorized = true, allowPlaintextAuth = false } = opts;
  if (!host) throw new SmtpError('SMTP_HOST is not set.');
  for (const a of [from, to]) if (/[\r\n<>]/.test(String(a))) throw new SmtpError('Invalid envelope address.');
  const implicit = opts.secure === '1' || opts.secure === true || (opts.secure !== '0' && opts.secure !== false && Number(port) === 465);
  const name = opts.name || os.hostname() || 'localhost';

  let sock;
  let buf = '';
  let lines = [];
  let waiter = null;
  let failed = null;
  const fail = (e) => { if (failed) return; failed = e; if (waiter) { const w = waiter; waiter = null; w.reject(e); } };
  const onData = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) { // last line of a (possibly multi-line) reply
        const reply = { code: Number(line.slice(0, 3)), lines: lines.map((l) => l.slice(4)), text: lines.join('\n') };
        lines = [];
        if (waiter) { const w = waiter; waiter = null; w.resolve(reply); }
      }
    }
  };
  const attach = (s) => {
    s.setTimeout(timeoutMs, () => { fail(new SmtpError(`SMTP timeout after ${timeoutMs} ms talking to ${host}:${port}`)); s.destroy(); });
    s.on('data', onData);
    s.on('error', (e) => fail(new SmtpError(`SMTP connection error (${host}:${port}): ${e.message}`)));
    s.on('close', () => fail(new SmtpError(`SMTP connection to ${host}:${port} closed unexpectedly`)));
  };
  const read = () => new Promise((resolve, reject) => {
    if (failed) return reject(failed);
    waiter = { resolve, reject };
  });
  const expect = async (codes, what) => {
    const r = await read();
    if (!codes.includes(r.code)) throw new SmtpError(`SMTP ${what} failed: ${r.text.slice(0, 300)}`, r.code);
    return r;
  };
  const cmd = (line, codes, what = line.split(' ')[0]) => { sock.write(`${line}\r\n`); return expect(codes, what); };

  let connTimer = null;
  const connected = new Promise((resolve, reject) => {
    const done = () => resolve();
    sock = implicit
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized }, done)
      : net.connect({ host, port }, done);
    sock.once('error', reject);
    connTimer = setTimeout(() => { reject(new SmtpError(`SMTP connect timeout (${host}:${port})`)); sock.destroy(); }, timeoutMs);
  });
  try {
    await connected;
    clearTimeout(connTimer);
    attach(sock);
    let secure = implicit;
    await expect([220], 'greeting');
    let ehlo = await cmd(`EHLO ${name}`, [250], 'EHLO');
    const has = (r, ext) => r.lines.some((l) => l.toUpperCase().startsWith(ext));
    if (!secure && has(ehlo, 'STARTTLS')) {
      await cmd('STARTTLS', [220]);
      const plain = sock;
      plain.removeListener('data', onData);
      plain.removeAllListeners('close');
      plain.removeAllListeners('error');
      plain.setTimeout(0);
      plain.on('error', () => {});
      sock = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host, rejectUnauthorized }, () => resolve(s));
        s.once('error', (e) => reject(new SmtpError(`STARTTLS failed: ${e.message}`)));
      });
      attach(sock);
      secure = true;
      ehlo = await cmd(`EHLO ${name}`, [250], 'EHLO');
    }
    if (user) {
      if (!secure && !allowPlaintextAuth) throw new SmtpError(`${host}:${port} did not offer TLS; refusing to send the SMTP password in clear text (use port 465/587 with TLS, or SMTP_ALLOW_PLAINTEXT_AUTH=1 for a local relay).`);
      const auth = ehlo.lines.find((l) => /^AUTH[ =]/i.test(l)) || '';
      const mechs = auth.toUpperCase().split(/[ =]/).slice(1);
      if (mechs.includes('PLAIN') || !mechs.includes('LOGIN')) {
        await cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')}`, [235], 'AUTH PLAIN');
      } else {
        await cmd('AUTH LOGIN', [334], 'AUTH LOGIN');
        await cmd(Buffer.from(user, 'utf8').toString('base64'), [334], 'AUTH LOGIN (user)');
        await cmd(Buffer.from(pass, 'utf8').toString('base64'), [235], 'AUTH LOGIN (password)');
      }
    }
    await cmd(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');
    await cmd(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
    await cmd('DATA', [354]);
    let body = dotStuff(raw);
    if (!body.endsWith('\r\n')) body += '\r\n';
    sock.write(`${body}.\r\n`);
    const r = await expect([250], 'DATA');
    sock.write('QUIT\r\n');
    return { code: r.code, message: r.text };
  } finally {
    clearTimeout(connTimer);
    setTimeout(() => sock?.destroy(), 200).unref?.();
  }
}
