import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,httpFixture,newUser,meterPhoto,apartmentInput} from './helpers.mjs';
import {openDatabase} from '../server/db.mjs';
import {createSession} from '../server/auth.mjs';
import {processInbox,makeMessage} from '../server/bot.mjs';
import {enqueueTelegramUpdate,toTelegram} from '../server/telegram.mjs';
import {managerRole,managerIds,createUnit} from '../server/rental.mjs';
import * as D from '../server/domain.mjs';
import * as O from '../server/owners.mjs';

const TG='123456:telegram-test-token-abcdefghijklmnopqrstu';
let uid=8000;
const msg=(text,from)=>({update_id:++uid,message:{message_id:uid,date:1,chat:{id:from,type:'private'},from:{id:from,is_bot:false,first_name:'Мама'},text}});
const press=(data,from)=>({update_id:++uid,callback_query:{id:'cb'+uid,from:{id:from,is_bot:false,first_name:'Мама'},message:{message_id:1,chat:{id:from,type:'private'}},data}});
const send=(f,u)=>{enqueueTelegramUpdate(f.db,u);processInbox(f.db,f.config);};
const lastReply=(f,tgId)=>{const u=f.db.get('SELECT id FROM users WHERE tg_id=?',String(tgId));const row=f.db.get('SELECT * FROM outbox WHERE user_id=? ORDER BY rowid DESC LIMIT 1',u.id);const body=JSON.parse(row.body);return {body,message:toTelegram(makeMessage(f.db,f.config,u.id,body),f.config)};};
function tg(t){const f=fixture(t);Object.assign(f.config,{tgBotToken:TG,telegram:true,tgBotUsername:'rentkeysbot',publicUrl:'https://keys.example.org'});return f;}
// Main owner + co-owner (via a real link), the seeded tenant and a stranger.
function family(f){
  const co=newUser(f.db,'Мама','owner'),stranger=newUser(f.db,'Чужой','owner');
  const inv=f.db.tx(()=>O.createOwnerInvite(f.db,f.owner,f.lease.apartment_id,{label:'Мама',secret:f.config.secret}));
  f.db.tx(()=>O.joinOwnerInvite(f.db,co,inv.code));
  return {co:f.u(co.id),stranger,apartment:f.db.get('SELECT * FROM apartments WHERE id=?',f.lease.apartment_id)};
}
const notes=(f,userId,title)=>f.db.all('SELECT * FROM notifications WHERE user_id=?'+(title?' AND title=?':''),...[userId,...(title?[title]:[])]);

test('Co-owners: existing owners are migrated into apartment_members; a DB from an older release is backfilled on open',t=>{
  const f=fixture(t),a=f.db.get('SELECT * FROM apartments WHERE id=?',f.lease.apartment_id);
  assert.equal(f.db.get('SELECT role FROM apartment_members WHERE apartment_id=? AND user_id=?',a.id,f.owner.id).role,'owner');
  // An apartment written by 0.5.0 (no membership row) after a rollback:
  f.db.run("INSERT INTO apartments(id,owner_id,title,address,rooms,area,photo,created_at) VALUES('legacy',?,'Старая','Адрес',1,30,'living',?)",f.owner.id,D.nowISO());
  f.db.close();const db=openDatabase(f.dir);t.after(()=>db.close());
  assert.equal(db.get("SELECT role FROM apartment_members WHERE apartment_id='legacy'").role,'owner');
  assert.equal(managerRole(db,'legacy',f.owner.id),'owner');
});

