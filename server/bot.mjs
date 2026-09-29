import {createHash,randomUUID} from 'node:crypto';
import {ensureMaxUser} from './auth.mjs';
import {actionRecord,recordAccess,leaseAccess,previewInvite,joinInvite,settings,nowISO} from './domain.mjs';
const root=c=>(c.deepLinkBase||'https://max.ru').replace(/\/$/,'');
export function deepLink(c,payload='') {
  if(c.botUsername) return `${root(c)}/${encodeURIComponent(c.botUsername)}?startapp=${encodeURIComponent(payload)}`;
  if(payload.startsWith('r_')||payload.startsWith('c_')) return c.publicUrl+'/app/record/'+encodeURIComponent(payload.slice(2));
  return c.publicUrl;
}
export function botLink(c,payload='') {
  return c.botUsername?`${root(c)}/${encodeURIComponent(c.botUsername)}${payload?'?start='+encodeURIComponent(payload):''}`:c.publicUrl+(payload.startsWith('join_')?'?invite='+encodeURIComponent(payload.slice(5)):'');
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
  if(b.inviteCode) {
    try {
      previewInvite(db,u,b.inviteCode);
      buttons=[[{type:'callback',text:'Принять приглашение',payload:'join|'+b.inviteCode}]];
      return {format:'html',text:`<b>${limitedHtml(title,650)}</b>\n\n${limitedHtml(text,3200)}`,attachments:[{type:'inline_keyboard',payload:{buttons}}]};
    } catch {title='Приглашение недоступно';text='Оно уже принято, отозвано или истекло. Новое приглашение можно получить у собственника.';}
  }
  if(b.recordId) {
    try {
      const {record:r,owner}=recordAccess(db,u,b.recordId);
      target=(b.discussion?'c_':'r_')+r.id;
      cta=b.discussion?'Ответить в обсуждении':({ticket:'Открыть заявку',charge:owner?'Проверить платёж':'Открыть платёж',visit:'Согласовать посещение',reading:'Посмотреть показания',purchase:'Открыть покупку',document:'Открыть документ',terms:'Посмотреть условия',termination:'Обсудить завершение'})[r.kind]||'Открыть запись';
      const accepted=r.payload.accepted_by||[],required=r.payload.required_approvals;
      if(r.kind==='visit'&&['proposed','counter'].includes(r.status)&&r.payload.proposer!==u.id&&!accepted.includes(u.id)&&(!required||required.includes(u.id))) {
        buttons.push([{type:'callback',text:'Подтвердить время',payload:`visit|${r.id}|${r.version}|accept`},link('Предложить другое',deepLink(config,'r_'+r.id))]);
      }
    } catch { title='Событие в Ключах';text='Доступ к этой записи изменился. Проверьте доступные вам аренды.';target='';cta='Открыть Ключи'; }
  }
  if(target.startsWith('l_')||target.startsWith('m_')) {
    try {leaseAccess(db,u,target.slice(2));cta=target.startsWith('m_')?'Открыть счётчики':'Открыть аренду';}
    catch {target='';text='Доступ к аренде изменился.';}
  }
  buttons.push([link(cta,deepLink(config,target))]);
  return {format:'html',text:`<b>${limitedHtml(title,650)}</b>\n\n${limitedHtml(text,3200)}`,attachments:[{type:'inline_keyboard',payload:{buttons}}]};
}
export function enqueueUpdate(db,body) {
  const serialized=JSON.stringify(body),key=body.callback?.callback_id?`cb:${body.callback.callback_id}`:body.update_type==='message_created'&&body.message?.body?.mid?`msg:${body.message.body.mid}`:createHash('sha256').update(serialized).digest('hex');
  db.run('INSERT OR IGNORE INTO webhook_inbox(id,body,created_at) VALUES(?,?,?)',key,serialized,nowISO());return key;
}
function reply(db,userId,title,text,answerId,extra={}) {
  db.run('INSERT INTO outbox(id,user_id,body,created_at) VALUES(?,?,?,?)',randomUUID(),userId,JSON.stringify({title,text,answerId,...extra}),nowISO());
}
function inviteReply(db,u,code) {
  try {
    const {apartment,unit,owner,lease}=previewInvite(db,u,code);
    reply(db,u.id,'Приглашение в Ключи',`${owner} приглашает вас:\n${apartment.title} · ${unit}\n\nАренда за весь объект: ${new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(lease.rent/100)} в месяц.\nВы присоединитесь к группе этой аренды. Её участники видят общую историю, документы и платежи. Начисления не умножаются на число участников.\n\nПрисоединяйтесь только по знакомому приглашению.`,null,{inviteCode:code});
  } catch(e) {if(!e.status)throw e;reply(db,u.id,'Не удалось открыть приглашение',e.message);}
}
function callbackAction(db,fn) {
  db.exec('SAVEPOINT callback_action');
  try {const result=fn();db.exec('RELEASE callback_action');return result;}
  catch(e) {db.exec('ROLLBACK TO callback_action; RELEASE callback_action');throw e;}
}
export function processInbox(db) {
  for(const row of db.all("SELECT * FROM webhook_inbox WHERE status='queued' AND attempts<5 LIMIT 20")) {
    try {db.tx(()=>{
      const b=JSON.parse(row.body),source=b.callback?.user||b.message?.sender||b.user;
      const chatType=b.message?.recipient?.chat_type;
      if(!source||!Number.isSafeInteger(source.user_id)||source.user_id<=0||source.is_bot||b.is_channel||
        (b.update_type==='message_created'&&chatType!=='dialog')||(b.update_type==='message_callback'&&chatType&&chatType!=='dialog')) {
          db.run("UPDATE webhook_inbox SET status='ignored' WHERE id=?",row.id);return;
      }
      const u=ensureMaxUser(db,{id:String(source.user_id),name:[source.first_name,source.last_name].filter(Boolean).join(' ')||source.name||'Пользователь MAX'});
      if(['bot_stopped','dialog_removed'].includes(b.update_type)) db.run('UPDATE users SET bot_enabled=0 WHERE id=?',u.id);
      else if(b.update_type==='bot_started') {
        db.run('UPDATE users SET bot_enabled=1 WHERE id=?',u.id);
        const payload=String(b.payload||'');
        if(payload.startsWith('join_')) inviteReply(db,u,payload.slice(5));
        else reply(db,u.id,'Ключи — всё о вашей аренде','Платежи, показания, заявки, покупки и посещения — в одной истории.\n\n/start — открыть приложение\n/help — помощь');
      } else if(b.update_type==='message_callback') {
        const parts=String(b.callback.payload||'').split('|');
        let answer='Откройте приложение для этого действия.',title='Ключи',extra={};
        try {
          if(parts.length===2&&parts[0]==='join') {
            const joined=callbackAction(db,()=>joinInvite(db,u,parts[1]));
            db.run('UPDATE users SET bot_enabled=1 WHERE id=?',u.id);
            answer='Вы присоединились к аренде. Теперь откройте её в мини-приложении.';title='Приглашение принято';extra.target='l_'+joined.lease_id;
          } else if(parts.length===4&&parts[0]==='visit'&&parts[3]==='accept') {
            const result=callbackAction(db,()=>actionRecord(db,u,parts[1],{action:'accept',version:Number(parts[2])}));
            answer=result.status==='accepted'?'Время посещения подтверждено всеми участниками.':'Ваш ответ сохранён. Ждём остальных участников.';title='Посещение';extra.recordId=result.id;
          }
        } catch(e) {if(!e.status)throw e;answer=e.message;}
        reply(db,u.id,title,answer,b.callback.callback_id,extra);
      } else if(b.update_type==='message_created') {
        const raw=String(b.message.body?.text||'').trim(),command=raw.toLowerCase();
        db.run('UPDATE users SET bot_enabled=1 WHERE id=?',u.id);
        const invite=raw.match(/^\/start\s+join_([A-Za-z0-9_-]{1,100})$/);
        if(invite) inviteReply(db,u,invite[1]);
        else if(command==='/stop') {const s=settings(u);s.bot=false;db.run('UPDATE users SET settings=? WHERE id=?',JSON.stringify(s),u.id);reply(db,u.id,'Уведомления выключены','Включить снова: /notifications. История остаётся в приложении.');}
        else if(command==='/notifications') {const s=settings(u);s.bot=true;db.run('UPDATE users SET settings=? WHERE id=?',JSON.stringify(s),u.id);reply(db,u.id,'Уведомления включены','Настройте события и напоминания в профиле приложения.');}
        else if(command==='/help') reply(db,u.id,'Помощь','Собственник отправляет персональную ссылку. Откройте её в боте и подтвердите присоединение.\n\n/start — приложение\n/notifications — включить уведомления\n/stop — выключить уведомления\n\nПлатежи совершаются вне приложения. Ключи не заменяет экстренные службы.');
        else reply(db,u.id,'Ваши дела в Ключах','Чтобы сообщение не потерялось, создайте заявку или комментарий в карточке своей аренды.');
      }
      db.run("UPDATE webhook_inbox SET status='processed',error=NULL WHERE id=?",row.id);
    });}catch(e) {db.run("UPDATE webhook_inbox SET attempts=attempts+1,error=? WHERE id=?",String(e.message).slice(0,200),row.id);}
  }
}
export async function processOutbox(db,config){if(!config.botToken)return;const row=db.get("SELECT * FROM outbox WHERE status='queued' AND next_attempt<=? ORDER BY created_at LIMIT 1",Date.now());if(!row)return;const u=db.get('SELECT * FROM users WHERE id=?',row.user_id),b=JSON.parse(row.body);if(!u?.max_id||!u.bot_enabled||(b.category&&(!settings(u).bot||settings(u)[b.category]===false))){db.run("UPDATE outbox SET status='skipped' WHERE id=?",row.id);return;}
 try{if(b.answerId)await maxRequest(config,'POST','/answers?callback_id='+encodeURIComponent(b.answerId),{message:makeMessage(db,config,u.id,b)});else await maxRequest(config,'POST','/messages?user_id='+encodeURIComponent(u.max_id),makeMessage(db,config,u.id,b));db.run("UPDATE outbox SET status='sent',attempts=attempts+1,error=NULL WHERE id=?",row.id);}
 catch(e){const n=row.attempts+1;db.run('UPDATE outbox SET attempts=?,next_attempt=?,status=?,error=? WHERE id=?',n,Date.now()+Math.min(3600_000,2**n*10_000),n>=8?'failed':'queued',e.message.slice(0,200),row.id);}
}
