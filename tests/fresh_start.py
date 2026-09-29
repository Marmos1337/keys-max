"""Clean-copy launch and persistence checks (real HTTP; temporary demo data only)."""
from __future__ import annotations
import argparse, json, os, shutil, socket, sqlite3, subprocess, tempfile, time, uuid
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parents[1]
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--output',default='test-results/fresh');a=ap.parse_args();out=Path(a.output).resolve();out.mkdir(parents=True,exist_ok=True)
    checks=[];proc=None;version=json.loads((ROOT/'package.json').read_text())['version']
    with tempfile.TemporaryDirectory(prefix='keys-clean-') as td:
        root=Path(td)/'app';shutil.copytree(ROOT,root,ignore=shutil.ignore_patterns('.env','data','node_modules','__pycache__','test-results','.git','backups'))
        assert not (root/'.env').exists();checks.append('Clean source copy has no working .env')
        with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        base=f'http://127.0.0.1:{port}';data=Path(td)/'data';token=''
        env={**os.environ,'APP_MODE':'demo','HOST':'127.0.0.1','PORT':str(port),'PUBLIC_URL':base,'DATA_DIR':str(data),'MAX_BOT_TOKEN':'','TZ':'Europe/Moscow'}
        subprocess.run(['node','scripts/setup.mjs'],cwd=root,env=env,check=True,capture_output=True)
        before=(root/'.env').read_bytes();subprocess.run(['node','scripts/setup.mjs'],cwd=root,env=env,check=True,capture_output=True)
        assert before==(root/'.env').read_bytes();checks.append('Setup creates .env and does not overwrite it on repeat')
        log=open(out/'server.log','w',encoding='utf8')
        def req(path,body=None,raw=False,auth=True,expected=200):
            headers={'Origin':base,'X-Keys-Client':'miniapp','Idempotency-Key':str(uuid.uuid4())}
            if auth and token:headers['Authorization']='Bearer '+token
            if body is not None and not raw:headers['Content-Type']='application/json'
            payload=body if raw else json.dumps(body).encode() if body is not None else None
            try:res=urlopen(Request(base+path,headers=headers,data=payload,method='POST' if body is not None else 'GET'),timeout=5)
            except HTTPError as e:res=e
            buf=res.read();assert res.status==expected,(path,res.status,buf[:300])
            return json.loads(buf) if 'application/json' in res.headers.get('Content-Type','') else buf
        def start():
            nonlocal proc
            proc=subprocess.Popen(['node','--env-file=.env','server/index.mjs'],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
            for _ in range(100):
                try:req('/api/health');return
                except Exception:time.sleep(.05)
            raise RuntimeError('Server did not start')
        def stop():
            nonlocal proc
            if proc:proc.terminate();proc.wait(timeout=5);proc=None
        try:
            start();assert req('/api/health')['version']==version;assert req('/api/config')['version']==version;checks.append('Real HTTP health/config report version '+version)
            for route in ['/','/ui.js','/styles.css','/theme.js','/guide.js','/guide-state.js','/legal.css','/privacy','/terms']:
                assert req(route)
            checks.append('App modules/styles and both public document pages return 200')
            req('/api/state',auth=False,expected=401);checks.append('Private state requires authentication')
            token=req('/api/auth/demo',{'role':'owner'},auth=False)['token'];st=req('/api/state');apartment=st['apartments'][0]
            image=(root/'public/art/keys-logo-black.png').read_bytes();photo=req('/api/apartment-covers?name=qa-cover.png',image,raw=True)
            title='QA: визуальное обновление — сохранение'
            edited=req('/api/apartments/'+apartment['id'],{'version':apartment['version'],'title':title,'cover_id':photo['id']})
            assert edited['title']==title;checks.append('Actual property update and uploaded cover are stored through HTTP')
            disposable=req('/api/apartments',{'title':'QA: временная квартира','address':'Тестовый адрес, 1','rooms':2,'area':52,'start':'2026-01-01','end':'2028-12-31','rent':6500000,'deposit':0,'recurring_rent':False})
            preview=req('/api/apartments/'+disposable['id']+'/deletion-preview')
            assert preview['can_delete'] and any(x['id']==disposable['id'] for x in req('/api/state')['apartments'])
            result=req('/api/apartments/'+disposable['id']+'/delete',{'version':preview['version'],'confirmation_token':preview['confirmation_token'],'confirmed':True})
            assert result['deleted'];checks.append('Deletion preview is read-only; explicit confirmation removes a temporary property through HTTP')
            req('/api/profile/guide',{'role':'owner','progress':{'opens':4,'topics':['documents'],'dismissed':False}})
            stop();start();st=req('/api/state');assert st['user']['settings']['guide_v1']['owner']['opens']==4;checks.append('Guide progress survives server restart');after=next(x for x in st['apartments'] if x['id']==apartment['id']);assert after['title']==title and after['cover_id']==photo['id']
            assert req(after['cover_url'])==image;checks.append('Session, property and exact uploaded bytes survive restart')
            assert not any(x['id']==disposable['id'] for x in st['apartments']);checks.append('Deleted property remains absent after the real server restart')
            stop()
            db=sqlite3.connect(data/'keys.sqlite')
            tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")};assert 'leases' in tables and 'lease_members' in tables and 'recurring_rules' in tables
            # Use the actual metadata table rather than PRAGMA user_version (not used by the app).
            v=db.execute("SELECT version FROM schema_version").fetchone();assert str(v[0])=='3';db.close();checks.append('SQLite schema remains 3; rental/participant/recurrence tables intact')
            report={'passed':len(checks),'failed':0,'version':version,'mode':'clean temporary source copy + real Node HTTP / SQLite','checks':checks,'max_live_tested':False,'production_data_used':False}
            (out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(report,ensure_ascii=False))
        finally:stop();log.close()
if __name__=='__main__':main()