test('Co-owners: invite lifecycle through the bot — preview, opened, accepted; the co-owner gets only THAT apartment',t=>{
  const f=tg(t),secret=f.config.secret,a=f.lease.apartment_id;
  const second=f.db.tx(()=>D.createApartment(f.db,f.owner,{...apartmentInput,title:'Дача'}));
  const inv=f.db.tx(()=>O.createOwnerInvite(f.db,f.owner,a,{label:'Мама',secret}));
  assert.equal(D.bootstrap(f.db,f.owner,f.config).owner_invites[0].status,'pending');
  send(f,msg('/start own_'+inv.code,555001));
  let r=lastReply(f,555001);assert.equal(r.body.title,'Приглашение стать совладельцем');assert.match(r.body.text,/Собственники сейчас: Алексей Петров/);
  assert.equal(r.message.reply_markup.inline_keyboard[0][0].callback_data,'own|'+inv.code);
  assert.equal(D.bootstrap(f.db,f.owner,f.config).owner_invites[0].status,'opened');
  send(f,press('own|'+inv.code,555001));
  r=lastReply(f,555001);assert.equal(r.body.title,'Готово, вы совладелец');assert.equal(r.message.reply_markup.inline_keyboard[0][0].text,'Открыть квартиру');assert.match(r.message.reply_markup.inline_keyboard[0][0].web_app.url,/startapp=a_/);
  const mama=f.db.get("SELECT * FROM users WHERE tg_id='555001'");
  assert.equal(managerRole(f.db,a,mama.id),'co_owner');assert.equal(managerRole(f.db,second.id,mama.id),null,'not the inviter\'s other apartments');
  assert.equal(mama.role,'owner');
  const st=D.bootstrap(f.db,mama,f.config);assert.deepEqual(st.apartments.map(x=>[x.title,x.my_role]),[[f.db.get('SELECT title FROM apartments WHERE id=?',a).title,'co_owner']]);
  assert.deepEqual(st.apartments[0].owners.map(o=>[o.name,o.role]),[['Алексей Петров','owner'],['Мама','co_owner']]);
  assert.equal(D.bootstrap(f.db,f.owner,f.config).owner_invites[0].status,'accepted');
  assert.equal(notes(f,f.owner.id,'Новый совладелец').length,1);assert.equal(notes(f,f.tenant.id,'У квартиры новый совладелец').length,1);
  // Tenants see both owners.
  assert.deepEqual(D.bootstrap(f.db,f.tenant,f.config).apartments[0].owners.map(o=>o.name),['Алексей Петров','Мама']);
  // Errors explained: reuse by someone else, reopen by the co-owner, own link, tenant, revoked, expired.
  send(f,msg('/start own_'+inv.code,555002));assert.match(lastReply(f,555002).body.text,/другой человек/);
  send(f,msg('/start own_'+inv.code,555001));assert.equal(lastReply(f,555001).body.title,'Вы уже совладелец');
  const own=f.db.tx(()=>O.createOwnerInvite(f.db,f.owner,a,{secret}));f.db.run("UPDATE users SET tg_id='555003',tg_bot_enabled=1 WHERE id=?",f.owner.id);
  send(f,msg('/start own_'+own.code,555003));assert.equal(lastReply(f,555003).body.title,'Это ваша ссылка');
  f.db.run("UPDATE users SET tg_id='555004',tg_bot_enabled=1 WHERE id=?",f.tenant.id);
  send(f,msg('/start own_'+own.code,555004));assert.match(lastReply(f,555004).body.text,/снимаете эту квартиру/);
  f.db.tx(()=>O.revokeOwnerInvite(f.db,f.owner,own.id));send(f,msg('/start own_'+own.code,555005));assert.match(lastReply(f,555005).body.text,/отозвал/);
  const old=f.db.tx(()=>O.createOwnerInvite(f.db,f.owner,a,{secret}));f.db.run('UPDATE owner_invites SET expires=? WHERE hash=?',Date.now()-1,old.id);
  send(f,msg('/start own_'+old.code,555006));assert.match(lastReply(f,555006).body.text,/Срок ссылки истёк/);
});

test('Co-owners: only the main owner invites, shares again, renews, revokes and removes; a co-owner can leave; the main owner cannot',t=>{
  const f=fixture(t),{co,stranger,apartment:a}=family(f),secret=f.config.secret;
  assert.throws(()=>O.createOwnerInvite(f.db,co,a.id,{secret}),e=>e.status===403);
  assert.throws(()=>O.createOwnerInvite(f.db,f.tenant,a.id,{secret}),e=>e.status===404);
  const inv=f.db.tx(()=>O.createOwnerInvite(f.db,f.owner,a.id,{label:'Папа',secret}));
  assert.equal(f.db.tx(()=>O.shareOwnerInvite(f.db,f.owner,inv.id,secret)).code,inv.code);
  assert.throws(()=>O.shareOwnerInvite(f.db,co,inv.id,secret),e=>e.status===403);
  const next=f.db.tx(()=>O.renewOwnerInvite(f.db,f.owner,inv.id,secret));assert.notEqual(next.code,inv.code);
  assert.throws(()=>f.db.tx(()=>O.joinOwnerInvite(f.db,stranger,inv.code)),e=>e.reason==='revoked');
  assert.throws(()=>O.removeCoOwner(f.db,co,a.id,f.owner.id),e=>e.status===403);
  assert.throws(()=>O.leaveApartment(f.db,f.owner,a.id),e=>e.status===409);
  assert.throws(()=>O.removeCoOwner(f.db,f.owner,a.id,f.owner.id),e=>e.status===409);
  f.db.tx(()=>O.removeCoOwner(f.db,f.owner,a.id,co.id));
  assert.equal(managerRole(f.db,a,co.id),null);assert.equal(D.bootstrap(f.db,co,f.config).apartments.length,0);
  assert.throws(()=>D.leaseAccess(f.db,co,f.lease.id),e=>e.status===404);
  assert.equal(notes(f,co.id,'Доступ к квартире закрыт').length,1);
  const again=f.db.tx(()=>O.createOwnerInvite(f.db,f.owner,a.id,{secret}));f.db.tx(()=>O.joinOwnerInvite(f.db,co,again.code));
  f.db.tx(()=>O.leaveApartment(f.db,co,a.id));assert.equal(managerRole(f.db,a,co.id),null);
  assert.equal(notes(f,f.owner.id,'Совладелец вышел').length,1);
  const hist=f.db.all('SELECT e.title,u.name FROM events e JOIN users u ON u.id=e.user_id WHERE e.apartment_id=? ORDER BY e.created_at',a.id).map(e=>e.name+': '+e.title);
  assert.ok(hist.some(x=>x==='Мама: Мама — совладелец квартиры')&&hist.some(x=>x.startsWith('Алексей Петров: Мама больше не совладелец'))&&hist.some(x=>x.includes('Выход из совладельцев:')),hist.join('\n'));
});

