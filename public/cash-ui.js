// Cash first (0.7): who owes what inside a charge, the tenant's one-tap «Отдал наличными»,
// the owner's «Наличные у жильцов» with bulk «Забрал», and the utilities sheet.
// Money maths comes from shares.js (the same code the server runs); this file only presents it.
import { recordTitle, esc, icon, button, notice, money, date, count, field, today, pillIcon } from './utils.js';
import { OPEN_CHARGE, sharesOf, paidBy, waitingBy, owedBy, remainingBy, claimsOf, debtOf, allocate, equalSplit } from './shares.js';
import { tenantIds, canManage, isMainOwner, freeAmount, monthLabel, dueForMonth } from './rental-ui.js';
import { nameIn } from './people.js';

const credited = c => c?.for_user_id ?? c?.user_id ?? null;
const initial = name => esc(String(name || '?').trim()[0] || '?');
const avatarOf = (d, id) => initial(id === d.user.id ? d.user.name : nameIn(d, id, { fallback: 'Жилец' }));
export const isUtilities = r => r?.kind === 'charge' && r.payload?.category === 'utilities';
// Utilities entered by a co-owner (or saved as a draft) wait for the main owner before tenants see them.
export const isDraft = r => isUtilities(r) && r.payload?.approval === 'pending';
export const mainOwnerName = (d, a) => { const o = (a?.owners || []).find(x => x.role === 'owner'); return o ? nameIn(d, o.id, { fallback: 'собственника', self: 'вас' }) : 'собственника'; };
const leaseOf = (d, r) => d.leases.find(l => l.id === r.lease_id);
const running = l => l && l.status !== 'ended';
const isOpen = r => r.kind === 'charge' && OPEN_CHARGE.includes(r.status);
const addMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number), x = new Date(Date.UTC(y, m - 1 + n, 1)); return x.toISOString().slice(0, 7); };
export const bills = n => count(n, 'счёт', 'счёта', 'счетов');
const tenantsWord = n => count(n, 'жилец', 'жильца', 'жильцов');
const persons = n => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'человека' : 'человек'}`;
const rubles = v => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v / 100);
// Utilities titles carry the year («Коммуналка за октябрь 2026»); the card says the month in words.
export const monthWord = ym => new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: 'UTC' }).format(new Date(ym + '-01T12:00:00Z'));

/** Per-person picture of one charge. Rows follow the share snapshot order (who was in the lease
 * when the bill was made); legacy bills fall back to an equal split among today's tenants. */
export function chargePeople(d, r) {
    const l = leaseOf(d, r), members = tenantIds(l), p = r.payload, shares = sharesOf(p, members);
    const ids = Object.keys(shares);
    const rows = ids.map(id => {
        const share = shares[id] || 0, paid = paidBy(p, id, members), waiting = waitingBy(p, id), owed = owedBy(p, id, members), left = remainingBy(p, id, members);
        const status = owed <= 0 ? 'paid' : waiting >= owed ? 'waiting' : 'owes';
        return { id, share, paid, waiting, owed, left, status, claims: claimsOf(p).filter(c => credited(c) === id) };
    });
    const me = d.user.id, mine = rows.find(x => x.id === me);
    return { l, members, rows: mine ? [mine, ...rows.filter(x => x !== mine)] : rows, mine, joinedLater: !mine && tenantIds(l).includes(me) && !!p.shares };
}
// The tenant's own state on a charge: a hand-over mark waiting for the owner, or what is left to give.
export function myCash(d, r) {
    if (!isOpen(r) || !running(leaseOf(d, r))) return null;
    const me = d.user.id, l = leaseOf(d, r), members = tenantIds(l), p = r.payload;
    if (!members.includes(me)) return null;
    const claim = claimsOf(p).find(c => c.user_id === me && credited(c) === me);
    if (claim) return { state: 'claimed', claim, amount: claim.amount };
    const shares = sharesOf(p, members);
    if (p.shares && !(me in shares)) return null; // joined after the bill: not my share
    const left = Math.min(remainingBy(p, me, members), freeAmount(p));
    return left > 0 ? { state: 'open', amount: left } : null;
}

/** The tenant's part of one bill: their share, what is confirmed, what waits. Null when the bill
 * is not theirs to pay (joined later, owner-only, not a member). */
export function myShare(d, r) {
    const l = leaseOf(d, r), members = tenantIds(l), me = d.user.id, p = r.payload;
    if (r.kind !== 'charge' || !members.includes(me)) return null;
    const shares = sharesOf(p, members);
    if (!(me in shares)) return null;
    return { share: shares[me], paid: paidBy(p, me, members), waiting: waitingBy(p, me), owed: owedBy(p, me, members), total: p.amount, alone: Object.keys(shares).length < 2 };
}
/** «ждём Степана»: the main owner's name in the accusative for short one-line toasts. */
export function waitFor(d, a) {
    const o = (a?.owners || []).find(x => x.role === 'owner'), name = o ? nameIn(d, o.id, { fallback: '' }) : '';
    if (!name || /[@·]/.test(name) || /\s/.test(name.trim())) return 'ждём подтверждения';
    const acc = /[бвгджзклмнпрстфхцчшщ]$/i.test(name) ? name + 'а' : /а$/.test(name) ? name.slice(0, -1) + 'у' : /я$/.test(name) ? name.slice(0, -1) + 'ю' : name;
    return 'ждём ' + acc;
}
/** «Отдал наличными 1 500 ₽» ⇄ «Отмечено · Отменить»: both faces live in one grid cell, so the
 * pill is as big as its larger face in both states and only the inside cross-fades. */
// `quiet` is the secondary look for every bill but the oldest: one ink action per screen.
export function cashPill(d, r, cash = myCash(d, r), { quiet = false } = {}) {
    if (!cash) return '';
    const open = cash.state === 'open', hide = 'tabindex="-1" aria-hidden="true" inert';
    return `<div class="cash-pill${quiet ? ' quiet' : ''}" data-state="${cash.state}" data-pill="${esc(r.id)}">
        <button type="button" class="cash-face cash-give" data-act="cash-claim" data-id="${esc(r.id)}" data-version="${r.version}" data-key="claim-${esc(r.id)}-v${r.version}" aria-label="Отдал наличными ${esc(money(cash.amount))}" ${open ? '' : hide}>${quiet ? '' : icon('wallet', 19)}<span>${quiet ? 'Отдал' : 'Отдал наличными'} <b data-pill-amount>${money(cash.amount)}</b></span></button>
        <button type="button" class="cash-face cash-done" data-act="cash-withdraw" data-id="${esc(r.id)}" data-version="${r.version}" data-claim-id="${esc(cash.claim?.id || '')}" data-key="withdraw-${esc(cash.claim?.id || r.id)}-v${r.version}" aria-label="Отмечено, что отдали ${esc(money(cash.amount))}. Отменить отметку" ${open ? hide : ''}>${icon('check', 19)}<span>Отмечено</span><span class="cash-undo">Отменить</span></button>
    </div>`;
}
export const otherWayLink = r => `<button type="button" class="text-link cash-other" data-act="record-action" data-id="${esc(r.id)}" data-action="claim">Другая сумма или перевод</button>`;

// Open charges where this tenant still has something to give or a mark waiting, oldest first.
export function myOpenCharges(d) {
    const me = d.user.id;
    return d.records.filter(r => r.kind === 'charge' && r.visibility !== 'owner' && tenantIds(leaseOf(d, r)).includes(me))
        .map(r => ({ r, cash: myCash(d, r) })).filter(x => x.cash)
        .sort((a, b) => String(a.r.payload.due).localeCompare(String(b.r.payload.due)) || String(a.r.created_at).localeCompare(String(b.r.created_at)));
}

/** Tenant: «К оплате сейчас: моя доля» with a pill per bill. `limit` keeps home short. */
export function myDuePanel(s, { limit = 0, skip = [] } = {}) {
    const d = s.data, all = myOpenCharges(d).filter(x => !skip.includes(x.r.id));
    if (!all.length) return '';
    const open = all.filter(x => x.cash.state === 'open'), left = open.reduce((n, x) => n + x.cash.amount, 0);
    const waiting = all.filter(x => x.cash.state === 'claimed').reduce((n, x) => n + x.cash.amount, 0);
    const late = open.some(x => x.r.payload.due < d.business_date), tone = late ? 'red' : 'green';
    // One counting rule for the header and «ещё N»: every bill in this list, open or marked.
    const shown = limit ? all.slice(0, limit) : all, more = all.length - shown.length, ink = open[0]?.r.id;
    const head = left ? (late ? 'Есть просроченные: моя доля' : 'К оплате сейчас: моя доля') : 'Отмечено, ждёт подтверждения';
    const sub = left ? [bills(all.length), waiting ? money(waiting) + ' ждёт подтверждения' : ''].filter(Boolean).join(' · ') : 'Собственник подтвердит, когда получит';
    const row = ({ r, cash }) => `<div class="my-due-row${r.id === ink ? '' : ' quiet'}"><button type="button" class="my-due-title" data-act="open-record" data-id="${esc(r.id)}"><b>${esc(recordTitle(r))}</b><small>${r.payload.due < d.business_date && cash.state === 'open' ? 'Срок был' : 'До'} ${date(r.payload.due)}</small></button><div class="my-due-actions">${cashPill(d, r, cash, { quiet: r.id !== ink })}${cash.state === 'open' && r.id === ink ? otherWayLink(r) : ''}</div></div>`;
    return `<section class="surface my-due" data-tone="${tone}" aria-label="Моя доля к оплате"><div class="my-due-head">${pillIcon('wallet', tone)}<div><span class="muted">${head}</span><strong data-fit-number>${money(left || waiting)}</strong><small>${esc(sub)}</small></div></div><div class="my-due-list">${shown.map(row).join('')}</div>${more ? `<button type="button" class="text-link my-due-more" data-act="nav" data-page="finances">Ещё ${bills(more)} · все платежи${icon('arrow', 16)}</button>` : ''}</section>`;
}

/* «New utilities» card for tenants: shown until the tenant opens the bill or taps «Понятно».
 * Seen state is per device (localStorage), keyed by user and record, remembering the share it
 * showed: a later change of the amount brings the card back with «сумма изменена». */
const seenKey = d => 'keys.seen.' + d.user.id;
function seenMap(d) { try { return JSON.parse(localStorage.getItem(seenKey(d)) || '{}') || {}; } catch { return {}; } }
export function markSeen(d, r) {
    if (!isUtilities(r)) return;
    const share = sharesOf(r.payload, tenantIds(leaseOf(d, r)))[d.user.id];
    if (share === undefined) return;
    try { const m = seenMap(d); m[r.id] = share; localStorage.setItem(seenKey(d), JSON.stringify(m)); } catch { /* private mode: the card simply shows again */ }
}
export function freshUtilities(d) {
    const me = d.user.id, seen = seenMap(d), since = Date.now() - 45 * 86400000;
    return d.records.filter(r => isUtilities(r) && r.status !== 'cancelled' && Date.parse(r.updated_at || r.created_at) > since && tenantIds(leaseOf(d, r)).includes(me))
        .map(r => ({ r, share: sharesOf(r.payload, tenantIds(leaseOf(d, r)))[me], cash: myCash(d, r) }))
        .filter(x => x.share !== undefined && x.cash && seen[x.r.id] !== x.share)
        .map(x => ({ ...x, changed: seen[x.r.id] !== undefined }))
        .sort((a, b) => String(b.r.payload.period).localeCompare(String(a.r.payload.period)));
}
export function freshUtilitiesCard(s) {
    const d = s.data, list = freshUtilities(d);
    if (!list.length) return { html: '', ids: [] };
    const { r, share, changed, cash } = list[0], p = r.payload;
    const html = `<section class="surface fresh-card" data-tone="green" data-fresh="${esc(r.id)}" aria-label="Новая коммуналка"><div class="fresh-head">${pillIcon('drop', 'green')}<div><span class="fresh-title">Коммуналка за ${esc(monthWord(p.period))} — ваша доля <b>${money(share)}</b></span><small>${p.group_total ? `всего ${money(p.group_total)} на ${persons(p.people_total || 1)} · ` : ''}до ${date(p.due)}${list.length > 1 ? ' · ещё ' + bills(list.length - 1) : ''}</small>${changed ? '<span class="badge amber">Сумма изменена</span>' : ''}</div><button type="button" class="icon-button fresh-ok" data-act="fresh-ok" data-id="${esc(r.id)}" aria-label="Понятно, скрыть">${icon('close', 20)}</button></div><div class="fresh-actions">${cashPill(d, r, cash)}</div></section>`;
    return { html, ids: [r.id] };
}

/* Owner side ----------------------------------------------------------------------------- */
const managers = a => new Set((a.owners || []).map(o => o.id).concat(a.owner_id ? [a.owner_id] : []));
const runningLeases = (d, a) => d.leases.filter(l => l.apartment_id === a.id && ['active', 'ending'].includes(l.status)).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)) || String(x.id).localeCompare(String(y.id)));
/** Tenants who split utilities, in the server's order (lease creation, then joining). */
export function utilityTenants(d, a) {
    const own = managers(a), seen = new Set();
    return runningLeases(d, a).flatMap(l => tenantIds(l).filter(id => !own.has(id) && !seen.has(id) && seen.add(id)));
}
/** Each tenant's open cash debt in one apartment, exactly as the server counts it for expected_owed. */
export function apartmentDebts(d, a) {
    const own = managers(a), leases = d.leases.filter(l => l.apartment_id === a.id && l.status !== 'ended');
    const ids = [...new Set(leases.flatMap(l => tenantIds(l)))].filter(id => !own.has(id));
    return ids.map(id => {
        const charges = d.records.filter(r => r.apartment_id === a.id && r.kind === 'charge' && r.visibility === 'shared' && OPEN_CHARGE.includes(r.status))
            .map(r => ({ r, l: leases.find(l => l.id === r.lease_id) })).filter(x => x.l && tenantIds(x.l).includes(id))
            .map(({ r, l }) => ({ ...r, members: tenantIds(l) }));
        const debt = debtOf(charges, id), waiting = charges.reduce((n, r) => n + waitingBy(r.payload, id), 0);
        const items = debt.items.map(x => { const r = charges.find(c => c.id === x.id); return { ...x, title: r ? recordTitle(r) : 'Счёт' }; });
        return { a, id, total: debt.total, items, waiting };
    }).filter(x => x.total > 0);
}
export function ownerDebts(d) { return d.apartments.filter(canManage).map(a => ({ a, rows: apartmentDebts(d, a), tenants: utilityTenants(d, a).length || d.leases.some(l => l.apartment_id === a.id && l.status !== 'ended' && tenantIds(l).length) })); }

/** «Наличные у жильцов» on the owner's home. */
export function cashBlock(s) {
    const d = s.data, groups = ownerDebts(d).filter(g => g.tenants);
    if (!groups.length) return '';
    const several = groups.length > 1, rows = groups.flatMap(g => g.rows);
    if (!rows.length) return `<section class="section cash-section"><div class="section-heading"><h2>Наличные у жильцов</h2></div><div class="surface cash-empty">${pillIcon('check', 'green')}<span><b>Всё собрано</b><small>Никто из жильцов ничего не должен.</small></span></div></section>`;
    const row = x => `<div class="ui-row cash-row"><span class="person-avatar">${avatarOf(d, x.id)}</span><span class="cash-copy"><b>${esc(nameIn(d, x.id, { fallback: 'Жилец' }))}</b><strong class="cash-amount">${money(x.total)}</strong><small>${bills(x.items.length)}${x.waiting ? ' · отметил ' + money(x.waiting) : ''}</small></span>${button('Забрал', 'cash-collect', `data-apartment="${esc(x.a.id)}" data-tenant="${esc(x.id)}" aria-label="Забрал наличные у ${esc(nameIn(d, x.id))}"`, 'secondary small')}</div>`;
    const body = groups.filter(g => g.rows.length).map(g => `${several ? `<h3 class="cash-apartment">${esc(g.a.title)}</h3>` : ''}<div class="surface panel cash-list">${g.rows.map(row).join('')}${g.rows.length > 1 ? `<div class="cash-foot"><span>Всего ${money(g.rows.reduce((n, x) => n + x.total, 0))}</span>${button(icon('wallet', 18) + ' Забрал у всех', 'cash-collect', `data-apartment="${esc(g.a.id)}" data-tenant="*"`, 'primary small')}</div>` : ''}</div>`).join('');
    return `<section class="section cash-section"><div class="section-heading"><h2>Наличные у жильцов</h2></div>${body}</section>`;
}

/** Collection sheet: one entry per tenant, editable amount, live oldest-first split. */
export function collectionContext(d, apartmentId, tenant) {
    const a = d.apartments.find(x => x.id === apartmentId);
    if (!a || !canManage(a)) throw Error('Квартира недоступна. Обновите экран.');
    const rows = apartmentDebts(d, a).filter(x => tenant === '*' || x.id === tenant);
    return { apartmentId: a.id, title: a.title, entries: rows.map(x => ({ id: x.id, name: nameIn(d, x.id, { fallback: 'Жилец' }), owed: x.total, items: x.items })) };
}
// Amounts are shown as they will be read: «43 215», «1 490,50».
export function groupDigits(raw) {
    const clean = String(raw).replace(/[^\d.,]/g, '').replace('.', ','), [int, ...rest] = clean.split(',');
    const grouped = int.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
    return rest.length ? grouped + ',' + rest.join('').slice(0, 2) : grouped;
}
const allocRows = (e, amount) => {
    const { lines } = allocate(e.items, amount);
    return e.items.map(x => { const got = lines.find(l => l.id === x.id)?.amount || 0; return `<li class="${got ? '' : 'muted-line'}" data-item="${esc(x.id)}"><span><b>${esc(x.title)}</b><small>до ${date(x.due)} · долг ${money(x.cap)}</small></span><strong data-alloc>${got ? money(got) : '—'}</strong></li>`; }).join('');
};
export function collectionSheet(ctx) {
    if (!ctx.entries.length) return `<div class="form-stack">${notice('Долгов по наличным уже нет — всё собрано.', 'green', 'check')}${button('Закрыть', 'close-modal', '', 'secondary wide')}</div>`;
    const total = ctx.entries.reduce((n, e) => n + e.owed, 0);
    // The error sits right under its field in a slot that is always reserved, so nothing moves.
    const entry = e => `<fieldset class="cash-entry" data-tenant="${esc(e.id)}"><legend class="sr-only">${esc(e.name)}</legend><div class="cash-entry-head"><span class="person-avatar">${initial(e.name)}</span><span><b>${esc(e.name)}</b><small>Долг ${money(e.owed)} · ${bills(e.items.length)}</small></span></div><label class="field money-field"><span>Получено, ₽</span><input name="amount_${esc(e.id)}" type="text" inputmode="decimal" autocomplete="off" value="${groupDigits(rubles(e.owed))}" data-collect-amount="${esc(e.id)}" data-money-input aria-describedby="err-${esc(e.id)}"></label><p class="entry-error" id="err-${esc(e.id)}" aria-live="polite"></p><ol class="alloc-list" aria-label="Куда пойдут деньги">${allocRows(e, e.owed)}</ol></fieldset>`;
    return `<form class="form-stack cash-sheet" data-form="cash-collect" data-apartment="${esc(ctx.apartmentId)}"><p class="small-note">${ctx.entries.length > 1 ? `${tenantsWord(ctx.entries.length)} · всего ${money(total)}. ` : ''}Сначала закрываются самые старые счета. Отметки «Отдал наличными» засчитаются.</p><div class="cash-entries">${ctx.entries.map(entry).join('')}</div><div class="sheet-dock">${field('Когда получили', 'paid_on', 'date', today(), 'required')}<div class="form-error" role="alert"></div><button type="submit" class="btn primary wide" data-collect-submit>Записать ${money(total)}</button></div></form>`;
}
/** Live update after typing an amount; returns the entries ready to send, or null when invalid. */
export function updateCollection(form, ctx, parse) {
    let total = 0, ok = true;
    const entries = ctx.entries.map(e => {
        const input = form.querySelector(`[data-collect-amount="${CSS.escape(e.id)}"]`), err = form.querySelector(`#err-${CSS.escape(e.id)}`);
        let amount = 0, msg = '';
        const raw = input.value.trim();
        if (raw) { try { amount = parse(raw); } catch (x) { msg = x.message; } }
        if (!msg && amount > e.owed) msg = `Больше долга: максимум ${money(e.owed)}.`;
        if (msg) ok = false;
        err.textContent = msg; input.setAttribute('aria-invalid', msg ? 'true' : 'false'); input.closest('.field')?.classList.toggle('invalid', !!msg);
        const lines = allocate(e.items, msg ? 0 : amount).lines;
        form.querySelectorAll(`[data-tenant="${CSS.escape(e.id)}"] [data-item]`).forEach(li => { const got = lines.find(l => l.id === li.dataset.item)?.amount || 0; li.classList.toggle('muted-line', !got); li.querySelector('[data-alloc]').textContent = got ? money(got) : '—'; });
        if (!msg) total += amount;
        return { tenant_id: e.id, amount: msg ? 0 : amount, expected_owed: e.owed };
    });
    const btn = form.querySelector('[data-collect-submit]');
    btn.textContent = !ok ? 'Проверьте суммы' : total ? `Записать ${money(total)}` : 'Укажите сумму';
    btn.disabled = !ok || !total;
    return ok && total ? entries.filter(e => e.amount > 0) : null;
}

