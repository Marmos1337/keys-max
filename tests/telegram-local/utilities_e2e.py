# 0.7 cash run on seed-utilities.mjs: the owner enters utilities, a tenant taps «Отдал наличными»
# and takes it back, the owner records «Забрал наличные» and undoes it, mom enters a draft and
# Степан sends it to the tenants. Starts the fake Bot API (:3998) and the server (PORT, default 3100)
# on a fresh data dir by itself.
# Usage: KEYS_REPO=<repo> python utilities_e2e.py <out_dir>
import hashlib, hmac, json, os, shutil, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.environ.get('KEYS_REPO') or os.path.dirname(os.path.dirname(HERE))
NODE = os.environ.get('NODE', 'node'); PORT = os.environ.get('PORT', '3100'); BASE = f'http://localhost:{PORT}'
TOKEN = '123456:local-test-token-abcdefghijklmnopqrstuv'
procs = []; DATA = ''; IDS = {}
def start():
    # A fresh data dir with the seed every time: the runs change money.
    global DATA, IDS
    stop(); DATA = tempfile.mkdtemp(prefix='keys-util-')
    IDS = json.loads(subprocess.check_output([NODE, os.path.join(HERE, 'seed-utilities.mjs'), REPO, DATA], text=True))
    env = {**os.environ, 'APP_MODE': 'test', 'PORT': PORT, 'PUBLIC_URL': BASE, 'DATA_DIR': DATA, 'SESSION_SECRET': 'local-run-secret-local-run-secret-1234',
           'KEYS_TG_BOT_TOKEN': TOKEN, 'KEYS_TG_BOT_USERNAME': 'rentkeysbot', 'KEYS_TG_API_BASE': 'http://127.0.0.1:3998'}
    procs.append(subprocess.Popen([NODE, os.path.join(HERE, 'fake-bot-api.mjs'), '3998', TOKEN], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    procs.append(subprocess.Popen([NODE, os.path.join(REPO, 'server/index.mjs')], env=env, cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    for _ in range(80):
        try: urllib.request.urlopen(BASE + '/api/health', timeout=1); return
        except Exception: time.sleep(0.25)
    raise SystemExit('server did not start')
def stop():
    while procs: x = procs.pop(); x.terminate(); x.wait(5)
    if DATA: shutil.rmtree(DATA, ignore_errors=True)

# Signed Telegram launch; username keeps the @handle (login refreshes it from the messenger).
PEOPLE = {'stepan': (800001, 'Степан', 'stepan_n'), 'mama': (800002, 'Мама', ''), 'sanya_p': (800003, 'Саня', 'sanya_p'), 'sanya2': (800004, 'Саня', '')}
def url(who, scheme='light', start=''):
    uid, name, handle = PEOPLE[who]
    user = {'id': uid, 'first_name': name, 'allows_write_to_pm': True, 'language_code': 'ru', **({'username': handle} if handle else {})}
    p = {'auth_date': str(int(time.time())), 'query_id': 'local-run', 'user': json.dumps(user, ensure_ascii=False, separators=(',', ':'))}
    if start: p['start_param'] = start
    data = '\n'.join(f'{k}={p[k]}' for k in sorted(p))
    p['hash'] = hmac.new(hmac.new(b'WebAppData', TOKEN.encode(), hashlib.sha256).digest(), data.encode(), hashlib.sha256).hexdigest()
    theme = {'bg_color': '#17212b', 'text_color': '#f5f5f5', 'button_color': '#5288c1', 'button_text_color': '#ffffff'} if scheme == 'dark' else {'bg_color': '#ffffff', 'text_color': '#000000', 'button_color': '#2481cc', 'button_text_color': '#ffffff'}
    h = urllib.parse.urlencode({'tgWebAppData': urllib.parse.urlencode(p), 'tgWebAppVersion': '8.0', 'tgWebAppPlatform': 'ios', 'tgWebAppThemeParams': json.dumps(theme)})
    return BASE + '/' + (('?startapp=' + start) if start else '') + '#' + h
PROXY = "window.__events=[];window.TelegramWebviewProxy={postEvent:function(n,d){window.__events.push([n,d]);}};"
def page_for(browser, w=375, scheme='light'):
    ctx = browser.new_context(viewport={'width': w, 'height': 860}, device_scale_factor=2, color_scheme=scheme, is_mobile=w < 700, has_touch=w < 700)
    ctx.add_init_script(PROXY); page = ctx.new_page(); errs = []; page.on('pageerror', lambda e: errs.append(str(e))); return ctx, page, errs
def login(page, who, scheme='light', start=''):
    page.goto(url(who, scheme, start)); page.wait_for_selector('.app-body', timeout=15000); page.wait_for_timeout(500)
def settle(p, ms=450): p.wait_for_timeout(ms)
# Money is printed with no-break spaces; checks compare plain text.
def T(page, sel): return page.inner_text(sel).replace('\u00a0', ' ').replace('\u202f', ' ')
def rect(page, sel): return page.eval_on_selector(sel, 'e=>{const r=e.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]}')

results = []
def check(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name + (' — ' + str(extra)[:300] if extra and not cond else ''))

if __name__ == '__main__':
    OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
    start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True)
            octx, own, oerr = page_for(browser)
            login(own, 'stepan')
            home = own.inner_text('main')
            check('owner: «Наличные у жильцов» tells the two Саня apart', 'Саня @sanya_p' in home and 'Саня 2' in home, home[:500])
            check('owner: «Забрал у всех» when two owe', own.locator('[data-act=cash-collect][data-tenant="*"]').count() >= 1)
            check('owner: September utilities reminder', 'Коммуналка за сентябрь ещё не внесена' in home, home[:400])
            # Utilities entry: month and amount come prefilled from August.
            own.click('.quick-grid.trio [data-act=utilities]'); own.wait_for_selector('[data-form=utilities]'); settle(own)
            check('sheet: month defaults to September', own.input_value('[data-form=utilities] input[name=period]') == '09.2026', own.input_value('[data-form=utilities] input[name=period]'))
            check('sheet: amount prefilled from last month', own.input_value('[data-utilities-amount]').replace(' ', ' ') == '3 450', own.input_value('[data-utilities-amount]'))
            own.fill('[data-utilities-amount]', '3000'); settle(own, 200)
            check('sheet: live split «по 1 500 ₽ × 2 жильца»', 'по 1 500' in T(own, '[data-split-preview]') and '2 жильца' in T(own, '[data-split-preview]'), T(own, '[data-split-preview]'))
            own.screenshot(path=f'{OUT}/e2e-01-utilities-sheet.png')
            own.click('[data-form=utilities] [data-publish="1"]'); own.wait_for_selector('.toast', timeout=10000); settle(own)
            check('owner: utilities sent', 'отправлена' in own.inner_text('.toast'), own.inner_text('.toast'))
            # Same month again: the sheet offers to open it instead.
            own.click('.quick-grid.trio [data-act=utilities]'); own.wait_for_selector('[data-form=utilities]'); settle(own)
            own.fill('[data-form=utilities] input[name=period]', '09.2026'); settle(own, 200)
            check('sheet: existing month → «Открыть / изменить»', own.locator('[data-utilities-exists] [data-act=open-record]').count() == 1)
            own.click('[data-act=close-modal]'); settle(own)

            # Tenant: new utilities card on top, one tap, then withdraw; the pill keeps its size.
            tctx, ten, terr = page_for(browser)
            login(ten, 'sanya2')
            check('tenant: fresh utilities card with own share', ten.locator('.fresh-card').count() == 1 and '1 500' in T(ten, '.fresh-card'), ten.inner_text('main')[:300])
            pill = '.fresh-card .cash-pill'
            before = rect(ten, pill)
            ten.screenshot(path=f'{OUT}/e2e-02-tenant-home.png')
            ten.click(pill + ' .cash-give'); ten.wait_for_selector(pill + '[data-state=claimed]', timeout=8000); settle(ten, 900)
            check('tenant: pill morphs to «Отмечено · Отменить» at the same size', rect(ten, pill) == before, (before, rect(ten, pill)))
            ten.screenshot(path=f'{OUT}/e2e-03-tenant-claimed.png')
            ten.click(pill + ' .cash-done'); ten.wait_for_selector(pill + '[data-state=open]', timeout=8000); settle(ten, 900)
            check('tenant: withdraw brings the pill back', ten.locator(pill + '[data-state=open]').count() == 1)
            ten.click('.fresh-card [data-act=fresh-ok]'); settle(ten, 700)
            check('tenant: «Понятно» hides the card', ten.locator('.fresh-card').count() == 0)
            ten.locator('.my-due-title').first.click(); ten.wait_for_selector('.share-panel', timeout=8000); settle(ten)
            first = ten.inner_text('.share-row >> nth=0')
            check('tenant detail: own row first as «Вы»', first.split('\n')[1:2] == ['Вы'], first)
            check('tenant: no page errors', not terr, terr)

            # Owner: «Забрал» from Саня 2, partial amount, then undo from the toast.
            login(own, 'stepan')
            own.click('.cash-row:has-text("Саня 2") [data-act=cash-collect]'); own.wait_for_selector('[data-form=cash-collect]'); settle(own)
            box = rect(own, '.modal')
            own.fill('[data-collect-amount]', '1000'); settle(own, 200)
            check('collection: live allocation follows the amount', own.locator('.alloc-list li:not(.muted-line)').count() >= 1 and 'Записать 1 000' in T(own, '[data-collect-submit]'), own.inner_text('[data-collect-submit]'))
            own.fill('[data-collect-amount]', '999999'); settle(own, 200)
            check('collection: more than the debt is refused inline', 'Больше долга' in own.inner_text('.entry-error') and own.is_disabled('[data-collect-submit]'))
            check('collection: the sheet keeps its size', rect(own, '.modal') == box, (box, rect(own, '.modal')))
            own.fill('[data-collect-amount]', '1000'); settle(own, 200)
            own.screenshot(path=f'{OUT}/e2e-04-collection.png')
            own.click('[data-collect-submit]'); own.wait_for_selector('.toast-action', timeout=10000); settle(own)
            check('collection: toast offers «Отменить»', 'Записано' in own.inner_text('.toast'))
            own.click('.toast-action'); own.wait_for_selector('.toast:has-text("отменена")', timeout=10000); settle(own)
            check('undo: the debt is back', 'Саня 2' in own.inner_text('.cash-section'))
            check('owner: no page errors', not oerr, oerr)

            # Mom writes October utilities from her home; Степан sends it on.
            mctx, mom, merr = page_for(browser)
            login(mom, 'mama')
            check('co-owner: minimal home with «Впишите коммуналку»', 'Впишите коммуналку за октябрь' in mom.inner_text('main') and mom.locator('.cash-section').count() == 0, mom.inner_text('main')[:300])
            mom.fill('.co-utilities-form [data-utilities-amount]', '3100'); mom.click('.co-utilities-form button[type=submit]'); mom.wait_for_selector('.co-status', timeout=10000); settle(mom)
            check('co-owner: status «Ждёт отправки»', 'Ждёт отправки' in mom.inner_text('.co-utilities'))
            login(own, 'stepan')
            check('owner: «Нужно одобрить» block', 'Нужно одобрить' in own.inner_text('main') and '3 100' in T(own, '.approval-block'))
            own.click('.approval-block [data-decision=approve]'); own.wait_for_selector('.toast', timeout=10000); settle(own)
            check('owner: approved block disappears', own.locator('.approval-block').count() == 0)
            check('no horizontal overflow', not own.evaluate('document.documentElement.scrollWidth>innerWidth+1'))
            check('no page errors (mom)', not merr, merr)
            browser.close()
    finally:
        stop()
    fails = [n for n, ok in results if not ok]
    print(f'{len(results) - len(fails)}/{len(results)} passed'); sys.exit(1 if fails else 0)
