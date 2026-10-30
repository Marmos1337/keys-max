// People of a lease and the owner's invite links. One link admits one person,
// so two tenants means two links; each row shows where that link stands.
import { esc, icon, button, notice, date, days } from './utils.js';
import { tenantIds } from './rental-ui.js';
import { nameIn } from './people.js';

// Statuses of a link (ссылка): said the same way in rows, chips and sheets.
export const inviteStatusText = { pending: 'Не открыта', opened: 'Открыта', accepted: 'Принята', expired: 'Истекла', revoked: 'Отозвана' };
const statusTone = { pending: 'amber', opened: 'blue', accepted: 'green', expired: 'neutral', revoked: 'neutral' };
const chip = (status, text) => `<span class="badge ${statusTone[status] === 'green' ? 'green' : statusTone[status] === 'amber' ? 'amber' : statusTone[status] === 'blue' ? 'blue' : 'neutral'}">${esc(text || inviteStatusText[status])}</span>`;
const initial = name => esc(String(name || '?').trim()[0] || '?');

export function leaseInvites(d, l) { return (d.invites || []).filter(i => i.lease_id === l.id); }

function inviteRow(i) {
    const title = i.label ? esc(i.label) : 'Ссылка-приглашение';
    const sub = i.status === 'accepted' ? `${esc(i.accepted_name || 'Жилец')} · ${date(i.accepted_at || i.created_at)}`
        : i.status === 'pending' ? `Действует до ${date(i.expires)}`
        : i.status === 'opened' ? `Открыта в боте ${date(i.opened_at)}, ещё не подтверждена`
        : i.status === 'expired' ? 'Срок вышел — создайте новую ссылку' : 'Ссылка больше не работает';
    return `<button type="button" class="ui-row person-row invite-row" data-act="invite-manage" data-id="${esc(i.id)}" data-status="${i.status}"><span class="person-avatar invite-avatar" data-status="${i.status}">${icon(i.status === 'accepted' ? 'check' : 'link', 18)}</span><span class="person-copy"><b>${title}</b><small>${sub}</small></span>${chip(i.status)}${icon('arrow', 16)}</button>`;
}

// Owner: members first, then open links, then the main action.
export function peopleSection(s, l) {
    const d = s.data, ids = tenantIds(l), members = d.members || [];
    const people = ids.map(id => {
        const who = nameIn(d, id, { fallback: 'Жилец' }), joined = members.find(m => m.lease_id === l.id && m.user_id === id)?.joined_at;
        return `<div class="ui-row person-row"><span class="person-avatar">${initial(id === d.user.id ? d.user.name : who)}</span><span class="person-copy"><b>${esc(who)}</b><small>${joined ? 'В аренде с ' + date(joined, { year: 'numeric' }) : 'Участник аренды'}</small></span></div>`;
    }).join('');
    const invites = leaseInvites(d, l).filter(i => i.status !== 'accepted');
    const rows = people + invites.map(inviteRow).join('');
    const canInvite = l.status === 'active';
    const body = rows ? `<div class="surface panel people-list">${rows}</div>`
        : `<div class="surface people-empty"><span class="people-empty-art" aria-hidden="true">${icon('invite', 30)}</span><b>Пока никого</b><p>Отправьте каждому жильцу свою ссылку. Двое жильцов — две ссылки. Человек откроет её в Telegram или MAX и подтвердит одной кнопкой.</p></div>`;
    const action = canInvite ? button(icon('invite', 19) + (ids.length || invites.length ? ' Пригласить ещё' : ' Пригласить жильца'), 'invite', '', ids.length || invites.length ? 'secondary wide' : 'primary wide') : '';
    return `<section class="section people-section"><div class="section-heading"><h2>Жильцы${ids.length ? ` <span class="section-count">${ids.length}</span>` : ''}</h2></div>${body}${action}</section>`;
}

