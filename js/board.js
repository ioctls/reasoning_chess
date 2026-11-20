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
    this.prevArrows = new Set();
    this.prevBoard = null;
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
    const imgs = new Array(64);
    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (!p) continue;
      const [x, y] = this.xy(i);
      imgs[i] = g('image', { href: PIECES[p.c + p.t], x: x + 2, y: y + 2, width: S - 4, height: S - 4 });
    }
    this.animatePieces(g, board, imgs);
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
    // Arrows on top. Only arrows that weren't there last time fade in, so nothing flickers.
    const seen = new Set();
    for (const a of ov.arrows || []) {
      const key = `${a.from}${a.to}${a.color}${a.label ?? ''}`;
      seen.add(key);
      this.arrow(g, a, !this.prevArrows.has(key));
    }
    this.prevArrows = seen;
  }

  /**
   * Slide pieces from where they were to where they are now.
   * Works by diffing the two positions, so it also handles castling, en passant,
   * promotions and jumping back/forward through the game.
   */
  animatePieces(g, board, imgs) {
    const prev = this.prevBoard;
    const prevOrient = this.prevOrientation;
    this.prevBoard = board;
    this.prevOrientation = this.orientation;
    const now = performance.now();
    // The board is redrawn often (e.g. when analysis arrives). Carry on any slide that's
    // still in flight instead of snapping the piece to its square.
    this.active = (this.active || []).filter((a) => now - a.t0 < a.dur && board[a.to]);
    for (const a of this.active) {
      const el = imgs[a.to];
      if (!el) continue;
      el.parentNode.appendChild(el);
      el.animate([{ transform: `translate(${a.dx}px, ${a.dy}px)` }, { transform: 'translate(0,0)' }], { duration: a.dur, delay: -(now - a.t0), easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
    if (!prev || prevOrient !== this.orientation || this.instant) return;
    const same = (a, b) => a && b && a.c === b.c && a.t === b.t;
    const arrivals = [], departures = [];
    for (let i = 0; i < 64; i++) {
      if (board[i] && !same(board[i], prev[i])) arrivals.push(i);
      if (prev[i] && !same(prev[i], board[i])) departures.push(i);
    }
    if (!arrivals.length || arrivals.length > 4) return; // nothing moved, or a jump too big to follow
    const used = new Set();
    const dist = (a, b) => Math.hypot((a % 8) - (b % 8), Math.floor(a / 8) - Math.floor(b / 8));
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dur = reduce ? 0 : 280;
    for (const to of arrivals) {
      const p = board[to];
      let from = departures.filter((d) => !used.has(d) && same(prev[d], p)).sort((a, b) => dist(a, to) - dist(b, to))[0];
      if (from == null) from = departures.find((d) => !used.has(d) && prev[d].c === p.c && prev[d].t === 'p'); // promotion
      if (from == null) continue;
      used.add(from);
      const [x0, y0] = this.xy(from), [x1, y1] = this.xy(to);
      const el = imgs[to];
      el.parentNode.appendChild(el); // moving piece on top
      if (dur) {
        el.animate([{ transform: `translate(${x0 - x1}px, ${y0 - y1}px)` }, { transform: 'translate(0,0)' }], { duration: dur, easing: 'cubic-bezier(.2,.7,.2,1)' });
        this.active.push({ to, dx: x0 - x1, dy: y0 - y1, t0: now, dur });
      }
    }
    // Captured pieces fade out where they stood.
    for (const d of departures) {
      if (used.has(d) || !dur) continue;
      const [x, y] = this.xy(d);
      const ghost = g('image', { href: PIECES[prev[d].c + prev[d].t], x: x + 2, y: y + 2, width: S - 4, height: S - 4 });
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur, fill: 'forwards' });
      setTimeout(() => ghost.remove(), dur + 20);
    }
  }

  arrow(g, { from, to, color, width = 16, label, dashed, opacity = 0.85 }, fadeIn = false) {
    const [x1, y1] = this.center(from), [x2, y2] = this.center(to);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (!len) return;
    const ux = dx / len, uy = dy / len, px = -uy, py = ux;
    const head = Math.max(30, width * 2.2), hw = Math.max(22, width * 1.6);
    const sx = x1 + ux * 18, sy = y1 + uy * 18;
    const ex = x2 - ux * 12, ey = y2 - uy * 12;
    const bx = ex - ux * head, by = ey - uy * head;
    const grp = g('g', { opacity, class: fadeIn ? 'fade-in' : '' });
    g('line', { x1: sx, y1: sy, x2: bx, y2: by, stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-dasharray': dashed ? `${width * 1.4} ${width}` : '' }, grp);
    g('polygon', { points: `${ex},${ey} ${bx + px * hw},${by + py * hw} ${bx - px * hw},${by - py * hw}`, fill: color }, grp);
    if (label != null) {
      const lx = x1 + dx * 0.5, ly = y1 + dy * 0.5;
      g('circle', { cx: lx, cy: ly, r: 21, fill: color, stroke: '#111', 'stroke-width': 2 }, grp);
      g('text', { x: lx, y: ly + 8, 'text-anchor': 'middle', class: 'arrow-label' }, grp).textContent = label;
    }
  }
}
