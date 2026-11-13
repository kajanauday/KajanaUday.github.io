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

async function storeWith(docs, monthSections, years = ['2026'], settles = {}) {
  const db = { get: async path => docs[path.replace('months/', '')] || null, patch: async () => {} };
  const yearNodes = Object.fromEntries(years.map(year => [year, { currencies: { JPY: { from: 'January' } }, monthSections: Object.fromEntries(Object.entries(monthSections).filter(([id]) => id.startsWith(year))), monthConfig: {}, months: {}, settles: settles[year] || {}, metadata: { entries: 0 } }]));
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
  assert.equal(store.monthTotals(2026, 7, 'JPY').holdings.held, 280000);
  assert.equal(store.monthTotals(2026, 9, 'JPY').holdings.held, -280000);
  assert.equal(store.monthTotals(2026, 10, 'JPY').holdings.held, 0);
  assert.equal(store.monthTotals(2026, 7, 'JPY').closing, 20000);
  assert.equal(store.monthTotals(2026, 9, 'JPY').closing, 240000);
  assert.equal(year.closing, 240000);
  // August alone: the advance is on hold, and is not an expense.
  const august = store.year(2026).months['2026_August'].metadata.JPY;
  assert.equal(august.holdings.held, 280000);
  assert.equal(august.expenses, 0);
});

test('a refund above a held balance records its excess as separate income', async () => {
  const source = {
    id: 'ur-source', property: 'JPY', date: '2026-09-10', section: 'UR deposit', category: 'Advance',
    type: 'net', description: 'UR money', amount: 100000, moneyId: 'ur-hold', moneyRole: 'hold'
  };
  const repayment = {
    id: 'ur-return', property: 'JPY', date: '2026-10-10', section: 'UR deposit', category: 'Had back',
    type: 'net', description: 'Refund for UR money', amount: -100000, moneyId: 'ur-hold', moneyRole: 'hold',
    moneyRef: { date: source.date, description: source.description, section: source.section, category: source.category }
  };
  const extra = {
    id: 'ur-extra', property: 'JPY', date: '2026-10-10', section: 'Income', category: 'Other income',
    type: 'income', description: 'Extra returned for UR money', amount: 25000
  };
  const holdSection = subsections => ({
    own: true,
    sections: [{ ...block('UR deposit', 'hold', Object.fromEntries(subsections.map(name => [name, 'hold']))), link: 'ur-hold-link' }]
  });
  const store = await storeWith({
    '2026_September': { JPY: ExpenseStore.monthDoc([source]).JPY },
    '2026_October': { JPY: ExpenseStore.monthDoc([repayment, extra]).JPY }
  }, {
    '2026_September': { JPY: holdSection(['Advance']) },
    '2026_October': { JPY: holdSection(['Had back']) }
  });

  assert.equal(store.monthTotals(2026, 9, 'JPY').income, 25000);
  assert.equal(store.monthTotals(2026, 9, 'JPY').holdings.held, -100000);
  assert.equal(store.yearTotals(2026, 'JPY').own.income, 25000);
  assert.equal(store.yearHoldings(2026, 'JPY').open.held, 0);
  assert.equal(extra.moneyId, undefined);
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
  assert.equal(store.monthTotals(2027, 2, 'JPY').holdings.saved, -258000);
  assert.equal(store.monthTotals(2027, 3, 'JPY').holdings.saved, 0);
  assert.equal(store.monthTotals(2027, 2, 'JPY').closing, 280000);
  assert.equal(store.yearTotals(2026, 'JPY').closing, -258000);
  assert.equal(store.yearTotals(2027, 'JPY').closing, 280000);
});

