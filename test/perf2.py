import time
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844}); pg=ctx.new_page()
    pg.goto('http://localhost:8766/index.html')
    pg.wait_for_function('window.__gym && window.__gym.st.analysis', timeout=60000)
    cdp=ctx.new_cdp_session(pg); cdp.send('Emulation.setCPUThrottlingRate', {'rate':4})
    print(pg.evaluate("""async()=>{
      const A=await import('./js/analysis.js'); const {Chess}=await import('./vendor/chess/chess.js');
      const fen='r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
      const T=(f,n=5)=>{const t=performance.now(); for(let i=0;i<n;i++) f(); return +((performance.now()-t)/n).toFixed(1)};
      const c=new Chess(fen); const mv=c.moves({verbose:true})[5];
      return {
        describeMove: T(()=>A.describeMove(fen, mv.from+mv.to)),
        hangingPieces: T(()=>A.hangingPieces(A.boardFromFen(fen),'w')),
        controlMap: T(()=>A.controlMap(A.boardFromFen(fen))),
        mateInOne: T(()=>A.mateInOne(fen)),
        forcingMoves: T(()=>A.forcingMoves(fen),2),
        moveFeatures: T(()=>A.moveFeatures(fen, mv.from+mv.to)),
        boardRender: T(()=>window.__gymBoard.render(),10),
      }}"""))
    b.close()
