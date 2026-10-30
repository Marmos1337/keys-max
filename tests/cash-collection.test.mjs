import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,httpFixture,newUser,apartmentInput,status} from './helpers.mjs';
import {createSession} from '../server/auth.mjs';
import * as D from '../server/domain.mjs';
import * as O from '../server/owners.mjs';
import * as U from '../server/utilities.mjs';
import * as C from '../server/cash.mjs';
import {debtOf} from '../public/shares.js';

const tx=(f,fn)=>f.db.tx(fn);
let joined=0;
const invite=(f,l,u)=>{const i=tx(f,()=>D.createInvite(f.db,f.owner,l.id));tx(f,()=>D.joinInvite(f.db,u,i.code));f.db.run('UPDATE lease_members SET joined_at=? WHERE lease_id=? AND user_id=?',new Date(Date.UTC(2026,0,1)+(++joined)*1000).toISOString(),l.id,u.id);};
const PERIOD=D.dateInZone().slice(0,7),PREV=(()=>{const [y,m]=PERIOD.split('-').map(Number);return m===1?`${y-1}-12`:`${y}-${String(m-1).padStart(2,'0')}`;})();
// Rent 30 000 ₽ for last month and this month, utilities 3 000 ₽ this month; two tenants «Саня», mom is a co-owner.
function flat(f){
  const a=tx(f,()=>D.createApartment(f.db,f.owner,{...apartmentInput,recurring_rent:false})),l=f.db.get('SELECT * FROM leases WHERE apartment_id=?',a.id);
  const s1=newUser(f.db,'Саня'),s2=newUser(f.db,'Саня');invite(f,l,s1);invite(f,l,s2);
  const mama=newUser(f.db,'Мама','owner'),inv=tx(f,()=>O.createOwnerInvite(f.db,f.owner,a.id,{secret:f.config.secret}));tx(f,()=>O.joinOwnerInvite(f.db,mama,inv.code));
  const rent=(period,due)=>tx(f,()=>D.createRecord(f.db,f.owner,{lease_id:l.id,kind:'charge',title:'Аренда за '+period,payload:{amount:3000000,due,period}},f.config));
  const prev=rent(PREV,PREV+'-05'),cur=rent(PERIOD,PERIOD+'-05');
  const util=tx(f,()=>U.createUtilities(f.db,f.owner,a.id,{period:PERIOD,amount:300000,due:PERIOD+'-20',publish:true})).records[0];
  return {a,l,s1:f.u(s1.id),s2:f.u(s2.id),mama:f.u(mama.id),prev,cur,util};
}
const rec=(f,id)=>D.decode(f.db.get('SELECT * FROM records WHERE id=?',id));
const owed=(f,a,id)=>debtOf(C.openChargesOf(f.db,a,id),id).total;
const collect=(f,who,a,entries,extra={})=>tx(f,()=>C.collectCash(f.db,who,a.id,{entries,...extra}));
const entry=(f,a,u,amount)=>({tenant_id:u.id,amount,expected_owed:owed(f,a,u.id)});
const undo=(f,who,c,versions=c.versions)=>tx(f,()=>C.undoCollection(f.db,who,c.collection_id,{versions}));
const notes=(f,id)=>f.db.all('SELECT * FROM notifications WHERE user_id=? ORDER BY rowid',id);

