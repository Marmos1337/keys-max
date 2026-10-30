import {createHmac,createHash,randomBytes,timingSafeEqual,randomUUID} from 'node:crypto';
export const hash=x=>createHash('sha256').update(x).digest('hex');
export function fail(status,message){const e=new Error(message);e.status=status;throw e;}
export function constantEqual(a,b){const aa=Buffer.from(String(a)),bb=Buffer.from(String(b));return aa.length===bb.length&&timingSafeEqual(aa,bb);}
// MAX and Telegram sign launch data with the same scheme: secret = HMAC_SHA256(key "WebAppData", bot token),
// hash = HMAC_SHA256(secret, sorted "key=value" lines without hash). Compare the original decoded strings;
// never reserialize user JSON and never trust initDataUnsafe.
const PLATFORM_TEXT={
  max:{open:'Откройте приложение из MAX.',sign:'Некорректная подпись MAX.',verify:'Не удалось подтвердить вход через MAX.',expired:'Сеанс запуска истёк. Переоткройте приложение в MAX.',user:'Некорректный пользователь MAX.'},
  telegram:{open:'Откройте приложение из Telegram.',sign:'Некорректная подпись Telegram.',verify:'Не удалось подтвердить вход через Telegram.',expired:'Сеанс запуска истёк. Переоткройте приложение в Telegram.',user:'Некорректный пользователь Telegram.'}
};
export function validateInitData(raw,token,{now=Math.floor(Date.now()/1000),maxAge=3600,platform='max'}={}) {
  const t=PLATFORM_TEXT[platform]||PLATFORM_TEXT.max;
  if(typeof raw!=='string'||raw.length>16384||!token)fail(401,t.open);
  const p=new URLSearchParams(raw), seen=new Set();
  for(const [k] of p){if(seen.has(k))fail(401,'Повторяющийся параметр авторизации.');seen.add(k);}
  const received=p.get('hash')||'';
  if(!/^[a-f0-9]{64}$/i.test(received))fail(401,t.sign);
  const data=[...p.entries()].filter(([k])=>k!=='hash').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  const expected=createHmac('sha256',secret).update(data).digest('hex');
  if(!constantEqual(expected,received.toLowerCase()))fail(401,t.verify);
  const date=Number(p.get('auth_date'));
  if(!Number.isSafeInteger(date)||date>now+30||now-date>maxAge)fail(401,t.expired);
  let u;try{u=JSON.parse(p.get('user')||'null');}catch{fail(401,t.user);}
  if(!u||!Number.isSafeInteger(u.id)||u.id<=0||typeof u.first_name!=='string'||u.is_bot===true)fail(401,t.user);
  const out={id:String(u.id),name:[u.first_name,u.last_name].filter(Boolean).join(' ').slice(0,120)||'Пользователь',startParam:p.get('start_param')||''};
  const handle=cleanHandle(u.username);if(handle)out.handle=handle;
  if(platform==='telegram')out.allowsWrite=u.allows_write_to_pm===true;
  return out;
}
// Messenger @username without the @: letters, digits and underscores only, else nothing.
export const cleanHandle=v=>typeof v==='string'&&/^@?[A-Za-z0-9_]{3,64}$/.test(v.trim())?v.trim().replace(/^@/,''):null;
const PLACEHOLDER_NAMES=['Пользователь','Пользователь MAX','Пользователь Telegram'];
// Name and @handle follow the messenger at every login, unless the person renamed themselves in the profile.
function refreshIdentity(db,found,u){
  const handle=cleanHandle(u.handle),custom=!!JSON.parse(found.settings||'{}').name_custom;
  const name=!custom&&typeof u.name==='string'&&u.name.trim()&&!PLACEHOLDER_NAMES.includes(u.name.trim())?u.name.trim().slice(0,120):found.name;
  if(handle===(found.handle??null)&&name===found.name)return found;
  db.run('UPDATE users SET name=?,handle=? WHERE id=?',name,handle,found.id);
  return db.get('SELECT * FROM users WHERE id=?',found.id);
}
export function ensureMaxUser(db,u){let found=db.get('SELECT * FROM users WHERE max_id=?',u.id);if(!found){const id=randomUUID();db.run('INSERT INTO users(id,max_id,name,handle,created_at) VALUES(?,?,?,?,?)',id,u.id,u.name,cleanHandle(u.handle),new Date().toISOString());found=db.get('SELECT * FROM users WHERE id=?',id);}return refreshIdentity(db,found,u);}
export function ensureTelegramUser(db,u){
  let found=db.get('SELECT * FROM users WHERE tg_id=?',u.id);
  if(!found){const id=randomUUID();db.run('INSERT INTO users(id,tg_id,name,handle,created_at) VALUES(?,?,?,?,?)',id,u.id,u.name||'Пользователь Telegram',cleanHandle(u.handle),new Date().toISOString());found=db.get('SELECT * FROM users WHERE id=?',id);}
  else found=refreshIdentity(db,found,u);
  if(u.allowsWrite&&!found.tg_bot_enabled){db.run('UPDATE users SET tg_bot_enabled=1 WHERE id=?',found.id);found=db.get('SELECT * FROM users WHERE id=?',found.id);}
  return found;
}
export function createSession(db,userId){const token=randomBytes(32).toString('base64url'),expires=Date.now()+12*3600_000;db.run('INSERT INTO sessions VALUES(?,?,?,?)',hash(token),userId,expires,new Date().toISOString());return {token,expires};}
export function tokenFrom(req){const bearer=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(bearer)return bearer;const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('keys_session='));try{return cookie?decodeURIComponent(cookie.slice(13)):'';}catch{return '';} }
export function sessionUser(db,req){const t=tokenFrom(req);const u=t&&db.get('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires>?',hash(t),Date.now());if(!u)fail(401,'Сессия истекла. Войдите снова.');return u;}
export function signTicket(config,userId,fileId,expires=Date.now()+5*60_000){const body=Buffer.from(JSON.stringify({u:userId,f:fileId,e:expires})).toString('base64url');return body+'.'+createHmac('sha256',config.secret).update(body).digest('base64url');}
export function verifyTicket(config,token){if(typeof token!=='string'||token.length>2048)fail(401,'Ссылка недействительна.');const [body,sig,extra]=token.split('.');if(extra||!sig||!constantEqual(createHmac('sha256',config.secret).update(body).digest('base64url'),sig))fail(401,'Ссылка недействительна.');let d;try{d=JSON.parse(Buffer.from(body,'base64url').toString());}catch{fail(401,'Ссылка недействительна.');}if(!d||typeof d.u!=='string'||typeof d.f!=='string'||!Number.isSafeInteger(d.e)||d.e<Date.now())fail(401,'Ссылка истекла. Откройте файл ещё раз.');return d;}
