import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
import {openDatabase} from '../server/db.mjs';
import {makeConfig} from '../server/config.mjs';
import {seedDemo} from '../server/seed.mjs';
import {createServer} from '../server/http.mjs';
import * as D from '../server/domain.mjs';
export function fixture(t,{seed=true}={}){const dir=mkdtempSync(path.join(tmpdir(),'keys-test-'));const config=makeConfig({APP_MODE:'test',DATA_DIR:dir,SESSION_SECRET:'test-secret-'.repeat(4),MAX_WEBHOOK_SECRET:'test-webhook-secret-'.repeat(2),MAX_BOT_TOKEN:'test-token',TZ:'Europe/Moscow'}),db=openDatabase(dir);if(seed)seedDemo(db,config);t.after(()=>{try{db.close();}catch{}rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});const u=id=>db.get('SELECT * FROM users WHERE id=?',id),owner=u('demo-owner'),tenant=u('demo-tenant'),other=u('demo-other');const lease=seed?db.get('SELECT * FROM leases WHERE tenant_id=?',tenant.id):null;
 const create=(kind,payload={},who=tenant,options={})=>db.tx(()=>D.createRecord(db,who,{lease_id:lease.id,title:'Тест '+kind,kind,payload,...options},config));
 const act=(id,action,who=owner,body={})=>db.tx(()=>D.actionRecord(db,who,id,{version:db.get('SELECT version FROM records WHERE id=?',id).version,action,...body}));
 return {db,config,dir,u,owner,tenant,other,lease,create,act};}
export const status=n=>e=>e.status===n;
export function signedData(token='test-token',values={}){const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:'testing',user:JSON.stringify({id:12345,first_name:'Илья',last_name:'Соколов'}),...values});const data=[...p].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n'),secret=createHmac('sha256','WebAppData').update(token).digest();p.set('hash',createHmac('sha256',secret).update(data).digest('hex'));return p.toString();}
export function newUser(db,name='Другой пользователь',role='tenant'){const id=randomUUID();db.run('INSERT INTO users(id,name,role,created_at) VALUES(?,?,?,?)',id,name,role,D.nowISO());return db.get('SELECT * FROM users WHERE id=?',id);}
export const apartmentInput={title:'Новая квартира',address:'Тестовый город, дом 1',rooms:2,area:50,start:'2026-01-01',end:'2028-12-31',rent:6000000,deposit:6000000,terms:'Демонстрационные условия',due_day:5,meter_day:25};
export async function httpFixture(t){const f=fixture(t);const server=createServer(f.db,f.config);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.publicUrl='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));let token='';
 const api=async(url,{method='GET',body,raw=false,key=randomUUID(),headers={},auth=true}={})=>{const r=await fetch(f.config.publicUrl+url,{method,headers:{...(auth&&token?{Authorization:'Bearer '+token}:{}),...(method!=='GET'?{'X-Keys-Client':'miniapp','Idempotency-Key':key}:{}),...(!raw&&body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:raw?body:JSON.stringify(body)});const ct=r.headers.get('content-type')||'';const data=ct.includes('application/json')?await r.json():await r.text();return {r,data,status:r.status};};
 const login=async(role)=>{const r=await api('/api/auth/demo',{method:'POST',body:{role},auth:false});token=r.data.token;return r;};return {...f,api,login,server,setToken:t=>token=t};}
