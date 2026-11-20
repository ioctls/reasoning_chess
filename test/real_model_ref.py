# Reference: run the real Maia-3 model with the official encoding (numpy port of CSSLab/maia3)
# and print the top moves for a set of positions. CI compares this with the app's JS encoding.
import json, sys, chess, numpy as np, onnxruntime as ort
sys.argv += [] ; MODEL = sys.argv[1] if len(sys.argv) > 1 else 'models/maia3-5m.fp16.onnx'
PIECE = {chess.PAWN:1, chess.KNIGHT:2, chess.BISHOP:3, chess.ROOK:4, chess.QUEEN:5, chess.KING:6}
def all_moves():
    out = []
    for r in range(8):
        for f in range(8):
            sq = chess.square(f, r)
            for tr in range(8):
                for tf in range(8): out.append(chess.square_name(sq) + chess.square_name(chess.square(tf, tr)))
    for a in 'abcdefgh':
        for b in 'abcdefgh':
            for p in 'qrbn': out.append(f'{a}7{b}8{p}')
    return out
IDX = {m: i for i, m in enumerate(all_moves())}
mir = lambda u: u[0] + str(9 - int(u[1])) + u[2] + str(9 - int(u[3])) + u[4:]
def tokens(b):
    t = np.zeros((64, 12), np.float32)
    if b.turn == chess.BLACK: b = b.mirror()
    for sq in chess.SQUARES:
        p = b.piece_at(sq)
        if p: t[sq][PIECE[p.piece_type] + (6 if p.color == chess.BLACK else 0) - 1] = 1
    return t
FENS = [chess.STARTING_FEN,
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
        'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4']
so = ort.SessionOptions()
so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC  # same as the app; full fusion breaks on this fp16 graph
s = ort.InferenceSession(MODEL, so)
print('inputs', [(i.name, i.shape) for i in s.get_inputs()], 'outputs', [o.name for o in s.get_outputs()], file=sys.stderr)
res = []
for fen in FENS:
    b = chess.Board(fen)
    feeds = {'tokens': tokens(b)[None], 'elo_self': np.array([1500], np.float32), 'elo_oppo': np.array([1500], np.float32)}
    lm = s.run(['logits_move'], feeds)[0][0]
    legal = [(m.uci(), float(lm[IDX[m.uci() if b.turn else mir(m.uci())]])) for m in b.legal_moves]
    mx = max(v for _, v in legal); e = {u: np.exp(v - mx) for u, v in legal}; z = sum(e.values())
    top = sorted(((u, e[u] / z) for u in e), key=lambda x: -x[1])[:3]
    res.append({'fen': fen, 'top': [[u, round(p, 4)] for u, p in top]})
print(json.dumps(res))
