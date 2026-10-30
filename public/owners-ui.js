// «Совладельцы»: people who run the apartment together. The main owner invites and
// removes co-owners by personal links; a co-owner has the same rights and can leave.
import { esc, icon, button, notice, date } from './utils.js';
import { isMainOwner } from './rental-ui.js';
import { inviteStatusText } from './invites-ui.js';
import { nameIn } from './people.js';

const initial = name => esc(String(name || '?').trim()[0] || '?');
const chip = (cls, text) => `<span class="badge ${cls}">${esc(text)}</span>`;
const statusCls = { pending: 'amber', opened: 'blue', accepted: 'green', expired: 'neutral', revoked: 'neutral' };

// «Собственники · N»: the main owner and co-owners, each counted once. The role is said
// in the row's second line; chips are kept for link statuses only.
export function ownersSection(s, a) {
    const d = s.data, me = d.user.id, main = isMainOwner(a), list = a.owners || [];
    const owners = list.map(o => {
        const manage = main && o.role === 'co_owner', who = nameIn(d, o.id, { fallback: o.name }), tag = manage ? `button type="button" data-act="co-owner-manage" data-id="${esc(o.id)}"` : 'div';
        return `<${tag} class="ui-row person-row owner-row${manage ? ' invite-row' : ''}"><span class="person-avatar">${initial(o.id === me ? o.name : who)}</span><span class="person-copy"><b>${esc(who)}</b><small>${o.role === 'owner' ? 'Главный владелец' : 'Совладелец · с ' + date(o.since, { year: 'numeric' })}</small></span>${manage ? icon('arrow', 16) : ''}</${manage ? 'button' : 'div'}>`;
    }).join('');
    const links = main ? (d.owner_invites || []).filter(i => i.apartment_id === a.id && i.status !== 'accepted').map(i => `<button type="button" class="ui-row person-row invite-row" data-act="owner-invite-manage" data-id="${esc(i.id)}" data-status="${i.status}"><span class="person-avatar invite-avatar" data-status="${i.status}">${icon('link', 18)}</span><span class="person-copy"><b>${i.label ? esc(i.label) : 'Ссылка для совладельца'}</b><small>${i.status === 'pending' ? 'Действует до ' + date(i.expires) : i.status === 'opened' ? 'Открыта в боте, ещё не подтверждена' : i.status === 'expired' ? 'Срок вышел — сделайте новую' : 'Ссылка больше не работает'}</small></span>${chip(statusCls[i.status], inviteStatusText[i.status])}${icon('arrow', 16)}</button>`).join('') : '';
    const action = main ? button(icon('invite', 19) + ' Пригласить совладельца', 'owner-invite', `data-id="${esc(a.id)}"`, list.length > 1 || links ? 'secondary wide' : 'primary wide')
        : button(icon('logout', 18) + ' Выйти из совладельцев', 'apartment-leave', `data-id="${esc(a.id)}"`, 'ghost danger wide');
    const hint = main && list.length < 2 && !links ? `<p class="owners-hint">Ведёте квартиру вместе с кем-то из семьи? Совладелец видит и меняет всё по этой квартире, а уведомления приходят вам обоим.</p>` : '';
    return `<section class="section owners-section"><div class="section-heading"><h2>Собственники <span class="section-count">${list.length}</span></h2></div><div class="surface panel people-list">${owners}${links}</div>${hint}${action}</section>`;
}

const step = (n, title, text) => `<div class="invite-step"><span class="invite-step-n">${n}</span><span><b>${title}</b><small>${text}</small></span></div>`;
export function ownerInviteForm(a) {
    return `<form class="form-stack" data-form="owner-invite-create" data-apartment="${esc(a.id)}">
        <div class="invite-steps">${step(1, 'Создайте ссылку', 'Одна ссылка — для одного человека.')}${step(2, 'Отправьте её', 'Например, маме в Telegram или MAX.')}${step(3, 'Человек подтверждает', 'Бот покажет квартиру, он нажмёт «Стать совладельцем».')}</div>
        <label class="field"><span>Кого приглашаете (необязательно)</span><input name="label" type="text" maxlength="60" autocomplete="off" placeholder="Например, Мама"></label>
        ${notice(`Совладелец «${esc(a.title)}» видит и меняет всё по этой квартире: аренду и условия, жильцов и приглашения, счётчики, платежи, заявки и документы. Уведомления приходят и ему. Удалить квартиру и убрать совладельца можете только вы.`, 'blue', 'shield')}
        <div class="form-error" role="alert"></div>
        <button type="submit" class="btn primary wide">${icon('link', 18)} Создать ссылку</button></form>`;
}

