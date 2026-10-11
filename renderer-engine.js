// LedgerRenderer: walks the ExpenseStore tree top-down and paints months.html.
//   Level 1  year tabs + "N entries in YYYY" + year-to-date KPI cards (from year._meta, no re-summing)
//   Level 2  month rows; an open month renders one CurrencyPanel per active currency (full width when there is one)
//   Level 3+ inside each panel: Expenses/Income → categories → entries → sub-entries, all from cached _meta
// Interaction state (open months, expanded entries, inline drafts) is owned by the app and passed in per render,
// so this file never touches storage or event wiring.
(function (global) {
  const B = () => global.LedgerBlueprints;

  class LedgerRenderer {
    constructor(store, ctx) {
      this.store = store;
      this.ctx = ctx; // { fmt, compact, signed, netClass, esc, dayLabel, keyOf, catKey, monthLabel, regions, firstYear }
    }

    // Priority order: this month, then finished months (newest first), then upcoming months (soonest first).
    monthOrder(year) {
      const today = new Date();
      const months = Array.from({ length: 12 }, (_, month) => month);
      if (year !== today.getFullYear()) return months.reverse();
      const now = today.getMonth();
      return [now, ...months.filter(month => month < now).reverse(), ...months.filter(month => month > now)];
    }

    orderedCurrencies(currencies) {
      return Object.keys(this.ctx.regions).filter(property => currencies.includes(property));
    }

    yearKpis(year) {
      const node = this.store.year(year);
      return this.orderedCurrencies(node.settings.currencies).map(property => {
        const items = this.store.items(year, property);
        const flow = this.store.flow(items);
        const region = this.ctx.regions[property];
        return B().YearKpiCard({ id: property, name: region.name, code: region.code, ...flow, opening: this.store.openingFor(year, property) }, year, this.ctx);
      }).join('');
    }

    currencyPanel(property, year, monthIndex, state) {
      const country = this.store.country(year, monthIndex, property);
      return B().CurrencyPanel(country, { year, monthIndex }, state, this.ctx);
    }

    monthSummary(year, monthIndex, currencies, isFuture) {
      const today = new Date();
      const daysAway = isFuture ? Math.ceil((new Date(year, monthIndex, 1) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000) : 0;
      const rows = this.orderedCurrencies(currencies).map(property => {
        const flow = this.store.flow(this.store.items(year, property, monthIndex));
        return { property, income: flow.income, expense: flow.expense, balance: this.store.closingBalance(year, property, monthIndex) };
      });
      return B().MonthSummary(rows, { isFuture, daysAway }, this.ctx);
    }

    monthBlock(year, monthIndex, state) {
      const today = new Date();
      const mKey = this.ctx.keyOf(year, monthIndex);
      const currencies = this.store.settings(year).currencies;
      const open = state.expandedMonths.has(mKey);
      const isFuture = new Date(year, monthIndex, 1) > today;
      return B().MonthBlock({
        mKey,
        month: monthIndex,
        label: this.ctx.monthLabel(new Date(year, monthIndex, 1)),
        open,
        isNow: year === today.getFullYear() && monthIndex === today.getMonth(),
        isFuture,
        summaryHtml: open ? '' : this.monthSummary(year, monthIndex, currencies, isFuture),
        panelsHtml: open ? this.orderedCurrencies(currencies).map(property => this.currencyPanel(property, year, monthIndex, state)).join('') : '',
        single: currencies.length === 1
      });
    }

    // Months grouped by priority: this month, earlier months (newest first), then the ones still to come.
    monthGroups(year, state) {
      const today = new Date();
      const order = this.monthOrder(year);
      const groups = year === today.getFullYear()
        ? [['This month', order.slice(0, 1)], [`Earlier in ${year}`, order.filter(month => month < today.getMonth())], ['Coming up', order.filter(month => month > today.getMonth())]]
        : [[`${year}, newest first`, order]];
      return groups.filter(([, months]) => months.length)
        .map(([title, months]) => B().MonthGroup(title, months.length, months.map(month => this.monthBlock(year, month, state)).join('')))
        .join('');
    }

    yearTabs(activeYear) {
      const lastYear = new Date().getFullYear();
      const years = Array.from({ length: lastYear - this.ctx.firstYear + 1 }, (_, offset) => lastYear - offset);
      return B().YearTabs(years, activeYear);
    }

    yearEntryCount(year) {
      return this.store.settings(year).currencies.reduce((sum, property) => sum + this.store.items(year, property).length, 0);
    }
  }

  global.LedgerRenderer = LedgerRenderer;
})(typeof globalThis !== 'undefined' ? globalThis : window);