/* Utilities ------------------------------------------------------------------------------- */
export function utilityGroups(d, apartmentId) {
    const map = new Map();
    for (const r of d.records.filter(r => isUtilities(r) && r.apartment_id === apartmentId && r.status !== 'cancelled')) {
        const g = map.get(r.payload.group_id) || { id: r.payload.group_id, period: r.payload.period, due: r.payload.due, total: r.payload.group_total || 0, records: [], draft: false, change: null };
        g.records.push(r); if (r.payload.due > g.due) g.due = r.payload.due;
        if (isDraft(r)) g.draft = true;
        if (r.payload.pending_change) g.change = r.payload.pending_change;
        map.set(g.id, g);
    }
    return [...map.values()].sort((a, b) => b.period.localeCompare(a.period));
}
/** Month: the one after the latest entry, not later than now; nothing yet → last month.
 * Due: the 10th of the month after it; if that date has passed, the 10th of next month. */
export function utilitiesDefaults(d, a) {
    const now = d.business_date, cur = now.slice(0, 7), last = utilityGroups(d, a.id)[0];
    const month = last ? (addMonth(last.period, 1) > cur ? cur : addMonth(last.period, 1)) : addMonth(cur, -1);
    let due = dueForMonth(addMonth(month, 1), 10);
    if (due < now) due = dueForMonth(addMonth(cur, 1), 10);
    return { month, due, amount: last?.total || 0, last };
}
/** Owner home: a whole past month went by without utilities, while an earlier month was entered. */
export function missingUtilities(d) {
    const cur = d.business_date.slice(0, 7);
    return d.apartments.filter(canManage).map(a => ({ a, groups: utilityGroups(d, a.id), tenants: utilityTenants(d, a) }))
        .filter(x => x.groups.length && x.tenants.length).map(x => ({ a: x.a, month: addMonth(x.groups[0].period, 1) }))
        .filter(x => x.month < cur && !utilityGroups(d, x.a.id).some(g => g.period === x.month));
}
export function missingUtilitiesCard(s) {
    const list = missingUtilities(s.data);
    return list.map(({ a, month }) => `<div class="surface payment-highlight utilities-missing" data-tone="amber">${pillIcon('drop', 'amber')}<div><span class="muted">${s.data.apartments.filter(canManage).length > 1 ? esc(a.title) : 'Пора внести'}</span><b class="utilities-missing-title">Коммуналка за ${esc(monthWord(month))} ещё не внесена</b></div>${button('Внести', 'utilities', `data-apartment="${esc(a.id)}"`, 'secondary')}</div>`).join('');
}
/** `ids`: who splits it; a new month splits among today's tenants, an edit among the bill's own people. */
export function splitPreview(d, a, amount, ids = utilityTenants(d, a)) {
    const n = ids.length;
    if (!n) return '';
    if (!amount) return `Разделим поровну на ${tenantsWord(n)}`;
    const shares = equalSplit(amount, ids), values = ids.map(id => shares[id]), hi = Math.max(...values), lo = Math.min(...values);
    if (hi < 100) return 'Сумма слишком мала, чтобы разделить её на всех.';
    if (hi === lo) return `по ${money(hi)} × ${tenantsWord(n)}`;
    const k = values.filter(v => v === hi).length;
    return `${tenantsWord(k)} по ${money(hi)}, ${tenantsWord(n - k)} по ${money(lo)}`;
}
export function utilitiesSheet(d, a) {
    const ids = utilityTenants(d, a), def = utilitiesDefaults(d, a);
    if (!ids.length) return `<div class="form-stack">${notice('В квартире пока нет жильцов: коммуналку не на кого разделить. Сначала пригласите жильцов.', 'amber')}${button('Понятно', 'close-modal', '', 'secondary wide')}</div>`;
    const names = ids.map(id => nameIn(d, id, { fallback: 'Жилец', self: 'вы' })).join(', ');
    return `<form class="form-stack utilities-sheet" data-form="utilities" data-apartment="${esc(a.id)}">
        <label class="field big-amount"><span>Сколько за месяц, ₽</span><input name="amount" type="text" inputmode="decimal" autocomplete="off" required value="${def.amount ? groupDigits(rubles(def.amount)) : ''}" placeholder="0" data-utilities-amount data-money-input data-select-on-focus></label>
        <div class="split-preview" data-tone="green"><b data-split-preview aria-live="polite">${esc(splitPreview(d, a, def.amount))}</b><small>${esc(names)}</small></div>
        <div class="form-grid">${field('За какой месяц', 'period', 'month', def.month, 'required data-utilities-month')}${field('Оплатить до', 'due', 'date', def.due, 'required')}</div>
        <p class="small-note">${isMainOwner(a) ? 'Делим поровну между жильцами. Увидят после отправки.' : `Делим поровну между жильцами. ${esc(mainOwnerName(d, a))} проверит и отправит.`}</p>
        <div class="form-error" role="alert"></div>
        <div class="sheet-foot" data-foot="new"><div class="foot-face foot-new">${utilitiesButtons(a)}</div><div class="foot-face foot-exists" data-utilities-exists aria-live="polite" inert></div></div></form>`;
}
// Main owner: straight to tenants is the main action, a draft is the quiet one. Co-owner: one button, the main owner sends.
const utilitiesButtons = a => isMainOwner(a)
    ? `<button type="submit" class="btn primary wide" data-publish="1">Сохранить и отправить</button><button type="submit" class="text-link foot-link" data-publish="0">Сохранить черновик</button>`
    : `<button type="submit" class="btn primary wide" data-publish="0">Сохранить</button>`;
