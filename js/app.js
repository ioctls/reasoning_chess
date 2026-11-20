import { Chess } from '../vendor/chess/chess.js';
import { Board } from './board.js';
import { Stockfish } from './engine.js';
import { Maia, sampleHuman, DEFAULT_MODEL_URL } from './maia.js';
import {
  boardFromFen, controlMap, hangingPieces, attackersOf, VALUE, describeMove, winChance, verdict,
  humanQuadrant, pct, forcingMoves, moveFeatures, nullMoveFen, sqIdx, sqName, NAME,
} from './analysis.js';
import {
  loadProfile, saveProfile, resetProfile, recordMove, recordEloEvidence, eloPosterior, styleSummary,
  addDrill, dueDrills, gradeDrill, ELO_GRID,
} from './profile.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THREAT_KINDS = ['win', 'mate', 'matethreat', 'fork', 'check', 'threat', 'pin', 'skewer', 'discovered'];
const IDEA_NAMES = { fork: 'a fork', pin: 'a pin', skewer: 'a skewer', discovered: 'a discovered attack', matethreat: 'a mate threat', mate: 'checkmate', win: 'winning material', check: 'a forcing check', threat: 'an attack on a loose piece', promo: 'promotion', defend: 'defending', escape: 'saving a piece', castle: 'king safety', develop: 'development', center: 'the center', attack: 'king pressure', activate: 'piece activity', trade: 'a trade', capture: 'a capture', quiet: 'a quiet improvement' };

// ---------- settings ----------
const SKEY = 'chessgym.settings.v1';
const settings = Object.assign(
  { myElo: 1200, oppElo: 1200, color: 'w', depth: 12, quiz: true, modelUrl: DEFAULT_MODEL_URL, layers: { threats: true, control: false, plan: false, humans: false } },
  JSON.parse(localStorage.getItem(SKEY) || '{}'),
);
const saveSettings = () => localStorage.setItem(SKEY, JSON.stringify(settings));

// ---------- state ----------
const engine = new Stockfish();
const maia = new Maia();
let profile = loadProfile();
const st = {
  mode: 'game',        // 'game' | 'drill'
  game: new Chess(),
  myColor: 'w',
  busy: false,
  token: 0,            // bumps whenever the position changes; stale async results are dropped
  analysis: null, analysisP: null,
  human: null,
  selected: null, targets: [],
  hint: 0,
  quiz: null,          // { fen, key:Set, text, answered, correct }
  opp: null,           // { fenBefore, uci, san, idea }
  review: null,
  preview: null,       // { fens, pv, sans, idx, notes }
  drill: null, drillResult: null,
  verdicts: [],        // per ply index
  modelMsg: null,
};

const board = new Board($('#board'), { onSquareTap });

// ---------- engine helpers ----------
function analyseCurrent() {
  const fen = st.game.fen();
  if (st.analysisP && st.analysisP.fen === fen) return st.analysisP.p;
  const p = engine.analyse(fen, { depth: settings.depth, multipv: 3 }).then((a) => {
    const res = { fen, ...a };
    if (st.game.fen() === fen) { st.analysis = res; refresh(); renderCoach(); }
    return res;
  });
  st.analysisP = { fen, p };
  return p;
}

// ---------- game flow ----------
function newGame() {
  st.mode = 'game';
  st.drill = null; st.drillResult = null;
  st.game = new Chess();
  st.myColor = settings.color === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : settings.color;
  st.review = null; st.opp = null; st.preview = null; st.verdicts = [];
  board.orientation = st.myColor;
  profile.games++; saveProfile(profile);
  if (st.myColor === 'w') startMyTurn(); else opponentMove();
}

function resetTurnState() {
  st.token++;
  st.analysis = null; st.human = null; st.hint = 0; st.quiz = null;
  st.selected = null; st.targets = [];
}

async function startMyTurn() {
  resetTurnState();
  st.busy = false;
  const tok = st.token;
  const fen = st.game.fen();
  refresh(); renderCoach();
  if (st.game.isGameOver()) return endGame();
  analyseCurrent();
  if (maia.ready) {
    maia.predict(st.game, settings.myElo, settings.oppElo).then((h) => {
      if (tok !== st.token) return;
      st.human = { fen, ...h }; refresh(); renderCoach();
    }).catch((e) => console.warn('maia', e));
  }
  if (st.opp && st.mode === 'game') await buildThreatQuiz(tok);
}

