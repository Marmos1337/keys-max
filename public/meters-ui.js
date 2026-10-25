// Meters: the owner writes the starting numbers once (no photo), then tenants send
// monthly readings with a photo. History shows consumption from the start.
import { esc, icon, pillIcon, button, notice, empty, section, number, money, date } from './utils.js';
import { metersFor, pendingMeters, monthLabel } from './rental-ui.js';

const icons = { cold_water: 'drop', hot_water: 'drop', electricity: 'lightning', gas: 'meter', heating: 'meter', other: 'meter' };
const tone = { cold_water: 'blue', hot_water: 'red', electricity: 'amber', gas: 'orange', heating: 'orange', other: 'neutral' };
const fmt = v => number(v / 1000);
const hasReadings = (d, m) => (d.meter_history || []).some(v => v.meter_id === m.id);
export const baselineEditable = (d, l) => metersFor(d, l).filter(m => !hasReadings(d, m));
const priceText = m => m.price != null ? `${money(m.price)} за ${esc(m.unit)}` : '';

function lastOf(d, m) { return (d.meter_history || []).filter(v => v.meter_id === m.id).sort((a, b) => b.period.localeCompare(a.period))[0]; }

function meterRow(s, m, { owner, input, pendingIds, ended }) {
    const d = s.data, last = lastOf(d, m), prev = m.previous ?? m.baseline;
    const sub = last ? `Последнее: <b>${fmt(last.value)}</b> · ${monthLabel(last.period)}${last.value > last.previous ? ` <span class="delta">+${fmt(last.value - last.previous)}</span>` : ''}`
        : m.baseline_at ? `Старт: <b>${fmt(m.baseline)}</b> · ${date(m.baseline_at)}` : m.baseline ? `Старт: <b>${fmt(m.baseline)}</b>` : '<span class="muted">Стартовое значение не записано</span>';
    const meta = [m.scope === 'apartment' ? 'Общий для квартиры' : 'Этот объект', esc(m.unit), priceText(m)].filter(Boolean).join(' · ');
    const end = owner ? `<button class="icon-button" data-act="edit-meter" data-id="${m.id}" aria-label="Настроить ${esc(m.label)}">${icon('edit', 18)}</button>`
        : input && !ended && pendingIds.has(m.id) ? `<label class="meter-input"><span class="sr-only">${esc(m.label)}</span><input aria-label="${esc(m.label)}" name="meter_${m.id}" type="text" inputmode="decimal" placeholder="${fmt(prev)}" required pattern="[0-9]+([.,][0-9]{1,3})?"><small>${esc(m.unit)}</small></label>`
        : `<span class="badge green">Передано</span>`;
    return `<div class="surface meter-row" data-tone="${tone[m.kind] || 'amber'}">${pillIcon(icons[m.kind] || 'meter', tone[m.kind] || 'amber')}<div class="meter-copy"><b>${esc(m.label)}</b><small>${meta}</small><small class="meter-last">${sub}</small></div>${end}</div>`;
}

// Starting readings card for the owner while no tenant has sent numbers for a meter.
function baselineCard(s, l) {
    const d = s.data, open = baselineEditable(d, l);
    if (!open.length || l.status === 'ended') return '';
    const done = open.every(m => m.baseline_at);
    if (done) {
        const when = open.map(m => m.baseline_at).sort().at(-1);
        return `<div class="surface baseline-card done" data-tone="green">${pillIcon('check', 'green')}<div><b>Стартовые показания записаны</b><small>${date(when, { year: 'numeric' })} · изменить можно, пока жильцы не передали первые показания</small></div>${button('Изменить', 'meter-baselines', '', 'secondary')}</div>`;
    }
    return `<div class="surface baseline-card" data-tone="amber"><div class="baseline-art" aria-hidden="true">${icon('meter', 28)}</div><div><b>Запишите стартовые показания</b><small>Перепишите текущие цифры со счётчиков — фото не нужно. Дальше жильцы будут передавать показания раз в месяц с фото, а расход посчитается от старта.</small></div>${button(icon('edit', 18) + ' Записать показания', 'meter-baselines', '', 'primary wide')}</div>`;
}

export function baselineForm(s, l) {
    const d = s.data, open = baselineEditable(d, l);
    const rows = open.map(m => `<label class="field meter-field"><span>${esc(m.label)} <small class="muted">· ${esc(m.unit)}</small></span><input name="baseline_${m.id}" type="text" inputmode="decimal" required pattern="[0-9]+([.,][0-9]{1,3})?" value="${m.baseline_at || m.baseline ? fmt(m.baseline).replace(/\s/g, '') : ''}" placeholder="Например, 123,456" autocomplete="off"></label>`).join('');
    const locked = metersFor(d, l).filter(m => hasReadings(d, m));
    return `<form class="form-stack" data-form="meter-baselines" data-lease="${esc(l.id)}">${notice('Перепишите цифры со счётчиков как есть — накопительные значения, до трёх знаков после запятой. Фото не нужно.', 'amber', 'info')}${rows}${locked.length ? `<p class="small-note">Уже с показаниями жильцов (не меняются): ${locked.map(m => esc(m.label)).join(', ')}.</p>` : ''}<div class="form-error" role="alert"></div><button type="submit" class="btn primary wide">${icon('check', 18)} Сохранить стартовые показания</button></form>`;
}

