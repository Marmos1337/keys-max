// The real 0.7 situation: Степан (Telegram 800001) owns «Квартира на Мира», co-owner «Екатерина» (800002)
// is a co-owner; two tenants are both called «Саня» — the first one has @sanya_p, the second has no
// @handle (800003, 800004). Rent for August–October, utilities for June–August (June settled),
// August rent paid, and one open «Отдал наличными» mark by Саня @sanya_p on the September rent.
// Usage: node seed-utilities.mjs <repo> <data_dir>   (fresh data dir; prints ids as JSON)
const [repo, dir] = process.argv.slice(2);
const SECRET = 'local-run-secret-local-run-secret-1234';
const { openDatabase } = await import(repo + '/server/db.mjs');
const D = await import(repo + '/server/domain.mjs');
const O = await import(repo + '/server/owners.mjs');
const { ensureTelegramUser } = await import(repo + '/server/auth.mjs');
const { createUtilities } = await import(repo + '/server/utilities.mjs');
const db = openDatabase(dir), cfg = { timezone: 'Europe/Moscow' };
const user = id => db.get('SELECT * FROM users WHERE id=?', id);
const rec = id => db.get('SELECT * FROM records WHERE id=?', id);

let stepan = db.tx(() => ensureTelegramUser(db, { id: '800001', name: 'Степан', handle: 'stepan_n', allowsWrite: true }));
db.run("UPDATE users SET role='owner' WHERE id=?", stepan.id); stepan = user(stepan.id);
const flat = db.tx(() => D.createApartment(db, stepan, { title: 'Квартира на Мира', address: 'Москва, проспект Мира, 41, кв. 12', rooms: 2, area: 48, start: '2026-06-01', end: '2027-05-31', rent: 4000000, deposit: 4000000, terms: 'Оплата наличными, Степан забирает раз в два месяца', due_day: 5, meter_day: 25, recurring_rent: false }));
const lease = db.get("SELECT * FROM leases WHERE apartment_id=? AND status='active' LIMIT 1", flat.id);

const mama = db.tx(() => ensureTelegramUser(db, { id: '800002', name: 'Екатерина', allowsWrite: true }));
db.run("UPDATE users SET role='owner' WHERE id=?", mama.id);
const own = db.tx(() => O.createOwnerInvite(db, stepan, flat.id, { label: 'Екатерина', secret: SECRET }));
db.tx(() => O.joinOwnerInvite(db, user(mama.id), own.code));

const join = (tg, handle) => {
    const t = db.tx(() => ensureTelegramUser(db, { id: tg, name: 'Саня', ...(handle ? { handle } : {}), allowsWrite: true }));
    const inv = db.tx(() => D.createInvite(db, stepan, lease.id, { secret: SECRET }));
    db.tx(() => D.joinInvite(db, user(t.id), inv.code));
    return user(t.id);
};
const sanyaP = join('800003', 'sanya_p'), sanya2 = join('800004', '');

const charge = (title, rub, due, period) => db.tx(() => D.createRecord(db, stepan, { lease_id: lease.id, kind: 'charge', title, payload: { amount: rub * 100, due, period } }, cfg));
const pay = (id, payer, rub) => db.tx(() => D.actionRecord(db, stepan, id, { version: rec(id).version, action: 'record_payment', amount: rub * 100, payer_id: payer.id, method: 'cash', paid_on: '2026-09-02' }));
const aug = charge('Аренда за август 2026', 40000, '2026-08-05', '2026-08');
charge('Аренда за сентябрь 2026', 40000, '2026-09-05', '2026-09');
charge('Аренда за октябрь 2026', 40000, '2026-10-05', '2026-10');
pay(aug.id, sanyaP, 20000); pay(aug.id, sanya2, 20000);

const util = (period, rub, due) => db.tx(() => createUtilities(db, stepan, flat.id, { period, amount: rub * 100, due, publish: true }));
const june = util('2026-06', 3200, '2026-07-10'), july = util('2026-07', 2980, '2026-08-10'), august = util('2026-08', 3450, '2026-09-10');
for (const r of june.records) { pay(r.id, sanyaP, 1600); pay(r.id, sanya2, 1600); }

// One open hand-over mark: Саня @sanya_p says he gave his half of the September rent.
const sept = db.get("SELECT * FROM records WHERE lease_id=? AND kind='charge' AND json_extract(payload,'$.period')='2026-09' AND json_extract(payload,'$.category') IS NULL", lease.id);
db.tx(() => D.actionRecord(db, sanyaP, sept.id, { version: sept.version, action: 'claim', method: 'cash' }));

console.log(JSON.stringify({ apartment: flat.id, lease: lease.id, stepan: stepan.id, mama: mama.id, sanya_p: sanyaP.id, sanya2: sanya2.id, july: july.group_id, august: august.group_id, august_record: august.records[0].id, sept: sept.id }));
db.close();
