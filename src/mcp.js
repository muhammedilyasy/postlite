// Model Context Protocol server (JSON-RPC 2.0, hand-rolled — no SDK dependency).
// Transports: Streamable HTTP (POST /mcp, JSON responses; Node and Workers) and stdio (Node only,
// src/node/mcp-stdio.js).
import { operations, opsByName, execute } from './api/operations.js';
import { HttpError } from './errors.js';

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `postlite schedules and publishes posts to YouTube, Facebook Pages and Instagram, and reports analytics.
Typical flow: whoami → list_accounts → list_platforms (rules + settings schemas) → upload media (upload_media_from_url / upload_media_base64 / upload_media_from_path in stdio mode) → validate_post → create_post (mode "schedule" with publish_at, "next_slot", or "now") → get_post to watch status.
Times: ISO-8601 with offset, epoch ms, or local "YYYY-MM-DDTHH:mm" in the server timezone (get_settings).
If your key is in approval mode, scheduled posts become "pending_approval" until a human approves; tell the user.
Errors explain what to fix (e.g. per-platform validation). Never retry a failed post whose error says it "may have been published" without checking the platform first.`;

export const PATH_TOOL = {
  name: 'upload_media_from_path',
  title: 'Upload a local file',
  description: 'Upload a file from the local filesystem of the machine running this MCP stdio server (e.g. "/home/me/videos/clip.mp4"). Only available over stdio. Returns the media id.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', description: 'Absolute path to an image or video file.' }, filename: { type: 'string' } } },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export function toolDefs({ stdio = false } = {}) {
  const tools = operations.filter((o) => o.mcp !== false).map((o) => ({
    name: o.name,
    title: o.summary,
    description: `${o.description}${o.scope ? ` (requires scope: ${o.scope})` : ''}`,
    inputSchema: o.input,
    annotations: { title: o.summary, readOnlyHint: !!o.readOnly, destructiveHint: !!o.destructive, idempotentHint: !!o.readOnly, openWorldHint: /sync|check|connect|from_url/.test(o.name) },
  }));
  if (stdio) tools.push(PATH_TOOL);
  return tools;
}

const RESOURCES = [
  { uri: 'postlite://accounts', name: 'accounts', title: 'Connected accounts', description: 'Connected accounts with status.', mimeType: 'application/json', op: 'list_accounts', args: {} },
  { uri: 'postlite://calendar/upcoming', name: 'calendar', title: 'Upcoming calendar (7 days)', description: 'Scheduled/pending/published entries for the next 7 days plus undated drafts.', mimeType: 'application/json', op: 'get_calendar', args: {} },
  { uri: 'postlite://analytics/summary', name: 'analytics-summary', title: 'Analytics summary (30 days)', description: 'Per-account totals for the last 30 days.', mimeType: 'application/json', op: 'get_analytics_overview', args: {} },
  { uri: 'postlite://platforms', name: 'platforms', title: 'Platform rules', description: 'Per-platform rules, limits and settings schemas.', mimeType: 'application/json', op: 'list_platforms', args: {} },
  { uri: 'postlite://approvals', name: 'approvals', title: 'Pending approvals', description: 'Posts awaiting human approval.', mimeType: 'application/json', op: 'list_pending_approvals', args: {} },
  { uri: 'postlite://settings', name: 'settings', title: 'Settings', description: 'Timezone and posting slots.', mimeType: 'application/json', op: 'get_settings', args: {} },
];

const PROMPTS = [
  {
    name: 'plan_week', title: 'Plan a week of posts',
    description: 'Draft a week of posts into the free posting slots.',
    arguments: [{ name: 'topic', description: 'Theme or campaign', required: true }, { name: 'accounts', description: 'Which accounts (names or "all")', required: false }],
    render: (a) => `Plan one week of social posts about: ${a.topic}.\n1. Call get_settings and list_free_slots (count 7).\n2. Call list_accounts${a.accounts ? ` and use: ${a.accounts}` : ''}, then list_platforms for the rules.\n3. For each slot write a caption that fits every target platform (respect caption limits, Instagram needs media).\n4. validate_post each post, fix errors, then create_post with mode "schedule" and publish_at = the slot time.\n5. Summarize the plan as a table (time, accounts, caption, status). Mention if posts are pending approval.`,
  },
  {
    name: 'schedule_short', title: 'Upload a video and schedule a YouTube Short',
    description: 'Upload a vertical video and schedule it as a YouTube Short (optionally also as an Instagram Reel).',
    arguments: [{ name: 'video', description: 'URL or local path of the video', required: true }, { name: 'when', description: 'When to publish (e.g. 2026-11-02T18:00 or "next slot")', required: false }],
    render: (a) => `Upload ${a.video} (upload_media_from_url for URLs, upload_media_from_path for local files). Check the returned width/height/duration: a Short must be vertical and ≤ 180 s. Find the YouTube account (list_accounts). Write a title (≤ 100 chars) and description, then validate_post with settings {"title": ..., "isShort": true, "privacy": "public"}. Create the post with ${a.when && !/next/i.test(a.when) ? `mode "schedule" and publish_at "${a.when}"` : 'mode "next_slot"'}. If an Instagram account exists, also add it as a target (single video = Reel). Report the result.`,
  },
  {
    name: 'weekly_report', title: 'Weekly analytics report',
    description: 'Summarize last week\'s performance.',
    arguments: [],
    render: () => 'Call sync_analytics, then get_analytics_overview for the last 7 days and get_top_posts (limit 5, sort views). Write a short report: follower change, views/reach, top posts with links, and 3 concrete suggestions. Mention metrics listed as unavailable.',
  },
];

