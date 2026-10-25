// Adds a Telegram tenant to the seeded owner's lease (for meters and payments runs).
// Usage: node seed-tenant.mjs <repo> <data_dir> <tg_id> <name>
const [repo, dir, tgId, name] = process.argv.slice(2);
const { openDatabase } = await import(repo + '/server/db.mjs');
const D = await import(repo + '/server/domain.mjs');
const { ensureTelegramUser } = await import(repo + '/server/auth.mjs');
const db = openDatabase(dir);
const owner = db.get("SELECT * FROM users WHERE tg_id='777001'");
const lease = db.get("SELECT l.* FROM leases l JOIN apartments a ON a.id=l.apartment_id WHERE a.owner_id=? AND l.status='active' LIMIT 1", owner.id);
const tenant = db.tx(() => ensureTelegramUser(db, { id: tgId, name, allowsWrite: true }));
if (!db.get('SELECT 1 FROM lease_members WHERE lease_id=? AND user_id=?', lease.id, tenant.id)) {
    const i = db.tx(() => D.createInvite(db, owner, lease.id));
    db.tx(() => D.joinInvite(db, tenant, i.code));
}
console.log(JSON.stringify({ lease: lease.id, tenant: tenant.id }));
db.close();
