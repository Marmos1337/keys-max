// Co-ownership: the main owner invites a co-owner of ONE apartment by a personal
// link (same mechanics as tenant links: 7 days, one person, sealed code). A co-owner
// has owner rights for that apartment (see rental.mjs managerRole); only the main
// owner invites or removes co-owners and deletes the apartment. Co-owners may leave.
import { randomBytes } from 'node:crypto';
import { fail, hash } from './auth.mjs';
import * as V from './validate.mjs';
import { sealCode, openCode } from './invite-codes.mjs';
import { managerRole, managerIds, memberIds, ownerInviteStatus } from './rental.mjs';
import { event, pushNotification, nowISO, INVITE_DAYS } from './domain.mjs';

const ownerFail = (status, reason, message, apartment) => { const e = new Error(message); e.status = status; e.reason = reason; if (apartment) e.apartment_id = apartment.id; throw e; };

function mainOwnerApartment(db, u, apartmentId) {
    const a = db.get('SELECT * FROM apartments WHERE id=?', V.text(apartmentId, 'Квартира', 80));
    const role = a && managerRole(db, a, u.id);
    if (!role) fail(404, 'Квартира не найдена.');
    if (role !== 'owner') fail(403, 'Совладельцев приглашает и убирает главный владелец квартиры.');
    return a;
}

// Owner-side history line on every running lease of the apartment, with the actor as author.
export function apartmentEvent(db, u, apartment, title, visibility = 'owner') {
    const leases = db.all("SELECT * FROM leases WHERE apartment_id=? AND status!='ended'", apartment.id);
    const target = leases.length ? leases : db.all('SELECT * FROM leases WHERE apartment_id=? ORDER BY created_at DESC LIMIT 1', apartment.id);
    for (const l of target) event(db, u, l, title, null, visibility);
}
const tenantIdsOf = (db, a) => [...new Set(db.all("SELECT id FROM leases WHERE apartment_id=? AND status!='ended'", a.id).flatMap(l => memberIds(db, l.id)))];
const nameOf = (db, id) => db.get('SELECT name FROM users WHERE id=?', id)?.name || 'Собственник';

export function createOwnerInvite(db, u, apartmentId, { label = '', secret = '' } = {}) {
    const a = mainOwnerApartment(db, u, apartmentId);
    const code = randomBytes(18).toString('base64url'), expires = Date.now() + INVITE_DAYS * 86400000, h = hash(code);
    const name = V.text(String(label || '').trim(), 'Для кого', 60, true);
    db.run('INSERT INTO owner_invites(hash,apartment_id,label,created_by,created_at,expires,code_enc) VALUES(?,?,?,?,?,?,?)', h, a.id, name, u.id, nowISO(), expires, secret ? sealCode(secret, code) : null);
    apartmentEvent(db, u, a, 'Создана ссылка для совладельца' + (name ? ` «${name}»` : ''));
    return { id: h, code, label: name, apartment_id: a.id, expires: new Date(expires).toISOString() };
}

// Says exactly why a link does not work, for the bot and the app.
export function previewOwnerInvite(db, u, code, { track = false } = {}) {
    V.text(code, 'Код', 100);
    const h = hash(String(code).trim()), inv = db.get('SELECT * FROM owner_invites WHERE hash=?', h);
    if (!inv) ownerFail(400, 'not_found', 'Ссылка для совладельца не найдена. Проверьте, что она скопирована целиком, или попросите новую.');
    const a = db.get('SELECT * FROM apartments WHERE id=?', inv.apartment_id);
    if (!a) ownerFail(400, 'not_found', 'Квартира по этой ссылке больше не существует.');
    const ctx = { invite: inv, apartment: a, inviter: nameOf(db, inv.created_by), owners: managerIds(db, a).map(id => nameOf(db, id)) };
    const role = managerRole(db, a, u.id);
    if (role === 'owner' && inv.created_by === u.id) ownerFail(400, 'own', 'Это ваша ссылка для совладельца. Отправьте её человеку, с которым делите квартиру.', a);
    if (role) ownerFail(409, 'member', 'Вы уже совладелец этой квартиры.', a);
    if (db.get("SELECT 1 FROM lease_members lm JOIN leases l ON l.id=lm.lease_id WHERE l.apartment_id=? AND lm.user_id=? AND l.status!='ended'", a.id, u.id))
        ownerFail(409, 'tenant', 'Вы снимаете эту квартиру, поэтому стать её совладельцем нельзя. Если это ошибка — напишите собственнику.', a);
    if (inv.revoked_at) ownerFail(400, 'revoked', 'Владелец отозвал эту ссылку. Попросите у него новую.', a);
    if (inv.used_by) ownerFail(400, 'used', 'По этой ссылке уже стал совладельцем другой человек: одна ссылка — для одного человека.', a);
    if (inv.expires < Date.now()) ownerFail(400, 'expired', `Срок ссылки истёк (она действует ${INVITE_DAYS} дней). Попросите у владельца новую.`, a);
    if (track && !inv.opened_at) db.run('UPDATE owner_invites SET opened_at=?,opened_by=? WHERE hash=?', nowISO(), u.id, h);
    return ctx;
}

