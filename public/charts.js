// Hand-rolled SVG charts. ponytail: no chart library — axes, paths and rects are
// about 150 lines, and a dependency here would outweigh the whole app.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
export const COLORS = { ember: '#dd6b2f', gold: '#c9a05a', green: '#7fa650', violet: '#8a7fb8', steel: '#5f7d8c', bone: '#a89f8c' };

function frame(width, height, pad) {
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, preserveAspectRatio: 'none', role: 'img' });
  return { svg, x0: pad.l, x1: width - pad.r, y0: height - pad.b, y1: pad.t };
}

function axes(svg, f, { xTicks = [], yTicks = [], yFmt = String, xFmt = String, grid = true }) {
  for (const t of yTicks) {
    const y = f.yScale(t);
    if (grid) svg.append(el('line', { x1: f.x0, x2: f.x1, y1: y, y2: y, class: 'grid-line' }));
    svg.append(el('text', { x: f.x0 - 6, y: y + 3, 'text-anchor': 'end' }, yFmt(t)));
  }
  for (const t of xTicks) {
    const x = f.xScale(t);
    svg.append(el('text', { x, y: f.y0 + 14, 'text-anchor': 'middle' }, xFmt(t)));
  }
  svg.append(el('line', { x1: f.x0, x2: f.x1, y1: f.y0, y2: f.y0, class: 'axis' }));
}

const ticks = (min, max, n = 5) => {
  const step = (max - min) / n || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(step)));
  const nice = [1, 2, 2.5, 5, 10].map(m => m * mag).find(m => m >= step) || step;
  const out = [];
  for (let v = Math.ceil(min / nice) * nice; v <= max + 1e-9; v += nice) out.push(+v.toFixed(6));
  return out;
};

