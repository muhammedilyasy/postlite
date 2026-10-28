// OpenAPI 3.1 document generated from the operation registry.
import { operations } from './operations.js';

export function openapi(cfg, version) {
  const paths = {};
  for (const op of operations) {
    const pathParams = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const props = op.input.properties || {};
    const required = op.input.required || [];
    const parameters = pathParams.map((n) => ({ name: n, in: 'path', required: true, schema: props[n] || { type: 'string' } }));
    let requestBody;
    if (op.method === 'GET' || op.method === 'DELETE') {
      for (const [k, s] of Object.entries(props)) if (!pathParams.includes(k)) parameters.push({ name: k, in: 'query', required: required.includes(k), schema: s, description: s.description });
    } else {
      const bodyProps = Object.fromEntries(Object.entries(props).filter(([k]) => !pathParams.includes(k)));
      requestBody = {
        required: required.some((r) => !pathParams.includes(r)),
        content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: bodyProps, required: required.filter((r) => !pathParams.includes(r)) } } },
      };
    }
    const p = `/api/v1${op.path}`;
    paths[p] ||= {};
    paths[p][op.method.toLowerCase()] = {
      operationId: op.name,
      summary: op.summary,
      description: `${op.description}${op.scope ? `\n\nRequired scope: \`${op.scope}\`.` : ''}\n\nMCP tool: \`${op.name}\`.`,
      tags: op.tags,
      parameters,
      ...(requestBody ? { requestBody } : {}),
      responses: {
        200: { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } },
        400: { $ref: '#/components/responses/Error' },
        401: { $ref: '#/components/responses/Error' },
        403: { $ref: '#/components/responses/Error' },
        404: { $ref: '#/components/responses/Error' },
        409: { $ref: '#/components/responses/Error' },
        422: { $ref: '#/components/responses/Error' },
        429: { $ref: '#/components/responses/Error' },
      },
      security: [{ bearer: [] }, { session: [] }],
      'x-required-scope': op.scope,
    };
  }
  paths['/api/v1/media'] ||= {};
  paths['/api/v1/media'].post = {
    operationId: 'upload_media',
    summary: 'Upload a file (raw body)',
    description: 'Send the file bytes as the request body (any Content-Type except application/json). Put the file name in the `X-Filename` header or `?filename=`. Required scope: `write`. Example: `curl -X POST -H "Authorization: Bearer $KEY" -H "X-Filename: clip.mp4" --data-binary @clip.mp4 $URL/api/v1/media`.',
    tags: ['media'],
    parameters: [{ name: 'filename', in: 'query', schema: { type: 'string' } }],
    requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
    responses: { 200: { description: 'Created media', content: { 'application/json': { schema: { type: 'object' } } } }, 413: { $ref: '#/components/responses/Error' }, 415: { $ref: '#/components/responses/Error' } },
    security: [{ bearer: [] }, { session: [] }],
  };
  paths['/api/v1/analytics/export.csv'] = {
    get: {
      operationId: 'export_analytics_csv',
      summary: 'Export analytics as CSV',
      description: 'kind=account (daily account metrics, needs account_id) or kind=posts (latest metrics per post). Required scope: `analytics`.',
      tags: ['analytics'],
      parameters: [
        { name: 'kind', in: 'query', required: true, schema: { type: 'string', enum: ['account', 'posts'] } },
        { name: 'account_id', in: 'query', schema: { type: 'string' } },
        { name: 'from', in: 'query', schema: { type: 'string' } },
        { name: 'to', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: { type: 'string' } } } } },
      security: [{ bearer: [] }, { session: [] }],
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'postlite API',
      version,
      description: 'Agent-first API of postlite, a lightweight self-hosted scheduler for YouTube, Instagram and Facebook Pages. The same operations are exposed as MCP tools at /mcp. Errors have the shape {"error":{"status","message","details"}} with actionable messages.',
      license: { name: 'MIT' },
    },
    servers: [{ url: cfg.publicUrl }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'API key created in Settings → API keys or `postlite keys create`.' },
        session: { type: 'apiKey', in: 'cookie', name: 'pl_sid', description: 'Web UI session (mutating requests also need the X-CSRF-Token header).' },
      },
      responses: {
        Error: { description: 'Error', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'object', properties: { status: { type: 'integer' }, message: { type: 'string' }, details: {} } } } } } } },
      },
    },
    paths,
  };
}
