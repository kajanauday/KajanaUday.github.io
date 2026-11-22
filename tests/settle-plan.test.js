// Run with: node --test tests/settle-plan.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const SL = require('../shared-ledger.js');

const mine = (id, date, amount) => ({ id, date, amount, paidBy: 'me', hisPct: 50, shared: true });     // he owes me amount/2
const his = (id, date, amount) => ({ id, date, amount, paidBy: 'friend', hisPct: 50, shared: true });  // I owe him amount/2
// Pays and records, the way the page does, so the next payment sees it.
function pay(entries, settlements, cash) {
  const plan = SL.planPayment({ entries, settlements, cash });
  const result = SL.settle({ entries, settlements, items: plan.items, cash, treatment: 'none', credit: plan.credit });
  assert.ok(result.ok && result.forgiven === 0, 'a plan never leaves a difference');
  return { plan, settlements: [...settlements, { id: `s${settlements.length}`, date: '2026-11-30', ...result.settlement }] };
}

test('a part payment clears the oldest first and leaves the rest open', () => {
  const entries = [mine('a', '2026-11-01', 2000), mine('b', '2026-11-05', 2000)];   // 1000 each
  const { plan, settlements } = pay(entries, [], 1500);
  assert.deepEqual(plan.items, [{ to: 'a', a: 1000 }, { to: 'b', a: 500 }]);
  const after = SL.pending(entries, settlements);
  assert.equal(after.net, 500);
  assert.equal(after.receivable.length, 1);
});

test('paying the balance clears both sides', () => {
  const entries = [mine('a', '2026-11-01', 2000), his('b', '2026-11-02', 600)];     // he owes 1000, I owe 300
  const { settlements } = pay(entries, [], 700);
  const after = SL.pending(entries, settlements);
  assert.equal(after.receivable.length + after.payable.length, 0);
  assert.equal(after.overall, 0);
});

test('more than the balance is kept as buffer and counts at the next payment', () => {
  const entries = [mine('a', '2026-11-01', 2000)];
  const first = pay(entries, [], 1500);
  assert.equal(SL.pending(entries, first.settlements).buffer, 500);
  const more = [...entries, mine('c', '2026-12-01', 1000)];                          // 500 more
  const second = pay(more, first.settlements, 0);
  assert.equal(SL.pending(more, second.settlements).overall, 0);
});

test('items that cancel out are settled with no cash', () => {
  const entries = [mine('a', '2026-11-01', 2000), his('b', '2026-11-02', 2000)];
  const { settlements } = pay(entries, [], 0);
  assert.equal(SL.pending(entries, settlements).receivable.length, 0);
});

test('paying the other way pays what I owe', () => {
  const entries = [his('b', '2026-11-02', 2000), his('c', '2026-11-09', 2000)];
  const { plan, settlements } = pay(entries, [], -1500);
  assert.deepEqual(plan.items, [{ to: 'b', a: 1000 }, { to: 'c', a: 500 }]);
  assert.equal(SL.pending(entries, settlements).net, -500);
});

const inSeries = (entry, id) => ({ ...entry, series: { id } });
test('a payment equal to a series balance settles that series, both sides, and leaves the next one open', () => {
  const entries = [
    inSeries(mine('a', '2026-10-02', 2000), 's1'), inSeries(his('b', '2026-10-09', 600), 's1'),   // s1: he owes 1000, I owe 300 -> 700
    inSeries(mine('c', '2026-11-03', 4000), 's2')                                               // s2: he owes 2000
  ];
  const { plan, settlements } = pay(entries, [], 700);
  assert.deepEqual(plan.items, [{ to: 'a', a: 1000 }, { to: 'b', a: 300 }]);
  const after = SL.pending(entries, settlements);
  assert.deepEqual(after.receivable.map(row => row.id), ['c']);
  assert.equal(after.payable.length, 0);
  const second = pay(entries, settlements, 2500);                       // covers s2 and the rest is buffer
  assert.equal(SL.pending(entries, second.settlements).buffer, 500);
});

test('a part payment on a series goes to the side it is for, oldest first, inside the oldest series', () => {
  const entries = [inSeries(mine('a', '2026-10-02', 2000), 's1'), inSeries(mine('b', '2026-10-05', 2000), 's1'), inSeries(mine('c', '2026-11-03', 2000), 's2')];
  const { plan } = pay(entries, [], 1500);
  assert.deepEqual(plan.items, [{ to: 'a', a: 1000 }, { to: 'b', a: 500 }]);
});
