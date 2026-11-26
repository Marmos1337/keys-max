// 0.7.1: who gets which reminder, when, and in what order.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,newUser,meterPhoto} from './helpers.mjs';
import * as D from '../server/domain.mjs';

const MSK=(day,hh='12:00')=>Date.parse(`${day}T${hh}:00+03:00`);
const shift=(day,n)=>new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const today=()=>D.dateInZone('Europe/Moscow');
const run=(f,time)=>f.db.tx(()=>D.generateRecurring(f.db,f.config,time));
const notes=(f,id,like='rem:%')=>f.db.all('SELECT * FROM notifications WHERE user_id=? AND dedupe LIKE ? ORDER BY created_at',id,like);
const old=(f,id)=>f.db.run("UPDATE records SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?",id);
function bill(f,due,amount=4000000,title){const r=f.create('charge',{amount,due,period:due.slice(0,7)},f.owner,title?{title}:{});old(f,r.id);return r;}
const act=(f,r,action,who,body={})=>f.db.tx(()=>D.actionRecord(f.db,who,r.id,{version:f.db.get('SELECT version FROM records WHERE id=?',r.id).version,action,...body}));
function telegram(f,...users){for(const u of users) f.db.run("UPDATE users SET tg_id=?,tg_bot_enabled=1 WHERE id=?",'tg-'+u.id,u.id);}

test('Daytime window: nothing scheduled goes out at night; at 9:00 it does, once',t=>{
  const f=fixture(t);f.config.notifyFrom=9;f.config.notifyTo=22;
  const d=today();bill(f,shift(d,3));
  f.db.run('DELETE FROM notifications');
  run(f,MSK(d,'03:00'));assert.equal(notes(f,f.tenant.id).length,0,'no reminders at 3 am');
  run(f,MSK(d,'22:30'));assert.equal(notes(f,f.tenant.id).length,0,'no reminders at 22:30');
  run(f,MSK(d,'09:01'));run(f,MSK(d,'15:00'));assert.equal(notes(f,f.tenant.id).length,1,'once, in the morning');
  assert.equal(D.daytimeAt(f.config,MSK(d,'12:00')),0);
  assert.equal(D.daytimeAt(f.config,MSK(d,'03:00')),MSK(d,'09:00'));
  assert.equal(D.daytimeAt(f.config,MSK(d,'23:15')),MSK(shift(d,1),'09:00'));
});

test('Daytime window: a monthly bill made at night waits in the outbox until 9:00',t=>{
  const f=fixture(t);f.config.notifyFrom=9;f.config.notifyTo=22;telegram(f,f.tenant);
  f.db.run("UPDATE recurring_rules SET advance_days=40");
  f.db.run('DELETE FROM outbox');
  const night=MSK(today(),'02:00');run(f,night);
  const rows=f.db.all("SELECT next_attempt FROM outbox WHERE user_id=?",f.tenant.id);
  assert.ok(rows.length>0,'the tenant hears about the new bill');
  assert.ok(rows.every(x=>x.next_attempt===MSK(today(),'09:00')),'delivered from 9:00, not at 2 am');
});

test('Payments: one message per tenant with every bill, oldest first; a week late; owners only the day after',t=>{
  const f=fixture(t),d=today();
  const nov=bill(f,shift(d,-7),4000000,'Аренда за ноябрь'),dec=bill(f,d,4000000,'Аренда за декабрь');
  f.db.run('DELETE FROM notifications');run(f,MSK(d));
  const mine=notes(f,f.tenant.id);
  assert.equal(mine.length,1,'one message, not one per bill');assert.equal(mine[0].title,'Просрочена оплата');
  assert.ok(mine[0].text.indexOf('ноябрь')<mine[0].text.indexOf('декабрь'),'oldest first');
  assert.match(mine[0].text,/Отдал наличными/);
  assert.equal(notes(f,f.owner.id).length,0,'owners: no «soon», no «today»');
  f.db.run('DELETE FROM notifications');run(f,MSK(shift(d,1)));
  const late=notes(f,f.owner.id).filter(n=>n.title==='Не оплачено в срок');
  assert.equal(late.length,1);assert.match(late[0].text,/Аренда за декабрь/);assert.doesNotMatch(late[0].text,/ноябрь/,'only the bill that just went late');
  assert.equal(notes(f,f.tenant.id).length,0,'tenants: no reminder the day after');
  void nov;void dec;
});

test('A bill created today is not reminded about the same day',t=>{
  const f=fixture(t),d=today();const r=f.create('charge',{amount:100000,due:d,period:d.slice(0,7)},f.owner);
  f.db.run('DELETE FROM notifications');run(f,MSK(d));
  assert.equal(notes(f,f.tenant.id).length,0);void r;
});

