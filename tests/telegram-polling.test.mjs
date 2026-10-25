import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fixture,httpFixture} from './helpers.mjs';
import {makeConfig} from '../server/config.mjs';
import {processInbox,processOutbox} from '../server/bot.mjs';
import {startTelegramPoller,acquireLock,releaseLock,storedOffset,storeUpdates,backoffMs,telegramHealth,ALLOWED_UPDATES} from '../server/telegram-poller.mjs';

const TG='123456:telegram-test-token-abcdefghijklmnopqrstu';
let id=5000;
const msg=(text,from=777001)=>({update_id:++id,message:{message_id:id,date:1,chat:{id:from,type:'private'},from:{id:from,is_bot:false,first_name:'Анна'},text}});
const press=(data,from=777001)=>({update_id:++id,callback_query:{id:'cbq'+id,from:{id:from,is_bot:false,first_name:'Анна'},message:{message_id:1,chat:{id:from,type:'private'}},data}});

// Minimal Bot API double: queue of updates, a webhook flag and a call log.
async function fakeTelegram(t,{webhook='',updates=[],hang=false}={}){
  const calls=[];let pending=[...updates],hook=webhook;
  const server=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    const method=req.url.split('/').at(-1),body=JSON.parse(raw||'{}');calls.push({method,body,path:req.url});
    const send=(result,ok=true,extra={})=>{res.writeHead(ok?200:extra.error_code||400,{'Content-Type':'application/json'});res.end(JSON.stringify(ok?{ok,result}:{ok,...extra}));};
    if(!req.url.startsWith('/bot'+TG+'/'))return send(null,false,{error_code:401,description:'Unauthorized'});
    if(method==='getWebhookInfo')return send({url:hook,pending_update_count:pending.length});
    if(method==='deleteWebhook'){assert.equal(body.drop_pending_updates,false);hook='';return send(true);}
    if(method==='getUpdates'){
      if(hook)return send(null,false,{error_code:409,description:"Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"});
      if(body.offset!==undefined)pending=pending.filter(u=>u.update_id>=body.offset);
      if(pending.length)return send(pending);
      if(hang)return; // emulate a long poll that never returns
      return setTimeout(()=>send([]),30);
    }
    if(method==='sendMessage')return send({message_id:1});
    send(true);
  });});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  return {calls,base:'http://127.0.0.1:'+server.address().port,push:u=>pending.push(u),get webhook(){return hook;}};
}
function tg(t,api){const f=fixture(t);Object.assign(f.config,{tgBotToken:TG,telegram:true,tgBotUsername:'rentkeysbot',publicUrl:'https://keys.example.org',tgApiBase:api.base,tgMode:'polling'});f.config.botToken='';return f;}
const until=async(fn,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,20));}throw Error('timeout waiting for condition');};

test('Polling config: default mode is polling, webhook secret optional there, required for webhook',()=>{const base={APP_MODE:'production',SESSION_SECRET:'x'.repeat(32),PUBLIC_URL:'https://example.org',OPERATOR_NAME:'Example',SUPPORT_EMAIL:'support@example.org',PRIVACY_URL:'https://example.org/privacy',TERMS_URL:'https://example.org/terms',KEYS_TG_BOT_TOKEN:TG,KEYS_TG_BOT_USERNAME:'rentkeysbot'};assert.equal(makeConfig(base).tgMode,'polling');assert.throws(()=>makeConfig({...base,KEYS_TG_MODE:'webhook'}),/KEYS_TG_WEBHOOK_SECRET/);assert.equal(makeConfig({...base,KEYS_TG_MODE:'webhook',KEYS_TG_WEBHOOK_SECRET:'w'.repeat(40)}).tgMode,'webhook');assert.throws(()=>makeConfig({...base,KEYS_TG_MODE:'push'}),/KEYS_TG_MODE/);});

test('Polling: removes the webhook without dropping pending updates, answers /start and /help, persists offset',async t=>{
  const pending=[msg('/start'),msg('/help')],api=await fakeTelegram(t,{webhook:'https://keys.example.org/api/telegram/webhook',updates:pending}),f=tg(t,api);
  let kicked=0;const p=startTelegramPoller(f.db,f.config,{pollTimeout:1,onUpdates:()=>kicked++});t.after(()=>p.stop());
  await until(()=>f.db.get("SELECT COUNT(*) n FROM webhook_inbox WHERE id LIKE 'tg:%'").n===2);
  assert.equal(api.webhook,'');
  assert.deepEqual(api.calls.slice(0,2).map(c=>c.method),['getWebhookInfo','deleteWebhook']);
  const poll=api.calls.find(c=>c.method==='getUpdates');assert.equal(poll.body.timeout,1);assert.deepEqual(poll.body.allowed_updates,ALLOWED_UPDATES);
  assert.equal(storedOffset(f.db),pending[1].update_id+1);assert.ok(kicked>=1);
  await until(()=>api.calls.some(c=>c.method==='getUpdates'&&c.body.offset===pending[1].update_id+1));
  processInbox(f.db);await processOutbox(f.db,f.config);await processOutbox(f.db,f.config);
  const sent=api.calls.filter(c=>c.method==='sendMessage');
  assert.equal(sent.length,2);assert.equal(sent[0].body.chat_id,'777001');assert.match(sent[0].body.text,/Ключи/);assert.match(sent[1].body.text,/Помощь/);
  assert.equal(sent[0].body.reply_markup.inline_keyboard[0][0].web_app.url,'https://keys.example.org/');
  assert.equal(telegramHealth().state,'polling');assert.equal(telegramHealth().updates,2);
  await p.stop();assert.equal(telegramHealth(),null);
});

