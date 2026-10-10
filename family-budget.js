const STORAGE_KEY = 'family-budget-static-demo-v1';
    const regions = {
      india: { name: 'India', home: 'Pune home', code: 'INR', color: 'india', opening: 1973800, budget: 5500000, icon: 'ti-home-2' },
      japan: { name: 'Japan', home: 'Tokyo home', code: 'JPY', color: 'japan', opening: 1973800, budget: 9800000, icon: 'ti-building-community' }
    };
    const starterTransactions = [
      { id: 'in-1', property: 'india', date: '2026-10-09', category: 'Travel', description: 'Airport transfer', amount: 80000, type: 'expense' },
      { id: 'in-2', property: 'india', date: '2026-10-08', category: 'Salary', description: 'Monthly salary', amount: 12500000, type: 'income' },
      { id: 'in-3', property: 'india', date: '2026-10-07', category: 'Food', description: 'Dinner with family', amount: 370000, type: 'expense' },
      { id: 'in-4', property: 'india', date: '2026-10-05', category: 'Utilities', description: 'Electricity & internet', amount: 432000, type: 'expense' },
      { id: 'in-5', property: 'india', date: '2026-10-04', category: 'Housing', description: 'Apartment maintenance', amount: 2200000, type: 'expense' },
      { id: 'in-6', property: 'india', date: '2026-10-02', category: 'Freelance', description: 'Project payment', amount: 800000, type: 'income' },
      { id: 'in-7', property: 'india', date: '2026-10-01', category: 'Shopping', description: 'Household essentials', amount: 1000000, type: 'expense' },
      { id: 'jp-1', property: 'japan', date: '2026-10-09', category: 'Dining', description: 'Dinner in Shibuya', amount: 1250000, type: 'expense' },
      { id: 'jp-2', property: 'japan', date: '2026-10-08', category: 'Rent', description: 'Monthly rent', amount: 4500000, type: 'expense' },
      { id: 'jp-3', property: 'japan', date: '2026-10-07', category: 'Salary', description: 'Monthly salary', amount: 15000000, type: 'income' },
      { id: 'jp-4', property: 'japan', date: '2026-10-05', category: 'Transport', description: 'Suica & rail pass', amount: 750000, type: 'expense' },
      { id: 'jp-5', property: 'japan', date: '2026-10-03', category: 'Groceries', description: 'Weekend groceries', amount: 1000000, type: 'expense' },
      { id: 'jp-6', property: 'japan', date: '2026-10-01', category: 'Rental income', description: 'Property income', amount: 15000000, type: 'income' }
    ];
    let transactions = loadTransactions();
    const YEAR_SETTINGS_KEY = `${STORAGE_KEY}-year-settings`;
    const yearSettingsByYear = loadYearSettings();
    const FIRST_YEAR = 2025;
    let currentMonth = (() => {
      const today = new Date();
      const savedMonth = sessionStorage.getItem(`${STORAGE_KEY}-month`);
      if (!savedMonth || !/^\d{4}-\d{2}$/.test(savedMonth)) return new Date(today.getFullYear(), today.getMonth(), 1);
      const [year, month] = savedMonth.split('-').map(Number);
      if (year < FIRST_YEAR || year > today.getFullYear()) return new Date(today.getFullYear(), today.getMonth(), 1);
      return new Date(year, month - 1, 1);
    })();
    let toastTimer;

    function loadTransactions() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        return Array.isArray(saved) ? saved : starterTransactions.map(item => ({ ...item }));
      } catch (error) {
        return starterTransactions.map(item => ({ ...item }));
      }
    }
    function defaultYearSettings(year) {
      const yearItems = transactions.filter(item => item.date.startsWith(`${year}-`));
      const expenseSubsections = yearItems.filter(item => item.type === 'expense').map(item => item.category);
      const incomeSubsections = yearItems.filter(item => item.type === 'income').map(item => item.category);
      return {
        currencies: year === 2025 ? ['india'] : Object.keys(regions),
        sections: [
          { name: 'Expenses', type: 'expense', subsections: [...new Set(expenseSubsections.length ? expenseSubsections : ['Housing', 'Food', 'Utilities', 'Transport', 'Shopping'])] },
          { name: 'Income', type: 'income', subsections: [...new Set(incomeSubsections.length ? incomeSubsections : ['Salary', 'Freelance', 'Other'])] }
        ]
      };
    }
    function loadYearSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem(YEAR_SETTINGS_KEY) || '{}');
        return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
      } catch (error) {
        console.error('Could not load year settings.', error);
        return {};
      }
    }
    function yearSettings(year) {
      const key = String(year);
      yearSettingsByYear[key] ||= defaultYearSettings(year);
      return yearSettingsByYear[key];
    }
    function saveYearSettings() {
      localStorage.setItem(YEAR_SETTINGS_KEY, JSON.stringify(yearSettingsByYear));
    }
    // Per-year amounts (minor units). Settings saved before these keys existed fall back to the region defaults.
    function openingFor(year, property) {
      const saved = yearSettings(year).openings?.[property];
      return Number.isFinite(saved) ? saved : year === 2026 ? regions[property].opening : 0;
    }
    function budgetFor(year, property) {
      const saved = yearSettings(year).budgets?.[property];
      return Number.isFinite(saved) ? saved : regions[property].budget;
    }
    function saveTransactions() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
        const saveState = document.querySelector('.save-state');
        if (saveState) saveState.innerHTML = '<span class="save-dot"></span> All changes saved';
      } catch (error) {
        const saveState = document.querySelector('.save-state');
        if (saveState) saveState.textContent = 'Could not save locally';
      }
    }
    function monthKey(date = currentMonth) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }
    function monthTransactions(property = null) {
      const key = monthKey();
      return transactions.filter(item => item.date.startsWith(key) && (!property || item.property === property));
    }
    function formatMoney(minor, property) {
      const value = Number(minor || 0) / 100;
      const formatted = new Intl.NumberFormat(property === 'japan' ? 'en-US' : 'en-IN', { maximumFractionDigits: 0 }).format(Math.abs(value));
      return `${value < 0 ? '-' : ''}${formatted}`;
    }
    // Short form for dense cells: 1.33L / 40.8K for INR, 300K / 1.2M for JPY. Full value stays in titles and the ledger.
    // Suffixes are fixed here because browsers disagree on Intl compact labels for en-IN (some print "T" for thousand).
    function compactMoney(minor, property) {
      const value = Math.abs(Number(minor || 0) / 100);
      const steps = property === 'japan' ? [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] : [[1e7, 'Cr'], [1e5, 'L'], [1e3, 'K']];
      const [size, suffix] = steps.find(([limit]) => value >= limit) || [1, ''];
      const digits = suffix === 'L' || suffix === 'Cr' ? 2 : suffix ? 1 : 0;
      return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value / size)}${suffix}`;
    }
    function signedMoney(minor, property, format = formatMoney) {
      return `${minor > 0 ? '+' : minor < 0 ? '−' : ''}${format(Math.abs(minor), property)}`;
    }
    function totalFor(items, type) {
      return items.filter(item => item.type === type).reduce((sum, item) => sum + Number(item.amount), 0);
    }
    function monthLabel(date = currentMonth) {
      return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    }
    function dayLabel(date) {
      return new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
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
    function propertyStats(property) {
      const items = monthTransactions(property);
      const income = totalFor(items, 'income');
      const expense = totalFor(items, 'expense');
      return { items, income, expense, balance: regions[property].opening + income - expense };
    }
    function balanceSpark() {
      return '<svg class="balance-spark" viewBox="0 0 78 34" fill="none" aria-hidden="true"><path d="M2 27 14 22 25 24 36 14 47 18 58 8 76 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 33H76" stroke="currentColor" stroke-opacity=".15"/></svg>';
    }
    function renderRecent(property) {
      const items = propertyStats(property).items.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, 5);
      if (!items.length) return '<p class="transaction-meta">No activity this month yet.</p>';
      return items.map(item => `<div class="transaction-row"><span class="transaction-icon"><i class="ti ${iconFor(item.category, item.type)}" aria-hidden="true"></i></span><div class="transaction-copy"><p class="transaction-title">${escapeHtml(item.description)}</p><span class="transaction-meta">${item.section ? `${escapeHtml(item.section)} · ` : ''}${escapeHtml(item.category)} · ${dayLabel(item.date)}</span></div><span class="transaction-amount ${item.type}">${item.type === 'expense' ? '−' : '+'}${formatMoney(item.amount, property)}</span></div>`).join('');
    }
    function renderProperty(property) {
      const target = document.querySelector(`#property-${property}`);
      if (!target) return;
      const region = regions[property];
      const stats = propertyStats(property);
      const spentPercent = Math.min(100, stats.expense / region.budget * 100);
      const content = `<div class="property-inner"><header class="property-header"><div class="property-identity"><span class="property-badge"><i class="ti ${region.icon}" aria-hidden="true"></i></span><div><h2 class="property-title">${region.name.toUpperCase()}</h2><span class="property-meta">${region.home}</span></div></div><span class="currency-chip"><span>${region.code}</span></span></header><div class="property-stats"><div class="stat-box"><span class="stat-label">Income</span><strong class="stat-value income">${formatMoney(stats.income, property)}</strong></div><div class="stat-box"><span class="stat-label">Expenses</span><strong class="stat-value expense">${formatMoney(stats.expense, property)}</strong></div></div><div class="balance-box"><div><span class="balance-label">Current balance</span><strong class="balance-value">${formatMoney(stats.balance, property)}</strong><span class="balance-change"><i class="ti ti-trending-up" aria-hidden="true"></i> ${stats.income ? 'On pace this month' : 'Opening balance'}</span></div>${balanceSpark()}</div><section aria-label="Monthly budget"><div class="card-section-head"><h3>Monthly spend</h3><button type="button" class="subtle-action" data-page-link="budgets">Budget details <i class="ti ti-arrow-up-right" aria-hidden="true"></i></button></div><div class="budget-line"><span>${formatMoney(stats.expense, property)} spent</span><strong>${Math.round(spentPercent)}% of ${formatMoney(region.budget, property)}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${spentPercent}%"></div></div></section><section aria-label="Recent transactions"><div class="card-section-head"><h3>Recent activity</h3><button type="button" class="subtle-action" data-page-link="transactions">See all <i class="ti ti-arrow-right" aria-hidden="true"></i></button></div><div class="transaction-list">${renderRecent(property)}</div></section></div>`;
      target.innerHTML = content;
    }
    function renderTransactions() {
      const searchInput = document.querySelector('#transaction-search');
      const propertyFilter = document.querySelector('#property-filter');
      const rows = document.querySelector('#activity-rows');
      if (!searchInput || !propertyFilter || !rows) return;
      const search = searchInput.value.trim().toLowerCase();
      const property = propertyFilter.value;
      const items = monthTransactions().filter(item => (property === 'all' || item.property === property) && `${item.description} ${item.section || ''} ${item.category} ${regions[item.property].name}`.toLowerCase().includes(search)).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
      document.querySelector('#transaction-count').textContent = `${items.length} ${items.length === 1 ? 'entry' : 'entries'}`;
      rows.innerHTML = items.length ? items.map(item => `<tr><td>${dayLabel(item.date)}</td><td><strong>${escapeHtml(item.description)}</strong></td><td><span class="property-pill"><i class="ti ${regions[item.property].icon}" aria-hidden="true"></i>${regions[item.property].name}</span></td><td>${item.section ? `${escapeHtml(item.section)} · ` : ''}${escapeHtml(item.category)}</td><td class="amount-cell ${item.type}">${item.type === 'expense' ? '−' : '+'}${formatMoney(item.amount, item.property)}</td></tr>`).join('') : '<tr><td colspan="5" style="padding:24px 12px;color:#777e75">No transactions match this month and filter.</td></tr>';
    }
    function categoryTotals(property) {
      const totals = new Map();
      monthTransactions(property).filter(item => item.type === 'expense').forEach(item => totals.set(item.category, (totals.get(item.category) || 0) + item.amount));
      return [...totals.entries()].sort((a, b) => b[1] - a[1]);
    }
    // ---- Monthly ledger (months.html) ----
    const SYMBOLS = { india: '₹', japan: '¥' };
    function flowStats(items) {
      const income = totalFor(items, 'income');
      const expense = totalFor(items, 'expense');
      return { income, expense, net: income - expense, count: items.length };
    }
    function netClass(minor) {
      return minor > 0 ? 'income' : minor < 0 ? 'expense' : '';
    }
    function ledgerItems(year, property, month = null) {
      const prefix = month === null ? `${year}-` : `${year}-${String(month + 1).padStart(2, '0')}`;
      return transactions.filter(item => item.property === property && item.date.startsWith(prefix));
    }
    // Groups a month's entries into the year's configured sections; anything unmatched lands in an "Other" bucket so nothing is hidden.
    function groupIntoSections(items, settings) {
      const claimed = new Set();
      const groups = [...settings.sections]
        .sort((a, b) => (a.type === 'income' ? 0 : 1) - (b.type === 'income' ? 0 : 1))
        .map(section => {
          const sectionItems = items.filter(item => item.type === section.type && !claimed.has(item) && (item.section === section.name || (!item.section && section.subsections.includes(item.category))));
          sectionItems.forEach(item => claimed.add(item));
          return { ...section, items: sectionItems };
        });
      ['income', 'expense'].forEach(type => {
        const leftover = items.filter(item => item.type === type && !claimed.has(item));
        if (leftover.length) groups.push({ name: type === 'income' ? 'Other income' : 'Other expenses', type, subsections: [], items: leftover });
      });
      return groups;
    }
    function renderLedgerSection(section, property) {
      const total = totalFor(section.items, section.type);
      const names = [...new Set([...section.subsections, ...section.items.map(item => item.category)])];
      const categories = names
        .map(name => ({ name, items: section.items.filter(item => item.category === name) }))
        .map(category => ({ ...category, amount: totalFor(category.items, section.type) }));
      const filled = categories.filter(category => category.items.length).sort((a, b) => b.amount - a.amount);
      const empty = categories.filter(category => !category.items.length).map(category => escapeHtml(category.name));
      const rows = filled.map(category => {
        const share = total ? Math.max(2, category.amount / total * 100) : 0;
        const entries = [...category.items]
          .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
          .map(item => `<div class="ledger-entry" title="${escapeHtml(item.description)}${item.place ? ` · ${escapeHtml(item.place)}` : ''}"><time datetime="${item.date}">${dayLabel(item.date)}</time><span class="ledger-entry-desc">${escapeHtml(item.description)}</span><span class="ledger-entry-place">${escapeHtml(item.place || '')}</span><strong class="${section.type}">${formatMoney(item.amount, property)}</strong></div>`).join('');
        return `<details class="ledger-cat"><summary><i class="ti ti-chevron-right" aria-hidden="true"></i><span class="ledger-cat-name">${escapeHtml(category.name)}</span><span class="ledger-cat-bar" aria-hidden="true"><i class="${section.type}" style="width:${share}%"></i></span><span class="ledger-cat-count" title="${category.items.length} ${category.items.length === 1 ? 'entry' : 'entries'}">${category.items.length}</span><strong>${formatMoney(category.amount, property)}</strong></summary><div class="ledger-entries">${entries}</div></details>`;
      }).join('');
      return `<section class="ledger-sec ${section.type}"><header class="ledger-sec-head"><h4>${escapeHtml(section.name)}</h4><span>${section.items.length}</span><strong class="${section.type}">${formatMoney(total, property)}</strong></header>${rows || '<p class="ledger-none">Nothing recorded</p>'}${empty.length ? `<p class="ledger-none" title="Configured but no entries this month">No entries · ${empty.join(', ')}</p>` : ''}</section>`;
    }
    function renderLedgerPanel(property, year, month, settings) {
      const region = regions[property];
      const items = ledgerItems(year, property, month);
      const stats = flowStats(items);
      const spent = region.budget ? stats.expense / region.budget * 100 : 0;
      const sections = groupIntoSections(items, settings).map(section => renderLedgerSection(section, property)).join('');
      return `<section class="ledger-panel ${property}" aria-label="${region.name}">
        <header class="ledger-panel-head">
          <h3><span class="property-dot ${property}" aria-hidden="true"></span>${region.name}<small>${region.code}</small></h3>
          <dl class="ledger-totals"><div><dt>In</dt><dd class="income">${formatMoney(stats.income, property)}</dd></div><div><dt>Out</dt><dd class="expense">${formatMoney(stats.expense, property)}</dd></div><div><dt>Net</dt><dd class="${netClass(stats.net)}">${signedMoney(stats.net, property)}</dd></div></dl>
        </header>
        <div class="ledger-budget${spent > 100 ? ' is-over' : ''}" title="Monthly budget ${formatMoney(region.budget, property)}"><span>Budget</span><div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, spent)}%"></div></div><span class="ledger-budget-value">${Math.round(spent)}% of ${compactMoney(region.budget, property)}</span></div>
        <div class="ledger-sections">${sections}</div>
      </section>`;
    }
    function renderYearKpis(year, settings) {
      return settings.currencies.map(property => {
        const region = regions[property];
        const stats = flowStats(ledgerItems(year, property));
        const opening = year === 2026 ? region.opening : 0;
        const rate = stats.income ? Math.round(stats.net / stats.income * 100) : null;
        const nets = Array.from({ length: 12 }, (_, month) => flowStats(ledgerItems(year, property, month)).net);
        const peak = Math.max(1, ...nets.map(Math.abs));
        const bars = nets.map((net, month) => {
          const label = new Date(year, month, 1).toLocaleDateString('en', { month: 'short' });
          return `<span class="kpi-bar ${netClass(net)}" title="${label}: ${signedMoney(net, property)}" style="--h:${Math.abs(net) / peak * 100}%"></span>`;
        }).join('');
        return `<article class="kpi-card ${property}">
          <header class="kpi-head"><span class="property-dot ${property}" aria-hidden="true"></span><strong>${region.name}</strong><span>${region.code} · ${year} to date</span></header>
          <dl class="kpi-values">
            <div><dt>Income</dt><dd class="income">${formatMoney(stats.income, property)}</dd></div>
            <div><dt>Expenses</dt><dd class="expense">${formatMoney(stats.expense, property)}</dd></div>
            <div><dt>Net</dt><dd class="${netClass(stats.net)}">${signedMoney(stats.net, property)}</dd></div>
            <div><dt>Saved</dt><dd>${rate === null ? '—' : `${rate}%`}</dd></div>
            <div><dt>Balance</dt><dd>${formatMoney(opening + stats.net, property)}</dd></div>
          </dl>
          <div class="kpi-spark" role="img" aria-label="Monthly net for ${year}">${bars}</div>
        </article>`;
      }).join('');
    }
    function renderMonthRail(year, selected, settings) {
      const today = new Date();
      return Array.from({ length: 12 }, (_, month) => {
        const date = new Date(year, month, 1);
        const name = date.toLocaleDateString('en', { month: 'short' });
        const isNow = year === today.getFullYear() && month === today.getMonth();
        const isFuture = date > today;
        const rows = settings.currencies.map(property => ({ property, stats: flowStats(ledgerItems(year, property, month)) }));
        const hasData = rows.some(row => row.stats.count);
        const label = rows.filter(row => row.stats.count).map(({ property, stats }) => `${regions[property].code} income ${formatMoney(stats.income, property)}, expenses ${formatMoney(stats.expense, property)}`).join('; ');
        const body = hasData
          ? rows.map(({ property, stats }) => stats.count
            ? `<span class="mcell-cur ${property}"><span class="mcell-net ${netClass(stats.net)}"><i>${SYMBOLS[property]}</i>${signedMoney(stats.net, property, compactMoney)}</span><span class="mcell-flow"><span class="income" title="Income ${formatMoney(stats.income, property)}">${compactMoney(stats.income, property)}</span><span class="expense" title="Expenses ${formatMoney(stats.expense, property)}">${compactMoney(stats.expense, property)}</span></span></span>`
            : `<span class="mcell-cur ${property} is-empty"><span class="mcell-net"><i>${SYMBOLS[property]}</i>—</span></span>`).join('')
          : isFuture ? '' : '<span class="mcell-idle">—</span>';
        return `<button type="button" class="mcell${month === selected ? ' is-selected' : ''}${hasData ? '' : ' is-empty'}${isFuture ? ' is-future' : ''}" data-ledger-month="${month}" aria-pressed="${month === selected}" aria-label="${name} ${year}${label ? `: ${label}` : ', no entries'}"${isNow ? ' aria-current="date"' : ''}><span class="mcell-name">${name}${isNow ? '<i class="mcell-now" title="This month"></i>' : ''}</span>${body}</button>`;
      }).join('');
    }
    function renderLedger() {
      const ledger = document.querySelector('#ledger');
      if (!ledger) return;
      const year = currentMonth.getFullYear();
      const month = currentMonth.getMonth();
      const lastYear = new Date().getFullYear();
      const settings = yearSettings(year);
      const monthCount = settings.currencies.reduce((sum, property) => sum + ledgerItems(year, property, month).length, 0);
      document.querySelector('#year-tabs').innerHTML = Array.from({ length: lastYear - FIRST_YEAR + 1 }, (_, offset) => lastYear - offset)
        .map(value => `<button type="button" class="year-tab" data-ledger-year="${value}" aria-pressed="${value === year}">${value}</button>`).join('');
      document.querySelector('#year-kpis').innerHTML = renderYearKpis(year, settings);
      document.querySelector('#month-rail').innerHTML = renderMonthRail(year, month, settings);
      document.querySelector('#month-rail').setAttribute('aria-label', `Months of ${year}`);
      document.querySelector('#month-ledger').innerHTML = `
        <header class="month-ledger-head">
          <div class="month-step"><button type="button" class="month-arrow" data-ledger-step="-1" aria-label="Previous month"${year === FIRST_YEAR && month === 0 ? ' disabled' : ''}><i class="ti ti-chevron-left" aria-hidden="true"></i></button><h2>${monthLabel()}</h2><button type="button" class="month-arrow" data-ledger-step="1" aria-label="Next month"${year === lastYear && month === 11 ? ' disabled' : ''}><i class="ti ti-chevron-right" aria-hidden="true"></i></button></div>
          <span class="month-ledger-meta">${monthCount} ${monthCount === 1 ? 'entry' : 'entries'}</span>
          <button type="button" class="quiet-button month-ledger-toggle" data-ledger-expand>Expand all</button>
        </header>
        <div class="ledger-panels${settings.currencies.length === 1 ? ' is-single' : ''}">${settings.currencies.map(property => renderLedgerPanel(property, year, month, settings)).join('')}</div>`;
      document.querySelector('#year-settings-button').dataset.year = year;
    }
    function selectLedgerMonth(year, month) {
      currentMonth = new Date(year, month, 1);
      sessionStorage.setItem(`${STORAGE_KEY}-month`, monthKey());
      renderLedger();
    }
    function setupLedger() {
      const ledger = document.querySelector('#ledger');
      if (!ledger) return;
      const lastYear = new Date().getFullYear();
      const step = delta => {
        const next = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + delta, 1);
        if (next.getFullYear() >= FIRST_YEAR && next.getFullYear() <= lastYear) selectLedgerMonth(next.getFullYear(), next.getMonth());
      };
      document.querySelector('#year-tabs').addEventListener('click', event => {
        const tab = event.target.closest('[data-ledger-year]');
        if (!tab) return;
        const year = Number(tab.dataset.ledgerYear);
        const today = new Date();
        // Jump to the current month in the current year, otherwise the latest month that has entries.
        const latest = year === today.getFullYear() ? today.getMonth() : Math.max(0, ...transactions.filter(item => item.date.startsWith(`${year}-`)).map(item => Number(item.date.slice(5, 7)) - 1));
        selectLedgerMonth(year, latest);
      });
      ledger.addEventListener('click', event => {
        const monthButton = event.target.closest('[data-ledger-month]');
        if (monthButton) return selectLedgerMonth(currentMonth.getFullYear(), Number(monthButton.dataset.ledgerMonth));
        const stepButton = event.target.closest('[data-ledger-step]');
        if (stepButton) return step(Number(stepButton.dataset.ledgerStep));
        const expandButton = event.target.closest('[data-ledger-expand]');
        if (expandButton) {
          const cats = [...ledger.querySelectorAll('.ledger-cat')];
          const open = cats.some(cat => !cat.open);
          cats.forEach(cat => { cat.open = open; });
          expandButton.textContent = open ? 'Collapse all' : 'Expand all';
        }
      });
      document.querySelector('#year-settings-button').addEventListener('click', event => openYearSettings(Number(event.currentTarget.dataset.year)));
      document.addEventListener('keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey || document.querySelector('dialog[open]')) return;
        if (event.target.closest('input, select, textarea, [contenteditable]')) return;
        if (event.key === 'ArrowLeft') step(-1);
        if (event.key === 'ArrowRight') step(1);
      });
    }
    function renderBudgets() {
      const panels = document.querySelector('#budget-panels');
      if (!panels) return;
      panels.innerHTML = Object.keys(regions).map(property => {
        const region = regions[property];
        const stats = propertyStats(property);
        const categories = categoryTotals(property);
        const remainder = Math.max(0, region.budget - stats.expense);
        return `<section class="surface-panel"><div class="panel-title-row"><h2><span class="property-dot ${property}" style="display:inline-block;margin-right:7px"></span>${region.name} · ${region.code}</h2><span>${monthLabel()}</span></div><div class="category-budget">${categories.map(([name, amount]) => { const percent = Math.min(100, amount / region.budget * 100); return `<div class="category-budget-row"><div class="category-budget-top"><strong>${escapeHtml(name)}</strong><span>${formatMoney(amount, property)} · ${Math.round(percent)}%</span></div><div class="progress-track"><div class="progress-fill" style="width:${percent}%;${property === 'japan' ? 'background:var(--japan)' : ''}"></div></div></div>`; }).join('') || '<p class="transaction-meta">No expenses recorded for this month.</p>'}</div><div class="budget-foot"><span>Monthly limit</span><strong>${formatMoney(region.budget, property)}</strong></div><div class="budget-foot"><span>Remaining</span><strong>${formatMoney(remainder, property)}</strong></div></section>`;
      }).join('');
    }
    function renderInsights() {
      const panels = document.querySelector('#insight-panels');
      if (!panels) return;
      panels.innerHTML = Object.keys(regions).map(property => {
        const region = regions[property];
        const stats = propertyStats(property);
        const topCategory = categoryTotals(property)[0];
        const rate = stats.income ? Math.round((stats.income - stats.expense) / stats.income * 100) : 0;
        return `<section class="surface-panel"><div class="panel-title-row"><h2>${region.name} household</h2><span>${region.code}</span></div><div class="insight-stat"><span>Income this month</span><strong style="color:var(--income)">${formatMoney(stats.income, property)}</strong><small>Recorded in ${monthLabel()}</small></div><div class="insight-stat"><span>Expenses this month</span><strong style="color:var(--expense)">${formatMoney(stats.expense, property)}</strong><small>${stats.income ? `${rate}% of income retained` : 'No income recorded yet'}</small></div><div class="insight-stat"><span>Largest category</span><strong>${topCategory ? escapeHtml(topCategory[0]) : 'No activity'}</strong><small>${topCategory ? formatMoney(topCategory[1], property) : 'Add activity to see patterns'}</small></div></section>`;
      }).join('');
    }
    function render() {
      document.querySelectorAll('.month-label').forEach(el => { el.textContent = monthLabel(); });
      document.querySelectorAll('.month-label-copy').forEach(el => el.textContent = monthLabel());
      renderProperty('india');
      renderProperty('japan');
      renderTransactions();
      renderBudgets();
      renderInsights();
      renderLedger();
    }
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    }
    function showToast(message) {
      const toast = document.querySelector('#toast');
      toast.textContent = message;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 2500);
    }
    function addYearSectionEditor(section = { name: '', type: 'expense', subsections: [] }) {
      const template = document.querySelector('#year-section-template');
      const list = document.querySelector('#year-section-list');
      if (!template || !list) return;
      const editor = template.content.firstElementChild.cloneNode(true);
      editor.querySelector('.year-section-name').value = section.name;
      editor.querySelector('.year-section-type').value = section.type;
      editor.querySelector('.year-section-subsections').value = section.subsections.join(', ');
      list.append(editor);
    }
    function openYearSettings(year) {
      const dialog = document.querySelector('#year-settings-dialog');
      const form = document.querySelector('#year-settings-form');
      if (!dialog || !form) return;
      const settings = yearSettings(year);
      document.querySelector('#year-settings-title').textContent = `${year} settings`;
      form.querySelectorAll('input[name="currency"]').forEach(input => { input.checked = settings.currencies.includes(input.value); });
      const list = document.querySelector('#year-section-list');
      list.replaceChildren();
      settings.sections.forEach(section => addYearSectionEditor(section));
      document.querySelector('#year-settings-error').hidden = true;
      dialog.showModal();
    }
    function setupTransactionTaxonomy() {
      const form = document.querySelector('#transaction-form');
      const dateInput = document.querySelector('#entry-date');
      const propertySelect = document.querySelector('#entry-property');
      const typeSelect = document.querySelector('#entry-type');
      const categoryLabel = document.querySelector('label[for="entry-category"]');
      const categoryInput = document.querySelector('#entry-category');
      if (!form || !dateInput || !propertySelect || !typeSelect || !categoryLabel || !categoryInput) return;

      const sectionLabel = document.createElement('label');
      sectionLabel.className = 'field';
      sectionLabel.htmlFor = 'entry-section';
      sectionLabel.innerHTML = 'Section<select id="entry-section" name="section" required></select>';
      categoryInput.replaceWith(Object.assign(document.createElement('select'), { id: 'entry-category', name: 'category', required: true }));
      sectionLabel.querySelector('select').className = 'taxonomy-select';
      categoryLabel.parentNode.insertBefore(sectionLabel, categoryLabel);

      const sectionSelect = sectionLabel.querySelector('select');
      const subsectionSelect = document.querySelector('#entry-category');
      const refreshOptions = () => {
        const year = Number((dateInput.value || `${new Date().getFullYear()}-01-01`).slice(0, 4));
        const config = yearSettings(year);
        const previousProperty = propertySelect.value;
        propertySelect.replaceChildren(...config.currencies.map(property => new Option(`${regions[property].name} · ${regions[property].code}`, property)));
        if (config.currencies.includes(previousProperty)) propertySelect.value = previousProperty;
        const previousSection = sectionSelect.value;
        const matchingSections = config.sections.filter(section => section.type === typeSelect.value);
        sectionSelect.replaceChildren(...matchingSections.map(section => new Option(section.name, section.name)));
        if (matchingSections.some(section => section.name === previousSection)) sectionSelect.value = previousSection;
        const section = matchingSections.find(item => item.name === sectionSelect.value) || matchingSections[0];
        subsectionSelect.replaceChildren(...(section?.subsections || []).map(name => new Option(name, name)));
        sectionSelect.disabled = matchingSections.length === 0;
        subsectionSelect.disabled = !section?.subsections.length;
      };
      dateInput.addEventListener('change', refreshOptions);
      propertySelect.addEventListener('change', refreshOptions);
      typeSelect.addEventListener('change', refreshOptions);
      sectionSelect.addEventListener('change', refreshOptions);
      refreshOptions();
    }
    document.querySelector('#add-year-section')?.addEventListener('click', () => addYearSectionEditor());
    document.querySelector('#year-section-list')?.addEventListener('click', event => {
      const removeButton = event.target.closest('.remove-year-section');
      if (removeButton) removeButton.closest('.year-section-editor').remove();
    });
    document.querySelector('#year-settings-form')?.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget;
      const dialog = form.closest('dialog');
      const year = Number(document.querySelector('#year-settings-title').textContent.split(' ')[0]);
      const currencies = [...form.querySelectorAll('input[name="currency"]:checked')].map(input => input.value);
      const sections = [...form.querySelectorAll('.year-section-editor')].map(editor => ({
        name: editor.querySelector('.year-section-name').value.trim(),
        type: editor.querySelector('.year-section-type').value,
        subsections: [...new Set(editor.querySelector('.year-section-subsections').value.split(',').map(name => name.trim()).filter(Boolean))]
      }));
      const names = sections.map(section => section.name.toLocaleLowerCase());
      const error = document.querySelector('#year-settings-error');
      if (!currencies.length) error.textContent = 'Select at least one currency for this year.';
      else if (!sections.length) error.textContent = 'Add at least one section for this year.';
      else if (sections.some(section => !section.name || !section.subsections.length)) error.textContent = 'Each section needs a name and at least one subsection.';
      else if (new Set(names).size !== names.length) error.textContent = 'Section names must be unique.';
      else if (sections.some(section => new Set(section.subsections.map(name => name.toLocaleLowerCase())).size !== section.subsections.length)) error.textContent = 'Subsection names must be unique within each section.';
      else {
        yearSettingsByYear[String(year)] = { currencies, sections };
        try {
          saveYearSettings();
          dialog.close();
          window.location.reload();
        } catch (saveError) {
          console.error('Could not save year settings.', saveError);
          error.textContent = 'Could not save these settings in this browser.';
        }
        return;
      }
      error.hidden = false;
    });
    setupTransactionTaxonomy();
    const loginForm = document.querySelector('#login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', event => {
        event.preventDefault();
        const passkey = new FormData(loginForm).get('passkey');
        if (passkey !== 'kajanauday') {
          const loginError = document.querySelector('#login-error');
          loginError.textContent = 'That passkey was not recognized.';
          loginError.hidden = false;
          return;
        }
        sessionStorage.setItem(`${STORAGE_KEY}-passkey-signed-in`, 'true');
        const today = new Date();
        sessionStorage.setItem(`${STORAGE_KEY}-month`, `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`);
        window.location.href = 'family-budget/months.html';
      });
    } else {
      if (sessionStorage.getItem(`${STORAGE_KEY}-passkey-signed-in`) !== 'true') {
        window.location.replace('../family-budget-vertical.html');
      }
      setupLedger();
      document.querySelectorAll('[data-month-shift]').forEach(button => button.addEventListener('click', () => {
      currentMonth.setMonth(currentMonth.getMonth() + Number(button.dataset.monthShift));
      sessionStorage.setItem(`${STORAGE_KEY}-month`, monthKey());
      render();
    }));
    document.querySelectorAll('.device-button').forEach(button => button.addEventListener('click', () => {
      const grid = document.querySelector('#property-grid');
      if (!grid) return;
      grid.dataset.device = button.dataset.device;
      document.querySelectorAll('.device-button').forEach(choice => choice.setAttribute('aria-pressed', String(choice === button)));
      try { localStorage.setItem(`${STORAGE_KEY}-view`, button.dataset.device); } catch (error) { /* Layout preference is optional. */ }
    }));
    document.querySelector('#transaction-search')?.addEventListener('input', renderTransactions);
    document.querySelector('#property-filter')?.addEventListener('change', renderTransactions);
    document.querySelector('#add-button')?.addEventListener('click', () => {
      const dateInput = document.querySelector('#entry-date');
      const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
      dateInput.value = `${monthKey()}-${String(Math.min(new Date().getDate(), daysInMonth)).padStart(2, '0')}`;
      // Refresh the year-specific property/section options for the prefilled date.
      dateInput.dispatchEvent(new Event('change'));
      document.querySelector('#transaction-dialog').showModal();
    });
    document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
    document.querySelector('#transaction-form')?.addEventListener('submit', event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const amount = Number(values.amount);
      if (!Number.isFinite(amount) || amount <= 0) return;
      transactions.push({ id: `new-${Date.now()}`, property: values.property, date: values.date, section: values.section, category: values.category.trim(), description: values.description.trim(), place: values.place.trim(), amount: Math.round(amount * 100), type: values.type });
      saveTransactions();
      event.currentTarget.reset();
      document.querySelector('#transaction-dialog').close();
      render();
      showToast('Transaction added to your activity.');
    });
    document.querySelector('#logout-button')?.addEventListener('click', () => {
      sessionStorage.removeItem(`${STORAGE_KEY}-passkey-signed-in`);
      sessionStorage.removeItem(`${STORAGE_KEY}-signed-in`);
      window.location.href = '../family-budget-vertical.html';
    });
    try {
      const preferredView = localStorage.getItem(`${STORAGE_KEY}-view`);
      const grid = document.querySelector('#property-grid');
      if (grid && (preferredView === 'mobile' || preferredView === 'desktop')) {
        grid.dataset.device = preferredView;
        document.querySelectorAll('.device-button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.device === preferredView)));
      }
    } catch (error) { /* Layout preference is optional. */ }
    render();
    }