/** The month is already entered: a warning and the way to it, in the place of the save buttons. */
export function existingUtilitiesNote(d, a, month) {
    const g = utilityGroups(d, a.id).find(x => x.period === month);
    return g ? `<div class="notice amber" data-tone="amber">${icon('info', 20)}<span>За ${esc(monthWord(month))} уже внесено: ${money(g.total)}</span></div>${button('Открыть запись', 'open-record', `data-id="${esc(g.records[0].id)}"`, 'secondary wide')}` : '';
}
/** Owner: edit the amount or due of a whole month (all rooms at once). */
export function utilitiesEditSheet(d, groupId) {
    const records = d.records.filter(r => isUtilities(r) && r.payload.group_id === groupId && r.status !== 'cancelled');
    if (!records.length) throw Error('Коммуналка не найдена. Обновите экран.');
    const p = records[0].payload, a = d.apartments.find(x => x.id === records[0].apartment_id);
    if (!a) throw Error('Квартира недоступна. Обновите экран.');
    // The same people as when the month was entered (server keeps the share key set), not today's tenants.
    const people = utilityPeople(records);
    return `<form class="form-stack utilities-sheet" data-form="utilities-edit" data-group="${esc(groupId)}" data-apartment="${esc(a.id)}" data-people="${esc(people.join(','))}">
        <label class="field big-amount"><span>Сколько за ${esc(monthWord(p.period))}, ₽</span><input name="amount" type="text" inputmode="decimal" autocomplete="off" required value="${groupDigits(rubles(p.group_total || p.amount))}" data-utilities-amount data-money-input data-select-on-focus></label>
        <div class="split-preview" data-tone="green"><b data-split-preview aria-live="polite">${esc(splitPreview(d, a, p.group_total || p.amount, people))}</b><small>Доли пересчитаются для тех же жильцов. Уже отданное останется отданным.</small></div>
        ${field('Оплатить до', 'due', 'date', p.due, 'required')}
        <div class="form-error" role="alert"></div><button type="submit" class="btn primary wide">Сохранить</button></form>`;
}
export const utilityPeople = records => [...new Set(records.flatMap(r => Object.keys(r.payload.shares || {})))];
export const utilitiesVersions = (d, groupId) => Object.fromEntries(d.records.filter(r => isUtilities(r) && r.payload.group_id === groupId && r.status !== 'cancelled').map(r => [r.id, r.version]));
export const utilitiesTouched = (d, groupId) => d.records.some(r => isUtilities(r) && r.payload.group_id === groupId && (r.payload.confirmed || (r.payload.payments || []).length || claimsOf(r.payload).length));
export function utilitiesCancelSheet(d, groupId) {
    const r = d.records.find(x => isUtilities(x) && x.payload.group_id === groupId);
    if (!r) throw Error('Коммуналка не найдена. Обновите экран.');
    const draft = isDraft(r);
    return `<form class="form-stack" data-form="utilities-cancel" data-group="${esc(groupId)}">${notice(draft ? `Черновик за ${esc(monthWord(r.payload.period))} будет удалён. Жильцы его не видели. Месяц можно внести заново.` : `Коммуналка за ${esc(monthWord(r.payload.period))} исчезнет у всех жильцов. Месяц можно будет внести заново.`, 'amber')}<label class="field"><span>Причина (необязательно)</span><input name="note" type="text" maxlength="200" placeholder="Например, ошиблись суммой"></label><div class="form-error" role="alert"></div><button type="submit" class="btn danger wide">${draft ? 'Удалить черновик' : 'Отменить коммуналку'}</button></form>`;
}
/** Owner «Получил» from one person on one charge: their remainder, cash, today. */
export function receiveSheet(d, r, personId) {
    const view = chargePeople(d, r), row = view.rows.find(x => x.id === personId);
    const amount = Math.min(row?.left || 0, freeAmount(r.payload));
    if (amount <= 0) throw Error('Этот человек уже всё отдал. Обновите экран.');
    const who = nameIn(d, personId, { fallback: 'Жилец' });
    return `<form class="form-stack receive-sheet" data-form="record-action" data-id="${esc(r.id)}" data-action="record_payment" data-version="${r.version}" data-claim-id="">
        <div class="cash-entry-head"><span class="person-avatar">${initial(who)}</span><span><b>${esc(who)}</b><small>${esc(recordTitle(r))} · осталось ${money(row.left)}</small></span></div>
        <label class="field big-amount"><span>Получил наличными, ₽</span><input name="amount" type="text" inputmode="decimal" autocomplete="off" required value="${rubles(amount)}"></label>
        <input type="hidden" name="method" value="cash"><input type="hidden" name="payer_id" value="${esc(personId)}"><input type="hidden" name="for_user_id" value="${esc(personId)}"><input type="hidden" name="paid_on" value="${today()}">
        <p class="small-note">Наличными, сегодня. Платёж сразу станет подтверждённым. <button type="button" class="text-link inline-link" data-act="record-action" data-id="${esc(r.id)}" data-action="record_payment" data-payer="${esc(personId)}">Перевод или другая дата</button></p>
        <div class="form-error" role="alert"></div><button type="submit" class="btn primary wide">${icon('check', 18)} Получил</button></form>`;
}
export { monthLabel };

