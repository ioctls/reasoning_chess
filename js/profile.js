// Your play-style profile and mistake drills, stored on this device (localStorage).

const KEY = 'chessgym.profile.v1';
export const ELO_GRID = [600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400];

const blank = () => ({
  games: 0,
  moves: [],          // { mine: features, best: features, loss, humanP }
  quiz: { right: 0, total: 0, streak: 0, best: 0 },
  eloLL: Object.fromEntries(ELO_GRID.map((e) => [e, 0])),
  eloN: 0,
  drills: [],         // { id, fen, best, bestSan, kinds, mySan, box, due }
});

export function loadProfile() {
  try { return { ...blank(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return blank(); }
}
export function saveProfile(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}
export function resetProfile() { const p = blank(); saveProfile(p); return p; }

export function recordMove(p, rec) {
  p.moves.push(rec);
  if (p.moves.length > 600) p.moves.splice(0, p.moves.length - 600);
}

export function recordEloEvidence(p, probs) {
  ELO_GRID.forEach((e, i) => { p.eloLL[e] += Math.log(Math.max(probs[i], 1e-6)); });
  p.eloN++;
}

/** Posterior over ratings: which Maia level is most likely to have played your moves? */
export function eloPosterior(p) {
  const ll = ELO_GRID.map((e) => p.eloLL[e] || 0);
  const m = Math.max(...ll);
  const w = ll.map((x) => Math.exp(x - m));
  const s = w.reduce((a, b) => a + b, 0);
  const post = w.map((x) => x / s);
  const mean = ELO_GRID.reduce((a, e, i) => a + e * post[i], 0);
  return { post, mean, n: p.eloN };
}

export const STYLE_AXES = [
  { key: 'forcing', label: 'Forcing moves', hint: 'checks & captures' },
  { key: 'threat', label: 'Creating threats', hint: 'forks, pins, attacks on loose pieces' },
  { key: 'attack', label: 'King pressure', hint: 'moves aimed at their king' },
  { key: 'trade', label: 'Trading pieces', hint: 'even swaps' },
  { key: 'pawn', label: 'Pawn moves', hint: 'share of pawn moves' },
  { key: 'defensive', label: 'Defending', hint: 'saving or guarding pieces' },
  { key: 'loosens', label: 'Leaving pieces loose', hint: 'lower is better' },
];

/** Compare how often you do X with how often the best move does X, in the same positions. */
export function styleSummary(p) {
  const n = p.moves.length;
  const axes = STYLE_AXES.map((a) => {
    const you = n ? p.moves.filter((m) => m.mine && m.mine[a.key]).length / n : 0;
    const eng = n ? p.moves.filter((m) => m.best && m.best[a.key]).length / n : 0;
    return { ...a, you, eng };
  });
  const missed = {};
  for (const m of p.moves) {
    if (m.loss <= 5 || !m.best) continue;
    for (const k of m.best.kinds) {
      if (['quiet', 'weak', 'develop', 'center', 'activate'].includes(k)) continue;
      missed[k] = (missed[k] || 0) + 1;
    }
  }
  const avgLoss = n ? p.moves.reduce((a, m) => a + m.loss, 0) / n : 0;
  return { n, axes, missed, avgLoss };
}

export function addDrill(p, d) {
  if (p.drills.some((x) => x.fen === d.fen)) return;
  p.drills.push({ id: Date.now() + Math.random(), box: 0, due: Date.now(), ...d });
  if (p.drills.length > 200) p.drills.shift();
}

export function dueDrills(p) {
  const now = Date.now();
  return p.drills.filter((d) => d.due <= now).sort((a, b) => a.box - b.box || a.due - b.due);
}

/** Leitner-style spacing: right answers push the card out 1, 3, 7, 15... days. */
export function gradeDrill(p, id, correct) {
  const d = p.drills.find((x) => x.id === id);
  if (!d) return;
  d.box = correct ? d.box + 1 : 0;
  const days = correct ? 2 ** d.box - 1 : 0;
  d.due = Date.now() + days * 864e5 + (correct ? 0 : 60e3);
}
