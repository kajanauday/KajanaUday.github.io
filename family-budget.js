const STORAGE_KEY = 'family-budget-static-demo-v1';
    // Data now lives in Firebase; drop what older builds kept in this browser.
    try { [STORAGE_KEY, `${STORAGE_KEY}-year-settings`, `${STORAGE_KEY}-view`].forEach(key => localStorage.removeItem(key)); } catch (error) { /* Nothing to clean up. */ }
    if (sessionStorage.getItem(`${STORAGE_KEY}-passkey-signed-in`) !== 'true') window.location.replace('../family-budget-vertical.html');
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
    const yearMonthOf = mKey => [Number(mKey.slice(0, 4)), Number(mKey.slice(5, 7)) - 1];
    function saveMonthSections(mKey, property) {
      const [year, monthIndex] = yearMonthOf(mKey);
      trackSave(store.saveMonthSections(year, monthIndex, property, store.ownSections(year, monthIndex, property)));
    }
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
    // ---- Monthly ledger (months.html) ----
    // Inline ledger drafts: subsection adds and unsaved transaction fields.
    let ledgerDraft = null;
    let entryDraft = null;
    let subEntryDraftParentId = null;
    let editDraft = null; // { kind: 'entry' | 'note', id } or { kind: 'category', month, property, type, category }
    const hasDraft = () => Boolean(ledgerDraft || entryDraft || subEntryDraftParentId || editDraft);
    const expandedEntries = new Set();
    let revealKey = null; // subsection to open on the next render, e.g. the one that just got an entry
    const catKey = (month, property, section, category) => [month, property, section, category].join('|');
    const keyOf = (year, month) => `${year}-${String(month + 1).padStart(2, '0')}`;
    // Months whose ledger is open. A fresh session opens the current month on wider screens; on phones every month
    // starts closed so the whole year's list fits on screen (an open month is several screens tall there).
    const isPhone = () => window.matchMedia('(max-width: 700px)').matches;
    const expandedMonths = new Set(JSON.parse(sessionStorage.getItem(`${STORAGE_KEY}-open-months`) || 'null') || (isPhone() ? [] : [keyOf(new Date().getFullYear(), new Date().getMonth())]));
    function saveExpandedMonths() {
      sessionStorage.setItem(`${STORAGE_KEY}-open-months`, JSON.stringify([...expandedMonths]));
    }
    // The ledger is painted from the ExpenseStore tree by LedgerRenderer using LedgerBlueprints.
    // Inline-edit state lives here and is handed to each render, so blueprints stay pure.
    const renderState = () => ({ expandedEntries, expandedMonths, entryDraft, subEntryDraftParentId, ledgerDraft, editDraft });
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
      const keepOpen = [...host.querySelectorAll('.ledger-cat[open], .ledger-cat.is-editing')].map(cat => cat.dataset.key);
      host.innerHTML = store.year(year) ? renderMonthGroups(year) : '<p class="ledger-none">No years in Firebase yet. Add one from Year settings.</p>';
      host.querySelectorAll('.ledger-cat').forEach(cat => { if (keepOpen.includes(cat.dataset.key) || cat.dataset.key === revealKey) cat.open = true; });
      revealKey = null;
      // Focus an inline form without jumping the page; scroll only as far as needed to show it.
      const focusQuietly = input => {
        if (!input) return;
        input.focus({ preventScroll: true });
        input.closest('form').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };
      focusQuietly(host.querySelector('[data-ledger-form="subsection"]')?.elements.name);
      focusQuietly(host.querySelector('[data-ledger-form="entry"], [data-ledger-form="sub-entry"]')?.elements.day);
      focusQuietly(host.querySelector('[data-ledger-form="edit-entry"], [data-ledger-form="edit-note"]')?.elements.description);
      const rename = host.querySelector('[data-ledger-form="rename-category"]')?.elements.name;
      focusQuietly(rename);
      rename?.select();
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
    // Adds a subsection to this month's own list for this currency; other months keep theirs.
    function saveDraftSubsection(form) {
      const input = form.elements.name;
      const name = input.value.trim().replace(/\s+/g, ' ');
      const hint = form.querySelector('.ledger-form-hint');
      const { month, property } = ledgerDraft;
      const [year, monthIndex] = yearMonthOf(month);
      const problem = !name ? 'Type a name first.' : !store.sections(year, monthIndex, property).some(item => item.name === ledgerDraft.section) ? 'This section is no longer set up for this month.' : '';
      if (problem) {
        hint.textContent = problem;
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      const sections = store.ownSections(year, monthIndex, property);
      const section = sections.find(item => item.name === ledgerDraft.section);
      const existing = sections.filter(item => item.type === section.type).flatMap(item => item.subsections).find(item => item.toLowerCase() === name.toLowerCase());
      const category = existing || name;
      const holder = existing ? sections.find(item => item.type === section.type && item.subsections.includes(existing)) : section;
      if (!existing) section.subsections.push(name);
      saveMonthSections(month, property);
      // Go straight to the first entry for the subsection.
      ledgerDraft = null;
      entryDraft = { month, property, section: holder.name, type: section.type, category };
      revealKey = catKey(month, property, section.type, category);
      renderLedger();
      showToast(existing ? `Add an entry to "${category}".` : `Added "${name}" to ${section.name} for this month.`);
    }
    function saveEntryDraft(form) {
      const fields = form.elements;
      const { month, property, section, type, category } = form.dataset;
      const day = Number(fields.day.value);
      const parsed = ExpenseStore.readAmount(fields.amount.value);
      const amount = parsed.value;
      const checks = [
        [fields.day, Number.isInteger(day) && day >= 1 && day <= Number(fields.day.max)],
        [fields.description, fields.description.value.trim() !== ''],
        [fields.amount, !parsed.error && !parsed.empty && amount > 0]
      ];
      checks.forEach(([input, ok]) => input.toggleAttribute('aria-invalid', !ok));
      const invalid = checks.find(([, ok]) => !ok);
      if (invalid) return invalid[0].focus();
      const date = `${month}-${String(day).padStart(2, '0')}`;
      transactions.push({ id: `new-${Date.now()}`, property, date, section, category, description: fields.description.value.trim(), place: fields.place.value.trim(), amount: Math.round(amount * 100), ...(parsed.formula && { formula: parsed.formula }), type });
      saveTransactions();
      entryDraft = null;
      revealKey = catKey(month, property, type, category);
      renderLedger();
      showToast(`Saved to ${category}.`);
    }
    // Double-click edit of an entry or a note: same day/description/place/amount fields as when it was added.
    function saveEditDraft(form) {
      const item = transactions.find(t => t.id === form.dataset.entryId);
      if (!item) {
        editDraft = null;
        renderLedger();
        return showToast('Could not find that entry. Refresh and try again.');
      }
      const fields = form.elements;
      const isNote = form.dataset.ledgerForm === 'edit-note';
      const day = Number(fields.day.value);
      const parsed = ExpenseStore.readAmount(fields.amount.value);
      const amount = parsed.value;
      const checks = [
        [fields.day, Number.isInteger(day) && day >= 1 && day <= Number(fields.day.max)],
        [fields.description, fields.description.value.trim() !== ''],
        [fields.amount, !parsed.error && !parsed.empty && (isNote ? amount >= 0 : amount > 0)]
      ];
      checks.forEach(([input, ok]) => input.toggleAttribute('aria-invalid', !ok));
      const invalid = checks.find(([, ok]) => !ok);
      if (invalid) return invalid[0].focus();
      Object.assign(item, {
        date: `${item.date.slice(0, 7)}-${String(day).padStart(2, '0')}`,
        description: fields.description.value.trim(),
        place: fields.place.value.trim(),
        amount: Math.round(amount * 100),
        formula: parsed.formula || undefined
      });
      saveTransactions();
      editDraft = null;
      renderLedger();
      showToast(isNote ? 'Note updated.' : 'Entry updated.');
    }
    // Deletes one ledger row and everything under it, limited to the month and currency the row is shown in.
    // Deleting a subsection also takes it off that month's own section list.
    function deleteRow({ deleteRow: kind, entryId, month, property, type, category }) {
      const inRow = {
        note: item => item.id === entryId,
        entry: item => item.id === entryId,
        category: item => !item.parentId && item.date.startsWith(month) && item.property === property && item.type === type && item.category === category
      }[kind];
      const rows = transactions.filter(inRow);
      const [rowYear, rowMonth] = month ? yearMonthOf(month) : [];
      const emptyListed = kind === 'category' && !rows.length && store.sections(rowYear, rowMonth, property).some(section => section.type === type && section.subsections.includes(category));
      if (emptyListed) {
        if (!window.confirm(`Remove the empty subsection "${category}" from ${monthLabel(new Date(rowYear, rowMonth, 1))}?`)) return;
        store.ownSections(rowYear, rowMonth, property).filter(section => section.type === type).forEach(section => {
          section.subsections = section.subsections.filter(name => name !== category);
        });
        saveMonthSections(month, property);
        editDraft = null;
        renderLedger();
        return showToast(`Removed "${category}".`);
      }
      if (!rows.length) {
        editDraft = null;
        renderLedger();
        return showToast('Nothing to delete. Refresh and try again.');
      }
      const ids = new Set(rows.map(item => item.id));
      const doomed = new Set(transactions.filter(item => ids.has(item.id) || ids.has(item.parentId)));
      const notes = [...doomed].filter(item => item.parentId).length;
      const entries = doomed.size - notes;
      const plural = (n, word) => `${n} ${n === 1 ? word : word === 'entry' ? 'entries' : `${word}s`}`;
      const label = {
        note: `the note "${rows[0].description}"`,
        entry: `the entry "${rows[0].description}"`,
        category: `"${category}"`
      }[kind];
      const scope = kind === 'note' ? '' : ` (${plural(entries, 'entry')}${notes ? ` and ${plural(notes, 'note')}` : ''})`;
      const where = kind === 'category' ? ` for ${property.toUpperCase()} in ${monthLabel(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1))}` : '';
      if (!window.confirm(`Delete ${label}${scope}${where}? This cannot be undone.`)) return;
      if (kind === 'category') {
        const [year, monthIndex] = yearMonthOf(month);
        store.ownSections(year, monthIndex, property).filter(section => section.type === type).forEach(section => {
          section.subsections = section.subsections.filter(name => name !== category);
        });
        saveMonthSections(month, property);
      }
      for (let index = transactions.length - 1; index >= 0; index--) {
        if (doomed.has(transactions[index])) transactions.splice(index, 1);
      }
      saveTransactions();
      editDraft = null;
      renderLedger();
      showToast(kind === 'note' ? 'Note deleted.' : `Deleted ${plural(entries, 'entry')}${notes ? ` and ${plural(notes, 'note')}` : ''}.`);
    }
    // Renaming a subsection changes only the month and currency it is shown in: its entries and that month's own list.
    function saveCategoryRename(form) {
      const { month, property, type, category } = form.dataset;
      const input = form.elements.name;
      const hint = form.querySelector('.ledger-form-hint');
      const name = input.value.trim().replace(/\s+/g, ' ');
      const [year, monthIndex] = yearMonthOf(month);
      if (name === category) {
        editDraft = null;
        return renderLedger();
      }
      const inPanel = item => item.date.startsWith(month) && item.property === property && item.type === type;
      const sameName = other => other !== category && other.toLowerCase() === name.toLowerCase();
      const taken = transactions.some(item => inPanel(item) && sameName(item.category));
      const problem = !name ? 'Type a name first.' : taken ? `"${name}" is already used this month.` : '';
      if (problem) {
        hint.textContent = problem;
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      // Copy the month's list before moving entries, so the copy still holds the old name.
      const sections = store.ownSections(year, monthIndex, property).filter(section => section.type === type);
      // Renaming onto an empty subsection already listed merges into it, keeping its spelling and section.
      const target = sections.find(section => section.subsections.some(sameName));
      const finalName = target ? target.subsections.find(sameName) : name;
      const moved = transactions.filter(item => inPanel(item) && item.category === category);
      moved.forEach(item => {
        item.category = finalName;
        if (target) item.section = target.name;
      });
      sections.forEach(section => {
        const index = section.subsections.indexOf(category);
        if (index < 0) return;
        if (target) section.subsections.splice(index, 1);
        else section.subsections[index] = name;
      });
      if (!sections.some(section => section.subsections.includes(finalName))) {
        sections.find(section => section.name === moved[0]?.section)?.subsections.push(finalName);
      }
      saveMonthSections(month, property);
      saveTransactions();
      editDraft = null;
      revealKey = catKey(month, property, type, finalName);
      renderLedger();
      showToast(`Renamed "${category}" to "${finalName}" for this month.`);
    }
    function setupLedger() {
      const ledger = document.querySelector('#ledger');
      if (!ledger) return;
      // A 0.8s hold adds a child (entry → note, subsection → entry, Income/Expenses → subsection); a double-click edits
      // the row itself. A hold re-renders under the pointer, so the click that follows it is swallowed. Rows re-render
      // on the first click, so a double-click is detected as two clicks on the same row within DOUBLE_CLICK_MS.
      let longPressFired = false;
      let suppressClickUntil = 0;
      let lastClick = { key: null, time: 0 };
      let lastMonthClick = { key: null, time: 0 };
      const DOUBLE_CLICK_MS = 400;
      const rowKeyFor = target => {
        const el = getElement(target);
        if (!el || el.closest('form')) return null;
        const note = el.closest('[data-note-id]');
        if (note) return `note:${note.dataset.noteId}`;
        const entryCell = el.closest('.ledger-entry-cell:not(.ledger-sub-entry)');
        const toggle = entryCell?.querySelector('[data-toggle-entry]');
        if (toggle) return `entry:${toggle.dataset.entryId}`;
        const cat = el.closest('.ledger-cat > summary');
        if (cat) return `cat:${cat.parentElement.dataset.key}`;
        const type = el.closest('.ledger-type-section > summary');
        if (type) return `type:${type.closest('.month-block')?.dataset.monthKey}|${type.closest('.ledger-panel')?.className}|${type.querySelector('strong')?.textContent}`;
        return null;
      };
      // Shows or hides an entry's notes in place; no re-render, so a second click lands on the same element.
      const setEntryOpen = (toggle, open) => {
        const entryId = toggle.dataset.entryId;
        if (open) expandedEntries.add(entryId);
        else expandedEntries.delete(entryId);
        toggle.setAttribute('aria-expanded', String(open));
        const notes = toggle.closest('.ledger-entry-cell').querySelector(':scope > .ledger-notes');
        if (notes) notes.hidden = !open;
      };
      ledger.addEventListener('click', event => {
        // The click released from a hold must not toggle the row that was just re-rendered. Enter-to-submit
        // synthesises a click on the form's button, so clicks inside forms are never swallowed.
        if (Date.now() < suppressClickUntil && !event.target.closest('form')) {
          suppressClickUntil = 0;
          return event.preventDefault();
        }
        const deleteButton = event.target.closest('[data-delete-row]');
        if (deleteButton) {
          event.preventDefault();
          return deleteRow(deleteButton.dataset);
        }
        const rowKey = rowKeyFor(event.target);
        if (rowKey) {
          const isDouble = lastClick.key === rowKey && Date.now() - lastClick.time < DOUBLE_CLICK_MS;
          lastClick = isDouble ? { key: null, time: 0 } : { key: rowKey, time: Date.now() };
          if (isDouble) {
            event.preventDefault();
            return triggerEdit(event.target, rowKey);
          }
        }
        // A year tab switches years; the year already shown opens its settings.
        const yearTab = event.target.closest('[data-ledger-year]');
        if (yearTab) {
          const year = Number(yearTab.dataset.ledgerYear);
          return year === currentMonth.getFullYear() ? openYearSettings(year) : selectLedgerYear(year);
        }
        if (event.target.closest('[data-toggle-universe]')) return setUniverse(!universeOpen);
        // A month name opens or closes the month; a double-click undoes that and opens the month's settings instead.
        const eye = event.target.closest('[data-toggle-month]');
        if (eye) {
          const key = eye.dataset.toggleMonth;
          const isDouble = lastMonthClick.key === key && Date.now() - lastMonthClick.time < DOUBLE_CLICK_MS;
          lastMonthClick = isDouble ? { key: null, time: 0 } : { key, time: Date.now() };
          if (expandedMonths.has(key)) expandedMonths.delete(key);
          else expandedMonths.add(key);
          if (isDouble) {
            saveExpandedMonths();
            renderLedger();
            return openMonthSettings(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1);
          }
          saveExpandedMonths();
          if (ledgerDraft?.month === key) ledgerDraft = null;
          if (entryDraft?.month === key) entryDraft = null;
          editDraft = null;
          renderLedger();
          return document.querySelector(`[data-toggle-month="${key}"]`)?.focus();
        }
        const addSub = event.target.closest('[data-add-subsection]');
        const addEntry = event.target.closest('[data-add-entry-row]');
        if (addEntry) event.preventDefault();
        if ((addSub || addEntry) && hasDraft()) {
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
        if (toggleEntry) return setEntryOpen(toggleEntry, !expandedEntries.has(toggleEntry.dataset.entryId));
        if (event.target.closest('[data-cancel-draft]')) {
          ledgerDraft = null;
          return renderLedger();
        }
        if (event.target.closest('[data-cancel-entry]')) {
          entryDraft = null;
          return renderLedger();
        }
        if (event.target.closest('[data-cancel-edit]')) {
          editDraft = null;
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
        if (form.dataset.ledgerForm === 'edit-entry' || form.dataset.ledgerForm === 'edit-note') return saveEditDraft(form);
        if (form.dataset.ledgerForm === 'rename-category') return saveCategoryRename(form);
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
          const parsed = ExpenseStore.readAmount(form.elements.amount.value);
          if (parsed.error || parsed.value < 0) {
            form.elements.amount.setAttribute('aria-invalid', 'true');
            form.elements.amount.focus();
            return showToast('Enter an amount, or a formula like =120+80.');
          }
          const amount = parsed.empty ? 0 : Math.round(parsed.value * 100);
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
            amount,
            ...(parsed.formula && { formula: parsed.formula })
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
          else if (['edit-entry', 'edit-note', 'rename-category'].includes(form.dataset.ledgerForm)) editDraft = null;
          else ledgerDraft = null;
          renderLedger();
          return;
        }

        if (event.key === 'Enter') {
          const isEntryForm = ['entry', 'sub-entry', 'edit-entry', 'edit-note'].includes(form.dataset.ledgerForm);
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
      const LONG_PRESS_DURATION = 800;
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
        const sections = store.sections(...yearMonthOf(mKey), property);
        if (hasDraft()) {
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
          showToast('Add a note below.');
          return true;
        }
        if (cat && typeSection) {
          const categoryName = cat.querySelector('.ledger-cat-name').textContent.trim();
          const candidates = sections.filter(item => item.type === type);
          const section = candidates.find(item => item.subsections.includes(categoryName)) || candidates[0];
          if (!section) {
            showToast('Add a section for this month first: double-click the month name.');
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
            showToast('Add a section for this month first: double-click the month name.');
            return true;
          }
          ledgerDraft = { month: mKey, property, section: section.name };
          renderLedger();
          showToast(`Add a subsection to ${section.name}.`);
          return true;
        }
        return false;
      };

      // Double-click: edit the row in place. Entries and notes get their own fields back; a subsection gets a rename
      // field; Income/Expenses opens the month's settings, where its sections are named.
      const triggerEdit = (element, rowKey) => {
        element = getElement(element);
        const panel = element?.closest('.ledger-panel');
        const monthBlock = element?.closest('.month-block');
        if (!panel || !monthBlock) return;
        if (hasDraft()) return showToast('Save or cancel the current inline edit first.');
        const [kind, ...rest] = rowKey.split(':');
        const id = rest.join(':');
        // The first click of the pair already toggled what was clicked; undo that so a double-click only edits.
        if (kind === 'entry') {
          const toggle = element.closest('.ledger-entry-cell')?.querySelector('[data-toggle-entry]');
          if (toggle) setEntryOpen(toggle, !expandedEntries.has(id));
          editDraft = { kind: 'entry', id };
        } else if (kind === 'note') {
          editDraft = { kind: 'note', id };
        } else if (kind === 'cat') {
          const cat = element.closest('.ledger-cat');
          const type = element.closest('.ledger-type-section')?.querySelector('summary strong')?.textContent.trim().toLowerCase() === 'income' ? 'income' : 'expense';
          editDraft = { kind: 'category', month: monthBlock.dataset.monthKey, property: panel.dataset.property, type, category: cat.querySelector('.ledger-cat-name').textContent.trim() };
        } else {
          const section = element.closest('.ledger-type-section');
          if (section) section.open = !section.open;
          return openMonthSettings(...yearMonthOf(monthBlock.dataset.monthKey));
        }
        renderLedger();
      };

      // The row a hold would add to: an entry (also when pressing one of its notes), a subsection, or Income/Expenses.
      const pressRowFor = target => {
        const el = getElement(target);
        if (!el || el.closest('form')) return null;
        const cell = el.closest('.ledger-entry-cell:not(.ledger-sub-entry)');
        if (cell) return cell.querySelector(':scope > .ledger-entry-line');
        return el.closest('.ledger-cat > summary, .ledger-type-section > summary');
      };
      let pressedRow = null;
      const pointOf = e => e.touches?.[0] ?? e;
      const startLongPress = (target, e) => {
        suppressClickUntil = 0; // a new press means the previous press's click has happened or never will
        longPressFired = false;
        const row = pressRowFor(target);
        if (!row) return;
        longPressTarget = getElement(target);
        longPressStart = { x: pointOf(e).pageX, y: pointOf(e).pageY };
        pressedRow = row;
        row.classList.add('is-pressing');
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          pressedRow?.classList.remove('is-pressing');
          longPressFired = triggerLongPress(longPressTarget);
          if (longPressFired) {
            // The hold re-rendered the row; swallow the click that the release will produce, whenever it comes.
            suppressClickUntil = Infinity;
            navigator.vibrate?.(12);
          }
        }, LONG_PRESS_DURATION);
      };

      const endLongPress = () => {
        pressedRow?.classList.remove('is-pressing');
        pressedRow = null;
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        if (suppressClickUntil === Infinity) suppressClickUntil = Date.now() + 600;
        longPressFired = false;
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
      // second hold nor clears the click suppression. Touch end events go to the element first touched, which a
      // hold has just re-rendered away, so releases are caught as pointer events on the window instead.
      let lastTouchEnd = 0;
      const endPointer = event => {
        if (event.pointerType !== 'mouse') lastTouchEnd = Date.now();
        endLongPress();
      };
      window.addEventListener('pointerup', endPointer);
      window.addEventListener('pointercancel', endPointer);
      ledger.addEventListener('touchmove', (e) => {
        checkLongPressMove(e);
      });

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
    // ---- Month settings: double-click a month name ----
    // Per currency: whether it is used this month, whether the month brings in the previous balance, and the month's own
    // sections. Sections edited here belong to this month only.
    const monthState = { year: null, month: null, setup: null, sections: {}, dirty: new Set() };
    function renderMonthSettings() {
      const { year, month, setup } = monthState;
      document.querySelector('#month-settings-title').textContent = monthLabel(new Date(year, month, 1));
      document.querySelector('#month-currency-rows').innerHTML = store.currencyKeys().map(key => {
        const region = regions[key];
        const { active, carry } = setup[key];
        const totals = store.monthTotals(year, month, key);
        const from = store.carriedFrom(year, month, key);
        const previous = store.monthNode(year, month)?.currencies.includes(key) ? totals.previous : null;
        const amount = previous === null ? 'shown after saving' : `${previous < 0 ? '−' : '+'}${formatMoney(Math.abs(previous), key)} as ${previous < 0 ? 'an expense' : 'income'}`;
        const entries = totals.entries;
        return `<div class="month-currency${active ? '' : ' is-off'}">
          <label class="check-field is-strong"><input type="checkbox" data-month-active="${key}"${active ? ' checked' : ''}${active && entries ? ' disabled' : ''}><span><span class="cur-dot ${region.color}"></span>${escapeHtml(region.code)} · ${escapeHtml(region.name)}${active && entries ? ` <em>${entries} ${entries === 1 ? 'entry' : 'entries'} — remove them to turn ${escapeHtml(region.code)} off</em>` : ''}</span></label>
          ${active ? `<label class="check-field"><input type="checkbox" data-month-carry="${key}"${carry ? ' checked' : ''}><span>Bring in the balance from ${escapeHtml(from)} <em>${escapeHtml(amount)}</em></span></label>` : ''}
        </div>`;
      }).join('');
      renderMonthSections();
      document.querySelector('#month-settings-error').hidden = true;
    }
    function monthSectionsFor(key) {
      const { year, month } = monthState;
      monthState.sections[key] ||= store.sectionsDraft(year, month, key).map(section => ({ ...section, originalName: section.name }));
      return monthState.sections[key];
    }
    function renderMonthSections() {
      const { year, month, setup } = monthState;
      const root = document.querySelector('#month-sections');
      root.replaceChildren();
      const items = key => transactions.filter(item => !item.parentId && item.property === key && item.date.startsWith(keyOf(year, month)));
      store.currencyKeys().filter(key => setup[key].active).forEach(key => {
        const list = monthSectionsFor(key);
        const block = document.createElement('section');
        block.className = 'config-block';
        block.dataset.currency = key;
        block.innerHTML = `<div class="config-block-head"><h3><span class="cur-dot ${regions[key].color}"></span> ${escapeHtml(regions[key].code)} sections</h3><button type="button" class="quiet-button" data-month-add-section><i class="ti ti-plus" aria-hidden="true"></i> Add section</button></div><div class="config-sections"></div>`;
        const holder = block.querySelector('.config-sections');
        list.forEach((section, index) => {
          const box = document.createElement('fieldset');
          box.className = `config-section ${section.type}`;
          box.dataset.sectionIndex = index;
          const entries = items(key).filter(item => item.type === section.type && (item.section === section.originalName || (!item.section && section.subsections.includes(item.category)))).length;
          box.innerHTML = `<div class="config-section-head">
              <input class="config-section-name" value="${escapeHtml(section.name)}" placeholder="Section name" aria-label="Section name" maxlength="40">
              <div class="type-toggle" role="group" aria-label="Section type"><button type="button" data-section-type="expense" aria-pressed="${section.type === 'expense'}">Expense</button><button type="button" data-section-type="income" aria-pressed="${section.type === 'income'}">Income</button></div>
              <span class="config-usage">${entries ? `${entries} ${entries === 1 ? 'entry' : 'entries'}` : ''}</span>
              <button type="button" class="icon-button config-remove" data-remove-section aria-label="Remove section ${escapeHtml(section.name)}" title="Remove section"><i class="ti ti-trash" aria-hidden="true"></i></button>
            </div>
            <div class="kv-row"><span class="kv-key">Subsections</span></div>`;
          box.querySelector('.kv-row').append(chipInput({
            values: section.subsections,
            label: `Subsections of ${section.name || 'section'}`,
            placeholder: 'Type a name, press Enter or comma',
            countFor: name => items(key).filter(item => item.type === section.type && item.category.toLowerCase() === name.toLowerCase()).length,
            onChange: () => monthState.dirty.add(key)
          }));
          holder.append(box);
        });
        if (!list.length) holder.innerHTML = '<p class="config-muted">No sections this month yet. Add one to start categorising entries.</p>';
        root.append(block);
      });
    }
    function openMonthSettings(year, month) {
      if (!store.year(year)) return showToast(`${year} is not set up in Firebase.`);
      // Section usage and the first copy of a month's sections need its entries.
      store.ensureMonth(year, month).then(() => {
        Object.assign(monthState, { year, month, setup: JSON.parse(JSON.stringify(store.monthSetup(year, month))), sections: {}, dirty: new Set() });
        renderMonthSettings();
        document.querySelector('#month-settings-dialog').showModal();
      }, error => {
        console.error('Could not load the month from Firebase.', error);
        showToast('Could not load that month from Firebase.');
      });
    }
    function setupMonthSettings() {
      const dialog = document.querySelector('#month-settings-dialog');
      const form = document.querySelector('#month-settings-form');
      form.addEventListener('change', event => {
        const active = event.target.closest('[data-month-active]');
        if (active) monthState.setup[active.dataset.monthActive].active = active.checked;
        const carry = event.target.closest('[data-month-carry]');
        if (carry) monthState.setup[carry.dataset.monthCarry].carry = carry.checked;
        if (active) renderMonthSettings();
      });
      form.addEventListener('input', event => {
        const name = event.target.closest('.config-section-name');
        const block = event.target.closest('[data-currency]');
        if (!name || !block) return;
        monthSectionsFor(block.dataset.currency)[Number(name.closest('.config-section').dataset.sectionIndex)].name = name.value;
        monthState.dirty.add(block.dataset.currency);
      });
      form.addEventListener('click', event => {
        const block = event.target.closest('#month-sections [data-currency]');
        if (!block) return;
        const key = block.dataset.currency;
        const list = monthSectionsFor(key);
        const box = event.target.closest('.config-section');
        const typeButton = event.target.closest('[data-section-type]');
        const changed = (typeButton && box) || (event.target.closest('[data-remove-section]') && box) || event.target.closest('[data-month-add-section]');
        if (!changed) return;
        if (typeButton) list[Number(box.dataset.sectionIndex)].type = typeButton.dataset.sectionType;
        else if (box) list.splice(Number(box.dataset.sectionIndex), 1);
        else list.push({ name: '', originalName: null, type: 'expense', subsections: [] });
        monthState.dirty.add(key);
        renderMonthSections();
        if (!box) document.querySelector(`#month-sections [data-currency="${key}"] .config-section:last-child .config-section-name`)?.focus();
      });
      form.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target.matches('.config-section-name')) event.preventDefault();
      });
      form.addEventListener('submit', event => {
        event.preventDefault();
        const { year, month, setup } = monthState;
        const error = document.querySelector('#month-settings-error');
        const fail = message => {
          error.textContent = message;
          error.hidden = false;
        };
        if (!Object.values(setup).some(item => item.active)) return fail('Keep at least one currency on.');
        const edited = [...monthState.dirty].filter(key => setup[key].active);
        for (const key of edited) {
          const names = monthSectionsFor(key).map(section => section.name.trim().toLowerCase());
          if (names.some(name => !name)) return fail(`${regions[key].code}: every section needs a name.`);
          if (new Set(names).size !== names.length) return fail(`${regions[key].code}: section names must be unique.`);
        }
        let renamed = false;
        edited.forEach(key => {
          const list = monthSectionsFor(key);
          // Entries follow a section renamed here, in this month and currency only.
          list.forEach(section => {
            const name = section.name.trim();
            if (!section.originalName || section.originalName === name) return;
            transactions.forEach(item => {
              if (item.property === key && item.date.startsWith(keyOf(year, month)) && item.section === section.originalName) {
                item.section = name;
                renamed = true;
              }
            });
          });
          trackSave(store.saveMonthSections(year, month, key, list.map(section => ({ name: section.name.trim(), type: section.type, subsections: [...section.subsections] }))));
        });
        if (renamed) saveTransactions();
        trackSave(store.saveMonthSetup(year, month, setup));
        dialog.close();
        renderLedger();
        showToast(`Saved ${monthLabel(new Date(year, month, 1))} settings.`);
      });
    }

    // ---- Add entry: the "+ Add" button ----
    // Defaults to the newest open month (else this month) and expense; currency and subsection follow the chosen date.
    const entryState = { type: 'expense', currency: null };
    function entryDate() {
      const value = document.querySelector('#entry-date').value;
      return value ? new Date(`${value}T12:00:00`) : null;
    }
    function renderEntryChoices() {
      const date = entryDate();
      const currencies = date ? store.monthCurrencies(date.getFullYear(), date.getMonth()) : [];
      if (!currencies.includes(entryState.currency)) entryState.currency = currencies[0] || null;
      document.querySelectorAll('#entry-type [data-value]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.value === entryState.type)));
      document.querySelector('#entry-currency').innerHTML = currencies.map(key => `<button type="button" data-value="${key}" aria-pressed="${key === entryState.currency}"><span class="cur-dot ${regions[key].color}"></span>${escapeHtml(regions[key].code)}</button>`).join('')
        || `<span class="config-muted">${date && store.year(date.getFullYear()) ? 'No currency in this month' : 'This year is not set up'}</span>`;
      const select = document.querySelector('#entry-category');
      const previous = select.value;
      const sections = date ? store.sections(date.getFullYear(), date.getMonth(), entryState.currency).filter(section => section.type === entryState.type) : [];
      select.innerHTML = sections.map(section => `<optgroup label="${escapeHtml(section.name)}">${section.subsections.map(name => `<option value="${escapeHtml(name)}" data-section="${escapeHtml(section.name)}">${escapeHtml(name)}</option>`).join('')}</optgroup>`).join('');
      if ([...select.options].some(option => option.value === previous)) select.value = previous;
      document.querySelector('#entry-dialog-title').textContent = entryState.type === 'income' ? 'Add income' : 'Add an expense';
    }
    function openEntryDialog() {
      const today = new Date();
      const openKey = [...expandedMonths].filter(key => key.startsWith(`${currentMonth.getFullYear()}-`)).sort().pop();
      const base = openKey ? new Date(Number(openKey.slice(0, 4)), Number(openKey.slice(5, 7)) - 1, 1) : new Date(currentMonth.getFullYear(), today.getFullYear() === currentMonth.getFullYear() ? today.getMonth() : 0, 1);
      const day = base.getFullYear() === today.getFullYear() && base.getMonth() === today.getMonth() ? today.getDate() : 1;
      const form = document.querySelector('#entry-form');
      form.reset();
      document.querySelector('#entry-amount-preview').textContent = '';
      form.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid'));
      document.querySelector('#entry-error').hidden = true;
      document.querySelector('#entry-date').value = `${keyOf(base.getFullYear(), base.getMonth())}-${String(day).padStart(2, '0')}`;
      entryState.type = 'expense';
      renderEntryChoices();
      document.querySelector('#entry-dialog').showModal();
      form.elements.description.focus();
    }
    function setupEntryDialog() {
      const dialog = document.querySelector('#entry-dialog');
      const form = document.querySelector('#entry-form');
      document.querySelector('#add-entry-button').addEventListener('click', openEntryDialog);
      document.querySelector('#entry-date').addEventListener('change', renderEntryChoices);
      form.elements.amount.addEventListener('input', () => {
        const preview = document.querySelector('#entry-amount-preview');
        const parsed = ExpenseStore.readAmount(form.elements.amount.value);
        preview.textContent = parsed.formula ? `= ${formatMoney(Math.round(parsed.value * 100), entryState.currency)}` : parsed.error && form.elements.amount.value.trim().startsWith('=') ? 'Not a valid formula yet' : '';
        preview.classList.toggle('is-error', Boolean(parsed.error));
      });
      document.querySelector('#entry-type').addEventListener('click', event => {
        const button = event.target.closest('[data-value]');
        if (!button) return;
        entryState.type = button.dataset.value;
        renderEntryChoices();
      });
      document.querySelector('#entry-currency').addEventListener('click', event => {
        const button = event.target.closest('[data-value]');
        if (!button) return;
        entryState.currency = button.dataset.value;
        renderEntryChoices();
      });
      form.addEventListener('submit', event => {
        event.preventDefault();
        const fields = form.elements;
        const date = entryDate();
        const parsed = ExpenseStore.readAmount(fields.amount.value);
        const amount = parsed.value;
        const option = fields.category.selectedOptions[0];
        const checks = [
          [fields.date, Boolean(date) && Boolean(store.monthNode(date.getFullYear(), date.getMonth()))],
          [fields.category, Boolean(option)],
          [fields.description, fields.description.value.trim() !== ''],
          [fields.amount, !parsed.error && !parsed.empty && amount > 0]
        ];
        checks.forEach(([input, ok]) => input.toggleAttribute('aria-invalid', !ok));
        const error = document.querySelector('#entry-error');
        const invalid = checks.find(([, ok]) => !ok);
        if (invalid || !entryState.currency) {
          error.textContent = !date || !store.year(date.getFullYear()) ? 'That year is not set up yet. Add it in Year settings.' : !entryState.currency ? 'No currency is on for that month.' : !fields.category.options.length ? 'That month has no subsections yet. Add one in its month settings (double-click the month name).' : 'Fill in the highlighted fields.';
          error.hidden = false;
          return invalid?.[0].focus();
        }
        const year = date.getFullYear();
        const month = date.getMonth();
        // The month's entries must be loaded first, or saving it would replace what Firebase already holds.
        store.ensureMonth(year, month).then(() => {
          transactions.push({ id: `new-${Date.now()}`, property: entryState.currency, date: fields.date.value, section: option.dataset.section, category: option.value, description: fields.description.value.trim(), place: fields.place.value.trim(), amount: Math.round(amount * 100), ...(parsed.formula && { formula: parsed.formula }), type: entryState.type });
          saveTransactions();
          dialog.close();
          const key = keyOf(year, month);
          expandedMonths.add(key);
          saveExpandedMonths();
          revealKey = catKey(key, entryState.currency, entryState.type, option.value);
          if (year !== currentMonth.getFullYear()) currentMonth = new Date(year, month, 1);
          renderLedger();
          showToast(`Saved to ${option.value}.`);
        }, loadError => {
          console.error('Could not load the month from Firebase.', loadError);
          error.textContent = 'Could not load that month from Firebase. Try again.';
          error.hidden = false;
        });
      });
    }

    // ---- Year configuration (months.html) ----
    // Edits are held as per-year drafts so the user can hop between year boxes; Save validates and writes every touched year.
    // A year's currencies are { <cur>: { from: <month name>, opening, carryIn } }: active from `from` (months can override),
    // opening either on the previous year's closing (carryIn) or on the amount set here.
    const configState = { year: null, drafts: {} };
    const toMajor = minor => String(Math.round(Number(minor || 0) / 100));
    function draftFromYear(year) {
      const node = store.year(year);
      return {
        dirty: false,
        from: Object.fromEntries(store.currencyKeys().map(key => [key, node?.currencies[key]?.from || ''])),
        openings: Object.fromEntries(store.currencyKeys().map(key => [key, toMajor(node?.currencies[key]?.opening)])),
        carryIn: Object.fromEntries(store.currencyKeys().map(key => [key, Boolean(node?.currencies[key]?.carryIn)]))
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
    // LinkedIn-style tag field: type and press Enter or comma, paste a comma list, Backspace removes the last chip, × removes any chip.
    function chipInput({ values, label, placeholder, countFor = () => 0, onChange = () => {} }) {
      const root = document.createElement('div');
      root.className = 'chip-field';
      root.innerHTML = `<div class="chip-input"><input type="text" aria-label="${escapeHtml(label)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"></div><p class="chip-hint" aria-live="polite"></p>`;
      const box = root.querySelector('.chip-input');
      const input = root.querySelector('input');
      const hint = root.querySelector('.chip-hint');
      const draw = () => {
        box.querySelectorAll('.chip').forEach(chip => chip.remove());
        values.forEach((value, index) => {
          const count = countFor(value);
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.innerHTML = `<span>${escapeHtml(value)}</span>${count ? `<small title="${count} ${count === 1 ? 'entry' : 'entries'} this month">${count}</small>` : ''}<button type="button" aria-label="Remove ${escapeHtml(value)}" data-chip-index="${index}">×</button>`;
          box.insertBefore(chip, input);
        });
        input.placeholder = values.length ? '' : placeholder;
      };
      const say = message => { hint.textContent = message; root.classList.toggle('has-hint', Boolean(message)); };
      const add = raw => {
        const problems = [];
        raw.split(/[,\n]/).map(part => part.trim()).filter(Boolean).forEach(part => {
          const value = part.slice(0, 40);
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
    // One row per currency: the month it starts, and what the year opens on (last year's closing, or a set amount).
    function renderConfigCurrencies() {
      const year = configState.year;
      const draft = configDraft(year);
      const previousYear = store.year(year - 1) ? year - 1 : null;
      document.querySelector('#config-currencies').innerHTML = store.currencyKeys().map(key => {
        const region = regions[key];
        const used = Boolean(draft.from[key]);
        const closing = previousYear ? store.yearTotals(previousYear, key).closing : 0;
        const carryNote = !previousYear ? `no ${year - 1} in Firebase` : `${closing < 0 ? '−' : '+'}${formatMoney(Math.abs(closing), key)} as ${closing < 0 ? 'an expense' : 'income'}`;
        return `<div class="config-currency${used ? '' : ' is-off'}">
          <span class="config-cur-code"><span class="cur-dot ${region.color}"></span>${escapeHtml(region.code)}</span>
          <label class="money-field"><select data-config-from="${key}" aria-label="${escapeHtml(region.code)} starts">${['', ...MONTH_NAMES].map(name => `<option value="${name}"${draft.from[key] === name ? ' selected' : ''}>${name ? `from ${name}` : 'Not used this year'}</option>`).join('')}</select></label>
          ${used ? `<label class="check-field"><input type="checkbox" data-config-carry-in="${key}"${draft.carryIn[key] ? ' checked' : ''}${previousYear ? '' : ' disabled'}><span>Bring in ${year - 1} closing <em>${escapeHtml(carryNote)}</em></span></label>
          <label class="money-field${draft.carryIn[key] ? ' is-disabled' : ''}"><span>Opening</span><input type="number" step="1" inputmode="numeric" value="${escapeHtml(draft.openings[key])}" data-config-money="openings" data-property="${key}" aria-label="${escapeHtml(region.code)} opening balance"${draft.carryIn[key] ? ' disabled' : ''}></label>` : ''}
        </div>`;
      }).join('') || '<span class="config-muted">No currencies in Firebase</span>';
    }
    function renderConfig() {
      const year = configState.year;
      const years = store.yearIds().map(Number).reverse();
      document.querySelector('#year-settings-title').textContent = year ? `${year} configuration` : 'No years yet';
      document.querySelector('#config-years').innerHTML = years.map(value => {
        const summary = configState.drafts[value] || draftFromYear(value);
        const currencies = draftCurrencies(summary).map(key => `${regions[key].code}${summary.from[key] === 'January' ? '' : ` from ${summary.from[key].slice(0, 3)}`}`);
        return `<button type="button" class="config-year${value === year ? ' is-active' : ''}${summary.dirty ? ' is-dirty' : ''}" data-config-year="${value}" aria-pressed="${value === year}"><strong>${value}</strong><span>${currencies.join(' · ') || 'No currency'}</span></button>`;
      }).join('') + `<button type="button" class="config-year" id="config-add-year" title="Add the next year to Firebase"><strong><i class="ti ti-plus" aria-hidden="true"></i> ${years.length ? years[0] + 1 : new Date().getFullYear()}</strong><span>Add year</span></button>`;
      document.querySelector('.config-body').hidden = !year;
      if (!year) return;
      renderConfigCurrencies();
      document.querySelector('#year-settings-error').hidden = true;
    }
    function showConfigYear(year) {
      configState.year = store.year(year) ? year : null;
      renderConfig();
    }
    function openYearSettings(year) {
      const dialog = document.querySelector('#year-settings-dialog');
      if (!dialog) return;
      configState.drafts = {};
      showConfigYear(year);
      dialog.showModal();
    }
    // A new year copies the latest year's currencies and brings in its closing balances. Its months start with no sections.
    function addConfigYear() {
      const years = store.yearIds().map(Number);
      const year = years.length ? Math.max(...years) + 1 : new Date().getFullYear();
      const previous = store.year(year - 1);
      const currencies = Object.fromEntries((previous?.metadata.currencies || []).map(key => [key, { from: 'January', opening: 0, carryIn: true }]));
      saveYearConfig(year, { currencies });
      showConfigYear(year);
      renderLedger();
      showToast(`Added ${year}. Review its currencies.`);
    }
    function validateDraft(draft) {
      if (!draftCurrencies(draft).length) return 'Choose a start month for at least one currency.';
      const amounts = draftCurrencies(draft).filter(key => !draft.carryIn[key]).map(key => draft.openings[key]);
      if (amounts.some(value => String(value).trim() !== '' && !Number.isFinite(Number(value)))) return 'Opening balance must be a number.';
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
      form.addEventListener('input', event => {
        const draft = configDraft(configState.year);
        const money = event.target.closest('[data-config-money]');
        if (money) draft[money.dataset.configMoney][money.dataset.property] = money.value;
        const from = event.target.closest('[data-config-from]');
        if (from) draft.from[from.dataset.configFrom] = from.value;
        const carryIn = event.target.closest('[data-config-carry-in]');
        if (carryIn) draft.carryIn[carryIn.dataset.configCarryIn] = carryIn.checked;
        if (from || carryIn) renderConfigCurrencies();
        if (money || from || carryIn) markConfigDirty();
      });
      // Enter inside a plain field should not save the whole dialog by accident.
      form.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target.matches('input')) event.preventDefault();
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
          const currencies = Object.fromEntries(draftCurrencies(draft).map(key => [key, { from: draft.from[key], opening: Math.round(Number(draft.openings[key] || 0) * 100), carryIn: draft.carryIn[key] }]));
          saveYearConfig(Number(year), { currencies });
        });
        dialog.close();
        renderLedger();
        showToast(touched.length ? `Saved ${touched.map(([year]) => year).join(' & ')} configuration.` : 'No changes to save.');
      });
    }
    setupYearConfig();
    setupMonthSettings();
    setupEntryDialog();
    setupLedger();
    document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
    document.querySelector('#logout-button').addEventListener('click', () => {
      sessionStorage.removeItem(`${STORAGE_KEY}-passkey-signed-in`);
      sessionStorage.removeItem(`${STORAGE_KEY}-signed-in`);
      window.location.href = '../family-budget-vertical.html';
    });
    renderLedger();
    })();