/** What does the opponent's last move threaten? Uses a "free move" for them + the geometry tagger. */
async function buildThreatQuiz(tok) {
  const o = st.opp;
  const key = new Set();
  const notes = [];
  const myMove = describeMove(o.fenBefore, o.uci);
  if (st.game.inCheck()) { o.idea = { text: `${o.san} gives check.`, arrows: [] }; renderCoach(); return; }
  for (const t of myMove.tags) if (THREAT_KINDS.includes(t.kind) && t.kind !== 'check') { t.squares.forEach((s) => key.add(sqName(s))); notes.push(t.text); }
  // Free move: if they could move again, what would they do?
  let arrows = [];
  const nf = nullMoveFen(st.game.fen());
  if (nf) {
    const a = await engine.analyse(nf, { depth: Math.min(10, settings.depth) });
    if (tok !== st.token) return;
    const nb = a.best;
    if (nb) {
      const d = describeMove(nf, nb);
      const serious = d && d.tags.some((t) => ['win', 'mate', 'fork', 'matethreat', 'skewer', 'discovered'].includes(t.kind));
      if (serious) {
        key.add(nb.slice(2, 4)); key.add(nb.slice(0, 2));
        notes.push(`If you ignore it: ${d.san} — ${d.tags.filter((t) => t.kind !== 'weak').map((t) => t.text).join(' ')}`);
        arrows = [{ from: nb.slice(0, 2), to: nb.slice(2, 4), color: 'var(--them)', dashed: true, width: 12, label: '!' }];
      }
    }
  }
  o.idea = { text: notes.length ? notes.join(' ') : `${o.san} doesn't create an immediate threat. Free to follow your own plan.`, arrows, key };
  if (settings.quiz && st.mode === 'game') st.quiz = { key, answered: false };
  refresh(); renderCoach();
}

function answerQuiz(answer) {
  const q = st.quiz;
  const correct = answer === 'none' ? q.key.size === 0 : q.key.has(answer);
  q.answered = true; q.correct = correct; q.pick = answer;
  profile.quiz.total++;
  if (correct) { profile.quiz.right++; profile.quiz.streak++; profile.quiz.best = Math.max(profile.quiz.best, profile.quiz.streak); }
  else profile.quiz.streak = 0;
  saveProfile(profile);
  refresh(); renderCoach();
}

function onSquareTap(sq) {
  if (st.preview) return;
  if (st.quiz && !st.quiz.answered) return answerQuiz(sq);
  if (st.busy || st.game.turn() !== st.myColor || st.game.isGameOver()) return;
  if (st.selected && st.targets.includes(sq)) return doMyMove(st.selected, sq);
  const p = st.game.get(sq);
  if (p && p.color === st.myColor) {
    st.selected = sq;
    st.targets = st.game.moves({ square: sq, verbose: true }).map((m) => m.to);
  } else { st.selected = null; st.targets = []; }
  refresh();
}

async function doMyMove(from, to) {
  const fenBefore = st.game.fen();
  const before = new Chess(fenBefore);
  let mv;
  try { mv = st.game.move({ from, to, promotion: 'q' }); } catch { return; }
  const uci = mv.from + mv.to + (mv.promotion || '');
  const ply = st.game.history().length - 1;
  const humanBefore = st.human && st.human.fen === fenBefore ? st.human : null;
  resetTurnState();
  st.busy = true; st.review = { pending: true, san: mv.san }; st.opp = null;
  refresh(); renderCoach();

  const pre = (st.analysisP && st.analysisP.fen === fenBefore) ? await st.analysisP.p : await engine.analyse(fenBefore, { depth: settings.depth, multipv: 3 });
  let myWin;
  let post = null;
  if (st.game.isCheckmate()) myWin = 100;
  else if (st.game.isDraw() || st.game.isStalemate()) myWin = 50;
  else { post = await engine.analyse(st.game.fen(), { depth: settings.depth }); myWin = 100 - winChance(post.lines[0]?.score); }
  const bestWin = winChance(pre.lines[0]?.score);
  const loss = Math.max(0, bestWin - myWin);
  const isBest = uci === pre.best;
  const v = verdict(loss, isBest);
  let humanP = null;
  if (humanBefore) humanP = (humanBefore.moves.find((m) => m.uci === uci) || { p: 0 }).p;
  else if (maia.ready) { try { const h = await maia.predict(before, settings.myElo, settings.oppElo); humanP = (h.moves.find((m) => m.uci === uci) || { p: 0 }).p; } catch { /* ignore */ } }
  const mine = describeMove(fenBefore, uci);
  const best = pre.best ? describeMove(fenBefore, pre.best) : null;
  const refute = loss > 5 && post && post.lines[0] ? describeMove(st.game.fen(), post.lines[0].pv[0]) : null;

  st.verdicts[ply] = v.key;
  st.review = { san: mv.san, uci, fenBefore, v, loss, myWin, humanP, quad: humanQuadrant(humanP, loss), mine, best, bestPv: pre.lines[0]?.pv || [], isBest, refute, refutePv: post?.lines[0]?.pv || [], fenAfter: st.game.fen() };

  if (st.mode === 'drill') return finishDrill(loss);

  // Learn about you.
  recordMove(profile, { mine: moveFeatures(fenBefore, uci), best: pre.best ? moveFeatures(fenBefore, pre.best) : null, loss, humanP });
  if (loss > 10 && best) addDrill(profile, { fen: fenBefore, best: pre.best, bestSan: best.san, kinds: best.tags.map((t) => t.kind), mySan: mv.san });
  if (maia.ready) {
    try { recordEloEvidence(profile, await maia.moveProbAcrossElos(before, uci, ELO_GRID, settings.oppElo)); } catch (e) { console.warn(e); }
  }
  saveProfile(profile);
  refresh(); renderCoach();
  if (st.game.isGameOver()) return endGame();
  await opponentMove();
}

