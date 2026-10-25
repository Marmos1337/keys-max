// One-time codes that attach a second messenger (MAX or Telegram) to an existing
// Keys account. The code is issued inside an authenticated Mini App session and is
// redeemed by a session or a bot update from the other platform, so both sides of
// the link are proven by the platforms' own signatures.
import { randomBytes } from 'node:crypto';
import { hash, fail } from './auth.mjs';
import { nowISO, pushNotification } from './domain.mjs';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I
export const LINK_TTL_MS = 15 * 60_000;
export const PLATFORMS = {
    max: { column: 'max_id', bot: 'bot_enabled', name: 'MAX' },
    telegram: { column: 'tg_id', bot: 'tg_bot_enabled', name: 'Telegram' },
};

export function normalizeLinkCode(raw) {
    const code = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-HJ-NP-Z2-9]{10}$/.test(code)) fail(400, 'Код привязки — 10 латинских букв и цифр, например ABCDE-23456.');
    return code;
}

export const linkedPlatforms = u => ({ max: !!u.max_id, telegram: !!u.tg_id });

export function createAccountLink(db, u) {
    let code = '';
    for (const byte of randomBytes(10)) code += ALPHABET[byte & 31];
    db.run('DELETE FROM account_links WHERE user_id=? AND used_at IS NULL', u.id);
    const expires = Date.now() + LINK_TTL_MS;
    db.run('INSERT INTO account_links(hash,user_id,expires,created_at) VALUES(?,?,?,?)', hash(code), u.id, expires, nowISO());
    return { code, display: code.slice(0, 5) + '-' + code.slice(5), expires: new Date(expires).toISOString() };
}

// True when the account owns or participates in anything that a link would orphan.
export function accountHasData(db, userId) {
    return [
        'SELECT 1 FROM apartments WHERE owner_id=? LIMIT 1',
        'SELECT 1 FROM lease_members WHERE user_id=? LIMIT 1',
        'SELECT 1 FROM leases WHERE tenant_id=? LIMIT 1',
        'SELECT 1 FROM records WHERE created_by=? LIMIT 1',
        'SELECT 1 FROM comments WHERE user_id=? LIMIT 1',
        'SELECT 1 FROM files WHERE user_id=? LIMIT 1',
        'SELECT 1 FROM apartment_covers WHERE owner_id=? LIMIT 1',
    ].some(sql => db.get(sql, userId));
}

function activeLink(db, code) {
    const row = db.get('SELECT * FROM account_links WHERE hash=?', hash(normalizeLinkCode(code)));
    if (!row || row.used_at || row.expires < Date.now()) fail(410, 'Код привязки недействителен или истёк. Получите новый в профиле Ключей.');
    const target = db.get('SELECT * FROM users WHERE id=?', row.user_id);
    if (!target || target.demo) fail(410, 'Код привязки недействителен или истёк. Получите новый в профиле Ключей.');
    return { row, target };
}

function check(db, target, platform, externalId) {
    const p = PLATFORMS[platform];
    if (!p || !externalId) fail(400, 'Неизвестный мессенджер.');
    if (target[p.column] && target[p.column] !== String(externalId))
        fail(409, `К этому аккаунту Ключей уже привязан другой ${p.name}.`);
    const existing = db.get(`SELECT * FROM users WHERE ${p.column}=? AND id<>?`, String(externalId), target.id);
    if (existing && accountHasData(db, existing.id))
        fail(409, `Этот ${p.name} уже используется другим аккаунтом Ключей с квартирами или арендами. Автоматически аккаунты не объединяются — напишите в поддержку.`);
    return { p, existing };
}

export function previewAccountLink(db, code, platform, externalId) {
    const { target } = activeLink(db, code);
    check(db, target, platform, externalId);
    return { name: target.name, already: target[PLATFORMS[platform].column] === String(externalId) };
}

// Attaches the platform identity to the code owner. An empty placeholder account
// that was created on first launch from the new platform gives up its identity.
export function claimAccountLink(db, code, platform, externalId, { botEnabled = false } = {}) {
    const { row, target } = activeLink(db, code);
    const { p, existing } = check(db, target, platform, externalId);
    if (target[p.column] === String(externalId)) {
        db.run('UPDATE account_links SET used_at=?, used_platform=? WHERE hash=?', nowISO(), platform, row.hash);
        return target;
    }
    if (existing) {
        db.run(`UPDATE users SET ${p.column}=NULL, ${p.bot}=0 WHERE id=?`, existing.id);
        const rest = db.get('SELECT max_id, tg_id FROM users WHERE id=?', existing.id);
        if (!rest.max_id && !rest.tg_id) db.run('DELETE FROM sessions WHERE user_id=?', existing.id);
    }
    const enabled = botEnabled || existing?.[p.bot] || target[p.bot] ? 1 : 0;
    db.run(`UPDATE users SET ${p.column}=?, ${p.bot}=? WHERE id=?`, String(externalId), enabled, target.id);
    db.run('UPDATE account_links SET used_at=?, used_platform=? WHERE hash=?', nowISO(), platform, row.hash);
    pushNotification(db, target.id, `${p.name} подключён`, `Теперь Ключи открываются и в ${p.name}. Квартиры, аренды и история общие.`);
    return db.get('SELECT * FROM users WHERE id=?', target.id);
}