// Month-by-month history: value, consumption since the previous reading (or the start) and cost.
function historySection(s, l, meters) {
    const d = s.data, ids = new Set(meters.map(m => m.id));
    const rows = (d.meter_history || []).filter(v => ids.has(v.meter_id));
    if (!rows.length) return '';
    const periods = [...new Set(rows.map(v => v.period))].sort().reverse().slice(0, 12);
    const costOf = v => { const rec = d.records.find(r => r.id === v.record_id), pv = rec?.payload?.values?.find(x => x.meter_id === v.meter_id); if (pv?.cost != null) return pv.cost; const m = meters.find(x => x.id === v.meter_id); return m?.price != null ? Math.round((v.value - v.previous) * m.price / 1000) : null; };
    return section('История показаний', `<div class="meter-history">${periods.map(p => {
        const items = rows.filter(v => v.period === p), total = items.map(costOf).filter(x => x != null);
        const rec = items.map(v => v.record_id).find(Boolean);
        return `<div class="surface history-month"><div class="history-head"><b>${monthLabel(p)}</b>${total.length ? `<span class="history-total">${money(total.reduce((a, b) => a + b, 0))}</span>` : ''}${rec ? `<button type="button" class="text-link" data-act="open-record" data-id="${rec}">Фото ${icon('arrow', 14)}</button>` : ''}</div>${items.map(v => {
            const m = meters.find(x => x.id === v.meter_id), c = costOf(v);
            return `<div class="history-line"><span>${esc(m.label)}</span><span class="history-value">${fmt(v.value)}</span><span class="delta">+${fmt(v.value - v.previous)} ${esc(m.unit)}</span>${c != null ? `<span class="history-cost">${money(c)}</span>` : ''}</div>`;
        }).join('')}</div>`;
    }).join('')}</div>`);
}

export function photoUpload() {
    return `<label class="file-input photo-required" data-photo-required><span>${icon('camera')}<b>Фото счётчиков</b></span><small>Обязательно · можно несколько фото (до 5), JPG, PNG, WebP</small><input type="file" name="files" accept="image/jpeg,image/png,image/webp" multiple><span class="file-chosen" data-file-summary>Сфотографировать или выбрать</span></label>`;
}

export function metersContent(s, model) {
    const { l, owner, d } = model;
    if (!l) return empty('Выберите аренду', 'Сначала добавьте квартиру или комнату.');
    const all = metersFor(d, l, { archived: true }), mm = all.filter(m => m.active), pending = pendingMeters(d, l), pendingIds = new Set(pending.map(m => m.id)), ended = l.status === 'ended';
    if (!l.meters_enabled && !owner) return empty('Передача показаний отключена', 'Для этой аренды собственник отключил раздел.');
    const controls = owner && !ended ? `<div class="action-row">${button(icon('plus', 18) + ' Добавить счётчик', 'new-meter')}${button(l.meters_enabled ? 'Отключить показания' : 'Включить показания', 'toggle-meters', `data-enabled="${l.meters_enabled ? 'false' : 'true'}"`, 'secondary')}</div>` : '';
    const canSend = !owner && !ended && pending.length && l.meters_enabled;
    const rows = mm.map(m => meterRow(s, m, { owner, input: canSend, pendingIds, ended })).join('');
    const status = !l.meters_enabled ? notice('Передача показаний и напоминания отключены. Настройки и прежние значения сохранены.', 'amber')
        : owner ? '' : notice(pending.length ? `Срок — до ${l.meter_day} числа. Введите цифры со счётчика как есть (не расход) и приложите фото.` : 'Показания за этот месяц переданы. Спасибо!', pending.length ? 'neutral' : 'green', pending.length ? 'info' : 'check');
    const list = !mm.length ? empty('Счётчиков пока нет', owner ? 'Добавьте приборы, затем один раз перепишите их текущие цифры.' : 'Собственник ещё не настроил счётчики. Когда настроит, здесь появится форма показаний.', owner && !ended ? button(icon('plus', 18) + ' Добавить счётчик', 'new-meter', '', 'primary wide') : '', { icon: 'meter', tone: 'amber', steps: owner ? ['Добавьте воду, свет, газ или свой прибор', 'Запишите стартовые показания — без фото', 'Дальше жильцы передают показания с фото'] : [] })
        : canSend ? `<form data-form="readings" data-lease="${l.id}" class="form-stack"><div class="meters-grid">${rows}</div>${photoUpload()}<div class="form-error" role="alert"></div><button class="btn primary wide" type="submit">Отправить показания ${icon('send', 18)}</button></form>`
        : `<div class="meters-grid">${rows}</div>`;
    const archive = owner && all.some(m => !m.active) ? section('Архив счётчиков', all.filter(m => !m.active).map(m => `<div class="info-row"><span><b>${esc(m.label)}</b><small>История сохранена</small></span>${button('Восстановить', 'restore-meter', `data-id="${m.id}"`, 'secondary')}</div>`).join('')) : '';
    return (owner ? controls + (mm.length ? baselineCard(s, l) : '') : '') + status + list + historySection(s, l, all) + archive
        + notice('Общий счётчик квартиры передаётся один раз в месяц. Жильцам других комнат видны только цифры общих приборов, не ваши фото. В ЖКХ ничего не отправляется автоматически.', 'blue');
}
