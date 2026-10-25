// Invite codes are stored as a SHA-256 hash (the lookup key) and, while the
// invite is pending, sealed with a key derived from SESSION_SECRET, so the
// owner can share the same link again. A database copy alone does not reveal
// working links; the sealed copy is dropped once the invite is used or revoked.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const key = secret => createHash('sha256').update('keys-invite-v1:' + secret).digest();

export function sealCode(secret, code) {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(secret), iv);
    const body = Buffer.concat([c.update(code, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function openCode(secret, sealed) {
    try {
        const raw = Buffer.from(String(sealed || ''), 'base64url');
        if (raw.length < 29) return '';
        const d = createDecipheriv('aes-256-gcm', key(secret), raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch { return ''; }
}