async function opponentMove() {
  st.busy = true; st.thinking = true;
  refresh(); renderCoach();
  const fenBefore = st.game.fen();
  await sleep(450);
  let uci;
  try {
    if (maia.ready) {
      const h = await maia.predict(st.game, settings.oppElo, settings.myElo);
      uci = sampleHuman(h.moves).uci;
    } else uci = await engine.playMove(fenBefore, settings.oppElo);
  } catch (e) {
    console.warn('opponent fallback', e);
    uci = await engine.playMove(fenBefore, settings.oppElo);
  }
  const m = st.game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  st.opp = { fenBefore, uci, san: m.san };
  st.thinking = false;
  startMyTurn();
}

function endGame() {
  st.busy = false;
  refresh(); renderCoach();
}

function takeBack() {
  if (st.busy || st.mode !== 'game') return;
  const h = st.game.history();
  if (!h.length) return;
  st.game.undo();
  if (st.game.turn() !== st.myColor) st.game.undo();
  st.verdicts.length = st.game.history().length;
  st.review = null; st.opp = null; st.preview = null;
  if (st.game.turn() === st.myColor) startMyTurn(); else opponentMove();
}

// ---------- drills ----------
function startDrill() {
  const due = dueDrills(profile);
  st.mode = 'drill'; st.preview = null; st.review = null; st.opp = null; st.drillResult = null;
  if (!due.length) { st.drill = null; resetTurnState(); refresh(); renderCoach(); return; }
  st.drill = due[0];
  st.game = new Chess(st.drill.fen);
  st.myColor = st.game.turn();
  board.orientation = st.myColor;
  st.verdicts = [];
  startMyTurn();
}

function finishDrill(loss) {
  const correct = loss <= 5;
  gradeDrill(profile, st.drill.id, correct);
  saveProfile(profile);
  st.drillResult = { correct };
  st.busy = true; // board locked until "next"
  refresh(); renderCoach();
}

// ---------- idea preview ("show me what it's thinking") ----------
function openPreview(fen, pv, title) {
  const c = new Chess(fen);
  const fens = [fen], sans = [], notes = [];
  for (const u of pv.slice(0, 6)) {
    const f = c.fen();
    const d = describeMove(f, u);
    let m; try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { break; }
    sans.push(m.san);
    notes.push(d ? d.tags.filter((t) => t.kind !== 'quiet').map((t) => t.text).join(' ') : '');
    fens.push(c.fen());
  }
  st.preview = { fens, pv: pv.slice(0, sans.length), sans, notes, idx: 0, title, startColor: new Chess(fen).turn() };
  refresh(); renderCoach();
}

