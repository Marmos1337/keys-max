// Utilities («Коммуналка»): one amount a month for the whole apartment, split equally among the
// tenants of every running lease (owners and co-owners never get a share). Stored as one ordinary
// charge per lease (category 'utilities'), so claims, payments, reminders and 0.6 clients keep working.
// Each lease's record holds only its own tenants' shares; other rooms see the total and headcount.
// Tenants get no message when utilities are entered or edited: they hear about them once, in the
// month-end digest (domain.mjs generateRecurring), and see the charge in the app.
// Approval: the primary owner publishes at once. A co-owner's new group is a draft (visibility
// 'owner', payload.approval='pending'), invisible to tenants until the primary owner approves; a
// co-owner's edit of a published group is kept as payload.pending_change until approved or declined.
import { randomUUID } from 'node:crypto';
import { fail } from './auth.mjs';
import * as V from './validate.mjs';
import { managedApartment, managerIds, memberIds, unitName } from './rental.mjs';
import { decode, event, pushNotification, nowISO, monthText, validMonth, formatMoney } from './domain.mjs';
import { equalSplit, claimsOf } from '../public/shares.js';

const LINE = 'Коммуналка';
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
const isPrimary = (a, u) => a.owner_id === u.id;
const awaitingApproval = p => p.approval === 'pending';
// Only the primary owner (apartments.owner_id) is told about co-owners' drafts and proposed changes.
const tellPrimary = (db, a, title, text, recordId, dedupe = null) => pushNotification(db, a.owner_id, title, `${text}\n${a.title}`, recordId, dedupe, 'events', { target: 'a_' + a.id });

/** POST /api/apartments/:id/utilities {period, amount, due, note?, publish?}
 * Every new group is a draft (records.visibility='owner', payload.approval='pending') until the primary
 * owner approves it. publish:true («Отправить сразу») skips the draft, and only the primary owner may use it. */
