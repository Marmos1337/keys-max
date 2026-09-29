import { VERSION } from './version.mjs';
import { purgeUnboundUploads } from './maintenance.mjs';
import { makeConfig } from './config.mjs';
import { openDatabase } from './db.mjs';
import { createServer } from './http.mjs';
import { seedDemo } from './seed.mjs';
import { generateRecurring } from './domain.mjs';
import { processInbox, processOutbox } from './bot.mjs';
const config = makeConfig(), db = openDatabase(config.dataDir);
if (config.production && db.get('SELECT 1 FROM users WHERE demo=1')) {
    db.close();
    throw Error('Production cannot use a demo database. Set a fresh DATA_DIR or a separate Docker project name.');
}
if (config.mode === 'demo')
    seedDemo(db, config);
const server = createServer(db, config);
let busy = false, lastRecurring = 0;
const timer = setInterval(async () => { if (busy)
    return; busy = true; try {
    processInbox(db);
    if (Date.now() - lastRecurring > 60000) {
        db.tx(() => generateRecurring(db, config));
        lastRecurring = Date.now();
        db.run('DELETE FROM sessions WHERE expires<?', Date.now());
        db.run('DELETE FROM idempotency WHERE created_at<?', Date.now() - 7 * 86400000);
        await purgeUnboundUploads(db, config);
    }
    await processOutbox(db, config);
}
catch (e) {
    console.error(JSON.stringify({ level: 'worker_error', message: e.message }));
}
finally {
    busy = false;
} }, 1200);
timer.unref();
server.listen(config.port, config.host, () => console.log(`Ключи ${VERSION} | ${config.mode} | ${config.publicUrl}\nДанные: ${config.dataDir}\n${config.mode === 'demo' ? 'ДЕМО: только вымышленные данные. Реальные аккаунты MAX отключены.' : 'MAX: webhook должен быть зарегистрирован командой npm run max:register.'}`));
let stopping = false;
function stop() { if (stopping)
    return; stopping = true; clearInterval(timer); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