/** Multi-series line/area chart over a numeric x. */
export function lineChart(node, { series, height = 190, yFmt = String, xFmt = String, area = false, yMin = null }) {
  node.innerHTML = '';
  const pad = { l: 46, r: 10, t: 10, b: 22 }, width = 900;
  const f = frame(width, height, pad);
  const pts = series.flatMap(s => s.points);
  if (!pts.length) { node.append(Object.assign(document.createElement('p'), { className: 'faint tiny', textContent: 'no data yet' })); return; }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = yMin != null ? yMin : Math.min(...ys, 0), ymax = Math.max(...ys) * 1.08 || 1;
  f.xScale = x => f.x0 + (x - xmin) / (xmax - xmin || 1) * (f.x1 - f.x0);
  f.yScale = y => f.y0 - (y - ymin) / (ymax - ymin || 1) * (f.y0 - f.y1);
  axes(f.svg, f, { yTicks: ticks(ymin, ymax, 4), xTicks: ticks(xmin, xmax, 5), yFmt, xFmt });
  for (const s of series) {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${f.xScale(p[0]).toFixed(1)},${f.yScale(p[1]).toFixed(1)}`).join('');
    if (area || s.area) f.svg.append(el('path', { d: `${d}L${f.xScale(s.points.at(-1)[0])},${f.y0}L${f.xScale(s.points[0][0])},${f.y0}Z`, fill: s.color, 'fill-opacity': .14, stroke: 'none' }));
    f.svg.append(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 1.6, 'stroke-dasharray': s.dash || null }));
  }
  node.append(f.svg);
}

/** Vertical bars over an ordered index (weeks, months). */
export function barChart(node, { bars, height = 170, yFmt = String, xFmt = i => i, color = COLORS.ember, marks = [] }) {
  node.innerHTML = '';
  const pad = { l: 46, r: 10, t: 10, b: 22 }, width = 900;
  const f = frame(width, height, pad);
  if (!bars.length) { node.append(Object.assign(document.createElement('p'), { className: 'faint tiny', textContent: 'no data yet' })); return; }
  const ymax = Math.max(...bars.map(b => b.y)) * 1.1 || 1;
  const bw = (f.x1 - f.x0) / bars.length;
  f.xScale = i => f.x0 + i * bw + bw / 2;
  f.yScale = y => f.y0 - (y / ymax) * (f.y0 - f.y1);
  axes(f.svg, f, { yTicks: ticks(0, ymax, 4), xTicks: bars.map((_, i) => i).filter(i => i % Math.ceil(bars.length / 8) === 0), yFmt, xFmt });
  bars.forEach((b, i) => {
    const rect = el('rect', {
      x: f.x0 + i * bw + bw * .12, y: f.yScale(b.y), width: Math.max(1, bw * .76), height: Math.max(0, f.y0 - f.yScale(b.y)),
      fill: b.color || color, 'fill-opacity': b.faded ? .4 : .85,
    });
    rect.append(el('title', {}, b.title || `${xFmt(i)}: ${yFmt(b.y)}`));   // append() returns undefined — no chaining
    f.svg.append(rect);
  });
  for (const m of marks) {
    const y = f.yScale(m.y);
    f.svg.append(el('line', { x1: f.x0, x2: f.x1, y1: y, y2: y, stroke: m.color || COLORS.gold, 'stroke-dasharray': '4 3', 'stroke-width': 1 }));
    f.svg.append(el('text', { x: f.x1 - 2, y: y - 4, 'text-anchor': 'end', fill: m.color || COLORS.gold }, m.label));
  }
  node.append(f.svg);
}

/**
 * The pace curve: log-distance on x, pace on y. Your measured PBs, your predicted
 * curve, and every time-based feat plotted as a dot — anything below your line is beaten.
 */
export function paceCurve(node, { curve, pbs, feats, height = 320 }) {
  node.innerHTML = '';
  const pad = { l: 52, r: 12, t: 12, b: 26 }, width = 900;
  const f = frame(width, height, pad);
  const all = [...curve, ...pbs, ...feats];
  if (!all.length) { node.append(Object.assign(document.createElement('p'), { className: 'faint tiny', textContent: 'no data yet' })); return; }
  const lx = d => Math.log10(d);
  const xmin = lx(Math.min(...all.map(p => p.d)) * .85), xmax = lx(Math.max(...all.map(p => p.d)) * 1.15);
  const paces = all.map(p => p.pace);
  const ymin = Math.min(...paces) * .92, ymax = Math.max(...paces) * 1.06;
  f.xScale = d => f.x0 + (lx(d) - xmin) / (xmax - xmin) * (f.x1 - f.x0);
  f.yScale = p => f.y0 - (p - ymin) / (ymax - ymin || 1) * (f.y0 - f.y1);
  const paceFmt = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const xTickVals = [1000, 5000, 10000, 21097, 42195, 100000, 160934].filter(d => lx(d) >= xmin && lx(d) <= xmax);
  for (const t of ticks(ymin, ymax, 5)) {
    const y = f.yScale(t);
    f.svg.append(el('line', { x1: f.x0, x2: f.x1, y1: y, y2: y, class: 'grid-line' }));
    f.svg.append(el('text', { x: f.x0 - 6, y: y + 3, 'text-anchor': 'end' }, paceFmt(t)));
  }
  for (const d of xTickVals) {
    f.svg.append(el('text', { x: f.xScale(d), y: f.y0 + 15, 'text-anchor': 'middle' }, d >= 1000 ? `${Math.round(d / 1000)}k` : d));
  }
  f.svg.append(el('line', { x1: f.x0, x2: f.x1, y1: f.y0, y2: f.y0, class: 'axis' }));

  if (curve.length) {
    const d = curve.map((p, i) => `${i ? 'L' : 'M'}${f.xScale(p.d).toFixed(1)},${f.yScale(p.pace).toFixed(1)}`).join('');
    f.svg.append(el('path', { d, fill: 'none', stroke: COLORS.ember, 'stroke-width': 2 }));
  }
  for (const p of feats) {
    const beaten = p.beaten;
    const g = el('g');
    g.append(el('circle', {
      cx: f.xScale(p.d), cy: f.yScale(p.pace), r: p.reference ? 4.5 : 3.4,
      fill: beaten ? COLORS.green : 'none', stroke: beaten ? COLORS.green : (p.reference ? COLORS.gold : COLORS.bone),
      'stroke-width': 1.2, 'fill-opacity': .7,
    }));
    g.append(el('title', {}, `${p.who} — ${p.label} (${paceFmt(p.pace)}/km)${beaten ? ' — beaten' : ''}`));
    f.svg.append(g);
  }
  for (const p of pbs) {
    const box = el('rect', { x: f.xScale(p.d) - 3, y: f.yScale(p.pace) - 3, width: 6, height: 6, fill: COLORS.gold });
    box.append(el('title', {}, `${p.label}: ${paceFmt(p.pace)}/km`));
    f.svg.append(box);
  }
  node.append(f.svg);
}
