import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,httpFixture,newUser,apartmentInput,status} from './helpers.mjs';
import {createSession} from '../server/auth.mjs';
import {createUnit,memberIds} from '../server/rental.mjs';
import * as D from '../server/domain.mjs';
import * as O from '../server/owners.mjs';
import * as U from '../server/utilities.mjs';
import {debtOf} from '../public/shares.js';

const tx=(f,fn)=>f.db.tx(fn);
// Joining order decides who carries the extra ruble; make it explicit (joins in one millisecond tie).
let joined=0;
const invite=(f,l,u)=>{const i=tx(f,()=>D.createInvite(f.db,f.owner,l.id));tx(f,()=>D.joinInvite(f.db,u,i.code));f.db.run('UPDATE lease_members SET joined_at=? WHERE lease_id=? AND user_id=?',new Date(Date.UTC(2026,0,1)+(++joined)*1000).toISOString(),l.id,u.id);};
const sanya=(f,handle)=>{const u=newUser(f.db,'Саня');f.db.run('UPDATE users SET handle=? WHERE id=?',handle,u.id);return f.u(u.id);};
// The owner's flat: Степан (owner) + Мама (co-owner), two tenants named «Саня».
function flat(f,input={}){
  const a=tx(f,()=>D.createApartment(f.db,f.owner,{...apartmentInput,...input})),l=f.db.get('SELECT * FROM leases WHERE apartment_id=?',a.id);
  const s1=sanya(f,'sanya_p'),s2=sanya(f,'sanya_k');invite(f,l,s1);invite(f,l,s2);
  const mama=newUser(f.db,'Мама','owner'),inv=tx(f,()=>O.createOwnerInvite(f.db,f.owner,a.id,{secret:f.config.secret}));tx(f,()=>O.joinOwnerInvite(f.db,mama,inv.code));
  return {a,l,s1,s2,mama:f.u(mama.id)};
}
const PERIOD=D.dateInZone().slice(0,7),DUE=D.dueDate(D.nextMonth(PERIOD),10);
const add=(f,who,a,body={})=>tx(f,()=>U.createUtilities(f.db,who,a.id,{period:PERIOD,amount:300000,due:DUE,publish:true,...body}));
const change=(f,who,g,body)=>tx(f,()=>U.changeUtilities(f.db,who,g.group_id,{versions:Object.fromEntries(g.records.map(r=>[r.id,f.db.get('SELECT version FROM records WHERE id=?',r.id).version])),...body}));
const notes=(f,id)=>f.db.all('SELECT * FROM notifications WHERE user_id=? ORDER BY rowid',id);

test('Utilities: one amount split equally among tenants only, one charge per lease, tenants are not messaged',t=>{
  const f=fixture(t),{a,l,s1,s2,mama}=flat(f);
  f.db.run('DELETE FROM notifications');
  const g=add(f,f.owner,a,{note:'Свет и вода'});
  assert.equal(g.records.length,1);
  const r=g.records[0],p=r.payload;
  assert.equal(r.kind,'charge');assert.equal(r.lease_id,l.id);assert.equal(r.status,'pending');assert.equal(r.title,'Коммуналка за '+D.monthText(PERIOD));
  assert.equal(p.category,'utilities');assert.equal(p.group_id,g.group_id);assert.equal(p.amount,300000);assert.equal(p.confirmed,0);
  assert.deepEqual(p.shares,{[s1.id]:150000,[s2.id]:150000},'owner and co-owner never get a share');
  assert.equal(p.people_total,2);assert.equal(p.group_total,300000);assert.equal(p.note,'Свет и вода');
  assert.deepEqual(p.lines,[{label:'Коммуналка',amount:300000}]);assert.equal(p.amount,p.lines.reduce((n,x)=>n+x.amount,0));
  assert.equal(f.db.get('SELECT dedupe FROM records WHERE id=?',r.id).dedupe,`utilities:${a.id}:${PERIOD}:${l.id}`);
  for(const s of [s1,s2]) assert.equal(notes(f,s.id).length,0,'tenants get no message when utilities are entered');
  assert.equal(notes(f,mama.id).length,0,'the co-owner is not disturbed by the primary owner\'s entry');
  assert.equal(notes(f,f.owner.id).length,0);assert.equal(p.approval,'approved');assert.equal(r.visibility,'shared');
  assert.ok(f.db.get("SELECT 1 FROM events WHERE record_id=? AND visibility='shared'",r.id));
});

