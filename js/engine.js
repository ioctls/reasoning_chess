// Stockfish 18 (lite, single-threaded WASM) in a Web Worker.
// Jobs are serialized: one search at a time, each resolved on "bestmove".

export class Stockfish {
  constructor(path = './vendor/stockfish/stockfish-18-lite-single.js') {
    this.worker = new Worker(path);
    this.queue = Promise.resolve();
    this.listeners = new Set();
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);
      for (const l of [...this.listeners]) l(line);
    };
    this.ready = this._run(['uci'], (l) => l === 'uciok')
      .then(() => this._run(['isready'], (l) => l === 'readyok'));
  }

  _run(cmds, isDone, onLine) {
    return new Promise((resolve) => {
      const h = (line) => {
        onLine && onLine(line);
        if (isDone(line)) { this.listeners.delete(h); resolve(line); }
      };
      this.listeners.add(h);
      cmds.forEach((c) => this.worker.postMessage(c));
    });
  }

  /** Queue a job so searches never overlap. */
  _enqueue(fn) {
    const p = this.queue.then(() => this.ready).then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  /**
   * Analyse a position. Scores are from the side to move's point of view.
   * Returns { lines: [{ score: {cp}|{mate}, pv: [uci...] }], best }
   */
  analyse(fen, { depth = 12, multipv = 1 } = {}) {
    return this._enqueue(() => {
      const lines = [];
      const onLine = (l) => {
        if (!l.startsWith('info') || !l.includes(' pv ')) return;
        const mpv = Number((l.match(/ multipv (\d+)/) || [0, 1])[1]);
        const cp = l.match(/ score cp (-?\d+)/), mate = l.match(/ score mate (-?\d+)/);
        if (l.includes('lowerbound') || l.includes('upperbound')) return;
        const pv = l.split(' pv ')[1].trim().split(/\s+/);
        lines[mpv - 1] = { score: mate ? { mate: Number(mate[1]) } : { cp: Number(cp ? cp[1] : 0) }, pv, depth: Number((l.match(/ depth (\d+)/) || [0, 0])[1]) };
      };
      return this._run(
        ['ucinewgame', `setoption name MultiPV value ${multipv}`, `position fen ${fen}`, `go depth ${depth}`],
        (l) => l.startsWith('bestmove'),
        onLine,
      ).then((l) => {
        const best = l.split(' ')[1];
        const clean = lines.filter(Boolean);
        if (!clean.length && best && best !== '(none)') clean.push({ score: { cp: 0 }, pv: [best] });
        return { lines: clean, best: best === '(none)' ? null : best };
      });
    });
  }

  /** Weaker play for the fallback opponent when Maia isn't loaded. */
  playMove(fen, elo) {
    const skill = Math.max(0, Math.min(20, Math.round((elo - 600) / 90)));
    return this._enqueue(() => this._run(
      ['ucinewgame', 'setoption name MultiPV value 1', `setoption name Skill Level value ${skill}`, `position fen ${fen}`, 'go depth 8'],
      (l) => l.startsWith('bestmove'),
    ).then((l) => {
      this.worker.postMessage('setoption name Skill Level value 20');
      return l.split(' ')[1];
    }));
  }
}
