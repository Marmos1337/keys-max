import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { surface, listItem, statCard, segmented, actionTile, navigationRow, pageTone, navPage } from '../public/ui.js';
import { button, icon, notice, kindColor } from '../public/utils.js';
import { pageView, shell } from '../public/views.js';
import { fixture } from './helpers.mjs';
import * as D from '../server/domain.mjs';

const state = (f, user, page, extra = {}) => ({ data: D.bootstrap(f.db, user, f.config), config: { mode: 'demo' }, screen: 'app', page, scope: 'all', filter: 'all', ...extra });

test('Shared button is not an implicit form submit and keeps action identifiers', () => {
  const html = button('Добавить', 'new-record', 'data-kind="ticket"', 'secondary');
  assert.match(html, /type="button"/);
  assert.match(html, /class="btn secondary"/);
  assert.match(html, /data-act="new-record"/);
  assert.match(html, /data-tone="purple"/);
});
test('Icon-only edit has an accessible name and the same button component', () => {
  const html = button(icon('edit', 16), 'edit-unit', 'data-id="a"', 'ghost');
  assert.match(html, /btn-icon/);
  assert.match(html, /aria-label="Изменить название комнаты"/);
});
test('Pill tabs escape user labels, mark one pressed button, keep data routes', () => {
  const html = segmented([['a','<Новая>'],['b','Вторая']], 'a', { act: 'apartment-select', key: 'id', label: 'Выбор квартиры', tone: 'blue' });
  assert.ok(!html.includes('<Новая>'));
  assert.ok(html.includes('&lt;Новая&gt;'));
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(html, /data-act="apartment-select" data-id="a"/);
  assert.match(html, /data-ui="segmented" data-tone="blue"/);
});
test('Cards, rows and statistics share a single surface family', () => {
  assert.match(surface('Test'), /class="surface /);
  assert.match(listItem({ act: 'open-record', content: '<span>Test</span>' }), /surface ui-row/);
  assert.match(statCard({ label: 'Квартир', value: 3, tone: 'blue' }), /surface stat-card/);
  assert.match(navigationRow('Помощь', 'help'), /surface ui-row info-row plain/);
});
test('Domain tile and hint use identical colour tokens rather than inline colours', () => {
  const tile = actionTile({ title: 'Покупка', name: 'bag', tone: 'orange', act: 'new-record', attrs: 'data-kind="purchase"' });
  assert.match(tile, /class="quick orange" data-tone="orange"/);
  assert.match(notice('Готово', 'green'), /data-tone="green"/);
  assert.ok(!tile.includes('style='));
  assert.equal(kindColor.ticket, 'purple');
  assert.equal(kindColor.charge, 'green');
});
test('Detailed records retain the correct parent navigation and semantic tone', () => {
  for (const [kind, page, tone] of [['ticket','requests','purple'],['charge','finances','green'],['expense','finances','green'],['document','documents','slate'],['reading','apartments','amber'],['visit','apartments','teal']]) {
    const s = { page: 'record', recordId: 'r', data: { records: [{ id:'r', kind }] } };
    assert.equal(navPage(s), page); assert.equal(pageTone(s), tone);
  }
});
test('Owner apartment pills, section tabs and repeated room actions use the common components', t => {
  const f = fixture(t), html = pageView(state(f, f.owner, 'apartments'));
  assert.match(html, /data-ui="segmented" data-tone="blue" role="group" aria-label="Выбор квартиры"/);
  assert.match(html, /aria-label="Разделы квартиры"/);
  assert.match(html, /data-act="new-unit" data-tone="blue"/);
  assert.ok(!html.includes('Вся история'));
});
test('Lists keep their actual records while reusing the shared row surface', t => {
  const f = fixture(t), html = pageView(state(f, f.owner, 'requests'));
  assert.match(html, /surface ui-row record-card/);
  assert.match(html, /data-id="/);
  assert.match(html, /aria-pressed="true"/);
});
test('Desktop and mobile nav each have one accessible current item on a record page', t => {
  const f = fixture(t), r = f.create('ticket', { description:'Ремонт', room:'Кухня' });
  const s = state(f, f.tenant, 'record', { recordId:r.id });
  const html = shell(s, pageView(s));
  assert.equal((html.match(/aria-current="page"/g) || []).length, 2);
  assert.match(html, /class="app-shell" data-tone="purple"/);
});
test('Dark theme is token-based; no late white-rectangle or purple-unread overrides', () => {
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes(':root[data-theme="dark"]'));
  assert.ok(!/\[data-theme[=][^\]]+\]\s+:is/.test(css));
  assert.match(css, /\.notification-row\.unread \{ background: var\(--card\); \}/);
  assert.match(css, /\.btn\.secondary \{ background: var\(--tone-soft\)/);
  assert.match(css, /prefers-reduced-motion/);
});