test('Utilities: odd amounts keep whole-ruble shares; the extra ruble and kopecks go to the first tenant',t=>{
  const f=fixture(t),{a,s1,s2}=flat(f);
  const p=add(f,f.owner,a,{amount:100150}).records[0].payload;
  assert.deepEqual(p.shares,{[s1.id]:50150,[s2.id]:50000});assert.equal(p.amount,100150);
});

test('Utilities: the month exists → 409 with the existing group; no tenants → 409; tenants 403, strangers 404',t=>{
  const f=fixture(t),{a,s1}=flat(f),g=add(f,f.owner,a);
  assert.throws(()=>add(f,f.owner,a,{amount:500000}),e=>e.status===409&&e.details.group_id===g.group_id&&/уже внесена/.test(e.message));
  assert.throws(()=>add(f,s1,a),status(403));
  assert.throws(()=>add(f,newUser(f.db,'Чужой','owner'),a),status(404));
  const empty=tx(f,()=>D.createApartment(f.db,f.owner,{...apartmentInput,title:'Пустая'}));
  assert.throws(()=>add(f,f.owner,empty),e=>e.status===409&&/нет жильцов/.test(e.message));
  assert.throws(()=>add(f,f.owner,a,{period:'2026-13'}),status(400));
  assert.throws(()=>add(f,f.owner,a,{amount:0,period:D.nextMonth(PERIOD)}),status(400));
});

test('Utilities: the due date is clamped to the lease end',t=>{
  const f=fixture(t),end=D.dueDate(D.nextMonth(PERIOD),5),{a}=flat(f,{start:'2026-01-01',end});
  assert.equal(add(f,f.owner,a,{due:DUE}).records[0].payload.due,end);
});

test('Utilities: rooms get one record each with only their own tenants; other rooms see total and headcount, not names',t=>{
  const f=fixture(t),a=tx(f,()=>D.createApartment(f.db,f.owner,{...apartmentInput,rental_mode:'rooms',unit_title:'Комната А'}));
  const l1=f.db.get('SELECT * FROM leases WHERE apartment_id=?',a.id),unit=tx(f,()=>createUnit(f.db,f.owner,a.id,{title:'Комната Б'})),l2=tx(f,()=>D.createLease(f.db,f.owner,a.id,{...apartmentInput,unit_id:unit.id}));
  const alice=newUser(f.db,'Алиса'),bob=newUser(f.db,'Борис'),vera=newUser(f.db,'Вера');invite(f,l1,alice);invite(f,l1,bob);invite(f,l2,vera);
  f.db.run("UPDATE leases SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?",l1.id);
  const g=add(f,f.owner,a,{amount:300100});
  assert.equal(g.records.length,2);
  const [r1,r2]=[l1,l2].map(l=>g.records.find(r=>r.lease_id===l.id));
  const [first,second]=memberIds(f.db,l1.id);
  assert.deepEqual(r1.payload.shares,{[first]:100100,[second]:100000});assert.equal(r1.payload.amount,200100);
  assert.deepEqual(r2.payload.shares,{[vera.id]:100000});assert.equal(r2.payload.amount,100000);
  assert.ok(g.records.every(r=>r.payload.group_total===300100&&r.payload.people_total===3&&r.payload.group_id===g.group_id));
  const st=D.bootstrap(f.db,vera,f.config);
  assert.deepEqual(st.records.filter(r=>r.payload.category==='utilities').map(r=>r.id),[r2.id]);
  assert.ok(!st.people.some(p=>p.id===alice.id||p.id===bob.id));
  assert.equal(notes(f,vera.id).length,0);
});

