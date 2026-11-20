import fs from 'fs';
import { Chess } from '../vendor/chess/chess.js';
import { encodeBoard, legalMoveIndices } from '../js/maia-encode.js';
const ref = JSON.parse(fs.readFileSync(new URL('./ref_encode.json', import.meta.url)));
let bad = 0;
for (const r of ref) {
  const c = new Chess(r.fen);
  const t = encodeBoard(c);
  const nz = [...t.keys()].filter((i) => t[i] === 1);
  const legal = legalMoveIndices(c).map((l) => l.idx).sort((a, b) => a - b);
  if (JSON.stringify(nz) !== JSON.stringify(r.nz) || JSON.stringify(legal) !== JSON.stringify(r.legal)) { bad++; console.log('MISMATCH', r.fen); }
}
console.log(`${ref.length - bad}/${ref.length} positions match the reference encoding`);
process.exit(bad ? 1 : 0);
