// «Забрал наличные»: a manager writes down cash taken from tenants in person, across every open
// charge of the apartment (rent, utilities, any month), oldest first, real amounts only. One DB
// transaction for all records, one summary message per tenant and one to the other managers.
// Undo restores the records exactly as they were, while nobody has changed them since.
import { randomUUID } from 'node:crypto';
import { fail } from './auth.mjs';
import * as V from './validate.mjs';
import { managedApartment, managerIds, memberIds } from './rental.mjs';
import { decode, event, pushNotification, nowISO, dateInZone, formatMoney, humanDate } from './domain.mjs';
import { debtOf, allocate, claimsOf } from '../public/shares.js';

const conflict = (message, details) => { const e = new Error(message); e.status = 409; e.details = details; throw e; };
const credited = x => x.for_user_id ?? x.user_id;
const statusOf = p => p.claims.length ? 'claimed' : p.confirmed === p.amount ? 'paid' : p.confirmed ? 'partial' : 'pending';
const who = (db, id) => { const x = db.get('SELECT name,handle FROM users WHERE id=?', id); return x ? x.name + (x.handle ? ` (@${x.handle})` : '') : 'Жилец'; };
const lease = (db, id) => db.get('SELECT * FROM leases WHERE id=?', id);

// Open shared charges of running leases where this person is a tenant.
export function openChargesOf(db, a, tenantId) {
    return db.all(`SELECT r.* FROM records r JOIN leases l ON l.id=r.lease_id JOIN lease_members lm ON lm.lease_id=l.id AND lm.user_id=?
        WHERE r.apartment_id=? AND r.kind='charge' AND r.visibility='shared' AND r.status IN ('pending','partial','claimed') AND l.status!='ended'`, tenantId, a.id)
        .map(decode).map(r => ({ ...r, members: memberIds(db, r.lease_id) }));
}

/** POST /api/apartments/:id/cash-collections {entries:[{tenant_id, amount, expected_owed}], paid_on?, note?} */
export function collectCash(db, u, apartmentId, b) {
    const a = managedApartment(db, u, apartmentId);
    if (!Array.isArray(b.entries) || !b.entries.length || b.entries.length > 20) fail(400, 'Укажите, у кого и сколько получено.');
    const zone = process.env.TZ || 'Europe/Moscow', paidOn = b.paid_on ? V.date(b.paid_on, 'Дата получения') : dateInZone(zone);
    if (paidOn > dateInZone(zone, Date.now() + 86400000)) fail(400, 'Дата получения не может быть в будущем.');
    const note = V.text(b.note, 'Комментарий', 1000, true), id = randomUUID(), at = nowISO(), seen = new Set(), before = new Map(), entries = [], helped = new Map();
    const titles = new Map();
    for (const raw of b.entries) {
        const e = V.own(raw), tenantId = V.text(e.tenant_id, 'Жилец', 80);
        if (seen.has(tenantId)) fail(400, 'Каждого жильца укажите один раз.');
        seen.add(tenantId);
        const amount = V.integer(e.amount, 'Полученная сумма', 1), expected = V.integer(e.expected_owed, 'Долг жильца', 0);
        if (!db.get("SELECT 1 FROM lease_members lm JOIN leases l ON l.id=lm.lease_id WHERE l.apartment_id=? AND lm.user_id=? AND l.status!='ended'", a.id, tenantId)) fail(400, 'Этот человек не снимает эту квартиру.');
        const debt = debtOf(openChargesOf(db, a, tenantId), tenantId);
        // The form showed an older debt (someone paid or a bill changed meanwhile): ask to look again.
        if (debt.total !== expected) conflict(`Долг ${who(db, tenantId)} уже изменился: сейчас ${formatMoney(debt.total)}. Проверьте сумму и запишите ещё раз.`, { tenant_id: tenantId, owed: debt.total });
        if (amount > debt.total) fail(400, `Получено больше долга: ${who(db, tenantId)} должен ${formatMoney(debt.total)}.`);
        const { lines } = allocate(debt.items, amount);
        for (const line of lines) {
            const r = decode(db.get('SELECT * FROM records WHERE id=?', line.id)), p = { ...r.payload };
            if (!before.has(r.id)) before.set(r.id, { status: r.status, payload: r.payload });
            titles.set(r.id, r.title);
            p.claims = claimsOf(p).map(c => ({ ...c, id: c.id || randomUUID() }));
            const payments = [], stamp = { confirmed_by: u.id, confirmed_at: at, source: 'owner_collection', collection_id: id };
            let left = line.amount;
            // The tenant's own hand-over marks become payments first (from_claim keeps the link).
            for (const c of p.claims.filter(c => credited(c) === tenantId)) {
                if (!left) break;
                const take = Math.min(c.amount, left);
                // Payments made from a claim keep the claim's paid_on, method and note.
                payments.push({ ...c, ...stamp, id: randomUUID(), amount: take, for_user_id: tenantId, from_claim: c.id, claimed_amount: c.amount });
                // A partly used claim stays open for the rest (undo restores the original from the snapshot).
                p.claims = c.amount > take ? p.claims.map(x => x.id === c.id ? { ...c, amount: c.amount - take } : x) : p.claims.filter(x => x.id !== c.id);
                if (c.user_id && c.user_id !== tenantId) helped.set(c.user_id + '|' + tenantId, { by: c.user_id, tenant: tenantId, amount: (helped.get(c.user_id + '|' + tenantId)?.amount || 0) + take });
                left -= take;
            }
            if (left) payments.push({ id: randomUUID(), amount: left, method: 'cash', paid_on: paidOn, user_id: tenantId, for_user_id: tenantId, note, files: [], ...stamp });
            p.confirmed += line.amount;
            if (p.confirmed > p.amount) fail(409, 'Сумма превышает остаток начисления. Обновите экран.');
            p.payments = [...(p.payments || []), ...payments];
            p.claim = p.claims[0] || null;
            db.run('UPDATE records SET status=?,payload=?,version=version+1,updated_at=? WHERE id=? AND version=?', statusOf(p), JSON.stringify(p), at, r.id, r.version);
            event(db, u, lease(db, r.lease_id), `${r.title}: получено наличными ${formatMoney(line.amount)} от ${who(db, tenantId)} — ${u.name}`, r.id);
        }
        entries.push({ tenant_id: tenantId, amount, lines: lines.map(l => ({ record_id: l.id, amount: l.amount })) });
    }
    const total = entries.reduce((n, e) => n + e.amount, 0);
    const snapshot = [...before].map(([recordId, x]) => ({ record_id: recordId, status: x.status, payload: x.payload, version: db.get('SELECT version FROM records WHERE id=?', recordId).version }));
    db.run('INSERT INTO cash_collections(id,apartment_id,created_by,created_at,paid_on,note,total,entries,snapshot) VALUES(?,?,?,?,?,?,?,?,?)', id, a.id, u.id, at, paidOn, note, total, JSON.stringify(entries), JSON.stringify(snapshot));
    const day = paidOn === dateInZone(zone) ? '' : `, ${humanDate(paidOn)}`;
    for (const e of entries) pushNotification(db, e.tenant_id, 'Записана оплата наличными', `Получено от вас наличными ${formatMoney(e.amount)}${day} — ${u.name}:\n${e.lines.map(l => `${titles.get(l.record_id)} — ${formatMoney(l.amount)}`).join('\n')}\n${a.title}`, e.lines[0]?.record_id || null);
    // Someone who marked a payment for another tenant hears that it was received.
    const managers = new Set(managerIds(db, a));
    for (const h of helped.values()) if (h.by !== u.id && !managers.has(h.by)) pushNotification(db, h.by, 'Записана оплата наличными', `Ваша отметка об оплате за ${who(db, h.tenant)} принята: получено наличными ${formatMoney(h.amount)}${day} — ${u.name}\n${a.title}`, null);
    for (const uid of managerIds(db, a)) if (uid !== u.id) pushNotification(db, uid, 'Записаны наличные', `${u.name}: получено наличными ${formatMoney(total)}${day}\n${entries.map(e => `${who(db, e.tenant_id)} — ${formatMoney(e.amount)}`).join('\n')}\n${a.title}`, null, null, 'events', { target: 'a_' + a.id });
    const records = snapshot.map(x => decode(db.get('SELECT * FROM records WHERE id=?', x.record_id)));
    return { collection_id: id, apartment_id: a.id, total, paid_on: paidOn, entries, versions: Object.fromEntries(records.map(r => [r.id, r.version])), records };
}

