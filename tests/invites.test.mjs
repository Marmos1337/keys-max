import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,httpFixture,signedData,newUser,apartmentInput} from './helpers.mjs';
import {processInbox,processOutbox,makeMessage} from '../server/bot.mjs';
import {enqueueTelegramUpdate,toTelegram} from '../server/telegram.mjs';
import {sealCode,openCode} from '../server/invite-codes.mjs';
import * as D from '../server/domain.mjs';
import {hash,createSession} from '../server/auth.mjs';

const TG='123456:telegram-test-token-abcdefghijklmnopqrstu';
let id=7000;
// Telegram users without a username: only id and first_name are guaranteed.
const msg=(text,from)=>({update_id:++id,message:{message_id:id,date:1,chat:{id:from,type:'private'},from:{id:from,is_bot:false,first_name:'Жилец '+from},text}});
const press=(data,from)=>({update_id:++id,callback_query:{id:'cb'+id,from:{id:from,is_bot:false,first_name:'Жилец '+from},message:{message_id:1,chat:{id:from,type:'private'}},data}});
function tg(t){const f=fixture(t);Object.assign(f.config,{tgBotToken:TG,telegram:true,tgBotUsername:'rentkeysbot',publicUrl:'https://keys.example.org',termsUrl:'https://keys.example.org/terms',privacyUrl:'https://keys.example.org/privacy'});return f;}
const lastReply=(f,tgId)=>{const u=f.db.get('SELECT id FROM users WHERE tg_id=?',String(tgId));const row=f.db.get("SELECT * FROM outbox WHERE user_id=? ORDER BY rowid DESC LIMIT 1",u.id);const body=JSON.parse(row.body);return {body,message:toTelegram(makeMessage(f.db,f.config,u.id,body),f.config)};};
const send=(f,update)=>{enqueueTelegramUpdate(f.db,update);processInbox(f.db,f.config);};
const setup=f=>{const apt=f.db.tx(()=>D.createApartment(f.db,f.owner,{...apartmentInput,title:'Квартира на Ленина'}));return f.db.get('SELECT * FROM leases WHERE apartment_id=?',apt.id);};
const statusOf=(f,inviteId)=>D.listInvites(f.db,f.owner).find(i=>i.id===inviteId)?.status;

test('Invites: owner adds two tenants with two links; statuses go pending → opened → accepted; owner is notified',t=>{
  const f=tg(t),lease=setup(f),secret=f.config.secret;
  const a=f.db.tx(()=>D.createInvite(f.db,f.owner,lease.id,{label:'Маша',secret})),b=f.db.tx(()=>D.createInvite(f.db,f.owner,lease.id,{label:'Петя',secret}));
  assert.equal(statusOf(f,a.id),'pending');assert.equal(D.listInvites(f.db,f.owner).length,2);
  assert.ok(Date.parse(a.expires)-Date.now()>6.9*86400000,'valid for 7 days');
  send(f,msg('/start join_'+a.code,501));
  let r=lastReply(f,501);assert.equal(r.body.title,'Вас приглашают в Ключи');assert.match(r.body.text,/Квартира на Ленина/);assert.match(r.body.text,/условиями/);
  assert.equal(r.message.reply_markup.inline_keyboard[0][0].callback_data,'join|'+a.code);
  assert.equal(statusOf(f,a.id),'opened');
  send(f,press('join|'+a.code,501));
  r=lastReply(f,501);assert.equal(r.body.title,'Готово, приглашение принято');assert.equal(r.message.reply_markup.inline_keyboard[0][0].text,'Открыть Ключи');
  assert.equal(r.message.reply_markup.inline_keyboard[0][0].web_app.url,'https://keys.example.org/?startapp=j_'+lease.id);
  send(f,msg('/start join_'+b.code,502));send(f,press('join|'+b.code,502));
  assert.equal(D.memberIds(f.db,lease.id).length,2);
  const list=D.listInvites(f.db,f.owner);assert.deepEqual(list.map(i=>[i.label,i.status,i.accepted_name]).sort(),[['Маша','accepted','Жилец 501'],['Петя','accepted','Жилец 502']]);
  assert.ok(list.every(i=>!i.shareable),'used links cannot be shared again');
  const ownerNotes=f.db.all("SELECT text FROM notifications WHERE user_id=? AND title='Новый участник аренды'",f.owner.id);
  assert.equal(ownerNotes.length,2);assert.match(ownerNotes[0].text+ownerNotes[1].text,/по ссылке «Маша»/);
  const state=D.bootstrap(f.db,f.owner,f.config);assert.equal(state.invites.length,2);assert.equal(state.members.filter(m=>m.lease_id===lease.id).length,2);
  assert.equal(D.bootstrap(f.db,f.u(f.db.get("SELECT id FROM users WHERE tg_id='501'").id),f.config).invites.length,0,'tenants never see invites');
});

