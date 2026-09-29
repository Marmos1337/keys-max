import { randomUUID, randomBytes } from 'node:crypto';
import { fail, hash } from './auth.mjs';
import * as V from './validate.mjs';
import { bindCover, presentApartment } from './covers.mjs';
import { isMember, memberIds, unitName, createUnit } from './rental.mjs';
export { isMember, memberIds } from './rental.mjs';
export const nowISO = () => new Date().toISOString();
export const decode = r => r ? { ...r, payload: JSON.parse(r.payload) } : null;
export const settings = u => ({ events: true, reminders: true, bot: true, ...JSON.parse(u.settings || '{}') });
export const safeUser = u => ({ id: u.id, name: u.name, role: u.role, demo: !!u.demo, bot_enabled: !!u.bot_enabled, settings: settings(u) });
export function dateInZone(timezone = 'Europe/Moscow', time = Date.now()) { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(time)); return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k).value).join('-'); }
export function apartmentAccess(db, u, id, ownerOnly = false) { const a = db.get('SELECT * FROM apartments WHERE id=?', id); if (!a)
    fail(404, 'Квартира не найдена.'); if (a.owner_id === u.id)
    return { apartment: a, owner: true }; if (ownerOnly || !db.get('SELECT 1 FROM leases l JOIN lease_members lm ON lm.lease_id=l.id WHERE l.apartment_id=? AND lm.user_id=?', id, u.id))
    fail(404, 'Квартира не найдена.'); return { apartment: a, owner: false }; }
