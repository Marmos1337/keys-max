# End-to-end invite run against the real server process and a fake Bot API.
# The owner creates two links in the Mini App; tenant 1 joins through the bot
# (updates go through long polling), tenant 2 joins inside the Mini App.
# Usage: python invites_e2e.py <out_dir>   (server on :3000, fake Bot API on :3999)
import json, os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); TOKEN = '123456:local-test-token-abcdefghijklmnopqrstuv'
NODE = os.environ.get('NODE', 'node'); BASE = 'http://localhost:3000'; API = 'http://127.0.0.1:3999'; PUBLIC = 'https://keys.local'
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'shots'); os.makedirs(OUT, exist_ok=True)
results = []
def check(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name + (' — ' + str(extra)[:300] if extra and not cond else ''))
def launch(uid, name, scheme='light', start=''):
    return subprocess.check_output([NODE, os.path.join(HERE, 'initdata.mjs'), TOKEN, str(uid), name, scheme, start], text=True).strip()
def push(update):
    req = urllib.request.Request(API + '/_push', data=json.dumps({'update': update}).encode(), headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req))
def sent(): return json.load(urllib.request.urlopen(API + '/_sent'))
def wait_message(chat, pred, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        for m in sent():
            if m['method'] == 'sendMessage' and str(m['body'].get('chat_id')) == str(chat) and pred(m['body']): return m['body']
        time.sleep(0.2)
    return None
def text_msg(uid, text): return {'message': {'message_id': 1, 'date': 1, 'chat': {'id': uid, 'type': 'private'}, 'from': {'id': uid, 'is_bot': False, 'first_name': 'Маша'}, 'text': text}}
def press(uid, data): return {'callback_query': {'id': 'cb-%d-%d' % (uid, time.time() * 1000), 'from': {'id': uid, 'is_bot': False, 'first_name': 'Маша'}, 'message': {'message_id': 1, 'chat': {'id': uid, 'type': 'private'}}, 'data': data}}
PROXY = "window.__events=[];window.TelegramWebviewProxy={postEvent:function(n,d){window.__events.push([n,d]);}};"
def page_for(browser, w=375, scheme='light'):
    ctx = browser.new_context(viewport={'width': w, 'height': 820}, device_scale_factor=2, color_scheme=scheme, is_mobile=True, has_touch=True)
    ctx.add_init_script(PROXY); page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    return ctx, page, errs
def overflow(page): return page.evaluate('document.documentElement.scrollWidth>innerWidth+1')

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    ctx, owner, errs = page_for(browser)
    owner.goto(BASE + '/' + launch(777001, 'Анна', 'light'))
    owner.wait_for_selector('.app-body', timeout=10000)
    check('owner: returning user skips the welcome screen', owner.locator('[data-act=login]').count() == 0)
    owner.click('[data-act=nav][data-page=apartments] >> visible=true >> nth=0'); owner.wait_for_selector('.people-section')
    check('owner: «Жильцы» section with empty state', 'Пока никого' in owner.inner_text('.people-section'))
    owner.screenshot(path=f'{OUT}/invite-01-owner-empty.png', full_page=True)
    links = {}
    for label in ['Маша', 'Петя']:
        owner.click('.people-section [data-act=invite]'); owner.wait_for_selector('[data-form=invite-create]')
        if label == 'Маша': owner.screenshot(path=f'{OUT}/invite-02-create.png')
        owner.fill('[data-form=invite-create] input[name=label]', label); owner.click('[data-form=invite-create] button[type=submit]')
        owner.wait_for_selector('[data-invite-url]'); url = owner.inner_text('[data-invite-url]'); links[label] = url
        check(f'owner: link for {label} goes to the Telegram bot', url.startswith('https://t.me/rentkeysbot?start=join_'), url)
        if label == 'Маша':
            owner.screenshot(path=f'{OUT}/invite-03-link.png')
            owner.click('[data-act=share-invite]'); owner.wait_for_timeout(200)
            ev = owner.evaluate('window.__events.filter(e=>e[0]==="web_app_open_tg_link").map(e=>e[1])')
            check('owner: share opens the Telegram share sheet', any('share/url' in json.dumps(x) for x in ev), ev)
        owner.click('.modal [data-act=close-modal]'); owner.wait_for_timeout(300)
    owner.reload(); owner.wait_for_selector('.app-body'); owner.click('[data-act=nav][data-page=apartments] >> visible=true >> nth=0'); owner.wait_for_selector('.invite-row')
    rows = owner.inner_text('.people-section')
    check('owner: both links listed as «Не открыта»', 'Маша' in rows and 'Петя' in rows and rows.count('Не открыта') == 2, rows)
    owner.screenshot(path=f'{OUT}/invite-04-two-pending.png', full_page=True)

    # Tenant 1 (no username) opens the link: Telegram sends /start join_…, the server polls it.
    code1 = links['Маша'].split('join_')[1]
    push(text_msg(900001, '/start join_' + code1))
    m = wait_message(900001, lambda b: 'приглашает' in b.get('text', ''))
    check('bot: invite preview arrives via long polling', m is not None)
    btn = m and m['reply_markup']['inline_keyboard'][0][0]
    check('bot: preview has «Принять приглашение»', btn and btn.get('callback_data') == 'join|' + code1, btn)
    owner.reload(); owner.wait_for_selector('.app-body'); owner.click('[data-act=nav][data-page=apartments] >> visible=true >> nth=0'); owner.wait_for_selector('.invite-row')
    check('owner: status «Открыта» after the tenant opened it', 'Открыта в боте' in owner.inner_text('.people-section'))
    push(press(900001, 'join|' + code1))
    done = wait_message(900001, lambda b: 'Готово' in b.get('text', ''))
    check('bot: confirmation after accepting', done is not None)
    web = done and done['reply_markup']['inline_keyboard'][0][0]
    check('bot: «Открыть Ключи» opens the joined lease', web and web.get('text') == 'Открыть Ключи' and 'startapp=j_' in web['web_app']['url'], web)
    lease_url = web['web_app']['url'].replace(PUBLIC, BASE) if web else BASE + '/'
    push(text_msg(900001, '/start join_' + code1))
    again = wait_message(900001, lambda b: 'уже в этой аренде' in b.get('text', ''))
    check('bot: reopening the link says «Вы уже в этой аренде»', again is not None)
    push(text_msg(900009, '/start join_' + code1))
    used = wait_message(900009, lambda b: 'другой человек' in b.get('text', ''))
    check('bot: someone else with a used link is told to ask for their own', used is not None)

    t1ctx, t1, t1errs = page_for(browser)
    t1.goto(lease_url + launch(900001, 'Маша', 'light'))
    t1.wait_for_selector('.joined-welcome', timeout=10000)
    check('tenant 1: lands in the lease with a welcome', 'Квартира на Лесной' in t1.inner_text('.modal'))
    t1.screenshot(path=f'{OUT}/invite-05-tenant-welcome.png')
    check('tenant 1: no horizontal overflow', not overflow(t1))
    t1ctx.close()

    # Tenant 2 opens the link inside the Mini App (startapp=join_…).
    code2 = links['Петя'].split('join_')[1]
    t2ctx, t2, t2errs = page_for(browser, 320, 'dark')
    t2.goto(BASE + '/' + launch(900002, 'Петя', 'dark', 'join_' + code2))
    t2.wait_for_selector('[data-act=login]', timeout=10000)
    check('tenant 2 (new user): sees the welcome with terms first', 'условия' in t2.inner_text('body'))
    t2.click('[data-act=login]')
    t2.wait_for_selector('[data-form=invite-accept]', timeout=10000)
    t2.screenshot(path=f'{OUT}/invite-06-inapp-preview-320-dark.png')
    t2.click('[data-form=invite-accept] button[type=submit]')
    t2.wait_for_selector('.joined-welcome', timeout=10000)
    check('tenant 2: joined from the Mini App', 'Квартира на Лесной' in t2.inner_text('.modal'))
    t2.screenshot(path=f'{OUT}/invite-07-inapp-joined-320-dark.png')
    check('tenant 2: no horizontal overflow at 320', not overflow(t2))
    t2ctx.close()

    owner.reload(); owner.wait_for_selector('.app-body'); owner.click('[data-act=nav][data-page=apartments] >> visible=true >> nth=0'); owner.wait_for_selector('.people-section')
    people = owner.inner_text('.people-section')
    check('owner: both tenants listed as members, no pending links', 'Маша' in people and 'Петя' in people and 'Не открыта' not in people, people)
    owner.screenshot(path=f'{OUT}/invite-08-owner-two-tenants.png', full_page=True)

    # Outside a messenger: a plain browser with ?invite=… shows both bots.
    bctx = browser.new_context(viewport={'width': 390, 'height': 820}); b = bctx.new_page()
    b.goto(BASE + '/?invite=' + code2); b.wait_for_selector('.modal', timeout=8000)
    body = b.inner_text('body')
    check('browser: invite page offers Telegram and MAX bots', 'Открыть в Telegram' in body, body[:300])
    b.screenshot(path=f'{OUT}/invite-09-browser.png'); bctx.close()
    check('no page errors', not (errs + t1errs + t2errs), errs + t1errs + t2errs)
    browser.close()
fails = [n for n, ok in results if not ok]
print(f'{len(results) - len(fails)}/{len(results)} passed')
sys.exit(1 if fails else 0)
