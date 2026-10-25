# Drives the Mini App as if launched in Telegram: signed hash + a TelegramWebviewProxy that records bridge events.
import json, subprocess, sys, os
from playwright.sync_api import sync_playwright
SP=os.path.dirname(os.path.abspath(__file__)); TOKEN='123456:local-test-token-abcdefghijklmnopqrstuv'
NODE=os.environ.get('NODE','node'); BASE='http://localhost:3000'
LINK=sys.argv[1]; OUT=os.path.join(SP,'shots'); os.makedirs(OUT,exist_ok=True)
def launch_hash(uid,name,scheme,start=''):
    return subprocess.check_output([NODE,os.path.join(SP,'initdata.mjs'),TOKEN,str(uid),name,scheme,start],text=True).strip()
PROXY="window.__events=[];window.TelegramWebviewProxy={postEvent:function(n,d){window.__events.push([n,d]);}};"
results=[]
def check(name,cond,extra=''):
    results.append((name,bool(cond))); print(('PASS ' if cond else 'FAIL ')+name+(' — '+extra if extra and not cond else ''))
def events(page): return page.evaluate('window.__events.map(e=>e[0])')
def open_app(browser,w,scheme,uid,name,start=''):
    ctx=browser.new_context(viewport={'width':w,'height':800},device_scale_factor=2,color_scheme=scheme,is_mobile=True,has_touch=True)
    ctx.add_init_script(PROXY); page=ctx.new_page(); errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('console',lambda m:errors.append(m.text) if m.type=='error' and '401' not in m.text else None)
    page.goto(BASE+'/'+launch_hash(uid,name,scheme,start)); page.wait_for_selector('[data-act=login]',timeout=8000)
    return ctx,page,errors
def overflow(page): return page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
with sync_playwright() as p:
    browser=p.chromium.launch(channel='chrome',headless=True)
    # 1. Main owner scenario, every width and theme.
    for scheme in ['light','dark']:
        for w in [320,375,430]:
            tag=f'{w}-{scheme}'
            ctx,page,errors=open_app(browser,w,scheme,777001,'Анна',)
            check(f'{tag} welcome says Telegram','Войти через Telegram' in page.inner_text('body'))
            check(f'{tag} theme follows Telegram',page.evaluate('document.documentElement.dataset.theme')==scheme)
            page.screenshot(path=f'{OUT}/{tag}-1-welcome.png')
            page.click('[data-act=login]'); page.wait_for_selector('.app-body, [data-act=choose-role]',timeout=8000); page.wait_for_timeout(400)
            body=page.inner_text('body')
            check(f'{tag} logged in, apartment visible','Квартира на Лесной' in body or 'Лесн' in body, body[:200])
            check(f'{tag} no horizontal overflow home',not overflow(page))
            page.screenshot(path=f'{OUT}/{tag}-2-home.png')
            page.click('[data-act=nav][data-page=profile] >> visible=true >> nth=0'); page.wait_for_timeout(300)
            ev=events(page)
            check(f'{tag} BackButton shown off home','web_app_setup_back_button' in ev)
            page.click('[data-act=messengers]'); page.wait_for_selector('.modal'); page.wait_for_timeout(250)
            m=page.inner_text('.modal').lower()
            check(f'{tag} messengers modal lists Telegram connected','telegram' in m and 'подключён' in m, m[:200])
            page.screenshot(path=f'{OUT}/{tag}-3-messengers.png')
            if w==375:
                page.click('.modal [data-act=link-create]'); page.wait_for_selector('.modal .code-box'); page.wait_for_timeout(400)
                code=page.inner_text('.modal .code-box'); check(f'{tag} link code issued',len(code.replace('-',''))==10,code)
                page.screenshot(path=f'{OUT}/{tag}-3b-linkcode.png')
            page.click('.modal [data-act=close-modal]')
            page.click('[data-act=nav][data-page=apartments] >> visible=true >> nth=0'); page.wait_for_timeout(300)
            inv=page.locator('[data-act=invite]')
            if inv.count():
                inv.first.click(); page.wait_for_selector('.invite-url'); page.wait_for_timeout(250)
                url=page.inner_text('.code-box.invite-url')
                check(f'{tag} invite link points to the Telegram bot',url.startswith('https://t.me/rentkeysbot?start=join_'),url)
                page.screenshot(path=f'{OUT}/{tag}-4-invite.png')
                if w==375 and scheme=='light':
                    page.click('[data-act=share-invite]'); page.wait_for_timeout(200)
                    last=page.evaluate('window.__events.filter(e=>e[0]==="web_app_open_tg_link").map(e=>e[1])')
                    check('share opens Telegram share sheet',any('share/url' in json.dumps(x) for x in last),json.dumps(last)[:200])
            else: check(f'{tag} invite button present',False)
            ev=events(page)
            check(f'{tag} ready/expand/haptics sent','web_app_ready' in ev and 'web_app_expand' in ev and 'web_app_trigger_haptic_feedback' in ev,str(sorted(set(ev))))
            check(f'{tag} header painted','web_app_set_header_color' in ev)
            check(f'{tag} no JS errors',not errors,'; '.join(errors)[:300])
            ctx.close()
    # 2. Existing MAX account moves to Telegram with a one-time code.
    ctx,page,errors=open_app(browser,375,'light',777002,'Илья')
    page.click('[data-act=login]'); page.wait_for_selector('[data-act=choose-role]',timeout=8000)
    page.screenshot(path=f'{OUT}/375-light-5-role.png')
    page.click('[data-act=link-claim]'); page.fill('input[name=code]',LINK)
    page.wait_for_timeout(400); page.screenshot(path=f'{OUT}/375-light-6-claim.png')
    page.click('form[data-form=link-claim] button[type=submit]'); page.wait_for_timeout(1200)
    body=page.inner_text('body')
    check('MAX account opened in Telegram after code','Студия у парка' in body,body[:300])
    page.screenshot(path=f'{OUT}/375-light-7-linked.png')
    page.click('[data-act=nav][data-page=profile] >> visible=true >> nth=0'); page.click('[data-act=messengers]'); page.wait_for_selector('.modal')
    m=page.inner_text('.modal').lower(); check('both messengers connected',m.count('подключён')>=2 and 'не подключён' not in m,m)
    ctx.close()
    # 3. Same code cannot be reused.
    ctx,page,errors=open_app(browser,375,'light',777003,'Чужой')
    page.click('[data-act=login]'); page.wait_for_selector('[data-act=choose-role]',timeout=8000)
    page.click('[data-act=link-claim]'); page.fill('input[name=code]',LINK); page.click('form[data-form=link-claim] button[type=submit]'); page.wait_for_timeout(800)
    check('reused code rejected','недействителен' in page.inner_text('.modal'))
    ctx.close()
    # 4. MAX launch still uses the MAX bridge (no Telegram hash).
    ctx=browser.new_context(viewport={'width':375,'height':800}); page=ctx.new_page(); page.goto(BASE+'/'); page.wait_for_timeout(800)
    check('plain/MAX launch loads MAX bridge',page.evaluate('window.__keysPlatform')=='max' and page.evaluate('[...document.scripts].some(s=>s.src.includes("st.max.ru"))'))
    ctx.close(); browser.close()
fails=[n for n,ok in results if not ok]
print(f'{len(results)-len(fails)}/{len(results)} passed'); sys.exit(1 if fails else 0)
