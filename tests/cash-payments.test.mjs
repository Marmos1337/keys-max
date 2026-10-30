import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,status,meterPhoto,newUser} from './helpers.mjs';
import {equalSplit,sharesOf,paidBy} from '../public/shares.js';
import * as D from '../server/domain.mjs';

function charge(f,amount=3000000){return f.create('charge',{amount,due:f.lease.start,period:f.lease.start.slice(0,7)},f.owner);}
const act=(f,r,action,who,body={})=>f.db.tx(()=>D.actionRecord(f.db,who,r.id,{version:f.db.get('SELECT version FROM records WHERE id=?',r.id).version,action,...body}));

test('Cash: tenant marks a hand-over with date and photo, owner confirms receipt → paid',t=>{
  const f=fixture(t),r=charge(f),photo=meterPhoto(f.db,f.lease,f.tenant);
  const claimed=act(f,r,'claim',f.tenant,{amount:3000000,method:'cash',paid_on:D.dateInZone(),note:'Отдала лично',files:[photo]});
  assert.equal(claimed.status,'claimed');const c=claimed.payload.claims[0];
  assert.equal(c.method,'cash');assert.equal(c.paid_on,D.dateInZone());assert.deepEqual(c.files,[photo]);
  assert.equal(f.db.get('SELECT record_id FROM files WHERE id=?',photo).record_id,r.id,'photo stays with the record');
  const note=f.db.get('SELECT text FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1',f.owner.id).text;
  assert.match(note,/передал наличными/);assert.match(note,/подтвердите получение/);
  const paid=act(f,claimed,'confirm',f.owner,{claim_id:c.id});
  assert.equal(paid.status,'paid');assert.equal(paid.payload.confirmed,3000000);assert.equal(paid.payload.payments[0].method,'cash');
  assert.match(f.db.get('SELECT text FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1',f.tenant.id).text,/Получено .* наличными — подтверждение/);
});

test('Cash: owner disputes with a reason; history keeps it; tenant can mark again',t=>{
  const f=fixture(t),r=charge(f);
  const claimed=act(f,r,'claim',f.tenant,{amount:3000000});
  assert.equal(claimed.payload.claims[0].method,'cash','cash is the default');
  assert.throws(()=>act(f,claimed,'reject',f.owner,{claim_id:claimed.payload.claims[0].id}),status(400),'a reason is required');
  const disputed=act(f,claimed,'reject',f.owner,{claim_id:claimed.payload.claims[0].id,note:'Получил 25 000, а не 30 000'});
  assert.equal(disputed.status,'pending');assert.equal(disputed.payload.disputes.length,1);assert.equal(disputed.payload.disputes[0].reason,'Получил 25 000, а не 30 000');
  const again=act(f,disputed,'claim',f.tenant,{amount:2500000,method:'cash'});
  assert.equal(again.status,'claimed');
  const partial=act(f,again,'confirm',f.owner,{claim_id:again.payload.claims[0].id});
  assert.equal(partial.status,'partial');assert.equal(partial.payload.confirmed,2500000);
});

test('Cash: owner records cash directly; future dates and other people are refused',t=>{
  const f=fixture(t),r=charge(f,1000000);
  const future=new Date(Date.now()+5*86400000).toISOString().slice(0,10);
  assert.throws(()=>act(f,r,'record_payment',f.owner,{amount:1000000,paid_on:future}),status(400));
  assert.throws(()=>act(f,r,'record_payment',f.tenant,{amount:1000000}),status(403));
  assert.throws(()=>act(f,r,'claim',f.owner,{amount:1000000}),status(403));
  assert.throws(()=>act(f,r,'claim',f.tenant,{amount:1000000,method:'barter'}),status(400));
  const paid=act(f,r,'record_payment',f.owner,{amount:1000000,method:'cash',payer_id:f.tenant.id});
  assert.equal(paid.status,'paid');assert.equal(paid.payload.payments[0].source,'owner_manual');assert.equal(paid.payload.payments[0].method,'cash');assert.ok(paid.payload.payments[0].paid_on);
});

// 0.7: shares, one-tap claim, withdraw, paying for another tenant, personal reminders.
function pair(f){const i=f.db.tx(()=>D.createInvite(f.db,f.owner,f.lease.id)),u=newUser(f.db,'Саня');f.db.tx(()=>D.joinInvite(f.db,u,i.code));f.db.run("UPDATE lease_members SET joined_at='2099-01-01T00:00:00.000Z' WHERE user_id=?",u.id);return f.u(u.id);}

test('Shares: rent and manual charges snapshot an equal split of the current tenants; legacy charges fall back',t=>{
  const f=fixture(t),second=pair(f),r=charge(f,3000100);
  assert.deepEqual(r.payload.shares,{[f.tenant.id]:1500100,[second.id]:1500000});
  const rule=f.db.tx(()=>D.createRecurringRule(f.db,f.owner,{lease_id:f.lease.id,title:'Интернет',amount:90100,due_day:28,advance_days:60,start_month:D.dateInZone().slice(0,7)},f.config));
  f.db.tx(()=>D.generateRecurring(f.db,f.config));
  const monthly=D.decode(f.db.get("SELECT * FROM records WHERE json_extract(payload,'$.rule_id')=?",rule.id));
  assert.deepEqual(monthly.payload.shares,{[f.tenant.id]:45100,[second.id]:45000});
  // A charge written by 0.6 has no snapshot.
  f.db.run("UPDATE records SET payload=json_remove(payload,'$.shares') WHERE id=?",r.id);
  const legacy=D.decode(f.db.get('SELECT * FROM records WHERE id=?',r.id));
  assert.deepEqual(sharesOf(legacy.payload,D.memberIds(f.db,f.lease.id)),equalSplit(legacy.payload.amount,[f.tenant.id,second.id]));
});

