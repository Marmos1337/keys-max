import test from 'node:test';
import assert from 'node:assert/strict';
import { displayName, joinOrder, nameIn } from '../public/people.js';

const people = [{ id: 'b', name: 'Саня' }, { id: 'a', name: 'Саня', handle: 'sanya_p' }, { id: 'c', name: 'Саня' }, { id: 's', name: 'Степан' }];
const order = joinOrder([{ user_id: 'c', joined_at: '2026-06-03' }, { user_id: 'a', joined_at: '2026-06-01' }, { user_id: 'b', joined_at: '2026-06-02' }]);

test('the viewer is «Вы»', () => {
    assert.equal(displayName(people, 's', { id: 's' }), 'Вы');
    assert.equal(displayName(people, 's', { id: 's', self: 'вы' }), 'вы');
});
test('a unique name stays as is', () => assert.equal(displayName(people, 'a', { id: 's' }), 'Степан'));
test('namesakes: @handle first, else the ordinal by join order', () => {
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(displayName(people, 's', { id: 'a', order }), 'Саня @sanya_p');
    assert.equal(displayName(people, 's', { id: 'b', order }), 'Саня 2');
    assert.equal(displayName(people, 's', { id: 'c', order }), 'Саня 3');
});
test('unknown person gets the fallback', () => assert.equal(displayName(people, 's', { id: 'x', fallback: 'Жилец' }), 'Жилец'));
test('nameIn reads the app state', () => {
    const d = { user: { id: 'a' }, people, members: [{ user_id: 'b', joined_at: '1' }, { user_id: 'c', joined_at: '2' }] };
    assert.equal(nameIn(d, 'a'), 'Вы');
    assert.equal(nameIn(d, 'c'), 'Саня 2'); // a never joined a lease, so b and c come first
});