/** POST /api/cash-collections/:id/undo {versions:{record_id:version}} */
export function undoCollection(db, u, collectionId, b) {
    const c = db.get('SELECT * FROM cash_collections WHERE id=?', V.text(collectionId, 'Запись о наличных', 80));
    if (!c) fail(404, 'Запись о наличных не найдена.');
    const a = managedApartment(db, u, c.apartment_id);
    if (c.undone_at) fail(409, 'Эта запись о наличных уже отменена.');
    const snapshot = JSON.parse(c.snapshot), versions = V.own(b.versions), at = nowISO();
    const changedSince = 'После этой записи счета уже менялись, поэтому отменить её целиком нельзя. Исправьте оплату в самом счёте.';
    if (Object.keys(versions).length !== snapshot.length) fail(409, changedSince);
    for (const x of snapshot) {
        const r = db.get('SELECT version,lease_id FROM records WHERE id=?', x.record_id);
        if (!r || r.version !== x.version || versions[x.record_id] !== x.version) fail(409, changedSince);
        if (lease(db, r.lease_id).status === 'ended') fail(409, 'Аренда завершена. История доступна только для чтения.');
    }
    for (const x of snapshot) {
        // Back to the exact state before the collection: consumed hand-over marks are open again.
        db.run('UPDATE records SET status=?,payload=?,version=version+1,updated_at=? WHERE id=? AND version=?', x.status, JSON.stringify(x.payload), at, x.record_id, x.version);
        const r = decode(db.get('SELECT * FROM records WHERE id=?', x.record_id));
        event(db, u, lease(db, r.lease_id), `${r.title}: отменена запись о наличных — ${u.name}`, r.id);
    }
    db.run('UPDATE cash_collections SET undone_at=?,undone_by=? WHERE id=?', at, u.id, c.id);
    const entries = JSON.parse(c.entries), day = humanDate(c.paid_on);
    for (const e of entries) pushNotification(db, e.tenant_id, 'Отменена запись о наличных', `Запись о ${formatMoney(e.amount)} наличными от ${day} отменена — ${u.name}. Эти счета снова ждут оплаты.\n${a.title}`, e.lines[0]?.record_id || null);
    for (const uid of managerIds(db, a)) if (uid !== u.id) pushNotification(db, uid, 'Отменена запись о наличных', `${u.name}: отменена запись о ${formatMoney(c.total)} наличными от ${day}\n${a.title}`, null, null, 'events', { target: 'a_' + a.id });
    return { ok: true, collection_id: c.id, records: snapshot.map(x => decode(db.get('SELECT * FROM records WHERE id=?', x.record_id))) };
}
