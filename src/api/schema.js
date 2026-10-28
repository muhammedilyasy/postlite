// Tiny JSON-Schema subset validator with agent-friendly error messages + query-string coercion.

function closest(word, options) {
  let best = null, bestD = Infinity;
  for (const o of options) {
    const d = lev(word.toLowerCase(), o.toLowerCase());
    if (d < bestD) { bestD = d; best = o; }
  }
  return bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}
function lev(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

export function validate(schema, value, path = '') {
  const errs = [];
  const at = path || 'input';
  if (value === undefined) return errs;
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
  if (types) {
    const t = typeOf(value);
    const ok = types.some((x) => x === t || (x === 'number' && t === 'integer'));
    if (!ok) return [`${at} must be ${types.join(' or ')} (got ${t})`];
  }
  if (schema.oneOf && !schema.oneOf.some((s) => !validate(s, value, path).length)) errs.push(`${at} does not match any allowed form`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at} must be one of: ${schema.enum.map((e) => JSON.stringify(e)).join(', ')} (got ${JSON.stringify(value)})`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at} must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${at} must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at} has an invalid format${schema.description ? ` (${schema.description})` : ''}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at} must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at} must be ≤ ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${at} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${at} allows at most ${schema.maxItems} item(s)`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties || {};
    for (const r of schema.required || []) if (value[r] === undefined) errs.push(`${path ? `${path}.` : ''}${r} is required${props[r]?.description ? ` — ${props[r].description}` : ''}`);
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errs.push(...validate(props[k], v, path ? `${path}.${k}` : k));
      else if (schema.additionalProperties === false) {
        const guess = closest(k, Object.keys(props));
        errs.push(`Unknown field "${path ? `${path}.` : ''}${k}"${guess ? ` — did you mean "${guess}"?` : ''} Allowed: ${Object.keys(props).join(', ')}`);
      } else if (typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties, v, path ? `${path}.${k}` : k));
    }
  }
  return errs;
}

/** Coerce query-string values to the schema's declared types. */
export function coerceQuery(schema, q) {
  const out = {};
  for (const [k, raw] of Object.entries(q)) {
    const s = schema.properties?.[k];
    const t = s && (Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type);
    if (t === 'integer' || t === 'number') out[k] = raw === '' ? undefined : Number.isNaN(Number(raw)) ? raw : Number(raw);
    else if (t === 'boolean') out[k] = raw === 'true' || raw === '1' ? true : raw === 'false' || raw === '0' ? false : raw;
    else if (t === 'array') out[k] = String(raw).split(',').filter(Boolean);
    else out[k] = raw;
  }
  return out;
}