test('Utilities: edit while untouched keeps the same people; a later joiner is not added; claims block edit and cancel',t=>{
  const f=fixture(t),{a,l,s1,s2}=flat(f),g=add(f,f.owner,a);
  const late=newUser(f.db,'Новенький');invite(f,l,late);
  const edited=change(f,f.owner,g,{action:'update',amount:400100,due:D.dueDate(D.nextMonth(PERIOD),15),note:''});
  const p=edited.records[0].payload;
  assert.deepEqual(p.shares,{[s1.id]:200100,[s2.id]:200000});assert.equal(p.amount,400100);assert.equal(p.group_total,400100);
  assert.deepEqual(p.lines,[{label:'Коммуналка',amount:400100}]);assert.equal(p.due,D.dueDate(D.nextMonth(PERIOD),15));
  assert.equal(notes(f,s1.id).filter(n=>n.record_id===p.id).length,0,'edits do not message tenants');assert.equal(notes(f,late.id).filter(n=>n.record_id===p.id).length,0);
  assert.throws(()=>tx(f,()=>U.changeUtilities(f.db,f.owner,g.group_id,{action:'update',amount:1000,versions:{[g.records[0].id]:1}})),status(409),'stale version');
  assert.throws(()=>change(f,s1,g,{action:'cancel'}),status(403));
  const r=edited.records[0];
  tx(f,()=>D.actionRecord(f.db,s1,r.id,{version:r.version,action:'claim'}));
  assert.throws(()=>change(f,f.owner,g,{action:'cancel'}),status(409));
});

test('Utilities: cancel frees the month (dedupe cleared) so it can be entered again',t=>{
  const f=fixture(t),{a,s1}=flat(f),g=add(f,f.owner,a);
  const c=change(f,f.owner,g,{action:'cancel',note:'Ошиблась суммой'});
  assert.equal(c.records[0].status,'cancelled');assert.equal(c.records[0].payload.cancel_reason,'Ошиблась суммой');
  assert.equal(f.db.get('SELECT dedupe FROM records WHERE id=?',g.records[0].id).dedupe,null);
  assert.match(notes(f,s1.id).at(-1).title,/отменена/);
  const again=add(f,f.owner,a,{amount:310000});assert.notEqual(again.group_id,g.group_id);
  assert.throws(()=>change(f,f.owner,g,{action:'update',amount:1}),status(404),'cancelled group is gone');
});

test('Utilities: tenant one tap claims exactly their remaining share, cash by default',t=>{
  const f=fixture(t),{a,s1,s2}=flat(f),r=add(f,f.owner,a,{amount:300100}).records[0];
  const c=tx(f,()=>D.actionRecord(f.db,s2,r.id,{version:r.version,action:'claim'}));
  assert.equal(c.payload.claims[0].amount,150000);assert.equal(c.payload.claims[0].method,'cash');assert.equal(c.payload.claims[0].for_user_id,s2.id);
  const c2=tx(f,()=>D.actionRecord(f.db,s1,r.id,{version:c.version,action:'claim'}));
  assert.equal(c2.payload.claims[1].amount,150100);
});

