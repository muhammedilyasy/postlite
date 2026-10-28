// Tiny, safe Markdown → HTML renderer for the bundled docs (docs/setup/*.md). Supports headings,
// paragraphs, nested lists, fenced code, blockquotes, tables, hr, inline code/bold/italic/links.
// All text is HTML-escaped first; only http(s), relative and #anchor links are emitted.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const slug = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

function safeHref(href, mapLink) {
  const h = href.trim();
  if (/^(https?:|#|\/|\.\/|[\w.-]+(\.md)?(#[\w-]*)?$)/i.test(h) && !/^javascript:/i.test(h)) return mapLink ? mapLink(h) : h;
  return '#';
}

export function inline(text, mapLink) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, u) => { codes.push(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => {
    const h = safeHref(href.replace(/&amp;/g, '&'), mapLink);
    const ext = /^https?:/i.test(h);
    return `<a href="${esc(h)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:])/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

export function renderMarkdown(md, { mapLink } = {}) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let title = '';
  const isBlockStart = (l) => /^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|\|.*\|\s*$|---+\s*$)/.test(l);

  function list(indent) {
    const ordered = /^\s*\d+[.)]\s/.test(lines[i]);
    const start = ordered ? Number(/^\s*(\d+)/.exec(lines[i])[1]) : 1;
    const items = [];
    while (i < lines.length) {
      const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
      if (!m || m[1].length < indent) break;
      if (m[1].length > indent) { items[items.length - 1] += list(m[1].length); continue; }
      let body = '';
      let text = [m[3]];
      const flush = () => { if (text.length) body += inline(text.join(' '), mapLink); text = []; };
      i++;
      for (;;) {
        if (i >= lines.length || !lines[i].trim()) break;
        const ind = /^(\s*)/.exec(lines[i])[1].length;
        const tt = lines[i].trim();
        if (tt.startsWith('```') && ind > indent) { // fenced code nested in the item
          flush();
          const buf = [];
          i++;
          while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++].trim());
          i++;
          body += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
          continue;
        }
        if (/^([-*+]|\d+[.)])\s/.test(tt) || (isBlockStart(tt) && ind <= indent) || (ind <= indent && body)) break;
        if (isBlockStart(tt)) break;
        text.push(tt);
        i++;
      }
      flush();
      items.push(body);
      while (i < lines.length && !lines[i].trim() && /^\s*([-*+]|\d+[.)])\s/.test(lines[i + 1] || '') && /^(\s*)/.exec(lines[i + 1])[1].length >= indent) i++;
    }
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag}${start !== 1 ? ` start="${start}"` : ''}>${items.map((x) => `<li>${x}</li>`).join('')}</${tag}>`;
  }

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }
    let m;
    if ((m = /^```(\w*)/.exec(t))) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${m[1] ? ` class="lang-${esc(m[1])}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) {
      const lvl = m[1].length;
      if (lvl === 1 && !title) title = m[2];
      out.push(`<h${lvl} id="${slug(m[2])}">${inline(m[2], mapLink)}</h${lvl}>`);
      i++;
    } else if (/^---+$/.test(t)) { out.push('<hr>'); i++; }
    else if (t.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) buf.push(lines[i++].trim().replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), { mapLink }).html}</blockquote>`);
    } else if (/^\|.*\|$/.test(t) && /^\|?\s*:?-+/.test((lines[i + 1] || '').trim())) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(t);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) rows.push(cells(lines[i++]));
      out.push(`<div class="table-wrap"><table class="table"><thead><tr>${head.map((c) => `<th>${inline(c, mapLink)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, mapLink)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      out.push(list(/^(\s*)/.exec(line)[1].length));
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i].trim())) buf.push(lines[i++].trim());
      if (!buf.length) { buf.push(lines[i++].trim()); }
      out.push(`<p>${inline(buf.join(' '), mapLink)}</p>`);
    }
  }
  return { html: out.join('\n'), title };
}
