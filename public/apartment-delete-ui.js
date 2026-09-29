import { esc, icon, button, notice } from './utils.js';
import { surface } from './ui.js';

/** One owner-only danger zone at the bottom of the apartment overview. */
export function apartmentDeleteFooter(apartment) {
    return surface(`<div><h2>Удаление квартиры</h2><p>Удалить карточку и связанные с ней данные. Перед удалением потребуется подтверждение.</p></div>${button(icon('trash', 18) + '<span>Удалить квартиру</span>', 'delete-apartment', `data-id="${esc(apartment.id)}"`, 'danger')}`,
        { className: 'apartment-danger-zone', tone: 'red', tag: 'section', attrs: 'aria-label="Удаление квартиры"' });
}

export function apartmentDeleteDialog(p) {
    const cancel = button('Отмена', 'close-modal', 'data-delete-cancel data-tone="neutral"', 'secondary');
    const place = `<div class="delete-property-summary"><b>${esc(p.title)}</b><span>${esc(p.address)}</span></div>`;
    if (!p.can_delete) {
        return `<div class="form-stack" data-delete-dialog><p id="delete-apartment-question">Сейчас эту квартиру удалить нельзя.</p>${place}${p.blockers.map(b => notice(esc(b.message), 'amber')).join('')}<p class="small-note">Карточка и все данные остаются без изменений. После завершения аренды и расчётов вернитесь к удалению.</p><div class="action-row">${button('Закрыть', 'close-modal', 'data-delete-cancel data-tone="neutral"', 'secondary')}</div></div>`;
    }
    const counts = [['Комнаты', p.counts.rooms], ['Периоды аренды', p.counts.leases], ['Записи', p.counts.records], ['Файлы и обложки', p.counts.files + p.counts.covers]];
    return `<form data-form="delete-apartment" data-delete-dialog data-id="${esc(p.id)}" data-version="${p.version}" data-confirmation="${esc(p.confirmation_token)}" class="form-stack">
        <p id="delete-apartment-question">Вы уверены, что хотите удалить эту квартиру?</p>${place}
        <p>Вместе с квартирой удалятся её комнаты, аренды, платежи, заявки, показания, документы и загруженные фото. Приглашения перестанут работать.</p>
        <dl class="delete-counts">${counts.filter(([, n]) => n > 0).map(([label, n]) => `<div><dt>${esc(label)}</dt><dd>${n}</dd></div>`).join('')}</dl>
        ${notice('Восстановить данные через приложение нельзя. ' + (p.counts.tenants ? 'История исчезнет и из кабинетов бывших арендаторов. ' : '') + 'Сначала сохраните нужные документы и экспорт. Резервные копии этим действием не удаляются.', 'red')}
        <div class="form-error" role="alert"></div>
        <div class="action-row delete-confirm-actions">${cancel}<button type="submit" class="btn danger" data-delete-confirm>${icon('trash', 18)}<span>Удалить квартиру</span></button></div>
    </form>`;
}

/** Local post-success cleanup, also when the follow-up /state refresh is offline.
 * Never invoked before an explicit successful server response.
 */
export function withoutApartment(data, id) {
    const leaseIds = new Set(data.leases.filter(l => l.apartment_id === id).map(l => l.id));
    const recordIds = new Set(data.records.filter(r => r.apartment_id === id).map(r => r.id));
    const meterIds = new Set(data.meters.filter(m => m.apartment_id === id).map(m => m.id));
    return {
        ...data,
        apartments: data.apartments.filter(a => a.id !== id),
        units: data.units.filter(u => u.apartment_id !== id),
        leases: data.leases.filter(l => !leaseIds.has(l.id)),
        records: data.records.filter(r => !recordIds.has(r.id)),
        files: data.files.filter(f => f.apartment_id !== id && !recordIds.has(f.record_id)),
        comments: data.comments.filter(c => !recordIds.has(c.record_id)),
        events: data.events.filter(e => e.apartment_id !== id),
        notifications: data.notifications.filter(n => !recordIds.has(n.record_id)),
        meters: data.meters.filter(m => !meterIds.has(m.id)),
        meter_history: data.meter_history.filter(v => !meterIds.has(v.meter_id) && !recordIds.has(v.record_id)),
        recurring_rules: data.recurring_rules.filter(r => !leaseIds.has(r.lease_id))
    };
}