test('Invites: every failure explains what to do — used, expired, revoked, own link, already a member, unknown',t=>{
  const f=tg(t),lease=setup(f),secret=f.config.secret;
  const a=f.db.tx(()=>D.createInvite(f.db,f.owner,lease.id,{secret}));
  send(f,msg('/start join_'+a.code,601));send(f,press('join|'+a.code,601));
  send(f,msg('/start join_'+a.code,602));assert.match(lastReply(f,602).body.text,/уже присоединился другой человек/);
  send(f,msg('/start join_'+a.code,601));let r=lastReply(f,601);assert.equal(r.body.title,'Вы уже в этой аренде');assert.match(r.message.reply_markup.inline_keyboard[0][0].web_app.url,/startapp=j_/);
  send(f,press('join|'+a.code,601));assert.equal(lastReply(f,601).body.title,'Вы уже в этой аренде');assert.equal(D.memberIds(f.db,lease.id).length,1);
  const b=f.db.tx(()=>D.createInvite(f.db,f.owner,lease.id,{secret}));f.db.run('UPDATE invites SET expires=? WHERE hash=?',Date.now()-1,b.id);
  send(f,msg('/start join_'+b.code,603));assert.match(lastReply(f,603).body.text,/Срок ссылки истёк/);assert.equal(statusOf(f,b.id),'expired');
  const c=f.db.tx(()=>D.createInvite(f.db,f.owner,lease.id,{secret}));f.db.tx(()=>D.revokeInvite(f.db,f.owner,c.id));
  send(f,msg('/start join_'+c.code,604));assert.match(lastReply(f,604).body.text,/отозвал/);
  send(f,msg('/start join_doesnotexist12345',605));assert.match(lastReply(f,605).body.text,/не найдена/);
  f.db.run("UPDATE users SET tg_id='606',tg_bot_enabled=1 WHERE id=?",f.owner.id);const d=f.db.tx(()=>D.createInvite(f.db,f.u(f.owner.id),lease.id,{secret}));
  send(f,msg('/start join_'+d.code,606));assert.equal(lastReply(f,606).body.title,'Это ваша ссылка');
  // A preview that went stale before it was delivered still renders an explanation, not an accept button.
  const e=f.db.tx(()=>D.createInvite(f.db,f.owner,lease.id,{secret}));send(f,msg('/start join_'+e.code,607));f.db.tx(()=>D.revokeInvite(f.db,f.owner,e.id));
  r=lastReply(f,607);assert.equal(r.message.reply_markup.inline_keyboard[0][0].callback_data,undefined);assert.match(r.message.text,/отозвал/);
});

test('Invites: share again returns the same link; renew replaces it and the old one stops working; revoke is owner-only',t=>{
  const f=tg(t),lease=setup(f),secret=f.config.secret;
  const a=f.db.tx(()=>D.createInvite(f.db,f.owner,lease.id,{label:'Маша',secret}));
  assert.equal(f.db.tx(()=>D.shareInvite(f.db,f.owner,a.id,secret)).code,a.code);
  assert.throws(()=>D.shareInvite(f.db,f.owner,a.id,'other-secret'),e=>e.status===409);
  const next=f.db.tx(()=>D.renewInvite(f.db,f.owner,a.id,secret));assert.notEqual(next.code,a.code);assert.equal(next.label,'Маша');
  assert.deepEqual(D.listInvites(f.db,f.owner).map(i=>i.id),[next.id],'replaced link is hidden');
  assert.throws(()=>f.db.tx(()=>D.joinInvite(f.db,f.other,a.code)),e=>e.reason==='revoked');
  assert.throws(()=>f.db.tx(()=>D.revokeInvite(f.db,f.other,next.id)),e=>e.status===403||e.status===404);
  f.db.tx(()=>D.joinInvite(f.db,f.other,next.code));
  assert.throws(()=>f.db.tx(()=>D.revokeInvite(f.db,f.owner,next.id)),e=>e.status===409);
  assert.throws(()=>f.db.tx(()=>D.renewInvite(f.db,f.owner,next.id,secret)),e=>e.status===409);
  const sealed=sealCode('s1','abc');assert.equal(openCode('s1',sealed),'abc');assert.equal(openCode('s2',sealed),'');assert.equal(openCode('s1','junk'),'');
  assert.ok(!f.db.get('SELECT code_enc FROM invite_meta WHERE hash=?',next.id).code_enc,'sealed code is dropped after use');
});

