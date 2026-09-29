"""Public document visual regression. Optional about:blank test mount (not MAX).
Checks actual public HTML/CSS supplied by Node; does not edit legal text.
"""
from __future__ import annotations
import argparse, base64, json, os, re, socket, subprocess, tempfile, time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--embedded',action='store_true');ap.add_argument('--chromium');ap.add_argument('--output',default='test-results/legal');a=ap.parse_args()
    out=Path(a.output).resolve();out.mkdir(parents=True,exist_ok=True)
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    base=f'http://127.0.0.1:{port}';checks=[];errors=[]
    with tempfile.TemporaryDirectory(prefix='keys-legal-') as tmp:
        log=open(out/'server.log','w');env={**os.environ,'APP_MODE':'demo','PORT':str(port),'PUBLIC_URL':base,'HOST':'127.0.0.1','DATA_DIR':tmp,'MAX_BOT_TOKEN':''}
        proc=subprocess.Popen(['node','server/index.mjs'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        def get(p):
            with urlopen(base+p,timeout=5) as res:assert res.status==200;return res.read()
        try:
            for _ in range(100):
                try:get('/api/health');break
                except Exception:time.sleep(.05)
            with sync_playwright() as pw:
                b=pw.chromium.launch(headless=True,**({'executable_path':a.chromium} if a.chromium else {}));p=b.new_page();p.set_default_timeout(8000);p.on('pageerror',lambda e:errors.append(str(e)))
                for route,count in [('privacy',8),('terms',9)]:
                    html=get('/'+route).decode()
                    if a.embedded:
                        assets={f'/art/keys-logo-{c}.png':'data:image/png;base64,'+base64.b64encode(get(f'/art/keys-logo-{c}.png')).decode() for c in ['black','white']}
                        html=re.sub(r'<link[^>]+rel="stylesheet"[^>]*>',lambda m:'<style>'+get(re.search(r'href="([^"]+)"',m[0])[1]).decode()+'</style>',html)
                        html=re.sub(r'<script.*?</script>','',html,flags=re.S)
                        for path,data in assets.items():html=html.replace('src="'+path+'"','src="'+data+'"')
                        p.set_content(html,wait_until='domcontentloaded')
                        p.evaluate('''assets=>{
                          const store={};Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>store[k]||null,setItem:(k,v)=>store[k]=v}});
                          const src=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
                          Object.defineProperty(HTMLImageElement.prototype,'src',{...src,set(v){src.set.call(this,assets[v]||v)}});
                        }''',assets)
                        source=get('/theme.js').decode()+'\nwindow.__testSetTheme=setTheme;'
                        p.evaluate('u=>import(u)', 'data:text/javascript;base64,'+base64.b64encode(source.encode()).decode())
                        p.wait_for_function('typeof window.__testSetTheme === "function"')
                    else:
                        p.goto(base+'/'+route);p.evaluate("import('/theme.js').then(m=>window.__testSetTheme=m.setTheme)");p.wait_for_function('typeof window.__testSetTheme === "function"')
                    for theme in ['light','dark']:
                        p.evaluate('t=>window.__testSetTheme(t)',theme)
                        for width in [320,390,1440]:
                            p.set_viewport_size({'width':width,'height':900});p.wait_for_timeout(20)
                            assert p.locator('.legal section').count()==count
                            assert p.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                            assert p.locator('.legal').evaluate("e=>getComputedStyle(e).backgroundColor!=='rgba(0, 0, 0, 0)'&&parseFloat(getComputedStyle(e).borderRadius)>=20")
                            assert p.locator('.logo').evaluate('e=>e.complete&&e.naturalWidth>0')
                            assert p.locator('html').get_attribute('data-theme')==theme
                            label=f'{route}/{theme}/{width}';checks.append(label)
                            p.screenshot(path=str(out/(label.replace('/','-')+'.png')),full_page=False,animations='disabled')
                assert not errors,errors
                result={'passed':len(checks),'failed':0,'checks':checks,'page_errors':errors,'mode':'public Node HTML/CSS in embedded DOM' if a.embedded else 'native browser HTTP'}
                (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False));b.close()
        finally:proc.terminate();proc.wait(timeout=5);log.close()
if __name__=='__main__':main()