export function inviteCreateForm(l, unitTitle) {
    return `<form class="form-stack" data-form="invite-create" data-lease="${esc(l.id)}">
        <div class="invite-steps">${step(1, 'Создайте ссылку', 'Для каждого жильца — своя.')}${step(2, 'Отправьте её жильцу', 'В Telegram, MAX или любом чате.')}${step(3, 'Жилец подтверждает', 'Бот покажет квартиру, он нажмёт «Принять».')}</div>
        <label class="field"><span>Для кого (необязательно)</span><input name="label" type="text" maxlength="60" autocomplete="off" placeholder="Например, Маша"></label>
        <p class="small-note">Имя видите только вы — чтобы различать ссылки. Объект: ${esc(unitTitle)}.</p>
        <div class="form-error" role="alert"></div>
        <button type="submit" class="btn primary wide">${icon('link', 18)} Создать ссылку</button></form>`;
}
const step = (n, title, text) => `<div class="invite-step"><span class="invite-step-n">${n}</span><span><b>${title}</b><small>${text}</small></span></div>`;

export function inviteResult(invite, { inHost, platformLabel, renewed = false, kind = 'tenant' } = {}) {
    const owner = kind === 'owner';
    const otherKey = invite.platform === 'telegram' ? 'max' : 'telegram', other = invite.links?.[otherKey], otherName = otherKey === 'max' ? 'MAX' : 'Telegram';
    return `<div class="form-stack invite-result" data-invite-result>
        <div class="invite-success" aria-hidden="true"><span class="success-ring">${icon('check', 30)}</span></div>
        <p class="invite-lead">${renewed ? 'Новая ссылка готова' : 'Ссылка готова'}${invite.label ? ` · «${esc(invite.label)}»` : ''}<br><span class="muted">${renewed ? 'Старая больше не работает. ' : ''}Одна ссылка — ${owner ? 'для одного совладельца' : 'для одного жильца'}, действует ${days(invite.days || 7)}.</span></p>
        <div class="code-box invite-url" data-invite-url>${esc(invite.url)}</div>
        <div class="action-row stacked">${button(icon('send', 18) + (inHost ? ` Отправить в ${esc(platformLabel)}` : ' Поделиться'), 'share-invite', '', 'primary wide')}${button(icon('copy', 18) + ' Скопировать ссылку', 'copy-code', '', 'secondary wide')}</div>
        ${other ? `<details class="invite-other"><summary>${owner ? 'Человек пользуется' : 'Жилец пользуется'} ${otherName}?</summary><p class="small-note">Отправьте ему эту ссылку — она ведёт в бота Ключей в ${otherName}. Сработает только одна из двух: первая принятая.</p><div class="code-box invite-url">${esc(other)}</div>${button(icon('copy', 18) + ' Скопировать ссылку для ' + otherName, 'copy-other-link', '', 'ghost wide')}</details>` : ''}
        ${notice(owner ? 'Человек откроет ссылку → бот покажет квартиру → он нажмёт «Стать совладельцем». Вы получите уведомление, а в «Совладельцах» появится его имя.' : 'Жилец откроет ссылку → бот покажет квартиру → он нажмёт «Принять приглашение». Вы получите уведомление, а в разделе «Жильцы» появится его имя.', 'blue', 'info')}
        ${owner ? '' : button(icon('invite', 18) + ' Пригласить ещё одного жильца', 'invite', '', 'ghost wide')}
    </div>`;
}