test('Co-owners: notifications reach every owner once, never the actor, and name who acted',t=>{
  const f=fixture(t),{co}=family(f);
  f.db.run('DELETE FROM notifications');
  const ticket=f.create('ticket',{description:'Течёт кран',room:'Кухня'});
  assert.equal(notes(f,f.owner.id).length,1);assert.equal(notes(f,co.id).length,1);
  const bill=f.create('charge',{amount:3000000,due:f.lease.start,period:f.lease.start.slice(0,7)},co);
  assert.equal(notes(f,co.id).filter(n=>n.record_id===bill.id).length,0,'the actor is not notified');
  assert.equal(notes(f,f.owner.id).filter(n=>n.record_id===bill.id).length,1);assert.match(notes(f,f.owner.id).find(n=>n.record_id===bill.id).text,/^Мама:/);
  const claimed=f.db.tx(()=>D.actionRecord(f.db,f.tenant,bill.id,{version:bill.version,action:'claim',amount:3000000,method:'cash'}));
  f.db.run('DELETE FROM notifications');
  const paid=f.db.tx(()=>D.actionRecord(f.db,co,bill.id,{version:claimed.version,action:'confirm',claim_id:claimed.payload.claims[0].id}));
  assert.equal(paid.status,'paid');
  for(const id of [f.owner.id,f.tenant.id]){const n=notes(f,id);assert.equal(n.length,1);assert.match(n[0].text,/подтверждение: Мама/);}
  assert.equal(notes(f,co.id).length,0);
  assert.throws(()=>D.actionRecord(f.db,f.owner,bill.id,{version:paid.version,action:'confirm',claim_id:claimed.payload.claims[0].id}),e=>e.status===409,'a second confirmation by the other owner is refused');
  void ticket;
});

test('Co-owners: owners answer proposals as one side',t=>{
  const f=fixture(t),{co}=family(f),start=new Date(Date.now()+3*86400000),end=new Date(start.getTime()+3600000);
  const visit=f.create('visit',{start:start.toISOString(),end:end.toISOString(),reason:'Счётчики'},f.owner);
  assert.throws(()=>f.db.tx(()=>D.actionRecord(f.db,co,visit.id,{version:visit.version,action:'accept'})),e=>e.status===403,'the co-owner is the same side as the proposer');
  const ok=f.db.tx(()=>D.actionRecord(f.db,f.tenant,visit.id,{version:visit.version,action:'accept'}));assert.equal(ok.status,'accepted');
  const end2=f.create('termination',{date:f.lease.end,reason:'Переезд'},f.tenant);
  const accepted=f.db.tx(()=>D.actionRecord(f.db,co,end2.id,{version:end2.version,action:'accept'}));
  assert.equal(accepted.status,'accepted','one owner answers for the owners');
  assert.deepEqual(accepted.payload.accepted_by,[f.owner.id]);
});

test('Co-owners: reminders go to each owner once',t=>{
  const f=fixture(t),{co}=family(f);
  f.db.run('DELETE FROM notifications');
  D.generateRecurring(f.db,f.config);D.generateRecurring(f.db,f.config);
  const byTitle=id=>f.db.all('SELECT title,COUNT(*) n FROM notifications WHERE user_id=? GROUP BY title,record_id',id);
  assert.ok(byTitle(co.id).every(x=>x.n===1));assert.deepEqual(byTitle(co.id).map(x=>x.title).sort(),byTitle(f.owner.id).map(x=>x.title).sort());
  assert.deepEqual(managerIds(f.db,f.lease.apartment_id),[f.owner.id,co.id]);
});

