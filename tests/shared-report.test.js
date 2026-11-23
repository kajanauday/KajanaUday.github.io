// Run with: node --test tests/shared-report.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.SharedLedger = require('../shared-ledger.js');
require('../data-layer.js');
const { ExpenseStore } = globalThis;

// A store with just what the report needs: entries, settlements, a database that records its writes.
function fake({ rows = [], settles = [], stored = null } = {}) {
  const store = Object.create(ExpenseStore.prototype);
  const writes = [];
  Object.assign(store, {
    transactions: rows, writes: Promise.resolve(),
    db: { readOnly: false, patch: async update => { writes.push(update); return null; }, get: async () => stored },
    ensureAllYears: async () => {},
    realSettleList: () => settles, settleList: () => settles, repayRegistry: () => [],
    fullAmount: row => Math.abs(Number(row.amount))
  });
  return { store, writes };
}
const row = (sid, date, amount, by, series, who = 'Sairam') => ({ id: `r-${sid}`, sid, date, amount, property: 'INR', description: `Item ${sid}`, series, shared: { by, his: 50, with: who } });

test('one report per person and currency, with what is open on every entry', async () => {
  const { store, writes } = fake({ rows: [row('a', '2026-10-02', 2000, 'me', { id: 's1', colour: '#2563eb' }), row('b', '2026-10-09', 600, 'friend', { id: 's1', colour: '#2563eb' }), row('c', '2026-11-03', 1000, 'me', { id: 's2', colour: '#7c3aed' }, 'Ravi')] });
  await store.refreshSharedReport();
  assert.equal(writes.length, 1);
  const paths = Object.keys(writes[0]).sort();
  assert.deepEqual(paths, ['sharedReport/INR/Ravi', 'sharedReport/INR/Sairam']);
  const sairam = writes[0]['sharedReport/INR/Sairam'];
  assert.equal(sairam.overall, 700);           // he owes 1000, I owe 300
  assert.equal(sairam.entries.find(entry => entry.id === 'a').owed, 1000);
  assert.equal(sairam.closed.length, 0);                 // nothing settled yet
  assert.equal(sairam.entries.every(entry => entry.closedBy === ''), true);
  assert.ok(sairam.updated);
});

test('a second refresh with nothing changed writes nothing', async () => {
  const { store, writes } = fake({ rows: [row('a', '2026-10-02', 2000, 'me', { id: 's1', colour: '#2563eb' })] });
  await store.refreshSharedReport();
  await store.refreshSharedReport();
  assert.equal(writes.length, 1);
});

test('a settlement changes only that person, and closes what it paid off into a box of its own', async () => {
  const rows = [row('a', '2026-10-02', 2000, 'me', { id: 's1', colour: '#2563eb' }), row('c', '2026-11-03', 1000, 'me', { id: 's2', colour: '#7c3aed' }, 'Ravi')];
  const settles = [];
  const { store, writes } = fake({ rows, settles });
  await store.refreshSharedReport();
  settles.push({ id: 'st1', date: '2026-12-01', property: 'INR', with: 'Sairam', year: 2026, items: [{ to: 'a', a: 1000 }], cash: 1000, forgiven: 0, treatment: 'none' });
  await store.refreshSharedReport();
  assert.equal(writes.length, 2);
  assert.deepEqual(Object.keys(writes[1]), ['sharedReport/INR/Sairam']);
  const node = writes[1]['sharedReport/INR/Sairam'];
  assert.equal(node.overall, 0);
  assert.deepEqual(node.closed.map(box => [box.id, box.moved, box.last, box.count]), [['st1', 1000, '2026-12-01', 1]]);
  assert.equal(node.entries.find(entry => entry.id === 'a').closedBy, 'st1');
  assert.equal(node.settles[0].year, undefined);
});

test('a person with nothing left is taken away', async () => {
  const rows = [row('a', '2026-10-02', 2000, 'me', { id: 's1', colour: '#2563eb' })];
  const { store, writes } = fake({ rows });
  await store.refreshSharedReport();
  rows.length = 0;
  await store.refreshSharedReport();
  assert.deepEqual(writes[1], { 'sharedReport/INR/Sairam': null });
});

test('loading reads the stored reports and works nothing out', async () => {
  const built = fake({ rows: [row('a', '2026-10-02', 2000, 'me', { id: 's1', colour: '#2563eb' })] });
  await built.store.refreshSharedReport();
  const saved = built.writes[0]['sharedReport/INR/Sairam'];
  let rebuilt = false;
  const { store } = fake({ stored: { INR: { Sairam: saved } } });
  store.refreshSharedReport = async () => { rebuilt = true; };
  globalThis.localStorage = { getItem: key => (key === 'kajanauday-shared-report' ? '1' : null), setItem() {}, removeItem() {} };
  await store.loadSharedReport();
  delete globalThis.localStorage;
  assert.equal(rebuilt, false);
  assert.equal(store.sharedReportPeople()[0].name, 'Sairam');
  assert.equal(store.sharedReportPeople()[0].node.overall, 1000);
});

