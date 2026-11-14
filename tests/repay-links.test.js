// Run with: node --test tests/repay-links.test.js
// A repayment entry keeps what it paid when it changes (a new note, an edit), and finds it again if it already lost it.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../shared-ledger.js');
require('../data-layer.js');
const { ExpenseStore } = globalThis;

async function make(settles) {
  const writes = [];
  const docs = { '2026_January': { JPY: { income: [{ category: 'Back', total: 10000, count: 1, entries: [{ day: 5, description: 'Repaid', place: '', amount: 10000, section: 'Sairam', notes: [] }] }] } } };
  const db = { get: async path => docs[path.replace('months/', '')] || null, patch: async update => { writes.push(update); } };
  const years = { 2026: { currencies: { JPY: { from: 'January' } }, monthSections: { '2026_January': { JPY: { own: true, sections: [{ name: 'Sairam', type: 'income', subsections: ['Back'] }] } } }, monthConfig: {}, months: {}, settles, metadata: { entries: 0 } } };
  const store = new ExpenseStore({ db, currencies: { JPY: { code: 'JPY' } }, years });
  await store.ensureYear(2026);
  return { store, writes };
}
const settle = via => ({ s1: { date: '2026-01-05', property: 'JPY', with: 'Sairam', items: [{ to: 'x', a: 6000 }], cash: 6000, forgiven: 0, treatment: 'none', via, link: true } });

test('a payment added to the repayment entry as a note keeps what it already paid', async () => {
  const { store, writes } = await make(settle('2026-01-05|Repaid|10000'));
  const entry = store.transactions.find(item => item.description === 'Repaid');
  store.syncRepayFlags();
  assert.equal(store.payerStats(entry).used, 6000);
  store.transactions.push({ id: 'n1', parentId: entry.id, property: 'JPY', type: 'income', section: 'Sairam', category: 'Back', date: entry.date, description: 'more', amount: 4000 });
  store.transactions.push({ id: 'n0', parentId: entry.id, property: 'JPY', type: 'income', section: 'Sairam', category: 'Back', date: entry.date, description: 'first', amount: 10000 });
  assert.equal(store.repaySignature(entry), '2026-01-05|Repaid|14000');
  assert.equal(store.payerStats(entry).used, 0); // the old signature no longer matches…
  await store.saveTransactions();
  assert.equal(store.payerStats(entry).used, 6000); // …until the save moves the link with the entry
  assert.equal(store.payerStats(entry).balance, 8000);
  assert.equal(writes.flatMap(update => Object.entries(update)).find(([path]) => path.endsWith('/via'))[1], '2026-01-05|Repaid|14000');
});

test('links an edit already cut are found again by the entry\'s day and description', async () => {
  const { store } = await make(settle('2026-01-05|Repaid|8000'));
  const entry = store.transactions.find(item => item.description === 'Repaid');
  store.syncRepayFlags();
  assert.equal(store.payerStats(entry).used, 6000);
});

test('links of an entry that is gone are not given to another entry of the same day', async () => {
  const { store } = await make(settle('2026-01-05|Repaid|8000'));
  const entry = store.transactions.find(item => item.description === 'Repaid');
  store.years[2026].settles.s2 = { ...store.years[2026].settles.s1, items: [{ to: 'y', a: 1000 }], via: '2026-01-05|Repaid|10000' };
  store.resetShared();
  store.repairedAt = null;
  store.syncRepayFlags();
  assert.equal(store.payerStats(entry).used, 1000);
});

test('payments whose repayment entry is gone are found, and listed per shared entry', async () => {
  const { store } = await make({
    a: { date: '2026-01-05', property: 'JPY', with: 'Sairam', items: [{ to: 'x', a: 6000 }], cash: 6000, forgiven: 0, treatment: 'none', via: '2026-01-05|Repaid|10000', link: true },
    b: { date: '2026-01-06', property: 'JPY', with: 'Sairam', items: [{ to: 'x', a: 1000 }, { to: 'y', a: 500 }], cash: 1500, forgiven: 0, treatment: 'none', via: '2026-01-06|Gone|1500', link: true },
    c: { date: '2026-01-07', property: 'JPY', with: 'Sairam', items: [{ to: 'x', a: 200 }], cash: 200, forgiven: 0, treatment: 'none', link: true },
    d: { date: '2026-01-08', property: 'JPY', with: 'Sairam', items: [{ to: 'y', a: 300 }], cash: 300, forgiven: 0, treatment: 'none' }
  });
  assert.deepEqual(store.lostSettles().map(settle => settle.id).sort(), ['b', 'c']);
  assert.deepEqual(store.paymentsOn('x').map(row => [row.settle.id, row.amount]).sort(), [['a', 6000], ['b', 1000], ['c', 200]]);
  assert.equal(store.paymentsOn('nobody').length, 0);
});