test('Utilities over HTTP: create, replay with the same key, 409 carries the group id, tenant is refused',async t=>{
  const f=await httpFixture(t),{a,s1}=flat(f);
  await f.login('owner');
  const body={period:PERIOD,amount:300000,due:DUE},key='utilities-key-1';
  const first=await f.api(`/api/apartments/${a.id}/utilities`,{method:'POST',body,key});
  assert.equal(first.status,200);assert.ok(first.data.group_id);assert.equal(first.data.records.length,1);
  const replay=await f.api(`/api/apartments/${a.id}/utilities`,{method:'POST',body,key});
  assert.deepEqual(replay.data,first.data);
  assert.equal(f.db.get("SELECT COUNT(*) n FROM records WHERE json_extract(payload,'$.category')='utilities'").n,1);
  const dup=await f.api(`/api/apartments/${a.id}/utilities`,{method:'POST',body});
  assert.equal(dup.status,409);assert.equal(dup.data.details.group_id,first.data.group_id);
  const r=first.data.records[0];
  const upd=await f.api(`/api/utilities/${first.data.group_id}`,{method:'POST',body:{action:'update',amount:200000,versions:{[r.id]:r.version}}});
  assert.equal(upd.status,200);assert.equal(upd.data.records[0].payload.amount,200000);
  f.setToken(createSession(f.db,s1.id).token);
  assert.equal((await f.api(`/api/apartments/${a.id}/utilities`,{method:'POST',body:{...body,period:D.nextMonth(PERIOD)}})).status,403);
});

test('Utilities edit after payments: only the floor (confirmed + open claims) is a hard rule; status recomputed; history event, no notifications',t=>{
  const f=fixture(t),{a,l,s1,s2}=flat(f,{recurring_rent:false}),g=add(f,f.owner,a,{amount:300000}),r=g.records[0];
  const c1=tx(f,()=>D.actionRecord(f.db,s1,r.id,{version:r.version,action:'claim'}));
  const paid=tx(f,()=>D.actionRecord(f.db,f.owner,r.id,{version:c1.version,action:'confirm',claim_id:c1.payload.claims[0].id}));
  assert.equal(paid.payload.confirmed,150000);
  const c2=tx(f,()=>D.actionRecord(f.db,s2,r.id,{version:paid.version,action:'claim'}));
  assert.equal(c2.status,'claimed');
  f.db.run('DELETE FROM notifications');
  // 150 000 confirmed + 150 000 waiting: nothing below 3 000 ₽.
  assert.throws(()=>change(f,f.owner,g,{action:'update',amount:200000}),e=>e.status===409&&e.details.min_amount===300000&&/3\s000\s₽/.test(e.message));
  const up=change(f,f.owner,g,{action:'update',amount:400000,due:DUE}),p=up.records[0].payload;
  assert.equal(p.amount,400000);assert.equal(p.group_total,400000);assert.deepEqual(p.shares,{[s1.id]:200000,[s2.id]:200000});
  assert.equal(up.records[0].status,'claimed');assert.equal(p.confirmed,150000);assert.equal(p.claims.length,1);assert.equal(p.claim.id,p.claims[0].id);
  assert.deepEqual(p.lines,[{label:'Коммуналка',amount:400000}]);
  const ev=f.db.get("SELECT title,visibility FROM events WHERE record_id=? ORDER BY rowid DESC LIMIT 1",r.id);
  assert.match(ev.title,/^Коммуналка за .+ изменена: было 3\s000\s₽, стало 4\s000\s₽$/);assert.equal(ev.visibility,'shared');
  for(const s of [s1,s2]) assert.equal(notes(f,s.id).length,0);
  assert.equal(notes(f,f.mama?.id||'-').length,0);
  // The tenant who already paid more than the new share simply owes nothing: shrink to the floor.
  const down=change(f,f.owner,g,{action:'update',amount:300000});
  assert.equal(down.records[0].payload.shares[s1.id],150000);
  // Confirm the open claim → fully paid at the floor; a later lowering is refused, raising reopens.
  const cur=down.records[0],done=tx(f,()=>D.actionRecord(f.db,f.owner,cur.id,{version:cur.version,action:'confirm',claim_id:cur.payload.claims[0].id}));
  assert.equal(done.status,'paid');
  assert.throws(()=>change(f,f.owner,g,{action:'update',amount:299900}),e=>e.status===409&&e.details.min_amount===300000);
  const up2=change(f,f.owner,g,{action:'update',amount:340000});assert.equal(up2.records[0].status,'partial');
  assert.throws(()=>change(f,f.owner,g,{action:'cancel'}),e=>e.status===409);
  assert.ok(l);
});

