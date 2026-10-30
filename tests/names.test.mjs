import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,httpFixture,signedData,newUser} from './helpers.mjs';
import {validateInitData,cleanHandle} from '../server/auth.mjs';
import {processInbox} from '../server/bot.mjs';
import {enqueueTelegramUpdate} from '../server/telegram.mjs';
import * as D from '../server/domain.mjs';

const TG='123456:telegram-test-token-abcdefghijklmnopqrstu';
const tgUser=(extra={})=>JSON.stringify({id:777001,first_name:'Саня',last_name:'Петров',...extra});

test('Handles: initData username becomes a clean handle; junk is ignored',()=>{
  assert.equal(validateInitData(signedData('t',{user:tgUser({username:'sanya_p'})}),'t',{platform:'telegram'}).handle,'sanya_p');
  assert.equal(validateInitData(signedData('t',{user:tgUser()}),'t',{platform:'telegram'}).handle,undefined);
  assert.equal(cleanHandle('@sanya'),'sanya');assert.equal(cleanHandle('a b'),null);assert.equal(cleanHandle('<x>'),null);assert.equal(cleanHandle(42),null);
});

test('Handles: login refreshes the @handle, never a stored real name; a placeholder name is replaced; tenants see co-tenants\' handles',async t=>{
  const f=await httpFixture(t);Object.assign(f.config,{tgBotToken:TG,telegram:true});
  const login=async user=>(await f.api('/api/auth/telegram',{method:'POST',body:{initData:signedData(TG,{user})},auth:false})).data;
  let s=await login(tgUser({username:'sanya_p'}));
  assert.equal(s.user.handle,'sanya_p');assert.equal(s.user.name,'Саня Петров');
  s=await login(tgUser({first_name:'Александр',username:'alex_p'}));
  assert.equal(s.user.name,'Саня Петров','a real stored name is not overwritten (0.6 never rewrote names)');assert.equal(s.user.handle,'alex_p');
  f.setToken(s.token);
  const me=await f.api('/api/profile',{method:'POST',body:{name:'Саня П.',role:'tenant'}});assert.equal(me.data.name,'Саня П.');
  s=await login(tgUser({username:'sanya_new'}));
  assert.equal(s.user.name,'Саня П.','profile name wins over the messenger');assert.equal(s.user.handle,'sanya_new');
  s=await login(tgUser());
  assert.equal(s.user.handle,null,'username removed in Telegram → handle cleared');
  // A co-tenant sees the handle in people; nothing like an owner label exists.
  const sanya=f.db.get("SELECT * FROM users WHERE tg_id='777001'");f.db.run("UPDATE users SET handle='sanya_p' WHERE id=?",sanya.id);
  const i=f.db.tx(()=>D.createInvite(f.db,f.owner,f.lease.id));f.db.tx(()=>D.joinInvite(f.db,f.u(sanya.id),i.code));
  const st=D.bootstrap(f.db,f.tenant,f.config),person=st.people.find(p=>p.id===sanya.id);
  assert.deepEqual({...person},{id:sanya.id,name:'Саня П.',handle:'sanya_p'});
  assert.ok(st.people.every(p=>!('label' in p)));
});

test('Handles: an existing user with a custom name and no name_custom flag keeps it; a placeholder name is replaced',async t=>{
  const f=await httpFixture(t);Object.assign(f.config,{tgBotToken:TG,telegram:true});
  const login=async user=>(await f.api('/api/auth/telegram',{method:'POST',body:{initData:signedData(TG,{user})},auth:false})).data;
  const u=newUser(f.db,'Мой выбор');f.db.run("UPDATE users SET tg_id='777001',settings='{}',handle='old' WHERE id=?",u.id);
  let s=await login(tgUser({username:'fresh'}));
  assert.equal(s.user.name,'Мой выбор');assert.equal(s.user.handle,'fresh');
  f.db.run("UPDATE users SET name='Пользователь Telegram' WHERE id=?",u.id);
  s=await login(tgUser({username:'fresh'}));
  assert.equal(s.user.name,'Саня Петров');
});

test('Handles: bot updates refresh the handle too; placeholder names never overwrite a real one',t=>{
  const f=fixture(t),u=newUser(f.db,'Саня');f.db.run("UPDATE users SET tg_id='777002' WHERE id=?",u.id);
  enqueueTelegramUpdate(f.db,{update_id:9101,message:{message_id:1,date:1,chat:{id:777002,type:'private'},from:{id:777002,is_bot:false,first_name:'Саня',username:'sanya_k'},text:'/help'}});
  processInbox(f.db,f.config);
  assert.equal(f.u(u.id).handle,'sanya_k');
  enqueueTelegramUpdate(f.db,{update_id:9102,message:{message_id:2,date:1,chat:{id:777002,type:'private'},from:{id:777002,is_bot:false,first_name:''},text:'/help'}});
  processInbox(f.db,f.config);
  assert.equal(f.u(u.id).name,'Саня');assert.equal(f.u(u.id).handle,null);
});