export function ownerInviteManage(i) {
    const active = ['pending', 'opened'].includes(i.status);
    const rows = [['Статус', inviteStatusText[i.status]], ['Создана', date(i.created_at, { year: 'numeric' })], ...(active ? [['Действует до', date(i.expires, { year: 'numeric' })]] : []), ...(i.opened_at ? [['Открыта в боте', date(i.opened_at)]] : [])];
    return `<div class="form-stack"><dl class="contract-grid">${rows.map(([k, v]) => `<div class="contract-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
        ${i.status === 'opened' ? notice('Человек открыл ссылку, но ещё не нажал «Стать совладельцем». Напомните — кнопка в чате с ботом Ключей.', 'blue') : ''}
        <div class="action-row stacked">${active && i.shareable ? button(icon('send', 18) + ' Отправить эту ссылку ещё раз', 'owner-invite-share-again', `data-id="${esc(i.id)}"`, 'primary wide') : ''}
        ${button(icon('link', 18) + ' Новая ссылка вместо этой', 'owner-invite-renew', `data-id="${esc(i.id)}"`, active && i.shareable ? 'secondary wide' : 'primary wide')}
        ${active ? button('Отозвать ссылку', 'owner-invite-revoke', `data-id="${esc(i.id)}"`, 'ghost danger wide') : ''}</div></div>`;
}

export function coOwnerManage(a, o) {
    return `<form class="form-stack" data-form="co-owner-remove" data-apartment="${esc(a.id)}" data-user="${esc(o.id)}"><div class="invite-card"><span class="person-avatar large">${initial(o.name)}</span><div><small>Совладелец с ${date(o.since, { year: 'numeric' })}</small><b>${esc(o.name)}</b><span>Видит и ведёт «${esc(a.title)}» вместе с вами</span></div></div>
        ${notice('Если убрать совладельца, он сразу перестанет видеть квартиру и получать уведомления. История его действий останется в журнале. Вернуть можно новой ссылкой.', 'amber')}
        <div class="form-error" role="alert"></div><button type="submit" class="btn danger wide">Убрать из совладельцев</button></form>`;
}

export function leaveForm(a) {
    return `<form class="form-stack" data-form="apartment-leave" data-apartment="${esc(a.id)}">${notice(`Вы перестанете видеть «${esc(a.title)}» и получать уведомления. Ваши действия останутся в журнале квартиры. Вернуться можно по новой ссылке от главного владельца.`, 'amber')}<div class="form-error" role="alert"></div><button type="submit" class="btn danger wide">Выйти из совладельцев</button></form>`;
}

// A co-owner link opened inside the Mini App.
export function ownerInvitePreview(p, code) {
    return `<form class="form-stack invite-preview" data-form="owner-invite-accept" data-code="${esc(code)}">
        <div class="invite-card"><span class="person-avatar large">${initial(p.inviter)}</span><div><small>${esc(p.inviter)} приглашает вести квартиру вместе</small><b>${esc(p.apartment)}</b><span>Собственники: ${esc((p.owners || []).join(', '))}</span></div></div>
        ${notice('Совладелец видит и меняет всё по этой квартире: аренду, жильцов, счётчики, платежи и заявки. Уведомления будут приходить и вам. Принимайте, только если знаете отправителя.', 'blue', 'shield')}
        <div class="form-error" role="alert"></div>
        <button type="submit" class="btn primary wide">${icon('check', 18)} Стать совладельцем</button></form>`;
}
export function ownerInviteProblem(p) {
    return `<div class="form-stack">${notice(esc(p.message), p.reason === 'member' ? 'green' : 'amber', p.reason === 'member' ? 'check' : 'info')}${p.reason === 'member' && p.apartment_id ? button('Открыть квартиру', 'apartment-open', `data-id="${esc(p.apartment_id)}"`, 'primary wide') : button('Понятно', 'close-modal', '', 'secondary wide')}</div>`;
}
export function coOwnerWelcome(a) {
    return `<div class="form-stack joined-welcome"><div class="invite-success" aria-hidden="true"><span class="success-ring">${icon('check', 30)}</span></div>
        <p class="invite-lead">Вы совладелец «${esc(a.title)}».<br><span class="muted">Собственники: ${esc((a.owners || []).map(o => o.name).join(', '))}</span></p>
        <div class="joined-grid"><button type="button" class="joined-tile" data-act="close-modal">${icon('building', 22)}<b>Квартира</b><small>Аренда, жильцы, счётчики</small></button><button type="button" class="joined-tile" data-act="nav" data-page="finances">${icon('wallet', 22)}<b>Финансы</b><small>Начисления и подтверждение оплат</small></button><button type="button" class="joined-tile" data-act="nav" data-page="requests">${icon('tool', 22)}<b>Заявки</b><small>Ремонт и обращения жильцов</small></button></div>
        ${button('Начать', 'close-modal', '', 'primary wide')}</div>`;
}
