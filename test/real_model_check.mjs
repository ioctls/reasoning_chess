// Runs the real Maia-3 model through the app's own JS encoding (js/maia-encode.js) with
// onnxruntime-node, compares with the Python reference, and checks the moves look human.
import fs from 'fs';
import * as ort from 'onnxruntime-node';
import { Chess } from '../vendor/chess/chess.js';
import { encodeBoard, legalMoveIndices, legalPolicy } from '../js/maia-encode.js';
const model = process.argv[2] || 'models/maia3-5m.fp16.onnx';
const ref = JSON.parse(fs.readFileSync(process.argv[3] || 'ref.json', 'utf8'));
const s = await ort.InferenceSession.create(model, { graphOptimizationLevel: 'basic' }); // same as the app
let bad = 0;
for (const r of ref) {
  const c = new Chess(r.fen);
  const out = await s.run({
    tokens: new ort.Tensor('float32', encodeBoard(c), [1, 64, 12]),
    elo_self: new ort.Tensor('float32', Float32Array.from([1500]), [1]),
    elo_oppo: new ort.Tensor('float32', Float32Array.from([1500]), [1]),
  });
  const top = legalPolicy(out.logits_move.data, legalMoveIndices(c)).slice(0, 3).map((m) => [m.uci, +m.p.toFixed(4)]);
  const same = top.every((t, i) => t[0] === r.top[i][0] && Math.abs(t[1] - r.top[i][1]) < 2e-3);
  if (!same) bad++;
  console.log(same ? 'match' : 'MISMATCH', r.fen.split(' ').slice(0, 2).join(' '), 'js', JSON.stringify(top), 'py', JSON.stringify(r.top));
}
// Sanity: from the start position a 1500 player plays a normal opening move.
if (!['e2e4', 'd2d4', 'g1f3', 'c2c4'].includes(ref[0].top[0][0])) { console.log('Start position top move looks wrong:', ref[0].top[0]); bad++; }
// After 1.e4, Black's most common replies.
if (!['e7e5', 'c7c5', 'e7e6', 'c7c6', 'd7d5', 'd7d6', 'g8f6'].includes(ref[1].top[0][0])) { console.log('Reply to 1.e4 looks wrong:', ref[1].top[0]); bad++; }
console.log(bad ? `${bad} problem(s)` : 'real Maia-3 model: JS encoding matches Python and predictions look human');
process.exit(bad ? 1 : 0);