export function createUtilities(db, u, apartmentId, b) {
    const a = managedApartment(db, u, apartmentId);
    const period = validMonth(b.period), amount = V.integer(b.amount, 'Сумма коммуналки', 1, 10_000_000_00), due = V.date(b.due, 'Срок оплаты'), note = V.text(b.note, 'Комментарий', 500, true);
    const existing = db.get("SELECT json_extract(payload,'$.group_id') AS g FROM records WHERE apartment_id=? AND kind='charge' AND status!='cancelled' AND json_extract(payload,'$.category')='utilities' AND json_extract(payload,'$.period')=? LIMIT 1", a.id, period);
    if (existing) conflict(`Коммуналка за ${monthText(period)} уже внесена. Откройте её, чтобы изменить сумму или срок.`, { group_id: existing.g, period });
    const groups = tenantGroups(db, a);
    if (!groups.length) fail(409, 'В квартире пока нет жильцов: коммуналку не на кого разделить. Сначала пригласите жильцов.');
    const parts = split(groups, amount), people = parts.reduce((n, x) => n + x.tenants.length, 0);
    const draft = !(isPrimary(a, u) && b.publish === true), visibility = draft ? 'owner' : 'shared';
    const groupId = randomUUID(), at = nowISO(), title = `${LINE} за ${monthText(period)}`, ids = [];
    for (const x of parts) {
        const id = randomUUID(), d = clampDue(due, x.lease);
        const payload = { category: 'utilities', amount: x.amount, confirmed: 0, due: d, period, payments: [], claims: [], claim: null, group_id: groupId, shares: x.shares, people_total: people, group_total: amount, lines: [{ label: LINE, amount: x.amount }], approval: draft ? 'pending' : 'approved', author: u.id, ...(draft ? {} : { approved_by: u.id, approved_at: at }), ...(note ? { note } : {}) };
        db.run('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, a.id, x.lease.id, 'charge', 'pending', title, JSON.stringify(payload), visibility, 1, u.id, at, at, `utilities:${a.id}:${period}:${x.lease.id}`);
        ids.push(id);
        event(db, u, x.lease, `${title}: ${draft ? 'внесено, ждёт одобрения' : 'создано'}`, id, visibility);
    }
    if (draft && !isPrimary(a, u)) tellPrimary(db, a, `${title}: нужно одобрить`, `${u.name}: внесена ${title.toLowerCase()}: ${formatMoney(amount)} — нужно одобрить`, ids[0]);
    return { group_id: groupId, records: byIds(db, ids) };
}

/** POST /api/utilities/:group_id {action:'update'|'cancel'|'approve'|'decline', amount?, due?, note?, versions:{record_id:version}}
 * update: any manager; paid/claimed money does not block it, only amount >= confirmed + open claims per lease (else 409 with details.min_amount).
 *   A draft is edited in place and stays a draft. A published group: the primary owner's edit applies at once; a co-owner's edit
 *   is stored as payload.pending_change (the primary owner may edit that in place too, it stays unapproved).
 * approve: primary owner only, publishes the draft or applies pending_change. decline: primary owner only, drops it and tells the author.
 * cancel: only while nothing is paid or claimed. */
export function changeUtilities(db, u, groupId, b) {
    const action = V.choice(b.action, ['update', 'cancel', 'approve', 'decline'], 'Действие'), rows = groupRows(db, V.text(groupId, 'Коммуналка', 80));
    if (!rows.length) fail(404, 'Коммуналка не найдена.');
    const a = managedApartment(db, u, rows[0].apartment_id), versions = V.own(b.versions), primary = isPrimary(a, u);
    if (Object.keys(versions).length !== rows.length || rows.some(r => versions[r.id] !== r.version)) fail(409, 'Коммуналка уже изменилась. Обновите экран и повторите.');
    if (['approve', 'decline'].includes(action) && !primary) fail(403, 'Одобрять и отклонять коммуналку может только основной собственник.');
    if (action === 'cancel' && rows.some(r => touched(r.payload))) fail(409, 'По этой коммуналке уже есть оплаты или отметки об оплате, поэтому отменить её нельзя. Можно изменить сумму.');
    const leases = new Map(rows.map(r => [r.id, db.get('SELECT * FROM leases WHERE id=?', r.lease_id)]));
    if ([...leases.values()].some(l => l.status === 'ended')) fail(409, 'Аренда завершена. История доступна только для чтения.');
    const title = rows[0].title, period = rows[0].payload.period, at = nowISO(), draft = awaitingApproval(rows[0].payload), pending = rows[0].payload.pending_change || null;
    const save = (r, status, p, { dedupe, visibility } = {}) => {
        const changed = db.run(`UPDATE records SET status=?,payload=?,version=version+1,updated_at=?${dedupe === null ? ',dedupe=NULL' : ''}${visibility ? ',visibility=?' : ''} WHERE id=? AND version=?`, status, JSON.stringify(p), at, ...(visibility ? [visibility] : []), r.id, r.version);
        if (!changed.changes) fail(409, 'Коммуналка уже изменилась. Обновите экран и повторите.');
    };
    const result = () => ({ group_id: groupId, records: byIds(db, rows.map(r => r.id)) });
    const evt = (r, text, visibility = 'shared') => event(db, u, leases.get(r.id), text, r.id, visibility);
    const monthTitle = `${LINE} за ${monthText(period)}`;

    if (action === 'cancel' || (action === 'decline' && draft)) {
        const reason = V.text(b.note, 'Причина', 500, true) || (action === 'cancel' ? 'Отменено собственником.' : 'Отклонено основным собственником.');
        for (const r of rows) {
            // Dedupe is cleared so the month can be entered again.
            save(r, 'cancelled', { ...r.payload, cancel_reason: reason, cancelled_by: u.id, cancelled_at: at }, { dedupe: null });
            evt(r, `${title}: ${action === 'cancel' ? 'отменено' : 'отклонено'}`, draft ? 'owner' : 'shared');
            // Tenants never saw a draft, so only a published charge is announced to them.
            if (!draft) for (const uid of Object.keys(r.payload.shares || {})) pushNotification(db, uid, `${title} отменена`, `Начисление отменено — ${u.name}: ${reason}\n${place(db, a, leases.get(r.id))}`, r.id);
        }
        if (action === 'decline') { const author = rows[0].payload.author || rows[0].created_by; if (author && author !== u.id) pushNotification(db, author, `${title} отклонена`, `${u.name} отклонил(а) вашу коммуналку: ${reason}\n${a.title}`, null); }
        else if (!primary) tellPrimary(db, a, `${title} отменена`, `${title} отменена — ${u.name}`, null);
        return result();
    }
    if (action === 'decline') {
        if (!pending) fail(409, 'Нечего отклонять: предложенных изменений нет.');
        for (const r of rows) { const p = { ...r.payload }; delete p.pending_change; save(r, r.status, p); evt(r, `${monthTitle}: предложенное изменение отклонено`, 'owner'); }
        if (pending.by && pending.by !== u.id) pushNotification(db, pending.by, `${title}: изменение отклонено`, `${u.name} не принял(а) изменение суммы коммуналки: оставлено ${formatMoney(rows[0].payload.group_total)}\n${a.title}`, null);
        return result();
    }
    if (action === 'approve' && !draft && !pending) fail(409, 'Нечего одобрять: коммуналка уже выставлена.');

    const oldTotal = rows[0].payload.group_total;
    const want = action === 'approve' ? (draft ? {} : pending) : b;
    const editsPending = action === 'update' && primary && !draft && !!pending;
    const amount = want.amount === undefined ? (editsPending ? pending.amount : oldTotal) : V.integer(want.amount, 'Сумма коммуналки', 1, 10_000_000_00);
    const due = want.due === undefined || want.due === null ? null : V.date(want.due, 'Срок оплаты'), note = want.note === undefined || want.note === null ? null : V.text(want.note, 'Комментарий', 500, true);
    // Same people as at creation, in the same order: a tenant who joined later is not added.
    const groups = rows.map(r => ({ record: r, tenants: Object.keys(r.payload.shares || {}) }));
    // The one hard rule: a lease's charge may not drop below what is already confirmed plus open claims.
    const floorOf = r => (r.payload.confirmed || 0) + claimsOf(r.payload).reduce((n, c) => n + (c.amount || 0), 0);
    const enough = total => split(groups, total).every(x => x.amount >= floorOf(x.record));
    if (!enough(amount)) {
        let lo = amount, hi = Math.max(10_000_000_00, amount);
        while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (enough(mid)) hi = mid; else lo = mid + 1; }
        conflict(`Меньше ${formatMoney(lo)} сделать нельзя: столько уже оплачено или ждёт подтверждения.`, { min_amount: lo });
    }

    // A co-owner's edit of a published group is only a proposal; the primary owner editing a proposal
    // changes its values in place and it stays unapproved.
    if (action === 'update' && !draft && (!primary || pending)) {
        const base = editsPending ? pending : {}, d = due || base.due, n = note !== null ? note : base.note;
        const change = { amount, by: editsPending ? pending.by : u.id, at, ...(d ? { due: d } : {}), ...(n !== undefined ? { note: n } : {}) };
        for (const r of rows) { save(r, r.status, { ...r.payload, pending_change: change }); evt(r, `${monthTitle}: предложено изменить: было ${formatMoney(oldTotal)}, станет ${formatMoney(amount)}`, 'owner'); }
        if (!primary) tellPrimary(db, a, `${title}: нужно одобрить`, `${u.name}: изменение коммуналки за ${monthText(period)}: было ${formatMoney(oldTotal)}, станет ${formatMoney(amount)} — нужно одобрить`, rows[0].id, `util-change:${groupId}:${rows[0].version}`);
        return result();
    }

    // Applying: an edit of a draft (it stays a draft), an approval, or the primary owner editing a published group.
    const publish = action === 'approve' && draft;
    const parts = split(groups, amount), people = parts.reduce((n, x) => n + x.tenants.length, 0);
    for (const x of parts) {
        const r = x.record, l = leases.get(r.id), p = { ...r.payload, amount: x.amount, due: due ? clampDue(due, l) : r.payload.due, shares: x.shares, people_total: people, group_total: amount, lines: [{ label: LINE, amount: x.amount }] };
        delete p.pending_change;
        if (note !== null) { if (note) p.note = note; else delete p.note; }
        if (publish) Object.assign(p, { approval: 'approved', approved_by: u.id, approved_at: at });
        p.claims = claimsOf(p);
        p.claim = p.claims[0] || null;
        const status = p.claims.length ? 'claimed' : p.confirmed === p.amount ? 'paid' : p.confirmed ? 'partial' : 'pending';
        save(r, status, p, publish ? { visibility: 'shared' } : {});
        if (publish) evt(r, `Выставлена ${monthTitle.toLowerCase()}`);
        else evt(r, amount !== oldTotal ? `${monthTitle} изменена: было ${formatMoney(oldTotal)}, стало ${formatMoney(amount)}` : `${monthTitle} изменена: срок или комментарий`, draft ? 'owner' : 'shared');
    }
    if (draft && !primary) tellPrimary(db, a, `${title}: нужно одобрить`, `${u.name}: внесена ${title.toLowerCase()}: ${formatMoney(amount)} — нужно одобрить`, rows[0].id, `util-draft:${groupId}:${rows[0].version}`);
    return result();
}