test('Utilities edit: when the total is unchanged the event says the due date or note changed; stale versions refused',t=>{
  const f=fixture(t),{a}=flat(f),g=add(f,f.owner,a);
  change(f,f.owner,g,{action:'update',note:'Новая заметка'});
  assert.match(f.db.get("SELECT title FROM events WHERE record_id=? ORDER BY rowid DESC LIMIT 1",g.records[0].id).title,/изменена: срок или комментарий/);
  assert.throws(()=>tx(f,()=>U.changeUtilities(f.db,f.owner,g.group_id,{action:'update',amount:1000,versions:{[g.records[0].id]:1}})),status(409));
});

test('Month-end digest: last day only, once per tenant per month, owed tenants only, rooms isolated, utilities have no own reminders',t=>{
  const f=fixture(t),a=tx(f,()=>D.createApartment(f.db,f.owner,{...apartmentInput,rental_mode:'rooms',unit_title:'Комната А',recurring_rent:false}));
  const l1=f.db.get('SELECT * FROM leases WHERE apartment_id=?',a.id),unit=tx(f,()=>createUnit(f.db,f.owner,a.id,{title:'Комната Б'})),l2=tx(f,()=>D.createLease(f.db,f.owner,a.id,{...apartmentInput,unit_id:unit.id,recurring_rent:false}));
  const alice=newUser(f.db,'Алиса'),vera=newUser(f.db,'Вера'),idle=newUser(f.db,'Тихая');invite(f,l1,alice);invite(f,l2,vera);
  tx(f,()=>D.createRecord(f.db,f.owner,{lease_id:l1.id,kind:'charge',title:'Аренда за '+PERIOD,payload:{amount:3000000,due:PERIOD+'-05',period:PERIOD}},f.config));
  const g=add(f,f.owner,a,{amount:200000,due:PERIOD+'-28'});
  const [y,m]=PERIOD.split('-').map(Number),lastDay=new Date(Date.UTC(y,m,0)).getUTCDate(),at=day=>Date.parse(`${PERIOD}-${String(day).padStart(2,'0')}T09:00:00+03:00`);
  f.db.run('DELETE FROM notifications');
  tx(f,()=>D.generateRecurring(f.db,f.config,at(lastDay-1)));
  assert.equal(f.db.all("SELECT 1 FROM notifications WHERE dedupe LIKE 'digest:%'").length,0,'not the last day');
  tx(f,()=>D.generateRecurring(f.db,f.config,at(lastDay)));tx(f,()=>D.generateRecurring(f.db,f.config,at(lastDay)));
  const da=notes(f,alice.id).filter(n=>/^Итог за/.test(n.title));
  assert.equal(da.length,1,'once per month even when the worker runs twice');
  assert.match(da[0].text,/аренда 30\s000\s₽, коммуналка 1\s000\s₽ — ваша доля к оплате 31\s000\s₽/);
  assert.ok(da[0].text.indexOf('Аренда за')<da[0].text.indexOf('Коммуналка за'),'oldest first');
  const dv=notes(f,vera.id).filter(n=>/^Итог за/.test(n.title));
  assert.equal(dv.length,1);assert.doesNotMatch(dv[0].text,/Аренда/);assert.match(dv[0].text,/коммуналка 1\s000\s₽ — ваша доля к оплате 1\s000\s₽/);
  assert.equal(notes(f,idle.id).length,0);assert.equal(notes(f,f.owner.id).filter(n=>/^Итог за/.test(n.title)).length,0,'managers get no digest');
  const ukey=`due:${g.records[0].id}:%`;
  tx(f,()=>D.generateRecurring(f.db,f.config,Date.parse(PERIOD+'-28T09:00:00+03:00')));
  assert.equal(f.db.all('SELECT 1 FROM notifications WHERE dedupe LIKE ?',ukey).length+f.db.all('SELECT 1 FROM notifications WHERE dedupe LIKE ?',`due:${g.records[1].id}:%`).length,0,'no per-charge reminders for utilities');
});