test('Cash marks: only owners are asked to confirm, a day after, a week after, then monthly; tenants never get «ждёт подтверждения»',t=>{
  const f=fixture(t),d=today(),r=bill(f,shift(d,20));
  const c=act(f,r,'claim',f.tenant,{method:'cash'});
  const p=c.payload;p.claims[0].at=MSK(shift(d,-1),'12:00')&&new Date(MSK(shift(d,-1))).toISOString();f.db.run('UPDATE records SET payload=? WHERE id=?',JSON.stringify(p),r.id);
  f.db.run('DELETE FROM notifications');run(f,MSK(d));
  const ask=notes(f,f.owner.id).filter(n=>n.title==='Наличные у жильцов');
  assert.equal(ask.length,1);assert.match(ask[0].text,/наличными/);assert.match(ask[0].text,/Забрал/);assert.match(ask[0].text,/Илья Соколов/);
  assert.equal(notes(f,f.tenant.id).length,0);
  for(const [n,expect] of [[1,0],[6,1],[7,0],[29,1],[30,0],[59,1]]) {f.db.run('DELETE FROM notifications');run(f,MSK(shift(d,n)));assert.equal(notes(f,f.owner.id).filter(x=>x.title==='Наличные у жильцов').length,expect,`day ${n+1} after the mark`);}
});

test('Cash mark notification: owners only; the tenant paid for hears it separately; no doubled name',t=>{
  const f=fixture(t),i=f.db.tx(()=>D.createInvite(f.db,f.owner,f.lease.id)),second=newUser(f.db,'Саня');f.db.tx(()=>D.joinInvite(f.db,second,i.code));
  const r=bill(f,shift(today(),20)),mate=second.id;
  f.db.run('DELETE FROM notifications');
  act(f,r,'claim',f.tenant,{method:'cash',for_user_id:mate,amount:100000});
  const own=f.db.all('SELECT * FROM notifications WHERE user_id=?',f.owner.id);
  assert.equal(own.length,1);assert.match(own[0].title,/передал наличными .* — подтвердите получение/);
  assert.equal(((own[0].title+'\n'+own[0].text).match(/Илья Соколов/g)||[]).length,1,'name once, in the title');assert.match(own[0].text,/^Начислено/);
  const theirs=f.db.all('SELECT * FROM notifications WHERE user_id=?',mate);
  assert.equal(theirs.length,1);assert.equal(theirs[0].title,'Илья Соколов отметил оплату за вас');assert.doesNotMatch(theirs[0].text,/подтвердите/);
});

test('Scheduled bill is announced as a bill, not as a message from the owner',t=>{
  const f=fixture(t);f.db.run("UPDATE recurring_rules SET advance_days=40");f.db.run('DELETE FROM notifications');
  run(f,Date.now());
  const n=f.db.all("SELECT * FROM notifications WHERE user_id=? AND record_id IS NOT NULL",f.tenant.id);
  assert.ok(n.length>0);assert.ok(n.every(x=>x.text.startsWith('Новое начисление: ')),n.map(x=>x.text).join('\n'));
});

function meterLease(f,day=25){f.db.run('UPDATE leases SET meter_day=?,meters_enabled=1 WHERE id=?',day,f.lease.id);return D.visibleMeters(f.db,f.lease);}
test('Meters: tenants are asked 3 days before and on the day; owners never asked to send, told the day after if nothing came',t=>{
  const f=fixture(t),d=today(),ym=d.slice(0,7);
  assert.ok(meterLease(f).length,'demo lease has meters');f.db.run('DELETE FROM meter_values WHERE period=?',ym);
  const at=n=>MSK(`${ym}-${String(n).padStart(2,'0')}`);
  f.db.run('DELETE FROM notifications');
  run(f,at(22));run(f,at(25));
  const tenant=notes(f,f.tenant.id,'meter:%');assert.deepEqual(tenant.map(n=>n.title),['Пора передать показания','Сегодня последний день для показаний']);
  assert.match(tenant[0].text,/Сфотографируйте счётчики/);
  assert.equal(notes(f,f.owner.id,'meter:%').length,0,'the owner is not asked to photograph meters');
  const missed=`meter-missed:${f.lease.id}:%`;
  run(f,at(26));
  assert.equal(notes(f,f.owner.id,missed).length,1);assert.match(notes(f,f.owner.id,missed)[0].text,/не передали показания/);
  run(f,at(26));assert.equal(notes(f,f.owner.id,missed).length,1,'once');
});

test('Meters: a lease ended by an accepted termination stops reminding',t=>{
  const f=fixture(t),d=today(),ym=d.slice(0,7);meterLease(f);f.db.run('DELETE FROM meter_values WHERE period=?',ym);
  f.db.run("INSERT INTO records(id,apartment_id,lease_id,kind,status,title,payload,visibility,version,created_by,created_at,updated_at) VALUES('term',?,?,'termination','accepted','Завершение',?,'shared',1,?,?,?)",f.lease.apartment_id,f.lease.id,JSON.stringify({date:`${ym}-01`}),f.owner.id,D.nowISO(),D.nowISO());
  f.db.run('DELETE FROM notifications');run(f,MSK(`${ym}-22`));
  assert.equal(notes(f,f.tenant.id,'meter:%').length,0);
});