test('money lent: cash balance reflects the amount out, while interest and write-offs remain income and expenses', async () => {
  const store = await storeWith(
    { '2026_May': { JPY: { net: [net('Ravi', 'Given', 100000), net('Ravi', 'Repaid', -70000), net('Ravi', 'Interest', 5000), net('Ravi', 'Written off', 30000)] } } },
    { '2026_May': { JPY: { own: true, sections: [block('Ravi', 'lent', { Given: 'lend', Repaid: 'lend', Interest: 'earned', 'Written off': 'writeoff' })] } } }
  );
  const year = store.yearTotals(2026, 'JPY');
  assert.equal(year.own.income, 5000);
  assert.equal(year.own.expenses, 30000);
  assert.equal(store.yearHoldings(2026, 'JPY').open.lent, 0);
  assert.equal(year.closing, -25000);
  assert.equal(store.monthTotals(2026, 4, 'JPY').closing, -25000);
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
  assert.equal(store.monthTotals(2026, 5, 'JPY').holdings.borrowed, 300000);
  await store.ensureMonth(2026, 5);
  assert.equal(store.country(2026, 5, 'JPY')._meta.holdings.borrowed, 300000);
  assert.equal(store.yearbook(2026, 'JPY')._meta.holdings.borrowed, 300000);
  assert.equal(year.closing, 288000);
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

test('recorded shared repayments stay visible without adding to expenses twice', async () => {
  const sharedExpense = {
    id: 'sairam-shared', property: 'JPY', date: '2026-07-12', section: 'Expenses', category: 'Sai Ram',
    type: 'expense', description: 'Shared dinner', amount: 10000, sid: 'shared-dinner',
    shared: { by: 'friend', his: 50, with: 'Sai Ram' }
  };
  const repayment = {
    id: 'sairam-repayment', property: 'JPY', date: '2026-07-30', section: 'Expenses', category: 'Sai Ram',
    type: 'expense', description: 'Settled with Sai Ram', amount: 5000,
    cleared: { id: 'settlement-1', colour: '#2563eb' }
  };
  const store = await storeWith({
    '2026_July': { JPY: ExpenseStore.monthDoc([sharedExpense, repayment]).JPY }
  }, {});
  const month = store.monthTotals(2026, 6, 'JPY');
  const year = store.yearTotals(2026, 'JPY');
  const expenses = Object.values(store.country(2026, 6, 'JPY').sections)
    .find(section => section._meta.type === 'expense');

  assert.equal(month.expenses, 5000);
  assert.equal(year.own.expenses, 5000);
  assert.equal(expenses.categories['Sai Ram']._meta.total, 5000);
  assert.equal(expenses.categories['Sai Ram'].entries.length, 2);
  assert.equal(expenses.categories['Sai Ram'].entries.find(entry => entry.cleared)._meta.total, 5000);
});

test('yearbook groups shared expenses into settled and ongoing histories across months', async () => {
  const sources = [
    { id: 'settled-source', sid: 'shared-settled', series: { id: 'settled-series', colour: '#2563eb' }, shared: { by: 'me', his: 50, with: 'UR' }, property: 'JPY', date: '2026-08-12', type: 'expense', category: 'Housing', section: 'Expenses', description: 'UR advance', amount: 44000 },
    { id: 'open-source', sid: 'shared-open', series: { id: 'open-series', colour: '#7c3aed' }, shared: { by: 'me', his: 50, with: 'UR' }, property: 'JPY', date: '2026-09-03', type: 'expense', category: 'Housing', section: 'Expenses', description: 'UR utilities', amount: 20000 }
  ];
  const docs = Object.fromEntries(sources.map(source => {
    const month = `${source.date.slice(0, 4)}_${ExpenseStore.MONTH_NAMES[Number(source.date.slice(5, 7)) - 1]}`;
    return [month, ExpenseStore.monthDoc([source])];
  }));
  const store = await storeWith(docs, {}, ['2026', '2027'], {
    2026: {
      partial: { id: 'partial', date: '2026-10-05', property: 'JPY', with: 'UR', cash: 3000, items: [{ to: 'shared-open', a: 3000 }] }
    },
    2027: {
      first: { id: 'first', date: '2027-01-02', property: 'JPY', with: 'UR', cash: 22000, items: [{ to: 'shared-settled', a: 22000 }] }
    }
  });
  const history = store.yearbook(2026, 'JPY')._meta.sharedHistory;
  assert.equal(history.settled.length, 1);
  assert.equal(history.settled[0].title, 'UR advance');
  assert.deepEqual(history.settled[0].history.map(item => item.date), ['2026-08-12', '2027-01-02']);
  assert.equal(history.settled[0].history[1].amount, 22000);
  assert.equal(history.ongoing.length, 1);
  assert.equal(history.ongoing[0].title, 'UR utilities');
  assert.deepEqual(history.ongoing[0].history.map(item => item.date), ['2026-09-03', '2026-10-05']);
  assert.equal(history.ongoing[0].balance, 7000);
});

test('a partial repayment keeps a stable link to its original money entry when saved and reloaded', () => {
  const source = {
    id: 'source-entry', property: 'JPY', date: '2026-06-02', section: 'Annayya', category: 'Borrowed',
    type: 'net', description: 'Annayya', amount: 500000, moneyId: 'ml-source', moneyRole: 'borrow'
  };
  const repayment = {
    id: 'repayment-entry', property: 'JPY', date: '2026-07-14', section: 'Annayya', category: 'Repaid',
    type: 'net', description: 'Repaid for “Annayya”', amount: -125000, moneyId: 'ml-source', moneyRole: 'borrow',
    moneyRef: { date: source.date, description: source.description, section: source.section, category: source.category }
  };
  const sourceDoc = ExpenseStore.monthDoc([source]);
  const repaymentDoc = ExpenseStore.monthDoc([repayment]);
  const reloadedSource = ExpenseStore.flattenMonth('2026_June', { JPY: sourceDoc.JPY }, ['JPY'])[0];
  const reloadedRepayment = ExpenseStore.flattenMonth('2026_July', { JPY: repaymentDoc.JPY }, ['JPY'])[0];

  assert.equal(reloadedSource.amount, 500000);
  assert.equal(reloadedSource.moneyId, 'ml-source');
  assert.equal(reloadedSource.moneyRole, 'borrow');
  assert.equal(reloadedRepayment.amount, -125000);
  assert.equal(reloadedRepayment.moneyId, reloadedSource.moneyId);
  assert.deepEqual(reloadedRepayment.moneyRef, {
    date: source.date, description: source.description, section: source.section, category: source.category
  });
});

test('partial repayments across months reduce only their linked entry outstanding', () => {
  const rows = [
    { moneyId: 'loan-a', moneyRole: 'borrow', amount: 500000 },
    { moneyId: 'loan-a', moneyRole: 'borrow', amount: -125000 },
    { moneyId: 'loan-a', moneyRole: 'borrow', amount: -125000 },
    { moneyId: 'loan-a', moneyRole: 'charged', amount: 5000 },
    { moneyId: 'loan-b', moneyRole: 'borrow', amount: 80000 }
  ];
  assert.equal(ExpenseStore.linkedMoneyBalance('loan-a', 'borrowed', rows), 250000);
  assert.equal(ExpenseStore.linkedMoneyBalance('loan-b', 'borrowed', rows), 80000);
  assert.equal(rows[0].amount, 500000);
});

test('additional linked principal and edits to an earlier amount change later balances', async () => {
  const source = {
    id: 'linked-source', property: 'JPY', date: '2026-08-12', section: 'Family loan', category: 'Lent',
    type: 'net', description: 'Family loan', amount: 5000000, moneyId: 'family-loan', moneyRole: 'lend'
  };
  const repayment = {
    id: 'linked-repayment', property: 'JPY', date: '2026-09-10', section: 'Family loan', category: 'Repaid',
    type: 'net', description: 'Repaid for Family loan', amount: -1500000, moneyId: 'family-loan', moneyRole: 'lend',
    moneyRef: { date: source.date, description: source.description, section: source.section, category: source.category }
  };
  const additional = {
    id: 'linked-additional', property: 'JPY', date: '2026-10-10', section: 'Family loan', category: 'Additional',
    type: 'net', description: 'Additional lending for Family loan', amount: 2000000, moneyId: 'family-loan', moneyRole: 'lend',
    moneyRef: { date: source.date, description: source.description, section: source.section, category: source.category }
  };
  const linkedSection = () => ({
    own: true,
    sections: [{ ...block('Family loan', 'lent', { Lent: 'lend', Repaid: 'lend', Additional: 'lend' }), link: 'family-loan-link' }]
  });
  const store = await storeWith({
    '2026_August': { JPY: ExpenseStore.monthDoc([source]).JPY },
    '2026_September': { JPY: ExpenseStore.monthDoc([repayment]).JPY },
    '2026_October': { JPY: ExpenseStore.monthDoc([additional]).JPY }
  }, {
    '2026_August': { JPY: linkedSection() },
    '2026_September': { JPY: linkedSection() },
    '2026_October': { JPY: linkedSection() }
  });
  const balanceAt = throughDate => ExpenseStore.linkedMoneyBalance(
    'family-loan', 'lent', store.transactions.filter(item => item.property === 'JPY'), item => store.entryTotal(item.id), throughDate
  );
  const storedSource = store.transactions.find(item => item.date === source.date && item.moneyId === source.moneyId);

  assert.equal(balanceAt('2026-10-31'), 5500000);
  storedSource.amount = 7000000;
  await store.saveTransactions();
  assert.equal(balanceAt('2026-10-31'), 7500000);
});

test('linked money balances can be read as of a selected month without counting later repayments', () => {
  const rows = [
    { moneyId: 'loan', moneyRole: 'borrow', amount: 100000, date: '2026-08-12' },
    { moneyId: 'loan', moneyRole: 'borrow', amount: -25000, date: '2026-10-04' },
    { moneyId: 'loan', moneyRole: 'borrow', amount: -30000, date: '2026-11-02' }
  ];
  assert.equal(ExpenseStore.linkedMoneyBalance('loan', 'borrowed', rows, undefined, '2026-10-31'), 75000);
  assert.equal(ExpenseStore.linkedMoneyBalance('loan', 'borrowed', rows), 45000);
});

test('yearbook lists a settled linked savings account with its dated history', async () => {
  const source = {
    id: 'savings-source', property: 'JPY', date: '2026-08-12', section: 'Festival pot', category: 'Put in',
    type: 'net', description: 'Festival savings', amount: 10000, moneyId: 'money-savings', moneyRole: 'save'
  };
  const withdrawal = {
    id: 'savings-return', property: 'JPY', date: '2026-10-04', section: 'Festival pot', category: 'Paid out',
    type: 'net', description: 'Withdrawal for “Festival savings”', amount: -10000, moneyId: 'money-savings', moneyRole: 'save',
    moneyRef: { date: source.date, description: source.description, section: source.section, category: source.category }
  };
  const monthDoc = items => ExpenseStore.monthDoc(items).JPY;
  const sections = link => ({
    own: true,
    sections: [block('Festival pot', 'savings', { 'Put in': 'save', 'Paid out': 'save' })].map(item => ({ ...item, link }))
  });
  const store = await storeWith({
    '2026_August': { JPY: monthDoc([source]) },
    '2026_October': { JPY: monthDoc([withdrawal]) }
  }, {
    '2026_August': { JPY: sections('savings-link') },
    '2026_October': { JPY: sections('savings-link') }
  });
  const accounts = store.yearbook(2026, 'JPY')._meta.settledAccounts.savings;
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].description, source.description);
  assert.deepEqual(accounts[0].history.map(item => [item.date, item.description, item.amount]), [
    ['2026-08-12', source.description, 10000],
    ['2026-10-04', withdrawal.description, -10000]
  ]);
});

