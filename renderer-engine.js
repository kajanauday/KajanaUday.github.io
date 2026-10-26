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

    // `edit` is the year-summary row being renamed, if any.
    yearKpis(year, edit = null) {
      return this.store.yearCurrencies(year).map(currency => {
        const totals = this.store.yearTotals(year, currency);
        const region = this.ctx.regions[currency];
        const breakdown = this.store.isYearLoaded(year) ? this.store.yearBreakdown(year, currency) : null;
        return B().YearKpiCard({ id: currency, name: region.name, code: region.code, color: region.color, income: totals.income, expense: totals.expenses, net: totals.balance, opening: totals.opening, closing: totals.closing, breakdown }, year, this.ctx, edit);
      }).join('');
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

    // The year's special events first, then months grouped by priority: this month, earlier months (newest first),
    // then the ones still to come.
    monthGroups(year, state) {
      // The Special tab: every special event, grouped by the year it belongs to, newest year first. A year's own view
      // shows its months only.
      if (state.special) {
        const events = this.store.eventList();
        if (!events.length) return '<p class="ledger-none">No special events yet. Add one in Year settings.</p>';
        const years = [...new Set(events.map(event => event.year))].sort((a, b) => b - a);
        return years.map(eventYear => {
          const ofYear = events.filter(event => event.year === eventYear);
          return B().MonthGroup(String(eventYear), ofYear.length, ofYear.map(event => this.eventBlock(event, eventYear, state)).join(''), 'events');
        }).join('');
      }
      // Months as one list with no group labels: the current month first, then earlier months (newest first), then
      // upcoming ones at the bottom (soonest first). Past, current and upcoming show in their colours (see the stylesheet).
      return `<div class="month-group month-list">${this.monthOrder(year).map(month => this.monthBlock(year, month, state)).join('')}</div>`;
    }

    yearTabs(activeYear, special = false) {
      return B().YearTabs(this.store.yearIds().map(Number).reverse(), activeYear, special);
    }

  }

  global.LedgerRenderer = LedgerRenderer;
})(typeof globalThis !== 'undefined' ? globalThis : window);