// ---------- rendering ----------
function overlaysFor(fen) {
  const ov = { arrows: [], rings: [], highlights: [] };
  const L = settings.layers;
  const b = boardFromFen(fen);
  if (L.control) ov.control = controlMap(b);

  if (st.preview) {
    const p = st.preview;
    p.pv.forEach((u, i) => {
      if (i < p.idx) return;
      const sideIsStart = i % 2 === 0;
      ov.arrows.push({ from: u.slice(0, 2), to: u.slice(2, 4), color: sideIsStart ? 'var(--plan-me)' : 'var(--plan-them)', label: i + 1, width: i === p.idx ? 18 : 10, opacity: i === p.idx ? 0.95 : 0.45 });
    });
    return ov;
  }

  const myTurn = st.game.turn() === st.myColor && !st.busy;
  if (L.threats) {
    for (const s of hangingPieces(b, st.myColor)) {
      ov.rings.push({ sq: sqName(s), color: 'var(--them)' });
      const att = attackersOf(b, s, st.myColor === 'w' ? 'b' : 'w').sort((x, y) => VALUE[b[x].t] - VALUE[b[y].t])[0];
      if (att != null) ov.arrows.push({ from: sqName(att), to: sqName(s), color: 'var(--them)', width: 8, opacity: 0.7 });
    }
    if (st.opp && st.opp.idea && (!st.quiz || st.quiz.answered)) ov.arrows.push(...st.opp.idea.arrows);
  }
  if (L.plan && st.analysis && st.analysis.fen === fen) {
    st.analysis.lines[0]?.pv.slice(0, 4).forEach((u, i) => ov.arrows.push({ from: u.slice(0, 2), to: u.slice(2, 4), color: i % 2 ? 'var(--plan-them)' : 'var(--plan-me)', label: i + 1, width: 11, opacity: 0.8 }));
  }
  if (L.humans && st.human && st.human.fen === fen) {
    st.human.moves.slice(0, 3).filter((m) => m.p >= 0.04).forEach((m) => ov.arrows.push({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), color: 'var(--human)', width: 6 + 26 * m.p, label: Math.round(m.p * 100), opacity: 0.75 }));
  }
  if (myTurn && st.hint >= 1) {
    const them = st.myColor === 'w' ? 'b' : 'w';
    for (const s of hangingPieces(b, them)) ov.rings.push({ sq: sqName(s), color: 'var(--hint)', dashed: true });
  }
  if (myTurn && st.analysis && st.analysis.fen === fen && st.analysis.best) {
    const best = st.analysis.best;
    if (st.hint >= 2) ov.highlights.push({ sq: best.slice(0, 2), color: 'var(--hint)', opacity: 0.55 });
    if (st.hint >= 4) ov.arrows.push({ from: best.slice(0, 2), to: best.slice(2, 4), color: 'var(--hint)', width: 16 });
  }
  return ov;
}

function refresh() {
  const fen = st.preview ? st.preview.fens[st.preview.idx] : st.game.fen();
  let lastMove = null;
  if (st.preview) { const u = st.preview.pv[st.preview.idx - 1]; if (u) lastMove = [u.slice(0, 2), u.slice(2, 4)]; }
  else { const h = st.game.history({ verbose: true }); const l = h[h.length - 1]; if (l) lastMove = [l.from, l.to]; }
  board.set({ fen, lastMove, selected: st.selected, targets: st.targets, overlays: overlaysFor(fen) });

  // Eval bar: your winning chances.
  let w = null;
  if (st.analysis && st.analysis.fen === st.game.fen() && st.analysis.lines[0]) {
    const stm = winChance(st.analysis.lines[0].score);
    w = st.game.turn() === st.myColor ? stm : 100 - stm;
  } else if (st.review && st.review.myWin != null) w = st.review.myWin;
  if (w != null) { $('#evalfill').style.height = `${w}%`; $('#evaltext').textContent = Math.round(w); }

  document.querySelectorAll('#layers .chip').forEach((c) => c.classList.toggle('on', !!settings.layers[c.dataset.layer]));
  $('#btn-undo').disabled = st.busy || st.mode !== 'game' || !st.game.history().length;
  $('#btn-hint').disabled = st.busy || !!st.preview || st.game.turn() !== st.myColor || st.game.isGameOver();
  $('#btn-new').textContent = st.mode === 'drill' ? 'Back to game' : 'New game';
  renderMoves();
}

function renderMoves() {
  if (st.mode === 'drill') { $('#moves').innerHTML = ''; return; }
  const h = st.game.history();
  const parts = [];
  for (let i = 0; i < h.length; i++) {
    const cls = { blunder: 'mv-blunder', mistake: 'mv-mistake', inacc: 'mv-inacc' }[st.verdicts[i]] || '';
    const sym = { blunder: '??', mistake: '?', inacc: '?!' }[st.verdicts[i]] || '';
    if (i % 2 === 0) parts.push(`<b>${i / 2 + 1}.</b>`);
    parts.push(`<span class="${cls}">${esc(h[i])}${sym}</span>`);
  }
  $('#moves').innerHTML = parts.join(' ');
}

function tagLine(desc, skip = []) {
  if (!desc) return '';
  return desc.tags.filter((t) => !skip.includes(t.kind)).map((t) => esc(t.text)).join(' ');
}

