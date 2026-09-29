import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fixture, httpFixture, newUser, apartmentInput, status } from './helpers.mjs';
import * as D from '../server/domain.mjs';
import { createUnit } from '../server/rental.mjs';
import { openDatabase } from '../server/db.mjs';
import { apartmentDeletionPreview, deleteApartment } from '../server/apartment-delete.mjs';
import { purgeOrphanUploads, cleanupDeletedUploads } from '../server/upload-cleanup.mjs';
import { apartmentDeleteDialog, apartmentDeleteFooter, withoutApartment } from '../public/apartment-delete-ui.js';
import { pageView } from '../public/views.js';

function fresh(f, options = {}) { return f.db.tx(() => D.createApartment(f.db, f.owner, { ...apartmentInput, title: 'Квартира для удаления', ...options })); }
function payload(p) { return { version: p.version, confirmation_token: p.confirmation_token, confirmed: true }; }
function remove(f, a, overrides = {}) {
    const p = apartmentDeletionPreview(f.db, f.owner, a.id);
    return f.db.tx(() => deleteApartment(f.db, f.owner, a.id, { ...payload(p), ...overrides }));
}
function snapshot(db) {
    return JSON.stringify(db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(({ name }) => [name, db.all(`SELECT * FROM "${name}" ORDER BY rowid`)]));
}
function addFile(f, a, recordId = null) {
    const l = f.db.get('SELECT * FROM leases WHERE apartment_id=?', a.id), id = randomUUID();
    mkdirSync(path.join(f.dir, 'uploads'), { recursive: true });
    writeFileSync(path.join(f.dir, 'uploads', id), 'fake-test-document');
    f.db.run('INSERT INTO files(id,apartment_id,lease_id,record_id,user_id,name,mime,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, a.id, l.id, recordId, f.owner.id, 'delete-test.txt', 'text/plain', 18, id, D.nowISO());
    return id;
}

test('Delete: preview is read-only and reports rooms, drafts, rules and revoked invites', t => {
    const f = fixture(t), a = fresh(f, { rental_mode: 'rooms' });
    const l = f.db.get('SELECT * FROM leases WHERE apartment_id=?', a.id);
    f.db.tx(() => D.createInvite(f.db, f.owner, l.id));
    const before = snapshot(f.db), p = apartmentDeletionPreview(f.db, f.owner, a.id);
    assert.equal(p.can_delete, true); assert.equal(p.counts.rooms, 1); assert.equal(p.counts.leases, 1);
    assert.equal(p.counts.recurring_rules, 1); assert.match(p.confirmation_token, /^[0-9a-f]{64}$/);
    assert.equal(snapshot(f.db), before);
});

test('Delete: empty apartment with separate rooms, meters and monthly rules is actually removed', t => {
    const f = fixture(t), a = fresh(f, { rental_mode: 'rooms' }), l = f.db.get('SELECT * FROM leases WHERE apartment_id=?', a.id);
    const room = f.db.tx(() => createUnit(f.db, f.owner, a.id, { title: 'Вторая комната', kind: 'room' }));
    f.db.tx(() => D.createLease(f.db, f.owner, a.id, { ...apartmentInput, unit_id: room.id }));
    f.db.tx(() => D.createMeter(f.db, f.owner, l.id, { label: 'Вода', unit: 'м³', kind: 'cold_water', scope: 'lease', baseline: 0 }));
    const invite = f.db.tx(() => D.createInvite(f.db, f.owner, l.id));
    const userCount = f.db.get('SELECT count(*) n FROM users').n;
    remove(f, a);
    for (const table of ['apartments', 'leases', 'rental_units', 'meters', 'events', 'records', 'files', 'apartment_covers'])
        assert.equal(f.db.get(`SELECT count(*) n FROM ${table} WHERE ${table === 'apartments' ? 'id' : 'apartment_id'}=?`, a.id).n, 0, table);
    assert.throws(() => D.previewInvite(f.db, f.tenant, invite.code), status(400));
    assert.ok(f.db.get('SELECT 1 FROM apartments WHERE id=?', f.lease.apartment_id));
    assert.equal(f.db.get('SELECT count(*) n FROM users').n, userCount);
    assert.deepEqual(f.db.all('PRAGMA foreign_key_check'), []);
});

test('Delete: ownership and owner mode are required, including a spoofed role', t => {
    const f = fixture(t), a = fresh(f), p = apartmentDeletionPreview(f.db, f.owner, a.id);
    for (const u of [f.tenant, { ...f.tenant, role: 'owner' }, newUser(f.db, 'Чужой владелец', 'owner')]) {
        assert.throws(() => apartmentDeletionPreview(f.db, u, a.id), status(404));
        assert.throws(() => f.db.tx(() => deleteApartment(f.db, u, a.id, payload(p))), status(404));
    }
    assert.throws(() => apartmentDeletionPreview(f.db, { ...f.owner, role: 'tenant' }, a.id), status(403));
    assert.ok(f.db.get('SELECT 1 FROM apartments WHERE id=?', a.id));
});

test('Delete: confirmation is mandatory; stale apartment or missing snapshot never deletes', t => {
    const f = fixture(t), a = fresh(f);
    for (const confirmed of [undefined, false, 'true', 1]) assert.throws(() => remove(f, a, { confirmed }), status(400));
    assert.throws(() => remove(f, a, { confirmation_token: undefined }), status(409));
    assert.throws(() => remove(f, a, { version: a.version + 1 }), status(409));
    assert.ok(f.db.get('SELECT 1 FROM apartments WHERE id=?', a.id));
});

test('Delete: active residents, including one occupied room, require agreed termination', t => {
    const f = fixture(t), a = fresh(f, { rental_mode: 'rooms' }), l = f.db.get('SELECT * FROM leases WHERE apartment_id=?', a.id);
    f.db.run('INSERT INTO lease_members VALUES(?,?,?)', l.id, f.tenant.id, D.nowISO());
    for (const state of ['active', 'ending']) {
        f.db.run('UPDATE leases SET status=? WHERE id=?', state, l.id);
        const before = snapshot(f.db), p = apartmentDeletionPreview(f.db, f.owner, a.id);
        assert.equal(p.can_delete, false); assert.ok(p.blockers.some(b => b.code === 'active_tenants'));
        assert.throws(() => remove(f, a), status(409)); assert.equal(snapshot(f.db), before);
    }
});

test('Delete: ended rentals with outstanding payments/compensation cannot bypass safeguards', t => {
    const f = fixture(t), a = fresh(f), l = f.db.get('SELECT * FROM leases WHERE apartment_id=?', a.id);
    f.db.run('INSERT INTO lease_members VALUES(?,?,?)', l.id, f.tenant.id, D.nowISO());
    const r = f.db.tx(() => D.createRecord(f.db, f.owner, { lease_id: l.id, kind: 'charge', title: 'Платёж', payload: { amount: 12000, due: '2026-09-05', period: '2026-09' } }, f.config));
    f.db.run("UPDATE leases SET status='ended' WHERE id=?", l.id);
    const p = apartmentDeletionPreview(f.db, f.owner, a.id);
    assert.ok(p.blockers.some(b => b.code === 'unsettled_finances')); assert.throws(() => remove(f, a), status(409));
    assert.ok(f.db.get('SELECT 1 FROM records WHERE id=?', r.id));
});

test('Delete: draft invoices with no tenants/claims may be discarded, real partial payment may not', t => {
    const f = fixture(t), a = fresh(f), l = f.db.get('SELECT * FROM leases WHERE apartment_id=?', a.id);
    const r = f.db.tx(() => D.createRecord(f.db, f.owner, { lease_id: l.id, kind: 'charge', title: 'Черновое начисление', payload: { amount: 10000, due: '2026-09-05', period: '2026-09' } }, f.config));
    assert.equal(apartmentDeletionPreview(f.db, f.owner, a.id).can_delete, true);
    f.db.tx(() => D.actionRecord(f.db, f.owner, r.id, { action: 'record_payment', amount: 500, version: r.version, note: 'Проверка' }));
    assert.equal(apartmentDeletionPreview(f.db, f.owner, a.id).can_delete, false); assert.throws(() => remove(f, a), status(409));
});

test('Delete: new records, invites or uploads after opening confirmation invalidate its snapshot', t => {
    const f = fixture(t), a = fresh(f), l = f.db.get('SELECT * FROM leases WHERE apartment_id=?', a.id);
    let p = apartmentDeletionPreview(f.db, f.owner, a.id);
    f.db.tx(() => D.createInvite(f.db, f.owner, l.id));
    assert.throws(() => f.db.tx(() => deleteApartment(f.db, f.owner, a.id, payload(p))), status(409));
    p = apartmentDeletionPreview(f.db, f.owner, a.id); addFile(f, a);
    assert.throws(() => f.db.tx(() => deleteApartment(f.db, f.owner, a.id, payload(p))), status(409));
    p = apartmentDeletionPreview(f.db, f.owner, a.id);
    f.db.tx(() => D.createRecord(f.db, f.owner, { lease_id: l.id, kind: 'expense', title: 'Новый расход', payload: { amount: 1000, date: '2026-09-27' } }, f.config));
    assert.throws(() => f.db.tx(() => deleteApartment(f.db, f.owner, a.id, payload(p))), status(409));
    assert.ok(f.db.get('SELECT 1 FROM apartments WHERE id=?', a.id));
});

test('Delete: complete related history removed; other apartment and user state stay intact', t => {
    const f = fixture(t), a = fresh(f), l = f.db.get('SELECT * FROM leases WHERE apartment_id=?', a.id);
    f.db.run('INSERT INTO lease_members VALUES(?,?,?)', l.id, f.tenant.id, D.nowISO());
    const fid = addFile(f, a);
    const doc = f.db.tx(() => D.createRecord(f.db, f.owner, { lease_id: l.id, kind: 'document', title: 'Документ', payload: { category: 'act' }, files: [fid] }, f.config));
    f.db.tx(() => D.addComment(f.db, f.tenant, doc.id, { text: 'Запись на удаление' }));
    const meter = f.db.tx(() => D.createMeter(f.db, f.owner, l.id, { label: 'Вода', unit: 'м³', kind: 'cold_water', scope: 'lease', baseline: 0 }));
    f.db.tx(() => D.createRecord(f.db, f.tenant, { lease_id: l.id, kind: 'reading', title: 'Показания', payload: { values: [{ meter_id: meter.meters[0].id, value: 10 }] } }, f.config));
    f.db.run("UPDATE leases SET status='ended' WHERE id=?", l.id);
    const oid = randomUUID();
    f.db.run('INSERT INTO outbox(id,user_id,body,created_at) VALUES(?,?,?,?)', oid, f.tenant.id, JSON.stringify({ recordId: doc.id, title: 'Старое уведомление' }), D.nowISO());
    const unrelated = D.bootstrap(f.db, f.owner, f.config, { coverUrls: false }).records.filter(r => r.apartment_id !== a.id);
    const result = remove(f, a); assert.ok(result.upload_keys.includes(fid));
    assert.equal(f.db.get('SELECT 1 FROM files WHERE id=?', fid), undefined);
    assert.equal(f.db.get('SELECT 1 FROM outbox WHERE id=?', oid), undefined);
    assert.deepEqual(D.bootstrap(f.db, f.owner, f.config, { coverUrls: false }).records, unrelated);
    assert.throws(() => D.recordAccess(f.db, f.tenant, doc.id), status(404));
    assert.deepEqual(f.db.all('PRAGMA foreign_key_check'), []);
});

test('Delete HTTP: success is idempotent, response has no storage keys, other properties unchanged', async t => {
    const f = await httpFixture(t); await f.login('owner'); const a = fresh(f);
    const p = (await f.api(`/api/apartments/${a.id}/deletion-preview`)).data, key = randomUUID();
    const first = await f.api(`/api/apartments/${a.id}/delete`, { method: 'POST', body: payload(p), key });
    assert.equal(first.status, 200); assert.deepEqual(first.data, { ok: true, id: a.id, deleted: true });
    const retry = await f.api(`/api/apartments/${a.id}/delete`, { method: 'POST', body: payload(p), key });
    assert.deepEqual(retry.data, first.data);
    assert.equal((await f.api(`/api/apartments/${a.id}/delete`, { method: 'POST', body: payload(p) })).status, 404);
    const state = (await f.api('/api/state')).data;
    assert.ok(!state.apartments.some(x => x.id === a.id)); assert.ok(state.apartments.some(x => x.id === f.lease.apartment_id));
});

test('Delete HTTP: GET never mutates and missing confirmation/CSRF/session cannot remove', async t => {
    const f = await httpFixture(t); await f.login('owner'); const a = fresh(f), p = apartmentDeletionPreview(f.db, f.owner, a.id);
    assert.equal((await f.api(`/api/apartments/${a.id}/delete`)).status, 404);
    assert.equal((await f.api(`/api/apartments/${a.id}/delete`, { method: 'POST', body: { ...payload(p), confirmed: false } })).status, 400);
    assert.equal((await f.api(`/api/apartments/${a.id}/delete`, { method: 'POST', body: payload(p), headers: { 'X-Keys-Client': '' } })).status, 403);
    assert.equal((await f.api(`/api/apartments/${a.id}/delete`, { method: 'POST', body: payload(p), auth: false })).status, 401);
    await f.login('tenant'); assert.equal((await f.api(`/api/apartments/${a.id}/deletion-preview`)).status, 404);
    assert.ok(f.db.get('SELECT 1 FROM apartments WHERE id=?', a.id));
});

test('Delete HTTP: commit then physical file/cover cleanup; unrelated uploads survive', async t => {
    const f = await httpFixture(t); await f.login('owner'); const a = fresh(f), fid = addFile(f, a), cid = randomUUID();
    writeFileSync(path.join(f.dir, 'uploads', cid), 'fake-cover');
    f.db.run('INSERT INTO apartment_covers VALUES(?,?,?,?,?,?,?,?)', cid, f.owner.id, a.id, 'cover.jpg', 'image/jpeg', 10, cid, D.nowISO());
    f.db.run('UPDATE apartments SET cover_id=? WHERE id=?', cid, a.id);
    const existing = f.db.get('SELECT storage_key FROM files WHERE apartment_id!=? LIMIT 1', a.id).storage_key;
    const p = apartmentDeletionPreview(f.db, f.owner, a.id);
    const r = await f.api(`/api/apartments/${a.id}/delete`, { method: 'POST', body: payload(p) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(existsSync(path.join(f.dir, 'uploads', fid)), false);
    assert.equal(existsSync(path.join(f.dir, 'uploads', cid)), false);
    assert.equal(existsSync(path.join(f.dir, 'uploads', existing)), true);
});

test('Delete HTTP: forced DB error rolls everything back, including attached file access', async t => {
    const f = await httpFixture(t); await f.login('owner'); const a = fresh(f), fid = addFile(f, a);
    f.db.exec(`CREATE TEMP TRIGGER fail_delete BEFORE DELETE ON apartments WHEN OLD.id='${a.id}' BEGIN SELECT RAISE(ABORT,'test deletion failure'); END;`);
    const p = apartmentDeletionPreview(f.db, f.owner, a.id), before = snapshot(f.db);
    const result = await f.api(`/api/apartments/${a.id}/delete`, { method: 'POST', body: payload(p) });
    assert.equal(result.status, 500); assert.equal(snapshot(f.db), before);
    assert.ok(existsSync(path.join(f.dir, 'uploads', fid)));
    assert.deepEqual(f.db.all('PRAGMA foreign_key_check'), []);
});

test('Delete: result remains deleted after reopening the real SQLite database', t => {
    const f = fixture(t), a = fresh(f); remove(f, a); f.db.close();
    const reopened = openDatabase(f.dir);
    try { assert.equal(reopened.get('SELECT 1 FROM apartments WHERE id=?', a.id), undefined); assert.deepEqual(reopened.all('PRAGMA foreign_key_check'), []); }
    finally { reopened.close(); }
});

test('Delete cleanup: retry sweep removes old orphans but preserves referenced/fresh files and symlinks', async t => {
    const f = fixture(t), oldId = randomUUID(), linked = randomUUID(), normal = path.join(f.dir, 'uploads', 'do-not-touch.txt');
    const oldPath = path.join(f.dir, 'uploads', oldId); writeFileSync(oldPath, 'orphan'); writeFileSync(normal, 'keep');
    const refer = f.db.get('SELECT storage_key FROM files WHERE record_id IS NOT NULL LIMIT 1').storage_key;
    symlinkSync(normal, path.join(f.dir, 'uploads', linked));
    await cleanupDeletedUploads(f.db, f.config, ['../do-not-touch.txt', refer]);
    await purgeOrphanUploads(f.db, f.config); assert.ok(existsSync(oldPath));
    await purgeOrphanUploads(f.db, f.config, Date.now() + 2 * 86400000);
    assert.equal(existsSync(oldPath), false); assert.ok(existsSync(normal)); assert.ok(existsSync(path.join(f.dir, 'uploads', refer))); assert.ok(existsSync(path.join(f.dir, 'uploads', linked)));
});

test('Delete UI: one footer only in owner overview, after rooms; no tenant delete control', t => {
    const f = fixture(t), d = D.bootstrap(f.db, f.owner, f.config);
    const state = { data: d, config: { mode: 'test' }, page: 'apartments', aptTab: 'overview', apartmentId: f.lease.apartment_id };
    const html = pageView(state);
    assert.equal((html.match(/data-act="delete-apartment"/g) || []).length, 1);
    assert.ok(html.indexOf('apartment-danger-zone') > html.indexOf('Что сдаётся'));
    assert.ok(!pageView({ ...state, aptTab: 'contract' }).includes('apartment-danger-zone'));
    assert.ok(!pageView({ ...state, data: D.bootstrap(f.db, f.tenant, f.config) }).includes('data-act="delete-apartment"'));
});

test('Delete UI: escaped title/address, explicit question and safe cancel, blocked preview has no submit', t => {
    const f = fixture(t), a = fresh(f, { title: '<b>Нежелательная разметка</b>' }), p = apartmentDeletionPreview(f.db, f.owner, a.id);
    const html = apartmentDeleteDialog(p);
    assert.match(html, /Вы уверены/); assert.match(html, /&lt;b&gt;/); assert.match(html, /data-delete-cancel/); assert.match(html, /data-delete-confirm/);
    assert.ok(!apartmentDeleteDialog({ ...p, can_delete: false, blockers: [{ message: 'Завершите аренду' }] }).includes('type="submit"'));
    assert.match(apartmentDeleteFooter(a), /data-act="delete-apartment"/);
});

test('Delete UI: after-success state reset preserves other properties, account and guide progress', t => {
    const f = fixture(t), a = fresh(f), data = D.bootstrap(f.db, f.owner, f.config), updated = withoutApartment(data, a.id);
    assert.equal(updated.user, data.user); assert.equal(updated.people, data.people);
    assert.equal(data.apartments.length, updated.apartments.length + 1);
    assert.ok(!updated.leases.some(l => l.apartment_id === a.id)); assert.ok(updated.apartments.some(x => x.id === f.lease.apartment_id));
});

test('Delete: removing the last property produces a clean owner empty state', t => {
    const f = fixture(t), u = newUser(f.db, 'Новый собственник', 'owner');
    const a = f.db.tx(() => D.createApartment(f.db, u, apartmentInput));
    const p = apartmentDeletionPreview(f.db, u, a.id);
    f.db.tx(() => deleteApartment(f.db, u, a.id, payload(p)));
    const data = D.bootstrap(f.db, u, f.config);
    assert.equal(data.apartments.length, 0); assert.equal(data.leases.length, 0);
    assert.equal(data.units.length, 0); assert.equal(data.records.length, 0); assert.equal(data.recurring_rules.length, 0);
    const html = pageView({ data, config: { mode: 'test' }, page: 'home' });
    assert.match(html, /Добавьте первую квартиру/); assert.ok(!html.includes('data-act="delete-apartment"'));
});
