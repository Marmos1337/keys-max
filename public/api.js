import {uuid} from './utils.js';
let token='';
export function setToken(t){token=t||'';}
export async function request(path,{method='GET',body,raw=false,key,signal}={}){
  const mutating=method!=='GET';const headers={...(token?{Authorization:'Bearer '+token}:{}),...(mutating?{'X-Keys-Client':'miniapp','Idempotency-Key':key||uuid()}:{}),...(body!==undefined&&!raw?{'Content-Type':'application/json'}:{})};
  let r;try{r=await fetch('/api'+path,{method,credentials:'include',headers,body:body===undefined?undefined:raw?body:JSON.stringify(body),signal:signal||AbortSignal.timeout(raw?60000:20000)});}catch(e){throw new Error(e.name==='AbortError'||e.name==='TimeoutError'?'Сервер долго не отвечает. Проверьте соединение.':'Не удалось связаться с сервером. Проверьте интернет и повторите.');}
  let data;try{data=await r.json();}catch{throw new Error('Сервер вернул неожиданный ответ.');}
  if(!r.ok){const e=new Error(data.error||'Не удалось выполнить действие.');e.status=r.status;throw e;}return data;
}
export const post=(path,body={},key)=>request(path,{method:'POST',body,key});
export async function uploadFiles(files,leaseId){if(files.length>5)throw Error('Можно прикрепить не больше 5 файлов.');const ids=[];for(const f of files){if(f.size>10*1024*1024)throw Error(`Файл ${f.name} больше 10 МБ.`);const result=await request('/files?lease_id='+encodeURIComponent(leaseId)+'&name='+encodeURIComponent(f.name),{method:'POST',body:f,raw:true});ids.push(result.id);}return ids;}