test('all money blocks account for partial returns, write-offs and interest without changing principal entries', () => {
  const rows = [
    { moneyId: 'savings', moneyRole: 'save', amount: 100000 },
    { moneyId: 'savings', moneyRole: 'save', amount: -30000 },
    { moneyId: 'savings', moneyRole: 'return', amount: 1000 },
    { moneyId: 'savings', moneyRole: 'return', amount: -5000 },
    { moneyId: 'hold', moneyRole: 'hold', amount: 80000 },
    { moneyId: 'hold', moneyRole: 'hold', amount: -20000 },
    { moneyId: 'hold', moneyRole: 'kept', amount: 10000 },
    { moneyId: 'lent', moneyRole: 'lend', amount: 50000 },
    { moneyId: 'lent', moneyRole: 'lend', amount: -20000 },
    { moneyId: 'lent', moneyRole: 'writeoff', amount: 5000 },
    { moneyId: 'lent', moneyRole: 'earned', amount: 1000 },
    { moneyId: 'borrowed', moneyRole: 'borrow', amount: 90000 },
    { moneyId: 'borrowed', moneyRole: 'borrow', amount: -25000 },
    { moneyId: 'borrowed', moneyRole: 'charged', amount: 2000 }
  ];
  assert.equal(ExpenseStore.linkedMoneyBalance('savings', 'savings', rows), 65000);
  assert.equal(ExpenseStore.linkedMoneyBalance('hold', 'hold', rows), 50000);
  assert.equal(ExpenseStore.linkedMoneyBalance('lent', 'lent', rows), 25000);
  assert.equal(ExpenseStore.linkedMoneyBalance('borrowed', 'borrowed', rows), 65000);
  assert.equal(rows[0].amount, 100000);
  assert.equal(rows[4].amount, 80000);
  assert.equal(rows[7].amount, 50000);
  assert.equal(rows[11].amount, 90000);
});
