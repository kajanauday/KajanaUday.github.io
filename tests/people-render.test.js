// Run with: node --test tests/people-render.test.js
// Draws the People page's boxes with the real functions from kajanauday.js against stub surroundings (running, held-ahead and settled boxes, the
// edit, rename and notes states), so a reference error in them shows here and not in the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'kajanauday.js'), 'utf8');
const grab = name => { const m = src.match(new RegExp(`\\n    (?:async )?function ${name}\\(`)); if (!m) throw new Error('missing ' + name); let i = m.index + 1; const end = src.indexOf('\n    }\n', i); return src.slice(i, end + 7); };
const names = ['sharedEntryRow', 'ppRowFormHtml', 'ppEntryDetailHtml', 'sharedEntryList', 'ppPaymentRows', 'sharedBoxHtml'];
const SL = require('../shared-ledger.js');
const ctx = vm.createContext({ SharedLedger: SL, console });
vm.runInContext(`
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const sharedMoney = (m) => (Math.abs(m)/100).toFixed(2);
  const regions = { jpy: { code: 'JPY', color: 'japan' } };
  let isViewer = false;
  const ppState = { order: 'date', open: new Set(), notesOpen: new Set(), editing: '', noteEdit: '', adding: '', renaming: '', key: null, ticked: new Set(), box: new Map() };
  const store = { sharedReportPeople: () => [], repayTargets: () => [] };
  const ppAddPaneHtml = () => '<form class="pp-add"></form>';
  const repayLabel = () => '';
  const ppDay = date => { const [y, m, d] = String(date).split('-'); return !y || !m || !d ? String(date || '') : d === '00' ? '—' : d + '.' + m + '.' + y.slice(-2); };
  const ExpenseStore = {};
  ${names.map(grab).join('\n')}
  globalThis.run = { sharedBoxHtml, ppState };
`, ctx);
const { sharedBoxHtml, ppState } = ctx.run;
const entry = (id, by, owed, over = {}) => ({ id, date: '2026-10-30', amount: 1000, paidBy: by, hisPct: 50, shared: true, description: 'Dinner', owed, closedBy: '', place: '', about: '', notes: [], ...over });
const empty = { receivable: [], payable: [], receivableTotal: 0, payableTotal: 0, net: 0, buffer: 0, overall: 0 };
const ok = (label, html, ...must) => test(label, () => { must.forEach(part => assert.ok(html.includes(part), `missing ${part}`)); });
// 1. a running box with open entries
const e1 = entry('a', 'me', 500), e2 = entry('b', 'friend', 300, { place: 'cab', notes: [{ id: 'n1', date: '2026-10-30', description: 'Fare', place: '', amount: 300 }], about: 'x' });
const running = { key: 'jpy|Sairam', property: 'jpy', name: 'Sairam', bundle: { entries: [e1, e2], settles: [], pending: { ...empty, receivable: [{ id: 'a', entry: e1, owed: 500, direction: 'friend-owes-me' }], payable: [{ id: 'b', entry: e2, owed: 300, direction: 'i-owe-friend' }], receivableTotal: 500, payableTotal: 300, net: 200, overall: 200 } } };
ok('running box', sharedBoxHtml(running, { entries: [e1, e2], series: [] }), 'data-settle-pick', 'data-add-open', 'data-rename-open', 'Dinner');
// 2. held-ahead box (nothing open, money held)
const held = { key: 'jpy|Sai', property: 'jpy', name: 'Sai', bundle: { entries: [], settles: [{ id: 's1', date: '2026-10-31', credit: -3576900, note: 'rent was changed' }], pending: { ...empty, buffer: -3576900, overall: 3576900 } } };
ok('held box', sharedBoxHtml(held, { entries: [], series: [] }), 'pp-held', 'data-held-clear="jpy|Sai"', 'rent was changed');
// 3. settled box with a payment: a plain repayment row (date, name, cash), nothing under it
const c1 = entry('c', 'me', 0, { closedBy: 's2' }), c2 = entry('d', 'friend', 0, { closedBy: 's2' });
const settle = { id: 's2', date: '2026-10-31', cash: -200, items: [{ to: 'c', a: 500 }, { to: 'd', a: 700 }], entry: { description: 'to Sairam', date: '2026-10-31' } };
const settledHtml = sharedBoxHtml({ ...running, bundle: { entries: [c1, c2], settles: [settle], pending: empty } }, { entries: [c1, c2], series: [{ id: 's2', moved: -200, last: '2026-10-31', settles: [settle] }], readonly: true });
ok('settled box', settledHtml, 'to Sairam', 'is-pay');
test('a payment is only a repayment: no parts hang under it', () => {
  assert.ok(!settledHtml.includes('pp-row-detail'));
  assert.ok(!settledHtml.includes('counted'));
  assert.ok(!settledHtml.includes('data-notes-toggle="pay:'));
});
ppState.editing = 'a';
ok('inline edit form', sharedBoxHtml(running, { entries: [e1, e2], series: [] }), 'pp-row-form', 'data-edit-delete');
ppState.editing = ''; ppState.renaming = 'jpy|Sairam';
ok('rename form', sharedBoxHtml(running, { entries: [e1, e2], series: [] }), 'pp-rename');
ppState.renaming = ''; ppState.notesOpen.add('b'); 
ok('notes open', sharedBoxHtml(running, { entries: [e1, e2], series: [] }), 'pp-row-detail', 'Fare');

