// Dependency-free SVG line chart in the style of developer-console metrics charts:
// faint horizontal gridlines, mono axis labels (HTML, so they never scale), accent line + soft area, hover crosshair + tooltip.
import { h, fmtNum } from './core.js';

export function lineChart(points, { color = 'var(--accent)', height = 150, label = '' } = {}) {
  if (!points?.length) return h('div', { class: 'chart-empty muted small' }, 'No data in this range');
  if (points.length < 2) return h('div', { class: 'chart-single' }, h('div', { class: 'kv' }, fmtNum(points[0].value)), h('div', { class: 'muted small mono' }, `as of ${points[0].day}`));
  const W = 1000, H = 100;
  const vals = points.map((p) => p.value);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  if (min > 0 && min / max < 0.6) min = 0;
  const pad = (max - min) * 0.08;
  max += pad; if (min !== 0) min -= pad;
  const span = max - min;
  const x = (i) => (i * W) / (points.length - 1);
  const y = (v) => (1 - (v - min) / span) * H;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ');
  const area = `${d} L${W},${H} L0,${H} Z`;
  const ticks = [0, 1, 2, 3].map((k) => min + (span * k) / 3);
  const uid = `g${Math.random().toString(36).slice(2, 8)}`;
  const grid = ticks.map((t) => `<line x1="0" x2="${W}" y1="${y(t).toFixed(2)}" y2="${y(t).toFixed(2)}" class="grid"/>`).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart" role="img" aria-label="${label} chart"><defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".25"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${area}" fill="url(#${uid})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.75" vector-effect="non-scaling-stroke" stroke-linejoin="round"/><line class="xhair" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/></svg>`;
  const plot = h('div', { class: 'chart-plot', html: svg });
  plot.querySelector('svg').style.height = `${height}px`; // CSSOM (inline style attributes are blocked by the CSP)
  const yAxis = h('div', { class: 'chart-y', style: { height: `${height}px` } }, ticks.map((t) => h('span', { class: 'mono', style: { top: `${(y(t) / H) * 100}%` } }, fmtNum(t))));
  const xi = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const xAxis = h('div', { class: 'chart-x mono' }, xi.map((i) => h('span', {}, String(points[i].day || '').slice(5))));
  const dot = h('span', { class: 'chart-dot', hidden: true, style: { background: color } });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  plot.append(dot, tip);
  const wrap = h('div', { class: 'chart-wrap' }, h('div', { class: 'chart-row' }, plot, yAxis), xAxis);
  const xh = plot.querySelector('.xhair');
  plot.addEventListener('pointermove', (ev) => {
    const r = plot.getBoundingClientRect();
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((ev.clientX - r.left) / r.width) * (points.length - 1))));
    const px = (x(i) / W) * r.width, py = (y(points[i].value) / H) * r.height;
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
    dot.hidden = false; dot.style.left = `${px}px`; dot.style.top = `${py}px`;
    tip.hidden = false;
    tip.replaceChildren(h('div', { class: 'mono muted' }, points[i].day), h('div', { class: 'tip-val' }, h('i', { class: 'sw', style: { background: color } }), fmtNum(points[i].value)));
    tip.style.left = `${Math.min(r.width - 120, Math.max(0, px + 12))}px`;
    tip.style.top = `${Math.max(0, py - 44)}px`;
  });
  plot.addEventListener('pointerleave', () => { tip.hidden = true; dot.hidden = true; xh.setAttribute('visibility', 'hidden'); });
  return wrap;
}