test('Month-end digest: a tenant who owes nothing gets no digest',t=>{
  const f=fixture(t),{a,s1,s2}=flat(f,{recurring_rent:false}),g=add(f,f.owner,a,{amount:300000}),r=g.records[0];
  const c=tx(f,()=>D.actionRecord(f.db,s2,r.id,{version:r.version,action:'claim'}));
  tx(f,()=>D.actionRecord(f.db,f.owner,r.id,{version:c.version,action:'confirm',claim_id:c.payload.claims[0].id}));
  const [y,m]=PERIOD.split('-').map(Number),last=new Date(Date.UTC(y,m,0)).getUTCDate();
  f.db.run('DELETE FROM notifications');
  tx(f,()=>D.generateRecurring(f.db,f.config,Date.parse(`${PERIOD}-${String(last).padStart(2,'0')}T09:00:00+03:00`)));
  assert.equal(notes(f,s2.id).filter(n=>/^Итог за/.test(n.title)).length,0);
  assert.equal(notes(f,s1.id).filter(n=>/^Итог за/.test(n.title)).length,1);
});

const approvalNotes=(f,id)=>notes(f,id).filter(n=>/одобрить/.test(n.title));
const stateFor=(f,u)=>D.bootstrap(f.db,u,f.config);

test('Utilities approval: a co-owner\'s entry is a draft nobody else sees until the primary owner approves; no tenant push',t=>{
  const f=fixture(t),{a,s1,mama}=flat(f,{recurring_rent:false});
  f.db.run('DELETE FROM notifications');
  const g=add(f,mama,a,{publish:true});   // publish is ignored for a co-owner
  const r=g.records[0];
  assert.equal(r.visibility,'owner');assert.equal(r.payload.approval,'pending');
  assert.equal(approvalNotes(f,f.owner.id).length,1);assert.match(approvalNotes(f,f.owner.id)[0].text,/Мама: внесена коммуналка за .+: 3\s000\s₽ — нужно одобрить/);assert.equal(approvalNotes(f,f.owner.id)[0].record_id,r.id);
  assert.equal(notes(f,s1.id).length,0);
  const st=stateFor(f,s1);
  assert.ok(!st.records.some(x=>x.id===r.id),'a tenant never sees a draft');
  assert.ok(!st.events.some(e=>e.record_id===r.id),'nor its history');
  assert.ok(stateFor(f,mama).records.some(x=>x.id===r.id)&&stateFor(f,f.owner).records.some(x=>x.id===r.id));
  assert.throws(()=>tx(f,()=>D.actionRecord(f.db,s1,r.id,{version:r.version,action:'claim'})),status(404));
  assert.throws(()=>tx(f,()=>D.actionRecord(f.db,f.owner,r.id,{version:r.version,action:'claim'})),status(409),'no claims on a draft');
  assert.equal(debtOf([{...r,members:[s1.id]}],s1.id).total,0,'drafts are not debt');
  assert.throws(()=>change(f,mama,g,{action:'approve'}),status(403));assert.throws(()=>change(f,s1,g,{action:'approve'}),status(403));
  // Co-owner edits own draft in place and the primary owner is told once more.
  const e1=change(f,mama,g,{action:'update',amount:360000});
  assert.equal(e1.records[0].payload.amount,360000);assert.equal(e1.records[0].visibility,'owner');assert.equal(approvalNotes(f,f.owner.id).length,2);
  // The primary owner edits the draft: it stays a draft, nobody is notified.
  f.db.run('DELETE FROM notifications');
  const e2=change(f,f.owner,g,{action:'update',amount:400000});
  assert.equal(e2.records[0].visibility,'owner');assert.equal(e2.records[0].payload.approval,'pending');assert.equal(e2.records[0].payload.group_total,400000);
  assert.equal(f.db.get('SELECT COUNT(*) n FROM notifications').n,0);
  const ap=change(f,f.owner,g,{action:'approve'}),p=ap.records[0];
  assert.equal(p.visibility,'shared');assert.equal(p.payload.approval,'approved');assert.equal(p.payload.approved_by,f.owner.id);assert.equal(p.payload.amount,400000);
  assert.ok(stateFor(f,s1).records.some(x=>x.id===r.id));
  assert.match(stateFor(f,s1).events.find(e=>e.record_id===r.id&&/Выставлена/.test(e.title)).title,/Выставлена коммуналка за /);
  assert.equal(f.db.get('SELECT COUNT(*) n FROM notifications').n,0,'approval pushes nothing to tenants');
  assert.throws(()=>change(f,f.owner,g,{action:'approve'}),status(409));
  assert.equal(debtOf([{...p,members:[s1.id,'x']}],s1.id).total>0,true);
});

