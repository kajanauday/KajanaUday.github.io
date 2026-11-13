// Run with: node --test tests/blueprints.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
require('../component-blueprints.js');

test('zero custom-section totals render as dots in both group and section headings', () => {
  const section = {
    categories: {},
    _meta: {
      id: 'Loan',
      kind: 'lent',
      stats: { income: 0, expenses: 0, balance: 43847 },
      subsections: [],
      entries: 1
    }
  };
  const html = globalThis.LedgerBlueprints.GroupBlock(
    'lent',
    [section],
    { mKey: '2026_11', property: 'INR' },
    { ledgerDraft: null, editDraft: null },
    { esc: String, fmt: amount => amount }
  );

  assert.equal((html.match(/title="Income">·<\/span>/g) || []).length, 2);
  assert.equal((html.match(/title="Expenses">·<\/span>/g) || []).length, 2);
  assert.equal((html.match(/title="Balance">43847<\/span>/g) || []).length, 2);
});

test('currency panel headers show savings, held, lent, and borrowed balances', () => {
  const html = globalThis.LedgerBlueprints.CurrencyPanel(
    {
      _meta: {
        id: 'INR', name: 'India', code: 'INR', color: 'india',
        income: 1000, expense: 400, closing: 600,
        holdings: { saved: 100, held: 200, lent: 300, borrowed: 400 }
      },
      sections: {}
    },
    { mKey: '2026_11' },
    { ledgerDraft: null, editDraft: null, entryDraft: null },
    { esc: String, fmt: amount => String(amount), keyOf: () => '2026_11', dayLabel: String }
  );

  assert.match(html, /title="Savings: 100" aria-label="Savings: 100">100<\/span>/);
  assert.match(html, /title="On hold: 200" aria-label="On hold: 200">200<\/span>/);
  assert.match(html, /title="Lent out: 300" aria-label="Lent out: 300">300<\/span>/);
  assert.match(html, /title="Borrowed: 400" aria-label="Borrowed: 400">400<\/span>/);
});
