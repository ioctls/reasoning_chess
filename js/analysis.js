// Deterministic, explainable chess analysis.
// Nothing here "guesses": every explanation is derived from board geometry
// (who attacks what) plus engine facts passed in from Stockfish.

import { Chess } from '../vendor/chess/chess.js';

export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const FILES = 'abcdefgh';

export const sqName = (i) => FILES[i % 8] + (Math.floor(i / 8) + 1);
export const sqIdx = (n) => (Number(n[1]) - 1) * 8 + FILES.indexOf(n[0]);

/** FEN -> 64-array of {c, t} or null, index a1 = 0. */
export function boardFromFen(fen) {
  const b = new Array(64).fill(null);
  const rows = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      const c = ch === ch.toUpperCase() ? 'w' : 'b';
      b[(7 - r) * 8 + f] = { c, t: ch.toLowerCase() };
      f++;
    }
  }
  return b;
}

const KN = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KG = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Squares attacked by the piece standing on `sq` (ignores pins; that's what "attack" means). */
export function attacksFrom(board, sq) {
  const p = board[sq];
  if (!p) return [];
  const f0 = sq % 8, r0 = Math.floor(sq / 8);
  const out = [];
  const add = (f, r) => { if (f >= 0 && f < 8 && r >= 0 && r < 8) out.push(r * 8 + f); };
  const slide = (dirs) => {
    for (const [df, dr] of dirs) {
      let f = f0 + df, r = r0 + dr;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        out.push(r * 8 + f);
        if (board[r * 8 + f]) break;
        f += df; r += dr;
      }
    }
  };
  switch (p.t) {
    case 'p': { const d = p.c === 'w' ? 1 : -1; add(f0 - 1, r0 + d); add(f0 + 1, r0 + d); break; }
    case 'n': KN.forEach(([a, b]) => add(f0 + a, r0 + b)); break;
    case 'k': KG.forEach(([a, b]) => add(f0 + a, r0 + b)); break;
    case 'b': slide(DIAG); break;
    case 'r': slide(ORTH); break;
    case 'q': slide(DIAG); slide(ORTH); break;
  }
  return out;
}

export function attackersOf(board, sq, color) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    if (board[i] && board[i].c === color && attacksFrom(board, i).includes(sq)) out.push(i);
  }
  return out;
}

/** Net control per square: +n means White attacks it n more times than Black. */
export function controlMap(board) {
  const m = new Array(64).fill(0);
  for (let i = 0; i < 64; i++) {
    if (!board[i]) continue;
    const s = board[i].c === 'w' ? 1 : -1;
    for (const t of attacksFrom(board, i)) m[t] += s;
  }
  return m;
}

/**
 * A piece is "loose" if it can be taken for profit right now:
 * attacked and undefended, or attacked by something cheaper.
 */
export function isHanging(board, sq) {
  const p = board[sq];
  if (!p || p.t === 'k') return false;
  const enemy = p.c === 'w' ? 'b' : 'w';
  const att = attackersOf(board, sq, enemy);
  if (!att.length) return false;
  const def = attackersOf(board, sq, p.c);
  const cheapest = Math.min(...att.map((a) => VALUE[board[a].t]));
  return def.length === 0 || cheapest < VALUE[p.t];
}

export function hangingPieces(board, color) {
  const out = [];
  for (let i = 0; i < 64; i++) if (board[i] && board[i].c === color && isHanging(board, i)) out.push(i);
  return out;
}

/** Same position, but the other side to move (a "free move"). null if illegal. */
export function nullMoveFen(fen) {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  const f = parts.join(' ');
  try {
    const c = new Chess(f);
    // If the side that would *not* move is in check, the position is illegal.
    const flipBack = new Chess(fen);
    if (flipBack.inCheck()) return null;
    return c.fen();
  } catch { return null; }
}

export function mateInOne(fen) {
  let c;
  try { c = new Chess(fen); } catch { return null; }
  for (const m of c.moves({ verbose: true })) {
    c.move(m);
    const mate = c.isCheckmate();
    c.undo();
    if (mate) return m;
  }
  return null;
}

const pname = (board, sq) => `${NAME[board[sq].t]} on ${sqName(sq)}`;

/**
 * Explain a single move: which ideas does it contain?
 * Returns { tags: [{kind, text, squares}], san, after }.
 */
