// Extra data on top of seed-rich.mjs for design reviews, so every counter and list
// shows its real shape: co-owner «Мама» (Telegram 900100), a second tenant from MAX
// (Игорь, 5550002), a second apartment let by rooms with one tenant (Дмитрий, 900006)
// and a free room, pending tenant/co-owner links, a purchase, a visit and a document.
// Usage: node seed-polish.mjs <repo> <data_dir>   (after seed-rich.mjs, same data dir)
import { randomUUID } from 'node:crypto';
const [repo, dir] = process.argv.slice(2);
const SECRET = 'local-run-secret-local-run-secret-1234';
const { openDatabase } = await import(repo + '/server/db.mjs');
const D = await import(repo + '/server/domain.mjs');
const O = await import(repo + '/server/owners.mjs');
const { createUnit } = await import(repo + '/server/rental.mjs');
const { ensureTelegramUser, ensureMaxUser } = await import(repo + '/server/auth.mjs');
const db = openDatabase(dir), cfg = { timezone: 'Europe/Moscow' };
const user = id => db.get('SELECT * FROM users WHERE id=?', id);
const anna = db.get("SELECT * FROM users WHERE tg_id='777001'");
const flat = db.get('SELECT * FROM apartments WHERE owner_id=? ORDER BY created_at LIMIT 1', anna.id);
const lease = db.get("SELECT * FROM leases WHERE apartment_id=? AND status='active' LIMIT 1", flat.id);

// Co-owner by a personal link, plus one link still waiting.
const mama = db.tx(() => ensureTelegramUser(db, { id: '900100', name: 'Мама', allowsWrite: true }));
const own = db.tx(() => O.createOwnerInvite(db, anna, flat.id, { label: 'Мама', secret: SECRET }));
db.tx(() => O.joinOwnerInvite(db, user(mama.id), own.code));
db.tx(() => O.createOwnerInvite(db, anna, flat.id, { label: 'Брат', secret: SECRET }));

// Second tenant of the same lease comes from MAX.
const igor = db.tx(() => ensureMaxUser(db, { id: '5550002', name: 'Игорь Петров' }));
const inv = db.tx(() => D.createInvite(db, anna, lease.id, { label: 'Игорь', secret: SECRET }));
db.tx(() => D.joinInvite(db, user(igor.id), inv.code));
db.tx(() => D.createInvite(db, anna, lease.id, { label: 'Соседка Маша', secret: SECRET }));

// Records that make the lists look lived-in.
const olga = db.get("SELECT * FROM users WHERE tg_id='900005'");
db.tx(() => D.createRecord(db, olga, { lease_id: lease.id, kind: 'purchase', title: 'Новая лампа в коридор', payload: { amount: 129000, purchase_date: D.dateInZone(), description: 'Перегорела старая, купила в «Леруа».' } }, cfg));
const start = new Date(Date.now() + 3 * 86400000); start.setHours(11, 0, 0, 0); const end = new Date(+start + 3600000);
db.tx(() => D.createRecord(db, anna, { lease_id: lease.id, kind: 'visit', title: 'Посещение квартиры', payload: { start: start.toISOString(), end: end.toISOString(), reason: 'Проверить счётчики и кран на кухне' } }, cfg));
const pdf = randomUUID();
db.run('INSERT INTO files(id,apartment_id,lease_id,record_id,user_id,name,mime,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', pdf, lease.apartment_id, lease.id, null, anna.id, 'Договор аренды.pdf', 'application/pdf', 248000, pdf, D.nowISO());
db.tx(() => D.createRecord(db, anna, { lease_id: lease.id, kind: 'document', title: 'Договор аренды', payload: { category: 'contract' }, files: [pdf] }, cfg));

// Second apartment, let by rooms: one room with one tenant, one room free.
const garden = db.tx(() => D.createApartment(db, anna, { title: 'Комнаты на Садовой', address: 'Москва, ул. Садовая, 8, кв. 17', rooms: 3, area: 72, start: '2026-10-01', end: '2027-09-30', rent: 2800000, deposit: 2800000, terms: '', due_day: 10, meter_day: 25, rental_mode: 'rooms', unit_title: 'Комната у окна' }));
db.tx(() => createUnit(db, anna, garden.id, { kind: 'room', title: 'Маленькая комната' }));
const gLease = db.get("SELECT * FROM leases WHERE apartment_id=? AND status='active' LIMIT 1", garden.id);
const dima = db.tx(() => ensureTelegramUser(db, { id: '900006', name: 'Дмитрий Орлов', allowsWrite: true }));
const gi = db.tx(() => D.createInvite(db, anna, gLease.id, { label: 'Дмитрий', secret: SECRET }));
db.tx(() => D.joinInvite(db, user(dima.id), gi.code));
// Meters without starting numbers: the owner sees the «write the start» card, Дмитрий the photo form.
for (const [label, kind, unit] of [['Холодная вода', 'cold_water', 'м³'], ['Свет', 'electricity', 'кВт·ч']])
    db.tx(() => D.createMeter(db, anna, gLease.id, { label, kind, unit }));
console.log(JSON.stringify({ mama: mama.id, igor: igor.id, dima: dima.id, garden: garden.id }));
db.close();
