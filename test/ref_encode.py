# Faithful numpy port of CSSLab/maia3 tokenize_board / get_legal_moves_mask / get_all_possible_moves
import sys, json, random, chess, numpy as np
sys.path.insert(0, '/tmp/maia3')
PIECE_MAP = {chess.PAWN:1, chess.KNIGHT:2, chess.BISHOP:3, chess.ROOK:4, chess.QUEEN:5, chess.KING:6}
def get_all_possible_moves():
    all_moves=[]
    for rank in range(8):
        for file in range(8):
            sq=chess.square(file,rank)
            for tr in range(8):
                for tf in range(8):
                    all_moves.append(chess.square_name(sq)+chess.square_name(chess.square(tf,tr)))
    for a in 'abcdefgh':
        for b in 'abcdefgh':
            for p in 'qrbn': all_moves.append(f'{a}7{b}8{p}')
    return all_moves
def mirror_move(u):
    m=lambda s: s[0]+str(9-int(s[1]))
    return m(u[:2])+m(u[2:4])+u[4:]
def tokenize(board):
    t=np.zeros((64,12),dtype=np.float32)
    if board.turn==chess.BLACK: board=board.mirror()
    for sq in chess.SQUARES:
        p=board.piece_at(sq)
        if p: t[sq][PIECE_MAP[p.piece_type]+(6 if p.color==chess.BLACK else 0)-1]=1
    return t
moves=get_all_possible_moves(); d={m:i for i,m in enumerate(moves)}
assert len(moves)==4352
random.seed(1); out=[]
fens=["8/1P6/8/8/8/8/6p1/K6k w - - 0 1","8/1P6/8/8/8/8/6p1/K6k b - - 0 1","r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1","r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1"]
for g in range(30):
    b=chess.Board()
    for ply in range(random.randint(1,80)):
        lm=list(b.legal_moves)
        if not lm: break
        b.push(random.choice(lm))
    fens.append(b.fen())
for f in fens:
    b=chess.Board(f)
    t=tokenize(b)
    legal=sorted(d[(m.uci() if b.turn==chess.WHITE else mirror_move(m.uci()))] for m in b.legal_moves)
    out.append({"fen":f,"nz":np.flatnonzero(t.reshape(-1)).tolist(),"legal":legal})
json.dump(out,open('test/ref_encode.json','w'))
print(len(out),"positions")