test('Utilities approval: primary owner publishes at once with publish:true; his edit of a published group applies immediately and quietly',t=>{
  const f=fixture(t),{a,s1,mama}=flat(f,{recurring_rent:false});
  const draft=add(f,f.owner,a,{publish:false,period:D.nextMonth(PERIOD)});
  assert.equal(draft.records[0].visibility,'owner');assert.equal(approvalNotes(f,f.owner.id).length,0);
  change(f,f.owner,draft,{action:'cancel'});
  const g=add(f,f.owner,a);f.db.run('DELETE FROM notifications');
  assert.equal(g.records[0].visibility,'shared');
  const e=change(f,f.owner,g,{action:'update',amount:240000});assert.equal(e.records[0].payload.amount,240000);assert.equal(e.records[0].payload.approval,'approved');
  assert.equal(f.db.get('SELECT COUNT(*) n FROM notifications').n,0);assert.ok(mama&&s1);
});

test('Utilities approval: a co-owner\'s edit of a published group is a pending_change hidden from tenants; approve applies it, decline drops it',t=>{
  const f=fixture(t),{a,s1,s2,mama}=flat(f,{recurring_rent:false}),g=add(f,f.owner,a),r=g.records[0];
  f.db.run('DELETE FROM notifications');
  const pr=change(f,mama,g,{action:'update',amount:500000,due:D.dueDate(D.nextMonth(PERIOD),20),note:'Счёт пересчитали'}),p=pr.records[0].payload;
  assert.equal(p.amount,300000,'published amount untouched');assert.equal(p.group_total,300000);
  assert.deepEqual({amount:p.pending_change.amount,by:p.pending_change.by,note:p.pending_change.note},{amount:500000,by:mama.id,note:'Счёт пересчитали'});
  assert.match(approvalNotes(f,f.owner.id).at(-1).text,/Мама: изменение коммуналки за .+: было 3\s000\s₽, станет 5\s000\s₽ — нужно одобрить/);
  assert.equal(notes(f,s1.id).length,0);
  for(const who of [s1,s2]) assert.ok(!JSON.stringify(stateFor(f,who).records.find(x=>x.id===r.id)).includes('pending_change'),'tenant state has no pending_change');
  assert.ok(stateFor(f,mama).records.find(x=>x.id===r.id).payload.pending_change);
  // A tenant's own action response never leaks it either.
  const claimed=tx(f,()=>D.actionRecord(f.db,s1,r.id,{version:pr.records[0].version,action:'claim'}));assert.equal(claimed.payload.pending_change,undefined);
  // Primary owner edits the proposal in place: it stays a proposal, no notification.
  f.db.run('DELETE FROM notifications');
  const ed=change(f,f.owner,g,{action:'update',amount:600000});
  assert.equal(ed.records[0].payload.pending_change.amount,600000);assert.equal(ed.records[0].payload.pending_change.by,mama.id);assert.equal(ed.records[0].payload.pending_change.note,'Счёт пересчитали');assert.equal(ed.records[0].payload.group_total,300000);
  assert.equal(f.db.get('SELECT COUNT(*) n FROM notifications').n,0);
  // Approve applies it, still respecting the floor rule.
  const ok=change(f,f.owner,g,{action:'approve'}),q=ok.records[0].payload;
  assert.equal(q.group_total,600000);assert.equal(q.amount,600000);assert.equal(q.pending_change,undefined);assert.equal(q.note,'Счёт пересчитали');assert.equal(q.due,D.dueDate(D.nextMonth(PERIOD),20));
  assert.equal(q.claims.length,1,'the tenant\'s claim survives');
  // Another proposal below the floor is refused at proposal time; decline drops a valid one and tells the author.
  assert.throws(()=>change(f,mama,g,{action:'update',amount:100000}),e=>e.status===409&&e.details.min_amount>0);
  change(f,mama,g,{action:'update',amount:700000});f.db.run('DELETE FROM notifications');
  assert.throws(()=>change(f,mama,g,{action:'decline'}),status(403));
  const dec=change(f,f.owner,g,{action:'decline'});assert.equal(dec.records[0].payload.pending_change,undefined);assert.equal(dec.records[0].payload.group_total,600000);
  assert.match(notes(f,mama.id).at(-1).title,/изменение отклонено/);
  assert.throws(()=>change(f,f.owner,g,{action:'decline'}),status(409));assert.throws(()=>change(f,f.owner,g,{action:'approve'}),status(409));
});