test('each settlement closes its own entries, and entries still open stay out of every settled box', async () => {
  const rows = [row('a', '2026-10-02', 2000, 'me', null), row('b', '2026-10-09', 2000, 'me', null), row('c', '2026-11-03', 2000, 'me', null)];
  const settles = [
    { id: 'st1', date: '2026-10-20', property: 'INR', with: 'Sairam', items: [{ to: 'a', a: 1000 }], cash: 1000, forgiven: 0, treatment: 'none' },
    { id: 'st2', date: '2026-11-20', property: 'INR', with: 'Sairam', items: [{ to: 'b', a: 1000 }, { to: 'c', a: 400 }], cash: 1400, forgiven: 0, treatment: 'none' }
  ];
  const { store, writes } = fake({ rows, settles });
  await store.refreshSharedReport();
  const node = writes[0]['sharedReport/INR/Sairam'];
  assert.deepEqual(node.closed.map(box => [box.id, box.moved, box.count]).sort(), [['st1', 1000, 1], ['st2', 1000, 1]]);
  assert.equal(node.entries.find(entry => entry.id === 'c').closedBy, '');     // still open: 600 left
  assert.equal(node.entries.find(entry => entry.id === 'c').owed, 600);
});

test('an entry made a settlement for several expenses gathers them into one settled box', async () => {
  const rows = [row('a', '2026-10-02', 2000, 'me', null), row('b', '2026-10-09', 1000, 'me', null), row('c', '2026-11-03', 4000, 'me', null)];
  const { store, writes } = fake({ rows });
  // What the store works out from one entry in a repayment place: one settlement over every expense it covers.
  store.settleList = () => [{ id: 'rp:1', date: '2026-10-20', property: 'INR', with: 'Sairam', items: [{ to: 'a', a: 1000 }, { to: 'b', a: 500 }], cash: 1500 }];
  await store.refreshSharedReport();
  const node = writes[0]['sharedReport/INR/Sairam'];
  assert.deepEqual(node.closed.map(box => [box.id, box.moved, box.count]), [['rp:1', 1500, 2]]);
  assert.deepEqual(node.entries.filter(entry => entry.closedBy === 'rp:1').map(entry => entry.id).sort(), ['a', 'b']);
  assert.equal(node.entries.find(entry => entry.id === 'c').owed, 2000);         // not covered: stays in the running box
});

test('the report carries each entry\'s comment, long description and notes', async () => {
  const withNotes = { ...row('a', '2026-10-02', 2000, 'me', null), place: 'at the lake', about: 'Weekend trip, split with the group' };
  const note = { id: 'n1', parentId: withNotes.id, date: '2026-10-03', description: 'Boat', amount: 800, place: '' };
  const { store, writes } = fake({ rows: [withNotes, note] });
  await store.refreshSharedReport();
  const entry = writes[0]['sharedReport/INR/Sairam'].entries[0];
  assert.equal(entry.place, 'at the lake');
  assert.equal(entry.about, 'Weekend trip, split with the group');
  assert.deepEqual(entry.notes.map(item => [item.id, item.description, item.amount]), [['n1', 'Boat', 800]]);
});

test('what they owe me and what I owe them settle as one unit: one box, the net is what moved', async () => {
  const rows = [row('a', '2026-10-02', 1000, 'me', null), row('b', '2026-10-09', 600, 'friend', null)];   // they owe me 500, I owe them 300
  const settles = [{ id: 'st1', date: '2026-10-20', property: 'INR', with: 'Sairam', items: [{ to: 'a', a: 500 }, { to: 'b', a: 300 }], cash: 200, forgiven: 0, treatment: 'none' }];
  const { store, writes } = fake({ rows, settles });
  await store.refreshSharedReport();
  const node = writes[0]['sharedReport/INR/Sairam'];
  assert.deepEqual(node.closed.map(box => [box.id, box.moved, box.count]), [['st1', 200, 2]]);
  assert.equal(node.overall, 0);
  assert.equal(node.entries.every(entry => entry.closedBy === 'st1'), true);
});

test('a settlement paid with a ledger entry carries the name of that entry, and nothing under it', async () => {
  const rows = [row('a', '2026-10-02', 1000, 'me', null)];
  const paid = { id: 'p1', date: '2026-10-20', property: 'INR', section: 'Expenses', category: 'REPAYMENTS', description: 'to Sairam', amount: 1000, type: 'expense' };
  const settles = [{ id: 'st1', date: '2026-10-20', property: 'INR', with: 'Sairam', items: [{ to: 'a', a: 500 }], cash: -500, via: 'sig-1' }];
  const { store, writes } = fake({ rows: [...rows, paid], settles });
  store.repaySignature = item => (item.id === 'p1' ? 'sig-1' : `other-${item.id}`);
  store.entryTotal = () => 1000;
  await store.refreshSharedReport();
  const settle = writes[0]['sharedReport/INR/Sairam'].settles[0];
  assert.equal(settle.entry.description, 'to Sairam');
  assert.equal(settle.entry.notes, undefined);
  assert.equal(settle.entry.total, undefined);
});

