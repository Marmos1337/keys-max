import { randomUUID, randomBytes } from 'node:crypto';
import { fail, hash } from './auth.mjs';
import * as V from './validate.mjs';
import { bindCover, presentApartment } from './covers.mjs';
import { isMember, memberIds, unitName, createUnit, managerRole, managerIds, managerSql, listOwnerInvitesFor } from './rental.mjs';
import { sealCode, openCode } from './invite-codes.mjs';
export { isMember, memberIds } from './rental.mjs';
export const nowISO = () => new Date().toISOString();
export const decode = r => r ? { ...r, payload: JSON.parse(r.payload) } : null;
export const settings = u => ({ events: true, reminders: true, bot: true, ...JSON.parse(u.settings || '{}') });
export const safeUser = u => ({ id: u.id, name: u.name, role: u.role, demo: !!u.demo, bot_enabled: !!u.bot_enabled, tg_bot_enabled: !!u.tg_bot_enabled, platforms: { max: !!u.max_id, telegram: !!u.tg_id }, settings: settings(u) });
export function dateInZone(timezone = 'Europe/Moscow', time = Date.now()) { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(time)); return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k).value).join('-'); }
export function apartmentAccess(db, u, id, ownerOnly = false) { const a = db.get('SELECT * FROM apartments WHERE id=?', id); if (!a)
    fail(404, 'Квартира не найдена.'); const role = managerRole(db, a, u.id); if (role)
    return { apartment: a, owner: true, role }; if (ownerOnly || !db.get('SELECT 1 FROM leases l JOIN lease_members lm ON lm.lease_id=l.id WHERE l.apartment_id=? AND lm.user_id=?', id, u.id))
    fail(404, 'Квартира не найдена.'); return { apartment: a, owner: false }; }
export function leaseAccess(db, u, id, { write = false, ownerOnly = false } = {}) { const l = db.get('SELECT * FROM leases WHERE id=?', id); if (!l)
    fail(404, 'Аренда не найдена.'); const a = db.get('SELECT * FROM apartments WHERE id=?', l.apartment_id), role = managerRole(db, a, u.id), owner = !!role; if (!owner && (ownerOnly || !isMember(db,u.id,l.id)))
    fail(404, 'Аренда не найдена.'); if (write && l.status === 'ended')
    fail(409, 'Аренда завершена. История доступна только для чтения.'); return { lease: l, apartment: a, owner, role }; }
export function recordAccess(db, u, id, write = false) { const r = decode(db.get('SELECT * FROM records WHERE id=?', id)); if (!r)
    fail(404, 'Запись не найдена.'); const ctx = leaseAccess(db, u, r.lease_id, { write }); if (!ctx.owner && r.visibility === 'owner')
    fail(404, 'Запись не найдена.'); return { ...ctx, record: r }; }