test('Polling: an update delivered twice (restart before confirmation) is processed once; callbacks are answered',async t=>{
  const u=press('noop'),api=await fakeTelegram(t,{updates:[u]}),f=tg(t,api);
  assert.equal(storeUpdates(f.db,[u,u]),2);storeUpdates(f.db,[u]);
  assert.equal(f.db.get("SELECT COUNT(*) n FROM webhook_inbox WHERE id LIKE 'tg:%'").n,1);
  processInbox(f.db);await processOutbox(f.db,f.config);
  assert.deepEqual(api.calls.map(c=>c.method),['answerCallbackQuery','sendMessage']);
});

test('Polling: single-instance lease; expired lease is taken over; release frees it',t=>{
  const f=fixture(t),now=Date.now();
  assert.equal(acquireLock(f.db,'a',1000,now),true);
  assert.equal(acquireLock(f.db,'b',1000,now+10),false);
  assert.equal(acquireLock(f.db,'a',1000,now+20),true,'holder renews');
  assert.equal(acquireLock(f.db,'b',1000,now+2000),true,'expired lease is taken over');
  releaseLock(f.db,'a');assert.equal(acquireLock(f.db,'a',1000,now+2100),false,'foreign release does not free');
  releaseLock(f.db,'b');assert.equal(acquireLock(f.db,'a',1000,now+2200),true);
});

test('Polling: stale offset is not trusted; backoff grows, honours retry_after and slows down on a bad token',t=>{
  const f=fixture(t);storeUpdates(f.db,[{update_id:42,message:{}}]);
  assert.equal(storedOffset(f.db),43);assert.equal(storedOffset(f.db,Date.now()+25*3600_000),undefined);
  assert.equal(backoffMs({retryAfter:7},1),7000);assert.equal(backoffMs({status:401},1),300000);
  assert.ok(backoffMs({},1)<=1200&&backoffMs({},6)>=25600&&backoffMs({},20)<=72000);
});

test('Polling: standby while another holder has the lease; stop() aborts a hanging long poll quickly',async t=>{
  const api=await fakeTelegram(t,{hang:true}),f=tg(t,api);
  acquireLock(f.db,'other',60_000);
  const p=startTelegramPoller(f.db,f.config,{pollTimeout:50,standbyMs:30});
  await until(()=>telegramHealth()?.state==='standby');
  assert.equal(api.calls.length,0,'standby poller does not call Telegram');
  releaseLock(f.db,'other');
  await until(()=>api.calls.some(c=>c.method==='getUpdates'));
  const started=Date.now();await p.stop();assert.ok(Date.now()-started<1000,'graceful stop must not wait for the long poll');
  assert.equal(acquireLock(f.db,'next',1000),true,'lease released on stop');
});

test('HTTP: health shows polling state; webhook route is off in polling mode and works in webhook mode',async t=>{
  const f=await httpFixture(t);Object.assign(f.config,{tgBotToken:TG,telegram:true,tgBotUsername:'rentkeysbot',tgWebhookSecret:'w'.repeat(40),tgMode:'polling'});
  const h=await f.api('/api/health',{auth:false});assert.equal(h.data.telegram.mode,'polling');assert.ok(!JSON.stringify(h.data).includes(TG));
  const off=await f.api('/api/telegram/webhook',{method:'POST',auth:false,headers:{'X-Telegram-Bot-Api-Secret-Token':'w'.repeat(40)},body:msg('/help')});assert.equal(off.status,404);
  f.config.tgMode='webhook';
  const on=await f.api('/api/telegram/webhook',{method:'POST',auth:false,headers:{'X-Telegram-Bot-Api-Secret-Token':'w'.repeat(40)},body:msg('/help')});assert.equal(on.status,200);
  assert.equal((await f.api('/api/health',{auth:false})).data.telegram.mode,'webhook');
});
