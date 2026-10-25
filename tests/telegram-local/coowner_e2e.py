# Co-owner run: Анна invites «Мама» by a link (bot path), Мама opens the apartment
# with owner rights, confirms a cash payment that the tenant marked; the tenant sees
# both owners; Анна removes Мама; «Папа» joins inside the Mini App and leaves himself.
# Usage: python coowner_e2e.py <out_dir>   (server on :3000 with seed-rich.mjs data, fake Bot API on :3999)
import json, os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); TOKEN = '123456:local-test-token-abcdefghijklmnopqrstuv'
NODE = os.environ.get('NODE', 'node'); BASE = 'http://localhost:3000'; API = 'http://127.0.0.1:3999'; PUBLIC = 'https://keys.local'
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True); results = []
def check(name, cond, extra=''): results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else ' — ' + str(extra)[:300]))
def launch(uid, name, scheme='light', start=''): return subprocess.check_output([NODE, os.path.join(HERE, 'initdata.mjs'), TOKEN, str(uid), name, scheme, start], text=True).strip()
def push(update): urllib.request.urlopen(urllib.request.Request(API + '/_push', data=json.dumps({'update': update}).encode(), headers={'Content-Type': 'application/json'}))
def wait_message(chat, pred, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        for m in json.load(urllib.request.urlopen(API + '/_sent')):
            if m['method'] == 'sendMessage' and str(m['body'].get('chat_id')) == str(chat) and pred(m['body']): return m['body']
        time.sleep(0.2)
    return None
def text_msg(uid, name, text): return {'message': {'message_id': 1, 'date': 1, 'chat': {'id': uid, 'type': 'private'}, 'from': {'id': uid, 'is_bot': False, 'first_name': name}, 'text': text}}
def press(uid, name, data): return {'callback_query': {'id': 'cb-%d-%d' % (uid, time.time() * 1000), 'from': {'id': uid, 'is_bot': False, 'first_name': name}, 'message': {'message_id': 1, 'chat': {'id': uid, 'type': 'private'}}, 'data': data}}
PROXY = "window.__events=[];window.TelegramWebviewProxy={postEvent:function(n,d){window.__events.push([n,d]);}};"
def page_for(browser, w=390, scheme='light'):
    ctx = browser.new_context(viewport={'width': w, 'height': 860}, device_scale_factor=2, color_scheme=scheme, is_mobile=True, has_touch=True)
    ctx.add_init_script(PROXY); page = ctx.new_page(); errs = []; page.on('pageerror', lambda e: errs.append(str(e))); return ctx, page, errs
def settle(p, ms=650): p.wait_for_timeout(ms)
def tall(page, path):
    vp = page.viewport_size; h = min(4200, page.evaluate('document.documentElement.scrollHeight')); page.set_viewport_size({'width': vp['width'], 'height': max(vp['height'], h)}); settle(page, 300); page.screenshot(path=path); page.set_viewport_size(vp)
def open_apartment(page):
    page.click('[data-act=nav][data-page=apartments] >> visible=true >> nth=0'); page.wait_for_selector('.apartment-tabs'); settle(page)
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    octx, own, e1 = page_for(browser); errors += [e1]
    own.goto(BASE + '/' + launch(777001, 'Анна')); own.wait_for_selector('.app-body', timeout=10000); open_apartment(own)
    sec = own.inner_text('.owners-section')
    check('owner: «Совладельцы» shows the main owner and a hint', 'Главный' in sec and 'Ведёте квартиру вместе' in sec, sec)
    own.click('.owners-section [data-act=owner-invite]'); own.wait_for_selector('[data-form=owner-invite-create]'); settle(own)
    own.screenshot(path=f'{OUT}/coowner-01-invite-form.png')
    own.fill('[data-form=owner-invite-create] input[name=label]', 'Мама'); own.click('[data-form=owner-invite-create] button[type=submit]'); own.wait_for_selector('[data-invite-url]'); settle(own, 900)
    url = own.inner_text('[data-invite-url]'); check('owner: co-owner link goes to the bot with own_', url.startswith('https://t.me/rentkeysbot?start=own_'), url)
    own.screenshot(path=f'{OUT}/coowner-02-link.png')
    own.click('[data-act=share-invite]'); settle(own, 500)
    ev = own.evaluate('window.__events.filter(e=>e[0]==="web_app_open_tg_link").map(e=>e[1])')
    check('owner: share text speaks about co-ownership', any('%D1%81%D0%BE%D0%B2%D0%BB%D0%B0%D0%B4%D0%B5%D0%BB' in json.dumps(x) or 'совлад' in json.dumps(x, ensure_ascii=False) for x in ev), ev)
    own.click('.modal [data-act=close-modal]'); settle(own)
    code = url.split('own_')[1]
    push(text_msg(900100, 'Мама', '/start own_' + code))
    m = wait_message(900100, lambda b: 'вести квартиру вместе' in b.get('text', ''))
    check('bot: Мама gets the co-owner invitation', m is not None and m['reply_markup']['inline_keyboard'][0][0].get('callback_data') == 'own|' + code, m)
    push(press(900100, 'Мама', 'own|' + code))
    done = wait_message(900100, lambda b: 'вы совладелец' in b.get('text', '').lower())
    btn = done and done['reply_markup']['inline_keyboard'][0][0]
    check('bot: «Готово, вы совладелец» opens the apartment', btn and btn['text'] == 'Открыть квартиру' and 'startapp=a_' in btn['web_app']['url'], done)
    push(text_msg(900102, 'Кто-то', '/start own_' + code))
    check('bot: the used link is refused for someone else', wait_message(900102, lambda b: 'другой человек' in b.get('text', '')) is not None)
    mctx, mama, e2 = page_for(browser); errors += [e2]
    mama.goto(btn['web_app']['url'].replace(PUBLIC, BASE) + launch(900100, 'Мама')); mama.wait_for_selector('.owners-section', timeout=10000); settle(mama, 900)
    msec = mama.inner_text('.owners-section')
    check('Мама: sees both owners, herself marked, can leave, cannot invite', 'Анна' in msec and 'это вы' in msec and mama.locator('[data-act=apartment-leave]').count() == 1 and mama.locator('[data-act=owner-invite]').count() == 0, msec)
    check('Мама: no «Удалить квартиру»', mama.locator('[data-act=delete-apartment]').count() == 0)
    check('Мама: can invite tenants and edit the apartment', mama.locator('.people-section [data-act=invite]').count() == 1 and mama.locator('[data-act=edit-apartment]').count() == 1)
    tall(mama, f'{OUT}/coowner-03-mama-apartment-light.png')
    mama.click('.apartment-tabs [data-tab=meters]'); settle(mama)
    check('Мама: manages meters', mama.locator('[data-act=new-meter]').count() > 0)
    # The tenant marks cash; Мама confirms.
    tctx, ten, e3 = page_for(browser, 375); errors += [e3]
    rid = json.loads(subprocess.check_output([NODE, '-e', "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(JSON.stringify(d.prepare(\"SELECT id FROM records WHERE kind='charge' AND status='pending' ORDER BY created_at DESC LIMIT 1\").get()))", os.environ['KEYS_DB']], text=True, stderr=subprocess.DEVNULL))['id']
    ten.goto(BASE + '/?startapp=r_' + rid + launch(900005, 'Ольга')); ten.wait_for_selector('.detail-amount', timeout=10000); settle(ten)
    ten.click('[data-act=record-action][data-action=claim] >> nth=0'); ten.wait_for_selector('.method-switch'); ten.click('[data-form=record-action] button[type=submit]'); ten.wait_for_selector('.claim-card', timeout=10000)
    mama.goto(BASE + '/?startapp=r_' + rid + launch(900100, 'Мама')); mama.wait_for_selector('.claim-card', timeout=10000); settle(mama)
    mama.click('.claim-card [data-action=confirm]'); mama.wait_for_selector('[data-form=record-action]'); settle(mama); mama.click('[data-form=record-action] button[type=submit]'); mama.wait_for_selector('.pay-entry.ok', timeout=10000); settle(mama)
    log = mama.inner_text('.payment-log'); check('Мама: confirmed the cash; history names her', 'Мама' in log and 'наличными' in log, log)
    tall(mama, f'{OUT}/coowner-04-mama-confirmed-cash.png')
    own.goto(BASE + '/' + launch(777001, 'Анна')); own.wait_for_selector('.app-body', timeout=10000); settle(own)
    own.click('[data-act=nav][data-page=notifications] >> visible=true >> nth=0'); settle(own)
    notes = own.inner_text('main'); check('Анна: notification says Мама confirmed', 'Мама' in notes and 'Получено' in notes, notes[:400])
    own.screenshot(path=f'{OUT}/coowner-05-owner-notification.png')
    ten.goto(BASE + '/' + launch(900005, 'Ольга')); ten.wait_for_selector('.app-body', timeout=10000); open_apartment(ten)
    body = ten.inner_text('main'); check('tenant: «Собственники» lists Анна and Мама', 'Собственники' in body and 'Мама' in body and 'Анна' in body, body[:600])
    tall(ten, f'{OUT}/coowner-06-tenant-sees-owners.png')
    # Анна removes Мама.
    open_apartment(own); own.click('[data-act=co-owner-manage]'); own.wait_for_selector('[data-form=co-owner-remove]'); settle(own)
    own.screenshot(path=f'{OUT}/coowner-07-remove.png')
    own.click('[data-form=co-owner-remove] button[type=submit]'); own.wait_for_selector('.modal', state='detached'); settle(own)
    check('Анна: Мама removed from the list', 'Мама' not in own.inner_text('.owners-section'))
    mama.goto(BASE + '/' + launch(900100, 'Мама')); mama.wait_for_selector('.app-body, .role-page', timeout=10000); settle(mama)
    check('Мама: the apartment is gone after removal', 'Квартира на Лесной' not in mama.inner_text('body'))
    # Папа joins inside the Mini App, then leaves.
    open_apartment(own); own.click('.owners-section [data-act=owner-invite]'); own.wait_for_selector('[data-form=owner-invite-create]'); own.fill('[data-form=owner-invite-create] input[name=label]', 'Папа'); own.click('[data-form=owner-invite-create] button[type=submit]'); own.wait_for_selector('[data-invite-url]')
    code2 = own.inner_text('[data-invite-url]').split('own_')[1]
    pctx, papa, e4 = page_for(browser, 320, 'dark'); errors += [e4]
    papa.goto(BASE + '/' + launch(900101, 'Папа', 'dark', 'own_' + code2)); papa.wait_for_selector('[data-act=login]', timeout=10000); papa.click('[data-act=login]')
    papa.wait_for_selector('[data-form=owner-invite-accept]', timeout=10000); settle(papa)
    papa.screenshot(path=f'{OUT}/coowner-08-inapp-accept-320-dark.png')
    papa.click('[data-form=owner-invite-accept] button[type=submit]'); papa.wait_for_selector('.joined-welcome', timeout=10000); settle(papa, 900)
    check('Папа: joined inside the Mini App', 'совладелец' in papa.inner_text('.modal'))
    papa.screenshot(path=f'{OUT}/coowner-09-welcome-320-dark.png')
    papa.click('.modal [data-act=close-modal] >> nth=0'); settle(papa)
    check('Папа: no horizontal overflow at 320', not papa.evaluate('document.documentElement.scrollWidth>innerWidth+1'))
    tall(papa, f'{OUT}/coowner-10-papa-apartment-320-dark.png')
    papa.click('[data-act=apartment-leave]'); papa.wait_for_selector('[data-form=apartment-leave]'); papa.click('[data-form=apartment-leave] button[type=submit]'); papa.wait_for_selector('.modal', state='detached'); settle(papa)
    check('Папа: left by himself', 'Квартира на Лесной' not in papa.inner_text('main'))
    own.goto(BASE + '/' + launch(777001, 'Анна')); own.wait_for_selector('.app-body', timeout=10000); open_apartment(own)
    own.click('.apartment-tabs [data-tab=history]'); settle(own)
    hist = own.inner_text('main'); check('history: every co-owner change carries the actor', 'Мама — совладелец квартиры' in hist and 'Папа вышел(ла) из совладельцев' in hist, hist[:800])
    tall(own, f'{OUT}/coowner-11-history.png')
    check('no page errors', not any(errors), errors)
    browser.close()
fails = [n for n, ok in results if not ok]; print(f'{len(results) - len(fails)}/{len(results)} passed'); sys.exit(1 if fails else 0)
