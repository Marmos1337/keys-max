/** Physical cleanup follows a committed DB removal; never run inside db.tx. */
import { opendir, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';

const storageName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function referenced(db, key) {
    return !!db.get('SELECT 1 FROM files WHERE storage_key=? UNION ALL SELECT 1 FROM apartment_covers WHERE storage_key=? LIMIT 1', key, key);
}
export async function cleanupDeletedUploads(db, config, keys = []) {
    for (const key of keys) {
        // Storage names originate on the server, but never treat them as arbitrary paths.
        if (typeof key !== 'string' || !storageName.test(key) || referenced(db, key)) continue;
        try { await unlink(path.join(config.dataDir, 'uploads', key)); }
        catch (e) { if (e.code !== 'ENOENT') console.error(JSON.stringify({ level: 'upload_cleanup_retry', code: e.code, id: key })); }
    }
}
/** Retry after a crash between COMMIT and unlink. Fresh uploads may not yet have
 * DB metadata, so only unreferenced ordinary files older than 24 h are swept.
 * Non-UUID files, directories, symlinks and backup directories are untouched.
 */
export async function purgeOrphanUploads(db, config, now = Date.now()) {
    const dir = path.join(config.dataDir, 'uploads');
    let handle;
    try { handle = await opendir(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    let purged = 0;
    for await (const entry of handle) {
        if (!entry.isFile() || !storageName.test(entry.name) || referenced(db, entry.name)) continue;
        try {
            const stat = await lstat(path.join(dir, entry.name));
            if (!stat.isFile() || Math.max(stat.mtimeMs, stat.birthtimeMs || 0) > now - 86400000) continue;
            await cleanupDeletedUploads(db, config, [entry.name]);
            if (++purged >= 100) break;
        } catch (e) { if (e.code !== 'ENOENT') console.error(JSON.stringify({ level: 'orphan_upload_retry', code: e.code, id: entry.name })); }
    }
}
