// What kind of mistake was it? Each costly move gets one issue, so drills can target it.

export const ISSUES = {
  hung:    { label: 'Left a piece hanging', tip: 'Before letting go of a piece, ask: is anything of mine now attacked and not defended enough?' },
  threat:  { label: 'Missed their threat', tip: 'Their last move wanted something. Find out what before you make your own plan.' },
  king:    { label: 'King safety', tip: 'Your king got exposed. Count their pieces near it before grabbing material or attacking.' },
  tactic:  { label: 'Missed a tactic', tip: 'There was a forcing win. Scan checks, captures and threats first, every move.' },
  free:    { label: 'Missed free material', tip: 'Something of theirs was loose. Look at what each of your pieces can take.' },
  plan:    { label: 'Positional slip', tip: 'No single trick here. The move just made your position worse. Compare how active your pieces are.' },
};

const TACTICS = ['fork', 'pin', 'skewer', 'discovered', 'matethreat', 'mate', 'promo'];
const kinds = (d) => new Set(d ? d.tags.map((t) => t.kind) : []);

/**
 * mine / best / refute: describeMove() results for your move, the best move,
 * and their best reply to your move. threatUci: their "free move" threat before you moved, if any.
 */
export function classifyIssue({ mine, best, refute, refuteUci, threatUci }) {
  const r = kinds(refute), m = kinds(mine), b = kinds(best);
  if (r.has('mate') || r.has('matethreat')) return 'king';
  if (threatUci && refuteUci === threatUci) return 'threat';
  if (m.has('weak') || r.has('win') || r.has('fork') || r.has('skewer')) return 'hung';
  if (TACTICS.some((k) => b.has(k))) return 'tactic';
  if (b.has('win') || b.has('capture')) return 'free';
  return 'plan';
}

/** Older drills (saved before issues existed) get an issue from the best move's ideas. */
export function issueOfDrill(d) {
  if (d.issue) return d.issue;
  const b = new Set(d.kinds || []);
  if (TACTICS.some((k) => b.has(k))) return 'tactic';
  if (b.has('win') || b.has('capture')) return 'free';
  return 'plan';
}
