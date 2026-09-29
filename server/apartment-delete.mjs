/** Destructive apartment removal: explicit confirmation, ownership and snapshot checks.
 * The HTTP layer runs deleteApartment inside BEGIN IMMEDIATE and queues physical
 * cleanup only AFTER commit. No filesystem work happens in the transaction.
 */
import { fail, hash } from './auth.mjs';
import * as V from './validate.mjs';

function graph(db, user, id) {
    const apartment = db.get('SELECT * FROM apartments WHERE id=? AND owner_id=?', id, user.id);
    if (!apartment) fail(404, 'Квартира не найдена.');
    if (user.role !== 'owner') fail(403, 'Удалить квартиру можно только из кабинета собственника.');
    const leases = db.all('SELECT * FROM leases WHERE apartment_id=? ORDER BY id', id);
    const members = db.all('SELECT lm.* FROM lease_members lm JOIN leases l ON l.id=lm.lease_id WHERE l.apartment_id=? ORDER BY lm.lease_id,lm.user_id', id);
    const units = db.all('SELECT * FROM rental_units WHERE apartment_id=? ORDER BY id', id);
    const records = db.all('SELECT * FROM records WHERE apartment_id=? ORDER BY id', id);
    const files = db.all('SELECT * FROM files WHERE apartment_id=? ORDER BY id', id);
    const covers = db.all('SELECT * FROM apartment_covers WHERE apartment_id=? ORDER BY id', id);
    const meters = db.all('SELECT * FROM meters WHERE apartment_id=? ORDER BY id', id);
    const invites = db.all('SELECT i.* FROM invites i JOIN leases l ON l.id=i.lease_id WHERE l.apartment_id=? ORDER BY i.hash', id);
    const rules = db.all('SELECT rr.* FROM recurring_rules rr JOIN leases l ON l.id=rr.lease_id WHERE l.apartment_id=? ORDER BY rr.id', id);
    // These are part of the snapshot: a new comment/upload/payment after opening
    // the confirmation requires the owner to read a fresh confirmation first.
    const comments = db.all('SELECT c.* FROM comments c JOIN records r ON r.id=c.record_id WHERE r.apartment_id=? ORDER BY c.id', id);
    const events = db.all('SELECT * FROM events WHERE apartment_id=? ORDER BY id', id);
    const values = db.all('SELECT v.* FROM meter_values v JOIN meters m ON m.id=v.meter_id WHERE m.apartment_id=? ORDER BY v.meter_id,v.period', id);
    const revisions = db.all('SELECT v.* FROM recurring_revisions v JOIN recurring_rules rr ON rr.id=v.rule_id JOIN leases l ON l.id=rr.lease_id WHERE l.apartment_id=? ORDER BY v.rule_id,v.from_month', id);
    return { apartment, leases, members, units, records, files, covers, meters, invites, rules, comments, events, values, revisions };
}

function blockersFor(g) {
    const occupied = new Set(g.members.map(m => m.lease_id));
    for (const l of g.leases) if (l.tenant_id) occupied.add(l.id); // legacy safety
    const active = g.leases.filter(l => l.status !== 'ended' && occupied.has(l.id));
    const unsettled = g.records.filter(r => {
        const p = JSON.parse(r.payload);
        if (r.kind === 'purchase') return ['pending', 'approved'].includes(r.status);
        if (r.kind !== 'charge' || ['paid', 'cancelled'].includes(r.status)) return false;
        // Draft invoices without residents or any real payments may be removed
        // with an unused property. A real balance/claim must never be erased.
        return occupied.has(r.lease_id) || (p.confirmed || 0) > 0 || (p.claims || []).length > 0 || !!p.claim || (p.payments || []).length > 0;
    });
    const blockers = [];
    if (active.length) blockers.push({ code: 'active_tenants', count: active.length,
        message: 'В квартире или её комнатах есть действующие аренды с жильцами. Сначала завершите их через согласование с арендаторами.' });
    if (unsettled.length) blockers.push({ code: 'unsettled_finances', count: unsettled.length,
        message: 'Есть неурегулированные платежи, покупки или компенсации. Сначала завершите расчёты.' });
    return blockers;
}

