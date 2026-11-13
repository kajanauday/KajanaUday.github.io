// ExpenseStore: the single owner of ledger data, backed by Firebase Realtime Database (REST API).
//
// Firebase layout under `root`:
//   currencies/<cur>                 display config per currency (name, code, symbol, locale, color, order)
//   years/<year>                     one year, small enough to render the whole shell from:
//     currencies/<cur>               { from: "August", opening, carryIn }  start month; the year opens on `opening`, or on the
//                                    previous year's closing balance when carryIn is true
//     monthConfig/<year>_<Month>     { <cur>: { active, carry } }  per-month overrides: currency on/off, and whether the month
//                                    brings in the previous balance (default: active from `from`, carry on)
//     monthSections/<year>_<Month>/<cur>  { own: true, sections[{ name, type, subsections[] }] }  each month's own taxonomy per
//                                    currency; a month without one has no sections. (A legacy year-wide `sections[]` is moved
//                                    into every month once, on open, and then removed.)
//     metadata                       { entries, currencies[], <cur>: { income, expenses, balance, entries, opening, closing } }
//     months/<year>_<Month>          { name, month, currencies[], metadata: { entries, <cur>: { income, expenses, balance, entries,
//                                    closing, carried, previous } } }
//
// Carry-forward: a month that carries brings in the previous balance (the prior month's closing, or the year's opening for its
// first month) as income when positive or as an expense when negative; one that does not starts from zero. Month income and
// expenses include that carried amount; `carried` records it so the entries-only figures can always be recovered.
//   months/<year>_<Month>            that month's entries: <cur> → income/expenses → [{ category, total, count, entries[] }] → notes[]
//   events/<id>                      a special event (marriage, registration…): a standalone ledger like a month, whose entries
//                                    carry full dates and may fall in any month or year:
//                                    { name, year, created, include, currencies[], sections/<cur>[], entries: <cur> → income/expenses →
//                                    [{ category, total, count, entries[{ date, …, notes[{ date, … }] }] }] }
//                                    With `include` on, each entry also counts in the month of its date (totals, balances, the
//                                    year's totals); a month's metadata keeps that share as `fromEvents` so it can be taken out.
//                                    goes out again (a loan and its repayments, an advance and its refund): any entries
//
// The shell (year tabs, month rows, the year card's figures) is drawn from `years` alone. A month's entries are fetched only when it is
// opened (ensureMonth). Amounts are minor units (paise / sen). An entry with notes counts as the sum of its notes.
(function (global) {
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // A balance section (type 'net', drawn beside Income and Expenses) keeps its signed entries in a third bucket.
  const BUCKETS = [['income', 'income'], ['expenses', 'expense'], ['net', 'net']];
  const bucketOf = type => (type === 'income' ? 'income' : type === 'net' ? 'net' : 'expenses');
  const pad = n => String(n).padStart(2, '0');
  const monthIdOf = (year, monthIndex) => `${year}_${MONTH_NAMES[monthIndex]}`;
  const dateKeyOf = (year, monthIndex) => `${year}-${pad(monthIndex + 1)}`;
  const noteTotal = (amount, notes) => (notes.length ? notes.reduce((sum, note) => sum + Number(note.amount), 0) : Number(amount));
  // The figure a row counts for: a shared expense counts my share of its full amount (worked out from its split, so the
  // stored amount is never changed by sharing); any other row counts its amount as it is.
  const REPAY_COLOUR = '#0d9488';
  const TRASH_LIMIT = 25;
  // What an entry counts for once its notes are in: with notes, their sum (a shared entry then counts my share of that sum);
  // without, its own figure.
  const entryWith = (item, notes) => {
    if (!notes.length) return shareOf(item);
    const sum = notes.reduce((total, note) => total + Number(note.amount), 0);
    return item.sid && item.shared && global.SharedLedger
      ? global.SharedLedger.split({ amount: Math.abs(sum), paidBy: item.shared.by, hisPct: item.shared.his }).myShare
      : sum;
  };
  const shareOf = row => (row.sid && row.shared && global.SharedLedger
    ? global.SharedLedger.split({ amount: Math.abs(Number(row.amount) || 0), paidBy: row.shared.by, hisPct: row.shared.his }).myShare
    : Number(row.amount));
  const zeroTotals = () => ({ income: 0, expenses: 0, entries: 0 });
  // What the blocks hold, for the year summary: savings put in (savedIn) and their balance (saved), the returns they
  // earned, what is on hold, what the other side kept of it, what is lent out and what is borrowed. Balances are signed
  // so that a month's figure added to the months before it gives what is still open.
  const emptyHoldings = () => ({ saved: 0, savedIn: 0, returns: 0, held: 0, kept: 0, lent: 0, borrowed: 0 });
  const addHoldings = (a = {}, b = {}) => Object.fromEntries(Object.keys(emptyHoldings()).map(key => [key, (a[key] || 0) + (b[key] || 0)]));
  // Cash tied up in savings, deposits or loans is unavailable; borrowed cash is available. `held` and `lent` already
  // exclude the parts kept or written off, which are counted as expenses in the ordinary totals.
  const cashBalanceAdjustment = holdings => -(holdings.saved || 0) - (holdings.held || 0) - (holdings.lent || 0) + (holdings.borrowed || 0);
  const otherSectionName = type => (type === 'income' ? 'Other income' : type === 'net' ? 'Other balance' : 'Other expenses');

  // Amount fields accept a formula such as "=(210+178)+178": + - * /, brackets and decimals only. A small parser
  // works it out; nothing is passed to eval. Returns { value, formula } in major units, or { error } / { empty }.
  function readAmount(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { empty: true };
    if (!text.startsWith('=')) {
      const value = Number(text.replace(/,/g, ''));
      return Number.isFinite(value) ? { value, formula: null } : { error: true };
    }
    const src = text.slice(1).replace(/[\s,]/g, '');
    let at = 0;
    const fail = () => { throw new Error('bad formula'); };
    const sum = () => {
      let value = product();
      while (src[at] === '+' || src[at] === '-') value = src[at++] === '+' ? value + product() : value - product();
      return value;
    };
    const product = () => {
      let value = unary();
      while (src[at] === '*' || src[at] === '/') value = src[at++] === '*' ? value * unary() : value / unary();
      return value;
    };
    const unary = () => {
      if (src[at] === '-') { at++; return -unary(); }
      if (src[at] === '+') { at++; return unary(); }
      if (src[at] === '(') {
        at++;
        const value = sum();
        if (src[at++] !== ')') fail();
        return value;
      }
      const match = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(at));
      if (!match) fail();
      at += match[0].length;
      return Number(match[0]);
    };
    try {
      if (!src) fail();
      const value = sum();
      if (at !== src.length || !Number.isFinite(value)) fail();
      return { value, formula: `=${src}` };
    } catch (error) {
      return { error: true };
    }
  }

  function iconFor(category, type) {
    if (type === 'income') return 'ti-arrow-down-left';
    const key = category.toLowerCase();
    if (key.includes('food') || key.includes('dining') || key.includes('grocer')) return 'ti-tools-kitchen-2';
    if (key.includes('travel') || key.includes('transport')) return 'ti-train';
    if (key.includes('house') || key.includes('rent')) return 'ti-home';
    if (key.includes('util')) return 'ti-bolt';
    if (key.includes('shop')) return 'ti-shopping-bag';
    return 'ti-receipt';
  }

  // One key per name for de-duplication: same letters regardless of case, repeated spaces, Unicode composition or the
  // invisible joiners Telugu text often carries.
  const nameKey = name => String(name ?? '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

  class FirebaseDb {
    // readOnly (view-only accounts): reads as usual, but every write is dropped here, before any request is made.
    // auth, when given, resolves to a Firebase Auth ID token that goes with every request, so database rules can tell
    // the admin from a view-only account.
    constructor(databaseURL, root, readOnly = false, auth = null) {
      this.base = `${databaseURL.replace(/\/$/, '')}/${root}`;
      this.readOnly = readOnly;
      this.auth = auth;
    }
    async request(path, options) {
      const token = this.auth ? await this.auth() : null;
      const response = await fetch(`${this.base}${path ? `/${path}` : ''}.json${token ? `?auth=${encodeURIComponent(token)}` : ''}`, options);
      if (!response.ok) throw new Error(`Firebase ${options?.method || 'GET'} ${path || '/'} failed: HTTP ${response.status}`);
      return response.json();
    }
    get(path) { return this.request(path); }
    // Multi-path update: keys are paths under root, null deletes. Applied atomically.
    patch(update) { return this.readOnly ? Promise.resolve(null) : this.request('', { method: 'PATCH', body: JSON.stringify(update) }); }
  }

  // Firebase drops empty arrays and objects, so restore them before the UI reads a year.
  // Firebase will not take . $ # [ ] or / in a key, and a name typed by hand becomes one: a section keeps its roles and
  // its subsection descriptions per subsection name. One such name makes Firebase refuse the whole update, so that year
  // and every save behind it stop going out, for good. Rather than refuse what someone typed, each of the six is
  // swapped for the character that looks like it and is allowed, so the name reads as written and the ledger saves.
  // Swapping twice changes nothing, which is what lets this sit on every door the data comes through — loading,
  // renaming, pasting and sending — and have them all agree on one spelling.
  const KEY_SWAPS = { '.': '․', $: '＄', '#': '＃', '[': '［', ']': '］', '/': '／' };
  const safeKey = name => String(name ?? '').replace(/[.$#[\]/]/g, character => KEY_SWAPS[character]);
  const safeKeysOf = map => (map && typeof map === 'object' && !Array.isArray(map)
    ? Object.fromEntries(Object.entries(map).map(([name, value]) => [safeKey(name), value]))
    : map);
  const normalizeSections = sections => (sections || []).map(section => ({
    ...section,
    name: section.name === undefined ? section.name : safeKey(section.name),
    subsections: (section.subsections || []).map(safeKey),
    ...(section.roles ? { roles: safeKeysOf(section.roles) } : {}),
    ...(section.subAbout ? { subAbout: safeKeysOf(section.subAbout) } : {})
  }));
  function normalizeYear(year = {}) {
    year.currencies ||= {};
    if (year.sections) year.sections = normalizeSections(year.sections);
    year.monthSections ||= {};
    Object.values(year.monthSections).forEach(month => Object.values(month).forEach(own => { own.sections = normalizeSections(own.sections); }));
    year.metadata ||= { entries: 0 };
    year.metadata.currencies ||= [];
    year.months ||= {};
    year.monthConfig ||= {};
    Object.values(year.months).forEach(month => {
      month.currencies ||= [];
      month.metadata ||= { entries: 0 };
    });
    return year;
  }

  // One stored month → flat entries; notes become sub-entries of their entry. Ids are derived from position.
  // A shared expense written by the earlier version kept my share as its amount and the full cost in its marker. It is read
  // here with the full cost as its amount, as it is now kept; the marker's copy is dropped on the next save.
  function sharedMigrated(row) {
    if (!row.sid || !row.shared || row.shared.total === undefined) return row;
    const { total, ...shared } = row.shared;
    return { ...row, amount: Math.abs(Math.round(Number(total) || 0)), shared };
  }
  function flattenMonth(monthId, currencies, currencyKeys) {
    const year = monthId.slice(0, 4);
    const dateKey = dateKeyOf(year, MONTH_NAMES.indexOf(monthId.slice(5)));
    const list = [];
    currencyKeys.forEach(currency => {
      const buckets = currencies?.[currency];
      if (!buckets) return;
      let index = 0;
      BUCKETS.forEach(([bucket, type]) => {
        (buckets[bucket] || []).forEach(({ category, entries = [] }) => entries.forEach(({ day, notes = [], ...entry }) => {
          const id = `${currency}-${dateKey}-${++index}`;
          // The same swap the sections get, so an entry still points at the subsection it belongs to.
          const safeCategory = safeKey(category);
          const home = entry.section === undefined ? {} : { section: safeKey(entry.section) };
          list.push(sharedMigrated({ ...entry, ...home, id, date: `${dateKey}-${pad(day)}`, property: currency, type, category: safeCategory }));
          notes.forEach(({ day: noteDay, ...note }, n) => list.push({ ...note, id: `${id}-note-${n + 1}`, parentId: id, date: `${dateKey}-${pad(noteDay ?? day)}`, property: currency, type, category: safeCategory }));
        }));
      });
    });
    return list;
  }

  // Flat entries of one month → the stored month document (null when the month has no entries). An event's document is
  // the same shape, but entries and notes keep their full date instead of the day.
  function monthDoc(items, dated = false) {
    const doc = {};
    const childrenOf = new Map();
    items.filter(item => item.parentId).forEach(item => {
      if (!childrenOf.has(item.parentId)) childrenOf.set(item.parentId, []);
      childrenOf.get(item.parentId).push(item);
    });
    items.filter(item => !item.parentId).sort((a, b) => a.date.localeCompare(b.date)).forEach(item => {
      const groups = (doc[item.property] ||= { income: [], expenses: [] })[bucketOf(item.type)] ||= [];
      let group = groups.find(g => g.category === item.category);
      if (!group) groups.push(group = { category: item.category, total: 0, count: 0, entries: [] });
      const when = row => (dated ? { date: row.date } : { day: Number(row.date.slice(8, 10)) });
      // Hashtags given by gesture (lower case, without #), on entries and notes alike.
      const tagsOf = row => (row.tags?.length ? { tags: [...row.tags] } : {});
      // A row's own description (see readStatus): kept only when there is one.
      const aboutOf = row => (row.about ? { about: String(row.about) } : {});
      // What part of a settlement entry was mine (see splitShare), kept only when one was recorded and always in a
      // settled shape, so a malformed split never reaches the ledger. Anything an entry can hold has to be written
      // here: saveTransactions decides whether to write at all by comparing this document with the last copy sent, so
      // a field missing from here makes a real change look like no change — it is never saved, never synced, and
      // disappears on the next reload.
      const splitOf = row => {
        const split = row.split;
        if (!split || !SPLIT_MODES.includes(split.m)) return {};
        if (split.m === 'equal') return { split: { m: 'equal', n: Math.max(1, Math.round(Number(split.n) || 1)) } };
        if (split.m === 'amount') return { split: { m: 'amount', a: Math.abs(Math.round(Number(split.a) || 0)) } };
        return { split: { m: split.m } };
      };
      // What a repayment or a receipt inside a settlement was for (see normalizeAlloc): the subsections it covers and
      // how much of it each one takes. Written here for the same reason a split is — saveTransactions decides whether
      // to write at all by comparing this document with the last copy sent, so a field missing from here is a change
      // that is never saved, never synced, and gone on the next reload.
      const allocOf = row => {
        const list = normalizeAlloc(row.alloc);
        return list.length ? { alloc: list } : {};
      };
      // A shared expense's stable key and its marker (see shared-ledger.js). The key is what a settlement points at: an
      // entry's own id is only its place in the month, and it changes on every load.
      const sharedOf = row => (row.sid && row.shared ? { ...(row.series?.id && { series: { id: String(row.series.id), colour: String(row.series.colour || '') } }), sid: String(row.sid), shared: { by: row.shared.by === 'friend' ? 'friend' : 'me', his: Math.min(100, Math.max(0, Math.round(Number(row.shared.his) || 0))), with: String(row.shared.with || '').trim() || 'Friend' } } : {});
      // A ledger entry that clears a settlement carries the settlement's id and the series colour, shown as CLEARED.
      // An expense added in one month for another (see here-and-there.js): the real entry keeps its reference key and the
      // date it is for; a marker keeps the key of the entry it stands for, that entry's amount and its date.
      const refOf = row => ({ ...(row.refKey ? { refKey: String(row.refKey) } : {}), ...(row.refDate ? { refDate: String(row.refDate) } : {}), ...(row.markerOf ? { markerOf: { key: String(row.markerOf.key), amount: Math.round(Number(row.markerOf.amount)) || 0, ...(row.markerOf.from ? { from: String(row.markerOf.from) } : {}) } } : {}) });
      // A link to a special card: the entry stays where it is; the card lists it (see cardLinked).
      const cardOf = row => (row.card ? { card: String(row.card) } : {});
      const clearedOf = row => (row.cleared?.id ? { cleared: { id: String(row.cleared.id), colour: String(row.cleared.colour || '') } } : {});
      // A repayment keeps a stable key to the original money entry, plus enough context to find it after reload.
      const moneyLinkOf = row => ({
        ...(row.moneyId ? { moneyId: String(row.moneyId) } : {}),
        ...(row.moneyRole ? { moneyRole: String(row.moneyRole) } : {}),
        ...(row.moneyRef?.date && row.moneyRef?.description ? {
          moneyRef: {
            date: String(row.moneyRef.date),
            description: String(row.moneyRef.description),
            ...(row.moneyRef.section ? { section: String(row.moneyRef.section) } : {}),
            ...(row.moneyRef.category ? { category: String(row.moneyRef.category) } : {})
          }
        } : {})
      });
      const notes = (childrenOf.get(item.id) || []).map(note => ({ ...when(note), description: note.description, place: note.place || '', amount: Number(note.amount), ...(note.formula && { formula: note.formula }), ...tagsOf(note), ...aboutOf(note) }));
      const entry = { ...when(item), description: item.description, place: item.place || '', amount: Number(item.amount), ...tagsOf(item), ...aboutOf(item), ...splitOf(item), ...allocOf(item), ...sharedOf(item), ...clearedOf(item), ...cardOf(item), ...refOf(item), ...moneyLinkOf(item) };
      if (item.formula) entry.formula = item.formula;
      if (item.section) entry.section = item.section;
      entry.notes = notes;
      group.entries.push(entry);
      group.count += 1;
      if (!item.cleared) group.total += entryWith(item, notes);
    });
    return Object.keys(doc).length ? doc : null;
  }

  // Entries-only totals from a stored month's metadata (which includes any carried balance and any events' share).
  function rawFromStored(stored) {
    if (!stored) return zeroTotals();
    const carried = Number(stored.carried) || 0;
    const events = stored.fromEvents || zeroTotals();
    return { income: stored.income - Math.max(carried, 0) - (events.income || 0), expenses: stored.expenses - Math.max(-carried, 0) - (events.expenses || 0), entries: (stored.entries || 0) - (events.entries || 0), holdings: stored.holdings || emptyHoldings() };
  }

  // One event's stored entries → flat items, marked with eventId so they never land in a month's document.
  function flattenEvent(eventId, currencies, currencyKeys) {
    const list = [];
    currencyKeys.forEach(currency => {
      const buckets = currencies?.[currency];
      if (!buckets) return;
      let index = 0;
      BUCKETS.forEach(([bucket, type]) => {
        (buckets[bucket] || []).forEach(({ category, entries = [] }) => entries.forEach(({ date, notes = [], ...entry }) => {
          const id = `ev:${eventId}:${currency}-${++index}`;
          list.push(sharedMigrated({ ...entry, id, eventId, date, property: currency, type, category }));
          notes.forEach(({ date: noteDate, ...note }, n) => list.push({ ...note, id: `${id}-note-${n + 1}`, parentId: id, eventId, date: noteDate || date, property: currency, type, category }));
        }));
      });
    });
    return list;
  }
  function normalizeEvent(event = {}, currencyKeys = []) {
    const sections = event.sections || {};
    const currencies = (event.currencies || []).filter(key => currencyKeys.includes(key));
    return {
      name: event.name || 'Event',
      created: event.created || '',
      // The year whose list the event sits at the top of; older events take the year they were created in.
      year: Number(event.year) || Number(String(event.created || '').slice(0, 4)) || new Date().getFullYear(),
      include: Boolean(event.include),
      currencies: currencies.length ? currencies : currencyKeys.slice(0, 1),
      sections: Object.fromEntries(Object.entries(sections).map(([key, list]) => [key, normalizeSections(list)]))
    };
  }

  // A custom section (L1, beside Income and Expenses) is worked out like a small sheet, kept on the section as `calc`:
  //   vars     [{ id: 'E1', name }]: each subsection (L2) has a fixed id, standing for the sum of its entries (an entry
  //            counts as the sum of its notes). Ids follow renames and are never reused, so equations stay right.
  //   lines    ['Share = (E1 - E2) / 2', 'GI = TI', 'GB = GI - GE', …]: calculations, in any order. GI, GE and GB are
  //            the section's income, expenses and balance as shown in its heading: each only when a line sets it.
  //            TI and TE are its entries' own totals, positive ones and negative ones (as a positive sum), to use anywhere.
  //            Names are not case sensitive.
  //   income / expense  { mode, formula }: what goes to the month's actual income and expenses.
  //            mode 'count' shown there and added to its total; 'show' shown only; 'off' not used. Empty sends nothing.
  //   v        2 since GI / GE / GB are set by hand; before, they were always the entries' totals and an empty formula was GB.
  // Equations use numbers, + − * / ( ), and abs(), min(), max(), round(); amounts are in major units.
  const SIDE_MODES = ['count', 'show', 'off'];
  const CALC_FUNCTIONS = { ABS: Math.abs, MIN: Math.min, MAX: Math.max, ROUND: Math.round };
  const GRAND = ['GI', 'GE', 'GB'];
  // Read-only figures an equation may use. TI / TE are every entry, positive and negative; the rest come from the roles
  // each subsection carries (see ROLES) and are what make a settlement or a savings pot work out realistically:
  //   CI / CO   cash in and cash out: every entry whose role is a real movement of money (a memo role is left out), so
  //             a shared cost of 1000 recovered 500 reads as CI 500 and CO 1000, never as a single netted 500.
  //   OWED      what is still outstanding, signed: more than zero is owed to me, less than zero is what I owe.
  //   MS        my own share of what the group spent, as a positive cost.
  //   SV / RT   a savings pot: what was put in less what was taken out, and the interest or gain credited to it.
  //   SI / SO   money that passed between me and the other side: what came to me, and what I handed over. They are the
  //             repayment half of CI / CO, so what was laid out for the group on its own is CI - SI and CO - SO.
  //   AL / UA   of that repayment money, how much has been said what it was for (see normalizeAlloc) and how much has
  //             not. Both are positive sums, and together they come to SI + SO.
  const ENTRY_TOTALS = ['TI', 'TE', 'CI', 'CO', 'OWED', 'MS', 'SV', 'RT', 'SI', 'SO', 'AL', 'UA', 'HD', 'KP', 'LT', 'WO', 'LI', 'BR', 'BI'];
  const SUB_ID = /^E\d+$/;
  // A custom section is either a settlement (money shared with someone: a split bill, a loan, someone investing in me)
  // or a savings pot. Both live inside their own single block; a month never has more than one of each block.
  const SECTION_KINDS = ['settlement', 'savings', 'hold', 'lent', 'borrowed'];
  const MONEY_ACCOUNT_ROLES = { savings: 'save', hold: 'hold', lent: 'lend', borrowed: 'borrow' };
  function linkedMoneyBalance(moneyId, kind, items, amountOf = item => Number(item.amount), throughDate = '9999-12-31', raw = false) {
    const role = MONEY_ACCOUNT_ROLES[kind];
    if (!moneyId || !role) return 0;
    const balance = items.reduce((sum, item) => {
      if (item.parentId || item.moneyId !== moneyId || (item.date && item.date > throughDate)) return sum;
      const amount = Number(amountOf(item)) || 0;
      if (item.moneyRole === role) return sum + amount;
      if ((kind === 'hold' && item.moneyRole === 'kept') || (kind === 'lent' && item.moneyRole === 'writeoff')) return sum - amount;
      if (kind === 'savings' && item.moneyRole === 'return' && amount < 0) return sum + amount;
      return sum;
    }, 0);
    return raw ? balance : Math.max(0, balance);
  }
  // Three more blocks, each for money that sits somewhere and comes back (see the roles below):
  //   hold      hold     paid in (positive) or had back (negative) — a deposit or an advance; neither income nor expense
  //             kept     the part of it the other side kept — an expense, and no money moves, so it is a memo
  //   lent      lend     given (positive) or repaid (negative) — neither income nor expense
  //             writeoff the part that will never come back — an expense, and a memo
  //             earned   interest received on it — income
  //   borrowed  borrow   received (positive) or repaid (negative) — neither income nor expense
  //             charged  interest paid on it — an expense
  // What a subsection of one stands for. Only a cash role moves money; a memo role explains it.
  //   settlement  cost    what I laid out for the group (negative) or had back for it (positive) — cash
  //               share   my own portion of that cost, written as a negative — memo, never a movement of money
  //               settle  money passing between me and the other side: they paid me (positive), I paid them
  //                       (negative). A loan given, or someone investing in me, is this with no cost beside it — cash
  //   savings     save    put into the pot (positive) or taken back out (negative) — cash, but a transfer between my
  //                       own pockets, so by itself it is neither income nor an expense
  //               return  interest, dividend or gain credited to the pot — cash, and real income
  const ROLES = { settlement: ['cost', 'share', 'settle'], savings: ['save', 'return'], hold: ['hold', 'kept'], lent: ['lend', 'writeoff', 'earned'], borrowed: ['borrow', 'charged'] };
  const MEMO_ROLES = new Set(['share', 'kept', 'writeoff']);
  // Only money laid out for the group is divided, so that is the role a split belongs to. A repayment under "Settled
  // up" moves money between the two sides; it is not a cost with a share of its own.
  const SPLIT_ROLE = 'cost';
  // Money passing between the two sides is the only thing there is to allocate: it is the entry that pays something
  // off, or that arrives for some purpose. A cost already says what it was for — it is sitting under that heading.
  const ALLOC_ROLE = 'settle';
  // How one entry says what part of it was mine, so the split sits on the entry that was shared instead of in a second
  // subsection kept beside it by hand:
  //   { m: 'mine' }             all of it was mine — nothing is owed either way
  //   { m: 'equal', n: 3 }      shared equally, three ways
  //   { m: 'none' }             none of it was mine: I paid the lot for them, or took the lot and owe it back
  //   { m: 'amount', a: 1250 }  exactly this much of it was mine
  // No split means nothing was recorded, which is what every entry held before this existed. It adds nothing, so a
  // ledger written before splits reads exactly as it always did.
  const SPLIT_MODES = ['mine', 'equal', 'none', 'amount'];
  // One repayment usually pays off more than one thing at once: 130,000 handed over might clear the rent, part of the
  // car and the whole of a loan. Money coming the other way is the same question asked backwards — what is it for.
  // So a "Settled up" entry carries `alloc`: the subsections of its own settlement it covers, each with a positive
  // amount in minor units. The entry's own sign says which way the money went, so an allocation never carries one.
  //   [{ to: 'Rent', a: 5000000 }, { to: 'Car', a: 8000000 }]
  // Nothing has to be allocated: an entry with no `alloc` is exactly what every repayment was before this existed,
  // and counts the same. A name no longer among the subsections is kept rather than dropped — it costs nothing, and
  // it comes back the moment that subsection does (a rename carries its allocations with it).
  const MAX_ALLOC = 40;
  function normalizeAlloc(value) {
    const seen = new Map();
    listOf(value).forEach(item => {
      if (!item || typeof item !== 'object') return;
      const to = String(item.to ?? '').trim();
      const amount = Math.abs(Math.round(Number(item.a) || 0));
      if (!to || !amount || seen.size >= MAX_ALLOC && !seen.has(to)) return;
      seen.set(to, (seen.get(to) || 0) + amount);
    });
    return [...seen].map(([to, a]) => ({ to, a }));
  }
  const allocTotal = list => normalizeAlloc(list).reduce((sum, item) => sum + item.a, 0);
  // An allocation never says more than the entry it sits on: the entries are trimmed in order until they fit, so a
  // half-finished edit can overstate what a repayment covered but the figures never can.
  function allocFor(amount, list) {
    let left = Math.abs(Math.round(Number(amount) || 0));
    const out = [];
    normalizeAlloc(list).forEach(item => {
      const take = Math.min(item.a, left);
      left -= take;
      if (take) out.push({ to: item.to, a: take });
    });
    return out;
  }
  function splitShare(amount, split) {
    const value = Number(amount) || 0;
    const mode = split?.m;
    if (!value || !SPLIT_MODES.includes(mode) || mode === 'none') return 0;
    if (mode === 'mine') return value;
    if (mode === 'equal') return Math.round(value / Math.max(1, Math.round(Number(split.n) || 1)));
    // An exact share never runs past the entry it belongs to, and always points the same way as it.
    const mine = Math.min(Math.abs(Math.round(Number(split.a) || 0)), Math.abs(value));
    return value < 0 ? -mine : mine;
  }
  // What a split says, in words, for the row it sits on and for the picker that sets it.
  function splitLabel(split, ways = null) {
    const mode = split?.m;
    if (!SPLIT_MODES.includes(mode)) return '';
    if (mode === 'mine') return 'All mine';
    if (mode === 'none') return 'None mine';
    if (mode === 'equal') { const n = ways || Math.max(1, Math.round(Number(split.n) || 1)); return n === 2 ? 'Half mine' : `1/${n} mine`; }
    return 'Part mine';
  }
  const DEFAULT_ROLE = { settlement: 'cost', savings: 'save', hold: 'hold', lent: 'lend', borrowed: 'borrow' };
  const ROLE_LABELS = {
    cost: 'Paid for the group', share: 'My share', settle: 'Settled up',
    save: 'Put in or taken out', return: 'Interest or gain',
    hold: 'Paid in or had back', kept: 'Kept by them (an expense)',
    lend: 'Given or repaid', writeoff: 'Written off (an expense)', earned: 'Interest earned',
    borrow: 'Received or repaid', charged: 'Interest paid'
  };
  // ---- descriptions, their status words, and a section's lifecycle ----------------------------
  // Any section, subsection, entry or note may carry a description (`about`): a longer note kept out of the row itself,
  // behind a small mark, and locked until it is deliberately unlocked so a stray double-click never rewrites it.
  //
  // A description may set a status on a line of its own that starts with "=": "=paid". The word is shown as a capsule,
  // coloured by what it means rather than by how it is spelled, so "paid" is green wherever it is written.
  // It has to be the whole line, so an "=" inside a sentence ("split = 500 each") is left alone as ordinary prose.
  const STATUS_TONES = {
    done: ['paid', 'done', 'closed', 'settled', 'complete', 'completed', 'received', 'cleared', 'delivered', 'approved', 'ok', 'yes'],
    waiting: ['pending', 'waiting', 'partial', 'progress', 'ongoing', 'hold', 'onhold', 'review', 'draft', 'later'],
    overdue: ['due', 'overdue', 'unpaid', 'missed', 'failed', 'rejected', 'late', 'owed', 'no'],
    dropped: ['cancelled', 'canceled', 'dropped', 'void', 'ignored', 'na', 'none', 'closedlost']
  };
  const STATUS_TONE = new Map(Object.entries(STATUS_TONES).flatMap(([tone, words]) => words.map(word => [word, tone])));
  // A whole line that is "=" and one word. The word must start with a letter or digit, so "= 500" is not a status.
  const STATUS_MARK = /^[ \t]*=[ \t]*([\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*)[ \t]*$/imu;
  // The status a description sets, or null. `tone` is what it means; an unknown word still shows, in a plain capsule.
  // The last such line wins, so adding "=paid" under an earlier "=pending" moves the row on.
  function readStatus(text) {
    const lines = String(text ?? '').split('\n');
    for (let at = lines.length - 1; at >= 0; at--) {
      const found = STATUS_MARK.exec(lines[at]);
      if (found) return { word: found[1], tone: STATUS_TONE.get(found[1].toLocaleLowerCase()) || 'plain', line: at };
    }
    return null;
  }
  // The description without its status line, for showing the two apart.
  const statusless = text => String(text ?? '').split('\n').filter(line => !STATUS_MARK.test(line)).join('\n').trim();

  // Where a settlement or a pot stands. One of five, worked out from what it holds rather than stored, so it can never
  // disagree with the entries: nothing in it yet, money still outstanding, nothing outstanding, closed off, or closed
  // after other closed ones were folded into it.
  const SECTION_STATES = {
    draft: { label: 'Draft', savings: 'Draft', title: 'Named, but nothing recorded in it yet' },
    open: { label: 'Open', savings: 'Open', title: 'Money is still outstanding' },
    clear: { label: 'Cleared', savings: 'Active', title: 'Nothing outstanding' },
    settled: { label: 'Settled', savings: 'Settled', title: 'Closed off — it still counts, but takes no new entries' },
    merged: { label: 'Merged', savings: 'Merged', title: 'Closed, and other closed ones were folded into it' }
  };
  // `meta` is a built section's _meta (kind, settle, closed, mergedFrom, categories): the same shape a month and the
  // year card both hold, so one section reads the same wherever it is drawn.
  function sectionState(meta = {}) {
    const kind = SECTION_KINDS.includes(meta.kind) ? meta.kind : 'settlement';
    const key = meta.closed
      ? (meta.autoClosed ? 'clear' : meta.mergedFrom?.length ? 'merged' : 'settled')
      : !meta.entries ? 'draft'
        : kind === 'settlement' && meta.settle && meta.settle.owed !== 0 ? 'open'
          // Money lent, held or borrowed is open while any of it is still out (across every month linked to it), and clear
          // once it has all come back or been paid back. Only a savings pot is "Active" while it holds money.
          : MONEY_OUT_KINDS.includes(kind) && Number(meta.outstanding) > 0 ? 'open' : 'clear';
    const state = SECTION_STATES[key];
    const named = kind === 'settlement' || MONEY_OUT_KINDS.includes(kind);
    return { key, kind, label: named ? state.label : state.savings, title: key === 'open' && kind !== 'settlement' ? 'Money is still out' : state.title };
  }

  // Each block has a name of its own, kept per month and currency beside that month's section list. A month holds
  // exactly one of each kind, so the name belongs to the kind, not to a section.
  const BLOCK_NAMES = { settlement: 'Settlements', savings: 'Savings', hold: 'On hold', lent: 'Lent out', borrowed: 'Borrowed' };
  const blockNameOf = (names, kind) => {
    const given = String(names?.[kind] ?? '').trim();
    return given || BLOCK_NAMES[kind] || BLOCK_NAMES.settlement;
  };
  const MONEY_OUT_KINDS = ['hold', 'lent', 'borrowed'];
  const sectionKind = section => (SECTION_KINDS.includes(section?.kind) ? section.kind : 'settlement');
  const subsectionRole = (section, name) => {
    const kind = sectionKind(section);
    const role = section?.roles?.[name];
    return ROLES[kind].includes(role) ? role : DEFAULT_ROLE[kind];
  };
  // How a brand-new section counts. A settlement posts its signed net cash balance to exactly one side; a savings pot
  // counts only its gain as income, because moving your own money into savings neither earns nor spends anything.
  const DEFAULT_CALCS = {
    savings: { v: 4, vars: [], lines: ['GI = RT', 'GB = SV + RT'], income: { mode: 'count', formula: 'GI' }, expense: { mode: 'off', formula: '' } },
    // On hold: only what they kept is an expense; what is still with them is the balance.
    hold: { v: 4, vars: [], lines: ['GE = KP', 'GB = HD - KP'], income: { mode: 'off', formula: '' }, expense: { mode: 'count', formula: 'GE' } },
    // Lent out: interest received is income, a write-off is an expense, and what is still out is the balance.
    lent: { v: 4, vars: [], lines: ['GI = LI', 'GE = WO', 'GB = LT - WO'], income: { mode: 'count', formula: 'GI' }, expense: { mode: 'count', formula: 'GE' } },
    // Borrowed: only interest paid is an expense; what is still owed is the balance.
    borrowed: { v: 4, vars: [], lines: ['GE = BI', 'GB = BR'], income: { mode: 'off', formula: '' }, expense: { mode: 'count', formula: 'GE' } }
  };
  const defaultCalc = kind => (DEFAULT_CALCS[kind] ? JSON.parse(JSON.stringify(DEFAULT_CALCS[kind])) : settlePreset('net'));
  // ---- what a settlement reports to the month ------------------------------------------------
  // Everything else about a settlement is worked out from its entries and cannot be argued with. This one thing is a
  // choice, and only its owner can make it: the same 130,000 paid out and 90,000 had back is honestly a net 40,000
  // expense, honestly 90,000 of income beside 130,000 of expense, and honestly neither if the only part that was ever
  // mine was my own share of the bill. So a settlement says which of those it means, and says it in one named word
  // rather than by hand in equations nobody can read back:
  //   net     one signed figure — what it came to on balance. How every settlement has always counted.
  //   gross   both sides at once — everything that went out as an expense, everything that came in as income.
  //           A settlement very often is both at once, and this is the way to say so.
  //   mine    only my own share of what the group spent, as an expense. Money coming back is recovery, not income.
  //   custom  whatever its own equations say, written in the setup dialog like any other section's.
  // The first three are written into the calc as ordinary lines, so the dialog shows exactly what the word means and
  // a word can always be taken apart into equations. A calc with no word at all is a settlement from before this
  // existed: it reads as `net`, which is what it has been posting all along.
  const SETTLE_MODES = ['net', 'gross', 'mine', 'custom'];
  const SETTLE_PRESETS = {
    net: { lines: ['GB = CI - CO'], income: { mode: 'count', formula: 'max(GB, 0)' }, expense: { mode: 'count', formula: 'max(-GB, 0)' } },
    gross: { lines: ['GI = CI', 'GE = CO', 'GB = GI - GE'], income: { mode: 'count', formula: 'GI' }, expense: { mode: 'count', formula: 'GE' } },
    mine: { lines: ['GE = MS', 'GB = CI - CO'], income: { mode: 'off', formula: '' }, expense: { mode: 'count', formula: 'GE' } }
  };
  const SETTLE_MODE_LABELS = {
    net: { label: 'Net', hint: 'one signed figure: what it came to on balance' },
    gross: { label: 'Both sides', hint: 'everything out as expense, everything in as income — at the same time' },
    mine: { label: 'My share only', hint: 'what the shared spending really cost you; money back is not income' },
    custom: { label: 'Custom', hint: 'whatever the equations below say' }
  };
  const settleMode = calc => (SETTLE_MODES.includes(calc?.mode) ? calc.mode : 'net');
  // A preset as a whole calc, keeping the ids its parts already have. Always a fresh copy: a calc is handed out to be
  // edited, and the stored shapes above are read by every settlement there is.
  const settlePreset = (mode, vars = []) => {
    const preset = SETTLE_PRESETS[mode] || { lines: [], income: { mode: 'off', formula: '' }, expense: { mode: 'off', formula: '' } };
    return { v: 4, mode, vars, lines: [...preset.lines], income: { ...preset.income }, expense: { ...preset.expense } };
  };
  // The gross calc some settlements were left holding before any of this was a choice. It was never what they posted
  // (the net figure was), so it is still read as the default — unless a word has since been set on purpose, which is
  // the whole point of `gross` and must not be undone the moment it is saved.
  const legacyGrossSettlementCalc = calc => {
    if (SETTLE_MODES.includes(calc?.mode)) return false;
    const lines = listOf(calc?.lines).map(line => String(line).trim().toUpperCase());
    return Number(calc?.v) >= 1 && Number(calc?.v) <= 3 &&
      lines.join('|') === 'GI = CI|GE = CO|GB = GI - GE' &&
      calc?.income?.mode === 'count' && String(calc.income.formula || '').trim().toUpperCase() === 'GI' &&
      calc?.expense?.mode === 'count' && String(calc.expense.formula || '').trim().toUpperCase() === 'GE';
  };
  // Reads an expression into { refs, run(get) } or { error }; names are upper-cased.
  function parseCalc(text) {
    const tokens = String(text ?? '').match(/[A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*|\.\d+|\S/g) || [];
    let at = 0;
    const refs = new Set();
    const fail = message => { throw new Error(message); };
    const peek = () => tokens[at];
    const sum = () => {
      let node = product();
      while (peek() === '+' || peek() === '-') {
        const op = tokens[at++];
        const left = node;
        const right = product();
        node = get => (op === '+' ? left(get) + right(get) : left(get) - right(get));
      }
      return node;
    };
    const product = () => {
      let node = unary();
      while (peek() === '*' || peek() === '/') {
        const op = tokens[at++];
        const left = node;
        const right = unary();
        node = get => (op === '*' ? left(get) * right(get) : left(get) / right(get));
      }
      return node;
    };
    const unary = () => {
      if (peek() === '-') { at++; const inner = unary(); return get => -inner(get); }
      if (peek() === '+') { at++; return unary(); }
      return primary();
    };
    const primary = () => {
      const token = tokens[at++];
      if (token === undefined) fail('It ends too early.');
      if (token === '(') {
        const inner = sum();
        if (tokens[at++] !== ')') fail('A ( is not closed.');
        return inner;
      }
      if (/^[\d.]/.test(token)) {
        const value = Number(token);
        return () => value;
      }
      if (/^[A-Za-z_]/.test(token)) {
        const name = token.toUpperCase();
        if (CALC_FUNCTIONS[name]) {
          if (tokens[at++] !== '(') fail(`${token} needs ( ), like ${token.toLowerCase()}(GB).`);
          const args = [sum()];
          while (peek() === ',') { at++; args.push(sum()); }
          if (tokens[at++] !== ')') fail(`${token}( is not closed.`);
          return get => CALC_FUNCTIONS[name](...args.map(arg => arg(get)));
        }
        refs.add(name);
        return get => get(name);
      }
      return fail(`“${token}” is not allowed here.`);
    };
    try {
      if (!tokens.length) fail('It is empty.');
      const run = sum();
      if (at < tokens.length) fail(`“${tokens[at]}” is not expected there.`);
      return { refs, run };
    } catch (error) {
      return { error: error.message };
    }
  }
  // One calculation line: "Name = expression".
  function parseLine(text) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(String(text ?? ''));
    if (!match) return { error: 'Write it as Name = …, e.g. Share = E1 / 2.' };
    const name = match[1].toUpperCase();
    if (SUB_ID.test(name)) return { name: match[1], key: name, reserved: true, error: `${match[1]} is a subsection; give the result another name.` };
    if (CALC_FUNCTIONS[name]) return { name: match[1], key: name, reserved: true, error: `${match[1]} is a function name.` };
    if (ENTRY_TOTALS.includes(name)) return { name: match[1], key: name, reserved: true, error: `${match[1]} is the entries' own total and cannot be set.` };
    return { name: match[1], key: name, ...parseCalc(match[2]) };
  }
  const listOf = value => (Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []);
  // Ids for the subsections, keeping those already given and giving the next free number to new ones.
  function calcVars(vars, names) {
    const kept = listOf(vars).filter(item => item && SUB_ID.test(item.id) && typeof item.name === 'string').map(({ id, name }) => ({ id, name }));
    let next = kept.reduce((top, item) => Math.max(top, Number(item.id.slice(1))), 0);
    names.filter(name => !kept.some(item => item.name === name)).forEach(name => kept.push({ id: `E${++next}`, name }));
    return kept;
  }
  // The older ways a section counted: { expense, income } with equations on subsection names, before that { to, positive,
  // formula } with one equation; read here only to turn them into a calc.
  const sideRule = side => ({ mode: SIDE_MODES.includes(side?.mode) ? side.mode : 'off', formula: String(side?.formula ?? '').trim() });
  function legacyRule(section) {
    if (section?.expense || section?.income) return { expense: sideRule(section.expense), income: sideRule(section.income), sign: null };
    const to = ['expense', 'income', 'sign', 'none'].includes(section?.to) ? section.to : section?.count === 'none' ? 'none' : 'sign';
    const formula = String(section?.formula ?? '').trim();
    const one = mode => ({ mode, formula });
    const off = { mode: 'off', formula: '' };
    if (to === 'sign') return { expense: one('count'), income: one('count'), sign: section?.positive === 'expense' ? 'expense' : 'income' };
    return { expense: to === 'income' ? off : one(to === 'none' ? 'show' : 'count'), income: to === 'income' ? one('count') : off, sign: null };
  }
  const isNameChar = char => /[\p{L}\p{M}\p{N}_]/u.test(char || '');
  // Splits an old equation into subsection names (as written, or in [brackets]) and plain arithmetic.
  function readFormula(formula, names) {
    const byLength = [...names].sort((a, b) => b.length - a.length);
    const parts = [];
    const text = String(formula ?? '');
    for (let at = 0; at < text.length;) {
      if (text[at] === '[') {
        const end = text.indexOf(']', at);
        const inside = end < 0 ? '' : text.slice(at + 1, end).trim();
        const name = names.find(item => item.toLowerCase() === inside.toLowerCase());
        if (!name) return { error: true };
        parts.push({ name });
        at = end + 1;
        continue;
      }
      const name = !isNameChar(text[at - 1]) && byLength.find(item => text.slice(at, at + item.length).toLowerCase() === item.toLowerCase() && !isNameChar(text[at + item.length]));
      if (name) {
        parts.push({ name });
        at += name.length;
      } else if (/[0-9+\-*/().\s]/.test(text[at])) {
        parts.push(text[at++]);
      } else {
        return { error: true };
      }
    }
    return { parts };
  }
  // A rule nobody ever wrote anything into: no lines, and each side either empty or the plain balance. Those are the
  // ones that used to net +X and -X down to a single figure, so they are the ones moved to the current default;
  // anything with an equation in it is left exactly as its owner wrote it.
  const plainSide = text => { const value = String(text ?? '').trim().toUpperCase(); return !value || value === 'GB'; };
  const untouchedCalc = calc => !listOf(calc?.lines).some(line => String(line).trim()) && plainSide(calc?.income?.formula) && plainSide(calc?.expense?.formula);
  const untouchedLegacy = section => !section || (!section.calc && !section.to && !section.count && !section.formula && !section.expense && !section.income && !section.positive);
  // A section's calc: its own, or one made from an older rule (same results).
  function sectionCalc(section) {
    const names = section?.subsections || [];
    if (section?.calc) {
      const { calc } = section;
      if ((Number(calc.v) < 4 && untouchedCalc(calc)) || (sectionKind(section) === 'settlement' && legacyGrossSettlementCalc(calc))) {
        return { ...defaultCalc(sectionKind(section)), vars: calcVars(calc.vars, names) };
      }
      return handSetGrand({
        vars: calcVars(calc.vars, names),
        lines: listOf(calc.lines).map(String),
        income: sideRule(calc.income),
        expense: sideRule(calc.expense),
        v: calc.v,
        ...(sectionKind(section) === 'settlement' && { mode: settleMode(calc) })
      });
    }
    if (untouchedLegacy(section)) return { ...defaultCalc(sectionKind(section)), vars: calcVars([], names) };
    const vars = calcVars([], names);
    const rule = legacyRule(section);
    const totals = { Income: 'GI', Expenses: 'GE', Balance: 'GB' };
    const known = [...names, ...Object.keys(totals).filter(name => !names.some(sub => sub.toLowerCase() === name.toLowerCase()))];
    const convert = formula => {
      const read = formula && readFormula(formula, known);
      if (!read || read.error) return 'GB';
      return read.parts.map(part => (typeof part === 'string' ? part : vars.find(item => item.name === part.name)?.id || totals[part.name])).join('').replace(/\s+/g, ' ').trim();
    };
    const side = ({ mode, formula }) => ({ mode, formula: convert(formula) === 'GB' ? '' : convert(formula) });
    if (rule.sign) {
      // Oldest: the result went to one side by its sign.
      const formula = convert(rule.income.formula);
      const wrap = text => (/^[A-Za-z0-9_]+$/.test(text) ? text : `(${text})`);
      const positive = { mode: 'count', formula: `max(${formula}, 0)` };
      const negative = { mode: 'count', formula: `max(-${wrap(formula)}, 0)` };
      return handSetGrand({ vars, lines: [], income: rule.sign === 'income' ? positive : negative, expense: rule.sign === 'income' ? negative : positive });
    }
    return handSetGrand({ vars, lines: [], income: side(rule.income), expense: side(rule.expense) });
  }
  const signedSettlementTotals = (amount, label, kind) => {
    const net = Math.round(Number(amount) || 0);
    const income = Math.max(net, 0);
    const expenses = Math.max(-net, 0);
    const type = net < 0 ? 'expense' : 'income';
    const formula = type === 'income' ? 'max(GB, 0)' : 'max(-GB, 0)';
    const off = { mode: 'off', formula, result: 0, error: null, fatal: false, empty: false };
    const active = { ...off, mode: 'count', result: Math.abs(net) };
    return {
      stats: { income: income || undefined, expenses: expenses || undefined, balance: net },
      sides: { income: net > 0 ? active : off, expense: net < 0 ? active : off },
      adds: {
        income, expenses,
        lines: net ? [{ type, label, section: label, kind, amount: Math.abs(net), counted: true, parts: null }] : []
      }
    };
  };
  // An older calc used GI / GE / GB as the entries' totals without setting them, and sent GB for an empty formula: it gets
  // the lines that set the ones it uses, so it works out as before (and shows just those in its heading).
  function handSetGrand(calc) {
    if (Number(calc.v) >= 2) return calc;
    ['income', 'expense'].forEach(type => {
      if (calc[type].mode !== 'off' && !calc[type].formula) calc[type].formula = 'GB';
    });
    const defined = new Set(calc.lines.map(line => parseLine(line).key).filter(Boolean));
    const used = [...calc.lines, calc.income.formula, calc.expense.formula].join(' ').toUpperCase();
    const sets = { GI: 'GI = TI', GE: 'GE = TE', GB: 'GB = TI - TE' };
    const added = GRAND.filter(name => !defined.has(name) && new RegExp(`\\b${name}\\b`).test(used)).map(name => sets[name]);
    return { ...calc, lines: [...added, ...calc.lines], v: 2 };
  }
  // Works a calc out on a section's entries ({ subsection → [amount…] }, minor units): each subsection's id and sum, each
  // line's value or problem, the section's GI / GE / GB, and what goes to the month's income and expenses.
  // A problem that stops an equation being used is `fatal` (it does not read, names something unknown, loops…); one
  // that only these amounts cause (dividing by zero) is not.
  function runCalc(section, amountsBySub, calc = sectionCalc(section)) {
    const names = [...new Set([...(section?.subsections || []), ...Object.keys(amountsBySub)])];
    const vars = calcVars(calc.vars, names);
    const major = minor => minor / 100;
    // A subsection hands over either plain amounts or { amount, split } — the split being what part of that one entry
    // was mine (see splitShare). Both shapes are read the same way here, so a caller that knows nothing about splits
    // goes on working and an old ledger keeps every figure it had.
    const valuesBySub = {};
    const splitsBySub = {};
    const allocsBySub = {};
    names.forEach(name => {
      const list = amountsBySub[name] || [];
      valuesBySub[name] = list.map(item => (item && typeof item === 'object' ? Number(item.amount) || 0 : Number(item) || 0));
      splitsBySub[name] = list.map(item => (item && typeof item === 'object' ? item.split || null : null));
      allocsBySub[name] = list.map((item, at) => (item && typeof item === 'object' && item.alloc ? allocFor(valuesBySub[name][at], item.alloc) : []));
    });
    const all = names.flatMap(name => valuesBySub[name]);
    const income = all.filter(amount => amount > 0).reduce((sum, amount) => sum + amount, 0);
    const expenses = -all.filter(amount => amount < 0).reduce((sum, amount) => sum + amount, 0);
    // Each subsection counted under the role it was given, so money that really moved is told apart from a memo.
    // A role is a plain sum of its entries; `in` and `out` keep the two directions apart, because a settlement has to
    // show both — 1000 paid out and 500 had back is not the same story as 500 spent.
    const kind = sectionKind(section);
    const byRole = Object.fromEntries(ROLES[kind].map(role => [role, { in: 0, out: 0, net: 0 }]));
    let cashIn = 0;
    let cashOut = 0;
    // What each entry said was mine, added up. Only money laid out for the group carries a split: a repayment moves
    // money between the two sides rather than being a cost to divide, and the old "My share" subsection is a memo
    // that already states its own figure.
    let splitMine = 0;
    // Money passing between the two sides, kept apart from what was laid out for the group, and how much of it has
    // been said what it was for. A settlement reads very differently once those two are told apart: 130,000 handed
    // over against named things is a story, 130,000 handed over against nothing is a figure.
    let settleIn = 0;
    let settleOut = 0;
    let allocated = 0;
    // What each subsection has against it, once allocations are read: what was laid out under it, how much of that
    // was mine, and how much of it has since been covered from either side. `owed` is what is still open on that one
    // thing — the same sum the whole settlement does, asked of one subsection at a time, which is what makes paying
    // 130,000 across three of them something the ledger can show rather than something you remember.
    const purposes = new Map();
    const purposeOf = name => purposes.get(name) || purposes.set(name, { name, role: subsectionRole(section, name), laid: 0, mine: 0, covered: 0, owed: 0 }).get(name);
    names.forEach(name => purposeOf(name));
    names.forEach(name => {
      const role = subsectionRole(section, name);
      const tally = byRole[role] || (byRole[role] = { in: 0, out: 0, net: 0 });
      const here = purposeOf(name);
      valuesBySub[name].forEach((amount, at) => {
        tally.net += amount;
        if (amount > 0) tally.in += amount; else tally.out -= amount;
        if (role === SPLIT_ROLE) {
          splitMine += splitShare(amount, splitsBySub[name][at]);
          here.laid += amount;
          here.mine += splitShare(amount, splitsBySub[name][at]);
        }
        if (role === ALLOC_ROLE) {
          if (amount > 0) settleIn += amount; else settleOut -= amount;
          // The entry's own sign says which way this money went, so an allocation only ever says how much.
          allocsBySub[name][at].forEach(part => {
            allocated += part.a;
            purposeOf(part.to).covered += amount > 0 ? part.a : -part.a;
          });
        }
        if (MEMO_ROLES.has(role)) return;
        if (amount > 0) cashIn += amount; else cashOut -= amount;
      });
    });
    purposes.forEach(item => { item.owed = -item.laid + item.mine - item.covered; });
    const cost = byRole.cost?.net || 0;
    // My own part: whatever the "My share" subsection states, plus what the entries themselves said was mine.
    const share = (byRole.share?.net || 0) + splitMine;
    const settled = byRole.settle?.net || 0;
    const saved = byRole.save?.net || 0;
    const returns = byRole.return?.net || 0;
    const held = byRole.hold?.net || 0;
    const kept = byRole.kept?.net || 0;
    const lentOut = byRole.lend?.net || 0;
    const writtenOff = byRole.writeoff?.net || 0;
    const earned = byRole.earned?.net || 0;
    const borrowedIn = byRole.borrow?.net || 0;
    const charged = byRole.charged?.net || 0;
    // What is still open between me and the other side. Everything I laid out is owed back to me, less the part that was
    // mine to begin with, less whatever has already changed hands. Zero means the settlement is clear.
    const owed = -cost + share - settled;
    const unallocated = Math.max(0, settleIn + settleOut - allocated);
    const settle = { kind, cashIn, cashOut, owed, share: -share, saved, returns, byRole, cleared: owed === 0,
      settleIn, settleOut, allocated, unallocated, purposes: [...purposes.values()],
      held, kept, lent: lentOut, writtenOff, earned, borrowed: borrowedIn, charged };
    const base = {
      TI: major(income), TE: major(expenses),
      CI: major(cashIn), CO: major(cashOut),
      OWED: major(owed), MS: major(-share),
      SV: major(saved), RT: major(returns),
      SI: major(settleIn), SO: major(settleOut),
      AL: major(allocated), UA: major(unallocated),
      HD: major(held), KP: major(kept), LT: major(lentOut), WO: major(writtenOff), LI: major(earned), BR: major(borrowedIn), BI: major(charged)
    };
    const subs = vars.filter(item => names.includes(item.name)).map(item => {
      const sum = (valuesBySub[item.name] || []).reduce((total, amount) => total + amount, 0);
      base[item.id] = major(sum);
      return { ...item, sum };
    });
    const label = section?.name || 'Section';
    // What each subsection on its own puts into the money that moved, so the ledger can post a section either as one
    // figure or line by line. A memo role (My share) is left out: it is a note about the split, never money.
    const postings = names.map(name => {
      const role = subsectionRole(section, name);
      if (MEMO_ROLES.has(role)) return { name, role, memo: true, in: 0, out: 0 };
      let into = 0;
      let outOf = 0;
      (valuesBySub[name] || []).forEach(amount => { if (amount > 0) into += amount; else outOf -= amount; });
      return { name, role, memo: false, in: into, out: outOf };
    });
    const evaluated = evaluateCalc({ calc, vars, base, label, kind, postings });
    const totals = kind === 'settlement' && settleMode(calc) === 'net' ? signedSettlementTotals(cashIn - cashOut, label, kind) : evaluated;
    const { lines } = evaluated;
    const { stats, sides, adds } = totals;
    return { calc: { ...calc, vars }, subs, base, lines, stats, sides, adds, settle, kind };
  }
  // Works a calculation out against a set of named figures: the lines in order, the grand totals they set, and what
  // the two "to the month" rules come to. None of it cares whether those figures are a section’s subsections or a
  // block’s sections, so one engine decides what every equation in the ledger means and there is a single place for
  // a formula to be wrong. `base` is every read-only name a formula may use (TI, CI, OWED… and the part ids), `vars`
  // is what those part ids stand for, and `postings` is what each part puts into the money that moved — used to split
  // one posted figure back into its parts when they add up to it exactly.
  function evaluateCalc({ calc, vars, base, label, kind, postings }) {
    const lines = calc.lines.map(text => (String(text).trim() ? { text, ...parseLine(text) } : { text, blank: true }));
    const defs = new Map();
    lines.forEach(line => {
      if (line.key && defs.has(line.key)) Object.assign(line, { error: `${line.name} is set twice.` });
      else if (line.key && !line.reserved) defs.set(line.key, line);
      if (line.error) line.fatal = true;
    });
    const values = new Map();
    const busy = [];
    const problem = (message, fatal = true) => Object.assign(new Error(message), { fatal });
    const get = name => {
      if (values.has(name)) return values.get(name);
      const def = defs.get(name);
      if (!def) {
        if (name in base) return base[name];
        // A removed subsection's id counts as nothing.
        if (SUB_ID.test(name) && vars.some(item => item.id === name)) return 0;
        throw problem(GRAND.includes(name) ? `${name} is not set: add a line ${name} = …` : `${name} is not known here.`);
      }
      if (def.error) throw problem(`${def.name} has a problem.`, def.fatal);
      if (busy.includes(name)) throw problem(`It loops: ${[...busy.slice(busy.indexOf(name)), name].map(key => defs.get(key).name).join(' → ')}.`);
      busy.push(name);
      try {
        const value = def.run(get);
        if (!Number.isFinite(value)) throw problem(`${def.name} does not work out (dividing by zero?).`, false);
        values.set(name, value);
        return value;
      } finally {
        busy.pop();
      }
    };
    const work = run => {
      try {
        const value = run(get);
        return Number.isFinite(value) ? { value } : { error: 'It does not work out (dividing by zero?).', fatal: false };
      } catch (error) {
        return { error: error.message, fatal: error.fatal !== false };
      }
    };
    const results = lines.map(line => (line.error || line.blank ? null : work(() => get(line.key))));
    lines.forEach((line, index) => {
      const result = results[index];
      if (result) Object.assign(line, result.error ? { error: result.error, fatal: result.fatal } : { value: Math.round(result.value * 100) });
    });
    // Only the ones a line sets (and that work out) are shown.
    const grand = Object.fromEntries(GRAND.map(name => [name, defs.has(name) ? work(() => get(name)).value : undefined]));
    const minor = value => (value === undefined ? undefined : Math.round(value * 100));
    const stats = { income: minor(grand.GI), expenses: minor(grand.GE), balance: minor(grand.GB) };
    const sides = {};
    const out = [];
    const adds = { income: 0, expenses: 0, lines: out };
    ['income', 'expense'].forEach(type => {
      const { mode, formula } = calc[type];
      const parsed = parseCalc(formula);
      const result = mode === 'off' || !formula.trim() ? { value: 0 } : parsed.error ? { error: parsed.error, fatal: true } : work(parsed.run);
      const amount = result.error ? 0 : Math.round(result.value * 100);
      sides[type] = { mode, formula, result: amount, error: result.error, fatal: result.fatal, empty: !formula.trim() };
      if (mode === 'off' || !formula.trim()) return;
      // The subsections behind this one figure, but only when they add up to it exactly. A section whose own equations
      // reshape the figure (anything but the plain cash in / cash out) cannot be split without inventing numbers, so it
      // keeps its single line and the ledger falls back to that wherever the breakdown is asked for.
      const side = type === 'income' ? 'in' : 'out';
      const parts = postings.filter(item => !item.memo && item[side]).map(item => ({ label: item.name, role: item.role, amount: Math.round(item[side]) }));
      const splits = parts.length > 0 && parts.reduce((sum, item) => sum + item.amount, 0) === amount;
      out.push({ type, label, section: label, kind, amount, counted: mode === 'count', parts: splits ? parts : null });
      if (mode === 'count') adds[type === 'income' ? 'income' : 'expenses'] += amount;
    });
    return { lines, stats, sides, adds };
  }
  // ---- a block's own calculation ---------------------------------------------------------------
  // A block (Settlements, Savings) holds sections the way a section holds subsections, so it counts the same way: its
  // parts are the sections in it, and it has one calculation of its own saying what the block posts to the month.
  // Where a section reads its parts from entries and their roles, a block reads its parts from what each section
  // already worked out, so the two can never disagree — a block is never a second opinion about the same money.
  // Stored per month and currency beside the block names (monthSections/<month>/<cur>/blockCalc/<kind>).
  //
  // Its read-only figures are the sections' own, added up: CI / CO cash both ways, OWED what is still outstanding,
  // MS my share, SV / RT a pot and its gain, TI / TE every section's balance positive and negative. Each section is a
  // part id (E1, E2…) worth that section's balance, so a block formula can name one settlement on its own.
  const defaultBlockCalc = kind => defaultCalc(kind);
  // Reads a block's stored calculation, giving it the ids its sections need. `names` are the sections in it, in order.
  function blockCalc(stored, names, kind = 'settlement') {
    const calc = stored && Number(stored.v) >= 3 && !(kind === 'settlement' && legacyGrossSettlementCalc(stored)) ? stored : null;
    if (!calc) return { ...defaultBlockCalc(sectionKind({ kind })), vars: calcVars([], names) };
    return handSetGrand({
      vars: calcVars(calc.vars, names),
      lines: listOf(calc.lines).map(String),
      income: sideRule(calc.income),
      expense: sideRule(calc.expense),
      v: calc.v,
      ...(kind === 'settlement' && { mode: settleMode(calc) })
    });
  }
  // Works a block out. `parts` is one entry per section in it, in order:
  //   { name, stats: { income, expenses, balance }, settle: { cashIn, cashOut, owed, share, saved, returns } }
  // which is exactly what runCalc already hands back for each section, so nothing is recomputed from the entries.
  function runBlockCalc(block, parts, calc = blockCalc(block?.calc, parts.map(part => part.name), sectionKind(block))) {
    const kind = sectionKind(block);
    const names = parts.map(part => part.name);
    const vars = calcVars(calc.vars, names);
    const major = minor => minor / 100;
    const add = pick => parts.reduce((sum, part) => sum + (Number(pick(part)) || 0), 0);
    const balanceOf = part => Number(part.stats?.balance ?? part.settle?.owed ?? 0) || 0;
    // A block's cash both ways is its sections' cash both ways: a section that brought 500 in and paid 1000 out keeps
    // both figures here, so +X and -X never cancel and the block says what really moved.
    const cashIn = add(part => part.settle?.cashIn);
    const cashOut = add(part => part.settle?.cashOut);
    const owed = add(part => part.settle?.owed);
    const share = add(part => part.settle?.share);
    const saved = add(part => part.settle?.saved);
    const returns = add(part => part.settle?.returns);
    const settleIn = add(part => part.settle?.settleIn);
    const settleOut = add(part => part.settle?.settleOut);
    const allocated = add(part => part.settle?.allocated);
    const balances = parts.map(balanceOf);
    const income = balances.filter(amount => amount > 0).reduce((sum, amount) => sum + amount, 0);
    const expenses = -balances.filter(amount => amount < 0).reduce((sum, amount) => sum + amount, 0);
    const unallocated = Math.max(0, settleIn + settleOut - allocated);
    const held = add(part => part.settle?.held);
    const kept = add(part => part.settle?.kept);
    const lentOut = add(part => part.settle?.lent);
    const writtenOff = add(part => part.settle?.writtenOff);
    const earned = add(part => part.settle?.earned);
    const borrowedIn = add(part => part.settle?.borrowed);
    const charged = add(part => part.settle?.charged);
    const settle = { kind, cashIn, cashOut, owed, share, saved, returns, byRole: {}, cleared: owed === 0,
      settleIn, settleOut, allocated, unallocated, purposes: [], held, kept, lent: lentOut, writtenOff, earned, borrowed: borrowedIn, charged };
    const base = {
      TI: major(income), TE: major(expenses),
      CI: major(cashIn), CO: major(cashOut),
      OWED: major(owed), MS: major(share),
      SV: major(saved), RT: major(returns),
      SI: major(settleIn), SO: major(settleOut),
      AL: major(allocated), UA: major(unallocated),
      HD: major(held), KP: major(kept), LT: major(lentOut), WO: major(writtenOff), LI: major(earned), BR: major(borrowedIn), BI: major(charged)
    };
    const byName = new Map(parts.map(part => [part.name, part]));
    const subs = vars.filter(item => byName.has(item.name)).map(item => {
      const sum = balanceOf(byName.get(item.name));
      base[item.id] = major(sum);
      return { ...item, sum };
    });
    // What each section puts into the money that moved: what it already posts, so a block posted line by line and the
    // same block posted as one figure are the same money said two ways.
    const postings = parts.map(part => ({
      name: part.name, role: 'cost', memo: false,
      in: Math.max(0, Math.round(Number(part.adds?.income) || 0)),
      out: Math.max(0, Math.round(Number(part.adds?.expenses) || 0))
    }));
    const label = block?.name || 'Block';
    const evaluated = evaluateCalc({ calc, vars, base, label, kind, postings });
    const totals = kind === 'settlement' && settleMode(calc) === 'net'
      ? signedSettlementTotals(balances.reduce((sum, amount) => sum + amount, 0), label, kind)
      : evaluated;
    const { lines } = evaluated;
    const { stats, sides, adds } = totals;
    return { calc: { ...calc, vars }, subs, base, lines, stats, sides, adds, settle, kind };
  }
  const netSectionSummary = (section, amountsBySub) => runCalc(section, amountsBySub);
  const CALC_NAMES = { functions: Object.keys(CALC_FUNCTIONS), grand: GRAND, totals: ENTRY_TOTALS };
  const SECTION_ROLES = { kinds: SECTION_KINDS, roles: ROLES, labels: ROLE_LABELS, fallback: DEFAULT_ROLE, memo: [...MEMO_ROLES] };
  // Gives a section its calc (turning an older rule into one) and returns it, for changes made to it.
  function ensureCalc(section) {
    const calc = sectionCalc(section);
    ['to', 'positive', 'count', 'formula', 'subRules', 'expense', 'income'].forEach(key => delete section[key]);
    section.kind = sectionKind(section);
    section.roles = Object.fromEntries((section.subsections || []).map(name => [name, subsectionRole(section, name)]));
    section.calc = calc;
    return calc;
  }
  function docTotals(buckets, rules = new Map(), blockCalcs = {}) {
    const totals = zeroTotals();
    const treat = emptyHoldings();
    const balances = new Map();
    // An entry written before sections had names carries only its subsection; it belongs to whichever section lists
    // that subsection, so it is counted under that section's roles rather than falling back to the bare defaults.
    const homeOf = new Map();
    rules.forEach((section, name) => (section?.subsections || []).forEach(sub => { if (!homeOf.has(nameKey(sub))) homeOf.set(nameKey(sub), name); }));
    rules.forEach((_, name) => balances.set(name, {}));
    BUCKETS.forEach(([bucket]) => (buckets?.[bucket] || []).forEach(group => {
      totals.entries += group.count;
      if (bucket !== 'net') {
        const total = group.entries
          ? group.entries.reduce((sum, entry) => sum + (entry.cleared ? 0 : entryWith(entry, entry.notes || [])), 0)
          : group.total;
        totals[bucket] += total;
        return;
      }
      (group.entries || []).forEach(entry => {
        const key = entry.section || homeOf.get(nameKey(group.category)) || '';
        const sectionName = rules.has(key) ? key : otherSectionName('net');
        const bySub = balances.get(sectionName) || balances.set(sectionName, {}).get(sectionName);
        (bySub[group.category] ||= []).push({ amount: entryWith(entry, entry.notes || []), split: entry.split || null, alloc: entry.alloc || null });
      });
    }));
    const partsByKind = Object.fromEntries(SECTION_KINDS.map(kind => [kind, []]));
    balances.forEach((amountsBySub, name) => {
      const section = rules.get(name) || { name, subsections: Object.keys(amountsBySub) };
      const summary = netSectionSummary(section, amountsBySub);
      totals.income += summary.adds.income;
      totals.expenses += summary.adds.expenses;
      (partsByKind[summary.kind] ||= []).push({ name, stats: summary.stats, settle: summary.settle, adds: summary.adds });
      // What the blocks hold at the end of the month, for the year's summary: savings and their returns, what is on hold,
      // lent or borrowed.
      const held = summary.settle || {};
      treat.saved += held.saved || 0;
      treat.savedIn += held.byRole?.save?.in || 0;
      treat.returns += held.returns || 0;
      treat.held += (held.held || 0) - (held.kept || 0);
      treat.kept += held.kept || 0;
      treat.lent += (held.lent || 0) - (held.writtenOff || 0);
      treat.borrowed += held.borrowed || 0;
    });
    Object.entries(partsByKind).forEach(([kind, parts]) => {
      const calc = blockCalcs?.[kind];
      if (!calc || !parts.length) return;
      const before = parts.reduce((sum, part) => ({
        income: sum.income + part.adds.income,
        expenses: sum.expenses + part.adds.expenses
      }), { income: 0, expenses: 0 });
      const run = runBlockCalc({ name: BLOCK_NAMES[kind], kind, calc }, parts);
      totals.income += run.adds.income - before.income;
      totals.expenses += run.adds.expenses - before.expenses;
    });
    totals.holdings = treat;
    return totals;
  }

  class ExpenseStore {
    // Build with ExpenseStore.open(), which reads currencies and years (not entries) from Firebase.
    constructor({ db, currencies, years, events = {}, trash = {} }) {
      this.db = db;
      // The dustbin: the last TRASH_LIMIT things deleted, newest first (see addTrash).
      this.trashList = Object.values(trash || {}).filter(item => item && item.id).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      this.currencies = currencies;
      this.years = years;
      this.transactions = [];
      this.synced = new Map();   // monthId → JSON of the month document as Firebase holds it
      this.loading = new Map();  // monthId → in-flight fetch
      this.writes = Promise.resolve();
      this.events = {};
      this.eventSynced = new Map(); // eventId → JSON of its entries document as Firebase holds it
      // Change counters for the year card (see yearbook): a month's goes up when its entries load or change, the events'
      // when any event, its entries or its settings change.
      this.versions = new Map(); // monthId → number
      this.eventsVersion = 0;
      this.slices = new Map();   // '<monthId>|<cur>' → { sig, sections }: one month as the year card uses it
      this.books = new Map();    // '<year>|<cur>' → { sig, book }: the year card's last build
      Object.entries(events || {}).forEach(([id, event]) => this.addEvent(id, event));
    }
    // readOnly opens a store that can never write to Firebase (view-only accounts); auth supplies the ID token per request.
    // `offline`, when given ({ vault, deviceId, onState, onConflict }), puts the device's copy and its outbox behind the
    // same get/patch: the app then opens and takes new entries with no connection, and sends them when one returns.
    static async open({ databaseURL, root, readOnly = false, auth = null, offline = null }) {
      const wire = new FirebaseDb(databaseURL, root, readOnly, auth);
      const db = offline?.vault ? new OfflineSync(offline.vault, wire, { ...offline, readOnly }) : wire;
      const [currencies, years, events, trash] = await Promise.all([db.get('currencies'), db.get('years'), db.get('events'), db.get('trash').catch(() => null)]);
      const ordered = Object.fromEntries(Object.entries(currencies || {}).sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0)));
      Object.values(years || {}).forEach(normalizeYear);
      const store = new ExpenseStore({ db, currencies: ordered, years: years || {}, events: events || {}, trash: trash || {} });
      store.sync = db === wire ? null : db;
      // Rebuild metadata in memory so carried balances show even for data saved before they existed; the next save writes it.
      store.yearIds().forEach(year => store.recomputeYear(year));
      await store.moveYearSectionsToMonths();
      await store.migrateEventSections();
      return store;
    }
    // One-time move from year-wide sections to per-month lists. Every month and currency that is on or has entries, and has
    // no list of its own, gets the year's sections with only the subsections it uses; then the year's list is dropped.
    // Nothing is written unless every month of those years loaded. If the write fails, the moved lists stay in memory and
    // the next save writes them with the year; the next open moves again from whatever Firebase still holds.
    async moveYearSectionsToMonths() {
      const years = this.yearIds().filter(year => this.year(year).sections?.length);
      if (!years.length) return;
      await Promise.all(years.map(year => this.ensureYear(year)));
      years.forEach(year => {
        const node = this.year(year);
        MONTH_NAMES.forEach((_, monthIndex) => {
          const id = monthIdOf(year, monthIndex);
          const month = node.monthSections[id] || {};
          const setup = this.monthSetup(year, monthIndex);
          this.currencyKeys().forEach(currency => {
            const items = this.items(year, currency, monthIndex);
            if (month[currency] || !(setup[currency].active || items.length)) return;
            const used = (type, name) => items.some(item => item.type === type && item.category === name);
            month[currency] = { own: true, sections: node.sections.map(section => ({ ...section, subsections: section.subsections.filter(name => used(section.type, name)) })) };
          });
          if (Object.keys(month).length) node.monthSections[id] = month;
        });
        delete node.sections;
      });
      const update = this.recomputeFrom(years[0]);
      await this.queue(() => this.db.patch(update)).catch(error => console.error('Could not save the per-month sections.', error));
    }

    // ---- shell: years, months and their metadata ----
    currencyKeys() { return Object.keys(this.currencies); }
    ordered(list) { return this.currencyKeys().filter(key => list.includes(key)); }
    yearIds() { return Object.keys(this.years).sort(); }
    year(year) { return this.years[String(year)]; }
    // A month's sections for one currency; a month that has none set up has an empty list.
    sections(year, monthIndex, currency) {
      return this.year(year)?.monthSections[monthIdOf(year, monthIndex)]?.[currency]?.sections || [];
    }
    // An editable copy of a month's sections, for the month settings dialog.
    // The two block headings of a month and currency: what they are called, falling back to Settlements / Savings.
    blockNames(year, monthIndex, currency) {
      const names = this.year(year)?.monthSections[monthIdOf(year, monthIndex)]?.[currency]?.names;
      return Object.fromEntries(SECTION_KINDS.map(kind => [kind, blockNameOf(names, kind)]));
    }
    // Renames one block for this month and currency only, as renaming anything else here does. A name matching the
    // default is stored as nothing, so the heading follows the default if it ever changes.
    saveBlockName(year, monthIndex, currency, kind, name) {
      if (!SECTION_KINDS.includes(kind)) return Promise.resolve();
      const month = this.year(year).monthSections[monthIdOf(year, monthIndex)] ||= {};
      const node = month[currency] ||= { own: true, sections: [] };
      const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
      const names = { ...(node.names || {}) };
      if (!clean || nameKey(clean) === nameKey(BLOCK_NAMES[kind])) delete names[kind];
      else names[kind] = clean;
      if (Object.keys(names).length) node.names = names; else delete node.names;
      const update = this.recomputeFrom(String(year));
      return this.queue(() => this.db.patch(update));
    }
    // A block's own calculation for this month and currency, as stored (null when it has never been set up, which is
    // every block until someone opens its setup: the default is then worked out from the sections in it).
    storedBlockCalc(year, monthIndex, currency, kind) {
      return this.year(year)?.monthSections[monthIdOf(year, monthIndex)]?.[currency]?.blockCalc?.[kind] || null;
    }
    // Both blocks' stored calculations, or null each where none was ever saved. A block with none behaves exactly as
    // it always did — the sections in it post themselves — so this feature is invisible until someone uses it.
    blockCalcs(year, monthIndex, currency) {
      return Object.fromEntries(SECTION_KINDS.map(kind => [kind, this.storedBlockCalc(year, monthIndex, currency, kind)]));
    }
    // Writes one, beside the block names. A calc equal to the default is stored as nothing, so a block that was opened
    // and left alone keeps no settings of its own and follows the default if it ever changes.
    saveBlockCalc(year, monthIndex, currency, kind, calc) {
      if (!SECTION_KINDS.includes(kind)) return Promise.resolve();
      const month = this.year(year).monthSections[monthIdOf(year, monthIndex)] ||= {};
      const node = month[currency] ||= { own: true, sections: [] };
      const all = { ...(node.blockCalc || {}) };
      const fallback = defaultBlockCalc(kind);
      const same = calc && JSON.stringify({ ...calc, vars: [] }) === JSON.stringify({ ...fallback, vars: [] });
      if (!calc || same) delete all[kind]; else all[kind] = calc;
      if (Object.keys(all).length) node.blockCalc = all; else delete node.blockCalc;
      const update = this.recomputeFrom(String(year));
      return this.queue(() => this.db.patch(update));
    }
    sectionsDraft(year, monthIndex, currency) {
      return this.sections(year, monthIndex, currency).map(section => ({ ...section, subsections: [...section.subsections] }));
    }
    // The month's own list for a currency, created empty if it has none yet.
    ownSections(year, monthIndex, currency) {
      const month = this.year(year).monthSections[monthIdOf(year, monthIndex)] ||= {};
      month[currency] ||= { own: true, sections: [] };
      return month[currency].sections;
    }
    saveMonthSections(year, monthIndex, currency, sections) {
      const node = this.year(year);
      const month = node.monthSections[monthIdOf(year, monthIndex)] ||= {};
      const names = month[currency]?.names;
      const blockCalc = month[currency]?.blockCalc;
      month[currency] = { own: true, sections: normalizeSections(sections), ...(names ? { names } : {}), ...(blockCalc ? { blockCalc } : {}) };
      const update = this.recomputeFrom(String(year));
      return this.queue(() => this.db.patch(update));
    }
    monthNode(year, monthIndex) { return this.year(year)?.months[monthIdOf(year, monthIndex)]; }
    monthCurrencies(year, monthIndex) { return this.ordered(this.monthNode(year, monthIndex)?.currencies || []); }
    yearCurrencies(year) { return this.ordered(this.year(year)?.metadata.currencies || []); }
    monthTotals(year, monthIndex, currency) {
      return { income: 0, expenses: 0, balance: 0, entries: 0, closing: 0, carried: 0, previous: 0, holdings: emptyHoldings(), ...this.monthNode(year, monthIndex)?.metadata[currency] };
    }
    // Effective per-currency setup of a month: { <cur>: { active, carry } }, month overrides over the year's defaults.
    monthSetup(year, monthIndex) {
      const node = this.year(year);
      const override = node?.monthConfig?.[monthIdOf(year, monthIndex)] || {};
      return Object.fromEntries(this.currencyKeys().map(key => {
        const config = node?.currencies[key];
        const byYear = Boolean(config) && MONTH_NAMES.indexOf(config.from) <= monthIndex;
        return [key, { active: override[key]?.active ?? byYear, carry: override[key]?.carry ?? true }];
      }));
    }
    // Where a month's carried balance comes from: the previous active month, else the year's opening.
    carriedFrom(year, monthIndex, currency) {
      for (let index = monthIndex - 1; index >= 0; index--) {
        if (this.monthNode(year, index)?.currencies.includes(currency)) return MONTH_NAMES[index];
      }
      return this.year(year)?.currencies[currency]?.carryIn ? String(Number(year) - 1) : 'opening balance';
    }
    // The balance a year opens on for a currency: the previous year's closing when carried in, else the set amount.
    yearOpening(year, currency) {
      const config = this.year(year)?.currencies[currency];
      if (config?.carryIn) return this.year(Number(year) - 1) ? Number(this.yearTotals(Number(year) - 1, currency).closing) || 0 : 0;
      return Number(config?.opening) || 0;
    }
    // A year's block figures for one currency (own), and what is still open at its end: savings, on hold, lent and
    // borrowed added up over every year up to it.
    // Every month's section that carries a link, for one currency, oldest first: an item put in one month and closed in
    // another. Read from the year settings, so it needs no month loaded.
    linkedSections(link, currency) {
      if (!link) return [];
      const out = [];
      Object.entries(this.years).forEach(([year, node]) => Object.entries(node.monthSections || {}).forEach(([id, month]) => {
        (month?.[currency]?.sections || []).forEach(section => {
          if (section.link === link) out.push({ year: Number(year), monthIndex: MONTH_NAMES.indexOf(id.slice(5)), section });
        });
      }));
      return out.sort((a, b) => a.year - b.year || a.monthIndex - b.monthIndex);
    }
    // What a loan, hold or lending still has out, taking every month it is linked through: the original amounts (positive) less what came back or
    // was paid (negative), for the entries in the subsections that count that way. { total, positives }: open when total > 0, over-paid when < 0.
    linkedRoleTotals(link, currency, kind) {
      const role = MONEY_ACCOUNT_ROLES[kind];
      if (!link || !role) return { total: 0, positives: 0 };
      const sections = new Map(this.linkedSections(link, currency).map(({ year, monthIndex, section }) => [`${year}-${String(monthIndex + 1).padStart(2, '0')}|${section.name}`, section]));
      let total = 0;
      let positives = 0;
      this.transactions.forEach(item => {
        if (item.parentId || item.eventId || item.property !== currency) return;
        const section = sections.get(`${item.date.slice(0, 7)}|${item.section}`);
        if (!section || (item.moneyRole || subsectionRole(section, item.category)) !== role) return;
        const amount = this.entryTotal(item.id);
        total += amount;
        if (amount > 0 && !item.moneyRef) positives += amount;
      });
      return { total, positives };
    }
    yearHoldings(year, currency) {
      const own = this.year(year)?.metadata?.[currency]?.holdings || emptyHoldings();
      const open = this.yearIds().filter(id => Number(id) <= Number(year))
        .reduce((sum, id) => addHoldings(sum, this.year(id)?.metadata?.[currency]?.holdings), emptyHoldings());
      return { own, open };
    }
    yearTotals(year, currency) {
      return { income: 0, expenses: 0, balance: 0, entries: 0, opening: 0, closing: 0, ...this.year(year)?.metadata[currency] };
    }

    // ---- lazy month loading ----
    isLoaded(year, monthIndex) { return this.synced.has(monthIdOf(year, monthIndex)); }
    ensureMonth(year, monthIndex) {
      const id = monthIdOf(year, monthIndex);
      if (this.synced.has(id)) return Promise.resolve();
      if (!this.loading.has(id)) {
        this.loading.set(id, this.db.get(`months/${id}`).then(data => {
          const items = flattenMonth(id, data, this.currencyKeys());
          this.transactions.push(...items);
          this.synced.set(id, JSON.stringify(monthDoc(items)));
          this.recomputeYear(id.slice(0, 4));
          this.changed(id);
        }).finally(() => this.loading.delete(id)));
      }
      return this.loading.get(id);
    }
    addEvent(id, stored = {}) {
      this.events[id] = normalizeEvent(stored, this.currencyKeys());
      const items = flattenEvent(id, stored.entries, this.currencyKeys());
      this.transactions.push(...items);
      this.eventSynced.set(id, JSON.stringify(monthDoc(items, true)));
      this.eventsVersion += 1;
    }
    // A month's entries changed (or loaded): the year card rebuilds that month, and only that month, when next drawn.
    changed(monthId) { this.versions.set(monthId, (this.versions.get(monthId) || 0) + 1); }
    ensureYear(year) {
      return Promise.all(MONTH_NAMES.map((_, monthIndex) => this.ensureMonth(year, monthIndex)));
    }

    // ---- persistence ----
    // Metadata is rebuilt immediately so the UI shows new totals at once; the write is queued so writes land in order.
    // `year`, when given, is rebuilt and written even if no month's entries changed (e.g. only its section lists did).
    saveTransactions(year) {
      const update = {};
      const years = new Set(year ? [String(year)] : []);
      const monthItems = this.transactions.filter(item => !item.eventId);
      this.synced.forEach((json, id) => {
        const year = id.slice(0, 4);
        const doc = monthDoc(monthItems.filter(item => item.date.startsWith(dateKeyOf(year, MONTH_NAMES.indexOf(id.slice(5))))));
        const next = JSON.stringify(doc);
        if (next === json) return;
        update[`months/${id}`] = doc;
        this.synced.set(id, next);
        this.changed(id);
        years.add(year);
      });
      // An event's entries are saved with the event; when it shows in months, every year's totals are rebuilt.
      this.eventSynced.forEach((json, id) => {
        const doc = monthDoc(this.transactions.filter(item => item.eventId === id), true);
        const next = JSON.stringify(doc);
        if (next === json) return;
        update[`events/${id}/entries`] = doc;
        this.eventSynced.set(id, next);
        this.eventsVersion += 1;
        if (this.events[id]?.include && this.yearIds().length) years.add(this.yearIds()[0]);
      });
      if (years.size) Object.assign(update, this.recomputeFrom([...years].sort()[0]));
      return this.queue(() => (Object.keys(update).length ? this.db.patch(update) : null));
    }
    // Writes a year's configuration ({ currencies }) and its rebuilt metadata. Creates the year if new.
    saveYear(year, config) {
      const key = String(year);
      this.years[key] = normalizeYear({ ...this.years[key], ...config });
      const update = this.recomputeFrom(key);
      return this.queue(() => this.db.patch(update));
    }
    // Writes one month's currency setup ({ <cur>: { active, carry } }) and the rebuilt metadata.
    saveMonthSetup(year, monthIndex, setup) {
      const node = this.year(year);
      node.monthConfig[monthIdOf(year, monthIndex)] = setup;
      const update = this.recomputeFrom(String(year));
      return this.queue(() => this.db.patch(update));
    }
    // A year's balances feed the next year's opening when it carries in, so later years are rebuilt too.
    recomputeFrom(year) {
      return Object.fromEntries(this.yearIds().filter(id => id >= String(year)).map(id => [`years/${id}`, this.recomputeYear(id)]));
    }
    queue(write) {
      const result = this.writes.then(write);
      this.writes = result.catch(() => {});
      return result;
    }

    // Month totals come from loaded entries when the month is loaded, otherwise from the stored metadata (minus its carry).
    // Each active month opens on the previous balance when it carries, or on zero when it does not.
    // An upcoming month (one that has not begun) carries nothing in: the current month's balance is not known until it
    // ends, so an upcoming month shows only its own entries. The running balance still passes through it underneath, so
    // later totals and the year's closing are unchanged; once the month begins, the next recompute (every time the app
    // opens) carries the balance in as usual.
    recomputeYear(year) {
      const node = this.year(year);
      const now = new Date();
      const keys = this.currencyKeys().filter(key => node.currencies[key] || Object.values(node.monthConfig).some(month => month?.[key]?.active));
      const running = {};
      const sums = {};
      const months = {};
      MONTH_NAMES.forEach((name, monthIndex) => {
        const id = monthIdOf(year, monthIndex);
        const setup = this.monthSetup(year, monthIndex);
        const active = keys.filter(key => setup[key].active);
        const doc = this.synced.has(id) ? JSON.parse(this.synced.get(id)) : null;
        const metadata = { entries: 0 };
        active.forEach(key => {
          const own = this.synced.has(id) ? docTotals(doc?.[key], this.netRules(year, monthIndex, key), this.blockCalcs(year, monthIndex, key)) : rawFromStored(node.months[id]?.metadata?.[key]);
          const fromEvents = this.eventMonthTotals(year, monthIndex, key);
          const raw = { income: own.income + fromEvents.income, expenses: own.expenses + fromEvents.expenses, entries: own.entries + fromEvents.entries };
          const first = !(key in running);
          const previous = first ? this.yearOpening(year, key) : running[key];
          const upcoming = new Date(Number(year), monthIndex, 1) > now;
          const carried = setup[key].carry && !upcoming ? previous : 0;
          const income = raw.income + Math.max(carried, 0);
          const expenses = raw.expenses + Math.max(-carried, 0);
          const holdings = own.holdings || emptyHoldings();
          const balance = income - expenses + cashBalanceAdjustment(holdings);
          running[key] = upcoming
            ? (setup[key].carry ? previous : 0) + raw.income - raw.expenses + cashBalanceAdjustment(holdings)
            : balance;
          metadata[key] = { income, expenses, balance, entries: raw.entries, closing: running[key], carried, previous, holdings, ...(upcoming && { upcoming: true }), ...(fromEvents.entries && { fromEvents }) };
          metadata.entries += raw.entries;
          const sum = sums[key] ||= { ...zeroTotals(), opening: previous, carriedIn: first ? carried : 0, cashAdjustment: 0 };
          sum.income += raw.income;
          sum.expenses += raw.expenses;
          sum.entries += raw.entries;
          sum.holdings = addHoldings(sum.holdings, own.holdings);
          sum.cashAdjustment += cashBalanceAdjustment(own.holdings || emptyHoldings());
        });
        months[id] = { name, month: monthIndex + 1, currencies: active, metadata };
      });
      // The year counts its entries plus the balance it opened on; month-to-month carries are internal and not re-counted.
      const metadata = { entries: 0, currencies: Object.keys(sums) };
      Object.entries(sums).forEach(([key, sum]) => {
        const income = sum.income + Math.max(sum.carriedIn, 0);
        const expenses = sum.expenses + Math.max(-sum.carriedIn, 0);
        metadata[key] = { income, expenses, balance: income - expenses + sum.cashAdjustment, entries: sum.entries, opening: sum.opening, closing: running[key], holdings: sum.holdings || emptyHoldings(), own: { income: sum.income, expenses: sum.expenses } };
        metadata.entries += sum.entries;
      });
      Object.assign(node, { months, metadata });
      return node;
    }

    // ---- special events ----
    // An event is a standalone ledger: its own sections, entries and notes, each entry dated in any month. With `include`
    // on, its entries also count in their months; edits always happen in the event.
    eventList() {
      return Object.entries(this.events).map(([id, event]) => ({ id, ...event })).sort((a, b) => a.name.localeCompare(b.name));
    }
    eventName(id) { return this.events[id]?.name || ''; }
    // Every loaded entry linked to a special card, from any month of any year (an event's own entries are not counted).
    cardLinked(id) { return this.transactions.filter(item => item.card === id && !item.parentId && !item.eventId); }
    eventItems(id, currency) { return this.transactions.filter(item => item.eventId === id && (!currency || item.property === currency)); }
    eventSections(id, currency) { return this.events[id]?.sections[currency] || []; }
    // The currencies an event is tagged with, plus any it still holds entries in, in display order.
    eventCurrencies(id) {
      const tagged = this.events[id]?.currencies || [];
      return this.ordered([...new Set([...tagged, ...this.eventItems(id).map(item => item.property)])]);
    }
    // The event's editable list for a currency: an expense section named after the event, and an Income section for money
    // it brings in (gifts, refunds…). Either is added if missing, so both can always be used.
    ownEventSections(id, currency) {
      const event = this.events[id];
      const list = event.sections[currency] ||= [];
      if (!list.some(section => section.type === 'expense')) list.unshift({ name: event.name, type: 'expense', subsections: [] });
      if (!list.some(section => section.type === 'income')) list.push({ name: 'Income', type: 'income', subsections: [] });
      return list;
    }
    // One-time move of events made before that: their default "Expenses" section takes the event's name (in the list and
    // on its entries). Written back once; nothing else changes.
    async migrateEventSections() {
      const update = {};
      Object.entries(this.events).forEach(([id, event]) => {
        let changed = false;
        Object.entries(event.sections).forEach(([currency, list]) => {
          const items = this.eventItems(id, currency);
          const legacy = list.find(section => section.type === 'expense' && section.name === 'Expenses');
          if (legacy && !list.some(section => nameKey(section.name) === nameKey(event.name))) {
            legacy.name = event.name;
            items.filter(item => item.section === 'Expenses').forEach(item => { item.section = event.name; });
            changed = true;
          }
        });
        if (!changed) return;
        update[`events/${id}/sections`] = event.sections;
        const doc = monthDoc(this.eventItems(id), true);
        update[`events/${id}/entries`] = doc;
        this.eventSynced.set(id, JSON.stringify(doc));
        this.eventsVersion += 1;
      });
      if (!Object.keys(update).length) return;
      await this.queue(() => this.db.patch(update)).catch(error => console.error('Could not save the event sections.', error));
    }
    // Each custom section of a month and currency (with its rules), by name.
    netRules(year, monthIndex, currency) {
      return new Map(this.sections(year, monthIndex, currency).filter(section => section.type === 'net').map(section => [section.name, section]));
    }
    // Entries-only totals that included events add to one month and currency.
    eventMonthTotals(year, monthIndex, currency) {
      const totals = zeroTotals();
      const prefix = dateKeyOf(year, monthIndex);
      this.transactions.forEach(item => {
        if (!item.eventId || item.parentId || item.cleared || item.property !== currency || !item.date.startsWith(prefix) || !this.events[item.eventId]?.include) return;
        totals[item.type === 'income' ? 'income' : 'expenses'] += this.entryTotal(item.id);
        totals.entries += 1;
      });
      return totals;
    }
    // A year shows an event only if the event was created for that year, or one of its entries is dated in it.
    eventsOfYear(year) {
      const prefix = `${Number(year)}-`;
      return this.eventList().filter(event => event.year === Number(year) || this.eventItems(event.id).some(item => item.date.startsWith(prefix)));
    }
    createEvent(id, name, year, currencies = []) {
      this.events[id] = normalizeEvent({ name, year, currencies, created: new Date().toISOString().slice(0, 10) }, this.currencyKeys());
      this.eventSynced.set(id, 'null');
      this.eventsVersion += 1;
      const { sections, ...meta } = this.events[id];
      return this.queue(() => this.db.patch({ [`events/${id}`]: meta }));
    }
    // Saves an event's own settings (name, currencies, sections, include) without touching its entries. Turning `include`
    // on or off rebuilds every year's totals.
    saveEventMeta(id, fields) {
      const event = this.events[id];
      const rebuild = 'include' in fields && Boolean(fields.include) !== event.include;
      this.eventsVersion += 1;
      Object.assign(event, fields, 'include' in fields ? { include: Boolean(fields.include) } : {});
      const update = Object.fromEntries(Object.keys(fields).map(key => [`events/${id}/${key}`, event[key]]));
      if (rebuild && this.yearIds().length) Object.assign(update, this.recomputeFrom(this.yearIds()[0]));
      return this.queue(() => this.db.patch(update));
    }
    deleteEvent(id) {
      const included = this.events[id]?.include;
      delete this.events[id];
      this.eventSynced.delete(id);
      this.eventsVersion += 1;
      for (let index = this.transactions.length - 1; index >= 0; index--) if (this.transactions[index].eventId === id) this.transactions.splice(index, 1);
      const update = { [`events/${id}`]: null };
      if (included && this.yearIds().length) Object.assign(update, this.recomputeFrom(this.yearIds()[0]));
      return this.queue(() => this.db.patch(update));
    }
    // One currency's tree for an event, in the same shape as country() so the month panel can draw it.
    eventCountry(id, currency) {
      const region = this.currencies[currency];
      const items = this.eventItems(id, currency);
      const totals = { income: 0, expense: 0 };
      items.filter(item => !item.parentId).forEach(item => { totals[item.type === 'income' ? 'income' : 'expense'] += this.entryTotal(item.id); });
      return {
        _meta: { id: currency, name: region.name, code: region.code, color: region.color, income: totals.income, expense: totals.expense, closing: totals.income - totals.expense, carried: 0, carriedFrom: '' },
        sections: this.groupIntoSections(items, this.eventSections(id, currency))
      };
    }

    // ---- shared costs (see shared-ledger.js and years/<year>/settles) ----
    // Every settlement of every loaded year, newest first. A settlement is kept in the year it is dated in.
    // Settlements as saved, newest first.
    realSettleList() {
      if (this.realCache) return this.realCache;
      return this.realCache = Object.entries(this.years).flatMap(([year, node]) => Object.entries(node.settles || {}).map(([id, settle]) => ({ ...settle, id, year: Number(year) })))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.id.localeCompare(b.id));
    }
    // Every settlement: the saved ones, plus one worked out for each entry of a repayment section (see repayFor). Those are
    // never saved: they come from the entries, so editing or deleting a repayment entry changes the settlement with it.
    settleList() {
      return [...this.realSettleList(), ...this.virtualSettles()]
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)));
    }
    // ---- the dustbin ----
    // Everything deleted is kept here so it can be put back: an entry (with its notes), a note, a subsection (with its entries),
    // a section. Only the last 25 are kept; adding one over that drops the oldest. Saved at trash/<id>.
    addTrash(item) {
      const entry = JSON.parse(JSON.stringify({ ...item, id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString() }));
      this.trashList.unshift(entry);
      const update = { [`trash/${entry.id}`]: entry };
      while (this.trashList.length > TRASH_LIMIT) update[`trash/${this.trashList.pop().id}`] = null;
      return this.queue(() => this.db.patch(update));
    }
    removeTrash(id) {
      this.trashList = this.trashList.filter(item => item.id !== id);
      return this.queue(() => this.db.patch({ [`trash/${id}`]: null }));
    }
    clearTrash() {
      const update = Object.fromEntries(this.trashList.map(item => [`trash/${item.id}`, null]));
      this.trashList = [];
      return Object.keys(update).length ? this.queue(() => this.db.patch(update)) : Promise.resolve();
    }
    // Takes a saved settlement away (an adjustment made when a shared entry was deleted, undone by restoring it).
    removeSettle(id) {
      const update = {};
      Object.entries(this.years).forEach(([year, node]) => { if (node.settles?.[id]) { delete node.settles[id]; update[`years/${year}/settles/${id}`] = null; } });
      this.resetShared();
      return Object.keys(update).length ? this.queue(() => this.db.patch(update)) : Promise.resolve();
    }
    // ---- repayments: any block of the ledger can be where a person's repayments are recorded ----
    // years/<year>/repay is a list of targets { property, with, year?, section, category?, entry? }: a whole section, one of
    // its subsections, or a single entry (found by its date, description and amount), optionally only within one year. Every
    // entry a target covers is a repayment: kept out of income and expenses (it carries the REPAYMENT mark, as a cleared
    // entry does) and it settles that person's open shared items on its own, oldest first, the surplus going to the buffer.
    repayRegistry() { return Object.values(this.years).flatMap(node => node.repay || []); }
    repayTargets(property, who) { return this.repayRegistry().filter(row => row.property === property && row.with === who); }
    // Does a repayment target cover this entry? (property, section, then each optional step: year, subsection, entry.)
    repayCovers(row, item) {
      if (!item || item.eventId || item.parentId || !item.section) return false;
      return row.property === item.property && nameKey(row.section) === nameKey(item.section)
        && (!row.year || String(item.date).startsWith(`${row.year}-`))
        && (!row.category || nameKey(row.category) === nameKey(item.category))
        && (!row.entry || (row.entry.date === item.date && row.entry.description === item.description && Number(row.entry.amount) === Number(item.amount)));
    }
    repayFor(item) { return this.repayRegistry().find(row => this.repayCovers(row, item))?.with || ''; }
    // Adds a target, or (with `remove`) takes the equal one off. Kept in the latest year's node.
    changeRepay(target, remove = false) {
      const same = row => JSON.stringify(row) === JSON.stringify(target);
      const update = {};
      Object.entries(this.years).forEach(([year, node]) => {
        const before = node.repay || [];
        const kept = before.filter(row => !same(row));
        if (kept.length !== before.length) { if (kept.length) node.repay = kept; else delete node.repay; update[`years/${year}/repay`] = kept.length ? kept : null; }
      });
      if (!remove) {
        const year = String(this.yearIds().slice(-1)[0] ?? '');
        const node = this.year(year);
        if (node) { node.repay = [...(node.repay || []), target]; update[`years/${year}/repay`] = node.repay; }
      }
      this.resetShared();
      return Object.keys(update).length ? this.queue(() => this.db.patch(update)) : Promise.resolve();
    }
    resetShared() { this.seriesIndex = null; this.resolvedIndex = null; this.paidIndex = null; this.virtualIndex = null; this.realCache = null; }
    // Marks every entry of a repayment section as a repayment (kept out of income and expenses, like a cleared entry) and
    // takes the mark off any entry that has left one. Run before totals are worked out or saved.
    syncRepayFlags() {
      let changed = false;
      this.transactions.forEach(item => {
        if (item.parentId || item.eventId) return;
        const who = this.repayFor(item);
        if (who) {
          if (item.cleared?.id && !String(item.cleared.id).startsWith('rp:')) return;
          const want = `rp:${item.property}:${who}`;
          if (item.cleared?.id !== want) { item.cleared = { id: want, colour: REPAY_COLOUR }; changed = true; }
        } else if (String(item.cleared?.id || '').startsWith('rp:')) { delete item.cleared; changed = true; }
      });
      if (changed) this.resetShared();
      return changed;
    }
    // The app makes no settlements by itself: a repayment entry is only money you have paid or received. Settling is something
    // you do in the settle pane, choosing which owed items the money covers.
    virtualSettles() { return []; }
    // The entries in the blocks chosen for a person's repayments, and the settlements that have used each one.
    repayEntries(property, who) {
      return this.transactions.filter(item => !item.parentId && !item.eventId && item.property === property && this.repayFor(item) === who)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)));
    }
    repaySignature(item) { return `${item.date}|${item.description}|${Math.round(Math.abs(this.entryTotal(item.id)))}`; }
    // The settlement(s) that used this repayment entry, or none: what the REPAYMENT badge says (used or not).
    repayUse(item) {
      const sig = this.repaySignature(item);
      const used = this.realSettleList().filter(settle => settle.via === sig);
      return { used: used.length > 0, items: used.reduce((sum, settle) => sum + (settle.items || []).length, 0) };
    }
    repayUsed(item) { return this.repayUse(item).used; }
    // How much of a repayment entry has gone to shared expenses (settlements that name it as the money source), what is left of it
    // as buffer for other things, and which shared entries it paid (their keys).
    payerStats(item) {
      const sig = this.repaySignature(item);
      const total = Math.round(Math.abs(this.entryTotal(item.id)));
      const uses = this.realSettleList().filter(settle => settle.via === sig);
      const used = uses.reduce((sum, settle) => sum + (settle.items || []).reduce((inner, row) => inner + Math.abs(Number(row.a) || 0), 0), 0);
      return { total, used: Math.min(used, total), balance: Math.max(0, total - used), targets: [...new Set(uses.flatMap(settle => (settle.items || []).map(row => row.to)))] };
    }
    // The repayment entries (their signatures) that paid on one shared entry, and how much each paid.
    payersOf(sid) {
      const out = new Map();
      this.realSettleList().filter(settle => settle.via).forEach(settle => (settle.items || []).forEach(row => { if (row.to === sid) out.set(settle.via, (out.get(settle.via) || 0) + Math.abs(Number(row.a) || 0)); }));
      return [...out.entries()].map(([sig, amount]) => ({ sig, amount }));
    }
    rowBySignature(sig) { return this.transactions.find(row => !row.parentId && !row.eventId && this.repaySignature(row) === sig) || null; }
    // What share of a shared entry has been paid off, by any settlement: { due, paid }.
    receiverStats(item) {
      if (!item?.sid || !item.shared) return { due: 0, paid: 0 };
      const parts = global.SharedLedger.split({ amount: this.fullAmount(item), paidBy: item.shared.by, hisPct: item.shared.his });
      const due = item.shared.by === 'friend' ? parts.iOwe : parts.friendOwes;
      const open = this.sharedOwed(item)?.owed ?? due;
      return { due, paid: Math.max(0, due - open) };
    }
    saveSettle(settle) {
      const at = String(settle.date).slice(0, 4);
      const node = this.year(at);
      if (!node) return Promise.reject(new Error(`No year ${at} to keep the settlement in.`));
      const settles = node.settles ||= {};
      settles[settle.id] = settle;
      this.resetShared();
      return this.queue(() => this.db.patch({ [`years/${at}/settles/${settle.id}`]: settle }));
    }
    // What is still open on one shared entry, from every settlement made so far. Null for anything not shared.
    sharedOwed(item) {
      if (!item?.sid || !item.shared) return null;
      return this.sharedResolved().owed.get(item.sid) || global.SharedLedger.outstanding({ id: item.sid, amount: this.fullAmount(item), paidBy: item.shared.by, hisPct: item.shared.his, shared: true }, this.settleList());
    }
    // What each settlement paid on each shared entry: sid → [{ id, date, amount, name }]. `name` is the transaction the
    // payment was recorded as ("Settled with …"), or a plain "Settlement with …" when it was not recorded.
    sharedPaid(sid) {
      if (!this.paidIndex) {
        const names = new Map(this.transactions.filter(row => row.cleared?.id).map(row => [row.cleared.id, row.description]));
        const index = new Map();
        this.settleList().slice().reverse().forEach(settle => (settle.items || []).forEach(item => {
          const list = index.get(item.to) || [];
          list.push({ id: settle.id, date: settle.date, amount: Math.abs(Number(item.a) || 0), name: names.get(settle.id) || settle.name || `Settlement with ${settle.with}` });
          index.set(item.to, list);
        }));
        this.paidIndex = index;
      }
      return this.paidIndex.get(sid) || [];
    }
    // The whole cost of a shared entry: its notes' sum when it has notes (its own amount may be 0), else its amount.
    fullAmount(item) {
      const notes = this.transactions.filter(row => row.parentId === item.id);
      return Math.abs(notes.length ? notes.reduce((sum, note) => sum + Number(note.amount), 0) : Number(item.amount));
    }
    // Every shared entry's open amount, with edits and the buffer taken into account (see SharedLedger.resolve).
    sharedResolved() {
      if (!this.resolvedIndex) {
        const rows = this.transactions.filter(row => row.sid && row.shared && !row.parentId && !row.eventId)
          .map(row => ({ id: row.sid, amount: this.fullAmount(row), paidBy: row.shared.by, hisPct: row.shared.his, date: row.date, property: row.property, with: row.shared.with }));
        this.resolvedIndex = global.SharedLedger.resolve(rows, this.settleList());
      }
      return this.resolvedIndex;
    }
    // Each shared item's series status, read across every loaded month and year. Built once per redraw (refreshSeries).
    refreshSeries() { this.resetShared(); }
    sharedSeriesStatus(item) {
      if (!item?.sid || !item.shared) return null;
      if (!this.seriesIndex) {
        const rows = this.transactions.filter(row => row.sid && row.shared && !row.parentId && !row.eventId)
          .map(row => ({ id: row.sid, amount: this.fullAmount(row), paidBy: row.shared.by, hisPct: row.shared.his, date: row.date, series: row.series, property: row.property, with: row.shared.with }));
        this.seriesIndex = global.SharedLedger.runSeries(rows, this.settleList());
      }
      return this.seriesIndex.get(item.sid) || null;
    }
    // Pending settlements need every month of every year that exists, so they are all loaded before they are worked out.
    ensureAllYears() { return Promise.all(this.yearIds().map(year => this.ensureYear(year))); }

    // ---- year card: a whole year as one ledger ----
    // One currency's year in the same shape as country(), so the month panel draws it: every section, subsection and entry
    // of the year's months, each entry exactly as stored (with its notes), marked with the month it comes from. Only the
    // totals are added up: Income, Expenses and the closing balance are the year's own, and each block adds up to them as a month's do (the balance the year opened on, what custom sections and
    // events shown in months add, then the subsections).
    //   A section is one section across the year, by name (nameKey) and type, spelled as in its latest month: the Income
    //   (Expenses) block holds every income (expense) section, a custom section or an event's ★ section is its own block.
    //   A subsection is one row per section across the year, by name; `_meta.months` gives its amount and entry count per
    //   month, `_meta.items` what it went on: its entries' notes (or an entry itself when it has none) added up by
    //   description over the year (total, how many, in how many months), largest first.
    //   Each entry keeps its id (the same object the month edits) and gains `month` (0–11) and `ref`, the Firebase path
    //   of the month document it is stored in, so anything changed from the year card lands in that month.
    // Not worked out on every draw: each month is a cached slice, rebuilt only when that month's entries, its section
    // list or the events change (versions, eventsVersion), and the year is put together again only when a slice changed.
    // Months not loaded yet are left out (the year card loads every month before it draws).
    monthSlice(year, monthIndex, currency) {
      const id = monthIdOf(year, monthIndex);
      const sig = `${this.versions.get(id) || 0}|${this.eventsVersion}|${JSON.stringify(this.sections(year, monthIndex, currency))}`;
      const key = `${id}|${currency}`;
      const cached = this.slices.get(key);
      if (cached?.sig === sig) return cached;
      const slice = { sig, sections: this.country(year, monthIndex, currency).sections };
      this.slices.set(key, slice);
      return slice;
    }
    yearbook(year, currency) {
      // The months this currency is on (as the year's totals count them), loaded.
      const months = MONTH_NAMES.map((_, monthIndex) => monthIndex).filter(monthIndex => this.monthNode(year, monthIndex)?.metadata?.[currency] && this.isLoaded(year, monthIndex));
      const slices = months.map(monthIndex => [monthIndex, this.monthSlice(year, monthIndex, currency)]);
      const totals = this.yearTotals(year, currency);
      const holdings = this.yearHoldings(year, currency).open;
      const sharedSettles = this.settleList();
      const yearEnd = `${year}-12-31`;
      const sig = `${slices.map(([monthIndex, slice]) => `${monthIndex}:${slice.sig}`).join(',')}#${JSON.stringify(totals)}#${JSON.stringify(holdings)}#${JSON.stringify(sharedSettles)}`;
      const key = `${year}|${currency}`;
      const cached = this.books.get(key);
      if (cached?.sig === sig) return cached.book;
      const sections = new Map();
      // Months are taken newest first, so a name is spelled as its latest month spells it.
      [...slices].reverse().forEach(([monthIndex, slice]) => {
        const monthId = monthIdOf(year, monthIndex);
        Object.values(slice.sections).forEach(section => {
          const { id: name, type } = section._meta;
          const sectionKey = section._meta.event ? `event:${section._meta.event}:${type}` : `${section._meta.block ? `block:${section._meta.kind || 'settlement'}` : 'section'}:${type}:${nameKey(name)}`;
          let into = sections.get(sectionKey);
          if (!into) {
            into = { _meta: { id: name, type, subsections: [], names: [], categories: new Map() }, categories: {} };
            if (section._meta.block) into._meta.block = true;
            if (section._meta.event) into._meta.event = section._meta.event;
            sections.set(sectionKey, into);
          }
          if (!into._meta.names.includes(name)) into._meta.names.push(name);
          // A custom section's own figures (GI, GE, GB) and what it adds to Income and Expenses: the months' sum.
          if (section._meta.stats) {
            const stats = into._meta.stats ||= {};
            Object.entries(section._meta.stats).forEach(([field, amount]) => { if (amount !== undefined) stats[field] = (stats[field] || 0) + amount; });
          }
          // A settlement or savings section over the whole year: its cash both ways, my share and what is still open
          // are the months added up, so the year card answers "is this cleared?" without opening a single month.
          if (section._meta.settle) {
            into._meta.kind = section._meta.kind;
            into._meta.outstanding = Math.max(into._meta.outstanding || 0, section._meta.outstanding || 0);
            const totals = into._meta.settle ||= { kind: section._meta.kind, cashIn: 0, cashOut: 0, owed: 0, share: 0, saved: 0, returns: 0, settleIn: 0, settleOut: 0, allocated: 0, unallocated: 0, byRole: {}, purposes: [], cleared: true };
            ['cashIn', 'cashOut', 'owed', 'share', 'saved', 'returns', 'settleIn', 'settleOut', 'allocated', 'unallocated'].forEach(field => { totals[field] += section._meta.settle[field] || 0; });
            // Each thing the settlement is about, over the whole year: a purpose opened in March and paid off in
            // August is one row here, which is the only place it can be seen as one.
            (section._meta.settle.purposes || []).forEach(part => {
              const seen = totals.purposes.find(item => nameKey(item.name) === nameKey(part.name));
              const into_ = seen || (totals.purposes.push({ name: part.name, role: part.role, laid: 0, mine: 0, covered: 0, owed: 0 }), totals.purposes[totals.purposes.length - 1]);
              ['laid', 'mine', 'covered', 'owed'].forEach(field => { into_[field] += part[field] || 0; });
            });
            Object.entries(section._meta.settle.byRole || {}).forEach(([role, tally]) => {
              const into_ = totals.byRole[role] ||= { in: 0, out: 0, net: 0 };
              ['in', 'out', 'net'].forEach(field => { into_[field] += tally[field] || 0; });
            });
            totals.cleared = totals.owed === 0;
            into._meta.entries = (into._meta.entries || 0) + (section._meta.entries || 0);
            if (section._meta.about && !into._meta.about) into._meta.about = section._meta.about;
            into._meta.subAbout = { ...(section._meta.subAbout || {}), ...(into._meta.subAbout || {}) };
            // Closed for the year only when every month it appears in has been closed off.
            into._meta.closed = (into._meta.closed !== false) && Boolean(section._meta.closed);
            if (section._meta.closedOn && section._meta.closedOn > (into._meta.closedOn || '')) into._meta.closedOn = section._meta.closedOn;
            (section._meta.mergedFrom || []).forEach(from => {
              into._meta.mergedFrom ||= [];
              if (!into._meta.mergedFrom.includes(from)) into._meta.mergedFrom.push(from);
            });
          }
          (section._meta.adds?.lines || []).forEach(line => {
            const lines = (into._meta.adds ||= { lines: [] }).lines;
            const same = lines.find(item => item.type === line.type && item.label === line.label);
            if (same) Object.assign(same, { amount: same.amount + line.amount, counted: same.counted || line.counted });
            else lines.push({ ...line });
          });
          section._meta.subsections.forEach(sub => {
            if (!into._meta.subsections.some(own => nameKey(own) === nameKey(sub))) into._meta.subsections.push(sub);
          });
          Object.entries(section.categories).forEach(([categoryName, category]) => {
            const catKey = nameKey(categoryName);
            let row = into._meta.categories.get(catKey);
            if (!row) {
              row = { _meta: { id: categoryName, icon: category._meta.icon, entries: 0, total: 0, months: [] }, entries: [] };
              into._meta.categories.set(catKey, row);
            }
            row._meta.entries += category._meta.entries;
            row._meta.total += category._meta.total;
            if (category.entries.length) row._meta.months.push({ month: monthIndex, total: category._meta.total, entries: category._meta.entries });
            const path = `months/${monthId}/${currency}/${bucketOf(type)}`;
            row.entries.push(...category.entries.map(entry => ({ ...entry, month: monthIndex, ref: { path, id: entry.id } })));
          });
        });
      });
      // What each subsection went on, by description, over the year.
      sections.forEach(section => section._meta.categories.forEach(row => {
        const items = new Map();
        row.entries.forEach(entry => {
          if (entry.cleared) return;
          (entry.subEntries.length ? entry.subEntries.map(note => [note.description, Number(note.amount)]) : [[entry.description, entry._meta.total]]).forEach(([name, amount]) => {
            const key = nameKey(name) || '—';
            const item = items.get(key) || { key, name: name || '—', total: 0, count: 0, months: new Set() };
            item.total += amount;
            item.count += 1;
            item.months.add(entry.month);
            items.set(key, item);
          });
        });
        row._meta.items = [...items.values()].map(item => ({ ...item, months: item.months.size })).sort((a, b) => b.total - a.total);
      }));
      const out = {};
      sections.forEach((section, sectionKey) => {
        // Subsections listed in a month under a spelling another month uses for its entries show once.
        section._meta.subsections = section._meta.subsections.filter(sub => !section._meta.categories.has(nameKey(sub)) || section._meta.categories.get(nameKey(sub))._meta.id === sub);
        section._meta.categories.forEach(row => { section.categories[row._meta.id] = row; });
        delete section._meta.categories;
        out[sectionKey] = section;
      });
      const settledAccounts = { savings: [], hold: [], lent: [], borrowed: [] };
      const accountRoles = { savings: 'save', hold: 'hold', lent: 'lend', borrowed: 'borrow' };
      const moneyEntries = Object.values(out).flatMap(section => {
        const kind = section._meta.kind;
        return accountRoles[kind] ? Object.values(section.categories).flatMap(category =>
          category.entries.filter(entry => entry.moneyId).map(entry => ({ entry, kind }))
        ) : [];
      });
      const accounts = new Map();
      moneyEntries.forEach(({ entry, kind }) => {
        if (entry.date.slice(0, 4) !== String(year) || entry.moneyRef || entry.moneyRole !== accountRoles[kind]) return;
        const related = moneyEntries.filter(item => item.kind === kind && item.entry.moneyId === entry.moneyId)
          .map(({ entry: item }) => ({
            moneyId: item.moneyId, moneyRole: item.moneyRole, date: item.date, amount: item._meta.total
          }))
          .sort((a, b) => a.date.localeCompare(b.date));
        const remaining = linkedMoneyBalance(entry.moneyId, kind, related, item => item.amount, yearEnd);
        if (remaining > 0) return;
        const history = moneyEntries.filter(item => item.kind === kind && item.entry.moneyId === entry.moneyId)
          .map(({ entry: item }) => ({
            date: item.date, description: item.description, amount: item._meta.total, id: item.id
          }))
          .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
        accounts.set(`${kind}:${entry.moneyId}`, {
          kind, moneyId: entry.moneyId, description: entry.description, section: entry.section,
          category: entry.category, date: entry.date, history
        });
      });
      [...accounts.values()].forEach(account => settledAccounts[account.kind].push(account));
      Object.values(settledAccounts).forEach(list => list.sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description)));
      const sharedEntries = Object.values(out).flatMap(section => Object.values(section.categories)
        .flatMap(category => category.entries)
        .filter(entry => entry.sid && entry.shared)
        .map(entry => ({ entry, seriesId: entry.series?.id || `loose-${entry.sid}` })));
      const sharedRows = sharedEntries.map(({ entry }) => ({
        id: entry.sid, amount: Math.abs(Number(entry.sharedTotal ?? entry.amount)),
        paidBy: entry.shared.by, hisPct: entry.shared.his, date: entry.date,
        series: entry.series
      }));
      const sharedStatus = global.SharedLedger.runSeries(sharedRows, sharedSettles);
      const sharedBySeries = new Map();
      sharedEntries.forEach(({ entry, seriesId }) => {
        const group = sharedBySeries.get(seriesId) || {
          id: seriesId, title: entry.description, with: entry.shared.with, colour: entry.series?.colour || '',
          balance: 0, entries: [], history: []
        };
        const state = global.SharedLedger.outstanding({
          id: entry.sid, amount: Math.abs(Number(entry.sharedTotal ?? entry.amount)),
          paidBy: entry.shared.by, hisPct: entry.shared.his, shared: true
        }, sharedSettles);
        group.entries.push(entry);
        group.balance += state.direction === 'friend-owes-me' ? state.owed : -state.owed;
        group.history.push({
          date: entry.date, title: entry.description, detail: `${entry.shared.with} · ${entry.shared.by === 'friend' ? 'paid by them' : 'paid by you'}`,
          amount: Math.abs(Number(entry.sharedTotal ?? entry.amount)), kind: 'source', id: entry.sid
        });
        sharedBySeries.set(seriesId, group);
      });
      const sidToSeries = new Map(sharedEntries.map(({ entry, seriesId }) => [entry.sid, seriesId]));
      sharedSettles.forEach(settle => (settle.items || []).forEach(applied => {
        const seriesId = sidToSeries.get(applied.to);
        const group = seriesId && sharedBySeries.get(seriesId);
        if (!group) return;
        group.history.push({
          date: settle.date, title: `Settlement with ${settle.with}`, detail: `${Math.abs(Number(applied.a) || 0)} applied${settle.note ? ` · ${settle.note}` : ''}`,
          amount: Math.abs(Number(applied.a) || 0), kind: 'settlement', id: settle.id
        });
      }));
      const sharedHistory = { settled: [], ongoing: [] };
      sharedBySeries.forEach(group => {
        group.history.sort((a, b) => a.date.localeCompare(b.date)
          || (a.kind === 'source' ? 0 : 1) - (b.kind === 'source' ? 0 : 1)
          || a.id.localeCompare(b.id));
        const state = group.entries.map(entry => sharedStatus.get(entry.sid)?.state).some(value => value && value !== 'done')
          ? 'ongoing'
          : 'settled';
        sharedHistory[state].push({ ...group, entries: undefined });
      });
      Object.values(sharedHistory).forEach(list => list.sort((a, b) => a.history[0].date.localeCompare(b.history[0].date) || a.title.localeCompare(b.title)));
      // The balance the year opened on, as its first month brought it in.
      const first = months.length ? this.monthNode(year, months[0]).metadata[currency] : null;
      const region = this.currencies[currency];
      const book = {
        // The block headings as the year's latest month calls them, so the year card reads like the months it sums.
        _meta: { id: currency, name: region.name, code: region.code, color: region.color, income: totals.income, expense: totals.expenses, closing: totals.closing, holdings, carried: Number(first?.carried) || 0, carriedFrom: months.length ? this.carriedFrom(year, months[0], currency) : '', months, blockNames: this.blockNames(year, months.length ? months[months.length - 1] : 0, currency), settledAccounts, sharedHistory },
        sections: out
      };
      this.books.set(key, { sig, book });
      return book;
    }

    // ---- name catalogue ----
    // Every section and subsection name used anywhere (all years, months and currencies), de-duplicated by nameKey within
    // its type. `uses` counts the month lists and loaded entries that use a name, so suggestions can rank common ones
    // first; the spelling shown is the one used most. Worked out from the data each time, so it never goes stale.
    nameCatalog() {
      const tally = () => new Map();
      const sections = tally();
      const subsections = tally();
      const add = (map, type, name, weight) => {
        const key = `${type}:${nameKey(name)}`;
        if (!nameKey(name)) return;
        const entry = map.get(key) || { key, type, uses: 0, spellings: new Map() };
        entry.uses += weight;
        entry.spellings.set(name, (entry.spellings.get(name) || 0) + weight);
        map.set(key, entry);
      };
      Object.values(this.years).forEach(node => Object.values(node.monthSections || {}).forEach(month => Object.values(month).forEach(own => {
        own.sections.forEach(section => {
          add(sections, section.type, section.name, 1);
          section.subsections.forEach(name => add(subsections, section.type, name, 1));
        });
      })));
      Object.values(this.events).forEach(event => Object.values(event.sections).forEach(list => list.forEach(section => {
        add(sections, section.type, section.name, 1);
        section.subsections.forEach(name => add(subsections, section.type, name, 1));
      })));
      this.transactions.filter(item => !item.parentId).forEach(item => {
        add(subsections, item.type, item.category, 1);
        if (item.section) add(sections, item.type, item.section, 1);
      });
      const finish = map => [...map.values()].map(({ spellings, ...entry }) => ({ ...entry, name: [...spellings].sort((a, b) => b[1] - a[1])[0][0] }));
      return { sections: finish(sections), subsections: finish(subsections) };
    }

    // Entry and note descriptions from the loaded months, de-duplicated by nameKey: { entries, notes }, each item
    // { name, uses, last (latest date), categories (subsection keys it was filed under) }. Feeds description suggestions.
    descriptionCatalog() {
      const lists = { entries: new Map(), notes: new Map() };
      this.transactions.forEach(item => {
        const key = nameKey(item.description);
        if (!key) return;
        const map = item.parentId ? lists.notes : lists.entries;
        const entry = map.get(key) || { uses: 0, last: '', spellings: new Map(), categories: new Set() };
        entry.uses += 1;
        if (item.date > entry.last) entry.last = item.date;
        entry.spellings.set(item.description, (entry.spellings.get(item.description) || 0) + 1);
        entry.categories.add(`${item.type}:${nameKey(item.category)}`);
        map.set(key, entry);
      });
      const finish = map => [...map.values()].map(({ spellings, ...entry }) => ({ ...entry, name: [...spellings].sort((a, b) => b[1] - a[1])[0][0] }));
      return { entries: finish(lists.entries), notes: finish(lists.notes) };
    }

    // ---- year breakdown ----
    isYearLoaded(year) { return MONTH_NAMES.every((_, monthIndex) => this.isLoaded(year, monthIndex)); }
    // The section a year-wide rename files an entry under, and where that came from: 'event' (★ event name), 'stored' (the
    // entry's own section), 'list' (the month's list section holding its subsection) or 'other' (neither).
    summarySection(item, lists) {
      if (item.eventId) return { name: `★ ${this.eventName(item.eventId)}`, source: 'event' };
      if (item.section) return { name: item.section, source: 'stored' };
      const listed = lists.find(section => section.type === item.type && section.subsections.includes(item.category))?.name;
      if (listed) return { name: listed, source: 'list' };
      return { name: otherSectionName(item.type), source: 'other' };
    }

    // ---- year-wide rename (from the year card) ----
    // Renames one row of the year card for one currency across the whole year: a section, a subsection or an item.
    // target: { level: 'section' | 'sub' | 'item', type, section, sub?, item? }, each a name's nameKey.
    //   section  every month's list section of that name and type, and every entry (and note) that stores it
    //   sub      in that section, every month's list name and every entry (and its notes) filed under it
    //   item     in that subsection, every note (or note-less entry) of that description
    // Names that already exist where the new name lands are merged: two sections become one list section, a subsection
    // already listed by another section of the month moves there (category names are unique per type within a month).
    // Returns { entries, months, merged, apply() }; nothing changes until apply(), then save with saveTransactions(year).
    planRename(year, currency, target, name) {
      const oldKey = target[target.level];
      const newKey = nameKey(name);
      const changes = [];
      const months = new Set();
      let entries = 0;
      let merged = false;
      const childrenOf = id => this.transactions.filter(item => item.parentId === id);
      MONTH_NAMES.forEach((_, monthIndex) => {
        const lists = this.sections(year, monthIndex, currency);
        const ofType = lists.filter(section => section.type === target.type);
        // Resolve every entry against the month's lists as they are now, before any of them change.
        const matched = this.items(year, currency, monthIndex).filter(item => !item.parentId && item.type === target.type
          && nameKey(this.summarySection(item, lists).name) === target.section
          && (target.level === 'section' || nameKey(item.category) === target.sub));
        const before = changes.length;
        if (target.level === 'section') {
          // Sections already called the new name (other than this one) take this one's subsections.
          const named = ofType.filter(section => [oldKey, newKey].includes(nameKey(section.name)));
          if (named.some(section => nameKey(section.name) === oldKey) && named.length > 1) merged = true;
          if (named.some(section => nameKey(section.name) === oldKey) || matched.length) {
            changes.push(() => {
              const [keep, ...rest] = named;
              if (keep) {
                keep.name = name;
                rest.forEach(section => {
                  section.subsections.forEach(sub => { if (!keep.subsections.some(own => nameKey(own) === nameKey(sub))) keep.subsections.push(sub); });
                  lists.splice(lists.indexOf(section), 1);
                });
              }
              this.items(year, currency, monthIndex).filter(item => item.type === target.type && item.section && [oldKey, newKey].includes(nameKey(item.section)))
                .forEach(item => { item.section = name; });
            });
          }
        } else if (target.level === 'sub') {
          const home = ofType.filter(section => nameKey(section.name) === target.section);
          // Another section of the month already listing the new name holds the renamed entries from now on.
          const holder = ofType.find(section => nameKey(section.name) !== target.section && section.subsections.some(sub => nameKey(sub) === newKey));
          const listed = home.some(section => section.subsections.some(sub => nameKey(sub) === oldKey));
          if (holder && (listed || matched.length)) merged = true;
          if (listed || matched.length) {
            changes.push(() => {
              const finalName = holder ? holder.subsections.find(sub => nameKey(sub) === newKey) : name;
              // Merging drops the old name from this section's list; otherwise it is renamed in place, once.
              home.forEach(section => {
                section.subsections = holder
                  ? section.subsections.filter(sub => nameKey(sub) !== oldKey)
                  : section.subsections.map(sub => (nameKey(sub) === oldKey ? name : sub))
                    .filter((sub, index, all) => all.findIndex(other => nameKey(other) === nameKey(sub)) === index);
              });
              matched.forEach(entry => [entry, ...childrenOf(entry.id)].forEach(item => {
                item.category = finalName;
                if (holder) item.section = holder.name;
              }));
            });
          }
        } else {
          const parts = matched.flatMap(entry => {
            const notes = childrenOf(entry.id);
            return notes.length ? notes.filter(note => nameKey(note.description) === target.item) : nameKey(entry.description) === target.item ? [entry] : [];
          });
          if (parts.length) changes.push(() => parts.forEach(item => { item.description = name; }));
        }
        if (changes.length > before) {
          months.add(monthIndex);
          entries += matched.length;
        }
      });
      return { entries, months: months.size, merged, apply: () => changes.forEach(change => change()) };
    }

    // ---- entry queries (loaded months only) ----
    // A month's own entries; withEvents adds the entries of events shown in months.
    items(year, currency, monthIndex, { withEvents = false } = {}) {
      const prefix = dateKeyOf(year, monthIndex);
      return this.transactions.filter(item => item.property === currency && item.date.startsWith(prefix) && (!item.eventId || (withEvents && this.events[item.eventId]?.include)));
    }
    // A split entry's displayed amount is the sum of its sub-entries; an unsplit one shows its own.
    entryTotal(entryId) {
      const children = this.transactions.filter(t => t.parentId === entryId);
      const entry = this.transactions.find(t => t.id === entryId);
      if (children.length) return entry ? entryWith(entry, children) : children.reduce((sum, t) => sum + Number(t.amount), 0);
      return entry ? shareOf(entry) : 0;
    }

    // One currency's tree for an opened month: section → category → entry → sub-entries. Header totals are the stored metadata.
    country(year, monthIndex, currency) {
      const region = this.currencies[currency];
      const totals = this.monthTotals(year, monthIndex, currency);
      const sections = this.groupIntoSections(this.items(year, currency, monthIndex), this.sections(year, monthIndex, currency), '9999-12-31', currency);
      // Events shown in months appear as their own ★ section, read-only here; they are edited in the event.
      const shown = this.items(year, currency, monthIndex, { withEvents: true }).filter(item => item.eventId);
      [...new Set(shown.map(item => item.eventId))].forEach(id => ['expense', 'income'].forEach(type => {
        const own = shown.filter(item => item.eventId === id && item.type === type);
        if (!own.length) return;
        const section = this.buildSection(`★ ${this.eventName(id)}`, type, [], own);
        section._meta.event = id;
        sections[`event:${id}:${type}`] = section;
      }));
      return {
        _meta: { id: currency, name: region.name, code: region.code, color: region.color, income: totals.income, expense: totals.expenses, closing: totals.closing, holdings: totals.holdings, carried: totals.carried, carriedFrom: this.carriedFrom(year, monthIndex, currency), blockNames: this.blockNames(year, monthIndex, currency), blockCalcs: this.blockCalcs(year, monthIndex, currency) },
        sections
      };
    }
    // Files items under a section list: by their stored section, else by subsection name, else under "Other".
    groupIntoSections(items, list, through = '9999-12-31', currency = null) {
      const sections = {};
      const claimed = new Set();
      [...list]
        .sort((a, b) => (a.type === 'income' ? 0 : 1) - (b.type === 'income' ? 0 : 1))
        .forEach(section => {
          const own = items.filter(item => item.type === section.type && !claimed.has(item) && (item.section === section.name || (!item.section && section.subsections.includes(item.category))));
          own.forEach(item => claimed.add(item));
          sections[section.name] = this.buildSection(section.name, section.type, section.subsections, own);
          // A section added beside Income and Expenses is drawn as its own block, under its own name.
          if (section.block || section.type === 'net') sections[section.name]._meta.block = true;
          if (section.type === 'net') {
            // What each subsection counts as and what the section adds to the month, by its rules (as stored totals count it).
            const built = sections[section.name];
            const amountsBySub = Object.fromEntries(Object.entries(built.categories).map(([name, category]) => [name, category.entries.map(entry => ({ amount: entry._meta.total, split: entry.split || null, alloc: entry.alloc || null }))]));
            const summary = netSectionSummary(section, amountsBySub);
            built._meta.adds = summary.adds;
            built._meta.stats = summary.stats;
            // Which block it belongs in (Settlements or Savings), what each subsection stands for, how much is still
            // open, and whether it has been closed off. A closed section still counts: history does not change.
            built._meta.kind = summary.kind;
            built._meta.settle = summary.settle;
            built._meta.roles = Object.fromEntries(Object.keys(built.categories).map(name => [name, subsectionRole(section, name)]));
            built._meta.closed = Boolean(section.closed);
            built._meta.autoClosed = Boolean(section.autoClosed);
            built._meta.closedOn = section.closedOn || '';
            built._meta.mergedFrom = [...(section.mergedFrom || [])];
            // The months an item in a block is linked across (see openCloseDialog): the same link on each month's section.
            built._meta.link = section.link || '';
            built._meta.entries = Object.values(built.categories).reduce((sum, category) => sum + category._meta.entries, 0);
            // How much of the money in this block is still out, as of the end of this month: each linked item's balance
            // (what was lent, held or borrowed, less what came back), over every month loaded.
            if (MONEY_OUT_KINDS.includes(built._meta.kind)) {
              // A section linked across months is judged as one: every month's entries together (see linkedRoleTotals). Without a link, only its own.
              const own = section.link && currency ? this.linkedRoleTotals(section.link, currency, built._meta.kind) : null;
              const mine = Number(built._meta.settle?.[{ hold: 'held', lent: 'lent', borrowed: 'borrowed' }[built._meta.kind]]) || 0;
              const net = own ? own.total : mine;
              // Paid back (or given back) more than was out: only noted, as "Buffered"; nothing is done with it.
              built._meta.buffered = net < 0 && (own ? own.positives > 0 : true);
              built._meta.outstanding = Math.max(0, net);
            }
            // The section's own description and each subsection's, kept with the section so they travel with it.
            built._meta.about = section.about || '';
            built._meta.subAbout = { ...(section.subAbout || {}) };
          }
        });
      ['income', 'expense', 'net'].forEach(type => {
        const leftover = items.filter(item => item.type === type && !claimed.has(item));
        if (leftover.length) {
          const name = otherSectionName(type);
          sections[name] = this.buildSection(name, type, [], leftover);
          if (type === 'net') {
            const built = sections[name];
            built._meta.block = true;
            const amountsBySub = Object.fromEntries(Object.entries(built.categories).map(([sub, category]) => [sub, category.entries.map(entry => ({ amount: entry._meta.total, split: entry.split || null, alloc: entry.alloc || null }))]));
            const summary = netSectionSummary({ name, subsections: Object.keys(built.categories) }, amountsBySub);
            Object.assign(built._meta, { adds: summary.adds, stats: summary.stats, kind: summary.kind, settle: summary.settle, roles: {}, closed: false, closedOn: '', mergedFrom: [] });
          }
        }
      });
      return sections;
    }
    buildSection(name, type, subsections, items) {
      const parents = items.filter(item => !item.parentId);
      const categories = {};
      [...new Set([...subsections, ...parents.map(item => item.category)])].forEach(category => {
        const own = parents.filter(item => item.category === category);
        categories[category] = {
          _meta: { id: category, icon: iconFor(category, type), entries: own.length, total: own.reduce((sum, item) => sum + (item.cleared ? 0 : this.entryTotal(item.id)), 0) },
          entries: own.map(item => this.buildEntry(item))
        };
      });
      return { _meta: { id: name, type, subsections: [...subsections] }, categories };
    }
    buildEntry(item) {
      const subEntries = this.transactions.filter(t => t.parentId === item.id);
      return {
        id: item.id, date: item.date, description: item.description, place: item.place || '', amount: shareOf(item), formula: item.formula || null, tags: item.tags || [], about: item.about || '',
        split: item.split || null, alloc: item.alloc ? normalizeAlloc(item.alloc) : null,
        // A shared expense carries its marker and series into the ledger, or its ball has nothing to draw.
        ...(item.sid && item.shared ? { sid: item.sid, shared: item.shared, sharedTotal: this.fullAmount(item), ...(item.series ? { series: item.series } : {}) } : {}),
        ...(item.cleared ? { cleared: item.cleared } : {}),
        ...(item.card ? { card: item.card } : {}),
        ...(item.refKey ? { refKey: item.refKey } : {}), ...(item.refDate ? { refDate: item.refDate } : {}), ...(item.markerOf ? { markerOf: item.markerOf } : {}),
        ...(item.moneyId ? {
          moneyId: String(item.moneyId),
          ...(item.moneyRole ? { moneyRole: String(item.moneyRole) } : {}),
          ...(item.moneyRef ? { moneyRef: {
            date: String(item.moneyRef.date), description: String(item.moneyRef.description),
            ...(item.moneyRef.section ? { section: String(item.moneyRef.section) } : {}),
            ...(item.moneyRef.category ? { category: String(item.moneyRef.category) } : {})
          } } : {})
        } : {}),
        section: item.section, category: item.category, type: item.type, property: item.property, eventId: item.eventId || null,
        _meta: { total: this.entryTotal(item.id), children: subEntries.length },
        subEntries: subEntries.map(sub => ({ id: sub.id, date: sub.date, description: sub.description, place: sub.place || '', amount: Number(sub.amount), formula: sub.formula || null, tags: sub.tags || [], flow: sub.flow || null, about: sub.about || '' }))
      };
    }
  }

  Object.assign(ExpenseStore, { sectionCalc, ensureCalc, runCalc, blockCalc, runBlockCalc, defaultBlockCalc, linkedMoneyBalance, CALC_NAMES, SECTION_ROLES, sectionKind, subsectionRole, defaultCalc, netSectionSummary, readStatus, statusless, sectionState, SECTION_STATES, BLOCK_NAMES, MONTH_NAMES, monthIdOf, iconFor, flattenMonth, monthDoc, readAmount, nameKey, safeKey, SPLIT_MODES, SPLIT_ROLE, splitShare, splitLabel,
    ALLOC_ROLE, normalizeAlloc, allocFor, allocTotal, SETTLE_MODES, SETTLE_MODE_LABELS, SETTLE_PRESETS, settleMode, settlePreset });
  global.ExpenseStore = ExpenseStore;
})(typeof globalThis !== 'undefined' ? globalThis : window);
