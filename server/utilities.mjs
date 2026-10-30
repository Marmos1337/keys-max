// Utilities («Коммуналка»): one amount a month for the whole apartment, split equally among the
// tenants of every running lease (owners and co-owners never get a share). Stored as one ordinary
// charge per lease (category 'utilities'), so claims, payments, reminders and 0.6 clients keep working.
// Each lease's record holds only its own tenants' shares; other rooms see the total and headcount.
import { randomUUID } from 'node:crypto';
import { fail } from './auth.mjs';
import * as V from './validate.mjs';
import { managedApartment, managerIds, memberIds, unitName } from './rental.mjs';
import { decode, event, pushNotification, nowISO, monthText, validMonth, formatMoney, humanDate } from './domain.mjs';
import { equalSplit } from '../public/shares.js';

const LINE = 'Коммуналка';
const persons = n => n % 10 === 1 && n % 100 !== 11 ? 'человека' : 'человек';
const conflict = (message, details) => { const e = new Error(message); e.status = 409; e.details = details; throw e; };
const clampDue = (due, lease) => due > lease.end ? lease.end : due < lease.start ? lease.start : due;
const touched = p => !!(p.confirmed || (p.payments || []).length || (p.claims || []).length || p.claim);

// Running leases with their tenants in a fixed order (lease creation, then joining); a person
// in two rooms of the same apartment pays one share, in the first lease.
function tenantGroups(db, a) {
    const managers = new Set(managerIds(db, a)), seen = new Set();
    return db.all("SELECT * FROM leases WHERE apartment_id=? AND status IN ('active','ending') ORDER BY created_at,id", a.id)
        .map(lease => ({ lease, tenants: memberIds(db, lease.id).filter(id => !managers.has(id) && !seen.has(id) && seen.add(id)) }))
        .filter(g => g.tenants.length);
}
function split(groups, total) {
    const shares = equalSplit(total, groups.flatMap(g => g.tenants));
    const parts = groups.map(g => { const own = Object.fromEntries(g.tenants.map(id => [id, shares[id]])); return { ...g, shares: own, amount: g.tenants.reduce((n, id) => n + own[id], 0) }; });
    if (parts.some(x => x.amount < 1)) fail(400, 'Сумма слишком мала, чтобы разделить её на всех жильцов.');
    return parts;
}
const groupRows = (db, groupId) => db.all("SELECT * FROM records WHERE kind='charge' AND json_extract(payload,'$.category')='utilities' AND json_extract(payload,'$.group_id')=? AND status!='cancelled' ORDER BY created_at,rowid", groupId).map(decode);
const byIds = (db, ids) => ids.map(id => decode(db.get('SELECT * FROM records WHERE id=?', id)));
const place = (db, a, lease) => `${a.title} · ${unitName(db, lease)}`;
function tellOwners(db, u, a, title, text) {
    for (const id of managerIds(db, a)) if (id !== u.id) pushNotification(db, id, title, `${text}\n${a.title}`, null, null, 'events', { target: 'a_' + a.id });
}

