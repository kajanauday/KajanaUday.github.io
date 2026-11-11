// Run with: node --test tests/blocks-store.test.js
// Savings, On hold, Lent and Borrowed blocks end to end through the store: month documents and month sections in
// Firebase's shape, and the year's figures as the year card reads them.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../shared-ledger.js');
require('../data-layer.js');
const { ExpenseStore } = globalThis;

const block = (name, kind, roles) => ({ name, type: 'net', kind, block: true, subsections: Object.keys(roles), roles, calc: ExpenseStore.defaultCalc(kind) });
const net = (section, category, amount, day = 1) => ({ category, total: amount, count: 1, entries: [{ day, description: `${section} ${category}`, place: '', amount, section, notes: [] }] });
const income = (category, amount) => ({ category, total: amount, count: 1, entries: [{ day: 1, description: category, place: '', amount, section: 'Income', notes: [] }] });

async function storeWith(docs, monthSections, years = ['2026']) {
  const db = { get: async path => docs[path.replace('months/', '')] || null, patch: async () => {} };
  const yearNodes = Object.fromEntries(years.map(year => [year, { currencies: { JPY: { from: 'January' } }, monthSections: Object.fromEntries(Object.entries(monthSections).filter(([id]) => id.startsWith(year))), monthConfig: {}, months: {}, metadata: { entries: 0 } }]));
  const store = new ExpenseStore({ db, currencies: { JPY: { code: 'JPY' } }, years: yearNodes });
  for (const year of years) await store.ensureYear(Number(year));
  years.forEach(year => store.recomputeYear(year));
  return store;
}

test('the UR advance on hold: only the kept part is an expense, and nothing is on hold once it is back', async () => {
  const store = await storeWith({
    '2026_August': { JPY: { income: [income('Relocation bonus', 300000)], net: [net('UR apartment', 'Advance', 280000, 10)] } },
    '2026_October': { JPY: { net: [net('UR apartment', 'Had back', -220000, 3), net('UR apartment', 'Kept', 60000, 3)] } }
  }, {
    '2026_August': { JPY: { own: true, sections: [block('UR apartment', 'hold', { Advance: 'hold' })] } },
    '2026_October': { JPY: { own: true, sections: [block('UR apartment', 'hold', { 'Had back': 'hold', Kept: 'kept' })] } }
  });
  const year = store.yearTotals(2026, 'JPY');
  assert.equal(year.own.income, 300000);
  assert.equal(year.own.expenses, 60000);
  assert.equal(store.yearHoldings(2026, 'JPY').open.held, 0);
  assert.equal(store.yearHoldings(2026, 'JPY').own.kept, 60000);
  // August alone: the advance is on hold, and is not an expense.
  const august = store.year(2026).months['2026_August'].metadata.JPY;
  assert.equal(august.holdings.held, 280000);
  assert.equal(august.expenses, 0);
});

test('a chit as a savings pot: paid in over a year, paid out with interest the next', async () => {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const docs = {};
  const sections = {};
  names.forEach(name => {
    docs[`2026_${name}`] = { JPY: { net: [net('Chit', 'Paid in', 21500)] } };
    sections[`2026_${name}`] = { JPY: { own: true, sections: [block('Chit', 'savings', { 'Paid in': 'save' })] } };
  });
  docs['2027_March'] = { JPY: { net: [net('Chit', 'Paid out', -258000), net('Chit', 'Interest', 22000)] } };
  sections['2027_March'] = { JPY: { own: true, sections: [block('Chit', 'savings', { 'Paid out': 'save', Interest: 'return' })] } };
  const store = await storeWith(docs, sections, ['2026', '2027']);
  assert.equal(store.yearHoldings(2026, 'JPY').own.savedIn, 258000);
  assert.equal(store.yearHoldings(2026, 'JPY').open.saved, 258000);
  assert.equal(store.yearTotals(2026, 'JPY').own.expenses, 0);
  assert.equal(store.yearHoldings(2027, 'JPY').own.returns, 22000);
  assert.equal(store.yearHoldings(2027, 'JPY').open.saved, 0);
  assert.equal(store.yearTotals(2027, 'JPY').own.income, 22000);
});

test('money lent: not an expense; interest is income; a write-off is an expense', async () => {
  const store = await storeWith(
    { '2026_May': { JPY: { net: [net('Ravi', 'Given', 100000), net('Ravi', 'Repaid', -70000), net('Ravi', 'Interest', 5000), net('Ravi', 'Written off', 30000)] } } },
    { '2026_May': { JPY: { own: true, sections: [block('Ravi', 'lent', { Given: 'lend', Repaid: 'lend', Interest: 'earned', 'Written off': 'writeoff' })] } } }
  );
  const year = store.yearTotals(2026, 'JPY');
  assert.equal(year.own.income, 5000);
  assert.equal(year.own.expenses, 30000);
  assert.equal(store.yearHoldings(2026, 'JPY').open.lent, 0);
});

test('money borrowed: not income; only interest paid is an expense, and what is owed stays open', async () => {
  const store = await storeWith(
    { '2026_June': { JPY: { net: [net('Loan', 'Received', 500000), net('Loan', 'Repaid', -200000), net('Loan', 'Interest', 12000)] } } },
    { '2026_June': { JPY: { own: true, sections: [block('Loan', 'borrowed', { Received: 'borrow', Repaid: 'borrow', Interest: 'charged' })] } } }
  );
  const year = store.yearTotals(2026, 'JPY');
  assert.equal(year.own.income, 0);
  assert.equal(year.own.expenses, 12000);
  assert.equal(store.yearHoldings(2026, 'JPY').open.borrowed, 300000);
});

test('settlements still count as before', async () => {
  const store = await storeWith(
    { '2026_July': { JPY: { net: [net('Trip', 'Paid', -90000), net('Trip', 'Settled', 60000)] } } },
    { '2026_July': { JPY: { own: true, sections: [block('Trip', 'settlement', { Paid: 'cost', Settled: 'settle' })] } } }
  );
  const year = store.yearTotals(2026, 'JPY');
  assert.equal(year.own.expenses, 30000);
  assert.equal(year.own.income, 0);
});
