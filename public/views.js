import { apartmentDeleteFooter } from './apartment-delete-ui.js';
import { guidePrompt } from './guide.js';
import { peopleSection } from './invites-ui.js';
import { ownersSection } from './owners-ui.js';
import { metersContent as meterSection } from './meters-ui.js';
import { chargeDetail } from './payments-ui.js';
import { nameIn } from './people.js';
import { myDuePanel, freshUtilitiesCard, cashBlock, missingUtilitiesCard, approvalBlock, coOwnerUtilitiesCard, utilityGroups, isDraft, isUtilities, markSeen, monthWord } from './cash-ui.js';
import { surface, listItem, statCard, segmented, actionTile, navigationRow, pageTone, navPage } from './ui.js';
import { canManage, isMainOwner, isOwnerSide, ownerNames, tenantIds, isTenant, unitTitle, metersFor, pendingMeters, claimsFor, freeAmount, displayedRule, monthLabel, editableMonth, plannedNext } from './rental-ui.js';
import { recordTitle, esc, money, number, date, datetime, range, icon, pillIcon, button, section, empty, notice, badge, recordBadge, count, days, dateRange, statusNames, categoryNames, fileSize, kindNames, kindIcon, kindColor, platformLogo, maxLogo } from './utils.js';
export const navItems = [['home', 'home', 'Главная'], ['apartments', 'building', 'Квартира'], ['requests', 'tool', 'Заявки'], ['finances', 'wallet', 'Платежи'], ['documents', 'folder', 'Документы'], ['profile', 'user', 'Профиль']];
export function model(s) {
    const d=s.data,u=d.user,owner=u.role==='owner';
    const apartments=d.apartments.filter(a=>owner?canManage(a):d.leases.some(l=>l.apartment_id===a.id&&isTenant(l,u.id)));
    const a=apartments.find(x=>x.id===s.apartmentId)||apartments[0];
    const leases=d.leases.filter(l=>a&&l.apartment_id===a.id&&(owner||isTenant(l,u.id)));
    const l=leases.find(x=>x.id===s.leaseId)||leases.find(x=>x.status!=='ended')||leases[0];
    const ids=new Set(apartments.map(x=>x.id)),records=d.records.filter(r=>ids.has(r.apartment_id));
    return {d,u,owner,apartments,a,l,leases,records};
}
function scoped(s,kind) { const m=model(s); return m.records.filter(r=>(!kind||r.kind===kind)&&(s.scope==='all'||r.apartment_id===s.scope)&&(!s.unitScope||r.lease_id===s.unitScope)); }
function heading(title, sub = '', action = '') { return `<div class="page-heading"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${action}</div>`; }

function nav(s, desktop = false) {
    const { owner } = model(s), active = navPage(s);
    const tones = { home: 'blue', apartments: 'blue', requests: 'purple', finances: 'green', documents: 'slate', profile: 'blue' };
    return navItems.map(([id, i, name]) => {
        const label = id === 'apartments' && owner ? 'Квартиры' : id === 'finances' && owner ? 'Финансы' : name;
        return `<button type="button" data-act="nav" data-page="${id}" data-tone="${tones[id]}" class="nav-item ${active === id ? 'active' : ''}" ${active === id ? 'aria-current="page"' : ''} aria-label="${label}" title="${label}"><span class="nav-icon">${icon(i, 22)}</span><span class="nav-label">${label}</span></button>`;
    }).join('');
}
function scopeControl(s) { const m = model(s); if (m.apartments.length < 2)
    return ''; return `<label class="scope-control">${icon('building', 18)}<select aria-label="Фильтр по квартире" data-change="scope"><option value="all">Все квартиры</option>${m.apartments.map(a => `<option value="${a.id}" ${s.scope === a.id ? 'selected' : ''}>${esc(a.title)}</option>`).join('')}</select></label>`; }
