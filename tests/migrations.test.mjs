import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../server/db.mjs';
import * as D from '../server/domain.mjs';
const rawSeed=(raw,version)=>{
 raw.exec(readFileSync(new URL(`./fixtures/schema-v${version}.sql`,import.meta.url),'utf8'));
 raw.exec(`INSERT INTO users(id,name,role,created_at) VALUES('owner','Собственник','owner','2026-01-01'),('tenant','Жилец','tenant','2026-01-01');
 INSERT INTO apartments(id,owner_id,title,address,rooms,area,created_at) VALUES('a','owner','Тестовая квартира','Синтетический адрес',2,50,'2026-01-01');
 INSERT INTO leases(id,apartment_id,tenant_id,start,end,rent,created_at) VALUES('l','a','tenant','2026-01-01','2030-12-31',6000000,'2026-01-01');
 INSERT INTO meters VALUES('m','l','Вода','м³',1000);
 INSERT INTO sessions VALUES('hash','tenant',9999999999999,'2026-01-01');`);
 const ym=D.dateInZone().slice(0,7),reading={period:ym,values:[{meter_id:'m',label:'Вода',value:4000,previous:1000,consumption:3000,unit:'м³'}]},payment={amount:6000000,confirmed:1000000,due:ym+'-05',period:ym,payments:[{amount:1000000,user_id:'tenant'}],claim:{amount:2000000,user_id:'tenant',note:'Старый перевод',at:'2026-01-01'}};
 const record=(id,kind,status,payload,dedupe=null)=>raw.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'a','l',kind,status,id,JSON.stringify(payload),'shared',2,'tenant','2026-01-01','2026-01-01',dedupe);
 record('r','reading','submitted',reading);record('p','charge','claimed',payment,`charge:l:${ym}`);
 raw.exec(`INSERT INTO files VALUES('f','a','l','r','tenant','photo.txt','text/plain',1,'f','2026-01-01');
 INSERT INTO comments VALUES('c','r','tenant','Сохранить комментарий','2026-01-01');
 INSERT INTO events VALUES('e','a','l','tenant','Событие','r','shared','2026-01-01');
 INSERT INTO invites VALUES('invite','l',9999999999999,NULL);`);
 if(version===2)raw.exec(`INSERT INTO apartment_covers VALUES('cover','owner','a','room.png','image/png',123,'cover','2026-01-01'); UPDATE apartments SET cover_id='cover',version=7;`);
 return payment;
};
for(const version of [1,2])test(`Real schema v${version} -> v3 preserves history, sessions, covers, pending payment and repeat-open`,()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'keys-migration-'));let raw,db;
 try {
  raw=new DatabaseSync(path.join(dir,'keys.sqlite'));raw.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');const original=rawSeed(raw,version);raw.close();raw=null;
  db=openDatabase(dir);assert.equal(db.get('SELECT version FROM schema_version').version,3);
  assert.equal(db.get('SELECT COUNT(*) n FROM lease_members').n,1);assert.equal(db.get('SELECT kind FROM rental_units').kind,'whole');
  for(const [table,count] of [['records',2],['files',1],['comments',1],['events',1],['sessions',1],['invites',1]])assert.equal(db.get('SELECT COUNT(*) n FROM '+table).n,count,table);
  assert.equal(db.get('SELECT value FROM meter_values').value,4000);
  let paid=D.decode(db.get("SELECT * FROM records WHERE id='p'")).payload;
  assert.equal(paid.confirmed,original.confirmed);assert.deepEqual(paid.payments,original.payments);assert.equal(paid.claims[0].id,'legacy_p_0');assert.equal(paid.rule_id,'rent_l');
  if(version===2){assert.equal(db.get("SELECT cover_id FROM apartments WHERE id='a'").cover_id,'cover');assert.equal(db.get("SELECT version FROM apartments WHERE id='a'").version,7);}
  const owner=db.get("SELECT * FROM users WHERE id='owner'");const r=db.tx(()=>D.actionRecord(db,owner,'p',{action:'confirm',claim_id:'legacy_p_0',version:2}));assert.equal(r.payload.confirmed,3000000);
  const before=db.get('SELECT COUNT(*) n FROM records').n;db.tx(()=>D.generateRecurring(db,{timezone:'Europe/Moscow'}));assert.equal(db.get("SELECT COUNT(*) n FROM records WHERE dedupe=?",`charge:l:${original.period}`).n,1);assert.ok(db.get('SELECT COUNT(*) n FROM records').n>=before);
  db.close();db=null;db=openDatabase(dir);assert.equal(db.get('SELECT COUNT(*) n FROM lease_members').n,1);assert.equal(D.decode(db.get("SELECT * FROM records WHERE id='p'")).payload.confirmed,3000000);assert.equal(db.get('PRAGMA integrity_check').integrity_check,'ok');
 } finally {try{raw?.close();}finally{db?.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}}
});
test('Unsupported schema closes handle and is never downgraded',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'keys-version-'));let db;
 try{db=openDatabase(dir);db.run('UPDATE schema_version SET version=999');db.close();db=null;assert.throws(()=>openDatabase(dir),/do not downgrade/);const raw=new DatabaseSync(path.join(dir,'keys.sqlite'));try{assert.equal(raw.prepare('SELECT version FROM schema_version').get().version,999);}finally{raw.close();}}
 finally{db?.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
