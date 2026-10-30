import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,httpFixture,newUser,apartmentInput,status} from './helpers.mjs';
import {createSession} from '../server/auth.mjs';
import {createUnit} from '../server/rental.mjs';
import * as D from '../server/domain.mjs';
import * as O from '../server/owners.mjs';
import * as U from '../server/utilities.mjs';

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
const add=(f,who,a,body={})=>tx(f,()=>U.createUtilities(f.db,who,a.id,{period:PERIOD,amount:300000,due:DUE,...body}));
const change=(f,who,g,body)=>tx(f,()=>U.changeUtilities(f.db,who,g.group_id,{versions:Object.fromEntries(g.records.map(r=>[r.id,f.db.get('SELECT version FROM records WHERE id=?',r.id).version])),...body}));
const notes=(f,id)=>f.db.all('SELECT * FROM notifications WHERE user_id=? ORDER BY rowid',id);

test('Utilities: one amount split equally among tenants only, one charge per lease, everyone told their part',t=>{
  const f=fixture(t),{a,l,s1,s2,mama}=flat(f);
  f.db.run('DELETE FROM notifications');
  const g=add(f,mama,a,{note:'Свет и вода'});
  assert.equal(g.records.length,1);
  const r=g.records[0],p=r.payload;
  assert.equal(r.kind,'charge');assert.equal(r.lease_id,l.id);assert.equal(r.status,'pending');assert.equal(r.title,'Коммуналка за '+D.monthText(PERIOD));
  assert.equal(p.category,'utilities');assert.equal(p.group_id,g.group_id);assert.equal(p.amount,300000);assert.equal(p.confirmed,0);
  assert.deepEqual(p.shares,{[s1.id]:150000,[s2.id]:150000},'owner and co-owner never get a share');
  assert.equal(p.people_total,2);assert.equal(p.group_total,300000);assert.equal(p.note,'Свет и вода');
  assert.deepEqual(p.lines,[{label:'Коммуналка',amount:300000}]);assert.equal(p.amount,p.lines.reduce((n,x)=>n+x.amount,0));
  assert.equal(f.db.get('SELECT dedupe FROM records WHERE id=?',r.id).dedupe,`utilities:${a.id}:${PERIOD}:${l.id}`);
  for(const s of [s1,s2]) {const n=notes(f,s.id);assert.equal(n.length,1);assert.match(n[0].text,/всего 3\s000\s₽ на 2 человек, ваша доля 1\s500\s₽, до /);assert.equal(n[0].record_id,r.id);}
  assert.equal(notes(f,mama.id).length,0,'the actor is not notified');
  assert.match(notes(f,f.owner.id)[0].text,/внесена: 3\s000\s₽ — Мама/);
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
  const g=add(f,f.owner,a,{amount:300100});
  assert.equal(g.records.length,2);
  const [r1,r2]=[l1,l2].map(l=>g.records.find(r=>r.lease_id===l.id));
  assert.deepEqual(r1.payload.shares,{[alice.id]:100100,[bob.id]:100000});assert.equal(r1.payload.amount,200100);
  assert.deepEqual(r2.payload.shares,{[vera.id]:100000});assert.equal(r2.payload.amount,100000);
  assert.ok(g.records.every(r=>r.payload.group_total===300100&&r.payload.people_total===3&&r.payload.group_id===g.group_id));
  const st=D.bootstrap(f.db,vera,f.config);
  assert.deepEqual(st.records.filter(r=>r.payload.category==='utilities').map(r=>r.id),[r2.id]);
  assert.ok(!st.people.some(p=>p.id===alice.id||p.id===bob.id));
  assert.doesNotMatch(notes(f,vera.id).at(-1).text,/Алиса|Борис/);assert.match(notes(f,vera.id).at(-1).text,/на 3 человек, ваша доля 1\s000\s₽/);
});

test('Utilities: edit while untouched keeps the same people; a later joiner is not added; claims block edit and cancel',t=>{
  const f=fixture(t),{a,l,s1,s2}=flat(f),g=add(f,f.owner,a);
  const late=newUser(f.db,'Новенький');invite(f,l,late);
  const edited=change(f,f.owner,g,{action:'update',amount:400100,due:D.dueDate(D.nextMonth(PERIOD),15),note:''});
  const p=edited.records[0].payload;
  assert.deepEqual(p.shares,{[s1.id]:200100,[s2.id]:200000});assert.equal(p.amount,400100);assert.equal(p.group_total,400100);
  assert.deepEqual(p.lines,[{label:'Коммуналка',amount:400100}]);assert.equal(p.due,D.dueDate(D.nextMonth(PERIOD),15));
  assert.match(notes(f,s1.id).at(-1).text,/ваша доля 2\s001\s₽/);assert.equal(notes(f,late.id).filter(n=>n.record_id===p.id).length,0);
  assert.throws(()=>tx(f,()=>U.changeUtilities(f.db,f.owner,g.group_id,{action:'update',amount:1000,versions:{[g.records[0].id]:1}})),status(409),'stale version');
  assert.throws(()=>change(f,s1,g,{action:'cancel'}),status(403));
  const r=edited.records[0];
  tx(f,()=>D.actionRecord(f.db,s1,r.id,{version:r.version,action:'claim'}));
  assert.throws(()=>change(f,f.owner,g,{action:'update',amount:500000}),e=>e.status===409&&/уже есть оплаты/.test(e.message));
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
