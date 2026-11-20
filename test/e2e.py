import json, sys, time
from playwright.sync_api import sync_playwright
exp=json.load(open('test/dummy_expected.json'))
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg=b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2)
    pg.on('console', lambda m: errs.append(m.text) if m.type in ('error','warning') else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERR '+str(e)))
    pg.goto('http://localhost:8766/index.html')
    pg.wait_for_function('window.__gym && window.__gym.st.analysis', timeout=60000)
    print('engine ok; eval lines:', pg.evaluate('window.__gym.st.analysis.lines.length'))
    pg.screenshot(path='test/out/1_start.png', full_page=True)
    # load dummy model via the banner file input
    pg.set_input_files('#model-banner input[type=file]', 'test/dummy.onnx')
    pg.wait_for_function('window.__gym.maia.ready', timeout=30000)
    got=pg.evaluate("""async (fen)=>{const {Chess}=await import('./vendor/chess/chess.js');
      const r=await window.__gym.maia.predict(new Chess(fen),1500,1500); return r.moves.slice(0,3).map(m=>[m.uci,m.p])}""", exp['fen'])
    print('JS  top3', got); print('PY  top3', exp['top'])
    ok=all(a[0]==b_[0] and abs(a[1]-b_[1])<1e-3 for a,b_ in zip(got,exp['top']))
    print('maia pipeline match:', ok)
    def tap(sq):
        box=pg.locator('#board svg').bounding_box(); f='abcdefgh'.index(sq[0]); r=int(sq[1])-1
        pg.mouse.click(box['x']+(f+.5)*box['width']/8, box['y']+(7-r+.5)*box['height']/8)
    for frm,to in [('e2','e4'),('g1','f3'),('f1','c4')]:
        pg.wait_for_function('!window.__gym.st.busy && window.__gym.st.game.turn()==="w"', timeout=60000)
        # answer threat quiz if shown
        if pg.evaluate('!!(window.__gym.st.quiz && !window.__gym.st.quiz.answered)'):
            pg.click('[data-act=quiz-none]')
        tap(frm); tap(to)
        pg.wait_for_function('window.__gym.st.review && !window.__gym.st.review.pending', timeout=60000)
        print('moved', frm+to, '->', pg.evaluate('window.__gym.st.review.v.label'), pg.evaluate('window.__gym.st.review.humanP'))
    pg.wait_for_function('!window.__gym.st.busy', timeout=60000)
    time.sleep(2)
    print('history', pg.evaluate('window.__gym.st.game.history()'))
    pg.click('[data-layer=plan]'); pg.click('[data-layer=humans]'); pg.click('[data-layer=control]')
    time.sleep(1.5)
    pg.screenshot(path='test/out/2_layers.png', full_page=True)
    pg.click('#btn-hint'); pg.click('#btn-hint'); pg.click('#btn-hint'); pg.click('#btn-hint')
    time.sleep(.5); pg.screenshot(path='test/out/3_hint.png', full_page=True)
    btn=pg.locator('[data-act=idea-now]')
    if btn.count(): btn.click(); pg.click('[data-act=pv-next]'); time.sleep(.3); pg.screenshot(path='test/out/4_preview.png', full_page=True); pg.click('[data-act=pv-close]')
    pg.click('.tabs [data-tab=style]'); time.sleep(.5); pg.screenshot(path='test/out/5_style.png', full_page=True)
    print('profile moves', pg.evaluate('window.__gym.profile().moves.length'), 'eloN', pg.evaluate('window.__gym.profile().eloN'))
    b.close()
print('ERRORS:', [e for e in errs if 'favicon' not in e][:10])
