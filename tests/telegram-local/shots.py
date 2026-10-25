# Screenshot set for design reviews (works with 0.4.0 and later; data from seed-rich.mjs).
# Usage: python shots.py <out_dir> <prefix> [widths]   (server on :3000, test mode, local test token)
import os, subprocess, sys
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); TOKEN = '123456:local-test-token-abcdefghijklmnopqrstuv'
NODE = os.environ.get('NODE', 'node'); BASE = 'http://localhost:3000'
OUT, PREFIX = sys.argv[1], sys.argv[2]; WIDTHS = [int(x) for x in (sys.argv[3] if len(sys.argv) > 3 else '375').split(',')]
os.makedirs(OUT, exist_ok=True)
def launch(uid, name, scheme): return subprocess.check_output([NODE, os.path.join(HERE, 'initdata.mjs'), TOKEN, str(uid), name, scheme, ''], text=True).strip()
PROXY = "window.TelegramWebviewProxy={postEvent:function(){}};"
def shoot(page, name, full=True):
    # Long shots: grow the viewport to the page height so fixed bars stay at the edges.
    page.wait_for_timeout(900); vp = page.viewport_size
    if full:
        h = min(4000, page.evaluate('document.documentElement.scrollHeight')); page.set_viewport_size({'width': vp['width'], 'height': max(vp['height'], h)}); page.wait_for_timeout(250)
    page.screenshot(path=f'{OUT}/{PREFIX}-{name}.png'); page.set_viewport_size(vp)
def enter(browser, uid, name, w, scheme):
    ctx = browser.new_context(viewport={'width': w, 'height': 844}, device_scale_factor=2, color_scheme=scheme, is_mobile=True, has_touch=True)
    ctx.add_init_script(PROXY); page = ctx.new_page(); page.goto(BASE + '/' + launch(uid, name, scheme))
    page.wait_for_selector('.app-body, [data-act=login], [data-act=choose-role]', timeout=10000); page.wait_for_timeout(300)
    if page.locator('[data-act=login]').count():
        shoot(page, f'welcome-{w}-{scheme}', False) if uid == 777001 else None
        page.click('[data-act=login]'); page.wait_for_selector('.app-body', timeout=10000)
    return ctx, page
def nav(page, target):
    page.click(f'[data-act=nav][data-page={target}] >> visible=true >> nth=0'); page.wait_for_timeout(200)
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    for w in WIDTHS:
        for scheme in ['light', 'dark']:
            tag = f'{w}-{scheme}'
            ctx, page = enter(browser, 777001, 'Анна', w, scheme)
            shoot(page, f'owner-home-{tag}')
            nav(page, 'apartments'); shoot(page, f'owner-apartment-{tag}')
            page.click('.apartment-tabs [data-tab=meters]'); shoot(page, f'owner-meters-{tag}')
            nav(page, 'finances'); shoot(page, f'owner-finances-{tag}')
            page.click('text=Аренда за октябрь >> nth=0'); shoot(page, f'owner-charge-{tag}')
            nav(page, 'profile'); shoot(page, f'owner-profile-{tag}')
            ctx.close()
            ctx, page = enter(browser, 900005, 'Ольга', w, scheme)
            shoot(page, f'tenant-home-{tag}')
            nav(page, 'requests'); shoot(page, f'tenant-requests-{tag}')
            nav(page, 'finances'); page.click('text=Аренда за октябрь >> nth=0'); shoot(page, f'tenant-charge-{tag}')
            nav(page, 'documents'); shoot(page, f'tenant-documents-{tag}')
            ctx.close()
            ctx = browser.new_context(viewport={'width': w, 'height': 844}, device_scale_factor=2, color_scheme=scheme, is_mobile=True, has_touch=True)
            ctx.add_init_script(PROXY); page = ctx.new_page(); newcomer = 900070 + WIDTHS.index(w) * 2 + (scheme == 'dark'); page.goto(BASE + '/' + launch(newcomer, 'Новый', scheme))
            page.wait_for_selector('[data-act=login]', timeout=10000); shoot(page, f'newcomer-welcome-{tag}', False)
            page.click('[data-act=login]'); page.wait_for_selector('.role-page, .app-body', timeout=10000); shoot(page, f'newcomer-role-{tag}', False)
            if page.locator('[data-act=choose-role]').count():
                role = 'tenant' if scheme == 'light' else 'owner'; page.click(f'[data-act=choose-role][data-role={role}]'); page.wait_for_selector('.empty-state', timeout=10000); shoot(page, f'newcomer-{role}-empty-{tag}')
            ctx.close()
    browser.close()
print('shots done')
