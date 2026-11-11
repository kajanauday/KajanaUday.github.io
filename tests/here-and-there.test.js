// Run with: node --test tests/here-and-there.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const HT = require('../here-and-there.js');

let n = 0;
const ctx = {
  labelFor: date => `From ${date.slice(0, 7)}`,
  amountText: (minor, property) => `${property} ${(minor / 100).toFixed(2)}`,
  newKey: () => `k${++n}`
};
const real = (over = {}) => ({ id: 'a', date: '2026-11-05', refDate: '2026-12-31', refKey: 'r1', property: 'INR', type: 'expense', description: 'Bill', place: '', amount: 150000, ...over });
const apply = (rows, result) => rows.filter(row => !result.remove.includes(row.id)).concat(result.add.map((row, i) => ({ ...row, id: `m${i}-${Math.random()}` })));

test('an entry for another month gets one marker there, with the amount as its note and no amount', () => {
  const result = HT.reconcileReferences([real()], ctx);
  assert.equal(result.add.length, 1);
  const marker = result.add[0];
  assert.equal(marker.date, '2026-12-31');
  assert.equal(marker.section, 'Here and there');
  assert.equal(marker.category, 'From 2026-11');
  assert.equal(marker.type, 'expense');
  assert.equal(marker.place, 'INR 1500.00');
  assert.equal(marker.amount, 0);
  assert.deepEqual(marker.markerOf, { key: 'r1', amount: 150000, from: '2026-11-05' });
  assert.deepEqual(result.months, ['2026-12']);
});
test('income stays income', () => assert.equal(HT.reconcileReferences([real({ type: 'income' })], ctx).add[0].type, 'income'));
test('a reference to the same month needs no marker', () => assert.equal(HT.reconcileReferences([real({ refDate: '2026-11-20' })], ctx).add.length, 0));
test('a second run with nothing changed does nothing', () => {
  const rows = [real()];
  const second = HT.reconcileReferences(apply(rows, HT.reconcileReferences(rows, ctx)), ctx);
  assert.deepEqual([second.add, second.remove, second.rekey], [[], [], []]);
});
test('changing the amount replaces the marker', () => {
  const after = apply([real()], HT.reconcileReferences([real()], ctx)).map(row => (row.id === 'a' ? { ...row, amount: 200000 } : row));
  const result = HT.reconcileReferences(after, ctx);
  assert.equal(result.remove.length, 1);
  assert.equal(result.add[0].place, 'INR 2000.00');
});
test('moving the reference to another month moves the marker', () => {
  const after = apply([real()], HT.reconcileReferences([real()], ctx)).map(row => (row.id === 'a' ? { ...row, refDate: '2027-01-10' } : row));
  const result = HT.reconcileReferences(after, ctx);
  assert.equal(result.add[0].date, '2027-01-10');
  assert.deepEqual(result.months, ['2026-12', '2027-01']);
});
test('removing the reference, or deleting the entry, removes the marker', () => {
  const after = apply([real()], HT.reconcileReferences([real()], ctx));
  assert.equal(HT.reconcileReferences(after.map(row => (row.id === 'a' ? { ...row, refDate: undefined } : row)), ctx).remove.length, 1);
  assert.equal(HT.reconcileReferences(after.filter(row => row.id !== 'a'), ctx).remove.length, 1);
});
test('a copy gets its own key and its own marker', () => {
  const result = HT.reconcileReferences([real(), real({ id: 'b' })], ctx);
  assert.equal(result.rekey.length, 1);
  assert.equal(new Set(result.add.map(row => row.markerOf.key)).size, 2);
});
test('a marker whose entry is in a month that is not loaded is left alone', () => {
  const marker = { id: 'm', date: '2026-12-31', markerOf: { key: 'r1', amount: 150000, from: '2026-11-05' }, property: 'INR', type: 'expense', description: 'Bill', place: 'INR 1500.00', category: 'From 2026-11', section: 'Here and there', amount: 0 };
  const result = HT.reconcileReferences([marker], { ...ctx, isLoaded: ym => ym !== '2026-11' });
  assert.deepEqual([result.remove, result.add], [[], []]);
});
