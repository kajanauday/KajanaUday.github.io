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
    const FIRST_YEAR = 2025;
    const store = new ExpenseStore({ storageKey: STORAGE_KEY, regions, firstYear: FIRST_YEAR, starter: starterTransactions });
    let transactions = store.transactions;
    const yearSettingsByYear = store.settingsByYear;
    let currentMonth = (() => {
      const today = new Date();
      const savedMonth = sessionStorage.getItem(`${STORAGE_KEY}-month`);
      if (!savedMonth || !/^\d{4}-\d{2}$/.test(savedMonth)) return new Date(today.getFullYear(), today.getMonth(), 1);
      const [year, month] = savedMonth.split('-').map(Number);
      if (year < FIRST_YEAR || year > today.getFullYear()) return new Date(today.getFullYear(), today.getMonth(), 1);
      return new Date(year, month - 1, 1);
    })();
    let toastTimer;
    let universeOpen = sessionStorage.getItem(`${STORAGE_KEY}-universe`) === 'true';

    function yearSettings(year) { return store.settings(year); }
    function saveYearSettings() { store.saveSettings(); }
    function openingFor(year, property) { return store.openingFor(year, property); }
    function budgetFor(year, property) { return store.budgetFor(year, property); }
    function saveTransactions() {
      try {
        store.saveTransactions();
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
      const digits = suffix === 'L' || suffix === 'Cr' ? 2 : suffix && value / size < 100 ? 1 : 0;
      return `${minor < 0 ? '−' : ''}${new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value / size)}${suffix}`;
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
    function iconFor(category, type) { return ExpenseStore.iconFor(category, type); }
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
      const budget = budgetFor(currentMonth.getFullYear(), property);
      const stats = propertyStats(property);
      const spentPercent = Math.min(100, stats.expense / budget * 100);
      target.innerHTML = LedgerBlueprints.PropertyCard({ region, property, stats, budget, spentPercent, recentHtml: renderRecent(property) }, { fmt: formatMoney, spark: balanceSpark });
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
    function closingBalance(year, property, month) { return store.closingBalance(year, property, month); }
    // Inline ledger drafts: subsection adds and unsaved transaction fields.
    let ledgerDraft = null;
    let entryDraft = null;
    let noteDraftId = null;
    let noteDraftValue = '';
    let subEntryDraftParentId = null;
    const expandedEntries = new Set();
    let revealKey = null; // subsection to open on the next render, e.g. the one that just got an entry
    const catKey = (month, property, section, category) => [month, property, section, category].join('|');
    const keyOf = (year, month) => `${year}-${String(month + 1).padStart(2, '0')}`;
    const dateOf = key => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
    // Months whose ledger is open. A fresh session opens the current month on wider screens; on phones every month
    // starts closed so the whole year's list fits on screen (an open month is several screens tall there).
    const isPhone = () => window.matchMedia('(max-width: 700px)').matches;
    const expandedMonths = new Set(JSON.parse(sessionStorage.getItem(`${STORAGE_KEY}-open-months`) || 'null') || (isPhone() ? [] : [keyOf(new Date().getFullYear(), new Date().getMonth())]));
    function saveExpandedMonths() {
      sessionStorage.setItem(`${STORAGE_KEY}-open-months`, JSON.stringify([...expandedMonths]));
    }
    // The ledger is painted from the ExpenseStore tree by LedgerRenderer using LedgerBlueprints.
    // Inline-edit state lives here and is handed to each render, so blueprints stay pure.
    const renderState = () => ({ expandedEntries, expandedMonths, entryDraft, subEntryDraftParentId, ledgerDraft });
    const ledgerRenderer = new LedgerRenderer(store, {
      fmt: formatMoney, compact: compactMoney, signed: signedMoney, esc: escapeHtml, dayLabel, keyOf, catKey, monthLabel, regions, firstYear: FIRST_YEAR,
      netClass: minor => (minor > 0 ? 'income' : minor < 0 ? 'expense' : '')
    });
    function renderLedgerPanel(property, year, month) { return ledgerRenderer.currencyPanel(property, year, month, renderState()); }
    function renderYearKpis(year) { return ledgerRenderer.yearKpis(year); }
    function renderMonthBlock(year, month) { return ledgerRenderer.monthBlock(year, month, renderState()); }
    function renderMonthGroups(year) { return ledgerRenderer.monthGroups(year, renderState()); }
    function renderLedger() {
      const ledger = document.querySelector('#ledger');
      if (!ledger) return;
      const year = currentMonth.getFullYear();
      const yearCount = ledgerRenderer.yearEntryCount(year);
      document.querySelector('#year-tabs').innerHTML = ledgerRenderer.yearTabs(year);
      document.querySelector('#year-meta').textContent = `${yearCount} ${yearCount === 1 ? 'entry' : 'entries'} in ${year}`;
      document.querySelector('#year-kpis').innerHTML = renderYearKpis(year);
      const toggle = document.querySelector('[data-toggle-universe]');
      toggle.setAttribute('aria-pressed', String(universeOpen));
      toggle.querySelector('span').textContent = universeOpen ? 'Hide summary' : 'Year summary';
      // Keep open subsections open across re-renders (e.g. after saving an entry).
      const host = document.querySelector('#month-ledger');
      const keepOpen = [...host.querySelectorAll('.ledger-cat[open]')].map(cat => cat.dataset.key);
      host.innerHTML = renderMonthGroups(year);
      host.querySelectorAll('.ledger-cat').forEach(cat => { if (keepOpen.includes(cat.dataset.key) || cat.dataset.key === revealKey) cat.open = true; });
      revealKey = null;
      host.querySelector('[data-ledger-form="subsection"]')?.elements.name.focus();
      host.querySelector('[data-ledger-form="entry"]')?.elements.description.focus();
      document.querySelector('#year-settings-button').dataset.year = year;
      document.body.classList.toggle('show-universe', universeOpen);
      const universe = document.querySelector('#universe');
      universe.inert = !universeOpen;
      universe.setAttribute('aria-hidden', String(!universeOpen));
    }
    function setUniverse(open) {
      universeOpen = open;
      sessionStorage.setItem(`${STORAGE_KEY}-universe`, String(open));
      renderLedger();
    }
    function selectLedgerYear(year) {
      const today = new Date();
      currentMonth = new Date(year, year === today.getFullYear() ? today.getMonth() : 0, 1);
      sessionStorage.setItem(`${STORAGE_KEY}-month`, monthKey());
      // A past year opens on its latest month with entries, unless one of its months is already open.
      const hasOpen = [...expandedMonths].some(key => key.startsWith(`${year}-`));
      if (!hasOpen && year !== today.getFullYear() && !isPhone()) {
        const latest = transactions.filter(item => item.date.startsWith(`${year}-`)).map(item => item.date.slice(0, 7)).sort().pop();
        if (latest) expandedMonths.add(latest);
        saveExpandedMonths();
      }
      ledgerDraft = null;
      renderLedger();
    }
    function saveDraftSubsection(form) {
      const input = form.elements.name;
      const name = input.value.trim().replace(/\s+/g, ' ');
      const hint = form.querySelector('.ledger-form-hint');
      const section = yearSettings(Number(ledgerDraft.month.slice(0, 4))).sections.find(item => item.name === ledgerDraft.section);
      const problem = !name ? 'Type a name first.' : !section ? 'This section is no longer configured.' : section.subsections.some(existing => existing.toLowerCase() === name.toLowerCase()) ? `"${name}" already exists in ${section.name}.` : '';
      if (problem) {
        hint.textContent = problem;
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      section.subsections.push(name);
      try {
        saveYearSettings();
      } catch (error) {
        section.subsections.pop();
        hint.textContent = 'Could not save in this browser.';
        return;
      }
      // Go straight to the first entry for the new subsection.
      const { month, property } = ledgerDraft;
      ledgerDraft = null;
      entryDraft = { month, property, section: section.name, type: section.type, category: name };
      revealKey = catKey(month, property, section.name, name);
      renderLedger();
      showToast(`Added "${name}" to ${section.name}.`);
    }
    function saveEntryDraft(form) {
      const fields = form.elements;
      const { month, property, section, type, category } = form.dataset;
      const day = Number(fields.day.value);
      const amount = Number(fields.amount.value);
      const checks = [
        [fields.day, Number.isInteger(day) && day >= 1 && day <= Number(fields.day.max)],
        [fields.description, fields.description.value.trim() !== ''],
        [fields.amount, Number.isFinite(amount) && amount > 0]
      ];
      checks.forEach(([input, ok]) => input.toggleAttribute('aria-invalid', !ok));
      const invalid = checks.find(([, ok]) => !ok);
      if (invalid) return invalid[0].focus();
      const date = `${month}-${String(day).padStart(2, '0')}`;
      transactions.push({ id: `new-${Date.now()}`, property, date, section, category, description: fields.description.value.trim(), place: fields.place.value.trim(), amount: Math.round(amount * 100), type });
      saveTransactions();
      entryDraft = null;
      revealKey = catKey(month, property, section, category);
      renderLedger();
      showToast(`Saved to ${category}.`);
    }
    function setupLedger() {
      const ledger = document.querySelector('#ledger');
      if (!ledger) return;
      ledger.addEventListener('click', event => {
        const yearTab = event.target.closest('[data-ledger-year]');
        if (yearTab) return selectLedgerYear(Number(yearTab.dataset.ledgerYear));
        if (event.target.closest('[data-toggle-universe]')) return setUniverse(!universeOpen);
        const eye = event.target.closest('[data-toggle-month]');
        if (eye) {
          const key = eye.dataset.toggleMonth;
          if (expandedMonths.has(key)) expandedMonths.delete(key);
          else expandedMonths.add(key);
          saveExpandedMonths();
          if (ledgerDraft?.month === key) ledgerDraft = null;
          if (entryDraft?.month === key) entryDraft = null;
          renderLedger();
          return document.querySelector(`[data-toggle-month="${key}"]`)?.focus();
        }
        const addSub = event.target.closest('[data-add-subsection]');
        const addEntry = event.target.closest('[data-add-entry-row]');
        if (addEntry) event.preventDefault();
        if ((addSub || addEntry) && (ledgerDraft || entryDraft || subEntryDraftParentId)) {
          showToast('Save or cancel the current inline edit first.');
          return;
        }
        if (addSub) {
          ledgerDraft = { month: addSub.dataset.month, property: addSub.dataset.property, section: addSub.dataset.section };
          return renderLedger();
        }
        if (addEntry) {
          entryDraft = { ...addEntry.dataset };
          revealKey = catKey(entryDraft.month, entryDraft.property, entryDraft.section, entryDraft.category);
          return renderLedger();
        }
        const toggleEntry = event.target.closest('[data-toggle-entry]');
        if (toggleEntry) {
          const entryId = toggleEntry.dataset.entryId;
          if (expandedEntries.has(entryId)) expandedEntries.delete(entryId);
          else expandedEntries.add(entryId);
          return renderLedger();
        }
        if (event.target.closest('[data-cancel-draft]')) {
          ledgerDraft = null;
          return renderLedger();
        }
        if (event.target.closest('[data-cancel-entry]')) {
          entryDraft = null;
          return renderLedger();
        }
        if (event.target.closest('[data-cancel-sub-entry]')) {
          subEntryDraftParentId = null;
          return renderLedger();
        }
        const expandButton = event.target.closest('[data-ledger-expand]');
        if (expandButton) {
          const cats = [...expandButton.closest('.month-block').querySelectorAll('.ledger-cat')];
          const open = cats.some(cat => !cat.open);
          cats.forEach(cat => { cat.open = open; });
          expandButton.textContent = open ? 'Collapse all' : 'Expand all';
        }
      });
      ledger.addEventListener('submit', event => {
        const form = event.target.closest('[data-ledger-form]');
        if (!form) return;
        event.preventDefault();
        if (form.dataset.ledgerForm === 'entry') return saveEntryDraft(form);
        if (form.dataset.ledgerForm === 'sub-entry') {
          const description = form.elements.description.value.trim();
          if (!description) {
            showToast('Description is required.');
            return;
          }
          const parentId = form.dataset.parentId;
          const parentItem = transactions.find(item => item.id === parentId);
          if (!parentItem) {
            subEntryDraftParentId = null;
            renderLedger();
            showToast('Could not find parent entry. Refresh and try again.');
            return;
          }
          const parentYear = Number(parentItem.date.slice(0, 4));
          const parentMonth = Number(parentItem.date.slice(5, 7));
          const daysInMonth = new Date(parentYear, parentMonth, 0).getDate();
          const day = form.elements.day.value ? Math.min(Number(form.elements.day.value), daysInMonth) : undefined;
          const date = day ? `${parentYear}-${String(parentMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}` : undefined;
          const amount = form.elements.amount.value ? Number(form.elements.amount.value) * 100 : undefined;
          const place = form.elements.place.value.trim() || undefined;
          const newSubEntry = {
            id: `${parentId}-sub-${Date.now()}`,
            parentId,
            property: parentItem.property,
            type: parentItem.type,
            category: parentItem.category,
            section: parentItem.section,
            description,
            place,
            date: date || parentItem.date,
            amount: amount || 0
          };
          transactions.push(newSubEntry);
          saveTransactions();
          subEntryDraftParentId = null;
          renderLedger();
          return showToast('Sub-entry added.');
        }
        if (form.dataset.ledgerForm === 'subsection' && ledgerDraft) saveDraftSubsection(form);
      });
      ledger.addEventListener('keydown', event => {
        const form = event.target.closest('[data-ledger-form]');
        if (!form) return;

        if (event.key === 'Escape') {
          if (form.dataset.ledgerForm === 'entry') entryDraft = null;
          else if (form.dataset.ledgerForm === 'sub-entry') subEntryDraftParentId = null;
          else ledgerDraft = null;
          renderLedger();
          return;
        }

        if (event.key === 'Enter') {
          const isEntryForm = form.dataset.ledgerForm === 'entry' || form.dataset.ledgerForm === 'sub-entry';
          if (!isEntryForm) return;

          event.preventDefault();
          const fields = form.elements;
          const fieldNames = ['day', 'description', 'place', 'amount'];
          const currentField = event.target.name;
          const currentIndex = fieldNames.indexOf(currentField);

          if (currentIndex === -1) return;

          if (currentIndex === fieldNames.length - 1) {
            form.dispatchEvent(new Event('submit', { bubbles: true }));
          } else {
            const nextFieldName = fieldNames[currentIndex + 1];
            const nextField = fields[nextFieldName];
            if (nextField) nextField.focus();
          }
        }
      });

      let longPressTimer = null;
      let longPressTarget = null;
      let longPressStart = null;
      const LONG_PRESS_DURATION = 2000;
      const LONG_PRESS_MOVE_THRESHOLD = 10;

      const getElement = (target) => {
        while (target && target.nodeType === Node.TEXT_NODE) {
          target = target.parentElement;
        }
        return target;
      };

      const triggerLongPress = (element) => {
        element = getElement(element);
        if (!element) return false;

        const entryLine = element.closest('.ledger-entry-line');
        const cat = element.closest('.ledger-cat');
        const typeSection = element.closest('.ledger-type-section');

        if (entryLine && entryLine.querySelector('[data-toggle-entry]')) {
          const button = entryLine.querySelector('[data-toggle-entry]');
          const entryId = button.dataset.entryId;
          subEntryDraftParentId = entryId;
          expandedEntries.add(entryId);
          renderLedger();
          showToast('✓ Long-press: Add sub-entry');
          return true;
        }

        if (cat && typeSection && cat.querySelector('.ledger-cat-name')) {
          const categoryName = cat.querySelector('.ledger-cat-name').textContent.trim();
          const typeSummary = typeSection.querySelector('summary strong');
          const section = typeSummary?.textContent.trim() === 'Income' ? 'income' : 'expense';
          const mKey = keyOf(currentMonth.getFullYear(), currentMonth.getMonth());
          entryDraft = { month: mKey, property: Object.keys(regions)[0], section, category: categoryName };
          revealKey = catKey(mKey, Object.keys(regions)[0], section, categoryName);
          renderLedger();
          showToast('✓ Long-press: Add entry');
          return true;
        }

        if (typeSection && !cat && typeSection.querySelector('summary strong')) {
          const sectionName = typeSection.querySelector('summary strong').textContent.trim();
          const type = sectionName === 'Income' ? 'income' : 'expense';
          const mKey = keyOf(currentMonth.getFullYear(), currentMonth.getMonth());
          ledgerDraft = { month: mKey, property: Object.keys(regions)[0], section: type === 'income' ? 'Income' : 'Expenses' };
          renderLedger();
          showToast('✓ Long-press: Add subsection');
          return true;
        }

        return false;
      };

      const startLongPress = (target, e) => {
        longPressTarget = getElement(target);
        longPressStart = { x: e.pageX, y: e.pageY };
        longPressTimer = setTimeout(() => {
          triggerLongPress(longPressTarget);
          longPressTimer = null;
        }, LONG_PRESS_DURATION);
      };

      const endLongPress = () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        longPressTarget = null;
        longPressStart = null;
      };

      const checkLongPressMove = (e) => {
        if (!longPressTimer || !longPressStart) return;
        const dx = Math.abs(e.pageX - longPressStart.x);
        const dy = Math.abs(e.pageY - longPressStart.y);
        if (dx > LONG_PRESS_MOVE_THRESHOLD || dy > LONG_PRESS_MOVE_THRESHOLD) {
          endLongPress();
        }
      };

      ledger.addEventListener('touchstart', (e) => {
        startLongPress(e.target, e);
      });

      ledger.addEventListener('touchend', endLongPress);
      ledger.addEventListener('touchmove', (e) => {
        checkLongPressMove(e);
      });
      ledger.addEventListener('touchcancel', endLongPress);

      ledger.addEventListener('mousedown', (e) => {
        if (e.button === 0) startLongPress(e.target, e);
      });

      ledger.addEventListener('mouseup', endLongPress);
      ledger.addEventListener('mousemove', (e) => {
        checkLongPressMove(e);
      });

      document.querySelector('#year-settings-button').addEventListener('click', event => openYearSettings(Number(event.currentTarget.dataset.year)));
    }
    function renderBudgets() {
      const panels = document.querySelector('#budget-panels');
      if (!panels) return;
      panels.innerHTML = Object.keys(regions).map(property => {
        const region = regions[property];
        const budget = budgetFor(currentMonth.getFullYear(), property);
        const stats = propertyStats(property);
        const categories = categoryTotals(property);
        const remainder = Math.max(0, budget - stats.expense);
        return `<section class="surface-panel"><div class="panel-title-row"><h2><span class="property-dot ${property}" style="display:inline-block;margin-right:7px"></span>${region.name} · ${region.code}</h2><span>${monthLabel()}</span></div><div class="category-budget">${categories.map(([name, amount]) => { const percent = Math.min(100, amount / budget * 100); return `<div class="category-budget-row"><div class="category-budget-top"><strong>${escapeHtml(name)}</strong><span>${formatMoney(amount, property)} · ${Math.round(percent)}%</span></div><div class="progress-track"><div class="progress-fill" style="width:${percent}%;${property === 'japan' ? 'background:var(--japan)' : ''}"></div></div></div>`; }).join('') || '<p class="transaction-meta">No expenses recorded for this month.</p>'}</div><div class="budget-foot"><span>Monthly limit</span><strong>${formatMoney(budget, property)}</strong></div><div class="budget-foot"><span>Remaining</span><strong>${formatMoney(remainder, property)}</strong></div></section>`;
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
    // Opens the add form for the month on screen, optionally preset to a currency, type and section.
    // Each preset goes through the hidden selects so the year-specific options and buttons refresh in order.
    function openEntryDialog({ property, type, section } = {}) {
      const dialog = document.querySelector('#transaction-dialog');
      if (!dialog || dialog.open) return;
      const dateInput = document.querySelector('#entry-date');
      const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
      dateInput.value = `${monthKey()}-${String(Math.min(new Date().getDate(), daysInMonth)).padStart(2, '0')}`;
      dateInput.dispatchEvent(new Event('change'));
      [['#entry-property', property], ['#entry-type', type], ['#entry-section', section]].forEach(([selector, value]) => {
        const select = document.querySelector(selector);
        if (!select || !value || ![...select.options].some(option => option.value === value)) return;
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      dialog.showModal();
      document.querySelector('#entry-description')?.focus();
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
        const previousSubsection = subsectionSelect.value;
        subsectionSelect.replaceChildren(...(section?.subsections || []).map(name => new Option(name, name)));
        if (section?.subsections.includes(previousSubsection)) subsectionSelect.value = previousSubsection;
        sectionSelect.disabled = matchingSections.length === 0;
        subsectionSelect.disabled = !section?.subsections.length;
        const amountLabel = document.querySelector('label[for="entry-amount"]');
        if (amountLabel?.firstChild?.nodeType === Node.TEXT_NODE) amountLabel.firstChild.textContent = `Amount · ${regions[propertySelect.value]?.code || ''}`;
      };
      dateInput.addEventListener('change', refreshOptions);
      propertySelect.addEventListener('change', refreshOptions);
      typeSelect.addEventListener('change', refreshOptions);
      sectionSelect.addEventListener('change', refreshOptions);
      form.addEventListener('reset', () => setTimeout(refreshOptions));
      refreshOptions();
      segmentize(propertySelect);
      segmentize(typeSelect);
      segmentize(sectionSelect);
      segmentize(subsectionSelect, { wrap: true });
      categoryLabel.classList.add('wide');
    }
    // Turns a <select> into one-click buttons. The hidden select stays the source of truth, so option lists
    // rebuilt elsewhere (per-year currencies, sections, subsections) are mirrored automatically.
    function segmentize(select, { wrap = false } = {}) {
      if (!select || select.dataset.segmented) return;
      select.dataset.segmented = 'true';
      const group = document.createElement('div');
      group.className = `segment-group${wrap ? ' is-wrap' : ''}`;
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', select.closest('label')?.firstChild?.textContent.trim() || select.name);
      select.hidden = true;
      select.after(group);
      const draw = () => {
        group.innerHTML = [...select.options].map(option => `<button type="button" class="segment" data-value="${escapeHtml(option.value)}" aria-pressed="${option.value === select.value}">${escapeHtml(option.textContent)}</button>`).join('')
          || '<span class="segment-empty">Nothing configured for this year</span>';
      };
      group.addEventListener('click', event => {
        const button = event.target.closest('[data-value]');
        if (!button || select.disabled) return;
        select.value = button.dataset.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        draw();
      });
      select.addEventListener('change', draw);
      new MutationObserver(draw).observe(select, { childList: true });
      select.form?.addEventListener('reset', () => setTimeout(draw));
      draw();
    }
    // ---- Year configuration (months.html) ----
    // Edits are held as per-year drafts so the user can hop between year boxes; Save validates and writes every touched year.
    const CODE_TO_PROPERTY = Object.fromEntries(Object.entries(regions).map(([property, region]) => [region.code, property]));
    const configState = { year: null, drafts: {} };
    const toMajor = minor => String(Math.round(Number(minor || 0) / 100));
    function draftFromSettings(year, source = yearSettings(year)) {
      const properties = Object.keys(regions);
      return {
        dirty: false,
        currencies: source.currencies.map(property => regions[property].code),
        openings: Object.fromEntries(properties.map(property => [property, toMajor(source === yearSettings(year) ? openingFor(year, property) : source.openings?.[property] ?? 0)])),
        sections: source.sections.map(section => ({ name: section.name, originalName: section.name, type: section.type, subsections: [...section.subsections] }))
      };
    }
    function configDraft(year) {
      configState.drafts[year] ||= draftFromSettings(year);
      return configState.drafts[year];
    }
    function markConfigDirty() {
      configDraft(configState.year).dirty = true;
      document.querySelector(`[data-config-year="${configState.year}"]`)?.classList.add('is-dirty');
    }
    function usageCount(year, filter) {
      return transactions.filter(item => item.date.startsWith(`${year}-`) && filter(item)).length;
    }
    // LinkedIn-style tag field: type and press Enter or comma, paste a comma list, Backspace removes the last chip, × removes any chip.
    function chipInput({ values, label, placeholder, allowed = null, countFor = () => 0, onChange = () => {} }) {
      const root = document.createElement('div');
      root.className = 'chip-field';
      root.innerHTML = `<div class="chip-input"><input type="text" aria-label="${escapeHtml(label)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"></div><p class="chip-hint" aria-live="polite"></p>`;
      const box = root.querySelector('.chip-input');
      const input = root.querySelector('input');
      const hint = root.querySelector('.chip-hint');
      if (allowed) {
        const list = document.createElement('datalist');
        list.id = `chip-options-${Math.random().toString(36).slice(2)}`;
        list.innerHTML = allowed.map(value => `<option value="${value}"></option>`).join('');
        input.setAttribute('list', list.id);
        root.append(list);
      }
      const draw = () => {
        box.querySelectorAll('.chip').forEach(chip => chip.remove());
        values.forEach((value, index) => {
          const count = countFor(value);
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.innerHTML = `<span>${escapeHtml(value)}</span>${count ? `<small title="${count} ${count === 1 ? 'entry' : 'entries'} this year">${count}</small>` : ''}<button type="button" aria-label="Remove ${escapeHtml(value)}" data-chip-index="${index}">×</button>`;
          box.insertBefore(chip, input);
        });
        input.placeholder = values.length ? '' : placeholder;
      };
      const say = message => { hint.textContent = message; root.classList.toggle('has-hint', Boolean(message)); };
      const add = raw => {
        const problems = [];
        raw.split(/[,\n]/).map(part => part.trim()).filter(Boolean).forEach(part => {
          const value = allowed ? allowed.find(option => option.toLowerCase() === part.toLowerCase()) : part.slice(0, 40);
          if (!value) return problems.push(`"${part}" is not available. Use ${allowed.join(' or ')}.`);
          if (values.some(existing => existing.toLowerCase() === value.toLowerCase())) return problems.push(`"${value}" is already added.`);
          values.push(value);
        });
        input.value = '';
        say(problems.join(' '));
        draw();
        onChange();
      };
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ',' || (event.key === 'Tab' && input.value.trim())) {
          event.preventDefault();
          add(input.value);
        } else if (event.key === 'Backspace' && !input.value && values.length) {
          values.pop();
          say('');
          draw();
          onChange();
        }
      });
      input.addEventListener('paste', event => {
        const text = event.clipboardData.getData('text');
        if (!/[,\n]/.test(text)) return;
        event.preventDefault();
        add(`${input.value},${text}`);
      });
      input.addEventListener('blur', () => { if (input.value.trim()) add(input.value); });
      box.addEventListener('click', event => {
        const remove = event.target.closest('[data-chip-index]');
        if (remove) {
          values.splice(Number(remove.dataset.chipIndex), 1);
          say('');
          draw();
          onChange();
        }
        input.focus();
      });
      draw();
      return root;
    }
    function renderConfigMoney() {
      const year = configState.year;
      const draft = configDraft(year);
      const properties = draft.currencies.map(code => CODE_TO_PROPERTY[code]);
      const carry = year > FIRST_YEAR;
      const field = (kind, property) => `<label class="money-field"><span>${regions[property].code}</span><input type="number" step="1" inputmode="numeric" value="${escapeHtml(draft[kind][property])}" data-config-money="${kind}" data-property="${property}"></label>`;
      document.querySelector('#config-openings').innerHTML = properties.length
        ? `${properties.map(property => field('openings', property)).join('')}${carry ? `<button type="button" class="link-button" data-config-carry>Use ${year - 1} closing</button>` : ''}`
        : '<span class="config-muted">Add a currency first</span>';
    }
    function renderConfigSections() {
      const year = configState.year;
      const draft = configDraft(year);
      const list = document.querySelector('#config-sections');
      list.replaceChildren();
      draft.sections.forEach((section, index) => {
        const box = document.createElement('fieldset');
        box.className = `config-section ${section.type}`;
        const entries = usageCount(year, item => item.type === section.type && (item.section === section.originalName || (!item.section && section.subsections.includes(item.category))));
        box.innerHTML = `<div class="config-section-head">
            <input class="config-section-name" value="${escapeHtml(section.name)}" placeholder="Section name" aria-label="Section name" maxlength="40" data-section-index="${index}">
            <div class="type-toggle" role="group" aria-label="Section type"><button type="button" data-section-type="expense" aria-pressed="${section.type === 'expense'}">Expense</button><button type="button" data-section-type="income" aria-pressed="${section.type === 'income'}">Income</button></div>
            <span class="config-usage">${entries ? `${entries} ${entries === 1 ? 'entry' : 'entries'}` : ''}</span>
            <button type="button" class="icon-button config-remove" data-remove-section aria-label="Remove section ${escapeHtml(section.name)}" title="Remove section"><i class="ti ti-trash" aria-hidden="true"></i></button>
          </div>
          <div class="kv-row"><span class="kv-key">Subsections</span></div>`;
        box.querySelector('.kv-row').append(chipInput({
          values: section.subsections,
          label: `Subsections of ${section.name || 'section'}`,
          placeholder: 'Type a name, press Enter or comma',
          countFor: name => usageCount(year, item => item.type === section.type && item.category.toLowerCase() === name.toLowerCase()),
          onChange: markConfigDirty
        }));
        box.dataset.sectionIndex = index;
        list.append(box);
      });
      if (!draft.sections.length) list.innerHTML = '<p class="config-muted">No sections yet. Add one to start categorising entries.</p>';
    }
    function renderConfig() {
      const year = configState.year;
      const draft = configDraft(year);
      const lastYear = new Date().getFullYear();
      document.querySelector('#year-settings-title').textContent = `${year} configuration`;
      document.querySelector('#config-years').innerHTML = Array.from({ length: lastYear - FIRST_YEAR + 1 }, (_, offset) => lastYear - offset).map(value => {
        const summary = configState.drafts[value] || draftFromSettings(value);
        return `<button type="button" class="config-year${value === year ? ' is-active' : ''}${summary.dirty ? ' is-dirty' : ''}" data-config-year="${value}" aria-pressed="${value === year}"><strong>${value}</strong><span>${summary.currencies.join(' · ') || 'No currency'}</span><span>${summary.sections.length} section${summary.sections.length === 1 ? '' : 's'}</span></button>`;
      }).join('');
      const others = Array.from({ length: lastYear - FIRST_YEAR + 1 }, (_, offset) => lastYear - offset).filter(value => value !== year);
      document.querySelector('#config-copy').innerHTML = `<option value="">Copy from…</option>${others.map(value => `<option value="${value}">${value} setup</option>`).join('')}`;
      document.querySelector('#config-copy').hidden = !others.length;
      const currencySlot = document.querySelector('#config-currencies');
      currencySlot.replaceChildren(chipInput({
        values: draft.currencies,
        label: 'Currencies',
        placeholder: 'Add INR or JPY',
        allowed: Object.values(regions).map(region => region.code),
        countFor: code => usageCount(year, item => item.property === CODE_TO_PROPERTY[code]),
        onChange: () => { markConfigDirty(); renderConfigMoney(); }
      }));
      renderConfigMoney();
      renderConfigSections();
      document.querySelector('#year-settings-error').hidden = true;
    }
    function openYearSettings(year) {
      const dialog = document.querySelector('#year-settings-dialog');
      if (!dialog) return;
      configState.year = year;
      configState.drafts = {};
      renderConfig();
      dialog.showModal();
    }
    function validateDraft(draft) {
      const names = draft.sections.map(section => section.name.trim().toLowerCase());
      if (!draft.currencies.length) return 'Add at least one currency.';
      const amounts = draft.currencies.map(code => draft.openings[CODE_TO_PROPERTY[code]]);
      if (amounts.some(value => String(value).trim() !== '' && !Number.isFinite(Number(value)))) return 'Opening balance must be a number.';
      if (!draft.sections.length) return 'Add at least one section.';
      if (names.some(name => !name)) return 'Every section needs a name.';
      if (new Set(names).size !== names.length) return 'Section names must be unique.';
      const bare = draft.sections.find(section => !section.subsections.length);
      if (bare) return `Add at least one subsection to "${bare.name}".`;
      return '';
    }
    function setupYearConfig() {
      const dialog = document.querySelector('#year-settings-dialog');
      const form = document.querySelector('#year-settings-form');
      if (!dialog || !form) return;
      document.querySelector('#config-years').addEventListener('click', event => {
        const button = event.target.closest('[data-config-year]');
        if (!button) return;
        configState.year = Number(button.dataset.configYear);
        renderConfig();
      });
      document.querySelector('#config-copy').addEventListener('change', event => {
        const from = Number(event.target.value);
        if (!from) return;
        const copy = draftFromSettings(from, { ...yearSettings(from), openings: undefined });
        const draft = configDraft(configState.year);
        Object.assign(draft, { currencies: copy.currencies, sections: copy.sections.map(section => ({ ...section, originalName: null })) });
        markConfigDirty();
        renderConfig();
        showToast(`Copied the ${from} setup. Review and save.`);
      });
      form.addEventListener('input', event => {
        const draft = configDraft(configState.year);
        const money = event.target.closest('[data-config-money]');
        if (money) draft[money.dataset.configMoney][money.dataset.property] = money.value;
        const name = event.target.closest('.config-section-name');
        if (name) draft.sections[Number(name.dataset.sectionIndex)].name = name.value;
        if (money || name) markConfigDirty();
      });
      form.addEventListener('click', event => {
        const draft = configDraft(configState.year);
        const box = event.target.closest('.config-section');
        const typeButton = event.target.closest('[data-section-type]');
        if (typeButton && box) {
          draft.sections[Number(box.dataset.sectionIndex)].type = typeButton.dataset.sectionType;
          markConfigDirty();
          renderConfigSections();
        }
        if (event.target.closest('[data-remove-section]') && box) {
          draft.sections.splice(Number(box.dataset.sectionIndex), 1);
          markConfigDirty();
          renderConfigSections();
        }
        if (event.target.closest('#config-add-section')) {
          draft.sections.push({ name: '', originalName: null, type: 'expense', subsections: [] });
          markConfigDirty();
          renderConfigSections();
          document.querySelector('#config-sections .config-section:last-child .config-section-name')?.focus();
        }
        if (event.target.closest('[data-config-carry]')) {
          draft.currencies.forEach(code => {
            const property = CODE_TO_PROPERTY[code];
            draft.openings[property] = toMajor(closingBalance(configState.year - 1, property, 11));
          });
          markConfigDirty();
          renderConfigMoney();
        }
      });
      // Enter inside a plain field should not save the whole dialog by accident.
      form.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target.matches('input:not(.chip-input input)')) event.preventDefault();
      });
      form.addEventListener('submit', event => {
        event.preventDefault();
        const error = document.querySelector('#year-settings-error');
        const touched = Object.entries(configState.drafts).filter(([, draft]) => draft.dirty);
        for (const [year, draft] of touched) {
          const problem = validateDraft(draft);
          if (problem) {
            configState.year = Number(year);
            renderConfig();
            error.textContent = `${year}: ${problem}`;
            error.hidden = false;
            return;
          }
        }
        const previous = JSON.stringify(yearSettingsByYear);
        const previousTransactions = JSON.stringify(transactions);
        touched.forEach(([year, draft]) => {
          const properties = draft.currencies.map(code => CODE_TO_PROPERTY[code]);
          const sections = draft.sections.map(section => ({ name: section.name.trim(), type: section.type, subsections: [...section.subsections] }));
          // Keep existing entries attached to a renamed section.
          draft.sections.forEach((section, index) => {
            if (!section.originalName || section.originalName === sections[index].name) return;
            transactions.forEach(item => { if (item.date.startsWith(`${year}-`) && item.section === section.originalName) item.section = sections[index].name; });
          });
          yearSettingsByYear[year] = {
            currencies: properties,
            sections,
            openings: Object.fromEntries(properties.map(property => [property, Math.round(Number(draft.openings[property] || 0) * 100)])),
            // Budgets are no longer edited here; keep any saved value so the overview page is unchanged.
            budgets: yearSettingsByYear[year]?.budgets
          };
        });
        try {
          saveYearSettings();
          if (touched.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
        } catch (saveError) {
          console.error('Could not save year settings.', saveError);
          Object.keys(yearSettingsByYear).forEach(key => delete yearSettingsByYear[key]);
          Object.assign(yearSettingsByYear, JSON.parse(previous));
          transactions = JSON.parse(previousTransactions);
          store.replaceTransactions(transactions);
          error.textContent = 'Could not save these settings in this browser.';
          error.hidden = false;
          return;
        }
        dialog.close();
        render();
        document.querySelector('#entry-date')?.dispatchEvent(new Event('change'));
        showToast(touched.length ? `Saved ${touched.map(([year]) => year).join(' & ')} configuration.` : 'No changes to save.');
      });
    }
    setupYearConfig();
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
        sessionStorage.removeItem(`${STORAGE_KEY}-universe`);
        sessionStorage.removeItem(`${STORAGE_KEY}-open-months`);
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
    document.querySelector('#add-button')?.addEventListener('click', () => openEntryDialog());
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
