// Run with: node --test tests/groups.test.js
// Groups: names live in groups/<id>; entries, sections and subsections say which groups they are in.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../shared-ledger.js');
require('../data-layer.js');
const { ExpenseStore } = globalThis;

const sec = (name, extra = {}) => ({ name, type: 'expense', subsections: ['Food', 'Rent'], ...extra });
async function make() {
  const writes = [];
  const docs = { '2026_January': { JPY: { expenses: [{ category: 'Food', total: 500, count: 1, entries: [{ day: 3, description: 'Lunch', place: '', amount: 500, section: 'Home', groups: ['g1'], notes: [] }, { day: 4, description: 'Dinner', place: '', amount: 700, section: 'Home', notes: [{ day: 4, description: 'Starter', place: '', amount: 300, groups: ['g2'] }, { day: 4, description: 'Main', place: '', amount: 400 }] }] }] } } };
  const db = { get: async path => docs[path.replace('months/', '')] || null, patch: async update => { writes.push(update); } };
  const monthSections = { '2026_January': { JPY: { own: true, sections: [sec('Home', { groups: ['g1'], subGroups: { Rent: ['g1', 'g2'] } })] } } };
  const years = { 2026: { currencies: { JPY: { from: 'January' } }, monthSections, monthConfig: {}, months: {}, settles: {}, metadata: { entries: 0 } } };
  const store = new ExpenseStore({ db, currencies: { JPY: { code: 'JPY' } }, years, groups: { g1: { name: 'Japan trip', color: '#e0a526' } } });
  await store.ensureYear(2026);
  return { store, writes };
}

test('a group lists its entries, sections and subsections, and the entry keeps its group ids', async () => {
  const { store } = await make();
  const members = store.groupMembers('g1');
  assert.equal(members.entries.length, 1);
  assert.deepEqual(members.notes.map(note => note.description), []);
  assert.deepEqual(store.groupMembers('g2').notes.map(note => note.description), ['Starter']);
  assert.equal(members.entries[0].description, 'Lunch');
  assert.deepEqual(members.sections.map(item => item.section), ['Home']);
  assert.deepEqual(members.subsections.map(item => item.category), ['Rent']);
  assert.equal(store.groupMembers('g2').subsections.length, 1);
  assert.equal(store.groupMembers('nope').entries.length, 0);
});

test('a group is saved and removed by its own path', async () => {
  const { store, writes } = await make();
  await store.saveGroup('g3', { name: 'Repayments', color: '#3aa6a0' });
  assert.equal(writes.at(-1)['groups/g3'].name, 'Repayments');
  assert.deepEqual(store.groupList().map(group => group.name), ['Japan trip', 'Repayments']);
  await store.deleteGroup('g3');
  assert.equal(writes.at(-1)['groups/g3'], null);
  assert.equal(store.groupName('g3'), '');
});

test('the built ledger carries the groups for the marks', async () => {
  const { store } = await make();
  store.recomputeYear('2026');
  const month = store.sections(2026, 0, 'JPY');
  assert.deepEqual(month[0].groups, ['g1']);
  const built = store.groupIntoSections ? store.groupIntoSections(store.items(2026, 'JPY', 0), month, '9999-12-31', 'JPY') : null;
  assert.deepEqual(built.Home._meta.groups, ['g1']);
  assert.deepEqual(built.Home._meta.subGroups.Rent, ['g1', 'g2']);
  assert.deepEqual(built.Home.categories.Food.entries[0].groups, ['g1']);
});

test('a note carries its groups into the ledger and can be saved with them', async () => {
  const { store } = await make();
  store.recomputeYear('2026');
  const month = store.sections(2026, 0, 'JPY');
  const built = store.groupIntoSections(store.items(2026, 'JPY', 0), month, '9999-12-31', 'JPY');
  const dinner = built.Home.categories.Food.entries.find(entry => entry.description === 'Dinner');
  assert.deepEqual(dinner.subEntries.find(note => note.description === 'Starter').groups, ['g2']);
  assert.deepEqual(dinner.subEntries.find(note => note.description === 'Main').groups, []);
});

test('a group added to a note is written with the note', async () => {
  const { store, writes } = await make();
  const note = store.transactions.find(row => row.description === 'Main');
  note.groups = ['g1'];
  await store.saveTransactions();
  const doc = writes.map(update => update['months/2026_January']).find(Boolean);
  const dinner = doc.JPY.expenses[0].entries.find(entry => entry.description === 'Dinner');
  assert.deepEqual(dinner.notes.find(item => item.description === 'Main').groups, ['g1']);
});
