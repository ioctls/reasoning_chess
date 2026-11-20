import time
from playwright.sync_api import sync_playwright
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg=b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.goto('http://localhost:8766/index.html')
    pg.evaluate("""localStorage.setItem('chessgym.profile.v1', JSON.stringify({drills:[{id:1,fen:'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1',best:'d5c7',bestSan:'Nc7+',kinds:['check','fork'],mySan:'Ke2',box:0,due:0}]}))""")
    pg.reload()
    pg.wait_for_function('window.__gym && window.__gym.st.analysis', timeout=60000)
    pg.click('.tabs [data-tab=drills]')
    pg.locator('[data-act=issue]').first.click()
    pg.wait_for_function('window.__gym.st.mode==="drill" && window.__gym.st.analysis', timeout=60000)
    pg.click('#btn-hint'); pg.click('#btn-hint'); pg.click('#btn-hint'); time.sleep(.3)
    pg.screenshot(path='test/out/6_drill.png')
    def tap(sq):
        box=pg.locator('#board svg').bounding_box(); f='abcdefgh'.index(sq[0]); r=int(sq[1])-1
        pg.mouse.click(box['x']+(f+.5)*box['width']/8, box['y']+(7-r+.5)*box['height']/8)
    tap('d5'); tap('c7')
    pg.wait_for_function('window.__gym.st.drillResult', timeout=60000)
    print('drill correct:', pg.evaluate('window.__gym.st.drillResult.correct'), 'box', pg.evaluate('window.__gym.profile().drills[0].box'))
    pg.click('[data-act=next-drill]'); time.sleep(.5)
    pg.click('.tabs [data-tab=play]')
    pg.wait_for_function('window.__gym.st.mode==="game" && !window.__gym.st.busy', timeout=60000)
    print('back in game, history', pg.evaluate('window.__gym.st.game.history().length'))
    b.close()
print('ERRORS', errs)
