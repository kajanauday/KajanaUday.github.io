const STORAGE_KEY = 'family-budget-static-demo-v1';
    const regions = {
      india: { name: 'India', home: 'Pune home', code: 'INR', symbol: '₹', color: 'india', opening: 1973800, budget: 5500000, icon: 'ti-home-2' },
      japan: { name: 'Japan', home: 'Tokyo home', code: 'JPY', symbol: '¥', color: 'japan', opening: 1973800, budget: 9800000, icon: 'ti-building-community' }
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
      const region = regions[property];
      const value = Number(minor || 0) / 100;
      const formatted = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value);
      return `${region.symbol}${formatted}`;
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
      return items.map(item => `<div class="transaction-row"><span class="transaction-icon"><i class="ti ${iconFor(item.category, item.type)}" aria-hidden="true"></i></span><div class="transaction-copy"><p class="transaction-title">${escapeHtml(item.description)}</p><span class="transaction-meta">${escapeHtml(item.category)} · ${dayLabel(item.date)}</span></div><span class="transaction-amount ${item.type}">${item.type === 'expense' ? '−' : '+'}${formatMoney(item.amount, property)}</span></div>`).join('');
    }
    function renderProperty(property) {
      const target = document.querySelector(`#property-${property}`);
      if (!target) return;
      const region = regions[property];
      const stats = propertyStats(property);
      const spentPercent = Math.min(100, stats.expense / region.budget * 100);
      const content = `<div class="property-inner"><header class="property-header"><div class="property-identity"><span class="property-badge"><i class="ti ${region.icon}" aria-hidden="true"></i></span><div><h2 class="property-title">${region.name.toUpperCase()}</h2><span class="property-meta">${region.home}</span></div></div><span class="currency-chip">${region.symbol} <span>${region.code}</span></span></header><div class="property-stats"><div class="stat-box"><span class="stat-label">Income</span><strong class="stat-value income">${formatMoney(stats.income, property)}</strong></div><div class="stat-box"><span class="stat-label">Expenses</span><strong class="stat-value expense">${formatMoney(stats.expense, property)}</strong></div></div><div class="balance-box"><div><span class="balance-label">Current balance</span><strong class="balance-value">${formatMoney(stats.balance, property)}</strong><span class="balance-change"><i class="ti ti-trending-up" aria-hidden="true"></i> ${stats.income ? 'On pace this month' : 'Opening balance'}</span></div>${balanceSpark()}</div><section aria-label="Monthly budget"><div class="card-section-head"><h3>Monthly spend</h3><button type="button" class="subtle-action" data-page-link="budgets">Budget details <i class="ti ti-arrow-up-right" aria-hidden="true"></i></button></div><div class="budget-line"><span>${formatMoney(stats.expense, property)} spent</span><strong>${Math.round(spentPercent)}% of ${formatMoney(region.budget, property)}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${spentPercent}%"></div></div></section><section aria-label="Recent transactions"><div class="card-section-head"><h3>Recent activity</h3><button type="button" class="subtle-action" data-page-link="transactions">See all <i class="ti ti-arrow-right" aria-hidden="true"></i></button></div><div class="transaction-list">${renderRecent(property)}</div></section></div>`;
      target.innerHTML = content;
    }
    function renderTransactions() {
      const searchInput = document.querySelector('#transaction-search');
      const propertyFilter = document.querySelector('#property-filter');
      const rows = document.querySelector('#activity-rows');
      if (!searchInput || !propertyFilter || !rows) return;
      const search = searchInput.value.trim().toLowerCase();
      const property = propertyFilter.value;
      const items = monthTransactions().filter(item => (property === 'all' || item.property === property) && `${item.description} ${item.category} ${regions[item.property].name}`.toLowerCase().includes(search)).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
      document.querySelector('#transaction-count').textContent = `${items.length} ${items.length === 1 ? 'entry' : 'entries'}`;
      rows.innerHTML = items.length ? items.map(item => `<tr><td>${dayLabel(item.date)}</td><td><strong>${escapeHtml(item.description)}</strong></td><td><span class="property-pill"><i class="ti ${regions[item.property].icon}" aria-hidden="true"></i>${regions[item.property].name}</span></td><td>${escapeHtml(item.category)}</td><td class="amount-cell ${item.type}">${item.type === 'expense' ? '−' : '+'}${formatMoney(item.amount, item.property)}</td></tr>`).join('') : '<tr><td colspan="5" style="padding:24px 12px;color:#777e75">No transactions match this month and filter.</td></tr>';
    }
    function categoryTotals(property) {
      const totals = new Map();
      monthTransactions(property).filter(item => item.type === 'expense').forEach(item => totals.set(item.category, (totals.get(item.category) || 0) + item.amount));
      return [...totals.entries()].sort((a, b) => b[1] - a[1]);
    }
    function monthCategoryTotals(items, type) {
      const totals = new Map();
      items.filter(item => item.type === type).forEach(item => totals.set(item.category, (totals.get(item.category) || 0) + Number(item.amount)));
      return [...totals.entries()].sort((a, b) => b[1] - a[1]);
    }
    function renderMonthDetails(value, date) {
      return Object.entries(regions).map(([property, region]) => {
        const items = transactions.filter(item => item.property === property && item.date.startsWith(value));
        const income = totalFor(items, 'income');
        const expense = totalFor(items, 'expense');
        const opening = value === '2026-10' ? region.opening : 0;
        const categories = monthCategoryTotals(items, 'expense');
        const categoryRows = categories.length
          ? categories.map(([name, amount]) => `<div class="month-category"><span>${escapeHtml(name)}</span><strong>${formatMoney(amount, property)}</strong></div>`).join('')
          : '<p class="month-empty">No expenses recorded this month.</p>';
        return `<section class="month-detail-property ${property}" aria-label="${region.name} details for ${date.toLocaleDateString('en', { month: 'long', year: 'numeric' })}"><header class="month-detail-head"><h2><i class="property-dot ${property}" aria-hidden="true"></i>${region.name}</h2><span>${region.code}</span></header><div class="month-detail-totals"><div><span>Income</span><strong class="income">${formatMoney(income, property)}</strong></div><div><span>Expenses</span><strong class="expense">${formatMoney(expense, property)}</strong></div><div><span>Balance</span><strong>${formatMoney(opening + income - expense, property)}</strong></div></div><div class="month-categories"><h3>Expense categories${categories[0] ? ` · Highest: ${escapeHtml(categories[0][0])}` : ''}</h3>${categoryRows}</div></section>`;
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
        const year = today.getFullYear();
        document.querySelector('#month-year').textContent = String(year);
        monthGrid.innerHTML = Array.from({ length: today.getMonth() + 1 }, (_, offset) => {
          const month = today.getMonth() - offset;
          const date = new Date(year, month, 1);
          const value = `${year}-${String(month + 1).padStart(2, '0')}`;
          const isCurrentMonth = month === today.getMonth();
          const propertySummaries = Object.entries(regions).map(([property, region]) => {
            const items = transactions.filter(item => item.property === property && item.date.startsWith(value));
            const income = totalFor(items, 'income');
            const expense = totalFor(items, 'expense');
            const opening = value === '2026-10' ? region.opening : 0;
            const balance = opening + income - expense;
            return `<div class="month-property"><span class="month-property-name"><i class="property-dot ${property}" aria-hidden="true"></i>${region.code}</span><span class="month-values"><strong class="income">${formatMoney(income, property)}</strong><strong class="expense">${formatMoney(expense, property)}</strong><strong>${formatMoney(balance, property)}</strong></span></div>`;
          }).join('');
          return `<article class="month-tile${isCurrentMonth ? ' is-current' : ''}" data-month-card="${value}"><button type="button" class="month-tile-toggle" data-month-value="${value}" aria-expanded="false" aria-controls="month-details-${value}"${isCurrentMonth ? ' aria-current="date"' : ''}><span class="month-tile-head">${date.toLocaleDateString('en', { month: 'long' })}${isCurrentMonth ? '<small>Current</small>' : ''}</span></button><div class="month-tile-summary">${propertySummaries}</div><div class="month-details" id="month-details-${value}" hidden>${renderMonthDetails(value, date)}</div></article>`;
        }).join('');
        monthGrid.addEventListener('click', event => {
          const tile = event.target.closest('[data-month-value]');
          if (!tile) return;
          const card = tile.closest('[data-month-card]');
          const isExpanded = tile.getAttribute('aria-expanded') === 'true';
          monthGrid.querySelectorAll('.month-tile.is-expanded').forEach(openCard => {
            openCard.classList.remove('is-expanded');
            openCard.querySelector('.month-tile-toggle').setAttribute('aria-expanded', 'false');
            openCard.querySelector('.month-details').hidden = true;
          });
          if (!isExpanded) {
            card.classList.add('is-expanded');
            tile.setAttribute('aria-expanded', 'true');
            card.querySelector('.month-details').hidden = false;
          }
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
      transactions.push({ id: `new-${Date.now()}`, property: values.property, date: values.date, category: values.category.trim(), description: values.description.trim(), amount: Math.round(amount * 100), type: values.type });
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
