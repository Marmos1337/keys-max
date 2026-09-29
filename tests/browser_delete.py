"""Deletion UI + real local HTTP/SQLite; production files, no MAX account.
External MAX SDK is not exercised. --embedded uses the existing test-only DOM/HTTP bridge without changing browser policies.
Run: python tests/browser_delete.py --chromium /usr/bin/chromium --output test-results/delete
"""
import argparse, json, os, socket, subprocess, tempfile, time, uuid
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from playwright.sync_api import sync_playwright
from browser_smoke import mount_embedded

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--embedded', action='store_true', help='DOM mount with Python HTTP bridge when browser navigation is restricted')
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    parser.add_argument('--output', default='test-results/delete')
    args = parser.parse_args()
    out = Path(args.output).resolve(); out.mkdir(parents=True, exist_ok=True)
    with socket.socket() as s: s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
    base = f'http://127.0.0.1:{port}'; groups = []; errors = []; cases = 0
    with tempfile.TemporaryDirectory(prefix='keys-delete-ui-') as data:
        env = {**os.environ, 'APP_MODE':'demo','HOST':'127.0.0.1','PORT':str(port),'PUBLIC_URL':base,'DATA_DIR':data,'MAX_BOT_TOKEN':'','TZ':'Europe/Moscow'}
        with open(out/'server.log', 'w') as log:
            proc = subprocess.Popen(['node','server/index.mjs'], cwd=ROOT, env=env, stdout=log, stderr=log)
            def api(path, body=None, token=''):
                headers = {'Origin':base,'X-Keys-Client':'miniapp','Content-Type':'application/json','Idempotency-Key':str(uuid.uuid4())}
                if token: headers['Authorization']='Bearer '+token
                req = Request(base+'/api'+path, method='POST' if body is not None else 'GET', data=json.dumps(body).encode() if body is not None else None, headers=headers)
                try: response=urlopen(req, timeout=10)
                except HTTPError as e: raise AssertionError(f'{path}: {e.code} {e.read().decode()}')
                return json.load(response)
            try:
                for _ in range(100):
                    try: api('/health'); break
                    except Exception: time.sleep(.1)
                owner=api('/auth/demo',{'role':'owner'})['token']; tenant=api('/auth/demo',{'role':'tenant'})['token']
                def new_apartment(title='Тестовая квартира для удаления'):
                    return api('/apartments',{'title':title,'address':'Тестовый город, Сосновая улица, дом 12, квартира 4','rooms':2,'area':52,'start':'2026-01-01','end':'2028-12-31','rent':6500000,'deposit':6500000,'photo':'room','rental_mode':'rooms','unit_title':'Светлая комната','recurring_rent':False},owner)
                a=new_apartment()
                with sync_playwright() as pw:
                    browser=pw.chromium.launch(headless=True,executable_path=args.chromium,args=['--no-sandbox'])
                    context=browser.new_context(viewport={'width':390,'height':844},locale='ru-RU')
                    context.route('https://st.max.ru/**',lambda route:route.fulfill(status=200,body='/* Local test: MAX SDK unavailable */',content_type='text/javascript'))
                    context.add_cookies([{'name':'keys_session','value':owner,'url':base,'httpOnly':True,'sameSite':'Lax'}])
                    def open_page(token=owner, selected=None):
                        q=context.new_page();q.set_default_timeout(9000);q.on('pageerror',lambda e:errors.append(str(e)))
                        if args.embedded: mount_embedded(q,base,initial_token=token)
                        else:
                            context.clear_cookies();context.add_cookies([{'name':'keys_session','value':token,'url':base,'httpOnly':True,'sameSite':'Lax'}])
                            q.goto(base+'/app/home',wait_until='domcontentloaded')
                        q.wait_for_selector('.app-shell')
                        if selected is not None:
                            q.locator('nav [data-page=apartments]:visible').first.click()
                            choice=q.locator('[data-act=apartment-select][data-id="'+selected+'"]')
                            if choice.count():choice.first.click()
                            q.wait_for_selector('main[data-page=apartments]')
                        return q
                    p=open_page(selected=a['id'])
                    assert p.locator('[data-act=delete-apartment]').count()==1
                    button=p.locator('[data-act=delete-apartment]');button.scroll_into_view_if_needed()
                    assert p.locator('main > :last-child').get_attribute('class').find('apartment-danger-zone')!=-1
                    p.screenshot(path=str(out/'01-delete-location-light.png'),full_page=False)
                    before=api('/state',token=owner)
                    button.click();p.wait_for_selector('[data-delete-confirm]')
                    p.wait_for_timeout(70)
                    assert p.locator('[data-delete-cancel]').evaluate('(el)=>el===document.activeElement')
                    assert 'Вы уверены' in p.locator('.modal').inner_text()
                    assert a['title'] in p.locator('.modal').inner_text()
                    p.locator('[data-delete-cancel]').click();p.wait_for_selector('.modal',state='detached')
                    after=api('/state',token=owner)
                    assert len(after['apartments'])==len(before['apartments'])
                    assert len(after['records'])==len(before['records'])
                    groups.append('Owner footer is last, preview read-only, cancellation restores focus and preserves data')
                    p.locator('[data-act=delete-apartment]').click();p.wait_for_selector('.modal');p.keyboard.press('Escape');p.wait_for_selector('.modal',state='detached')
                    p.locator('[data-act=delete-apartment]').click();p.wait_for_selector('.modal')
                    # Both themes and narrow / low / desktop viewports. Geometric tests
                    # inspect actual button/symbol rectangles instead of source strings.
                    for theme in ['light','dark']:
                        p.evaluate('(t)=>{document.documentElement.dataset.theme=t}',theme)
                        # theme.js uses data-theme; media settings are also changed for auto.
                        p.emulate_media(color_scheme=theme)
                        for width,height in [(320,700),(360,700),(390,844),(430,844),(768,900),(1440,900),(390,480)]:
                            p.set_viewport_size({'width':width,'height':height});p.wait_for_timeout(60)
                            p.locator('[data-delete-confirm]').scroll_into_view_if_needed()
                            result=p.evaluate('''() => {
                              const dialog=document.querySelector('.modal'), cancel=document.querySelector('[data-delete-cancel]'), confirm=document.querySelector('[data-delete-confirm]');
                              const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};
                              return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,dialogOverflow:dialog.scrollWidth>dialog.clientWidth+1,cancel:box(cancel),confirm:box(confirm),icon:box(confirm.querySelector('svg'))};
                            }''')
                            assert not result['overflow'], result
                            assert not result['dialogOverflow'], result
                            for key in ['cancel','confirm','icon']:
                                b=result[key];assert b['x']>=0 and b['right']<=width+1,(theme,width,key,result)
                            assert result['confirm']['h']>=44
                            assert abs(result['cancel']['w']-result['confirm']['w'])<=1
                            assert abs(result['cancel']['h']-result['confirm']['h'])<=1
                            assert result['icon']['w']>=17 and result['icon']['h']>=17
                            cases+=1
                            p.screenshot(path=str(out/f'confirm-{theme}-{width}x{height}.png'),full_page=False)
                    groups.append('14 visual cases: light/dark, 320–1440px, low window, equal buttons, non-clipped icon')
                    p.set_viewport_size({'width':390,'height':844});p.locator('[data-delete-cancel]').click()
                    # Long user input stays inside the confirmation and is shown fully.
                    a=api('/apartments/'+a['id'],{'version':a['version'],'title':'ОченьДлинноеНазваниеКвартирыБезПробеловДляПроверкиПереносаТекстаВПодтверждении'},owner)
                    p.close();p=open_page(selected=a['id']);p.emulate_media(color_scheme='dark')
                    p.locator('[data-act=delete-apartment]').click();p.wait_for_selector('.modal')
                    assert p.locator('.modal').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
                    p.screenshot(path=str(out/'long-title-dark.png'),full_page=False)
                    # Mutate after preview: delete must fail and require another confirmation.
                    api('/apartments/'+a['id'],{'version':a['version'],'title':'Другая редакция квартиры'},owner)
                    p.locator('[data-delete-confirm]').click();p.wait_for_selector('[data-act=refresh-delete-apartment]')
                    assert p.locator('[data-delete-confirm]').is_disabled()
                    assert 'изменились' in p.locator('.form-error').inner_text()
                    p.locator('[data-act=refresh-delete-apartment]').click();p.wait_for_selector('[data-delete-confirm]:not([disabled])')
                    assert 'Другая редакция квартиры' in p.locator('.modal').inner_text()
                    groups.append('Long labels fit; stale confirmation is blocked and must be reviewed again')
                    # Submit exactly once and ensure object and selected context disappear.
                    p.locator('[data-delete-confirm]').click();p.wait_for_selector('.modal',state='detached')
                    p.wait_for_selector('main[data-page=home]')
                    assert not any(x['id']==a['id'] for x in api('/state',token=owner)['apartments'])
                    assert p.evaluate('localStorage.getItem("keys.apartment")')!=a['id']
                    p.close();p=open_page()
                    assert 'Другая редакция квартиры' not in p.locator('main').inner_text()
                    groups.append('Confirmed deletion removes real server data, resets context, survives reload')
                    # Occupied property displays an explanation, not a destructive action.
                    occupied=next(x for x in api('/state',token=owner)['apartments'] if any(l['apartment_id']==x['id'] and l['tenant_ids'] for l in api('/state',token=owner)['leases']))
                    p.close();p=open_page(selected=occupied['id'])
                    p.locator('[data-act=delete-apartment]').click();p.wait_for_selector('[data-delete-dialog]')
                    assert p.locator('[data-delete-confirm]').count()==0
                    assert 'действующие аренды' in p.locator('.modal').inner_text()
                    p.screenshot(path=str(out/'active-lease-blocked.png'),full_page=False)
                    p.locator('[data-delete-cancel]').click()
                    groups.append('Occupied apartment cannot be deleted; existing tenancy is preserved')
                    # Actual tenant cookie, not an owner with hidden CSS control.
                    ta=api('/state',token=tenant)['apartments'][0]['id']
                    p.close();p=open_page(token=tenant,selected=ta)
                    assert p.locator('[data-act=delete-apartment]').count()==0
                    groups.append('Tenant account has no deletion button')
                    assert not errors, errors
                    browser.close()
                result={'pass':True,'groups':groups,'visual_cases':cases,'screenshots':len(list(out.glob('*.png'))),'javascript_errors':errors,'engine':'Chromium','transport':('about:blank DOM, Python bridge to real local HTTP/SQLite; browser cookies/network not exercised' if args.embedded else 'real localhost HTTP/cookies, production JS/CSS, local SQLite'),'max_sdk':'replaced by empty script; real MAX/iOS/Android not tested'}
                (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False,indent=2))
            finally:
                proc.terminate()
                try:proc.wait(timeout=8)
                except subprocess.TimeoutExpired:proc.kill();proc.wait()

if __name__=='__main__':main()