export function event(db, u, lease, title, recordId = null, visibility = 'shared') { db.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', randomUUID(), lease.apartment_id, lease.id, u.id, title, recordId, visibility, nowISO()); }
export function pushNotification(db, userId, title, text, recordId = null, dedupe = null, category = 'events', extra = {}) {
    if (!userId)
        return;
    const user = db.get('SELECT * FROM users WHERE id=?', userId);
    if (!user)
        return;
    if (dedupe && db.get('SELECT id FROM notifications WHERE dedupe=?', dedupe))
        return;
    const id = randomUUID();
    db.run('INSERT INTO notifications(id,user_id,title,text,record_id,created_at,dedupe,category) VALUES(?,?,?,?,?,?,?,?)', id, userId, title, text, recordId, nowISO(), dedupe, category);
    if (settings(user).bot && settings(user)[category] !== false) {
        const body = { title, text, recordId, category, ...extra };
        // One outbox row per messenger, so a failure in one never repeats delivery in the other.
        if (user.max_id && user.bot_enabled)
            db.run('INSERT INTO outbox(id,user_id,body,created_at) VALUES(?,?,?,?)', randomUUID(), userId, JSON.stringify(body), nowISO());
        if (user.tg_id && user.tg_bot_enabled)
            db.run('INSERT INTO outbox(id,user_id,body,created_at) VALUES(?,?,?,?)', randomUUID(), userId, JSON.stringify({ ...body, channel: 'telegram' }), nowISO());
    }
}
export function notifyOther(db, u, ctx, title, recordId, visibility = 'shared', detail = '', extra = {}) {
    if (visibility === 'owner') return;
    // Every owner of the apartment and every tenant of the lease, each once, never the actor.
    const targets = new Set([...managerIds(db,ctx.apartment), ...memberIds(db,ctx.lease.id)]);
    targets.delete(u.id);
    // Scheduled items (monthly bills) come from rules the owners set up: tell the tenants, not every owner.
    if (ctx.system) for (const id of managerIds(db,ctx.apartment)) targets.delete(id);
    const place = `${ctx.apartment.title} · ${unitName(db,ctx.lease)}`;
    if(!detail&&recordId) {
        const r=decode(db.get('SELECT * FROM records WHERE id=?',recordId)),p=r?.payload||{};
        detail=`${u.name}: ${title}`;
        if(p.description) detail+='\n'+p.description.slice(0,700);
        if(r?.kind==='charge') detail+=`\nНачислено: ${formatMoney(p.amount)}. Подтверждено: ${formatMoney(p.confirmed)}. До ${humanDate(p.due)}.`;
        if(r?.kind==='visit') detail+='\n'+p.reason+'\n'+new Date(p.start).toLocaleString('ru-RU',{timeZone:process.env.TZ||'Europe/Moscow'});
        if(r?.kind==='reading') detail+='\n'+(p.values||[]).map(v=>`${v.label}: ${v.value/1000} ${v.unit}`).join('\n');
        if(r?.kind==='purchase') detail+='\n'+formatMoney(p.amount);
        if(r?.kind==='ticket'&&p.result) detail+='\nРезультат: '+p.result;
    }
    for (const target of targets) pushNotification(db,target,title,`${detail || `${u.name}: ${title}`}\n${place}`,recordId,null,'events',extra);
}
export function attach(db, u, lease, recordId, ids) { for (const id of V.attachmentIds(ids)) {
    const f = db.get('SELECT * FROM files WHERE id=?', id);
    if (!f || f.user_id !== u.id || f.lease_id !== lease.id || f.record_id)
        fail(400, 'Файл недоступен или уже прикреплён. Загрузите его ещё раз.');
    db.run('UPDATE files SET record_id=? WHERE id=?', recordId, id);
} }
function insertRecord(db, u, ctx, kind, status, title, payload, visibility = 'shared', dedupe = null, files = []) { const id = randomUUID(), at = nowISO(); db.run('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, ctx.apartment.id, ctx.lease.id, kind, status, title, JSON.stringify(payload), visibility, 1, u.id, at, at, dedupe); attach(db, u, ctx.lease, id, files); event(db, u, ctx.lease, `${title}: создано`, id, visibility); notifyOther(db, u, ctx, title, id, visibility); return decode(db.get('SELECT * FROM records WHERE id=?', id)); }
export function createApartment(db,u,b) {
    if(u.role!=='owner') fail(403,'Переключитесь в режим собственника.');
    const title=V.text(b.title,'Название',80),address=V.text(b.address,'Адрес',250),rooms=V.integer(b.rooms,'Комнаты',1,20),area=Number(b.area);
    if(!Number.isFinite(area)||area<5||area>2000) fail(400,'Площадь: от 5 до 2000 м².');
    const id=randomUUID();
    db.run('INSERT INTO apartments(id,owner_id,title,address,rooms,area,photo,created_at) VALUES(?,?,?,?,?,?,?,?)',id,u.id,title,address,rooms,area,V.choice(b.photo||'living',['living','owner','room']),nowISO());
    db.run("INSERT OR IGNORE INTO apartment_members(apartment_id,user_id,role,added_by,created_at) VALUES(?,?,'owner',?,?)",id,u.id,u.id,nowISO());
    const mode=V.choice(b.rental_mode||'whole',['whole','rooms']);
    const whole=createUnit(db,u,id,{kind:'whole'});
    const unit=mode==='whole'?whole:createUnit(db,u,id,{kind:'room',title:b.unit_title||'Комната 1'});
    createLease(db,u,id,{...b,unit_id:unit.id});
    if(b.cover_id) bindCover(db,u,id,b.cover_id);
    return db.get('SELECT * FROM apartments WHERE id=?',id);
}
/** Owner-only editing of the property, not unilateral changes to an occupied lease. */
export function updateApartment(db, u, id, b) {
    const { apartment: a } = apartmentAccess(db, u, id, true);
    if (V.integer(b.version, 'Версия квартиры', 1) !== a.version)
        fail(409, 'Квартира уже изменена. Закройте форму и откройте её снова, чтобы не затереть новые данные.');
    const title = b.title === undefined ? a.title : V.text(b.title, 'Название', 80);
    const address = b.address === undefined ? a.address : V.text(b.address, 'Адрес', 250);
    const rooms = b.rooms === undefined ? a.rooms : V.integer(b.rooms, 'Комнаты', 1, 20);
    const area = b.area === undefined ? a.area : Number(b.area);
    if (!Number.isFinite(area) || area < 5 || area > 2000)
        fail(400, 'Площадь: от 5 до 2000 м².');
    const photo = b.photo === undefined ? a.photo : V.choice(b.photo, ['living', 'owner', 'room']);
    const lease = b.lease?.id ? db.get("SELECT * FROM leases WHERE id=? AND apartment_id=? AND status IN ('active','ending')", b.lease.id,id) : db.get("SELECT * FROM leases WHERE apartment_id=? AND status IN ('active','ending')", id);
    // A landlord may correct the draft before inviting a tenant. Once joined,
    // changes to the lease use the existing two-party proposal flow instead.
    if (b.lease !== undefined) {
        if (!lease || memberIds(db,lease.id).length || lease.status !== 'active' || b.lease.id !== lease.id)
            fail(409, 'Условия этой аренды нельзя менять напрямую. После присоединения арендатора используйте согласование условий.');
        if (db.get('SELECT 1 FROM records WHERE lease_id=? LIMIT 1', lease.id))
            fail(409, 'В аренде уже есть записи. Редактирование карточки не должно менять их условия.');
        const x = V.own(b.lease), start = V.date(x.start), end = V.date(x.end);
        if (end <= start) fail(400, 'Окончание аренды должно быть после начала.');
        db.run('UPDATE leases SET start=?,end=?,rent=?,deposit=?,terms=?,due_day=?,meter_day=? WHERE id=?',
            start, end, V.integer(x.rent, 'Арендная плата', 1), V.integer(x.deposit, 'Депозит'),
            V.text(x.terms, 'Условия', 3000, true), V.integer(x.due_day, 'День оплаты', 1, 31),
            V.integer(x.meter_day, 'День показаний', 1, 31), lease.id);
        db.run("UPDATE recurring_rules SET amount=?,due_day=?,start_month=?,end_month=? WHERE lease_id=? AND is_rent=1",x.rent,x.due_day,start.slice(0,7)>dateInZone().slice(0,7)?start.slice(0,7):dateInZone().slice(0,7),end.slice(0,7),lease.id);
    }
    if (b.cover_id !== undefined) bindCover(db, u, id, b.cover_id);
    db.run('UPDATE apartments SET title=?,address=?,rooms=?,area=?,photo=?,version=version+1 WHERE id=?',
        title, address, rooms, area, photo, id);
    if (lease) {
        const text = b.title === undefined && b.address === undefined ? 'Изменена обложка квартиры' : 'Обновлена карточка квартиры';
        event(db, u, lease, text);
        for(const l of db.all("SELECT * FROM leases WHERE apartment_id=? AND status!='ended'",id)) for(const uid of memberIds(db,l.id)) pushNotification(db,uid,text,`${u.name}: сведения о квартире обновлены. Условия согласованной аренды не изменены.`);
        for(const uid of managerIds(db,a)) if(uid!==u.id) pushNotification(db,uid,text,`${u.name}: ${text.toLowerCase()} «${title}».`,null,null,'events',{target:'a_'+id});
    }
    return db.get('SELECT * FROM apartments WHERE id=?', id);
}
export function createLease(db,u,apartmentId,b) {
    apartmentAccess(db,u,apartmentId,true);
    const unit=b.unit_id ? db.get('SELECT * FROM rental_units WHERE id=? AND apartment_id=?',b.unit_id,apartmentId) : createUnit(db,u,apartmentId,{kind:'whole'});
    if(!unit) fail(404,'Выберите квартиру целиком или комнату этой квартиры.');
    const active=db.all("SELECT l.*,ru.kind FROM leases l JOIN rental_units ru ON ru.id=l.unit_id WHERE l.apartment_id=? AND l.status IN ('active','ending')",apartmentId);
    if(active.some(l=>l.unit_id===unit.id||l.kind==='whole'||unit.kind==='whole')) fail(409,'Объект уже сдан. Квартиру целиком нельзя сдавать одновременно с отдельными комнатами.');
    const start=V.date(b.start),end=V.date(b.end);
    if(end<=start) fail(400,'Окончание аренды должно быть после начала.');
    const id=randomUUID(), rent=V.integer(b.rent,'Арендная плата',1),due=V.integer(b.due_day||5,'День оплаты',1,31);
    db.run(`INSERT INTO leases(id,apartment_id,tenant_id,start,end,rent,deposit,terms,due_day,meter_day,status,created_at,unit_id,meters_enabled)
        VALUES(?,?,NULL,?,?,?,?,?,?,?,'active',?,?,?)`,id,apartmentId,start,end,rent,V.integer(b.deposit??0,'Депозит'),V.text(b.terms,'Условия',3000,true),due,V.integer(b.meter_day||25,'День показаний',1,31),nowISO(),unit.id,b.meters_enabled===false?0:1);
    const lease=db.get('SELECT * FROM leases WHERE id=?',id);
    if(b.recurring_rent!==false) {
      const month=dateInZone().slice(0,7), from=start.slice(0,7)>month?start.slice(0,7):month;
      db.run(`INSERT INTO recurring_rules(id,lease_id,title,amount,due_day,start_month,end_month,is_rent,legacy,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        'rent_'+id,id,'Аренда',rent,due,from,end.slice(0,7),1,1,nowISO());
    }
    event(db,u,lease,'Создана аренда: '+unit.title);
    return lease;
}
export function archiveDraftLease(db,u,leaseId) {
    const {lease}=leaseAccess(db,u,leaseId,{write:true,ownerOnly:true});
    if(memberIds(db,lease.id).length||db.get('SELECT 1 FROM records WHERE lease_id=?',lease.id))fail(409,'Аренда уже используется. Завершите её через согласование с жильцами.');
    db.run("UPDATE leases SET status='ended' WHERE id=?",lease.id);
    db.run("UPDATE recurring_rules SET state='paused',version=version+1 WHERE lease_id=?",lease.id);
    db.run('DELETE FROM invites WHERE lease_id=?',lease.id);
    event(db,u,lease,'Отменён неиспользованный период аренды');return {ok:true};
}
export const INVITE_DAYS=7;
const inviteFail=(status,reason,message,ctx)=>{const e=new Error(message);e.status=status;e.reason=reason;if(ctx)e.lease_id=ctx.lease.id;throw e;};
// One link admits one person: two tenants get two links. The code is shown to the
// owner right away and can be shared again while pending (see invite-codes.mjs).
export function createInvite(db,u,leaseId,{label='',secret=''}={}) {
    const {lease}=leaseAccess(db,u,leaseId,{write:true,ownerOnly:true});
    if(lease.status!=='active') fail(409,'Нельзя приглашать новых участников в завершаемую аренду.');
    const code=randomBytes(18).toString('base64url'),expires=Date.now()+INVITE_DAYS*86400000,h=hash(code),name=V.text(String(label||'').trim(),'Для кого',60,true);
    db.run('INSERT INTO invites VALUES(?,?,?,NULL)',h,leaseId,expires);
    db.run('INSERT INTO invite_meta(hash,lease_id,label,created_by,created_at,code_enc) VALUES(?,?,?,?,?,?)',h,leaseId,name,u.id,nowISO(),secret?sealCode(secret,code):null);
    return {id:h,code,label:name,expires:new Date(expires).toISOString()};
}
// Explains exactly why a link does not work, so the bot and the app can say what to do next.
export function previewInvite(db,u,code,{track=false}={}) {
    V.text(code,'Код',100);
    const h=hash(String(code).trim()),invite=db.get('SELECT * FROM invites WHERE hash=?',h);
    if(!invite) inviteFail(400,'not_found','Ссылка-приглашение не найдена. Проверьте, что она скопирована целиком, или попросите у собственника новую.');
    const meta=db.get('SELECT * FROM invite_meta WHERE hash=?',h),lease=db.get('SELECT * FROM leases WHERE id=?',invite.lease_id),apartment=db.get('SELECT * FROM apartments WHERE id=?',lease.apartment_id);
    const inviter=meta?.created_by&&managerRole(db,apartment,meta.created_by)?meta.created_by:apartment.owner_id;
    const ctx={lease,apartment,invite,meta,unit:unitName(db,lease),owner:db.get('SELECT name FROM users WHERE id=?',inviter).name};
    if(managerRole(db,apartment,u.id)) inviteFail(400,'own','Это ваша ссылка-приглашение. Отправьте её жильцу: он откроет её у себя и подтвердит присоединение.',ctx);
    if(isMember(db,u.id,lease.id)) inviteFail(409,'member','Вы уже участник этой аренды.',ctx);
    if(lease.status!=='active') inviteFail(409,'closed','Эта аренда уже недоступна для присоединения.',ctx);
    if(meta?.revoked_at) inviteFail(400,'revoked','Собственник отозвал эту ссылку. Попросите у него новую.',ctx);
    if(invite.used_by) inviteFail(400,'used','По этой ссылке уже присоединился другой человек: одна ссылка — для одного жильца. Попросите у собственника свою ссылку.',ctx);
    if(invite.expires<Date.now()) inviteFail(400,'expired',`Срок ссылки истёк (она действует ${INVITE_DAYS} дней). Попросите у собственника новую — в Ключах это одна кнопка.`,ctx);
    if(track&&meta&&!meta.opened_at) db.run('UPDATE invite_meta SET opened_at=?,opened_by=? WHERE hash=?',nowISO(),u.id,h);
    return ctx;
}
function memberDates(db,leases) {
    return leases.flatMap(l=>db.all('SELECT lease_id,user_id,joined_at FROM lease_members WHERE lease_id=?',l.id));
}
export function inviteStatus(row,now=Date.now()) {
    if(row.used_by) return 'accepted';
    if(row.revoked_at) return 'revoked';
    if(row.expires<now) return 'expired';
    return row.opened_at?'opened':'pending';
}
// Owner view: pending and recent invites of active leases, without codes.
export function listInvites(db,u) {
    const now=Date.now(),recent=new Date(now-30*86400000).toISOString();
    return db.all(`SELECT i.hash,i.lease_id,i.expires,i.used_by,m.label,m.created_at,m.opened_at,m.accepted_at,m.revoked_at,m.code_enc IS NOT NULL AS sealed,uu.name AS used_name
        FROM invites i JOIN invite_meta m ON m.hash=i.hash JOIN leases l ON l.id=i.lease_id JOIN apartments a ON a.id=l.apartment_id LEFT JOIN users uu ON uu.id=i.used_by
        WHERE ${managerSql('a')} AND l.status!='ended' AND m.replaced_by IS NULL AND m.created_at>? ORDER BY m.created_at DESC LIMIT 100`,u.id,recent)
      .map(r=>({id:r.hash,lease_id:r.lease_id,label:r.label,status:inviteStatus(r,now),created_at:r.created_at,expires:new Date(r.expires||0).toISOString(),opened_at:r.opened_at,accepted_at:r.accepted_at,accepted_name:r.used_name||'',shareable:!!r.sealed&&inviteStatus(r,now)!=='accepted'&&inviteStatus(r,now)!=='revoked'&&r.expires>=now}))
      .filter(r=>r.status!=='revoked'||Date.parse(r.created_at)>now-86400000);
}
function ownedInvite(db,u,id) {
    const row=db.get('SELECT i.*,m.label,m.code_enc,m.revoked_at FROM invites i JOIN invite_meta m ON m.hash=i.hash WHERE i.hash=?',V.text(id,'Приглашение',80));
    if(!row) fail(404,'Приглашение не найдено.');
    leaseAccess(db,u,row.lease_id,{write:true,ownerOnly:true});
    return row;
}
export function revokeInvite(db,u,id) {
    const row=ownedInvite(db,u,id);
    if(row.used_by) fail(409,'По этой ссылке уже присоединились. Ссылку отзывать не нужно.');
    db.run('UPDATE invites SET expires=0 WHERE hash=?',row.hash);
    db.run('UPDATE invite_meta SET revoked_at=COALESCE(revoked_at,?),code_enc=NULL WHERE hash=?',nowISO(),row.hash);
    return {ok:true};
}
// "Send again": the same link while it is pending, otherwise a fresh one that replaces it.
export function shareInvite(db,u,id,secret) {
    const row=ownedInvite(db,u,id),code=!row.used_by&&!row.revoked_at&&row.expires>=Date.now()?openCode(secret,row.code_enc):'';
    if(!code) fail(409,'Эту ссылку уже нельзя отправить повторно. Создайте новую.');
    return {id:row.hash,code,label:row.label,expires:new Date(row.expires).toISOString()};
}
export function renewInvite(db,u,id,secret) {
    const row=ownedInvite(db,u,id);
    if(row.used_by) fail(409,'По этой ссылке уже присоединились. Для следующего жильца создайте новое приглашение.');
    const next=createInvite(db,u,row.lease_id,{label:row.label,secret});
    db.run('UPDATE invites SET expires=0 WHERE hash=?',row.hash);
    db.run('UPDATE invite_meta SET revoked_at=COALESCE(revoked_at,?),code_enc=NULL,replaced_by=? WHERE hash=?',nowISO(),next.id,row.hash);
    return next;
}
export function joinInvite(db,u,code) {
    const {lease:l,apartment:a,meta}=previewInvite(db,u,code);
    db.run('INSERT INTO lease_members VALUES(?,?,?)',l.id,u.id,nowISO());
    if(!l.tenant_id) db.run('UPDATE leases SET tenant_id=? WHERE id=?',u.id,l.id);
    db.run('UPDATE invites SET used_by=? WHERE hash=? AND used_by IS NULL',u.id,hash(String(code).trim()));
    db.run('UPDATE invite_meta SET accepted_at=?,code_enc=NULL WHERE hash=?',nowISO(),hash(String(code).trim()));
    db.run("UPDATE users SET role='tenant' WHERE id=?",u.id);
    // A new co-tenant cannot be silently bound by an unresolved group proposal.
    for(const r of db.all("SELECT * FROM records WHERE lease_id=? AND kind IN ('visit','terms','termination') AND status IN ('proposed','counter')",l.id).map(decode)) {
        r.payload.required_approvals=[...new Set([...(r.payload.required_approvals||proposalVoters(db,l,r.payload.proposer)),u.id])];
        db.run('UPDATE records SET payload=?,version=version+1,updated_at=? WHERE id=?',JSON.stringify(r.payload),nowISO(),r.id);
    }
    for(const r of db.all("SELECT * FROM records WHERE lease_id=? AND kind='visit' AND status='accepted'",l.id).map(decode)) {
        if(Date.parse(r.payload.end)<=Date.now())continue;
        const required=proposalVoters(db,l,r.payload.proposer);
        const previouslyAccepted=r.payload.accepted_by||required.filter(id=>id!==u.id);
        r.payload.required_approvals=required;r.payload.accepted_by=previouslyAccepted.filter(id=>id!==u.id);
        db.run("UPDATE records SET status='proposed',payload=?,version=version+1,updated_at=? WHERE id=?",JSON.stringify(r.payload),nowISO(),r.id);
        pushNotification(db,u.id,'Подтвердите предстоящее посещение','До вашего присоединения жильцы согласовали визит. Проверьте время и подтвердите его или предложите другое.',r.id);
    }
    event(db,u,l,u.name+' присоединился к аренде');
    notifyOther(db,u,{lease:l,apartment:a,owner:false},'Новый участник аренды',null,'shared',u.name+' присоединился'+(meta?.label?` по ссылке «${meta.label}»`:'')+'. Начисления общие для этой группы, а не отдельная полная сумма каждому.',{target:'l_'+l.id});
    return {apartment_id:a.id,lease_id:l.id};
}
// Owners vote as one side: any owner's answer counts for all of them and is stored
// under the main owner's id. Tenants vote one by one.
export function voterId(db,apartment,userId) { return managerRole(db,apartment,userId)?apartment.owner_id:userId; }
export const sameSide=(db,apartment,a,b)=>a===b||(!!managerRole(db,apartment,a)&&!!managerRole(db,apartment,b));
export function proposalVoters(db,lease,proposer) {
    const a=db.get('SELECT id,owner_id FROM apartments WHERE id=?',lease.apartment_id),side=voterId(db,a,proposer);
    return [a.owner_id,...memberIds(db,lease.id)].filter(id=>id!==side);
}
function approveProposal(db,u,ctx,p) {
    const required=p.required_approvals||proposalVoters(db,ctx.lease,p.proposer),voter=voterId(db,ctx.apartment,u.id);
    if(!required.includes(voter)||sameSide(db,ctx.apartment,p.proposer,u.id)) fail(403,'Предложение подтверждают остальные участники.');
    const accepted=p.accepted_by||[];
    if(accepted.includes(voter)) fail(409,'Это предложение уже подтверждено с вашей стороны. Ожидается ответ остальных.');
    p.required_approvals=required; p.accepted_by=[...accepted,voter];
    return required.every(id=>p.accepted_by.includes(id));
}
export function createRecord(db, u, b, config) {
    const ctx = leaseAccess(db, u, V.text(b.lease_id, 'Аренда', 80), { write: true }), p = V.own(b.payload), files = V.attachmentIds(b.files);
    const kind = V.choice(b.kind, ['ticket', 'purchase', 'visit', 'charge', 'reading', 'document', 'expense', 'termination', 'terms']);
    if (['visit', 'charge', 'expense', 'terms'].includes(kind) && !ctx.owner)
        fail(403, 'Действие доступно только собственнику.');
    if (['purchase', 'reading'].includes(kind) && ctx.owner)
        fail(403, 'Это действие выполняет арендатор.');
    const title = V.text(b.title, 'Название', 180);
    if (kind === 'ticket')
        return insertRecord(db, u, ctx, kind, 'open', title, { description: V.text(p.description, 'Описание', 3000), room: V.text(p.room, 'Помещение', 80), priority: V.choice(p.priority || 'normal', ['normal', 'urgent']) }, 'shared', null, files);
    if (kind === 'purchase')
        return insertRecord(db, u, ctx, kind, 'pending', title, { amount: V.integer(p.amount, 'Сумма', 1), description: V.text(p.description, 'Описание', 2000, true), purchase_date: V.date(p.purchase_date), settlement: 'Отдельная компенсация; арендная плата не уменьшается автоматически.' }, 'shared', null, files);
    if (kind === 'visit') {
        if (!memberIds(db,ctx.lease.id).length)
            fail(409, 'Сначала пригласите арендатора.');
        return insertRecord(db, u, ctx, kind, 'proposed', title, { ...V.visitTimes(p), reason: V.text(p.reason, 'Причина', 2000), proposer: u.id, required_approvals: proposalVoters(db,ctx.lease,u.id), accepted_by: [] }, 'shared', null, files);
    }
    if (kind === 'charge') {
        const due=V.date(p.due),period=validMonth(p.period),amount=V.integer(p.amount,'Сумма',1);
        if(due<ctx.lease.start||due>ctx.lease.end) fail(400,'Срок платежа должен попадать в период аренды.');
        let rule=null;
        if(p.repeat===true) rule=createRecurringRule(db,u,{lease_id:ctx.lease.id,title,amount,due_day:Number(due.slice(8)),start_month:period,advance_days:p.advance_days??14},config);
        return insertRecord(db,u,ctx,kind,'pending',title,{amount,confirmed:0,due,period,payments:[],claims:[],claim:null,...(rule?{rule_id:rule.id}:{})},'shared',rule?`recurring:${rule.id}:${period}`:null,files);
    }
    if (kind === 'reading') return recordReading(db,u,ctx,p,files,config);
    if (kind === 'document') {
        if (!files.length)
            fail(400, 'Прикрепите документ.');
        const visibility = ctx.owner && p.private ? 'owner' : 'shared';
        return insertRecord(db, u, ctx, kind, 'stored', title, { category: V.choice(p.category || 'other', ['contract', 'act', 'receipt', 'agreement', 'other']), description: V.text(p.description, 'Описание', 1000, true) }, visibility, null, files);
    }
    if (kind === 'expense')
        return insertRecord(db, u, ctx, kind, 'recorded', title, { amount: V.integer(p.amount, 'Сумма', 1), date: V.date(p.date), description: V.text(p.description, 'Описание', 2000, true) }, 'owner', null, files);
    if (kind === 'termination') {
        if (db.get("SELECT id FROM records WHERE lease_id=? AND kind='termination' AND status IN ('proposed','accepted')", ctx.lease.id))
            fail(409, 'Запрос на завершение уже отправлен.');
        return insertRecord(db, u, ctx, kind, 'proposed', title, { date: terminationDate(p.date, ctx.lease), reason: V.text(p.reason, 'Комментарий', 2000), proposer: u.id, required_approvals: proposalVoters(db,ctx.lease,u.id), accepted_by: [] }, 'shared', null, files);
    }
    if (kind === 'terms') {
        if (db.get("SELECT id FROM records WHERE lease_id=? AND kind='terms' AND status='proposed'", ctx.lease.id))
            fail(409, 'Сначала завершите предыдущее согласование.');
        return insertRecord(db, u, ctx, kind, 'proposed', title, { rent: V.integer(p.rent, 'Новая плата', 1), terms: V.text(p.terms, 'Условия', 3000), due_day: V.integer(p.due_day||ctx.lease.due_day,'День оплаты',1,31), previous_rent: ctx.lease.rent, previous_terms: ctx.lease.terms, previous_due_day:ctx.lease.due_day, proposer: u.id, required_approvals: proposalVoters(db,ctx.lease,u.id), accepted_by: [], effective_month: validateTermsMonth(db,ctx.lease,p.effective_month,config) }, 'shared', null, files);
    }
}
function terminationDate(value, lease) { const d = V.date(value); if (d < lease.start)
    fail(400, 'Дата завершения не может быть раньше начала аренды.'); return d; }
export const statusText = { open: 'Открыта', in_progress: 'В работе', resolved: 'Ожидает подтверждения арендатора', closed: 'Решена', cancelled: 'Отменено', pending: 'На согласовании', approved: 'Одобрено', rejected: 'Отклонено', compensated: 'Компенсировано', proposed: 'Предложено время', counter: 'Предложено другое время', accepted: 'Согласовано', completed: 'Состоялось', claimed: 'Ожидает подтверждения собственника', partial: 'Частично оплачено', paid: 'Оплачено', submitted: 'Передано', stored: 'Сохранено', recorded: 'Записано' };
export function actionRecord(db, u, id, b) {
    const ctx = recordAccess(db, u, id, true), r = ctx.record, p = { ...r.payload };
    const version = V.integer(b.version, 'Версия', 1);
    if (r.version !== version)
        fail(409, 'Запись уже изменилась. Обновите экран и повторите действие.');
    const act = V.text(b.action, 'Действие', 60);
    let status = r.status;
    const deny = () => fail(409, 'Это действие уже недоступно для текущего статуса.');
    const owner = () => { if (!ctx.owner)
        fail(403, 'Действие доступно собственнику.'); };
    const tenant = () => { if (ctx.owner || !isMember(db,u.id,ctx.lease.id))
        fail(403, 'Действие доступно арендатору.'); };
    const inStatus = (list) => { if (!list.includes(r.status))
        deny(); };
    let label = '';
    if (r.kind === 'ticket') {
        if (act === 'start') {
            owner();
            inStatus(['open']);
            status = 'in_progress';
        }
        else if (act === 'resolve') {
            owner();
            inStatus(['open', 'in_progress']);
            p.result = V.text(b.note, 'Что сделано', 2000);
            status = 'resolved';
        }
        else if (act === 'confirm') {
            tenant();
            inStatus(['resolved']);
            if(!managerRole(db,ctx.apartment,r.created_by) && r.created_by!==u.id) fail(403,'Результат подтверждает автор заявки.');
            status = 'closed';
        }
        else if (act === 'reopen') {
            tenant();
            inStatus(['resolved', 'closed']);
            p.reopen_reason = V.text(b.note, 'Что осталось сделать', 2000);
            status = 'in_progress';
        }
        else if (act === 'cancel') {
            if (r.created_by !== u.id)
                fail(403, 'Отменить может автор.');
            inStatus(['open']);
            status = 'cancelled';
        }
        else
            deny();
    }
    else if (r.kind === 'purchase') {
        owner();
        if (act === 'approve') {
            inStatus(['pending']);
            status = 'approved';
        }
        else if (act === 'reject') {
            inStatus(['pending']);
            p.reason = V.text(b.note, 'Причина', 2000);
            status = 'rejected';
        }
        else if (act === 'compensate') {
            inStatus(['approved']);
            p.compensated_at = nowISO();
            p.note = V.text(b.note, 'Комментарий', 1000, true);
            status = 'compensated';
        }
        else
            deny();
    }
    else if (r.kind === 'visit') {
        if (act === 'accept') {
            inStatus(['proposed', 'counter']);
            if (sameSide(db, ctx.apartment, p.proposer, u.id))
                fail(403, 'Предложенное время подтверждает другая сторона.');
            if (Date.parse(p.start) < Date.now())
                fail(409, 'Предложенное время уже прошло. Предложите новое.');
            status = approveProposal(db,u,ctx,p) ? 'accepted' : r.status;
            if(status!== 'accepted') label=u.name+' подтвердил время — ждём остальных';
        }
        else if (act === 'counter') {
            inStatus(['proposed', 'counter', 'accepted']);
            Object.assign(p, V.visitTimes(b));
            p.proposer = u.id;
            p.required_approvals=proposalVoters(db,ctx.lease,u.id); p.accepted_by=[];
            status = 'counter';
        }
        else if (act === 'cancel') {
            inStatus(['proposed', 'counter', 'accepted']);
            p.reason_cancel = V.text(b.note, 'Комментарий', 1000, true);
            status = 'cancelled';
        }
        else if (act === 'complete') {
            owner();
            inStatus(['accepted']);
            if (Date.parse(p.start) > Date.now())
                fail(409, 'Посещение ещё не началось.');
            status = 'completed';
        }
        else
            deny();
    }
    else if (r.kind === 'charge') {
        inStatus(['pending','partial','claimed']);
        p.claims=(p.claims||(p.claim?[p.claim]:[])).map(c=>({...c,id:c.id||randomUUID()}));
        const reserved=p.claims.reduce((sum,c)=>sum+c.amount,0),available=p.amount-p.confirmed-reserved;
        // Payments happen outside the app, mostly in cash. A tenant marks the hand-over (amount,
        // date, optional photo); only the owner turns it into «Оплачено» by confirming receipt.
        const method=()=>V.choice(b.method||'cash',['cash','transfer'],'Способ оплаты');
        const zone=process.env.TZ||'Europe/Moscow',paidOn=()=>{const d=b.paid_on?V.date(b.paid_on,'Дата оплаты'):dateInZone(zone);if(d>dateInZone(zone,Date.now()+86400000))fail(400,'Дата оплаты не может быть в будущем.');return d;};
        const fileIds=V.attachmentIds(b.files);
        const how=m=>m==='cash'?'наличными':'переводом';
        if(act==='claim') {
            tenant();
            if(p.claims.some(c=>c.user_id===u.id)) fail(409,'Ваша оплата уже ждёт подтверждения собственника.');
            if(available<=0) fail(409,'Вся оставшаяся сумма уже ждёт подтверждения.');
            const claim={id:randomUUID(),amount:V.integer(b.amount,'Сумма',1,available),method:method(),paid_on:paidOn(),note:V.text(b.note,'Комментарий',1000,true),at:nowISO(),user_id:u.id,files:fileIds};
            p.claims.push(claim);
            label=`${u.name}: ${claim.method==='cash'?'передал наличными':'перевёл'} ${formatMoney(claim.amount)} — подтвердите получение`;
        } else if(act==='confirm'||act==='reject') {
            owner();
            const claim=b.claim_id?p.claims.find(c=>c.id===b.claim_id):p.claims[0];
            if(!claim) fail(409,'Эта оплата уже обработана. Обновите экран.');
            if(act==='confirm') {
                if(p.confirmed+claim.amount>p.amount) fail(409,'Сумма превышает остаток начисления.');
                p.confirmed+=claim.amount;
                p.payments=[...p.payments,{...claim,confirmed_by:u.id,confirmed_at:nowISO()}];
                label=`Получено ${formatMoney(claim.amount)} ${how(claim.method||'transfer')} — подтверждение: ${u.name}`;
            } else {
                p.rejection=V.text(b.note,'Что не так',1000);
                p.disputes=[...(p.disputes||[]),{...claim,reason:p.rejection,by:u.id,disputed_at:nowISO()}];
                label=`Не подтверждено ${formatMoney(claim.amount)} ${how(claim.method||'transfer')}: ${p.rejection} — ${u.name}`;
            }
            p.claims=p.claims.filter(c=>c.id!==claim.id);
        } else if(act==='record_payment') {
            owner();if(available<=0) fail(409,'Сначала обработайте оплаты, которые ждут подтверждения.');
            const amount=V.integer(b.amount,'Полученная сумма',1,available);
            const payer=b.payer_id||null;
            if(payer&&!isMember(db,payer,ctx.lease.id)) fail(400,'Плательщик не участвует в этой аренде.');
            const m=method();
            p.confirmed+=amount;
            p.payments=[...p.payments,{id:randomUUID(),amount,method:m,paid_on:paidOn(),user_id:payer,note:V.text(b.note,'Комментарий',1000,true),files:fileIds,confirmed_by:u.id,confirmed_at:nowISO(),source:'owner_manual'}];
            label=`Записано получение ${formatMoney(amount)} ${how(m)} — ${u.name}`;
        } else deny();
        p.claim=p.claims[0]||null; // Backward-compatible field for older clients; authoritative list is claims.
        status=p.claims.length?'claimed':p.confirmed===p.amount?'paid':p.confirmed?'partial':'pending';
    }
    else if (r.kind === 'terms') {
        inStatus(['proposed']);
        if (act === 'accept') {
            tenant();
            if(approveProposal(db,u,ctx,p)) {
                applyTerms(db,ctx.lease,p);
                status='accepted'; label='Согласованы новые условия с '+monthText(p.effective_month);
            } else { label=u.name+' согласовал условия — ждём остальных'; }
        }
        else if (act === 'reject') {
            tenant();
            p.reason = V.text(b.note, 'Комментарий', 1000);
            status = 'rejected';
        }
        else if (act === 'cancel') {
            owner();
            status = 'cancelled';
        }
        else
            deny();
    }
    else if (r.kind === 'termination') {
        if (act === 'accept') {
            inStatus(['proposed']);
            if (sameSide(db, ctx.apartment, p.proposer, u.id))
                fail(403, 'Запрос подтверждает другая сторона.');
            if(approveProposal(db,u,ctx,p)) { status='accepted'; db.run("UPDATE leases SET status='ending' WHERE id=?",ctx.lease.id);
                for(const bill of db.all("SELECT * FROM records WHERE lease_id=? AND kind='charge' AND status='pending'",ctx.lease.id).map(decode)) {
                    if(bill.payload.rule_id&&bill.payload.due>p.date&&!bill.payload.confirmed&&!(bill.payload.claims||[]).length&&!bill.payload.claim) {
                        bill.payload.cancel_reason='Стороны согласовали завершение аренды до срока этого будущего регулярного начисления.';
                        db.run("UPDATE records SET status='cancelled',payload=?,version=version+1,updated_at=? WHERE id=?",JSON.stringify(bill.payload),nowISO(),bill.id);
                        event(db,u,ctx.lease,'Отменено будущее начисление при завершении аренды: '+bill.title,bill.id);
                        notifyOther(db,u,ctx,'Отменено будущее начисление',bill.id);
                    }
                }
            }
            else label=u.name+' согласовал завершение — ждём остальных';
        }
        else if (act === 'reject') {
            inStatus(['proposed']);
            if (sameSide(db, ctx.apartment, p.proposer, u.id))
                deny();
            status = 'rejected';
            p.reason = V.text(b.note, 'Комментарий', 1000);
        }
        else if (act === 'cancel') {
            inStatus(['proposed']);
            if (!sameSide(db, ctx.apartment, p.proposer, u.id))
                deny();
            status = 'cancelled';
        }
        else if (act === 'complete') {
            owner();
            inStatus(['accepted']);
            const today = dateInZone(process.env.TZ || 'Europe/Moscow');
            if (p.date > today)
                fail(409, 'Дата завершения ещё не наступила.');
            if (db.get("SELECT id FROM records WHERE lease_id=? AND kind='charge' AND status NOT IN ('paid','cancelled')", ctx.lease.id))
                fail(409, 'Сначала урегулируйте все начисления.');
            if (db.get("SELECT id FROM records WHERE lease_id=? AND kind='purchase' AND status IN ('pending','approved')", ctx.lease.id))
                fail(409, 'Сначала урегулируйте покупки и компенсации.');
            status = 'completed';
            db.run("UPDATE leases SET status='ended',end=? WHERE id=?", p.date, ctx.lease.id);
            db.run("UPDATE recurring_rules SET state='paused',version=version+1 WHERE lease_id=? AND state='active'",ctx.lease.id);
            db.run('DELETE FROM invites WHERE lease_id=?', ctx.lease.id);
        }
        else
            deny();
    }
    else
        fail(400, 'Для этой записи нет такого действия.');
    attach(db, u, ctx.lease, r.id, b.files || []);
    db.run('UPDATE records SET status=?,payload=?,version=version+1,updated_at=? WHERE id=? AND version=?', status, JSON.stringify(p), nowISO(), r.id, version);
    const title = label || `${r.title}: ${statusText[status] || status}`;
    event(db, u, ctx.lease, title, r.id, r.visibility);
    notifyOther(db, u, ctx, title, r.id, r.visibility);
    return decode(db.get('SELECT * FROM records WHERE id=?', r.id));
}
export function addComment(db,u,id,b) {
    const {record,lease,...ctx}=recordAccess(db,u,id,true),text=V.text(b.text,'Комментарий',3000);
    db.run('INSERT INTO comments VALUES(?,?,?,?,?)',randomUUID(),id,u.id,text,nowISO());
    event(db,u,lease,'Новый комментарий: '+record.title,id,record.visibility);
    notifyOther(db,u,{...ctx,lease},`${u.name} ответил: «${record.title}»`,id,record.visibility,`«${text.slice(0,1200)}»`,{discussion:true});
    return {ok:true};
}
export function updateProfile(db, u, b) { const name = V.text(b.name, 'Имя', 120), role = V.choice(b.role, ['owner', 'tenant']); const s = settings(u); for (const key of ['events', 'reminders', 'bot'])
    if (typeof b.settings?.[key] === 'boolean')
        s[key] = b.settings[key]; if (b.settings?.tax_status !== undefined)
    s.tax_status = V.choice(b.settings.tax_status, ['not_set', 'individual', 'self_employed', 'entrepreneur']); if(b.settings?.theme!==undefined)s.theme=V.choice(b.settings.theme,['auto','light','dark']); db.run('UPDATE users SET name=?,role=?,settings=? WHERE id=?', name, role, JSON.stringify(s), u.id); return safeUser(db.get('SELECT * FROM users WHERE id=?', u.id)); }

export const monthText = ym => new Date(ym+'-01T12:00:00Z').toLocaleDateString('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'});
const humanDate = value => new Date(value.length===10?value+'T12:00:00Z':value).toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
export function visibleMeters(db,lease,{activeOnly=true}={}) {
    return db.all(`SELECT * FROM meters WHERE (lease_id=? OR (scope='apartment' AND apartment_id=?)) ${activeOnly?'AND active=1':''} ORDER BY scope,CASE kind WHEN 'cold_water' THEN 0 WHEN 'hot_water' THEN 1 WHEN 'electricity' THEN 2 WHEN 'gas' THEN 3 WHEN 'heating' THEN 4 ELSE 5 END,label,id`,lease.id,lease.apartment_id);
}
export function meterPrevious(db,m,period=null) {
    const value=period ? db.get('SELECT * FROM meter_values WHERE meter_id=? AND period<? ORDER BY period DESC LIMIT 1',m.id,period) : db.get('SELECT * FROM meter_values WHERE meter_id=? ORDER BY period DESC LIMIT 1',m.id);
    return value?.value ?? m.baseline;
}
const meterKinds=['cold_water','hot_water','gas','electricity','heating','other'];
const meterUnits=['м³','кВт·ч','Гкал','МВт·ч','л','ед.'];
export function createMeter(db,u,leaseId,b) {
    const {lease}=leaseAccess(db,u,leaseId,{write:true,ownerOnly:true});
    const kind=V.choice(b.kind||'other',meterKinds),label=V.text(b.label,'Название счётчика',80),unit=V.choice(b.unit||'ед.',meterUnits);
    const scope=V.choice(b.scope||'lease',['lease','apartment']);
    const scheme=kind==='electricity'?V.choice(b.scheme||'single',['single','dual','triple']):'single';
    const tariffs=scheme==='single'?['']:scheme==='dual'?['Т1 · день','Т2 · ночь']:['Т1 · пик','Т2 · ночь','Т3 · полупик'];
    if(db.get('SELECT COUNT(*) AS n FROM meters WHERE apartment_id=? AND active=1',lease.apartment_id).n+tariffs.length>100) fail(400,'На квартиру поддерживается до 100 активных каналов учёта.');
    const group=randomUUID(),baseline=V.integer(b.baseline??0,'Начальное показание',0,1000000000000),ids=[],price=meterPrice(b.price);
    for(const tariff of tariffs) {
      const id=randomUUID();ids.push(id);
      db.run(`INSERT INTO meters(id,lease_id,label,unit,baseline,apartment_id,scope,kind,group_id,tariff,baseline_at,price) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,id,lease.id,label+(tariff?' — '+tariff:''),unit,baseline,lease.apartment_id,scope,kind,group,tariff,baseline>0?nowISO():null,price);
    }
    event(db,u,lease,'Добавлен счётчик: '+label);
    notifyMeterUsers(db,u,lease,scope,'Настроены счётчики: '+label);
    return {meters:ids.map(id=>db.get('SELECT * FROM meters WHERE id=?',id))};
}
function notifyMeterUsers(db,u,lease,scope,title) {
    const leases=scope==='apartment'?db.all("SELECT * FROM leases WHERE apartment_id=? AND status!='ended'",lease.apartment_id):[lease];
    for(const l of leases) for(const id of memberIds(db,l.id)) if(id!==u.id) pushNotification(db,id,title,'Проверьте актуальный набор счётчиков перед передачей показаний.',null,null,'events',{target:'m_'+l.id});
}
export function updateMeter(db,u,id,b) {
    const m=db.get('SELECT * FROM meters WHERE id=?',id);if(!m) fail(404,'Счётчик не найден.');
    apartmentAccess(db,u,m.apartment_id,true);
    const lease=db.get('SELECT * FROM leases WHERE id=?',m.lease_id);
    if(lease.status==='ended'&&m.scope==='lease') fail(409,'Аренда завершена. Архивные счётчики не изменяются.');
    if(b.version!==undefined&&V.integer(b.version,'Версия',1)!==m.version) fail(409,'Счётчик уже изменён. Обновите экран.');
    if(b.active===true&&!m.active&&db.get('SELECT COUNT(*) AS n FROM meters WHERE apartment_id=? AND active=1',m.apartment_id).n>=100)fail(400,'Сначала архивируйте ненужный счётчик: предел 100 активных каналов.');
    const hasReadings=!!db.get('SELECT 1 FROM meter_values WHERE meter_id=?',id);
    if(b.baseline!==undefined&&hasReadings) fail(409,'Начальное значение нельзя менять после передачи показаний. При замене архивируйте счётчик и добавьте новый.');
    const label=b.label===undefined?m.label:V.text(b.label,'Название',80),baseline=b.baseline===undefined?m.baseline:V.integer(b.baseline,'Начальное показание',0,1000000000000);
    if(b.active!==undefined&&typeof b.active!=='boolean') fail(400,'Активность счётчика должна быть true или false.');
    const price=b.price===undefined?m.price:meterPrice(b.price),baselineAt=b.baseline!==undefined&&baseline!==m.baseline?nowISO():m.baseline_at;
    db.run('UPDATE meters SET label=?,baseline=?,active=?,price=?,baseline_at=?,version=version+1 WHERE id=?',label,baseline,b.active===undefined?m.active:b.active?1:0,price,baselineAt,id);
    event(db,u,lease,b.active===false?'Счётчик перенесён в архив: '+m.label:'Обновлён счётчик: '+label);
    notifyMeterUsers(db,u,lease,m.scope,'Обновлены настройки счётчиков');
    return db.get('SELECT * FROM meters WHERE id=?',id);
}
// Price per unit in kopecks (optional): shows what a month of consumption costs.
function meterPrice(v) {
    if(v===undefined||v===null||v==='') return null;
    return V.integer(v,'Цена за единицу',0,100000000);
}
// First readings at move-in: the owner writes the current numbers, no photo needed.
// Allowed while a meter has no monthly readings yet; later the tenants send readings with photos.
export function setBaselines(db,u,leaseId,b) {
    const {lease}=leaseAccess(db,u,leaseId,{write:true,ownerOnly:true});
    if(lease.status==='ended') fail(409,'Аренда завершена.');
    if(!Array.isArray(b.values)||!b.values.length||b.values.length>100) fail(400,'Укажите показания счётчиков.');
    const meters=visibleMeters(db,lease),seen=new Set(),changed=[];
    for(const v of b.values) {
        const m=meters.find(x=>x.id===v?.meter_id);
        if(!m||seen.has(m.id)) fail(400,'Счётчики изменились. Обновите экран.');
        seen.add(m.id);
        if(db.get('SELECT 1 FROM meter_values WHERE meter_id=?',m.id)) fail(409,m.label+': жильцы уже передавали показания, стартовое значение не меняется.');
        const value=V.integer(v.value,m.label,0,1000000000000);
        db.run('UPDATE meters SET baseline=?,baseline_at=?,version=version+1 WHERE id=?',value,nowISO(),m.id);
        changed.push(`${m.label}: ${value/1000} ${m.unit}`);
    }
    event(db,u,lease,'Записаны стартовые показания');
    for(const id of memberIds(db,lease.id)) if(id!==u.id) pushNotification(db,id,'Записаны стартовые показания',changed.join('\n')+'\nДальше показания передаёте вы: раз в месяц, с фото счётчиков.',null,null,'events',{target:'m_'+lease.id});
    return {meters:meters.filter(m=>seen.has(m.id)).map(m=>db.get('SELECT * FROM meters WHERE id=?',m.id))};
}
export function configureMeters(db,u,leaseId,b) {
    const {lease}=leaseAccess(db,u,leaseId,{write:true,ownerOnly:true});
    if(typeof b.enabled!=='boolean') fail(400,'Укажите, включены ли показания.');
    db.run('UPDATE leases SET meters_enabled=? WHERE id=?',b.enabled?1:0,lease.id);
    event(db,u,lease,b.enabled?'Учёт показаний включён':'Учёт показаний отключён');
    notifyMeterUsers(db,u,lease,'lease',b.enabled?'Показания включены':'Показания отключены');
    return {ok:true};
}
function recordReading(db,u,ctx,p,files,config) {
    if(!ctx.lease.meters_enabled) fail(409,'Показания для этой аренды отключены собственником.');
    const period=dateInZone(config.timezone).slice(0,7),all=visibleMeters(db,ctx.lease);
    if(!all.length) fail(400,'Собственник ещё не настроил счётчики.');
    const meters=all.filter(m=>!db.get('SELECT 1 FROM meter_values WHERE meter_id=? AND period=?',m.id,period));
    if(!meters.length) fail(409,'Все показания за этот месяц уже переданы.');
    if(!Array.isArray(p.values)||p.values.length!==meters.length) fail(400,'Набор счётчиков изменился или показания уже переданы другим участником. Обновите экран.');
    // Tenants back the numbers with a photo of the meters; the owner's starting readings need none.
    const photos=files.filter(id=>String(db.get('SELECT mime FROM files WHERE id=?',id)?.mime||'').startsWith('image/'));
    if(!photos.length) fail(400,'Прикрепите фото счётчиков: по нему собственник сверит цифры.');
    const values=meters.map(m=>{
        const entries=p.values.filter(v=>v.meter_id===m.id);if(entries.length!==1) fail(400,'Счётчики не совпадают с настройками. Обновите экран.');
        const value=V.integer(entries[0].value,m.label,0,1000000000000),previous=meterPrevious(db,m,period);
        if(value<previous) fail(400,m.label+': показание меньше предыдущего. При замене добавьте новый счётчик.');
        return {meter_id:m.id,label:m.label,unit:m.unit,scope:m.scope,value,previous,consumption:value-previous,...(m.price!=null?{price:m.price,cost:Math.round((value-previous)*m.price/1000)}:{})};
    });
    const r=insertRecord(db,u,ctx,'reading','submitted','Показания за '+monthText(period),{period,values},'shared',null,files);
    for(const v of values) db.run('INSERT INTO meter_values VALUES(?,?,?,?,?,?)',v.meter_id,period,v.value,v.previous,r.id,r.created_at);
    // Other rooms can see the numeric common reading, not this room's files or contract.
    for(const v of values.filter(v=>v.scope==='apartment')) for(const other of db.all("SELECT * FROM leases WHERE apartment_id=? AND id!=? AND status!='ended'",ctx.apartment.id,ctx.lease.id)) {
        for(const uid of memberIds(db,other.id)) pushNotification(db,uid,'Переданы общие показания',`${v.label}: ${v.value/1000} ${v.unit} · ${monthText(period)}`,null,`common:${v.meter_id}:${period}:${uid}`,'events',{target:'m_'+other.id});
    }
    return r;
}
// «Собственники»: the main owner first, then co-owners, with the date they joined.
export function apartmentOwners(db,a) {
    return managerIds(db,a).map(id=>{const m=db.get('SELECT created_at FROM apartment_members WHERE apartment_id=? AND user_id=?',a.id,id);return {id,name:db.get('SELECT name FROM users WHERE id=?',id)?.name||'Собственник',role:id===a.owner_id?'owner':'co_owner',since:m?.created_at||a.created_at};});
}
export function bootstrap(db,u,config,{coverUrls=true}={}) {
    const access=`(${managerSql('a')} OR EXISTS(SELECT 1 FROM lease_members lm WHERE lm.lease_id=l.id AND lm.user_id=?))`;
    const apartments=db.all(`SELECT DISTINCT a.* FROM apartments a LEFT JOIN leases l ON l.apartment_id=a.id WHERE ${access} ORDER BY a.created_at`,u.id,u.id).map(a=>({...presentApartment(db,u,a,config,coverUrls),my_role:managerRole(db,a,u.id)||'tenant',owners:apartmentOwners(db,a)}));
    const leases=db.all(`SELECT l.* FROM leases l JOIN apartments a ON a.id=l.apartment_id WHERE ${access} ORDER BY l.created_at DESC`,u.id,u.id).map(l=>({...l,tenant_ids:memberIds(db,l.id),unit_title:unitName(db,l)}));
    const recordAccessSql=`(${managerSql('a')} OR (r.visibility='shared' AND EXISTS(SELECT 1 FROM lease_members lm WHERE lm.lease_id=r.lease_id AND lm.user_id=?)))`;
    const records=db.all(`SELECT r.* FROM records r JOIN apartments a ON a.id=r.apartment_id WHERE ${recordAccessSql} ORDER BY r.created_at DESC`,u.id,u.id).map(decode);
    const events=db.all(`SELECT e.*,u.name AS author FROM events e JOIN users u ON u.id=e.user_id JOIN apartments a ON a.id=e.apartment_id WHERE ${managerSql('a')} OR (e.visibility='shared' AND EXISTS(SELECT 1 FROM lease_members lm WHERE lm.lease_id=e.lease_id AND lm.user_id=?)) ORDER BY e.created_at DESC LIMIT 1000`,u.id,u.id);
    for(const l of leases) {
        const future=records.filter(r=>r.lease_id===l.id&&r.kind==='terms'&&r.status==='accepted'&&r.payload.effective_month>dateInZone(config.timezone).slice(0,7)).sort((a,b)=>a.payload.effective_month.localeCompare(b.payload.effective_month))[0];
        l.current_rent=future?future.payload.previous_rent:l.rent;
        l.current_terms=future?future.payload.previous_terms:l.terms;
        l.current_due_day=future?(future.payload.previous_due_day||l.due_day):l.due_day;
    }
    const notifications=db.all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 200',u.id);
    const ids=new Set([u.id,...leases.flatMap(l=>l.tenant_ids),...apartments.flatMap(a=>a.owners.map(o=>o.id))]);
    const people=[...ids].map(id=>db.get('SELECT id,name FROM users WHERE id=?',id));
    const units=db.all(`SELECT ru.* FROM rental_units ru JOIN apartments a ON a.id=ru.apartment_id WHERE ${managerSql('a')} OR EXISTS(SELECT 1 FROM leases l JOIN lease_members lm ON lm.lease_id=l.id WHERE l.unit_id=ru.id AND lm.user_id=?) ORDER BY ru.created_at,ru.title`,u.id,u.id);
    const meterMap=new Map();for(const l of leases) for(const m of visibleMeters(db,l,{activeOnly:false})) meterMap.set(m.id,m);
    const meters=[...meterMap.values()];
    const meter_history=[];
    for(const m of meters) {
        const own=apartments.some(a=>a.id===m.apartment_id&&a.my_role!=='tenant');
        const allowed=leases.filter(l=>l.id===m.lease_id||(m.scope==='apartment'&&l.apartment_id===m.apartment_id));
        for(const v of db.all('SELECT * FROM meter_values WHERE meter_id=? ORDER BY period DESC',m.id)) {
            if(own||allowed.some(l=>v.period>=l.start.slice(0,7)&&v.period<=l.end.slice(0,7))) meter_history.push({...v,record_id:records.some(r=>r.id===v.record_id)?v.record_id:null});
        }
        // Current baseline only; never expose another room's record or file identifiers.
        const lastVisible=meter_history.find(v=>v.meter_id===m.id);
        const before=allowed.map(l=>l.start.slice(0,7)).sort()[0];
        m.previous=lastVisible?.value??(before?meterPrevious(db,m,before):m.baseline);
    }
    const comments=db.all(`SELECT c.*,u.name AS author FROM comments c JOIN users u ON u.id=c.user_id JOIN records r ON r.id=c.record_id JOIN apartments a ON a.id=r.apartment_id WHERE ${recordAccessSql} ORDER BY c.created_at`,u.id,u.id);
    const files=db.all(`SELECT f.id,f.record_id,f.name,f.mime,f.size FROM files f JOIN records r ON r.id=f.record_id JOIN apartments a ON a.id=r.apartment_id WHERE ${recordAccessSql}`,u.id,u.id);
    const recurring_rules=db.all(`SELECT rr.* FROM recurring_rules rr JOIN leases l ON l.id=rr.lease_id JOIN apartments a ON a.id=l.apartment_id WHERE ${access} AND rr.state!='deleted' ORDER BY rr.created_at`,u.id,u.id).map(rr=>({...rr,next_editable_month:nextEditableMonth(db,rr,dateInZone(config.timezone).slice(0,7)),revisions:db.all('SELECT * FROM recurring_revisions WHERE rule_id=? ORDER BY from_month',rr.id)}));
    return {user:safeUser(u),apartments,units,leases,records,events,notifications,people,meters,meter_history,recurring_rules,comments,files,invites:apartments.some(a=>a.my_role!=='tenant')?listInvites(db,u):[],owner_invites:listOwnerInvitesFor(db,u),members:memberDates(db,leases),server_time:nowISO(),business_date:dateInZone(config.timezone),timezone:config.timezone};
}

export function validMonth(value,label='Месяц') {
    if(typeof value!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) fail(400,label+': выберите месяц и год.');
    V.date(value+'-01');return value;
}
export function nextMonth(ym) {
    const y=Number(ym.slice(0,4)),m=Number(ym.slice(5));return m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`;
}
export function ruleAt(db,rule,month) {
    const revision=db.get('SELECT * FROM recurring_revisions WHERE rule_id=? AND from_month<=? ORDER BY from_month DESC LIMIT 1',rule.id,month);
    return {...rule,...(revision||{})};
}
function ruleCharge(db,rule,ym) {
    return db.get("SELECT * FROM records WHERE kind='charge' AND (dedupe=? OR (json_extract(payload,'$.rule_id')=? AND json_extract(payload,'$.period')=?))",rule.legacy?`charge:${rule.lease_id}:${ym}`:`recurring:${rule.id}:${ym}`,rule.id,ym);
}
export function nextEditableMonth(db,rule,minimum=dateInZone().slice(0,7)) {
    let month=minimum;
    for(const row of db.all("SELECT payload FROM records WHERE lease_id=? AND kind='charge' AND (json_extract(payload,'$.rule_id')=? OR (?=1 AND dedupe LIKE ?))",rule.lease_id,rule.id,rule.legacy,`charge:${rule.lease_id}:%`)) {
        const p=JSON.parse(row.payload);if(p.period>=month) month=nextMonth(p.period);
    }
    return month;
}
function ensureRuleMonthOpen(db,rule,month) {
    const next=nextEditableMonth(db,rule,month);
    if(next!==month) fail(409,`Начисление уже создано. Оно не переписывается задним числом. Выберите изменения с ${monthText(next)} или позже.`);
}
export function createRecurringRule(db,u,b,config={timezone:'Europe/Moscow'}) {
    const {lease}=leaseAccess(db,u,b.lease_id,{write:true,ownerOnly:true});
    const start=validMonth(b.start_month||dateInZone(config.timezone).slice(0,7));
    if(start<lease.start.slice(0,7)||start>lease.end.slice(0,7)) fail(400,'Начало повторения должно попадать в период аренды.');
    if(start<dateInZone(config.timezone).slice(0,7)) fail(400,'Повторение можно начать с текущего месяца. Старые начисления добавляйте отдельно.');
    const end=b.end_month?validMonth(b.end_month):lease.end.slice(0,7);
    if(end<start||end>lease.end.slice(0,7)) fail(400,'Некорректное окончание повторения.');
    const id=randomUUID(),title=V.text(b.title,'Название',180),amount=V.integer(b.amount,'Сумма',1),due=V.integer(b.due_day,'День оплаты',1,31),advance=V.integer(b.advance_days??14,'Создавать заранее, дней',1,60);
    db.run(`INSERT INTO recurring_rules(id,lease_id,title,amount,due_day,advance_days,start_month,end_month,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,id,lease.id,title,amount,due,advance,start,end,nowISO());
    event(db,u,lease,'Добавлен регулярный платёж: '+title);
    return db.get('SELECT * FROM recurring_rules WHERE id=?',id);
}
export function updateRecurringRule(db,u,id,b,config={timezone:'Europe/Moscow'}) {
    const rule=db.get('SELECT * FROM recurring_rules WHERE id=?',id);if(!rule) fail(404,'Регулярный платёж не найден.');
    const {lease}=leaseAccess(db,u,rule.lease_id,{write:true,ownerOnly:true});
    if(V.integer(b.version,'Версия',1)!==rule.version) fail(409,'Настройка уже изменена. Обновите экран.');
    if(rule.state==='deleted') fail(409,'Правило уже удалено. Начисления сохранены.');
    if(b.action==='pause'||b.action==='delete') {
        db.run('UPDATE recurring_rules SET state=?,version=version+1 WHERE id=?',b.action==='pause'?'paused':'deleted',id);
        event(db,u,lease,(b.action==='pause'?'Приостановлен':'Удалён')+' регулярный платёж: '+rule.title);
        return db.get('SELECT * FROM recurring_rules WHERE id=?',id);
    }
    const month=validMonth(b.effective_month||nextEditableMonth(db,rule,dateInZone(config.timezone).slice(0,7)));
    if(month<dateInZone(config.timezone).slice(0,7)||month>lease.end.slice(0,7)) fail(400,'Месяц изменений должен быть текущим или будущим и попадать в аренду.');
    if(b.action==='resume') {
        if(rule.state!=='paused') fail(409,'Правило не приостановлено.');
        db.run("UPDATE recurring_rules SET state='active',start_month=?,version=version+1 WHERE id=?",month>rule.start_month?month:rule.start_month,id);
    } else {
        ensureRuleMonthOpen(db,rule,month);
        const old=ruleAt(db,rule,month),title=V.text(b.title??old.title,'Название',180),amount=V.integer(b.amount??old.amount,'Сумма',1),due=V.integer(b.due_day??old.due_day,'День оплаты',1,31),advance=V.integer(b.advance_days??old.advance_days,'Заранее, дней',1,60);
        if(rule.is_rent&&memberIds(db,lease.id).length&&(amount!==old.amount||due!==old.due_day)) fail(409,'Сумма и день аренды меняются через «Предложить условия» с подтверждением всех арендаторов.');
        db.run(`INSERT INTO recurring_revisions VALUES(?,?,?,?,?,?) ON CONFLICT(rule_id,from_month) DO UPDATE SET title=excluded.title,amount=excluded.amount,due_day=excluded.due_day,advance_days=excluded.advance_days`,id,month,title,amount,due,advance);
        db.run('UPDATE recurring_rules SET version=version+1 WHERE id=?',id);
    }
    event(db,u,lease,'Обновлён регулярный платёж с '+monthText(month)+': '+rule.title);
    return db.get('SELECT * FROM recurring_rules WHERE id=?',id);
}
function validateTermsMonth(db,lease,value,config) {
    if(!memberIds(db,lease.id).length) fail(409,'Сначала пригласите арендаторов.');
    const rule=db.get("SELECT * FROM recurring_rules WHERE lease_id=? AND is_rent=1 AND state!='deleted'",lease.id);
    const min=dateInZone(config.timezone).slice(0,7),month=validMonth(value||(rule?nextEditableMonth(db,rule,min):min));
    if(month<min||month>lease.end.slice(0,7)) fail(400,'Месяц новых условий должен быть текущим или будущим и попадать в период аренды.');
    if(rule) ensureRuleMonthOpen(db,rule,month);
    const later=db.get("SELECT id FROM records WHERE lease_id=? AND kind='terms' AND status='accepted' AND json_extract(payload,'$.effective_month')>=?",lease.id,month);
    if(later) fail(409,'На этот или более поздний месяц уже согласованы условия. Следующее изменение задайте после последнего согласованного месяца.');
    return month;
}
function applyTerms(db,lease,p) {
    const rule=db.get("SELECT * FROM recurring_rules WHERE lease_id=? AND is_rent=1 AND state!='deleted'",lease.id);
    const month=p.effective_month||dateInZone().slice(0,7);
    if(rule) {
        ensureRuleMonthOpen(db,rule,month);
        const old=ruleAt(db,rule,month);
        db.run(`INSERT INTO recurring_revisions VALUES(?,?,?,?,?,?) ON CONFLICT(rule_id,from_month) DO UPDATE SET amount=excluded.amount,due_day=excluded.due_day`,rule.id,month,old.title,p.rent,p.due_day||lease.due_day,old.advance_days);
        db.run('UPDATE recurring_rules SET version=version+1 WHERE id=?',rule.id);
    }
    db.run('UPDATE leases SET rent=?,terms=?,rent_effective_month=?,due_day=? WHERE id=?',p.rent,p.terms,month,p.due_day||lease.due_day,lease.id);
}
export function dueDate(month,day) {
    const last=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate();
    return month+'-'+String(Math.min(day,last)).padStart(2,'0');
}
export function generateRecurring(db,config,time=Date.now()) {
    const today=dateInZone(config.timezone,time),ym=today.slice(0,7),day=Number(today.slice(8));
    const leases=db.all("SELECT l.*,a.owner_id,a.title AS apartment_title FROM leases l JOIN apartments a ON a.id=l.apartment_id WHERE l.status IN ('active','ending') AND EXISTS(SELECT 1 FROM lease_members lm WHERE lm.lease_id=l.id)");
    for(const l of leases) {
        const user=db.get('SELECT * FROM users WHERE id=?',l.owner_id),apartment=db.get('SELECT * FROM apartments WHERE id=?',l.apartment_id);
        const ending=db.get("SELECT payload FROM records WHERE lease_id=? AND kind='termination' AND status='accepted'",l.id);
        const end=ending?JSON.parse(ending.payload).date:l.end;
        for(const base of db.all("SELECT * FROM recurring_rules WHERE lease_id=? AND state='active'",l.id)) {
            let month=base.start_month>l.start.slice(0,7)?base.start_month:l.start.slice(0,7);
            const horizon=dateInZone(config.timezone,time+60*86400000);
            for(let i=0;month<=end.slice(0,7)&&month<=horizon.slice(0,7)&&(!base.end_month||month<=base.end_month);month=nextMonth(month),i++) {
                if(i>2400) throw Error('Recurring rule covers more than 200 years');
                const r=ruleAt(db,base,month);let due=dueDate(month,r.due_day);
                if(due<l.start) due=l.start; // First month: no deadline before the lease itself.
                if(due>end||due>dateInZone(config.timezone,time+r.advance_days*86400000)||ruleCharge(db,base,month)) continue;
                const dedupe=base.legacy?`charge:${l.id}:${month}`:`recurring:${base.id}:${month}`;
                insertRecord(db,user,{lease:l,apartment,owner:true,system:true},'charge','pending',r.title+' за '+monthText(month),{amount:r.amount,confirmed:0,due,period:month,payments:[],claims:[],claim:null,rule_id:base.id},'shared',dedupe);
            }
        }
        if(l.start>today||l.end<today) continue;
        const meterDue=Number(dueDate(ym,l.meter_day).slice(8));
        const pending=visibleMeters(db,l).some(m=>!db.get('SELECT 1 FROM meter_values WHERE meter_id=? AND period=?',m.id,ym));
        if(l.meters_enabled&&pending&&[meterDue-3,meterDue].includes(day)) for(const uid of [...managerIds(db,l.apartment_id),...memberIds(db,l.id)]) pushNotification(db,uid,'Пора передать показания',`${l.apartment_title} · ${unitName(db,l)}\nЗа ${monthText(ym)}, до ${humanDate(dueDate(ym,l.meter_day))}.`,null,`meter:${l.id}:${uid}:${today}`,'reminders',{target:'m_'+l.id});
        const endDays=Math.ceil((Date.parse(end)-Date.parse(today))/86400000);
        if([30,7,1,0].includes(endDays)) for(const uid of [...managerIds(db,l.apartment_id),...memberIds(db,l.id)]) pushNotification(db,uid,'Срок аренды заканчивается',`${l.apartment_title} · ${unitName(db,l)}\nДата окончания: ${humanDate(end)}.`,null,`lease-end:${l.id}:${uid}:${today}`,'reminders',{target:'l_'+l.id});
    }
    for(const r of db.all("SELECT * FROM records WHERE kind IN ('charge','visit') AND status NOT IN ('paid','cancelled','completed')").map(decode)) {
        const l=db.get('SELECT * FROM leases WHERE id=?',r.lease_id);if(l.status==='ended') continue;
        const a=db.get('SELECT * FROM apartments WHERE id=?',r.apartment_id);
        let remind=false,title='',detail='';
        if(r.kind==='charge'&&['pending','partial','claimed'].includes(r.status)) {
            const delta=Math.round((Date.parse(r.payload.due)-Date.parse(today))/86400000);remind=[3,1,0,-1,-7].includes(delta);
            title=r.status==='claimed'?'Ожидается подтверждение оплаты':delta<0?'Проверьте просроченный платёж':'Скоро срок платежа';
            detail=`${r.title}\nОсталось подтвердить: ${formatMoney(r.payload.amount-r.payload.confirmed)}. Срок: ${humanDate(r.payload.due)}.`;
        }
        if(r.kind==='visit'&&r.status==='accepted') {const diff=Date.parse(r.payload.start)-time;remind=diff>0&&diff<=24*3600000;title='Скоро согласованное посещение';detail=`${r.payload.reason}\n${new Date(r.payload.start).toLocaleString('ru-RU',{timeZone:config.timezone})} (${config.timezone})`;}
        if(remind) for(const uid of [...managerIds(db,a),...memberIds(db,l.id)]) pushNotification(db,uid,title,`${detail}\n${a.title} · ${unitName(db,l)}`,r.id,`due:${r.id}:${r.version}:${uid}:${today}`,'reminders');
    }
}
const formatMoney=n=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(n/100);