export function describeMove(fen, move) {
  const c = new Chess(fen);
  const m = c.move(move);
  if (!m) return null;
  const before = boardFromFen(fen);
  const after = boardFromFen(c.fen());
  const me = m.color, them = me === 'w' ? 'b' : 'w';
  const to = sqIdx(m.to), from = sqIdx(m.from);
  const mover = after[to];
  const tags = [];
  const add = (kind, text, squares = []) => tags.push({ kind, text, squares });

  if (c.isCheckmate()) { add('mate', 'Checkmate.', [to]); return { tags, san: m.san, after: c.fen() }; }

  // Material
  if (m.captured) {
    const victimSq = m.flags.includes('e') ? sqIdx(m.to[0] + m.from[1]) : to;
    const recapturable = attackersOf(after, to, them).length > 0;
    const gain = VALUE[m.captured] - (recapturable ? VALUE[m.piece] : 0);
    if (!recapturable || gain > 0) add('win', `Wins the ${NAME[m.captured]}${recapturable ? ' (even after the recapture)' : ' for free'}.`, [victimSq]);
    else if (VALUE[m.captured] === VALUE[m.piece]) add('trade', `Trades ${NAME[m.piece]} for ${NAME[m.captured]}.`, [to]);
    else add('capture', `Takes the ${NAME[m.captured]}.`, [to]);
  }
  if (m.promotion) add('promo', `Promotes to a ${NAME[m.promotion]}.`, [to]);
  if (c.inCheck()) add('check', 'Check — they must respond to it.', [sqIdx(c.board().flat().find((p) => p && p.type === 'k' && p.color === them).square)]);

  // Fork: the moved piece hits two or more targets worth hitting.
  const hits = attacksFrom(after, to).filter((s) => after[s] && after[s].c === them);
  const juicy = hits.filter((s) => after[s].t === 'k' || VALUE[after[s].t] > VALUE[mover.t] || attackersOf(after, s, them).length === 0);
  if (juicy.length >= 2) {
    add('fork', `Fork: the ${NAME[mover.t]} attacks the ${juicy.map((s) => pname(after, s)).join(' and the ')} at once — they can only save one.`, [to, ...juicy]);
  }

  // Pins and skewers along the moved piece's lines.
  if ('brq'.includes(mover.t)) {
    const dirs = mover.t === 'b' ? DIAG : mover.t === 'r' ? ORTH : [...DIAG, ...ORTH];
    for (const [df, dr] of dirs) {
      let f = (to % 8) + df, r = Math.floor(to / 8) + dr, first = null;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        const s = r * 8 + f;
        if (after[s]) {
          if (after[s].c !== them) break;
          if (first === null) first = s;
          else {
            const front = after[first], back = after[s];
            // Not a real pin/skewer if the front piece can simply take our piece.
            if (attacksFrom(after, first).includes(to)) break;
            if (front.t !== 'p' && VALUE[back.t] > VALUE[front.t] && VALUE[back.t] > VALUE[mover.t]) {
              add('pin', `Pin: the ${pname(after, first)} can't move without exposing the ${pname(after, s)}.`, [to, first, s]);
            } else if (VALUE[front.t] > VALUE[back.t] && (front.t === 'k' || front.t === 'q')) {
              add('skewer', `Skewer: the ${pname(after, first)} must move, and then the ${pname(after, s)} falls.`, [to, first, s]);
            }
            break;
          }
        }
        f += df; r += dr;
      }
    }
  }

  // Discovered attack: moving this piece opened a line for another one.
  for (let i = 0; i < 64; i++) {
    if (i === to || !after[i] || after[i].c !== me || !'brq'.includes(after[i].t)) continue;
    const was = new Set(attacksFrom(before, i));
    const newly = attacksFrom(after, i).filter((s) => !was.has(s) && after[s] && after[s].c === them && (after[s].t === 'k' || isHanging(after, s)));
    if (newly.length) add('discovered', `Discovered attack: moving away uncovers the ${pname(after, i)}, which now hits the ${pname(after, newly[0])}.`, [i, newly[0]]);
  }

  // New threats: enemy pieces that became loose because of this move.
  const looseBefore = new Set(hangingPieces(before, them));
  const looseNow = hangingPieces(after, them).filter((s) => !looseBefore.has(s) && !juicy.includes(s));
  if (looseNow.length && !tags.some((t) => t.kind === 'fork' || t.kind === 'discovered')) {
    add('threat', `Threatens the ${looseNow.map((s) => pname(after, s)).join(' and the ')}.`, looseNow);
  }

  // Mate threat: if they did nothing, could we mate next move?
  if (!c.inCheck()) {
    const nm = nullMoveFen(c.fen());
    const mate = nm && mateInOne(nm);
    if (mate) add('matethreat', `Sets up a mate threat: if they ignore it, ${mate.san} is checkmate.`, [sqIdx(mate.from), sqIdx(mate.to)]);
  }

  // Defence: our loose pieces that are now safe.
  const mineLooseBefore = hangingPieces(before, me).filter((s) => s !== from);
  const mineLooseAfter = new Set(hangingPieces(after, me));
  const saved = mineLooseBefore.filter((s) => !mineLooseAfter.has(s) && after[s] && after[s].c === me);
  if (isHanging(before, from) && !isHanging(after, to)) add('escape', `Moves the attacked ${NAME[m.piece]} to safety.`, [to]);
  if (saved.length) add('defend', `Protects the ${saved.map((s) => pname(after, s)).join(' and the ')}.`, saved);

  // Downside: did we leave something loose?
  const exposed = [...mineLooseAfter].filter((s) => !mineLooseBefore.includes(s));
  if (exposed.length) add('weak', `Leaves the ${exposed.map((s) => pname(after, s)).join(' and the ')} loose.`, exposed);

  // Quiet, positional ideas (only if nothing sharper was found).
  if (!tags.some((t) => t.kind !== 'weak')) {
    if (m.flags.includes('k') || m.flags.includes('q')) add('castle', 'Castles: the king gets safe and a rook joins the game.', [to]);
    else if ('nb'.includes(m.piece) && (m.from[1] === (me === 'w' ? '1' : '8'))) add('develop', `Develops the ${NAME[m.piece]} — another piece joins the fight.`, [to]);
    else if (m.piece === 'p' && ['d4', 'e4', 'd5', 'e5', 'c4', 'c5', 'f4', 'f5'].includes(m.to)) add('center', 'Grabs space in the center.', [to]);
    else {
      const mob = (b, s) => attacksFrom(b, s).length;
      const gain = mob(after, to) - mob(before, from);
      const enemyK = after.findIndex((p) => p && p.t === 'k' && p.c === them);
      const dist = (a, b) => Math.max(Math.abs((a % 8) - (b % 8)), Math.abs(Math.floor(a / 8) - Math.floor(b / 8)));
      if (m.piece !== 'p' && m.piece !== 'k' && dist(to, enemyK) < dist(from, enemyK) && dist(to, enemyK) <= 3) add('attack', `Brings the ${NAME[m.piece]} closer to their king.`, [to]);
      else if (gain >= 2) add('activate', `Activates the ${NAME[m.piece]}: it now controls ${mob(after, to)} squares instead of ${mob(before, from)}.`, [to]);
      else add('quiet', 'A quiet improving move.', [to]);
    }
  }
  return { tags, san: m.san, after: c.fen() };
}

