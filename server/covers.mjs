/** Apartment covers are private data, not public static assets or lease documents. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { fail, signTicket } from './auth.mjs';
import * as V from './validate.mjs';

export const MAX_COVER_SIZE = 10 * 1024 * 1024;
const MAX_OWNER_BYTES = 500 * 1024 * 1024;

function checkDimensions(width, height) {
    if (!width || !height || width > 20000 || height > 20000 || width * height > 40_000_000)
        fail(400, 'Фото слишком большое: максимум 40 мегапикселей и 20 000 пикселей по стороне.');
}
export function imageMime(bytes, name) {
    const ext = path.extname(name).toLowerCase();
    if (bytes.length < 24) fail(400, 'Файл изображения повреждён. Выберите другое фото.');
    if (ext === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
        if (bytes.subarray(12,16).toString() !== 'IHDR') fail(400, 'Некорректный PNG.');
        checkDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
        return 'image/png';
    }
    if (['.jpg','.jpeg'].includes(ext) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
        let i = 2;
        const frames = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
        while (i + 4 <= bytes.length) {
            if (bytes[i++] !== 255) break;
            while (i < bytes.length && bytes[i] === 255) i++;
            const marker = bytes[i++];
            if (marker === 0xda || marker === 0xd9) break;
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
            if (i + 2 > bytes.length) break;
            const len = bytes.readUInt16BE(i);
            if (len < 2 || i + len > bytes.length) break;
            if (frames.has(marker) && len >= 8) {
                checkDimensions(bytes.readUInt16BE(i + 5), bytes.readUInt16BE(i + 3));
                return 'image/jpeg';
            }
            i += len;
        }
        fail(400, 'Не удалось прочитать размеры JPG. Выберите другое фото.');
    }
    if (ext === '.webp' && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') {
        for (let i = 12; i + 8 <= bytes.length;) {
            const kind = bytes.subarray(i, i+4).toString(), n = bytes.readUInt32LE(i+4), at = i+8;
            if (at + n > bytes.length) break;
            if (kind === 'VP8X' && n >= 10) {
                checkDimensions(1 + bytes.readUIntLE(at+4,3), 1 + bytes.readUIntLE(at+7,3));
                return 'image/webp';
            }
            if (kind === 'VP8 ' && n >= 10 && bytes.subarray(at+3,at+6).equals(Buffer.from([0x9d,0x01,0x2a]))) {
                checkDimensions(bytes.readUInt16LE(at+6) & 0x3fff, bytes.readUInt16LE(at+8) & 0x3fff);
                return 'image/webp';
            }
            if (kind === 'VP8L' && n >= 5 && bytes[at] === 0x2f) {
                const bits = bytes.readUInt32LE(at+1);
                checkDimensions((bits & 0x3fff)+1, ((bits >>> 14) & 0x3fff)+1);
                return 'image/webp';
            }
            i = at + n + (n & 1);
        }
        fail(400, 'Не удалось прочитать размеры WebP. Выберите другое фото.');
    }
    fail(400, 'Для обложки подходят JPG, PNG и WebP. SVG, PDF, GIF и HEIC не поддерживаются.');
}

function checkQuota(db, userId, bytes) {
    const { size, count } = db.get('SELECT COALESCE(SUM(size),0) AS size, COUNT(*) AS count FROM apartment_covers WHERE owner_id=?', userId);
    if (size + bytes > MAX_OWNER_BYTES || count >= 500)
        fail(413, 'Достигнут лимит обложек. Неиспользованные загрузки удаляются через 24 часа.');
}

export async function storeCover(db, u, bytes, inputName, config) {
    if (u.role !== 'owner') fail(403, 'Фото квартиры меняет собственник.');
    if (!bytes.length) fail(400, 'Файл пуст.');
    if (bytes.length > MAX_COVER_SIZE) fail(413, 'Фото должно быть не больше 10 МБ.');
    const name = V.text(inputName, 'Имя файла', 160).replace(/[\x00-\x1f/\\]/g, '_');
    const mime = imageMime(bytes, name);
    checkQuota(db, u.id, bytes.length);
    const id = randomUUID(), folder = path.join(config.dataDir, 'uploads'), filePath = path.join(folder, id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(filePath, bytes, { mode: 0o600, flag: 'wx' });
    try {
        db.tx(() => {
            checkQuota(db, u.id, bytes.length);
            db.run('INSERT INTO apartment_covers(id,owner_id,name,mime,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?)',
                id, u.id, name, mime, bytes.length, id, new Date().toISOString());
        });
    } catch (e) {
        await unlink(filePath).catch(() => {});
        throw e;
    }
    return { id, name, mime, size: bytes.length };
}

export function bindCover(db, u, apartmentId, id) {
    const a = db.get('SELECT * FROM apartments WHERE id=? AND owner_id=?', apartmentId, u.id);
    if (!a) fail(404, 'Квартира не найдена.');
    if (id !== null) {
        V.text(id, 'Идентификатор обложки', 80);
        const f = db.get('SELECT * FROM apartment_covers WHERE id=?', id);
        if (!f || f.owner_id !== u.id || (f.apartment_id && f.apartment_id !== apartmentId))
            fail(400, 'Обложка недоступна. Загрузите фотографию для этой квартиры.');
        db.run('UPDATE apartment_covers SET apartment_id=? WHERE id=?', apartmentId, id);
    }
    db.run('UPDATE apartments SET cover_id=? WHERE id=?', id, apartmentId);
}

export function canSeeCover(db, u, a) {
    return a.owner_id === u.id || !!db.get("SELECT 1 FROM leases l JOIN lease_members lm ON lm.lease_id=l.id WHERE l.apartment_id=? AND lm.user_id=? AND l.status IN ('active','ending')", a.id, u.id);
}
export function requireCover(db, u, id) {
    const f = db.get('SELECT * FROM apartment_covers WHERE id=?', id);
    if (!f) fail(404, 'Обложка недоступна.');
    if (!f.apartment_id) {
        if (f.owner_id !== u.id) fail(404, 'Обложка недоступна.');
        return f;
    }
    const a = db.get('SELECT * FROM apartments WHERE id=? AND cover_id=?', f.apartment_id, id);
    if (!a || !canSeeCover(db, u, a)) fail(404, 'Обложка недоступна.');
    return f;
}
export function coverUrl(config, userId, id) {
    return '/api/apartment-covers/' + encodeURIComponent(id) + '/image?ticket=' +
        encodeURIComponent(signTicket(config, userId, 'cover:' + id));
}
export function presentApartment(db, u, a, config, urls = true) {
    if (!a.cover_id) return { ...a, cover_url: null };
    // An archived tenant must not see new residents' interior photos.
    if (!canSeeCover(db, u, a)) return { ...a, cover_id: null, cover_url: null };
    return { ...a, ...(urls ? { cover_url: coverUrl(config, u.id, a.cover_id) } : {}) };
}

export async function purgeUnusedCovers(db, config, now = Date.now()) {
    const cutoff = new Date(now - 24 * 3600000).toISOString();
    const old = db.all('SELECT id,storage_key FROM apartment_covers c WHERE c.created_at<? AND NOT EXISTS(SELECT 1 FROM apartments a WHERE a.cover_id=c.id) LIMIT 100', cutoff);
    for (const f of old) {
        const result = db.run('DELETE FROM apartment_covers WHERE id=? AND created_at<? AND NOT EXISTS(SELECT 1 FROM apartments WHERE cover_id=?)', f.id, cutoff, f.id);
        if (result.changes !== 1) continue;
        await unlink(path.join(config.dataDir,'uploads',f.storage_key)).catch(e => {
            if (e.code !== 'ENOENT') console.error(JSON.stringify({level:'cover_cleanup_error',id:f.id,code:e.code}));
        });
    }
}
