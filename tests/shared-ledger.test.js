// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const SL = require('../shared-ledger.js');

// Amounts are minor units: 10,000.00 is 1000000.
const rent = { id: 'rent', amount: 1000000, paidBy: 'me', hisPct: 50, shared: true };
const food = { id: 'food', amount: 400000, paidBy: 'friend', hisPct: 50, shared: true };
const extra = { id: 'extra', amount: 200000, paidBy: 'me', hisPct: 100, shared: true };

test('half split: payer’s part is expense, the other half is owed back', () => {
  assert.deepEqual(SL.split(rent), { cost: 1000000, friendShare: 500000, myShare: 500000, myExpense: 500000, friendExpense: 0, friendOwes: 500000, iOwe: 0 });
});

test('friend paid: I owe my half, his half is his expense', () => {
  const parts = SL.split(food);
  assert.equal(parts.iOwe, 200000);
  assert.equal(parts.myExpense, 200000);
  assert.equal(parts.friendExpense, 200000);
});

test('extra payment at 100% his: nothing is my expense, all of it is owed', () => {
  const parts = SL.split(extra);
  assert.equal(parts.myExpense, 0);
  assert.equal(parts.friendOwes, 200000);
});

test('pending lists what is open on each side and the net between us', () => {
  const p = SL.pending([rent, food, extra], []);
  assert.equal(p.receivableTotal, 700000); // rent half + extra in full
  assert.equal(p.payableTotal, 200000);    // my half of food
  assert.equal(p.net, 500000);             // he owes me 5,000 overall
});

test('netting: money received clears what I owe, only the difference moves', () => {
  // He owes me 5,000 (rent half); I owe him 2,000 (my half of food). Cash that moves: he pays me 3,000.
  const r = SL.settle({ entries: [rent, food], settlements: [], items: [{ to: 'rent', a: 500000 }, { to: 'food', a: 200000 }], cash: 300000 });
  assert.equal(r.ok, true);
  assert.equal(r.forgiven, 0);
  assert.equal(r.question, null);
  const after = SL.pending([rent, food], [r.settlement]);
  assert.equal(after.net, 0);
  assert.equal(after.receivable.length + after.payable.length, 0);
});

test('a partial payment leaves the rest open, and that rest shows in pending', () => {
  const first = SL.settle({ entries: [rent], settlements: [], items: [{ to: 'rent', a: 200000 }], cash: 200000 });
  const p = SL.pending([rent], [first.settlement]);
  assert.equal(p.receivableTotal, 300000);
});

test('an item cannot be cleared for more than is open', () => {
  const r = SL.settle({ entries: [rent], settlements: [], items: [{ to: 'rent', a: 600000 }], cash: 600000 });
  assert.equal(r.ok, false);
});

test('forgiveness asks what to do with it, and only counts when told to', () => {
  // He owes 5,000 and pays only 4,000: 1,000 was let go.
  const asked = SL.settle({ entries: [rent], settlements: [], items: [{ to: 'rent', a: 500000 }], cash: 400000 });
  assert.equal(asked.forgiven, 100000);
  assert.match(asked.question, /expense/);
  const kept = SL.settle({ entries: [rent], settlements: [], items: [{ to: 'rent', a: 500000 }], cash: 400000, treatment: 'expense' });
  assert.equal(SL.profitEffect([rent], [kept.settlement]).expense, 500000 + 100000);
});

test('repayments never change income or expense', () => {
  const r = SL.settle({ entries: [rent], settlements: [], items: [{ to: 'rent', a: 500000 }], cash: 500000 });
  assert.equal(SL.profitEffect([rent], [r.settlement]).expense, 500000); // only my half, as before
  assert.equal(SL.profitEffect([rent], [r.settlement]).income, 0);
});

test('a payment can clear items across months: the open part carries until it is cleared', () => {
  // Month 1: I paid rent, he owes 5,000. Month 3: he pays 2,000, month 6: the rest.
  const m3 = SL.settle({ entries: [rent], settlements: [], items: [{ to: 'rent', a: 200000 }], cash: 200000 });
  const m6 = SL.settle({ entries: [rent], settlements: [m3.settlement], items: [{ to: 'rent', a: 300000 }], cash: 300000 });
  assert.equal(SL.pending([rent], [m3.settlement, m6.settlement]).net, 0);
});
