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

// ---- series: colour, merge and done ----
const bill100 = { id: 'b1', shared: true, amount: 10000, paidBy: 'friend', hisPct: 50, date: '2026-12-01', series: { id: 'S1', colour: '#2563eb' } };
const pay120 = { id: 'b2', shared: true, amount: 12000, paidBy: 'me', hisPct: 50, date: '2026-12-05', series: { id: 'S1', colour: '#2563eb' } };

test('a series with an opposite item is merged, and its balance is the net (100 paid by him, 120 by me → 10 back)', () => {
  const r = SL.runSeries([bill100, pay120], []);
  assert.equal(r.get('b1').state, 'merged');
  assert.equal(r.get('b2').state, 'merged');
  assert.equal(r.get('b2').balance, 1000); // +10: he owes me
});

test('a series with same-side items only stays open, not merged', () => {
  const r = SL.runSeries([bill100, { ...bill100, id: 'b3', paidBy: 'friend' }], []);
  assert.equal(r.get('b1').state, 'open');
});

test('a series is done when its balance is paid back to zero, and its colour stays', () => {
  const pay = SL.settle({ entries: [bill100, pay120], settlements: [], items: [{ to: 'b2', a: 1000 }], cash: 1000 });
  const r = SL.runSeries([bill100, pay120], [pay.settlement]);
  assert.equal(r.get('b1').state, 'done');
  assert.equal(r.get('b2').colour, '#2563eb');
});

test('the balance can flip: an item bigger than the opposite one turns the sign', () => {
  const big = { id: 'b4', shared: true, amount: 30000, paidBy: 'me', hisPct: 50, date: '2026-12-09', series: { id: 'S1', colour: '#2563eb' } };
  assert.equal(SL.runSeries([bill100, big], []).get('b4').balance, 10000); // he owes me 15,000 - 5,000 = 10,000
});

test('a new item joins the open series, and a finished one is not joined', () => {
  assert.equal(SL.joinSeries([bill100, pay120], []).id, 'S1');
  const pay = SL.settle({ entries: [bill100, pay120], settlements: [], items: [{ to: 'b2', a: 1000 }], cash: 1000 });
  assert.equal(SL.joinSeries([bill100, pay120], [pay.settlement]), null);
});

test('series colours are a fixed list of twelve, used in order and wrapping after the twelfth', () => {
  assert.equal(SL.SERIES_COLOURS.length, 12);
  assert.equal(new Set(SL.SERIES_COLOURS).size, 12);
  assert.equal(SL.colourAt(0), SL.SERIES_COLOURS[0]);
  assert.equal(SL.colourAt(11), SL.SERIES_COLOURS[11]);
  assert.equal(SL.colourAt(12), SL.SERIES_COLOURS[0]);
  assert.equal(SL.colourAt(-1), SL.SERIES_COLOURS[11]);
  assert.equal(SL.colourAt(-13), SL.SERIES_COLOURS[11]);
  assert.equal(SL.fixedColour('#2563EB', 'S1'), '#2563eb');
});

// ---- automatic allocation and the buffer ----
{
  const test = require('node:test'); const assert = require('node:assert');
  const L = require('../shared-ledger.js');
  const mk = (id, amt, date, by = 'friend') => ({ id, amount: amt, paidBy: by, hisPct: 50, shared: true, date });
  test('allocate: 100 against 80 and 40 clears the 80, keeps 20', () => {
    const entries = [mk('a', 160, '2026-01-01'), mk('b', 80, '2026-01-02')]; // I owe 80 and 40
    const r = L.allocate({ entries, settlements: [], cash: -100 });
    assert.deepEqual(r.items, [{ to: 'a', a: 80 }]);
    assert.equal(r.buffer, -20); assert.equal(r.credit, -20);
  });
  test('buffer carries into the next payment', () => {
    const entries = [mk('a', 160, '2026-01-01'), mk('b', 80, '2026-01-02')];
    const first = L.allocate({ entries, settlements: [], cash: -100 });
    const st = [{ id: 's1', items: first.items, cash: -100, credit: first.credit }];
    assert.equal(L.buffer(st), -20);
    const second = L.allocate({ entries, settlements: st, cash: -20 }); // 20 + 20 buffer = 40
    assert.deepEqual(second.items, [{ to: 'b', a: 40 }]);
    assert.equal(second.buffer, 0); assert.equal(second.credit, 20);
    const res = L.settle({ entries, settlements: st, items: second.items, cash: -20, treatment: 'none', credit: second.credit });
    assert.equal(res.ok, true); assert.equal(res.forgiven, 0);
  });
  test('smaller than every item: all goes to buffer', () => {
    const r = L.allocate({ entries: [mk('a', 160, '2026-01-01')], settlements: [], cash: -50 });
    assert.deepEqual(r.items, []); assert.equal(r.buffer, -50);
  });
}

// ---- editing a settled entry ----
{
  const test = require('node:test'); const assert = require('node:assert');
  const L = require('../shared-ledger.js');
  const mk = (id, amt, date, by = 'friend') => ({ id, amount: amt, paidBy: by, hisPct: 50, shared: true, date });
  const st = [{ id: 's', items: [{ to: 'a', a: 80 }], cash: -80 }];
  test('amount reduced after settling: the excess becomes buffer', () => {
    const p = L.pending([mk('a', 100, '2026-01-01')], st); // I now owe 50, 80 was paid
    assert.equal(p.buffer, -30); assert.equal(p.net, 0); assert.equal(p.overall, 30 * 1);
  });
  test('amount raised after settling, no buffer: reopens the difference', () => {
    const p = L.pending([mk('a', 200, '2026-01-01')], st); // owe 100, paid 80
    assert.equal(p.payableTotal, 20); assert.equal(p.buffer, 0);
  });
  test('amount raised, buffer available: stays open until the buffer is used (nothing is settled by itself)', () => {
    const credit = [{ id: 's', items: [{ to: 'a', a: 80 }], cash: -100, credit: -20 }];
    const p = L.pending([mk('a', 200, '2026-01-01')], credit);
    assert.equal(p.payableTotal, 20); assert.equal(p.buffer, -20); assert.equal(p.auto.length, 0);
  });
  test('reduced share feeds the next payment', () => {
    const entries = [mk('a', 100, '2026-01-01'), mk('b', 120, '2026-01-02')]; // a: owe 50 (paid 80, +30 buffer), b: owe 60
    const r = L.allocate({ entries, settlements: st, cash: -30 }); // 30 + 30 buffer = 60 -> clears b
    assert.deepEqual(r.items, [{ to: 'b', a: 60 }]); assert.equal(r.buffer, 0);
  });
}

// ---- a settled entry removed: its payments are kept as buffer and cover what is open ----
{
  const test = require('node:test'); const assert = require('node:assert');
  const L = require('../shared-ledger.js');
  test('deleted settled entry: released credit becomes buffer and covers an open item', () => {
    const entries = [{ id: 'b', amount: 120, paidBy: 'friend', hisPct: 50, shared: true, date: '2026-01-02' }]; // I owe 60; 'a' was deleted
    const st = [
      { id: 's1', items: [{ to: 'a', a: 80 }], cash: -80 },
      { id: 's2', items: [], cash: 0, credit: -80 }
    ];
    const p = L.pending(entries, st);
    assert.equal(p.payableTotal, 60); assert.equal(p.buffer, -80); assert.equal(p.auto.length, 0);
  });
}
