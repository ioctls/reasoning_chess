"""
Renders the Google Play graphics into store/ from the real app:
  store/icon-512.png, store/feature-graphic.png, store/screenshots/*.png (1080x1920)

Usage:  python3 -m http.server 8780 &   (from the repo root)
        python3 scripts/make_store_graphics.py
Needs Playwright + Chrome.
"""
import base64, os, time
from playwright.sync_api import sync_playwright

URL = 'http://localhost:8780/index.html'
OUT = 'store'
BG, INK, ACCENT = '#15171C', '#E9EDCC', '#3b82f6'
KNIGHT = ('M38,76 L70,76 C70,64 66,56 62,50 C68,52 74,52 76,46 C78,40 72,34 64,30 L58,26 L56,32 '
          'C48,32 40,38 38,48 C36,58 44,62 46,58 C48,54 52,52 56,52 C50,58 40,64 38,76 Z')
FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
os.makedirs(f'{OUT}/screenshots', exist_ok=True)


def knight_svg(size, bg=True):
    rect = f'<rect width="108" height="108" fill="{BG}"/>' if bg else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="{size}" height="{size}">{rect}'
            f'<path d="{KNIGHT}" fill="{INK}"/><rect x="34" y="78" width="40" height="6" fill="{INK}"/>'
            f'<circle cx="60" cy="38" r="2.5" fill="{BG}"/></svg>')


def render_html(browser, html, w, h, path):
    pg = browser.new_page(viewport={'width': w, 'height': h})
    pg.set_content(f'<!DOCTYPE html><html><body style="margin:0">{html}</body></html>')
    pg.screenshot(path=path)
    pg.close()


