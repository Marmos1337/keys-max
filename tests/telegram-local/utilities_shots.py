# Screenshots of the 0.7 cash screens for design review: owner, co-owner and tenant homes, charge
# details, the utilities and collection sheets and their states, at each width × theme on a fresh seed.
# Usage: KEYS_REPO=<repo> python utilities_shots.py <out_dir> [widths=375,1280] [themes=light,dark]
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import utilities_e2e as U
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
WIDTHS = [int(x) for x in (sys.argv[2] if len(sys.argv) > 2 else '375,1280').split(',')]
THEMES = (sys.argv[3] if len(sys.argv) > 3 else 'light,dark').split(',')
audit = []
def shot(page, name, full=True, modal=False):
    path = f'{OUT}/{name}.png'
    if modal: page.locator('.modal').screenshot(path=path)
    else: page.screenshot(path=path, full_page=full)
    over = page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
    if over: audit.append((name, 'horizontal overflow'))
def open_record(page, who, rid, scheme):
    page.goto(U.url(who, scheme, 'r_' + rid)); page.wait_for_selector('.detail-body', timeout=15000); U.settle(page, 700)
def home(page, who, scheme): U.login(page, who, scheme); U.settle(page, 500)
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=True)
        for w in WIDTHS:
            for theme in THEMES:
                U.start(); ids = U.IDS; pre = f'{w}-{theme}'
                octx, own, oerr = U.page_for(browser, w, theme)
                home(own, 'stepan', theme); shot(own, f'{pre}-01-owner-home')
                open_record(own, 'stepan', ids['sept'], theme); shot(own, f'{pre}-02-owner-charge-claimed')
                open_record(own, 'stepan', ids['august_record'], theme); shot(own, f'{pre}-03-owner-utilities-detail')
                home(own, 'stepan', theme)
                own.click('.quick-grid.trio [data-act=utilities]'); own.wait_for_selector('[data-form=utilities]'); U.settle(own, 500)
                shot(own, f'{pre}-04-utilities-sheet', full=False)
                own.fill('[data-form=utilities] input[name=period]', '08.2026'); U.settle(own, 300)
                shot(own, f'{pre}-05-utilities-sheet-month-exists', full=False)
                own.click('[data-act=close-modal]'); U.settle(own)
                own.click('.cash-foot [data-act=cash-collect]'); own.wait_for_selector('[data-form=cash-collect]'); U.settle(own, 500)
                shot(own, f'{pre}-06-collection-all', full=False)
                own.locator('[data-collect-amount]').first.fill('999999'); U.settle(own, 200)
                shot(own, f'{pre}-07-collection-error', full=False)
                own.click('[data-act=close-modal]'); U.settle(own)
                own.click('.cash-foot [data-act=cash-collect]'); own.wait_for_selector('[data-form=cash-collect]'); U.settle(own, 400)
                own.click('[data-collect-submit]'); own.wait_for_selector('.toast-action', timeout=10000); U.settle(own, 600)
                shot(own, f'{pre}-08-owner-all-collected-toast', full=False)
                own.click('.toast-action'); own.wait_for_selector('.toast:has-text("отменена")', timeout=10000); U.settle(own)
                tctx, ten, terr = U.page_for(browser, w, theme)
                home(ten, 'sanya2', theme); shot(ten, f'{pre}-09-tenant-home-new-utilities')
                ten.locator('.fresh-card .cash-give').click(); ten.wait_for_selector('.fresh-card .cash-pill[data-state=claimed]'); U.settle(ten, 900)
                shot(ten, f'{pre}-10-tenant-pill-claimed', full=False)
                ten.click('.fresh-card [data-act=fresh-ok]'); U.settle(ten, 800); shot(ten, f'{pre}-11-tenant-home-due')
                open_record(ten, 'sanya2', ids['sept'], theme); shot(ten, f'{pre}-12-tenant-charge-detail')
                ten.locator('[data-act=nav][data-page=finances]:visible').first.click(); U.settle(ten, 700); shot(ten, f'{pre}-13-tenant-finances')
                mctx, mom, merr = U.page_for(browser, w, theme)
                home(mom, 'mama', theme); shot(mom, f'{pre}-14-coowner-home')
                mom.fill('.co-utilities-form [data-utilities-amount]', '3100'); mom.click('.co-utilities-form button[type=submit]'); mom.wait_for_selector('.co-status', timeout=10000); U.settle(mom, 600)
                shot(mom, f'{pre}-15-coowner-home-sent')
                home(own, 'stepan', theme); shot(own, f'{pre}-16-owner-home-approval')
                own.locator('.approval-block [data-act=open-record]').first.click(); own.wait_for_selector('.detail-body'); U.settle(own, 600)
                shot(own, f'{pre}-17-owner-draft-detail')
                for name, errs in (('owner', oerr), ('tenant', terr), ('mom', merr)):
                    if errs: audit.append((pre + ' ' + name, errs))
                for c in (octx, tctx, mctx): c.close()
        browser.close()
finally:
    U.stop()
print('audit:', audit or 'clean')
