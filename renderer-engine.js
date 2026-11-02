// LedgerRenderer: paints months.html from the ExpenseStore.
//   Level 1  year tabs and the year card's figures: straight from years/<year>/metadata
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
      this.ctx = ctx; // { fmt, compact, esc, dayLabel, keyOf, catKey, monthLabel, regions }
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

    currencyPanel(currency, year, monthIndex, state) {
      return B().CurrencyPanel(this.store.country(year, monthIndex, currency), { year, monthIndex }, state, this.ctx);
    }

    // The currencies whose panels an open month (or event) shows: those chosen from its summary, else all of them.
    shownCurrencies(mKey, currencies, state) {
      const chosen = state.monthCurrencies?.[mKey] || [];
      const shown = currencies.filter(currency => chosen.includes(currency)); // in the usual currency order
      return shown.length ? shown : currencies;
    }
    monthSummary(year, monthIndex, currencies, isFuture, options = {}) {
      const today = new Date();
      const daysAway = isFuture ? Math.ceil((new Date(year, monthIndex, 1) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000) : 0;
      const rows = currencies.map(currency => {
        const totals = this.store.monthTotals(year, monthIndex, currency);
        return { property: currency, income: totals.income, expense: totals.expenses, balance: totals.closing };
      });
      // An upcoming month with entries (planned income or expenses) shows its figures like any month, so the future can
      // be planned; one with nothing in it shows when it starts.
      const planned = rows.some(row => row.income || row.expense);
      return B().MonthSummary(rows, { isFuture: isFuture && !planned, daysAway, slots: this.store.currencyKeys(), ...options }, this.ctx);
    }

    monthBlock(year, monthIndex, state) {
      const today = new Date();
      const mKey = this.ctx.keyOf(year, monthIndex);
      const currencies = this.store.monthCurrencies(year, monthIndex);
      const open = state.expandedMonths.has(mKey);
      const isFuture = new Date(year, monthIndex, 1) > today;
      const shown = this.shownCurrencies(mKey, currencies, state);
      let panelsHtml = '';
      if (open) {
        panelsHtml = !currencies.length
          ? '<p class="ledger-none">No currency is active this month.</p>'
          : this.store.isLoaded(year, monthIndex)
            ? shown.map(currency => this.currencyPanel(currency, year, monthIndex, state)).join('')
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
        summaryHtml: this.monthSummary(year, monthIndex, currencies, isFuture, { mKey, shown: open ? shown : null }),
        panelsHtml,
        single: currencies.length <= 1,
        note: this.store.monthNote(year, monthIndex)
      });
    }

    // A special event drawn like a month: its name in place of the month's, a panel for each currency it is tagged with,
    // and its entries (dated anywhere) inside. Its key "ev:<id>" makes every gesture act on the event instead of a month.
    eventBlock(event, year, state) {
      const mKey = `ev:${event.id}`;
      const currencies = this.store.eventCurrencies(event.id);
      currencies.forEach(currency => this.store.ownEventSections(event.id, currency));
      const open = state.expandedMonths.has(mKey);
      const countries = currencies.map(currency => this.store.eventCountry(event.id, currency));
      const shown = this.shownCurrencies(mKey, currencies, state);
      const name = this.ctx.esc(event.name);
      return B().MonthBlock({
        mKey,
        label: `${name} (special event)`,
        name,
        open,
        isEvent: true,
        isEmpty: !this.store.eventItems(event.id).length,
        summaryHtml: B().MonthSummary(countries.map(country => ({ property: country._meta.id, income: country._meta.income, expense: country._meta.expense, balance: country._meta.closing })), { isFuture: false, mKey, shown: open ? shown : null, slots: this.store.currencyKeys() }, this.ctx),
        panelsHtml: open ? countries.filter(country => shown.includes(country._meta.id)).map(country => B().CurrencyPanel(country, { mKey }, state, this.ctx)).join('') : '',
        single: currencies.length <= 1
      });
    }

    // Months grouped by priority: this month, earlier months (newest first), then the ones still to come. (Special events
    // have their own page; see renderHub in kajanauday.js.)
    monthGroups(year, state) {
      // Months as one list with no group labels: the current month first, then earlier months (newest first), then
      // upcoming ones at the bottom (soonest first). Past, current and upcoming show in their colours (see the stylesheet).
      // The year card leads the list.
      return `<div class="month-group month-list">${this.yearCard(year, state)}${this.monthOrder(year).map(month => this.monthBlock(year, month, state)).join('')}</div>`;
    }

    // The whole year as one ledger, drawn like a month (see ExpenseStore.yearbook): its key "yr:<year>". Its figures are
    // the year's totals; once opened it loads every month of the year, then shows each currency's panel.
    yearCard(year, state) {
      const mKey = `yr:${year}`;
      const currencies = this.store.yearCurrencies(year);
      if (!currencies.length) return '';
      const open = state.expandedMonths.has(mKey);
      const shown = this.shownCurrencies(mKey, currencies, state);
      const rows = currencies.map(currency => {
        const totals = this.store.yearTotals(year, currency);
        return { property: currency, income: totals.income, expense: totals.expenses, balance: totals.closing };
      });
      const panelsHtml = !open ? '' : this.store.isYearLoaded(year)
        ? shown.map(currency => B().CurrencyPanel(this.store.yearbook(year, currency), { mKey }, state, this.ctx)).join('')
        : `<p class="ledger-none">Loading every month of ${year}…</p>`;
      return B().MonthBlock({
        mKey,
        label: `${year}, the whole year`,
        name: String(year),
        open,
        isYear: true,
        isEmpty: !this.store.year(year)?.metadata.entries,
        summaryHtml: B().MonthSummary(rows, { isFuture: false, mKey, shown: open ? shown : null, slots: this.store.currencyKeys() }, this.ctx),
        panelsHtml,
        single: shown.length <= 1
      });
    }

    yearTabs(activeYear, special = false) {
      return B().YearTabs(this.store.yearIds().map(Number).reverse(), activeYear, special);
    }

  }

  global.LedgerRenderer = LedgerRenderer;
})(typeof globalThis !== 'undefined' ? globalThis : window);
