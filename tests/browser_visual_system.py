"""Visual-system audit. Native browser HTTP by default; optional test DOM bridge.
Covers both roles, light/dark, mobile/desktop, real dialogs and record detail types.
Screenshots and checks are local QA evidence, not a claim of live MAX testing.
"""
from __future__ import annotations
import argparse, json, os, socket, subprocess, tempfile, time, uuid
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from playwright.sync_api import sync_playwright
from browser_smoke import mount_embedded, ROOT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--embedded', action='store_true')
    parser.add_argument('--chromium')
    parser.add_argument('--output', default='test-results/visual-system')
    args = parser.parse_args()
    out = Path(args.output).resolve(); out.mkdir(parents=True, exist_ok=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    results = []; errors = []; shots = []
    with tempfile.TemporaryDirectory(prefix='keys-visual-system-') as tmp:
        log = open(out/'server.log', 'w', encoding='utf8')
        env = {**os.environ, 'APP_MODE':'demo', 'HOST':'127.0.0.1', 'PORT':str(port), 'PUBLIC_URL':base, 'DATA_DIR':tmp, 'MAX_BOT_TOKEN':'', 'MAX_BOT_USERNAME':'test_keys_bot', 'TZ':'Europe/Moscow'}
        server = subprocess.Popen(['node','server/index.mjs'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        def api(path, body=None, token=''):
            headers={'Origin':base, 'X-Keys-Client':'miniapp', 'Content-Type':'application/json', 'Idempotency-Key':str(uuid.uuid4())}
            if token: headers['Authorization']='Bearer '+token
            req=Request(base+path, headers=headers, data=json.dumps(body).encode() if body is not None else None, method='POST' if body is not None else 'GET')
            try: response=urlopen(req,timeout=10)
            except HTTPError as e: raise AssertionError((path,e.code,e.read().decode()))
            return json.loads(response.read())
        try:
            for _ in range(100):
                try: api('/api/health'); break
                except Exception: time.sleep(.05)
            owner=api('/api/auth/demo', {'role':'owner'})['token']
            tenant=api('/api/auth/demo', {'role':'tenant'})['token']
            with sync_playwright() as pw:
                browser=pw.chromium.launch(headless=True, **({'executable_path':args.chromium} if args.chromium else {}))
                p=browser.new_page(viewport={'width':390,'height':844}, locale='ru-RU', device_scale_factor=1)
                p.set_default_timeout(8000); p.on('pageerror', lambda e: errors.append(str(e)))
                if args.embedded: mount_embedded(p,base)
                else: p.goto(base,wait_until='domcontentloaded')
                def shot(name, full=True):
                    p.wait_for_timeout(25)
                    filename=name+'.png'
                    p.screenshot(path=str(out/filename),full_page=full,animations='disabled')
                    shots.append(filename)
                def nav(name):
                    el=p.locator('nav [data-page="'+name+'"]:visible').first
                    if el.count(): el.click()
                    elif name=='notifications': p.locator('.notifications-button').click()
                    elif name=='recurring':
                        nav('finances');p.locator('[data-page=recurring]').first.click()
                    elif name in ['visits','purchases']:
                        nav('apartments');p.locator('[data-tab=overview]').click();p.locator('[data-act=lease-page][data-page="'+name+'"]').click()
                    elif name in ['meters','contract','payments','history']:
                        nav('apartments');p.locator('[data-tab="'+name+'"]').click()
                    else: raise AssertionError('Unknown view '+name)
                def role(name):
                    p.locator('[data-act=switch-role]').first.click();p.locator('[data-role="'+name+'"]').click();p.wait_for_selector('.app-shell')
                def theme(name):
                    nav('profile');p.select_option('[name=theme]',name)
                    p.locator('[data-form=profile] button[type=submit]').click()
                    p.get_by_text('Настройки сохранены',exact=True).wait_for()
                    assert p.locator('html').get_attribute('data-theme')==name
                def check(label, modal=False):
                    geometry = p.evaluate((ROOT/'tests/layout_audit.js').read_text())
                    assert not geometry, (label, geometry)
                    assert p.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), label+' horizontal page overflow'
                    # Check the shared controls, not the deliberately scrollable tab strips.
                    style_errors=p.locator('.btn:visible').evaluate_all('''els=>els.flatMap(e=>{
                      const s=getComputedStyle(e), failures=[];
                      if(parseFloat(s.borderTopLeftRadius)<12)failures.push('square button');
                      if(parseFloat(s.borderTopWidth)>0)failures.push('extra border');
                      if(!e.textContent.trim()&&!e.getAttribute('aria-label'))failures.push('missing button name');
                      return failures.map(f=>({f,text:e.textContent,act:e.dataset.act}));
                    })''')
                    assert not style_errors,(label,style_errors)
                    if modal:
                        wrong=p.locator('.modal .field input,.modal .field select,.modal .field textarea').evaluate_all('''els=>els.filter(e=>{
                          const r=e.getBoundingClientRect();return r.width>0&&(r.x<0||r.right>innerWidth+1||parseFloat(getComputedStyle(e).borderTopWidth)>0)
                        }).map(e=>e.name)''')
                        assert not wrong,(label,wrong)
                    results.append(label)
                p.wait_for_selector('[data-act=login]');shot('welcome-mobile',False)
                p.locator('[data-act=login]').click();shot('role-mobile',False)
                p.locator('[data-role=owner]').click();p.wait_for_selector('.app-shell')
                pages=['home','apartments','contract','meters','payments','history','requests','finances','recurring','documents','purchases','visits','profile','notifications']
                for user_role in ['owner','tenant']:
                    if user_role=='tenant':role('tenant')
                    for colour in ['light','dark']:
                        theme(colour)
                        for width in [390,1440]:
                            p.set_viewport_size({'width':width,'height':844 if width==390 else 1000})
                            size='mobile' if width==390 else 'desktop'
                            for name in pages:
                                nav(name);check(f'{user_role}/{colour}/{size}/{name}')
                                shot(f'{user_role}-{colour}-{size}-{name}')
                                if name in ['home','finances','requests','apartments']:shot(f'viewport-{user_role}-{colour}-{size}-{name}',False)
                # Verify each dialog with real open controls (no injected app routes).
                role('owner')
                forms=[('new-apartment','apartments','[data-act=new-apartment]'),
                       ('edit-apartment','apartments','[data-act=edit-apartment]'),
                       ('cover','apartments','[data-act=edit-photo]'),
                       ('room','apartments','[data-act=new-unit]'),
                       ('invite','apartments','[data-act=invite]'),
                       ('terms','apartments','[data-kind=terms]'),
                       ('meter','meters','[data-act=new-meter]'),
                       ('meter-edit','meters','[data-act=edit-meter]'),
                       ('charge','finances','[data-kind=charge]'),
                       ('expense','finances','[data-kind=expense]'),
                       ('rule','recurring','[data-act=new-rule]'),
                       ('rule-edit','recurring','[data-act=edit-rule]'),
                       ('document','documents','[data-kind=document]'),
                       ('ticket','requests','[data-kind=ticket]'),
                       ('visit','visits','[data-kind=visit]'),
                       ('help','profile','[data-act=help]'),
                       ('security','profile','[data-act=security]'),
                       ('join','profile','[data-act=join]'),
                       ('termination','profile','[data-kind=termination]'),
                       ('export','profile','[data-act=export]')]
                for colour in ['light','dark']:
                    p.set_viewport_size({'width':390,'height':844});theme(colour)
                    for name,section,selector in forms:
                        nav(section);p.locator(selector).first.click();p.wait_for_selector('.modal')
                        check(f'owner/{colour}/dialog/{name}',True);shot(f'dialog-{colour}-{name}',False)
                        # Every dialog bottom is inspected, not just the long apartment form.
                        last=p.locator('.modal button').last
                        last.scroll_into_view_if_needed()
                        assert last.evaluate('e=>{const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return e===hit||e.contains(hit)}'), 'Dialog action occluded: '+name
                        check(f'owner/{colour}/dialog-bottom/{name}',True)
                        shot(f'dialog-{colour}-{name}-bottom',False)
                        p.locator('[data-act=close-modal]').click()
                # A narrow-viewport sweep over all views, including the collapsed sidebar.
                for width in [320,360,600,760,768,980,1024]:
                    p.set_viewport_size({'width':width,'height':900})
                    for name in pages:
                        nav(name);check(f'width/{width}/{name}')
                p.set_viewport_size({'width':390,'height':844});theme('light');nav('apartments')
                p.locator('[data-act=new-apartment]').click()
                for width in [320,360,600,760,980,1440]:
                    p.set_viewport_size({'width':width,'height':900});check(f'width/{width}/dialog/create-apartment',True)
                p.locator('[data-act=close-modal]').click()
                # Keyboard focus and empty filtered results are real DOM states.
                p.set_viewport_size({'width':390,'height':844});nav('requests')
                last=p.locator('[data-ui=segmented] button').last;last.focus()
                # :focus-visible follows keyboard modality, not programmatic pointer focus.
                p.keyboard.press('Tab');p.keyboard.press('Shift+Tab')
                assert last.evaluate('e=>document.activeElement===e')
                assert last.evaluate("e=>getComputedStyle(e).outlineStyle")!='none'
                last.click();check('keyboard-focus-and-scrollable-pill-selection');shot('empty-filter-mobile',False)
                # Create additional test records to inspect every detailed-card family.
                st=api('/api/state',token=tenant);lease=st['leases'][0];day=st['business_date'];ym=day[:7]
                year,month=map(int,ym.split('-'));month+=2
                if month>12:year+=1;month-=12
                future=f'{year:04d}-{month:02d}'
                payloads=[('terms',{'rent':lease['rent']+10000,'terms':'Согласуем обновлённые условия аренды.','effective_month':future,'due_day':5},owner),
                          ('termination',{'date':day,'reason':'Проверка экрана согласования выезда.'},tenant)]
                for kind,payload,token in payloads:
                    api('/api/records',{'lease_id':lease['id'],'kind':kind,'title':'Проверка: '+kind,'payload':payload},token)
                meters=[m for m in st['meters'] if m.get('lease_id')==lease['id'] and m.get('active')]
                if meters:
                    api('/api/records',{'lease_id':lease['id'],'kind':'reading','title':'Показания','payload':{'values':[{'meter_id':m['id'],'value':(m.get('previous') or m['baseline'])+1000} for m in meters]}},tenant)
                role('owner');theme('light')
                state_now=api('/api/state',token=owner)
                for colour in ['light','dark']:
                    theme(colour)
                    for kind in ['ticket','purchase','visit','charge','document','expense','reading','terms','termination']:
                        r=next((r for r in state_now['records'] if r['kind']==kind and r['lease_id']==lease['id']),None)
                        assert r,'missing detail fixture '+kind
                        nav('history');p.locator('[data-act=open-record][data-id="'+r['id']+'"]').first.click()
                        p.wait_for_selector('.detail-body');check(colour+'/detail/'+kind);shot(f'detail-{colour}-{kind}')
                        for width in [320,1440]:
                            p.set_viewport_size({'width':width,'height':900});check(f'{colour}/detail/{kind}/{width}')
                        p.set_viewport_size({'width':390,'height':844})
                role('tenant');nav('home');p.locator('[data-kind=purchase]').first.click();check('tenant/purchase-dialog',True);shot('dialog-dark-purchase',False);p.locator('[data-act=close-modal]').click()
                assert not errors,errors
                report={'checks':len(results),'failed':0,'checks_detail':results,'screenshots':shots,'roles':['owner','tenant'],'themes':['light','dark'],'widths':[320,360,390,600,760,768,980,1024,1440], 'mode':'embedded DOM + real Node/SQLite HTTP' if args.embedded else 'native browser HTTP','page_errors':errors,'max_live_tested':False,'webkit_tested':False}
                (out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
                print(json.dumps({k:v for k,v in report.items() if k not in ['checks_detail','screenshots']},ensure_ascii=False),flush=True)
                browser.close()
        except Exception:
            try:p.screenshot(path=str(out/'failure.png'));print(p.locator('body').inner_text()[-3000:],flush=True)
            except Exception:pass
            raise
        finally:
            server.terminate()
            try:server.wait(timeout=5)
            except subprocess.TimeoutExpired:server.kill();server.wait()
            log.close()

if __name__=='__main__':main()
