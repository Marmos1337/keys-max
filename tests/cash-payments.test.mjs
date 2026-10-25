import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,status,meterPhoto} from './helpers.mjs';
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
