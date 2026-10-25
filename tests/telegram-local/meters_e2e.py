# Meters run: the owner adds meters and writes starting readings without a photo,
# the tenant cannot send readings without a photo, then sends them with one and
# both see consumption from the start and its cost.
# Usage: python meters_e2e.py <out_dir> <data_dir>   (server on :3000 as in invites_e2e.py)
import json, os, subprocess, sys
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(os.path.dirname(HERE))
TOKEN = '123456:local-test-token-abcdefghijklmnopqrstuv'; NODE = os.environ.get('NODE', 'node'); BASE = 'http://localhost:3000'
OUT = sys.argv[1]; DATA = sys.argv[2]; os.makedirs(OUT, exist_ok=True)
PHOTO = os.path.join(REPO, 'public', 'art', 'tap.webp')
results = []
def check(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name + (' — ' + str(extra)[:300] if extra and not cond else ''))
def launch(uid, name, scheme='light', start=''):
    return subprocess.check_output([NODE, os.path.join(HERE, 'initdata.mjs'), TOKEN, str(uid), name, scheme, start], text=True).strip()
subprocess.check_output([NODE, os.path.join(HERE, 'seed-tenant.mjs'), REPO, DATA, '900005', 'Ольга Жилец'], stderr=subprocess.DEVNULL)
PROXY = "window.__events=[];window.TelegramWebviewProxy={postEvent:function(n,d){window.__events.push([n,d]);}};"
def page_for(browser, w=390, scheme='light'):
    ctx = browser.new_context(viewport={'width': w, 'height': 860}, device_scale_factor=2, color_scheme=scheme, is_mobile=True, has_touch=True)
    ctx.add_init_script(PROXY); page = ctx.new_page(); errs = []; page.on('pageerror', lambda e: errs.append(str(e))); return ctx, page, errs
def settle(page): page.wait_for_timeout(450)
def open_meters(page):
    page.click('[data-act=nav][data-page=apartments] >> visible=true >> nth=0'); page.wait_for_selector('.apartment-tabs')
    page.click('.apartment-tabs [data-tab=meters]'); settle(page)
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    ctx, owner, oerr = page_for(browser)
    owner.goto(BASE + '/' + launch(777001, 'Анна')); owner.wait_for_selector('.app-body', timeout=10000)
    open_meters(owner)
    for label, kind, price in [('Холодная вода', 'cold_water', '51,20'), ('Свет', 'electricity', '')]:
        owner.click('[data-act=new-meter] >> nth=0'); owner.wait_for_selector('[data-form=create-meter]')
        owner.fill('[data-form=create-meter] input[name=label]', label); owner.select_option('[data-form=create-meter] select[name=kind]', kind)
        owner.fill('[data-form=create-meter] input[name=baseline]', '')
        owner.fill('[data-form=create-meter] input[name=baseline]', '0')
        if price: owner.fill('[data-form=create-meter] input[name=price]', price)
        if label == 'Холодная вода': owner.screenshot(path=f'{OUT}/meters-01-add-with-price.png')
        owner.click('[data-form=create-meter] button[type=submit]'); owner.wait_for_selector('.modal', state='detached'); settle(owner)
    check('owner: starting readings card asks for numbers without a photo', 'фото не нужно' in owner.inner_text('.baseline-card'))
    owner.screenshot(path=f'{OUT}/meters-02-owner-baseline-prompt.png', full_page=True)
    owner.click('.baseline-card [data-act=meter-baselines]'); owner.wait_for_selector('[data-form=meter-baselines]')
    inputs = owner.locator('[data-form=meter-baselines] input')
    check('owner: one field per meter', inputs.count() == 2, inputs.count())
    inputs.nth(0).fill('123,456'); inputs.nth(1).fill('4500'); settle(owner)
    owner.screenshot(path=f'{OUT}/meters-03-baseline-form.png')
    owner.click('[data-form=meter-baselines] button[type=submit]'); owner.wait_for_selector('.baseline-card.done', timeout=8000); settle(owner)
    body = owner.inner_text('.meters-grid')
    check('owner: rows show «Старт» values', 'Старт' in body and '123,456' in body, body)
    owner.screenshot(path=f'{OUT}/meters-04-owner-baseline-done.png', full_page=True)

    tctx, ten, terr = page_for(browser, 375)
    ten.goto(BASE + '/' + launch(900005, 'Ольга')); ten.wait_for_selector('.app-body', timeout=10000)
    ten.click('[data-act=nav][data-page=meters] >> nth=0') if ten.locator('[data-act=nav][data-page=meters]').count() else open_meters(ten)
    ten.wait_for_selector('[data-form=readings]', timeout=8000); settle(ten)
    check('tenant: photo is marked as required', 'Обязательно' in ten.inner_text('[data-photo-required]'))
    fields = ten.locator('[data-form=readings] input[name^=meter_]')
    fields.nth(0).fill('126,956'); fields.nth(1).fill('4620')
    ten.click('[data-form=readings] button[type=submit]'); settle(ten)
    err = ten.inner_text('[data-form=readings] .form-error')
    check('tenant: sending without a photo is stopped with a clear message', 'фото' in err.lower(), err)
    ten.screenshot(path=f'{OUT}/meters-05-tenant-needs-photo.png', full_page=True)
    ten.set_input_files('[data-form=readings] input[type=file]', PHOTO)
    ten.click('[data-form=readings] button[type=submit]'); ten.wait_for_url('**/app/record/**', timeout=10000); settle(ten)
    detail = ten.inner_text('main')
    check('tenant: reading saved with consumption and cost', '3,5' in detail and '179,2' in detail, detail[:400])
    ten.screenshot(path=f'{OUT}/meters-06-tenant-reading-detail.png', full_page=True)
    tctx.close()

    owner.reload(); owner.wait_for_selector('.app-body'); open_meters(owner)
    hist = owner.inner_text('.meter-history')
    check('owner: history shows +3,5 м³ and the month cost', '+3,5' in hist and '179,2' in hist, hist)
    check('owner: starting card gone once tenants sent readings', owner.locator('.baseline-card').count() == 0)
    owner.screenshot(path=f'{OUT}/meters-07-owner-history.png', full_page=True)
    check('no page errors', not (oerr + terr), oerr + terr)
    browser.close()
fails = [n for n, ok in results if not ok]
print(f'{len(results) - len(fails)}/{len(results)} passed'); sys.exit(1 if fails else 0)
