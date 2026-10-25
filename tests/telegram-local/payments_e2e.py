# Cash run: the tenant marks «Передал наличными» with a photo, the owner presses
# «Получил» → paid; on a second bill the owner presses «Не получил» with a reason.
# Usage: python payments_e2e.py <out_dir> <data_dir>   (server on :3000, tenant 900005 seeded)
import json, os, subprocess, sys
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(os.path.dirname(HERE))
TOKEN = '123456:local-test-token-abcdefghijklmnopqrstuv'; NODE = os.environ.get('NODE', 'node'); BASE = 'http://localhost:3000'
OUT = sys.argv[1]; DATA = sys.argv[2]; os.makedirs(OUT, exist_ok=True); PHOTO = os.path.join(REPO, 'public', 'art', 'owner.webp')
results = []
def check(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name + (' — ' + str(extra)[:300] if extra and not cond else ''))
def launch(uid, name, scheme='light'):
    return subprocess.check_output([NODE, os.path.join(HERE, 'initdata.mjs'), TOKEN, str(uid), name, scheme, ''], text=True).strip()
def seed_charge(title, rub):
    return json.loads(subprocess.check_output([NODE, os.path.join(HERE, 'seed-charge.mjs'), REPO, DATA, title, str(rub)], stderr=subprocess.DEVNULL))['id']
subprocess.check_output([NODE, os.path.join(HERE, 'seed-tenant.mjs'), REPO, DATA, '900005', 'Ольга Жилец'], stderr=subprocess.DEVNULL)
rent = seed_charge('Аренда за октябрь', 30000); extra = seed_charge('Коммунальные', 2500)
PROXY = "window.__events=[];window.TelegramWebviewProxy={postEvent:function(n,d){window.__events.push([n,d]);}};"
def page_for(browser, w=390, scheme='light'):
    ctx = browser.new_context(viewport={'width': w, 'height': 860}, device_scale_factor=2, color_scheme=scheme, is_mobile=True, has_touch=True)
    ctx.add_init_script(PROXY); page = ctx.new_page(); errs = []; page.on('pageerror', lambda e: errs.append(str(e))); return ctx, page, errs
def settle(p): p.wait_for_timeout(450)
# Opening a record the way a bot button does: ?startapp=r_<id> plus a signed launch.
def open_record(page, rid, uid, name, scheme='light'): page.goto(BASE + '/?startapp=r_' + rid + launch(uid, name, scheme)); page.wait_for_selector('.detail-amount', timeout=10000); settle(page)
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    tctx, ten, terr = page_for(browser, 375)
    open_record(ten, rent, 900005, 'Ольга')
    ten.click('[data-act=record-action][data-action=claim] >> nth=0'); ten.wait_for_selector('.method-switch'); settle(ten)
    check('tenant: cash is preselected', ten.is_checked('.method-switch input[value=cash]'))
    ten.fill('[data-form=record-action] textarea[name=note]', 'Отдала лично в руки')
    ten.set_input_files('[data-form=record-action] input[type=file]', PHOTO)
    ten.screenshot(path=f'{OUT}/cash-01-tenant-form.png')
    ten.click('[data-form=record-action] button[type=submit]'); ten.wait_for_selector('.claim-card', timeout=10000); settle(ten)
    card = ten.inner_text('.claim-card')
    check('tenant: card shows «наличными» and «Ждёт подтверждения»', 'наличными' in card and 'Ждёт подтверждения' in card, card)
    check('tenant: photo linked to the hand-over', ten.locator('.claim-card .file-chip').count() == 1)
    ten.screenshot(path=f'{OUT}/cash-02-tenant-waiting.png', full_page=True)
    tctx.close()
    octx, own, oerr = page_for(browser)
    own.goto(BASE + '/' + launch(777001, 'Анна')); own.wait_for_selector('.app-body', timeout=10000); settle(own)
    home = own.inner_text('main')
    check('owner: home lists the hand-over under «Требует внимания»', 'Аренда за октябрь' in home, home[:300])
    open_record(own, rent, 777001, 'Анна')
    own.screenshot(path=f'{OUT}/cash-03-owner-confirm.png', full_page=True)
    own.click('.claim-card [data-action=confirm]'); own.wait_for_selector('[data-form=record-action]'); settle(own)
    check('owner: confirmation text names amount and method', 'наличными' in own.inner_text('.modal'))
    own.click('[data-form=record-action] button[type=submit]'); own.wait_for_selector('.pay-entry.ok', timeout=10000); settle(own)
    det = own.inner_text('main')
    check('owner: bill is paid and history shows cash', 'Оплачено' in det and 'наличными' in own.inner_text('.payment-log'), det[:400])
    own.screenshot(path=f'{OUT}/cash-04-owner-paid.png', full_page=True)
    # Second bill: tenant marks, owner disputes.
    tctx, ten, terr2 = page_for(browser, 375, 'dark')
    open_record(ten, extra, 900005, 'Ольга', 'dark')
    ten.click('[data-act=record-action][data-action=claim] >> nth=0'); ten.wait_for_selector('.method-switch'); ten.click('[data-form=record-action] button[type=submit]'); ten.wait_for_selector('.claim-card', timeout=10000)
    open_record(own, extra, 777001, 'Анна')
    own.click('.claim-card [data-action=reject]'); own.wait_for_selector('[data-form=record-action] textarea[name=note]')
    own.fill('[data-form=record-action] textarea[name=note]', 'Получил 2 000, а не 2 500'); own.click('[data-form=record-action] button[type=submit]'); own.wait_for_selector('.pay-entry.dispute', timeout=10000); settle(own)
    check('owner: dispute is in the history with the reason', 'Получил 2 000' in own.inner_text('.payment-log'))
    open_record(ten, extra, 900005, 'Ольга', 'dark')
    td = ten.inner_text('main')
    check('tenant: sees the reason and can mark again', 'Получил 2 000' in td and ten.locator('[data-action=claim]').count() > 0, td[:400])
    ten.screenshot(path=f'{OUT}/cash-05-tenant-disputed-dark.png', full_page=True)
    check('no horizontal overflow', not ten.evaluate('document.documentElement.scrollWidth>innerWidth+1'))
    check('no page errors', not (terr + oerr + terr2), terr + oerr + terr2)
    browser.close()
fails = [n for n, ok in results if not ok]
print(f'{len(results) - len(fails)}/{len(results)} passed'); sys.exit(1 if fails else 0)
