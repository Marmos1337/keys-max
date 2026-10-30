import { randomUUID } from 'node:crypto';
import { fail } from './auth.mjs';
import * as V from './validate.mjs';
export function memberIds(db, leaseId) {
  return db.all('SELECT user_id FROM lease_members WHERE lease_id=? ORDER BY joined_at,user_id',leaseId).map(x=>x.user_id);
}
export function isMember(db, userId, leaseId) {
  return !!db.get('SELECT 1 FROM lease_members WHERE lease_id=? AND user_id=?',leaseId,userId);
}
// The one place that grants owner rights over an apartment: its creator
// (apartments.owner_id, role 'owner') or an accepted co-owner (role 'co_owner').
// Every owner-permission check in the server goes through managerRole/managerSql.
export function managerRole(db, apartment, userId) {
  const a = typeof apartment === 'string' ? db.get('SELECT id,owner_id FROM apartments WHERE id=?', apartment) : apartment;
  if (!a || !userId) return null;
  if (a.owner_id === userId) return 'owner';
  return db.get("SELECT 1 FROM apartment_members WHERE apartment_id=? AND user_id=? AND role='co_owner'", a.id, userId) ? 'co_owner' : null;
}
export const isManager = (db, apartment, userId) => !!managerRole(db, apartment, userId);
// SQL condition «the user manages apartment <alias>»; takes one user id parameter.
export const managerSql = (alias = 'a') => `EXISTS(SELECT 1 FROM apartment_members am WHERE am.apartment_id=${alias}.id AND am.user_id=?)`;
// Main owner first, then co-owners by joining date.
export function managerIds(db, apartment) {
  const a = typeof apartment === 'string' ? db.get('SELECT id,owner_id FROM apartments WHERE id=?', apartment) : apartment;
  if (!a) return [];
  return [a.owner_id, ...db.all("SELECT user_id FROM apartment_members WHERE apartment_id=? AND role='co_owner' AND user_id<>? ORDER BY created_at,user_id", a.id, a.owner_id).map(x => x.user_id)];
}
export function unitName(db, lease) {
  return db.get('SELECT title FROM rental_units WHERE id=?',lease.unit_id)?.title || 'Квартира целиком';
}
export function createUnit(db,u,apartmentId,b) {
  const a=db.get('SELECT * FROM apartments WHERE id=?',apartmentId);
  if(!a||!isManager(db,a,u.id)) fail(404,'Квартира не найдена.');
  const kind=V.choice(b.kind||'room',['whole','room']);
  if(kind==='whole') {
    const old=db.get("SELECT * FROM rental_units WHERE apartment_id=? AND kind='whole'",a.id);
    if(old) return old;
  }
  const title=kind==='whole'?'Квартира целиком':V.text(b.title,'Название комнаты',80);
  if(db.get('SELECT 1 FROM rental_units WHERE apartment_id=? AND title=?',a.id,title)) fail(409,'Такое название комнаты уже есть.');
  const id=randomUUID();
  db.run('INSERT INTO rental_units(id,apartment_id,kind,title,created_at) VALUES(?,?,?,?,?)',id,a.id,kind,title,new Date().toISOString());
  return db.get('SELECT * FROM rental_units WHERE id=?',id);
}
export function updateUnit(db,u,id,b) {
  const unit=db.get('SELECT ru.* FROM rental_units ru WHERE ru.id=?',id);
  if(!unit||!isManager(db,unit.apartment_id,u.id)) fail(404,'Комната не найдена.');
  if(unit.kind!=='room') fail(400,'Название квартиры меняется в карточке квартиры.');
  if(V.integer(b.version,'Версия',1)!==unit.version) fail(409,'Комната уже изменена. Обновите экран.');
  const title=V.text(b.title,'Название комнаты',80);
  if(db.get('SELECT 1 FROM rental_units WHERE apartment_id=? AND title=? AND id!=?',unit.apartment_id,title,id)) fail(409,'Такое название комнаты уже есть.');
  db.run('UPDATE rental_units SET title=?,version=version+1 WHERE id=?',title,id);
  return db.get('SELECT * FROM rental_units WHERE id=?',id);
}

export function ownerInviteStatus(row, now = Date.now()) {
  if (row.used_by) return 'accepted';
  if (row.revoked_at) return 'revoked';
  if (row.expires < now) return 'expired';
  return row.opened_at ? 'opened' : 'pending';
}
// Co-owner links of the apartments where the user is the main owner (codes never leave the server).
export function listOwnerInvitesFor(db, u) {
  const now = Date.now(), recent = new Date(now - 30 * 86400000).toISOString();
  return db.all(`SELECT oi.*,uu.name AS used_name FROM owner_invites oi JOIN apartments a ON a.id=oi.apartment_id LEFT JOIN users uu ON uu.id=oi.used_by
      WHERE a.owner_id=? AND oi.replaced_by IS NULL AND oi.created_at>? ORDER BY oi.created_at DESC LIMIT 50`, u.id, recent)
    .map(r => { const status = ownerInviteStatus(r, now); return { id: r.hash, apartment_id: r.apartment_id, label: r.label, status, created_at: r.created_at, expires: new Date(r.expires).toISOString(), opened_at: r.opened_at, accepted_at: r.accepted_at, accepted_name: r.used_name || '', shareable: !!r.code_enc && (status === 'pending' || status === 'opened') }; })
    .filter(r => r.status !== 'revoked' || Date.parse(r.created_at) > now - 86400000);
}
// Apartment-wide money actions (utilities, cash collection): any owner or co-owner.
// A tenant of the apartment gets 403, anyone else 404 so the apartment stays hidden.
export function managedApartment(db, u, apartmentId) {
  const a = db.get('SELECT * FROM apartments WHERE id=?', V.text(apartmentId, 'Квартира', 80));
  if (a && managerRole(db, a, u.id)) return a;
  if (a && db.get('SELECT 1 FROM leases l JOIN lease_members lm ON lm.lease_id=l.id WHERE l.apartment_id=? AND lm.user_id=?', a.id, u.id))
    fail(403, 'Действие доступно собственнику.');
  fail(404, 'Квартира не найдена.');
}
