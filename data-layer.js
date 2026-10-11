// ExpenseStore: the single owner of ledger data.
// Holds the flat transaction list plus per-year settings (persisted to the same localStorage keys
// the app has always used), and builds the hierarchical tree described in expenses-schema.json
// on demand. Every node's _meta is computed once per build and reused until the next mutation.
(function (global) {
  const SYMBOLS = { INR: '₹', JPY: '¥' };

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

  class ExpenseStore {
    constructor({ storageKey, regions, firstYear, starter = [] }) {
      this.storageKey = storageKey;
      this.settingsKey = `${storageKey}-year-settings`;
      this.regions = regions;
      this.firstYear = firstYear;
      this.starter = starter;
      this.transactions = this.loadTransactions();
      this.settingsByYear = this.loadSettings();
      this.tree = null;
    }

    // ---- persistence (unchanged storage format) ----
    loadTransactions() {
      try {
        const saved = JSON.parse(localStorage.getItem(this.storageKey));
        return Array.isArray(saved) ? saved : this.starter.map(item => ({ ...item }));
      } catch (error) {
        return this.starter.map(item => ({ ...item }));
      }
    }
    loadSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem(this.settingsKey) || '{}');
        return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
      } catch (error) {
        console.error('Could not load year settings.', error);
        return {};
      }
    }
    saveTransactions() {
      localStorage.setItem(this.storageKey, JSON.stringify(this.transactions));
      this.invalidate();
    }
    saveSettings() {
      localStorage.setItem(this.settingsKey, JSON.stringify(this.settingsByYear));
      this.invalidate();
    }
    replaceTransactions(list) {
      this.transactions = list;
      this.invalidate();
    }
    invalidate() { this.tree = null; }

    // ---- settings ----
    defaultSettings(year) {
      const yearItems = this.transactions.filter(item => item.date.startsWith(`${year}-`));
      const expense = yearItems.filter(item => item.type === 'expense').map(item => item.category);
      const income = yearItems.filter(item => item.type === 'income').map(item => item.category);
      return {
        currencies: year === 2025 ? ['india'] : Object.keys(this.regions),
        sections: [
          { name: 'Expenses', type: 'expense', subsections: [...new Set(expense.length ? expense : ['Housing', 'Food', 'Utilities', 'Transport', 'Shopping'])] },
          { name: 'Income', type: 'income', subsections: [...new Set(income.length ? income : ['Salary', 'Freelance', 'Other'])] }
        ]
      };
    }
    settings(year) {
      const key = String(year);
      this.settingsByYear[key] ||= this.defaultSettings(year);
      return this.settingsByYear[key];
    }
    // Per-year amounts (minor units). Settings saved before these keys existed fall back to the region defaults.
    openingFor(year, property) {
      const saved = this.settings(year).openings?.[property];
      return Number.isFinite(saved) ? saved : year === 2026 ? this.regions[property].opening : 0;
    }
    budgetFor(year, property) {
      const saved = this.settings(year).budgets?.[property];
      return Number.isFinite(saved) ? saved : this.regions[property].budget;
    }

    // ---- flat queries used by forms, filters and balances ----
    items(year, property, month = null) {
      const prefix = month === null ? `${year}-` : `${year}-${String(month + 1).padStart(2, '0')}`;
      return this.transactions.filter(item => item.property === property && item.date.startsWith(prefix));
    }
    sumType(items, type) {
      return items.filter(item => item.type === type).reduce((sum, item) => sum + Number(item.amount), 0);
    }
    flow(items) {
      const income = this.sumType(items, 'income');
      const expense = this.sumType(items, 'expense');
      return { income, expense, net: income - expense, count: items.length };
    }
    // Opening balance for the year plus every month's net up to and including `month`.
    closingBalance(year, property, month) {
      const cutoff = `${year}-${String(month + 1).padStart(2, '0')}`;
      const items = this.items(year, property).filter(item => item.date.slice(0, 7) <= cutoff);
      return this.openingFor(year, property) + this.flow(items).net;
    }
    // A split entry's displayed amount is the sum of its sub-entries; an unsplit one shows its own.
    entryTotal(entryId) {
      const children = this.transactions.filter(t => t.parentId === entryId);
      if (children.length) return children.reduce((sum, t) => sum + Number(t.amount), 0);
      const entry = this.transactions.find(t => t.id === entryId);
      return entry ? Number(entry.amount) : 0;
    }
    categoryTotal(category, type, monthKey, property) {
      return this.transactions
        .filter(t => t.property === property && t.category === category && t.type === type && t.date.startsWith(monthKey) && !t.parentId)
        .reduce((sum, t) => sum + this.entryTotal(t.id), 0);
    }

    // ---- hierarchical tree (expenses-schema.json) ----
    build() {
      if (this.tree) return this.tree;
      const years = {};
      const lastYear = new Date().getFullYear();
      for (let year = lastYear; year >= this.firstYear; year--) years[year] = this.buildYear(year);
      this.tree = { years };
      return this.tree;
    }
    year(year) { return this.build().years[year]; }
    month(year, monthIndex) { return this.year(year)?.months[`${year}-${String(monthIndex + 1).padStart(2, '0')}`]; }
    country(year, monthIndex, property) { return this.month(year, monthIndex)?.countries[property]; }

    buildYear(year) {
      const settings = this.settings(year);
      const all = this.transactions.filter(item => item.date.startsWith(`${year}-`));
      const months = {};
      for (let m = 0; m < 12; m++) {
        const key = `${year}-${String(m + 1).padStart(2, '0')}`;
        months[key] = this.buildMonth(year, m, key, settings, all.filter(item => item.date.startsWith(key)));
      }
      const flow = this.flow(all);
      return {
        _meta: { id: String(year), entries: all.length, income: flow.income, expense: flow.expense, net: flow.net, currencies: [...settings.currencies] },
        settings,
        months
      };
    }
    buildMonth(year, monthIndex, key, settings, items) {
      const countries = {};
      settings.currencies.forEach(property => {
        countries[property] = this.buildCountry(year, monthIndex, key, property, settings, items.filter(item => item.property === property));
      });
      const flow = this.flow(items);
      return {
        _meta: { id: key, year, month: monthIndex + 1, entries: items.length, income: flow.income, expense: flow.expense, net: flow.net },
        countries
      };
    }
    buildCountry(year, monthIndex, key, property, settings, items) {
      const region = this.regions[property];
      const flow = this.flow(items);
      const sections = {};
      // Sections in display order: Income first, then everything else; each claims matching items once so none are shown twice.
      const claimed = new Set();
      [...settings.sections]
        .sort((a, b) => (a.type === 'income' ? 0 : 1) - (b.type === 'income' ? 0 : 1))
        .forEach(section => {
          const own = items.filter(item => item.type === section.type && !claimed.has(item) && (item.section === section.name || (!item.section && section.subsections.includes(item.category))));
          own.forEach(item => claimed.add(item));
          sections[section.name] = this.buildSection(section.name, section.type, section.subsections, own, key, property);
        });
      ['income', 'expense'].forEach(type => {
        const leftover = items.filter(item => item.type === type && !claimed.has(item));
        if (leftover.length) {
          const name = type === 'income' ? 'Other income' : 'Other expenses';
          sections[name] = this.buildSection(name, type, [], leftover, key, property);
        }
      });
      const budget = this.budgetFor(year, property);
      return {
        _meta: {
          id: property, name: region.name, code: region.code, symbol: SYMBOLS[region.code] || region.code, color: region.color, home: region.home, icon: region.icon,
          entries: items.length, income: flow.income, expense: flow.expense, net: flow.net,
          opening: this.openingFor(year, property), closing: this.closingBalance(year, property, monthIndex),
          budget, spentPercent: Math.min(100, flow.expense / budget * 100)
        },
        sections
      };
    }
    buildSection(name, type, subsections, items, monthKey, property) {
      const names = [...new Set([...subsections, ...items.map(item => item.category)])];
      const categories = {};
      names.forEach(category => {
        const parents = items.filter(item => item.category === category && !item.parentId);
        categories[category] = {
          _meta: { id: category, icon: iconFor(category, type), entries: parents.length, total: this.categoryTotal(category, type, monthKey, property) },
          entries: parents.map(parent => this.buildEntry(parent))
        };
      });
      return {
        _meta: { id: name, type, entries: items.filter(item => !item.parentId).length, total: this.sumType(items, type), subsections: [...subsections] },
        categories
      };
    }
    buildEntry(item) {
      const subEntries = this.transactions.filter(t => t.parentId === item.id);
      return {
        id: item.id, date: item.date, description: item.description, place: item.place || '', amount: Number(item.amount), notes: item.notes ?? null,
        section: item.section, category: item.category, type: item.type, property: item.property,
        _meta: { total: this.entryTotal(item.id), children: subEntries.length },
        subEntries: subEntries.map(sub => ({ id: sub.id, date: sub.date, description: sub.description, place: sub.place || '', amount: Number(sub.amount), notes: sub.notes ?? null }))
      };
    }
  }

  ExpenseStore.iconFor = iconFor;
  global.ExpenseStore = ExpenseStore;
})(typeof globalThis !== 'undefined' ? globalThis : window);
