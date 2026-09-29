import { randomUUID } from 'node:crypto';
import { fail } from './auth.mjs';
import * as V from './validate.mjs';
export function memberIds(db, leaseId) {
  return db.all('SELECT user_id FROM lease_members WHERE lease_id=? ORDER BY joined_at,user_id',leaseId).map(x=>x.user_id);
}
export function isMember(db, userId, leaseId) {
  return !!db.get('SELECT 1 FROM lease_members WHERE lease_id=? AND user_id=?',leaseId,userId);
}
export function unitName(db, lease) {
  return db.get('SELECT title FROM rental_units WHERE id=?',lease.unit_id)?.title || 'Квартира целиком';
}
export function createUnit(db,u,apartmentId,b) {
  const a=db.get('SELECT * FROM apartments WHERE id=? AND owner_id=?',apartmentId,u.id);
  if(!a) fail(404,'Квартира не найдена.');
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
  const unit=db.get('SELECT ru.* FROM rental_units ru JOIN apartments a ON a.id=ru.apartment_id WHERE ru.id=? AND a.owner_id=?',id,u.id);
  if(!unit) fail(404,'Комната не найдена.');
  if(unit.kind!=='room') fail(400,'Название квартиры меняется в карточке квартиры.');
  if(V.integer(b.version,'Версия',1)!==unit.version) fail(409,'Комната уже изменена. Обновите экран.');
  const title=V.text(b.title,'Название комнаты',80);
  if(db.get('SELECT 1 FROM rental_units WHERE apartment_id=? AND title=? AND id!=?',unit.apartment_id,title,id)) fail(409,'Такое название комнаты уже есть.');
  db.run('UPDATE rental_units SET title=?,version=version+1 WHERE id=?',title,id);
  return db.get('SELECT * FROM rental_units WHERE id=?',id);
}