test('Claim without an amount = my remaining share; explicit amounts (0.6.1 client) still work up to what is left',t=>{
  const f=fixture(t),second=pair(f),r=charge(f);
  const mine=act(f,r,'claim',f.tenant);assert.equal(mine.payload.claims[0].amount,1500000);assert.equal(mine.payload.claims[0].method,'cash');
  const theirs=act(f,mine,'claim',second,{amount:1500000,method:'transfer'});assert.equal(theirs.payload.claims.length,2);
  const done=act(f,theirs,'confirm',f.owner,{claim_id:mine.payload.claims[0].id});
  assert.throws(()=>act(f,done,'claim',f.tenant),e=>e.status===409,'already waiting');
  const r2=charge(f),old=act(f,r2,'claim',f.tenant,{amount:3000000});assert.equal(old.payload.claims[0].amount,3000000,'old full-amount claim is accepted');
  const r3=charge(f),paid=act(f,r3,'record_payment',f.owner,{amount:1500000,payer_id:f.tenant.id});
  assert.equal(paid.payload.payments[0].for_user_id,f.tenant.id,'payer is credited by default');
  assert.throws(()=>act(f,paid,'claim',f.tenant),e=>e.status===409&&/доля уже оплачена/.test(e.message));
});

test('Withdraw: a tenant takes back their own pending mark, never someone else\'s',t=>{
  const f=fixture(t),second=pair(f),r=charge(f);
  const c=act(f,r,'claim',f.tenant),id=c.payload.claims[0].id;
  assert.throws(()=>act(f,c,'withdraw',second,{claim_id:id}),status(403));
  assert.throws(()=>act(f,c,'withdraw',f.owner,{claim_id:id}),status(403));
  const w=act(f,c,'withdraw',f.tenant,{claim_id:id});
  assert.equal(w.status,'pending');assert.equal(w.payload.claims.length,0);assert.equal(w.payload.claim,null);assert.equal(w.payload.withdrawn[0].id,id);
  assert.throws(()=>act(f,w,'withdraw',f.tenant,{claim_id:id}),status(409));
  assert.equal(act(f,w,'claim',f.tenant).status,'claimed','can mark again');
});

test('One tenant pays for the other: for_user_id must be a member and gets the credit',t=>{
  const f=fixture(t),second=pair(f),r=charge(f);
  assert.throws(()=>act(f,r,'claim',f.tenant,{for_user_id:f.other.id}),status(400));
  const c=act(f,r,'claim',f.tenant,{for_user_id:second.id});
  assert.equal(c.payload.claims[0].for_user_id,second.id);assert.equal(c.payload.claims[0].user_id,f.tenant.id);assert.equal(c.payload.claims[0].amount,1500000);
  const own=act(f,c,'claim',f.tenant);assert.equal(own.payload.claims.length,2,'a claim for myself is separate');
  const ok=act(f,own,'confirm',f.owner,{claim_id:c.payload.claims[0].id});
  assert.equal(paidBy(ok.payload,second.id),1500000);assert.equal(paidBy(ok.payload,f.tenant.id),0);
  const r2=charge(f),p=act(f,r2,'record_payment',f.owner,{amount:1000000,payer_id:f.tenant.id,for_user_id:second.id});
  assert.equal(p.payload.payments[0].user_id,f.tenant.id);assert.equal(p.payload.payments[0].for_user_id,second.id);
  assert.throws(()=>act(f,p,'record_payment',f.owner,{amount:100,for_user_id:f.other.id}),status(400));
});

test('Reminders: each tenant hears their own remainder; whoever paid or handed over is skipped; owners once',t=>{
  const f=fixture(t),second=pair(f),due=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
  const r=f.create('charge',{amount:3000000,due,period:due.slice(0,7)},f.owner);
  const paid=act(f,r,'record_payment',f.owner,{amount:1000000,payer_id:second.id});
  f.db.run('DELETE FROM notifications');
  f.db.tx(()=>D.generateRecurring(f.db,f.config));
  const of=id=>f.db.all('SELECT * FROM notifications WHERE user_id=? AND record_id=?',id,r.id);
  assert.equal(of(f.tenant.id).length,1);assert.match(of(f.tenant.id)[0].text,/Ваша доля: 15\s000\s₽\. Осталось оплатить: 15\s000\s₽/);
  assert.equal(of(second.id).length,1);assert.match(of(second.id)[0].text,/Осталось оплатить: 5\s000\s₽/);
  assert.equal(of(f.owner.id).length,1);assert.match(of(f.owner.id)[0].text,/Осталось подтвердить: 20\s000\s₽/);
  // Second Саня pays the rest, the first hands over cash: neither gets the next reminder.
  const rest=act(f,paid,'record_payment',f.owner,{amount:500000,payer_id:second.id});act(f,rest,'claim',f.tenant);
  f.db.run('DELETE FROM notifications');
  f.db.tx(()=>D.generateRecurring(f.db,f.config));
  assert.equal(of(f.tenant.id).length,0);assert.equal(of(second.id).length,0);
  assert.equal(of(f.owner.id).length,1);assert.equal(of(f.owner.id)[0].title,'Ожидается подтверждение оплаты');
});
