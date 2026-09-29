import { purgeOrphanUploads } from './upload-cleanup.mjs';
import { purgeUnusedCovers } from './covers.mjs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
// Only delete unbound uploads older than 24 h. Attached documents are never GC'd.
export async function purgeUnboundUploads(db, config, now = Date.now()) {
    await purgeUnusedCovers(db, config, now);
    const cutoff = new Date(now - 24 * 3600000).toISOString();
    const files = db.all('SELECT id,storage_key FROM files WHERE record_id IS NULL AND created_at<? LIMIT 100', cutoff);
    for (const f of files) {
        const deleted = db.run('DELETE FROM files WHERE id=? AND record_id IS NULL AND created_at<?', f.id, cutoff);
        if (deleted.changes !== 1)
            continue;
        try {
            await unlink(path.join(config.dataDir, 'uploads', f.storage_key));
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                console.error(JSON.stringify({ level: 'cleanup_error', fileId: f.id, code: e.code }));
        }
    }
    await purgeOrphanUploads(db, config, now);
}