function renderCoach() {
  const el = $('#coach');
  const out = [];

  if (st.preview) {
    const p = st.preview;
    out.push(`<div class="card"><h3>👁 ${esc(p.title)}</h3>
      <p class="small muted">Green = the side to move, orange = the reply. Step through it and watch what each move <i>attacks</i>.</p>
      <ol class="idea-steps">${p.sans.map((s, i) => `<li class="${i === p.idx ? 'now' : i < p.idx ? '' : 'later'}"><b>${esc(s)}</b>${p.notes[i] ? ' — ' + esc(p.notes[i]) : ''}</li>`).join('')}</ol>
      <div class="row-btns"><button data-act="pv-prev" ${p.idx === 0 ? 'disabled' : ''}>◀</button><button data-act="pv-next" ${p.idx >= p.sans.length ? 'disabled' : ''}>▶ Play move</button><button data-act="pv-close" class="primary">Back to game</button></div></div>`);
    el.innerHTML = out.join('');
    return;
  }

  // Drill header
  if (st.mode === 'drill') {
    if (!st.drill) {
      out.push(`<div class="card"><h3>🏋️ Drills</h3><p>No drills due. Your mistakes from games land here automatically, then come back on a spaced schedule (1, 3, 7, 15 days…) until you find the right move every time.</p><div class="row-btns"><button data-act="back-game" class="primary">Play a game</button></div></div>`);
      el.innerHTML = out.join(''); return;
    }
    const left = dueDrills(profile).length;
    if (!st.drillResult) {
      out.push(`<div class="card"><h3>🏋️ Find the better move <span class="tag">${left} due</span></h3><p>In your game you played <b>${esc(st.drill.mySan)}</b> here. There's something much stronger. ${st.game.turn() === 'w' ? 'White' : 'Black'} to move.</p><p class="small muted">Use 💡 Hint for a nudge. Hints come in steps — take only what you need.</p></div>`);
    } else {
      const r = st.review;
      out.push(`<div class="card"><h3>${st.drillResult.correct ? '✅ Found it' : '❌ Not quite'} <span class="tag ${r.v.tone}">${esc(r.v.label)}</span></h3>
        ${st.drillResult.correct ? `<p>${tagLine(r.mine, ['weak']) || 'Good move.'}</p>` : `<p>The idea was <b>${esc(st.drill.bestSan)}</b>: ${tagLine(r.best, ['weak'])}</p>`}
        <p class="small muted">${st.drillResult.correct ? 'This one comes back later, spaced further out.' : 'This one comes back in a minute.'}</p>
        <div class="row-btns">${r.bestPv.length ? '<button data-act="idea-best">👁 Show the idea</button>' : ''}<button data-act="next-drill" class="primary">Next drill</button></div></div>`);
    }
  }

  // Threat check quiz
  if (st.quiz && !st.quiz.answered && st.opp) {
    out.push(`<div class="card"><h3>🛡 Threat check</h3><p>They played <b>${esc(st.opp.san)}</b>. Before you move: what is it after?</p><p class="small muted">Tap the piece or square they're targeting on the board.</p><div class="row-btns"><button data-act="quiz-none">Nothing serious</button><button data-act="quiz-skip">Skip</button></div></div>`);
  } else if (st.opp && st.opp.idea && st.mode === 'game') {
    const q = st.quiz;
    const head = q ? (q.correct ? `✅ Spotted <span class="tag good">streak ${profile.quiz.streak}</span>` : q.pick === 'skip' ? 'Their idea' : '❌ Missed it') : 'Their idea';
    out.push(`<div class="card"><h3>${head}</h3><p><b>${esc(st.opp.san)}</b>: ${esc(st.opp.idea.text)}</p></div>`);
  } else if (st.opp && st.mode === 'game' && settings.quiz && !st.game.isGameOver()) {
    out.push(`<div class="card"><p class="muted">They played <b>${esc(st.opp.san)}</b>. Spotting their idea…</p></div>`);
  }

  // Review of your last move
  const r = st.review;
  if (r && st.mode === 'game') {
    if (r.pending) out.push(`<div class="card"><p class="muted">Checking <b>${esc(r.san)}</b>…</p></div>`);
    else {
      const humanTag = r.quad ? `<span class="tag human">${esc(r.quad.label)}</span>` : '';
      let body = `<p>${tagLine(r.mine) || 'A quiet move.'}</p>`;
      if (r.quad) body += `<p class="small muted">${esc(r.quad.text).replace(/\*(.+?)\*/g, '<i>$1</i>')}</p>`;
      if (!r.isBest && r.best && r.loss > 2) body += `<p>Better: <b>${esc(r.best.san)}</b> — ${tagLine(r.best, ['weak']) || 'keeps more of your advantage.'}</p>`;
      if (r.refute) {
        const sharp = tagLine(r.refute, ['weak', 'quiet', 'develop', 'center', 'activate', 'castle']);
        body += sharp
          ? `<p>The problem: they can answer <b>${esc(r.refute.san)}</b>. ${sharp}</p>`
          : `<p>The problem isn't one tactic: it hands away ${Math.round(r.loss)}% of your winning chances. Their best reply is <b>${esc(r.refute.san)}</b>.</p>`;
      }
      const btns = [];
      if (!r.isBest && r.bestPv.length) btns.push('<button data-act="idea-best">👁 Show the better idea</button>');
      if (r.refute && r.refutePv.length) btns.push('<button data-act="idea-refute">👁 Show their punishment</button>');
      if (r.isBest && r.bestPv.length > 1) btns.push('<button data-act="idea-best">👁 Show where it leads</button>');
      out.push(`<div class="card"><h3>${esc(r.san)} <span class="tag ${r.v.tone}">${esc(r.v.label)}</span>${humanTag}</h3>${body}${btns.length ? `<div class="row-btns">${btns.join('')}</div>` : ''}</div>`);
    }
  }

  // Hints
  if (st.hint > 0 && st.game.turn() === st.myColor && !st.busy) {
    const a = st.analysis && st.analysis.fen === st.game.fen() ? st.analysis : null;
    if (!a) out.push('<div class="card"><p class="muted">💡 Still thinking…</p></div>');
    else {
      const items = [];
      const fm = forcingMoves(st.game.fen());
      items.push(`<b>Step 1 — scan forcing moves.</b> Checks: ${fm.checks.length}, captures: ${fm.captures.length}, threats: ${fm.threats.length}. Strong players look at these first, every move. ${hangingPieces(boardFromFen(st.game.fen()), st.myColor === 'w' ? 'b' : 'w').length ? 'Yellow rings = their loose pieces.' : ''}`);
      const best = a.best && describeMove(st.game.fen(), a.best);
      if (st.hint >= 2 && best) items.push(`<b>Step 2 — the piece.</b> The highlighted ${NAME[st.game.get(a.best.slice(0, 2)).type]} has the key move.`);
      if (st.hint >= 3 && best) {
        const k = best.tags.find((t) => t.kind !== 'weak');
        items.push(`<b>Step 3 — the idea.</b> Look for ${IDEA_NAMES[k?.kind] || 'an improving move'}.`);
      }
      if (st.hint >= 4 && best) items.push(`<b>Step 4 — the move.</b> ${esc(best.san)}: ${tagLine(best, ['weak'])} <button data-act="idea-now" class="small">👁 Show the line</button>`);
      out.push(`<div class="card"><h3>💡 Hint ${st.hint}/4</h3>${items.map((i) => `<p>${i}</p>`).join('')}</div>`);
    }
  }

  // Status
  if (st.game.isGameOver()) {
    let res = 'Draw.';
    if (st.game.isCheckmate()) res = st.game.turn() === st.myColor ? 'Checkmate — you lost this one.' : 'Checkmate — you win! 🎉';
    out.push(`<div class="card"><h3>${res}</h3><p class="small muted">Your mistakes from this game are now in Drills.</p><div class="row-btns"><button data-act="new" class="primary">New game</button><button data-act="drills">Go to drills</button></div></div>`);
  } else if (st.thinking) {
    out.push(`<div class="card"><p class="muted">${maia.ready ? `Maia ${settings.oppElo}` : `Stockfish (~${settings.oppElo})`} is thinking…</p></div>`);
  } else if (st.mode === 'game' && !st.busy && !st.game.history().length) {
    out.push(`<div class="card"><h3>Your move</h3><p class="small muted">After each move you'll see how good it was, how many players at your level would play it, and the idea behind the best move. Toggle the layers above to see threats, square control, the engine's plan, or what humans tend to play.</p></div>`);
  }
  el.innerHTML = out.join('');
}

