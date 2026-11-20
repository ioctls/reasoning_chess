// Maia-3 (human-like move prediction) via onnxruntime-web.
// The model file is fetched once and kept in the browser's Cache Storage,
// so after the first load everything runs offline on-device.

import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { encodeBoard, legalMoveIndices, legalPolicy, wdlFromLogits, VOCAB_SIZE } from './maia-encode.js';

export const DEFAULT_MODEL_URL = 'https://huggingface.co/bqrio/maia3-onnx/resolve/main/maia3-5m.fp16.onnx';
const CACHE = 'chess-gym-models-v1';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;

export class Maia {
  constructor() { this.session = null; this.source = null; }

  get ready() { return !!this.session; }

  async _create(bytes, source) {
    // 'basic' optimisation: the more aggressive fusions break on this graph's fp16 casts.
    this.session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'basic' });
    this.source = source;
    return this;
  }

  /** Try the cache only (no network). Returns true if loaded. */
  async loadCached(url = DEFAULT_MODEL_URL) {
    try {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(url);
      if (!hit) return false;
      await this._create(new Uint8Array(await hit.arrayBuffer()), 'cache');
      return true;
    } catch { return false; }
  }

  async loadUrl(url = DEFAULT_MODEL_URL, onProgress = () => {}) {
    if (await this.loadCached(url)) return this;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onProgress(total ? got / total : null, got);
    }
    const bytes = new Uint8Array(got);
    let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
    try { (await caches.open(CACHE)).put(url, new Response(bytes.slice())); } catch { /* private mode etc. */ }
    return this._create(bytes, 'download');
  }

  async loadFile(file) {
    return this._create(new Uint8Array(await file.arrayBuffer()), 'file');
  }

  async _run(chess, selfElos, oppoElos) {
    const n = selfElos.length;
    const one = encodeBoard(chess);
    const tokens = new Float32Array(n * one.length);
    for (let i = 0; i < n; i++) tokens.set(one, i * one.length);
    const feeds = {
      tokens: new ort.Tensor('float32', tokens, [n, 64, 12]),
      elo_self: new ort.Tensor('float32', Float32Array.from(selfElos), [n]),
      elo_oppo: new ort.Tensor('float32', Float32Array.from(oppoElos), [n]),
    };
    if (this.session.inputNames.includes('history')) {
      const h = new Float32Array(n * 64 * 96);
      for (let b = 0; b < n; b++) for (let s = 0; s < 64; s++) for (let k = 0; k < 8; k++)
        h.set(one.subarray(s * 12, s * 12 + 12), b * 64 * 96 + s * 96 + k * 12);
      feeds.history = new ort.Tensor('float32', h, [n, 64, 96]);
    }
    const out = await this.session.run(feeds);
    return { move: out.logits_move.data, value: out.logits_value.data };
  }

  /** Human move distribution for the side to move, at a given rating. */
  async predict(chess, eloSelf, eloOppo = eloSelf) {
    const legal = legalMoveIndices(chess);
    if (!legal.length) return { moves: [], wdl: null };
    const out = await this._run(chess, [eloSelf], [eloOppo]);
    return { moves: legalPolicy(out.move, legal), wdl: wdlFromLogits(out.value) };
  }

  /** Probability of one specific move at several ratings at once (one batched call). */
  async moveProbAcrossElos(chess, uci, elos, eloOppo) {
    const legal = legalMoveIndices(chess);
    const out = await this._run(chess, elos, elos.map(() => eloOppo));
    return elos.map((_, i) => {
      const pol = legalPolicy(out.move, legal, i * VOCAB_SIZE);
      return (pol.find((p) => p.uci === uci) || { p: 1e-6 }).p;
    });
  }
}

/** Sample a move the way a human at this level might (temperature 1, nucleus 0.95). */
export function sampleHuman(moves, topP = 0.95) {
  let acc = 0; const pool = [];
  for (const m of moves) { pool.push(m); acc += m.p; if (acc >= topP) break; }
  let r = Math.random() * acc;
  for (const m of pool) { r -= m.p; if (r <= 0) return m; }
  return pool[0];
}