test('Meters setup: several quick edits give each tenant one message asking for this month, listing every meter',t=>{
  const f=fixture(t);telegram(f,f.tenant);
  const ym=today().slice(0,7);f.db.run('DELETE FROM meter_values WHERE period=?',ym);f.db.run('DELETE FROM outbox');
  f.db.tx(()=>D.createMeter(f.db,f.owner,f.lease.id,{label:'Холодная вода',kind:'cold_water',unit:'м³',scope:'apartment'}));
  f.db.tx(()=>D.createMeter(f.db,f.owner,f.lease.id,{label:'Горячая вода',kind:'hot_water',unit:'м³',scope:'apartment'}));
  const q=f.db.all("SELECT * FROM outbox WHERE user_id=? AND status='queued'",f.tenant.id).map(x=>JSON.parse(x.body));
  assert.equal(q.length,1,'one message, the latest');
  assert.match(q[0].title,/^Пора передать показания за /);assert.match(q[0].text,/Холодная вода/);assert.match(q[0].text,/Горячая вода/);
  assert.ok(f.db.get("SELECT next_attempt FROM outbox WHERE user_id=?",f.tenant.id).next_attempt>Date.now()+4*60000,'sent a few minutes later');
  void meterPhoto;
});

test('Meters: «Показания не переданы» also when the day is the last of the month',t=>{
  const f=fixture(t);meterLease(f,31);
  const y=new Date().getUTCFullYear()+1;f.db.run("UPDATE leases SET start=?,end=? WHERE id=?",`${y}-01-01`,`${y+1}-12-31`,f.lease.id);
  f.db.run('DELETE FROM meter_values');f.db.run("UPDATE meters SET baseline_at=NULL");f.db.run('DELETE FROM notifications');
  run(f,MSK(`${y}-05-01`));
  const n=notes(f,f.owner.id,`meter-missed:${f.lease.id}:%`);
  assert.equal(n.length,1,'April has 30 days: the day after is 1 May');assert.match(n[0].text,/апрел/);
});

test('A legacy mark without a time does not break reminders for everybody',t=>{
  const f=fixture(t),d=today(),broken=bill(f,shift(d,20)),ok=bill(f,shift(d,3));
  const c=act(f,broken,'claim',f.tenant,{method:'cash'});const p=c.payload;delete p.claims[0].at;p.claim=p.claims[0];
  f.db.run('UPDATE records SET payload=? WHERE id=?',JSON.stringify(p),broken.id);
  f.db.run('DELETE FROM notifications');
  assert.doesNotThrow(()=>run(f,MSK(d)));
  assert.equal(notes(f,f.tenant.id).length,1,'the other bill is still reminded');void ok;
});

test('Config: bad notify hours fail at startup instead of silently breaking the window',async()=>{
  const {makeConfig}=await import('../server/config.mjs');
  for(const [from,to] of [['abc','22'],['22','9'],['-1','10'],['9','25']]) assert.throws(()=>makeConfig({APP_MODE:'test',KEYS_NOTIFY_FROM:from,KEYS_NOTIFY_TO:to}));
  assert.equal(makeConfig({APP_MODE:'test',KEYS_NOTIFY_FROM:'',KEYS_NOTIFY_TO:''}).notifyFrom,0,'empty = default');
});

test('Month-end digest: rent not yet due stays out, utilities of the month are in',t=>{
  const f=fixture(t),d=today(),[y,m]=d.split('-').map(Number),last=`${d.slice(0,7)}-${String(new Date(Date.UTC(y,m,0)).getUTCDate()).padStart(2,'0')}`;
  bill(f,shift(last,-3),4000000,'Аренда за этот месяц');bill(f,shift(last,5),4000000,'Аренда за следующий месяц');
  f.db.run('DELETE FROM notifications');run(f,MSK(last));
  const n=f.db.all("SELECT * FROM notifications WHERE user_id=? AND dedupe LIKE 'digest:%'",f.tenant.id);
  assert.equal(n.length,1);assert.match(n[0].text,/за этот месяц/);assert.doesNotMatch(n[0].text,/следующий/);
});

test('Water meters: a number without the comma (102996 m³) is refused with a hint; litres and normal numbers pass',t=>{
  const f=fixture(t),mk=b=>f.db.tx(()=>D.createMeter(f.db,f.owner,f.lease.id,{kind:'cold_water',unit:'м³',label:'Холодная вода',...b}));
  assert.throws(()=>mk({baseline:102996000}),e=>e.status===400&&/пропущена запятая/.test(e.message));
  assert.ok(mk({baseline:102996}).meters.length);
  assert.ok(mk({label:'Вода в литрах',unit:'л',baseline:102996000}).meters.length);
});