// Coach buttons
$('#coach').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const r = st.review;
  switch (act) {
    case 'quiz-none': answerQuiz('none'); break;
    case 'quiz-skip': st.quiz.answered = true; st.quiz.pick = 'skip'; refresh(); renderCoach(); break;
    case 'idea-best': openPreview(r.fenBefore, r.bestPv, r.isBest ? `Where ${r.san} leads` : `The better idea: ${r.best.san}`); break;
    case 'idea-refute': openPreview(r.fenAfter, r.refutePv, `How they punish ${r.san}`); break;
    case 'idea-now': openPreview(st.game.fen(), st.analysis.lines[0].pv, 'The engine\'s line'); break;
    case 'pv-prev': st.preview.idx--; refresh(); renderCoach(); break;
    case 'pv-next': st.preview.idx++; refresh(); renderCoach(); break;
    case 'pv-close': st.preview = null; refresh(); renderCoach(); break;
    case 'next-drill': startDrill(); break;
    case 'back-game': case 'new': setTab('play'); newGame(); break;
    case 'drills': setTab('drills'); break;
  }
});

// ---------- style view ----------
function renderStyle() {
  const s = styleSummary(profile);
  const e = eloPosterior(profile);
  const q = profile.quiz;
  const maxPost = Math.max(...e.post, 0.0001);
  const missed = Object.entries(s.missed).sort((a, b) => b[1] - a[1]);
  $('#view-style').innerHTML = `
  <div class="card"><h3>Who you play like</h3>
    ${e.n >= 5 ? `<div class="big">~${Math.round(e.mean / 50) * 50}</div><p class="small muted">Maia-3 checked every one of your ${e.n} moves against humans at each rating. These bars show which level most often makes the moves you make.</p>
    <div class="elo-chart">${e.post.map((p) => `<div style="height:${(p / maxPost) * 100}%"></div>`).join('')}</div>
    <div class="elo-axis">${ELO_GRID.map((x) => `<span>${x}</span>`).join('')}</div>`
    : `<p class="muted">${maia.ready ? `Play ${5 - e.n} more moves to get an estimate.` : 'Needs the human model (Maia-3). Load it from ⚙ Settings.'}</p>`}
  </div>
  <div class="card"><h3>Your style vs. the engine</h3>
    ${s.n ? `<p class="small muted">Same positions, two players: how often <i>you</i> chose each kind of move vs. how often the <i>best</i> move was that kind. Big gaps are your style — or your blind spots.</p>
    <div class="legend"><span><i style="background:var(--you)"></i>You</span><span><i style="background:var(--plan-me)"></i>Best move</span></div>
    <div class="bars">${s.axes.map((a) => `<div class="axis"><div class="lbl"><span>${a.label} <span class="muted">· ${a.hint}</span></span><span>${Math.round(a.you * 100)}% / ${Math.round(a.eng * 100)}%</span></div>
      <div class="track"><div class="fill you" style="width:${a.you * 100}%"></div></div><div class="track"><div class="fill eng" style="width:${a.eng * 100}%"></div></div></div>`).join('')}</div>
    <p class="small muted">${s.n} moves analysed · average ${s.avgLoss.toFixed(1)}% winning chance lost per move.</p>` : '<p class="muted">Play a game first.</p>'}
  </div>
  <div class="card"><h3>Blind spots</h3>
    ${missed.length ? `<p class="small muted">When you went wrong, this is what the best move was doing:</p><p>${missed.map(([k, n]) => `<span class="tag">${esc(IDEA_NAMES[k] || k)} × ${n}</span>`).join(' ')}</p><div class="row-btns"><button data-act="drills" class="primary">Drill them (${profile.drills.length})</button></div>` : '<p class="muted">Nothing yet. Mistakes you make will show up here.</p>'}
  </div>
  <div class="card"><h3>Threat check</h3>
    ${q.total ? `<p><span class="big">${Math.round((q.right / q.total) * 100)}%</span> <span class="muted">spotted (${q.right}/${q.total}) · best streak ${q.best}</span></p><p class="small muted">The habit that separates club players: before every move, ask what their last move wants.</p>` : '<p class="muted">Answer threat checks during games to track this.</p>'}
  </div>
  <div class="row-btns end"><button data-act="reset-profile">Reset my stats</button></div>`;
}
$('#view-style').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'drills') setTab('drills');
  if (act === 'reset-profile') {
    const b = e.target.closest('button');
    if (b.dataset.armed) { profile = resetProfile(); renderStyle(); } // pop-ups are blocked in some hosts, so confirm with a second tap
    else { b.dataset.armed = '1'; b.textContent = 'Tap again to erase stats & drills'; }
  }
});

