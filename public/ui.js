/**
 * Shared presentation components. No data writes or business rules live here.
 * Tone names use the same tokens on buttons, cards, tabs and navigation.
 * Labels passed as `content` are trusted template HTML; user text is escaped
 * by the caller, like the existing utils.button / notice helpers.
 */
import { esc, icon, pillIcon } from './utils.js';

const pageTones = Object.freeze({
    home: 'neutral', apartments: 'blue', requests: 'purple', finances: 'green',
    recurring: 'green', documents: 'slate', meters: 'amber', purchases: 'orange',
    visits: 'teal', history: 'blue', profile: 'blue', notifications: 'blue'
});
const recordTones = Object.freeze({
    ticket: 'purple', purchase: 'orange', visit: 'teal', charge: 'green',
    reading: 'amber', document: 'slate', expense: 'green', terms: 'blue', termination: 'blue'
});
export function pageTone(s) {
    if (s.page === 'record') return recordTones[s.data?.records.find(r => r.id === s.recordId)?.kind] || 'blue';
    if (s.page === 'apartments') return { meters: 'amber', payments: 'green' }[s.aptTab] || 'blue';
    return pageTones[s.page] || 'blue';
}
export function navPage(s) {
    if (s.page === 'record') {
        return { ticket: 'requests', charge: 'finances', expense: 'finances', document: 'documents' }[s.data?.records.find(r => r.id === s.recordId)?.kind] || 'apartments';
    }
    if (s.page === 'recurring') return 'finances';
    if (['meters', 'purchases', 'visits', 'history'].includes(s.page)) return 'apartments';
    return s.page;
}
export function surface(content, { className = '', tone = '', attrs = '', tag = 'div' } = {}) {
    return `<${tag} class="surface ${className}"${tone ? ` data-tone="${esc(tone)}"` : ''}${attrs ? ' ' + attrs : ''}>${content}</${tag}>`;
}
export function listItem({ leading = '', content, trailing = '', className = '', act = '', attrs = '', tone = '' }) {
    const tag = act ? 'button' : 'div';
    return `<${tag} ${act ? `type="button" data-act="${esc(act)}"` : ''} class="surface ui-row ${className}" ${tone ? `data-tone="${esc(tone)}"` : ''} ${attrs}>${leading}${content}${trailing}</${tag}>`;
}
export function statCard({ label, value, name, tone = 'neutral', className = '', act = '', attrs = '' }) {
    const tag = act ? 'button' : 'div';
    return surface(`${name ? pillIcon(name, tone) : ''}<span class="stat-label">${esc(label)}</span><strong data-fit-number>${value}</strong>`, {
        className: `stat-card ${act ? 'clickable' : ''} ${className}`.trim(),
        tone,
        tag,
        attrs: `${act ? `type="button" data-act="${esc(act)}"` : ''}${attrs ? (act ? ' ' : '') + attrs : ''}`.trim()
    });
}
export function segmented(items, current, { act = 'filter', key = 'value', className = 'tabs', buttonClass = 'tab', label = 'Фильтры', tone = '' } = {}) {
    return `<div class="segmented ${className}" data-ui="segmented"${tone ? ` data-tone="${esc(tone)}"` : ''} role="group" aria-label="${esc(label)}">${items.map(([id, text, name]) => `<button type="button" class="segment ${buttonClass} ${id === current ? 'selected' : ''}" data-act="${esc(act)}" data-${key}="${esc(id)}" aria-pressed="${id === current}"${name ? ` title="${esc(text)}"` : ''}>${name ? icon(name, 17) : ''}<span>${esc(text)}</span></button>`).join('')}</div>`;
}
export function actionTile({ title, name, tone = 'blue', act, attrs = '' }) {
    return `<button type="button" class="quick ${esc(tone)}" data-tone="${esc(tone)}" data-act="${esc(act)}" ${attrs}>${pillIcon(name, tone)}<span>${title}</span>${icon('arrow', 18)}</button>`;
}
export function navigationRow(title, act, attrs = '', { className = '', tone = '' } = {}) {
    return listItem({ content: `<b>${esc(title)}</b>`, trailing: icon('arrow', 18), act, attrs, className: `info-row plain ${className}`, tone });
}

/** Do not let amounts break at a space or leave a lone currency symbol.
 * Fit only numeric display elements; normal text remains readable and wrapping.
 * For unusually long statistics, give the card a full row instead of tiny text.
 */
export function fitNumericLabels(root) {
    root?.querySelectorAll('[data-fit-number]').forEach(el => {
        el.style.removeProperty('font-size');
        const card = el.closest('.stat-card');
        card?.classList.remove('wide-value');
        let font = parseFloat(getComputedStyle(el).fontSize);
        const min = card ? 18 : 20;
        let available = el.clientWidth || el.parentElement?.clientWidth || 0;
        if (!available) return;
        // scrollWidth is rounded; tolerate a single device-independent pixel.
        while (el.scrollWidth > available + 1 && font > min) {
            font -= .5; el.style.fontSize = `${font}px`;
            available = el.clientWidth;
        }
        if (card && el.scrollWidth > available + 1) {
            card.classList.add('wide-value');
            el.style.removeProperty('font-size');
        }
    });
}

/** Keep a selected pill in its own horizontal strip, without moving the page. */
const stripPositions = new Map();
export function rememberStrips(root) {
    root?.querySelectorAll('[data-ui="segmented"]').forEach(el => {
        stripPositions.set(el.getAttribute('aria-label'), el.scrollLeft);
    });
}
export function enhanceUI(root) {
    fitNumericLabels(root);
    root?.querySelectorAll('[data-ui="segmented"]').forEach(el => {
        const active = el.querySelector('[aria-pressed="true"]');
        el.scrollLeft = stripPositions.get(el.getAttribute('aria-label')) || 0;
        if (!active) return;
        const left = active.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
        if (left < el.scrollLeft + 6) el.scrollLeft = Math.max(0, left - 6);
        else if (left + active.offsetWidth > el.scrollLeft + el.clientWidth - 6)
            el.scrollLeft = left + active.offsetWidth - el.clientWidth + 6;
    });
}