function filterBar(items, current) { return segmented(items, current, { label: 'Фильтр списка' }); }
function arrowButton(label, page) { return `<button class="text-link" data-act="nav" data-page="${page}">${label}${icon('arrow', 16)}</button>`; }
// Where a record lives, said only when it tells something new: the apartment when the
// owner has several and is not inside one, the room when a room (not the whole flat) is let.
function recordPlace(r, s) {
    const { owner, d, apartments } = model(s), a = d.apartments.find(x => x.id === r.apartment_id), l = d.leases.find(x => x.id === r.lease_id), out = [];
    if (owner && apartments.length > 1 && s.page !== 'apartments' && a) out.push(a.title);
    if (l && (d.units || []).find(u => u.id === l.unit_id)?.kind === 'room') out.push(unitTitle(l));
    return out;
}
export function recordCard(r, s, { compact = false } = {}) {
    const { owner, d } = model(s), a = d.apartments.find(x => x.id === r.apartment_id), p = r.payload;
    let sub = p.description || p.reason || '';
    if (r.kind === 'visit')
        sub = range(p.start, p.end) + (p.reason ? ' · ' + p.reason : '');
    if (r.kind === 'charge')
        sub = 'До ' + date(p.due,{year:'numeric'}) + (p.rule_id?' · Регулярный':'');
    if (r.kind === 'document')
        sub = categoryNames[p.category] || 'Документ';
    if (r.kind === 'reading')
        sub = (p.values || []).map(v => `${v.label}: ${number(v.value / 1000)}`).join(' · ');
    if (r.kind === 'expense')
        sub = date(p.date);
    if (r.kind === 'termination')
        sub = 'Планируемая дата: ' + date(p.date);
    const visual = !compact && r.kind === 'ticket' && p.art ? `<img class="record-thumbnail" src="/art/${esc(p.art)}.webp" alt="">` : pillIcon(kindIcon[r.kind], kindColor[r.kind] || 'neutral');
    return listItem({ className: `record-card ${compact ? 'compact' : ''}`, act: 'open-record', attrs: `data-id="${r.id}"`, tone: kindColor[r.kind] || 'neutral', leading: visual,
        content: `<span class="record-copy"><span class="record-title">${esc(recordTitle(r))}</span>${sub ? `<span class="record-sub">${esc(sub)}</span>` : ''}<span class="record-meta">${esc(recordPlace(r, s).concat(r.kind === 'ticket' && p.room ? [p.room] : [], [date(r.created_at)]).join(' · '))}</span></span>`,
        trailing: `<span class="record-end">${['purchase', 'charge', 'expense'].includes(r.kind) ? `<b data-fit-number>${money(p.amount)}</b>` : ''}${recordBadge(r, d.business_date)}${icon('arrow', 17)}</span>` });
}
function apartmentHero(a, { small = false, subtitle = '', act = 'apartment-select', editable = false } = {}) {
    const interactive = act && act !== 'noop';
    const tag = interactive ? 'button' : 'div';
    const stockPhoto = ['living','owner','room'].includes(a.photo) ? a.photo : 'living';
    const fallback = '/art/' + (stockPhoto === 'owner' ? 'house' : stockPhoto) + '.webp';
    const src = a.cover_url || fallback;
    return `<div class="apartment-cover ${small ? 'small' : ''}"><${tag} class="apartment-hero ${small ? 'small' : ''} ${stockPhoto === 'owner' && !a.cover_url ? 'building-photo' : ''}" ${interactive ? `data-act="${act}" data-id="${a.id}"` : ''}>
        <img src="${esc(src)}" alt="${a.cover_url ? 'Фото квартиры' : 'Иллюстрация квартиры'}" ${a.cover_id ? `data-cover-id="${a.cover_id}"` : ''} data-fallback="${fallback}">
        <span class="hero-gradient"></span><span class="hero-info"><strong>${esc(a.title)}</strong><span>${esc(subtitle || a.address)}</span></span>
        ${interactive ? `<span class="hero-arrow">${icon('arrow')}</span>` : ''}
    </${tag}>${editable ? `<button type="button" aria-label="Изменить фото квартиры" class="cover-change" data-act="edit-photo" data-id="${a.id}">${icon('camera', 18)}<span>Изменить фото</span></button>` : ''}</div>`;
}
export function welcome(s) { return `<div class="welcome-page"><div class="welcome-art"></div><div class="welcome-top"><img class="wordmark" src="/art/keys-logo-white.png" alt="Ключи"><h1>Всё о квартире<br>и важных делах тут</h1><p>Меньше сообщений.<br>Больше спокойствия.</p></div><div class="welcome-bottom">${s.config?.mode === 'demo' ? '<span class="welcome-label">ДЕМОНСТРАЦИОННАЯ ВЕРСИЯ</span>' : ''}${button(`${s.config?.mode === 'demo' ? maxLogo() : platformLogo(s.platform?.name)} ${s.config?.mode === 'demo' ? 'Попробовать демо' : 'Войти через ' + (s.platform?.label || 'MAX')}`, 'login', '', 'white')}<p>${s.config?.mode === 'demo' ? 'Вымышленные квартиры и пользователи.<br>Не загружайте личные документы.' : `Продолжая, вы принимаете <a href="${esc(s.config?.terms_url)}" target="_blank" rel="noopener">условия использования</a> и <a href="${esc(s.config?.privacy_url)}" target="_blank" rel="noopener">политику конфиденциальности</a>.`}</p><button class="welcome-about" data-act="about">Что умеют Ключи ${icon('arrow', 15)}</button></div></div>`; }
export function roleView(s) { return `<div class="role-page"><header><button class="icon-button" data-act="role-back" aria-label="Назад">${icon('back')}</button><img class="wordmark" data-themed-logo src="/art/keys-logo-black.png" alt="Ключи"></header><div class="role-content">${heading(s.data ? 'Выберите кабинет' : 'Кто вы?', s.data ? 'Один аккаунт может одновременно сдавать и снимать жильё.' : 'Это поможет настроить приложение<br>под ваши задачи')}<button class="role-card" data-act="choose-role" data-role="tenant"><img src="/art/tenant.webp" alt="Житель квартиры"><span><strong>Я снимаю квартиру</strong><small>Платежи, заявки, показания и всё важное в одном месте</small></span>${icon('arrow')}</button><button class="role-card" data-act="choose-role" data-role="owner"><img src="/art/owner.webp" alt="Городской дом"><span><strong>Я собственник</strong><small>Квартиры, жильцы, финансы и документы</small></span>${icon('arrow')}</button></div><p class="role-footnote">${s.config?.mode === 'demo' ? 'В демо каждая роль — отдельный тестовый пользователь.' : 'Переключение не удаляет ваши квартиры и историю.<br>Доступ зависит от собственности и приглашений.'}${s.platform?.inHost && s.config?.mode !== 'demo' && !s.data?.apartments?.length ? `<br><button type="button" class="text-link" data-act="link-claim">Уже пользуетесь Ключами в ${s.platform.telegram ? 'MAX' : 'Telegram'}? Ввести код</button>` : ''}</p></div>`; }
export function shell(s, content) { const { u, owner } = model(s); const unread = s.data.notifications.filter(n => !n.is_read).length; const ownerApartments = s.data.apartments.filter(a => canManage(a)).length; const tenantApartments = s.data.apartments.filter(a => s.data.leases.some(l => l.apartment_id === a.id && isTenant(l, u.id))).length; const hasBothRoles = ownerApartments && tenantApartments; const backButton = s.page !== 'home' ? `<button class="icon-button topbar-back" data-act="back" aria-label="Назад">${icon('back')}</button>` : `<span class="topbar-spacer" aria-hidden="true"></span>`; const roleSwitch = hasBothRoles ? `<button type="button" class="topbar-role" data-tone="blue" data-act="switch-role" aria-label="Сменить режим: сейчас ${owner ? 'собственник' : 'арендатор'}"><span>${owner ? 'Собственник' : 'Арендатор'}</span><span class="role-switch-caption">Сменить ${icon('arrow',14)}</span></button>` : `<span class="desktop-context">${owner ? 'Кабинет собственника' : 'Кабинет арендатора'}</span>`; return `<div class="app-shell" data-tone="${pageTone(s)}"><aside class="sidebar" aria-label="Боковая панель"><img class="wordmark" data-themed-logo src="/art/keys-logo-black.png" alt="Ключи"><div class="sidebar-tag">Всё о вашей аренде</div><nav aria-label="Основная навигация">${nav(s, true)}</nav><div class="sidebar-bottom"><div class="sidebar-note">${icon('shield', 18)}<p>Всё на своих местах.<small>Документы и договорённости.</small></p></div><button type="button" class="account-card" data-tone="blue" data-act="nav" data-page="profile"><span class="avatar">${esc(u.name[0])}</span><span><b>${esc(u.name)}</b><small>${owner ? 'Собственник' : 'Арендатор'}</small></span>${icon('arrow', 16)}</button></div></aside><div class="app-body"><header class="topbar ${hasBothRoles ? 'has-role-switch' : ''}">${backButton}<img class="wordmark" data-themed-logo src="/art/keys-logo-black.png" alt="Ключи">${roleSwitch}<button class="icon-button notifications-button" data-act="nav" data-page="notifications" aria-label="Уведомления">${icon('bell')}${unread ? '<i class="notification-dot"></i>' : ''}</button></header>${s.config.mode === 'demo' ? '<div class="demo-banner"><span class="demo-dot"></span> Деморежим · вымышленные данные <button data-act="switch-role">Сменить роль</button></div>' : ''}<main id="main-content" data-page="${s.page}" tabindex="-1">${content}</main><nav class="bottom-nav" aria-label="Основная навигация">${nav(s)}</nav><footer class="desktop-footer">Ключи · Всё, что связано с квартирой, тут.<span>MAX × Умный город</span></footer></div></div>`; }
export function pageView(s) { const views = { home: home, apartments: apartments, requests: requests, finances: finances, documents: documents, profile: profile, meters: meters, purchases: purchases, visits: visits, history: history, record: detail, notifications: notifications, recurring: recurring }; return (views[s.page] || home)(s); }
function plannedCard(d,l){const n=plannedNext(d,l);return `<div class="surface payment-highlight" data-tone="green">${pillIcon('calendar','green')}<div><span class="muted">Следующий платёж по расписанию</span><strong data-fit-number>${money(n.amount)}</strong><small>${esc(n.title)} · до ${date(n.due,{year:'numeric'})}</small><small>Начисление появится за ${days(n.advance_days)}</small></div>${button('Расписание','nav','data-page="recurring"','secondary')}</div>`;}
function home(s) {
    const m = model(s), { u, owner, a, l, records, apartments: aa } = m;
    const first = esc(u.name.split(' ')[0]);
    if (!a)
        return heading(`Привет, ${first}!`, 'Начнём с вашей квартиры') + guidePrompt(u) + empty(owner ? 'Добавьте первую квартиру' : 'Ждём приглашение', owner ? 'Три шага — и аренда под контролем.' : 'Собственник присылает каждому жильцу свою ссылку.', button(owner ? icon('plus', 18) + ' Добавить квартиру' : icon('link', 18) + ' У меня есть ссылка', owner ? 'new-apartment' : 'join', '', 'primary wide'), { art: owner ? 'owner' : 'tenant', steps: owner ? ['Добавьте квартиру и условия аренды', 'Отправьте жильцам ссылки-приглашения', 'Платежи, счётчики и заявки — в одном месте'] : ['Попросите ссылку у собственника', 'Откройте её — бот покажет квартиру', 'Нажмите «Принять приглашение»'] });
    if (owner) {
        const need = records.filter(r => (r.kind === 'ticket' && ['open', 'in_progress'].includes(r.status)) || (r.kind === 'purchase' && r.status === 'pending') || (r.kind === 'charge' && r.status === 'claimed') || (r.kind === 'visit' && ['proposed', 'counter'].includes(r.status) && !isOwnerSide(s.data.apartments.find(x => x.id === r.apartment_id), r.payload.proposer)));
        const apartmentsBlock = section('Мои квартиры', `<div class="property-grid">${aa.map(x => apartmentHero(x, { small: true })).join('')}</div>`, arrowButton('Все', 'apartments'));
        // A co-owner (mom) gets a calm home: write this month's utilities, see its state, nothing else.
        if (!aa.some(isMainOwner)) return heading(`Привет, ${first}!`, 'Коммуналка и квартира — в одном месте') + guidePrompt(u) + coOwnerUtilitiesCard(s) + apartmentsBlock;
        const ym = s.data.business_date.slice(0, 7), charges = records.filter(r => r.kind === 'charge' && r.payload.period === ym && !isDraft(r)), paid = charges.reduce((v, r) => v + r.payload.confirmed, 0);
        const tiles = `<div class="quick-grid trio">${actionTile({ title: 'Коммуналка', name: 'drop', tone: 'green', act: 'utilities', attrs: `data-apartment="${esc(a.id)}"` })}${actionTile({ title: 'Забрал наличные', name: 'wallet', tone: 'green', act: 'cash-collect', attrs: 'data-tenant="*"' })}${actionTile({ title: 'Начисление', name: 'plus', tone: 'green', act: 'new-record', attrs: 'data-kind="charge"' })}</div>`;
        return heading(`Привет, ${first}!`, 'Ваши квартиры — под контролем') + guidePrompt(u) + approvalBlock(s) + missingUtilitiesCard(s) + coOwnerUtilitiesCard(s) + `<div class="stats-grid">${statCard({ label: aa.length === 1 ? 'Квартира' : 'Квартиры', value: aa.length, name: 'building', tone: 'blue', act: 'nav', attrs: 'data-page="apartments"' })}${statCard({ label: 'Получено за месяц', value: money(paid), name: 'wallet', tone: 'green', act: 'nav', attrs: 'data-page="finances"' })}${statCard({ label: 'Требуют внимания', value: need.length, name: 'bell', tone: 'neutral', act: 'nav', attrs: 'data-page="requests"' })}</div>` + tiles + cashBlock(s) + apartmentsBlock + section('Требует внимания', need.length ? `<div class="records-list">${need.slice(0, 5).map(r => recordCard(r, s, { compact: true })).join('')}</div>` : empty('Все вопросы решены', 'Новые заявки, оплаты и покупки появятся здесь — мы напомним.', '', { icon: 'check', tone: 'green' }));
    }
    const rr = records.filter(r => l && r.lease_id === l.id), active = rr.filter(r => r.kind === 'ticket' && ['open', 'in_progress', 'resolved'].includes(r.status)), events = rr.filter(r => r.kind === 'visit' && !['cancelled', 'completed'].includes(r.status) && Date.parse(r.payload.end) > Date.now()).sort((a, b) => a.payload.start.localeCompare(b.payload.start)), hasReading = !l?.meters_enabled || !pendingMeters(s.data,l).length;
    // New or changed utilities sit on top until opened; the due panel then lists the rest with a pill each.
    const fresh = freshUtilitiesCard(s), due = myDuePanel(s, { limit: 1, skip: fresh.ids });
    const money0 = due || fresh.html ? due : plannedNext(s.data,l) ? plannedCard(s.data,l) : notice('Все начисленные платежи подтверждены.', 'green', 'check');
    return heading(`Привет, ${first}!`, 'Ваша квартира — всё под контролем') + guidePrompt(u) + fresh.html + (due ? due : '') + apartmentHero(a) + `<div class="quick-grid">${l?.meters_enabled ? actionTile({ title: 'Передать<br>показания', name: 'meter', tone: 'amber', act: 'nav', attrs: 'data-page="meters"' }) : ''}${actionTile({ title: 'Сообщить<br>о проблеме', name: 'tool', tone: 'purple', act: 'new-record', attrs: 'data-kind="ticket"' })}${actionTile({ title: 'Добавить<br>покупку', name: 'bag', tone: 'orange', act: 'new-record', attrs: 'data-kind="purchase"' })}${actionTile({ title: 'Открыть<br>документы', name: 'file', tone: 'slate', act: 'nav', attrs: 'data-page="documents"' })}</div>` + (due ? '' : money0) + section('Ближайшие события', `<div class="surface panel event-list">${events.slice(0, 2).map(r => `<button class="ui-row event-row" data-act="open-record" data-id="${r.id}">${pillIcon('calendar', 'teal')}<span class="event-copy"><b>Визит собственника</b><small>${range(r.payload.start, r.payload.end)}</small>${badge(r.status)}</span>${icon('arrow', 17)}</button>`).join('')}${!hasReading ? `<button class="ui-row event-row" data-act="nav" data-page="meters">${pillIcon('meter', 'amber')}<span class="event-copy"><b>Передать показания</b><small>До ${l.meter_day} числа</small></span>${icon('arrow', 17)}</button>` : ''}${!events.length && hasReading ? '<p class="padded muted">Ближайших дел нет. Можно выдохнуть.</p>' : ''}</div>`, arrowButton('Все', 'visits')) + (active.length ? section('Активные заявки', `<div class="records-list">${active.slice(0, 2).map(r => recordCard(r, s, { compact: true })).join('')}</div>`, arrowButton('Все', 'requests')) : '');
}
// The lease picker reads as a list row: what is let (line 1), people and period (line 2).
// The native select lies over the whole row, so the full row opens the system picker.
function leasePeople(l) { const n = tenantIds(l).length; return n ? count(n, 'жилец', 'жильца', 'жильцов') : 'Жильцов пока нет'; }
function leasePeriod(l) { return l.status === 'ended' ? 'архив · ' + dateRange(l.start, l.end) : 'до ' + date(l.end, { year: 'numeric' }); }
function leaseSelector(d, leases, l) {
    if (!leases.length) return '';
    const room = (d.units || []).find(u => u.id === l?.unit_id)?.kind === 'room', many = leases.length > 1;
    const option = x => `<option value="${x.id}" ${l?.id === x.id ? 'selected' : ''}>${esc(unitTitle(x))} — ${esc(leasePeople(x).toLowerCase())}, ${x.status === 'ended' ? 'архив, ' + dateRange(x.start, x.end) : 'с ' + date(x.start, { year: 'numeric' })}</option>`;
    return `<label class="lease-selector${many ? ' many' : ''}" data-tone="blue">${pillIcon(room ? 'door' : 'key', 'blue')}<span class="lease-copy"><b>${esc(unitTitle(l))}</b><small>${esc(leasePeople(l))} · ${leasePeriod(l)}</small></span>${many ? `<span class="lease-more">${leases.length}${icon('chevron', 18)}</span>` : ''}<select data-change="lease" aria-label="Объект и период аренды">${leases.map(option).join('')}</select></label>`;
}
function apartments(s) {
    const {a,l,owner,apartments:aa,leases,d,u}=model(s);
    if(!a)return heading(owner?'Мои квартиры':'Моя квартира')+empty(owner?'Квартира ещё не добавлена':'Ждём приглашение',owner?'Создайте карточку квартиры, затем пригласите жильцов по ссылкам.':'Откройте ссылку-приглашение от собственника — квартира появится здесь.',button(owner?icon('plus',18)+' Добавить квартиру':icon('link',18)+' У меня есть ссылка',owner?'new-apartment':'join','','primary wide'),{art:owner?'house':'tenant'});
    const picker = aa.length > 1 ? segmented(aa.map(x => [x.id, x.title, 'building']), a.id, { act: 'apartment-select', key: 'id', className: 'property-pills', buttonClass: 'property-pill', label: 'Выбор квартиры', tone: 'blue' }) : '';
    const units=(d.units||[]).filter(x=>x.apartment_id===a.id),active=leases.filter(x=>x.status!=='ended'),wholeOccupied=active.some(x=>units.find(v=>v.id===x.unit_id)?.kind==='whole');
    // Facts read in pairs; long values take the whole row.
    const row=(label,value,wide=false)=>`<div class="contract-row${wide?' wide':''}"><dt>${label}</dt><dd>${value}</dd></div>`;
    const participantNames=l?tenantIds(l).map(id=>nameIn(d,id,{fallback:'Участник'})):[];
    const rent=l?money(l.current_rent??l.rent):'', dueDay=l?(l.current_due_day??l.due_day)+' числа':'';
    const tab=s.aptTab||'overview';let content='';
    if(!l)content=empty('Нет периода аренды','Выберите объект ниже и создайте аренду.');
    else if(tab==='overview') {
        const owners=(a.owners||[]).map(o=>nameIn(d,o.id,{fallback:o.name})).join(', ')||nameIn(d,a.owner_id,{fallback:'Собственник'});
        content=`<div class="surface panel padded lease-card"><dl class="contract-grid">${!owner?row(participantNames.length>1?'Жильцы':'Жилец',participantNames.length?participantNames.map(esc).join(', '):'Пока не присоединились',true)+row((a.owners||[]).length>1?'Собственники':'Собственник',esc(owners),true):''}${row('Срок',dateRange(l.start,l.end),true)}${row('Плата в месяц',rent)}${row('Депозит',money(l.deposit))}${row('Оплата до',dueDay)}${l.meters_enabled?row('Показания до',l.meter_day+' числа'):''}${row('Договорённости',esc(l.current_terms??l.terms)||'Не указаны',true)}</dl><p class="lease-note">Одна аренда — одна общая сумма: количество жильцов её не увеличивает.</p></div>`;
        if(owner&&l.status!=='ended')content+=peopleSection(s,l);
        // The tenant's main action is a button; the owner's lease actions live in the grouped list below.
        if(l.status!=='ended'&&!owner)content+=`<div class="action-row">${button(icon('tool',18)+' Сообщить о проблеме','new-record','data-kind="ticket"','primary')}</div>`;
        if(l.status!=='ended'&&owner&&!tenantIds(l).length&&!d.records.some(r=>r.lease_id===l.id))content+=`<div class="action-row">${button('Отменить пустую аренду','archive-draft','','ghost')}</div>`;
        if(tenantIds(l).length>1)content+=notice('Участники этой аренды видят общие документы, заявки и платежи. Каждый может внести свою часть оплаты; собственник подтверждает каждую оплату отдельно. Жильцы других комнат не видят эту историю.','blue');
    } else if(tab==='contract') {
        content=`<div class="surface panel padded contract-panel"><h2>Условия аренды</h2><dl class="contract-grid">${row('Объект',esc(unitTitle(l)),true)}${row('Начало',date(l.start,{year:'numeric'}))}${row('Окончание',date(l.end,{year:'numeric'}))}${row('Плата за весь объект',rent+' / месяц')}${row('Депозит',money(l.deposit))}${row('День оплаты',dueDay)}${l.rent_effective_month?row(l.rent_effective_month>d.business_date.slice(0,7)?'Согласованная будущая плата':'Последнее изменение платы',l.rent_effective_month>d.business_date.slice(0,7)?money(l.rent)+' с '+monthLabel(l.rent_effective_month):monthLabel(l.rent_effective_month),true):''}</dl><p class="contract-terms">${esc(l.current_terms??l.terms)||'Дополнительные условия не указаны.'}</p></div>`+notice('Карточка условий не заменяет подписанный договор. Изменения согласуются со всеми жильцами; уже выставленные начисления не пересчитываются.')+`<div class="records-list">${d.records.filter(r=>r.lease_id===l.id&&r.kind==='document'&&['contract','agreement','act'].includes(r.payload.category)).map(r=>recordCard(r,s)).join('')}</div>`+(l.status!=='ended'?`<div class="action-row">${button('Загрузить договор','new-record','data-kind="document"')}${owner&&tenantIds(l).length?button('Предложить изменения','new-record','data-kind="terms"','secondary'):''}</div>`:'');
    } else if(tab==='meters') content=metersContent(s);
    else if(tab==='payments') {
        const payments=d.records.filter(r=>r.lease_id===l.id&&r.kind==='charge');
        content=(owner?`<div class="action-row">${button(icon('plus',18)+' Начисление','new-record','data-kind="charge"')}${button('Регулярные платежи','nav','data-page="recurring"','secondary')}</div>`:'')+(payments.length?`<div class="records-list">${payments.map(r=>recordCard(r,s)).join('')}</div>`:empty('Пока без начислений','Начисления появятся заранее по графику. Наличные отмечаются прямо в начислении.','',{icon:'wallet',tone:'green'}));
    }
    else if(tab==='history')content=historyContent(s);
    // Lease pages one tap away, with what is waiting there.
    const links=tab==='overview'&&l?(()=>{const rr=d.records.filter(r=>r.lease_id===l.id),bought=rr.filter(r=>r.kind==='purchase'),pend=bought.filter(r=>r.status==='pending').length,visits=rr.filter(r=>r.kind==='visit'&&!['cancelled','completed'].includes(r.status)).sort((x,y)=>x.payload.start.localeCompare(y.payload.start));
        const row=(attrs,name,tone,title,sub)=>`<button type="button" class="ui-row link-row" data-tone="${tone}" ${attrs}>${pillIcon(name,tone)}<span class="link-copy"><b>${title}</b><small>${sub}</small></span>${icon('arrow',18)}</button>`;
        const item=(page,name,tone,title,sub)=>row(`data-act="lease-page" data-page="${page}" data-id="${l.id}"`,name,tone,title,sub);
        const open=l.status!=='ended'&&owner;
        return `<div class="surface panel property-links">${item('purchases','bag','orange','Покупки для квартиры',pend?count(pend,'покупка ждёт','покупки ждут','покупок ждут')+' решения':bought.length?count(bought.length,'покупка','покупки','покупок'):'Чеки и компенсации')}${item('visits','calendar','teal','Посещения',visits.length?'Ближайшее — '+datetime(visits[0].payload.start):'Визиты по договорённости')}${open&&tenantIds(l).length?row('data-act="new-record" data-kind="terms"','file','blue','Предложить новые условия','Плата, день оплаты, договорённости — с согласия жильцов'):''}${open?row('data-act="new-record" data-kind="ticket"','tool','purple','Сообщить о проблеме','Заявка на ремонт в этой аренде'):''}</div>`;})():'';
    const unitCards=owner&&tab==='overview'?section('Что сдаётся',`<div class="units-grid">${units.map(unit=>{const lease=active.find(x=>x.unit_id===unit.id),canStart=!lease&&(unit.kind==='whole'?!active.length:!wholeOccupied),current=lease&&lease.id===l?.id;return `<div class="surface panel unit-card${current?' current':''}"><div class="split"><h3>${esc(unit.title)}</h3>${unit.kind==='room'?button(icon('edit',16),'edit-unit',`data-id="${unit.id}"`,'ghost'):''}</div><p>${lease?(tenantIds(lease).length?count(tenantIds(lease).length,'жилец','жильца','жильцов'):'Жильцов пока нет')+' · '+money(lease.rent)+' / месяц':canStart?'Нет активной аренды':'Недоступно: квартира сдана '+(unit.kind==='whole'?'по комнатам':'целиком')}</p>${current?`<span class="unit-current">${icon('check',16)} Открыта сейчас</span>`:lease?button('Открыть аренду','lease-select',`data-id="${lease.id}"`,'secondary'):canStart?button('Создать аренду','new-lease',`data-unit="${unit.id}"`,'secondary'):''}</div>`;}).join('')}</div>`+notice('Можно сдавать всю квартиру либо выбранные комнаты независимо. В каждой аренде — любое количество приглашённых жильцов. Целую квартиру и её комнаты одновременно сдать нельзя.'),button(icon('plus',16)+' Комната','new-unit','','secondary')):'';
    const owners=owner&&tab==='overview'?ownersSection(s,a):'';
    const facts=[count(a.rooms,'комната','комнаты','комнат'),number(a.area)+' м²'].join(' · ');
    return heading(owner?'Карточка квартиры':'Моя квартира',facts,owner?`<div class="heading-actions">${button(icon('edit',18)+' Редактировать','edit-apartment',`data-id="${a.id}"`,'secondary')}${button(icon('plus',18)+' Ещё квартира','new-apartment','aria-label="Добавить квартиру"','secondary')}</div>`:'')+picker+apartmentHero(a,{subtitle:a.address,act:'noop',editable:owner})+leaseSelector(d,leases,l)+(l?.status==='ended'?notice('Эта аренда в архиве. Доступна история только вашего периода.','amber'):'')+segmented([['overview','Обзор'],['contract','Договор'],['meters','Счётчики'],['payments','Платежи'],['history','История']].filter(([id])=>id!=='meters'||owner||l?.meters_enabled), tab, { act: 'apt-tab', key: 'tab', className: 'tabs apartment-tabs', label: 'Разделы квартиры', tone: 'blue' })+content+links+unitCards+owners+(owner&&tab==='overview'?(isMainOwner(a)?apartmentDeleteFooter(a):''):'');
}
function requests(s) {
    const { owner } = model(s);
    let items = scoped(s, 'ticket');
    if (s.filter === 'urgent')
        items = items.filter(r => r.payload.priority === 'urgent');
    else if (s.filter && s.filter !== 'all')
        items = items.filter(r => r.status === s.filter);
    return heading('Заявки', 'Проблемы решаются, история остаётся', button(icon('plus', 18) + ' Новая заявка', 'new-record', 'data-kind="ticket"')) + scopeControl(s) + filterBar([['all', 'Все'], ['open', 'Открытые'], ['in_progress', 'В работе'], ['resolved', 'На проверке'], ['closed', 'Решённые'], ['urgent', 'Срочные']], s.filter || 'all') + (items.length ? `<div class="records-list">${items.map(r => recordCard(r, s)).join('')}</div>` : empty('Заявок нет', 'Что-то сломалось? Опишите и приложите фото — собственник увидит сразу.', '', { icon: 'tool', tone: 'purple' })) + notice('Для опасных и аварийных ситуаций используйте экстренные службы. Ключи не является аварийной диспетчерской.', 'amber');
}
function finances(s) { const { owner, records } = model(s), charges = scoped(s, 'charge').filter(r=>r.status!=='cancelled'&&!isDraft(r)).sort((a, b) => a.payload.due.localeCompare(b.payload.due)), paid = charges.reduce((sum, r) => sum + r.payload.confirmed, 0), total = charges.reduce((sum, r) => sum + r.payload.amount, 0), remaining = total - paid, expenses = scoped(s, 'expense'), purchases = scoped(s, 'purchase').filter(r => r.status === 'compensated'), spent = expenses.reduce((sum, r) => sum + r.payload.amount, 0) + purchases.reduce((sum, r) => sum + r.payload.amount, 0), pending = charges.filter(r => r.status !== 'paid'), done = charges.filter(r => r.status === 'paid').reverse(); const ratio = total ? Math.round(paid / total * 100) : 0; return heading(owner ? 'Финансы' : 'Платежи', 'Прозрачный учёт, без путаницы', `<div class="heading-actions">${button('Регулярные','nav','data-page="recurring"','secondary')}${owner?button(icon('plus',18)+' Начисление','new-record','data-kind="charge"'):''}</div>`) + scopeControl(s) + (owner ? utilitiesHistory(s) : myDuePanel(s)) + `<div class="surface finance-summary" data-tone="green"><div><span>Подтверждено за всё время</span><strong data-fit-number>${money(paid)}</strong><p>${owner ? 'Из начисленных ' + money(total) : 'Оплата подтверждена собственником'}</p></div>${pillIcon('wallet', 'green')}</div><div class="surface panel padded"><div class="split"><b>Учёт оплаты</b><span class="badge green">${ratio}%</span></div><progress max="${Math.max(total, 1)}" value="${paid}" aria-label="Подтверждённая оплата"></progress><div class="split"><span class="muted">Осталось подтвердить</span><b>${money(remaining)}</b></div></div>` + notice('Деньги передаются вне приложения — наличными или переводом. «Отдал наличными» отправляет отметку собственнику; платёж становится оплаченным, когда он подтвердит получение.') + section('Ближайшие и неподтверждённые', pending.length ? `<div class="records-list">${pending.map(r => recordCard(r, s, { compact: true })).join('')}</div>` : empty('Всё оплачено', 'Неподтверждённых начислений нет. Следующее появится заранее.', '', { icon: 'check', tone: 'green' })) + (done.length ? section('История платежей', `<div class="records-list">${done.map(r => recordCard(r, s, { compact: true })).join('')}</div>`) : '') + (owner ? section('Расходы и компенсации', `<div class="mini-stats">${statCard({ label: 'Расходы', value: money(spent), name: 'coins', tone: 'green' })}${statCard({ label: 'Доход минус расходы', value: money(paid - spent), name: 'wallet', tone: 'green' })}</div>` + `<div class="records-list">${[...expenses, ...purchases].map(r => recordCard(r, s, { compact: true })).join('') || '<p class="padded muted">Расходов пока нет.</p>'}</div>`, button(icon('plus', 16) + ' Расход', 'new-record', 'data-kind="expense"', 'secondary')) : ''); }
// Utilities by month for owners: the latest month open, earlier ones folded under «Прошлые месяцы».
function utilitiesHistory(s) {
    const { d, apartments: aa } = model(s), list = aa.filter(a => s.scope === 'all' || a.id === s.scope).flatMap(a => utilityGroups(d, a.id).map(g => ({ a, g })));
    if (!list.length) return '';
    const several = aa.length > 1, row = ({ a, g }) => listItem({ className: 'record-card compact', act: 'open-record', attrs: `data-id="${esc(g.records[0].id)}"`, tone: 'green', leading: pillIcon('drop', 'green'), content: `<span class="record-copy"><span class="record-title">Коммуналка за ${esc(monthWord(g.period))}</span><span class="record-sub">${esc([several ? a.title : '', 'до ' + date(g.due)].filter(Boolean).join(' · '))}</span></span>`, trailing: `<span class="record-end"><b data-fit-number>${money(g.total)}</b>${g.draft ? badge('pending', 'Ждёт одобрения') : g.change ? badge('pending', 'Изменение ждёт') : recordBadge(g.records[0], d.business_date)}${icon('arrow', 17)}</span>` });
    const [first, ...rest] = list.sort((x, y) => y.g.period.localeCompare(x.g.period));
    return section('Коммуналка', `<div class="records-list">${row(first)}</div>${rest.length ? `<details class="past-months"><summary>Прошлые месяцы <span class="section-count">${rest.length}</span></summary><div class="records-list">${rest.map(row).join('')}</div></details>` : ''}`, button(icon('plus', 16) + ' Внести', 'utilities', `data-apartment="${esc((aa.find(a => a.id === s.scope) || aa[0]).id)}"`, 'secondary'));
}
function recurring(s) {
    const {d,owner}=model(s),rules=(d.recurring_rules||[]).filter(r=>r.state!=='deleted'&&(s.scope==='all'||d.leases.find(l=>l.id===r.lease_id)?.apartment_id===s.scope));
    return heading('Регулярные платежи','Начисления появляются заранее, срок оплаты — отдельно',owner?button(icon('plus',18)+' Добавить','new-rule'):'')+scopeControl(s)+notice('По умолчанию начисление создаётся за 14 дней. Для каждого правила можно выбрать от 1 до 60 дней. Дата оплаты 29–31 в коротком месяце переносится на последний день. Уже выставленные суммы не меняются.')+(rules.length?`<div class="rules-list">${rules.map(rule=>{const next=editableMonth(d,rule),v=displayedRule(rule,next),l=d.leases.find(x=>x.id===rule.lease_id),a=d.apartments.find(x=>x.id===l?.apartment_id);return `<div class="surface panel rule-card"><div class="split"><div><h2>${esc(v.title)}</h2><p>${esc([a?.title, (d.units||[]).find(x=>x.id===l?.unit_id)?.kind==='room'?unitTitle(l):''].filter(Boolean).join(' · '))}</p></div><span class="badge ${rule.state==='active'?'green':'amber'}">${rule.state==='active'?'Включено':'На паузе'}</span></div><strong class="rule-amount" data-fit-number>${money(v.amount)}<small>в месяц</small></strong><p>До ${v.due_day} числа · появляется за ${days(v.advance_days)}</p><p class="muted">Период: ${monthLabel(rule.start_month)}${rule.end_month?' — '+monthLabel(rule.end_month):''}</p>${v.from_month?`<p class="small-note">Условия выше — с ${monthLabel(v.from_month)}</p>`:''}${owner&&l?.status!=='ended'?`<div class="action-row">${button('Изменить','edit-rule',`data-id="${rule.id}"`,'secondary')}${button(rule.state==='active'?'Пауза':'Возобновить','rule-state',`data-id="${rule.id}" data-value="${rule.state==='active'?'paused':'active'}"`,'secondary')}${button('Удалить правило','rule-state',`data-id="${rule.id}" data-value="deleted"`,'ghost')}</div>`:''}${rule.is_rent?'<p class="small-note">Изменение суммы аренды — через согласование новых условий со всеми жильцами.</p>':''}</div>`;}).join('')}</div>`:empty('Регулярных платежей пока нет','Настройте аренду, интернет или парковку — начисления будут создаваться сами.','',{icon:'calendar',tone:'green'}));
}
function documents(s) { const { owner, d } = model(s); let docs = scoped(s, 'document'); if (s.filter && s.filter !== 'all')
    docs = docs.filter(r => r.payload.category === s.filter); return heading('Документы', 'Договорённости, к которым легко вернуться', button(icon('plus', 18) + ' Добавить', 'new-record', 'data-kind="document"')) + scopeControl(s) + filterBar([['all', 'Все'], ['contract', 'Договоры'], ['receipt', 'Квитанции'], ['act', 'Акты'], ['agreement', 'Соглашения'], ['other', 'Другое']], s.filter || 'all') + `<div class="surface documents-banner" data-tone="slate"><div><h2>Важные документы.<br>В одном месте.</h2><p>Храните договоры, чеки, акты<br>и файлы вашей аренды.</p></div><div class="folder-illustration">${icon('folder', 105)}</div></div>` + (docs.length ? `<div class="records-list">${docs.map(r => { const files = d.files.filter(f => f.record_id === r.id); return listItem({ className: 'document-row', tone: 'slate', act: 'open-record', attrs: `data-id="${r.id}"`, leading: pillIcon('file', kindColor.document), content: `<span><b>${esc(r.title)}</b><small>${files.length ? files.map(f => `${esc(f.name.split('.').at(-1).toUpperCase())} · ${fileSize(f.size)}`).join(' / ') : 'Нет вложений'}</small><small>${date(r.created_at, { year: 'numeric' })}${r.visibility === 'owner' ? ' · Только собственник' : ''}</small></span>`, trailing: icon('arrow', 18) }); }).join('')}</div>` : empty('Документов пока нет', 'Загрузите договор или акт приёма — они останутся в истории аренды.', '', { icon: 'folder', tone: 'slate' })) + notice('Доступ ограничен участниками конкретной аренды. Личные расходы и закрытые документы собственника арендатору не видны.', 'blue', 'shield'); }
