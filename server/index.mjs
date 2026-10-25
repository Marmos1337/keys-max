import { VERSION } from './version.mjs';
import { purgeUnboundUploads } from './maintenance.mjs';
import { makeConfig } from './config.mjs';
import { openDatabase } from './db.mjs';
import { createServer } from './http.mjs';
import { seedDemo } from './seed.mjs';
import { generateRecurring } from './domain.mjs';
import { processInbox, processOutbox } from './bot.mjs';
import { startTelegramPoller } from './telegram-poller.mjs';
const config = makeConfig(), db = openDatabase(config.dataDir);
if (config.production && db.get('SELECT 1 FROM users WHERE demo=1')) {
    db.close();
    throw Error('Production cannot use a demo database. Set a fresh DATA_DIR or a separate Docker project name.');
}
if (config.mode === 'demo')
    seedDemo(db, config);
const server = createServer(db, config);
let busy = false, again = false, lastRecurring = 0;
async function tick() {
    if (busy) { again = true; return; }
    busy = true;
    try {
        processInbox(db);
        if (Date.now() - lastRecurring > 60000) {
            db.tx(() => generateRecurring(db, config));
            lastRecurring = Date.now();
            db.run('DELETE FROM sessions WHERE expires<?', Date.now());
            db.run('DELETE FROM idempotency WHERE created_at<?', Date.now() - 7 * 86400000);
            // Telegram may reuse update ids after a quiet week; old handled rows must not shadow new updates.
            db.run("DELETE FROM webhook_inbox WHERE id LIKE 'tg:%' AND status IN ('processed','ignored') AND created_at<?", new Date(Date.now() - 3 * 86400000).toISOString());
            await purgeUnboundUploads(db, config);
        }
        await processOutbox(db, config);
    }
    catch (e) {
        console.error(JSON.stringify({ level: 'worker_error', message: e.message }));
    }
    finally {
        busy = false;
        if (again) { again = false; setImmediate(tick); }
    }
}
const timer = setInterval(tick, 1200);
timer.unref();
// Polling is the default: inbound webhooks do not reach this server. Demo never talks to Telegram.
const poller = config.telegram && config.tgMode === 'polling' && config.mode !== 'demo'
    ? startTelegramPoller(db, config, { onUpdates: () => setImmediate(tick) }) : null;
server.listen(config.port, config.host, () => console.log(`Ключи ${VERSION} | ${config.mode} | ${config.publicUrl}\nДанные: ${config.dataDir}\n${config.mode === 'demo' ? 'ДЕМО: только вымышленные данные. Реальные аккаунты MAX отключены.' : 'MAX: webhook должен быть зарегистрирован командой npm run max:register.'}${config.telegram ? `\nTelegram: ${config.tgMode}` : ''}`));
let stopping = false;
async function stop() {
    if (stopping)
        return;
    stopping = true;
    clearInterval(timer);
    setTimeout(() => process.exit(1), 10000).unref();
    try { await poller?.stop(); } catch {}
    server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
