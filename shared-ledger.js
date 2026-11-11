// Shared costs: money a friend and I put into one thing, and what is still owed between us.
//
// Every amount is in minor units (paise, cents), as the rest of the ledger keeps them. Nothing here is stored or drawn;
// it works out the figures from the entries and settlements it is given, so it can be checked on its own.
//
// Rules the whole flow follows:
//   - A shared entry is an ordinary entry. It carries only a marker: who paid it, and the friend's share of it.
//   - `hisPct` is the friend's share as a whole percentage (0–100). The default is 50 (half each). 100 means I paid
//     the lot for him; 0 means it was all mine.
//   - Whoever paid puts the whole cost into the cash. The other person's part is what they owe back.
//       paid by me:     friend owes me   his part      (my expense is my part)
//       paid by friend: I owe him        my part       (his expense is his part)
//   - A settlement is one cash movement with the items it clears. Items I am owed and items I owe are cleared together,
//     so money received can clear what I owe: nothing needs to change hands for the part that cancels out.
//   - Only money that was waived (forgiven) changes income or expense. Repayments never do: they give back what was
//     already spent or lent.
(function (global) {
  const PERCENT = /^(100|[1-9]?\d)$/;
  const DEFAULT_HIS_PCT = 50;

  const whole = value => Math.round(Number(value) || 0);
  const isPayerMe = entry => entry.paidBy !== 'friend';

  // The friend's share of an entry, as minor units, and my share. The two always add back to the cost.
  function split(entry) {
    const cost = Math.abs(whole(entry.amount));
    const pct = PERCENT.test(String(entry.hisPct ?? DEFAULT_HIS_PCT)) ? Number(entry.hisPct ?? DEFAULT_HIS_PCT) : DEFAULT_HIS_PCT;
    const his = Math.round(cost * pct / 100);
    const mine = cost - his;
    return isPayerMe(entry)
      ? { cost, friendShare: his, myShare: mine, myExpense: mine, friendExpense: 0, friendOwes: his, iOwe: 0 }
      : { cost, friendShare: his, myShare: mine, myExpense: mine, friendExpense: his, friendOwes: 0, iOwe: mine };
  }

  // Each settlement says which items it clears and how much of each. Applied amounts are kept per item.
  function appliedTo(settlements) {
    const applied = new Map();
    (settlements || []).forEach(settlement => {
      (settlement.items || []).forEach(item => {
        applied.set(item.to, (applied.get(item.to) || 0) + Math.abs(whole(item.a)));
      });
    });
    return applied;
  }

  // What is still open on one shared entry, from my side: `owed` is what the friend still owes me (paid by me) or what
  // I still owe him (paid by friend), always positive. `settled` is true once nothing is open.
  function outstanding(entry, settlements) {
    const parts = split(entry);
    const due = isPayerMe(entry) ? parts.friendOwes : parts.iOwe;
    const owed = Math.max(0, due - (appliedTo(settlements).get(entry.id) || 0));
    return { id: entry.id, direction: isPayerMe(entry) ? 'friend-owes-me' : 'i-owe-friend', owed, settled: owed === 0 };
  }

  // Every open item, grouped by side, with the net between us. `net` is positive when the friend owes me overall.
  function pending(entries, settlements) {
    const rows = (entries || []).filter(entry => entry.shared).map(entry => ({ entry, ...outstanding(entry, settlements) }));
    const open = rows.filter(row => !row.settled);
    const receivable = open.filter(row => row.direction === 'friend-owes-me');
    const payable = open.filter(row => row.direction === 'i-owe-friend');
    const sum = list => list.reduce((total, row) => total + row.owed, 0);
    return { receivable, payable, receivableTotal: sum(receivable), payableTotal: sum(payable), net: sum(receivable) - sum(payable) };
  }

  // Checks a settlement before it is kept, and works out what it does. `items` are { to, a } pairs: the shared entries
  // it clears and how much of each. `cash` is the money that actually moved, signed from my side: positive means the
  // friend paid me, negative means I paid him. Returns { ok:false, error } or { ok:true, settlement, forgiven, question }.
  function settle({ entries, settlements, items, cash, treatment }) {
    const byId = new Map((entries || []).filter(entry => entry.shared).map(entry => [entry.id, entry]));
    const cleared = (items || []).map(item => ({ to: item.to, a: Math.abs(whole(item.a)) })).filter(item => item.a > 0);
    if (!cleared.length) return { ok: false, error: 'Pick the items this payment clears.' };
    let receivedFromFriend = 0;
    let paidToFriend = 0;
    for (const item of cleared) {
      const entry = byId.get(item.to);
      if (!entry) return { ok: false, error: 'One of the items is no longer a shared entry.' };
      const row = outstanding(entry, settlements);
      if (item.a > row.owed) return { ok: false, error: `Only ${row.owed} is still open on one of them.` };
      if (row.direction === 'friend-owes-me') receivedFromFriend += item.a;
      else paidToFriend += item.a;
    }
    const net = receivedFromFriend - paidToFriend;
    const moved = whole(cash);
    if (!Number.isFinite(moved)) return { ok: false, error: 'Enter the amount that moved.' };
    // The difference is forgiveness: money the other side agreed not to take back. Positive means the friend let go of
    // what he owed me (a loss to me); negative means I let go of what I owed him (a gain to me).
    const forgiven = net - moved;
    if (forgiven !== 0 && !['income', 'expense', 'none'].includes(treatment)) {
      return { ok: true, forgiven, question: forgiven > 0 ? 'Count the forgiven amount as an expense, or leave it out?' : 'Count the forgiven amount as income, or leave it out?', settlement: null };
    }
    const settlement = { items: cleared, cash: moved, forgiven, treatment: forgiven === 0 ? 'none' : treatment };
    return { ok: true, forgiven, question: null, settlement };
  }

  // What the two of us do to my own income and expenses from the shared side. My share of each entry is an expense
  // (paid by me or by him). Repayments add nothing. Forgiveness adds to income or expense only if it was said to.
  function profitEffect(entries, settlements) {
    let expense = 0;
    let income = 0;
    (entries || []).filter(entry => entry.shared).forEach(entry => { expense += split(entry).myExpense; });
    (settlements || []).forEach(settlement => {
      const forgiven = whole(settlement.forgiven);
      if (forgiven > 0 && settlement.treatment === 'expense') expense += forgiven;
      if (forgiven < 0 && settlement.treatment === 'income') income += -forgiven;
    });
    return { income, expense, net: income - expense };
  }

  // Per friend: what they owe me, what I owe them, and the net. The pending panel lists one of these per person.
  function byFriend(people) {
    return Object.fromEntries(Object.entries(people || {}).map(([name, bundle]) => [name, pending(bundle.entries, bundle.settlements)]));
  }

  // ---- series: a run of shared items with one person in one currency, from the first item until it is repaid ----
  // Each series keeps one colour for as long as it lives. A series is done when its balance is back to zero; the next
  // shared item then starts a new series with a new colour. When an item is on the other side of the running balance
  // the series is merged: its items show <--> and the balance, instead of a plain ball. Nothing is ever deleted, so
  // the balance is always what the items and settlements say.
  // The series colours: one fixed list of twelve, the same for every year. Within a month the first series that starts
  // gets the first colour, the next gets the second, and so on; after the twelfth the list starts again. Red and green
  // are left out, as they say which way the money moves.
  const SERIES_COLOURS = ['#2563eb', '#7c3aed', '#0d9488', '#db2777', '#d97706', '#0891b2', '#4f46e5', '#c026d3', '#ca8a04', '#0284c7', '#92400e', '#475569'];
  const signOf = value => (value > 0 ? 1 : value < 0 ? -1 : 0);
  // +: the friend owes me this share; -: I owe him it.
  const signedShare = entry => (isPayerMe(entry) ? split(entry).friendOwes : -split(entry).iOwe);
  // Items: [{ id, amount, paidBy, hisPct, date, series?: { id, colour } }]. Returns Map id → { seriesId, colour, state,
  // balance } where state is 'open', 'merged' or 'done', and balance is what is still owed across the series (+ owed to me).
  function runSeries(items, settlements) {
    const groups = new Map();
    (items || []).forEach(item => {
      const seriesId = item.series?.id || `loose-${item.id}`;
      if (!groups.has(seriesId)) groups.set(seriesId, []);
      groups.get(seriesId).push(item);
    });
    const out = new Map();
    groups.forEach((list, seriesId) => {
      const ordered = list.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
      const balance = ordered.reduce((sum, item) => sum + signOf(signedShare(item)) * outstanding(item, settlements).owed, 0);
      let running = 0;
      let merged = false;
      ordered.forEach(item => {
        const share = signedShare(item);
        if (running !== 0 && share !== 0 && signOf(share) !== signOf(running)) merged = true;
        running += share;
      });
      const state = balance === 0 ? 'done' : merged ? 'merged' : 'open';
      ordered.forEach(item => out.set(item.id, { seriesId, colour: item.series?.colour || null, state, balance }));
    });
    return out;
  }
  // The open series (balance not zero) a new item belongs to: the latest one with the same person and currency, or null.
  // `items` and `settlements` must already be the same person and currency.
  function joinSeries(items, settlements) {
    const groups = new Map();
    (items || []).forEach(item => {
      const key = item.series?.id;
      if (!key) return;
      if (!groups.has(key)) groups.set(key, { id: key, colour: item.series.colour, latest: '', list: [] });
      const group = groups.get(key);
      group.list.push(item);
      if (String(item.date || '') > group.latest) group.latest = String(item.date || '');
    });
    const open = [...groups.values()].filter(group => group.list.reduce((sum, item) => sum + signOf(signedShare(item)) * outstanding(item, settlements).owed, 0) !== 0);
    open.sort((a, b) => b.latest.localeCompare(a.latest));
    return open.length ? { id: open[0].id, colour: open[0].colour } : null;
  }
  // The colour for the series at position `index` in its month (0 is the first): the list in order, wrapping after twelve.
  function colourAt(index) {
    const n = Number.isFinite(Number(index)) ? Number(index) : 0;
    const wrapped = Math.floor(n) % SERIES_COLOURS.length;
    return SERIES_COLOURS[((wrapped % SERIES_COLOURS.length) + SERIES_COLOURS.length) % SERIES_COLOURS.length];
  }

  // The colour a series is drawn in: its stored colour when it is one of the fixed list, otherwise one from the list picked
  // by its id, so old series with other colours still show one of the same twelve.
  function fixedColour(stored, key) {
    const normalized = String(stored ?? '').trim().toLowerCase();
    const match = SERIES_COLOURS.find(colour => colour.toLowerCase() === normalized);
    if (match) return match;
    const hash = [...String(key || '')].reduce((n, ch) => (n * 31 + ch.codePointAt(0)) >>> 0, 7);
    return SERIES_COLOURS[hash % SERIES_COLOURS.length];
  }

  const api = { fixedColour, DEFAULT_HIS_PCT, split, outstanding, pending, settle, profitEffect, byFriend, SERIES_COLOURS, runSeries, joinSeries, colourAt };
  if (typeof module === 'object' && module.exports) module.exports = api;
  global.SharedLedger = api;
})(typeof window !== 'undefined' ? window : globalThis);