test('Cash collection: a tenant\'s cash goes oldest first across rent and utilities, real amounts, one message each',t=>{
  const f=fixture(t),{a,s1,s2,mama,prev,cur,util}=flat(f);
  assert.equal(owed(f,a,s1.id),1500000+1500000+150000);
  f.db.run('DELETE FROM notifications');
  const c=collect(f,f.owner,a,[entry(f,a,s1,2000000)],{note:'Встретились у дома'});
  assert.equal(c.total,2000000);
  assert.deepEqual(c.entries,[{tenant_id:s1.id,amount:2000000,lines:[{record_id:prev.id,amount:1500000},{record_id:cur.id,amount:500000}]}]);
  const p1=rec(f,prev.id),p2=rec(f,cur.id);
  assert.equal(p1.status,'partial');assert.equal(p1.payload.confirmed,1500000);assert.equal(p2.payload.confirmed,500000);
  const pay=p1.payload.payments[0];
  assert.equal(pay.source,'owner_collection');assert.equal(pay.collection_id,c.collection_id);assert.equal(pay.for_user_id,s1.id);assert.equal(pay.user_id,s1.id);assert.equal(pay.method,'cash');assert.equal(pay.note,'Встретились у дома');assert.equal(pay.confirmed_by,f.owner.id);
  assert.equal(rec(f,util.id).payload.confirmed,0,'utilities (latest due) not reached');
  assert.equal(p1.version,prev.version+1);
  assert.deepEqual(c.versions,{[prev.id]:p1.version,[cur.id]:p2.version});
  assert.equal(owed(f,a,s1.id),1150000);assert.equal(owed(f,a,s2.id),3150000,'the other tenant still owes their own shares');
  const n=notes(f,s1.id);assert.equal(n.length,1,'one summary, no per-record notifications');assert.match(n[0].text,/Получено от вас наличными 20\s000\s₽/);assert.match(n[0].text,new RegExp('Аренда за '+PREV+' — 15\\s000\\s₽'));
  assert.equal(notes(f,s2.id).length,0);
  assert.equal(notes(f,mama.id).length,1);assert.match(notes(f,mama.id)[0].text,/Алексей Петров: получено наличными 20\s000\s₽/);
  assert.equal(notes(f,f.owner.id).length,0,'the actor is not notified');
  assert.equal(f.db.get('SELECT COUNT(*) n FROM events WHERE record_id IN (?,?)',prev.id,cur.id).n,4,'creation + one event per touched record');
});

test('Cash collection «у всех»: both tenants in one call close the shared bills; the tenant\'s own claim is consumed, others stay',t=>{
  const f=fixture(t),{a,s1,s2,prev,cur,util}=flat(f);
  const claimed=tx(f,()=>D.actionRecord(f.db,s1,util.id,{version:util.version,action:'claim'}));
  tx(f,()=>D.actionRecord(f.db,s2,util.id,{version:claimed.version,action:'claim',method:'transfer'}));
  // Collect from s1 only: his claim on utilities becomes a payment; s2's transfer claim stays open.
  const c=collect(f,f.owner,a,[entry(f,a,s1,3150000),entry(f,a,s2,3000000)]);
  const u=rec(f,util.id);
  assert.equal(u.status,'claimed');assert.equal(u.payload.claims.length,1);assert.equal(u.payload.claims[0].user_id,s2.id);
  const fromClaim=u.payload.payments.find(p=>p.from_claim);
  assert.equal(fromClaim.from_claim,claimed.payload.claims[0].id);assert.equal(fromClaim.amount,150000);assert.equal(fromClaim.source,'owner_collection');
  assert.equal(rec(f,prev.id).status,'paid');assert.equal(rec(f,cur.id).status,'paid');
  assert.equal(owed(f,a,s1.id),0);assert.equal(owed(f,a,s2.id),150000,'s2 has only the claimed utilities share left');
  assert.equal(new Set(JSON.parse(f.db.get('SELECT snapshot FROM cash_collections WHERE id=?',c.collection_id).snapshot).map(x=>x.record_id)).size,3);
  // Undo by the co-owner: everything back, consumed claim restored.
  const back=undo(f,f.db.get("SELECT * FROM users WHERE name='Мама'"),c);
  assert.equal(back.ok,true);
  const u2=rec(f,util.id);assert.equal(u2.payload.claims.length,2);assert.equal(u2.payload.confirmed,0);
  assert.equal(rec(f,prev.id).status,'pending');assert.equal(rec(f,prev.id).payload.payments.length,0);
  assert.ok(rec(f,prev.id).version>prev.version+1,'undo bumps the version too');
  assert.equal(owed(f,a,s1.id),3150000);
  assert.throws(()=>undo(f,f.owner,c,Object.fromEntries(back.records.map(r=>[r.id,r.version]))),e=>e.status===409&&/уже отменена/.test(e.message));
});

test('Cash collection: stale debt → 409, more than owed → 400, the whole batch is atomic',t=>{
  const f=fixture(t),{a,s1,s2,prev}=flat(f);
  assert.throws(()=>collect(f,f.owner,a,[{tenant_id:s1.id,amount:1000,expected_owed:1}]),e=>e.status===409&&e.details.owed===3150000);
  assert.throws(()=>collect(f,f.owner,a,[entry(f,a,s1,3150001)]),status(400));
  const before=rec(f,prev.id).version;
  assert.throws(()=>collect(f,f.owner,a,[entry(f,a,s1,1000000),{tenant_id:s2.id,amount:1000,expected_owed:5}]),status(409));
  assert.equal(rec(f,prev.id).version,before,'first entry rolled back with the failed second');
  assert.equal(f.db.get('SELECT COUNT(*) n FROM cash_collections').n,0);
});

