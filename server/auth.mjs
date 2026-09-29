import {createHmac,createHash,randomBytes,timingSafeEqual,randomUUID} from 'node:crypto';
export const hash=x=>createHash('sha256').update(x).digest('hex');
export function fail(status,message){const e=new Error(message);e.status=status;throw e;}
export function constantEqual(a,b){const aa=Buffer.from(String(a)),bb=Buffer.from(String(b));return aa.length===bb.length&&timingSafeEqual(aa,bb);}
// MAX uses WebAppData, NOT Telegram.WebApp. Compare the original decoded strings;
// never reserialize user JSON and never trust initDataUnsafe.
export function validateInitData(raw,token,{now=Math.floor(Date.now()/1000),maxAge=3600}={}) {
  if(typeof raw!=='string'||raw.length>16384||!token)fail(401,'Откройте приложение из MAX.');
  const p=new URLSearchParams(raw), seen=new Set();
  for(const [k] of p){if(seen.has(k))fail(401,'Повторяющийся параметр авторизации.');seen.add(k);}
  const received=p.get('hash')||'';
  if(!/^[a-f0-9]{64}$/i.test(received))fail(401,'Некорректная подпись MAX.');
  const data=[...p.entries()].filter(([k])=>k!=='hash').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  const expected=createHmac('sha256',secret).update(data).digest('hex');
  if(!constantEqual(expected,received.toLowerCase()))fail(401,'Не удалось подтвердить вход через MAX.');
  const date=Number(p.get('auth_date'));
  if(!Number.isSafeInteger(date)||date>now+30||now-date>maxAge)fail(401,'Сеанс запуска истёк. Переоткройте приложение в MAX.');
  let u;try{u=JSON.parse(p.get('user')||'null');}catch{fail(401,'Некорректный пользователь MAX.');}
  if(!u||!Number.isSafeInteger(u.id)||u.id<=0||typeof u.first_name!=='string')fail(401,'Некорректный пользователь MAX.');
  return {id:String(u.id),name:[u.first_name,u.last_name].filter(Boolean).join(' ').slice(0,120),startParam:p.get('start_param')||''};
}
export function ensureMaxUser(db,u){let found=db.get('SELECT * FROM users WHERE max_id=?',u.id);if(!found){const id=randomUUID();db.run('INSERT INTO users(id,max_id,name,created_at) VALUES(?,?,?,?)',id,u.id,u.name,new Date().toISOString());found=db.get('SELECT * FROM users WHERE id=?',id);}return found;}
export function createSession(db,userId){const token=randomBytes(32).toString('base64url'),expires=Date.now()+12*3600_000;db.run('INSERT INTO sessions VALUES(?,?,?,?)',hash(token),userId,expires,new Date().toISOString());return {token,expires};}
export function tokenFrom(req){const bearer=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(bearer)return bearer;const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('keys_session='));try{return cookie?decodeURIComponent(cookie.slice(13)):'';}catch{return '';} }
export function sessionUser(db,req){const t=tokenFrom(req);const u=t&&db.get('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires>?',hash(t),Date.now());if(!u)fail(401,'Сессия истекла. Войдите снова.');return u;}
export function signTicket(config,userId,fileId,expires=Date.now()+5*60_000){const body=Buffer.from(JSON.stringify({u:userId,f:fileId,e:expires})).toString('base64url');return body+'.'+createHmac('sha256',config.secret).update(body).digest('base64url');}
export function verifyTicket(config,token){if(typeof token!=='string'||token.length>2048)fail(401,'Ссылка недействительна.');const [body,sig,extra]=token.split('.');if(extra||!sig||!constantEqual(createHmac('sha256',config.secret).update(body).digest('base64url'),sig))fail(401,'Ссылка недействительна.');let d;try{d=JSON.parse(Buffer.from(body,'base64url').toString());}catch{fail(401,'Ссылка недействительна.');}if(!d||typeof d.u!=='string'||typeof d.f!=='string'||!Number.isSafeInteger(d.e)||d.e<Date.now())fail(401,'Ссылка истекла. Откройте файл ещё раз.');return d;}