test('renaming a person changes every shared entry, settlement and repayment place, and the report follows', async () => {
  const rows = [row('a', '2026-10-02', 2000, 'me', null), row('b', '2026-10-09', 600, 'friend', null, 'Ravi')];
  const years = { 2026: { settles: { st1: { id: 'st1', date: '2026-10-20', property: 'INR', with: 'Sairam', items: [{ to: 'a', a: 500 }], cash: 500 } }, repay: [{ property: 'INR', with: 'Sairam', section: 'Expenses' }, { property: 'INR', with: 'Ravi', section: 'Other' }] } };
  const { store, writes } = fake({ rows });
  store.years = years;
  store.realSettleList = () => Object.entries(years[2026].settles).map(([id, settle]) => ({ ...settle, id, year: 2026 }));
  store.settleList = () => store.realSettleList();
  store.repayRegistry = () => years[2026].repay;
  await store.refreshSharedReport();
  assert.deepEqual(Object.keys(writes[0]).sort(), ['sharedReport/INR/Ravi', 'sharedReport/INR/Sairam']);
  const done = store.renamePerson('Sairam', 'Sai');
  assert.deepEqual(done, { entries: 1, settles: 1 });
  assert.equal(rows[0].shared.with, 'Sai');
  assert.equal(years[2026].settles.st1.with, 'Sai');
  assert.deepEqual(years[2026].repay.map(target => target.with), ['Sai', 'Ravi']);
  await store.writes;
  assert.equal(writes[1]['years/2026/settles/st1/with'], 'Sai');
  await store.refreshSharedReport();
  const last = writes[writes.length - 1];
  assert.equal(last['sharedReport/INR/Sairam'], null);                  // the old name's report is taken away
  assert.equal(last['sharedReport/INR/Sai'].with, 'Sai');               // and the new name has it
  assert.equal(last['sharedReport/INR/Sai'].settles[0].with, 'Sai');
});

// ---- a capsule is made only when a settlement says "close permanently" ----
const pay = (id, date, items, cash, extra = {}) => ({ id, date, property: 'INR', with: 'Sairam', items, cash, forgiven: 0, treatment: 'none', closes: false, ...extra });
const nodeOf = async (rows, settles) => { const { store, writes } = fake({ rows, settles }); await store.refreshSharedReport(); return writes[0]['sharedReport/INR/Sairam']; };

test('paying an item in full does not make a capsule: it stays in the list, marked paid', async () => {
  const node = await nodeOf([row('a', '2026-10-02', 2000, 'me', null), row('b', '2026-10-09', 2000, 'me', null)], [pay('st1', '2026-10-20', [{ to: 'a', a: 1000 }, { to: 'b', a: 400 }], 1400)]);
  assert.deepEqual(node.closed, []);
  assert.deepEqual(node.entries.map(entry => [entry.id, entry.owed, entry.paid, entry.closedBy]), [['a', 0, 1000, ''], ['b', 600, 400, '']]);
});

test('"close permanently" captures everything paid in full by then, including items paid by earlier payments', async () => {
  const rows = [row('a', '2026-10-02', 2000, 'me', null), row('b', '2026-10-09', 2000, 'me', null), row('c', '2026-11-03', 2000, 'me', null)];
  const node = await nodeOf(rows, [pay('st1', '2026-10-20', [{ to: 'a', a: 1000 }], 1000), pay('st2', '2026-11-01', [{ to: 'b', a: 1000 }], 1000, { closes: true })]);
  assert.deepEqual(node.closed.map(box => [box.id, box.moved, box.count]), [['st2', 2000, 2]]);
  assert.equal(node.entries.find(entry => entry.id === 'a').closedBy, 'st2');
  assert.equal(node.entries.find(entry => entry.id === 'c').closedBy, '');        // still open: not in the capsule
});

test('a payment made after the closing is not in that capsule', async () => {
  const rows = [row('a', '2026-10-02', 2000, 'me', null), row('b', '2026-10-09', 2000, 'me', null)];
  const node = await nodeOf(rows, [pay('st1', '2026-10-20', [{ to: 'a', a: 1000 }], 1000, { closes: true }), pay('st2', '2026-10-25', [{ to: 'b', a: 1000 }], 1000)]);
  assert.deepEqual(node.closed.map(box => [box.id, box.count]), [['st1', 1]]);
  assert.equal(node.entries.find(entry => entry.id === 'b').closedBy, '');          // paid, waiting for the next closing
});

test('closing with no payment of its own (the Close button) captures what is already paid', async () => {
  const rows = [row('a', '2026-10-02', 2000, 'me', null)];
  const node = await nodeOf(rows, [pay('st1', '2026-10-20', [{ to: 'a', a: 1000 }], 1000), { id: 'st2', date: '2026-10-21', property: 'INR', with: 'Sairam', items: [], cash: 0, closes: true }]);
  assert.deepEqual(node.closed.map(box => [box.id, box.moved, box.count]), [['st2', 1000, 1]]);
});
