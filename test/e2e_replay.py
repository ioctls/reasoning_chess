import time
from playwright.sync_api import sync_playwright
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg=b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2)
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERR '+str(e)))
    pg.goto('http://localhost:8766/index.html')
    pg.wait_for_function('window.__gym && window.__gym.st.analysis', timeout=60000)
    pg.set_input_files('#model-banner input[type=file]', 'test/dummy.onnx')
    pg.wait_for_function('window.__gym.maia.ready', timeout=30000)
    def tap(sq):
        box=pg.locator('#board svg').bounding_box(); f='abcdefgh'.index(sq[0]); r=int(sq[1])-1
        pg.mouse.click(box['x']+(f+.5)*box['width']/8, box['y']+(7-r+.5)*box['height']/8)
    anims=[]
    for frm,to in [('e2','e4'),('d1','h5'),('h5','f7'),('g1','f3'),('b1','c3')]:
        pg.wait_for_function('!window.__gym.st.busy && window.__gym.st.game.turn()==="w"', timeout=60000)
        if pg.evaluate('!!(window.__gym.st.quiz && !window.__gym.st.quiz.answered)'): pg.click('[data-act=quiz-skip]')
        legal = pg.evaluate(f'window.__gym.st.game.moves({{verbose:true}}).some(m=>m.from==="{frm}"&&m.to==="{to}")')
        if not legal:
            mv = pg.evaluate('window.__gym.st.game.moves({verbose:true})[0]'); frm,to = mv['from'],mv['to']
        tap(frm); tap(to)
        time.sleep(0.08)
        anims.append(pg.evaluate("document.querySelector('#board svg').getAnimations({subtree:true}).length"))
        pg.wait_for_function('window.__gym.st.review && !window.__gym.st.review.pending', timeout=60000)
        r = pg.evaluate('window.__gym.st.review'); print(f'{frm}{to}', r['san'], r['v']['label'], 'issue=', r.get('issue'))
    pg.wait_for_function('!window.__gym.st.busy', timeout=60000); time.sleep(1)
    print('animations running right after each move:', anims)
    n = pg.evaluate('window.__gym.st.log.length'); print('log length', n)
    for _ in range(3): pg.click('#btn-back'); time.sleep(0.35)
    print('view after 3x back:', pg.evaluate('window.__gym.st.view'))
    pg.screenshot(path='test/out/r1_replay.png', full_page=True)
    pg.locator('#moves [data-ply="2"]').click(); time.sleep(0.4)
    print('view after click ply 2:', pg.evaluate('window.__gym.st.view'))
    pg.screenshot(path='test/out/r2_replay_mine.png', full_page=True)
    pg.click('[data-act=live]'); print('live:', pg.evaluate('window.__gym.st.view'))
    pg.click('.tabs [data-tab=drills]'); time.sleep(.5)
    pg.screenshot(path='test/out/r3_issues.png', full_page=True)
    btns = pg.locator('[data-act=issue]').count(); print('issue buttons', btns)
    pg.locator('[data-act=issue]').first.click()
    pg.wait_for_function('window.__gym.st.drill && window.__gym.st.analysis', timeout=60000)
    pg.screenshot(path='test/out/r4_drill.png', full_page=True)
    print('drill issue', pg.evaluate('window.__gym.st.drillIssue'))
    pg.click('.tabs [data-tab=play]'); pg.wait_for_function('window.__gym.st.mode==="game" && !window.__gym.st.busy', timeout=60000)
    print('resumed log', pg.evaluate('window.__gym.st.log.length'))
    pg.click('.tabs [data-tab=style]'); time.sleep(.4); pg.screenshot(path='test/out/r5_style.png', full_page=True)
    b.close()
print('ERRORS', errs)
