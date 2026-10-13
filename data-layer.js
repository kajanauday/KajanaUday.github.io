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
  const normalizeSections = sections => (sections || []).map(section => ({ ...section, subsections: section.subsections || [] }));
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
      const notes = (childrenOf.get(item.id) || []).map(note => ({ day: Number(note.date.slice(8, 10)), description: note.description, place: note.place || '', amount: Number(note.amount), ...(note.formula && { formula: note.formula }) }));
      const entry = { day: Number(item.date.slice(8, 10)), description: item.description, place: item.place || '', amount: Number(item.amount) };
      if (item.formula) entry.formula = item.formula;
      if (item.section) entry.section = item.section;
      entry.notes = notes;
      group.entries.push(entry);
      group.count += 1;
      group.total += noteTotal(entry.amount, notes);
    });
    return Object.keys(doc).length ? doc : null;
  }

  // Entries-only totals from a stored month's metadata (which includes any carried balance).
  function rawFromStored(stored) {
    if (!stored) return zeroTotals();
    const carried = Number(stored.carried) || 0;
    return { income: stored.income - Math.max(carried, 0), expenses: stored.expenses - Math.max(-carried, 0), entries: stored.entries || 0 };
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
      const store = new ExpenseStore({ db, currencies: ordered, years: years || {} });
      // Rebuild metadata in memory so carried balances show even for data saved before they existed; the next save writes it.
      store.yearIds().forEach(year => store.recomputeYear(year));
      await store.moveYearSectionsToMonths();
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
      (node.monthSections[monthIdOf(year, monthIndex)] ||= {})[currency] = { own: true, sections: normalizeSections(sections) };
      const update = this.recomputeFrom(String(year));
      return this.queue(() => this.db.patch(update));
    }
    monthNode(year, monthIndex) { return this.year(year)?.months[monthIdOf(year, monthIndex)]; }
    monthCurrencies(year, monthIndex) { return this.ordered(this.monthNode(year, monthIndex)?.currencies || []); }
    yearCurrencies(year) { return this.ordered(this.year(year)?.metadata.currencies || []); }
    monthTotals(year, monthIndex, currency) {
      return { income: 0, expenses: 0, balance: 0, entries: 0, closing: 0, carried: 0, previous: 0, ...this.monthNode(year, monthIndex)?.metadata[currency] };
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
    recomputeYear(year) {
      const node = this.year(year);
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
          const raw = this.synced.has(id) ? docTotals(doc?.[key]) : rawFromStored(node.months[id]?.metadata?.[key]);
          const first = !(key in running);
          const previous = first ? this.yearOpening(year, key) : running[key];
          const carried = setup[key].carry ? previous : 0;
          const income = raw.income + Math.max(carried, 0);
          const expenses = raw.expenses + Math.max(-carried, 0);
          running[key] = income - expenses;
          metadata[key] = { income, expenses, balance: income - expenses, entries: raw.entries, closing: running[key], carried, previous };
          metadata.entries += raw.entries;
          const sum = sums[key] ||= { ...zeroTotals(), opening: previous, carriedIn: first ? carried : 0 };
          sum.income += raw.income;
          sum.expenses += raw.expenses;
          sum.entries += raw.entries;
        });
        months[id] = { name, month: monthIndex + 1, currencies: active, metadata };
      });
      // The year counts its entries plus the balance it opened on; month-to-month carries are internal and not re-counted.
      const metadata = { entries: 0, currencies: Object.keys(sums) };
      Object.entries(sums).forEach(([key, sum]) => {
        const income = sum.income + Math.max(sum.carriedIn, 0);
        const expenses = sum.expenses + Math.max(-sum.carriedIn, 0);
        metadata[key] = { income, expenses, balance: income - expenses, entries: sum.entries, opening: sum.opening, closing: running[key] };
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
      [...this.sections(year, monthIndex, currency)]
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
        _meta: { id: currency, name: region.name, code: region.code, color: region.color, income: totals.income, expense: totals.expenses, closing: totals.closing, carried: totals.carried, carriedFrom: this.carriedFrom(year, monthIndex, currency) },
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
        id: item.id, date: item.date, description: item.description, place: item.place || '', amount: Number(item.amount), formula: item.formula || null,
        section: item.section, category: item.category, type: item.type, property: item.property,
        _meta: { total: this.entryTotal(item.id), children: subEntries.length },
        subEntries: subEntries.map(sub => ({ id: sub.id, date: sub.date, description: sub.description, place: sub.place || '', amount: Number(sub.amount), formula: sub.formula || null }))
      };
    }
  }

  Object.assign(ExpenseStore, { MONTH_NAMES, monthIdOf, iconFor, flattenMonth, monthDoc, readAmount });
  global.ExpenseStore = ExpenseStore;
})(typeof globalThis !== 'undefined' ? globalThis : window);
