// Maia-3 input/output encoding, ported from CSSLab/maia3 (maia3/dataset.py, maia3/utils.py).
//
// The model always "sees" the board from the side to move:
//   - If Black is to move, the board is flipped vertically and colors swapped,
//     so the mover's pieces always occupy channels 0-5 and move "up" the board.
//   - Squares are indexed a1=0 ... h8=63 (rank * 8 + file), like python-chess.
//   - Move vocabulary: 64*64 from/to pairs (index = from*64 + to) followed by
//     256 promotion entries (from-file x to-file x [q,r,b,n]), always rank 7 -> 8.

const PIECE_INDEX = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
const PROMO_ORDER = 'qrbn';
const FILES = 'abcdefgh';

export const VOCAB_SIZE = 64 * 64 + 8 * 8 * 4; // 4352

function sqIndex(name) {
  return (Number(name[1]) - 1) * 8 + FILES.indexOf(name[0]);
}

function mirrorSquareName(name) {
  return name[0] + String(9 - Number(name[1]));
}

export function mirrorUci(uci) {
  return mirrorSquareName(uci.slice(0, 2)) + mirrorSquareName(uci.slice(2, 4)) + uci.slice(4);
}

/** Board -> Float32Array(64 * 12), side-to-move perspective. `chess` is a chess.js instance. */
export function encodeBoard(chess) {
  const tokens = new Float32Array(64 * 12);
  const blackToMove = chess.turn() === 'b';
  const rows = chess.board(); // rows[0] is rank 8
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = rows[r][f];
      if (!piece) continue;
      let rank = 7 - r; // 0-based rank, rank 1 = 0
      let isMover = piece.color === chess.turn();
      if (blackToMove) rank = 7 - rank;
      const sq = rank * 8 + f;
      // After mirroring, the mover's pieces are "white" (channels 0-5).
      const channel = PIECE_INDEX[piece.type] + (isMover ? 0 : 6);
      tokens[sq * 12 + channel] = 1;
    }
  }
  return tokens;
}

/** UCI move in the side-to-move frame -> vocabulary index. */
export function moveIndex(uciMoverFrame) {
  if (uciMoverFrame.length > 4) {
    const ff = FILES.indexOf(uciMoverFrame[0]);
    const tf = FILES.indexOf(uciMoverFrame[2]);
    return 4096 + (ff * 8 + tf) * 4 + PROMO_ORDER.indexOf(uciMoverFrame[4]);
  }
  return sqIndex(uciMoverFrame.slice(0, 2)) * 64 + sqIndex(uciMoverFrame.slice(2, 4));
}

export function uciOf(move) {
  return move.from + move.to + (move.promotion || '');
}

/** All legal moves with their vocabulary index. */
export function legalMoveIndices(chess) {
  const blackToMove = chess.turn() === 'b';
  return chess.moves({ verbose: true }).map((m) => {
    const uci = uciOf(m);
    return { move: m, uci, idx: moveIndex(blackToMove ? mirrorUci(uci) : uci) };
  });
}

/** Softmax over legal moves only (illegal logits are ignored, as in maia3/uci.py). */
export function legalPolicy(logits, legal, offset = 0) {
  let max = -Infinity;
  for (const l of legal) max = Math.max(max, logits[offset + l.idx]);
  let sum = 0;
  const out = legal.map((l) => {
    const e = Math.exp(logits[offset + l.idx] - max);
    sum += e;
    return { ...l, p: e };
  });
  out.forEach((o) => (o.p /= sum));
  return out.sort((a, b) => b.p - a.p);
}

/** [loss, draw, win] logits for the side to move -> probabilities. */
export function wdlFromLogits(v, offset = 0) {
  const a = [v[offset], v[offset + 1], v[offset + 2]];
  const m = Math.max(...a);
  const e = a.map((x) => Math.exp(x - m));
  const s = e[0] + e[1] + e[2];
  return { loss: e[0] / s, draw: e[1] / s, win: e[2] / s };
}
