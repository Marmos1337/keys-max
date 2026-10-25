# Width sweep: every main screen of both roles at phone, tablet and computer widths,
# light and dark. Fails on horizontal overflow, clipped text controls or page errors.
# Usage: python sweep.py   (server on :3000 with seed-rich.mjs data)
import os, subprocess, sys
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); TOKEN = '123456:local-test-token-abcdefghijklmnopqrstuv'; NODE = os.environ.get('NODE', 'node'); BASE = 'http://localhost:3000'
WIDTHS = [320, 360, 375, 390, 414, 430, 768, 1024, 1280, 1440, 1920]
PAGES = {'owner': ['home', 'apartments', 'requests', 'finances', 'documents', 'profile', 'notifications'], 'tenant': ['home', 'apartments', 'requests', 'finances', 'documents', 'profile', 'meters']}
def launch(uid, name, scheme): return subprocess.check_output([NODE, os.path.join(HERE, 'initdata.mjs'), TOKEN, str(uid), name, scheme, ''], text=True).strip()
CHECK = """() => { const out = []; const W = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > W + 1) out.push('page overflow ' + document.documentElement.scrollWidth + '>' + W);
  for (const el of document.querySelectorAll('main *, .modal *, .bottom-nav *, .topbar *')) {
    const r = el.getBoundingClientRect(); if (!r.width || getComputedStyle(el).position === 'fixed') continue;
    if (r.right > W + 1.5 && !el.closest('.segmented, .shared-readings, [data-ui=segmented]')) { out.push('sticks out: ' + (el.className || el.tagName) + ' ' + Math.round(r.right)); if (out.length > 4) break; }
  } return out; }"""
problems = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    for scheme in ['light', 'dark']:
        for role, uid, name in [('owner', 777001, 'Анна'), ('tenant', 900005, 'Ольга')]:
            ctx = browser.new_context(viewport={'width': 375, 'height': 820}, color_scheme=scheme, is_mobile=False)
            ctx.add_init_script("window.TelegramWebviewProxy={postEvent:function(){}};"); page = ctx.new_page(); errs = []
            page.on('pageerror', lambda e: errs.append(str(e)))
            page.goto(BASE + '/' + launch(uid, name, scheme)); page.wait_for_selector('.app-body', timeout=10000)
            for w in WIDTHS:
                page.set_viewport_size({'width': w, 'height': 820})
                for target in PAGES[role]:
                    sel = f'[data-act=nav][data-page={target}]'
                    if page.locator(sel + ' >> visible=true').count(): page.click(sel + ' >> visible=true >> nth=0')
                    else: page.evaluate("t => document.querySelector(`[data-act=nav][data-page=${t}]`)?.click()", target)
                    page.wait_for_timeout(120)
                    if target == 'apartments':
                        for tab in ['overview', 'contract', 'meters', 'payments', 'history']:
                            if page.locator(f'.apartment-tabs [data-tab={tab}]').count(): page.click(f'.apartment-tabs [data-tab={tab}]'); page.wait_for_timeout(80); res = page.evaluate(CHECK); [problems.append(f'{scheme} {role} {w} apartments/{tab}: {x}') for x in res]
                    res = page.evaluate(CHECK); [problems.append(f'{scheme} {role} {w} {target}: {x}') for x in res]
            problems += [f'{scheme} {role} page error: {e}' for e in errs]
            ctx.close()
    browser.close()
print('\n'.join(problems[:60]) or 'no problems'); print(f'{len(problems)} problems'); sys.exit(1 if problems else 0)