export function joinOwnerInvite(db, u, code) {
    const { invite, apartment: a } = previewOwnerInvite(db, u, code);
    db.run("INSERT INTO apartment_members(apartment_id,user_id,role,added_by,created_at) VALUES(?,?,'co_owner',?,?)", a.id, u.id, invite.created_by, nowISO());
    db.run('UPDATE owner_invites SET used_by=?,accepted_at=?,code_enc=NULL WHERE hash=? AND used_by IS NULL', u.id, nowISO(), invite.hash);
    // The new co-owner lands in the owner cabinet; the role switch keeps any rented flat.
    db.run("UPDATE users SET role='owner' WHERE id=?", u.id);
    apartmentEvent(db, u, a, `${u.name} — совладелец квартиры`, 'shared');
    for (const id of managerIds(db, a)) if (id !== u.id) pushNotification(db, id, 'Новый совладелец', `${u.name} теперь совладелец «${a.title}»: видит и ведёт квартиру вместе с вами.`, null, null, 'events', { target: 'a_' + a.id });
    for (const id of tenantIdsOf(db, a)) pushNotification(db, id, 'У квартиры новый совладелец', `${u.name} теперь тоже собственник «${a.title}»: видит платежи, показания и заявки.`, null, null, 'events');
    return { apartment_id: a.id, role: 'co_owner' };
}

function ownedInvite(db, u, id) {
    const inv = db.get('SELECT * FROM owner_invites WHERE hash=?', V.text(id, 'Приглашение', 80));
    if (!inv) fail(404, 'Приглашение не найдено.');
    return { inv, a: mainOwnerApartment(db, u, inv.apartment_id) };
}
export function revokeOwnerInvite(db, u, id) {
    const { inv, a } = ownedInvite(db, u, id);
    if (inv.used_by) fail(409, 'По этой ссылке уже стали совладельцем. Чтобы убрать человека, откройте его в «Совладельцах».');
    db.run('UPDATE owner_invites SET revoked_at=COALESCE(revoked_at,?),code_enc=NULL WHERE hash=?', nowISO(), inv.hash);
    apartmentEvent(db, u, a, 'Отозвана ссылка для совладельца' + (inv.label ? ` «${inv.label}»` : ''));
    return { ok: true };
}
export function shareOwnerInvite(db, u, id, secret) {
    const { inv } = ownedInvite(db, u, id), status = ownerInviteStatus(inv);
    const code = ['pending', 'opened'].includes(status) ? openCode(secret, inv.code_enc) : '';
    if (!code) fail(409, 'Эту ссылку уже нельзя отправить повторно. Создайте новую.');
    return { id: inv.hash, code, label: inv.label, apartment_id: inv.apartment_id, expires: new Date(inv.expires).toISOString() };
}
export function renewOwnerInvite(db, u, id, secret) {
    const { inv, a } = ownedInvite(db, u, id);
    if (inv.used_by) fail(409, 'По этой ссылке уже стали совладельцем.');
    const next = createOwnerInvite(db, u, a.id, { label: inv.label, secret });
    db.run('UPDATE owner_invites SET revoked_at=COALESCE(revoked_at,?),code_enc=NULL,replaced_by=? WHERE hash=?', nowISO(), next.id, inv.hash);
    return next;
}

export function removeCoOwner(db, u, apartmentId, userId) {
    const a = mainOwnerApartment(db, u, apartmentId);
    if (userId === a.owner_id) fail(409, 'Главного владельца убрать нельзя.');
    if (managerRole(db, a, userId) !== 'co_owner') fail(404, 'Такого совладельца нет.');
    db.run("DELETE FROM apartment_members WHERE apartment_id=? AND user_id=? AND role='co_owner'", a.id, userId);
    const name = nameOf(db, userId);
    apartmentEvent(db, u, a, `${name} больше не совладелец`, 'shared');
    pushNotification(db, userId, 'Доступ к квартире закрыт', `Вы больше не совладелец «${a.title}» — так решил главный владелец, ${u.name}. История квартиры у вас больше не отображается.`, null, null, 'events');
    for (const id of managerIds(db, a)) if (id !== u.id) pushNotification(db, id, 'Совладелец убран', `${name} больше не совладелец «${a.title}».`, null, null, 'events', { target: 'a_' + a.id });
    return { ok: true };
}

export function leaveApartment(db, u, apartmentId) {
    const a = db.get('SELECT * FROM apartments WHERE id=?', V.text(apartmentId, 'Квартира', 80));
    const role = a && managerRole(db, a, u.id);
    if (!role) fail(404, 'Квартира не найдена.');
    if (role === 'owner') fail(409, 'Главный владелец не может выйти из своей квартиры. Её можно только удалить.');
    db.run("DELETE FROM apartment_members WHERE apartment_id=? AND user_id=? AND role='co_owner'", a.id, u.id);
    apartmentEvent(db, u, a, `Выход из совладельцев: ${u.name}`, 'shared');
    for (const id of managerIds(db, a)) pushNotification(db, id, 'Совладелец вышел', `${u.name} больше не совладелец «${a.title}».`, null, null, 'events', { target: 'a_' + a.id });
    return { ok: true };
}
