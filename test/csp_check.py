# Loads the app under the exact CSP the Android app sends and reports anything it blocks.
import time, sys
from playwright.sync_api import sync_playwright
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8771/index.html#selftest'
logs=[]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg=b.new_page(viewport={'width':390,'height':844})
    pg.on('console', lambda m: logs.append((m.type, m.text)))
    pg.on('pageerror', lambda e: logs.append(('pageerror', str(e))))
    pg.goto(url)
    for _ in range(120):
        if any('SELFTEST' in t for _,t in logs): break
        time.sleep(0.5)
    print([t for _,t in logs if 'SELFTEST' in t] or 'no SELFTEST line')
    viol=[t for k,t in logs if 'Content Security Policy' in t or 'Refused' in t]
    print('CSP violations:', viol if viol else 'none')
    print('other errors:', [t for k,t in logs if k in ('error','pageerror') and 'cpuid' not in t and 'Refused' not in t and 'Content Security' not in t] or 'none')
    b.close()