/* Approval of utilities -------------------------------------------------------------------- */
const changeLine = (g) => {
    const c = g.change, parts = [];
    if (c.amount !== undefined && c.amount !== g.total) parts.push(`${money(g.total)} → ${money(c.amount)}`);
    if (c.due && c.due !== g.due) parts.push(`срок ${date(g.due)} → ${date(c.due)}`);
    return parts.join(', ') || 'новый комментарий';
};
/** Everything waiting for the main owner's decision, newest month first. */
export function awaitingApproval(d) {
    return d.apartments.filter(isMainOwner).flatMap(a => utilityGroups(d, a.id).filter(g => g.draft || g.change).map(g => ({ a, g })));
}
export function approvalBlock(s) {
    const list = awaitingApproval(s.data);
    if (!list.length) return '';
    const several = s.data.apartments.filter(canManage).length > 1;
    const row = ({ a, g }) => `<div class="approval-row"><span class="approval-copy"><b>Коммуналка за ${esc(monthWord(g.period))} — ${g.draft ? money(g.total) : esc(changeLine(g))}</b><small>${[several ? a.title : '', g.draft ? 'Черновик · ' + ((g.records[0].payload.author || g.records[0].created_by) === s.data.user.id ? 'внесли вы' : 'внесла ' + nameIn(s.data, g.records[0].payload.author || g.records[0].created_by, { fallback: 'совладелец' })) : 'Изменение от ' + nameIn(s.data, g.change.by, { fallback: 'совладельца' })].filter(Boolean).map(esc).join(' · ')}</small></span><span class="approval-actions">${button(g.draft ? 'Отправить жильцам' : 'Одобрить', 'utilities-decide', `data-group="${esc(g.id)}" data-decision="approve"`, 'primary small')}${button('Открыть', 'open-record', `data-id="${esc(g.records[0].id)}"`, 'secondary small')}</span></div>`;
    return `<section class="surface approval-block" data-tone="amber" aria-label="Нужно одобрить"><div class="approval-head">${pillIcon('drop', 'amber')}<h2>${list.every(x => x.g.draft) ? 'Ждёт отправки' : 'Нужно одобрить'}</h2></div>${list.map(row).join('')}</section>`;
}
/** Co-owner's home: one card to write this month's utilities, with the state of the last entry.
 * Both states share one body with the same minimum height; on a switch only the inside fades in. */