export function inviteManage(i) {
    const lines = [['Статус', inviteStatusText[i.status]], ['Создана', date(i.created_at, { year: 'numeric' })]];
    if (['pending', 'opened'].includes(i.status)) lines.push(['Действует до', date(i.expires, { year: 'numeric' })]);
    if (i.opened_at) lines.push(['Открыта в боте', date(i.opened_at)]);
    if (i.status === 'accepted') lines.push(['Кто принял', esc(i.accepted_name || 'Жилец')]);
    const active = ['pending', 'opened'].includes(i.status);
    return `<div class="form-stack"><dl class="contract-grid">${lines.map(([k, v]) => `<div class="contract-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
        ${i.status === 'opened' ? notice('Жилец открыл ссылку, но ещё не нажал «Принять приглашение». Напомните ему — кнопка в чате с ботом Ключей.', 'blue') : ''}
        ${i.status === 'expired' ? notice('Ссылка истекла. Создайте новую — имя «' + esc(i.label || 'без имени') + '» сохранится.', 'amber') : ''}
        <div class="action-row stacked">${active && i.shareable ? button(icon('send', 18) + ' Отправить эту ссылку ещё раз', 'invite-share-again', `data-id="${esc(i.id)}"`, 'primary wide') : ''}
        ${i.status !== 'accepted' ? button(icon('link', 18) + ' Новая ссылка вместо этой', 'invite-renew', `data-id="${esc(i.id)}"`, active && i.shareable ? 'secondary wide' : 'primary wide') : ''}
        ${active ? button('Отозвать ссылку', 'invite-revoke', `data-id="${esc(i.id)}"`, 'ghost danger wide') : ''}</div></div>`;
}

// Tenant: a link opened inside the Mini App.
export function invitePreview(p, code) {
    return `<form class="form-stack invite-preview" data-form="invite-accept" data-code="${esc(code)}">
        <div class="invite-card"><span class="person-avatar large">${initial(p.owner)}</span><div><small>${esc(p.owner)} приглашает вас</small><b>${esc(p.apartment)}</b><span>${esc(p.unit)}</span></div></div>
        ${notice('После подтверждения здесь будут платежи, показания счётчиков, заявки и документы этой квартиры. Плата за объект общая, если жильцов несколько.', 'blue')}
        <div class="form-error" role="alert"></div>
        <button type="submit" class="btn primary wide">${icon('check', 18)} Принять приглашение</button></form>`;
}
export function inviteProblem(p) {
    return `<div class="form-stack">${notice(esc(p.message), p.reason === 'member' ? 'green' : 'amber', p.reason === 'member' ? 'check' : 'info')}${p.reason === 'member' && p.lease_id ? button('Открыть квартиру', 'lease-select', `data-id="${esc(p.lease_id)}"`, 'primary wide') : button('Понятно', 'close-modal', '', 'secondary wide')}</div>`;
}
// Outside a messenger: send the person to the bot of their messenger.
export function inviteOutside(code, config, prefix = 'join_') {
    const tg = config.telegram?.enabled && config.telegram.bot_url, max = config.max?.enabled && config.max_bot_url;
    const withStart = url => { try { const u = new URL(url); u.searchParams.set('start', prefix + code); return u.href; } catch { return ''; } };
    const links = [tg && ['Открыть в Telegram', withStart(tg), 'telegram'], max && ['Открыть в MAX', withStart(max), 'max']].filter(x => x && x[1]);
    return `<div class="form-stack"><p>Приглашение открывается в боте Ключей — там вы увидите квартиру и подтвердите присоединение. Выберите свой мессенджер:</p><div class="action-row stacked">${links.map(([label, href, name], n) => `<a class="btn ${n ? 'secondary' : 'primary'} wide" href="${esc(href)}" rel="noopener" data-platform-link="${name}">${label}</a>`).join('')}</div><p class="small-note">Нет мессенджера на этом устройстве? Откройте ссылку на телефоне.</p></div>`;
}
export function joinedWelcome(s, l) {
    const d = s.data, a = d.apartments.find(x => x.id === l.apartment_id), owners = (a?.owners || []).map(o => nameIn(d, o.id, { fallback: o.name })).join(', ') || nameIn(d, a?.owner_id, { fallback: '' });
    return `<div class="form-stack joined-welcome"><div class="invite-success" aria-hidden="true"><span class="success-ring">${icon('check', 30)}</span></div>
        <p class="invite-lead">Вы в аренде «${esc(a?.title || 'Квартира')}».${owners ? `<br><span class="muted">${(a?.owners || []).length > 1 ? 'Собственники' : 'Собственник'} — ${esc(owners)}</span>` : ''}</p>
        <div class="joined-grid">${tile('wallet', 'Платежи', 'Начисления и отметки об оплате', 'finances')}${l.meters_enabled ? tile('meter', 'Счётчики', 'Показания раз в месяц, с фото', 'meters') : ''}${tile('tool', 'Заявки', 'Что-то сломалось — напишите', 'requests')}</div>
        ${button('Начать', 'close-modal', '', 'primary wide')}</div>`;
}
const tile = (name, title, text, page) => `<button type="button" class="joined-tile" data-act="nav" data-page="${page}">${icon(name, 22)}<b>${title}</b><small>${text}</small></button>`;
