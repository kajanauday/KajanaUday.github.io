// ExpenseStore: the single owner of ledger data, backed by Firebase Realtime Database (REST API).
//
// Firebase layout under `root`:
//   currencies/<cur>                 display config per currency (name, code, symbol, locale, color, order)
//   years/<year>                     one year, small enough to render the whole shell from:
//     currencies/<cur>               { from: "August", opening }  the month a currency starts and its opening balance
//     sections[]                     { name, type, subsections[] }  the year's section taxonomy
//     metadata                       { entries, currencies[], <cur>: { income, expenses, balance, entries, opening, closing } }
//     months/<year>_<Month>          { name, month, currencies[], metadata: { entries, <cur>: { income, expenses, balance, entries, closing } } }
//   months/<year>_<Month>            that month's entries: <cur> → income/expenses → [{ category, total, count, entries[] }] → notes[]
//
// The shell (year tabs, month rows, year summary) is drawn from `years` alone. A month's entries are fetched only when it is
// opened (ensureMonth). Amounts are minor units (paise / sen). An entry with notes counts as the sum of its notes.
(function (global) {
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const BUCKETS = [['income', 'income'], ['expenses', 'expense']];
  const pad = n => String(n).padStart(2, '0');
  const monthIdOf = (year, monthIndex) => `${year}_${MONTH_NAMES[monthIndex]}`;
  const dateKeyOf = (year, monthIndex) => `${year}-${pad(monthIndex + 1)}`;
  const noteTotal = (amount, notes) => (notes.length ? notes.reduce((sum, note) => sum + Number(note.amount), 0) : Number(amount));
  const zeroTotals = () => ({ income: 0, expenses: 0, entries: 0 });

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

  class FirebaseDb {
    constructor(databaseURL, root) {
      this.base = `${databaseURL.replace(/\/$/, '')}/${root}`;
    }
    async request(path, options) {
      const response = await fetch(`${this.base}${path ? `/${path}` : ''}.json`, options);
      if (!response.ok) throw new Error(`Firebase ${options?.method || 'GET'} ${path || '/'} failed: HTTP ${response.status}`);
      return response.json();
    }
    get(path) { return this.request(path); }
    // Multi-path update: keys are paths under root, null deletes. Applied atomically.
    patch(update) { return this.request('', { method: 'PATCH', body: JSON.stringify(update) }); }
  }

  // Firebase drops empty arrays and objects, so restore them before the UI reads a year.
  function normalizeYear(year = {}) {
    year.currencies ||= {};
    year.sections = (year.sections || []).map(section => ({ ...section, subsections: section.subsections || [] }));
    year.metadata ||= { entries: 0 };
    year.metadata.currencies ||= [];
    year.months ||= {};
    Object.values(year.months).forEach(month => {
      month.currencies ||= [];
      month.metadata ||= { entries: 0 };
    });
    return year;
  }

  // One stored month → flat entries; notes become sub-entries of their entry. Ids are derived from position.
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
          list.push({ ...entry, id, date: `${dateKey}-${pad(day)}`, property: currency, type, category });
          notes.forEach(({ day: noteDay, ...note }, n) => list.push({ ...note, id: `${id}-note-${n + 1}`, parentId: id, date: `${dateKey}-${pad(noteDay ?? day)}`, property: currency, type, category }));
        }));
      });
    });
    return list;
  }

  // Flat entries of one month → the stored month document (null when the month has no entries).
  function monthDoc(items) {
    const doc = {};
    const childrenOf = new Map();
    items.filter(item => item.parentId).forEach(item => {
      if (!childrenOf.has(item.parentId)) childrenOf.set(item.parentId, []);
      childrenOf.get(item.parentId).push(item);
    });
    items.filter(item => !item.parentId).sort((a, b) => a.date.localeCompare(b.date)).forEach(item => {
      const bucket = item.type === 'income' ? 'income' : 'expenses';
      const groups = (doc[item.property] ||= { income: [], expenses: [] })[bucket];
      let group = groups.find(g => g.category === item.category);
      if (!group) groups.push(group = { category: item.category, total: 0, count: 0, entries: [] });
      const notes = (childrenOf.get(item.id) || []).map(note => ({ day: Number(note.date.slice(8, 10)), description: note.description, place: note.place || '', amount: Number(note.amount) }));
      const entry = { day: Number(item.date.slice(8, 10)), description: item.description, place: item.place || '', amount: Number(item.amount) };
      if (item.section) entry.section = item.section;
      entry.notes = notes;
      group.entries.push(entry);
      group.count += 1;
      group.total += noteTotal(entry.amount, notes);
    });
    return Object.keys(doc).length ? doc : null;
  }

  function docTotals(buckets) {
    const totals = zeroTotals();
    BUCKETS.forEach(([bucket]) => (buckets?.[bucket] || []).forEach(group => {
      totals[bucket] += group.total;
      totals.entries += group.count;
    }));
    return totals;
  }

  class ExpenseStore {
    // Build with ExpenseStore.open(), which reads currencies and years (not entries) from Firebase.
    constructor({ db, currencies, years }) {
      this.db = db;
      this.currencies = currencies;
      this.years = years;
      this.transactions = [];
      this.synced = new Map();   // monthId → JSON of the month document as Firebase holds it
      this.loading = new Map();  // monthId → in-flight fetch
      this.writes = Promise.resolve();
    }
    static async open({ databaseURL, root }) {
      const db = new FirebaseDb(databaseURL, root);
      const [currencies, years] = await Promise.all([db.get('currencies'), db.get('years')]);
      const ordered = Object.fromEntries(Object.entries(currencies || {}).sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0)));
      Object.values(years || {}).forEach(normalizeYear);
      return new ExpenseStore({ db, currencies: ordered, years: years || {} });
    }

    // ---- shell: years, months and their metadata ----
    currencyKeys() { return Object.keys(this.currencies); }
    ordered(list) { return this.currencyKeys().filter(key => list.includes(key)); }
    yearIds() { return Object.keys(this.years).sort(); }
    year(year) { return this.years[String(year)]; }
    sections(year) { return this.year(year)?.sections || []; }
    monthNode(year, monthIndex) { return this.year(year)?.months[monthIdOf(year, monthIndex)]; }
    monthCurrencies(year, monthIndex) { return this.ordered(this.monthNode(year, monthIndex)?.currencies || []); }
    yearCurrencies(year) { return this.ordered(this.year(year)?.metadata.currencies || []); }
    monthTotals(year, monthIndex, currency) {
      return { income: 0, expenses: 0, balance: 0, entries: 0, closing: 0, ...this.monthNode(year, monthIndex)?.metadata[currency] };
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
        }).finally(() => this.loading.delete(id)));
      }
      return this.loading.get(id);
    }
    ensureYear(year) {
      return Promise.all(MONTH_NAMES.map((_, monthIndex) => this.ensureMonth(year, monthIndex)));
    }

    // ---- persistence ----
    // Metadata is rebuilt immediately so the UI shows new totals at once; the write is queued so writes land in order.
    saveTransactions() {
      const update = {};
      const years = new Set();
      this.synced.forEach((json, id) => {
        const year = id.slice(0, 4);
        const doc = monthDoc(this.transactions.filter(item => item.date.startsWith(dateKeyOf(year, MONTH_NAMES.indexOf(id.slice(5))))));
        const next = JSON.stringify(doc);
        if (next === json) return;
        update[`months/${id}`] = doc;
        this.synced.set(id, next);
        years.add(year);
      });
      years.forEach(year => { update[`years/${year}`] = this.recomputeYear(year); });
      return this.queue(() => (Object.keys(update).length ? this.db.patch(update) : null));
    }
    // Writes a year's configuration ({ currencies, sections }) and its rebuilt metadata. Creates the year if new.
    saveYear(year, config) {
      const key = String(year);
      this.years[key] = normalizeYear({ ...this.years[key], ...config });
      const node = this.recomputeYear(key);
      return this.queue(() => this.db.patch({ [`years/${key}`]: node }));
    }
    queue(write) {
      const result = this.writes.then(write);
      this.writes = result.catch(() => {});
      return result;
    }

    // Month totals come from loaded entries when the month is loaded, otherwise from the stored metadata.
    // Closing balances run from each currency's opening at its start month.
    recomputeYear(year) {
      const node = this.year(year);
      const keys = this.currencyKeys().filter(key => node.currencies[key]);
      const running = {};
      const yearTotals = {};
      const months = {};
      MONTH_NAMES.forEach((name, monthIndex) => {
        const id = monthIdOf(year, monthIndex);
        const active = keys.filter(key => MONTH_NAMES.indexOf(node.currencies[key].from) <= monthIndex);
        const doc = this.synced.has(id) ? JSON.parse(this.synced.get(id)) : null;
        const metadata = { entries: 0 };
        active.forEach(key => {
          const stored = node.months[id]?.metadata?.[key];
          const totals = this.synced.has(id) ? docTotals(doc?.[key]) : { ...zeroTotals(), ...(stored && { income: stored.income, expenses: stored.expenses, entries: stored.entries }) };
          running[key] ??= Number(node.currencies[key].opening) || 0;
          running[key] += totals.income - totals.expenses;
          metadata[key] = { ...totals, balance: totals.income - totals.expenses, closing: running[key] };
          metadata.entries += totals.entries;
          const sum = yearTotals[key] ||= { ...zeroTotals(), opening: Number(node.currencies[key].opening) || 0 };
          sum.income += totals.income;
          sum.expenses += totals.expenses;
          sum.entries += totals.entries;
        });
        months[id] = { name, month: monthIndex + 1, currencies: active, metadata };
      });
      const metadata = { entries: 0, currencies: Object.keys(yearTotals) };
      Object.entries(yearTotals).forEach(([key, sum]) => {
        metadata[key] = { ...sum, balance: sum.income - sum.expenses, closing: running[key] };
        metadata.entries += sum.entries;
      });
      Object.assign(node, { months, metadata });
      return node;
    }

    // ---- entry queries (loaded months only) ----
    items(year, currency, monthIndex) {
      const prefix = dateKeyOf(year, monthIndex);
      return this.transactions.filter(item => item.property === currency && item.date.startsWith(prefix));
    }
    // A split entry's displayed amount is the sum of its sub-entries; an unsplit one shows its own.
    entryTotal(entryId) {
      const children = this.transactions.filter(t => t.parentId === entryId);
      if (children.length) return children.reduce((sum, t) => sum + Number(t.amount), 0);
      const entry = this.transactions.find(t => t.id === entryId);
      return entry ? Number(entry.amount) : 0;
    }

    // One currency's tree for an opened month: section → category → entry → sub-entries. Header totals are the stored metadata.
    country(year, monthIndex, currency) {
      const region = this.currencies[currency];
      const items = this.items(year, currency, monthIndex);
      const totals = this.monthTotals(year, monthIndex, currency);
      const sections = {};
      const claimed = new Set();
      [...this.sections(year)]
        .sort((a, b) => (a.type === 'income' ? 0 : 1) - (b.type === 'income' ? 0 : 1))
        .forEach(section => {
          const own = items.filter(item => item.type === section.type && !claimed.has(item) && (item.section === section.name || (!item.section && section.subsections.includes(item.category))));
          own.forEach(item => claimed.add(item));
          sections[section.name] = this.buildSection(section.name, section.type, section.subsections, own);
        });
      ['income', 'expense'].forEach(type => {
        const leftover = items.filter(item => item.type === type && !claimed.has(item));
        if (leftover.length) {
          const name = type === 'income' ? 'Other income' : 'Other expenses';
          sections[name] = this.buildSection(name, type, [], leftover);
        }
      });
      return {
        _meta: { id: currency, name: region.name, code: region.code, color: region.color, income: totals.income, expense: totals.expenses, closing: totals.closing },
        sections
      };
    }
    buildSection(name, type, subsections, items) {
      const parents = items.filter(item => !item.parentId);
      const categories = {};
      [...new Set([...subsections, ...parents.map(item => item.category)])].forEach(category => {
        const own = parents.filter(item => item.category === category);
        categories[category] = {
          _meta: { id: category, icon: iconFor(category, type), entries: own.length, total: own.reduce((sum, item) => sum + this.entryTotal(item.id), 0) },
          entries: own.map(item => this.buildEntry(item))
        };
      });
      return { _meta: { id: name, type, subsections: [...subsections] }, categories };
    }
    buildEntry(item) {
      const subEntries = this.transactions.filter(t => t.parentId === item.id);
      return {
        id: item.id, date: item.date, description: item.description, place: item.place || '', amount: Number(item.amount),
        section: item.section, category: item.category, type: item.type, property: item.property,
        _meta: { total: this.entryTotal(item.id), children: subEntries.length },
        subEntries: subEntries.map(sub => ({ id: sub.id, date: sub.date, description: sub.description, place: sub.place || '', amount: Number(sub.amount) }))
      };
    }
  }

  Object.assign(ExpenseStore, { MONTH_NAMES, monthIdOf, iconFor, flattenMonth, monthDoc });
  global.ExpenseStore = ExpenseStore;
})(typeof globalThis !== 'undefined' ? globalThis : window);
