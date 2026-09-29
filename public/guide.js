import { post } from './api.js';
import { esc, button, icon } from './utils.js';
import { advanceGuide, mergeGuide, normalizeGuide, guideHidden } from './guide-state.js';

const cache = new Map();
const keyFor = (id, role) => `keys.guide.v1.${id}.${role}`;
const stored = key => { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Server remains authoritative if storage is unavailable. */ } };
function current(user, role = user.role) {
    const key = keyFor(user.id, role);
    const p = mergeGuide(user.settings?.guide_v1?.[role], mergeGuide(cache.get(key), stored(key)));
    cache.set(key, p);
    return p;
}
export function hydrateGuide(user) {
    if (!user) return;
    user.settings ??= {};
    user.settings.guide_v1 ??= {};
    for (const role of ['owner', 'tenant']) user.settings.guide_v1[role] = current(user, role);
}
export function showGuidePrompt(user) { return user && !guideHidden(current(user)); }

// A slow/offline sync must not resurrect the prompt or overwrite role/theme settings.
// Sending cumulative progress also makes retries and multiple tabs safe.
export async function recordGuide(user, event, topic) {
    if (!user) return;
    const role = user.role, key = keyFor(user.id, role);
    const previous = current(user);
    const progress = advanceGuide(previous, event, topic);
    cache.set(key, progress); save(key, progress);
    user.settings ??= {}; user.settings.guide_v1 ??= {};
    user.settings.guide_v1[role] = progress;
    if (event === 'visit' && JSON.stringify(progress) === JSON.stringify(previous)) return;
    try {
        const result = await post('/profile/guide', { role, progress });
        const merged = mergeGuide(cache.get(key), result.progress);
        cache.set(key, merged); save(key, merged);
        user.settings.guide_v1[role] = merged;
    } catch { /* Non-critical: keep the hint state locally, retry on the next session. */ }
}
export async function syncGuide(user) {
    if (!user) return;
    hydrateGuide(user);
    for (const role of ['owner', 'tenant']) {
        const p = current(user, role);
        if (!p.opens && !p.topics.length && !p.dismissed) continue;
        const key = keyFor(user.id, role);
        try {
            const result = await post('/profile/guide', { role, progress: p });
            const merged = mergeGuide(cache.get(key), result.progress);
            cache.set(key, merged); save(key, merged);
            user.settings.guide_v1[role] = merged;
        } catch { /* Keep local progress; never block the user's main task. */ }
    }
}
export function guidePrompt(user) {
    if (!showGuidePrompt(user)) return '';
    return `<aside class="guide-prompt" data-guide-prompt data-tone="blue" aria-label="Знакомство с приложением"><div><b>С чего начать?</b><p>Короткий гид по вашей аренде</p></div>${button('Открыть', 'guide-open', '', 'secondary')}<button type="button" class="icon-button guide-dismiss" data-act="guide-dismiss" aria-label="Больше не показывать подсказку" title="Больше не показывать">${icon('close',18)}</button></aside>`;
}
export function guideContent(user, config) {
    const owner = user.role === 'owner';
    const steps = [
        ['apartments', 'Квартира и участники', owner ? 'Создайте квартиру. Если сдаёте комнаты отдельно, добавьте их в блоке «Что сдаётся». Откройте нужную аренду и пригласите каждого жильца своей ссылкой.' : 'Примите приглашение собственника в MAX-боте. В квартире видны только ваши объекты аренды, участники и согласованные условия.'],
        ['documents', 'Договор и документы', 'Загрузите договор, акт или чек через «Документы → Добавить». Прикладывайте документы к выбранной аренде — соседняя комната их не увидит.'],
        ['finances', owner ? 'Начисления и оплата' : 'Оплата аренды', owner ? 'Создайте начисление или ежемесячное правило. Когда жилец нажмёт «Я оплатил», проверьте поступление денег и подтвердите каждый перевод.' : 'Сначала переведите деньги обычным способом. Затем откройте начисление, нажмите «Я оплатил» и укажите свою сумму. До ответа собственника она будет на подтверждении.'],
        ['requests', 'Заявки и ремонт', owner ? 'Откройте заявку, возьмите её в работу и опишите результат ремонта. Автор заявки затем подтверждает, что проблема решена.' : 'Нажмите «Сообщить о проблеме», опишите неисправность и добавьте фото. После ремонта подтвердите результат или верните заявку в работу.'],
        ['meters', 'Показания счётчиков', owner ? 'Настройте приборы конкретной аренды или общие счётчики квартиры. Если показания не нужны, раздел можно отключить.' : 'Введите накопительные значения в разделе «Счётчики». Фото необязательны. Показания сохраняются у собственника; поставщикам их нужно отправить отдельно.']
    ];
    return `<div class="guide-content"><p class="guide-intro">${owner ? 'Вы в кабинете собственника.' : 'Вы в кабинете арендатора.'} Каждый пункт можно открыть прямо отсюда.</p><div class="guide-steps">${steps.map(([page,title,text],i)=>`<section class="guide-step"><span class="guide-step-number">${i+1}</span><div><h3>${title}</h3><p>${text}</p><button type="button" class="text-link" data-act="guide-go" data-page="${page}">Открыть раздел ${icon('arrow',16)}</button></div></section>`).join('')}</div><div class="guide-note"><h3>Покупки и посещения</h3><p>Покупку добавляйте с суммой и чеком. Посещения согласуются заранее. Оба раздела открываются из карточки квартиры.</p><h3>Можно одновременно сдавать и снимать</h3><p>Переключение кабинета не удаляет ваши квартиры и историю. Когда доступны обе роли, переключатель находится под логотипом; он также есть в профиле.</p></div><p class="small-note">Подсказка на главной исчезнет после 4 открытий гида или знакомства с 4 разными разделами. Её можно скрыть сразу. Сам гид всегда остаётся в «Профиль → Помощь».</p>${button('Всё понятно', 'guide-finish', '', 'primary wide')}<p class="guide-support">Поддержка: ${esc(config.support || 'контакт указан в профиле')}</p></div>`;
}
