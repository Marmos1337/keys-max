import {createHash,randomUUID} from 'node:crypto';
import {ensureMaxUser,ensureTelegramUser} from './auth.mjs';
import {previewAccountLink,claimAccountLink,PLATFORMS} from './links.mjs';
import {tgRequest,toTelegram,telegramAppUrl,normalizeTelegramUpdate,parseCommand} from './telegram.mjs';
import {actionRecord,recordAccess,leaseAccess,apartmentAccess,previewInvite,joinInvite,settings,nowISO,voterId,sameSide} from './domain.mjs';
import {previewOwnerInvite,joinOwnerInvite} from './owners.mjs';
const root=c=>(c.deepLinkBase||'https://max.ru').replace(/\/$/,'');
export function deepLink(c,payload='',channel='max') {
  if(channel==='telegram') return telegramAppUrl(c,payload);
  if(c.botUsername) return `${root(c)}/${encodeURIComponent(c.botUsername)}?startapp=${encodeURIComponent(payload)}`;
  if(payload.startsWith('r_')||payload.startsWith('c_')) return c.publicUrl+'/app/record/'+encodeURIComponent(payload.slice(2));
  return c.publicUrl;
}
export function botLink(c,payload='') {
  return c.botUsername?`${root(c)}/${encodeURIComponent(c.botUsername)}${payload?'?start='+encodeURIComponent(payload):''}`:c.publicUrl+(payload.startsWith('join_')?'?invite='+encodeURIComponent(payload.slice(5)):payload.startsWith('own_')?'?startapp='+encodeURIComponent(payload):'');
}
export async function maxRequest(config,method,route,body) {
  const r=await fetch(config.apiBase+route,{method,headers:{Authorization:config.botToken,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12_000)});
  let result;try{result=await r.json();}catch{throw Error(`MAX returned HTTP ${r.status}`);}
  if(!r.ok||result.success===false){const e=new Error(`MAX HTTP ${r.status}: ${String(result.code||result.message||'request failed').slice(0,150)}`);e.status=r.status;throw e;}
  return result;
}
const html=v=>String(v??'').replace(/[&<>]/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[x]));
function limitedHtml(value,max) {
  let out='';for(const char of String(value??'')){const next=html(char);if(out.length+next.length>max-1)return out+'…';out+=next;}return out;
}
const link=(text,url)=>({type:'link',text,url});
export function makeMessage(db,config,userId,b) {
  const u=db.get('SELECT * FROM users WHERE id=?',userId);
  let title=b.title||'Ключи',text=b.text||'',target=b.target||'',cta=b.cta||'Открыть Ключи',buttons=[];
  const channel=b.channel||'max',open=payload=>deepLink(config,payload,channel);
  if(b.linkCode) {
    buttons=[[{type:'callback',text:'Подключить',payload:'link|'+b.linkCode}]];
    return {format:'html',text:`<b>${limitedHtml(title,650)}</b>\n\n${limitedHtml(text,3200)}`,attachments:[{type:'inline_keyboard',payload:{buttons}}]};
  }
  if(b.inviteCode) {
    try {
      previewInvite(db,u,b.inviteCode);
      buttons=[[{type:'callback',text:'Принять приглашение',payload:'join|'+b.inviteCode}]];
      return {format:'html',text:`<b>${limitedHtml(title,650)}</b>\n\n${limitedHtml(text,3200)}`,attachments:[{type:'inline_keyboard',payload:{buttons}}]};
    } catch(e) {
      if(e.reason==='member'&&e.lease_id){title='Вы уже в этой аренде';text='Приглашение принято раньше. Всё по квартире — в Ключах.';target='j_'+e.lease_id;}
      else {title='Приглашение недоступно';text=e.status?e.message:'Оно уже принято, отозвано или истекло. Новое приглашение можно получить у собственника.';}
    }
  }
  if(b.ownerInviteCode) {
    try {
      previewOwnerInvite(db,u,b.ownerInviteCode);
      buttons=[[{type:'callback',text:'Стать совладельцем',payload:'own|'+b.ownerInviteCode}]];
      return {format:'html',text:`<b>${limitedHtml(title,650)}</b>\n\n${limitedHtml(text,3200)}`,attachments:[{type:'inline_keyboard',payload:{buttons}}]};
    } catch(e) {
      if(e.reason==='member'&&e.apartment_id){title='Вы уже совладелец';text='Квартира уже есть в ваших Ключах.';target='a_'+e.apartment_id;}
      else {title='Приглашение недоступно';text=e.status?e.message:'Ссылка больше не действует. Попросите у владельца новую.';}
    }
  }
  if(b.recordId) {
    try {
      const {record:r,owner,apartment}=recordAccess(db,u,b.recordId);
      target=(b.discussion?'c_':'r_')+r.id;
      cta=b.discussion?'Ответить в обсуждении':({ticket:'Открыть заявку',charge:owner?'Проверить платёж':'Открыть платёж',visit:'Согласовать посещение',reading:'Посмотреть показания',purchase:'Открыть покупку',document:'Открыть документ',terms:'Посмотреть условия',termination:'Обсудить завершение'})[r.kind]||'Открыть запись';
      const accepted=r.payload.accepted_by||[],required=r.payload.required_approvals;
      const voter=voterId(db,apartment,u.id);
      if(r.kind==='visit'&&['proposed','counter'].includes(r.status)&&!sameSide(db,apartment,r.payload.proposer,u.id)&&!accepted.includes(voter)&&(!required||required.includes(voter))) {
        buttons.push([{type:'callback',text:'Подтвердить время',payload:`visit|${r.id}|${r.version}|accept`},link('Предложить другое',open('r_'+r.id))]);
      }
    } catch { title='Событие в Ключах';text='Доступ к этой записи изменился. Проверьте доступные вам аренды.';target='';cta='Открыть Ключи'; }
  }
  if(target.startsWith('a_')) {
    try {apartmentAccess(db,u,target.slice(2));cta='Открыть квартиру';}
    catch {target='';text='Доступ к квартире изменился.';}
  }
  if(target.startsWith('l_')||target.startsWith('m_')||target.startsWith('j_')) {
    try {leaseAccess(db,u,target.slice(2));cta=target.startsWith('m_')?'Открыть счётчики':target.startsWith('j_')?'Открыть Ключи':'Открыть аренду';}
    catch {target='';text='Доступ к аренде изменился.';}
  }
  buttons.push([link(cta,open(target))]);
  return {format:'html',text:`<b>${limitedHtml(title,650)}</b>\n\n${limitedHtml(text,3200)}`,attachments:[{type:'inline_keyboard',payload:{buttons}}]};
}
export function enqueueUpdate(db,body) {
  const serialized=JSON.stringify(body),key=body.callback?.callback_id?`cb:${body.callback.callback_id}`:body.update_type==='message_created'&&body.message?.body?.mid?`msg:${body.message.body.mid}`:createHash('sha256').update(serialized).digest('hex');
  db.run('INSERT OR IGNORE INTO webhook_inbox(id,body,created_at) VALUES(?,?,?)',key,serialized,nowISO());return key;
}
function reply(db,userId,title,text,answerId,extra={},channel='max') {
  db.run('INSERT INTO outbox(id,user_id,body,created_at) VALUES(?,?,?,?)',randomUUID(),userId,JSON.stringify({title,text,answerId,...extra,...(channel==='max'?{}:{channel})}),nowISO());
}
const rub=v=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:0}).format(v/100);
function inviteReply(db,u,code,channel='max',config={}) {
  try {
    const {apartment,unit,owner,lease}=previewInvite(db,u,code,{track:true});
    const legal=config.termsUrl&&config.privacyUrl?`\n\nНажимая «Принять приглашение», вы соглашаетесь с условиями (${config.termsUrl}) и политикой конфиденциальности (${config.privacyUrl}).`:'';
    reply(db,u.id,'Вас приглашают в Ключи',`${owner} приглашает вас в аренду:\n${apartment.title} · ${unit}\nПлата за весь объект: ${rub(lease.rent)} в месяц.\n\nПосле подтверждения здесь, в Ключах, будут платежи, показания счётчиков, заявки и документы этой квартиры. Если жильцов несколько, у каждого своя ссылка, а плата общая.\n\nПринимайте, только если знаете отправителя.${legal}`,null,{inviteCode:code},channel);
  } catch(e) {
    if(!e.status)throw e;
    if(e.reason==='member') reply(db,u.id,'Вы уже в этой аренде','Приглашение принято раньше. Откройте Ключи — квартира уже там.',null,{target:'j_'+e.lease_id},channel);
    else if(e.reason==='own') reply(db,u.id,'Это ваша ссылка',e.message+'\n\nОтправить её можно в Ключах: Квартира → Жильцы → «Поделиться».',null,{},channel);
    else reply(db,u.id,'Ссылка не сработала',e.message,null,{},channel);
  }
}
function callbackAction(db,fn) {
  db.exec('SAVEPOINT callback_action');
  try {const result=fn();db.exec('RELEASE callback_action');return result;}
  catch(e) {db.exec('ROLLBACK TO callback_action; RELEASE callback_action');throw e;}
}
const setBot=(db,u,channel,on)=>db.run(`UPDATE users SET ${PLATFORMS[channel].bot}=? WHERE id=?`,on?1:0,u.id);
function welcomeReply(db,u,channel) {
  const tenant=db.get("SELECT l.id FROM lease_members lm JOIN leases l ON l.id=lm.lease_id WHERE lm.user_id=? AND l.status!='ended' ORDER BY lm.joined_at DESC LIMIT 1",u.id);
  const owner=db.get('SELECT 1 FROM apartment_members WHERE user_id=?',u.id);
  const text=tenant||owner?'Платежи, показания счётчиков, заявки и документы — в одном месте. Уведомления о новых событиях приходят сюда.\n\n/help — помощь':'Платежи, показания счётчиков, заявки и документы по квартире — в одном месте, для собственника и жильцов.\n\nЖилец? Откройте ссылку-приглашение от собственника: бот покажет квартиру и попросит подтвердить.\nСобственник? Откройте Ключи, добавьте квартиру и отправьте жильцам ссылки.\n\n/help — помощь';
  reply(db,u.id,'Ключи — аренда без хаоса',text,null,tenant&&!owner?{target:'j_'+tenant.id}:{},channel);
}
function linkReply(db,u,code,channel) {
  const name=PLATFORMS[channel].name;
  try {
    const p=previewAccountLink(db,code,channel,u[PLATFORMS[channel].column]);
    if(p.already) reply(db,u.id,'Уже подключено',`Этот ${name} уже привязан к аккаунту «${p.name}».`,null,{},channel);
    else reply(db,u.id,`Подключить ${name}?`,`Код из профиля Ключей привяжет этот ${name} к аккаунту «${p.name}». Квартиры, аренды и история станут доступны здесь.\n\nПодтверждайте, только если код получили вы сами.`,null,{linkCode:code.toUpperCase().replace(/-/g,'')},channel);
  } catch(e) {if(!e.status)throw e;reply(db,u.id,'Не удалось подключить',e.message,null,{},channel);}
}
function ownerInviteReply(db,u,code,channel='max',config={}) {
  try {
    const {apartment,inviter,owners}=previewOwnerInvite(db,u,code,{track:true});
    const legal=config.termsUrl&&config.privacyUrl?`\n\nНажимая «Стать совладельцем», вы соглашаетесь с условиями (${config.termsUrl}) и политикой конфиденциальности (${config.privacyUrl}).`:'';
    reply(db,u.id,'Приглашение стать совладельцем',`${inviter} приглашает вас вести квартиру вместе:\n${apartment.title}\nСобственники сейчас: ${owners.join(', ')}.\n\nСовладелец видит и меняет всё по этой квартире: аренду, жильцов, счётчики, платежи и заявки. Уведомления будут приходить и вам. Принимайте, только если знаете отправителя.${legal}`,null,{ownerInviteCode:code},channel);
  } catch(e) {
    if(!e.status)throw e;
    if(e.reason==='member') reply(db,u.id,'Вы уже совладелец','Квартира уже есть в ваших Ключах.',null,{target:'a_'+e.apartment_id},channel);
    else if(e.reason==='own') reply(db,u.id,'Это ваша ссылка',e.message+'\n\nОтправить её можно в Ключах: Квартира → Совладельцы.',null,{},channel);
    else reply(db,u.id,'Ссылка не сработала',e.message,null,{},channel);
  }
}
function startPayload(db,u,payload,channel,config) {
  if(payload.startsWith('own_')) ownerInviteReply(db,u,payload.slice(4),channel,config);
  else if(payload.startsWith('join_')) inviteReply(db,u,payload.slice(5),channel,config);
  else if(payload.startsWith('link_')) linkReply(db,u,payload.slice(5),channel);
  else welcomeReply(db,u,channel);
}
function callbackReply(db,u,data,answerId,channel) {
  const parts=String(data||'').split('|');
  let answer='Откройте приложение для этого действия.',title='Ключи',extra={},recipient=u.id;
  try {
    if(parts.length===2&&parts[0]==='join') {
      try {
        const joined=callbackAction(db,()=>joinInvite(db,u,parts[1]));
        setBot(db,u,channel,true);
        const apt=db.get('SELECT a.title,o.name FROM apartments a JOIN users o ON o.id=a.owner_id WHERE a.id=?',joined.apartment_id);
        answer=`Вы в аренде «${apt.title}». ${apt.name} получит уведомление.\n\nОткройте Ключи: там платежи, счётчики и заявки по квартире. Уведомления будут приходить в этот чат.`;title='Готово, приглашение принято';extra.target='j_'+joined.lease_id;
      } catch(e) {
        if(e.reason!=='member') throw e;
        answer='Приглашение уже принято. Квартира — в Ключах.';title='Вы уже в этой аренде';extra.target='j_'+e.lease_id;
      }
    } else if(parts.length===2&&parts[0]==='own') {
      try {
        const joined=callbackAction(db,()=>joinOwnerInvite(db,u,parts[1]));
        setBot(db,u,channel,true);
        const apt=db.get('SELECT title FROM apartments WHERE id=?',joined.apartment_id);
        answer=`Вы совладелец «${apt.title}». Откройте Ключи: квартира уже в разделе «Квартиры», уведомления будут приходить сюда.`;title='Готово, вы совладелец';extra.target='a_'+joined.apartment_id;
      } catch(e) {
        if(e.reason!=='member') throw e;
        answer='Вы уже совладелец этой квартиры.';title='Вы уже совладелец';extra.target='a_'+e.apartment_id;
      }
    } else if(parts.length===4&&parts[0]==='visit'&&parts[3]==='accept') {
      const result=callbackAction(db,()=>actionRecord(db,u,parts[1],{action:'accept',version:Number(parts[2])}));
      answer=result.status==='accepted'?'Время посещения подтверждено всеми участниками.':'Ваш ответ сохранён. Ждём остальных участников.';title='Посещение';extra.recordId=result.id;
    } else if(parts.length===2&&parts[0]==='link') {
      // The placeholder account of this messenger user hands its identity to the code owner,
      // so the confirmation goes to the linked account.
      const linked=callbackAction(db,()=>claimAccountLink(db,parts[1],channel,u[PLATFORMS[channel].column],{botEnabled:true}));
      recipient=linked.id;title='Аккаунт подключён';
      answer=`${PLATFORMS[channel].name} подключён к аккаунту «${linked.name}». Откройте Ключи — квартиры и аренды уже здесь.`;
    }
  } catch(e) {if(!e.status)throw e;answer=e.message;}
  reply(db,recipient,title,answer,answerId,extra,channel);
}
function textReply(db,u,raw,channel,config={}) {
  const cmd=parseCommand(raw);
  if(cmd?.command==='/start'&&/^(join|link|own)_[A-Za-z0-9_-]{1,100}$/.test(cmd.arg)) return startPayload(db,u,cmd.arg,channel,config);
  if(cmd?.command==='/start'&&!cmd.arg&&channel==='telegram') return welcomeReply(db,u,channel);
  const command=cmd&&!cmd.arg?cmd.command:'';
  if(command==='/stop') {const s=settings(u);s.bot=false;db.run('UPDATE users SET settings=? WHERE id=?',JSON.stringify(s),u.id);reply(db,u.id,'Уведомления выключены','Включить снова: /notifications. История остаётся в приложении.',null,{},channel);}
  else if(command==='/notifications') {const s=settings(u);s.bot=true;db.run('UPDATE users SET settings=? WHERE id=?',JSON.stringify(s),u.id);reply(db,u.id,'Уведомления включены','Настройте события и напоминания в профиле приложения.',null,{},channel);}
  else if(command==='/help') reply(db,u.id,'Помощь','Собственник отправляет персональную ссылку. Откройте её в боте и подтвердите присоединение.\n\n/start — приложение\n/notifications — включить уведомления\n/stop — выключить уведомления\n\nПлатежи совершаются вне приложения. Ключи не заменяет экстренные службы.',null,{},channel);
  else reply(db,u.id,'Ваши дела в Ключах','Чтобы сообщение не потерялось, создайте заявку или комментарий в карточке своей аренды.',null,{},channel);
}
function processMaxUpdate(db,row,b,config) {
  const source=b.callback?.user||b.message?.sender||b.user;
  const chatType=b.message?.recipient?.chat_type;
  if(!source||!Number.isSafeInteger(source.user_id)||source.user_id<=0||source.is_bot||b.is_channel||
    (b.update_type==='message_created'&&chatType!=='dialog')||(b.update_type==='message_callback'&&chatType&&chatType!=='dialog')) {
      db.run("UPDATE webhook_inbox SET status='ignored' WHERE id=?",row.id);return;
  }
  const u=ensureMaxUser(db,{id:String(source.user_id),name:[source.first_name,source.last_name].filter(Boolean).join(' ')||source.name||'Пользователь MAX'});
  if(['bot_stopped','dialog_removed'].includes(b.update_type)) setBot(db,u,'max',false);
  else if(b.update_type==='bot_started') {setBot(db,u,'max',true);startPayload(db,u,String(b.payload||''),'max',config);}
  else if(b.update_type==='message_callback') callbackReply(db,u,b.callback.payload,b.callback.callback_id,'max');
  else if(b.update_type==='message_created') {setBot(db,u,'max',true);textReply(db,u,String(b.message.body?.text||'').trim(),'max',config);}
  db.run("UPDATE webhook_inbox SET status='processed',error=NULL WHERE id=?",row.id);
}
function processTelegramUpdate(db,row,update,config) {
  const ev=normalizeTelegramUpdate(update);
  if(!ev) {db.run("UPDATE webhook_inbox SET status='ignored' WHERE id=?",row.id);return;}
  const u=ensureTelegramUser(db,ev.user);
  if(ev.kind==='stopped') setBot(db,u,'telegram',false);
  else if(ev.kind==='started') setBot(db,u,'telegram',true);
  else if(ev.kind==='callback') {setBot(db,u,'telegram',true);callbackReply(db,db.get('SELECT * FROM users WHERE id=?',u.id),ev.data,ev.callbackId,'telegram');}
  else if(ev.kind==='text') {setBot(db,u,'telegram',true);textReply(db,db.get('SELECT * FROM users WHERE id=?',u.id),ev.text,'telegram',config);}
  db.run("UPDATE webhook_inbox SET status='processed',error=NULL WHERE id=?",row.id);
}
export function processInbox(db,config={}) {
  for(const row of db.all("SELECT * FROM webhook_inbox WHERE status='queued' AND attempts<5 LIMIT 20")) {
    try {db.tx(()=>{
      const b=JSON.parse(row.body);
      if(b.source==='telegram') processTelegramUpdate(db,row,b.update,config);
      else processMaxUpdate(db,row,b,config);
    });}catch(e) {db.run("UPDATE webhook_inbox SET attempts=attempts+1,error=? WHERE id=?",String(e.message).slice(0,200),row.id);}
  }
}
async function sendTelegram(db,config,u,b) {
  const message=toTelegram(makeMessage(db,config,u.id,b),config);
  if(b.answerId) {
    // Callback answers expire after a short time; a late answer must not block the message.
    try {await tgRequest(config,'answerCallbackQuery',{callback_query_id:b.answerId,text:String(b.title||'Ключи').slice(0,190)});} catch {}
  }
  await tgRequest(config,'sendMessage',{chat_id:u.tg_id,...message});
}
export async function processOutbox(db,config) {
  const channels=[...(config.botToken?['max']:[]),...(config.tgBotToken?['telegram']:[])];
  if(!channels.length)return;
  const row=db.get(`SELECT * FROM outbox WHERE status='queued' AND next_attempt<=? AND COALESCE(json_extract(body,'$.channel'),'max') IN (${channels.map(()=>'?').join(',')}) ORDER BY created_at LIMIT 1`,Date.now(),...channels);
  if(!row)return;
  const u=db.get('SELECT * FROM users WHERE id=?',row.user_id),b=JSON.parse(row.body),channel=b.channel==='telegram'?'telegram':'max',p=PLATFORMS[channel];
  if(!u?.[p.column]||!u[p.bot]||(b.category&&(!settings(u).bot||settings(u)[b.category]===false))){db.run("UPDATE outbox SET status='skipped' WHERE id=?",row.id);return;}
  try {
    if(channel==='telegram') await sendTelegram(db,config,u,b);
    else if(b.answerId) await maxRequest(config,'POST','/answers?callback_id='+encodeURIComponent(b.answerId),{message:makeMessage(db,config,u.id,b)});
    else await maxRequest(config,'POST','/messages?user_id='+encodeURIComponent(u.max_id),makeMessage(db,config,u.id,b));
    db.run("UPDATE outbox SET status='sent',attempts=attempts+1,error=NULL WHERE id=?",row.id);
  } catch(e) {
    const n=row.attempts+1;
    if(channel==='telegram'&&e.status===403) {
      // Blocked or never started: stop queueing Telegram messages until the user writes to the bot again.
      db.run('UPDATE users SET tg_bot_enabled=0 WHERE id=?',u.id);
      db.run("UPDATE outbox SET status='skipped',attempts=?,error=? WHERE id=?",n,e.message.slice(0,200),row.id);return;
    }
    const permanent=channel==='telegram'&&e.status===400;
    const delay=e.retryAfter?e.retryAfter*1000:Math.min(3600_000,2**n*10_000);
    db.run('UPDATE outbox SET attempts=?,next_attempt=?,status=?,error=? WHERE id=?',n,Date.now()+delay,permanent||n>=8?'failed':'queued',e.message.slice(0,200),row.id);
  }
}
