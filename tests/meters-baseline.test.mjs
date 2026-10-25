import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,httpFixture,status,meterPhoto} from './helpers.mjs';
import * as D from '../server/domain.mjs';

function setup(t){
  const f=fixture(t);
  const water=f.db.tx(()=>D.createMeter(f.db,f.owner,f.lease.id,{label:'Холодная вода',kind:'cold_water',unit:'м³',price:5120})).meters[0];
  const power=f.db.tx(()=>D.createMeter(f.db,f.owner,f.lease.id,{label:'Свет',kind:'electricity',unit:'кВт·ч'})).meters[0];
  return {...f,water,power};
}
const valuesFor=(f,map)=>D.visibleMeters(f.db,f.lease).filter(m=>!f.db.get('SELECT 1 FROM meter_values WHERE meter_id=? AND period=?',m.id,D.dateInZone(f.config.timezone).slice(0,7))).map(m=>({meter_id:m.id,value:map[m.id]??m.baseline}));

test('Meters: owner records starting readings without a photo; tenants are told what to do next',t=>{
  const f=setup(t);
  const r=f.db.tx(()=>D.setBaselines(f.db,f.owner,f.lease.id,{values:[{meter_id:f.water.id,value:123456},{meter_id:f.power.id,value:4500000}]}));
  assert.equal(r.meters.length,2);
  const w=f.db.get('SELECT * FROM meters WHERE id=?',f.water.id);assert.equal(w.baseline,123456);assert.ok(w.baseline_at);
  const note=f.db.get("SELECT * FROM notifications WHERE user_id=? AND title='Записаны стартовые показания'",f.tenant.id);
  assert.match(note.text,/123.456 м³/);assert.match(note.text,/с фото/);
  assert.throws(()=>D.setBaselines(f.db,f.tenant,f.lease.id,{values:[{meter_id:f.water.id,value:1}]}),e=>e.status===403||e.status===404);
  assert.throws(()=>D.setBaselines(f.db,f.owner,f.lease.id,{values:[{meter_id:'foreign',value:1}]}),status(400));
});

test('Meters: tenant reading needs a photo; consumption counts from the baseline; price gives the cost',t=>{
  const f=setup(t);
  f.db.tx(()=>D.setBaselines(f.db,f.owner,f.lease.id,{values:[{meter_id:f.water.id,value:100000},{meter_id:f.power.id,value:2000000}]}));
  const values=valuesFor(f,{[f.water.id]:103500,[f.power.id]:2150000});
  assert.throws(()=>f.db.tx(()=>D.createRecord(f.db,f.tenant,{lease_id:f.lease.id,kind:'reading',title:'Показания',payload:{values},files:[]},f.config)),e=>e.status===400&&/фото/.test(e.message));
  const txt='pdf-'+Date.now();f.db.run('INSERT INTO files(id,apartment_id,lease_id,record_id,user_id,name,mime,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',txt,f.lease.apartment_id,f.lease.id,null,f.tenant.id,'a.pdf','application/pdf',10,txt,D.nowISO());
  assert.throws(()=>f.db.tx(()=>D.createRecord(f.db,f.tenant,{lease_id:f.lease.id,kind:'reading',title:'Показания',payload:{values},files:[txt]},f.config)),e=>/фото/.test(e.message),'a PDF is not a photo');
  const r=f.db.tx(()=>D.createRecord(f.db,f.tenant,{lease_id:f.lease.id,kind:'reading',title:'Показания',payload:{values},files:[meterPhoto(f.db,f.lease,f.tenant)]},f.config));
  const water=r.payload.values.find(v=>v.meter_id===f.water.id),power=r.payload.values.find(v=>v.meter_id===f.power.id);
  assert.equal(water.previous,100000);assert.equal(water.consumption,3500);assert.equal(water.price,5120);assert.equal(water.cost,17920,'3.5 м³ × 51.20 ₽ = 179.20 ₽');
  assert.equal(power.consumption,150000);assert.equal(power.cost,undefined,'no price, no cost');
  assert.equal(f.db.get('SELECT COUNT(*) n FROM files WHERE record_id=?',r.id).n,1);
  assert.throws(()=>D.setBaselines(f.db,f.owner,f.lease.id,{values:[{meter_id:f.water.id,value:1}]}),e=>e.status===409&&/уже передавали/.test(e.message),'baseline is locked after the first reading');
});

test('Meters: price is optional, validated and editable; baseline date follows a manual change',t=>{
  const f=setup(t);
  assert.equal(f.water.price,5120);assert.equal(f.power.price,null);assert.equal(f.power.baseline_at,null,'no baseline entered yet');
  const upd=f.db.tx(()=>D.updateMeter(f.db,f.owner,f.power.id,{price:653,baseline:777000,version:f.power.version}));
  assert.equal(upd.price,653);assert.ok(upd.baseline_at);
  assert.throws(()=>D.updateMeter(f.db,f.owner,f.power.id,{price:-1,version:upd.version}),status(400));
  const cleared=f.db.tx(()=>D.updateMeter(f.db,f.owner,f.power.id,{price:null,version:upd.version}));assert.equal(cleared.price,null);
});

test('HTTP: meter-baselines route is owner-only and visible in state',async t=>{
  const f=await httpFixture(t);await f.login('owner');
  const lease=f.db.get("SELECT l.* FROM leases l JOIN apartments a ON a.id=l.apartment_id WHERE a.owner_id='demo-owner' AND l.status='active' LIMIT 1");
  const m=f.db.tx(()=>D.createMeter(f.db,f.u('demo-owner'),lease.id,{label:'Газ',kind:'gas',unit:'м³'})).meters[0];
  const r=await f.api('/api/leases/'+lease.id+'/meter-baselines',{method:'POST',body:{values:[{meter_id:m.id,value:5000}]}});
  assert.equal(r.status,200,JSON.stringify(r.data));
  const s=await f.api('/api/state');const sm=s.data.meters.find(x=>x.id===m.id);assert.equal(sm.baseline,5000);assert.ok(sm.baseline_at);
  await f.login('tenant');
  const denied=await f.api('/api/leases/'+lease.id+'/meter-baselines',{method:'POST',body:{values:[{meter_id:m.id,value:1}]}});
  assert.ok([403,404].includes(denied.status));
});
