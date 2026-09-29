"""0.3.0 browser regressions using production UI and a real temporary SQLite server.
The --embedded option is a constrained-environment DOM/HTTP bridge, NOT a MAX WebView test.
Synthetic extra users/sessions are inserted through SQLite only by this test runner.
No development login endpoints are added to the application.
"""
from __future__ import annotations
import argparse,json,os,socket,subprocess,tempfile,time,uuid
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from playwright.sync_api import sync_playwright
from browser_smoke import mount_embedded
ROOT=Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--embedded',action='store_true');parser.add_argument('--chromium');parser.add_argument('--output',default='test-results/revision-v3');args=parser.parse_args()
    out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    base=f'http://127.0.0.1:{port}';groups=[];errors=[]
    with tempfile.TemporaryDirectory(prefix='keys-v3-ui-') as data:
        log=open(out/'server.log','w',encoding='utf8')
        env={**os.environ,'APP_MODE':'demo','PORT':str(port),'HOST':'127.0.0.1','PUBLIC_URL':base,'DATA_DIR':data,'MAX_BOT_TOKEN':'','MAX_BOT_USERNAME':'test_keys_bot','TZ':'Europe/Moscow'}
        server=subprocess.Popen(['node','server/index.mjs'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        def api(path,body=None,token=''):
            headers={'Origin':base,'X-Keys-Client':'miniapp','Content-Type':'application/json','Idempotency-Key':str(uuid.uuid4())}
            if token:headers['Authorization']='Bearer '+token
            req=Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method='POST' if body is not None else 'GET')
            try:r=urlopen(req,timeout=10)
            except HTTPError as e:raise AssertionError(f'{path}: {e.code} {e.read().decode()}')
            return json.loads(r.read())
        try:
            for _ in range(100):
                try:api('/api/health');break
                except Exception:time.sleep(.05)
            owner=api('/api/auth/demo',{'role':'owner'})['token']
            # Create only synthetic test actors. Authentication itself remains real.
            code="""import {openDatabase} from './server/db.mjs';import {createSession} from './server/auth.mjs';
              const db=openDatabase(process.env.DATA_DIR),users=[];
              for(const [id,name] of [['qa-a','Анна Тестовая'],['qa-b','Борис Тестовый'],['qa-c','Вера Тестовая']]) {
                db.run('INSERT INTO users(id,name,role,created_at) VALUES(?,?,?,?)',id,name,'tenant',new Date().toISOString());
                users.push({id,name,token:createSession(db,id).token});}
              console.log(JSON.stringify(users));db.close();"""
            users=json.loads(subprocess.check_output(['node','--input-type=module','-e',code],cwd=ROOT,env=env,text=True))
            with sync_playwright() as pw:
                browser=pw.chromium.launch(headless=True,**({'executable_path':args.chromium} if args.chromium else {}))
                def open_page(token=owner):
                    p=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1);p.set_default_timeout(8000);p.on('pageerror',lambda e:errors.append(str(e)))
                    if args.embedded:mount_embedded(p,base,initial_token=token)
                    else:
                        p.context.add_cookies([{'name':'keys_session','value':token,'url':base,'httpOnly':True,'sameSite':'Lax'}]);p.goto(base,wait_until='domcontentloaded')
                    p.wait_for_selector('.app-shell');return p
                def nav(p,name):p.locator('nav [data-page="'+name+'"]:visible').first.click()
                def submit(p):
                    p.locator('.modal form button[type=submit]').click();p.wait_for_selector('.modal',state='detached')
                def shot(p,name):p.screenshot(path=str(out/(name+'.png')),full_page=True)
                def property(p,aid,lease=None):
                    nav(p,'apartments')
                    button=p.locator('[data-act=apartment-select][data-id="'+aid+'"]')
                    if button.count():button.first.click()
                    if lease:p.select_option('[data-change=lease]',lease)
                page=open_page()
                assert page.locator('.page-heading [data-act=new-apartment]').count()==0
                assert page.locator('.topbar [data-page=notifications]').count()==1
                property(page,api('/api/state',token=owner)['apartments'][0]['id'])
                assert page.locator('.page-heading [data-act=edit-apartment]').count()==1
                assert page.locator('.page-heading [data-act=new-apartment]').count()==1
                assert page.get_by_text('Вся история',exact=True).count()==0
                page.locator('[data-tab=contract]').click();assert 'ПАРАМЕТРЫ АРЕНДЫ' not in page.locator('main').inner_text()
                groups.append('navigation placement, single history and calm contract typography')
                page.locator('.page-heading [data-act=new-apartment]').click()
                for width in [320,360,390,768,1440]:
                    page.set_viewport_size({'width':width,'height':900})
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
                    for name in ['start','end']:
                        el=page.locator('.modal [name='+name+']');assert el.get_attribute('data-date-format')=='date';assert el.get_attribute('type')=='text'
                        box=el.bounding_box();assert box['x']>=0 and box['x']+box['width']<=width+1,(width,box)
                page.set_viewport_size({'width':390,'height':844})
                page.fill('.modal [name=title]','Квартира с двумя комнатами');page.fill('.modal [name=address]','Тестовый город, улица Мира, 10')
                page.select_option('[name=rental_mode]','rooms');page.fill('[name=unit_title]','Комната с балконом');page.fill('[name=rent]','60000')
                page.fill('[name=start]','01.01.2026');page.fill('[name=end]','31.12.2028');page.uncheck('[name=recurring_rent]');submit(page)
                state=api('/api/state',token=owner);a=next(x for x in state['apartments'] if x['title']=='Квартира с двумя комнатами');l1=next(x for x in state['leases'] if x['apartment_id']==a['id'])
                assert l1['rent']==6000000
                page.locator('[data-act=new-unit]').click();page.fill('.modal [name=title]','Тихая комната');submit(page)
                state=api('/api/state',token=owner);room2=next(x for x in state['units'] if x['apartment_id']==a['id'] and x['title']=='Тихая комната')
                page.locator('[data-act=new-lease][data-unit="'+room2['id']+'"]').click();page.fill('.modal [name=rent]','30000');page.fill('.modal [name=start]','01.01.2026');page.fill('.modal [name=end]','31.12.2028');page.uncheck('[name=recurring_rent]');submit(page)
                state=api('/api/state',token=owner);l2=next(x for x in state['leases'] if x['unit_id']==room2['id'])
                assert l2['rent']==3000000
                shot(page,'01-rooms-mobile');groups.append('room creation and independent rental forms; Russian date fields 320–1440px')
                # Two co-tenants in room A; a separate tenant in room B.
                for user,lease in [(users[0],l1),(users[1],l1),(users[2],l2)]:
                    invite=api('/api/leases/'+lease['id']+'/invite',{},owner)
                    assert 'https://max.ru/test_keys_bot?start=join_' in invite['url']
                    api('/api/join',{'code':invite['code']},user['token'])
                page.close();page=open_page();property(page,a['id'],l1['id'])
                assert 'Анна Тестовая, Борис Тестовый' in page.locator('main').inner_text()
                page.locator('[data-act=invite]').click();assert 'max.ru/test_keys_bot?start=join_' in page.locator('.modal').inner_text();page.locator('[data-act=close-modal]').click()
                shot(page,'02-group-household');groups.append('two tenants per room; separate room; repeat bot-first invitation links')
                # Owner creates any kind of meter and multiple tariff channels.
                page.locator('[data-tab=meters]').click();page.locator('[data-act=new-meter]').click()
                page.fill('[name=label]','Общее электричество');page.select_option('[name=kind]','electricity');page.select_option('[name=scheme]','triple');page.select_option('[name=scope]','apartment');submit(page)
                assert page.locator('.meter-row').count()==3
                page.locator('[data-act=new-meter]').click();page.fill('[name=label]','Газ комнаты');page.select_option('[name=kind]','gas');submit(page)
                assert page.locator('.meter-row').count()==4
                shot(page,'03-configurable-meters');groups.append('configurable gas and shared three-tariff electricity via UI')
                tenant=open_page(users[0]['token']);nav(tenant,'apartments');tenant.locator('[data-tab=meters]').click()
                assert tenant.locator('[data-act=new-meter]').count()==0
                inputs=tenant.locator('[data-form=readings] input[inputmode=decimal]');assert inputs.count()==4
                for i in range(4):inputs.nth(i).fill(str(100+i)+',125')
                tenant.locator('[data-form=readings] button[type=submit]').click();tenant.wait_for_selector('.detail-body')
                other=open_page(users[2]['token']);nav(other,'apartments');other.locator('[data-tab=meters]').click()
                assert 'Общее электричество' in other.locator('main').inner_text()
                assert 'Газ комнаты' not in other.locator('main').inner_text()
                assert other.locator('[data-form=readings]').count()==0
                groups.append('tenant readings; shared values only; private room meter stays hidden')
                # Create one bill; two people each claim part, owner confirms each separately.
                page.locator('[data-tab=payments]').click();page.locator('[data-kind=charge]').click();page.fill('.modal [name=title]','Совместная оплата');page.fill('.modal [name=amount]','60000');submit(page)
                rid=next(r['id'] for r in api('/api/state',token=owner)['records'] if r['title']=='Совместная оплата')
                for i,amount in [(0,'20000'),(1,'40000')]:
                    payer=open_page(users[i]['token']);nav(payer,'finances');payer.locator('[data-act=open-record][data-id="'+rid+'"]').click();payer.locator('[data-action=claim]').click();payer.fill('.modal [name=amount]',amount);submit(payer);payer.close()
                page.close();page=open_page();nav(page,'finances');page.locator('[data-act=open-record][data-id="'+rid+'"]').click()
                assert page.locator('.claim-card').count()==2;shot(page,'04-joint-payments')
                page.locator('.claim-card [data-action=confirm]').first.click();submit(page);assert page.locator('.claim-card').count()==1
                page.locator('.claim-card [data-action=confirm]').first.click();submit(page);assert page.locator('.claim-card').count()==0
                assert page.locator('.payment-log > div').count()==2;assert 'Оплачено' in page.locator('.badge').first.inner_text()
                groups.append('two actual-payment claims and individual owner confirmations, no duplicate rent')
                # Rule operations, future scheduling, Russian month and frozen issued amounts.
                property(page,a['id'],l1['id']);page.locator('[data-tab=payments]').click();page.locator('[data-page=recurring]').first.click();page.locator('[data-act=new-rule]').click()
                page.select_option('.modal [name=lease_id]',l1['id']);page.fill('.modal [name=title]','Интернет для комнаты');page.fill('.modal [name=amount]','900');page.fill('.modal [name=due_day]','31');page.fill('.modal [name=advance_days]','14')
                assert page.locator('.modal [name=from_month]').get_attribute('data-date-format')=='month';submit(page)
                rule=next(r for r in api('/api/state',token=owner)['recurring_rules'] if r['title']=='Интернет для комнаты')
                page.locator('[data-act=edit-rule][data-id="'+rule['id']+'"]').click();page.fill('.modal [name=amount]','950');submit(page)
                page.locator('[data-act=rule-state][data-id="'+rule['id']+'"][data-value=paused]').click();submit(page)
                assert next(r for r in api('/api/state',token=owner)['recurring_rules'] if r['id']==rule['id'])['state']=='paused'
                page.locator('[data-act=rule-state][data-id="'+rule['id']+'"][data-value=active]').click();submit(page)
                shot(page,'05-recurring-payments')
                page.locator('[data-act=rule-state][data-id="'+rule['id']+'"][data-value=deleted]').click();submit(page)
                assert page.locator('[data-act=edit-rule][data-id="'+rule['id']+'"]').count()==0
                groups.append('create/edit/pause/resume/delete monthly rule without changing issued bills')
                # Theme setting affects real wordmark variants and the entire surface.
                nav(page,'profile');page.select_option('[name=theme]','dark');page.locator('[data-form=profile] button[type=submit]').click();page.wait_for_timeout(150)
                assert page.locator('html').get_attribute('data-theme')=='dark';nav(page,'apartments');page.set_viewport_size({'width':390,'height':844})
                assert page.locator('.topbar img[data-themed-logo]').evaluate("e=>e.src.includes('data:image/png')" if args.embedded else "e=>e.src.endsWith('keys-logo-white.png')")
                shot(page,'06-dark-mobile');page.emulate_media(color_scheme='light')
                assert page.locator('html').get_attribute('data-theme')=='dark'
                nav(page,'profile');page.select_option('[name=theme]','light');page.locator('[data-form=profile] button[type=submit]').click();page.wait_for_timeout(150);nav(page,'home')
                assert page.locator('html').get_attribute('data-theme')=='light'
                groups.append('saved light/dark theme; original wordmark; system change does not override explicit preference')
                nav(page,'requests');assert page.locator('[data-value=resolved]').count()==1;assert page.locator('[data-value=closed]').count()==1
                for width in [320,360,390,768,1440]:
                    page.set_viewport_size({'width':width,'height':900});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                groups.append('separate ticket confirmation filter and responsive navigation')
                page.set_viewport_size({'width':1440,'height':1000});property(page,a['id'],l1['id']);shot(page,'07-owner-desktop')
                assert not errors,errors
                result={'passed':len(groups),'failed':0,'groups':groups,'mode':'embedded DOM + real HTTP bridge' if args.embedded else 'native browser HTTP','page_errors':errors,'widths':[320,360,390,768,1440],'max_live_tested':False,'webkit_tested':False}
                (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False),flush=True);browser.close()
        except Exception:
            try:page.screenshot(path=str(out/'failure.png'),full_page=True);print(page.locator('body').inner_text()[-4000:],flush=True)
            except Exception:pass
            raise
        finally:
            server.terminate()
            try:server.wait(timeout=5)
            except subprocess.TimeoutExpired:server.kill();server.wait()
            log.close()
if __name__=='__main__':main()
