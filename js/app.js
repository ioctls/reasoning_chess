import { Chess } from '../vendor/chess/chess.js';
import { Board } from './board.js';
import { Stockfish } from './engine.js';
import { Maia, sampleHuman, DEFAULT_MODEL_URL } from './maia.js';
import {
  boardFromFen, controlMap, hangingPieces, attackersOf, VALUE, describeMove, winChance, verdict,
  humanQuadrant, forcingMoves, moveFeatures, nullMoveFen, sqName, NAME,
} from './analysis.js';
import {
  loadProfile, saveProfile, resetProfile, recordMove, recordEloEvidence, eloPosterior, styleSummary,
  addDrill, dueDrills, drillQueue, issueSummary, gradeDrill, ELO_GRID,
} from './profile.js';
import { ISSUES, classifyIssue, issueOfDrill } from './issues.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Let the browser paint a frame before the next chunk of work, so animations never stall.
const breathe = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const THREAT_KINDS = ['win', 'mate', 'matethreat', 'fork', 'check', 'threat', 'pin', 'skewer', 'discovered'];
const IDEA_NAMES = { fork: 'a fork', pin: 'a pin', skewer: 'a skewer', discovered: 'a discovered attack', matethreat: 'a mate threat', mate: 'checkmate', win: 'winning material', check: 'a forcing check', threat: 'an attack on a loose piece', promo: 'promotion', defend: 'defending', escape: 'saving a piece', castle: 'king safety', develop: 'development', center: 'the center', attack: 'king pressure', activate: 'piece activity', trade: 'a trade', capture: 'a capture', quiet: 'a quiet improvement' };

// Pacing (ms). Slow enough to follow, quick enough not to drag.
const PAUSE_BEFORE_REPLY = 900;   // after your move: watch it land and read the verdict
const PAUSE_FIRST_MOVE = 500;

