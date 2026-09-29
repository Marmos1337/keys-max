import { apartmentDeletionPreview, deleteApartment } from './apartment-delete.mjs';
import { cleanupDeletedUploads } from './upload-cleanup.mjs';
import { VERSION } from './version.mjs';
import { createUnit, updateUnit } from './rental.mjs';
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { readFileSync, createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fail, hash, constantEqual, validateInitData, ensureMaxUser, createSession, sessionUser, tokenFrom, signTicket, verifyTicket } from './auth.mjs';
import * as D from './domain.mjs';
import { storeCover, requireCover, coverUrl } from './covers.mjs';
import * as V from './validate.mjs';
import { mergeGuide, GUIDE_LIMIT, GUIDE_TOPICS } from '../public/guide-state.js';
import { enqueueUpdate, deepLink, botLink } from './bot.mjs';
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const routes = [];
function route(method, pattern, handler, { auth = true, mutate = false, binary = false, afterCommit = null } = {}) { const keys = []; const regex = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'); routes.push({ method, regex, keys, handler, auth, mutate, binary, afterCommit }); }
function json(res, status, body) { const bytes = Buffer.from(JSON.stringify(body)); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' }); res.end(bytes); }
async function bodyBuffer(req, limit) { const len = Number(req.headers['content-length']); if (Number.isFinite(len) && len > limit)
    fail(413, 'Файл или запрос слишком большой.'); let size = 0; const chunks = []; for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
        fail(413, 'Файл или запрос слишком большой.');
    chunks.push(chunk);
} return Buffer.concat(chunks); }
function cookie(res, token, config, remove = false) { res.setHeader('Set-Cookie', `keys_session=${token}; HttpOnly; Path=/; Max-Age=${remove ? 0 : 43200}; ${config.production ? 'Secure; SameSite=None' : 'SameSite=Lax'}`); }
function requireFiles(db, u, id) { const file = db.get('SELECT * FROM files WHERE id=?', id); if (!file)
    fail(404, 'Файл не найден.'); if (file.record_id)
    D.recordAccess(db, u, file.record_id);
else if (file.user_id !== u.id)
    fail(404, 'Файл не найден.'); return file; }
route('GET', '/api/config', ({ config }) => ({ mode: config.mode, bot_url: botLink(config), operator: config.operator, support: config.support, privacy_url: config.privacyUrl, terms_url: config.termsUrl, version: VERSION }), { auth: false });
route('GET', '/api/health', ({ db, config }) => { db.get('SELECT 1'); return { ok: true, version: VERSION, mode: config.mode }; }, { auth: false });
route('POST', '/api/auth/demo', ({ db, body, res, config }) => { if (config.mode !== 'demo' && config.mode !== 'test')
    fail(404, 'Недоступно.'); const role = V.choice(body.role, ['tenant', 'owner']); const u = db.get('SELECT * FROM users WHERE id=?', 'demo-' + role); if (!u)
    fail(400, 'Демо не инициализировано.'); db.run('UPDATE users SET role=? WHERE id=?', role, u.id); const s = createSession(db, u.id); cookie(res, s.token, config); return { ...s, user: D.safeUser({ ...u, role }) }; }, { auth: false });
route('POST', '/api/auth/max', ({ db, body, res, config }) => { if (config.mode === 'demo')
    fail(409, 'Деморежим не принимает реальные аккаунты MAX. Для запуска настройте APP_MODE=production.'); const data = validateInitData(body.initData, config.botToken), u = ensureMaxUser(db, data), s = createSession(db, u.id); cookie(res, s.token, config); return { ...s, user: D.safeUser(u), start_param: data.startParam }; }, { auth: false });
route('POST', '/api/auth/logout', ({ db, req, res, config }) => { db.run('DELETE FROM sessions WHERE hash=?', hash(tokenFrom(req))); cookie(res, '', config, true); return { ok: true }; });
route('POST', '/api/auth/revoke', ({ db, user, res, config }) => { db.run('DELETE FROM sessions WHERE user_id=?', user.id); cookie(res, '', config, true); return { ok: true }; }, { mutate: true });
route('GET', '/api/state', ({ db, user, config }) => D.bootstrap(db, user, config));
route('POST', '/api/profile', ({ db, user, body }) => D.updateProfile(db, user, body), { mutate: true });
route('POST', '/api/profile/guide', ({ db, user, body }) => {
    const role = V.choice(body.role, ['owner', 'tenant'], 'Режим гида');
    const p = V.own(body.progress);
    V.integer(p.opens, 'Открытия гида', 0, GUIDE_LIMIT);
    if (!Array.isArray(p.topics) || p.topics.length > GUIDE_TOPICS.length || p.topics.some(t => !GUIDE_TOPICS.includes(t)) || typeof p.dismissed !== 'boolean')
        fail(400, 'Некорректное состояние знакомства с приложением.');
    const current = db.get('SELECT * FROM users WHERE id=?', user.id);
    const settings = D.settings(current);
    settings.guide_v1 = { ...V.own(settings.guide_v1), [role]: mergeGuide(settings.guide_v1?.[role], p) };
    db.run('UPDATE users SET settings=? WHERE id=?', JSON.stringify(settings), user.id);
    return { role, progress: settings.guide_v1[role] };
}, { mutate: true });
route('POST', '/api/apartments', ({ db, user, body }) => D.createApartment(db, user, body), { mutate: true });
route('POST', '/api/apartments/:id', ({ db, user, body, params }) => D.updateApartment(db, user, params.id, body), { mutate: true });
route('GET', '/api/apartments/:id/deletion-preview', ({ db, user, params }) => apartmentDeletionPreview(db, user, params.id));
route('POST', '/api/apartments/:id/delete', ctx => {
    const result = deleteApartment(ctx.db, ctx.user, ctx.params.id, ctx.body);
    ctx.cleanupUploadKeys = result.upload_keys;
    return { ok: true, id: result.id, deleted: true };
}, { mutate: true, afterCommit: ctx => cleanupDeletedUploads(ctx.db, ctx.config, ctx.cleanupUploadKeys) });

route('POST', '/api/apartments/:id/leases', ({ db, user, body, params }) => D.createLease(db, user, params.id, body), { mutate: true });
route('POST','/api/leases/:id/archive-draft',({db,user,params})=>D.archiveDraftLease(db,user,params.id),{mutate:true});
route('POST', '/api/leases/:id/invite', ({ db, user, params, config }) => { const i = D.createInvite(db, user, params.id); return { ...i, url: botLink(config, 'join_' + i.code) }; }, { mutate: true });
route('POST', '/api/join', ({ db, user, body, config }) => { if(config.production) fail(409,'Примите приглашение в MAX Bot. Откройте персональную ссылку собственника.'); return D.joinInvite(db,user,body.code); }, { mutate: true });
route('POST', '/api/apartments/:id/units', ({db,user,params,body}) => createUnit(db,user,params.id,body), {mutate:true});
route('POST', '/api/units/:id', ({db,user,params,body}) => updateUnit(db,user,params.id,body), {mutate:true});
route('POST', '/api/leases/:id/meters', ({db,user,params,body}) => D.createMeter(db,user,params.id,body), {mutate:true});
route('POST', '/api/leases/:id/meter-settings', ({db,user,params,body}) => D.configureMeters(db,user,params.id,body), {mutate:true});
route('POST', '/api/recurring-rules', ({db,user,body,config}) => D.createRecurringRule(db,user,body,config), {mutate:true});
route('POST', '/api/recurring-rules/:id', ({db,user,params,body,config}) => D.updateRecurringRule(db,user,params.id,body,config), {mutate:true});
route('POST', '/api/meters/:id', ({ db, user, body, params }) => D.updateMeter(db, user, params.id, body), { mutate: true });
route('POST', '/api/records', ({ db, user, body, config }) => D.createRecord(db, user, body, config), { mutate: true });
route('POST', '/api/records/:id/action', ({ db, user, body, params }) => D.actionRecord(db, user, params.id, body), { mutate: true });
route('POST', '/api/records/:id/comments', ({ db, user, body, params }) => D.addComment(db, user, params.id, body), { mutate: true });
route('POST', '/api/notifications/read', ({ db, user }) => { db.run('UPDATE notifications SET is_read=1 WHERE user_id=?', user.id); return { ok: true }; }, { mutate: true });
route('GET', '/api/export', ({ db, user, config }) => ({ ...D.bootstrap(db, user, config, { coverUrls: false }), export_notice: 'Учётные данные приложения. Не банковская выписка, не налоговая декларация и не юридическое подтверждение.' }));
route('POST', '/api/export/ticket', ({ user, config }) => ({ url: `${config.publicUrl}/api/export/download?ticket=${signTicket(config, user.id, 'export')}`, name: 'keys-export.json', mime: 'application/json' }));
route('GET', '/api/export/download', ({ db, url, config, res }) => { const d = verifyTicket(config, url.searchParams.get('ticket')); if (d.f !== 'export')
    fail(401, 'Invalid export ticket'); const u = db.get('SELECT * FROM users WHERE id=?', d.u); if (!u)
    fail(404, 'Пользователь не найден.'); const bytes = Buffer.from(JSON.stringify({ ...D.bootstrap(db, u, config, { coverUrls: false }), notice: 'Учёт приложения; не банковская выписка. Вложения скачиваются отдельно.' }, null, 2)); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Content-Disposition': 'attachment; filename="keys-export.json"', 'Cache-Control': 'private, no-store' }); res.end(bytes); return null; }, { auth: false });
route('POST', '/api/apartment-covers', ({ db, user, body, url, config }) =>
    storeCover(db, user, body, url.searchParams.get('name'), config), { binary: true });
route('POST', '/api/apartment-covers/:id/ticket', ({ db, user, params, config }) => {
    requireCover(db, user, params.id);
    return { url: coverUrl(config, user.id, params.id) };
});
route('GET', '/api/apartment-covers/:id/image', async ({ db, params, url, config, res }) => {
    const t = verifyTicket(config, url.searchParams.get('ticket'));
    if (t.f !== 'cover:' + params.id) fail(401, 'Ссылка не относится к этой обложке.');
    const u = db.get('SELECT * FROM users WHERE id=?', t.u);
    if (!u) fail(404, 'Обложка недоступна.');
    const f = requireCover(db, u, params.id);
    const disk = path.join(config.dataDir, 'uploads', f.storage_key);
    await stat(disk);
    res.writeHead(200, {
        'Content-Type': f.mime, 'Content-Length': f.size,
        'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox"
    });
    createReadStream(disk).on('error', () => res.destroy()).pipe(res);
    return null;
}, { auth: false });
route('POST', '/api/files', async ({ db, user, body, url, config }) => {
    const leaseId = url.searchParams.get('lease_id'), { lease } = D.leaseAccess(db, user, leaseId, { write: true });
    const name = V.text(url.searchParams.get('name'), 'Имя файла', 160).replace(/[\x00-\x1f/\\]/g, '_');
    if (!body.length)
        fail(400, 'Файл пуст.');
    const ext = path.extname(name).toLowerCase();
    let type;
    if (body.subarray(0, 5).toString() === '%PDF-' && ext === '.pdf')
        type = 'application/pdf';
    else if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && ext === '.png')
        type = 'image/png';
    else if (body[0] === 255 && body[1] === 216 && body[2] === 255 && ['.jpg', '.jpeg'].includes(ext))
        type = 'image/jpeg';
    else if (body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP' && ext === '.webp')
        type = 'image/webp';
    else if (ext === '.txt' && !body.includes(0)) {
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(body);
            type = 'text/plain';
        }
        catch { }
    }
    if (!type)
        fail(400, 'Поддерживаются PDF, JPG, PNG, WebP и UTF-8 TXT. Тип файла должен соответствовать расширению.');
    const used = db.get('SELECT COALESCE(SUM(size),0) AS total FROM files WHERE apartment_id=?', lease.apartment_id).total;
    if (used + body.length > 500 * 1024 * 1024)
        fail(413, 'Достигнут лимит файлов квартиры: 500 МБ.');
    const id = randomUUID(), folder = path.join(config.dataDir, 'uploads');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(path.join(folder, id), body, { mode: 0o600, flag: 'wx' });
    db.run('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?,?)', id, lease.apartment_id, lease.id, null, user.id, name, type, body.length, id, D.nowISO());
    return { id, name, mime: type, size: body.length };
}, { binary: true });
route('POST', '/api/files/:id/ticket', ({ db, user, params, config }) => { const f = requireFiles(db, user, params.id); return { url: `${config.publicUrl}/api/download/${f.id}?ticket=${signTicket(config, user.id, f.id)}`, name: f.name, mime: f.mime }; });
route('GET', '/api/download/:id', async ({ db, params, url, config, res }) => { const d = verifyTicket(config, url.searchParams.get('ticket')); if (d.f !== params.id)
    fail(401, 'Ссылка не относится к этому файлу.'); const u = db.get('SELECT * FROM users WHERE id=?', d.u); if (!u)
    fail(404, 'Файл недоступен.'); const f = requireFiles(db, u, d.f), filePath = path.join(config.dataDir, 'uploads', f.storage_key); await stat(filePath); res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': f.size, 'Content-Disposition': `attachment; filename="file${path.extname(f.name)}"; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }); createReadStream(filePath).on('error', () => res.destroy()).pipe(res); return null; }, { auth: false });
route('POST', '/api/max/webhook', ({ db, config, req, body }) => { if (!config.webhookSecret || !constantEqual(req.headers['x-max-bot-api-secret'] || '', config.webhookSecret))
    fail(401, 'Unauthorized'); if (typeof body.update_type !== 'string')
    fail(400, 'Invalid update'); enqueueUpdate(db, body); return { ok: true }; }, { auth: false });
export function createServer(db, config) {
    const buckets = new Map();
    const server = http.createServer(async (req, res) => {
        const requestId = randomUUID();
        res.setHeader('X-Request-Id', requestId);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://st.max.ru; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://max.ru https://*.max.ru https://web.max.ru");
        if (config.production)
            res.setHeader('Strict-Transport-Security', 'max-age=31536000');
        try {
            const url = new URL(req.url, 'http://local');
            if (url.pathname.startsWith('/api/')) {
                if (req.method === 'OPTIONS') {
                    res.writeHead(204);
                    res.end();
                    return;
                }
                const clientIp = config.trustProxy ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
                const group = url.pathname.startsWith('/api/auth/') ? 'auth' : url.pathname === '/api/max/webhook' ? 'webhook' : 'api', key = clientIp + ':' + group;
                const now = Date.now(), entry = buckets.get(key) || { start: now, n: 0 };
                if (now - entry.start > 60000) {
                    entry.start = now;
                    entry.n = 0;
                }
                entry.n++;
                buckets.set(key, entry);
                if (entry.n > (group === 'auth' ? 40 : group === 'webhook' ? 300 : 600)) {
                    res.setHeader('Retry-After', '60');
                    fail(429, 'Слишком много запросов. Подождите минуту.');
                }
                if (buckets.size > 5000)
                    for (const [k, v] of buckets)
                        if (now - v.start > 60000)
                            buckets.delete(k);
                const found = routes.find(r => r.method === req.method && r.regex.test(url.pathname));
                if (!found)
                    fail(404, 'Маршрут не найден.');
                const origin = req.headers.origin;
                if (!['GET', 'HEAD'].includes(req.method) && url.pathname !== '/api/max/webhook') {
                    if (origin && origin !== config.publicUrl && !(config.mode !== 'production' && ['http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin)))
                        fail(403, 'Origin не разрешён.');
                    if (req.headers['x-keys-client'] !== 'miniapp')
                        fail(403, 'Отсутствует защита запроса.');
                }
                const match = url.pathname.match(found.regex), params = Object.fromEntries(found.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
                const user = found.auth ? sessionUser(db, req) : null;
                let body = {};
                if (!['GET', 'HEAD'].includes(req.method)) {
                    const raw = await bodyBuffer(req, found.binary ? 10 * 1024 * 1024 : 128 * 1024);
                    if (found.binary)
                        body = raw;
                    else if (raw.length) {
                        try {
                            body = JSON.parse(raw.toString('utf8'));
                            if (!body || typeof body !== 'object' || Array.isArray(body))
                                fail(400, 'Ожидался объект JSON.');
                        }
                        catch {
                            fail(400, 'Некорректный JSON.');
                        }
                    }
                }
                const ctx = { db, config, req, res, url, body, user, params };
                let output;
                if (found.mutate) {
                    const key = req.headers['idempotency-key'];
                    if (typeof key !== 'string' || key.length < 8 || key.length > 100)
                        fail(400, 'Требуется Idempotency-Key (8–100 символов).');
                    const requestHash = hash(req.method + ' ' + url.pathname + ' ' + JSON.stringify(body));
                    output = db.tx(() => { const prev = db.get('SELECT * FROM idempotency WHERE user_id=? AND key=?', user.id, key); if (prev) {
                        if (prev.request_hash !== requestHash)
                            fail(409, 'Этот ключ уже использован для другого действия.');
                        return JSON.parse(prev.response);
                    } const result = found.handler(ctx); if (result?.then)
                        throw Error('Async transaction prohibited'); db.run('INSERT INTO idempotency VALUES(?,?,?,?,?)', user.id, key, requestHash, JSON.stringify(result), Date.now()); return result; });
                }
                else
                    output = await found.handler(ctx);
                if (found.afterCommit) {
                    // A committed deletion must not become an HTTP error on an
                    // unlink failure. The maintenance sweep retries stale orphans.
                    try { await found.afterCommit(ctx); }
                    catch (error) { console.error(JSON.stringify({ level: 'after_commit_cleanup', requestId, code: error.code || 'cleanup_failed' })); }
                }
                if (output !== null && !res.writableEnded)
                    json(res, 200, output);
                return;
            }
            if (!['GET', 'HEAD'].includes(req.method))
                fail(405, 'Method not allowed');
            let requested;
            try {
                requested = decodeURIComponent(url.pathname);
            }
            catch {
                fail(400, 'Bad path');
            }
            if (requested.split('/').some(segment => segment.startsWith('.')))
                fail(404, 'Файл не найден.');
            const publicPages = new Map([['/privacy','privacy.html'],['/terms','terms.html']]);
            let file = publicPages.has(requested) ? path.join(publicDir,publicPages.get(requested)) : path.resolve(publicDir, '.' + requested);
            if (!file.startsWith(publicDir + path.sep) && file !== publicDir)
                fail(404, 'Not found');
            let info;
            try {
                info = await stat(file);
            }
            catch { }
            if (!info?.isFile()) {
                if (!info?.isFile()) {
                    if (path.extname(requested))
                        fail(404, 'Файл не найден.');
                    file = path.join(publicDir, 'index.html');
                    info = await stat(file);
                }
            }
            const type = mime[path.extname(file)];
            if (!type)
                fail(404, 'Файл не найден.');
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': file.includes('/art/') ? 'public, max-age=86400' : 'no-cache' });
            if (req.method === 'HEAD')
                res.end();
            else
                createReadStream(file).on('error', () => res.destroy()).pipe(res);
        }
        catch (e) {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            const status = e.status || (e.code === 'ENOENT' ? 404 : 500);
            if (status === 500)
                console.error(JSON.stringify({ level: 'error', requestId, message: e.message }));
            json(res, status, { error: status === 500 ? 'Внутренняя ошибка. Попробуйте ещё раз.' : e.message, requestId });
        }
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    server.keepAliveTimeout = 5000;
    return server;
}