function meters(s) { return heading('Счётчики', 'Показания и расход — без поиска по чатам') + metersContent(s); }
function metersContent(s) { return meterSection(s, model(s)); }
function purchases(s) { const { owner } = model(s); let list = scoped(s, 'purchase'); if (s.filter && s.filter !== 'all')
    list = list.filter(r => r.status === s.filter); return heading('Покупки для квартиры', 'Что купили, сколько стоит и кто подтвердил', !owner ? button(icon('plus', 18) + ' Покупка', 'new-record', 'data-kind="purchase"') : '') + scopeControl(s) + filterBar([['all', 'Все'], ['pending', 'На согласовании'], ['approved', 'Одобрены'], ['compensated', 'Компенсированы']], s.filter || 'all') + (list.length ? `<div class="records-list">${list.map(r => recordCard(r, s)).join('')}</div>` : empty('Покупок пока нет', 'Купили что-то для квартиры? Добавьте сумму и чек — собственник согласует.', '', { icon: 'bag', tone: 'orange' })) + notice('Одобрение покупки не означает перевод денег. Компенсация отмечается отдельно и не уменьшает арендную плату автоматически.'); }
function visits(s) { const { owner } = model(s); let list = scoped(s, 'visit').sort((a, b) => a.payload.start.localeCompare(b.payload.start)); if (s.filter === 'upcoming')
    list = list.filter(r => !['cancelled', 'completed'].includes(r.status)); if (s.filter === 'completed')
    list = list.filter(r => ['cancelled', 'completed'].includes(r.status)); return heading('Посещения квартиры', 'Удобное время — по договорённости', owner ? button(icon('plus', 18) + ' Предложить', 'new-record', 'data-kind="visit"') : '') + scopeControl(s) + filterBar([['all', 'Все'], ['upcoming', 'Предстоящие'], ['completed', 'Завершённые']], s.filter || 'all') + (list.length ? `<div class="records-list">${list.map(r => recordCard(r, s)).join('')}</div>` : empty('Посещений пока нет', 'Здесь появятся предложения собственника. Время можно подтвердить или предложить своё.', '', { icon: 'calendar', tone: 'teal' })) + notice('Запрос на посещение не означает согласие. Дождитесь подтверждения другой стороны.'); }