/** Engine score (side-to-move, centipawns or mate) -> win chance 0..100 for the side to move. */
export function winChance(score) {
  if (!score) return 50;
  if (score.mate != null) return score.mate > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * score.cp)) - 1);
}

export function verdict(lossPct, isBest) {
  if (isBest || lossPct <= 2) return { key: 'best', label: 'Excellent', tone: 'good' };
  if (lossPct <= 5) return { key: 'good', label: 'Good', tone: 'good' };
  if (lossPct <= 10) return { key: 'inacc', label: 'Inaccuracy', tone: 'meh' };
  if (lossPct <= 20) return { key: 'mistake', label: 'Mistake', tone: 'bad' };
  return { key: 'blunder', label: 'Blunder', tone: 'bad' };
}

/**
 * Where does a move sit between "what humans do" and "what's good"?
 * humanP: Maia probability at your level (null if unavailable).
 */
export function humanQuadrant(humanP, lossPct) {
  if (humanP == null) return null;
  const good = lossPct <= 5, common = humanP >= 0.12;
  if (good && !common) return { key: 'gem', label: 'Hidden gem', text: `Only ${pct(humanP)} of players at this level find this. That gap is exactly what training closes.` };
  if (good && common) return { key: 'natural', label: 'Natural', text: `${pct(humanP)} of players at this level play this — your instincts are on track here.` };
  if (!good && common) return { key: 'trap', label: 'Common trap', text: `${pct(humanP)} of players at this level play this too. It *looks* right, which is why it's worth learning.` };
  return { key: 'offtrack', label: 'Off-track', text: `Only ${pct(humanP)} of players at this level would play this.` };
}

export const pct = (p) => (p >= 0.995 ? '99%' : p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`);

/** Checks, captures and threats available to the side to move — the "forcing moves" scan. */
export function forcingMoves(fen) {
  const c = new Chess(fen);
  const out = { checks: [], captures: [], threats: [] };
  for (const m of c.moves({ verbose: true })) {
    if (m.san.includes('+') || m.san.includes('#')) out.checks.push(m.san);
    else if (m.captured) out.captures.push(m.san);
    else {
      const d = describeMove(fen, m);
      if (d && d.tags.some((t) => ['fork', 'threat', 'matethreat', 'discovered', 'pin', 'skewer'].includes(t.kind))) out.threats.push(m.san);
    }
  }
  return out;
}

/** Simple style features of a move, used for the play-style profile. */
export function moveFeatures(fen, move) {
  const d = describeMove(fen, move);
  if (!d) return null;
  const kinds = new Set(d.tags.map((t) => t.kind));
  const c = new Chess(fen);
  const m = c.move(move);
  return {
    forcing: kinds.has('check') || kinds.has('win') || kinds.has('capture') || kinds.has('mate'),
    threat: ['fork', 'threat', 'matethreat', 'discovered', 'pin', 'skewer'].some((k) => kinds.has(k)),
    attack: kinds.has('attack') || kinds.has('matethreat') || kinds.has('check'),
    trade: kinds.has('trade'),
    pawn: m.piece === 'p',
    defensive: kinds.has('defend') || kinds.has('escape'),
    loosens: kinds.has('weak'),
    kinds: [...kinds],
  };
}
