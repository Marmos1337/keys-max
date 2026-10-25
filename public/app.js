import { apartmentDeleteDialog, withoutApartment } from './apartment-delete-ui.js';
import { hydrateGuide, syncGuide, recordGuide, showGuidePrompt, guideContent } from './guide.js';
import { guideTopic } from './guide-state.js';
import { pageTone, enhanceUI, rememberStrips, fitNumericLabels } from './ui.js';
import { dueForMonth, tenantIds, isTenant, unitTitle, metersFor, pendingMeters, claimsFor, freeAmount, displayedRule, editableMonth, monthLabel } from './rental-ui.js';
import { applyTheme, setTheme, useHostTheme } from './theme.js';
import { platform, bridgeReady, launchData, hostScheme, onHostSchemeChange, paintHost, haptic, closingConfirmation, syncBackButton, openLink, share, download, requestWriteAccess } from './platform.js';
import { request, post, setToken, uploadFiles } from './api.js';
import { coverFields, handleCoverChange, collectCover, releaseCoverPreviews } from './images.js';
import { welcome, roleView, shell, pageView, model, actionsFor } from './views.js';
import { baselineForm } from './meters-ui.js';
import { paymentFields } from './payments-ui.js';
import { peopleSection, inviteCreateForm, inviteResult, inviteManage, invitePreview, inviteProblem, inviteOutside, joinedWelcome } from './invites-ui.js';
import { uuid, esc, icon, button, notice, field, textarea, select, uploadField, localISO, today, parseAmount, money, number, date, categoryNames, kindNames } from './utils.js';
const root = document.querySelector('#root'), modalRoot = document.querySelector('#modal-root'), toastRoot = document.querySelector('#toast-root');
const state = { config: null, data: null, screen: 'loading', page: 'home', recordId: null, apartmentId: localStorage.getItem('keys.apartment') || '', leaseId: '', scope: 'all', filter: 'all', unitScope: '', aptTab: 'overview', modal: null, depth: 0 };
let guideVisitTimer;
let bridgeData = launchData(), toastTimer, previousFocus = null, loading = false;
const pendingFiles = new WeakMap();
function render() { hydrateGuide(state.data?.user); rememberStrips(root); if (state.screen === 'app' && state.data)
    root.innerHTML = shell(state, pageView(state));
else if (state.screen === 'role')
    root.innerHTML = roleView(state);
else if (state.screen === 'welcome')
    root.innerHTML = welcome(state); applyTheme(); enhanceUI(root); syncBack(); }
// Telegram header back button: visible when the in-app back action would do something.
function syncBack() { syncBackButton(!!state.modal || (state.screen === 'app' && state.page !== 'home') || (state.screen === 'role' && !!state.data), hostBack); }
function hostBack() {
    if (state.modal) { closeModal(); return; }
    if (state.screen === 'role') { if (state.data) { state.screen = 'app'; render(); } return; }
    if (state.screen === 'app' && state.page !== 'home') { if (state.depth > 1) history.back(); else nav('home', null, { replace: true }); }
}
// Learning progress follows explicit navigation, not polling or page reloads.
function updateGuidePrompt() {
    if (state.data?.user && !showGuidePrompt(state.data.user)) root.querySelector('[data-guide-prompt]')?.remove();
}
function guideEvent(event, topic) {
    const task = recordGuide(state.data?.user, event, topic);
    updateGuidePrompt();
    task.then(updateGuidePrompt);
}
function queueGuideVisit() {
    clearTimeout(guideVisitTimer);
    const topic = guideTopic(state.page, state.aptTab), user = state.data?.user;
    if (!topic || !user || !showGuidePrompt(user)) return;
    const role = user.role, id = user.id;
    guideVisitTimer = setTimeout(() => {
        if (state.screen !== 'app' || state.modal || document.hidden || state.data?.user.id !== id || state.data.user.role !== role || guideTopic(state.page, state.aptTab) !== topic) return;
        guideEvent('visit', topic);
    }, 1000);
}
function initializeGuide() {
    hydrateGuide(state.data?.user);
    syncGuide(state.data?.user).then(updateGuidePrompt);
}
function toast(message, error = false) { haptic(error ? 'error' : 'success'); clearTimeout(toastTimer); toastRoot.innerHTML = `<div class="toast ${error ? 'error' : ''}">${icon(error ? 'info' : 'check', 18)}<span>${esc(message)}</span></div>`; toastTimer = setTimeout(() => toastRoot.innerHTML = '', error ? 6500 : 4200); }
function routeFromLocation() { const [, app, page, id] = location.pathname.split('/'); if (app === 'app') {
    state.page = page || 'home';
    state.recordId = page === 'record' ? id : null;
} }
function nav(page, id = null, { replace = false, keepScope = false, learn = !replace } = {}) { clearTimeout(toastTimer); toastRoot.innerHTML = ''; if(!keepScope)state.unitScope=''; state.page = page; state.recordId = id; state.filter = 'all'; if (page !== 'apartments')
    state.aptTab = 'overview'; const path = '/app/' + page + (id ? '/' + encodeURIComponent(id) : ''); history[replace ? 'replaceState' : 'pushState']({}, '', path); state.depth++; if (learn) haptic('select'); render(); if (learn) queueGuideVisit(); window.scrollTo({ top: 0, behavior: 'instant' }); }
async function reload() { state.data = await request('/state'); if(state.data.user.settings.theme)setTheme(state.data.user.settings.theme); if (state.screen === 'app')
    render(); }
function modalTone(html) {
    if (html.includes('data-delete-dialog')) return 'red';
    if (html.includes('class="guide-content"')) return 'blue';
    const name = html.match(/data-form="([^"]+)"/)?.[1] || '';
    const kind = html.match(/data-kind="([^"]+)"/)?.[1];
    if (kind) return { ticket: 'purple', purchase: 'orange', charge: 'green', expense: 'green', visit: 'teal', document: 'slate', terms: 'blue', termination: 'blue' }[kind] || 'blue';
    if (/meter|readings/.test(name)) return 'amber';
    if (/rule/.test(name)) return 'green';
    if (/apartment|lease|unit|photo|join/.test(name)) return 'blue';
    return state.data ? pageTone(state) : 'blue';
}
function modal(title, html, meta = {}) { releaseCoverPreviews(modalRoot); previousFocus = document.activeElement; state.modal = { title, ...meta }; modalRoot.innerHTML = `<div class="modal-overlay" data-overlay="true"><section class="modal" data-tone="${modalTone(html)}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"${meta.descriptionId ? ` aria-describedby="${esc(meta.descriptionId)}"` : ''} tabindex="-1"><header class="modal-header"><h2 id="dialog-title">${esc(title)}</h2><button class="icon-button" data-act="close-modal" aria-label="Закрыть">${icon('close')}</button></header>${html}</section></div>`; document.body.classList.add('modal-open'); setTimeout(() => modalRoot.querySelector(meta.initialFocus || '.modal')?.focus({preventScroll: true}), 20); try {
    closingConfirmation(true); syncBack();
}
catch { } }
function closeModal() { if (state.modal?.busy)
    return; releaseCoverPreviews(modalRoot); modalRoot.innerHTML = ''; state.modal = null; document.body.classList.remove('modal-open'); try {
    closingConfirmation(false); syncBack();
}
catch { } if (previousFocus?.isConnected)
    previousFocus.focus(); }
function formContent(name, fields, submit = 'Сохранить', attrs = '') { return `<form class="form-stack" data-form="${name}" ${attrs}>${fields}<div class="form-error" role="alert"></div><button type="submit" class="btn primary wide">${submit}</button></form>`; }
function setFormError(form, message){ const box=form.querySelector('.form-error'); if(box) box.textContent=message||''; }
function chosenLease() { const m = model(state); if (!m.l)
    throw Error('Сначала добавьте квартиру или присоединитесь по приглашению.'); if (m.l.status === 'ended')
    throw Error('Эта аренда завершена. Откройте активную аренду.'); return m; }
