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
  assert.equal(sairam.series.length, 1);
  assert.ok(sairam.updated);
});

test('a second refresh with nothing changed writes nothing', async () => {
  const { store, writes } = fake({ rows: [row('a', '2026-10-02', 2000, 'me', { id: 's1', colour: '#2563eb' })] });
  await store.refreshSharedReport();
  await store.refreshSharedReport();
  assert.equal(writes.length, 1);
});

test('a settlement changes only that person, and settles the series', async () => {
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
  assert.equal(node.series[0].settled, true);
  assert.equal(node.series[0].moved, 1000);
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