function preview(g) {
    const blockers = blockersFor(g);
    return {
        id: g.apartment.id, title: g.apartment.title, address: g.apartment.address,
        version: g.apartment.version, confirmation_token: hash(JSON.stringify(g)),
        can_delete: blockers.length === 0, blockers,
        counts: { rooms: g.units.filter(u => u.kind === 'room').length, leases: g.leases.length,
            records: g.records.length, files: g.files.length, covers: g.covers.length,
            recurring_rules: g.rules.length, tenants: new Set([...g.members.map(m => m.user_id), ...g.leases.map(l => l.tenant_id).filter(Boolean)]).size },
        has_history: g.records.length > 0 || g.files.length > 0 || g.members.length > 0
    };
}

export function apartmentDeletionPreview(db, user, id) { return preview(graph(db, user, id)); }

/** Must be called inside db.tx. File names are internal, not part of the API response. */
export function deleteApartment(db, user, id, body) {
    const g = graph(db, user, id), p = preview(g);
    if (body.confirmed !== true) fail(400, 'Подтвердите удаление квартиры.');
    if (V.integer(body.version, 'Версия квартиры', 1) !== p.version || body.confirmation_token !== p.confirmation_token)
        fail(409, 'Данные квартиры изменились. Закройте окно и подтвердите удаление заново.');
    if (!p.can_delete) fail(409, p.blockers.map(b => b.message).join(' '));

    const recordIds = new Set(g.records.map(r => r.id));
    const leaseIds = new Set(g.leases.map(l => l.id));
    const inviteHashes = new Set(g.invites.map(i => i.hash));
    // Revoke pending messages and invite buttons scoped to this apartment only.
    for (const row of db.all('SELECT id,body FROM outbox')) {
        let b; try { b = JSON.parse(row.body); } catch { continue; }
        const target = typeof b.target === 'string' ? b.target : '';
        const targetId = /^[rcm]_/.test(target) ? target.slice(2) : '';
        if (recordIds.has(b.recordId) || recordIds.has(targetId) || leaseIds.has(targetId) ||
            (typeof b.inviteCode === 'string' && inviteHashes.has(hash(b.inviteCode))))
            db.run('DELETE FROM outbox WHERE id=?', row.id);
    }
    db.run('DELETE FROM notifications WHERE record_id IN (SELECT id FROM records WHERE apartment_id=?)', id);
    db.run('DELETE FROM comments WHERE record_id IN (SELECT id FROM records WHERE apartment_id=?)', id);
    db.run('DELETE FROM events WHERE apartment_id=?', id);
    db.run('DELETE FROM files WHERE apartment_id=?', id);
    db.run('DELETE FROM meter_values WHERE meter_id IN (SELECT id FROM meters WHERE apartment_id=?) OR record_id IN (SELECT id FROM records WHERE apartment_id=?)', id, id);
    db.run('DELETE FROM meters WHERE apartment_id=?', id);
    db.run('DELETE FROM recurring_revisions WHERE rule_id IN (SELECT rr.id FROM recurring_rules rr JOIN leases l ON l.id=rr.lease_id WHERE l.apartment_id=?)', id);
    db.run('DELETE FROM recurring_rules WHERE lease_id IN (SELECT id FROM leases WHERE apartment_id=?)', id);
    db.run('DELETE FROM invites WHERE lease_id IN (SELECT id FROM leases WHERE apartment_id=?)', id);
    db.run('DELETE FROM lease_members WHERE lease_id IN (SELECT id FROM leases WHERE apartment_id=?)', id);
    db.run('DELETE FROM records WHERE apartment_id=?', id);
    db.run('DELETE FROM leases WHERE apartment_id=?', id);
    db.run('DELETE FROM rental_units WHERE apartment_id=?', id);
    // Cover and apartment reference each other. Break the forward reference first.
    db.run('UPDATE apartments SET cover_id=NULL WHERE id=?', id);
    db.run('DELETE FROM apartment_covers WHERE apartment_id=?', id);
    db.run('DELETE FROM apartments WHERE id=? AND owner_id=?', id, user.id);
    return { id, upload_keys: [...new Set([...g.files, ...g.covers].map(f => f.storage_key))] };
}
