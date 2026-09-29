import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture } from './helpers.mjs';
import { normalizeGuide, advanceGuide, mergeGuide, guideHidden, guideTopic } from '../public/guide-state.js';

test('Guide: fourth opening hides the prompt; prior openings do not', () => {
    let p = normalizeGuide();
    for (let i=1; i<=4; i++) { p=advanceGuide(p,'open'); assert.equal(guideHidden(p),i===4); }
    assert.equal(advanceGuide(p,'open').opens,4);
});
test('Guide: four distinct topics hide it, repeat visits/polling do not inflate progress', () => {
    let p=normalizeGuide();
    for(let i=0;i<20;i++) p=advanceGuide(p,'visit','documents');
    assert.deepEqual(p.topics,['documents']); assert.equal(guideHidden(p),false);
    for (const t of ['apartments','finances','requests']) p=advanceGuide(p,'visit',t);
    assert.equal(guideHidden(p),true);
    assert.equal(advanceGuide(p,'reload').topics.length,4);
});
test('Guide: dismissal and counters survive stale/out-of-order client updates', () => {
    const p=mergeGuide({opens:4,topics:['documents'],dismissed:true},{opens:0,topics:['requests'],dismissed:false});
    assert.equal(p.opens,4); assert.equal(p.dismissed,true); assert.deepEqual(p.topics,['documents','requests']);
});
test('Guide: tabs map to the same real sections, unknown pages do not count', () => {
    assert.equal(guideTopic('apartments','contract'),'documents');
    assert.equal(guideTopic('apartments','payments'),'finances');
    assert.equal(guideTopic('recurring'),'finances');
    assert.equal(guideTopic('home'),null); assert.equal(guideTopic('notifications'),null);
});
test('Guide API: authentication required, invalid payload rejected, settings and role unchanged',async t=>{
    const f=await httpFixture(t); const endpoint='/api/profile/guide';
    assert.equal((await f.api(endpoint,{method:'POST',body:{},auth:false})).status,401);
    await f.login('owner');
    assert.equal((await f.api(endpoint,{method:'POST',body:{role:'admin',progress:{opens:0,topics:[],dismissed:false}}})).status,400);
    assert.equal((await f.api(endpoint,{method:'POST',body:{role:'owner',progress:{opens:99,topics:[],dismissed:false}}})).status,400);
    assert.equal((await f.api(endpoint,{method:'POST',body:{role:'owner',progress:{opens:0,topics:['secret'],dismissed:false}}})).status,400);
    const r=await f.api(endpoint,{method:'POST',body:{role:'owner',progress:{opens:1,topics:['documents'],dismissed:false}}});
    assert.equal(r.status,200);
    assert.equal(f.u('demo-owner').role,'owner');
    assert.equal(JSON.parse(f.u('demo-owner').settings).guide_v1.owner.opens,1);
});
test('Guide API: separate progress per account and role, returning session keeps state',async t=>{
    const f=await httpFixture(t); await f.login('owner');
    const put=(role,p)=>f.api('/api/profile/guide',{method:'POST',body:{role,progress:p}});
    await put('owner',{opens:4,topics:[],dismissed:false});
    await put('tenant',{opens:1,topics:['apartments'],dismissed:false});
    await put('owner',{opens:0,topics:['documents'],dismissed:false});
    await f.login('owner'); let s=(await f.api('/api/state')).data;
    assert.equal(s.user.settings.guide_v1.owner.opens,4); assert.equal(s.user.settings.guide_v1.tenant.opens,1);
    const saved=await f.api('/api/profile',{method:'POST',body:{name:s.user.name,role:'owner',settings:{theme:'dark',events:false}}});
    assert.equal(saved.status,200); s=(await f.api('/api/state')).data;
    assert.equal(s.user.settings.guide_v1.owner.opens,4); assert.equal(s.user.settings.theme,'dark'); assert.equal(s.user.settings.events,false);
    await f.login('tenant');s=(await f.api('/api/state')).data;
    assert.equal(s.user.settings.guide_v1,undefined);
});
test('Guide API: idempotent retry and local progress sync do not resurrect hidden prompt',async t=>{
    const f=await httpFixture(t); await f.login('owner');
    const body={role:'owner',progress:{opens:2,topics:['apartments','documents','finances','requests'],dismissed:false}};
    const a=await f.api('/api/profile/guide',{method:'POST',body,key:'guide-idempotent'});
    const b=await f.api('/api/profile/guide',{method:'POST',body,key:'guide-idempotent'});
    assert.deepEqual(a.data,b.data); assert.equal(guideHidden(b.data.progress),true);
    const c=await f.api('/api/profile/guide',{method:'POST',body:{role:'owner',progress:{opens:0,topics:[],dismissed:false}}});
    assert.equal(guideHidden(c.data.progress),true);
});