// ---------- tabs, layers, buttons ----------
function setTab(tab) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#view-board').hidden = tab === 'style';
  $('#view-style').hidden = tab !== 'style';
  if (tab === 'style') renderStyle();
  if (tab === 'drills' && st.mode !== 'drill') { st.savedGame = { fen: st.game.pgn(), myColor: st.myColor, verdicts: [...st.verdicts] }; startDrill(); }
  if (tab === 'play' && st.mode === 'drill') resumeGame();
}
function resumeGame() {
  st.mode = 'game'; st.drill = null; st.drillResult = null; st.preview = null; st.review = null; st.opp = null;
  if (st.savedGame) {
    st.game = new Chess(); st.game.loadPgn(st.savedGame.fen);
    st.myColor = st.savedGame.myColor; st.verdicts = st.savedGame.verdicts;
    board.orientation = st.myColor;
    if (st.game.turn() === st.myColor) startMyTurn(); else opponentMove();
  } else newGame();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
document.querySelectorAll('#layers .chip').forEach((c) => c.addEventListener('click', () => {
  settings.layers[c.dataset.layer] = !settings.layers[c.dataset.layer]; saveSettings(); refresh();
}));
$('#btn-hint').addEventListener('click', () => { st.hint = Math.min(4, st.hint + 1); if (st.quiz && !st.quiz.answered) { st.quiz.answered = true; st.quiz.pick = 'skip'; } refresh(); renderCoach(); });
$('#btn-undo').addEventListener('click', takeBack);
$('#btn-new').addEventListener('click', () => { if (st.mode === 'drill') setTab('play'); else if (!st.busy) newGame(); });

// ---------- settings + model ----------
const eloOpts = () => Array.from({ length: 19 }, (_, i) => 600 + i * 100).map((v) => `<option value="${v}">${v}</option>`).join('');
$('#set-myelo').innerHTML = eloOpts(); $('#set-oppelo').innerHTML = eloOpts();
$('#btn-settings').addEventListener('click', () => {
  $('#set-myelo').value = settings.myElo; $('#set-oppelo').value = settings.oppElo; $('#set-color').value = settings.color;
  $('#set-depth').value = settings.depth; $('#set-quiz').checked = settings.quiz; $('#set-modelurl').value = settings.modelUrl;
  $('#settings').showModal();
});
$('#settings').addEventListener('close', () => {
  settings.myElo = Number($('#set-myelo').value); settings.oppElo = Number($('#set-oppelo').value);
  settings.color = $('#set-color').value; settings.depth = Number($('#set-depth').value);
  settings.quiz = $('#set-quiz').checked; settings.modelUrl = $('#set-modelurl').value || DEFAULT_MODEL_URL;
  saveSettings();
});

function renderModel(progress) {
  const status = maia.ready ? `Maia-3 ready (${maia.source === 'cache' ? 'offline, from cache' : maia.source})` : st.modelMsg || 'not loaded';
  $('#model-status').textContent = status;
  const bn = $('#model-banner');
  if (maia.ready) { bn.hidden = true; return; }
  bn.hidden = false;
  bn.innerHTML = progress != null
    ? `Loading Maia-3… <div class="progress"><div style="width:${Math.round((progress || 0) * 100)}%"></div></div>`
    : `<b>Human model off.</b> Load Maia-3 (11 MB, once — then it works offline) for a human-like opponent and "what players at your level do".${st.modelMsg ? `<br><span class="small muted">${esc(st.modelMsg)}</span>` : ''}
       <div class="row-btns"><button data-act="dl" class="primary">Load Maia-3</button><label class="filebtn">From file<input type="file" accept=".onnx" data-act="file"></label></div>`;
}
async function loadModel(fn) {
  try { renderModel(0); await fn((p) => renderModel(p)); st.modelMsg = null; }
  catch (e) { console.warn(e); st.modelMsg = `Couldn't load: ${e.message}. You can download the .onnx yourself and use "From file".`; }
  renderModel();
  if (maia.ready && st.game.turn() === st.myColor && !st.busy) startMyTurnKeepOpp();
}
function startMyTurnKeepOpp() { const o = st.opp; startMyTurn(); st.opp = o; }
$('#model-banner').addEventListener('click', (e) => { if (e.target.dataset.act === 'dl') loadModel((cb) => maia.loadUrl(settings.modelUrl, cb)); });
$('#model-banner').addEventListener('change', (e) => { if (e.target.files?.[0]) loadModel(() => maia.loadFile(e.target.files[0])); });
$('#btn-model-dl').addEventListener('click', () => loadModel((cb) => maia.loadUrl($('#set-modelurl').value || DEFAULT_MODEL_URL, cb)));
$('#model-file').addEventListener('change', (e) => { if (e.target.files?.[0]) loadModel(() => maia.loadFile(e.target.files[0])); });

// ---------- boot ----------
renderModel();
maia.loadCached(settings.modelUrl).then(() => renderModel());
newGame();
window.__gym = { st, engine, maia, settings, profile: () => profile };
