/** Who owes what inside one charge, shared by browser and server. All money is integer kopecks.
 * A charge belongs to a lease; its tenants split it by payload.shares (a snapshot taken when the
 * charge was created). Charges from 0.6 have no snapshot and fall back to an equal split.
 * Payments and claims are credited to for_user_id when set (one tenant paid for another), else to user_id.
 */
export const OPEN_CHARGE = Object.freeze(['pending', 'partial', 'claimed']);

// Whole rubles per person; leftover rubles go to the first people in the given order and
// the sub-ruble remainder to the first person, so the shares always add up to the total.
export function equalSplit(total, ids) {
    const list = [...new Set(ids || [])], out = {};
    if (!list.length || !Number.isSafeInteger(total) || total <= 0) {
        for (const id of list) out[id] = 0;
        return out;
    }
    const rubles = Math.floor(total / 100), kopecks = total - rubles * 100;
    const base = Math.floor(rubles / list.length), extra = rubles - base * list.length;
    list.forEach((id, i) => { out[id] = (base + (i < extra ? 1 : 0)) * 100 + (i === 0 ? kopecks : 0); });
    return out;
}
const credited = x => x?.for_user_id ?? x?.user_id ?? null;
const sum = (list, id) => list.filter(x => credited(x) === id).reduce((n, x) => n + (x.amount || 0), 0);
export const claimsOf = payload => payload?.claims || (payload?.claim ? [payload.claim] : []);
export function sharesOf(payload, members = []) {
    const s = payload?.shares;
    if (s && typeof s === 'object' && Object.keys(s).length) return { ...s };
    return equalSplit(payload?.amount || 0, members);
}
export const paidBy = (payload, id) => sum(payload?.payments || [], id);
export const waitingBy = (payload, id) => sum(claimsOf(payload), id);
// Never more than what is still unpaid on the whole charge: legacy payments without a payer
// are not credited to anyone but still close the charge.
export function owedBy(payload, id, members = []) {
    const share = sharesOf(payload, members)[id] || 0;
    return Math.max(0, Math.min(share - paidBy(payload, id), (payload?.amount || 0) - (payload?.confirmed || 0)));
}
// What the person still has to hand over: their debt minus hand-overs waiting for confirmation.
export const remainingBy = (payload, id, members = []) => Math.max(0, owedBy(payload, id, members) - waitingBy(payload, id));
// What a manager may record as received from this person on this charge: their own claims are
// consumed, other people's claims stay reserved.
export function collectableBy(payload, id, members = []) {
    const others = claimsOf(payload).filter(c => credited(c) !== id).reduce((n, c) => n + c.amount, 0);
    return Math.max(0, Math.min(owedBy(payload, id, members), (payload?.amount || 0) - (payload?.confirmed || 0) - others));
}
const oldestFirst = (a, b) => String(a.due).localeCompare(String(b.due)) || String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id));
/** Open debt of one person across charges [{id, status, due?, created_at, payload, members}]. */
export function debtOf(charges, id) {
    const items = (charges || []).filter(r => OPEN_CHARGE.includes(r.status ?? 'pending'))
        .map(r => ({ id: r.id, due: r.due ?? r.payload?.due, created_at: r.created_at, cap: collectableBy(r.payload, id, r.members || []) }))
        .filter(x => x.cap > 0).sort(oldestFirst);
    return { total: items.reduce((n, x) => n + x.cap, 0), items };
}
/** Spreads a received total over debt items oldest first (by due, then created_at), each capped. */
export function allocate(items, total) {
    let left = Number.isSafeInteger(total) && total > 0 ? total : 0;
    const lines = [];
    for (const x of [...(items || [])].sort(oldestFirst)) {
        if (!left) break;
        const amount = Math.min(left, Math.max(0, x.cap ?? Math.min(x.owed ?? 0, x.available ?? Infinity)));
        if (amount > 0) { lines.push({ id: x.id, amount }); left -= amount; }
    }
    return { lines, rest: left };
}