test('Utilities approval: a pending change that would go under confirmed + claims cannot be approved; declining a draft cancels it and frees the month',t=>{
  const f=fixture(t),{a,s1,mama}=flat(f,{recurring_rent:false}),g=add(f,mama,a,{period:D.nextMonth(PERIOD)});
  f.db.run('DELETE FROM notifications');
  const d=change(f,f.owner,g,{action:'decline',note:'Не та сумма'});
  assert.equal(d.records[0].status,'cancelled');assert.equal(f.db.get('SELECT dedupe FROM records WHERE id=?',g.records[0].id).dedupe,null);
  assert.match(notes(f,mama.id).at(-1).text,/отклонил/);assert.equal(notes(f,s1.id).length,0,'tenants never heard of the draft');
  add(f,f.owner,a,{period:D.nextMonth(PERIOD)});
  const g2=add(f,f.owner,a),r=g2.records[0];
  tx(f,()=>D.actionRecord(f.db,s1,r.id,{version:r.version,action:'claim'}));
  assert.throws(()=>change(f,mama,g2,{action:'update',amount:100000}),e=>e.status===409&&e.details.min_amount===150000);
});

test('Utilities approval over HTTP: approve is for the primary owner only',async t=>{
  const f=await httpFixture(t),{a,mama}=flat(f,{recurring_rent:false});
  f.setToken(createSession(f.db,mama.id).token);
  const made=await f.api(`/api/apartments/${a.id}/utilities`,{method:'POST',body:{period:PERIOD,amount:300000,due:DUE}});
  assert.equal(made.status,200);assert.equal(made.data.records[0].payload.approval,'pending');
  const versions=Object.fromEntries(made.data.records.map(r=>[r.id,r.version]));
  assert.equal((await f.api(`/api/utilities/${made.data.group_id}`,{method:'POST',body:{action:'approve',versions}})).status,403);
  await f.login('owner');
  const ok=await f.api(`/api/utilities/${made.data.group_id}`,{method:'POST',body:{action:'approve',versions}});
  assert.equal(ok.status,200);assert.equal(ok.data.records[0].visibility,'shared');
});
