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
      const keepOpen = [...host.querySelectorAll('.ledger-cat[open]')].map(cat => cat.dataset.key);
      host.innerHTML = store.year(year) ? renderMonthGroups(year) : '<p class="ledger-none">No years in Firebase yet. Add one from Year settings.</p>';
      host.querySelectorAll('.ledger-cat').forEach(cat => { if (keepOpen.includes(cat.dataset.key) || cat.dataset.key === revealKey) cat.open = true; });
      revealKey = null;
      host.querySelector('[data-ledger-form="subsection"]')?.elements.name.focus();
      host.querySelector('[data-ledger-form="entry"], [data-ledger-form="sub-entry"]')?.elements.day.focus();
      host.querySelector('[data-ledger-form="edit-entry"], [data-ledger-form="edit-note"]')?.elements.description.focus();
      host.querySelector('[data-ledger-form="rename-category"]')?.elements.name.select();
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
      const amount = Number(fields.amount.value);
      const checks = [
        [fields.day, Number.isInteger(day) && day >= 1 && day <= Number(fields.day.max)],
        [fields.description, fields.description.value.trim() !== ''],
        [fields.amount, fields.amount.value !== '' && Number.isFinite(amount) && (isNote ? amount >= 0 : amount > 0)]
      ];
      checks.forEach(([input, ok]) => input.toggleAttribute('aria-invalid', !ok));
      const invalid = checks.find(([, ok]) => !ok);
      if (invalid) return invalid[0].focus();
      Object.assign(item, {
        date: `${item.date.slice(0, 7)}-${String(day).padStart(2, '0')}`,
        description: fields.description.value.trim(),
        place: fields.place.value.trim(),
        amount: Math.round(amount * 100)
      });
      saveTransactions();
      editDraft = null;
      renderLedger();
      showToast(isNote ? 'Note updated.' : 'Entry updated.');
    }
    // Renaming a subsection applies to the whole year: its section lists and every entry filed under it.
    function saveCategoryRename(form) {
      const { month, property, type, category } = form.dataset;
      const input = form.elements.name;
      const hint = form.querySelector('.ledger-form-hint');
      const name = input.value.trim().replace(/\s+/g, ' ');
      const year = Number(month.slice(0, 4));
      if (name === category) {
        editDraft = null;
        return renderLedger();
      }
      const sections = store.sections(year).filter(section => section.type === type);
      const taken = sections.some(section => section.subsections.some(existing => existing !== category && existing.toLowerCase() === name.toLowerCase()));
      const problem = !name ? 'Type a name first.' : taken ? `"${name}" already exists.` : '';
      if (problem) {
        hint.textContent = problem;
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      store.ensureYear(year).then(() => {
        sections.forEach(section => {
          const index = section.subsections.indexOf(category);
          if (index >= 0) section.subsections[index] = name;
          else if (section.subsections.length && !sections.some(other => other.subsections.includes(name))) section.subsections.push(name);
        });
        transactions.forEach(item => { if (item.date.startsWith(`${year}-`) && item.type === type && item.category === category) item.category = name; });
        saveYearConfig(year);
        saveTransactions();
        editDraft = null;
        revealKey = catKey(month, property, type, name);
        renderLedger();
        showToast(`Renamed "${category}" to "${name}" for ${year}.`);
      }, error => {
        console.error('Could not load the year from Firebase.', error);
        showToast(`Could not load ${year} from Firebase.`);
      });
    }
    function setupLedger() {
      const ledger = document.querySelector('#ledger');
      if (!ledger) return;
      // A 1.5s hold adds a child (entry → note, subsection → entry, Income/Expenses → subsection); a double-click edits
      // the row itself. A hold re-renders under the pointer, so the click that follows it is swallowed. Rows re-render
      // on the first click, so a double-click is detected as two clicks on the same row within DOUBLE_CLICK_MS.
      let longPressFired = false;
      let suppressClickUntil = 0;
      let lastClick = { key: null, time: 0 };
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
      ledger.addEventListener('click', event => {
        // The click released from a hold must not toggle the row that was just re-rendered. Enter-to-submit
        // synthesises a click on the form's button, so clicks inside forms are never swallowed.
        if (Date.now() < suppressClickUntil && !event.target.closest('form')) {
          suppressClickUntil = 0;
          return event.preventDefault();
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

      // Double-click: edit the row in place. Entries and notes get their own fields back; a subsection gets a rename
      // field; Income/Expenses opens Year settings, where sections are named.
      const triggerEdit = (element, rowKey) => {
        element = getElement(element);
        const panel = element?.closest('.ledger-panel');
        const monthBlock = element?.closest('.month-block');
        if (!panel || !monthBlock) return;
        if (hasDraft()) return showToast('Save or cancel the current inline edit first.');
        const [kind, ...rest] = rowKey.split(':');
        const id = rest.join(':');
        if (kind === 'entry') {
          // The first click of the pair toggled the entry open or closed; put it back.
          if (expandedEntries.has(id)) expandedEntries.delete(id);
          else expandedEntries.add(id);
          editDraft = { kind: 'entry', id };
        } else if (kind === 'note') {
          editDraft = { kind: 'note', id };
        } else if (kind === 'cat') {
          const cat = element.closest('.ledger-cat');
          const type = element.closest('.ledger-type-section')?.querySelector('summary strong')?.textContent.trim().toLowerCase() === 'income' ? 'income' : 'expense';
          editDraft = { kind: 'category', month: monthBlock.dataset.monthKey, property: panel.dataset.property, type, category: cat.querySelector('.ledger-cat-name').textContent.trim() };
        } else {
          return openYearSettings(Number(monthBlock.dataset.monthKey.slice(0, 4)));
        }
        renderLedger();
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
      renderLedger();
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
        renderLedger();
        showToast(touched.length ? `Saved ${touched.map(([year]) => year).join(' & ')} configuration.` : 'No changes to save.');
      });
    }
    setupYearConfig();
    setupLedger();
    document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
    document.querySelector('#logout-button').addEventListener('click', () => {
      sessionStorage.removeItem(`${STORAGE_KEY}-passkey-signed-in`);
      sessionStorage.removeItem(`${STORAGE_KEY}-signed-in`);
      window.location.href = '../family-budget-vertical.html';
    });
    renderLedger();
    })();
