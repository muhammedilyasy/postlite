// Unicode "bold" / "italic" for platforms without rich text (LinkedIn, X): Mathematical Sans-Serif
// letters (U+1D5D4…). Shared by the composer and tests. Screen readers and search handle them poorly.
const RANGES = {
  bold: { A: 0x1d5d4, a: 0x1d5ee, d: 0x1d7ec },
  italic: { A: 0x1d608, a: 0x1d622, d: null },
};

/** Map styled letters back to ASCII. */
export function plain(str) {
  let out = '';
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    let hit = null;
    for (const r of Object.values(RANGES)) {
      if (c >= r.A && c < r.A + 26) hit = 65 + c - r.A;
      else if (c >= r.a && c < r.a + 26) hit = 97 + c - r.a;
      else if (r.d && c >= r.d && c < r.d + 10) hit = 48 + c - r.d;
      if (hit !== null) break;
    }
    out += hit !== null ? String.fromCharCode(hit) : ch;
  }
  return out;
}

/** Style ASCII letters (and digits for bold); anything else is kept. */
export function toStyle(str, style) {
  const r = RANGES[style];
  if (!r) throw new Error(`unknown style ${style}`);
  let out = '';
  for (const ch of plain(str)) {
    const c = ch.codePointAt(0);
    if (c >= 65 && c <= 90) out += String.fromCodePoint(r.A + c - 65);
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(r.a + c - 97);
    else if (c >= 48 && c <= 57 && r.d) out += String.fromCodePoint(r.d + c - 48);
    else out += ch;
  }
  return out;
}

export const hasStyled = (str) => /[\u{1D5D4}-\u{1D63B}\u{1D7EC}-\u{1D7F5}]/u.test(String(str || ''));
/** True when every letter of str already has the style. */
export const isStyled = (str, style) => { const s = [...String(str)].filter((ch) => /[A-Za-z]/.test(plain(ch))); return s.length > 0 && s.every((ch) => toStyle(plain(ch), style) === ch); };

/** Toggle a style on [s, e) of text; returns { text, start, end }. Empty range = whole text. */
export function toggleRange(text, s, e, style) {
  if (s === e) { s = 0; e = text.length; }
  const sel = text.slice(s, e);
  const next = isStyled(sel, style) ? plain(sel) : toStyle(sel, style);
  return { text: text.slice(0, s) + next + text.slice(e), start: s, end: s + next.length };
}
