import time, json, sys
from playwright.sync_api import sync_playwright
port = sys.argv[1] if len(sys.argv)>1 else '8766'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2)
    pg=ctx.new_page()
    pg.goto(f'http://localhost:{port}/index.html')
    pg.wait_for_function('window.__gym && window.__gym.st.analysis', timeout=60000)
    pg.set_input_files('#model-banner input[type=file]', 'test/dummy.onnx')
    pg.wait_for_function('window.__gym.maia.ready', timeout=30000)
    cdp=ctx.new_cdp_session(pg); cdp.send('Emulation.setCPUThrottlingRate', {'rate':4})
    pg.evaluate("""() => { window.__lt=[]; new PerformanceObserver(l=>{for(const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)])}).observe({type:'longtask', buffered:false});
      // timestamp when a slide animation first appears after a tap
      window.__tapT=0; window.__lag=[];
      document.querySelector('#board').addEventListener('click', ()=>{ window.__tapT=performance.now(); }, true);
      const poll=()=>{ const n=document.querySelector('#board svg').getAnimations({subtree:true}).length; if(window.__tapT && n){ window.__lag.push(Math.round(performance.now()-window.__tapT)); window.__tapT=0;} requestAnimationFrame(poll)}; poll(); }""")
    def tap(sq):
        box=pg.locator('#board svg').bounding_box(); f='abcdefgh'.index(sq[0]); r=int(sq[1])-1
        pg.mouse.click(box['x']+(f+.5)*box['width']/8, box['y']+(7-r+.5)*box['height']/8)
    for frm,to in [('e2','e4'),('g1','f3'),('f1','c4'),('b1','c3')]:
        pg.wait_for_function('!window.__gym.st.busy && window.__gym.st.game.turn()==="w"', timeout=120000)
        if pg.evaluate('!!(window.__gym.st.quiz && !window.__gym.st.quiz.answered)'): pg.click('[data-act=quiz-skip]')
        if not pg.evaluate(f'window.__gym.st.game.moves({{verbose:true}}).some(m=>m.from==="{frm}"&&m.to==="{to}")'):
            mv=pg.evaluate('window.__gym.st.game.moves({verbose:true})[0]'); frm,to=mv['from'],mv['to']
        tap(frm); time.sleep(0.3); pg.evaluate('window.__lt.length=0'); tap(to)
        pg.wait_for_function('window.__gym.st.review && !window.__gym.st.review.pending', timeout=120000)
        time.sleep(0.3)
        print(f'{frm}{to}: tap->slide {pg.evaluate("window.__lag[window.__lag.length-1]")}ms, long tasks after tap: {pg.evaluate("window.__lt.slice(0,6)")}')
    # what does a full board render cost?
    print('render x20 avg ms:', pg.evaluate("()=>{const B=window.__gym; const t=performance.now(); for(let i=0;i<20;i++){document.querySelector('#board svg') && B && 0;} return 0}"))
    print('board.render avg ms:', pg.evaluate("""()=>{ const bd=document.querySelector('#board'); const t0=performance.now(); for(let i=0;i<20;i++){ window.__gymBoard ? window.__gymBoard.render() : 0 } return (performance.now()-t0)/20 }"""))
    print('maia predict ms:', pg.evaluate("""async()=>{const {Chess}=await import('./vendor/chess/chess.js'); const c=new Chess(); const t=performance.now(); await window.__gym.maia.predict(c,1200,1200); return Math.round(performance.now()-t)}"""))
    print('maia 10-elo batch ms:', pg.evaluate("""async()=>{const {Chess}=await import('./vendor/chess/chess.js'); const c=new Chess(); const t=performance.now(); await window.__gym.maia.moveProbAcrossElos(c,'e2e4',[600,800,1000,1200,1400,1600,1800,2000,2200,2400],1200); return Math.round(performance.now()-t)}"""))
    b.close()
