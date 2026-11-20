# Dummy ONNX with Maia-3's exact I/O signature, to test the browser pipeline end to end.
import numpy as np, onnx, json, chess, sys
from onnx import helper, TensorProto, numpy_helper
import onnxruntime as ort
sys.path.insert(0,'test'); 
rng=np.random.default_rng(0)
W=rng.normal(size=(768,4352)).astype(np.float32); B=rng.normal(size=(1,4352)).astype(np.float32)*0.001
V=rng.normal(size=(768,3)).astype(np.float32)
nodes=[helper.make_node('Reshape',['tokens','shape'],['flat']),
 helper.make_node('MatMul',['flat','W'],['mm']),
 helper.make_node('Unsqueeze',['elo_self','ax'],['elo2']),
 helper.make_node('MatMul',['elo2','B'],['eb']),
 helper.make_node('Add',['mm','eb'],['logits_move']),
 helper.make_node('MatMul',['flat','V'],['logits_value'])]
g=helper.make_graph(nodes,'dummy',
 [helper.make_tensor_value_info('tokens',TensorProto.FLOAT,['b',64,12]),helper.make_tensor_value_info('elo_self',TensorProto.FLOAT,['b']),helper.make_tensor_value_info('elo_oppo',TensorProto.FLOAT,['b'])],
 [helper.make_tensor_value_info('logits_move',TensorProto.FLOAT,['b',4352]),helper.make_tensor_value_info('logits_value',TensorProto.FLOAT,['b',3])],
 [numpy_helper.from_array(np.array([-1,768],dtype=np.int64),'shape'),numpy_helper.from_array(W,'W'),numpy_helper.from_array(B,'B'),numpy_helper.from_array(V,'V'),numpy_helper.from_array(np.array([1],dtype=np.int64),'ax')])
m=helper.make_model(g,opset_imports=[helper.make_opsetid('',17)]); m.ir_version=8
onnx.save(m,'test/dummy.onnx')
# expected top-3 for a black-to-move position using reference encoding
exec(open('test/ref_encode.py').read().split('moves=get_all_possible_moves()')[0])
moves=get_all_possible_moves(); d={m:i for i,m in enumerate(moves)}
fen='r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 3 3'
b=chess.Board(fen); t=tokenize(b)[None]
s=ort.InferenceSession('test/dummy.onnx')
lm=s.run(None,{'tokens':t,'elo_self':np.array([1500],np.float32),'elo_oppo':np.array([1500],np.float32)})[0][0]
legal=[(m.uci(), lm[d[mirror_move(m.uci())]]) for m in b.legal_moves]
legal.sort(key=lambda x:-x[1]); ex=np.exp(np.array([l[1] for l in legal])-legal[0][1]); p=ex/ex.sum()
json.dump({'fen':fen,'top':[[legal[i][0],float(p[i])] for i in range(3)]},open('test/dummy_expected.json','w'))
print(open('test/dummy_expected.json').read())
