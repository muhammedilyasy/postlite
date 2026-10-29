// Composer extras: Unicode bold/italic round-trips (LinkedIn/X have no rich text) and the emoji set is vendored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toStyle, plain, hasStyled, isStyled, toggleRange } from '../src/shared/textstyle.js';

test('bold/italic: letters and bold digits map to Mathematical Sans-Serif and back', () => {
  const b = toStyle('Hello 2026!', 'bold');
  assert.equal(b, '𝗛𝗲𝗹𝗹𝗼 𝟮𝟬𝟮𝟲!');
  assert.equal(plain(b), 'Hello 2026!');
  const i = toStyle('Hello 2026', 'italic');
  assert.equal(i, '𝘏𝘦𝘭𝘭𝘰 2026'); // no italic digits
  assert.equal(plain(i), 'Hello 2026');
  assert.ok(hasStyled(b) && hasStyled(i) && !hasStyled('Hello'));
  assert.ok(isStyled(b, 'bold') && !isStyled(b, 'italic'));
  // italic over bold re-styles from plain text instead of mixing
  assert.equal(toStyle(b, 'italic'), '𝘏𝘦𝘭𝘭𝘰 2026!');
});

test('toggleRange styles the selection, toggles it back, and uses the whole text when nothing is selected', () => {
  const r = toggleRange('make this bold', 5, 9, 'bold');
  assert.equal(r.text, 'make 𝘁𝗵𝗶𝘀 bold');
  const back = toggleRange(r.text, r.start, r.end, 'bold');
  assert.equal(back.text, 'make this bold');
  assert.equal(toggleRange('all', 0, 0, 'italic').text, '𝘢𝘭𝘭');
  assert.equal(toggleRange('Ünïcode ok', 0, 0, 'bold').text, 'Ü𝗻ï𝗰𝗼𝗱𝗲 𝗼𝗸'); // non-ASCII letters stay
});

test('emoji picker is vendored (no CDN, no remote font) and categorised', () => {
  const src = fs.readFileSync(new URL('../public/js/emoji.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /https?:\/\//);
  const cats = [...src.matchAll(/^\s+\['(\w+)', '/gm)].map((m) => m[1]);
  assert.ok(cats.length >= 6, cats.join(','));
});
