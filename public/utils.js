import { icon } from './icons.js';
export { icon };
export const esc = v => String(v ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
export const money = v => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: v % 100 ? 2 : 0 }).format((v || 0) / 100);
export const number = v => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(v || 0);
export const date = (v, opts = {}) => { if (!v)
    return 'Не указано'; return new Date(v.length === 10 ? v + 'T12:00:00' : v).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...opts }); };
export const datetime = v => new Date(v).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const range = (a, b) => `${datetime(a)} — ${new Date(b).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
export const localISO = offset => { const d = new Date(Date.now() + (offset || 0)); return new Date(+d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export const today = () => localISO().slice(0, 10);
export function parseAmount(v, scale = 100) { const raw = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.'); if (!/^\d+(\.\d+)?$/.test(raw))
    throw Error('Введите положительное число.'); const precision = Math.log10(scale); if ((raw.split('.')[1] || '').length > precision)
    throw Error(`Допустимо не более ${precision} знаков после запятой.`); const n = Math.round(Number(raw) * scale); if (!Number.isSafeInteger(n))
    throw Error('Слишком большое число.'); return n; }
export const statusNames = { open: 'Открыта', in_progress: 'В работе', resolved: 'На проверке', closed: 'Решена', cancelled: 'Отменено', pending: 'На согласовании', approved: 'Одобрено', rejected: 'Отклонено', compensated: 'Компенсировано', proposed: 'Ждёт ответа', counter: 'Новое время', accepted: 'Согласовано', completed: 'Завершено', claimed: 'На подтверждении', partial: 'Частично', paid: 'Оплачено', submitted: 'Передано', stored: 'Сохранено', recorded: 'Записано' };
export const statusColor = s => ['closed', 'paid', 'accepted', 'compensated', 'submitted', 'completed'].includes(s) ? 'green' : ['open', 'rejected'].includes(s) ? 'red' : ['pending', 'claimed', 'proposed', 'counter', 'partial'].includes(s) ? 'amber' : 'blue';
export const badge = (status, label) => `<span class="badge ${statusColor(status)}">${esc(label || statusNames[status] || status)}</span>`;
export const pillIcon = (name, color = 'blue') => `<span class="tile-icon ${color}" data-tone="${color}">${icon(name)}</span>`;
const actionTones = Object.freeze({
    'new-apartment': 'blue', 'edit-apartment': 'blue', 'edit-photo': 'blue',
    'new-unit': 'blue', 'edit-unit': 'blue', 'new-lease': 'blue', 'lease-select': 'blue',
    invite: 'blue', join: 'blue', 'new-meter': 'amber', 'edit-meter': 'amber',
    'toggle-meters': 'amber', 'restore-meter': 'amber', 'new-rule': 'green',
    'edit-rule': 'green', 'rule-state': 'green'
});
export function button(label, act, extra = '', kind = 'primary') {
    const recordKind = extra.match(/data-kind=["']([^"']+)/)?.[1];
    const tone = kindColor[recordKind] || actionTones[act];
    const onlyIcon = !String(label).replace(/<[^>]*>/g, '').trim();
    const names = { 'edit-unit': 'Изменить название комнаты', 'edit-meter': 'Настроить счётчик' };
    const accessible = onlyIcon && !extra.includes('aria-label=') ? ` aria-label="${esc(names[act] || 'Изменить')}"` : '';
    return `<button type="button" class="btn ${kind}${onlyIcon ? ' btn-icon' : ''}" data-act="${act}"${tone ? ` data-tone="${tone}"` : ''}${accessible} ${extra}>${label}</button>`;
}
export const section = (title, content, extra = '') => `<section class="section"><div class="section-heading"><h2>${title}</h2>${extra}</div>${content}</section>`;
export const empty = (title, description, action = '') => `<div class="surface empty-state">${pillIcon('spark', 'neutral')}<h3>${title}</h3><p>${description}</p>${action}</div>`;
export const notice = (text, color = 'neutral', name = 'info') => `<div class="notice ${color}" data-tone="${color}">${icon(name, 20)}<span>${text}</span></div>`;
export const fileSize = n => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : `${Math.ceil(n / 1024)} КБ`;
export function field(label,name,type='text',value='',extra='') {
    let display=value,attrs='';
    if(['date','month','datetime-local'].includes(type)) {
        const original=type,raw=String(value||'');
        if(raw){if(original==='month')display=raw.slice(5,7)+'.'+raw.slice(0,4);else display=raw.slice(8,10)+'.'+raw.slice(5,7)+'.'+raw.slice(0,4)+(original==='datetime-local'?' '+raw.slice(11,16):'');}
        const hint=original==='month'?'ММ.ГГГГ':original==='datetime-local'?'ДД.ММ.ГГГГ ЧЧ:ММ':'ДД.ММ.ГГГГ';
        attrs=` data-date-format="${original}" placeholder="${hint}" autocomplete="off" ${original==='datetime-local'?'':'inputmode="decimal"'}`;type='text';
        attrs += ` aria-label="${esc(label)}, формат ${hint}"`;
    }
    return `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(display)}" ${extra}${attrs}></label>`;
}
export const textarea = (label, name, value = '', required = false) => `<label class="field"><span>${label}</span><textarea name="${name}" rows="3" maxlength="3000" ${required ? 'required' : ''}>${esc(value)}</textarea></label>`;
export const select = (label, name, options, value) => `<label class="field"><span>${label}</span><select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
export const uploadField = (label = 'Фото и документы', onlyImages = false) => `<label class="file-input"><span>${icon('upload')}<b>${label}</b></span><small>До 5 файлов, каждый до 10 МБ · ${onlyImages ? 'JPG, PNG, WebP' : 'PDF, JPG, PNG, WebP, TXT'}</small><input type="file" name="files" multiple accept="${onlyImages ? 'image/jpeg,image/png,image/webp' : '.pdf,.jpg,.jpeg,.png,.webp,.txt'}"><span class="file-chosen" data-file-summary>Выбрать файлы</span></label>`;
export const categoryNames = { contract: 'Договор', act: 'Акт', receipt: 'Квитанция', agreement: 'Соглашение', other: 'Другое' };
export const kindNames = { ticket: 'Заявка', purchase: 'Покупка', visit: 'Посещение', charge: 'Платёж', reading: 'Показания', document: 'Документ', expense: 'Расход', termination: 'Завершение аренды', terms: 'Условия аренды' };
export const kindIcon = { ticket: 'tool', purchase: 'bag', visit: 'calendar', charge: 'wallet', reading: 'meter', document: 'file', expense: 'coins', termination: 'logout', terms: 'file' };
export function uuid() { if (globalThis.crypto?.randomUUID)
    return crypto.randomUUID(); const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128; const h = [...bytes].map(x => x.toString(16).padStart(2, "0")).join(""); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }

// Domain colours are independent of status badges. Purple means repairs only.
export const kindColor = Object.freeze({
    ticket: 'purple', purchase: 'orange', visit: 'teal', charge: 'green',
    reading: 'amber', document: 'slate', expense: 'green', termination: 'blue', terms: 'blue'
});
export const maxLogo = () => '<img class="max-logo" src="/art/max-colored.png" width="26" height="26" alt="" aria-hidden="true">';
