// Composer extras: a small vendored emoji picker (no CDN, no font download) and Unicode bold/italic
// for platforms without rich text (LinkedIn, X). Both work on any <textarea> at the cursor.
import { h } from './core.js';
import { toggleRange, hasStyled } from '/assets/shared/textstyle.js';

export { hasStyled };

/** Compact categorised set: the emoji people actually use in social captions. */
export const EMOJI = [
  ['Smileys', '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😎 🤩 🥳 🤔 🤨 😐 🙄 😏 😮 😲 🥺 😢 😭 😤 😡 🤯 😱 😴 🤗 🤫 🤭 🫡 🫠 😬'],
  ['Gestures', '👍 👎 👌 ✌️ 🤞 🤝 👏 🙌 👐 🙏 💪 👀 👇 👆 👉 👈 ☝️ ✋ 🫶 🤙 ✍️ 🧠 🫵'],
  ['Hearts', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💖 💯 ✨ 🔥 ⭐ 🌟 💥 💫 🎉 🎊 🏆 🥇'],
  ['Objects', '📢 📣 🔔 💡 🔗 📌 📍 📎 📝 📅 📆 ⏰ ⏳ 🎥 🎬 📷 📸 🎙️ 🎧 💻 📱 ⌨️ 🖥️ 🛠️ ⚙️ 🔒 🔑 💰 💸 📈 📉 📊 🧾 🎁 📦 🚀 🛒'],
  ['Nature', '🌱 🌿 🍀 🌸 🌻 🌞 🌙 ⚡ 🌈 ☀️ ⛅ 🌧️ ❄️ 🌊 🌍 🐶 🐱 🦊 🐻 🐼 🦁 🐝 🦋'],
  ['Food', '☕ 🍵 🍕 🍔 🌮 🍣 🍜 🍩 🍪 🎂 🍫 🍎 🍉 🍓 🥑 🥗 🍿 🥤 🍺 🥂'],
  ['Travel', '✈️ 🚗 🚲 🏠 🏢 🏖️ ⛰️ 🗺️ 🧳 🏁 🎯 🎮 ⚽ 🏀 🎵 🎶'],
  ['Symbols', '✅ ☑️ ✔️ ❌ ⚠️ ❗ ❓ ➡️ ⬅️ ⬆️ ⬇️ ↗️ 🔁 🔄 ➕ ➖ 🆕 🆓 🔴 🟢 🔵 🟡 ⚫ ⚪ #️⃣ 1️⃣ 2️⃣ 3️⃣'],
].map(([name, list]) => [name, list.split(' ')]);

/** Insert text at the cursor of a textarea/input and fire `input` so listeners (counters, state) update. */
export function insertAtCursor(el, text) {
  if (!el) return;
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, s) + text + el.value.slice(e);
  const pos = s + text.length;
  el.focus();
  el.setSelectionRange(pos, pos);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Toggle bold/italic on the selection (whole value when nothing is selected). */
export function toggleStyle(el, style) {
  if (!el) return;
  const r = toggleRange(el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0, style);
  el.value = r.text;
  el.focus();
  el.setSelectionRange(r.start, r.end);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

let openPicker = null;
/** Emoji popover anchored to a button; `target()` returns the textarea to insert into. */
export function emojiPicker(anchor, target) {
  if (openPicker) { openPicker(); return; }
  let cat = 0;
  const grid = h('div', { class: 'emoji-grid', role: 'listbox', 'aria-label': 'Emoji' });
  const tabsEl = h('div', { class: 'emoji-tabs', role: 'tablist' });
  const fill = () => {
    tabsEl.replaceChildren(...EMOJI.map(([name, list], i) => h('button', { type: 'button', role: 'tab', class: i === cat ? 'on' : '', 'aria-selected': i === cat ? 'true' : 'false', title: name, onclick: () => { cat = i; fill(); } }, list[0])));
    grid.replaceChildren(...EMOJI[cat][1].map((em) => h('button', { type: 'button', class: 'emoji', role: 'option', title: em, onclick: () => { insertAtCursor(target(), em); } }, em)));
  };
  fill();
  const pop = h('div', { class: 'emoji-pop menu', role: 'dialog', 'aria-label': 'Insert emoji' }, h('div', { class: 'emoji-head small muted' }, EMOJI[cat][0]), tabsEl, grid);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8);
  let top = r.bottom + 6;
  if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 6);
  Object.assign(pop.style, { left: `${Math.max(8, left) + window.scrollX}px`, top: `${top + window.scrollY}px` });
  const head = pop.querySelector('.emoji-head');
  const obs = () => { head.textContent = EMOJI[cat][0]; };
  tabsEl.addEventListener('click', obs);
  const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); } };
  function close() { pop.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); openPicker = null; }
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  openPicker = close;
  grid.querySelector('button')?.focus({ preventScroll: true });
  return close;
}

/** Caption toolbar: emoji, and bold/italic when a LinkedIn or X target is selected. */
export function captionTools({ target, styled = false, extra = null }) {
  return h('div', { class: 'cap-tools', role: 'toolbar', 'aria-label': 'Caption tools' },
    h('button', { type: 'button', class: 'icon-btn', title: 'Emoji', 'aria-label': 'Insert emoji', 'aria-haspopup': 'dialog', onclick: (e) => emojiPicker(e.currentTarget, target) }, h('span', { class: 'emoji-ic', 'aria-hidden': 'true' }, '☺')),
    styled ? [
      h('button', { type: 'button', class: 'icon-btn fmt b', title: 'Bold (Unicode, for LinkedIn and X)', 'aria-label': 'Bold', onmousedown: (e) => e.preventDefault(), onclick: () => toggleStyle(target(), 'bold') }, 'B'),
      h('button', { type: 'button', class: 'icon-btn fmt i', title: 'Italic (Unicode, for LinkedIn and X)', 'aria-label': 'Italic', onmousedown: (e) => e.preventDefault(), onclick: () => toggleStyle(target(), 'italic') }, 'I'),
    ] : null,
    extra);
}

