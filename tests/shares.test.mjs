import test from 'node:test';
import assert from 'node:assert/strict';
import {equalSplit,sharesOf,paidBy,waitingBy,owedBy,remainingBy,collectableBy,debtOf,allocate} from '../public/shares.js';

const total=o=>Object.values(o).reduce((n,x)=>n+x,0);

test('Shares: equal split in whole rubles, leftover rubles to the first people, kopecks to the first, exact sum',()=>{
  assert.deepEqual(equalSplit(300000,['a','b']),{a:150000,b:150000});
  assert.deepEqual(equalSplit(100100,['a','b']),{a:50100,b:50000},'1001 ₽ on two: the extra ruble goes to the first');
  assert.deepEqual(equalSplit(100050,['a','b','c']),{a:33450,b:33300,c:33300},'1000,50 ₽ on three: 1 ruble and 50 kopecks to the first');
  assert.deepEqual(equalSplit(1000200,['a','b','c']),{a:333400,b:333400,c:333400});
  assert.deepEqual(equalSplit(1000300,['a','b','c']),{a:333500,b:333400,c:333400});
  assert.deepEqual(equalSplit(99,['a','b']),{a:99,b:0});
  assert.deepEqual(equalSplit(12345,['solo']),{solo:12345});
  assert.deepEqual(equalSplit(1000,[]),{});
  assert.deepEqual(equalSplit(1000,['a','a','b']),{a:500,b:500},'duplicates count once');
  for(const n of [1,2,3,4,5]) for(const amount of [1,99,100,101,9999,1675050,300001]) {
    const ids=Array.from({length:n},(_,i)=>'p'+i),s=equalSplit(amount,ids);
    assert.equal(total(s),amount,`${amount} on ${n}`);
    assert.ok(Object.values(s).every(x=>Number.isSafeInteger(x)&&x>=0));
    assert.ok(Object.values(s).slice(1).every(x=>x%100===0),'only the first person carries kopecks');
  }
});

test('Shares: snapshot wins; a 0.6 charge without one falls back to an equal split of its amount',()=>{
  assert.deepEqual(sharesOf({amount:300000,shares:{a:100000,b:200000}},['a','b','c']),{a:100000,b:200000});
  assert.deepEqual(sharesOf({amount:300000},['a','b']),{a:150000,b:150000});
  assert.deepEqual(sharesOf({amount:300000,shares:{}},['a']),{a:300000},'an empty snapshot is not a snapshot');
});

test('Shares: payments and claims count for for_user_id, else for user_id; debt never exceeds what is unpaid',()=>{
  const p={amount:300000,confirmed:150000,shares:{a:150000,b:150000},payments:[{amount:150000,user_id:'a',for_user_id:'b'}],claims:[{id:'c1',amount:50000,user_id:'a'}]};
  assert.equal(paidBy(p,'b'),150000);assert.equal(paidBy(p,'a'),0);
  assert.equal(waitingBy(p,'a'),50000);assert.equal(waitingBy(p,'b'),0);
  assert.equal(owedBy(p,'a'),150000);assert.equal(owedBy(p,'b'),0);
  assert.equal(remainingBy(p,'a'),100000);
  assert.equal(owedBy({amount:300000,confirmed:300000,payments:[{amount:300000,user_id:null}]},'a',['a','b']),0,'legacy payment without a payer still closes the charge');
  assert.equal(waitingBy({amount:1000,confirmed:0,claim:{amount:400,user_id:'a'}},'a'),400,'0.5 single claim field');
});

test('Shares: collectable keeps other people\'s claims reserved and consumes the person\'s own claim',()=>{
  const p={amount:300000,confirmed:0,shares:{a:150000,b:150000},payments:[],claims:[{amount:150000,user_id:'b'},{amount:60000,user_id:'a'}]};
  assert.equal(collectableBy(p,'a'),150000);
  const tight={amount:300000,confirmed:0,shares:{a:150000,b:150000},payments:[],claims:[{amount:200000,user_id:'b'}]};
  assert.equal(collectableBy(tight,'a'),100000,'capped by amount − confirmed − other people\'s claims');
});

test('Shares: allocation goes oldest first by due then created_at, never above each cap, rest reported',()=>{
  const charges=[
    {id:'oct-util',status:'pending',created_at:'2026-10-02',payload:{amount:300000,confirmed:0,due:'2026-10-10',shares:{a:150000,b:150000},payments:[],claims:[]}},
    {id:'sep-rent',status:'partial',created_at:'2026-09-01',payload:{amount:3000000,confirmed:1500000,due:'2026-09-05',shares:{a:1500000,b:1500000},payments:[{amount:1500000,user_id:'b'}],claims:[]}},
    {id:'oct-rent',status:'pending',created_at:'2026-10-01',payload:{amount:3000000,confirmed:0,due:'2026-10-10',shares:{a:1500000,b:1500000},payments:[],claims:[]}},
    {id:'paid',status:'paid',created_at:'2026-08-01',payload:{amount:100,confirmed:100,due:'2026-08-01',shares:{a:100},payments:[],claims:[]}}
  ];
  const debt=debtOf(charges,'a');
  assert.deepEqual(debt.items.map(x=>[x.id,x.cap]),[['sep-rent',1500000],['oct-rent',1500000],['oct-util',150000]]);
  assert.equal(debt.total,3150000);
  assert.deepEqual(allocate(debt.items,2000000),{lines:[{id:'sep-rent',amount:1500000},{id:'oct-rent',amount:500000}],rest:0});
  assert.deepEqual(allocate(debt.items,4000000).rest,850000);
  assert.deepEqual(allocate(debt.items,0),{lines:[],rest:0});
  assert.equal(debtOf(charges,'b').total,1650000);
});
