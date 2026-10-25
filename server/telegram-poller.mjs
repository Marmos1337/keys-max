// Telegram long polling. The home server cannot receive webhooks (inbound
// connections from Telegram time out at the ISP), but outbound requests work,
// so the server pulls updates itself with getUpdates.
//
// Guarantees:
// - one poller per database: a lease row in bot_state, renewed before every
//   request, so a second container or process stays in standby;
// - at-least-once delivery: updates are written to webhook_inbox (deduplicated
//   by update_id) before the offset that confirms them is sent to Telegram;
// - the offset is persisted, so a restart continues where it stopped;
// - network and API errors back off exponentially, 429 honours retry_after.
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { tgRequest, enqueueTelegramUpdate } from './telegram.mjs';

export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];
const LOCK_KEY = 'tg_poll_lock', OFFSET_KEY = 'tg_offset';
// A stored offset older than this is not trusted: after a week without updates
// Telegram may restart update_id from a random value.
const OFFSET_MAX_AGE = 24 * 3600_000;

let current = null;
export function telegramHealth() { return current ? current.health() : null; }

const log = (event, extra = {}) => console.log(JSON.stringify({ level: 'tg_poll', event, at: new Date().toISOString(), ...extra }));

export function readState(db, key) {
    const row = db.get('SELECT value,updated_at FROM bot_state WHERE key=?', key);
    return row ? { value: JSON.parse(row.value), updatedAt: row.updated_at } : null;
}
function writeState(db, key, value, now = Date.now()) {
    db.run('INSERT INTO bot_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', key, JSON.stringify(value), now);
}

// Takes or renews the polling lease. BEGIN IMMEDIATE makes it atomic across processes.
export function acquireLock(db, holder, ttl, now = Date.now()) {
    return db.tx(() => {
        const cur = readState(db, LOCK_KEY)?.value;
        if (cur && cur.holder !== holder && cur.expires > now) return false;
        writeState(db, LOCK_KEY, { holder, expires: now + ttl }, now);
        return true;
    });
}
export function releaseLock(db, holder) {
    db.tx(() => {
        if (readState(db, LOCK_KEY)?.value?.holder === holder) db.run('DELETE FROM bot_state WHERE key=?', LOCK_KEY);
    });
}

export function storedOffset(db, now = Date.now()) {
    const s = readState(db, OFFSET_KEY);
    return s && now - s.updatedAt < OFFSET_MAX_AGE && Number.isSafeInteger(s.value) ? s.value : undefined;
}

// Stores a batch of updates and the next offset in one transaction.
export function storeUpdates(db, updates) {
    const valid = updates.filter(u => Number.isSafeInteger(u?.update_id));
    if (!valid.length) return 0;
    db.tx(() => {
        for (const u of valid) enqueueTelegramUpdate(db, u);
        writeState(db, OFFSET_KEY, Math.max(...valid.map(u => u.update_id)) + 1);
    });
    return valid.length;
}

export function backoffMs(error, failures) {
    if (error?.retryAfter) return error.retryAfter * 1000;
    if (error?.status === 401 || error?.status === 404) return 300_000; // wrong token: do not hammer the API
    const base = Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1));
    return Math.round(base * (0.8 + Math.random() * 0.4));
}

export function startTelegramPoller(db, config, { onUpdates = () => {}, pollTimeout = 50, lockTtl = 120_000, standbyMs = 15_000 } = {}) {
    if (current) throw Error('Telegram poller is already running');
    const holder = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
    const abort = new AbortController();
    const state = { mode: 'polling', state: 'starting', startedAt: Date.now(), lastOkAt: 0, lastUpdateAt: 0, updates: 0, failures: 0, lastError: '', offset: storedOffset(db) };
    let stopped = false, wake = null, done;
    const sleep = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); wake = () => { clearTimeout(t); resolve(); }; });

    async function dropWebhookIfSet() {
        const info = await tgRequest(config, 'getWebhookInfo', {}, { signal: abort.signal });
        if (info.url) {
            // Pending updates stay on Telegram's side and arrive through getUpdates.
            await tgRequest(config, 'deleteWebhook', { drop_pending_updates: false }, { signal: abort.signal });
            log('webhook_deleted', { pending: info.pending_update_count || 0 });
        }
    }

    async function loop() {
        let prepared = false, standbyLogged = false;
        log('starting', { offset: state.offset ?? null, holder });
        while (!stopped) {
            if (!acquireLock(db, holder, lockTtl)) {
                if (!standbyLogged) { log('standby', { reason: 'another poller holds the lock' }); standbyLogged = true; }
                state.state = 'standby';
                await sleep(standbyMs);
                continue;
            }
            standbyLogged = false;
            try {
                if (!prepared) { await dropWebhookIfSet(); prepared = true; }
                state.state = 'polling';
                const body = { timeout: pollTimeout, allowed_updates: ALLOWED_UPDATES };
                if (state.offset !== undefined) body.offset = state.offset;
                const updates = await tgRequest(config, 'getUpdates', body, { timeoutMs: (pollTimeout + 15) * 1000, signal: abort.signal });
                if (state.failures) log('recovered', { after: state.failures });
                state.failures = 0; state.lastError = ''; state.lastOkAt = Date.now();
                const n = Array.isArray(updates) ? storeUpdates(db, updates) : 0;
                if (n) {
                    state.offset = Math.max(...updates.map(u => u.update_id)) + 1;
                    state.updates += n; state.lastUpdateAt = Date.now();
                    log('updates', { n, offset: state.offset });
                    try { onUpdates(n); } catch (e) { log('handler_error', { message: e.message }); }
                }
            } catch (e) {
                if (stopped) break;
                state.failures++;
                state.state = 'error';
                state.lastError = String(e.message || e).slice(0, 200);
                // 409: a webhook is set (delete it) or another getUpdates call took over.
                if (e.status === 409 && /webhook/i.test(e.message)) prepared = false;
                const wait = backoffMs(e, state.failures);
                // Log the first failures and then every tenth, so a long outage does not flood the log.
                if (state.failures <= 3 || state.failures % 10 === 0) log('error', { message: state.lastError, code: e.cause?.code, status: e.status, failures: state.failures, retry_in_ms: wait });
                await sleep(wait);
            }
        }
        releaseLock(db, holder);
        state.state = 'stopped';
        log('stopped', { offset: state.offset ?? null });
    }

    done = loop().catch(e => { state.state = 'crashed'; state.lastError = e.message; log('crashed', { message: e.message }); });
    const heartbeat = setInterval(() => log('heartbeat', publicHealth()), 30 * 60_000);
    heartbeat.unref();

    function publicHealth() {
        const now = Date.now();
        return {
            mode: 'polling', state: state.state, updates: state.updates, failures: state.failures,
            last_ok_s: state.lastOkAt ? Math.round((now - state.lastOkAt) / 1000) : null,
            last_update_s: state.lastUpdateAt ? Math.round((now - state.lastUpdateAt) / 1000) : null,
        };
    }

    current = {
        health: publicHealth,
        details: () => ({ ...publicHealth(), last_error: state.lastError, offset: state.offset ?? null, holder }),
        async stop() {
            if (stopped) return done;
            stopped = true; clearInterval(heartbeat); abort.abort(); wake?.();
            await done;
            current = null;
        },
    };
    return current;
}