function history(s) { return heading('История квартиры', 'Все важные события — по порядку') + historyContent(s); }
function historyContent(s) { const { l, d } = model(s); const ee = d.events.filter(e => l && e.lease_id === l.id); return ee.length ? `<div class="timeline">${ee.map(e => `<${e.record_id ? 'button' : 'div'} class="timeline-item" ${e.record_id ? `data-act="open-record" data-id="${e.record_id}"` : ''}><span class="timeline-dot"></span><div><small>${datetime(e.created_at)}</small><b>${esc(e.title)}</b><span>${esc(nameIn(d,e.user_id,{fallback:e.author}))}${e.visibility === 'owner' ? ' · Видят только собственники' : ''}</span></div>${e.record_id ? icon('arrow', 16) : ''}</${e.record_id ? 'button' : 'div'}>`).join('')}</div>` : empty('История начинается здесь', 'Платежи, показания и заявки будут появляться тут по порядку.', '', { icon: 'history', tone: 'blue' }); }
export function actionsFor(r, s) {
    const { u, d } = model(s), a = d.apartments.find(a => a.id === r.apartment_id), l = d.leases.find(l => l.id === r.lease_id), owner = canManage(a), items = [];
    // Owners answer proposals as one side, recorded under the main owner's id.
    const voter = owner ? a.owner_id : u.id, sameSide = id => id === u.id || (owner && isOwnerSide(a, id));
    const add = (action, label, style = 'primary') => items.push({ action, label, style });
    if (l?.status === 'ended')
        return items;
    if (r.kind === 'ticket') {
        if (owner && r.status === 'open')
            add('start', 'Взять в работу');
        if (owner && ['open', 'in_progress'].includes(r.status))
            add('resolve', 'Работа выполнена');
        if (!owner && r.status === 'resolved' && (r.created_by === u.id || isOwnerSide(a, r.created_by)))
            add('confirm', 'Подтвердить решение');
        if (!owner && ['resolved', 'closed'].includes(r.status))
            add('reopen', 'Проблема осталась', 'secondary');
        if (r.created_by === u.id && r.status === 'open')
            add('cancel', 'Отменить', 'secondary');
    }
    if (r.kind === 'purchase' && owner) {
        if (r.status === 'pending') {
            add('approve', 'Одобрить покупку');
            add('approve_cash', 'Одобрить и вернул наличными', 'secondary');
            add('reject', 'Отклонить', 'secondary');
        }
        if (r.status === 'approved')
            add('compensate', 'Отметить компенсацию');
    }
    if (r.kind === 'visit') {
        if (['proposed', 'counter'].includes(r.status) && !sameSide(r.payload.proposer) && !(r.payload.accepted_by||[]).includes(voter))
            add('accept', 'Подтвердить время');
        if (['proposed', 'counter', 'accepted'].includes(r.status)) {
            add('counter', 'Предложить другое время', 'secondary');
            add('cancel', 'Отменить', 'ghost');
        }
        if (owner && r.status === 'accepted' && Date.parse(r.payload.start) <= Date.now())
            add('complete', 'Посещение состоялось');
    }
    if(r.kind==='charge') {
        const claims=claimsFor(r.payload),free=freeAmount(r.payload);
        if(!owner&&['pending','partial','claimed'].includes(r.status)&&free>0&&!claims.some(c=>c.user_id===u.id))add('claim','Другая сумма или перевод','secondary');
        if(owner&&!isDraft(r)&&['pending','partial','claimed'].includes(r.status)&&free>0)add('record_payment','Записать полученные наличные','secondary');
    }
    if (r.kind === 'terms' && r.status === 'proposed') {
        if (!owner && !(r.payload.accepted_by||[]).includes(u.id)) {
            add('accept', 'Согласовать условия');
            add('reject', 'Не согласен', 'secondary');
        }
        else if(owner)
            add('cancel', 'Отозвать предложение', 'secondary');
    }
    if (r.kind === 'termination') {
        if (r.status === 'proposed' && !sameSide(r.payload.proposer) && !(r.payload.accepted_by||[]).includes(voter)) {
            add('accept', 'Согласовать завершение');
            add('reject', 'Не согласен', 'secondary');
        }
        if (r.status === 'proposed' && sameSide(r.payload.proposer))
            add('cancel', 'Отозвать запрос', 'secondary');
        if (owner && r.status === 'accepted')
            add('complete', 'Завершить аренду');
    }
    return items;
}
function detail(s) {
    const r = s.data.records.find(r => r.id === s.recordId);
    if (!r)
        return empty('Запись недоступна', 'Обновите данные или вернитесь к списку.', button('На главную', 'nav', 'data-page="home"'));
    const { d } = model(s), a = d.apartments.find(a => a.id === r.apartment_id), l = d.leases.find(l => l.id === r.lease_id), p = r.payload, files = d.files.filter(f => f.record_id === r.id), comments = d.comments.filter(c => c.record_id === r.id), actions = actionsFor(r, s);
    let body = '';
    const info = (label, value) => `<div class="detail-line"><span>${label}</span><b>${value}</b></div>`;
    if (p.description)
        body += `<p class="detail-description">${esc(p.description)}</p>`;
    if (r.kind === 'ticket')
        body += info('Помещение', esc(p.room)) + info('Приоритет', p.priority === 'urgent' ? 'Срочная' : 'Обычная') + (p.result ? notice('<b>Результат работы:</b> ' + esc(p.result), r.status==='closed'?'green':'amber', r.status==='closed'?'check':'info') : '') + (p.reopen_reason ? notice(esc(p.reopen_reason), 'amber') : '');
    if (r.kind === 'purchase')
        body += `<div class="detail-amount" data-fit-number>${money(p.amount)}</div>` + info('Дата покупки', date(p.purchase_date, { year: 'numeric' })) + notice('Компенсация — отдельным переводом. Арендная плата автоматически не уменьшается.') + (p.compensated_at ? info('Компенсация отмечена', datetime(p.compensated_at)) : '');
    if (r.kind === 'visit')
        body += `<div class="visit-time">${pillIcon('calendar', 'teal')}<div><b>${date(p.start, { year: 'numeric' })}</b><strong>${new Date(p.start).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} — ${new Date(p.end).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</strong></div></div><p>${esc(p.reason)}</p>` + notice('Время отображается в часовом поясе вашего устройства: ' + esc(Intl.DateTimeFormat().resolvedOptions().timeZone)) + info('Предложил', esc(nameIn(d, p.proposer, { fallback: 'Участник аренды' })));
    if(r.kind==='charge') {
        if(isUtilities(r)&&!canManage(a))markSeen(d,r);
        body+=chargeDetail(s,r,a,l);
    }
    if (r.kind === 'reading')
        body += `<div class="reading-result">${p.values.map(v => `<div>${pillIcon('meter', 'amber')}<span><b>${esc(v.label)}</b><small>Расход: ${number(v.consumption / 1000)} ${esc(v.unit)}${v.cost != null ? ' · ' + money(v.cost) : ''}</small></span><strong>${number(v.value / 1000)}</strong></div>`).join('')}</div>` + notice('Показания сохранены для собственника. Передачу поставщику услуг нужно выполнить отдельно.');
    if (r.kind === 'expense')
        body += `<div class="detail-amount" data-fit-number>${money(p.amount)}</div>` + info('Дата', date(p.date)) + notice('Расход виден только собственнику.', 'neutral', 'shield');
    if (r.kind === 'terms')
        body += info('Предыдущая плата', money(p.previous_rent)) + info('Предложенная плата', money(p.rent)) + info('Применить с месяца',monthLabel(p.effective_month)) + info('День оплаты',String(p.due_day||l.due_day)+' числа') + `<p class="detail-description">${esc(p.terms)}</p>` + notice('Согласование обновляет карточку и будущие начисления. Уже выставленные платежи не меняются. Подписанное соглашение загрузите отдельно.');
    if (r.kind === 'termination')
        body += info('Предлагаемая дата', date(p.date, { year: 'numeric' })) + `<p>${esc(p.reason)}</p>` + notice('После согласования собственник отдельно завершает аренду. До этого нужно урегулировать начисления и покупки. Возврат депозита фиксируйте в документах; банковский перевод приложение не выполняет.', 'amber');
    if(['visit','terms','termination'].includes(r.kind)&&(p.required_approvals||[]).length) body+=info('Согласование',(p.accepted_by||[]).length+' из '+p.required_approvals.length)+notice(p.required_approvals.filter(id=>!(p.accepted_by||[]).includes(id)).length?'Ожидается ответ: '+p.required_approvals.filter(id=>!(p.accepted_by||[]).includes(id)).map(id=>esc(nameIn(d,id,{fallback:'Участник'}))).join(', '):'Все необходимые участники подтвердили.','blue');
    if(r.kind==='ticket'&&r.status==='resolved')body+=notice('Собственник сообщил о выполнении работы. Заявка закроется только после подтверждения автора заявки (арендатора).','amber');
    if (p.reason && ['purchase', 'terms'].includes(r.kind))
        body += notice(esc(p.reason), 'amber');
    const room = (d.units || []).find(x => x.id === l?.unit_id)?.kind === 'room', primaryShown = { n: 0 };
    return heading(esc(recordTitle(r)), esc([a?.title, room ? unitTitle(l) : ''].filter(Boolean).join(' · '))) + `<div class="detail-top"><span class="eyebrow">${esc(kindNames[r.kind])}</span>${recordBadge(r, d.business_date)}</div><div class="surface panel padded detail-body">${body}${!body ? `<p>${esc(categoryNames[p.category] || 'Документ')}</p>` : ''}<small class="muted detail-created">Создано ${datetime(r.created_at)}${r.updated_at && r.updated_at !== r.created_at ? ' · изменено ' + datetime(r.updated_at) : ''}</small></div>` + (files.length ? section('Вложения', `<div class="surface panel">${files.map(f => listItem({ className: 'attachment', tone: 'slate', act: 'file', attrs: `data-id="${f.id}"`, leading: pillIcon(f.mime.startsWith('image') ? 'camera' : 'file', 'slate'), content: `<span><b>${esc(f.name)}</b><small>${fileSize(f.size)}</small></span>`, trailing: icon('download', 20) })).join('')}</div>`) : '') + (actions.length ? `<div class="action-row detail-actions">${actions.filter(x=>!(r.kind==='charge'&&['confirm','reject','claim'].includes(x.action))).map(x => button(x.label, 'record-action', `data-id="${r.id}" data-action="${x.action}"`, x.style === 'primary' && primaryShown.n++ ? 'secondary' : x.style)).join('')}</div>` : '') + section('Обсуждение', `<div id="discussion" class="comments">${comments.map(c => `<div class="comment ${c.user_id === d.user.id ? 'mine' : ''}"><div><b>${esc(nameIn(d, c.user_id, { fallback: c.author }))}</b><small>${datetime(c.created_at)}</small></div><p>${esc(c.text)}</p></div>`).join('') || '<p class="muted">Пока без комментариев. Уточните детали здесь — они останутся с этой записью.</p>'}</div>${l.status !== 'ended' ? `<form data-form="comment" data-id="${r.id}" class="comment-form"><label class="sr-only" for="comment-text">Комментарий</label><textarea id="comment-text" name="text" placeholder="Написать комментарий…" required maxlength="3000" rows="2"></textarea><button class="icon-button send-button" type="submit" aria-label="Отправить комментарий">${icon('send')}</button><div class="form-error" role="alert"></div></form>` : notice('Архив аренды доступен только для чтения.', 'amber')}`);
}
function profile(s) {
    const { u, owner, a, l, d } = model(s), settings = u.settings;
    const toggle = (key, label, sub) => `<label class="setting-row"><span><b>${label}</b><small>${sub}</small></span><input type="checkbox" name="${key}" ${settings[key] ? 'checked' : ''} role="switch"><span class="switch" aria-hidden="true"></span></label>`;
    return heading('Профиль', 'Ваши данные и настройки') + `<div class="surface profile-hero" data-tone="blue"><span class="avatar large">${esc(u.name[0])}</span><div><h2>${esc(u.name)}</h2><span>${owner ? 'Собственник' : 'Арендатор'}${u.demo ? ' · Демо' : ''}</span></div></div><form data-form="profile" class="form-stack"><div class="surface panel padded"><label class="field"><span>Как к вам обращаться</span><input name="name" value="${esc(u.name)}" maxlength="120" required></label></div><div class="surface panel padded"><label class="field"><span>Тема оформления</span><select name="theme" data-change="theme">${[['auto','Как на устройстве'],['light','Светлая'],['dark','Тёмная']].map(([v,t])=>`<option value="${v}" ${(settings.theme||localStorage.getItem('keys.theme')||'auto')===v?'selected':''}>${t}</option>`).join('')}</select></label></div><div class="surface panel">${toggle('events', 'События аренды', 'Заявки, покупки, документы и согласования')}${toggle('reminders', 'Напоминания', 'Платежи, показания, посещения и окончание аренды')}${toggle('bot', 'Сообщения от бота', 'Уведомления в MAX и Telegram, если бот подключён')}</div>${owner ? `<div class="surface panel padded"><label class="field"><span>Налоговый профиль</span><select name="tax_status">${[['not_set', 'Не указан'], ['individual', 'Физическое лицо'], ['self_employed', 'Самозанятый'], ['entrepreneur', 'Индивидуальный предприниматель']].map(([v, t]) => `<option value="${v}" ${settings.tax_status === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label><small class="muted">Информационное поле. Налоги не рассчитываются, декларации не подаются.</small></div>` : ''}<div class="form-error" role="alert"></div><button class="btn primary" type="submit">Сохранить настройки</button></form><div class="profile-links">${[['switch-role', 'user', 'Переключить роль'], ['export', 'download', 'Экспорт моих данных'], ['help', 'info', 'Помощь'], ['security', 'shield', 'Безопасность'], ['messengers', 'link', 'Мессенджеры: MAX и Telegram'], ['join', 'link', 'Присоединиться к квартире']].map(([act, i, title]) => navigationRow(title, act)).join('')}${a && l?.status !== 'ended' ? `<button class="info-row plain" data-act="new-record" data-kind="termination"><b>Завершение аренды</b>${icon('arrow', 18)}</button>` : ''}</div>${button('Выйти из приложения', 'logout', '', 'secondary wide')}<p class="profile-note">Ключи · версия ${esc(s.config.version || '0.3.4')}<br>${s.config.mode === 'demo' ? 'Демонстрационная версия без реальных платежей.' : esc(s.config.operator)}</p>`;
}
function notifications(s) {
    const nn = s.data.notifications;
    return heading('Уведомления', 'Важное не потеряется', nn.some(n => !n.is_read) ? button('Прочитать все', 'read-notifications', '', 'secondary') : '') + (nn.length ? `<div class="records-list">${nn.map(n => {
        const tone = kindColor[s.data.records.find(r => r.id === n.record_id)?.kind] || 'blue';
        return listItem({ className: `notification-row ${!n.is_read ? 'unread' : ''}`, tone, act: n.record_id ? 'open-record' : 'read-notifications', attrs: n.record_id ? `data-id="${n.record_id}"` : '', leading: pillIcon('bell', tone), content: `<span><b>${esc(n.title)}</b><small>${esc(n.text)}</small><small>${datetime(n.created_at)}</small></span>`, trailing: !n.is_read ? '<i class="notification-dot" aria-label="Не прочитано"></i>' : '' });
    }).join('')}</div>` : empty('Пока ничего нового', 'Уведомления об оплатах, заявках и показаниях появятся здесь и в чате с ботом.', '', { icon: 'bell', tone: 'blue' }));
}