/** POST /api/apartments/:id/utilities {period, amount, due, note?} */
export function createUtilities(db, u, apartmentId, b) {
    const a = managedApartment(db, u, apartmentId);
    const period = validMonth(b.period), amount = V.integer(b.amount, 'Сумма коммуналки', 1, 10_000_000_00), due = V.date(b.due, 'Срок оплаты'), note = V.text(b.note, 'Комментарий', 500, true);
    const existing = db.get("SELECT json_extract(payload,'$.group_id') AS g FROM records WHERE apartment_id=? AND kind='charge' AND status!='cancelled' AND json_extract(payload,'$.category')='utilities' AND json_extract(payload,'$.period')=? LIMIT 1", a.id, period);
    if (existing) conflict(`Коммуналка за ${monthText(period)} уже внесена. Откройте её, чтобы изменить сумму или срок.`, { group_id: existing.g, period });
    const groups = tenantGroups(db, a);
    if (!groups.length) fail(409, 'В квартире пока нет жильцов: коммуналку не на кого разделить. Сначала пригласите жильцов.');
    const parts = split(groups, amount), people = parts.reduce((n, x) => n + x.tenants.length, 0);
    const groupId = randomUUID(), at = nowISO(), title = `${LINE} за ${monthText(period)}`, ids = [];
    for (const x of parts) {
        const id = randomUUID(), d = clampDue(due, x.lease);
        const payload = { category: 'utilities', amount: x.amount, confirmed: 0, due: d, period, payments: [], claims: [], claim: null, group_id: groupId, shares: x.shares, people_total: people, group_total: amount, lines: [{ label: LINE, amount: x.amount }], ...(note ? { note } : {}) };
        db.run('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, a.id, x.lease.id, 'charge', 'pending', title, JSON.stringify(payload), 'shared', 1, u.id, at, at, `utilities:${a.id}:${period}:${x.lease.id}`);
        ids.push(id);
        event(db, u, x.lease, `${title}: создано`, id);
        for (const uid of x.tenants) pushNotification(db, uid, title, `${title}: всего ${formatMoney(amount)} на ${people} ${persons(people)}, ваша доля ${formatMoney(x.shares[uid])}, до ${humanDate(d)}${note ? '\n' + note : ''}\n${place(db, a, x.lease)}`, id);
    }
    tellOwners(db, u, a, title, `${title} внесена: ${formatMoney(amount)} — ${u.name}`);
    return { group_id: groupId, records: byIds(db, ids) };
}

/** POST /api/utilities/:group_id {action:'update'|'cancel', amount?, due?, note?, versions:{record_id:version}} */
export function changeUtilities(db, u, groupId, b) {
    const action = V.choice(b.action, ['update', 'cancel'], 'Действие'), rows = groupRows(db, V.text(groupId, 'Коммуналка', 80));
    if (!rows.length) fail(404, 'Коммуналка не найдена.');
    const a = managedApartment(db, u, rows[0].apartment_id), versions = V.own(b.versions);
    if (Object.keys(versions).length !== rows.length || rows.some(r => versions[r.id] !== r.version)) fail(409, 'Коммуналка уже изменилась. Обновите экран и повторите.');
    if (rows.some(r => touched(r.payload))) fail(409, 'По этой коммуналке уже есть оплаты или отметки об оплате, поэтому изменить или отменить её нельзя.');
    const leases = new Map(rows.map(r => [r.id, db.get('SELECT * FROM leases WHERE id=?', r.lease_id)]));
    if ([...leases.values()].some(l => l.status === 'ended')) fail(409, 'Аренда завершена. История доступна только для чтения.');
    const title = rows[0].title, at = nowISO(), save = (r, status, p, dedupe) => {
        const changed = db.run(`UPDATE records SET status=?,payload=?,version=version+1,updated_at=?${dedupe === null ? ',dedupe=NULL' : ''} WHERE id=? AND version=?`, status, JSON.stringify(p), at, r.id, r.version);
        if (!changed.changes) fail(409, 'Коммуналка уже изменилась. Обновите экран и повторите.');
    };
    if (action === 'cancel') {
        const reason = V.text(b.note, 'Причина', 500, true) || 'Отменено собственником.';
        for (const r of rows) {
            // Dedupe is cleared so the month can be entered again.
            save(r, 'cancelled', { ...r.payload, cancel_reason: reason, cancelled_by: u.id, cancelled_at: at }, null);
            event(db, u, leases.get(r.id), `${title}: отменено`, r.id);
            for (const uid of Object.keys(r.payload.shares || {})) pushNotification(db, uid, `${title} отменена`, `Начисление отменено — ${u.name}: ${reason}\n${place(db, a, leases.get(r.id))}`, r.id);
        }
        tellOwners(db, u, a, `${title} отменена`, `${title} отменена — ${u.name}`);
        return { group_id: groupId, records: byIds(db, rows.map(r => r.id)) };
    }
    const amount = b.amount === undefined ? rows[0].payload.group_total : V.integer(b.amount, 'Сумма коммуналки', 1, 10_000_000_00);
    const due = b.due === undefined ? null : V.date(b.due, 'Срок оплаты'), note = b.note === undefined ? null : V.text(b.note, 'Комментарий', 500, true);
    // Same people as at creation, in the same order: a tenant who joined later is not added.
    const parts = split(rows.map(r => ({ record: r, tenants: Object.keys(r.payload.shares || {}) })), amount), people = parts.reduce((n, x) => n + x.tenants.length, 0);
    for (const x of parts) {
        const r = x.record, l = leases.get(r.id), p = { ...r.payload, amount: x.amount, due: due ? clampDue(due, l) : r.payload.due, shares: x.shares, people_total: people, group_total: amount, lines: [{ label: LINE, amount: x.amount }] };
        if (note !== null) { if (note) p.note = note; else delete p.note; }
        save(r, 'pending', p);
        event(db, u, l, `${title}: изменено`, r.id);
        for (const uid of x.tenants) pushNotification(db, uid, `${title} изменена`, `${title}: всего ${formatMoney(amount)} на ${people} ${persons(people)}, ваша доля ${formatMoney(x.shares[uid])}, до ${humanDate(p.due)}\n${place(db, a, l)}`, r.id);
    }
    tellOwners(db, u, a, `${title} изменена`, `${title}: теперь ${formatMoney(amount)} — ${u.name}`);
    return { group_id: groupId, records: byIds(db, rows.map(r => r.id)) };
}
