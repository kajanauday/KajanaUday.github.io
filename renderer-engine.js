// LedgerRenderer: paints months.html from the ExpenseStore.
//   Level 1  year tabs, "N entries in YYYY" and the year summary cards: straight from years/<year>/metadata
//   Level 2  month rows from years/<year>/months, each showing only the currencies active that month; a closed row's
//            figures are that month's stored metadata
//   Level 3+ an opened month's panels (sections → categories → entries → sub-entries), built from its fetched entries
// Interaction state (open months, expanded entries, inline drafts) is owned by the app and passed in per render,
// so this file never touches storage or event wiring.
(function (global) {
  const B = () => global.LedgerBlueprints;

  class LedgerRenderer {
    constructor(store, ctx) {
      this.store = store;
      this.ctx = ctx; // { fmt, compact, signed, netClass, esc, dayLabel, keyOf, catKey, monthLabel, regions }
    }

    // Month indexes the year actually has in Firebase, in calendar order.
    months(year) {
      return Object.values(this.store.year(year)?.months || {}).map(month => month.month - 1).sort((a, b) => a - b);
    }

    // Priority order: this month, then finished months (newest first), then upcoming months (soonest first).
    monthOrder(year) {
      const today = new Date();
      const months = this.months(year);
      if (year !== today.getFullYear()) return months.reverse();
      const now = today.getMonth();
      return [...months.filter(month => month === now), ...months.filter(month => month < now).reverse(), ...months.filter(month => month > now)];
    }

    yearKpis(year) {
      return this.store.yearCurrencies(year).map(currency => {
        const totals = this.store.yearTotals(year, currency);
        const region = this.ctx.regions[currency];
        const breakdown = this.store.isYearLoaded(year) ? this.store.yearBreakdown(year, currency) : null;
        return B().YearKpiCard({ id: currency, name: region.name, code: region.code, color: region.color, income: totals.income, expense: totals.expenses, net: totals.balance, opening: totals.opening, closing: totals.closing, breakdown }, year, this.ctx);
      }).join('');
    }

    currencyPanel(currency, year, monthIndex, state) {
      return B().CurrencyPanel(this.store.country(year, monthIndex, currency), { year, monthIndex }, state, this.ctx);
    }

    monthSummary(year, monthIndex, currencies, isFuture) {
      const today = new Date();
      const daysAway = isFuture ? Math.ceil((new Date(year, monthIndex, 1) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000) : 0;
      const rows = currencies.map(currency => {
        const totals = this.store.monthTotals(year, monthIndex, currency);
        return { property: currency, income: totals.income, expense: totals.expenses, balance: totals.closing };
      });
      return B().MonthSummary(rows, { isFuture, daysAway }, this.ctx);
    }

    monthBlock(year, monthIndex, state) {
      const today = new Date();
      const mKey = this.ctx.keyOf(year, monthIndex);
      const currencies = this.store.monthCurrencies(year, monthIndex);
      const open = state.expandedMonths.has(mKey);
      const isFuture = new Date(year, monthIndex, 1) > today;
      let panelsHtml = '';
      if (open) {
        panelsHtml = !currencies.length
          ? '<p class="ledger-none">No currency is active this month.</p>'
          : this.store.isLoaded(year, monthIndex)
            ? currencies.map(currency => this.currencyPanel(currency, year, monthIndex, state)).join('')
            : '<p class="ledger-none">Loading entries…</p>';
      }
      return B().MonthBlock({
        mKey,
        label: this.ctx.monthLabel(new Date(year, monthIndex, 1)),
        name: ExpenseStore.MONTH_NAMES[monthIndex],
        open,
        isNow: year === today.getFullYear() && monthIndex === today.getMonth(),
        isFuture,
        isEmpty: !isFuture && !this.store.monthNode(year, monthIndex)?.metadata.entries,
        summaryHtml: open ? '' : this.monthSummary(year, monthIndex, currencies, isFuture),
        panelsHtml,
        single: currencies.length <= 1
      });
    }

    // A special event drawn like a month: its name in place of the month's, the year's currencies as panels, and its
    // entries (dated anywhere) inside. Its key "ev:<id>" makes every gesture act on the event instead of a month.
    eventBlock(event, year, state) {
      const mKey = `ev:${event.id}`;
      const currencies = this.store.yearCurrencies(year).length ? this.store.yearCurrencies(year) : this.store.currencyKeys().slice(0, 1);
      currencies.forEach(currency => this.store.ownEventSections(event.id, currency));
      const open = state.expandedMonths.has(mKey);
      const countries = currencies.map(currency => this.store.eventCountry(event.id, currency));
      const name = this.ctx.esc(event.name);
      return B().MonthBlock({
        mKey,
        label: `${name} (special event)`,
        name,
        open,
        isEvent: true,
        isEmpty: !this.store.eventItems(event.id).length,
        summaryHtml: open ? '' : B().MonthSummary(countries.map(country => ({ property: country._meta.id, income: country._meta.income, expense: country._meta.expense, balance: country._meta.closing })), { isFuture: false }, this.ctx),
        panelsHtml: open ? countries.map(country => B().CurrencyPanel(country, { mKey }, state, this.ctx)).join('') : '',
        single: currencies.length <= 1
      });
    }

    // The year's special events first, then months grouped by priority: this month, earlier months (newest first),
    // then the ones still to come.
    monthGroups(year, state) {
      const today = new Date();
      const order = this.monthOrder(year);
      const groups = year === today.getFullYear()
        ? [['This month', order.filter(month => month === today.getMonth())], [`Earlier in ${year}`, order.filter(month => month < today.getMonth())], ['Coming up', order.filter(month => month > today.getMonth())]]
        : [[`${year}, newest first`, order]];
      const events = this.store.eventsOfYear(year);
      const eventGroup = events.length ? B().MonthGroup('Special events', events.length, events.map(event => this.eventBlock(event, year, state)).join(''), 'events') : '';
      return eventGroup + groups.filter(([, months]) => months.length)
        .map(([title, months]) => B().MonthGroup(title, months.length, months.map(month => this.monthBlock(year, month, state)).join('')))
        .join('');
    }

    yearTabs(activeYear) {
      return B().YearTabs(this.store.yearIds().map(Number).reverse(), activeYear);
    }

  }

  global.LedgerRenderer = LedgerRenderer;
})(typeof globalThis !== 'undefined' ? globalThis : window);
