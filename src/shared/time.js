// Timezone helpers without dependencies (Intl-based). Shared by server and browser.

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz) {
  try { dtf(tz); return true; } catch { return false; }
}

/** Wall-clock parts of a UTC instant in a timezone. */
export function zonedParts(ms, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { year: +o.year, month: +o.month, day: +o.day, hour: +o.hour % 24, minute: +o.minute, second: +o.second, weekday: o.weekday };
}

/** Offset (ms) of tz at instant ms: local = utc + offset. */
export function tzOffset(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Convert wall-clock time in tz to a UTC epoch ms. */
export function zonedToUtc(year, month, day, hour = 0, minute = 0, tz = 'UTC') {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let off = tzOffset(guess, tz);
  let t = guess - off;
  const off2 = tzOffset(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}

/** Parse "YYYY-MM-DDTHH:mm" (no zone) as wall time in tz; ISO strings with Z/offset are absolute. */
export function parseLocal(str, tz) {
  const s = String(str || '').trim();
  if (/([zZ]|[+-]\d\d:?\d\d)$/.test(s)) return Date.parse(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return NaN;
  return zonedToUtc(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), tz);
}

export function formatLocal(ms, tz) {
  const p = zonedParts(ms, tz);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WD = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };

/**
 * Next free posting slots.
 * @param {object} slots  { mon: ['09:00','18:00'], ... } in tz
 * @param {(ms:number)=>boolean} isTaken
 */
export function nextSlots(slots, tz, { from = Date.now(), count = 5, isTaken = () => false, horizonDays = 60 } = {}) {
  const out = [];
  const start = zonedParts(from, tz);
  for (let d = 0; d < horizonDays && out.length < count; d++) {
    const dayUtc = Date.UTC(start.year, start.month - 1, start.day + d, 12);
    const dt = new Date(dayUtc);
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, da = dt.getUTCDate();
    const wd = WD[zonedParts(zonedToUtc(y, mo, da, 12, 0, tz), tz).weekday];
    const times = [...(slots?.[wd] || [])].sort();
    for (const t of times) {
      const [hh, mm] = t.split(':').map(Number);
      const ms = zonedToUtc(y, mo, da, hh, mm, tz);
      if (ms <= from + 60000) continue;
      if (isTaken(ms)) continue;
      out.push(ms);
      if (out.length >= count) break;
    }
  }
  return out;
}
