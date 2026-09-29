"""UI acceptance smoke against the real Node/SQLite server.
Normal: python tests/browser_smoke.py --output test-results/browser
Optional --embedded renders in about:blank and bridges fetch through Python;
use only in a sandbox whose browser policy prohibits all navigations. It does
NOT change browser policies or claim to test MAX's native WebView/network.
Requires Python 3.10+ and playwright (testing only, not app runtime).
"""
from __future__ import annotations
import argparse,base64,json,os,re,socket,subprocess,tempfile,time
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--embedded',action='store_true');parser.add_argument('--chromium');parser.add_argument('--output',default='test-results/browser');args=parser.parse_args()
    out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    base=f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='keys-browser-') as data:
        log=open(out/'server.log','w',encoding='utf8')
        env={**os.environ,'APP_MODE':'demo','PORT':str(port),'HOST':'127.0.0.1','PUBLIC_URL':base,'DATA_DIR':data,'MAX_BOT_TOKEN':'','TZ':'Europe/Moscow'}
        server=subprocess.Popen(['node','server/index.mjs'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                try:
                    with urlopen(base+'/api/health',timeout=1) as r:
                        if r.status==200:break
                except Exception:time.sleep(.05)
            else:raise RuntimeError('Node server did not start')
            with sync_playwright() as p:
                browser=p.chromium.launch(headless=True,**({'executable_path':args.chromium} if args.chromium else {}),args=['--no-sandbox'] if args.embedded else [])
                page=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1)
                page.set_default_timeout(8000);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                if args.embedded:mount_embedded(page,base)
                else:page.goto(base,wait_until='domcontentloaded')
                def wait_app():page.wait_for_selector('.app-shell')
                def shot(name):page.screenshot(path=str(out/(name+'.png')),full_page=True)
                def nav(name):page.locator('.bottom-nav [data-page="'+name+'"]').click()
                def role(name):
                    page.locator('[data-act=switch-role]').first.click();page.locator('[data-role="'+name+'"]').click();wait_app()
                def form_submit():page.locator('.modal form button[type=submit]').click();page.wait_for_selector('.modal',state='detached')
                def action(name,note=None):
                    page.locator('[data-act=record-action][data-action="'+name+'"]').click()
                    if note is not None:page.locator('.modal textarea[name=note]').fill(note)
                    form_submit()
                def open_record(title):page.get_by_text(title,exact=True).first.click();page.wait_for_selector('.detail-body')
                def open_visits():
                    nav('apartments')
                    if not page.locator('[data-page=visits]').count():page.locator('[data-act=apartment-select]').first.click()
                    page.locator('[data-page=visits]').first.click()
                def title_is(title):assert page.locator('h1').inner_text()==title
                page.wait_for_selector('[data-act=login]');shot('01-welcome');page.click('[data-act=login]');shot('02-role');page.click('[data-role=tenant]');wait_app();title_is('Привет, Илья!');shot('03-tenant-home')
                # 1. Tenant creates issue, writes a comment.
                page.locator('[data-act=new-record][data-kind=ticket]').first.click();page.fill('.modal [name=title]','QA — протекает кран');page.fill('.modal [name=description]','Проверяем полный сценарий ремонта.');form_submit();title_is('QA — протекает кран');shot('04-ticket-detail')
                page.fill('[data-form=comment] textarea[name=text]','Буду дома после 18:00.');page.locator('[data-form=comment] button[type=submit]').click();page.get_by_text('Буду дома после 18:00.',exact=True).wait_for()
                # 2. Owner processes issue; tenant confirms.
                role('owner');shot('05-owner-home');nav('requests');open_record('QA — протекает кран');action('start');action('resolve','Заменена прокладка, проверено.');role('tenant');nav('requests');open_record('QA — протекает кран');action('confirm');assert page.locator('.badge').first.inner_text()=='Решена'
                # 3. Purchase with a real file, approval, reimbursement.
                nav('home');page.locator('[data-kind=purchase]').first.click();page.fill('.modal [name=title]','QA — покупка');page.fill('.modal [name=amount]','1499,50');page.fill('.modal [name=description]','Проверка покупки и чека.');page.locator('.modal input[type=file]').set_input_files({'name':'receipt.txt','mimeType':'text/plain','buffer':b'TEST RECEIPT - NOT A REAL RECEIPT'});form_submit();title_is('QA — покупка');page.get_by_text('receipt.txt',exact=True).wait_for();shot('06-purchase')
                role('owner');page.get_by_text('QA — покупка',exact=True).first.click();page.wait_for_selector('.detail-body');action('approve');action('compensate','Компенсация отмечена для теста.');assert page.locator('.badge').first.inner_text()=='Компенсировано'
                # 4. Readings retain exact decimal precision.
                role('tenant');nav('home');page.locator('[data-page=meters]').first.click();shot('07-meters');inputs=page.locator('[data-form=readings] input[inputmode=decimal]');assert inputs.count()==4
                for i,v in enumerate(['150,125','92','1268','692']):inputs.nth(i).fill(v)
                page.locator('[data-form=readings] button[type=submit]').click();page.wait_for_selector('.detail-body');assert '150,125' in page.locator('body').inner_text()
                # 5. Tenant records an actual-payment claim; owner separately confirms.
                nav('finances');shot('08-payments');page.locator('.records-list [data-act=open-record]').first.click();page.wait_for_selector('.detail-body');charge_title=page.locator('h1').inner_text();page.locator('[data-act=record-action][data-action=claim]').first.click();page.fill('.modal [name=amount]','65000');form_submit();assert 'подтвержден' in page.locator('body').inner_text().lower() or 'подтверждения' in page.locator('body').inner_text().lower()
                role('owner');nav('finances');open_record(charge_title);page.locator('[data-act=record-action][data-action=confirm]').first.click();form_submit()
                # 6. Owner proposes visit; tenant counterproposes; owner accepts.
                open_visits();page.locator('[data-kind=visit]').first.click();page.fill('.modal [name=reason]','QA — проверка посещения');form_submit();title_is('Посещение собственника')
                role('tenant');open_visits();page.get_by_text('QA — проверка посещения',exact=False).first.click();page.wait_for_selector('.detail-body');action('counter');shot('09-visit')
                role('owner');open_visits();page.get_by_text('QA — проверка посещения',exact=False).first.click();page.wait_for_selector('.detail-body');action('accept');assert page.locator('.badge').first.inner_text()=='Согласовано'
                # 7. Document listing/prepared download, profile and notifications.
                role('tenant');nav('documents');shot('10-documents');page.locator('.document-row').first.click();page.wait_for_selector('.detail-body');page.locator('[data-act=file]').first.click();page.get_by_text('Файл готов',exact=True).wait_for();page.click('[data-act=close-modal]');nav('profile');shot('11-profile');page.fill('[name=name]','Илья Проверка');page.locator('[data-form=profile] button[type=submit]').click();page.wait_for_timeout(150);nav('home');title_is('Привет, Илья!');page.locator('[data-page=notifications]').first.click();page.locator('[data-act=read-notifications]').first.click()
                # 8. Multi-apartment desktop layout + smallest mobile viewport.
                role('owner');page.set_viewport_size({'width':1440,'height':1000});shot('12-owner-desktop');page.set_viewport_size({'width':360,'height':800});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                assert not errors,errors
                summary={'passed':8,'failed':0,'groups':['repair workflow and comments','purchase with receipt/approval/compensation','meter submission','payment claim and owner confirmation','visit counterproposal and agreement','documents','profile/notifications','mobile+desktop layouts'],'mode':'embedded DOM + real HTTP bridge' if args.embedded else 'native browser HTTP','page_errors':errors,'max_live_tested':False}
                (out/'result.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(summary,ensure_ascii=False),flush=True);browser.close()
        except Exception:
            try:page.screenshot(path=str(out/'failure.png'),full_page=True);print(page.locator('body').inner_text()[-2500:],flush=True)
            except Exception:pass
            raise
        finally:
            server.terminate()
            try:server.wait(timeout=5)
            except subprocess.TimeoutExpired:server.kill();server.wait()
            log.close()

def mount_embedded(page,base,initial_token=None):
    """Test-only DOM mount. Keeps browser navigation policy unchanged.
    Python bridges real localhost HTTP and supplies local images as data URLs.
    Does not exercise browser networking, cookies, CSP or MAX WebView itself.
    """
    public=ROOT/'public'
    assets={f'/art/{x.name}':f'data:image/{"png" if x.suffix==".png" else "webp"};base64,'+base64.b64encode(x.read_bytes()).decode() for x in (public/'art').iterdir() if x.is_file()}
    cache={}
    def module(name):
        if name in cache:return cache[name]
        source=(public/name).read_text(encoding='utf8')
        source=re.sub(r"from '(\./[^']+)'",lambda m:"from '"+module(m.group(1)[2:])+"'",source)
        cache[name]='data:text/javascript;base64,'+base64.b64encode(source.encode()).decode()
        return cache[name]
    cookie=''
    def bridge(args):
        nonlocal cookie
        headers=dict(args.get('headers',{}));headers['Origin']=base
        if initial_token:headers.setdefault('Authorization','Bearer '+initial_token)
        if cookie:headers['Cookie']=cookie
        data=args.get('body');data=base64.b64decode(data) if args.get('binary') else data.encode() if data is not None else None
        relative=args['url']
        if relative.startswith(base):relative=relative[len(base):]
        if not relative.startswith('/api/'):raise ValueError('Test bridge only supports local /api/ paths')
        req=Request(base+relative,headers=headers,data=data,method=args.get('method','GET'))
        try:r=urlopen(req,timeout=15)
        except HTTPError as e:r=e
        if r.headers.get('Set-Cookie'):cookie=r.headers['Set-Cookie'].split(';')[0]
        mime=r.headers.get('Content-Type','application/octet-stream');body=r.read()
        binary=mime.startswith('image/')
        return {'status':r.status,'body':base64.b64encode(body).decode() if binary else body.decode('utf8'),'mime':mime,'binary':binary}
    page.expose_function('__localHTTP',bridge)
    css=(public/'styles.css').read_text(encoding='utf8')
    for k,v in assets.items():css=css.replace("url('"+k+"')","url('"+v+"')")
    page.set_content('<html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body><div id="root"></div><div id="modal-root"></div><div id="toast-root"></div></body></html>')
    page.evaluate(r'''assets=>{
      const store={}; Object.defineProperty(window,'localStorage',{value:{getItem:k=>store[k]||null,setItem:(k,v)=>store[k]=v}});
      history.pushState=()=>{}; history.replaceState=()=>{};
      window.fetch=async(url,options={})=>{
        let body=options.body,binary=false;
        if(body instanceof Blob){body=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(body)});binary=true;}
        const r=await window.__localHTTP({url,method:options.method||'GET',headers:options.headers||{},body,binary});
        return {ok:r.status>=200&&r.status<300,status:r.status,json:async()=>JSON.parse(r.body)};
      };
      const src=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
      function loadImage(img,value){
        if(assets[value])return src.set.call(img,assets[value]);
        if(value.startsWith('/api/apartment-covers/')){
          img.dataset.testCoverSource=value;
          window.__localHTTP({url:value,method:'GET'}).then(r=>{
            if(img.dataset.testCoverSource!==value)return;
            if(r.status===200)src.set.call(img,'data:'+r.mime+';base64,'+r.body);
            else img.dispatchEvent(new Event('error'));
          });return;
        }
        src.set.call(img,value);
      }
      Object.defineProperty(HTMLImageElement.prototype,'src',{...src,set(value){loadImage(this,String(value))}});
      const html=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
      Object.defineProperty(Element.prototype,'innerHTML',{...html,set(value){
        const content=String(value).replace(/src="([^"]+)"/g,(m,p)=>assets[p]?'src="'+assets[p]+'"':p.startsWith('/api/apartment-covers/')?'data-local-cover="'+p+'"':m);
        html.set.call(this,content);
        this.querySelectorAll('img[data-local-cover]').forEach(img=>{const p=img.dataset.localCover;delete img.dataset.localCover;loadImage(img,p)});
      }});
    }''',assets)
    page.add_script_tag(type='module',content="import '"+module('app.js')+"';")

if __name__=='__main__':main()