// ---------- settings ----------
const SKEY = 'reasonablechess.settings.v1';
let stored = {};
try { stored = JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch { /* ignore */ }
const settings = Object.assign(
  { mode: 'learn', myElo: 1200, oppElo: 1200, color: 'w', depth: 12, quiz: true, modelUrl: DEFAULT_MODEL_URL, layers: { threats: true, control: false, plan: false, humans: false } },
  stored,
);
const saveSettings = () => { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch { /* ignore */ } };

// ---------- state ----------
const engine = new Stockfish();
const maia = new Maia();
let profile = loadProfile();
const st = {
  mode: 'game',        // 'game' | 'drill'
  game: new Chess(),
  myColor: 'w',
  busy: false,
  thinking: false,
  token: 0,            // bumps whenever the position changes; stale async results are dropped
  analysis: null, analysisP: null,
  human: null,
  selected: null, targets: [],
  hint: 0,
  quiz: null,          // { key:Set, answered, correct, pick }
  opp: null,           // log entry of their last move (+ idea)
  review: null,        // review of your last move
  log: [],             // one entry per ply: { by, fenBefore, fenAfter, uci, san, review?, idea? }
  view: null,          // null = live; otherwise index into log (-1 = start position)
  preview: null,       // { fens, pv, sans, idx, notes, title }
  drill: null, drillResult: null, drillIssue: undefined, drillPicking: false,
  awaitingContinue: false, // Learn mode: bot waits until you tap Continue
  resigned: false,
  modelMsg: null,
};
const learning = () => settings.mode === 'learn';
const over = () => st.game.isGameOver() || st.resigned;

const board = new Board($('#board'), { onSquareTap });

// ---------- engine helpers ----------
function analyseCurrent() {
  const fen = st.game.fen();
  if (st.analysisP && st.analysisP.fen === fen) return st.analysisP.p;
  const p = engine.analyse(fen, { depth: settings.depth, multipv: 3 }).then((a) => {
    const res = { fen, ...a };
    // Remember your winning chances after their move too, for the report graph.
    const last = st.log[st.log.length - 1];
    if (last && last.by === 'them' && last.fenAfter === fen && a.lines[0]) last.myWin = winChance(a.lines[0].score);
    if (st.game.fen() === fen) { st.analysis = res; refresh(); renderCoach(); }
    return res;
  });
  st.analysisP = { fen, p };
  return p;
}

// ---------- game flow ----------
function newGame() {
  st.mode = 'game';
  st.drill = null; st.drillResult = null; st.drillPicking = false;
  st.game = new Chess();
  st.myColor = settings.color === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : settings.color;
  st.review = null; st.opp = null; closePreview(); st.log = []; st.view = null;
  st.resigned = false; st.awaitingContinue = false;
  board.orientation = st.myColor;
  profile.games++; saveProfile(profile);
  if (st.myColor === 'w') startMyTurn(); else opponentMove(PAUSE_FIRST_MOVE);
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
  if (over()) return endGame();
  analyseCurrent(); // runs in a worker, safe to start right away
  await board.settled();
  if (tok !== st.token) return;
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
  await breathe();
  if (tok !== st.token) return;
  const theirMove = describeMove(o.fenBefore, o.uci);
  if (st.game.inCheck()) { o.idea = { text: `${o.san} gives check.`, arrows: [], key }; renderCoach(); return; }
  for (const t of theirMove.tags) if (THREAT_KINDS.includes(t.kind) && t.kind !== 'check') { t.squares.forEach((s) => key.add(sqName(s))); notes.push(t.text); }
  // Free move: if they could move again, what would they do?
  let arrows = [], threatUci = null;
  const nf = nullMoveFen(st.game.fen());
  if (nf) {
    const a = await engine.analyse(nf, { depth: Math.min(10, settings.depth) });
    if (tok !== st.token) return;
    const nb = a.best;
    if (nb) {
      await breathe();
      if (tok !== st.token) return;
      const d = describeMove(nf, nb);
      const serious = d && d.tags.some((t) => ['win', 'mate', 'fork', 'matethreat', 'skewer', 'discovered'].includes(t.kind));
      if (serious) {
        threatUci = nb;
        key.add(nb.slice(2, 4)); key.add(nb.slice(0, 2));
        notes.push(`If you ignore it: ${d.san} — ${d.tags.filter((t) => t.kind !== 'weak').map((t) => t.text).join(' ')}`);
        arrows = [{ from: nb.slice(0, 2), to: nb.slice(2, 4), color: 'var(--them)', dashed: true, width: 12, label: '!' }];
      }
    }
  }
  o.idea = { text: notes.length ? notes.join(' ') : `${o.san} doesn't create an immediate threat. Free to follow your own plan.`, arrows, key, threatUci };
  if (settings.quiz && st.mode === 'game' && learning()) st.quiz = { key, answered: false };
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
  if (st.view != null) { goLive(); return; } // tapping the board while replaying jumps back to the game
  if (st.quiz && !st.quiz.answered) return answerQuiz(sq);
  if (st.busy || st.game.turn() !== st.myColor || over()) return;
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
  const humanBefore = st.human && st.human.fen === fenBefore ? st.human : null;
  const threatUci = st.opp && st.opp.idea ? st.opp.idea.threatUci : null;
  const entry = { by: 'me', fenBefore, fenAfter: st.game.fen(), uci, san: mv.san, review: null };
  if (st.mode === 'game') st.log.push(entry);
  resetTurnState();
  st.busy = true; st.review = { pending: true, san: mv.san }; st.opp = null;
  refresh(); renderCoach();
  const slid = board.settled();

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
  await slid; // explaining is CPU work: never do it while the piece is still sliding
  const mine = describeMove(fenBefore, uci);
  await breathe();
  const best = pre.best ? (pre.best === uci ? mine : describeMove(fenBefore, pre.best)) : null;
  await breathe();
  const refuteUci = post && post.lines[0] ? post.lines[0].pv[0] : null;
  const refute = loss > 5 && refuteUci ? describeMove(st.game.fen(), refuteUci) : null;
  const issue = loss > 10 ? classifyIssue({ mine, best, refute, refuteUci, threatUci }) : null;

  st.review = { san: mv.san, uci, fenBefore, v, loss, myWin, humanP, quad: humanQuadrant(humanP, loss), mine, best, bestPv: pre.lines[0]?.pv || [], isBest, refute, refutePv: post?.lines[0]?.pv || [], fenAfter: st.game.fen(), issue };
  entry.review = st.review;

  if (st.mode === 'drill') return finishDrill(loss);

  // Learn about you.
  recordMove(profile, { mine: moveFeatures(fenBefore, uci, mine), best: pre.best ? moveFeatures(fenBefore, pre.best, best) : null, loss, humanP, issue });
  if (issue && best) addDrill(profile, { fen: fenBefore, best: pre.best, bestSan: best.san, kinds: best.tags.map((t) => t.kind), mySan: mv.san, issue });
  saveProfile(profile);
  refresh(); renderCoach();
  if (maia.ready) {
    // "Who you play like" evidence: not urgent, so it runs while you read the review.
    maia.moveProbAcrossElos(before, uci, ELO_GRID, settings.oppElo)
      .then((p) => { recordEloEvidence(profile, p); saveProfile(profile); })
      .catch((e) => console.warn(e));
  }
  if (over()) return endGame();
  if (learning()) {
    // Learn mode: read the feedback first; the bot moves when you tap Continue.
    st.awaitingContinue = true;
    refresh(); renderCoach();
    return;
  }
  await opponentMove(PAUSE_FIRST_MOVE);
}

function continueGame() {
  if (!st.awaitingContinue) return;
  st.awaitingContinue = false;
  st.review = null; // one block at a time: your feedback goes away, their move comes in
  closePreview();
  opponentMove(250);
}

async function opponentMove(pause = PAUSE_BEFORE_REPLY) {
  if (over()) return endGame();
  st.busy = true; st.thinking = true;
  const tok = st.token;
  refresh(); renderCoach();
  const fenBefore = st.game.fen();
  await sleep(pause);
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
  if (tok !== st.token || st.game.fen() !== fenBefore) return; // game changed meanwhile (new game, take back)
  const m = st.game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  const entry = { by: 'them', fenBefore, fenAfter: st.game.fen(), uci, san: m.san };
  st.log.push(entry);
  st.opp = entry;
  st.thinking = false;
  startMyTurn();
}

function endGame() {
  st.busy = false;
  refresh(); renderCoach();
}

function takeBack() {
  if (st.mode === 'game' && !learning() && !over() && st.log.length) { st.resigned = true; st.token++; st.busy = false; st.thinking = false; closePreview(); endGame(); return; }
  if (st.resigned || st.mode !== 'game' || !st.log.length || (st.busy && !st.awaitingContinue)) return;
  st.awaitingContinue = false;
  st.view = null;
  st.game.undo(); st.log.pop();
  if (st.game.turn() !== st.myColor && st.log.length) { st.game.undo(); st.log.pop(); }
  st.review = null; st.opp = null; closePreview();
  if (st.game.turn() === st.myColor) startMyTurn(); else opponentMove(PAUSE_FIRST_MOVE);
}

// ---------- replay (back / forward) ----------
function goTo(i) {
  if (st.preview || st.mode !== 'game') return;
  const last = st.log.length - 1;
  if (i >= last) { goLive(); return; }
  st.view = Math.max(-1, i);
  st.selected = null; st.targets = [];
  refresh(); renderCoach();
}
function goLive() { st.view = null; refresh(); renderCoach(); }
const curPly = () => (st.view == null ? st.log.length - 1 : st.view);

// ---------- drills ----------
function openDrills(issue) {
  st.mode = 'drill'; st.preview = null; st.review = null; st.opp = null; st.view = null;
  if (issue === undefined) { st.drillPicking = true; st.drill = null; resetTurnState(); refresh(); renderCoach(); return; }
  st.drillIssue = issue;
  st.drillPicking = false;
  nextDrill();
}

function nextDrill() {
  st.drillResult = null; st.review = null; st.preview = null;
  const q = drillQueue(profile, st.drillIssue);
  if (!q.length) { st.drill = null; st.drillPicking = true; resetTurnState(); refresh(); renderCoach(); return; }
  // Don't serve the card you just did if there's another one.
  st.drill = q.length > 1 && st.lastDrillId === q[0].id ? q[1] : q[0];
  st.lastDrillId = st.drill.id;
  st.game = new Chess(st.drill.fen);
  st.myColor = st.game.turn();
  board.orientation = st.myColor;
  board.prevBoard = null; // new position: no slide from the previous one
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
const STEP_MS = 1300;

function openPreview(fen, pv, title) {
  closePreview();
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
  const p = { fens, pv: pv.slice(0, sans.length), sans, notes, idx: 0, title, evals: [], playing: true, timer: null };
  st.preview = p;
  // Evaluate every position in the line (in the engine's worker) so the eval bar can follow along.
  (async () => {
    for (let i = 0; i < fens.length; i++) {
      const a = await engine.analyse(fens[i], { depth: Math.min(10, settings.depth) });
      if (st.preview !== p) return;
      const c2 = new Chess(fens[i]);
      let w;
      if (c2.isCheckmate()) w = c2.turn() === st.myColor ? 0 : 100;
      else if (c2.isDraw() || c2.isStalemate()) w = 50;
      else { const stm = winChance(a.lines[0]?.score); w = c2.turn() === st.myColor ? stm : 100 - stm; }
      p.evals[i] = w;
      refresh(); renderCoach();
    }
  })();
  refresh(); renderCoach();
  schedulePreview(900); // a moment to look at the starting position, then it plays itself
}

function schedulePreview(delay = STEP_MS) {
  const p = st.preview;
  if (!p) return;
  clearTimeout(p.timer);
  if (!p.playing) return;
  if (p.idx >= p.sans.length) { p.playing = false; renderCoach(); return; }
  p.timer = setTimeout(() => {
    if (st.preview !== p || !p.playing) return;
    p.idx++;
    refresh(); renderCoach();
    schedulePreview();
  }, delay);
}

function previewStep(d) {
  const p = st.preview;
  if (!p) return;
  p.playing = false; clearTimeout(p.timer);
  p.idx = Math.max(0, Math.min(p.sans.length, p.idx + d));
  refresh(); renderCoach();
}

function previewToggle() {
  const p = st.preview;
  if (!p) return;
  if (p.playing) { p.playing = false; clearTimeout(p.timer); renderCoach(); return; }
  if (p.idx >= p.sans.length) { p.idx = 0; refresh(); }
  p.playing = true; renderCoach();
  schedulePreview(500);
}

function closePreview() {
  if (st.preview) clearTimeout(st.preview.timer);
  if (st.preview) board.prevBoard = null; // jump straight back, no slide from the preview position
  st.preview = null;
}

// ---------- rendering ----------
function overlaysFor(fen) {
  const ov = { arrows: [], rings: [], highlights: [] };
  if (st.mode === 'game' && !learning() && !over() && !st.preview) return ov; // Play mode: no help until the end
  const L = settings.layers;
  const b = boardFromFen(fen);
  if (L.control) ov.control = controlMap(b);

  if (st.preview) {
    const p = st.preview;
    p.pv.forEach((u, i) => {
      if (i < p.idx) return;
      ov.arrows.push({ from: u.slice(0, 2), to: u.slice(2, 4), color: i % 2 === 0 ? 'var(--plan-me)' : 'var(--plan-them)', label: i + 1, width: i === p.idx ? 18 : 10, opacity: i === p.idx ? 0.95 : 0.45 });
    });
    return ov;
  }

  if (L.threats) {
    for (const s of hangingPieces(b, st.myColor)) {
      ov.rings.push({ sq: sqName(s), color: 'var(--them)' });
      const att = attackersOf(b, s, st.myColor === 'w' ? 'b' : 'w').sort((x, y) => VALUE[b[x].t] - VALUE[b[y].t])[0];
      if (att != null) ov.arrows.push({ from: sqName(att), to: sqName(s), color: 'var(--them)', width: 8, opacity: 0.7 });
    }
  }
  if (st.view != null) return ov; // replaying: geometry layers only

  const myTurn = st.game.turn() === st.myColor && !st.busy;
  if (L.threats && st.opp && st.opp.idea && (!st.quiz || st.quiz.answered)) ov.arrows.push(...st.opp.idea.arrows);
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

function shownFen() {
  if (st.preview) return st.preview.fens[st.preview.idx];
  if (st.view != null) return st.view < 0 ? (st.log[0]?.fenBefore || st.game.fen()) : st.log[st.view].fenAfter;
  return st.game.fen();
}

function refresh() {
  const fen = shownFen();
  let lastMove = null;
  if (st.preview) { const u = st.preview.pv[st.preview.idx - 1]; if (u) lastMove = [u.slice(0, 2), u.slice(2, 4)]; }
  else if (st.view != null) { const e = st.log[st.view]; if (e) lastMove = [e.uci.slice(0, 2), e.uci.slice(2, 4)]; }
  else { const h = st.game.history({ verbose: true }); const l = h[h.length - 1]; if (l) lastMove = [l.from, l.to]; }
  const live = st.view == null && !st.preview;
  board.set({ fen, lastMove, selected: live ? st.selected : null, targets: live ? st.targets : [], overlays: overlaysFor(fen) });

  // Eval bar: your winning chances.
  let w = null;
  const playing = st.mode === 'game' && !learning() && !over();
  if (st.preview) w = st.preview.evals[st.preview.idx] ?? null;
  else if (playing) w = null;
  else if (st.view != null) {
    const e = st.log[st.view];
    const r = e && (e.review || (st.log[st.view - 1] && st.log[st.view - 1].review));
    if (r) w = r.myWin;
  } else if (st.analysis && st.analysis.fen === st.game.fen() && st.analysis.lines[0]) {
    const stm = winChance(st.analysis.lines[0].score);
    w = st.game.turn() === st.myColor ? stm : 100 - stm;
  } else if (st.review && st.review.myWin != null) w = st.review.myWin;
  if (w != null) { $('#evalfill').style.height = `${w}%`; $('#evaltext').textContent = Math.round(w); }
  else if (playing) { $('#evalfill').style.height = '50%'; $('#evaltext').textContent = ''; }
  $('#view-board').classList.toggle('play-mode', playing);
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === settings.mode));

  document.querySelectorAll('#layers .chip').forEach((c) => c.classList.toggle('on', !!settings.layers[c.dataset.layer]));
  const inGame = st.mode === 'game' && !st.preview && !playing;
  $('#btn-back').disabled = !inGame || curPly() < 0;
  $('#btn-fwd').disabled = !inGame || st.view == null;
  $('#btn-undo').textContent = playing ? '🏳 Resign' : '↶ Undo';
  $('#btn-undo').disabled = st.resigned || (playing ? !st.log.length : ((st.busy && !st.awaitingContinue) || st.mode !== 'game' || !st.log.length));
  $('#btn-hint').disabled = playing || st.busy || !!st.preview || st.view != null || st.game.turn() !== st.myColor || over() || st.drillPicking;
  $('#btn-new').textContent = st.mode === 'drill' ? '← Game' : 'New game';
  renderMoves();
}

function renderMoves() {
  if (st.mode === 'drill') { $('#moves').innerHTML = ''; return; }
  const cur = st.view;
  const parts = [];
  st.log.forEach((e, i) => {
    const k = e.review?.v?.key;
    const cls = { blunder: 'mv-blunder', mistake: 'mv-mistake', inacc: 'mv-inacc' }[k] || '';
    const sym = { blunder: '??', mistake: '?', inacc: '?!' }[k] || '';
    if (i % 2 === 0) parts.push(`<b>${i / 2 + 1}.</b>`);
    parts.push(`<span class="ply ${cls} ${cur === i ? 'cur' : ''}" data-ply="${i}">${esc(e.san)}${sym}</span>`);
  });
  $('#moves').innerHTML = parts.join(' ');
}

function tagLine(desc, skip = []) {
  if (!desc) return '';
  return desc.tags.filter((t) => !skip.includes(t.kind)).map((t) => esc(t.text)).join(' ');
}

/** The verdict card for one of your moves. Used live and when replaying. */
function reviewCard(r, ply) {
  if (r.pending) return `<div class="card"><p class="muted">Checking <b>${esc(r.san)}</b>…</p></div>`;
  const humanTag = r.quad ? `<span class="tag human">${esc(r.quad.label)}</span>` : '';
  let body = `<p>${tagLine(r.mine) || 'A quiet move.'}</p>`;
  if (r.issue) body += `<p><span class="tag issue-tag">Issue: ${esc(ISSUES[r.issue].label)}</span> <span class="small muted">${esc(ISSUES[r.issue].tip)}</span></p>`;
  if (r.quad) body += `<p class="small muted">${esc(r.quad.text).replace(/\*(.+?)\*/g, '<i>$1</i>')}</p>`;
  if (!r.isBest && r.best && r.loss > 2) body += `<p>Better: <b>${esc(r.best.san)}</b> — ${tagLine(r.best, ['weak']) || 'keeps more of your advantage.'}</p>`;
  if (r.refute) {
    const sharp = tagLine(r.refute, ['weak', 'quiet', 'develop', 'center', 'activate', 'castle']);
    body += sharp
      ? `<p>The problem: they can answer <b>${esc(r.refute.san)}</b>. ${sharp}</p>`
      : `<p>The problem isn't one tactic: it hands away ${Math.round(r.loss)}% of your winning chances. Their best reply is <b>${esc(r.refute.san)}</b>.</p>`;
  }
  const at = ply != null ? ` data-ply="${ply}"` : '';
  const btns = [];
  if (!r.isBest && r.bestPv.length) btns.push(`<button data-act="idea-best"${at}>👁 Show the better idea</button>`);
  if (r.refute && r.refutePv.length) btns.push(`<button data-act="idea-refute"${at}>👁 Show their punishment</button>`);
  if (r.isBest && r.bestPv.length > 1) btns.push(`<button data-act="idea-best"${at}>👁 Show where it leads</button>`);
  return `<div class="card"><h3>${esc(r.san)} <span class="tag ${r.v.tone}">${esc(r.v.label)}</span>${humanTag}</h3>${body}${btns.length ? `<div class="row-btns">${btns.join('')}</div>` : ''}</div>`;
}

/**
 * Swap in cards. Unchanged cards stay put; new ones fade in. A card with a data-key
 * (like the line preview) updates in place without fading, so stepping doesn't flicker.
 */
function setCards(el, cards) {
  const old = [...el.children];
  const frag = document.createDocumentFragment();
  for (const html of cards) {
    const prev = old.find((c) => c.dataset.h === html);
    if (prev) { frag.appendChild(prev); continue; }
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const node = wrap.firstElementChild || wrap;
    node.dataset.h = html;
    const key = node.dataset.key;
    if (!(key && old.some((c) => c.dataset.key === key))) node.classList.add('card-in');
    frag.appendChild(node);
  }
  el.replaceChildren(frag);
}

const winTxt = (w) => (w == null ? '' : `${Math.round(w)}%`);

function previewCard() {
  const p = st.preview;
  const e = p.evals;
  const chip = (i) => {
    if (e[i + 1] == null) return '';
    const d = e[i] != null ? e[i + 1] - e[i] : 0;
    return `<span class="evalchip ${d > 4 ? 'up' : d < -4 ? 'down' : ''}">you ${winTxt(e[i + 1])}</span>`;
  };
  const atEnd = p.idx >= p.sans.length;
  return `<div class="card" data-key="preview"><h3>👁 ${esc(p.title)}</h3>
    <p class="small muted">Green = the side to move first, orange = the reply. The bar on the left is your winning chance at each step.${e[0] != null ? ` Starts at <b>${winTxt(e[0])}</b>.` : ''}</p>
    <ol class="idea-steps">${p.sans.map((s, i) => `<li class="${i === p.idx - 1 ? 'now' : i < p.idx ? '' : 'later'}"><b>${esc(s)}</b>${chip(i)}${p.notes[i] ? ' — ' + esc(p.notes[i]) : ''}</li>`).join('')}</ol>
    <div class="row-btns pv-controls"><button data-act="pv-prev" ${p.idx === 0 ? 'disabled' : ''} aria-label="Back">◀</button><button data-act="pv-toggle">${p.playing ? '❚❚ Pause' : atEnd ? '↻ Replay' : '▶ Play'}</button><button data-act="pv-next" ${atEnd ? 'disabled' : ''} aria-label="Next">▶|</button><button data-act="pv-close" class="primary">Done</button></div></div>`;
}

function renderCoach() {
  const el = $('#coach');
  const out = [];

  if (st.preview) { setCards(el, [previewCard()]); return; }

  // Replaying the game
  if (st.view != null && st.mode === 'game') {
    const n = st.log.length;
    out.push(`<div class="history-bar">Replaying · move <b>${st.view + 1}</b> of ${n} <button data-act="live" class="primary">${over() ? 'Back to report' : 'Back to game'} ▸▸</button></div>`);
    const e = st.log[st.view];
    if (!e) out.push('<div class="card"><p class="muted">Start position.</p></div>');
    else if (e.by === 'me' && e.review) out.push(reviewCard(e.review, st.view));
    else if (e.by === 'them') out.push(`<div class="card"><h3>They played ${esc(e.san)}</h3><p>${esc(e.idea ? e.idea.text : tagLine(describeMove(e.fenBefore, e.uci)) || 'A quiet move.')}</p></div>`);
    setCards(el, out);
    return;
  }

  if (st.mode === 'drill') { renderDrillCoach(out); setCards(el, out); return; }

  if (over()) { out.push(reportCard()); setCards(el, out); return; }

  if (!learning()) {
    // Play mode: just play. Everything is saved for the report.
    const msg = st.thinking ? `${maia.ready ? `Maia ${settings.oppElo}` : `Stockfish (~${settings.oppElo})`} is thinking…`
      : st.busy ? 'Saving your move for the report…' : 'Your move.';
    out.push(`<div class="card"><p class="muted">🎯 <b>Play mode</b> · ${msg}</p><p class="small muted">No hints or feedback until the game ends — then you get a full report. Switch to Learn anytime.</p></div>`);
    setCards(el, out);
    return;
  }

  // ----- Learn mode: one block at a time -----
  if (st.review) {
    // Your move's feedback. The bot waits until you tap Continue.
    let html = reviewCard(st.review, null);
    if (st.awaitingContinue) html = html.replace(/<\/div>$/, '<button data-act="continue" class="primary continue">Got it — continue ▸</button></div>');
    out.push(html);
  } else if (st.thinking) {
    out.push(`<div class="card"><p class="muted">${maia.ready ? `Maia ${settings.oppElo}` : `Stockfish (~${settings.oppElo})`} is thinking…</p></div>`);
  } else if (st.quiz && !st.quiz.answered && st.opp) {
    out.push(`<div class="card"><h3>🛡 Threat check</h3><p>They played <b>${esc(st.opp.san)}</b>. Before you move: what is it after?</p><p class="small muted">Tap the piece or square they're targeting on the board.</p><div class="row-btns"><button data-act="quiz-none">Nothing serious</button><button data-act="quiz-skip">Skip</button></div></div>`);
  } else if (st.opp && st.opp.idea) {
    const q = st.quiz;
    const head = q ? (q.correct ? `✅ Spotted <span class="tag good">streak ${profile.quiz.streak}</span>` : q.pick === 'skip' ? 'Their idea' : '❌ Missed it') : 'Their idea';
    out.push(`<div class="card"><h3>${head}</h3><p><b>${esc(st.opp.san)}</b>: ${esc(st.opp.idea.text)}</p></div>`);
  } else if (st.opp) {
    out.push(`<div class="card"><p class="muted">They played <b>${esc(st.opp.san)}</b>. Spotting their idea…</p></div>`);
  } else if (!st.busy && !st.log.length) {
    out.push(`<div class="card"><h3>Your move</h3><p class="small muted">After each move you'll get feedback, and the bot waits until you tap Continue. Use ◀ ▶ to replay the game anytime, and the layers above to see threats, square control, the engine's plan, or what humans tend to play. Prefer to just play? Switch to <b>Play</b> for a report at the end.</p></div>`);
  }
  if (st.hint > 0 && st.game.turn() === st.myColor && !st.busy) out.push(hintCard());
  setCards(el, out);
}

/** End-of-game report: how it went, where it turned, and what to practice. */
function reportCard() {
  let res = 'Draw.';
  if (st.resigned) res = 'You resigned.';
  else if (st.game.isCheckmate()) res = st.game.turn() === st.myColor ? 'Checkmate — you lost this one.' : 'Checkmate — you win! 🎉';
  const mine = st.log.map((e, i) => ({ e, i })).filter(({ e }) => e.by === 'me' && e.review && !e.review.pending);
  const pending = st.log.some((e) => e.by === 'me' && (!e.review || e.review.pending));
  const count = (keys) => mine.filter(({ e }) => keys.includes(e.review.v.key)).length;
  const avg = mine.length ? mine.reduce((a, { e }) => a + e.review.loss, 0) / mine.length : 0;

  // Your winning chance after every move, from the start.
  const pts = [{ i: -1, w: 50 }];
  st.log.forEach((e, i) => {
    const w = e.by === 'me' ? e.review?.myWin : e.myWin;
    if (w != null) pts.push({ i, w });
  });
  const n = Math.max(1, st.log.length);
  const X = (i) => ((i + 1) / n) * 100, Y = (w) => 100 - w;
  const line = pts.map((p, k) => `${k ? 'L' : 'M'}${X(p.i).toFixed(2)},${Y(p.w).toFixed(2)}`).join(' ');
  const area = `${line} L${X(pts[pts.length - 1].i).toFixed(2)},100 L0,100 Z`;
  const dots = mine.filter(({ e }) => ['inacc', 'mistake', 'blunder'].includes(e.review.v.key)).map(({ e, i }) => {
    const c = { inacc: 'var(--meh)', mistake: '#fb923c', blunder: 'var(--bad)' }[e.review.v.key];
    return `<circle cx="${X(i)}" cy="${Y(e.review.myWin)}" r="2.6" fill="${c}" stroke="#111" stroke-width=".6" data-act="jump" data-ply="${i}" style="cursor:pointer"/>`;
  }).join('');
  const graph = `<div class="report-graph"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Your winning chances over the game">
      <line x1="0" y1="50" x2="100" y2="50" stroke="var(--line)" stroke-width=".5" vector-effect="non-scaling-stroke" stroke-dasharray="3 3"/>
      <path d="${area}" fill="color-mix(in srgb, var(--you) 22%, transparent)"/>
      <path d="${line}" fill="none" stroke="var(--you)" stroke-width="2" vector-effect="non-scaling-stroke"/>
      ${dots}
      ${st.log.map((_, i) => `<rect x="${X(i - 1)}" y="0" width="${100 / n}" height="100" fill="transparent" data-act="jump" data-ply="${i}" style="cursor:pointer"/>`).join('')}
    </svg></div><p class="small muted" style="margin-top:0">Your winning chance over the game. Tap anywhere on it to replay that moment; dots are mistakes.</p>`;

  const moments = mine.filter(({ e }) => e.review.loss > 10).sort((a, b) => b.e.review.loss - a.e.review.loss).slice(0, 4)
    .sort((a, b) => a.i - b.i)
    .map(({ e, i }) => {
      const r = e.review;
      const why = r.issue ? ISSUES[r.issue].label : r.v.label;
      return `<button class="moment" data-act="jump" data-ply="${i}"><span class="mv">${Math.floor(i / 2) + 1}${i % 2 ? '…' : '.'} ${esc(r.san)}</span><span class="why">${esc(why)} · lost ${Math.round(r.loss)}%${r.best ? ` · better ${esc(r.best.san)}` : ''}</span><span>›</span></button>`;
    }).join('');

  const issues = {}; mine.forEach(({ e }) => { if (e.review.issue) issues[e.review.issue] = (issues[e.review.issue] || 0) + 1; });
  const top = Object.entries(issues).sort((a, b) => b[1] - a[1]);
  return `<div class="card" data-key="report"><h3>📋 Game report · ${res}</h3>
    ${pending ? '<p class="small muted">Finishing analysis of your last move…</p>' : ''}
    ${mine.length ? graph : ''}
    <div class="stats"><div><b>${count(['best', 'good'])}</b><span>good moves</span></div><div><b>${count(['inacc'])}</b><span>inaccuracies</span></div><div><b>${count(['mistake'])}</b><span>mistakes</span></div><div><b>${count(['blunder'])}</b><span>blunders</span></div></div>
    <p class="small muted">On average you gave away ${avg.toFixed(1)}% winning chance per move${avg < 3 ? ' — very solid.' : avg < 7 ? '.' : ' — the key moments below are where it went.'}</p>
    ${moments ? `<p style="margin-bottom:0"><b>Key moments</b></p>${moments}` : '<p>No big mistakes this game. 👏</p>'}
    ${top.length ? `<p style="margin:12px 0 4px"><b>What to work on</b></p><p>${top.map(([k, c]) => `<span class="tag issue-tag">${esc(ISSUES[k].label)} × ${c}</span>`).join(' ')}</p><p class="small muted">${esc(ISSUES[top[0][0]].tip)}</p>` : ''}
    <div class="row-btns"><button data-act="new" class="primary">New game</button>${top.length ? `<button data-act="issue" data-issue="${top[0][0]}">Practice: ${esc(ISSUES[top[0][0]].label)}</button>` : ''}</div></div>`;
}

function hintCard() {
  const a = st.analysis && st.analysis.fen === st.game.fen() ? st.analysis : null;
  if (!a) return '<div class="card"><p class="muted">💡 Still thinking…</p></div>';
  const items = [];
  const fen = st.game.fen();
  if (!st.forcing || st.forcing.fen !== fen) st.forcing = { fen, ...forcingMoves(fen) };
  const fm = st.forcing;
  items.push(`<b>Step 1 — scan forcing moves.</b> Checks: ${fm.checks.length}, captures: ${fm.captures.length}, threats: ${fm.threats.length}. Strong players look at these first, every move. ${hangingPieces(boardFromFen(st.game.fen()), st.myColor === 'w' ? 'b' : 'w').length ? 'Yellow rings = their loose pieces.' : ''}`);
  const best = a.best && describeMove(st.game.fen(), a.best);
  if (st.hint >= 2 && best) items.push(`<b>Step 2 — the piece.</b> The highlighted ${NAME[st.game.get(a.best.slice(0, 2)).type]} has the key move.`);
  if (st.hint >= 3 && best) {
    const k = best.tags.find((t) => t.kind !== 'weak');
    items.push(`<b>Step 3 — the idea.</b> Look for ${IDEA_NAMES[k?.kind] || 'an improving move'}.`);
  }
  if (st.hint >= 4 && best) items.push(`<b>Step 4 — the move.</b> ${esc(best.san)}: ${tagLine(best, ['weak'])} <button data-act="idea-now" class="small">👁 Show the line</button>`);
  return `<div class="card"><h3>💡 Hint ${st.hint}/4</h3>${items.map((i) => `<p>${i}</p>`).join('')}</div>`;
}

function issuePickerHtml() {
  const rows = issueSummary(profile).filter((i) => i.drills > 0);
  if (!rows.length) {
    return `<div class="card"><h3>🏋️ Practice by issue</h3><p>No drills yet. Play a game: every mistake gets tagged with what went wrong (hanging pieces, missed threats, missed tactics…) and saved here so you can practice that one thing.</p><div class="row-btns"><button data-act="back-game" class="primary">Play a game</button></div></div>`;
  }
  const total = profile.drills.length, due = dueDrills(profile).length;
  return `<div class="card"><h3>🏋️ Practice by issue</h3><p class="small muted">Your mistakes, grouped by what went wrong. Most frequent first. Pick one and drill just that.</p>
    <div class="issues">${rows.map((i) => `<button class="issue" data-act="issue" data-issue="${i.key}"><span class="t">${esc(i.label)}</span><span class="n">${i.drills}</span><span class="d">${i.games} in games · ${i.due} due now</span></button>`).join('')}
    <button class="issue" data-act="issue" data-issue=""><span class="t">Mixed</span><span class="n">${total}</span><span class="d">everything · ${due} due now</span></button></div></div>`;
}

function renderDrillCoach(out) {
  if (st.drillPicking || !st.drill) { out.push(issuePickerHtml()); return; }
  const issue = issueOfDrill(st.drill);
  const label = st.drillIssue ? ISSUES[st.drillIssue].label : 'Mixed';
  const left = drillQueue(profile, st.drillIssue).length;
  if (!st.drillResult) {
    out.push(`<div class="card"><h3>🏋️ ${esc(label)} <span class="tag">${left} in set</span></h3><p>In your game you played <b>${esc(st.drill.mySan)}</b> here. There's something much stronger. ${st.game.turn() === 'w' ? 'White' : 'Black'} to move.</p><p class="small muted">${esc(ISSUES[issue].tip)}</p><div class="row-btns"><button data-act="pick-issue">Change issue</button></div></div>`);
  } else {
    const r = st.review;
    out.push(`<div class="card"><h3>${st.drillResult.correct ? '✅ Found it' : '❌ Not quite'} <span class="tag ${r.v.tone}">${esc(r.v.label)}</span></h3>
      ${st.drillResult.correct ? `<p>${tagLine(r.mine, ['weak']) || 'Good move.'}</p>` : `<p>The idea was <b>${esc(st.drill.bestSan)}</b>: ${tagLine(describeMove(st.drill.fen, st.drill.best), ['weak'])}</p>`}
      <p class="small muted">${st.drillResult.correct ? 'This one comes back later, spaced further out.' : 'This one comes back soon.'}</p>
      <div class="row-btns"><button data-act="idea-drill">👁 Show the idea</button><button data-act="next-drill" class="primary">Next drill</button><button data-act="pick-issue">Change issue</button></div></div>`);
  }
  if (st.hint > 0 && !st.busy) out.push(hintCard());
}

// Coach buttons
$('#coach').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const ply = btn.dataset.ply != null ? Number(btn.dataset.ply) : null;
  const r = ply != null ? st.log[ply]?.review : st.review;
  switch (act) {
    case 'quiz-none': answerQuiz('none'); break;
    case 'quiz-skip': st.quiz.answered = true; st.quiz.pick = 'skip'; refresh(); renderCoach(); break;
    case 'idea-best': openPreview(r.fenBefore, r.bestPv, r.isBest ? `Where ${r.san} leads` : `The better idea: ${r.best.san}`); break;
    case 'idea-refute': openPreview(r.fenAfter, r.refutePv, `How they punish ${r.san}`); break;
    case 'idea-now': openPreview(st.game.fen(), st.analysis.lines[0].pv, 'The engine\'s line'); break;
    case 'idea-drill': engine.analyse(st.drill.fen, { depth: settings.depth }).then((a) => openPreview(st.drill.fen, a.lines[0]?.pv || [st.drill.best], `The idea: ${st.drill.bestSan}`)); break;
    case 'pv-prev': previewStep(-1); break;
    case 'pv-next': previewStep(1); break;
    case 'pv-toggle': previewToggle(); break;
    case 'pv-close': closePreview(); refresh(); renderCoach(); break;
    case 'continue': continueGame(); break;
    case 'jump': goTo(ply); break;
    case 'live': goLive(); break;
    case 'next-drill': nextDrill(); break;
    case 'pick-issue': openDrills(undefined); break;
    case 'issue': setTab('drills', btn.dataset.issue || null); break;
    case 'back-game': case 'new': setTab('play'); newGame(); break;
    case 'drills': setTab('drills'); break;
  }
});
$('#moves').addEventListener('click', (e) => {
  const p = e.target.closest('[data-ply]');
  if (p) goTo(Number(p.dataset.ply));
});

