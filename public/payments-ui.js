// Cash-first payments. The tenant marks a hand-over, the owner confirms receipt.
// A photo of the cash or a receipt is a note for the history, not a proof.
import { esc, icon, button, notice, money, date, datetime, field, textarea, uploadField, today, badge } from './utils.js';
import { claimsFor, freeAmount, tenantIds, canManage, isMainOwner } from './rental-ui.js';
import { nameIn } from './people.js';
import { chargePeople, cashPill, myCash, myShare, otherWayLink, isUtilities, isDraft, mainOwnerName, monthWord, utilitiesTouched, utilityGroups } from './cash-ui.js';
import { remainingBy } from './shares.js';

const how = m => m === 'transfer' ? 'переводом' : 'наличными';
const person = (d, id, fallback) => esc(nameIn(d, id, { fallback }));
const initial = name => esc(String(name || '?').trim()[0] || '?');
const persons = n => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'человека' : 'человек'}`;
const fileLinks = (d, ids = []) => ids.filter(id => d.files.some(f => f.id === id)).map((id, n) => `<button type="button" class="text-link file-chip" data-act="file" data-id="${esc(id)}">${icon('camera', 15)} Фото${ids.length > 1 ? ' ' + (n + 1) : ''}</button>`).join('');

// Progress of a whole bill (owners) or of one share (a tenant sees only their own part).
function progress({ amount, confirmed, waiting }) {
    const pct = amount ? Math.min(100, Math.round(confirmed / amount * 100)) : 0;
    const waitPct = amount ? Math.min(100 - pct, Math.round(waiting / amount * 100)) : 0;
    return `<div class="pay-progress" role="img" aria-label="Подтверждено ${pct}%"><span class="pay-done" data-w="${pct}"></span><span class="pay-wait" data-w="${waitPct}"></span></div>
        <div class="pay-legend"><span><i class="dot done"></i>Получено ${money(confirmed)}</span>${waiting ? `<span><i class="dot wait"></i>Ждёт подтверждения ${money(waiting)}</span>` : ''}<span><i class="dot rest"></i>Осталось ${money(Math.max(0, amount - confirmed - waiting))}</span></div>`;
}
const statusBadge = { paid: ['paid', 'Оплачено'], waiting: ['claimed', 'Ждёт подтверждения'], owes: ['open', 'Должен'] };
// «Кто сколько»: one row per tenant of this bill, the viewer first. Room tenants only ever see
// their own room's people; the apartment total and headcount come from the bill itself.
function sharePanel(s, r, view, manage, open) {
    const d = s.data;
    if (!view.rows.length) return '';
    const draft = isDraft(r);
    const row = x => {
        const me = x.id === d.user.id, who = nameIn(d, x.id, { fallback: 'Бывший жилец' }), [st, label] = statusBadge[x.status];
        const give = manage && open && x.left > 0 && freeAmount(r.payload) > 0;
        // A hand-over waiting for the owner reads «На проверке» in amber; once confirmed it is «Отдал» again.
        const checking = x.waiting > 0 && x.status !== 'paid';
        const tag = draft ? '<span class="badge neutral">Черновик</span>' : badge(st, me && x.status === 'owes' ? 'Должны' : label);
        const middle = checking ? `<div class="checking"><dt>На проверке</dt><dd>${money(x.waiting)}</dd></div>` : `<div><dt>${me ? 'Отдали' : 'Отдал'}</dt><dd>${money(x.paid)}</dd></div>`;
        return `<div class="share-row${me ? ' mine' : ''}"><span class="person-avatar">${initial(me ? d.user.name : who)}</span><div class="share-top"><b class="share-name">${esc(who)}</b>${tag}</div><dl class="share-figures"><div><dt>Доля</dt><dd>${money(x.share)}</dd></div>${middle}<div><dt>Осталось</dt><dd>${money(x.owed)}</dd></div></dl>${give ? `<div class="share-act">${button(icon('check', 17) + ' Получил ' + money(Math.min(x.left, freeAmount(r.payload))), 'cash-receive', `data-id="${esc(r.id)}" data-person="${esc(x.id)}"`, 'secondary small')}</div>` : ''}</div>`;
    };
    const p = r.payload, total = isUtilities(r) && p.group_total ? `всего ${money(p.group_total)} на ${persons(p.people_total || view.rows.length)}` : view.rows.length > 1 ? 'поровну на ' + persons(view.rows.length) : '';
    return `<section class="share-panel" aria-label="Кто сколько"><div class="share-head"><h3>Кто сколько</h3>${total ? `<small>${esc(total)}</small>` : ''}</div><div class="share-rows">${view.rows.map(row).join('')}</div></section>`;
}
// Utilities for managers: drafts wait for the main owner, edits of a sent month may too.
function utilitiesControls(s, r, a, open) {
    const d = s.data, p = r.payload, g = utilityGroups(d, r.apartment_id).find(x => x.id === p.group_id);
    if (!g || !open) return '';
    const main = isMainOwner(a), boss = mainOwnerName(d, a), id = esc(g.id), out = [];
    if (g.draft) {
        out.push(notice(main ? ((p.author || r.created_by) === d.user.id ? 'Черновик: жильцы его не видят. Проверьте сумму и отправьте.' : `Внесла ${esc(nameIn(d, p.author || r.created_by, { fallback: 'совладелец' }))}. Жильцы не видят, пока вы не отправите.`) : `Ждёт отправки: ${esc(boss)} проверит и отправит жильцам.`, 'amber', 'info'));
        out.push(`<div class="action-row utilities-actions">${main ? button('Отправить жильцам', 'utilities-decide', `data-group="${id}" data-decision="approve"`, 'primary') : ''}${button(icon('edit', 17) + ' Изменить', 'utilities-edit', `data-group="${id}"`, 'secondary')}${main ? button('Отклонить', 'utilities-decide', `data-group="${id}" data-decision="decline"`, 'ghost danger') : (p.author || r.created_by) === d.user.id ? button('Удалить черновик', 'utilities-cancel', `data-group="${id}"`, 'ghost danger') : ''}</div>`);
        return out.join('');
    }
    if (g.change) {
        out.push(`<div class="notice amber change-note" data-tone="amber">${icon('info', 20)}<span><b>Было ${money(g.total)} → станет ${money(g.change.amount ?? g.total)}</b>${g.change.due && g.change.due !== g.due ? `<br>Срок: ${date(g.due)} → ${date(g.change.due)}` : ''}<br>${esc(nameIn(d, g.change.by, { fallback: 'Совладелец' }))} ${main ? 'предлагает изменить.' : `предложил изменение, ждёт одобрения: ${esc(boss)}.`}</span></div>`);
        if (main) out.push(`<div class="action-row utilities-actions">${button('Одобрить', 'utilities-decide', `data-group="${id}" data-decision="approve"`, 'primary')}${button('Отклонить', 'utilities-decide', `data-group="${id}" data-decision="decline"`, 'secondary')}</div>`);
        return out.join('');
    }
    // Cancelling a month tenants already see is the main owner's call.
    return `<div class="action-row utilities-actions">${button(icon('edit', 17) + (main ? ' Изменить сумму' : ' Предложить другую сумму'), 'utilities-edit', `data-group="${id}"`, 'secondary')}${main && !utilitiesTouched(d, g.id) ? button('Отменить', 'utilities-cancel', `data-group="${id}"`, 'ghost danger') : ''}</div>`;
}

export function chargeDetail(s, r, a, l) {
    const d = s.data, p = r.payload, claims = claimsFor(p), owner = canManage(a), open = l.status !== 'ended', view = chargePeople(d, r), live = open && !isDraft(r) && ['pending', 'partial', 'claimed'].includes(r.status);
    // A tenant sees their own share as the headline; the whole bill is the context line.
    const mine = !owner ? myShare(d, r) : null, part = mine && !mine.alone;
    let html = part
        ? `<div class="detail-amount" data-fit-number>${money(mine.share)}</div><p class="detail-due">Ваша доля из ${money(p.amount)} · до ${date(p.due)}</p>` + progress({ amount: mine.share, confirmed: Math.min(mine.paid, mine.share), waiting: mine.waiting })
        : `<div class="detail-amount" data-fit-number>${money(p.amount)}</div><p class="detail-due">Оплатить до ${date(p.due)}</p>` + progress({ amount: p.amount, confirmed: p.confirmed, waiting: claimsFor(p).reduce((n, c) => n + c.amount, 0) });
    if (p.cancel_reason) html += notice(esc(p.cancel_reason), 'amber');
    if (owner && isUtilities(r)) html += utilitiesControls(s, r, a, open);
    if (!owner && view.joinedLater) html += notice('Счёт выставлен до вашего заезда — вашей доли в нём нет.', 'blue');
    html += sharePanel(s, r, view, owner, live);
    if (!owner && live) { const cash = myCash(d, r); if (cash) html += `<div class="detail-pay">${cashPill(d, r, cash)}${cash.state === 'open' ? otherWayLink(r) : ''}</div>`; }
    html += claims.map(c => `<div class="surface claim-card" data-tone="amber"><div class="claim-head"><span class="claim-icon">${icon(c.method === 'cash' ? 'wallet' : 'send', 20)}</span><span><b>${person(d, c.user_id, 'Жилец')}${c.for_user_id && c.for_user_id !== c.user_id ? ' за ' + person(d, c.for_user_id, 'жильца') : ''} — ${how(c.method || 'transfer')}</b><small>${c.paid_on ? 'Передано ' + date(c.paid_on, { year: 'numeric' }) : 'Отмечено ' + datetime(c.at)}</small></span><strong data-fit-number>${money(c.amount)}</strong></div>${c.note ? `<p>${esc(c.note)}</p>` : ''}<div class="claim-foot"><span class="badge amber">Ждёт подтверждения</span>${fileLinks(d, c.files)}</div>${owner && open ? `<div class="action-row">${button(icon('check', 18) + ' Получил', 'record-action', `data-id="${r.id}" data-action="confirm" data-claim-id="${c.id}"`)}${button('Не получил', 'record-action', `data-id="${r.id}" data-action="reject" data-claim-id="${c.id}"`, 'secondary')}</div>` : ''}</div>`).join('');
    if (p.rejection && !claims.length && r.status !== 'paid') html += notice('Собственник не подтвердил оплату: ' + esc(p.rejection) + (owner ? '' : '. Уточните и отметьте оплату ещё раз.'), 'amber');
    const log = [...(p.payments || []).map(x => ({ ...x, kind: 'paid', when: x.confirmed_at })), ...(p.disputes || []).map(x => ({ ...x, kind: 'dispute', when: x.disputed_at }))].sort((x, y) => String(y.when).localeCompare(String(x.when)));
    if (log.length) html += `<div class="payment-log"><h3>История оплаты</h3>${log.map(x => x.kind === 'paid'
        ? `<div class="pay-entry ok">${icon('check', 18)}<span><b>${money(x.amount)} ${how(x.method || 'transfer')}</b><small>${x.user_id ? person(d, x.user_id, 'Жилец') + (x.for_user_id && x.for_user_id !== x.user_id ? ' за ' + person(d, x.for_user_id, 'жильца') : '') : 'Записал собственник'}${x.source === 'owner_collection' ? ' · забрал наличные' : ''}${x.paid_on ? ' · передано ' + date(x.paid_on) : ''} · получение подтверждено ${datetime(x.confirmed_at)}${x.confirmed_by ? ' · ' + person(d, x.confirmed_by, 'собственник') : ''}</small>${x.note ? `<small>${esc(x.note)}</small>` : ''}<span class="pay-files">${fileLinks(d, x.files)}</span></span></div>`
        : `<div class="pay-entry dispute">${icon('info', 18)}<span><b>${money(x.amount)} ${how(x.method || 'transfer')} — не подтверждено</b><small>${person(d, x.user_id, 'Жилец')} · ${datetime(x.disputed_at)}${x.by ? ' · проверка: ' + person(d, x.by, 'собственник') : ''}</small><small>Причина: ${esc(x.reason)}</small></span></div>`).join('')}</div>`;
    html += notice(owner ? 'Отметка жильца и фото не меняют статус сами. «Оплачено» появляется, когда вы или другой собственник нажмёте «Получил».' : 'Деньги передаются вне приложения. Фото купюр или расписки помогает вспомнить детали, но не доказывает оплату — статус «Оплачено» ставит собственник, когда подтвердит получение.', 'neutral', 'shield');
    return html;
}

// Form fields for the payment actions (inside the shared record-action form).
export function paymentFields(r, action, state, claimId = '', preset = {}) {
    const d = state.data, p = r.payload, free = freeAmount(p), l = d.leases.find(x => x.id === r.lease_id), members = tenantIds(l);
    const rub = v => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v / 100);
    if (action === 'claim' || action === 'record_payment') {
        const tenant = action === 'claim', ids = members.filter(id => !(d.apartments.find(x => x.id === r.apartment_id)?.owners || []).some(o => o.id === id));
        // Who paid: the only tenant is chosen by default; the amount follows that person's remainder.
        const payer = preset.payer || (ids.length === 1 ? ids[0] : ''), left = id => Math.min(remainingBy(p, id, members), free);
        const amount = tenant ? (Math.min(remainingBy(p, d.user.id, members), free) || free) : payer ? (left(payer) || free) : free;
        return `<div class="method-switch" role="radiogroup" aria-label="Как оплачено"><label><input type="radio" name="method" value="cash" checked><span>${icon('wallet', 18)} Наличными</span></label><label><input type="radio" name="method" value="transfer"><span>${icon('send', 18)} Переводом</span></label></div>`
            + `<div class="form-grid">${field(tenant ? 'Сколько передали, ₽' : 'Сколько получили, ₽', 'amount', 'text', rub(amount), 'required inputmode="decimal" autocomplete="off"')}${field('Когда', 'paid_on', 'date', today(), 'required')}</div>`
            + (tenant ? '' : `<label class="field"><span>От кого</span><select name="payer_id" data-payer-select><option value="" data-left="${rub(free)}">Не указывать</option>${ids.map(id => `<option value="${esc(id)}" data-left="${rub(left(id) || free)}" ${id === payer ? 'selected' : ''}>${esc(nameIn(d, id, { fallback: 'Жилец' }))}</option>`).join('')}</select></label>`)
            + textarea(tenant ? 'Комментарий (кому, где передали)' : 'Комментарий', 'note')
            + uploadField('Фото купюр, расписки или чека — по желанию', true)
            + notice(tenant ? 'Собственник увидит отметку и подтвердит получение. До этого платёж «Ждёт подтверждения». Фото — для истории, не доказательство.' : 'Запишите, только если деньги уже у вас. Платёж сразу станет подтверждённым.', 'neutral', 'info');
    }
    if (action === 'confirm') {
        const c = claimsFor(p).find(x => x.id === claimId) || claimsFor(p)[0];
        return notice(c ? `Подтвердите, что получили ${money(c.amount)} ${how(c.method || 'transfer')}${c.paid_on ? ' (' + date(c.paid_on) + ')' : ''}. После этого платёж станет оплаченным на эту сумму.` : 'Оплата уже обработана.', 'green', 'check');
    }
    if (action === 'reject') return textarea('Что не так', 'note', '', true) + '<p class="small-note">Например: «получил 25 000, а не 30 000» или «денег не было». Жилец увидит причину и сможет отметить оплату заново.</p>';
    return '';
}
