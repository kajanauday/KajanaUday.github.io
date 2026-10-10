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
    let currentMonth = (() => {
      const today = new Date();
      if (document.body.dataset.page === 'months') return new Date(today.getFullYear(), today.getMonth(), 1);
      const savedMonth = sessionStorage.getItem(`${STORAGE_KEY}-month`);
      if (!savedMonth || !/^\d{4}-\d{2}$/.test(savedMonth)) return new Date(today.getFullYear(), today.getMonth(), 1);
      const [year, month] = savedMonth.split('-').map(Number);
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
    function saveTransactions() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
        document.querySelector('.save-state').innerHTML = '<span class="save-dot"></span> All changes saved';
      } catch (error) {
        document.querySelector('.save-state').textContent = 'Could not save locally';
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
      const formatted = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(value));
      return `${value < 0 ? '-' : ''}${formatted}`;
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
    function renderMonthDetails(value, date) {
      const settings = yearSettings(date.getFullYear());
      return settings.currencies.map(property => {
        const region = regions[property];
        const items = transactions.filter(item => item.property === property && item.date.startsWith(value));
        const sectionRows = [...settings.sections].sort((a, b) => (a.type === 'income' ? 0 : 1) - (b.type === 'income' ? 0 : 1)).map(section => {
          const sectionItems = items.filter(item => item.type === section.type && (item.section === section.name || (!item.section && section.subsections.includes(item.category))));
          const subsections = [...new Set([
            ...section.subsections,
            ...sectionItems.map(item => item.category)
          ])];
          const subsectionRows = subsections.map(subsection => {
            const subsectionItems = sectionItems
              .filter(item => item.category === subsection)
              .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
            const amount = totalFor(subsectionItems, section.type);
            const entries = subsectionItems.length
              ? subsectionItems.map(item => `<div class="month-entry-row"><span>${dayLabel(item.date)}</span><span>${escapeHtml(item.description)}</span><span>${escapeHtml(item.place || '—')}</span><strong class="month-entry-amount ${section.type}">${formatMoney(item.amount, property)}</strong></div>`).join('')
              : '<p class="month-empty">No entries for this subsection.</p>';
            return `<details class="month-drill-subsection"><summary><span>${escapeHtml(subsection)}</span><strong>${formatMoney(amount, property)}</strong></summary><div class="month-entry-table">${entries}</div></details>`;
          }).join('');
          return `<details class="month-drill-section ${section.type}"><summary>${escapeHtml(section.name)}</summary><div class="month-drill-subsections">${subsectionRows || '<p class="month-empty">No subsections configured.</p>'}</div></details>`;
        }).join('');
        return `<section class="month-detail-property ${property}" aria-label="${region.name} details for ${date.toLocaleDateString('en', { month: 'long', year: 'numeric' })}"><header class="month-detail-head"><h2><i class="property-dot ${property}" aria-hidden="true"></i>${region.name}</h2><span>${region.code}</span></header><div class="month-drill-sections">${sectionRows}</div></section>`;
      }).join('');
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
      const monthGrid = document.querySelector('#month-grid');
      if (monthGrid) {
        const today = new Date();
        const firstYear = 2025;
        document.querySelector('#month-year').textContent = 'Monthly history';
        monthGrid.innerHTML = Array.from({ length: Math.max(0, today.getFullYear() - firstYear + 1) }, (_, yearOffset) => {
          const year = today.getFullYear() - yearOffset;
          const isCurrentYear = year === today.getFullYear();
          const yearItems = transactions.filter(item => item.date.startsWith(`${year}-`));
          const settings = yearSettings(year);
          const activeMonth = year === today.getFullYear()
            ? today.getMonth()
            : Math.max(0, ...yearItems.map(item => Number(item.date.slice(5, 7)) - 1));
          const yearSummaries = settings.currencies.map(property => {
            const region = regions[property];
            const items = yearItems.filter(item => item.property === property);
            const income = totalFor(items, 'income');
            const expense = totalFor(items, 'expense');
            const opening = year === 2026 ? region.opening : 0;
            return `<div class="year-summary-property"><span class="year-summary-name"><i class="property-dot ${property}" aria-hidden="true"></i>${region.code}</span><span class="year-summary-value"><small>Income</small><strong class="income">${formatMoney(income, property)}</strong></span><span class="year-summary-value"><small>Expenses</small><strong class="expense">${formatMoney(expense, property)}</strong></span><span class="year-summary-value"><small>Balance</small><strong>${formatMoney(opening + income - expense, property)}</strong></span></div>`;
          }).join('');
          const months = Array.from({ length: 12 }, (_, month) => {
            const date = new Date(year, month, 1);
            const value = `${year}-${String(month + 1).padStart(2, '0')}`;
            const isActiveMonth = month === activeMonth;
            const monthName = date.toLocaleDateString('en', { month: 'short' }).slice(0, 3);
            const monthItems = yearItems.filter(item => item.date.startsWith(value));
            const monthSummary = Object.keys(regions).filter(property => settings.currencies.includes(property)).map(property => {
              const region = regions[property];
              const items = monthItems.filter(item => item.property === property);
              const income = totalFor(items, 'income');
              const expense = totalFor(items, 'expense');
              const formattedIncome = formatMoney(income, property);
              const formattedExpense = formatMoney(expense, property);
              return {
                markup: `<span class="month-tile-currency-row"><span class="month-tile-currency">${region.code}</span><strong class="month-tile-amount income">${formattedIncome}</strong><strong class="month-tile-amount expense">${formattedExpense}</strong></span>`,
                label: `${region.code}: Income ${formattedIncome}, Expenses ${formattedExpense}`
              };
            });
            const monthSummaryLabel = monthSummary.map(summary => summary.label).join('; ');
            return `<article class="month-tile${isActiveMonth ? ' is-selected' : ''}" data-month-card="${value}"><button type="button" class="month-tile-toggle" data-month-value="${value}" aria-label="${monthName} ${year}${monthSummaryLabel ? `: ${monthSummaryLabel}` : ''}" aria-expanded="${isActiveMonth}" aria-controls="month-details-${year}"${year === today.getFullYear() && month === today.getMonth() ? ' aria-current="date"' : ''}><span class="month-tile-head">${monthName}</span><span class="month-tile-summary">${monthSummary.map(summary => summary.markup).join('')}</span></button></article>`;
          }).join('');
          const monthDetails = Array.from({ length: 12 }, (_, month) => {
            const date = new Date(year, month, 1);
            const value = `${year}-${String(month + 1).padStart(2, '0')}`;
            const singleCurrency = settings.currencies.length === 1 ? ' has-single-currency' : '';
            return `<div class="month-details${singleCurrency}" data-month-details="${value}"${month === activeMonth ? '' : ' hidden'}>${renderMonthDetails(value, date)}</div>`;
          }).join('');
          return `<section class="month-year-group${isCurrentYear ? ' is-open' : ''}" data-year-group="${year}"><div class="month-year-heading"><button type="button" class="month-year-toggle" aria-expanded="${isCurrentYear}" aria-controls="months-${year}"><span class="month-list-year">${year}</span><span class="year-summary">${yearSummaries}</span></button></div><div class="year-month-content" id="months-${year}"${isCurrentYear ? '' : ' hidden'}><div class="year-month-grid">${months}</div><div class="year-active-month-details" id="month-details-${year}" data-year-details="${year}">${monthDetails}</div></div></section>`;
        }).join('');
        monthGrid.addEventListener('click', event => {
          const settingsButton = event.target.closest('[data-year-settings]');
          if (settingsButton) {
            openYearSettings(Number(settingsButton.dataset.yearSettings));
            return;
          }
          const yearToggle = event.target.closest('.month-year-toggle');
          if (yearToggle) {
            const group = yearToggle.closest('.month-year-group');
            const isExpanded = yearToggle.getAttribute('aria-expanded') === 'true';
            monthGrid.querySelectorAll('.month-year-group.is-open').forEach(openGroup => {
              openGroup.classList.remove('is-open');
              openGroup.querySelector('.month-year-toggle').setAttribute('aria-expanded', 'false');
              openGroup.querySelector('.year-month-content').hidden = true;
            });
            if (!isExpanded) {
              group.classList.add('is-open');
              yearToggle.setAttribute('aria-expanded', 'true');
              group.querySelector('.year-month-content').hidden = false;
            }
            return;
          }
          const tile = event.target.closest('[data-month-value]');
          if (!tile) return;
          const yearGroup = tile.closest('.month-year-group');
          const value = tile.dataset.monthValue;
          yearGroup.querySelectorAll('.month-tile').forEach(card => {
            const button = card.querySelector('[data-month-value]');
            const isSelected = button === tile;
            card.classList.toggle('is-selected', isSelected);
            button.setAttribute('aria-expanded', String(isSelected));
          });
          yearGroup.querySelectorAll('[data-month-details]').forEach(details => { details.hidden = details.dataset.monthDetails !== value; });
        });
      }
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
      document.querySelector('#entry-date').value = `${monthKey()}-${String(new Date().getDate()).padStart(2, '0')}`;
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
