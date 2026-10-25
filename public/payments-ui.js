// Cash-first payments. The tenant marks a hand-over, the owner confirms receipt.
// A photo of the cash or a receipt is a note for the history, not a proof.
import { esc, icon, button, notice, money, date, datetime, field, textarea, uploadField, today } from './utils.js';
import { claimsFor, freeAmount, tenantIds, canManage } from './rental-ui.js';

const how = m => m === 'transfer' ? 'переводом' : 'наличными';
const person = (d, id, fallback) => esc(d.people.find(x => x.id === id)?.name || fallback);
const fileLinks = (d, ids = []) => ids.filter(id => d.files.some(f => f.id === id)).map((id, n) => `<button type="button" class="text-link file-chip" data-act="file" data-id="${esc(id)}">${icon('camera', 15)} Фото${ids.length > 1 ? ' ' + (n + 1) : ''}</button>`).join('');

function progress(p) {
    const pct = p.amount ? Math.min(100, Math.round(p.confirmed / p.amount * 100)) : 0, waiting = claimsFor(p).reduce((n, c) => n + c.amount, 0);
    const waitPct = p.amount ? Math.min(100 - pct, Math.round(waiting / p.amount * 100)) : 0;
    return `<div class="pay-progress" role="img" aria-label="Подтверждено ${pct}%"><span class="pay-done" data-w="${pct}"></span><span class="pay-wait" data-w="${waitPct}"></span></div>
        <div class="pay-legend"><span><i class="dot done"></i>Получено ${money(p.confirmed)}</span>${waiting ? `<span><i class="dot wait"></i>Ждёт подтверждения ${money(waiting)}</span>` : ''}<span><i class="dot rest"></i>Осталось ${money(Math.max(0, p.amount - p.confirmed - waiting))}</span></div>`;
}

export function chargeDetail(s, r, a, l) {
    const d = s.data, p = r.payload, claims = claimsFor(p), owner = canManage(a), open = l.status !== 'ended';
    let html = `<div class="detail-amount" data-fit-number>${money(p.amount)}</div><p class="detail-due">Оплатить до ${date(p.due, { year: 'numeric' })}</p>` + progress(p);
    if (p.cancel_reason) html += notice(esc(p.cancel_reason), 'amber');
    if (tenantIds(l).length > 1) html += notice('Сумма общая на всех жильцов этой аренды. Отмечайте ту часть, которую передали вы.', 'blue');
    html += claims.map(c => `<div class="surface claim-card" data-tone="amber"><div class="claim-head"><span class="claim-icon">${icon(c.method === 'cash' ? 'wallet' : 'send', 20)}</span><span><b>${person(d, c.user_id, 'Жилец')} — ${how(c.method || 'transfer')}</b><small>${c.paid_on ? 'Передано ' + date(c.paid_on, { year: 'numeric' }) : 'Отмечено ' + datetime(c.at)}</small></span><strong data-fit-number>${money(c.amount)}</strong></div>${c.note ? `<p>${esc(c.note)}</p>` : ''}<div class="claim-foot"><span class="badge amber">Ждёт подтверждения</span>${fileLinks(d, c.files)}</div>${owner && open ? `<div class="action-row">${button(icon('check', 18) + ' Получил', 'record-action', `data-id="${r.id}" data-action="confirm" data-claim-id="${c.id}"`)}${button('Не получил', 'record-action', `data-id="${r.id}" data-action="reject" data-claim-id="${c.id}"`, 'secondary')}</div>` : ''}</div>`).join('');
    if (p.rejection && !claims.length && r.status !== 'paid') html += notice('Собственник не подтвердил оплату: ' + esc(p.rejection) + (owner ? '' : '. Уточните и отметьте оплату ещё раз.'), 'amber');
    const log = [...(p.payments || []).map(x => ({ ...x, kind: 'paid', when: x.confirmed_at })), ...(p.disputes || []).map(x => ({ ...x, kind: 'dispute', when: x.disputed_at }))].sort((x, y) => String(y.when).localeCompare(String(x.when)));
    if (log.length) html += `<div class="payment-log"><h3>История оплаты</h3>${log.map(x => x.kind === 'paid'
        ? `<div class="pay-entry ok">${icon('check', 18)}<span><b>${money(x.amount)} ${how(x.method || 'transfer')}</b><small>${x.user_id ? person(d, x.user_id, 'Жилец') : 'Записал собственник'}${x.paid_on ? ' · передано ' + date(x.paid_on) : ''} · получение подтверждено ${datetime(x.confirmed_at)}${x.confirmed_by ? ' · ' + person(d, x.confirmed_by, 'собственник') : ''}</small>${x.note ? `<small>${esc(x.note)}</small>` : ''}<span class="pay-files">${fileLinks(d, x.files)}</span></span></div>`
        : `<div class="pay-entry dispute">${icon('info', 18)}<span><b>${money(x.amount)} ${how(x.method || 'transfer')} — не подтверждено</b><small>${person(d, x.user_id, 'Жилец')} · ${datetime(x.disputed_at)}${x.by ? ' · не подтвердил(а) ' + person(d, x.by, 'собственник') : ''}</small><small>Причина: ${esc(x.reason)}</small></span></div>`).join('')}</div>`;
    html += notice(owner ? 'Отметка жильца и фото не меняют статус сами. «Оплачено» появляется, когда вы или другой собственник нажмёте «Получил».' : 'Деньги передаются вне приложения. Фото купюр или расписки помогает вспомнить детали, но не доказывает оплату — статус «Оплачено» ставит собственник, когда подтвердит получение.', 'neutral', 'shield');
    return html;
}

// Form fields for the payment actions (inside the shared record-action form).
export function paymentFields(r, action, state, claimId = '') {
    const d = state.data, p = r.payload, free = freeAmount(p), l = d.leases.find(x => x.id === r.lease_id);
    if (action === 'claim' || action === 'record_payment') {
        const tenant = action === 'claim';
        return `<div class="method-switch" role="radiogroup" aria-label="Как оплачено"><label><input type="radio" name="method" value="cash" checked><span>${icon('wallet', 18)} Наличными</span></label><label><input type="radio" name="method" value="transfer"><span>${icon('send', 18)} Переводом</span></label></div>`
            + `<div class="form-grid">${field(tenant ? 'Сколько передали, ₽' : 'Сколько получили, ₽', 'amount', 'text', String(free / 100), 'required inputmode="decimal"')}${field('Когда', 'paid_on', 'date', today(), 'required')}</div>`
            + (tenant ? '' : `<label class="field"><span>От кого</span><select name="payer_id"><option value="">Не указывать</option>${(l?.tenant_ids || []).map(id => `<option value="${esc(id)}">${esc(d.people.find(x => x.id === id)?.name || 'Жилец')}</option>`).join('')}</select></label>`)
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