// ---------- style view ----------
function renderStyle() {
  const s = styleSummary(profile);
  const e = eloPosterior(profile);
  const q = profile.quiz;
  const maxPost = Math.max(...e.post, 0.0001);
  const issues = issueSummary(profile).filter((i) => i.games || i.drills);
  const maxIssue = Math.max(1, ...issues.map((i) => i.games));
  $('#view-style').innerHTML = `
  <div class="card"><h3>What keeps going wrong</h3>
    ${issues.length ? `<p class="small muted">Every costly move gets one label. Fix the top one first — it's where most of your points go.</p>
    <div class="bars">${issues.map((i) => `<div class="axis"><div class="lbl"><span>${esc(i.label)}</span><span>${i.games}×</span></div><div class="track"><div class="fill" style="width:${(i.games / maxIssue) * 100}%;background:var(--meh)"></div></div></div>`).join('')}</div>
    <div class="row-btns">${issues.filter((i) => i.drills).slice(0, 3).map((i) => `<button data-act="issue" data-issue="${i.key}">Practice: ${esc(i.label)}</button>`).join('')}</div>`
    : '<p class="muted">No mistakes recorded yet. Play a game.</p>'}
  </div>
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
  <div class="card"><h3>Threat check</h3>
    ${q.total ? `<p><span class="big">${Math.round((q.right / q.total) * 100)}%</span> <span class="muted">spotted (${q.right}/${q.total}) · best streak ${q.best}</span></p><p class="small muted">The habit that separates club players: before every move, ask what their last move wants.</p>` : '<p class="muted">Answer threat checks during games to track this.</p>'}
  </div>
  <div class="row-btns end"><button data-act="reset-profile">Reset my stats</button></div>`;
}
$('#view-style').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'issue') { setTab('drills', b.dataset.issue || null); return; }
  if (b.dataset.act === 'reset-profile') {
    if (b.dataset.armed) { profile = resetProfile(); renderStyle(); } // pop-ups are blocked in some hosts, so confirm with a second tap
    else { b.dataset.armed = '1'; b.textContent = 'Tap again to erase stats & drills'; }
  }
});

