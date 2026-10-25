// Telegram bot setup: `check` reads the bot state, `register` points the webhook,
// the menu button and the bot texts at this installation. Never prints the token.
import { makeConfig } from '../server/config.mjs';
import { tgRequest } from '../server/telegram.mjs';

const command = process.argv[2] || 'check';
const commands = [
    { command: 'start', description: 'Открыть Ключи' },
    { command: 'help', description: 'Помощь' },
    { command: 'notifications', description: 'Включить уведомления' },
    { command: 'stop', description: 'Выключить уведомления' },
];
const description = 'Ключи — всё о квартире и аренде в одном месте: платежи, показания счётчиков, заявки, покупки, документы и посещения. Для собственника и арендаторов.\n\nОткройте приложение кнопкой «Ключи» внизу чата.';
const shortDescription = 'Аренда квартиры без хаоса: платежи, счётчики, заявки и документы.';

try {
    const c = makeConfig();
    if (!c.tgBotToken) throw Error('Заполните KEYS_TG_BOT_TOKEN в .env. Токен не нужно присылать в чат.');
    if (!['check', 'register'].includes(command)) throw Error('Используйте check или register.');
    const me = await tgRequest(c, 'getMe');
    console.log('Telegram API отвечает. Бот: @' + me.username);
    if (c.tgBotUsername && c.tgBotUsername.toLowerCase() !== String(me.username).toLowerCase())
        throw Error('KEYS_TG_BOT_USERNAME не совпадает с ботом этого токена. Исправьте .env.');
    if (command === 'check') {
        const hook = await tgRequest(c, 'getWebhookInfo');
        const menu = await tgRequest(c, 'getChatMenuButton', {});
        console.log('Webhook:', hook.url || '(не задан)', '| в очереди:', hook.pending_update_count ?? 0, hook.last_error_message ? '| последняя ошибка: ' + hook.last_error_message : '');
        console.log('Кнопка меню:', menu.type === 'web_app' ? `${menu.text} → ${menu.web_app?.url}` : menu.type);
        console.log('Проверка API завершена. Это ещё не проверка Mini App на устройстве.');
    } else {
        if (c.mode !== 'production') throw Error('Регистрация webhook разрешена только в APP_MODE=production.');
        const url = new URL(c.publicUrl);
        if (url.protocol !== 'https:' || url.port) throw Error('Нужен HTTPS-домен на стандартном порту 443.');
        const health = await fetch(c.publicUrl + '/api/health', { signal: AbortSignal.timeout(10000) });
        if (!health.ok) throw Error('PUBLIC_URL/api/health недоступен. Сначала запустите сервер.');
        if ((await health.json()).mode !== 'production') throw Error('По PUBLIC_URL сейчас открыт не production. Не подключайте бота к демо.');
        await tgRequest(c, 'setWebhook', { url: c.publicUrl + '/api/telegram/webhook', secret_token: c.tgWebhookSecret, allowed_updates: ['message', 'callback_query', 'my_chat_member'], max_connections: 10 });
        await tgRequest(c, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Ключи', web_app: { url: c.publicUrl + '/' } } });
        for (const language_code of [undefined, 'ru']) {
            const lang = language_code ? { language_code } : {};
            await tgRequest(c, 'setMyCommands', { commands, ...lang });
            await tgRequest(c, 'setMyDescription', { description, ...lang });
            await tgRequest(c, 'setMyShortDescription', { short_description: shortDescription, ...lang });
        }
        console.log('Webhook зарегистрирован:', c.publicUrl + '/api/telegram/webhook');
        console.log('Кнопка меню «Ключи» открывает', c.publicUrl + '/');
        console.log('Отправьте боту /start и откройте приложение кнопкой меню.');
    }
} catch (e) {
    console.error('Ошибка:', e.message);
    if (e.cause?.code) console.error('Сетевая причина:', e.cause.code);
    process.exit(1);
}