test('Invites: legacy invites without metadata still work (rollback-safe schema)',t=>{
  const f=tg(t),lease=setup(f),code='legacyCodeLegacyCode1234';
  f.db.run('INSERT INTO invites VALUES(?,?,?,NULL)',hash(code),lease.id,Date.now()+3600_000);
  f.db.tx(()=>D.joinInvite(f.db,f.other,code));assert.equal(D.memberIds(f.db,lease.id).length,1);
});

test('HTTP: create with label, list in state, share/renew/revoke, in-app preview and accept, silent login probe',async t=>{
  const f=await httpFixture(t);Object.assign(f.config,{tgBotToken:TG,telegram:true,tgBotUsername:'rentkeysbot',botUsername:'keys_max_bot'});
  await f.login('owner');const lease=f.db.get("SELECT l.* FROM leases l JOIN apartments a ON a.id=l.apartment_id WHERE a.owner_id='demo-owner' AND l.status='active' LIMIT 1");
  const created=await f.api('/api/leases/'+lease.id+'/invite',{method:'POST',body:{platform:'telegram',label:'Маша'}});
  assert.equal(created.status,200,JSON.stringify(created.data));assert.match(created.data.url,/^https:\/\/t\.me\/rentkeysbot\?start=join_/);assert.match(created.data.links.max,/max\.ru\/keys_max_bot\?start=join_/);assert.equal(created.data.days,7);assert.equal(created.data.label,'Маша');
  const state=await f.api('/api/state');const inv=state.data.invites.find(i=>i.id===created.data.id);assert.equal(inv.status,'pending');assert.equal(inv.shareable,true);assert.ok(!JSON.stringify(state.data.invites).includes(created.data.code),'state never contains codes');
  const again=await f.api('/api/invites/'+created.data.id+'/share',{method:'POST',body:{platform:'telegram'}});assert.equal(again.data.url,created.data.url);
  const renewed=await f.api('/api/invites/'+created.data.id+'/renew',{method:'POST',body:{platform:'max'}});assert.equal(renewed.data.platform,'max');assert.notEqual(renewed.data.code,created.data.code);
  const revoked=await f.api('/api/invites/'+renewed.data.id+'/revoke',{method:'POST',body:{}});assert.equal(revoked.status,200);
  const fresh=await f.api('/api/leases/'+lease.id+'/invite',{method:'POST',body:{}});
  // Tenant opens the link inside the Mini App.
  const tenant=newUser(f.db,'Новый жилец');f.setToken(createSession(f.db,tenant.id).token);
  const bad=await f.api('/api/invites/preview',{method:'POST',body:{code:renewed.data.code}});assert.equal(bad.data.ok,false);assert.equal(bad.data.reason,'revoked');
  const p=await f.api('/api/invites/preview',{method:'POST',body:{code:fresh.data.code}});assert.equal(p.data.ok,true);assert.equal(p.data.lease_id,lease.id);
  const acc=await f.api('/api/invites/accept',{method:'POST',body:{code:fresh.data.code}});assert.equal(acc.status,200,JSON.stringify(acc.data));assert.equal(acc.data.lease_id,lease.id);
  const member=await f.api('/api/invites/preview',{method:'POST',body:{code:fresh.data.code}});assert.equal(member.data.reason,'member');assert.equal(member.data.lease_id,lease.id);
  // Probe: unknown Telegram user is not created; a known one gets a session without the welcome step.
  const unknown=await f.api('/api/auth/telegram',{method:'POST',auth:false,body:{probe:true,initData:signedData(TG,{user:JSON.stringify({id:880001,first_name:'Новый'})})}});
  assert.equal(unknown.data.known,false);assert.equal(unknown.data.token,undefined);assert.equal(f.db.get("SELECT COUNT(*) n FROM users WHERE tg_id='880001'").n,0);
  f.db.run("UPDATE users SET tg_id='880002' WHERE id=?",tenant.id);
  const known=await f.api('/api/auth/telegram',{method:'POST',auth:false,body:{probe:true,initData:signedData(TG,{user:JSON.stringify({id:880002,first_name:'Жилец'})})}});
  assert.equal(known.data.known,true);assert.ok(known.data.token);assert.equal(known.data.user.id,tenant.id);
});
