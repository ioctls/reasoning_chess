import time
from playwright.sync_api import sync_playwright
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg=b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2)
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERR '+str(e)))
    pg.goto('http://localhost:8766/index.html')
    pg.evaluate("localStorage.clear()"); pg.reload()
    pg.wait_for_function('window.__gym && window.__gym.st.analysis', timeout=60000)
    pg.set_input_files('#model-banner input[type=file]', 'test/dummy.onnx')
    pg.wait_for_function('window.__gym.maia.ready', timeout=30000)
    def tap(sq):
        box=pg.locator('#board svg').bounding_box(); f='abcdefgh'.index(sq[0]); r=int(sq[1])-1
        pg.mouse.click(box['x']+(f+.5)*box['width']/8, box['y']+(7-r+.5)*box['height']/8)
    def my_turn():
        pg.wait_for_function('!window.__gym.st.busy && window.__gym.st.game.turn()==="w"', timeout=120000)
        if pg.evaluate('!!(window.__gym.st.quiz && !window.__gym.st.quiz.answered)'): pg.click('[data-act=quiz-skip]')
    def move(frm,to):
        if not pg.evaluate(f'window.__gym.st.game.moves({{verbose:true}}).some(m=>m.from==="{frm}"&&m.to==="{to}")'):
            mv=pg.evaluate('window.__gym.st.game.moves({verbose:true})[0]'); frm,to=mv['from'],mv['to']
        tap(frm); tap(to)
    # ---- LEARN ----
    print('mode', pg.evaluate('window.__gym.settings.mode'))
    my_turn(); move('e2','e4')
    pg.wait_for_function('window.__gym.st.awaitingContinue', timeout=120000)
    time.sleep(2)
    print('learn: bot waited? plies =', pg.evaluate('window.__gym.st.game.history().length'), '| cards:', pg.locator('#coach > .card').count())
    pg.screenshot(path='test/out/m1_learn_review.png', full_page=True)
    pg.click('[data-act=continue]')
    pg.wait_for_function('window.__gym.st.game.history().length===2 && !window.__gym.st.thinking', timeout=60000); time.sleep(1.5)
    print('learn: after continue plies =', pg.evaluate('window.__gym.st.game.history().length'), '| cards:', pg.locator('#coach > .card').count(), '| review cleared:', pg.evaluate('window.__gym.st.review===null'))
    my_turn(); move('d1','h5')
    pg.wait_for_function('window.__gym.st.awaitingContinue', timeout=120000)
    btn = pg.locator('[data-act=idea-refute], [data-act=idea-best]').first
    btn.click(); t0=time.time()
    time.sleep(3.2)
    idx = pg.evaluate('window.__gym.st.preview.idx'); ev = pg.evaluate('window.__gym.st.preview.evals.length'); n = pg.evaluate('window.__gym.st.preview.sans.length')
    print(f'preview autoplay: idx={idx} of {n} after 3.2s, evals ready={ev}, bar={pg.inner_text("#evaltext")}')
    pg.screenshot(path='test/out/m2_preview.png', full_page=True)
    pg.click('[data-act=pv-toggle]'); i1=pg.evaluate('window.__gym.st.preview.idx'); time.sleep(1.6); i2=pg.evaluate('window.__gym.st.preview.idx')
    print('paused holds:', i1==i2, '| playing:', pg.evaluate('window.__gym.st.preview.playing'))
    pg.click('[data-act=pv-prev]'); print('back ->', pg.evaluate('window.__gym.st.preview.idx'))
    pg.click('[data-act=pv-close]')
    pg.click('[data-act=continue]')
    # ---- PLAY ----
    pg.click('#mode [data-mode=play]'); pg.click('#btn-new')
    for frm,to in [('e2','e4'),('g1','f3'),('d1','e2'),('e2','b5')]:
        my_turn(); move(frm,to)
        time.sleep(0.2)
        txt = pg.inner_text('#coach')
        assert 'Excellent' not in txt and 'Blunder' not in txt and 'Mistake' not in txt, txt
    my_turn()
    print('play: chips hidden:', not pg.locator('[data-layer=threats]').is_visible(), '| hint disabled:', pg.locator('#btn-hint').is_disabled(), '| undo label:', pg.inner_text('#btn-undo'))
    pg.screenshot(path='test/out/m3_play.png', full_page=True)
    pg.click('#btn-undo')  # resign
    time.sleep(1)
    print('report shown:', pg.locator('[data-key=report]').count()==1, '| graph:', pg.locator('.report-graph').count(), '| moments:', pg.locator('.moment').count())
    pg.screenshot(path='test/out/m4_report.png', full_page=True)
    if pg.locator('.moment').count():
        pg.locator('.moment').first.click(); time.sleep(.4)
        print('jumped to ply', pg.evaluate('window.__gym.st.view'), '| back label:', pg.inner_text('[data-act=live]'))
        pg.screenshot(path='test/out/m5_moment.png', full_page=True)
    b.close()
print('ERRORS', [e for e in errs if 'cpuid' not in e])
