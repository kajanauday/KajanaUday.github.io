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

  // ---- what is really open, after edits: the buffer follows the entries ----
  // Entries and settlements are matched per person and currency (`property` and `with` on both; rows without them are one
  // group). From the history alone this works out, so it stays right when an entry is edited later:
  //   - money applied to an entry beyond what it now owes (its amount or share was reduced) goes back into the buffer;
  //   - the buffer (stored credits + that excess) then clears open items on its own side, oldest first, whole items that
  //     fit, so an entry raised after it was settled is covered at once when the buffer can pay for it.
  // Returns { owed: Map id → { owed, covered, direction, settled }, buffers: Map key → buffer left }. A buffer is signed
  // from my side: positive means the friend has paid me ahead, negative means I have paid him ahead.
  const keyOf = item => `${item.property ?? ''}|${item.with ?? ''}`;
  function resolve(entries, settlements) {
    const applied = appliedTo(settlements);
    const groups = new Map();
    (entries || []).forEach(entry => { const key = keyOf(entry); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entry); });
    const credits = new Map();
    (settlements || []).forEach(settlement => { const key = keyOf(settlement); credits.set(key, (credits.get(key) || 0) + whole(settlement.credit)); });
    const owed = new Map();
    const buffers = new Map();
    const sources = new Map();
    new Set([...groups.keys(), ...credits.keys()]).forEach(key => {
      let held = credits.get(key) || 0;
      // Where the buffer came from: payments that left a surplus, and entries reduced after money was paid on them.
      const from = [];
      (settlements || []).filter(settlement => keyOf(settlement) === key && whole(settlement.credit)).forEach(settlement => from.push({ kind: 'payment', date: settlement.date, label: settlement.name || settlement.note || 'Payment', amount: whole(settlement.credit) }));
      const rows = (groups.get(key) || []).map(entry => {
        const parts = split(entry);
        const mine = isPayerMe(entry);
        const due = mine ? parts.friendOwes : parts.iOwe;
        const paid = applied.get(entry.id) || 0;
        const sign = mine ? 1 : -1;
        if (paid > due) { held += sign * (paid - due); from.push({ kind: 'reduced', date: entry.date, label: entry.description || 'An entry', amount: sign * (paid - due) }); }
        return { entry, sign, open: Math.max(0, due - paid), covered: 0 };
      });
      const lean = Math.sign(held);
      sources.set(key, from.filter(item => Math.sign(item.amount) === lean));
      // Nothing is covered from the buffer by itself: it stays as it is until a settlement uses it.
      rows.forEach(row => owed.set(row.entry.id, { id: row.entry.id, direction: row.sign > 0 ? 'friend-owes-me' : 'i-owe-friend', owed: row.open, covered: row.covered, settled: row.open === 0 }));
      buffers.set(key, held);
    });
    return { owed, buffers, sources };
  }

  // Every open item, grouped by side, with the net between us. `net` is positive when the friend owes me overall, before
  // the buffer; `buffer` is what is held (see resolve), and `overall` is the net with it taken off.
  function pending(entries, settlements) {
    const resolved = resolve((entries || []).filter(entry => entry.shared), settlements);
    const rows = (entries || []).filter(entry => entry.shared).map(entry => ({ entry, ...resolved.owed.get(entry.id) }));
    const open = rows.filter(row => !row.settled);
    const receivable = open.filter(row => row.direction === 'friend-owes-me');
    const payable = open.filter(row => row.direction === 'i-owe-friend');
    const sum = list => list.reduce((total, row) => total + row.owed, 0);
    const buffer = [...resolved.buffers.values()].reduce((total, value) => total + value, 0);
    const net = sum(receivable) - sum(payable);
    // Items the buffer settled by itself, and what the buffer was made of.
    const auto = rows.filter(row => row.covered > 0).map(row => ({ entry: row.entry, id: row.id, amount: row.covered, direction: row.direction }));
    const from = [...resolved.sources.values()].flat();
    return { receivable, payable, receivableTotal: sum(receivable), payableTotal: sum(payable), net, buffer, overall: net - buffer, auto, from };
  }

  // Checks a settlement before it is kept, and works out what it does. `items` are { to, a } pairs: the shared entries
  // it clears and how much of each. `cash` is the money that actually moved, signed from my side: positive means the
  // friend paid me, negative means I paid him. Returns { ok:false, error } or { ok:true, settlement, forgiven, question }.
  function settle({ entries, settlements, items, cash, treatment, credit }) {
    const byId = new Map((entries || []).filter(entry => entry.shared).map(entry => [entry.id, entry]));
    const cleared = (items || []).map(item => ({ to: item.to, a: Math.abs(whole(item.a)) })).filter(item => item.a > 0);
    const held = whole(credit);
    if (!cleared.length && !held) return { ok: false, error: 'Pick the items this payment clears.' };
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
    const forgiven = net + held - moved;
    if (forgiven !== 0 && !['income', 'expense', 'none'].includes(treatment)) {
      return { ok: true, forgiven, question: forgiven > 0 ? 'Count the forgiven amount as an expense, or leave it out?' : 'Count the forgiven amount as income, or leave it out?', settlement: null };
    }
    const settlement = { items: cleared, cash: moved, forgiven, treatment: forgiven === 0 ? 'none' : treatment };
    if (held) settlement.credit = held;
    return { ok: true, forgiven, question: null, settlement };
  }

  // ---- the buffer: cash that moved but did not clear a whole item ----
  // Each settlement may carry `credit`: cash it took in (+) or paid out (-) beyond the items it cleared, or minus what it
  // took from the buffer. Cash = what the items net to + credit. The buffer is the sum of every credit: positive means the
  // friend has paid me ahead, negative means I have paid him ahead. It waits for the next payment.
  function buffer(settlements) {
    return (settlements || []).reduce((sum, settlement) => sum + whole(settlement.credit), 0);
  }
  // Works out what a payment clears by itself. `cash` is signed from my side (+ the friend paid me, - I paid him).
  // The funds are the cash plus the buffer already held. They clear the open items on the side they pay for, oldest
  // first, a whole item at a time: an item too big for what is left is skipped and a later, smaller one may still fit.
  // What cannot clear anything stays in the buffer. Returns { items, credit, buffer, funds, direction }.
  function allocate({ entries, settlements, cash }) {
    const open = pending(entries, settlements);
    const held = open.buffer;
    const moved = whole(cash);
    const funds = moved + held;
    const direction = funds > 0 ? 'friend-owes-me' : funds < 0 ? 'i-owe-friend' : null;
    let left = Math.abs(funds);
    const items = [];
    if (direction) {
      const list = (direction === 'friend-owes-me' ? open.receivable : open.payable)
        .slice().sort((a, b) => String(a.entry.date || '').localeCompare(String(b.entry.date || '')) || String(a.id).localeCompare(String(b.id)));
      list.forEach(row => {
        if (row.owed <= left) { items.push({ to: row.id, a: row.owed }); left -= row.owed; }
      });
    }
    const sign = funds < 0 ? -1 : 1;
    const newBuffer = sign * left;
    return { items, credit: newBuffer - held, buffer: newBuffer, funds, direction };
  }

  // What a payment does, worked out from the open items alone. `cash` is signed from my side (+ the friend paid me, - I paid
  // him). The cash plus any buffer already held are the funds.
  //   - Funds that cover the whole balance between us clear every open item on both sides; what is over is kept as buffer.
  //   - Otherwise the SERIES are paid one at a time, oldest first (a series is a run of shared items with one person, see
  //     runSeries; entries without one count as a single series). Funds that cover a series' own balance (what the friend
  //     owes less what I owe) clear all of it, both sides; a series that cancels out clears free of charge. Funds that fall
  //     short pay that series' items on the side they are for, oldest first, the last one possibly in part. A series whose
  //     balance runs the other way is left for later.
  // Cash always equals what the items net to plus `credit`, so a payment never leaves an unexplained difference.
  // Returns { items: [{ to, a }], credit, buffer, funds }.
  function planPayment({ entries, settlements, cash }) {
    const open = pending(entries, settlements);
    const held = open.buffer;
    const funds = whole(cash) + held;
    const byAge = list => list.slice().sort((a, b) => String(a.entry.date || '').localeCompare(String(b.entry.date || '')) || String(a.id).localeCompare(String(b.id)));
    const everything = [...open.receivable, ...open.payable];
    const coversAll = everything.length && (open.net === 0 ? funds === 0 : Math.sign(funds) === Math.sign(open.net) && Math.abs(funds) >= Math.abs(open.net));
    const items = [];
    let left = funds;
    if (coversAll) {
      everything.forEach(row => items.push({ to: row.id, a: row.owed }));
      left = funds - open.net;
    } else if (funds) {
      const groups = new Map();
      everything.forEach(row => {
        const id = row.entry.series?.id || row.entry.item?.series?.id || 'legacy';
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(row);
      });
      const ordered = [...groups.values()].sort((x, y) => byAge(x)[0].entry.date.localeCompare(byAge(y)[0].entry.date));
      for (const rows of ordered) {
        if (!left) break;
        const net = rows.reduce((sum, row) => sum + (row.direction === 'friend-owes-me' ? row.owed : -row.owed), 0);
        if (net === 0) { rows.forEach(row => items.push({ to: row.id, a: row.owed })); continue; }
        if (Math.sign(net) !== Math.sign(left)) continue;
        if (Math.abs(left) >= Math.abs(net)) { rows.forEach(row => items.push({ to: row.id, a: row.owed })); left -= net; continue; }
        let rest = Math.abs(left);
        byAge(rows.filter(row => (row.direction === 'friend-owes-me') === (left > 0))).forEach(row => {
          if (rest <= 0) return;
          const a = Math.min(row.owed, rest);
          items.push({ to: row.id, a });
          rest -= a;
        });
        left = Math.sign(left) * rest;
      }
    }
    return { items, credit: left - held, buffer: left, funds };
  }

  // ---- the stored report: one person's shared side, worked out once and kept (sharedReport/<currency>/<person>) ----
  // Everything the People page draws, so opening it reads this and works nothing out: each shared entry with what is still
  // open on it, the totals and the buffer, the settlements, and `closed`: one group per settlement that finished entries. An
  // entry belongs to the settlement that paid off the last of it (`closedBy`); everything that settlement closed is one settled
  // box, and the entries still open stay in the running box. So a settlement, whether made with the Settle button or an entry made
  // a settlement for several expenses, gathers everything it paid off into one box. A pure function of the entries and
  // settlements; they must already be one person in one currency. Returns plain data, safe to save.
  const REPORT_VERSION = 4;
  function report(entries, settlements) {
    const shared = (entries || []).filter(entry => entry.shared);
    const real = (settlements || []).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.id).localeCompare(String(b.id)));
    const open = pending(shared, real);
    const owedBy = new Map([...open.receivable, ...open.payable].map(row => [row.id, row.owed]));
    const lastOn = new Map();
    real.forEach(settlement => (settlement.items || []).forEach(item => lastOn.set(item.to, settlement.id)));
    const closedBy = entry => (owedBy.has(entry.id) ? '' : lastOn.get(entry.id) || '');
    const groups = new Map();
    shared.forEach(entry => {
      const id = closedBy(entry);
      if (!id) return;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(entry);
    });
    const closed = [...groups].map(([id, list]) => {
      const ids = new Set(list.map(entry => entry.id));
      const byId = new Map(list.map(entry => [entry.id, entry]));
      const touching = real.filter(settlement => (settlement.items || []).some(item => ids.has(item.to)));
      const moved = touching.reduce((sum, settlement) => sum + (settlement.items || []).filter(item => ids.has(item.to))
        .reduce((inner, item) => inner + (byId.get(item.to).paidBy === 'friend' ? -1 : 1) * Math.abs(whole(item.a)), 0), 0);
      const dates = list.map(entry => String(entry.date || '')).sort();
      const last = String(real.find(settlement => settlement.id === id)?.date || '');
      return { id, last, moved, from: dates[0] || '', to: dates[dates.length - 1] || '', count: list.length };
    });
    return {
      v: REPORT_VERSION,
      buffer: open.buffer, net: open.net, overall: open.overall, receivableTotal: open.receivableTotal, payableTotal: open.payableTotal,
      entries: shared.map(entry => ({
        id: entry.id, date: String(entry.date || ''), description: String(entry.description || ''), amount: Math.abs(whole(entry.amount)),
        paidBy: entry.paidBy === 'friend' ? 'friend' : 'me', hisPct: Number(entry.hisPct ?? DEFAULT_HIS_PCT),
        owed: owedBy.get(entry.id) || 0, closedBy: closedBy(entry),
        place: String(entry.place || ''), about: String(entry.about || ''), notes: (entry.notes || []).map(note => ({ id: String(note.id), date: String(note.date || ''), description: String(note.description || ''), place: String(note.place || ''), amount: Math.abs(whole(note.amount)) }))
      })),
      closed,
      settles: real.map(settlement => JSON.parse(JSON.stringify(settlement)))
    };
  }

  // One payment against shared expenses, with some of what is owed the other way counted in it. `balance` is the money in the
  // payment; `targets` are the shared ids it pays, oldest first, each with what is still open on it (`open`: Map id → owed);
  // `counted` are expenses owed the other way that were chosen to be counted ({ id, owed }): they are cleared in full and added to
  // the money, so only the difference leaves the pocket. Nothing is counted that was not chosen, and nothing is netted by itself.
  // Returns { ok, items (what the money pays, to clear), counted (the same, for the other way), total, net, error }.
  function planCounted({ balance, targets, open, counted }) {
    const countedList = (counted || []).filter(row => row.owed > 0).map(row => ({ to: row.id, a: row.owed }));
    const countedTotal = countedList.reduce((sum, row) => sum + row.a, 0);
    let available = Math.max(0, whole(balance)) + countedTotal;
    const items = [];
    (targets || []).forEach(id => {
      const owed = open.get(id) || 0;
      if (available <= 0 || owed <= 0) return;
      const a = Math.min(available, owed);
      items.push({ to: id, a });
      available -= a;
    });
    const total = items.reduce((sum, row) => sum + row.a, 0);
    if (countedTotal && total < countedTotal) return { ok: false, error: 'counted-exceeds', items, counted: countedList, total, net: total - countedTotal, countedTotal };
    return { ok: true, items, counted: countedList, total, net: total - countedTotal, countedTotal };
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
    const resolved = resolve(items, settlements);
    groups.forEach((list, seriesId) => {
      const ordered = list.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
      const balance = ordered.reduce((sum, item) => sum + signOf(signedShare(item)) * (resolved.owed.get(item.id)?.owed ?? 0), 0);
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

  const api = { resolve, buffer, allocate, planPayment, planCounted, report, REPORT_VERSION, fixedColour, DEFAULT_HIS_PCT, split, outstanding, pending, settle, profitEffect, byFriend, SERIES_COLOURS, runSeries, joinSeries, colourAt };
  if (typeof module === 'object' && module.exports) module.exports = api;
  global.SharedLedger = api;
})(typeof window !== 'undefined' ? window : globalThis);
