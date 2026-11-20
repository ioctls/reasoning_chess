// SVG chessboard with overlay layers (control heat, rings, arrows) and tap-to-move.
import { PIECES } from './pieces.js';
import { boardFromFen, sqIdx, sqName } from './analysis.js';

const NS = 'http://www.w3.org/2000/svg';
const S = 100;

export class Board {
  constructor(el, { onSquareTap } = {}) {
    this.el = el;
    this.onSquareTap = onSquareTap;
    this.orientation = 'w';
    this.fen = null;
    this.lastMove = null;
    this.selected = null;
    this.targets = [];
    this.overlays = {};
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('viewBox', '0 0 800 800');
    this.svg.classList.add('board-svg');
    el.appendChild(this.svg);
    this.svg.addEventListener('click', (e) => {
      const pt = this.svg.getBoundingClientRect();
      const x = ((e.clientX - pt.left) / pt.width) * 800, y = ((e.clientY - pt.top) / pt.height) * 800;
      const fx = Math.floor(x / S), fy = Math.floor(y / S);
      const f = this.orientation === 'w' ? fx : 7 - fx;
      const r = this.orientation === 'w' ? 7 - fy : fy;
      if (f < 0 || f > 7 || r < 0 || r > 7) return;
      this.onSquareTap && this.onSquareTap(sqName(r * 8 + f));
    });
  }

  xy(name) {
    const i = typeof name === 'number' ? name : sqIdx(name);
    const f = i % 8, r = Math.floor(i / 8);
    return this.orientation === 'w' ? [f * S, (7 - r) * S] : [(7 - f) * S, r * S];
  }
  center(name) { const [x, y] = this.xy(name); return [x + S / 2, y + S / 2]; }

  set(state) { Object.assign(this, state); this.render(); }

  render() {
    const svg = this.svg;
    svg.textContent = '';
    const g = (tag, attrs, parent = svg) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      parent.appendChild(e);
      return e;
    };
    const board = this.fen ? boardFromFen(this.fen) : new Array(64).fill(null);
    const ov = this.overlays || {};

    // Squares
    for (let i = 0; i < 64; i++) {
      const [x, y] = this.xy(i);
      const light = (i % 8 + Math.floor(i / 8)) % 2 === 1;
      g('rect', { x, y, width: S, height: S, class: light ? 'sq-light' : 'sq-dark' });
    }
    // Control heat: blue = you control it, red = they do.
    if (ov.control) {
      for (let i = 0; i < 64; i++) {
        const v = ov.control[i] * (this.orientation === 'w' ? 1 : -1);
        if (!v) continue;
        const [x, y] = this.xy(i);
        g('rect', { x, y, width: S, height: S, fill: v > 0 ? 'var(--you)' : 'var(--them)', opacity: Math.min(0.55, 0.16 * Math.abs(v)) });
      }
    }
    if (this.lastMove) for (const s of this.lastMove) { const [x, y] = this.xy(s); g('rect', { x, y, width: S, height: S, class: 'sq-last' }); }
    for (const h of ov.highlights || []) { const [x, y] = this.xy(h.sq); g('rect', { x, y, width: S, height: S, fill: h.color, opacity: h.opacity ?? 0.45 }); }
    if (this.selected) { const [x, y] = this.xy(this.selected); g('rect', { x, y, width: S, height: S, class: 'sq-sel' }); }

    // Coordinates
    for (let k = 0; k < 8; k++) {
      const file = this.orientation === 'w' ? 'abcdefgh'[k] : 'hgfedcba'[k];
      const rank = this.orientation === 'w' ? 8 - k : k + 1;
      g('text', { x: k * S + S - 6, y: 800 - 6, class: 'coord', 'text-anchor': 'end' }).textContent = file;
      g('text', { x: 5, y: k * S + 20, class: 'coord' }).textContent = rank;
    }

    // Pieces
    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (!p) continue;
      const [x, y] = this.xy(i);
      g('image', { href: PIECES[p.c + p.t], x: x + 2, y: y + 2, width: S - 4, height: S - 4 });
    }
    // Rings (e.g. loose pieces)
    for (const r of ov.rings || []) {
      const [cx, cy] = this.center(r.sq);
      g('circle', { cx, cy, r: S * 0.46, fill: 'none', stroke: r.color, 'stroke-width': 7, opacity: 0.9, 'stroke-dasharray': r.dashed ? '14 9' : '' });
    }
    // Legal move dots
    for (const t of this.targets) {
      const [cx, cy] = this.center(t);
      const occupied = board[sqIdx(t)];
      if (occupied) g('circle', { cx, cy, r: S * 0.44, fill: 'none', stroke: 'rgba(0,0,0,.28)', 'stroke-width': 8 });
      else g('circle', { cx, cy, r: S * 0.15, fill: 'rgba(0,0,0,.28)' });
    }
    // Arrows on top
    for (const a of ov.arrows || []) this.arrow(g, a);
  }

  arrow(g, { from, to, color, width = 16, label, dashed, opacity = 0.85 }) {
    const [x1, y1] = this.center(from), [x2, y2] = this.center(to);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (!len) return;
    const ux = dx / len, uy = dy / len, px = -uy, py = ux;
    const head = Math.max(30, width * 2.2), hw = Math.max(22, width * 1.6);
    const sx = x1 + ux * 18, sy = y1 + uy * 18;
    const ex = x2 - ux * 12, ey = y2 - uy * 12;
    const bx = ex - ux * head, by = ey - uy * head;
    const grp = g('g', { opacity });
    g('line', { x1: sx, y1: sy, x2: bx, y2: by, stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-dasharray': dashed ? `${width * 1.4} ${width}` : '' }, grp);
    g('polygon', { points: `${ex},${ey} ${bx + px * hw},${by + py * hw} ${bx - px * hw},${by - py * hw}`, fill: color }, grp);
    if (label != null) {
      const lx = x1 + dx * 0.5, ly = y1 + dy * 0.5;
      g('circle', { cx: lx, cy: ly, r: 21, fill: color, stroke: '#111', 'stroke-width': 2 }, grp);
      g('text', { x: lx, y: ly + 8, 'text-anchor': 'middle', class: 'arrow-label' }, grp).textContent = label;
    }
  }
}