const coShown = new Map();
export function coOwnerUtilitiesCard(s) {
    const d = s.data, list = d.apartments.filter(a => canManage(a) && !isMainOwner(a) && utilityTenants(d, a).length);
    return list.map(a => {
        const def = utilitiesDefaults(d, a), groups = utilityGroups(d, a.id), last = groups[0];
        // Her last entry still waits for the main owner: show its state, not the next month's form.
        const entered = last && (last.draft || last.change) ? last : groups.find(g => g.period === def.month);
        const mode = entered ? 'saved:' + entered.id : 'input:' + def.month, swap = coShown.has(a.id) && coShown.get(a.id) !== mode;
        coShown.set(a.id, mode);
        const status = g => g.draft ? '<span class="badge amber">Ждёт отправки</span>' : g.change ? '<span class="badge amber">Изменение ждёт отправки</span>' : '<span class="badge green">Отправлено</span>';
        const head = `<div class="approval-head">${pillIcon('drop', 'green')}<div><h2>${entered ? `Коммуналка за ${esc(monthWord(entered.period))}` : `Впишите коммуналку за ${esc(monthWord(def.month))}`}</h2>${list.length > 1 ? `<small class="muted">${esc(a.title)}</small>` : ''}</div></div>`;
        const body = entered
            ? `<div class="co-saved"><div class="co-status"><strong data-fit-number>${money(entered.total)}</strong>${status(entered)}</div><small class="muted">${entered.draft || entered.change ? esc(mainOwnerName(d, a)) + ' проверит и отправит жильцам.' : 'Жильцы видят свою долю в приложении.'}<br>Оплатить до ${date(entered.change?.due || entered.due)} · ${esc(splitPreview(d, a, entered.change?.amount ?? entered.total, utilityPeople(entered.records)))}</small><div class="co-actions">${button('Открыть', 'open-record', `data-id="${esc(entered.records[0].id)}"`, 'secondary')}</div></div>`
            : `<form class="co-utilities-form" data-form="utilities" data-apartment="${esc(a.id)}" data-quick="1"><input type="hidden" name="period" value="${def.month}"><input type="hidden" name="due" value="${def.due}"><div class="co-input-row"><label class="field big-amount"><span>Сумма за ${esc(monthWord(def.month))}, ₽</span><input name="amount" type="text" inputmode="decimal" autocomplete="off" required value="${def.amount ? groupDigits(rubles(def.amount)) : ''}" data-utilities-amount data-money-input data-select-on-focus></label><button type="submit" class="btn primary" data-publish="0">Сохранить</button></div><div class="form-error" role="alert"></div><small class="muted co-hint">${def.amount ? `Как в прошлый раз (${esc(monthWord(last.period))}). ` : ''}Оплатить до ${date(def.due)} · ${esc(splitPreview(d, a, 0))}. <button type="button" class="text-link inline-link" data-act="utilities" data-apartment="${esc(a.id)}">Другой месяц или срок</button></small></form>`;
        return `<section class="surface co-utilities" data-tone="green">${head}<div class="co-body${swap ? ' swap-in' : ''}" data-co="${entered ? 'saved' : 'input'}">${body}</div></section>`;
    }).join('');
}
export { changeLine };
