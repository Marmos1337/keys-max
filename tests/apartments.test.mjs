import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, httpFixture, newUser, apartmentInput, status } from './helpers.mjs';
import * as D from '../server/domain.mjs';
import { openDatabase } from '../server/db.mjs';
import { createSession, signTicket } from '../server/auth.mjs';
import { purgeUnboundUploads } from '../server/maintenance.mjs';
const image = readFileSync(new URL('../public/art/wordmark.png',import.meta.url));
const snapshot = f => f.db.get('SELECT * FROM apartments WHERE id=?',f.lease.apartment_id);
const update = (f,body,u=f.owner) => f.db.tx(()=>D.updateApartment(f.db,u,f.lease.apartment_id,{version:snapshot(f).version,...body}));
async function upload(f,bytes=image,name='photo.png') {
    const result=await f.api('/api/apartment-covers?name='+encodeURIComponent(name),{method:'POST',body:bytes,raw:true});
    assert.equal(result.status,200,JSON.stringify(result.data)); return result.data;
}
async function attach(f,id,extra={}) {
    const a=snapshot(f);
    return f.api('/api/apartments/'+a.id,{method:'POST',body:{version:a.version,cover_id:id,...extra}});
}

test('Apartment edit: real metadata update leaves active lease and payments unchanged',t=>{
    const f=fixture(t),a=snapshot(f),lease={...f.db.get('SELECT * FROM leases WHERE id=?',f.lease.id)};
    const records=f.db.all('SELECT * FROM records');
    const edited=update(f,{title:'Квартира на набережной',address:'Тестовый адрес, дом 7',rooms:3,area:74.2,photo:'owner',owner_id:f.tenant.id});
    assert.equal(edited.title,'Квартира на набережной'); assert.equal(edited.area,74.2);
    assert.equal(edited.owner_id,f.owner.id); assert.equal(edited.version,a.version+1);
    assert.deepEqual({...f.db.get('SELECT * FROM leases WHERE id=?',f.lease.id)},lease);
    assert.deepEqual(f.db.all('SELECT * FROM records'),records);
    assert.ok(D.bootstrap(f.db,f.tenant,f.config).events.some(e=>e.title==='Обновлена карточка квартиры'));
});
test('Apartment edit: tenant, stranger and role spoof cannot edit owner property',t=>{
    const f=fixture(t);
    assert.throws(()=>update(f,{title:'Hacked'},f.tenant),status(404));
    assert.throws(()=>update(f,{title:'Hacked'},f.other),status(404));
    assert.throws(()=>update(f,{title:'Hacked'},{...f.tenant,role:'owner'}),status(404));
});
test('Apartment edit: rejects stale version, invalid area and empty name',t=>{
    const f=fixture(t),old=snapshot(f);update(f,{title:'Новое название'});
    assert.throws(()=>update(f,{version:old.version,title:'Старое'}),status(409));
    assert.throws(()=>update(f,{area:0}),status(400));
    assert.throws(()=>update(f,{rooms:0}),status(400));
    assert.throws(()=>update(f,{title:''}),status(400));
    assert.equal(snapshot(f).title,'Новое название');
});
test('Apartment draft: dates and terms may be edited only before a tenant joins',t=>{
    const f=fixture(t),a=f.db.tx(()=>D.createApartment(f.db,f.owner,apartmentInput)),l=f.db.get('SELECT * FROM leases WHERE apartment_id=?',a.id);
    const changes={...apartmentInput,id:l.id,start:'2026-03-01',end:'2029-04-01',rent:7100000,deposit:1000000};
    f.db.tx(()=>D.updateApartment(f.db,f.owner,a.id,{version:a.version,lease:changes}));
    assert.equal(f.db.get('SELECT end FROM leases WHERE id=?',l.id).end,'2029-04-01');
    f.db.run('UPDATE leases SET tenant_id=? WHERE id=?',f.tenant.id,l.id);
    assert.throws(()=>f.db.tx(()=>D.updateApartment(f.db,f.owner,a.id,{version:2,lease:changes})),status(409));
});
test('Apartment draft: date validation rolls back metadata together',t=>{
    const f=fixture(t),a=f.db.tx(()=>D.createApartment(f.db,f.owner,apartmentInput)),l=f.db.get('SELECT * FROM leases WHERE apartment_id=?',a.id);
    assert.throws(()=>f.db.tx(()=>D.updateApartment(f.db,f.owner,a.id,{version:1,title:'Should not persist',lease:{...apartmentInput,id:l.id,end:'2025-01-01'}})),status(400));
    assert.equal(f.db.get('SELECT title FROM apartments WHERE id=?',a.id).title,apartmentInput.title);
});
test('HTTP apartment edit: idempotent double save increments version only once',async t=>{
    const f=await httpFixture(t);await f.login('owner');const a=snapshot(f),key=randomUUID();
    const args={method:'POST',key,body:{version:a.version,title:'Идемпотентное сохранение'}};
    const first=await f.api('/api/apartments/'+a.id,args),second=await f.api('/api/apartments/'+a.id,args);
    assert.equal(first.status,200);assert.deepEqual(first.data,second.data);assert.equal(snapshot(f).version,a.version+1);
    const stale=await f.api('/api/apartments/'+a.id,{method:'POST',body:{version:a.version,title:'Конфликт'}});assert.equal(stale.status,409);
});
test('Cover: secure image upload and atomic binding work for an existing property',async t=>{
    const f=await httpFixture(t);await f.login('owner');const photo=await upload(f);
    assert.equal((await attach(f,photo.id)).status,200);
    const state=(await f.api('/api/state')).data,a=state.apartments.find(a=>a.id===f.lease.apartment_id);
    assert.equal(a.cover_id,photo.id);assert.ok(a.cover_url.startsWith('/api/apartment-covers/'));
    const r=await fetch(f.config.publicUrl+a.cover_url);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');
    assert.equal(r.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await r.arrayBuffer()),image);
});
test('Cover: a staged photo can be attached while creating a new apartment',async t=>{
    const f=await httpFixture(t);await f.login('owner');const photo=await upload(f);
    const result=await f.api('/api/apartments',{method:'POST',body:{...apartmentInput,cover_id:photo.id}});
    assert.equal(result.status,200);assert.equal(result.data.cover_id,photo.id);
    assert.equal(f.db.get('SELECT apartment_id FROM apartment_covers WHERE id=?',photo.id).apartment_id,result.data.id);
});
test('Cover: wrong author or another property cannot reuse a bound upload',async t=>{
    const f=await httpFixture(t);await f.login('owner');const photo=await upload(f);await attach(f,photo.id);
    const second=f.db.get('SELECT * FROM apartments WHERE id<>?',f.lease.apartment_id);
    let r=await f.api('/api/apartments/'+second.id,{method:'POST',body:{version:second.version,cover_id:photo.id}});assert.equal(r.status,400);
    const stranger=newUser(f.db,'Посторонний собственник','owner'),a=f.db.tx(()=>D.createApartment(f.db,stranger,apartmentInput));
    f.setToken(createSession(f.db,stranger.id).token);
    r=await f.api('/api/apartments/'+a.id,{method:'POST',body:{version:1,cover_id:photo.id}});assert.equal(r.status,400);
});
test('Cover: active tenant may see but cannot change it; no public/stranger access',async t=>{
    const f=await httpFixture(t);await f.login('owner');const photo=await upload(f);await attach(f,photo.id);
    await f.login('tenant');const a=(await f.api('/api/state')).data.apartments[0];
    assert.ok(a.cover_url);assert.equal((await fetch(f.config.publicUrl+a.cover_url)).status,200);
    assert.equal((await f.api('/api/apartment-covers?name=a.png',{method:'POST',body:image,raw:true})).status,403);
    f.setToken(createSession(f.db,f.other.id).token);
    assert.equal((await f.api('/api/apartment-covers/'+photo.id+'/ticket',{method:'POST'})).status,404);
    assert.equal((await fetch(f.config.publicUrl+'/api/apartment-covers/'+photo.id+'/image')).status,401);
});
test('Cover: archived tenant loses current-photo access even with a previous ticket',async t=>{
    const f=await httpFixture(t);await f.login('owner');const photo=await upload(f);await attach(f,photo.id);
    await f.login('tenant');const url=(await f.api('/api/state')).data.apartments[0].cover_url;
    f.db.run("UPDATE leases SET status='ended' WHERE id=?",f.lease.id);
    const a=(await f.api('/api/state')).data.apartments[0];assert.equal(a.cover_url,null);assert.equal(a.cover_id,null);
    assert.equal((await fetch(f.config.publicUrl+url)).status,404);
});
test('Cover: replacement/reset invalidate previous image links',async t=>{
    const f=await httpFixture(t);await f.login('owner');const first=await upload(f);await attach(f,first.id);
    const url=(await f.api('/api/state')).data.apartments.find(a=>a.id===f.lease.apartment_id).cover_url;
    const second=await upload(f);await attach(f,second.id);assert.equal((await fetch(f.config.publicUrl+url)).status,404);
    await attach(f,null,{photo:'owner'});assert.equal(snapshot(f).cover_id,null);assert.equal(snapshot(f).photo,'owner');
});
test('Cover: file validation rejects spoofed extension, unsupported types and oversize',async t=>{
    const f=await httpFixture(t);await f.login('owner');
    for (const [bytes,name] of [[image,'fake.jpg'],[Buffer.from('<svg>not an apartment photo</svg>'),'x.svg'],[Buffer.from('%PDF-1.4____________________'),'x.pdf'],[Buffer.alloc(0),'empty.png']])
        assert.equal((await f.api('/api/apartment-covers?name='+name,{method:'POST',body:bytes,raw:true})).status,400);
    assert.equal((await f.api('/api/apartment-covers?name=big.png',{method:'POST',body:Buffer.alloc(10*1024*1024+1),raw:true})).status,413);
});
test('Cover: image tickets expire and exported JSON does not contain them',async t=>{
    const f=await httpFixture(t);await f.login('owner');const photo=await upload(f);await attach(f,photo.id);
    const exp=signTicket(f.config,f.owner.id,'cover:'+photo.id,Date.now()-1);
    assert.equal((await fetch(f.config.publicUrl+'/api/apartment-covers/'+photo.id+'/image?ticket='+exp)).status,401);
    const exported=JSON.stringify((await f.api('/api/export')).data);assert.ok(!exported.includes('ticket='));assert.ok(!exported.includes('storage_key'));
});
test('Cover maintenance: unused uploads expire, current photos persist',async t=>{
    const f=await httpFixture(t);await f.login('owner');const active=await upload(f),unused=await upload(f);await attach(f,active.id);
    f.db.run("UPDATE apartment_covers SET created_at='2020-01-01T00:00:00.000Z'");
    await purgeUnboundUploads(f.db,f.config);
    assert.ok(f.db.get('SELECT 1 FROM apartment_covers WHERE id=?',active.id));
    assert.ok(existsSync(path.join(f.dir,'uploads',active.id)));
    assert.equal(f.db.get('SELECT 1 FROM apartment_covers WHERE id=?',unused.id),undefined);
    assert.ok(!existsSync(path.join(f.dir,'uploads',unused.id)));
});