export function leaseAccess(db, u, id, { write = false, ownerOnly = false } = {}) { const l = db.get('SELECT * FROM leases WHERE id=?', id); if (!l)
    fail(404, 'Аренда не найдена.'); const a = db.get('SELECT * FROM apartments WHERE id=?', l.apartment_id), owner = a.owner_id === u.id; if (!owner && (ownerOnly || !isMember(db,u.id,l.id)))
    fail(404, 'Аренда не найдена.'); if (write && l.status === 'ended')
    fail(409, 'Аренда завершена. История доступна только для чтения.'); return { lease: l, apartment: a, owner }; }
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
    if (user.max_id && user.bot_enabled && settings(user).bot && settings(user)[category] !== false) {
        db.run('INSERT INTO outbox(id,user_id,body,created_at) VALUES(?,?,?,?)', randomUUID(), userId, JSON.stringify({ title, text, recordId, category, ...extra }), nowISO());
    }
}
export function notifyOther(db, u, ctx, title, recordId, visibility = 'shared', detail = '', extra = {}) {
    if (visibility === 'owner') return;
    const targets = new Set([ctx.apartment.owner_id, ...memberIds(db,ctx.lease.id)]);
    targets.delete(u.id);
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
        for(const l of db.all("SELECT * FROM leases WHERE apartment_id=? AND status!='ended'",id)) for(const uid of memberIds(db,l.id)) pushNotification(db,uid,text,'Собственник обновил сведения. Условия согласованной аренды не изменены.');
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
export function createInvite(db,u,leaseId) {
    const {lease}=leaseAccess(db,u,leaseId,{write:true,ownerOnly:true});
    if(lease.status!=='active') fail(409,'Нельзя приглашать новых участников в завершаемую аренду.');
    const code=randomBytes(18).toString('base64url'),expires=Date.now()+72*3600000;
    db.run('INSERT INTO invites VALUES(?,?,?,NULL)',hash(code),leaseId,expires);
    return {code,expires:new Date(expires).toISOString()};
}
export function previewInvite(db,u,code) {
    V.text(code,'Код',100);
    const invite=db.get('SELECT * FROM invites WHERE hash=?',hash(code));
    if(!invite||invite.expires<Date.now()||invite.used_by) fail(400,'Приглашение истекло или уже использовано.');
    const lease=db.get('SELECT * FROM leases WHERE id=?',invite.lease_id),apartment=db.get('SELECT * FROM apartments WHERE id=?',lease.apartment_id);
    if(apartment.owner_id===u.id) fail(400,'Нельзя принять собственное приглашение.');
    if(lease.status!=='active') fail(409,'Эта аренда уже недоступна для присоединения.');
    if(isMember(db,u.id,lease.id)) fail(409,'Вы уже участвуете в этой аренде.');
    return {lease,apartment,invite,unit:unitName(db,lease),owner:db.get('SELECT name FROM users WHERE id=?',apartment.owner_id).name};
}
export function joinInvite(db,u,code) {
    const {lease:l,apartment:a}=previewInvite(db,u,code);
    db.run('INSERT INTO lease_members VALUES(?,?,?)',l.id,u.id,nowISO());
    if(!l.tenant_id) db.run('UPDATE leases SET tenant_id=? WHERE id=?',u.id,l.id);
    db.run('UPDATE invites SET used_by=? WHERE hash=? AND used_by IS NULL',u.id,hash(code));
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
    notifyOther(db,u,{lease:l,apartment:a,owner:false},'Новый участник аренды',null,'shared',u.name+' присоединился. Начисления общие для этой группы, а не отдельная полная сумма каждому.');
    return {apartment_id:a.id,lease_id:l.id};
}
export function proposalVoters(db,lease,proposer) {
    const a=db.get('SELECT owner_id FROM apartments WHERE id=?',lease.apartment_id);
    return [a.owner_id,...memberIds(db,lease.id)].filter(id=>id!==proposer);
}
function approveProposal(db,u,ctx,p) {
    const required=p.required_approvals||proposalVoters(db,ctx.lease,p.proposer);
    if(!required.includes(u.id)||p.proposer===u.id) fail(403,'Предложение подтверждают остальные участники.');
    const accepted=p.accepted_by||[];
    if(accepted.includes(u.id)) fail(409,'Вы уже подтвердили предложение. Ожидается ответ остальных.');
    p.required_approvals=required; p.accepted_by=[...accepted,u.id];
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
            if(r.created_by!==ctx.apartment.owner_id && r.created_by!==u.id) fail(403,'Результат подтверждает автор заявки.');
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
            if (p.proposer === u.id)
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
        if(act==='claim') {
            tenant();
            if(p.claims.some(c=>c.user_id===u.id)) fail(409,'Ваш перевод уже ожидает подтверждения собственника.');
            if(available<=0) fail(409,'Вся оставшаяся сумма уже ожидает подтверждения.');
            p.claims.push({id:randomUUID(),amount:V.integer(b.amount,'Сумма перевода',1,available),note:V.text(b.note,'Комментарий',1000,true),at:nowISO(),user_id:u.id});
            label=u.name+' сообщил об оплате';
        } else if(act==='confirm'||act==='reject') {
            owner();
            const claim=b.claim_id?p.claims.find(c=>c.id===b.claim_id):p.claims[0];
            if(!claim) fail(409,'Этот перевод уже обработан. Обновите экран.');
            if(act==='confirm') {
                if(p.confirmed+claim.amount>p.amount) fail(409,'Сумма превышает остаток начисления.');
                p.confirmed+=claim.amount;
                p.payments=[...p.payments,{...claim,confirmed_by:u.id,confirmed_at:nowISO()}];
                label='Подтверждён перевод: '+formatMoney(claim.amount);
            } else {p.rejection=V.text(b.note,'Причина',1000);label='Перевод отклонён: '+p.rejection;}
            p.claims=p.claims.filter(c=>c.id!==claim.id);
        } else if(act==='record_payment') {
            owner();if(available<=0) fail(409,'Сначала обработайте ожидающие переводы.');
            const amount=V.integer(b.amount,'Полученная сумма',1,available);
            const payer=b.payer_id||null;
            if(payer&&!isMember(db,payer,ctx.lease.id)) fail(400,'Плательщик не участвует в этой аренде.');
            p.confirmed+=amount;
            p.payments=[...p.payments,{id:randomUUID(),amount,user_id:payer,note:V.text(b.note,'Комментарий',1000,true),confirmed_by:u.id,confirmed_at:nowISO(),source:'owner_manual'}];
            label='Собственник подтвердил получение: '+formatMoney(amount);
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
            if (p.proposer === u.id)
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
            if (p.proposer === u.id)
                deny();
            status = 'rejected';
            p.reason = V.text(b.note, 'Комментарий', 1000);
        }
        else if (act === 'cancel') {
            inStatus(['proposed']);
            if (p.proposer !== u.id)
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
    const group=randomUUID(),baseline=V.integer(b.baseline??0,'Начальное показание',0,1000000000000),ids=[];
    for(const tariff of tariffs) {
      const id=randomUUID();ids.push(id);
      db.run(`INSERT INTO meters(id,lease_id,label,unit,baseline,apartment_id,scope,kind,group_id,tariff) VALUES(?,?,?,?,?,?,?,?,?,?)`,id,lease.id,label+(tariff?' — '+tariff:''),unit,baseline,lease.apartment_id,scope,kind,group,tariff);
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
    db.run('UPDATE meters SET label=?,baseline=?,active=?,version=version+1 WHERE id=?',label,baseline,b.active===undefined?m.active:b.active?1:0,id);
    event(db,u,lease,b.active===false?'Счётчик перенесён в архив: '+m.label:'Обновлён счётчик: '+label);
    notifyMeterUsers(db,u,lease,m.scope,'Обновлены настройки счётчиков');
    return db.get('SELECT * FROM meters WHERE id=?',id);
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
    const values=meters.map(m=>{
        const entries=p.values.filter(v=>v.meter_id===m.id);if(entries.length!==1) fail(400,'Счётчики не совпадают с настройками. Обновите экран.');
        const value=V.integer(entries[0].value,m.label,0,1000000000000),previous=meterPrevious(db,m,period);
        if(value<previous) fail(400,m.label+': показание меньше предыдущего. При замене добавьте новый счётчик.');
        return {meter_id:m.id,label:m.label,unit:m.unit,scope:m.scope,value,previous,consumption:value-previous};
    });
    const r=insertRecord(db,u,ctx,'reading','submitted','Показания за '+monthText(period),{period,values},'shared',null,files);
    for(const v of values) db.run('INSERT INTO meter_values VALUES(?,?,?,?,?,?)',v.meter_id,period,v.value,v.previous,r.id,r.created_at);
    // Other rooms can see the numeric common reading, not this room's files or contract.
    for(const v of values.filter(v=>v.scope==='apartment')) for(const other of db.all("SELECT * FROM leases WHERE apartment_id=? AND id!=? AND status!='ended'",ctx.apartment.id,ctx.lease.id)) {
        for(const uid of memberIds(db,other.id)) pushNotification(db,uid,'Переданы общие показания',`${v.label}: ${v.value/1000} ${v.unit} · ${monthText(period)}`,null,`common:${v.meter_id}:${period}:${uid}`,'events',{target:'m_'+other.id});
    }
    return r;
}
export function bootstrap(db,u,config,{coverUrls=true}={}) {
    const access=`(a.owner_id=? OR EXISTS(SELECT 1 FROM lease_members lm WHERE lm.lease_id=l.id AND lm.user_id=?))`;
    const apartments=db.all(`SELECT DISTINCT a.* FROM apartments a LEFT JOIN leases l ON l.apartment_id=a.id WHERE ${access} ORDER BY a.created_at`,u.id,u.id).map(a=>presentApartment(db,u,a,config,coverUrls));
    const leases=db.all(`SELECT l.* FROM leases l JOIN apartments a ON a.id=l.apartment_id WHERE ${access} ORDER BY l.created_at DESC`,u.id,u.id).map(l=>({...l,tenant_ids:memberIds(db,l.id),unit_title:unitName(db,l)}));
    const recordAccessSql=`(a.owner_id=? OR (r.visibility='shared' AND EXISTS(SELECT 1 FROM lease_members lm WHERE lm.lease_id=r.lease_id AND lm.user_id=?)))`;
    const records=db.all(`SELECT r.* FROM records r JOIN apartments a ON a.id=r.apartment_id WHERE ${recordAccessSql} ORDER BY r.created_at DESC`,u.id,u.id).map(decode);
    const events=db.all(`SELECT e.*,u.name AS author FROM events e JOIN users u ON u.id=e.user_id JOIN apartments a ON a.id=e.apartment_id WHERE a.owner_id=? OR (e.visibility='shared' AND EXISTS(SELECT 1 FROM lease_members lm WHERE lm.lease_id=e.lease_id AND lm.user_id=?)) ORDER BY e.created_at DESC LIMIT 1000`,u.id,u.id);
    for(const l of leases) {
        const future=records.filter(r=>r.lease_id===l.id&&r.kind==='terms'&&r.status==='accepted'&&r.payload.effective_month>dateInZone(config.timezone).slice(0,7)).sort((a,b)=>a.payload.effective_month.localeCompare(b.payload.effective_month))[0];
        l.current_rent=future?future.payload.previous_rent:l.rent;
        l.current_terms=future?future.payload.previous_terms:l.terms;
        l.current_due_day=future?(future.payload.previous_due_day||l.due_day):l.due_day;
    }
    const notifications=db.all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 200',u.id);
    const ids=new Set([u.id,...leases.flatMap(l=>l.tenant_ids),...apartments.map(a=>a.owner_id)]);
    const people=[...ids].map(id=>db.get('SELECT id,name FROM users WHERE id=?',id));
    const units=db.all(`SELECT ru.* FROM rental_units ru JOIN apartments a ON a.id=ru.apartment_id WHERE a.owner_id=? OR EXISTS(SELECT 1 FROM leases l JOIN lease_members lm ON lm.lease_id=l.id WHERE l.unit_id=ru.id AND lm.user_id=?) ORDER BY ru.created_at,ru.title`,u.id,u.id);
    const meterMap=new Map();for(const l of leases) for(const m of visibleMeters(db,l,{activeOnly:false})) meterMap.set(m.id,m);
    const meters=[...meterMap.values()];
    const meter_history=[];
    for(const m of meters) {
        const own=apartments.some(a=>a.id===m.apartment_id&&a.owner_id===u.id);
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
    return {user:safeUser(u),apartments,units,leases,records,events,notifications,people,meters,meter_history,recurring_rules,comments,files,server_time:nowISO(),business_date:dateInZone(config.timezone),timezone:config.timezone};
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
                insertRecord(db,user,{lease:l,apartment,owner:true},'charge','pending',r.title+' за '+monthText(month),{amount:r.amount,confirmed:0,due,period:month,payments:[],claims:[],claim:null,rule_id:base.id},'shared',dedupe);
            }
        }
        if(l.start>today||l.end<today) continue;
        const meterDue=Number(dueDate(ym,l.meter_day).slice(8));
        const pending=visibleMeters(db,l).some(m=>!db.get('SELECT 1 FROM meter_values WHERE meter_id=? AND period=?',m.id,ym));
        if(l.meters_enabled&&pending&&[meterDue-3,meterDue].includes(day)) for(const uid of [l.owner_id,...memberIds(db,l.id)]) pushNotification(db,uid,'Пора передать показания',`${l.apartment_title} · ${unitName(db,l)}\nЗа ${monthText(ym)}, до ${humanDate(dueDate(ym,l.meter_day))}.`,null,`meter:${l.id}:${uid}:${today}`,'reminders',{target:'m_'+l.id});
        const endDays=Math.ceil((Date.parse(end)-Date.parse(today))/86400000);
        if([30,7,1,0].includes(endDays)) for(const uid of [l.owner_id,...memberIds(db,l.id)]) pushNotification(db,uid,'Срок аренды заканчивается',`${l.apartment_title} · ${unitName(db,l)}\nДата окончания: ${humanDate(end)}.`,null,`lease-end:${l.id}:${uid}:${today}`,'reminders',{target:'l_'+l.id});
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
        if(remind) for(const uid of [a.owner_id,...memberIds(db,l.id)]) pushNotification(db,uid,title,`${detail}\n${a.title} · ${unitName(db,l)}`,r.id,`due:${r.id}:${r.version}:${uid}:${today}`,'reminders');
    }
}
const formatMoney=n=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(n/100);