export function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/**
 * Create an MCP message handler bound to a core and transport.
 * @param {object} core
 * @param {{via:'mcp-stdio'|'mcp-http', stdio?:boolean, version?:string, uploadFromPath?:Function}} opts
 *   uploadFromPath(core, args, principal) handles upload_media_from_path (stdio on Node only).
 */
export function createMcp(core, { via, stdio = false, version = '0.1.0', uploadFromPath = null }) {
  const tools = toolDefs({ stdio });

  async function callTool(name, args, principal) {
    if (name === PATH_TOOL.name && stdio && uploadFromPath) {
      if (!principal.scopes.includes('write') && !principal.scopes.includes('admin')) throw new HttpError(403, 'This API key lacks the "write" scope.');
      return uploadFromPath(core, args || {}, principal, via);
    }
    const op = opsByName[name];
    if (!op || op.mcp === false) return undefined;
    return execute(core, op, args || {}, principal, via);
  }

  async function handle(msg, principal) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid Request');
    const { id, method, params = {} } = msg;
    const isNotification = id === undefined || id === null;
    try {
      let result;
      switch (method) {
        case 'initialize': {
          const want = params.protocolVersion;
          result = {
            protocolVersion: MCP_PROTOCOL_VERSIONS.includes(want) ? want : MCP_PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false }, logging: {} },
            serverInfo: { name: 'postlite', title: 'postlite social scheduler', version },
            instructions: INSTRUCTIONS,
          };
          break;
        }
        case 'ping': result = {}; break;
        case 'logging/setLevel': result = {}; break;
        case 'tools/list': result = { tools }; break;
        case 'tools/call': {
          if (!params.name) return rpcError(id, -32602, 'Missing tool name');
          try {
            const r = await callTool(params.name, params.arguments, principal);
            if (r === undefined) return rpcError(id, -32602, `Unknown tool "${params.name}". Call tools/list.`);
            result = { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], structuredContent: r, isError: false };
          } catch (e) {
            const status = e.status || 500;
            const text = `Error ${status}: ${e.message}${e.extra?.required_scope ? `\nRequired scope: ${e.extra.required_scope}` : ''}`;
            if (status >= 500) core.log('error', `mcp tool ${params.name}: ${e.stack || e}`);
            result = { content: [{ type: 'text', text }], structuredContent: { error: { status, message: e.message, details: e.extra || null } }, isError: true };
          }
          break;
        }
        case 'resources/list':
          result = { resources: RESOURCES.map(({ op, args, ...r }) => r) };
          break;
        case 'resources/templates/list':
          result = { resourceTemplates: [
            { uriTemplate: 'postlite://posts/{post_id}', name: 'post', title: 'A post with targets and event log', mimeType: 'application/json' },
            { uriTemplate: 'postlite://analytics/accounts/{account_id}', name: 'account-analytics', title: 'Account analytics (30 days)', mimeType: 'application/json' },
          ] };
          break;
        case 'resources/read': {
          const uri = String(params.uri || '');
          let opName, args;
          const fixed = RESOURCES.find((r) => r.uri === uri);
          if (fixed) { opName = fixed.op; args = fixed.args; }
          else if (/^postlite:\/\/posts\/[\w-]+$/.test(uri)) { opName = 'get_post'; args = { post_id: uri.split('/').pop() }; }
          else if (/^postlite:\/\/analytics\/accounts\/[\w-]+$/.test(uri)) { opName = 'get_account_analytics'; args = { account_id: uri.split('/').pop() }; }
          else return rpcError(id, -32002, `Resource not found: ${uri}`);
          const r = await execute(core, opsByName[opName], args, principal, via);
          result = { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(r, null, 2) }] };
          break;
        }
        case 'prompts/list':
          result = { prompts: PROMPTS.map(({ render, ...p }) => p) };
          break;
        case 'prompts/get': {
          const p = PROMPTS.find((x) => x.name === params.name);
          if (!p) return rpcError(id, -32602, `Unknown prompt "${params.name}"`);
          for (const a of p.arguments) if (a.required && !params.arguments?.[a.name]) return rpcError(id, -32602, `Missing argument "${a.name}"`);
          result = { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.render(params.arguments || {}) } }] };
          break;
        }
        case 'completion/complete': result = { completion: { values: [], hasMore: false } }; break;
        default:
          if (method.startsWith('notifications/')) return null;
          return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
      }
      return isNotification ? null : { jsonrpc: '2.0', id, result };
    } catch (e) {
      if (isNotification) return null;
      if (e instanceof HttpError) return rpcError(id, e.status === 403 ? -32003 : e.status === 404 ? -32002 : -32602, e.message, e.extra);
      core.log('error', `mcp ${method}: ${e.stack || e}`);
      return rpcError(id, -32603, `Internal error: ${e.message}`);
    }
  }

  /** Handle a parsed body that may be a single message or a batch. */
  async function handleAny(body, principal) {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(m, principal)))).filter(Boolean);
      return out.length ? out : null;
    }
    return handle(body, principal);
  }

  return { handle, handleAny, tools };
}

