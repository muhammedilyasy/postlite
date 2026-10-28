// MCP over stdio (Node only): local server bound to a DB, or a bridge to a remote postlite
// (Node or Cloudflare Workers) over Streamable HTTP. Local file uploads use resumable upload sessions
// when talking to a remote instance, so big videos work against Workers too.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createMcp, PATH_TOOL, rpcError } from '../mcp.js';
import { HttpError } from '../errors.js';
import { uploadFileRemote } from './remote.js';
import { scopeFor } from '../api/operations.js';

/** upload_media_from_path for a local (stdio) server. */
export async function uploadFromPath(rootCore, args, principal, via) {
  const core = await scopeFor(rootCore, principal);
  const p = String(args?.path || '');
  if (!path.isAbsolute(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw new HttpError(400, `File not found: "${p}". Pass an absolute path to an existing file.`);
  const m = await core.media.save(Readable.toWeb(fs.createReadStream(p)), args.filename || path.basename(p), { size: fs.statSync(p).size });
  await core.audit.record({ principal, via, operation: PATH_TOOL.name, target: m.id, status: 200, detail: { path: p } });
  return { media: { ...core.media.view(m), public_url: core.media.publicUrl(m) } };
}

/** Run MCP over stdio (newline-delimited JSON-RPC). */
export function runStdio(core, principal, { input = process.stdin, output = process.stdout, version } = {}) {
  const mcp = createMcp(core, { via: 'mcp-stdio', stdio: true, version, uploadFromPath });
  let buf = '';
  let pending = Promise.resolve();
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      pending = pending.then(async () => {
        let msg;
        try { msg = JSON.parse(line); } catch { output.write(JSON.stringify(rpcError(null, -32700, 'Parse error')) + '\n'); return; }
        const res = await mcp.handleAny(msg, principal);
        if (res) output.write(JSON.stringify(res) + '\n');
      });
    }
  });
  return new Promise((resolve) => input.on('end', () => pending.then(resolve)));
}

/** stdio → remote Streamable HTTP bridge (for laptops talking to a postlite server). */
export function runBridge({ url, key, input = process.stdin, output = process.stdout }) {
  let buf = '';
  let session = null;
  let pending = Promise.resolve();
  const endpoint = `${url.replace(/\/+$/, '')}/mcp`;
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      pending = pending.then(async () => {
        let msg;
        try { msg = JSON.parse(line); } catch { output.write(JSON.stringify(rpcError(null, -32700, 'Parse error')) + '\n'); return; }
        // Local file uploads are handled here and sent as a raw REST upload.
        if (msg.method === 'tools/call' && msg.params?.name === PATH_TOOL.name) {
          const p = String(msg.params.arguments?.path || '');
          try {
            if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
            let j, ok = true;
            try { j = await uploadFileRemote({ url, key, file: p, filename: msg.params.arguments?.filename || path.basename(p) }); } catch (e) { ok = false; j = e.json || { error: { message: e.message } }; }
            output.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(j, null, 2) }], structuredContent: j, isError: !ok } }) + '\n');
          } catch (e) {
            output.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } }) + '\n');
          }
          return;
        }
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
            body: JSON.stringify(msg),
          });
          session = res.headers.get('mcp-session-id') || session;
          const text = await res.text();
          if (!text) return;
          let parsed;
          try { parsed = JSON.parse(text); } catch { parsed = rpcError(msg.id, -32603, `Bad response from server (HTTP ${res.status})`); }
          if (msg.method === 'tools/list' && parsed.result?.tools) parsed.result.tools.push(PATH_TOOL);
          output.write(JSON.stringify(parsed) + '\n');
        } catch (e) {
          if (msg.id !== undefined) output.write(JSON.stringify(rpcError(msg.id, -32603, `Cannot reach postlite at ${url}: ${e.cause?.code || e.message}`)) + '\n');
        }
      });
    }
  });
  return new Promise((resolve) => input.on('end', () => pending.then(resolve)));
}