def caption_frame(browser, shot_png, title, sub, path):
    """1080x1920 store screenshot: caption on top, the app below."""
    b64 = base64.b64encode(open(shot_png, 'rb').read()).decode()
    html = f'''<div style="width:1080px;height:1920px;background:{BG};font-family:{FONT};color:#fff;
      display:flex;flex-direction:column;align-items:center;overflow:hidden">
      <div style="padding:70px 70px 40px;text-align:center">
        <div style="font-size:64px;font-weight:800;line-height:1.1">{title}</div>
        <div style="font-size:36px;color:#9aa3b2;margin-top:18px;line-height:1.3">{sub}</div></div>
      <img src="data:image/png;base64,{b64}" style="width:900px;border-radius:36px;border:3px solid #343a46;
        box-shadow:0 30px 80px rgba(0,0,0,.6)"></div>'''
    render_html(browser, html, 1080, 1920, path)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])

        # ---------- icon ----------
        render_html(browser, knight_svg(512), 512, 512, f'{OUT}/icon-512.png')

        # ---------- app screenshots ----------
        ctx = browser.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2.625)
        ctx.route('**/models/**', lambda r: r.abort())          # no human model: keeps screenshots honest
        pg = ctx.new_page()
        pg.goto(URL)
        pg.evaluate('localStorage.clear()')
        for f in os.listdir(f'{OUT}/screenshots'): os.remove(f'{OUT}/screenshots/{f}')
        pg.reload()
        pg.add_style_tag(content='#model-banner{display:none!important}')
        pg.wait_for_function('window.__gym && window.__gym.st.analysis', timeout=60000)

        def tap(sq):
            box = pg.locator('#board svg').bounding_box()
            flip = pg.evaluate('window.__gym.st.myColor') == 'b'
            f = 'abcdefgh'.index(sq[0]); r = int(sq[1]) - 1
            if flip: f, r = 7 - f, 7 - r
            pg.mouse.click(box['x'] + (f + .5) * box['width'] / 8, box['y'] + (7 - r + .5) * box['height'] / 8)

        def wait_my_turn():
            pg.wait_for_function('!window.__gym.st.busy && window.__gym.st.game.turn()==="w"', timeout=120000)

        def play(frm, to):
            if not pg.evaluate(f'window.__gym.st.game.moves({{verbose:true}}).some(m=>m.from==="{frm}"&&m.to==="{to}")'):
                mv = pg.evaluate('window.__gym.st.game.moves({verbose:true})[0]'); frm, to = mv['from'], mv['to']
            tap(frm); tap(to)
            pg.wait_for_function('window.__gym.st.review && !window.__gym.st.review.pending', timeout=120000)
            time.sleep(0.8)

        def shot(name, title, sub, clip_to_coach=True):
            raw = f'/tmp/raw-{name}.png'
            pg.evaluate('window.scrollTo(0,0)')
            time.sleep(0.4)
            pg.screenshot(path=raw)
            caption_frame(browser, raw, title, sub, f'{OUT}/screenshots/{name}.png')

        # 1. feedback on a move (Learn mode)
        wait_my_turn(); play('e2', 'e4'); pg.click('[data-act=continue]')
        wait_my_turn()
        if pg.evaluate('!!(window.__gym.st.quiz && !window.__gym.st.quiz.answered)'):
            time.sleep(1.5)
            shot('6-threat-check', 'Spot their threat first', 'Before every move: what is their last move after?')
            pg.click('[data-act=quiz-skip]')
        play('d1', 'h5')
        shot('1-feedback', 'Know why, every move', 'Plain-language feedback: forks, pins, threats, loose pieces')

        # 2. the better idea, playing itself with the eval bar
        btn = pg.locator('[data-act=idea-best], [data-act=idea-refute]').first
        btn.click(); time.sleep(4.2); pg.click('[data-act=pv-toggle]'); time.sleep(0.6)
        shot('2-see-the-idea', 'Watch the idea play out', 'Step through the line with the eval bar following along')
        pg.click('[data-act=pv-close]'); pg.click('[data-act=continue]')

        # 4. Play mode report
        pg.click('#mode [data-mode=play]'); pg.click('#btn-new')
        for frm, to in [('e2', 'e4'), ('d1', 'h5'), ('h5', 'f7'), ('g1', 'f3'), ('f1', 'c4'), ('b1', 'c3')]:
            wait_my_turn(); play(frm, to)
        wait_my_turn(); pg.click('#btn-undo'); time.sleep(1.5)  # resign -> report
        pg.locator('[data-key=report]').scroll_into_view_if_needed()
        pg.evaluate("document.querySelector('[data-key=report]').scrollIntoView({block:'start'})"); time.sleep(0.5)
        raw = '/tmp/raw-3-report.png'; pg.screenshot(path=raw)
        caption_frame(browser, raw, 'Play, then get a report', 'Your winning chances, key moments and what to work on', f'{OUT}/screenshots/3-report.png')

        # 5. practice by issue
        pg.click('.tabs [data-tab=drills]'); time.sleep(0.8)
        shot('4-practice', 'Practice your weak spots', 'Your own mistakes, grouped by what went wrong')

        # 6. style
        pg.click('.tabs [data-tab=style]'); time.sleep(0.8)
        # The rating estimate needs the human model, which is blocked here (it's built into the real app).
        pg.evaluate("[...document.querySelectorAll('#view-style .card')].filter(c => c.textContent.includes('Who you play like')).forEach(c => c.remove())")
        shot('5-style', 'See how you play', 'Your style vs. the engine, and where your points go')

        # feature graphic uses a clean board from the app
        pg.click('.tabs [data-tab=play]'); pg.click('#btn-new'); wait_my_turn()
        board_png = '/tmp/board.png'; pg.locator('#board').screenshot(path=board_png)
        ctx.close()

        # ---------- feature graphic 1024x500 ----------
        b64 = base64.b64encode(open(board_png, 'rb').read()).decode()
        html = f'''<div style="width:1024px;height:500px;background:{BG};font-family:{FONT};display:flex;align-items:center;overflow:hidden;position:relative">
          <div style="padding-left:70px;width:560px;color:#fff;z-index:1">
            <div style="display:flex;align-items:center;gap:18px">{knight_svg(84)}
              <div style="font-size:54px;font-weight:800;letter-spacing:-.5px">Reasonable Chess</div></div>
            <div style="font-size:30px;color:#c7cdd8;margin-top:22px;line-height:1.3">Chess intuition, explained.<br>Every move. Fully offline.</div>
            <div style="margin-top:26px;font-size:20px;color:#9aa3b2">Stockfish + Maia-3 · free · open source · no ads</div></div>
          <img src="data:image/png;base64,{b64}" style="position:absolute;right:-40px;top:40px;width:440px;border-radius:14px;transform:rotate(-4deg);box-shadow:0 30px 70px rgba(0,0,0,.6)"></div>'''
        render_html(browser, html, 1024, 500, f'{OUT}/feature-graphic.png')
        browser.close()
    print('done:', sorted(os.listdir(f'{OUT}/screenshots')))


if __name__ == '__main__':
    main()