// Permission matrix: every owner endpoint, called as owner / co-owner / tenant / stranger.
test('HTTP permissions matrix: owner rights for owner and co-owner, none for tenant or stranger; main-owner-only actions',async t=>{
  const f=await httpFixture(t);Object.assign(f.config,{tgBotToken:TG,telegram:true,tgBotUsername:'rentkeysbot'});
  const owner=f.u('demo-owner'),lease=f.db.get("SELECT l.* FROM leases l JOIN apartments a ON a.id=l.apartment_id WHERE a.owner_id='demo-owner' AND l.status='active' AND EXISTS(SELECT 1 FROM lease_members WHERE lease_id=l.id) LIMIT 1");
  const aid=lease.apartment_id,tenant=f.u(f.db.get('SELECT user_id FROM lease_members WHERE lease_id=?',lease.id).user_id);
  const co=newUser(f.db,'Мама','owner'),stranger=newUser(f.db,'Чужой','owner'),as=u=>f.setToken(createSession(f.db,u.id).token);
  as(owner);const link=await f.api('/api/apartments/'+aid+'/owner-invite',{method:'POST',body:{label:'Мама'}});assert.equal(link.status,200,JSON.stringify(link.data));assert.match(link.data.url,/start=own_/);
  as(co);const pre=await f.api('/api/owner-invites/preview',{method:'POST',body:{code:link.data.code}});assert.equal(pre.data.ok,true);
  assert.equal((await f.api('/api/owner-invites/accept',{method:'POST',body:{code:link.data.code}})).status,200);
  // Fixtures the endpoints act on.
  const meter=f.db.tx(()=>D.createMeter(f.db,owner,lease.id,{label:'Вода',kind:'cold_water',unit:'м³'})).meters[0];
  const rule=f.db.tx(()=>D.createRecurringRule(f.db,owner,{lease_id:lease.id,title:'Интернет',amount:70000,due_day:10,start_month:D.dateInZone().slice(0,7),advance_days:14},f.config));
  const invite=f.db.tx(()=>D.createInvite(f.db,owner,lease.id,{secret:f.config.secret}));
  const bill=f.db.tx(()=>D.createRecord(f.db,owner,{lease_id:lease.id,kind:'charge',title:'Счёт',payload:{amount:1000000,due:lease.start,period:lease.start.slice(0,7)}},f.config));
  const ticket=f.db.tx(()=>D.createRecord(f.db,tenant,{lease_id:lease.id,kind:'ticket',title:'Кран',payload:{description:'Течёт',room:'Кухня'}},f.config));
  const purchase=f.db.tx(()=>D.createRecord(f.db,tenant,{lease_id:lease.id,kind:'purchase',title:'Лампа',payload:{amount:50000,purchase_date:D.dateInZone()}},f.config));
  const unit=f.db.tx(()=>createUnit(f.db,owner,aid,{title:'Комната М'}));
  const ver=(table,id)=>f.db.get(`SELECT version FROM ${table} WHERE id=?`,id).version;
  const soon=new Date(Date.now()+5*86400000),later=new Date(soon.getTime()+3600000);
  let n=0;
  const endpoints=[
    ['update apartment',()=>['/api/apartments/'+aid,{version:ver('apartments',aid),title:'Квартира '+(++n)}]],
    ['create lease',()=>['/api/apartments/'+aid+'/leases',{unit_id:unit.id,start:lease.start,end:lease.end,rent:100000}]],
    ['archive draft lease',()=>['/api/leases/'+lease.id+'/archive-draft',{}]],
    ['tenant invite',()=>['/api/leases/'+lease.id+'/invite',{}]],
    ['share tenant invite',()=>['/api/invites/'+invite.id+'/share',{}]],
    ['renew tenant invite',()=>['/api/invites/'+(f.db.get('SELECT hash FROM invite_meta WHERE lease_id=? AND replaced_by IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',lease.id)?.hash||invite.id)+'/renew',{}]],
    ['revoke tenant invite',()=>['/api/invites/'+invite.id+'/revoke',{}]],
    ['add room',()=>['/api/apartments/'+aid+'/units',{title:'Комната '+(++n),kind:'room'}]],
    ['rename room',()=>['/api/units/'+unit.id,{title:'Комната Р'+(++n),version:ver('rental_units',unit.id)}]],
    ['add meter',()=>['/api/leases/'+lease.id+'/meters',{label:'Газ '+(++n),kind:'gas',unit:'м³'}]],
    ['meter baselines',()=>['/api/leases/'+lease.id+'/meter-baselines',{values:[{meter_id:meter.id,value:1000*(++n)}]}]],
    ['meter settings',()=>['/api/leases/'+lease.id+'/meter-settings',{enabled:true}]],
    ['meter price',()=>['/api/meters/'+meter.id,{price:5000+(++n),version:ver('meters',meter.id)}]],
    ['recurring rule',()=>['/api/recurring-rules',{lease_id:lease.id,title:'Парковка '+(++n),amount:100000,due_day:5,start_month:D.dateInZone().slice(0,7),advance_days:14}]],
    ['pause rule',()=>['/api/recurring-rules/'+rule.id,{action:'pause',version:ver('recurring_rules',rule.id)}]],
    ['new charge',()=>['/api/records',{lease_id:lease.id,kind:'charge',title:'Вода',payload:{amount:20000,due:lease.start,period:lease.start.slice(0,7)}}]],
    ['new visit',()=>['/api/records',{lease_id:lease.id,kind:'visit',title:'Визит',payload:{start:soon.toISOString(),end:later.toISOString(),reason:'Осмотр'}}]],
    ['owner expense',()=>['/api/records',{lease_id:lease.id,kind:'expense',title:'Ремонт',payload:{amount:100000,date:D.dateInZone()}}]],
    ['record cash',()=>['/api/records/'+bill.id+'/action',{action:'record_payment',amount:1000,method:'cash',version:ver('records',bill.id)}]],
    ['start repair',()=>['/api/records/'+ticket.id+'/action',{action:'start',version:ver('records',ticket.id)}]],
    ['approve purchase',()=>['/api/records/'+purchase.id+'/action',{action:'approve',version:ver('records',purchase.id)}]],
  ];
  const mainOnly=[
    ['deletion preview',()=>['/api/apartments/'+aid+'/deletion-preview',undefined,'GET']],
    ['co-owner invite',()=>['/api/apartments/'+aid+'/owner-invite',{}]],
  ];
  const call=async(make)=>{const [url,body,method='POST']=make();return (await f.api(url,{method,...(body!==undefined?{body}:{})})).status;};
  const denied=s=>[403,404].includes(s),allowed=s=>![401,403,404].includes(s)&&s<500;
  const report=[];
  for(const [name,make] of endpoints) for(const [who,u,ok] of [['tenant',tenant,false],['stranger',stranger,false],['co-owner',co,true],['owner',owner,true]]) {as(u);const s=await call(make);if(ok?!allowed(s):!denied(s))report.push(`${name} as ${who}: ${s}`);}
  for(const [name,make] of mainOnly) for(const [who,u,ok] of [['tenant',tenant,false],['stranger',stranger,false],['co-owner',co,false],['owner',owner,true]]) {as(u);const s=await call(make);if(ok?!allowed(s):!denied(s))report.push(`${name} as ${who}: ${s}`);}
  for(const [who,u] of [['co-owner',co],['tenant',tenant],['stranger',stranger]]) {as(u);const s=(await f.api('/api/apartments/'+aid+'/delete',{method:'POST',body:{confirm:true}})).status;if(!denied(s)&&s!==400)report.push('delete as '+who+': '+s);}
  assert.deepEqual(report,[],report.join('\n'));
  // Visibility: the co-owner sees private owner records, the stranger sees nothing.
  as(co);const cs=(await f.api('/api/state')).data;assert.ok(cs.apartments.some(x=>x.id===aid&&x.my_role==='co_owner'));assert.ok(cs.records.some(r=>r.kind==='expense'));
  as(stranger);const ss=(await f.api('/api/state')).data;assert.ok(!ss.apartments.some(x=>x.id===aid));
  // Tenant-only actions stay with tenants.
  as(co);const reading=await f.api('/api/records',{method:'POST',body:{lease_id:lease.id,kind:'reading',title:'Показания',payload:{values:[]},files:[meterPhoto(f.db,lease,co)]}});assert.equal(reading.status,403);
  // Removal and leave over HTTP.
  as(co);assert.equal((await f.api('/api/apartments/'+aid+'/co-owners/'+owner.id+'/remove',{method:'POST',body:{}})).status,403);
  as(owner);assert.equal((await f.api('/api/apartments/'+aid+'/leave',{method:'POST',body:{}})).status,409);
  assert.equal((await f.api('/api/apartments/'+aid+'/co-owners/'+co.id+'/remove',{method:'POST',body:{}})).status,200);
  as(co);assert.equal((await f.api('/api/apartments/'+aid,{method:'POST',body:{version:ver('apartments',aid),title:'После'}})).status,404);
});
