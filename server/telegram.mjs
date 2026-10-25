// Telegram Bot API adapter. The domain logic and the outbox are shared with MAX;
// this module only translates updates in and messages out.
import { nowISO } from './domain.mjs';

export async function tgRequest(config, method, body = {}, { timeoutMs = 12_000, signal } = {}) {
    // The token is part of the Bot API path by design. Errors never include the URL.
    const timeout = AbortSignal.timeout(timeoutMs);
    const r = await fetch(`${config.tgApiBase}/bot${config.tgBotToken}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    let result;
    try { result = await r.json(); } catch { throw Error(`Telegram returned HTTP ${r.status}`); }
    if (!r.ok || result.ok !== true) {
        const e = new Error(`Telegram HTTP ${r.status}: ${String(result.description || 'request failed').slice(0, 150)}`);
        e.status = r.status;
        e.retryAfter = Number(result.parameters?.retry_after) || 0;
        throw e;
    }
    return result.result;
}

export function telegramBotLink(config, payload = '') {
    if (!config.tgBotUsername) return '';
    return `https://t.me/${encodeURIComponent(config.tgBotUsername)}${payload ? '?start=' + encodeURIComponent(payload) : ''}`;
}

// Mini App URL opened by a web_app button. Telegram appends the signed launch data
// in the hash; our client reads ?startapp from the query as in MAX direct links.
export function telegramAppUrl(config, payload = '') {
    return config.publicUrl + '/' + (payload ? '?startapp=' + encodeURIComponent(payload) : '');
}

const byteLength = s => Buffer.byteLength(String(s), 'utf8');

// Converts the shared message shape (MAX inline_keyboard) to sendMessage fields.
export function toTelegram(message, config) {
    const app = config.publicUrl.startsWith('https://') ? config.publicUrl + '/' : null;
    const rows = (message.attachments?.[0]?.payload?.buttons || []).map(row => row.map(b => {
        if (b.type === 'callback') return byteLength(b.payload) <= 64 ? { text: b.text, callback_data: b.payload } : null;
        if (app && String(b.url).startsWith(app)) return { text: b.text, web_app: { url: b.url } };
        return /^https:\/\//.test(b.url) ? { text: b.text, url: b.url } : null;
    }).filter(Boolean)).filter(row => row.length);
    return {
        text: message.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}),
    };
}

const person = from => ({ id: String(from.id), name: [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 120) || 'Пользователь Telegram' });
const validFrom = from => from && Number.isSafeInteger(from.id) && from.id > 0 && !from.is_bot;

// Reduces a Telegram update to the few events the bot understands, or null.
// Only private chats are handled: lease data is never sent to groups.
export function normalizeTelegramUpdate(update) {
    if (update?.message) {
        const m = update.message;
        if (m.chat?.type !== 'private' || !validFrom(m.from) || typeof m.text !== 'string') return null;
        return { kind: 'text', user: person(m.from), text: m.text.trim() };
    }
    if (update?.callback_query) {
        const q = update.callback_query;
        if (!validFrom(q.from) || (q.message && q.message.chat?.type !== 'private') || typeof q.data !== 'string') return null;
        return { kind: 'callback', user: person(q.from), data: q.data, callbackId: String(q.id) };
    }
    if (update?.my_chat_member) {
        const c = update.my_chat_member;
        if (c.chat?.type !== 'private' || !validFrom(c.from)) return null;
        const status = c.new_chat_member?.status;
        if (status === 'kicked' || status === 'left') return { kind: 'stopped', user: person(c.from) };
        if (status === 'member') return { kind: 'started', user: person(c.from) };
    }
    return null;
}

export function enqueueTelegramUpdate(db, update) {
    const key = 'tg:' + update.update_id;
    db.run('INSERT OR IGNORE INTO webhook_inbox(id,body,created_at) VALUES(?,?,?)', key, JSON.stringify({ source: 'telegram', update }), nowISO());
    return key;
}

// "/start join_x", "/start@rentkeysbot link_x" → { command: '/start', arg: 'join_x' }
export function parseCommand(text) {
    const m = String(text).match(/^(\/[a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/i);
    return m ? { command: m[1].toLowerCase(), arg: m[2] || '' } : null;
}
