// Creates a rent charge on the seeded owner's lease. Usage: node seed-charge.mjs <repo> <data_dir> <title> <rubles>
const [repo, dir, title, rub] = process.argv.slice(2);
const { openDatabase } = await import(repo + '/server/db.mjs');
const D = await import(repo + '/server/domain.mjs');
const db = openDatabase(dir);
const owner = db.get("SELECT * FROM users WHERE tg_id='777001'");
const lease = db.get("SELECT l.* FROM leases l JOIN apartments a ON a.id=l.apartment_id WHERE a.owner_id=? AND l.status='active' LIMIT 1", owner.id);
const today = D.dateInZone();
const r = db.tx(() => D.createRecord(db, owner, { lease_id: lease.id, kind: 'charge', title, payload: { amount: Number(rub) * 100, due: today, period: today.slice(0, 7) } }, { timezone: 'Europe/Moscow' }));
console.log(JSON.stringify({ id: r.id }));
db.close();
