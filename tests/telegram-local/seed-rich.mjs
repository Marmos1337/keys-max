// A lived-in dataset for screenshots (works with 0.4.0 and later):
// owner Анна (Telegram 777001) with «Квартира на Лесной», tenant Ольга (900005),
// three meters with starting values and this month's reading, a paid and a
// pending rent bill, an open repair request.
// Usage: node seed-rich.mjs <repo> <data_dir>
import { randomUUID } from 'node:crypto';
const [repo, dir] = process.argv.slice(2);
const { openDatabase } = await import(repo + '/server/db.mjs');
const D = await import(repo + '/server/domain.mjs');
const { ensureTelegramUser } = await import(repo + '/server/auth.mjs');
const db = openDatabase(dir), cfg = { timezone: 'Europe/Moscow' };
let owner = ensureTelegramUser(db, { id: '777001', name: 'Анна Морозова', allowsWrite: true });
db.run("UPDATE users SET role='owner' WHERE id=?", owner.id); owner = db.get('SELECT * FROM users WHERE id=?', owner.id);
db.tx(() => D.createApartment(db, owner, { title: 'Квартира на Лесной', address: 'Москва, ул. Лесная, 12, кв. 45', rooms: 2, area: 54, start: '2026-09-01', end: '2027-08-31', rent: 6500000, deposit: 6500000, terms: 'Оплата наличными до 5 числа', due_day: 5, meter_day: 25 }));
const lease = db.get("SELECT l.* FROM leases l JOIN apartments a ON a.id=l.apartment_id WHERE a.owner_id=? AND l.status='active' LIMIT 1", owner.id);
const tenant = db.tx(() => ensureTelegramUser(db, { id: '900005', name: 'Ольга Смирнова', allowsWrite: true }));
const inv = db.tx(() => D.createInvite(db, owner, lease.id)); db.tx(() => D.joinInvite(db, tenant, inv.code));
const t = db.get('SELECT * FROM users WHERE id=?', tenant.id);
const meters = [['Холодная вода', 'cold_water', 'м³', 123456], ['Горячая вода', 'hot_water', 'м³', 87300], ['Свет', 'electricity', 'кВт·ч', 4500000]]
    .map(([label, kind, unit, baseline]) => db.tx(() => D.createMeter(db, owner, lease.id, { label, kind, unit, baseline })).meters[0]);
const photo = randomUUID();
db.run('INSERT INTO files(id,apartment_id,lease_id,record_id,user_id,name,mime,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', photo, lease.apartment_id, lease.id, null, t.id, 'meters.jpg', 'image/jpeg', 1000, photo, D.nowISO());
db.tx(() => D.createRecord(db, t, { lease_id: lease.id, kind: 'reading', title: 'Показания', payload: { values: meters.map((m, i) => ({ meter_id: m.id, value: m.baseline + [3500, 1800, 152000][i] })) }, files: [photo] }, cfg));
const today = D.dateInZone(), month = today.slice(0, 7);
const sept = db.tx(() => D.createRecord(db, owner, { lease_id: lease.id, kind: 'charge', title: 'Аренда за сентябрь', payload: { amount: 6500000, due: '2026-09-05', period: '2026-09' } }, cfg));
db.tx(() => D.actionRecord(db, owner, sept.id, { version: 1, action: 'record_payment', amount: 6500000, payer_id: t.id, note: 'Наличными при встрече' }));
db.tx(() => D.createRecord(db, owner, { lease_id: lease.id, kind: 'charge', title: 'Аренда за октябрь', payload: { amount: 6500000, due: today, period: month } }, cfg));
db.tx(() => D.createRecord(db, t, { lease_id: lease.id, kind: 'ticket', title: 'Протекает кран на кухне', payload: { description: 'Капает под раковиной, подставила таз.', room: 'Кухня', priority: 'normal' } }, cfg));
console.log(JSON.stringify({ lease: lease.id, owner: owner.id, tenant: t.id }));
db.close();