test('Cash collection: validation and permissions',t=>{
  const f=fixture(t),{a,s1}=flat(f),future=new Date(Date.now()+5*86400000).toISOString().slice(0,10);
  assert.throws(()=>collect(f,s1,a,[entry(f,a,s1,100)]),status(403),'tenants cannot');
  assert.throws(()=>collect(f,newUser(f.db,'Чужой','owner'),a,[entry(f,a,s1,100)]),status(404));
  assert.throws(()=>collect(f,f.owner,a,[]),status(400));
  assert.throws(()=>collect(f,f.owner,a,[entry(f,a,s1,100),entry(f,a,s1,100)]),status(400),'one entry per tenant');
  assert.throws(()=>collect(f,f.owner,a,[{tenant_id:f.tenant.id,amount:100,expected_owed:0}]),status(400),'not a tenant of this apartment');
  assert.throws(()=>collect(f,f.owner,a,[entry(f,a,s1,0)]),status(400));
  assert.throws(()=>collect(f,f.owner,a,[entry(f,a,s1,100)],{paid_on:future}),status(400));
  const c=collect(f,f.owner,a,[entry(f,a,s1,100)],{paid_on:PREV+'-28'});
  assert.equal(c.paid_on,PREV+'-28');assert.match(notes(f,s1.id).at(-1).text,/, 28 /);
});

test('Cash collection undo: refused once a touched record changed since; stale versions refused',t=>{
  const f=fixture(t),{a,s1,s2,cur}=flat(f);
  const c=collect(f,f.owner,a,[entry(f,a,s1,2000000)]);
  assert.throws(()=>undo(f,f.owner,c,{}),status(409));
  const r=rec(f,cur.id);tx(f,()=>D.actionRecord(f.db,s2,r.id,{version:r.version,action:'claim'}));
  assert.throws(()=>undo(f,f.owner,c),e=>e.status===409&&/уже менялись/.test(e.message));
  assert.throws(()=>undo(f,s1,c),status(403));
  const st=D.bootstrap(f.db,f.owner,f.config);
  assert.equal(st.cash_collections[0].id,c.collection_id);assert.equal(st.cash_collections[0].total,2000000);
  assert.deepEqual(D.bootstrap(f.db,s1,f.config).cash_collections,[],'tenants never get collection records');
});

test('Cash collection over HTTP: idempotent replay, undo endpoint',async t=>{
  const f=await httpFixture(t),{a,s1,prev}=flat(f);
  await f.login('owner');
  const body={entries:[entry(f,a,s1,1500000)]},key='collect-key-0001';
  const first=await f.api(`/api/apartments/${a.id}/cash-collections`,{method:'POST',body,key});
  assert.equal(first.status,200);
  const replay=await f.api(`/api/apartments/${a.id}/cash-collections`,{method:'POST',body,key});
  assert.deepEqual(replay.data,first.data);
  assert.equal(f.db.get('SELECT COUNT(*) n FROM cash_collections').n,1);assert.equal(rec(f,prev.id).payload.payments.length,1);
  const stale=await f.api(`/api/apartments/${a.id}/cash-collections`,{method:'POST',body});
  assert.equal(stale.status,409);assert.equal(stale.data.details.owed,1650000);
  const back=await f.api(`/api/cash-collections/${first.data.collection_id}/undo`,{method:'POST',body:{versions:first.data.versions}});
  assert.equal(back.status,200);assert.equal(rec(f,prev.id).payload.payments.length,0);
  f.setToken(createSession(f.db,s1.id).token);
  assert.equal((await f.api(`/api/apartments/${a.id}/cash-collections`,{method:'POST',body})).status,403);
});