function leasePicker(currentId) { const { d, u, owner } = model(state); const leases = d.leases.filter(l => l.status !== 'ended' && (owner ? d.apartments.some(a => a.id === l.apartment_id && a.owner_id === u.id) : isTenant(l,u.id))); return select('Квартира / аренда', 'lease_id', leases.map(l => [l.id, (d.apartments.find(a => a.id === l.apartment_id)?.title || 'Квартира')+' · '+unitTitle(l)]), currentId); }
function timesFields(start = localISO(86400000), end = localISO(86400000 + 3600000)) { return `<div class="form-grid date-grid">${field('Начало', 'start', 'datetime-local', start, 'required')}${field('Окончание', 'end', 'datetime-local', end, 'required')}</div><p class="small-note">Часовой пояс устройства: ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}. У другой стороны время отобразится в её часовом поясе.</p>`; }
function newRecord(kind) {
    const { l, owner } = chosenLease();
    let fields = leasePicker(l.id), title = '', submit = 'Сохранить';
    if (kind === 'ticket') {
        title = 'Сообщить о проблеме';
        submit = 'Отправить заявку';
        fields += field('Что случилось?', 'title', 'text', '', 'placeholder="Например, протекает кран" required maxlength="180"') + select('Где', 'room', [['Кухня', 'Кухня'], ['Гостиная', 'Гостиная'], ['Спальня', 'Спальня'], ['Ванная', 'Ванная'], ['Прихожая', 'Прихожая'], ['Другое', 'Другое']], 'Кухня') + textarea('Подробности', 'description', '', true) + select('Приоритет', 'priority', [['normal', 'Обычная'], ['urgent', 'Срочная']], 'normal') + uploadField() + notice('При угрозе жизни или имуществу не ждите ответа в приложении — обратитесь в экстренные службы.', 'amber');
    }
    if (kind === 'purchase') {
        title = 'Добавить покупку';
        submit = 'Отправить на согласование';
        fields += field('Название покупки', 'title', 'text', '', 'placeholder="Смеситель для кухни" required maxlength="180"') + `<div class="form-grid">${field('Стоимость, ₽', 'amount', 'text', '', 'required inputmode="decimal" placeholder="4 590"')}${field('Дата покупки', 'purchase_date', 'date', today(), 'required')}</div>` + textarea('Зачем и что согласовать', 'description') + uploadField('Фото покупки и чек') + notice('Опишите, что именно купили и что нужно согласовать. Согласование не выполняет перевод и не вычитает сумму из аренды.');
    }
    if (kind === 'visit') {
        title = 'Предложить посещение';
        submit = 'Предложить время';
        fields += timesFields() + textarea('Причина посещения', 'reason', '', true) + notice('Посещение станет согласованным после подтверждения всех арендаторов этого объекта.');
    }
    if (kind === 'charge') {
        title = 'Добавить начисление';
        submit = 'Создать начисление';
        fields += field('Название', 'title', 'text', 'Аренда', 'required maxlength="180"') + field('Сумма, ₽', 'amount', 'text', String(l.rent / 100), 'inputmode="decimal" required') + `<div class="form-grid">${field('За какой месяц', 'period', 'month', today().slice(0, 7), 'required')}${field('Оплатить до', 'due', 'date', dueForMonth(today().slice(0,7),l.current_due_day??l.due_day), 'required')}</div>` + '<label class="checkbox-field"><input type="checkbox" name="repeat"> Повторять ежемесячно</label>'+field('Создавать за сколько дней до оплаты','advance_days','number',14,'min="1" max="60" required')+notice('Это общая сумма для всех жильцов выбранной аренды, не сумма на каждого. Ежемесячное правило можно изменить в разделе «Регулярные платежи». Деньги переводятся вне приложения.');
    }
    if (kind === 'document') {
        title = 'Добавить документ';
        submit = 'Загрузить документ';
        fields += field('Название документа', 'title', 'text', '', 'placeholder="Договор аренды" required maxlength="180"') + select('Категория', 'category', Object.entries(categoryNames), 'contract') + textarea('Комментарий', 'description') + uploadField('Документы') + (owner ? '<label class="checkbox-field"><input type="checkbox" name="private"> Видно только собственнику</label>' : '') + notice('Загружайте только документы, которыми вправе делиться с участниками этой аренды.');
    }
    if (kind === 'expense') {
        title = 'Расход собственника';
        fields += field('На что потратили', 'title', 'text', '', 'required maxlength="180"') + `<div class="form-grid">${field('Сумма, ₽', 'amount', 'text', '', 'required inputmode="decimal"')}${field('Дата расхода', 'date', 'date', today(), 'required')}</div>` + textarea('Комментарий', 'description') + uploadField('Чек или фотография') + notice('Личный расход видите только вы.', 'neutral', 'shield');
    }
    if (kind === 'termination') {
        title = 'Завершение аренды';
        submit = 'Отправить предложение';
        fields += field('Предлагаемая дата', 'date', 'date', today(), 'required') + textarea('Обсудите порядок выезда', 'reason', '', true) + notice('Это согласование намерения в приложении. Подписанные документы и вопрос депозита стороны урегулируют отдельно.', 'amber');
    }
    if (kind === 'terms') {
        title = 'Новые условия аренды';
        submit = 'Предложить арендаторам';
        fields += field('Новая плата, ₽ / месяц', 'rent', 'text', String(l.rent / 100), 'inputmode="decimal" required') + textarea('Предлагаемые условия', 'terms', l.terms, true) + field('Действуют с месяца','effective_month','month',termsMonth(l),'required') + field('Новый день оплаты','due_day','number',l.due_day,'required min="1" max="31"') + notice('После согласования изменятся карточка аренды и будущие начисления. Подписанное соглашение загрузите отдельно.');
    }
    modal(title, formContent('create-record', fields, submit, `data-kind="${kind}"`));
}
function apartmentFields(a = {}) {
    return field('Название квартиры', 'title', 'text', a.title || '', 'placeholder="Квартира на Тверской" required maxlength="80"') +
        field('Полный адрес', 'address', 'text', a.address || '', 'required maxlength="250" placeholder="Город, улица, дом, квартира"') +
        `<div class="form-grid">${field('Комнат', 'rooms', 'number', a.rooms ?? 2, 'required min="1" max="20"')}${field('Площадь, м²', 'area', 'number', a.area ?? 52, 'required min="5" max="2000" step="0.1"')}</div>`;
}
function leaseFields(l = {}) {
    // Keep paired dates full-width on phones, including iOS native date controls.
    let end = l.end;
    if (!end) {
        const d = new Date(today() + 'T12:00:00'); d.setFullYear(d.getFullYear() + 1);
        end = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    return `<div class="form-grid date-grid">${field('Начало аренды', 'start', 'date', l.start || today(), 'required')}${field('Окончание аренды', 'end', 'date', end, 'required')}</div>` +
        `<div class="form-grid">${field('Плата в месяц, ₽', 'rent', 'text', l.rent === undefined ? '' : String(l.rent / 100), 'required inputmode="decimal" placeholder="65 000"')}${field('Депозит, ₽', 'deposit', 'text', String((l.deposit || 0) / 100), 'required inputmode="decimal"')}</div>` +
        `<div class="form-grid">${field('День оплаты', 'due_day', 'number', l.due_day || 5, 'required min="1" max="31"')}${field('День показаний', 'meter_day', 'number', l.meter_day || 25, 'required min="1" max="31"')}</div>` +
        textarea('Условия и договорённости', 'terms', l.terms || '');
}
function termsMonth(l) {
    const rule=(state.data.recurring_rules||[]).find(r=>r.lease_id===l.id&&r.is_rent&&r.state!=='deleted');
    return rule?editableMonth(state.data,rule):state.data.business_date.slice(0,7);
}
function newApartment(leaseOnly=false,unitId='') {
    let first='';
    if(leaseOnly) {
        const {a,d}=model(state),active=d.leases.filter(l=>l.apartment_id===a.id&&l.status!=='ended'),units=d.units.filter(v=>v.apartment_id===a.id);
        const available=units.filter(v=>!active.some(l=>l.unit_id===v.id)&&(v.kind==='whole'?!active.length:!active.some(l=>units.find(x=>x.id===l.unit_id)?.kind==='whole')));
        if(!available.length)throw Error('Нет свободного объекта. Добавьте комнату или завершите действующую аренду.');
        first=select('Что сдаём','unit_id',available.map(v=>[v.id,v.title]),unitId||available[0].id);
    } else first=apartmentFields()+coverFields()+select('Формат аренды','rental_mode',[['whole','Сдаётся вся квартира целиком'],['rooms','Сдаются отдельные комнаты']],'whole')+'<div data-room-name hidden>'+field('Название первой комнаты','unit_title','text','Комната 1','maxlength="80"')+'</div>'+notice('Можно сдавать всю квартиру целиком или сдавать комнаты отдельно. В каждом объекте может быть один или несколько арендаторов.','blue');
    const fields=first+'<h3 class="form-section-title">Период и условия аренды</h3>'+leaseFields()+
      '<label class="checkbox-field"><input type="checkbox" name="recurring_rent" checked> Начислять аренду ежемесячно</label><label class="checkbox-field"><input type="checkbox" name="meters_enabled" checked> Передавать показания счётчиков</label>'+notice('Плата указана за весь выбранный объект. Пригласите в эту аренду одного или нескольких жильцов — каждый сможет оплачивать свою часть. Другие комнаты создаются отдельно.');
    modal(leaseOnly?'Новая аренда':'Добавить квартиру',formContent(leaseOnly?'create-lease':'create-apartment',fields,leaseOnly?'Создать аренду':'Добавить квартиру'));
}
function unitModal(id='') {
    const {a,d}=model(state),unit=d.units.find(v=>v.id===id);
    modal(unit?'Название комнаты':'Добавить комнату',formContent(unit?'edit-unit':'create-unit',field('Название','title','text',unit?.title||'','placeholder="Например, Комната с балконом" required maxlength="80"')+notice('Комната — отдельный сдаваемый объект внутри квартиры. После создания задайте условия аренды и пригласите любое количество жильцов.'),'Сохранить',`data-id="${unit?.id||''}" data-apartment="${a.id}" data-version="${unit?.version||0}"`));
}
function meterModal(id='') {
    const {l,d}=chosenLease(),m=d.meters.find(x=>x.id===id),used=m&&(d.meter_history||[]).some(v=>v.meter_id===m.id);
    let fields=field('Название','label','text',m?.label||'','placeholder="Например, Горячая вода — кухня" required maxlength="80"');
    if(!m)fields+=select('Тип','kind',[['cold_water','Холодная вода'],['hot_water','Горячая вода'],['gas','Газ'],['electricity','Электричество'],['heating','Отопление'],['other','Свой вариант']],'cold_water')+
        '<div data-electric-scheme hidden>'+select('Тарифы электричества','scheme',[['single','Один тариф'],['dual','День и ночь'],['triple','Т1, Т2, Т3']],'single')+'</div>'+
        select('Единица измерения','unit',[['м³','м³'],['кВт·ч','кВт·ч'],['Гкал','Гкал'],['МВт·ч','МВт·ч'],['л','л'],['ед.','ед.']],'м³')+
        select('Кто передаёт','scope',[['lease','Только жильцы этой аренды'],['apartment','Общий счётчик всей квартиры']],'lease');
    if(!used)fields+=field('Стартовое показание (цифры со счётчика сейчас)','baseline','text',String((m?.baseline||0)/1000),'required inputmode="decimal"');
    else fields+=notice('После первой передачи стартовое показание не меняется. При замене прибора архивируйте старый и добавьте новый.');
    fields+=field('Цена за единицу, ₽ (необязательно)','price','text',m?.price!=null?String(m.price/100):'','inputmode="decimal" placeholder="Например, 51,20" autocomplete="off"')+'<p class="small-note">С ценой в истории видно, сколько стоит расход за месяц. Начисления по ней сами не создаются.</p>';
    if(m)fields+='<label class="checkbox-field"><input type="checkbox" name="active" '+(m.active?'checked':'')+'> Использовать этот счётчик</label>';
    else fields+=notice('Для нескольких тарифов создаются отдельные строки показаний. Начальные значения каждого тарифа можно затем изменить отдельно.');
    modal(m?'Настройки счётчика':'Добавить счётчик',formContent(m?'edit-meter':'create-meter',fields,'Сохранить',`data-id="${m?.id||''}" data-version="${m?.version||0}" data-lease="${l.id}"`));
}
function ruleModal(id='',newState='') {
    const d=state.data,rule=d.recurring_rules.find(x=>x.id===id),l=rule?d.leases.find(l=>l.id===rule.lease_id):chosenLease().l,month=rule?editableMonth(d,rule):d.business_date.slice(0,7),v=rule?displayedRule(rule,month):null;
    if(newState) {
      const label={active:'Возобновить правило',paused:'Приостановить правило',deleted:'Удалить правило'}[newState];
      modal(label,formContent('rule-state',notice('Уже созданные начисления и история оплаты сохранятся. '+(newState==='active'?'Пропущенные во время паузы месяцы автоматически не начисляются.':'Новые начисления по этому правилу создаваться не будут.'),'amber')+(newState==='active'?field('Возобновить с месяца','from_month','month',month,'required'):''),label,`data-id="${rule.id}" data-version="${rule.version}" data-state="${newState}"`));return;
    }
    const fields=(rule?notice(esc(unitTitle(d.leases.find(l=>l.id===rule.lease_id)))):leasePicker(l.id))+
      field('Название','title','text',v?.title||'','placeholder="Например, Интернет" required maxlength="180"')+
      field('Сумма за весь объект, ₽','amount','text',v?String(v.amount/100):'','required inputmode="decimal" '+(rule?.is_rent?'readonly':''))+
      field('Оплатить до какого числа','due_day','number',v?.due_day||5,'required min="1" max="31" '+(rule?.is_rent?'readonly':''))+
      field('Создавать за сколько дней','advance_days','number',v?.advance_days||14,'required min="1" max="60"')+
      field(rule?'Применить с месяца':'Первый месяц','from_month','month',month,'required')+
      (!rule?field('Последний месяц (необязательно)','end_month','month',model(state).l?.end.slice(0,7)||''):'')+
      notice(rule?.is_rent?'Сумму аренды и день оплаты изменяйте через «Предложить условия» в карточке квартиры. Все арендаторы должны согласовать изменение.':'Новое правило создаёт ежемесячные начисления. Уже выставленные платежи не пересчитываются; меняется только будущий график.');
    modal(rule?'Изменить регулярный платёж':'Регулярный платёж',formContent(rule?'edit-rule':'create-rule',fields,'Сохранить',`data-id="${rule?.id||''}" data-version="${rule?.version||0}"`));
}
function editApartment(id, photoOnly = false) {
    const a = state.data.apartments.find(a => a.id === id);
    if (!a || a.owner_id !== state.data.user.id) throw Error('Редактировать квартиру может только её собственник.');
    const l = state.data.leases.find(l=>l.id===state.leaseId&&l.apartment_id===id)||state.data.leases.find(l=>l.apartment_id===id&&l.status==='active');
    const draftLease = !photoOnly && l && !tenantIds(l).length && !state.data.records.some(r => r.lease_id === l.id);
    let fields = (photoOnly ? '' : apartmentFields(a)) + coverFields(a);
    if (draftLease) fields += '<h3 class="form-section-title">Период и условия аренды</h3>' + leaseFields(l);
    else if (!photoOnly && tenantIds(l).length) fields += notice('Здесь меняются сведения о квартире и фото. Для изменения согласованных условий аренды откройте «Предложить условия» в карточке квартиры.');
    modal(photoOnly ? 'Фото квартиры' : 'Редактировать квартиру', formContent(photoOnly ? 'edit-photo' : 'edit-apartment', fields,
        photoOnly ? 'Сохранить фото' : 'Сохранить изменения',
        `data-id="${a.id}" data-version="${a.version}" ${draftLease ? `data-draft-lease="${l.id}"` : ''}`));
}
async function deleteApartmentModal(id) {
    const { a, u, owner } = model(state);
    if (!owner || !a || a.id !== id || a.owner_id !== u.id) throw Error('Квартиру может удалить только её собственник.');
    const userId = u.id;
    const preview = await request('/apartments/' + encodeURIComponent(id) + '/deletion-preview');
    // Ignore a slow response if the user has navigated to a different property/role.
    if (state.screen !== 'app' || state.page !== 'apartments' || state.data.user.id !== userId || state.data.user.role !== 'owner' || model(state).a?.id !== id) return;
    const returnFocus = state.modal ? previousFocus : null;
    modal('Удалить квартиру?', apartmentDeleteDialog(preview), { initialFocus: '[data-delete-cancel]', descriptionId: 'delete-apartment-question' });
    if (returnFocus) previousFocus = returnFocus;
}
function actionModal(id, action, claimId='') {
    const r = state.data.records.find(r => r.id === id);
    if (!r)
        throw Error('Запись не найдена.');
    // Receipt of a marked payment is confirmed from its own card, not from the action bar.
    const ownsCharge = r.kind === 'charge' && state.data.apartments.find(a => a.id === r.apartment_id)?.owner_id === state.data.user.id;
    const item = actionsFor(r, state).find(x => x.action === action) || (ownsCharge && ['confirm', 'reject'].includes(action) && claimsFor(r.payload).length ? { action, label: action === 'confirm' ? 'Получил' : 'Не получил' } : null);
    if (!item)
        throw Error('Действие уже недоступно. Обновите страницу.');
    let fields = notice(esc(r.title));
    if (action === 'counter')
        fields += timesFields();
    if (['resolve', 'reopen', 'reject'].includes(action) && r.kind !== 'charge')
        fields += textarea(action === 'resolve' ? 'Что сделано' : action === 'reopen' ? 'Что осталось исправить' : 'Причина / комментарий', 'note', '', true);
    if (r.kind === 'charge' && ['claim', 'record_payment', 'confirm', 'reject'].includes(action))
        fields += paymentFields(r, action, state, claimId);
    if (action === 'compensate')
        fields += textarea('Комментарий к компенсации', 'note') + notice('Подтверждайте только после фактического возврата денег. Эта кнопка не выполняет перевод.', 'amber');
    if (action === 'complete' && r.kind === 'termination')
        fields += notice('Аренда перейдёт в архив. Записи останутся доступны сторонам только для чтения. Неурегулированные начисления или покупки блокируют завершение.', 'amber');
    if (action === 'accept' && r.kind === 'terms')
        fields += notice('Согласовать плату ' + money(r.payload.rent) + ' и предложенные условия для будущих начислений?', 'amber');
    modal(item.label, formContent('record-action', fields, item.label, `data-id="${id}" data-action="${action}" data-version="${r.version}" data-claim-id="${claimId}"`));
}
async function fileDialog(id) { const file = await post('/files/' + id + '/ticket'); modal('Файл готов', `${file.mime.startsWith('image/') ? `<img class="download-preview" src="${esc(file.url)}" alt="Предпросмотр вложения">` : notice(esc(file.name))}<p>Ссылка ограничена по времени. Для скачивания нажмите кнопку ниже.</p><div class="action-row">${button(icon('download', 18) + ' Скачать файл', 'download-ready')}</div>`, { download: file }); }
function launchDownload(file) { if (platform.telegram && bridgeData) {
    download(file).then(r => { if (r === 'unsupported') toast('Скачивание недоступно в этой версии Telegram. Обновите приложение.', true); }).catch(() => toast('Не удалось скачать. Откройте файл заново.', true));
    return;
}
if (window.WebApp?.initData && typeof window.WebApp.downloadFile === 'function') {
    try {
        const result = window.WebApp.downloadFile(file.url, file.name);
        if (result?.catch)
            result.catch(() => toast('Не удалось скачать. Откройте файл заново.', true));
    }
    catch {
        toast('В этой версии MAX скачивание недоступно.', true);
    }
}
else {
    const a = document.createElement('a');
    a.href = file.url;
    a.download = file.name;
    a.rel = 'noopener';
    a.click();
} }
function showHelp() { modal('Как пользоваться Ключами', guideContent(state.data.user, state.config)); }
async function clickAction(el) {
    const act = el.dataset.act;
    if (act === 'noop')
        return;
    if (act === 'close-modal') {
        closeModal();
        return;
    }
    if (act === 'login') {
        if (state.config.mode === 'demo') {
            state.screen = 'role';
            render();
            return;
        }
        bridgeData = bridgeData || window.WebApp?.initData || '';
        if (!bridgeData && state.config.mode !== 'demo' && state.pendingStart?.startsWith('join_')) {
            modal('Приглашение в Ключи', inviteOutside(inviteCode(state.pendingStart), state.config));
            return;
        }
        if (!bridgeData) {
            modal('Вход через ' + platform.label, `<p>Откройте Ключи из бота ${platform.label}. Это нужно для безопасного входа в вашу квартиру.</p><div class="action-row">${button('Открыть бота', 'open-bot')}</div>`);
            return;
        }
        await enterApp(await post(platform.telegram ? '/auth/telegram' : '/auth/max', { initData: bridgeData }));
        return;
    }
    if (act === 'role-back') {
        if (state.data) {
            state.screen = 'app';
            render();
        }
        else {
            state.screen = 'welcome';
            render();
        }
        return;
    }
    if (act === 'choose-role') {
        if (state.config.mode === 'demo') {
            const session = await post('/auth/demo', { role: el.dataset.role });
            setToken(session.token);
        }
        else
            await post('/profile', { name: state.data.user.name, role: el.dataset.role, settings: state.data.user.settings });
        state.data = await request('/state');
        initializeGuide();
        state.screen = 'app';
        state.apartmentId = '';
        state.leaseId = '';
        state.scope = 'all';
        nav('home', null, { replace: true });
        applyStart();
        return;
    }
    if (act === 'nav') {
        if (state.modal) closeModal();
        nav(el.dataset.page);
        return;
    }
    if (act === 'switch-role') {
        state.screen = 'role';
        render();
        return;
    }
    if (act === 'open-record') {
        nav('record', el.dataset.id);
        return;
    }
    if (act === 'back') {
        if (state.depth > 1)
            history.back();
        else
            nav('home');
        return;
    }
    if (act === 'filter') {
        state.filter = el.dataset.value;
        render();
        return;
    }
    if (act === 'apt-tab') {
        state.aptTab = el.dataset.tab;
        render();
        queueGuideVisit();
        return;
    }
    if (act === 'apartment-select') {
        state.apartmentId = el.dataset.id;
        state.leaseId = '';
        state.aptTab = 'overview';
        localStorage.setItem('keys.apartment', state.apartmentId);
        nav('apartments');
        return;
    }
    if (act === 'new-record') {
        newRecord(el.dataset.kind);
        return;
    }
    if (act === 'new-apartment') {
        newApartment();
        return;
    }
    if (act === 'delete-apartment' || act === 'refresh-delete-apartment') {
        await deleteApartmentModal(el.dataset.id);
        return;
    }
    if (act === 'edit-apartment' || act === 'edit-photo') {
        editApartment(el.dataset.id, act === 'edit-photo');
        return;
    }
    if (act === 'new-lease') {
        newApartment(true,el.dataset.unit||'');
        return;
    }
    if (act === 'record-action') {
        actionModal(el.dataset.id, el.dataset.action,el.dataset.claimId);
        return;
    }
    if (act === 'file') {
        await fileDialog(el.dataset.id);
        return;
    }
    if (act === 'download-ready') {
        launchDownload(state.modal.download);
        return;
    }
    if (act === 'read-notifications') {
        await post('/notifications/read');
        await reload();
        toast('Уведомления прочитаны');
        return;
    }
    if (act === 'invite') {
        const { l } = chosenLease();
        modal('Пригласить жильца', inviteCreateForm(l, unitTitle(l)));
        return;
    }
    if (act === 'invite-manage') {
        const i = (state.data.invites || []).find(x => x.id === el.dataset.id);
        if (!i) throw Error('Приглашение не найдено. Обновите страницу.');
        modal(i.label ? 'Ссылка для «' + i.label + '»' : 'Ссылка-приглашение', inviteManage(i));
        return;
    }
    if (act === 'invite-share-again' || act === 'invite-renew') {
        const invite = await post('/invites/' + encodeURIComponent(el.dataset.id) + (act === 'invite-renew' ? '/renew' : '/share'), { platform: platform.name });
        showInviteResult(invite, act === 'invite-renew');
        reload().catch(() => {});
        return;
    }
    if (act === 'invite-revoke') {
        modal('Отозвать ссылку?', formContent('invite-revoke', notice('Ссылка перестанет работать сразу. Если жилец ещё не подтвердил приглашение, отправьте ему новую.', 'amber'), 'Отозвать', `data-id="${esc(el.dataset.id)}"`));
        return;
    }
    if (act === 'copy-code') {
        await copyText(state.modal.invite.url);
        return;
    }
    if (act === 'copy-other-link') {
        const i = state.modal.invite, other = i.links?.[i.platform === 'telegram' ? 'max' : 'telegram'];
        if (other) await copyText(other);
        return;
    }
    if (act === 'share-invite') {
        const i = state.modal.invite, lead = 'Приглашаю в Ключи — там платежи, счётчики и заявки по нашей квартире. Откройте ссылку и нажмите «Принять приглашение» в боте:', text = lead + '\n' + i.url;
        if (platform.telegram && bridgeData) {
            await share(lead, i.url);
        }
        else if (window.WebApp?.initData && window.WebApp.shareMaxContent) {
            try {
                await window.WebApp.shareMaxContent({ text });
            }
            catch {
                await copyText(text);
            }
        }
        else if (navigator.share) {
            try {
                await navigator.share({ text });
            }
            catch (e) {
                if (e.name !== 'AbortError')
                    await copyText(text);
            }
        }
        else
            await copyText(text);
        return;
    }
    if (act === 'messengers') {
        const u = state.data.user, linked = u.platforms || {}, tgOn = !!state.config.telegram?.enabled, maxOn = !!state.config.max_bot_url;
        const row = (label, on) => `<div class="setting-row messenger-row"><span><b>${label}</b><small>${on ? 'Подключён к этому аккаунту' : 'Не подключён'}</small></span>${on ? icon('check', 18) : ''}</div>`;
        const canLink = (tgOn && !linked.telegram) || (maxOn && !linked.max);
        modal('Мессенджеры', `<div class="form-stack messenger-stack"><p>Один аккаунт Ключей можно открывать и в MAX, и в Telegram: квартиры, аренды и история общие. Уведомления приходят в каждый подключённый мессенджер.</p><div class="surface panel">${row('MAX', linked.max)}${tgOn || linked.telegram ? row('Telegram', linked.telegram) : ''}</div>${canLink && !u.demo ? `<p>Чтобы подключить второй мессенджер, получите здесь одноразовый код и введите его в Ключах в другом мессенджере.</p><div class="action-row">${button(icon('link', 18) + ' Получить код', 'link-create')}</div>` : ''}${state.platform?.inHost && !u.demo ? `<p class="small-note">Код получен в другом мессенджере? <button type="button" class="text-link" data-act="link-claim">Ввести код</button></p>` : ''}</div>`);
        return;
    }
    if (act === 'link-create') {
        const link = await post('/account-links');
        const target = link.telegram_url ? ['Telegram', link.telegram_url] : link.max_url ? ['MAX', link.max_url] : null;
        modal('Код для подключения', `<div class="form-stack messenger-stack"><p>Откройте Ключи в ${target ? target[0] : 'другом мессенджере'} и введите код в «Профиль → Мессенджеры → Ввести код». Можно и проще: откройте ссылку на бота и подтвердите подключение.</p><div class="code-box">${esc(link.display)}</div>${notice('Код действует 15 минут и подходит один раз. Никому его не отправляйте: он открывает доступ к вашему аккаунту.', 'amber')}<div class="action-row">${button(icon('copy', 18) + ' Скопировать код', 'copy-link-code')}${target ? button(icon('send', 18) + ' Открыть бота ' + target[0], 'open-link-bot', '', 'secondary') : ''}</div></div>`, { link, linkUrl: target?.[1] || '' });
        return;
    }
    if (act === 'copy-link-code') {
        await copyText(state.modal.link.display);
        return;
    }
    if (act === 'open-link-bot') {
        openLink(state.modal.linkUrl);
        return;
    }
    if (act === 'link-claim') {
        modal('Ввести код подключения', formContent('link-claim', field('Код из профиля Ключей', 'code', 'text', '', 'required maxlength="16" autocomplete="off" autocapitalize="characters" placeholder="ABCDE-23456"') + notice(`Этот ${platform.label} будет подключён к аккаунту, в котором вы получили код. Вводите только свой код.`), 'Подключить'));
        return;
    }
    if (act === 'join') {
        showJoin();
        return;
    }
    if(act==='archive-draft'){const {l}=chosenLease();modal('Отменить пустую аренду',formContent('archive-draft',notice('Сама квартира или комната останется. Неиспользованный период уйдёт в архив, приглашения перестанут действовать.','amber'),'Отменить период',`data-id="${l.id}"`));return;}
    if(act==='lease-select') { if(state.modal)closeModal(); const l=state.data.leases.find(x=>x.id===el.dataset.id);if(!l){toast('Эта аренда недоступна.',true);return;}state.leaseId=l.id;state.apartmentId=l.apartment_id;state.aptTab='overview';nav('apartments');return; }
    if(act==='lease-page'){state.unitScope=el.dataset.id;state.scope=model(state).a.id;nav(el.dataset.page,null,{keepScope:true});return;}
    if(act==='new-unit'||act==='edit-unit'){unitModal(el.dataset.id);return;}
    if(act==='new-meter'||act==='edit-meter'){meterModal(el.dataset.id);return;}
    if(act==='meter-baselines'){const {l}=chosenLease();modal('Стартовые показания',baselineForm(state,l));return;}
    if(act==='toggle-meters'){const {l}=chosenLease();await post('/leases/'+l.id+'/meter-settings',{enabled:el.dataset.enabled==='true'});await reload();toast('Настройка передачи показаний сохранена');return;}
    if(act==='restore-meter'){const m=state.data.meters.find(x=>x.id===el.dataset.id);await post('/meters/'+m.id,{active:true,version:m.version});await reload();toast('Счётчик восстановлен');return;}
    if(act==='new-rule'||act==='edit-rule'||act==='rule-state'){ruleModal(el.dataset.id,el.dataset.value);return;}
    if (act === 'meter-baseline') {
        const m = state.data.meters.find(x => x.id === el.dataset.id);
        modal('Начальное показание', formContent('meter', notice(esc(m.label)) + field('Накопительное значение', 'baseline', 'text', String(m.baseline / 1000), 'required inputmode="decimal"') + notice('Можно изменить только до первой передачи показаний.'), 'Сохранить', `data-id="${m.id}"`));
        return;
    }
    if (act === 'logout') {
        await post('/auth/logout');
        setToken('');
        state.data = null;
        state.screen = 'welcome';
        history.replaceState({}, '', '/');
        render();
        return;
    }
    if (act === 'help' || act === 'guide-open') {
        guideEvent('open');
        showHelp();
        return;
    }
    if (act === 'guide-dismiss' || act === 'guide-finish') {
        guideEvent('dismiss');
        if (act === 'guide-finish') closeModal();
        return;
    }
    if (act === 'guide-go') {
        closeModal();
        nav(el.dataset.page, null, { learn: false });
        return;
    }
    if (act === 'about') {
        modal('Ключи', `<div class="legal-text"><h3>Всё, что связано с квартирой, тут.</h3><p>Платежи, договоры, счётчики, заявки и покупки. Собственник и арендатор видят одну историю и согласовывают важные действия.</p><p>Бот напоминает о делах, мини-приложение помогает их выполнить.</p>${notice('Ранняя рабочая версия. Без банковских переводов, электронной подписи и интеграции с коммунальными службами.', 'neutral')}</div>`);
        return;
    }
    if (act === 'security') {
        modal('Безопасность', `<div class="legal-text"><p>Вход в рабочем режиме подтверждается подписью ${platform.label} на сервере. Доступ к квартирам и файлам проверяется отдельно для каждого пользователя.</p><p>Приглашение даёт доступ к одной аренде. Смена роли не открывает чужую квартиру. Ссылки на файлы действуют 5 минут.</p>${notice('Файлы хранятся на сервере оператора. Сквозное шифрование и автоматическая проверка файлов антивирусом в этой версии не реализованы.', 'amber')}<p>Можно завершить все сеансы вашего аккаунта. При следующем входе снова откройте приложение в MAX.</p></div>${button('Выйти на всех устройствах', 'revoke', '', 'danger wide')}`);
        return;
    }
    if (act === 'revoke') {
        await post('/auth/revoke');
        closeModal();
        setToken('');
        state.data = null;
        state.screen = 'welcome';
        render();
        toast('Все сеансы завершены');
        return;
    }
    if (act === 'export') {
        const file = await post('/export/ticket');
        modal('Экспорт данных', notice('Файл JSON содержит доступную вам историю, начисления, показания и сведения о вложениях. Сами вложения скачиваются отдельно.') + button(icon('download', 18) + ' Скачать JSON', 'download-ready', '', 'primary wide'), { download: file });
        return;
    }
    if (act === 'open-bot') {
        openLink(state.config.bot_url);
        return;
    }
}
async function applyStart() {
    const start=state.pendingStart||new URLSearchParams(location.search).get('startapp');state.pendingStart='';
    if(!start)return;
    if(start.startsWith('join_'))return openInvite(start.slice(5)).catch(e=>toast(e.message,true));
    if(start.startsWith('j_')) {
        const l=state.data.leases.find(x=>x.id===start.slice(2));
        if(!l){toast('Эта аренда недоступна.',true);return;}
        state.apartmentId=l.apartment_id;state.leaseId=l.id;state.aptTab='overview';nav('apartments',null,{replace:true});
        modal('Добро пожаловать!',joinedWelcome(state,l));
        return;
    }
    if(start.startsWith('r_')||start.startsWith('c_')) {
        const record=state.data.records.find(r=>r.id===start.slice(2));
        if(record){state.apartmentId=record.apartment_id;state.leaseId=record.lease_id;}
        nav('record',start.slice(2),{replace:true});
        if(start.startsWith('c_'))setTimeout(()=>{document.querySelector('#discussion')?.scrollIntoView({block:'start'});document.querySelector('#comment-text')?.focus({preventScroll:true});},100);
        return;
    }
    if(start.startsWith('l_')||start.startsWith('m_')) {
        const l=state.data.leases.find(x=>x.id===start.slice(2));
        if(!l){toast('Эта аренда недоступна.',true);return;}
        state.apartmentId=l.apartment_id;state.leaseId=l.id;state.aptTab='overview';nav(start.startsWith('m_')?'meters':'apartments',null,{replace:true});
    }
}
function showJoin(code='') {
    if(state.config.mode!=='demo'&&!state.platform?.inHost&&code)return modal('Приглашение в Ключи',inviteOutside(code,state.config));
    modal('Присоединиться к аренде',formContent(state.config.mode==='production'?'join-bot':'join',field('Ссылка или код из приглашения','code','text',code,'required maxlength="300" autocomplete="off" placeholder="Вставьте ссылку от собственника"')+notice('Собственник присылает ссылку вида t.me/…?start=join_… или max.ru/…?start=join_… Можно вставить её целиком.'),state.config.mode==='production'?'Открыть приглашение':'Присоединиться (демо)'));
}
// Accepts a bare code or a whole link with start=join_… / startapp=join_… / ?invite=….
function inviteCode(raw) {
    const t=String(raw||'').trim(),m=t.match(/(?:join_|[?&]invite=)([A-Za-z0-9_-]{8,100})/);
    return m?m[1]:t.replace(/^join_/,'');
}
async function showInviteResult(invite, renewed=false) {
    modal(renewed?'Новая ссылка':'Ссылка для жильца',inviteResult(invite,{inHost:!!state.platform?.inHost,platformLabel:platform.label,renewed}),{invite});
}
// A link opened inside the Mini App: confirm here, no detour through the bot chat.
async function openInvite(code) {
    code=inviteCode(code);
    if(!code)return;
    if(state.config.mode!=='demo'&&!state.platform?.inHost)return modal('Приглашение в Ключи',inviteOutside(code,state.config));
    if(state.config.mode==='demo')return showJoin(code);
    const p=await post('/invites/preview',{code});
    if(!p.ok)return modal(p.reason==='member'?'Вы уже в этой аренде':'Ссылка не сработала',inviteProblem(p));
    modal('Приглашение в аренду',invitePreview(p,code));
}
async function copyText(t) { try {
    await navigator.clipboard.writeText(t);
    toast('Скопировано');
}
catch {
    toast('Выделите и скопируйте код вручную.', true);
} }
async function collectFiles(form, leaseId) { const input = form.querySelector('input[type=file]'); if (!input?.files.length)
    return []; const old = pendingFiles.get(input), key = [...input.files].map(f => f.name + f.size + f.lastModified).join('|'); if (old?.key === key && old.leaseId === leaseId)
    return old.ids; const ids = await uploadFiles([...input.files], leaseId); pendingFiles.set(input, { key, leaseId, ids }); return ids; }
function parseDisplayDate(value,type) {
    const v=value.trim();if(!v)return '';
    if(type==='month') { const m=v.match(/^(0[1-9]|1[0-2])\.(\d{4})$/);if(!m)throw Error('Месяц: ММ.ГГГГ, например 10.2026.');return m[2]+'-'+m[1]; }
    const m=v.match(type==='datetime-local'?/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/:/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if(!m)throw Error(type==='datetime-local'?'Дата и время: ДД.ММ.ГГГГ ЧЧ:ММ.':'Дата: ДД.ММ.ГГГГ.');
    const iso=m[3]+'-'+m[2]+'-'+m[1],dt=new Date(iso+'T12:00:00Z');if(isNaN(+dt)||dt.toISOString().slice(0,10)!==iso)throw Error('Проверьте день, месяц и год.');
    if(type==='datetime-local'){if(+m[4]>23||+m[5]>59)throw Error('Проверьте время.');return iso+'T'+m[4]+':'+m[5];}return iso;
}
async function submit(form) {
    const data = Object.fromEntries(new FormData(form)), type = form.dataset.form;
    try { for(const el of form.querySelectorAll('[data-date-format]'))data[el.name]=parseDisplayDate(el.value,el.dataset.dateFormat); } catch(e){const error=form.querySelector('.form-error');if(error)error.textContent=e.message;return;}
    form.dataset.key ||= uuid();
    const key = form.dataset.key;
    const submitter = form.querySelector('button[type=submit]');
    const errors = form.querySelector('.form-error');
    if (errors)
        errors.textContent = '';
    if (submitter) {
        submitter.disabled = true;
        submitter.classList.add('loading-button');
    }
    if (state.modal)
        state.modal.busy = true;
    const locked = ['create-apartment','edit-apartment','edit-photo'].includes(type) ? [...form.elements].filter(el => el !== submitter).map(el => [el, el.disabled]) : [];
    for (const [el] of locked) el.disabled = true;
    try {
        let result, message = 'Сохранено';
        if (type === 'create-apartment' || type === 'create-lease') {
            const body = { ...data, meters_enabled:data.meters_enabled==='on',recurring_rent:data.recurring_rent==='on', rent: parseAmount(data.rent), deposit: parseAmount(data.deposit), due_day: Number(data.due_day), meter_day: Number(data.meter_day), rooms: Number(data.rooms), area: Number(data.area) };
            if (data.end <= data.start) throw Error('Окончание аренды должно быть после начала.');
            if (type === 'create-apartment') Object.assign(body, await collectCover(form));
            result = await post(type === 'create-apartment' ? '/apartments' : '/apartments/' + model(state).a.id + '/leases', body, key);
            state.apartmentId = type === 'create-apartment' ? result.id : result.apartment_id;
            state.leaseId = type==='create-lease'?result.id:'';
            message = 'Карточка аренды создана. Пригласите арендатора.';
        }
        if (type === 'delete-apartment') {
            const id = form.dataset.id;
            await post('/apartments/' + encodeURIComponent(id) + '/delete', {
                confirmed: true, version: Number(form.dataset.version), confirmation_token: form.dataset.confirmation
            }, key);
            state.data = withoutApartment(state.data, id);
            state.apartmentId = state.data.apartments.find(a => a.owner_id === state.data.user.id)?.id || '';
            state.leaseId = ''; state.scope = 'all'; state.unitScope = ''; state.aptTab = 'overview'; state.recordId = null;
            localStorage.setItem('keys.apartment', state.apartmentId);
            if (state.modal) state.modal.busy = false;
            closeModal();
            nav('home', null, { replace: true, learn: false });
            toast('Квартира удалена');
            try { await reload(); }
            catch { toast('Квартира удалена. Для обновления остальных данных проверьте соединение.', true); }
            return;
        }
        if (type === 'edit-apartment' || type === 'edit-photo') {
            const body = { version: Number(form.dataset.version), ...await collectCover(form) };
            if (type === 'edit-apartment') Object.assign(body, {
                title: data.title, address: data.address, rooms: Number(data.rooms), area: Number(data.area)
            });
            if (form.dataset.draftLease) {
                if (data.end <= data.start) throw Error('Окончание аренды должно быть после начала.');
                body.lease = { id: form.dataset.draftLease, start: data.start, end: data.end,
                    rent: parseAmount(data.rent), deposit: parseAmount(data.deposit), terms: data.terms,
                    due_day: Number(data.due_day), meter_day: Number(data.meter_day) };
            }
            result = await post('/apartments/' + form.dataset.id, body, key);
            state.apartmentId = result.id;
            localStorage.setItem('keys.apartment', result.id);
            message = type === 'edit-photo' ? 'Фото квартиры обновлено' : 'Изменения квартиры сохранены';
        }
        if (type === 'create-record') {
            const kind = form.dataset.kind, leaseId = data.lease_id;
            const payload = {};
            let title = data.title || kindNames[kind];
            if (kind === 'ticket')
                Object.assign(payload, { description: data.description, room: data.room, priority: data.priority });
            if (kind === 'purchase')
                Object.assign(payload, { description: data.description, purchase_date: data.purchase_date, amount: parseAmount(data.amount) });
            if (kind === 'visit') {
                title = 'Посещение собственника';
                Object.assign(payload, { start: new Date(data.start).toISOString(), end: new Date(data.end).toISOString(), reason: data.reason });
            }
            if (kind === 'charge')
                Object.assign(payload, { amount: parseAmount(data.amount), period: data.period, due: data.due, repeat:data.repeat==='on', advance_days:Number(data.advance_days||14) });
            if (kind === 'document')
                Object.assign(payload, { category: data.category, description: data.description, private: data.private === 'on' });
            if (kind === 'expense')
                Object.assign(payload, { amount: parseAmount(data.amount), date: data.date, description: data.description });
            if (kind === 'termination') {
                title = 'Завершение аренды';
                Object.assign(payload, { date: data.date, reason: data.reason });
            }
            if (kind === 'terms') {
                title = 'Изменение условий аренды';
                Object.assign(payload, { rent: parseAmount(data.rent), terms: data.terms, due_day:Number(data.due_day),effective_month:data.effective_month });
            }
            const files = await collectFiles(form, leaseId);
            result = await post('/records', { lease_id: leaseId, kind, title, payload, files }, key);
            message = kind === 'document' ? 'Документ сохранён' : 'Запись создана';
        }
        if (type === 'record-action') {
            const record = state.data.records.find(r => r.id === form.dataset.id);
            const body = { action: form.dataset.action, version: Number(form.dataset.version), note: data.note || '', ...(form.dataset.claimId?{claim_id:form.dataset.claimId}:{}),...(data.payer_id?{payer_id:data.payer_id}:{}),...(data.method?{method:data.method}:{}),...(data.paid_on?{paid_on:data.paid_on}:{}) };
            if (data.amount !== undefined)
                body.amount = parseAmount(data.amount);
            if (data.start)
                Object.assign(body, { start: new Date(data.start).toISOString(), end: new Date(data.end).toISOString() });
            body.files = await collectFiles(form, record.lease_id);
            result = await post('/records/' + record.id + '/action', body, key);
            message = 'Статус обновлён';
        }
        if (type === 'readings') {
            if (!form.querySelector('input[type=file]')?.files.length) throw Error('Приложите фото счётчиков — по нему собственник сверит цифры.');
            const leaseId = form.dataset.lease, values = pendingMeters(state.data,state.data.leases.find(l=>l.id===leaseId)).map(m => ({ meter_id: m.id, value: parseAmount(data['meter_' + m.id], 1000) })), files = await collectFiles(form, leaseId);
            result = await post('/records', { lease_id: leaseId, kind: 'reading', title: 'Показания счётчиков', payload: { values }, files }, key);
            message = 'Показания переданы собственнику';
        }
        if (type === 'comment') {
            const textValue = String(data.text || '').trim();
            if (textValue.length < 3) throw Error('Комментарий должен быть чуть подробнее: минимум 3 символа.');
            await post('/records/' + form.dataset.id + '/comments', { text: textValue }, key);
            message = 'Комментарий отправлен';
        }
        if (type === 'profile') {
            const u = state.data.user, settings = { ...u.settings, events: data.events === 'on', reminders: data.reminders === 'on', bot: data.bot === 'on',theme:data.theme||'auto' };
            if (data.tax_status)
                settings.tax_status = data.tax_status;
            await post('/profile', { name: data.name, role: u.role, settings }, key);
            // Telegram bots may write first only with the user's permission.
            if (platform.telegram && settings.bot && u.platforms?.telegram && !u.tg_bot_enabled && await requestWriteAccess())
                await post('/profile/telegram-write');
            message = 'Настройки сохранены';
        }
        if (type === 'link-claim') {
            const linked = await post('/account-links/claim', { code: data.code.trim(), platform: platform.name }, key);
            setToken(linked.token);
            state.data = await request('/state');
            initializeGuide();
            state.screen = state.data.apartments.length ? 'app' : 'role';
            message = 'Аккаунт подключён: квартиры и история теперь здесь';
        }
        if (type === 'join') {
            result = await post('/join', { code: inviteCode(data.code) }, key);
            state.apartmentId = result.apartment_id;
            state.leaseId = result.lease_id;
            message = 'Вы присоединились к аренде';
        }
        if(type==='archive-draft'){await post('/leases/'+form.dataset.id+'/archive-draft',{},key);state.leaseId='';message='Неиспользованный период отменён';}
        if(type==='invite-create') {
            const invite=await post('/leases/'+form.dataset.lease+'/invite',{platform:platform.name,label:String(data.label||'').trim()},key);
            if(state.modal)state.modal.busy=false;
            await showInviteResult(invite);
            reload().catch(()=>{});
            return;
        }
        if(type==='invite-revoke') {
            await post('/invites/'+encodeURIComponent(form.dataset.id)+'/revoke',{},key);
            message='Ссылка отозвана';
        }
        if(type==='invite-accept') {
            result=await post('/invites/accept',{code:form.dataset.code},key);
            if(platform.telegram&&bridgeData&&!state.data.user.tg_bot_enabled&&await requestWriteAccess())await post('/profile/telegram-write').catch(()=>{});
            if(state.modal)state.modal.busy=false;
            closeModal();
            await reload();
            state.pendingStart='j_'+result.lease_id;
            applyStart();
            toast('Вы присоединились к аренде');
            return;
        }
        if(type==='join-bot') {
            if(state.platform?.inHost){if(state.modal)state.modal.busy=false;closeModal();await openInvite(data.code);return;}
            const url=new URL(state.config.bot_url);url.searchParams.set('start','join_'+inviteCode(data.code));
            if(platform.telegram&&bridgeData)openLink(url.href);else window.location.href=url.href;
            if(state.modal)state.modal.busy=false;closeModal();return;
        }
        if(type==='create-unit'||type==='edit-unit') {
            result=await post(type==='create-unit'?'/apartments/'+form.dataset.apartment+'/units':'/units/'+form.dataset.id,{title:data.title,kind:'room',version:Number(form.dataset.version)},key);
            message='Комната сохранена. Теперь можно создать для неё отдельную аренду.';
        }
        if(type==='meter-baselines') {
            const values=[...form.querySelectorAll('input[name^="baseline_"]')].map(input=>({meter_id:input.name.slice(9),value:parseAmount(input.value,1000)}));
            await post('/leases/'+form.dataset.lease+'/meter-baselines',{values},key);
            message='Стартовые показания записаны';
        }
        if(type==='create-meter'||type==='edit-meter') {
            const body={label:data.label,version:Number(form.dataset.version)};
            body.price=String(data.price??'').trim()?parseAmount(data.price):null;
            if(data.baseline!==undefined)body.baseline=parseAmount(data.baseline,1000);
            if(type==='create-meter')Object.assign(body,{kind:data.kind,unit:data.unit,scope:data.scope,scheme:data.scheme});
            else body.active=data.active==='on';
            result=await post(type==='create-meter'?'/leases/'+form.dataset.lease+'/meters':'/meters/'+form.dataset.id,body,key);message='Счётчик сохранён';
        }
        if(type==='create-rule'||type==='edit-rule') {
            const body={title:data.title,amount:parseAmount(data.amount),due_day:Number(data.due_day),advance_days:Number(data.advance_days),version:Number(form.dataset.version)};
            if(type==='create-rule')Object.assign(body,{lease_id:data.lease_id,start_month:data.from_month,...(data.end_month?{end_month:data.end_month}:{})});else body.effective_month=data.from_month;
            result=await post('/recurring-rules'+(type==='edit-rule'?'/'+form.dataset.id:''),body,key);message='Регулярный платёж сохранён';
        }
        if(type==='rule-state') { await post('/recurring-rules/'+form.dataset.id,{action:{active:'resume',paused:'pause',deleted:'delete'}[form.dataset.state],version:Number(form.dataset.version),...(data.from_month?{effective_month:data.from_month}:{})},key);message='Правило обновлено'; }
        if (type === 'meter') {
            await post('/meters/' + form.dataset.id, { baseline: parseAmount(data.baseline, 1000) }, key);
            message = 'Начальное показание сохранено';
        }
        if (state.modal)
            state.modal.busy = false;
        closeModal();
        await reload();
        if (['create-record', 'readings'].includes(type) && result?.id)
            nav('record', result.id);
        else if (['create-apartment', 'create-lease', 'join'].includes(type)) {
            state.aptTab='overview'; state.unitScope=''; nav('apartments');
        }
        else
            render();
        toast(message);
    }
    catch (e) {
        if (state.modal)
            state.modal.busy = false;
        if (errors)
            errors.textContent = e.message;
        else
            toast(e.message, true);
        if (type === 'delete-apartment' && [403, 404, 409].includes(e.status)) {
            form.dataset.confirmationStale = '1';
            if (e.status === 409 && !form.querySelector('[data-act="refresh-delete-apartment"]')) {
                const area = form.querySelector('.delete-confirm-actions');
                area?.insertAdjacentHTML('afterend', button('Проверить ещё раз', 'refresh-delete-apartment', `data-id="${esc(form.dataset.id)}"`, 'secondary wide'));
            }
        }
        if (e.status === 409) {
            try {
                const fresh = await request('/state');
                state.data = fresh;
                if (form.dataset.form === 'record-action') {
                    const r = fresh.records.find(r => r.id === form.dataset.id);
                    if (r)
                        form.dataset.version = r.version;
                }
                delete form.dataset.key;
            }
            catch { }
        }
    }
    finally {
        for (const [el, disabled] of locked) el.disabled = disabled;
        if (submitter) {
            submitter.disabled = form.dataset.confirmationStale === '1';
            submitter.classList.remove('loading-button');
        }
    }
}
document.addEventListener('click', async (e) => { const el = e.target.closest('[data-act]'); if (!el) {
    if (e.target.matches('[data-overlay]'))
        closeModal();
    return;
} if (el.disabled || el.dataset.busy === '1')
    return; e.preventDefault(); if (state.modal?.busy && el.dataset.act === 'close-modal')
    return; el.dataset.busy = '1'; try {
    await clickAction(el);
}
catch (err) {
    toast(err.message, true);
}
finally {
    delete el.dataset.busy;
} });
document.addEventListener('submit', e => { const form = e.target.closest('[data-form]'); if (!form)
    return; e.preventDefault(); if (form.dataset.submitting)
    return; form.dataset.submitting = '1'; submit(form).finally(() => delete form.dataset.submitting); });
document.addEventListener('change', e => { const el = e.target; if (el.closest('[data-cover-editor]')) { handleCoverChange(el).catch(err => toast(err.message, true)); } if (el.dataset.change === 'scope') {
    state.unitScope='';
    state.scope = el.value;
    render();
} if (el.dataset.change === 'lease') {
    state.leaseId = el.value;
    render();
} if(el.dataset.change==='theme')setTheme(el.value);
if(el.name==='rental_mode')el.form.querySelector('[data-room-name]').hidden=el.value!=='rooms';
if(el.name==='kind'&&el.form?.dataset.form==='create-meter'){el.form.querySelector('[data-electric-scheme]').hidden=el.value!=='electricity';el.form.elements.unit.value=el.value==='electricity'?'кВт·ч':el.value==='heating'?'Гкал':el.value==='other'?'ед.':'м³';}
if (el.type === 'file') {
    const summary = el.closest('label')?.querySelector('[data-file-summary]');
    if (summary)
        summary.textContent = [...el.files].map(f => f.name).join(' · ') || 'Выбрать файлы';
} const form = el.closest('form'); if (form)
    delete form.dataset.key; });
document.addEventListener('input', e => { const f = e.target.closest('form'); if (f)
    delete f.dataset.key; });
document.addEventListener('keydown', e => { if (!state.modal)
    return; if (e.key === 'Escape')
    closeModal(); if (e.key === 'Tab') {
    const list = [...modalRoot.querySelectorAll('button:not(:disabled),a[href],input,select,textarea,[tabindex="0"]')].filter(el => el.offsetParent !== null);
    if (!list.length)
        return;
    const first = list[0], last = list.at(-1);
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    }
    else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
} });
window.addEventListener('popstate', () => { if (state.screen === 'app') {
    routeFromLocation();
    state.filter = 'all';
    render();
    window.scrollTo(0, 0);
} });
window.addEventListener('offline', () => toast('Нет сети. Несохранённые данные остаются в открытой форме.', true));
window.addEventListener('online', () => { toast('Соединение восстановлено'); syncGuide(state.data?.user).then(updateGuidePrompt); });
async function enterApp(session) {
    setToken(session.token);
    state.pendingStart = session.start_param || state.pendingStart;
    state.data = await request('/state');
    initializeGuide();
    if (state.data.user.settings.theme) setTheme(state.data.user.settings.theme);
    // An invite link skips the role question: the person is joining as a tenant.
    state.screen = state.data.apartments.length || String(state.pendingStart || '').startsWith('join_') ? 'app' : 'role';
    render();
    if (state.screen === 'app') {
        nav('home', null, { replace: true, learn: false });
        await applyStart();
    }
}
// Returning users skip the welcome screen; a first launch still shows it with the terms.
async function silentLogin() {
    const initData = bridgeData || window.WebApp?.initData || '';
    if (!initData) return false;
    try {
        const session = await post(platform.telegram ? '/auth/telegram' : '/auth/max', { initData, probe: true });
        if (!session.token) return false;
        await enterApp(session);
        return true;
    } catch { return false; }
}
async function boot() { try {
    await bridgeReady();
    bridgeData = bridgeData || launchData();
    if (platform.telegram) useHostTheme(hostScheme, paintHost), onHostSchemeChange(() => applyTheme());
    state.config = await request('/config');
    state.config.max_bot_url = state.config.bot_url;
    if (platform.telegram && state.config.telegram?.bot_url) state.config.bot_url = state.config.telegram.bot_url;
    state.platform = { ...platform, inHost: !!bridgeData };
    const params=new URLSearchParams(location.search);if(params.get('invite'))state.pendingStart='join_'+params.get('invite');else if(params.get('startapp'))state.pendingStart=params.get('startapp');
    if (state.config.mode !== 'demo' && (bridgeData || window.WebApp?.initData)) {
        if (await silentLogin()) return;
        state.screen = 'welcome';
        render();
        return;
    }
    try {
        state.data = await request('/state');
        initializeGuide();
        state.screen = 'app';
        routeFromLocation();
        if(state.data.user.settings.theme)setTheme(state.data.user.settings.theme);
        applyStart();
    }
    catch (e) {
        if (e.status !== 401)
            throw e;
        state.screen = 'welcome';
    }
    render();
    // A link opened in a plain browser: point the person to their messenger right away.
    if (state.screen === 'welcome' && !bridgeData && state.config.mode !== 'demo' && state.pendingStart?.startsWith('join_'))
        modal('Приглашение в Ключи', inviteOutside(inviteCode(state.pendingStart), state.config));
}
catch (e) {
    root.innerHTML = `<div class="app-error">${icon('info', 35)}<h2>Не удалось загрузить Ключи</h2><p>${esc(e.message)}</p><button class="btn primary" data-act="reload-page">Попробовать снова</button></div>`;
    root.querySelector('[data-act=reload-page]').onclick = () => location.reload();
} }
boot();
setInterval(async () => { if (state.screen !== 'app' || state.modal || loading || document.hidden || ['profile', 'meters'].includes(state.page) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName))
    return; loading = true; try {
    const old = state.data;
    const next = await request('/state');
    state.data = next;
    const changed = old.records.length !== next.records.length || old.notifications.length !== next.notifications.length || old.records.some((r, i) => r.id !== next.records[i]?.id || r.version !== next.records[i]?.version) || old.comments.length !== next.comments.length || old.apartments.length !== next.apartments.length || old.apartments.some((a, i) => a.id !== next.apartments[i]?.id || a.version !== next.apartments[i]?.version) || ['leases','units','meters','meter_history','recurring_rules','invites','members'].some(k=>JSON.stringify(old[k])!==JSON.stringify(next[k]));
    if (changed)
        render();
}
catch { }
finally {
    loading = false;
} }, 30000);

root.addEventListener('error', async e => {
    const image = e.target;
    if (!(image instanceof HTMLImageElement) || !image.dataset.coverId) return;
    if (image.dataset.retried) { image.src = image.dataset.fallback || '/art/living.webp'; delete image.dataset.coverId; return; }
    image.dataset.retried = '1';
    try { const next = await post('/apartment-covers/' + image.dataset.coverId + '/ticket'); if (image.isConnected) image.src = next.url; }
    catch { if (image.isConnected) { delete image.dataset.coverId; image.src = image.dataset.fallback || '/art/living.webp'; } }
}, true);

// Refit shared numeric components after the host changes its WebView size.
let numericFrame;
window.addEventListener('resize', () => {
    cancelAnimationFrame(numericFrame);
    numericFrame = requestAnimationFrame(() => fitNumericLabels(root));
});
