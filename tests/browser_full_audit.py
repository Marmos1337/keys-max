"""Supplemental regression: dual-role account, geometry, all forms and transient guide.
Native HTTP by default; --embedded only mounts the real UI with a local HTTP bridge.
The fixture and browser shims are test-only; they are never served to real users.
"""
from __future__ import annotations
import argparse,json,os,socket,subprocess,tempfile,time,uuid
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT,mount_embedded

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--embedded',action='store_true');ap.add_argument('--chromium');ap.add_argument('--output',default='test-results/full-audit');args=ap.parse_args()
    out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    base=f'http://127.0.0.1:{port}';checks=[];shots=[];errors=[];functional=[]
    geometry=(ROOT/'tests/layout_audit.js').read_text()
    with tempfile.TemporaryDirectory(prefix='keys-full-audit-') as tmp:
        ready=Path(tmp)/'ready.json';log=open(out/'server.log','w',encoding='utf8')
        env={**os.environ,'APP_MODE':'test','HOST':'127.0.0.1','PORT':str(port),'PUBLIC_URL':base,'DATA_DIR':str(Path(tmp)/'data'),'QA_READY':str(ready),'MAX_BOT_TOKEN':'','TZ':'Europe/Moscow'}
        proc=subprocess.Popen(['node','tests/visual_fixture.mjs'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        try:
            for _ in range(150):
                if ready.exists():break
                if proc.poll() is not None:raise RuntimeError((out/'server.log').read_text())
                time.sleep(.05)
            f=json.loads(ready.read_text())
            def api(path,who='dual',body=None):
                headers={'Origin':base,'X-Keys-Client':'miniapp','Idempotency-Key':str(uuid.uuid4()),'Authorization':'Bearer '+f['tokens'][who],'Content-Type':'application/json'}
                try:r=urlopen(Request(base+'/api'+path,headers=headers,data=json.dumps(body).encode() if body is not None else None,method='POST' if body is not None else 'GET'),timeout=10)
                except HTTPError as e:raise AssertionError((path,e.code,e.read().decode()))
                return json.loads(r.read())
            for who in ['owner','tenant','dual','alice']:
                for role in ['owner','tenant']:api('/profile/guide',who,{'role':role,'progress':{'opens':0,'topics':[],'dismissed':True}})
            with sync_playwright() as pw:
                browser=pw.chromium.launch(headless=True,**({'executable_path':args.chromium} if args.chromium else {}))
                def newpage(who,width=390,height=844):
                    page=browser.new_page(viewport={'width':width,'height':height},locale='ru-RU',device_scale_factor=1,reduced_motion='reduce')
                    page.set_default_timeout(8000);page.on('pageerror',lambda e:errors.append(str(e)))
                    if args.embedded:mount_embedded(page,base,f['tokens'][who])
                    else:
                        page.context.add_cookies([{'name':'keys_session','value':f['tokens'][who],'url':base}]);page.goto(base,wait_until='domcontentloaded')
                    page.wait_for_selector('.app-shell');return page
                p=newpage('dual')
                def shot(label,full=False):
                    name=label.replace('/','-')+'.png';p.screenshot(path=str(out/name),full_page=full,animations='disabled');shots.append(name)
                def check(label):
                    p.wait_for_timeout(35);bad=p.evaluate(geometry)
                    if bad:shot('failure-'+label);(out/'geometry-failure.json').write_text(json.dumps({'screen':label,'problems':bad},ensure_ascii=False,indent=2));raise AssertionError((label,bad))
                    checks.append(label)
                def nav(name):
                    if name.startswith('direct-'):
                        # Same navigation dispatcher, test-only entry for legacy/direct routes.
                        target=p.locator('nav [data-page=home]:visible').first
                        target.evaluate('(e,name)=>{e.dataset.page=name;e.click();}',name[7:])
                    elif name in ['home','apartments','requests','finances','documents','profile']:
                        p.locator('nav [data-page="'+name+'"]:visible').first.click()
                    elif name=='notifications':p.locator('.notifications-button').click()
                    elif name=='recurring':nav('finances');p.locator('[data-page=recurring]').first.click()
                    elif name in ['contract','payments','meters','history']:
                        nav('apartments');choose_room();p.locator('[data-tab="'+name+'"]').click()
                    elif name in ['purchases','visits']:
                        nav('apartments');choose_room();p.locator('[data-tab=overview]').click();p.locator('[data-act=lease-page][data-page="'+name+'"]').click()
                    else:raise AssertionError(name)
                def choose_room():
                    item=p.locator('[data-act=apartment-select][data-id="'+f['apartments']['rooms']+'"]')
                    if item.count():item.first.click()
                    select=p.locator('[data-change=lease]')
                    if select.count() and select.locator('option[value="'+f['leases']['a']+'"]').count():select.select_option(f['leases']['a'])
                def theme(colour):
                    nav('profile');p.select_option('[name=theme]',colour);p.locator('[data-form=profile] button[type=submit]').click();p.get_by_text('Настройки сохранены',exact=True).wait_for();nav('home')
                def role(name):
                    before=api('/state')['user']['id'];p.locator('[data-act=switch-role]:visible').first.click();p.locator('[data-role="'+name+'"]').click();p.wait_for_selector('.app-shell');assert api('/state')['user']['id']==before;assert api('/state')['user']['role']==name
                pages=['home','apartments','contract','meters','payments','history','requests','finances','recurring','documents','purchases','visits','profile','notifications','direct-meters','direct-history']
                for mode in ['owner','tenant']:
                    if mode=='tenant':role(mode)
                    for colour in ['light','dark']:
                        theme(colour)
                        for width in [320,390,768,1024,1440]:
                            p.set_viewport_size({'width':width,'height':844 if width<760 else 960})
                            for name in pages:
                                nav(name)
                                if name=='apartments':choose_room()
                                label=f'dual-{mode}/{colour}/{width}/{name}';check(label)
                                if width==390 or (width in [320,1440] and name in ['home','apartments','finances']):shot(label)
                        # Small desktop MAX windows, not just phone-sized emulation.
                        for width in [390,768]:
                            p.set_viewport_size({'width':width,'height':480});nav('apartments');choose_room();check(f'short/{mode}/{colour}/{width}');shot(f'short-{mode}-{colour}-{width}')
                functional.append('same account switches owner/tenant without losing access; dual header stays aligned')
                # Every record type plus pending/confirmed variants, on both sides.
                p.close();p=newpage('dual');role('owner')
                for who in ['dual','alice']:
                    if who=='alice':p.close();p=newpage(who)
                    available={r['id'] for r in api('/state',who)['records']}
                    for colour in ['light','dark']:
                        theme(colour)
                        for kind,rid in f['records'].items():
                            if rid not in available:continue
                            nav('history');p.locator('[data-act=open-record][data-id="'+rid+'"]').first.click();p.wait_for_selector('.detail-body')
                            for width in [320,390,768,1440]:
                                p.set_viewport_size({'width':width,'height':844 if width<760 else 960});check(f'detail/{who}/{colour}/{width}/{kind}')
                                if width==390:
                                    shot(f'detail-{who}-{colour}-{kind}',True)
                                    # Every action form must also lay out correctly, not only the detail page.
                                    actions=p.locator('.detail-actions [data-act=record-action]').count()
                                    for i in range(actions):
                                        p.locator('.detail-actions [data-act=record-action]').nth(i).click();p.wait_for_selector('.modal');check(f'action-form/{who}/{colour}/{kind}/{i}');shot(f'action-form-{who}-{colour}-{kind}-{i}');p.locator('[data-act=close-modal]').click()
                # Stress longer text, a large currency figure, common paired input error.
                p.close();p=newpage('dual');role('owner');theme('dark')
                state=api('/state');r=next(a for a in state['apartments'] if a['id']==f['apartments']['rooms'])
                api('/apartments/'+r['id'],body={'version':r['version'],'title':'Квартира с очень длинным названием рядом с центральным парком и набережной','address':'Тестовый город, длинная улица Северная набережная, дом 153, корпус 4, квартира 128','rooms':3,'area':72})
                person=api('/state')['user'];api('/profile',body={'name':'ОченьДлинноеИмяБезПробеловДляПроверкиОтображенияНаМаленькомЭкране','role':'owner','settings':person['settings']})
                p.close();p=newpage('dual',320);nav('home');check('stress/long-name/home');shot('stress-long-name-home')
                nav('profile');check('stress/long-name/profile');shot('stress-long-name-profile')
                nav('apartments');choose_room();check('stress/long-property-name');shot('stress-long-property-name')
                nav('finances');p.locator('[data-kind=charge]').first.click();check('stress/paired-inputs/charge');shot('stress-charge-form');p.locator('[data-act=close-modal]').click()
                for name in pages:
                    nav(name)
                    if name=='apartments':choose_room()
                    check('stress/all-sections/'+name)
                # Large sum: currency stays with the number, a narrow statistic can span a row.
                charge=api('/records',body={'lease_id':f['leases']['a'],'kind':'charge','title':'Проверка большой суммы','payload':{'amount':999999999,'period':api('/state')['business_date'][:7],'due':api('/state')['business_date']}})
                api('/records/'+charge['id']+'/action',body={'version':charge['version'],'action':'record_payment','amount':999999999})
                p.close();p=newpage('dual',320);nav('home');check('stress/large-money/home');shot('stress-large-money-home')
                nav('finances');check('stress/large-money/finances');shot('stress-large-money-finances')
                nav('apartments')
                p.locator('[data-act=apartment-select][data-id="'+f['apartments']['empty']+'"]').first.click()
                for tab in ['overview','contract','meters','payments','history']:
                    p.locator('[data-tab="'+tab+'"]').click();check('archive/'+tab);shot('archive-'+tab)
                # Cover every empty cabinet plus archiving/no-data alternative.
                for who in ['emptyOwner','emptyTenant']:
                    p.close();p=newpage(who,320)
                    for colour in ['light','dark']:
                        theme(colour)
                        for name in ['home','apartments','requests','finances','documents','profile','notifications']:
                            nav(name);check(f'empty/{who}/{colour}/{name}')
                            if name in ['home','apartments']:shot(f'empty-{who}-{colour}-{name}')
                functional.append('empty account screens and long text remain in viewport')
                p.close()
                # Guide: opening counter, dismissal, restoration, independent visit detection.
                p=newpage('guideOpens');assert p.locator('[data-guide-prompt]').count()==1
                for i in range(1,5):
                    p.locator('[data-act=guide-open]').click();p.wait_for_selector('.guide-content');check(f'guide/open/{i}')
                    if i==1:shot('guide-first-open')
                    p.locator('[data-act=close-modal]').click()
                    assert p.locator('[data-guide-prompt]').count()==(0 if i==4 else 1)
                p.wait_for_timeout(100);assert api('/state','guideOpens')['user']['settings']['guide_v1']['owner']['opens']==4
                p.close();p=newpage('guideOpens');assert not p.locator('[data-guide-prompt]').count();shot('guide-after-four-home')
                nav('profile');p.locator('[data-act=help]').click();p.wait_for_selector('.guide-content');p.locator('[data-act=close-modal]').click();nav('home');assert not p.locator('[data-guide-prompt]').count()
                functional.append('guide hides on fourth opening and stays available in Profile after a new session')
                p.close();p=newpage('guideVisits')
                nav('documents');p.wait_for_timeout(1150);nav('home')
                for _ in range(3):nav('documents');p.wait_for_timeout(1050);nav('home')
                assert p.locator('[data-guide-prompt]').count()==1
                assert len(api('/state','guideVisits')['user']['settings']['guide_v1']['owner']['topics'])==1
                # A guide-assisted visit must not count as independent discovery.
                p.locator('[data-act=guide-open]').click();p.locator('[data-act=guide-go][data-page=finances]').click();p.wait_for_timeout(1150);nav('home')
                assert api('/state','guideVisits')['user']['settings']['guide_v1']['owner']['topics']==['documents']
                for name in ['apartments','finances','requests']:nav(name);p.wait_for_timeout(1150)
                nav('home');assert not p.locator('[data-guide-prompt]').count()
                functional.append('four independent distinct sections hide guide; duplicate visits and guide links do not count')
                p.close();p=newpage('guideDismiss');p.locator('[data-act=guide-dismiss]').click();assert not p.locator('[data-guide-prompt]').count();p.wait_for_timeout(150);p.close();p=newpage('guideDismiss');assert not p.locator('[data-guide-prompt]').count()
                functional.append('explicit dismissal survives a new browser session')
                p.close();browser.close()
                assert not errors,errors
                report={'geometry_checks':len(checks),'failures':0,'functional_checks':functional,'cases':checks,'screenshots':shots,'page_errors':errors,'mode':'embedded DOM + real local Node/SQLite HTTP' if args.embedded else 'native HTTP','max_live_tested':False,'webkit_tested':False,'widths':[320,390,768,1024,1440],'short_viewport_height':480}
                (out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in report.items() if k not in ['cases','screenshots']},ensure_ascii=False),flush=True)
        except Exception:
            try:p.screenshot(path=str(out/'failure.png'));print(p.locator('body').inner_text()[-2500:],flush=True)
            except Exception:pass
            raise
        finally:
            proc.terminate()
            try:proc.wait(timeout=5)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()
            log.close()
if __name__=='__main__':main()