// ---------- tabs, layers, buttons ----------
function setTab(tab, issue) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#view-board').hidden = tab === 'style';
  $('#view-style').hidden = tab !== 'style';
  if (tab === 'style') renderStyle();
  if (tab === 'drills') {
    if (st.mode !== 'drill') st.savedGame = { pgn: st.game.pgn(), myColor: st.myColor, log: st.log, review: st.review, opp: st.opp };
    openDrills(issue);
  }
  if (tab === 'play' && st.mode === 'drill') resumeGame();
}
function resumeGame() {
  st.mode = 'game'; st.drill = null; st.drillResult = null; st.drillPicking = false; st.preview = null; st.view = null;
  const g = st.savedGame;
  if (!g) { newGame(); return; }
  st.game = new Chess(); if (g.pgn) st.game.loadPgn(g.pgn);
  st.myColor = g.myColor; st.log = g.log || []; st.review = g.review; st.opp = g.opp;
  board.orientation = st.myColor;
  board.prevBoard = null;
  if (st.game.turn() === st.myColor || over()) startMyTurn(); else opponentMove(PAUSE_FIRST_MOVE);
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
document.querySelectorAll('#layers .chip').forEach((c) => c.addEventListener('click', () => {
  settings.layers[c.dataset.layer] = !settings.layers[c.dataset.layer]; saveSettings(); refresh();
}));
$('#btn-hint').addEventListener('click', () => { st.hint = Math.min(4, st.hint + 1); if (st.quiz && !st.quiz.answered) { st.quiz.answered = true; st.quiz.pick = 'skip'; } refresh(); renderCoach(); });
$('#btn-undo').addEventListener('click', takeBack);
document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', () => {
  if (settings.mode === b.dataset.mode) return;
  settings.mode = b.dataset.mode; saveSettings();
  st.quiz = null; st.hint = 0;
  // Switching to Play while the bot was waiting on you: let it move.
  if (!learning() && st.awaitingContinue) { continueGame(); return; }
  refresh(); renderCoach();
}));
$('#btn-new').addEventListener('click', () => { if (st.mode === 'drill') setTab('play'); else if (!st.busy || over()) newGame(); });
$('#btn-back').addEventListener('click', () => goTo(curPly() - 1));
$('#btn-fwd').addEventListener('click', () => goTo(curPly() + 1));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,select,textarea,dialog')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); if (st.preview) previewStep(-1); else goTo(curPly() - 1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); if (st.preview) previewStep(1); else if (st.view != null) goTo(curPly() + 1); }
});

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
  if (maia.ready && st.game.turn() === st.myColor && !st.busy && st.view == null) startMyTurn();
}
$('#model-banner').addEventListener('click', (e) => { if (e.target.dataset.act === 'dl') loadModel((cb) => maia.loadUrl(settings.modelUrl, cb)); });
$('#model-banner').addEventListener('change', (e) => { if (e.target.files?.[0]) loadModel(() => maia.loadFile(e.target.files[0])); });
$('#btn-model-dl').addEventListener('click', () => loadModel((cb) => maia.loadUrl($('#set-modelurl').value || DEFAULT_MODEL_URL, cb)));
$('#model-file').addEventListener('change', (e) => { if (e.target.files?.[0]) loadModel(() => maia.loadFile(e.target.files[0])); });

// ---------- boot ----------
renderModel();
maia.loadCached(settings.modelUrl).then(() => renderModel());
newGame();
window.__gym = { st, engine, maia, settings, profile: () => profile, goTo };
window.__gymBoard = board;
