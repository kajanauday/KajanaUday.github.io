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
