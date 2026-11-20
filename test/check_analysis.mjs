import { describeMove, forcingMoves, hangingPieces, boardFromFen, sqName } from '../js/analysis.js';
const cases = [
  ['r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', 'Nc7+', ['check','fork']],
  ['r1bqkbnr/ppp2ppp/2np4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 4', 'Bb5', ['pin']],
  ['r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3', 'Qh5', ['matethreat']],
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'Nf3', ['develop']],
  ['4k3/8/8/8/8/8/4q3/R3K2R w KQ - 0 1', 'Kxe2', ['win']],
  ['4k3/4r3/8/8/8/8/4Q3/4K3 w - - 0 1', 'Qe6', []],
  ['3qk3/8/8/8/8/8/8/3RK2B w - - 0 1', 'Bd5', []],
];
let bad=0;
for (const [fen, mv, want] of cases) {
  const d = describeMove(fen, mv);
  const kinds = d.tags.map(t=>t.kind);
  const ok = want.every(k=>kinds.includes(k));
  if(!ok) bad++;
  console.log(ok?'ok ':'BAD', mv.padEnd(5), kinds.join(','), '|', d.tags.map(t=>t.text).join(' '));
}
console.log(forcingMoves('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3'));
console.log(hangingPieces(boardFromFen('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1'),'b').map(sqName));
process.exit(bad?1:0)