test('Cash collection: payer-less legacy money no longer blocks «у всех»; owed adds up to the remainder',t=>{
  const f=fixture(t),{a,s1,s2,util}=flat(f);
  const r=rec(f,util.id),p={...r.payload,confirmed:100000,payments:[{id:'old',amount:100000,method:'cash',user_id:null,for_user_id:null,confirmed_at:'2026-10-01'}]};
  f.db.run("UPDATE records SET status='partial',payload=?,version=version+1 WHERE id=?",JSON.stringify(p),util.id);
  const o1=owed(f,a,s1.id)-3000000/2*0,u1=debtOf(C.openChargesOf(f.db,a,s1.id).filter(x=>x.id===util.id),s1.id).total,u2=debtOf(C.openChargesOf(f.db,a,s2.id).filter(x=>x.id===util.id),s2.id).total;
  assert.equal(u1+u2,200000);assert.ok(o1>0);
  const c=collect(f,f.owner,a,[entry(f,a,s1,owed(f,a,s1.id)),entry(f,a,s2,owed(f,a,s2.id))]);
  assert.equal(rec(f,util.id).status,'paid');assert.equal(rec(f,util.id).payload.confirmed,300000);assert.ok(c.total>0);
  assert.equal(owed(f,a,s1.id)+owed(f,a,s2.id),0);
});

test('Cash collection: a partly used claim stays open for the rest; undo restores the original claim exactly',t=>{
  const f=fixture(t),{a,s1,util}=flat(f);
  const claimed=tx(f,()=>D.actionRecord(f.db,s1,util.id,{version:util.version,action:'claim'})),orig=claimed.payload.claims[0];
  assert.equal(orig.amount,150000);
  // The owner edits the total down underneath the claim: s1's share is now 400 ₽.
  const p={...claimed.payload,amount:80000,shares:{...claimed.payload.shares,[s1.id]:40000}};
  p.shares=Object.fromEntries(Object.keys(p.shares).map(k=>[k,40000]));
  f.db.run('UPDATE records SET payload=?,version=version+1 WHERE id=?',JSON.stringify(p),util.id);
  const before=rec(f,util.id).payload;
  const c=collect(f,f.owner,a,[entry(f,a,s1,owed(f,a,s1.id))]);
  const after=rec(f,util.id).payload,used=c.entries[0].lines.find(l=>l.record_id===util.id).amount;
  assert.equal(used,40000);
  assert.equal(after.claims.length,1,'the claim is not deleted');assert.equal(after.claims[0].id,orig.id);assert.equal(after.claims[0].amount,orig.amount-used);
  const pay=after.payments.find(x=>x.from_claim===orig.id);assert.equal(pay.claimed_amount,orig.amount);assert.equal(pay.paid_on,orig.paid_on,'payment keeps the claim\'s paid_on');assert.equal(pay.method,orig.method);
  undo(f,f.owner,c);
  assert.deepEqual(rec(f,util.id).payload,before,'undo restores the original claim and payload exactly');
});

test('Cash collection: claims of both tenants without for_user_id are both consumed in one call',t=>{
  const f=fixture(t),{a,s1,s2,util}=flat(f);
  const c1=tx(f,()=>D.actionRecord(f.db,s1,util.id,{version:util.version,action:'claim'}));
  const c2=tx(f,()=>D.actionRecord(f.db,s2,util.id,{version:c1.version,action:'claim'}));
  // Old-style claims: no for_user_id, credited to the claimant.
  const p={...c2.payload,claims:c2.payload.claims.map(({for_user_id,...c})=>c)};
  f.db.run('UPDATE records SET payload=?,version=version+1 WHERE id=?',JSON.stringify(p),util.id);
  collect(f,f.owner,a,[entry(f,a,s1,owed(f,a,s1.id)),entry(f,a,s2,owed(f,a,s2.id))]);
  const after=rec(f,util.id);
  assert.equal(after.payload.claims.length,0);assert.equal(after.payload.payments.filter(x=>x.from_claim).length,2);assert.equal(after.status,'paid');
});

test('Cash collection: when a claim made by A for B is consumed, A hears about it too',t=>{
  const f=fixture(t),{a,s1,s2,util}=flat(f);
  const claimed=tx(f,()=>D.actionRecord(f.db,s1,util.id,{version:util.version,action:'claim',for_user_id:s2.id}));
  assert.equal(claimed.payload.claims[0].user_id,s1.id);assert.equal(claimed.payload.claims[0].for_user_id,s2.id);
  f.db.run('DELETE FROM notifications');
  collect(f,f.owner,a,[entry(f,a,s2,owed(f,a,s2.id))]);
  assert.match(notes(f,s1.id).at(-1).text,/Ваша отметка об оплате за Саня.+принята: получено наличными 1\s500\s₽/);
  assert.equal(notes(f,s2.id).length,1);
});
