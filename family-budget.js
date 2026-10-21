const STORAGE_KEY = 'family-budget-static-demo-v1';
    // Data now lives in Firebase; drop what older builds kept in this browser.
    try { [STORAGE_KEY, `${STORAGE_KEY}-year-settings`, `${STORAGE_KEY}-view`].forEach(key => localStorage.removeItem(key)); } catch (error) { /* Nothing to clean up. */ }
    // Signed in means a Firebase Auth session (see firebase-auth.js), for this tab or kept on this device; without one,
    // back to the sign-in page.
    const LOGIN_PAGE = '../family-budget-vertical.html';
    (async () => {
    const authSession = window.FamilyAuth ? await FamilyAuth.restore() : null;
    if (!authSession) return window.location.replace(LOGIN_PAGE);
    // View-only accounts: everything can be seen, nothing can be changed. The store itself cannot write,
    // and every way into editing below stops with a short note instead. Database rules enforce the same on the server.
    const isViewer = authSession.role === 'viewer';
    if (isViewer) document.documentElement.classList.add('is-viewer');
    let store;
    try {
      // Every request carries the signed-in user's ID token; a session Firebase no longer accepts goes back to sign-in.
      const auth = () => FamilyAuth.token().catch(error => {
        if (error.code === 'signed-out') window.location.replace(LOGIN_PAGE);
        throw error;
      });
      store = await ExpenseStore.open({ databaseURL: FIREBASE_CONFIG.databaseURL, root: FIREBASE_ROOT, readOnly: isViewer, auth });
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
    // The year summary always starts collapsed; it opens only from its button.
    let universeOpen = false;
    try { sessionStorage.removeItem(`${STORAGE_KEY}-universe`); } catch (error) { /* Nothing stored. */ }

    function saveTransactions() { trackSave(store.saveTransactions()); }
    function saveYearConfig(year, config = {}) { trackSave(store.saveYear(year, config)); }
    const yearMonthOf = mKey => [Number(mKey.slice(0, 4)), Number(mKey.slice(5, 7)) - 1];
    function saveMonthSections(mKey, property) {
      const [year, monthIndex] = yearMonthOf(mKey);
      trackSave(store.saveMonthSections(year, monthIndex, property, store.ownSections(year, monthIndex, property)));
    }
    function trackSave(write) {
      if (isViewer) return;
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
    // Year-summary rename: the row being renamed ({ key, property, target, original, name, open, fresh }), and right after
    // a rename, [old key, new key] so the renamed row and the rows inside it stay open under their new keys.
    let summaryEdit = null;
    let summaryKeyMove = null;
    const hasDraft = () => Boolean(ledgerDraft || entryDraft || subEntryDraftParentId || editDraft || summaryEdit);
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
    // Child order per subsection (its data-key → 'date-asc' | 'amount-desc' | 'amount-asc'), chosen with the subsection's
    // sort button. A display preference, so it stays in this browser; no key means the default order.
    const SORT_KEY = `${STORAGE_KEY}-sort`;
    const sortModes = (() => {
      try { return JSON.parse(localStorage.getItem(SORT_KEY) || '{}') || {}; } catch (error) { return {}; }
    })();
    function saveSortModes() {
      try { localStorage.setItem(SORT_KEY, JSON.stringify(sortModes)); } catch (error) { /* Not remembered; still applies now. */ }
    }
    const renderState = () => ({ expandedEntries, expandedMonths, entryDraft, subEntryDraftParentId, ledgerDraft, editDraft, sortModes });
    const B = () => window.LedgerBlueprints;
    const ledgerCtx = {
      fmt: formatMoney, compact: compactMoney, signed: signedMoney, esc: escapeHtml, dayLabel, keyOf, catKey, monthLabel, regions,
      today: () => { const now = new Date(); return `${keyOf(now.getFullYear(), now.getMonth())}-${String(now.getDate()).padStart(2, '0')}`; },
      netClass: minor => (minor > 0 ? 'income' : minor < 0 ? 'expense' : '')
    };
    const ledgerRenderer = new LedgerRenderer(store, ledgerCtx);
    function renderYearKpis(year) { return ledgerRenderer.yearKpis(year, summaryEdit); }
    function renderMonthGroups(year) { return ledgerRenderer.monthGroups(year, renderState()); }
    // loadMissing: false redraws from what is already in memory only, without starting any Firebase load.
    function renderLedger({ loadMissing = true } = {}) {
      const ledger = document.querySelector('#ledger');
      if (!ledger) return;
      const year = currentMonth.getFullYear();
      document.querySelector('#year-tabs').innerHTML = ledgerRenderer.yearTabs(year);
      // Rows opened in the year summary stay open when it is redrawn, also under their new key after a rename; a row
      // being renamed keeps what was typed.
      const kpis = document.querySelector('#year-kpis');
      const [movedFrom, movedTo] = summaryKeyMove || [];
      const moveKey = key => (movedFrom && (key === movedFrom || key.startsWith(`${movedFrom}|`)) ? movedTo + key.slice(movedFrom.length) : key);
      const openRows = new Set([...kpis.querySelectorAll('details[open][data-key], .is-renaming[data-open][data-key]')].map(row => moveKey(row.dataset.key)));
      summaryKeyMove = null;
      const typed = kpis.querySelector('[data-kb-rename] input');
      if (typed && summaryEdit) summaryEdit.name = typed.value;
      kpis.innerHTML = renderYearKpis(year);
      kpis.querySelectorAll('details[data-key]').forEach(row => { if (openRows.has(row.dataset.key)) row.open = true; });
      const toggle = document.querySelector('[data-toggle-universe]');
      toggle.setAttribute('aria-pressed', String(universeOpen));
      toggle.querySelector('span').textContent = universeOpen ? 'Hide summary' : 'Year summary';
      // Keep open subsections open across re-renders (e.g. after saving an entry).
      const host = document.querySelector('#month-ledger');
      const keepOpen = [...host.querySelectorAll('.ledger-cat[open], .ledger-cat.is-editing')].map(cat => cat.dataset.key);
      host.innerHTML = store.year(year) ? renderMonthGroups(year) : '<p class="ledger-none">No years in Firebase yet. Add one from Year settings.</p>';
      host.querySelectorAll('.ledger-cat').forEach(cat => { if (keepOpen.includes(cat.dataset.key) || cat.dataset.key === revealKey) cat.open = true; });
      revealKey = null;
      focusDrafts(host);
      // After the ledger's own fields, which close any open suggestion list, so the summary field keeps its list.
      if (summaryEdit) {
        const field = kpis.querySelector('[data-kb-rename] input');
        if (!field) summaryEdit = null;
        else {
          attachSummarySuggestions(field, summaryEdit);
          field.focus({ preventScroll: true });
          if (summaryEdit.fresh) field.select();
          summaryEdit.fresh = false;
        }
      }
      document.body.classList.toggle('show-universe', universeOpen);
      const universe = document.querySelector('#universe');
      universe.inert = !universeOpen;
      universe.setAttribute('aria-hidden', String(!universeOpen));
      if (!loadMissing) return;
      loadOpenMonths(year);
      if (universeOpen) loadYearForSummary(year);
    }
    // Focus an open inline form without jumping the page, and give its name fields suggestions.
    function focusDrafts(host) {
      const focusQuietly = input => {
        if (!input) return;
        input.focus({ preventScroll: true });
        input.closest('form').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };
      focusQuietly(host.querySelector('[data-ledger-form="subsection"]')?.elements.name);
      const adding = host.querySelector('[data-ledger-form="entry"], [data-ledger-form="sub-entry"]');
      focusQuietly(adding?.elements.day || adding?.elements.description);
      focusQuietly(host.querySelector('[data-ledger-form="edit-entry"], [data-ledger-form="edit-note"]')?.elements.description);
      const rename = host.querySelector('[data-ledger-form="rename-category"]')?.elements.name;
      focusQuietly(rename);
      rename?.select();
      attachLedgerSuggestions(host);
    }
    // The year-summary name field suggests names already in use: sections and subsections of the same type, or for an item
    // past entry and note descriptions (those filed under the same subsection first). The current name is left out.
    // Picking one only fills it in; Enter then renames, merging into that name after asking.
    function attachSummarySuggestions(field, { target, original }) {
      const items = () => {
        if (target.level === 'section') return sectionChoices([original]).filter(item => item.type === target.type);
        if (target.level === 'sub') return subsectionChoices(target.type, [original]);
        const owner = { type: target.type, category: target.sub };
        const merged = new Map();
        [...descriptionChoices('notes', owner, original), ...descriptionChoices('entries', owner, original)].forEach(item => {
          const key = nameKey(item.name);
          const seen = merged.get(key);
          if (!seen) return merged.set(key, item);
          const uses = seen.uses + item.uses;
          const near = seen.near || item.near;
          merged.set(key, { ...seen, uses, near, last: seen.last > item.last ? seen.last : item.last, note: near ? `here · ${usesNote(uses)}` : usesNote(uses) });
        });
        return [...merged.values()];
      };
      suggest.attach(field, {
        items,
        onPick: item => {
          field.value = item.name;
          field.removeAttribute('aria-invalid');
          field.focus();
        }
      });
    }
    // Inline name fields get suggestions: a new subsection offers names this month and currency do not have yet, and a
    // rename offers every other name of the same type.
    function attachLedgerSuggestions(host) {
      suggest.close();
      const subForm = host.querySelector('[data-ledger-form="subsection"]');
      if (subForm && ledgerDraft) {
        const sections = panelScope(ledgerDraft.month, ledgerDraft.property).sections();
        const type = sections.find(section => section.name === ledgerDraft.section)?.type || 'expense';
        suggest.attach(subForm.elements.name, {
          items: () => subsectionChoices(type, sections.filter(section => section.type === type).flatMap(section => section.subsections)),
          onPick: item => {
            subForm.elements.name.value = item.name;
            subForm.requestSubmit();
          }
        });
      }
      // Entry fields suggest past entries, note fields past notes; the subsection they belong to ranks its own first.
      host.querySelectorAll('[data-ledger-form="entry"], [data-ledger-form="edit-entry"], [data-ledger-form="sub-entry"], [data-ledger-form="edit-note"]').forEach(form => {
        const kind = form.dataset.ledgerForm === 'entry' || form.dataset.ledgerForm === 'edit-entry' ? 'entries' : 'notes';
        const owner = form.dataset.ledgerForm === 'entry' ? form.dataset
          : transactions.find(item => item.id === (form.dataset.entryId || form.dataset.parentId));
        const input = form.elements.description;
        suggest.attach(input, { items: () => descriptionChoices(kind, owner || {}, form.dataset.ledgerForm.startsWith('edit') ? input.defaultValue : ''), onPick: pickDescription(form) });
      });
      const renameForm = host.querySelector('[data-ledger-form="rename-category"]');
      if (renameForm) {
        suggest.attach(renameForm.elements.name, {
          items: () => subsectionChoices(renameForm.dataset.type, [renameForm.dataset.category]),
          onPick: item => {
            renameForm.elements.name.value = item.name;
            renameForm.elements.name.focus();
          }
        });
      }
    }
    // The category breakdown needs every month's entries; they load once per year, then the summary repaints.
    const yearLoads = new Set();
    function loadYearForSummary(year) {
      if (!store.year(year) || store.isYearLoaded(year) || yearLoads.has(year)) return;
      yearLoads.add(year);
      store.ensureYear(year).then(() => renderLedger(), error => {
        console.error('Could not load the year from Firebase.', error);
        showToast(`Could not load ${year} for the summary.`);
      }).finally(() => yearLoads.delete(year));
    }
    // Open months show "Loading entries…" until their entries arrive from Firebase, then the ledger repaints.
    function loadOpenMonths(year) {
      const pending = [...expandedMonths]
        .filter(key => key.startsWith(`${year}-`))
        .map(key => Number(key.slice(5, 7)) - 1)
        .filter(month => store.monthNode(year, month) && !store.isLoaded(year, month));
      if (!pending.length) return;
      Promise.all(pending.map(month => store.ensureMonth(year, month))).then(() => renderLedger(), error => {
        console.error('Could not load entries from Firebase.', error);
        showToast('Could not load entries from Firebase.');
      });
    }
    function setUniverse(open) {
      universeOpen = open;
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
    // A panel is a month ("2026-10") or a special event ("ev:<id>"). Each has its own entries and section list per
    // currency; everything that adds, edits, moves or deletes rows goes through this so both behave alike.
    function panelScope(mKey, property) {
      if (String(mKey).startsWith('ev:')) {
        const id = mKey.slice(3);
        return {
          isEvent: true,
          id,
          label: `the event “${store.eventName(id)}”`,
          match: item => item.eventId === id && item.property === property,
          sections: () => store.eventSections(id, property),
          own: () => store.ownEventSections(id, property),
          save: () => trackSave(store.saveEventMeta(id, { sections: store.events[id].sections })),
          fields: { eventId: id }
        };
      }
      const [year, monthIndex] = yearMonthOf(mKey);
      return {
        isEvent: false,
        label: monthLabel(new Date(year, monthIndex, 1)),
        match: item => !item.eventId && item.property === property && item.date.startsWith(mKey),
        sections: () => store.sections(year, monthIndex, property),
        own: () => store.ownSections(year, monthIndex, property),
        save: () => saveMonthSections(mKey, property),
        fields: {}
      };
    }
    // An entry or note's date from its form: a full date in an event, else the day within the panel's month.
    function dateFromForm(fields, month) {
      if (fields.date) return /^\d{4}-\d{2}-\d{2}$/.test(fields.date.value) ? fields.date.value : null;
      const day = Number(fields.day.value);
      return Number.isInteger(day) && day >= 1 && day <= Number(fields.day.max) ? `${month}-${String(day).padStart(2, '0')}` : null;
    }
    // Adds a subsection to this panel's own list for this currency; other months and events keep theirs.
    function saveDraftSubsection(form) {
      const input = form.elements.name;
      const name = input.value.trim().replace(/\s+/g, ' ');
      const hint = form.querySelector('.ledger-form-hint');
      const { month, property } = ledgerDraft;
      const scope = panelScope(month, property);
      const problem = !name ? 'Type a name first.' : !scope.sections().some(item => item.name === ledgerDraft.section) ? 'This section is no longer set up here.' : '';
      if (problem) {
        hint.textContent = problem;
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      const sections = scope.own();
      const section = sections.find(item => item.name === ledgerDraft.section);
      const existing = sections.filter(item => item.type === section.type).flatMap(item => item.subsections).find(item => item.toLowerCase() === name.toLowerCase());
      const category = existing || name;
      const holder = existing ? sections.find(item => item.type === section.type && item.subsections.includes(existing)) : section;
      if (!existing) section.subsections.push(name);
      scope.save();
      // Go straight to the first entry for the subsection.
      ledgerDraft = null;
      entryDraft = { month, property, section: holder.name, type: section.type, category };
      revealKey = catKey(month, property, section.type, category);
      renderLedger();
      showToast(existing ? `Add an entry to "${category}".` : `Added "${name}" to ${section.name}${scope.isEvent ? '' : ' for this month'}.`);
    }
    function saveEntryDraft(form) {
      const fields = form.elements;
      const { month, property, section, type, category } = form.dataset;
      const date = dateFromForm(fields, month);
      const parsed = ExpenseStore.readAmount(fields.amount.value);
      const amount = parsed.value;
      const checks = [
        [fields.date || fields.day, Boolean(date)],
        [fields.description, fields.description.value.trim() !== ''],
        [fields.amount, !parsed.error && !parsed.empty && amount >= 0] // 0 is allowed: a gift with no money, say
      ];
      checks.forEach(([input, ok]) => input.toggleAttribute('aria-invalid', !ok));
      const invalid = checks.find(([, ok]) => !ok);
      if (invalid) return invalid[0].focus();
      transactions.push({ id: `new-${Date.now()}`, property, date, section, category, description: fields.description.value.trim(), place: fields.place.value.trim(), amount: Math.round(amount * 100), ...(parsed.formula && { formula: parsed.formula }), type, ...panelScope(month, property).fields });
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
      const date = dateFromForm(fields, item.date.slice(0, 7));
      const parsed = ExpenseStore.readAmount(fields.amount.value);
      const amount = parsed.value;
      const checks = [
        [fields.date || fields.day, Boolean(date)],
        [fields.description, fields.description.value.trim() !== ''],
        [fields.amount, !parsed.error && !parsed.empty && amount >= 0]
      ];
      checks.forEach(([input, ok]) => input.toggleAttribute('aria-invalid', !ok));
      const invalid = checks.find(([, ok]) => !ok);
      if (invalid) return invalid[0].focus();
      Object.assign(item, {
        date,
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
        category: item => !item.parentId && panelScope(month, property).match(item) && item.type === type && item.category === category
      }[kind];
      const rows = transactions.filter(inRow);
      const rowScope = month ? panelScope(month, property) : null;
      const emptyListed = kind === 'category' && !rows.length && rowScope.sections().some(section => section.type === type && section.subsections.includes(category));
      if (emptyListed) {
        if (!window.confirm(`Remove the empty subsection "${category}" from ${rowScope.label}?`)) return;
        rowScope.own().filter(section => section.type === type).forEach(section => {
          section.subsections = section.subsections.filter(name => name !== category);
        });
        rowScope.save();
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
      const where = kind === 'category' ? ` for ${property.toUpperCase()} in ${rowScope.label}` : '';
      if (!window.confirm(`Delete ${label}${scope}${where}? This cannot be undone.`)) return;
      if (kind === 'category') {
        rowScope.own().filter(section => section.type === type).forEach(section => {
          section.subsections = section.subsections.filter(name => name !== category);
        });
        rowScope.save();
      }
      for (let index = transactions.length - 1; index >= 0; index--) {
        if (doomed.has(transactions[index])) transactions.splice(index, 1);
      }
      saveTransactions();
      editDraft = null;
      renderLedger();
      showToast(kind === 'note' ? 'Note deleted.' : `Deleted ${plural(entries, 'entry')}${notes ? ` and ${plural(notes, 'note')}` : ''}.`);
    }
    // ---- Moving rows (press, hold, drag) ----
    // A move stays inside one month and currency, and never changes the month's totals: an entry that gains its first note
    // keeps its own amount as a note, and one that loses its last note drops to 0.
    const childrenOf = id => transactions.filter(item => item.parentId === id);
    function keepOwnAmountAsNote(entry) {
      if (childrenOf(entry.id).length || !Number(entry.amount)) return false;
      const { id, parentId, ...fields } = entry;
      transactions.push({ ...fields, id: `${entry.id}-own-${Date.now()}`, parentId: entry.id });
      return true;
    }
    function zeroIfEmptied(entry) {
      if (!entry || childrenOf(entry.id).length) return false;
      entry.amount = 0;
      delete entry.formula;
      return true;
    }
    const fileUnder = (item, { category, section, type }) => Object.assign(item, { category, section, type });
    // source: { kind: 'note'|'entry'|'category', id?, name?, type?, section? }; target: { kind: 'entry'|'category'|'type', ... }
    function moveVerdict(source, target) {
      if (!target) return { ok: false };
      if (source.kind === 'note') {
        const note = transactions.find(item => item.id === source.id);
        if (target.kind === 'entry') return target.id === note?.parentId ? { ok: false, label: 'Already in this entry' } : { ok: true, label: `Make a note of “${target.label}”` };
        if (target.kind === 'category') return { ok: true, label: `Make an entry in “${target.name}”` };
      }
      if (source.kind === 'entry') {
        const entry = transactions.find(item => item.id === source.id);
        if (target.kind === 'entry') {
          if (target.id === source.id) return { ok: false };
          return childrenOf(source.id).length ? { ok: false, label: 'An entry with notes can’t become a note' } : { ok: true, label: `Make a note of “${target.label}”` };
        }
        if (target.kind === 'category') return target.name === entry?.category && target.type === entry?.type ? { ok: false, label: 'Already here' } : { ok: true, label: `Move to “${target.name}”` };
      }
      if (source.kind === 'category') {
        if (target.kind === 'category') return target.name === source.name && target.type === source.type ? { ok: false } : { ok: true, label: `Merge into “${target.name}”` };
        if (target.kind === 'type') return target.type === source.type ? { ok: false, label: `Already under ${source.type === 'income' ? 'Income' : 'Expenses'}` } : { ok: true, label: `Move to ${target.type === 'income' ? 'Income' : 'Expenses'}` };
      }
      return { ok: false };
    }
    function applyMove(source, target, { month, property }) {
      const scope = panelScope(month, property);
      const inPanel = scope.match;
      let message = '';
      let listsChanged = false;
      if (source.kind === 'note' || source.kind === 'entry') {
        const item = transactions.find(row => row.id === source.id);
        if (!item) return showToast('Could not find that row. Refresh and try again.');
        const oldParent = transactions.find(row => row.id === item.parentId);
        if (target.kind === 'entry') {
          const parent = transactions.find(row => row.id === target.id);
          const kept = keepOwnAmountAsNote(parent);
          item.parentId = parent.id;
          fileUnder(item, parent);
          expandedEntries.add(parent.id);
          revealKey = catKey(month, property, parent.type, parent.category);
          message = `Moved “${item.description}” under “${parent.description}”${kept ? ', keeping its own amount as a note' : ''}.`;
        } else {
          delete item.parentId;
          const moved = [item, ...childrenOf(item.id)];
          moved.forEach(row => fileUnder(row, { category: target.name, section: target.section, type: target.type }));
          revealKey = catKey(month, property, target.type, target.name);
          message = `Moved “${item.description}” to “${target.name}”.`;
        }
        if (oldParent && oldParent.id !== item.parentId && zeroIfEmptied(oldParent)) message += ` “${oldParent.description}” has no notes left, so it is now 0.`;
      } else {
        const rows = transactions.filter(item => inPanel(item) && item.type === source.type && item.category === source.name);
        const lists = scope.own();
        let destination;
        if (target.kind === 'category') {
          const count = rows.filter(item => !item.parentId).length;
          if (!window.confirm(`Merge “${source.name}” (${count} ${count === 1 ? 'entry' : 'entries'}) into “${target.name}”?`)) return;
          destination = { category: target.name, section: target.section, type: target.type };
        } else {
          const home = lists.find(section => section.type === target.type);
          if (!home) return showToast(`Add an ${target.type === 'income' ? 'income' : 'expense'} section here first.`);
          if (!window.confirm(`Move “${source.name}” and its entries to ${target.type === 'income' ? 'Income' : 'Expenses'}?`)) return;
          if (!home.subsections.includes(source.name)) home.subsections.push(source.name);
          destination = { category: source.name, section: home.name, type: target.type };
        }
        lists.filter(section => section.type === source.type).forEach(section => {
          section.subsections = section.subsections.filter(name => name !== source.name);
        });
        listsChanged = true;
        rows.forEach(item => fileUnder(item, destination));
        revealKey = catKey(month, property, destination.type, destination.category);
        message = target.kind === 'category' ? `Merged “${source.name}” into “${target.name}”.` : `Moved “${source.name}” to ${target.type === 'income' ? 'Income' : 'Expenses'}.`;
      }
      if (listsChanged) scope.save();
      saveTransactions();
      renderLedger();
      showToast(message);
    }
    // Renaming from the year summary changes the whole year for that currency: every month's section lists and every
    // entry and note filed under the row (see ExpenseStore.planRename). Merging into a name that already exists asks first.
    function saveSummaryRename() {
      const edit = summaryEdit;
      const input = document.querySelector('[data-kb-rename] input');
      if (!edit || !input) return;
      const name = input.value.trim().replace(/\s+/g, ' ');
      const year = currentMonth.getFullYear();
      const what = { section: 'section', sub: 'subsection', item: 'item' }[edit.target.level];
      if (name === edit.original) return cancelSummaryRename();
      if (!name) {
        input.setAttribute('aria-invalid', 'true');
        showToast('Type a name first.');
        return input.focus();
      }
      if (!store.isYearLoaded(year)) return showToast(`Still loading ${year}; try again in a moment.`);
      const plan = store.planRename(year, edit.property, edit.target, name);
      if (!plan.months) {
        cancelSummaryRename();
        return showToast(`Nothing in ${year} is filed under “${edit.original}”.`);
      }
      if (plan.merged && !window.confirm(`“${name}” already exists in ${year}. Merge “${edit.original}” into it?`)) return input.focus();
      plan.apply();
      trackSave(store.saveTransactions(year));
      const at = edit.key.lastIndexOf('|') + 1;
      summaryKeyMove = [edit.key, edit.key.slice(0, at) + (ExpenseStore.nameKey(name) || '—')];
      summaryEdit = null;
      renderLedger();
      showToast(`Renamed ${what} “${edit.original}” to “${name}” in ${plan.months} ${plan.months === 1 ? 'month' : 'months'} of ${year} (${plan.entries} ${plan.entries === 1 ? 'entry' : 'entries'}).`);
    }
    function cancelSummaryRename() {
      if (!summaryEdit) return;
      summaryEdit = null;
      renderLedger();
    }
    // Renaming a subsection changes only the month and currency it is shown in: its entries and that month's own list.
    function saveCategoryRename(form) {
      const { month, property, type, category } = form.dataset;
      const input = form.elements.name;
      const hint = form.querySelector('.ledger-form-hint');
      const name = input.value.trim().replace(/\s+/g, ' ');
      const scope = panelScope(month, property);
      if (name === category) {
        editDraft = null;
        return renderLedger();
      }
      const inPanel = item => scope.match(item) && item.type === type;
      const sameName = other => other !== category && other.toLowerCase() === name.toLowerCase();
      const taken = transactions.some(item => inPanel(item) && sameName(item.category));
      const problem = !name ? 'Type a name first.' : taken ? `"${name}" is already used here.` : '';
      if (problem) {
        hint.textContent = problem;
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      // Copy the month's list before moving entries, so the copy still holds the old name.
      const sections = scope.own().filter(section => section.type === type);
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
      scope.save();
      saveTransactions();
      editDraft = null;
      revealKey = catKey(month, property, type, finalName);
      renderLedger();
      showToast(`Renamed "${category}" to "${finalName}"${scope.isEvent ? '' : ' for this month'}.`);
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
        if (!el || el.closest('form') || el.closest('[data-sort-cat]')) return null;
        const summaryRow = el.closest('[data-kb-level]');
        if (summaryRow) return `kb:${summaryRow.closest('[data-key]')?.dataset.key}|${summaryRow.dataset.kbItem ?? ''}`;
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
        // A subsection's Day or Amount sort button: orders its entries and their notes. It sits in the row's <summary>,
        // so the default (opening or closing the row) is prevented, and it never counts toward a double-click rename.
        // Only what is already loaded is redrawn: nothing is fetched from or written to Firebase.
        const sortButton = event.target.closest('[data-sort-cat]');
        if (sortButton) {
          event.preventDefault();
          lastClick = { key: null, time: 0 };
          const { sortCat: key, sortTo: to, sortField: field, sortName: name } = sortButton.dataset;
          if (to === 'date-desc') delete sortModes[key];
          else sortModes[key] = to;
          saveSortModes();
          const focused = document.activeElement === sortButton;
          renderLedger({ loadMissing: false });
          if (focused) document.querySelector(`[data-sort-cat="${CSS.escape(key)}"][data-sort-field="${field}"]`)?.focus({ preventScroll: true });
          return showToast(`${name}: ${B().SORT_LABELS[to]}.`);
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
            return rowKey.startsWith('kb:') ? startSummaryRename(event.target) : triggerEdit(event.target, rowKey);
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
            // An event's settings live with its year's events.
            if (key.startsWith('ev:')) return openYearSettings(currentMonth.getFullYear());
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
        if ((addSub || addEntry) && isViewer) return viewOnly();
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
      // The year-summary name field: Enter renames, Esc cancels, and so does moving focus anywhere else. Focus is checked
      // a frame later because a redraw replaces the field (and refocuses the new one).
      ledger.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !event.target.closest('[data-kb-rename]')) return;
        event.preventDefault();
        cancelSummaryRename();
      });
      ledger.addEventListener('focusout', event => {
        if (!event.target.closest?.('[data-kb-rename]')) return;
        requestAnimationFrame(() => {
          if (summaryEdit && !document.activeElement?.closest('[data-kb-rename]')) cancelSummaryRename();
        });
      });
      ledger.addEventListener('submit', event => {
        if (event.target.closest('[data-kb-rename]')) {
          event.preventDefault();
          return saveSummaryRename();
        }
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
          // In an event a note may carry its own full date; in a month it takes a day within the entry's month.
          const day = form.elements.day?.value ? Math.min(Number(form.elements.day.value), daysInMonth) : undefined;
          const date = form.elements.date ? (form.elements.date.value || undefined) : day ? `${parentYear}-${String(parentMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}` : undefined;
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
            ...(parsed.formula && { formula: parsed.formula }),
            ...(parentItem.eventId && { eventId: parentItem.eventId })
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

      // An event's rows inside a month are read-only there; they are changed in the event itself.
      const blockEventRow = element => {
        const row = element.closest('.ledger-cat[data-event-id]');
        if (!row) return false;
        showToast(`This comes from the event “${store.eventName(row.dataset.eventId)}”. Edit it under Events.`);
        return true;
      };
      // Opens the inline add form for whatever was pressed: an entry → sub-entry, a category → entry,
      // an Income/Expenses header → subsection. Month and currency come from the pressed panel, not the page state.
      const triggerLongPress = (element) => {
        if (isViewer) return false;
        element = getElement(element);
        if (!element || element.closest('form')) return false;
        const panel = element.closest('.ledger-panel');
        const monthBlock = element.closest('.month-block');
        if (!panel || !monthBlock) return false;
        if (blockEventRow(element)) return true;
        const property = panel.dataset.property;
        const mKey = monthBlock.dataset.monthKey;
        const sections = panelScope(mKey, property).sections();
        if (hasDraft()) {
          showToast('Save or cancel the current inline edit first.');
          return true;
        }
        const entryCell = element.closest('.ledger-entry-cell:not(.ledger-sub-entry)');
        const toggle = entryCell?.querySelector('[data-toggle-entry]');
        const cat = element.closest('.ledger-cat');
        // An event panel's currency header stands for the event's own section, which has no title row of its own.
        const typeSection = element.closest('.ledger-type-section') || (element.closest('.ledger-panel-head') && panel.querySelector('.ledger-type-section.is-bare'));
        // The block's own type, not its title: an event's blocks are titled with their section's name.
        const type = typeSection?.dataset.type === 'income' ? 'income' : 'expense';
        const namedSection = typeSection?.dataset.section;

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
          const section = candidates.find(item => item.name === namedSection) || candidates.find(item => item.subsections.includes(categoryName)) || candidates[0];
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
          const section = sections.find(item => item.type === type && item.name === namedSection) || sections.find(item => item.type === type);
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

      // Double-click on a year-summary name: rename it for the whole year. The second click was not let through, so a
      // section or subsection row was toggled once; its state before the double-click is kept for the edit and after it.
      const startSummaryRename = element => {
        if (isViewer) return viewOnly();
        const row = getElement(element)?.closest('[data-kb-level]');
        if (!row) return;
        if (hasDraft()) return showToast('Save or cancel the current inline edit first.');
        const d = row.dataset;
        const details = row.tagName === 'SUMMARY' ? row.parentElement : null;
        summaryEdit = {
          key: details ? details.dataset.key : `${row.closest('[data-key]').dataset.key}|${d.kbItem}`,
          property: d.kbProperty,
          target: { level: d.kbLevel, type: d.kbType, section: d.kbSection, sub: d.kbSub, item: d.kbItem },
          original: d.kbName,
          name: d.kbName,
          open: details ? !details.open : false,
          fresh: true
        };
        renderLedger();
      };
      // Double-click: edit the row in place. Entries and notes get their own fields back; a subsection gets a rename
      // field; Income/Expenses opens the month's settings, where its sections are named.
      const triggerEdit = (element, rowKey) => {
        if (isViewer) return viewOnly();
        element = getElement(element);
        const panel = element?.closest('.ledger-panel');
        const monthBlock = element?.closest('.month-block');
        if (!panel || !monthBlock) return;
        if (blockEventRow(element)) return;
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
          const type = element.closest('.ledger-type-section')?.dataset.type === 'income' ? 'income' : 'expense';
          editDraft = { kind: 'category', month: monthBlock.dataset.monthKey, property: panel.dataset.property, type, category: cat.querySelector('.ledger-cat-name').textContent.trim() };
        } else {
          const section = element.closest('.ledger-type-section');
          if (section) section.open = !section.open;
          if (monthBlock.dataset.monthKey.startsWith('ev:')) return showToast('Press and hold the section name to add a subsection.');
          return openMonthSettings(...yearMonthOf(monthBlock.dataset.monthKey));
        }
        renderLedger();
      };

      // The row a hold acts on: a note, an entry, a subsection, Income/Expenses, or an event panel's currency header.
      const pressRowFor = target => {
        const el = getElement(target);
        if (!el || el.closest('form') || el.closest('[data-sort-cat]')) return null;
        const note = el.closest('.ledger-sub-entry[data-note-id]');
        if (note) return note.querySelector('.ledger-entry-line') || note;
        const cell = el.closest('.ledger-entry-cell:not(.ledger-sub-entry)');
        if (cell) return cell.querySelector(':scope > .ledger-entry-line');
        return el.closest('.ledger-cat > summary, .ledger-type-section > summary, .month-block.is-event .ledger-panel-head');
      };
      // What a held row would move: notes, entries and subsections can be dragged; Income/Expenses cannot.
      const moveSourceFor = row => {
        if (row.closest('[data-event-id]')) return null;
        const note = row.closest('.ledger-sub-entry[data-note-id]');
        if (note) return { kind: 'note', id: note.dataset.noteId, label: note.querySelector('.ledger-entry-desc')?.textContent || '' };
        const toggle = row.querySelector('[data-toggle-entry]');
        if (toggle) return { kind: 'entry', id: toggle.dataset.entryId, label: toggle.querySelector('.ledger-entry-desc')?.textContent || '' };
        const cat = row.closest('.ledger-cat');
        if (cat && row.matches('.ledger-cat > summary')) return { kind: 'category', name: cat.querySelector('.ledger-cat-name').textContent.trim(), type: cat.closest('.ledger-type-section').dataset.type, section: cat.dataset.section, label: cat.querySelector('.ledger-cat-name').textContent.trim() };
        return null;
      };
      // The drop target under a point, limited to the panel the drag started in. A note stands for its entry.
      const dropTargetAt = (x, y, panel) => {
        const el = document.elementFromPoint(x, y);
        if (!el || el.closest('.ledger-panel') !== panel || el.closest('[data-event-id]')) return null;
        const cell = el.closest('.ledger-entry-cell:not(.ledger-sub-entry)') || el.closest('.ledger-sub-entry')?.closest('.ledger-entry-cell:not(.ledger-sub-entry)');
        const toggle = cell?.querySelector(':scope > .ledger-entry-line [data-toggle-entry]');
        if (toggle) return { kind: 'entry', id: toggle.dataset.entryId, label: toggle.querySelector('.ledger-entry-desc')?.textContent || '', el: toggle.closest('.ledger-entry-line') };
        const cat = el.closest('details.ledger-cat');
        if (cat) return { kind: 'category', name: cat.querySelector('.ledger-cat-name').textContent.trim(), type: cat.closest('.ledger-type-section').dataset.type, section: cat.dataset.section, el: cat.querySelector(':scope > summary') };
        const typeHead = el.closest('.ledger-type-section > summary');
        if (typeHead) return { kind: 'type', type: typeHead.parentElement.dataset.type, el: typeHead };
        return null;
      };
      let pressedRow = null;
      let lift = null; // { row, source, panel, month, property, dragging, ghost, target, x, y }
      const pointOf = e => e.touches?.[0] ?? e.changedTouches?.[0] ?? e;
      const startLongPress = (target, e) => {
        if (isViewer) return; // no hold to add, no drag to move
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
          const source = moveSourceFor(row);
          if (source && !hasDraft()) {
            // Lift: the release decides. Let go in place to add as before, or drag to move.
            lift = { row, source, panel: row.closest('.ledger-panel'), month: row.closest('.month-block').dataset.monthKey, property: row.closest('.ledger-panel').dataset.property, dragging: false };
            row.classList.add('is-lifted');
            longPressFired = true;
            navigator.vibrate?.(12);
            return;
          }
          longPressFired = triggerLongPress(longPressTarget);
          if (longPressFired) {
            // The hold re-rendered the row; swallow the click that the release will produce, whenever it comes.
            suppressClickUntil = Infinity;
            navigator.vibrate?.(12);
          }
        }, LONG_PRESS_DURATION);
      };

      const setDropTarget = target => {
        if (lift.target?.el !== target?.el) lift.target?.el?.classList.remove('is-drop-target', 'is-drop-invalid');
        lift.target = target;
        const verdict = moveVerdict(lift.source, target);
        lift.verdict = verdict;
        target?.el?.classList.toggle('is-drop-target', verdict.ok);
        target?.el?.classList.toggle('is-drop-invalid', !verdict.ok && Boolean(verdict.label));
        lift.ghost.querySelector('.drag-ghost-action').textContent = verdict.label || (lift.source.kind === 'category' ? 'Drop on a subsection or on Income / Expenses' : 'Drop on an entry or a subsection');
        lift.ghost.classList.toggle('is-ok', verdict.ok);
      };
      const beginDrag = () => {
        lift.dragging = true;
        lift.row.classList.add('is-drag-source');
        document.body.classList.add('is-dragging-row');
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.innerHTML = `<span class="drag-ghost-label"></span><span class="drag-ghost-action"></span>`;
        ghost.querySelector('.drag-ghost-label').textContent = lift.source.label;
        document.body.append(ghost);
        lift.ghost = ghost;
        const step = () => {
          if (!lift?.dragging) return;
          // Near the top or bottom edge the page scrolls, so a row can travel the whole month.
          const edge = 70;
          const speed = lift.y < edge ? -(edge - lift.y) / 4 : lift.y > innerHeight - edge ? (lift.y - (innerHeight - edge)) / 4 : 0;
          if (speed) {
            window.scrollBy(0, speed);
            setDropTarget(dropTargetAt(lift.x, lift.y, lift.panel));
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      };
      const moveDrag = e => {
        if (!lift) return;
        const point = pointOf(e);
        if (!lift.dragging) {
          const dx = Math.abs(point.pageX - longPressStart.x);
          const dy = Math.abs(point.pageY - longPressStart.y);
          if (dx <= LONG_PRESS_MOVE_THRESHOLD && dy <= LONG_PRESS_MOVE_THRESHOLD) return;
          beginDrag();
        }
        if (e.cancelable) e.preventDefault();
        lift.x = point.clientX;
        lift.y = point.clientY;
        lift.ghost.style.transform = `translate(${point.clientX}px, ${point.clientY}px)`;
        setDropTarget(dropTargetAt(point.clientX, point.clientY, lift.panel));
      };
      const endLift = drop => {
        const done = lift;
        lift = null;
        done.row.classList.remove('is-lifted', 'is-drag-source');
        done.target?.el?.classList.remove('is-drop-target', 'is-drop-invalid');
        done.ghost?.remove();
        document.body.classList.remove('is-dragging-row');
        suppressClickUntil = Date.now() + 600;
        if (!drop) return;
        if (!done.dragging) return triggerLongPress(longPressTarget);
        if (done.verdict?.ok) applyMove(done.source, done.target, done);
      };

      const endLongPress = () => {
        if (lift) endLift(true);
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
        if (lift) return moveDrag(e);
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
      window.addEventListener('pointercancel', () => { if (lift) endLift(false); endLongPress(); });
      // Moves are watched on the window so a drag can leave the row; touchmove must not be passive, so a drag
      // can stop the page from scrolling under the finger.
      window.addEventListener('touchmove', checkLongPressMove, { passive: false });
      window.addEventListener('mousemove', checkLongPressMove);
      window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && lift) {
          endLift(false);
          endLongPress();
          showToast('Move cancelled.');
        }
      });

      ledger.addEventListener('mousedown', (e) => {
        if (e.button === 0 && Date.now() - lastTouchEnd > 500) startLongPress(e.target, e);
      });

      ledger.addEventListener('mouseup', endLongPress);
      // Android raises the context menu mid-hold and cancels the touch; keep the hold alive.
      ledger.addEventListener('contextmenu', (e) => {
        if (longPressTimer || longPressFired || lift || Date.now() < suppressClickUntil) e.preventDefault();
      });

    }
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    }
    // ---- Name suggestions ----
    // Typing a section or subsection name lists names already used anywhere, best match first: exact, then names that
    // start with the text, then a word inside that starts with it, then anywhere inside, then the letters in order.
    // Ties go to names from the same subsection (near), then the most used, then the most recent. Nothing is chosen unless picked (↑/↓ then Enter or Tab, or a click), so a new name can
    // always be typed and saved as is.
    const nameKey = ExpenseStore.nameKey;
    const WORD_BREAK = /[\s\-_/&,.()>·|]/;
    function rankNames(query, items, limit = 8) {
      const q = nameKey(query);
      if (!q) return [];
      const letters = Array.from(q);
      const results = [];
      items.forEach(item => {
        const key = nameKey(item.name);
        let score = -1;
        let at = key.indexOf(q);
        if (key === q) score = 0;
        else if (at === 0) score = 1;
        else if (at > 0) {
          score = 3;
          for (let i = at; i >= 0; i = key.indexOf(q, i + 1)) {
            if (WORD_BREAK.test(key[i - 1])) { score = 2; at = i; break; }
          }
        } else if (letters.length >= 2) {
          // Letters in order with gaps, e.g. "emi hm" → "EMI - Home Loan"; tighter spans rank higher.
          let from = 0;
          let first = -1;
          const ok = letters.every(letter => {
            if (letter === ' ') return true;
            const found = key.indexOf(letter, from);
            if (found < 0) return false;
            if (first < 0) first = found;
            from = found + letter.length;
            return true;
          });
          // Only when the letters sit close together; scattered hits across a long name are noise.
          if (ok && from - first <= letters.length * 3) { score = 4; at = from - first; }
        }
        if (score >= 0) results.push({ item, score, at });
      });
      return results
        .sort((a, b) => a.score - b.score || Number(Boolean(b.item.near)) - Number(Boolean(a.item.near)) || b.item.uses - a.item.uses || String(b.item.last || '').localeCompare(String(a.item.last || '')) || a.at - b.at || a.item.name.length - b.item.name.length || a.item.name.localeCompare(b.item.name))
        .slice(0, limit)
        .map(result => result.item);
    }
    const suggest = (() => {
      const box = document.createElement('div');
      box.className = 'suggest-box';
      box.id = 'name-suggestions';
      box.setAttribute('role', 'listbox');
      box.hidden = true;
      const settings = new WeakMap();
      let active = null; // { input, results, index }
      const marked = (name, query) => {
        const lower = name.normalize('NFC').toLocaleLowerCase();
        const q = query.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
        const at = q ? lower.indexOf(q) : -1;
        if (at < 0) return escapeHtml(name);
        return `${escapeHtml(name.slice(0, at))}<mark>${escapeHtml(name.slice(at, at + q.length))}</mark>${escapeHtml(name.slice(at + q.length))}`;
      };
      const place = () => {
        if (!active) return;
        if (!active.input.isConnected) return close();
        const r = active.input.getBoundingClientRect();
        box.style.minWidth = `${Math.max(r.width, 220)}px`;
        const height = box.offsetHeight;
        const above = innerHeight - r.bottom < height + 12 && r.top > height + 12;
        box.style.top = `${above ? r.top - height - 4 : r.bottom + 4}px`;
        box.style.left = `${Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8))}px`;
      };
      function close() {
        if (!active) return;
        active.input.setAttribute('aria-expanded', 'false');
        active.input.removeAttribute('aria-activedescendant');
        active = null;
        box.hidden = true;
      }
      const render = () => {
        const { input, results, index } = active;
        if (!results.length) {
          box.hidden = true;
          input.setAttribute('aria-expanded', 'false');
          return;
        }
        box.innerHTML = results.map((item, i) => `<div class="suggest-item${i === index ? ' is-active' : ''}" role="option" id="name-suggestion-${i}" aria-selected="${i === index}" data-index="${i}"><span class="suggest-name">${marked(item.name, input.value)}</span>${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}</div>`).join('')
          + '<p class="suggest-hint">↑ ↓ to choose · Enter to use · Esc to close</p>';
        // A modal dialog sits in the top layer, so the list must live inside it to be seen.
        const host = input.closest('dialog') || document.body;
        if (box.parentElement !== host) host.append(box);
        box.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        if (index >= 0) input.setAttribute('aria-activedescendant', `name-suggestion-${index}`);
        else input.removeAttribute('aria-activedescendant');
        place();
      };
      const refresh = input => {
        const options = settings.get(input);
        if (!options) return;
        active = { input, results: rankNames(input.value, options.items()), index: -1 };
        render();
      };
      const pick = index => {
        const { input, results } = active;
        const item = results[index];
        close();
        settings.get(input)?.onPick(item, input);
      };
      box.addEventListener('pointerdown', event => event.preventDefault());
      box.addEventListener('click', event => {
        const option = event.target.closest('[data-index]');
        if (option && active) pick(Number(option.dataset.index));
      });
      // Capture phase, so a highlighted pick wins over the field's own Enter, Tab and Esc handling.
      document.addEventListener('keydown', event => {
        if (!active || event.target !== active.input || box.hidden) return;
        const count = active.results.length;
        const stop = () => { event.preventDefault(); event.stopImmediatePropagation(); };
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          stop();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          active.index = active.index + step >= count ? -1 : active.index + step < -1 ? count - 1 : active.index + step;
          render();
        } else if ((event.key === 'Enter' || event.key === 'Tab') && active.index >= 0) {
          stop();
          pick(active.index);
        } else if (event.key === 'Escape') {
          stop();
          close();
        }
      }, true);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      return {
        close,
        // items(): [{ name, uses, note? }] to choose from; onPick(item, input) applies the choice.
        attach(input, options) {
          settings.set(input, options);
          if (input.dataset.suggest) return;
          input.dataset.suggest = 'on';
          input.setAttribute('role', 'combobox');
          input.setAttribute('aria-autocomplete', 'list');
          input.setAttribute('aria-controls', 'name-suggestions');
          input.setAttribute('aria-expanded', 'false');
          input.setAttribute('autocomplete', 'off');
          input.addEventListener('input', () => refresh(input));
          input.addEventListener('focus', () => { if (input.value.trim()) refresh(input); });
          input.addEventListener('blur', () => { if (active?.input === input) close(); });
        }
      };
    })();
    const usesNote = uses => `used ${uses}×`;
    // Subsection names of one type, minus those the caller already has.
    function subsectionChoices(type, taken = []) {
      const takenKeys = new Set(taken.map(nameKey));
      return store.nameCatalog().subsections
        .filter(item => item.type === type && !takenKeys.has(nameKey(item.name)))
        .map(item => ({ ...item, note: usesNote(item.uses) }));
    }
    // Entry or note descriptions used before; those filed under the same subsection rank first. The field's own current
    // text is left out. Past months load in the background the first time, so suggestions cover the whole year.
    function descriptionChoices(kind, { type, category } = {}, current = '') {
      warmDescriptions();
      const here = type && category ? `${type}:${nameKey(category)}` : null;
      const skip = nameKey(current);
      return store.descriptionCatalog()[kind]
        .filter(item => nameKey(item.name) !== skip)
        .map(item => ({ ...item, near: Boolean(here && item.categories.has(here)), note: here && item.categories.has(here) ? `here · ${usesNote(item.uses)}` : usesNote(item.uses) }));
    }
    // Each year loads once; a failed load is retried the next time a description field asks.
    const warmYears = new Set();
    function warmDescriptions() {
      const year = new Date().getFullYear();
      [year, year - 1].filter(value => store.year(value) && !warmYears.has(value)).forEach(value => {
        warmYears.add(value);
        store.ensureYear(value).catch(error => {
          warmYears.delete(value);
          console.warn('Could not load past entries for suggestions; will retry.', error);
        });
      });
    }
    // Picking a description fills it in and moves on to the next field.
    const pickDescription = (form, next = 'place') => (item, input) => {
      input.value = item.name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      suggest.close();
      form.elements[next]?.focus();
    };
    function sectionChoices(taken = []) {
      const takenKeys = new Set(taken.map(nameKey));
      return store.nameCatalog().sections
        .filter(item => !takenKeys.has(nameKey(item.name)))
        .map(item => ({ ...item, note: `${item.type === 'income' ? 'Income' : 'Expense'} · ${usesNote(item.uses)}` }));
    }
    function viewOnly() {
      showToast('View only: you can look around, but not change anything.');
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
      const items = key => transactions.filter(item => !item.parentId && !item.eventId && item.property === key && item.date.startsWith(keyOf(year, month)));
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
            onChange: () => monthState.dirty.add(key),
            suggestions: values => subsectionChoices(section.type, values)
          }));
          suggest.attach(box.querySelector('.config-section-name'), {
            items: () => sectionChoices(list.filter(other => other !== section).map(other => other.name)),
            onPick: item => {
              Object.assign(section, { name: item.name, type: item.type });
              monthState.dirty.add(key);
              renderMonthSections();
            }
          });
          holder.append(box);
        });
        if (!list.length) holder.innerHTML = '<p class="config-muted">No sections this month yet. Add one to start categorising entries.</p>';
        root.append(block);
      });
    }
    function openMonthSettings(year, month) {
      if (isViewer) return viewOnly();
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
      // One letter per currency (I for India, J for Japan); the code is used instead if two names share a letter.
      const initials = currencies.map(key => regions[key].name.trim().charAt(0).toLocaleUpperCase());
      const short = (key, index) => (initials.indexOf(initials[index]) === initials.lastIndexOf(initials[index]) ? initials[index] : regions[key].code);
      document.querySelector('#entry-currency').innerHTML = currencies.map((key, index) => `<button type="button" data-value="${key}" aria-pressed="${key === entryState.currency}" aria-label="${escapeHtml(regions[key].name)}" title="${escapeHtml(`${regions[key].name} · ${regions[key].code}`)}"><span class="cur-dot ${regions[key].color}"></span>${escapeHtml(short(key, index))}</button>`).join('')
        || `<span class="config-muted">${date && store.year(date.getFullYear()) ? 'No currency' : 'Year not set up'}</span>`;
      const select = document.querySelector('#entry-category');
      const previous = select.value;
      const sections = date ? store.sections(date.getFullYear(), date.getMonth(), entryState.currency).filter(section => section.type === entryState.type) : [];
      select.innerHTML = sections.map(section => `<optgroup label="${escapeHtml(section.name)}">${section.subsections.map(name => `<option value="${escapeHtml(name)}" data-section="${escapeHtml(section.name)}">${escapeHtml(name)}</option>`).join('')}</optgroup>`).join('');
      if ([...select.options].some(option => option.value === previous)) select.value = previous;
      document.querySelector('#entry-dialog-title').textContent = entryState.type === 'income' ? 'Add income' : 'Add an expense';
    }
    // Opens on today's date; only if today's month is not set up does it fall back to the newest open month.
    function openEntryDialog() {
      if (isViewer) return viewOnly();
      const today = new Date();
      const openKey = [...expandedMonths].filter(key => key.startsWith(`${currentMonth.getFullYear()}-`)).sort().pop();
      const fallback = openKey ? new Date(Number(openKey.slice(0, 4)), Number(openKey.slice(5, 7)) - 1, 1) : new Date(currentMonth.getFullYear(), today.getFullYear() === currentMonth.getFullYear() ? today.getMonth() : 0, 1);
      const base = store.monthNode(today.getFullYear(), today.getMonth()) ? today : fallback;
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
      suggest.attach(form.elements.description, {
        items: () => {
          const option = form.elements.category.selectedOptions[0];
          return descriptionChoices('entries', option ? { type: entryState.type, category: option.value } : {});
        },
        onPick: pickDescription(form)
      });
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
          [fields.amount, !parsed.error && !parsed.empty && amount >= 0] // 0 is allowed: a gift with no money, say
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
    const configState = { year: null, drafts: {}, events: {} };
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
    // suggestions(values) → names to offer while typing (see suggest); a picked name is added as one chip.
    function chipInput({ values, label, placeholder, countFor = () => 0, onChange = () => {}, suggestions = null }) {
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
      const add = (raw, { whole = false } = {}) => {
        const problems = [];
        (whole ? [raw] : raw.split(/[,\n]/)).map(part => part.trim().replace(/\s+/g, ' ')).filter(Boolean).forEach(part => {
          const value = part.slice(0, 40);
          if (values.some(existing => nameKey(existing) === nameKey(value))) return problems.push(`"${value}" is already added.`);
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
      if (suggestions) suggest.attach(input, { items: () => suggestions(values), onPick: item => { add(item.name, { whole: true }); input.focus(); } });
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
      }).join('');
      document.querySelector('.config-body').hidden = !year;
      if (!year) return;
      renderConfigCurrencies();
      renderConfigEvents();
      document.querySelector('#year-settings-error').hidden = true;
    }
    // ---- Special events of the year: listed here, added with +, saved with the dialog ----
    // Each event shows at the top of its year's months, like a month with its own name, with a panel for each currency it
    // is tagged with.
    function eventDraft(year) {
      configState.events[year] ||= store.eventsOfYear(year).map(event => ({ id: event.id, name: event.name, include: event.include, currencies: [...event.currencies], removed: false }));
      return configState.events[year];
    }
    // A currency an event already has entries in stays tagged; it can be turned off once those entries are gone.
    const eventCurrencyLocked = (row, key) => Boolean(row.id && store.eventItems(row.id, key).length);
    // Currency tags offered for an event: the year's currencies, plus any the event already uses.
    function eventCurrencyChips(row, year) {
      const used = row.id ? store.eventCurrencies(row.id) : [];
      const keys = store.ordered([...store.yearCurrencies(year), ...row.currencies, ...used]);
      return `<div class="event-currencies" role="group" aria-label="Currencies for ${escapeHtml(row.name || 'this event')}">${keys.map(key => {
        const on = row.currencies.includes(key) || eventCurrencyLocked(row, key);
        const locked = eventCurrencyLocked(row, key);
        const title = locked ? `Has ${regions[key].code} entries` : `${on ? 'Remove' : 'Add'} ${regions[key].code}`;
        return `<button type="button" class="event-currency" data-event-currency="${key}" aria-pressed="${on}" title="${escapeHtml(title)}"${locked ? ' aria-disabled="true"' : ''}><span class="cur-dot ${regions[key].color}"></span>${escapeHtml(regions[key].code)}</button>`;
      }).join('')}</div>`;
    }
    function renderConfigEvents() {
      const year = configState.year;
      const rows = eventDraft(year);
      const visible = rows.map((row, index) => ({ row, index })).filter(({ row }) => !row.removed);
      document.querySelector('#config-events').innerHTML = visible.map(({ row, index }) => {
        const entries = row.id ? store.eventItems(row.id).filter(item => !item.parentId).length : 0;
        return `<div class="config-event" data-event-index="${index}">
          <i class="ti ti-star-filled" aria-hidden="true"></i>
          <input class="config-event-name" value="${escapeHtml(row.name)}" placeholder="Event name, e.g. Marriage" aria-label="Event name" maxlength="60" autocomplete="off">
          <span class="config-usage">${entries ? `${entries} ${entries === 1 ? 'entry' : 'entries'}` : ''}</span>
          ${eventCurrencyChips(row, year)}
          <label class="event-switch" title="Also count this event's entries in the months they happened"><input type="checkbox" data-event-include${row.include ? ' checked' : ''}><span class="event-switch-track" aria-hidden="true"></span><span>Show in months</span></label>
          <button type="button" class="icon-button config-remove" data-remove-event aria-label="Delete ${escapeHtml(row.name || 'event')}" title="Delete event"><i class="ti ti-trash" aria-hidden="true"></i></button>
        </div>`;
      }).join('');
    }
    // Saves the year's event changes: new events, renames, Show in months, and deletions (after confirming any with entries).
    function saveConfigEvents() {
      const changed = [];
      for (const [year, rows] of Object.entries(configState.events)) {
        const kept = rows.filter(row => !row.removed);
        const names = kept.map(row => nameKey(row.name));
        if (names.some(name => !name)) return { problem: `${year}: every event needs a name.`, year };
        if (new Set(names).size !== names.length) return { problem: `${year}: event names must be unique.`, year };
        if (kept.some(row => !row.currencies.length)) return { problem: `${year}: every event needs a currency.`, year };
      }
      // A name may also not repeat an event of another year, so the same event is never created twice.
      const removed = new Set(Object.values(configState.events).flat().filter(row => row.removed && row.id).map(row => row.id));
      for (const [year, rows] of Object.entries(configState.events)) {
        for (const row of rows.filter(item => !item.removed)) {
          const clash = store.eventList().find(other => other.id !== row.id && !removed.has(other.id) && nameKey(other.name) === nameKey(row.name)
            && !(configState.events[other.year] || []).some(item => item.id === other.id && nameKey(item.name) !== nameKey(row.name)));
          if (clash && clash.year !== Number(year)) return { problem: `“${row.name.trim()}” already exists in ${clash.year}. Open ${clash.year} to use it, or choose another name.`, year };
        }
      }
      const doomed = Object.values(configState.events).flat().filter(row => row.removed && row.id);
      const withEntries = doomed.filter(row => store.eventItems(row.id).length);
      if (withEntries.length && !window.confirm(`Delete ${withEntries.map(row => `“${store.eventName(row.id)}”`).join(', ')} and all ${withEntries.length === 1 ? 'its' : 'their'} entries? This cannot be undone.`)) return { problem: 'Nothing was deleted.', cancelled: true };
      doomed.forEach(row => {
        trackSave(store.deleteEvent(row.id));
        expandedMonths.delete(`ev:${row.id}`);
        changed.push(`deleted ${row.name}`);
      });
      Object.entries(configState.events).forEach(([year, rows]) => rows.filter(row => !row.removed).forEach(row => {
        const name = row.name.trim().replace(/\s+/g, ' ');
        if (!row.id) {
          const id = `ev-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
          trackSave(store.createEvent(id, name, Number(year), row.currencies));
          store.events[id].currencies.forEach(key => store.ownEventSections(id, key));
          trackSave(store.saveEventMeta(id, { sections: store.events[id].sections, ...(row.include && { include: true }) }));
          expandedMonths.add(`ev:${id}`);
          changed.push(`added ${name}`);
          return;
        }
        const fields = {};
        if (name !== store.eventName(row.id)) {
          // The section named after the event follows the new name, in its list and on its entries.
          const old = nameKey(store.eventName(row.id));
          const lists = store.events[row.id].sections;
          const named = Object.values(lists).flat().filter(section => nameKey(section.name) === old);
          if (named.length) {
            named.forEach(section => { section.name = name; });
            store.eventItems(row.id).filter(item => item.section && nameKey(item.section) === old).forEach(item => { item.section = name; });
            fields.sections = lists;
            saveTransactions();
          }
          fields.name = name;
        }
        if (row.include !== store.events[row.id].include) fields.include = row.include;
        const currencies = store.ordered(row.currencies);
        if (currencies.join() !== store.ordered(store.events[row.id].currencies).join()) fields.currencies = currencies;
        if (Object.keys(fields).length) {
          trackSave(store.saveEventMeta(row.id, fields));
          changed.push(`updated ${name}`);
        }
      }));
      saveExpandedMonths();
      return { changed };
    }
    function showConfigYear(year) {
      configState.year = store.year(year) ? year : null;
      renderConfig();
    }
    function openYearSettings(year) {
      if (isViewer) return viewOnly();
      const dialog = document.querySelector('#year-settings-dialog');
      if (!dialog) return;
      configState.drafts = {};
      configState.events = {};
      showConfigYear(year);
      dialog.showModal();
    }
    // Next year sets itself up once it is four months away (from September): it takes this year's currencies and brings
    // in their closing balances. Its months start with no sections.
    function ensureNextYear() {
      const today = new Date();
      const next = today.getFullYear() + 1;
      const current = store.year(next - 1);
      if (today.getMonth() < 8 || store.year(next) || !current) return;
      const currencies = Object.fromEntries((current.metadata.currencies || []).map(key => [key, { from: 'January', opening: 0, carryIn: true }]));
      if (Object.keys(currencies).length) saveYearConfig(next, { currencies });
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
      const eventRow = target => {
        const row = target.closest('.config-event');
        return row ? eventDraft(configState.year)[Number(row.dataset.eventIndex)] : null;
      };
      form.addEventListener('input', event => {
        const row = eventRow(event.target);
        if (row && event.target.matches('.config-event-name')) row.name = event.target.value;
      });
      form.addEventListener('change', event => {
        const row = eventRow(event.target);
        if (row && event.target.matches('[data-event-include]')) row.include = event.target.checked;
      });
      form.addEventListener('click', event => {
        if (event.target.closest('#config-add-event')) {
          const first = store.yearCurrencies(configState.year)[0] || store.currencyKeys()[0];
          eventDraft(configState.year).push({ id: null, name: '', include: false, currencies: first ? [first] : [], removed: false });
          renderConfigEvents();
          return document.querySelector('#config-events .config-event:last-child .config-event-name')?.focus();
        }
        const chip = event.target.closest('[data-event-currency]');
        if (chip) {
          const row = eventRow(chip);
          const key = chip.dataset.eventCurrency;
          const error = document.querySelector('#year-settings-error');
          const on = row.currencies.includes(key);
          const problem = eventCurrencyLocked(row, key) ? `“${row.name.trim() || 'This event'}” has ${regions[key].code} entries, so ${regions[key].code} stays on.`
            : on && row.currencies.length === 1 ? 'An event needs at least one currency.' : '';
          error.textContent = problem;
          error.hidden = !problem;
          if (problem) return;
          row.currencies = on ? row.currencies.filter(item => item !== key) : [...row.currencies, key];
          renderConfigEvents();
          return document.querySelector(`#config-events [data-event-index="${chip.closest('.config-event').dataset.eventIndex}"] [data-event-currency="${key}"]`)?.focus();
        }
        const remove = event.target.closest('[data-remove-event]');
        if (remove) {
          eventRow(remove).removed = true;
          renderConfigEvents();
        }
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
        const events = saveConfigEvents();
        if (events.problem) {
          if (events.year) {
            configState.year = Number(events.year);
            renderConfig();
          }
          error.textContent = events.problem;
          error.hidden = false;
          return;
        }
        touched.forEach(([year, draft]) => {
          const currencies = Object.fromEntries(draftCurrencies(draft).map(key => [key, { from: draft.from[key], opening: Math.round(Number(draft.openings[key] || 0) * 100), carryIn: draft.carryIn[key] }]));
          saveYearConfig(Number(year), { currencies });
        });
        dialog.close();
        renderLedger();
        const parts = [...(touched.length ? [`saved ${touched.map(([year]) => year).join(' & ')} settings`] : []), ...events.changed];
        showToast(parts.length ? `${parts.join(', ').replace(/^./, char => char.toUpperCase())}.` : 'No changes to save.');
      });
    }
    ensureNextYear();
    setupYearConfig();
    setupMonthSettings();
    setupEntryDialog();
    setupLedger();
    document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
    // Light or dark: remembered per browser; dark is the default.
    const themeButton = document.querySelector('#theme-button');
    const showTheme = () => {
      const light = document.documentElement.dataset.theme === 'light';
      themeButton.innerHTML = `<i class="ti ti-${light ? 'moon' : 'sun'}" aria-hidden="true"></i>`;
      themeButton.setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} theme`);
      themeButton.title = `Switch to ${light ? 'dark' : 'light'} theme`;
      document.querySelector('meta[name="theme-color"]').content = light ? '#f6f3ec' : '#090a0f';
    };
    themeButton.addEventListener('click', () => {
      const light = document.documentElement.dataset.theme !== 'light';
      if (light) document.documentElement.dataset.theme = 'light';
      else delete document.documentElement.dataset.theme;
      try { localStorage.setItem('family-budget-theme', light ? 'light' : 'dark'); } catch (error) { /* Not remembered this time. */ }
      showTheme();
    });
    showTheme();
    document.querySelector('#logout-button').addEventListener('click', () => {
      sessionStorage.removeItem(`${STORAGE_KEY}-passkey-signed-in`);
      sessionStorage.removeItem(`${STORAGE_KEY}-signed-in`);
      sessionStorage.removeItem(`${STORAGE_KEY}-viewer`);
      FamilyAuth.signOut();
      window.location.href = LOGIN_PAGE;
    });
    if (isViewer) {
      const saveState = document.querySelector('.save-state');
      if (saveState) saveState.innerHTML = '<i class="ti ti-eye" aria-hidden="true"></i> View only';
    }
    renderLedger();
    })();
