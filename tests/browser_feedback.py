"""UI regression coverage for the supplied feedback. --embedded is test-only.
Run normal browser HTTP where browser policy permits local navigation.
"""
import argparse,json,os,socket,subprocess,tempfile,time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright
from browser_smoke import mount_embedded, ROOT

def main():
    p=argparse.ArgumentParser();p.add_argument('--embedded',action='store_true');p.add_argument('--chromium');p.add_argument('--output',default='test-results/feedback');args=p.parse_args()
    out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    base=f'http://127.0.0.1:{port}'
    groups=[];errors=[]
    with tempfile.TemporaryDirectory(prefix='keys-feedback-') as tmp:
        log=open(out/'server.log','w',encoding='utf8');env={**os.environ,'APP_MODE':'demo','HOST':'127.0.0.1','PORT':str(port),'PUBLIC_URL':base,'DATA_DIR':tmp,'MAX_BOT_TOKEN':'','TZ':'Europe/Moscow'}
        server=subprocess.Popen(['node','server/index.mjs'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                try:
                    with urlopen(base+'/api/health',timeout=1) as r:
                        if r.status==200:break
                except Exception:time.sleep(.05)
            else:raise RuntimeError('server unavailable')
            with sync_playwright() as pw:
                browser=pw.chromium.launch(headless=True,**({'executable_path':args.chromium} if args.chromium else {}))
                context=browser.new_context(viewport={'width':390,'height':844},locale='ru-RU',device_scale_factor=1)
                page=context.new_page();page.set_default_timeout(8000);page.on('pageerror',lambda e:errors.append(str(e)))
                if args.embedded:mount_embedded(page,base)
                else:page.goto(base,wait_until='domcontentloaded')
                def shot(name):page.screenshot(path=str(out/(name+'.png')),full_page=False)
                def nav(name):page.locator('.bottom-nav [data-page="'+name+'"]').click()
                def role(name):
                    page.locator('[data-act=switch-role]').first.click();page.locator('[data-role="'+name+'"]').click();page.wait_for_selector('.app-shell')
                def submit():
                    page.locator('.modal form button[type=submit]').click();page.wait_for_selector('.modal',state='detached')
                def state():return page.evaluate("async()=> (await fetch('/api/state')).json()")
                def property_image():
                    image=page.locator('main .apartment-hero > img').first
                    page.wait_for_function("()=>{const i=document.querySelector('main .apartment-hero>img');return i&&i.complete&&i.naturalWidth>1}")
                    return image
                def assert_fit(selector):
                    failures=page.locator(selector).evaluate_all('''els=>els.filter(el=>{
                      const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();
                      return r.width>0&&(r.left<p.left-1||r.right>p.right+1||r.right>innerWidth+1||r.left< -1)
                    }).map(el=>({name:el.name,rect:el.getBoundingClientRect().toJSON()}))''')
                    assert not failures,failures
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'), 'horizontal page scroll'
                page.wait_for_selector('[data-act=login]')
                page.wait_for_function('document.querySelector(".wordmark").complete')
                assert page.locator('.wordmark').evaluate('el=>el.naturalWidth')==2048
                assert page.locator('[data-act=login] img.max-logo').count()==1
                assert page.locator('[data-act=login] svg').count()==0
                shot('01-welcome')
                page.locator('[data-act=login]').click();page.locator('[data-role=owner]').click();page.wait_for_selector('.app-shell')
                groups.append('original wordmarks and MAX image assets')
                assert page.locator('.owner-intro').count()==0
                assert page.get_by_text('Хорошо, когда',exact=False).count()==0
                assert page.locator('.hero-label').count()==0
                assert page.locator('.topbar [data-page=profile]').count()==0
                assert page.locator('.topbar-spacer').count()==1
                assert page.locator('.stat-card .tile-icon.blue').count()==1
                assert page.locator('.stat-card .tile-icon.green').count()==1
                assert page.locator('.stat-card .tile-icon.neutral').count()==1
                shot('02-owner-home');groups.append('banner removed, card label removed, no fake menu, semantic stats')
                page.locator('[data-act=apartment-select]').first.click();page.wait_for_selector('[data-act=edit-apartment]')
                a=state()['apartments'][0];page.locator('[data-act=edit-apartment]').click()
                assert page.locator('.modal [name=title]').input_value()==a['title']
                assert page.locator('.modal [name=start]').count()==0, 'active lease must not be silently editable'
                new_title='Квартира у набережной'
                page.locator('.modal [name=title]').fill(new_title)
                page.locator('.modal [name=address]').fill('Москва, Космодамианская набережная, дом 4/22, корпус А')
                page.locator('.modal [name=rooms]').fill('3');page.locator('.modal [name=area]').fill('73.5')
                page.locator('.modal input[name=cover_file]').set_input_files(str(ROOT/'public/art/owner.webp'))
                page.wait_for_function('document.querySelector("[name=cover_mode]").value==="upload"')
                page.locator('.modal [name=title]').scroll_into_view_if_needed();shot('03-edit-apartment')
                before=next(x for x in state()['apartments'] if x['id']==a['id']);assert before['title']==a['title']
                submit();edited=next(x for x in state()['apartments'] if x['id']==a['id'])
                assert edited['title']==new_title;assert edited['area']==73.5;assert edited['rooms']==3;assert edited['cover_id']
                property_image();shot('04-apartment-updated');groups.append('prefilled property editing, real image upload, atomic save')
                cover_id=edited['cover_id'];page.locator('[data-act=edit-photo]').click()
                assert page.locator('.modal [name=title]').count()==0
                page.select_option('.modal [name=cover_mode]','living');page.locator('[data-act=close-modal]').click()
                assert next(x for x in state()['apartments'] if x['id']==a['id'])['cover_id']==cover_id
                nav('home');assert new_title in page.locator('main').inner_text()
                page.locator('[data-act=apartment-select]').first.click();property_image()
                groups.append('cancel does not apply changes; saved image/title persist after navigation')
                role('tenant');nav('apartments')
                assert page.locator('[data-act=edit-apartment],[data-act=edit-photo]').count()==0
                assert new_title in page.locator('main').inner_text();property_image()
                nav('home');assert page.locator('.quick.purple[data-kind=ticket]').count()==1
                assert page.locator('.quick.orange[data-kind=purchase]').count()==1
                assert page.locator('.quick.amber[data-page=meters]').count()==1
                assert page.locator('.quick.slate[data-page=documents]').count()==1
                shot('05-tenant-home')
                nav('profile');assert page.locator('.profile-links .tile-icon').count()==0
                assert page.locator('.profile-links button').count()>=5
                page.locator('.profile-links').scroll_into_view_if_needed();shot('06-profile')
                nav('documents');assert page.locator('.document-row .tile-icon:not(.slate)').count()==0
                nav('finances');assert page.locator('.record-card .tile-icon:not(.green)').count()==0
                nav('home');page.locator('[data-page=meters]').first.click()
                assert page.locator('.meter-row .tile-icon:not(.amber)').count()==0
                groups.append('tenant permissions, icon-free profile, consistent domain colours')
                role('owner');nav('apartments');page.locator('[data-act=new-apartment]').first.click()
                # Validate explicit Russian date fields on mobile and desktop.
                for width in [320,360,375,390,414,540,760,1024]:
                    page.set_viewport_size({'width':width,'height':900});assert_fit('.modal .field input,.modal .field select')
                    starts=page.locator('.modal [name=start]').bounding_box();ends=page.locator('.modal [name=end]').bounding_box()
                    if width<=600:assert ends['y']>=starts['y']+starts['height'],(width,starts,ends)
                page.set_viewport_size({'width':390,'height':844})
                page.locator('.modal [name=start]').scroll_into_view_if_needed();shot('07-dates-mobile')
                page.locator('.modal [name=title]').fill('Новая квартира — тест')
                page.locator('.modal [name=address]').fill('Тестовый адрес, дом 10')
                page.locator('.modal [name=rent]').fill('45000')
                page.locator('.modal [name=start]').fill('01.09.2026');page.locator('.modal [name=end]').fill('01.08.2026')
                page.locator('.modal button[type=submit]').click()
                page.get_by_text('Окончание аренды должно быть после начала.',exact=True).wait_for()
                page.locator('.modal [name=end]').fill('01.09.2027');submit()
                page.locator('[data-act=edit-apartment]').click()
                assert page.locator('.modal [name=start]').input_value()=='01.09.2026'
                page.locator('.modal [name=end]').fill('01.09.2028');page.locator('.modal [name=rent]').fill('46000');submit()
                data=state();created=next(x for x in data['apartments'] if x['title']=='Новая квартира — тест')
                lease=next(x for x in data['leases'] if x['apartment_id']==created['id']);assert lease['end']=='2028-09-01';assert lease['rent']==4600000
                groups.append('responsive dates 320–1024px, date validation and editing vacant-lease draft')
                nav('home');page.locator('[data-act=apartment-select]').first.click()
                page.locator('[data-act=edit-photo]').click();page.select_option('[name=cover_mode]','living');submit()
                reset=next(x for x in state()['apartments'] if x['id']==a['id']);assert reset['cover_id'] is None
                property_image();groups.append('replace/reset cover with stock illustration')
                nav('home');page.set_viewport_size({'width':1440,'height':1000});assert_fit('main .apartment-hero');shot('08-owner-desktop')
                assert not errors,errors
                result={'passed':len(groups),'failed':0,'groups':groups,'widths':[320,360,375,390,414,540,760,1024,1440],
                    'mode':'embedded DOM + real Node/SQLite HTTP bridge' if args.embedded else 'browser HTTP',
                    'page_errors':errors,'webkit_tested':False,'max_live_tested':False}
                (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False));browser.close()
        except Exception:
            try:page.screenshot(path=str(out/'failure.png'));print(page.locator('body').inner_text()[-3500:])
            except Exception:pass
            raise
        finally:
            server.terminate()
            try:server.wait(timeout=5)
            except subprocess.TimeoutExpired:server.kill();server.wait()
            log.close()
if __name__=='__main__':main()