// A part payment ("settle only", nothing ticked) clears no item completely, so no settled box shows it: the running box must.
test('a running box lists the part payments made so far', () => {
  const open = entry('o', 'me', 700, { description: 'Trip' });
  const part = { id: 'pp1', date: '2026-11-02', cash: 3000, items: [{ to: 'o', a: 300 }], entry: { description: 'from Sairam', total: 300, notes: [] } };
  const box = { key: 'jpy|Sairam', property: 'jpy', name: 'Sairam', bundle: { entries: [open], settles: [part], pending: { ...empty, receivable: [{ id: 'o', entry: open, owed: 700, direction: 'friend-owes-me' }], receivableTotal: 700, net: 700, overall: 700 } } };
  const html = sharedBoxHtml(box, { entries: [open], series: [] });
  assert.ok(html.includes('is-pay'), 'the payment has a row');
  assert.ok(html.includes('from Sairam'));
});

test('an item paid in full stays in the running box with its share and no status, and a Close button offers the capsule', () => {
  const paidIn = entry('p', 'me', 0, { description: 'Rent', paid: 500 });
  const box = { key: 'jpy|Sairam', property: 'jpy', name: 'Sairam', bundle: { entries: [paidIn], settles: [], pending: empty } };
  const html = sharedBoxHtml(box, { entries: [paidIn], series: [] });
  assert.ok(html.includes('Rent'));
  assert.ok(html.includes('<b>5.00</b>'), 'the row shows its share (half of 10.00)');
  assert.ok(!html.includes('paid in full') && !html.includes('paid of'), 'no paid statuses on rows');
  assert.ok(html.includes('data-close-box="jpy|Sairam"'));
});

test('a part-paid row still shows its whole share, not what is left', () => {
  const part = entry('q', 'me', 300, { description: 'Trip', paid: 200 });
  const box = { key: 'jpy|Sairam', property: 'jpy', name: 'Sairam', bundle: { entries: [part], settles: [], pending: { ...empty, receivable: [{ id: 'q', entry: part, owed: 300, direction: 'friend-owes-me' }], receivableTotal: 300, net: 300, overall: 300 } } };
  const html = sharedBoxHtml(box, { entries: [part], series: [] });
  assert.ok(html.includes('<b>5.00</b>'), 'the share, 5.00, not the 3.00 left');
  assert.ok(!html.includes('paid of'));
  assert.ok(!html.includes('data-close-box'), 'no Close while something is open');
});

test('the header adds up what each of us put in: shares plus the cash each gave', () => {
  const mine = entry('m', 'me', 500, { amount: 10000, hisPct: 50 });           // I paid 100.00: their share is 50.00
  const theirs = entry('t', 'friend', 300, { amount: 6000, hisPct: 0 });       // they paid 60.00: my share is all of it, 60.00
  const gave = { id: 'g1', date: '2026-11-21', cash: 3000, items: [{ to: 'm', a: 3000 }] };   // they gave me 30.00 on account
  const box = { key: 'jpy|Sairam', property: 'jpy', name: 'Sairam', bundle: { entries: [mine, theirs], settles: [gave], pending: { ...empty, receivable: [{ id: 'm', entry: mine, owed: 2000, direction: 'friend-owes-me' }], payable: [{ id: 't', entry: theirs, owed: 6000, direction: 'i-owe-friend' }], receivableTotal: 2000, payableTotal: 6000, net: -4000, overall: -4000 } } };
  const html = sharedBoxHtml(box, { entries: [mine, theirs], series: [] });
  assert.ok(html.includes('50.00</span>'), 'I put 50.00 (their share of what I paid)');
  assert.ok(html.includes('90.00</span>'), 'they put 90.00: 60.00 on their expenses + 30.00 paid to me');
  assert.ok(html.includes('I put <b>50.00</b>'));
  assert.ok(html.includes('Sairam put <b>90.00</b>'));
  assert.ok(html.includes('60.00 on Sairam’s expenses + 30.00 paid to me'));
});

test('a settled box offers Reopen', () => {
  const c1 = entry('c', 'me', 0, { closedBy: 's2' });
  const settle = { id: 's2', date: '2026-10-31', cash: 500, items: [{ to: 'c', a: 500 }] };
  const box = { key: 'jpy|Sairam', property: 'jpy', name: 'Sairam', bundle: { entries: [c1], settles: [settle], pending: empty } };
  const html = sharedBoxHtml(box, { entries: [c1], series: [{ id: 's2', moved: 500, last: '2026-10-31', settles: [settle] }], readonly: true });
  assert.ok(html.includes('data-reopen-capsule="s2"'));
});

test('rows can be sorted by amount, largest or smallest first', () => {
  const small = entry('s', 'me', 100, { description: 'Small one', amount: 1000, date: '2026-10-30' });    // their share 5.00
  const big = entry('b', 'me', 100, { description: 'Big one', amount: 9000, date: '2026-10-01' });       // their share 45.00
  const box = { key: 'jpy|Sairam', property: 'jpy', name: 'Sairam', bundle: { entries: [small, big], settles: [], pending: { ...empty, receivable: [{ id: 's', entry: small, owed: 500, direction: 'friend-owes-me' }, { id: 'b', entry: big, owed: 4500, direction: 'friend-owes-me' }], receivableTotal: 5000, net: 5000, overall: 5000 } } };
  const at = (html, text) => html.indexOf(text);
  ppState.order = 'amount-desc';
  let html = sharedBoxHtml(box, { entries: [small, big], series: [] });
  assert.ok(at(html, 'Big one') < at(html, 'Small one'), 'largest first');
  ppState.order = 'amount-asc';
  html = sharedBoxHtml(box, { entries: [small, big], series: [] });
  assert.ok(at(html, 'Small one') < at(html, 'Big one'), 'smallest first');
  ppState.order = 'date';
  html = sharedBoxHtml(box, { entries: [small, big], series: [] });
  assert.ok(at(html, 'Small one') < at(html, 'Big one'), 'by date: the newer one first');
});
