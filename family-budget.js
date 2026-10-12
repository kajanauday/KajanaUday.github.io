const STORAGE_KEY = 'family-budget-static-demo-v1';
    // Data now lives in Firebase; drop the copy older builds kept in this browser.
    try { [STORAGE_KEY, `${STORAGE_KEY}-year-settings`].forEach(key => localStorage.removeItem(key)); } catch (error) { /* Nothing to clean up. */ }
    (async () => {
    let store;
    try {
      store = await ExpenseStore.open({ databaseURL: FIREBASE_CONFIG.databaseURL, root: FIREBASE_ROOT });
    } catch (error) {
      console.error('Could not load data from Firebase.', error);
      const saveState = document.querySelector('.save-state');
      if (saveState) saveState.textContent = 'Could not load data from Firebase';
      return;
    }
    // Currencies, years and months all come from Firebase; entries are fetched per month as they are needed.
    const regions = store.currencies;
    const { MONTH_NAMES } = ExpenseStore;
    const transactions = store.transactions;
    // Start on the remembered month, else today's, else the newest month Firebase has.
    let currentMonth = (() => {
      const today = new Date();
      const savedMonth = sessionStorage.getItem(`${STORAGE_KEY}-month`);
      if (savedMonth && /^\d{4}-\d{2}$/.test(savedMonth)) {
        const [year, month] = savedMonth.split('-').map(Number);
        if (store.monthNode(year, month - 1)) return new Date(year, month - 1, 1);
      }
      if (store.monthNode(today.getFullYear(), today.getMonth())) return new Date(today.getFullYear(), today.getMonth(), 1);
      const latest = Number(store.yearIds().pop());
      return latest ? new Date(latest, latest < today.getFullYear() ? 11 : 0, 1) : new Date(today.getFullYear(), today.getMonth(), 1);
    })();
    let toastTimer;
    let universeOpen = sessionStorage.getItem(`${STORAGE_KEY}-universe`) === 'true';

    function saveTransactions() { trackSave(store.saveTransactions()); }
    function saveYearConfig(year, config = {}) { trackSave(store.saveYear(year, config)); }
    function activeCurrencies(date = currentMonth) { return store.monthCurrencies(date.getFullYear(), date.getMonth()); }
    function trackSave(write) {
      const saveState = document.querySelector('.save-state');
      if (saveState) saveState.textContent = 'Saving…';
      write.then(() => {
        if (saveState) saveState.innerHTML = '<span class="save-dot"></span> All changes saved';
      }).catch(error => {
        console.error('Could not save to Firebase.', error);
        if (saveState) saveState.textContent = 'Could not save to Firebase';
        showToast('Could not save to Firebase. Check your connection and try again.');
      });
    }
    function monthKey(date = currentMonth) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }
    function monthTransactions(property = null) {
      const key = monthKey();
      return transactions.filter(item => item.date.startsWith(key) && (!property || item.property === property));
    }
    const localeOf = property => regions[property]?.locale || 'en-US';
    function formatMoney(minor, property) {
      const value = Number(minor || 0) / 100;
      const formatted = new Intl.NumberFormat(localeOf(property), { maximumFractionDigits: 0 }).format(Math.abs(value));
      return `${value < 0 ? '-' : ''}${formatted}`;
    }
    // Short form for dense cells: 1.33L / 40.8K for INR, 300K / 1.2M for JPY. Full value stays in titles and the ledger.
    // Suffixes are fixed here because browsers disagree on Intl compact labels for en-IN (some print "T" for thousand).
    function compactMoney(minor, property) {
      const value = Math.abs(Number(minor || 0) / 100);
      const steps = localeOf(property) === 'en-IN' ? [[1e7, 'Cr'], [1e5, 'L'], [1e3, 'K']] : [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
      const [size, suffix] = steps.find(([limit]) => value >= limit) || [1, ''];
      const digits = suffix === 'L' || suffix === 'Cr' ? 2 : suffix && value / size < 100 ? 1 : 0;
      return `${minor < 0 ? '−' : ''}${new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value / size)}${suffix}`;
    }
    function signedMoney(minor, property, format = formatMoney) {
      return `${minor > 0 ? '+' : minor < 0 ? '−' : ''}${format(Math.abs(minor), property)}`;
    }
    function monthLabel(date = currentMonth) {
      return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    }
    function dayLabel(date) {
      return new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    }
    function iconFor(category, type) { return ExpenseStore.iconFor(category, type); }
    // Card figures are the month's stored metadata; only the recent-activity list needs the month's entries.
    function propertyStats(property) {
      const totals = store.monthTotals(currentMonth.getFullYear(), currentMonth.getMonth(), property);
      return { items: monthTransactions(property).filter(item => !item.parentId), income: totals.income, expense: totals.expenses, balance: totals.closing };
    }
    function renderRecent(property) {
      const items = propertyStats(property).items.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, 5);
      if (!items.length) return '<p class="transaction-meta">No activity this month yet.</p>';
      return items.map(item => `<div class="transaction-row"><span class="transaction-icon"><i class="ti ${iconFor(item.category, item.type)}" aria-hidden="true"></i></span><div class="transaction-copy"><p class="transaction-title">${escapeHtml(item.description)}</p><span class="transaction-meta">${item.section ? `${escapeHtml(item.section)} · ` : ''}${escapeHtml(item.category)} · ${dayLabel(item.date)}</span></div><span class="transaction-amount ${item.type}">${item.type === 'expense' ? '−' : '+'}${formatMoney(item.amount, property)}</span></div>`).join('');
    }
    function propertyCard(property) {
      const budget = store.budgetFor(property);
      const stats = propertyStats(property);
      const spentPercent = budget ? Math.min(100, stats.expense / budget * 100) : 0;
      return LedgerBlueprints.PropertyCard({ region: regions[property], property, stats, budget, spentPercent, recentHtml: renderRecent(property) }, { fmt: formatMoney });
    }
    // Overview: one card per currency active this month. Country pages: their own currency, or a note when it is not active.
    function renderProperties() {
      const active = activeCurrencies();
      const grid = document.querySelector('#property-grid');
      if (grid) {
        grid.innerHTML = active.map(property => `<article class="property-card ${regions[property].color}" id="property-${property}" data-property="${property}">${propertyCard(property)}</article>`).join('')
          || `<p class="transaction-meta">No currency is active in ${monthLabel()}.</p>`;
      }
      document.querySelectorAll('.property-card[data-currency]').forEach(target => {
        const property = target.dataset.currency;
        const title = document.querySelector('#property-title');
        if (title && regions[property]) title.textContent = regions[property].name;
        target.classList.add(regions[property]?.color || property);
        target.innerHTML = active.includes(property) ? propertyCard(property) : `<p class="transaction-meta" style="padding:20px">${escapeHtml(regions[property]?.code || property)} is not active in ${monthLabel()}.</p>`;
      });
    }
    // Overview footer: the month's biggest expense categories and a few headline figures, per active currency.
    function renderOverviewPanels() {
      const spend = document.querySelector('#overview-spend');
      const glance = document.querySelector('#overview-glance');
      if (!spend || !glance) return;
      const year = currentMonth.getFullYear();
      const month = currentMonth.getMonth();
      const active = activeCurrencies();
      const none = `<p class="transaction-meta">No currency is active in ${monthLabel()}.</p>`;
      spend.innerHTML = active.map(property => {
        const region = regions[property];
        const { expense } = propertyStats(property);
        const rows = categoryTotals(property).slice(0, 5);
        const body = !store.isLoaded(year, month) ? '<p class="transaction-meta">Loading entries…</p>'
          : rows.map(([name, amount]) => `<div class="spend-row"><span>${escapeHtml(name)}</span><div class="spend-bar"><i class="${region.color}" style="width:${expense ? Math.max(2, amount / expense * 100) : 0}%"></i></div><strong>${formatMoney(amount, property)}</strong></div>`).join('')
            || '<p class="transaction-meta">No expenses recorded.</p>';
        return `<div class="spend-group"><div class="spend-head"><span class="property-dot ${region.color}"></span><strong>${escapeHtml(region.name)}</strong><span>${formatMoney(expense, property)} ${escapeHtml(region.code)}</span></div>${body}</div>`;
      }).join('') || none;
      glance.innerHTML = active.map(property => {
        const region = regions[property];
        const stats = propertyStats(property);
        const budget = store.budgetFor(property);
        const left = budget - stats.expense;
        const saved = stats.income ? Math.round((stats.income - stats.expense) / stats.income * 100) : null;
        const entries = store.monthTotals(year, month, property).entries;
        return `<div class="glance-row"><div class="glance-name"><span class="property-dot ${region.color}"></span><strong>${escapeHtml(region.code)}</strong></div><dl><div><dt>Saved</dt><dd class="${saved > 0 ? 'income' : saved < 0 ? 'expense' : ''}">${saved === null ? '—' : `${saved}%`}</dd></div><div><dt>Budget left</dt><dd class="${left < 0 ? 'expense' : ''}">${formatMoney(left, property)}</dd></div><div><dt>Balance</dt><dd>${formatMoney(stats.balance, property)}</dd></div><div><dt>Entries</dt><dd>${entries}</dd></div></dl></div>`;
      }).join('') || none;
    }
    function renderTransactions() {
      const searchInput = document.querySelector('#transaction-search');
      const propertyFilter = document.querySelector('#property-filter');
      const rows = document.querySelector('#activity-rows');
      if (!searchInput || !propertyFilter || !rows) return;
      const search = searchInput.value.trim().toLowerCase();
      const active = activeCurrencies();
      const options = ['all', ...active];
      if ([...propertyFilter.options].map(option => option.value).join() !== options.join()) {
        const previous = propertyFilter.value;
        propertyFilter.replaceChildren(new Option('All properties', 'all'), ...active.map(key => new Option(`${regions[key].name} · ${regions[key].code}`, key)));
        propertyFilter.value = options.includes(previous) ? previous : 'all';
      }
      const property = propertyFilter.value;
      const items = monthTransactions().filter(item => (property === 'all' || item.property === property) && `${item.description} ${item.section || ''} ${item.category} ${regions[item.property].name}`.toLowerCase().includes(search)).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
      document.querySelector('#transaction-count').textContent = `${items.length} ${items.length === 1 ? 'entry' : 'entries'}`;
      rows.innerHTML = items.length ? items.map(item => `<tr><td>${dayLabel(item.date)}</td><td><strong>${escapeHtml(item.description)}</strong></td><td><span class="property-pill" title="${escapeHtml(regions[item.property].name)}"><span class="property-dot ${regions[item.property].color}"></span>${escapeHtml(regions[item.property].code)}</span></td><td>${item.section ? `${escapeHtml(item.section)} · ` : ''}${escapeHtml(item.category)}</td><td class="amount-cell ${item.type}">${item.type === 'expense' ? '−' : '+'}${formatMoney(item.amount, item.property)}</td></tr>`).join('') : `<tr><td colspan="5" style="padding:24px 12px;color:#777e75">${store.isLoaded(currentMonth.getFullYear(), currentMonth.getMonth()) ? 'No transactions match this month and filter.' : 'Loading entries…'}</td></tr>`;
    }
    function categoryTotals(property) {
      const totals = new Map();
      monthTransactions(property).filter(item => item.type === 'expense' && !item.parentId).forEach(item => totals.set(item.category, (totals.get(item.category) || 0) + store.entryTotal(item.id)));
      return [...totals.entries()].sort((a, b) => b[1] - a[1]);
    }
    // ---- Monthly ledger (months.html) ----
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
      fmt: formatMoney, compact: compactMoney, signed: signedMoney, esc: escapeHtml, dayLabel, keyOf, catKey, monthLabel, regions,
      netClass: minor => (minor > 0 ? 'income' : minor < 0 ? 'expense' : '')
    });
    function renderYearKpis(year) { return ledgerRenderer.yearKpis(year); }
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
      host.innerHTML = store.year(year) ? renderMonthGroups(year) : '<p class="ledger-none">No years in Firebase yet. Add one from Year settings.</p>';
      host.querySelectorAll('.ledger-cat').forEach(cat => { if (keepOpen.includes(cat.dataset.key) || cat.dataset.key === revealKey) cat.open = true; });
      revealKey = null;
      host.querySelector('[data-ledger-form="subsection"]')?.elements.name.focus();
      host.querySelector('[data-ledger-form="entry"], [data-ledger-form="sub-entry"]')?.elements.day.focus();
      document.querySelector('#year-settings-button').dataset.year = year;
      document.body.classList.toggle('show-universe', universeOpen);
      const universe = document.querySelector('#universe');
      universe.inert = !universeOpen;
      universe.setAttribute('aria-hidden', String(!universeOpen));
      loadOpenMonths(year);
    }
    // Open months show "Loading entries…" until their entries arrive from Firebase, then the ledger repaints.
    function loadOpenMonths(year) {
      const pending = [...expandedMonths]
        .filter(key => key.startsWith(`${year}-`))
        .map(key => Number(key.slice(5, 7)) - 1)
        .filter(month => store.monthNode(year, month) && !store.isLoaded(year, month));
      if (!pending.length) return;
      Promise.all(pending.map(month => store.ensureMonth(year, month))).then(renderLedger, error => {
        console.error('Could not load entries from Firebase.', error);
        showToast('Could not load entries from Firebase.');
      });
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
        const latest = ledgerRenderer.months(year).filter(month => store.monthNode(year, month).metadata.entries).pop();
        if (latest !== undefined) expandedMonths.add(keyOf(year, latest));
        saveExpandedMonths();
      }
      ledgerDraft = null;
      renderLedger();
    }
    function saveDraftSubsection(form) {
      const input = form.elements.name;
      const name = input.value.trim().replace(/\s+/g, ' ');
      const hint = form.querySelector('.ledger-form-hint');
      const draftYear = Number(ledgerDraft.month.slice(0, 4));
      const section = store.sections(draftYear).find(item => item.name === ledgerDraft.section);
      const problem = !name ? 'Type a name first.' : !section ? 'This section is no longer configured.' : section.subsections.some(existing => existing.toLowerCase() === name.toLowerCase()) ? `"${name}" already exists in ${section.name}.` : '';
      if (problem) {
        hint.textContent = problem;
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      section.subsections.push(name);
      saveYearConfig(draftYear);
      // Go straight to the first entry for the new subsection.
      const { month, property } = ledgerDraft;
      ledgerDraft = null;
      entryDraft = { month, property, section: section.name, type: section.type, category: name };
      revealKey = catKey(month, property, section.type, name);
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
      revealKey = catKey(month, property, type, category);
      renderLedger();
      showToast(`Saved to ${category}.`);
    }
    function setupLedger() {
      const ledger = document.querySelector('#ledger');
      if (!ledger) return;
      // Adding works by a 1.5s hold or a double-click. A hold re-renders under the pointer, so the click that
      // follows it is swallowed; a double-click is two clicks on the same row within DOUBLE_CLICK_MS.
      let longPressFired = false;
      let suppressClickUntil = 0;
      let lastClick = { key: null, time: 0 };
      const DOUBLE_CLICK_MS = 400;
      const addKeyFor = target => {
        const el = getElement(target);
        if (!el || el.closest('form')) return null;
        const entryCell = el.closest('.ledger-entry-cell:not(.ledger-sub-entry)');
        const toggle = entryCell?.querySelector('[data-toggle-entry]');
        if (toggle) return `entry:${toggle.dataset.entryId}`;
        const cat = el.closest('.ledger-cat > summary');
        if (cat) return `cat:${cat.parentElement.dataset.key}`;
        const type = el.closest('.ledger-type-section > summary');
        if (type) return `type:${type.closest('.month-block')?.dataset.monthKey}|${type.closest('.ledger-panel')?.className}|${type.querySelector('strong')?.textContent}`;
        return null;
      };
      ledger.addEventListener('click', event => {
        // The click released from a hold must not toggle the row that was just re-rendered. Enter-to-submit
        // synthesises a click on the form's button, so clicks inside forms are never swallowed.
        if (Date.now() < suppressClickUntil && !event.target.closest('form')) {
          suppressClickUntil = 0;
          return event.preventDefault();
        }
        const addKey = addKeyFor(event.target);
        if (addKey) {
          const isDouble = lastClick.key === addKey && Date.now() - lastClick.time < DOUBLE_CLICK_MS;
          lastClick = isDouble ? { key: null, time: 0 } : { key: addKey, time: Date.now() };
          if (isDouble) {
            event.preventDefault();
            return triggerLongPress(event.target);
          }
        }
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
      const LONG_PRESS_DURATION = 1500;
      const LONG_PRESS_MOVE_THRESHOLD = 10;

      const getElement = (target) => {
        while (target && target.nodeType === Node.TEXT_NODE) {
          target = target.parentElement;
        }
        return target;
      };

      // Opens the inline add form for whatever was pressed: an entry → sub-entry, a category → entry,
      // an Income/Expenses header → subsection. Month and currency come from the pressed panel, not the page state.
      const triggerLongPress = (element) => {
        element = getElement(element);
        if (!element || element.closest('form')) return false;
        const panel = element.closest('.ledger-panel');
        const monthBlock = element.closest('.month-block');
        if (!panel || !monthBlock) return false;
        const property = panel.dataset.property;
        const mKey = monthBlock.dataset.monthKey;
        const sections = store.sections(Number(mKey.slice(0, 4)));
        if (ledgerDraft || entryDraft || subEntryDraftParentId) {
          showToast('Save or cancel the current inline edit first.');
          return true;
        }
        const entryCell = element.closest('.ledger-entry-cell:not(.ledger-sub-entry)');
        const toggle = entryCell?.querySelector('[data-toggle-entry]');
        const cat = element.closest('.ledger-cat');
        const typeSection = element.closest('.ledger-type-section');
        const type = typeSection?.querySelector('summary strong')?.textContent.trim() === 'Income' ? 'income' : 'expense';

        if (toggle) {
          const entryId = toggle.dataset.entryId;
          subEntryDraftParentId = entryId;
          expandedEntries.add(entryId);
          renderLedger();
          showToast('Add a sub-entry below.');
          return true;
        }
        if (cat && typeSection) {
          const categoryName = cat.querySelector('.ledger-cat-name').textContent.trim();
          const candidates = sections.filter(item => item.type === type);
          const section = candidates.find(item => item.subsections.includes(categoryName)) || candidates[0];
          if (!section) {
            showToast('Configure a section for this year first.');
            return true;
          }
          entryDraft = { month: mKey, property, section: section.name, type, category: categoryName };
          revealKey = catKey(mKey, property, type, categoryName);
          renderLedger();
          showToast(`Add an entry to ${categoryName}.`);
          return true;
        }
        if (typeSection) {
          const section = sections.find(item => item.type === type);
          if (!section) {
            showToast('Configure a section for this year first.');
            return true;
          }
          ledgerDraft = { month: mKey, property, section: section.name };
          renderLedger();
          showToast(`Add a subsection to ${section.name}.`);
          return true;
        }
        return false;
      };

      const pointOf = e => e.touches?.[0] ?? e;
      const startLongPress = (target, e) => {
        suppressClickUntil = 0; // a new press means the previous press's click has happened or never will
        longPressFired = false;
        longPressTarget = getElement(target);
        longPressStart = { x: pointOf(e).pageX, y: pointOf(e).pageY };
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          longPressFired = triggerLongPress(longPressTarget);
        }, LONG_PRESS_DURATION);
      };

      const endLongPress = () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        if (longPressFired) {
          suppressClickUntil = Date.now() + 400;
          longPressFired = false;
        }
        longPressTarget = null;
        longPressStart = null;
      };

      const checkLongPressMove = (e) => {
        if (!longPressTimer || !longPressStart) return;
        const dx = Math.abs(pointOf(e).pageX - longPressStart.x);
        const dy = Math.abs(pointOf(e).pageY - longPressStart.y);
        if (dx > LONG_PRESS_MOVE_THRESHOLD || dy > LONG_PRESS_MOVE_THRESHOLD) {
          endLongPress();
        }
      };

      ledger.addEventListener('touchstart', (e) => {
        startLongPress(e.target, e);
      });

      // After a touch the browser replays mousedown/mouseup/click; ignore that replay so it neither starts a
      // second hold nor clears the click suppression.
      let lastTouchEnd = 0;
      const endTouch = () => {
        lastTouchEnd = Date.now();
        endLongPress();
      };
      ledger.addEventListener('touchend', endTouch);
      ledger.addEventListener('touchmove', (e) => {
        checkLongPressMove(e);
      });
      ledger.addEventListener('touchcancel', endTouch);

      ledger.addEventListener('mousedown', (e) => {
        if (e.button === 0 && Date.now() - lastTouchEnd > 500) startLongPress(e.target, e);
      });

      ledger.addEventListener('mouseup', endLongPress);
      ledger.addEventListener('mousemove', (e) => {
        checkLongPressMove(e);
      });
      // Android raises the context menu mid-hold and cancels the touch; keep the hold alive.
      ledger.addEventListener('contextmenu', (e) => {
        if (longPressTimer || longPressFired || Date.now() < suppressClickUntil) e.preventDefault();
      });

      document.querySelector('#year-settings-button').addEventListener('click', event => openYearSettings(Number(event.currentTarget.dataset.year)));
    }
    function renderBudgets() {
      const panels = document.querySelector('#budget-panels');
      if (!panels) return;
      panels.innerHTML = activeCurrencies().map(property => {
        const region = regions[property];
        const budget = store.budgetFor(property);
        const stats = propertyStats(property);
        const categories = categoryTotals(property);
        const remainder = Math.max(0, budget - stats.expense);
        return `<section class="surface-panel"><div class="panel-title-row"><h2><span class="property-dot ${region.color}" style="display:inline-block;margin-right:7px"></span>${region.name} · ${region.code}</h2><span>${monthLabel()}</span></div><div class="category-budget">${categories.map(([name, amount]) => { const percent = budget ? Math.min(100, amount / budget * 100) : 0; return `<div class="category-budget-row"><div class="category-budget-top"><strong>${escapeHtml(name)}</strong><span>${formatMoney(amount, property)} · ${Math.round(percent)}%</span></div><div class="progress-track"><div class="progress-fill" style="width:${percent}%;background:var(--${region.color})"></div></div></div>`; }).join('') || '<p class="transaction-meta">No expenses recorded for this month.</p>'}</div><div class="budget-foot"><span>Monthly limit</span><strong>${formatMoney(budget, property)}</strong></div><div class="budget-foot"><span>Remaining</span><strong>${formatMoney(remainder, property)}</strong></div></section>`;
      }).join('') || `<p class="transaction-meta">No currency is active in ${monthLabel()}.</p>`;
    }
    function renderInsights() {
      const panels = document.querySelector('#insight-panels');
      if (!panels) return;
      panels.innerHTML = activeCurrencies().map(property => {
        const region = regions[property];
        const stats = propertyStats(property);
        const topCategory = categoryTotals(property)[0];
        const rate = stats.income ? Math.round((stats.income - stats.expense) / stats.income * 100) : 0;
        return `<section class="surface-panel"><div class="panel-title-row"><h2>${region.name} household</h2><span>${region.code}</span></div><div class="insight-stat"><span>Income this month</span><strong style="color:var(--income)">${formatMoney(stats.income, property)}</strong><small>Recorded in ${monthLabel()}</small></div><div class="insight-stat"><span>Expenses this month</span><strong style="color:var(--expense)">${formatMoney(stats.expense, property)}</strong><small>${stats.income ? `${rate}% of income retained` : 'No income recorded yet'}</small></div><div class="insight-stat"><span>Largest category</span><strong>${topCategory ? escapeHtml(topCategory[0]) : 'No activity'}</strong><small>${topCategory ? formatMoney(topCategory[1], property) : 'Add activity to see patterns'}</small></div></section>`;
      }).join('') || `<p class="transaction-meta">No currency is active in ${monthLabel()}.</p>`;
    }
    function render() {
      document.querySelectorAll('.month-label').forEach(el => { el.textContent = monthLabel(); });
      document.querySelectorAll('.month-label-copy').forEach(el => el.textContent = monthLabel());
      renderProperties();
      renderOverviewPanels();
      renderTransactions();
      renderBudgets();
      renderInsights();
      renderLedger();
    }
    // Pages other than the ledger paint from metadata first, then repaint once the month's entries arrive.
    function refresh() {
      render();
      const year = currentMonth.getFullYear();
      const month = currentMonth.getMonth();
      if (document.querySelector('#ledger') || !store.monthNode(year, month) || store.isLoaded(year, month)) return;
      store.ensureMonth(year, month).then(render, error => {
        console.error('Could not load entries from Firebase.', error);
        showToast('Could not load entries from Firebase.');
      });
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
        const date = dateInput.value ? new Date(`${dateInput.value}T12:00:00`) : currentMonth;
        const currencies = activeCurrencies(date);
        const previousProperty = propertySelect.value;
        propertySelect.replaceChildren(...currencies.map(property => new Option(`${regions[property].name} · ${regions[property].code}`, property)));
        if (currencies.includes(previousProperty)) propertySelect.value = previousProperty;
        const previousSection = sectionSelect.value;
        const matchingSections = store.sections(date.getFullYear()).filter(section => section.type === typeSelect.value);
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
          || '<span class="segment-empty">Nothing configured for this month</span>';
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
    // A year's currencies are { <cur>: { from: <month name>, opening } }; a currency is active from its `from` month to December.
    const configState = { year: null, drafts: {} };
    const toMajor = minor => String(Math.round(Number(minor || 0) / 100));
    function draftFromYear(year) {
      const node = store.year(year);
      return {
        dirty: false,
        from: Object.fromEntries(store.currencyKeys().map(key => [key, node?.currencies[key]?.from || ''])),
        openings: Object.fromEntries(store.currencyKeys().map(key => [key, toMajor(node?.currencies[key]?.opening)])),
        sections: (node?.sections || []).map(section => ({ name: section.name, originalName: section.name, type: section.type, subsections: [...section.subsections] }))
      };
    }
    function configDraft(year) {
      configState.drafts[year] ||= draftFromYear(year);
      return configState.drafts[year];
    }
    const draftCurrencies = draft => store.currencyKeys().filter(key => draft.from[key]);
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
    function renderConfigCurrencies() {
      const draft = configDraft(configState.year);
      document.querySelector('#config-currencies').innerHTML = store.currencyKeys().map(key => `<label class="money-field"><span>${escapeHtml(regions[key].code)}</span><select data-config-from="${key}" aria-label="${escapeHtml(regions[key].code)} active from"><option value="">Not used</option>${MONTH_NAMES.map(name => `<option value="${name}"${draft.from[key] === name ? ' selected' : ''}>from ${name}</option>`).join('')}</select></label>`).join('')
        || '<span class="config-muted">No currencies in Firebase</span>';
    }
    function renderConfigMoney() {
      const year = configState.year;
      const draft = configDraft(year);
      const properties = draftCurrencies(draft);
      const carry = Boolean(store.year(year - 1));
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
      const years = store.yearIds().map(Number).reverse();
      document.querySelector('#year-settings-title').textContent = year ? `${year} configuration` : 'No years yet';
      document.querySelector('#config-years').innerHTML = years.map(value => {
        const summary = configState.drafts[value] || draftFromYear(value);
        const currencies = draftCurrencies(summary).map(key => `${regions[key].code}${summary.from[key] === 'January' ? '' : ` from ${summary.from[key].slice(0, 3)}`}`);
        return `<button type="button" class="config-year${value === year ? ' is-active' : ''}${summary.dirty ? ' is-dirty' : ''}" data-config-year="${value}" aria-pressed="${value === year}"><strong>${value}</strong><span>${currencies.join(' · ') || 'No currency'}</span><span>${summary.sections.length} section${summary.sections.length === 1 ? '' : 's'}</span></button>`;
      }).join('') + `<button type="button" class="config-year" id="config-add-year" title="Add the next year to Firebase"><strong><i class="ti ti-plus" aria-hidden="true"></i> ${years.length ? years[0] + 1 : new Date().getFullYear()}</strong><span>Add year</span></button>`;
      const others = years.filter(value => value !== year);
      document.querySelector('#config-copy').innerHTML = `<option value="">Copy from…</option>${others.map(value => `<option value="${value}">${value} setup</option>`).join('')}`;
      document.querySelector('#config-copy').hidden = !others.length || !year;
      document.querySelector('.config-body').hidden = !year;
      if (!year) return;
      renderConfigCurrencies();
      renderConfigMoney();
      renderConfigSections();
      document.querySelector('#year-settings-error').hidden = true;
    }
    // Entry counts and section renames need the whole year's entries, so a year is loaded before it is shown here.
    function showConfigYear(year) {
      const ready = store.year(year) ? store.ensureYear(year) : Promise.resolve();
      return ready.then(() => {
        configState.year = store.year(year) ? year : null;
        renderConfig();
      }, error => {
        console.error('Could not load the year from Firebase.', error);
        showToast(`Could not load ${year} from Firebase.`);
      });
    }
    function openYearSettings(year) {
      const dialog = document.querySelector('#year-settings-dialog');
      if (!dialog) return;
      configState.drafts = {};
      showConfigYear(year).then(() => dialog.showModal());
    }
    // A new year copies the latest year's sections and currencies, opening at that year's closing balances.
    function addConfigYear() {
      const years = store.yearIds().map(Number);
      const year = years.length ? Math.max(...years) + 1 : new Date().getFullYear();
      const previous = store.year(year - 1);
      const currencies = Object.fromEntries((previous?.metadata.currencies || []).map(key => [key, { from: 'January', opening: store.yearTotals(year - 1, key).closing }]));
      const sections = (previous?.sections || []).map(section => ({ ...section, subsections: [...section.subsections] }));
      saveYearConfig(year, { currencies, sections });
      showConfigYear(year);
      render();
      showToast(`Added ${year}. Review its currencies and sections.`);
    }
    function validateDraft(draft) {
      const names = draft.sections.map(section => section.name.trim().toLowerCase());
      if (!draftCurrencies(draft).length) return 'Choose a start month for at least one currency.';
      const amounts = draftCurrencies(draft).map(key => draft.openings[key]);
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
        if (event.target.closest('#config-add-year')) return addConfigYear();
        const button = event.target.closest('[data-config-year]');
        if (button) showConfigYear(Number(button.dataset.configYear));
      });
      document.querySelector('#config-copy').addEventListener('change', event => {
        const from = Number(event.target.value);
        if (!from) return;
        const copy = draftFromYear(from);
        const draft = configDraft(configState.year);
        Object.assign(draft, { from: copy.from, sections: copy.sections.map(section => ({ ...section, originalName: null })) });
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
        const from = event.target.closest('[data-config-from]');
        if (from) {
          draft.from[from.dataset.configFrom] = from.value;
          renderConfigMoney();
        }
        if (money || name || from) markConfigDirty();
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
          draftCurrencies(draft).forEach(key => {
            draft.openings[key] = toMajor(store.yearTotals(configState.year - 1, key).closing);
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
        touched.forEach(([year, draft]) => {
          const sections = draft.sections.map(section => ({ name: section.name.trim(), type: section.type, subsections: [...section.subsections] }));
          // Keep existing entries attached to a renamed section.
          draft.sections.forEach((section, index) => {
            if (!section.originalName || section.originalName === sections[index].name) return;
            transactions.forEach(item => { if (item.date.startsWith(`${year}-`) && item.section === section.originalName) item.section = sections[index].name; });
          });
          const currencies = Object.fromEntries(draftCurrencies(draft).map(key => [key, { from: draft.from[key], opening: Math.round(Number(draft.openings[key] || 0) * 100) }]));
          saveYearConfig(Number(year), { currencies, sections });
        });
        if (touched.length) saveTransactions();
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
      const next = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + Number(button.dataset.monthShift), 1);
      if (!store.monthNode(next.getFullYear(), next.getMonth())) return showToast(`${monthLabel(next)} is not set up in Firebase.`);
      currentMonth = next;
      sessionStorage.setItem(`${STORAGE_KEY}-month`, monthKey());
      refresh();
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
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form));
      const amount = Number(values.amount);
      if (!Number.isFinite(amount) || amount <= 0) return;
      const date = new Date(`${values.date}T12:00:00`);
      if (!activeCurrencies(date).includes(values.property)) return showToast(`No currency is set up for ${monthLabel(date)}.`);
      // The month's entries must be loaded first, or saving it would replace what Firebase already holds.
      store.ensureMonth(date.getFullYear(), date.getMonth()).then(() => {
        transactions.push({ id: `new-${Date.now()}`, property: values.property, date: values.date, section: values.section, category: values.category.trim(), description: values.description.trim(), place: values.place.trim(), amount: Math.round(amount * 100), type: values.type });
        saveTransactions();
        form.reset();
        document.querySelector('#transaction-dialog').close();
        render();
        showToast('Transaction added to your activity.');
      }, error => {
        console.error('Could not load the month from Firebase.', error);
        showToast('Could not load that month from Firebase. Try again.');
      });
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
    refresh();
    }
    })();
