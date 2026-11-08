const STORAGE_KEY = 'kajanauday-static-demo-v1';
    // How much of the ledger this device may keep offline.
    const OFFLINE_BUDGET = 200 * 1024 * 1024;
    // The app's own files are kept on the device too (sw.js), so it opens with no connection; the ledger's data is kept
    // separately, by offline-store.js.
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register(new URL('../sw.js', document.baseURI)).catch(error => console.warn('The app cannot be kept on this device.', error)));
    }
    // Data now lives in Firebase; drop what older builds kept in this browser.
    try { [STORAGE_KEY, `${STORAGE_KEY}-year-settings`, `${STORAGE_KEY}-view`].forEach(key => localStorage.removeItem(key)); } catch (error) { /* Nothing to clean up. */ }
    // Signed in means a Firebase Auth session (see firebase-auth.js), for this tab or kept on this device; without one,
    // back to the sign-in page.
    const LOGIN_PAGE = '../kajanauday-vertical.html';
    (async () => {
    const authSession = window.FamilyAuth ? await FamilyAuth.restore() : null;
    if (!authSession) return window.location.replace(LOGIN_PAGE);
    // View-only accounts: everything can be seen, nothing can be changed. The store itself cannot write,
    // and every way into editing below stops with a short note instead. Database rules enforce the same on the server.
    const isViewer = authSession.role === 'viewer';
    if (isViewer) document.documentElement.classList.add('is-viewer');
    let store;
    // This device and Firebase (see "Sync markers and panel"); set up before the store opens, which already reports.
    // pending: paths changed here and not in Firebase yet; outdated: nodes kept here that Firebase has newer; newer: the
    // paths written elsewhere; busy: a sync in progress; needsRefresh: the page shows something Firebase has changed.
    const syncState = { pending: [], outdated: [], newer: [], kept: 0, bytes: 0, offline: false, error: null, checkedAt: null, mirroredAt: null, busy: null, needsRefresh: false };
    let syncNow = () => Promise.resolve();
    try {
      // Every request carries the signed-in user's ID token; a session Firebase no longer accepts goes back to sign-in.
      const auth = () => FamilyAuth.token().catch(error => {
        if (error.code === 'signed-out') window.location.replace(LOGIN_PAGE);
        throw error;
      });
      // The copy of the ledger kept on this device: the app opens and takes new entries with no connection, and what was
      // added offline goes out as soon as there is one. Without it (a private window, say) the app runs online-only.
      const vault = window.OfflineVault ? await OfflineVault.open({ budget: OFFLINE_BUDGET }) : null;
      const offline = vault ? { vault, deviceId: deviceId(), onState: setSyncStatus, onConflict: askAboutConflict } : null;
      store = await ExpenseStore.open({ databaseURL: FIREBASE_CONFIG.databaseURL, root: FIREBASE_ROOT, readOnly: isViewer, auth, offline });
    } catch (error) {
      console.error('Could not load data from Firebase.', error);
      setSaveStatus('load-error');
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

    function saveTransactions() { trackSave(store.saveTransactions()); }
    function saveYearConfig(year, config = {}) { trackSave(store.saveYear(year, config)); }
    const yearMonthOf = mKey => [Number(mKey.slice(0, 4)), Number(mKey.slice(5, 7)) - 1];
    function saveMonthSections(mKey, property) {
      const [year, monthIndex] = yearMonthOf(mKey);
      trackSave(store.saveMonthSections(year, monthIndex, property, store.ownSections(year, monthIndex, property)));
    }
    // The save status in the top bar is only a coloured dot: green saved, amber saving, red when saving or loading
    // failed, blue for a view-only sign-in. The words are its tooltip and are read out by screen readers.
    function setSaveStatus(state) {
      const text = { saved: 'All changes saved', saving: 'Saving…', pending: 'Waiting to send to Firebase', offline: 'Offline — changes are saved on this device', behind: 'Newer data in Firebase — updating this device', error: 'Could not save to Firebase', 'load-error': 'Could not load data from Firebase', viewer: 'View only' }[state] || '';
      const el = document.querySelector('.save-state');
      if (!el) return;
      el.dataset.state = state;
      el.title = text;
      el.innerHTML = `<span class="save-dot" aria-hidden="true"></span><span class="sr-only">${text}</span>`;
    }
    // The name this device signs its writes with, so its own saves are never mistaken for another device's.
    function deviceId() {
      try {
        const kept = localStorage.getItem(`${STORAGE_KEY}-device`);
        if (kept) return kept;
        const made = `d${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
        localStorage.setItem(`${STORAGE_KEY}-device`, made);
        return made;
      } catch (error) {
        return 'device';
      }
    }
    // What the sync layer reports, as the dot in the top bar. A viewer's dot stays on 'viewer'. All saved, but Firebase
    // holding something newer than this device, shows as 'behind'; the month markers follow the outbox (see syncMarks).
    function setSyncStatus(state) {
      if (isViewer) return;
      const behind = state === 'synced' && syncState.outdated.length;
      setSaveStatus(behind ? 'behind' : { synced: 'saved', pending: 'pending', offline: 'offline', saving: 'saving', error: 'error' }[state] || 'saved');
      if (store?.sync) refreshPendingMarks();
    }
    // Another device wrote the same part of the ledger after this one last read it. Nothing is merged on its own: the
    // choice is this device's queued change or the newer one already in Firebase.
    // However this dialog goes away — a button, Esc, the backdrop, anything closing it — it answers. Left unanswered it
    // would hold the outbox open for good: the flush waiting on it never ends, so nothing after it could save or sync,
    // and the dot would sit on amber with Sync now doing nothing. Dismissing it keeps this device's change, which loses
    // nothing; only “Use the other version” drops it.
    function askAboutConflict({ paths, at }) {
      const dialog = document.querySelector('#conflict-dialog');
      if (!dialog) return Promise.resolve('mine');
      const names = [...new Set(paths.map(describePath))];
      document.querySelector('#conflict-what').textContent = `${names.length === 1 ? names[0] : `${names.length} parts of the ledger`} changed on another device after this one went offline.`;
      document.querySelector('#conflict-when').textContent = `Changed here ${new Date(at).toLocaleString()}.`;
      const list = document.querySelector('#conflict-paths');
      list.replaceChildren(...names.map(name => Object.assign(document.createElement('li'), { textContent: name })));
      // An earlier one still on screen is closed first, before anything here listens for that.
      if (dialog.open) dialog.close();
      return new Promise(resolve => {
        let answer = 'mine';
        const done = () => {
          dialog.removeEventListener('click', choose);
          dialog.removeEventListener('close', done);
          resolve(answer);
        };
        const choose = event => {
          const button = event.target.closest('[data-conflict]');
          if (!button) return;
          answer = button.dataset.conflict;
          dialog.close();
        };
        dialog.addEventListener('click', choose);
        dialog.addEventListener('close', done);
        try {
          dialog.showModal();
        } catch (error) {
          // It could not be put on screen, so there is nobody to ask: this device's change stays.
          console.warn('Could not ask which version to keep.', error);
          done();
        }
      });
    }
    // A Firebase path as something to read: "October 2026", "the 2026 totals", an event's name.
    function describePath(path) {
      const month = /^months\/(\d{4})_(\w+)$/.exec(path);
      if (month) return `${month[2]} ${month[1]}`;
      const year = /^years\/(\d{4})$/.exec(path);
      if (year) return `the ${year[1]} totals`;
      const event = /^events\/([^/]+)/.exec(path);
      if (event) return `the event “${store?.eventName?.(event[1]) || 'special'}”`;
      return path;
    }
    function trackSave(write) {
      if (isViewer) return;
      setSaveStatus('saving');
      write.then(() => {
        setSaveStatus('saved');
      }).catch(error => {
        console.error('Could not save to Firebase.', error);
        // With a copy on this device the change is already safe here and goes out when the connection returns.
        if (store.sync) return showToast('No connection. The change is saved on this device and will go out later.');
        setSaveStatus('error');
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
    function monthLabel(date = currentMonth) {
      return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    }
    function dayLabel(date) {
      // A row standing for a group carries day 0, which is no date at all: shown as a dash rather than put through a
      // date it would come back from as "Invalid Date".
      if (String(date).slice(8, 10) === '00') return '—';
      return new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    }
    // ---- Monthly ledger (months.html) ----
    // Inline ledger drafts: subsection adds and unsaved transaction fields.
    let ledgerDraft = null;
    let entryDraft = null;
    let subEntryDraftParentId = null;
    // { kind: 'entry' | 'note', id }, { kind: 'category', month, property, type, category, section }, or in the year card
    // { kind: 'year-section', month, property, type, block, group, section } and
    // { kind: 'year-item', month, property, type, section, category, item }
    let editDraft = null;
    const hasDraft = () => Boolean(ledgerDraft || entryDraft || subEntryDraftParentId || editDraft);
    const expandedEntries = new Set();
    let revealKey = null; // subsection to open on the next render, e.g. the one that just got an entry
    const catKey = (month, property, section, category) => [month, property, section, category].join('|');
    const keyOf = (year, month) => `${year}-${String(month + 1).padStart(2, '0')}`;
    // Months whose ledger is open. A fresh session opens the current month on wider screens; on phones every month
    // starts closed so the whole year's list fits on screen (an open month is several screens tall there).
    const isPhone = () => window.matchMedia('(max-width: 700px)').matches;
    const expandedMonths = new Set(JSON.parse(sessionStorage.getItem(`${STORAGE_KEY}-open-months`) || 'null') || (isPhone() ? [] : [keyOf(new Date().getFullYear(), new Date().getMonth())]));
    // Which currencies an open month (or event) shows, when chosen from its summary: month key → currency list. A month
    // not listed shows every currency. Remembered for the tab, like the open months.
    const monthCurrencies = new Map(JSON.parse(sessionStorage.getItem(`${STORAGE_KEY}-month-currencies`) || '[]'));
    function saveMonthCurrencies() {
      sessionStorage.setItem(`${STORAGE_KEY}-month-currencies`, JSON.stringify([...monthCurrencies]));
    }
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
    // How far the main blocks spell out what a settlement or a pot posts into them: 'total' (one figure for the whole
    // block, the default), 'section' (one per settlement) or 'sub' (every subsection on its own line). Income and
    // Expenses read as a control account: the block posts one line under its own name and keeps the settlement-by-
    // settlement detail in the Settlements block below, where the reader can already see it. A way of reading the
    // month, not a fact about it, so like the sort order it stays in this browser and is never written to Firebase.
    const POSTING_KEY = `${STORAGE_KEY}-posting`;
    const POSTING_MODES = ['total', 'section', 'sub'];
    const POSTING_LABELS = {
      total: { label: 'the block as one figure', hint: 'the default · Settlements posts a single total; the detail stays in its own block' },
      section: { label: 'one line per settlement', hint: 'each settlement posts under its own name' },
      sub: { label: 'a line for every subsection', hint: 'each subsection posts on its own, named after its settlement' }
    };
    let postingMode = (() => {
      try { const saved = localStorage.getItem(POSTING_KEY); return POSTING_MODES.includes(saved) ? saved : 'total'; } catch (error) { return 'total'; }
    })();
    function setPostingMode(mode) {
      if (!POSTING_MODES.includes(mode) || mode === postingMode) return;
      postingMode = mode;
      try { localStorage.setItem(POSTING_KEY, mode); } catch (error) { /* Not remembered; still applies now. */ }
      renderLedger({ loadMissing: false });
      showToast(`Income and Expenses now show ${POSTING_LABELS[mode].label}.`);
    }
    // The ledger shows one year's months, or (the ★ tab beside the years) the special cards and hashtags page (see
    // renderHub). Remembered for the tab.
    let specialMode = sessionStorage.getItem(`${STORAGE_KEY}-special`) === 'true';
    function setSpecialMode(on) {
      specialMode = Boolean(on);
      sessionStorage.setItem(`${STORAGE_KEY}-special`, String(specialMode));
    }
    const renderState = () => ({ expandedEntries, expandedMonths, monthCurrencies: Object.fromEntries(monthCurrencies), entryDraft, subEntryDraftParentId, ledgerDraft, editDraft, sortModes, postingMode });
    const B = () => window.LedgerBlueprints;
    const ledgerCtx = {
      fmt: formatMoney, compact: compactMoney, esc: escapeHtml, dayLabel, keyOf, catKey, monthLabel, regions,
      flow: id => store.flow(id),
      today: () => { const now = new Date(); return `${keyOf(now.getFullYear(), now.getMonth())}-${String(now.getDate()).padStart(2, '0')}`; }
    };
    const ledgerRenderer = new LedgerRenderer(store, ledgerCtx);
    function renderMonthGroups(year) { return ledgerRenderer.monthGroups(year, renderState()); }
    // loadMissing: false redraws from what is already in memory only, without starting any Firebase load.
    function renderLedger({ loadMissing = true } = {}) {
      const ledger = document.querySelector('#ledger');
      if (!ledger) return;
      const year = currentMonth.getFullYear();
      document.querySelector('#year-tabs').innerHTML = ledgerRenderer.yearTabs(year, specialMode);
      const specialButton = document.querySelector('[data-ledger-special]');
      specialButton.setAttribute('aria-pressed', String(specialMode));
      specialButton.title = specialMode ? `Back to ${year}` : 'Special cards, flows and #hashtags';
      // Keep open subsections open across re-renders (e.g. after saving an entry).
      const host = document.querySelector('#month-ledger');
      const keepOpen = [...host.querySelectorAll('.ledger-cat[open], .ledger-cat.is-editing')].map(cat => cat.dataset.key);
      const keepOpenTypes = new Set([...host.querySelectorAll('details.ledger-type-section[open]')].map(section => section.dataset.key));
      const keepSettled = new Set([...host.querySelectorAll('details.ledger-settled[open]')].map(fold => fold.dataset.key));
      // A posted balance line opened for its breakdown stays open too: it is read while entries are being added, and
      // closing it on every save would shut the one thing the reader was looking at.
      const keepPosted = new Set([...host.querySelectorAll('details.ledger-carry[open]')].map(line => line.dataset.key));
      // The year card's section groups (open by default), description lists and months (closed by default) stay as they were.
      const yearFolds = new Map([...host.querySelectorAll('.month-block.is-year details.ledger-year-group, .month-block.is-year details.ledger-year-items, .month-block.is-year details.ledger-year-month')].map(item => [item.dataset.key, item.open]));
      const typingFilter = document.activeElement?.matches?.('[data-hub-filter]');
      host.innerHTML = specialMode ? renderHub() : store.year(year) ? renderMonthGroups(year) : '<p class="ledger-none">No years in Firebase yet. Add one from Year settings.</p>';
      if (specialMode) {
        applyHubFilter(host);
        if (typingFilter) host.querySelector('[data-hub-filter]')?.focus({ preventScroll: true });
        loadHubYears();
      }
      host.querySelectorAll('.ledger-cat').forEach(cat => { if (keepOpen.includes(cat.dataset.key) || cat.dataset.key === revealKey) cat.open = true; });
      // Income / Expenses blocks open before stay open, and an open subsection keeps its block open.
      host.querySelectorAll('details.ledger-type-section').forEach(section => { if (keepOpenTypes.has(section.dataset.key)) section.open = true; });
      host.querySelectorAll('details.ledger-settled').forEach(fold => { if (keepSettled.has(fold.dataset.key)) fold.open = true; });
      host.querySelectorAll('details.ledger-carry').forEach(line => { if (keepPosted.has(line.dataset.key)) line.open = true; });
      host.querySelectorAll('.ledger-cat[open], .ledger-cat.is-editing').forEach(cat => { const section = cat.closest('details.ledger-type-section'); if (section) section.open = true; });
      // A settlement inside Settlements (or a pot inside Savings) keeps the block around it open too, so reopening
      // one row never hides the rest of it.
      host.querySelectorAll('details.ledger-type-section[open], details.ledger-settled[open], .ledger-type-section form').forEach(item => {
        for (let parent = item.parentElement?.closest('details'); parent; parent = parent.parentElement?.closest('details')) parent.open = true;
      });
      host.querySelectorAll('.month-block.is-year details.ledger-year-group, .month-block.is-year details.ledger-year-items, .month-block.is-year details.ledger-year-month').forEach(item => {
        if (yearFolds.has(item.dataset.key) && !item.querySelector('form')) item.open = yearFolds.get(item.dataset.key);
      });
      revealKey = null;
      markPicks();
      focusDrafts(host);
      fitSummaryColumns();
      applySyncMarks();
      if (!loadMissing) return;
      loadOpenMonths(year);
      if (!specialMode && expandedMonths.has(`yr:${year}`)) loadYearForCard(year);
    }
    // The month list's figure columns are as wide as the widest figure showing (plus a small gap), so every month's
    // figures line up without spreading out; a longer figure (say −13.135K) widens them all. Fonts arriving late
    // re-measure once.
    function fitSummaryColumns() {
      let widest = 0;
      document.querySelectorAll('#month-ledger .ms-cur .ms-kv').forEach(kv => {
        const range = document.createRange();
        range.selectNodeContents(kv);
        widest = Math.max(widest, range.getBoundingClientRect().width);
      });
      if (widest) document.documentElement.style.setProperty('--ms-slot', `${Math.ceil(widest) + 8}px`);
    }
    document.fonts?.ready.then(fitSummaryColumns);
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
      const rename = host.querySelector('[data-ledger-form="rename-category"], [data-ledger-form="rename-year-section"], [data-ledger-form="rename-year-item"]')?.elements.name;
      focusQuietly(rename);
      rename?.select();
      attachLedgerSuggestions(host);
    }
    // The year card's section and description fields suggest names already in use: sections of the same type, or past
    // entry and note descriptions (those filed under the same subsection first). The current name is left out. Picking
    // one only fills it in; Enter then renames, merging into that name after asking.
    function attachYearRenameSuggestions(field, { level, type, category, original }) {
      const items = () => {
        if (level === 'section') return sectionChoices([original]).filter(item => item.type === type);
        const owner = { type, category };
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
      const sectionForm = host.querySelector('[data-ledger-form="rename-year-section"]');
      if (sectionForm) attachYearRenameSuggestions(sectionForm.elements.name, { level: 'section', type: sectionForm.dataset.type, original: sectionForm.dataset.section });
      const itemForm = host.querySelector('[data-ledger-form="rename-year-item"]');
      if (itemForm) attachYearRenameSuggestions(itemForm.elements.name, { level: 'item', type: itemForm.dataset.type, category: itemForm.dataset.category, original: itemForm.dataset.name });
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
    // The year card needs every month's entries; they load once per year, then the ledger repaints.
    const yearLoads = new Set();
    function loadYearForCard(year) {
      if (!store.year(year) || store.isYearLoaded(year) || yearLoads.has(year)) return;
      yearLoads.add(year);
      store.ensureYear(year).then(() => renderLedger(), error => {
        console.error('Could not load the year from Firebase.', error);
        showToast(`Could not load every month of ${year}.`);
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
      // A name becomes a Firebase key (a section keeps its roles per subsection name), and six characters cannot
      // go in one. safeKey swaps each for the character that looks like it and is allowed, so the name reads as
      // typed and the month can still be saved. See safeKey in data-layer.js.
      const name = ExpenseStore.safeKey(input.value.trim().replace(/\s+/g, ' '));
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
      if (section.closed) {
        hint.textContent = `“${section.name}” is closed. Reopen it to add to it.`;
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      // A settlement's subsections are kept to that settlement: "My share" means something different in each one, so
      // the same name in two of them is two different rows, not one shared between them.
      const grouped = section.type === 'net';
      const pool = grouped ? [section] : sections.filter(item => item.type === section.type);
      const existing = pool.flatMap(item => item.subsections).find(item => item.toLowerCase() === name.toLowerCase());
      const category = existing || name;
      const holder = existing ? pool.find(item => item.subsections.includes(existing)) : section;
      if (!existing) section.subsections.push(name);
      // What the new subsection stands for inside a settlement or a pot: money that moved, or a note about the split.
      if (!existing && grouped) {
        const kind = ExpenseStore.sectionKind(section);
        const picked = form.elements.role?.value;
        section.roles ||= {};
        section.roles[name] = ExpenseStore.SECTION_ROLES.roles[kind].includes(picked) ? picked : ExpenseStore.SECTION_ROLES.fallback[kind];
      }
      // A new subsection in a custom section gets its id (E1, E2…) for the section's equations now, so it keeps it.
      if (!existing && section.type === 'net') ExpenseStore.ensureCalc(section);
      scope.save();
      // Go straight to the first entry for the subsection.
      ledgerDraft = null;
      entryDraft = { month, property, section: holder.name, type: section.type, category };
      revealKey = catKey(month, property, section.type, category);
      renderLedger();
      showToast(existing ? `Add an entry to "${category}".` : `Added "${name}" to ${section.name}${scope.isEvent ? '' : ' for this month'}.`);
      // A custom section whose equations name subsections by id does not count a new one until it is put in, so ask.
      if (!existing && section.type === 'net' && usesSubsectionIds(section)) openSectionSetup(month, property, section.name, name);
    }
    // Adds a section inside Settlements or Savings for this month and currency, then asks for its first subsection.
    // Its entries may be negative, and it comes counting realistically from the start: for a settlement everything that
    // came in is income and everything that went out is an expense, so +X and -X never cancel each other out; for a
    // pot, only what it earned is income, because moving your own money into savings is neither.
    function saveDraftSection(form) {
      const input = form.elements.name;
      const name = ExpenseStore.safeKey(input.value.trim().replace(/\s+/g, ' '));
      const hint = form.querySelector('.ledger-form-hint');
      const { month, property } = ledgerDraft;
      const kind = ['settlement', 'savings'].includes(form.elements.kind?.value) ? form.elements.kind.value : 'settlement';
      const one = kind === 'savings' ? 'savings pot' : 'settlement';
      const scope = panelScope(month, property);
      const reserved = ['income', 'expenses', 'other income', 'other expenses', 'other balance', 'settlements', 'savings'];
      const problem = !name ? 'Type a name first.'
        : reserved.includes(name.toLowerCase()) || scope.sections().some(item => item.name.toLowerCase() === name.toLowerCase()) ? `There is already a section called "${name}" here.` : '';
      if (problem) {
        hint.textContent = problem;
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      scope.own().push({ name, type: 'net', kind, subsections: [], roles: {}, block: true, calc: ExpenseStore.defaultCalc(kind) });
      scope.save();
      ledgerDraft = { month, property, section: name, role: kind === 'savings' ? 'save' : 'cost' };
      renderLedger();
      showToast(`Added the ${one} "${name}". Name its first subsection.`);
    }
    // A settlement is finished when nothing is outstanding; closing it keeps every figure it ever had and stops it
    // taking new entries. Closing one that is still open asks first, because that is almost always a slip.
    function setSectionClosed(mKey, property, name, closed) {
      if (isViewer) return viewOnly();
      const scope = panelScope(mKey, property);
      const section = scope.own().find(item => item.type === 'net' && item.name === name);
      if (!section) return showToast('That section is no longer set up here.');
      if (closed) {
        const owed = sectionSettle(mKey, property, section)?.owed || 0;
        if (owed && !window.confirm(`“${name}” still has ${formatMoney(Math.abs(owed), property)} ${owed > 0 ? 'owed to you' : 'for you to pay'}.\n\nClose it anyway?`)) return;
        section.closed = true;
        section.closedOn = todayKey().slice(0, 10);
      } else {
        delete section.closed;
        delete section.closedOn;
      }
      scope.save();
      renderLedger();
      showToast(closed ? `Closed “${name}”.` : `“${name}” is open again.`);
    }
    // One section's own figures right now (what is outstanding, what moved either way), worked out from its entries.
    function sectionSettle(mKey, property, section) {
      const scope = panelScope(mKey, property);
      const amounts = Object.fromEntries((section.subsections || []).map(sub => [sub, []]));
      transactions.filter(item => !item.parentId && scope.match(item) && item.type === 'net'
        && (item.section === section.name || (!item.section && (section.subsections || []).includes(item.category))))
        .forEach(item => (amounts[item.category] ||= []).push(store.entryTotal(item.id)));
      return ExpenseStore.runCalc(section, amounts).settle;
    }
    // Closed sections of one kind, brought together into one. Their subsections move across (a name already taken is
    // kept apart by its section's name), every entry is re-pointed at the section it lands in, and enough of each
    // original section is retained to put it back. Only closed ones merge: a settlement still in progress has
    // somewhere else to go.
    function mergeSections(mKey, property, kind, names, targetName) {
      const scope = panelScope(mKey, property);
      const own = scope.own();
      const sources = names.map(name => own.find(item => item.type === 'net' && item.name === name)).filter(Boolean);
      if (sources.length < 2) return showToast('Pick at least two closed sections to merge.');
      const target = sources.find(item => item.name === targetName) || sources[0];
      const rest = sources.filter(item => item !== target);
      const copy = value => JSON.parse(JSON.stringify(value));
      const targetParts = target.mergedSections?.length
        ? copy(target.mergedSections)
        : [{ section: copy(target), subsections: (target.subsections || []).map(name => ({ from: name, to: name })) }];
      const addedParts = [];
      target.roles ||= {};
      target.mergedFrom = [...new Set([...(target.mergedFrom || []), ...rest.flatMap(item => [...(item.mergedFrom || []), item.name])])];
      rest.forEach(source => {
        const sourceParts = source.mergedSections?.length
          ? copy(source.mergedSections)
          : [{ section: copy(source), subsections: (source.subsections || []).map(name => ({ from: name, to: name })) }];
        const landedBySub = new Map();
        (source.subsections || []).forEach(sub => {
          const taken = target.subsections.some(item => ExpenseStore.nameKey(item) === ExpenseStore.nameKey(sub));
          const landed = taken ? `${sub} (${source.name})` : sub;
          target.subsections.push(landed);
          landedBySub.set(sub, landed);
          target.roles[landed] = ExpenseStore.subsectionRole(source, sub);
          const note = source.subAbout?.[sub];
          if (note) (target.subAbout ||= {})[landed] = note;
          transactions.filter(item => scope.match(item) && item.type === 'net' && item.category === sub
            && (item.section === source.name || (!item.section && (source.subsections || []).includes(item.category))))
            .forEach(item => Object.assign(item, { section: target.name, category: landed }));
        });
        sourceParts.forEach(part => addedParts.push({
          section: part.section,
          subsections: part.subsections.map(mapping => ({
            from: mapping.from,
            to: landedBySub.get(mapping.to) || mapping.to
          }))
        }));
        own.splice(own.indexOf(source), 1);
      });
      target.mergedSections = [...targetParts, ...addedParts];
      // Ids follow the subsections that moved in, so any equation already written on the target still means the same.
      ExpenseStore.ensureCalc(target);
      target.closed = true;
      target.closedOn = todayKey().slice(0, 10);
      saveTransactions();
      scope.save();
      renderLedger();
      showToast(`Merged ${sources.length} into “${target.name}”.`);
    }
    function unpackSection(mKey, property, name) {
      if (isViewer) return viewOnly();
      const scope = panelScope(mKey, property);
      const own = scope.own();
      const merged = own.find(item => item.type === 'net' && item.name === name);
      const parts = merged?.mergedSections;
      if (!merged || !Array.isArray(parts) || parts.length < 2) return showToast('This section does not have enough saved merge details to unpack.');
      if (parts.some(part => !part?.section?.name || !Array.isArray(part.subsections))) {
        return showToast('Cannot unpack: the saved merge details are incomplete.');
      }
      const originals = parts.map(part => part.section?.name).filter(Boolean);
      const conflicts = originals.filter(original => original !== merged.name
        && own.some(item => item !== merged && item.type === 'net' && item.name === original));
      if (conflicts.length) return showToast(`Cannot unpack: ${conflicts.map(original => `“${original}”`).join(', ')} already ${conflicts.length === 1 ? 'exists' : 'exist'} here.`);

      const currentParts = parts.map(part => ({
        ...copySection(part.section),
        subsections: [...(part.section.subsections || [])],
        roles: { ...(part.section.roles || {}) },
        subAbout: { ...(part.section.subAbout || {}) }
      }));
      const restoredName = new Map(parts.map((part, index) => [part.section.name, currentParts[index]]));
      const mappings = parts.flatMap(part => part.subsections.map(mapping => ({
        from: mapping.from, to: mapping.to, section: part.section.name
      })));
      const assigned = new Set(mappings.map(mapping => mapping.to));
      // Subsections added after the merge have no original home; keep them with the section that was retained.
      const retained = restoredName.get(merged.name) || currentParts[0];
      (merged.subsections || []).filter(sub => !assigned.has(sub)).forEach(sub => {
        if (!retained.subsections.includes(sub)) retained.subsections.push(sub);
        if (merged.roles?.[sub]) retained.roles[sub] = merged.roles[sub];
        if (merged.subAbout?.[sub]) retained.subAbout[sub] = merged.subAbout[sub];
      });
      mappings.forEach(mapping => {
        transactions.filter(item => scope.match(item) && item.type === 'net'
          && item.section === merged.name && item.category === mapping.to)
          .forEach(item => Object.assign(item, { section: mapping.section, category: mapping.from }));
      });
      const index = own.indexOf(merged);
      own.splice(index, 1, ...currentParts);
      saveTransactions();
      scope.save();
      renderLedger();
      showToast(`Unpacked “${name}” into ${currentParts.length} sections.`);
    }
    function copySection(section) {
      const copy = JSON.parse(JSON.stringify(section));
      delete copy.mergedSections;
      delete copy.mergedFrom;
      return copy;
    }
    const legacyUnpackState = { month: null, property: null, name: null };
    function legacyUnpackParts() {
      const merged = panelScope(legacyUnpackState.month, legacyUnpackState.property).own()
        .find(item => item.type === 'net' && item.name === legacyUnpackState.name);
      if (!merged) return { merged: null, names: [], subsections: [] };
      const names = [...new Set([merged.name, ...(Array.isArray(merged.mergedFrom) ? merged.mergedFrom : [])].filter(Boolean))];
      return { merged, names, subsections: merged.subsections || [] };
    }
    function renderLegacyUnpackDialog() {
      const { merged, names, subsections } = legacyUnpackParts();
      const list = document.querySelector('#legacy-unpack-list');
      if (!merged || names.length < 2) {
        list.innerHTML = '<p class="config-muted">This section no longer has enough merge history to unpack.</p>';
        return;
      }
      const options = names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
      list.innerHTML = subsections.map((sub, index) =>
        `<label class="legacy-unpack-row"><span>${escapeHtml(sub)}</span><select data-legacy-unpack="${index}" aria-label="Restore ${escapeHtml(sub)} under">${options}</select></label>`
      ).join('') || '<p class="config-muted">This merged section has no subsections.</p>';
      list.querySelectorAll('[data-legacy-unpack]').forEach(select => { select.value = names.slice(1).find(name => subsections[Number(select.dataset.legacyUnpack)].endsWith(` (${name})`)) || merged.name; });
    }
    function openLegacyUnpackDialog(mKey, property, name) {
      if (isViewer) return viewOnly();
      const section = panelScope(mKey, property).sections().find(item => item.type === 'net' && item.name === name);
      if (!section || !Array.isArray(section.mergedFrom) || !section.mergedFrom.length) return showToast('This section does not have enough saved merge history to unpack.');
      Object.assign(legacyUnpackState, { month: mKey, property, name });
      document.querySelector('#legacy-unpack-where').textContent = `${regions[property].code} · ${panelScope(mKey, property).label}`;
      renderLegacyUnpackDialog();
      document.querySelector('#legacy-unpack-dialog').showModal();
    }
    function unpackLegacySection() {
      const { merged, names, subsections } = legacyUnpackParts();
      if (!merged || names.length < 2) return showToast('This section no longer has enough merge history to unpack.');
      const own = panelScope(legacyUnpackState.month, legacyUnpackState.property).own();
      const conflicts = names.filter(name => name !== merged.name
        && own.some(item => item !== merged && item.type === 'net' && item.name === name));
      if (conflicts.length) return showToast(`Cannot unpack: ${conflicts.map(name => `“${name}”`).join(', ')} already ${conflicts.length === 1 ? 'exists' : 'exist'} here.`);
      const destinations = [...document.querySelectorAll('#legacy-unpack-list [data-legacy-unpack]')].map(select => select.value);
      if (destinations.length !== subsections.length || destinations.some(name => !names.includes(name))) {
        return showToast('Choose a destination for every subsection first.');
      }
      const kind = ExpenseStore.sectionKind(merged);
      const currentParts = names.map(name => {
        const part = name === merged.name
          ? copySection(merged)
          : { name, type: 'net', kind, block: true, subsections: [], roles: {}, subAbout: {}, calc: ExpenseStore.defaultCalc(kind), closed: true,
            ...(merged.closedOn ? { closedOn: merged.closedOn } : {}) };
        part.subsections = [];
        part.roles = {};
        part.subAbout = {};
        delete part.mergedFrom;
        delete part.mergedSections;
        return part;
      });
      const byName = new Map(currentParts.map(part => [part.name, part]));
      const mappings = subsections.map((sub, index) => {
        const owner = byName.get(destinations[index]);
        const source = names.slice(1).find(name => sub.endsWith(` (${name})`));
        const originalName = source === owner.name ? sub.slice(0, -(source.length + 3)) : sub;
        owner.subsections.push(originalName);
        if (merged.roles?.[sub]) owner.roles[originalName] = merged.roles[sub];
        if (merged.subAbout?.[sub]) owner.subAbout[originalName] = merged.subAbout[sub];
        return { sub, originalName, owner: owner.name };
      });
      const scope = panelScope(legacyUnpackState.month, legacyUnpackState.property);
      mappings.forEach(({ sub, originalName, owner }) => {
        transactions.filter(item => scope.match(item) && item.type === 'net' && item.section === merged.name && item.category === sub)
          .forEach(item => Object.assign(item, { section: owner, category: originalName }));
      });
      currentParts.forEach(part => ExpenseStore.ensureCalc(part));
      own.splice(own.indexOf(merged), 1, ...currentParts);
      saveTransactions();
      scope.save();
      document.querySelector('#legacy-unpack-dialog').close();
      renderLedger();
      showToast(`Unpacked “${merged.name}” into ${currentParts.length} sections. Review their calculation settings.`);
    }
    function setupLegacyUnpackDialog() {
      const form = document.querySelector('#legacy-unpack-form');
      if (!form) return;
      form.addEventListener('submit', event => {
        event.preventDefault();
        unpackLegacySection();
      });
    }
    function saveEntryDraft(form) {
      const fields = form.elements;
      const { month, property, section, type, category } = form.dataset;
      const holder = section ? panelScope(month, property).sections().find(item => item.name === section) : null;
      if (holder?.closed) {
        entryDraft = null;
        renderLedger();
        return showToast(`“${section}” is closed. Reopen it to add to it.`);
      }
      const date = dateFromForm(fields, month);
      const parsed = ExpenseStore.readAmount(fields.amount.value);
      const amount = parsed.value;
      const checks = [
        [fields.date || fields.day, Boolean(date)],
        [fields.description, fields.description.value.trim() !== ''],
        [fields.amount, !parsed.error && !parsed.empty && (amount >= 0 || type === 'net')] // 0 is allowed: a gift with no money, say
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
        [fields.amount, !parsed.error && !parsed.empty && (amount >= 0 || item.type === 'net')]
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
    // `section`, when given, keeps a subsection's removal inside that one section: two settlements may each have a
    // row called "My share", and clearing one must not take the other with it.
    function deleteRow({ deleteRow: kind, entryId, month, property, type, section, category }) {
      const within = type === 'net' && section ? section : null;
      const inRow = {
        note: item => item.id === entryId,
        entry: item => item.id === entryId,
        category: item => !item.parentId && panelScope(month, property).match(item) && item.type === type && item.category === category && (!within || item.section === within)
      }[kind];
      const rows = transactions.filter(inRow);
      const rowScope = month ? panelScope(month, property) : null;
      const emptyListed = kind === 'category' && !rows.length && rowScope.sections().some(item => item.type === type && (!within || item.name === within) && item.subsections.includes(category));
      if (emptyListed) {
        if (!window.confirm(`Remove the empty subsection "${category}" from ${rowScope.label}?`)) return;
        rowScope.own().filter(item => item.type === type && (!within || item.name === within)).forEach(item => {
          item.subsections = item.subsections.filter(name => name !== category);
          delete item.roles?.[category];
          delete item.subAbout?.[category];
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
        rowScope.own().filter(item => item.type === type && (!within || item.name === within)).forEach(item => {
          item.subsections = item.subsections.filter(name => name !== category);
          delete item.roles?.[category];
          delete item.subAbout?.[category];
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
    // ---- The year card's renames: they change every month of the year, for the currency they are made in, exactly as
    // renaming in each month would. A name already used in a month by other entries is refused (rename there first). ----
    function saveYearCategoryRename(form) {
      const { month: key, property, type, category, section } = form.dataset;
      const year = Number(key.slice(3));
      const input = form.elements.name;
      const hint = form.querySelector('.ledger-form-hint');
      const name = ExpenseStore.safeKey(input.value.trim().replace(/\s+/g, ' '));
      if (name === category) {
        editDraft = null;
        return renderLedger();
      }
      const fail = text => {
        hint.textContent = text;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      };
      if (!name) return fail('Type a name first.');
      if (!store.isYearLoaded(year)) return fail(`Still loading ${year}; try again in a moment.`);
      const same = (a, b) => ExpenseStore.nameKey(a) === ExpenseStore.nameKey(b);
      // Each month's own spelling of the subsection, where it has it (on entries or in its list).
      const months = [];
      for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
        const scope = panelScope(keyOf(year, monthIndex), property);
        const rows = transactions.filter(item => scope.match(item) && item.type === type);
        const spelling = [...rows.map(item => item.category), ...scope.sections().filter(item => item.type === type).flatMap(item => item.subsections)].find(other => same(other, category));
        if (!spelling) continue;
        // Only where the month files it under the same section as the row renamed (as the year card groups it).
        const home = Object.values(store.monthSlice(year, monthIndex, property).sections).find(item => !item._meta.event && item._meta.type === type && spelling in item.categories);
        if (section && home && !same(home._meta.id, section)) continue;
        const clash = spelling !== name && rows.some(item => item.category !== spelling && item.category.toLowerCase() === name.toLowerCase());
        months.push({ monthIndex, scope, spelling, clash });
      }
      const clashes = months.filter(item => item.clash).map(item => ExpenseStore.MONTH_NAMES[item.monthIndex]);
      if (clashes.length) return fail(`"${name}" already has entries in ${clashes.join(', ')}. Rename it there first.`);
      if (!months.length) return fail(`Nothing in ${year} is filed under "${category}".`);
      let finalName = name;
      months.forEach(item => { finalName = renameCategoryIn(item.scope, type, item.spelling, name); });
      // One save: every changed month's entries and the year (its months' section lists and totals).
      trackSave(store.saveTransactions(year));
      editDraft = null;
      revealKey = catKey(key, property, type, finalName);
      renderLedger();
      showToast(`Renamed "${category}" to "${finalName}" in ${months.length} ${months.length === 1 ? 'month' : 'months'} of ${year}.`);
    }
    // A double-click on a section's heading in the year card: a custom section's, a section's own heading inside Income or
    // Expenses (`group`), or Income or Expenses itself, which renames the one section it holds.
    function startYearSectionRename(key, property, block, group = null) {
      if (!block) return;
      if (hasDraft()) return showToast('Save or cancel the current inline edit first.');
      const type = ['income', 'net'].includes(block.dataset.type) ? block.dataset.type : 'expense';
      const named = block.dataset.section || '';
      let section = group || named;
      if (!section) {
        const shown = [...new Set([...block.querySelectorAll('.ledger-cat:not([data-event-id])')].map(cat => cat.dataset.section))];
        if (shown.length !== 1) return showToast(shown.length ? 'Double-click a section’s own name below to rename it.' : 'No section to rename here.');
        section = shown[0];
      }
      editDraft = { kind: 'year-section', month: key, property, type, block: named, group, section };
      renderLedger();
    }
    // A description renamed in the year card: every entry and note of the year (in that currency, section and
    // subsection) that carries it.
    function saveYearItemRename(form) {
      const { month: key, property, type, section, category, item, name: original } = form.dataset;
      const year = Number(key.slice(3));
      const input = form.elements.name;
      const hint = form.querySelector('.ledger-form-hint');
      const name = input.value.trim().replace(/\s+/g, ' ');
      const fail = text => {
        hint.textContent = text;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      };
      if (name === original) {
        editDraft = null;
        return renderLedger();
      }
      if (!name) return fail('Type a name first.');
      if (!store.isYearLoaded(year)) return fail(`Still loading ${year}; try again in a moment.`);
      const plan = store.planRename(year, property, { level: 'item', type, section: ExpenseStore.nameKey(section), sub: ExpenseStore.nameKey(category), item }, name);
      if (!plan.months) return fail(`Nothing in ${year} is called "${original}" here.`);
      plan.apply();
      trackSave(store.saveTransactions(year));
      editDraft = null;
      renderLedger();
      const count = Number(form.dataset.count) || 0;
      showToast(`Renamed "${original}" to "${name}" (${count} ${count === 1 ? 'time' : 'times'}) in ${plan.months} ${plan.months === 1 ? 'month' : 'months'} of ${year}.`);
    }
    function saveYearSectionRename(form) {
      const { month: key, property, type, section } = form.dataset;
      const year = Number(key.slice(3));
      const input = form.elements.name;
      const hint = form.querySelector('.ledger-form-hint');
      const name = ExpenseStore.safeKey(input.value.trim().replace(/\s+/g, ' '));
      const fail = text => {
        hint.textContent = text;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      };
      if (name === section) {
        editDraft = null;
        return renderLedger();
      }
      if (!name) return fail('Type a name first.');
      if (!store.isYearLoaded(year)) return fail(`Still loading ${year}; try again in a moment.`);
      const plan = store.planRename(year, property, { level: 'section', type, section: ExpenseStore.nameKey(section) }, name);
      if (!plan.months) return fail(`Nothing in ${year} is filed under "${section}".`);
      if (plan.merged && !window.confirm(`"${name}" already exists in ${year}. Merge "${section}" into it?`)) return input.focus();
      plan.apply();
      trackSave(store.saveTransactions(year));
      editDraft = null;
      renderLedger();
      showToast(`Renamed the section "${section}" to "${name}" in ${plan.months} ${plan.months === 1 ? 'month' : 'months'} of ${year}.`);
    }
    // Renames a subsection in one month (or event) and currency: its entries and the panel's own list. Renaming onto an
    // empty subsection already listed merges into it, keeping its spelling and section. Saving is left to the caller.
    // `within`, when given, keeps the rename inside one section: a settlement's or a pot's subsections belong to it
    // alone ("My share" means a different thing in each), so one is never folded into another section's row.
    function renameCategoryIn(scope, type, category, name, within = null) {
      const inPanel = item => scope.match(item) && item.type === type && (!within || item.section === within);
      const sameName = other => other !== category && other.toLowerCase() === name.toLowerCase();
      // Copy the month's list before moving entries, so the copy still holds the old name.
      const sections = scope.own().filter(section => section.type === type && (!within || section.name === within));
      const target = sections.find(section => section.subsections.some(sameName));
      const finalName = target ? target.subsections.find(sameName) : name;
      const moved = transactions.filter(item => inPanel(item) && item.category === category);
      moved.forEach(item => {
        item.category = finalName;
        if (target) item.section = target.name;
      });
      // Every repayment that said it covered this subsection goes on saying so under its new name. Allocations name
      // subsections of their own settlement, so only rows in the same section are rewritten — the same reach the
      // rename itself has.
      transactions.forEach(item => {
        if (!inPanel(item) || !Array.isArray(item.alloc)) return;
        if (!item.alloc.some(part => part.to === category)) return;
        item.alloc = ExpenseStore.normalizeAlloc(item.alloc.map(part => (part.to === category ? { ...part, to: finalName } : part)));
      });
      sections.forEach(section => {
        const index = section.subsections.indexOf(category);
        if (index < 0) return;
        // A custom section's subsection keeps its id (E1, E2…) and what it counts as under its new name, so its
        // equations and its figures stay right.
        if (section.type === 'net' && !target) {
          const item = ExpenseStore.ensureCalc(section).vars.find(entry => entry.name === category);
          if (item) item.name = finalName;
          if (section.roles && category in section.roles) {
            section.roles[finalName] = section.roles[category];
            delete section.roles[category];
          }
          if (section.subAbout && category in section.subAbout) {
            section.subAbout[finalName] = section.subAbout[category];
            delete section.subAbout[category];
          }
        } else if (section.type === 'net' && target) {
          delete section.roles?.[category];
          delete section.subAbout?.[category];
        }
        if (target) section.subsections.splice(index, 1);
        else section.subsections[index] = name;
      });
      if (!sections.some(section => section.subsections.includes(finalName))) {
        sections.find(section => section.name === moved[0]?.section)?.subsections.push(finalName);
      }
      return finalName;
    }
    // Renaming a settlement or a pot in place. It changes this month and currency only — the same reach as renaming a
    // subsection here — and its entries are re-pointed at the new name so nothing is orphaned.
    function saveSectionRename(form) {
      const { month, property, section: was } = form.dataset;
      const input = form.elements.name;
      const hint = form.querySelector('.ledger-form-hint');
      const name = ExpenseStore.safeKey(input.value.trim().replace(/\s+/g, ' '));
      const scope = panelScope(month, property);
      if (name === was) {
        editDraft = null;
        return renderLedger();
      }
      const reserved = ['income', 'expenses', 'other income', 'other expenses', 'other balance'];
      const blocks = Object.values(store.blockNames(...yearMonthOf(month), property)).map(item => item.toLowerCase());
      const problem = !name ? 'Type a name first.'
        : reserved.includes(name.toLowerCase()) || blocks.includes(name.toLowerCase()) ? `"${name}" is the name of a block here.`
          : scope.sections().some(item => item.name !== was && item.name.toLowerCase() === name.toLowerCase()) ? `There is already a section called "${name}" here.` : '';
      if (problem) {
        hint.textContent = problem;
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      const own = scope.own().find(item => item.type === 'net' && item.name === was);
      if (!own) {
        editDraft = null;
        renderLedger();
        return showToast('That section is no longer set up here.');
      }
      own.name = name;
      transactions.forEach(item => { if (scope.match(item) && item.type === 'net' && item.section === was) item.section = name; });
      scope.save();
      saveTransactions();
      editDraft = null;
      renderLedger();
      showToast(`Renamed "${was}" to "${name}" for this month.`);
    }
    // Renaming a block heading (Settlements / Savings). Only its name changes: nothing moves, and a month still has
    // exactly one of each. Emptying the field puts the default name back.
    function saveBlockRename(form) {
      const { month, property, block } = form.dataset;
      const input = form.elements.name;
      const hint = form.querySelector('.ledger-form-hint');
      const name = input.value.trim().replace(/\s+/g, ' ');
      const [year, monthIndex] = yearMonthOf(month);
      const other = ExpenseStore.SECTION_ROLES.kinds.find(kind => kind !== block);
      const names = store.blockNames(year, monthIndex, property);
      const scope = panelScope(month, property);
      const clash = name && (
        ['income', 'expenses'].includes(name.toLowerCase()) ? 'Income and Expenses are taken.'
          : name.toLowerCase() === names[other].toLowerCase() ? `The other block is already called "${name}".`
            : scope.sections().some(item => item.name.toLowerCase() === name.toLowerCase()) ? `A section here is already called "${name}".` : '');
      if (clash) {
        hint.textContent = clash;
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      trackSave(store.saveBlockName(year, monthIndex, property, block, name));
      editDraft = null;
      renderLedger();
      showToast(name ? `This block is now called "${name}".` : `Back to "${ExpenseStore.BLOCK_NAMES[block]}".`);
    }
    // Renaming a subsection changes only the month and currency it is shown in: its entries and that month's own list.
    function saveCategoryRename(form) {
      const { month, property, type, category, section: inSection } = form.dataset;
      const input = form.elements.name;
      const hint = form.querySelector('.ledger-form-hint');
      const name = ExpenseStore.safeKey(input.value.trim().replace(/\s+/g, ' '));
      const scope = panelScope(month, property);
      if (name === category) {
        editDraft = null;
        return renderLedger();
      }
      const within = type === 'net' && inSection ? inSection : null;
      const inPanel = item => scope.match(item) && item.type === type && (!within || item.section === within);
      const sameName = other => other !== category && other.toLowerCase() === name.toLowerCase();
      const taken = transactions.some(item => inPanel(item) && sameName(item.category));
      const problem = !name ? 'Type a name first.' : taken ? `"${name}" is already used here.` : '';
      if (problem) {
        hint.textContent = problem;
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      const finalName = renameCategoryIn(scope, type, category, name, within);
      scope.save();
      saveTransactions();
      editDraft = null;
      revealKey = catKey(month, property, type, finalName);
      renderLedger();
      showToast(`Renamed "${category}" to "${finalName}"${scope.isEvent ? '' : ' for this month'}.`);
    }
    // A subsection's stored name, taken from the row rather than from the text it draws. The two are not always the same
    // — a settlement's name is drawn without the arrows typed into it — and every lookup here (paste, rename, cut, the
    // search jump) matches against what is stored, so reading the drawn text would silently miss the row it meant.
    const catName = cat => cat?.dataset.category ?? cat?.querySelector('.ledger-cat-name')?.textContent.trim() ?? '';
    // Controls that live inside a row but act on their own: a click on one is not a click on the row around it.
    const ROW_BUTTONS = '[data-sort-cat], [data-panel-expand], [data-section-close], [data-group-merge], [data-about], [data-posted-section], [data-posted-block]';
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
      // Whether the last press was a mouse or a finger: a double-tap opens the row menu, a double-click edits.
      let lastPointerType = 'mouse';
      ledger.addEventListener('pointerdown', event => { lastPointerType = event.pointerType || 'mouse'; }, true);
      const rowKeyFor = target => {
        const el = getElement(target);
        if (!el || el.closest('form') || el.closest(ROW_BUTTONS)) return null;
        // The year card's section headings and descriptions rename for the whole year.
        const yearSection = el.closest('.ledger-year-group > summary[data-year-section]');
        if (yearSection) return `ysec:${yearSection.parentElement.dataset.key}`;
        const yearItem = el.closest('[data-year-item]');
        if (yearItem) return `yitem:${yearItem.closest('.ledger-year-items')?.dataset.key}|${yearItem.dataset.yearItem}`;
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
        const yearJump = event.target.closest('[data-year-jump]');
        if (yearJump) {
          event.preventDefault();
          const { yearJump: mKey, property, category } = yearJump.dataset;
          return openSearchResult({ year: Number(mKey.slice(0, 4)), mKey, property, category });
        }
        // A posted line in Income or Expenses stands for a section below it. Clicking it opens that section and brings
        // it into view, so the trail from the figure to the entries behind it is one step and never a hunt by name.
        const posted = event.target.closest('[data-posted-section], [data-posted-block]');
        if (posted) {
          event.preventDefault();
          const panel = posted.closest('.ledger-panel');
          const name = posted.dataset.postedSection;
          const target = name
            ? panel?.querySelector(`.ledger-type-section[data-section="${CSS.escape(name)}"]`)
            : panel?.querySelector(`.ledger-type-section.is-group[data-group="${CSS.escape(posted.dataset.postedBlock || '')}"]`);
          if (!target) return showToast('That section is not showing in this panel.');
          for (let node = target; node; node = node.parentElement?.closest('details')) {
            if (node.tagName === 'DETAILS') node.open = true;
          }
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('is-revealed');
          setTimeout(() => target.classList.remove('is-revealed'), 1400);
          return;
        }
        const groupMerge = event.target.closest('[data-group-merge]');
        if (groupMerge) {
          event.preventDefault();
          const { groupMerge: kind, month, property } = groupMerge.dataset;
          return openMergeDialog(month, property, kind);
        }
        const closeButton = event.target.closest('[data-section-close]');
        if (closeButton) {
          event.preventDefault();
          const { sectionClose: name, month, property, to } = closeButton.dataset;
          return setSectionClosed(month, property, name, to === 'closed');
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
            // A double-tap on a phone opens the row menu; the first tap's opening or closing is undone first.
            const target = lastPointerType !== 'mouse' ? menuTargetFor(event.target) : null;
            if (target) {
              if (target.kind === 'entry') {
                const toggle = target.row.querySelector('[data-toggle-entry]');
                if (toggle) setEntryOpen(toggle, !expandedEntries.has(target.id));
              } else if (['group', 'section', 'subsection'].includes(target.kind)) target.row.parentElement.open = !target.row.parentElement.open;
              return openRowMenu(target, null, true, { triggerLongPress });
            }
            return triggerEdit(event.target, rowKey);
          }
        }
        // A currency panel's header has no edit of its own: on a phone, its double-tap opens the row menu too.
        const panelHead = lastPointerType !== 'mouse' && !event.target.closest('button, input') ? event.target.closest('.ledger-panel-head') : null;
        if (panelHead) {
          const key = `head:${panelHead.closest('.month-block')?.dataset.monthKey}|${panelHead.closest('.ledger-panel')?.dataset.property}`;
          const isDouble = lastClick.key === key && Date.now() - lastClick.time < DOUBLE_CLICK_MS;
          lastClick = isDouble ? { key: null, time: 0 } : { key, time: Date.now() };
          const target = isDouble ? menuTargetFor(event.target) : null;
          if (target) return openRowMenu(target, null, true, { triggerLongPress });
        }
        // A year tab switches years; the year already shown opens its settings.
        // The ★ # button opens the special cards and hashtags page, and from there goes back to the year's months; a
        // year tab goes back to that year's months (and, when that year is already showing, opens its settings).
        if (event.target.closest('[data-ledger-special]')) {
          setSpecialMode(!specialMode);
          renderLedger();
          return window.scrollTo({ top: 0 });
        }
        const yearTab = event.target.closest('[data-ledger-year]');
        if (yearTab) {
          const year = Number(yearTab.dataset.ledgerYear);
          if (specialMode) {
            setSpecialMode(false);
            return selectLedgerYear(year);
          }
          return year === currentMonth.getFullYear() ? openYearSettings(year) : selectLedgerYear(year);
        }
        // A currency's summary beside a month name: on a closed month, opens it with only that currency; on an open one,
        // shows or hides that currency's panel (hiding the last one closes the month).
        const currencyPack = event.target.closest('[data-month-currency]');
        if (currencyPack) {
          const key = currencyPack.dataset.month;
          const currency = currencyPack.dataset.monthCurrency;
          const all = [...currencyPack.closest('.month-summary').querySelectorAll('[data-month-currency]')].map(button => button.dataset.monthCurrency);
          if (!expandedMonths.has(key)) {
            expandedMonths.add(key);
            monthCurrencies.set(key, [currency]);
          } else {
            const shown = monthCurrencies.get(key) || all;
            const next = shown.includes(currency) ? shown.filter(item => item !== currency) : all.filter(item => item === currency || shown.includes(item));
            if (!next.length) expandedMonths.delete(key);
            if (!next.length || next.length === all.length) monthCurrencies.delete(key);
            else monthCurrencies.set(key, next);
          }
          saveExpandedMonths();
          saveMonthCurrencies();
          if (!expandedMonths.has(key)) {
            if (ledgerDraft?.month === key) ledgerDraft = null;
            if (entryDraft?.month === key) entryDraft = null;
            editDraft = null;
          }
          renderLedger();
          return document.querySelector(`[data-month-currency="${CSS.escape(currency)}"][data-month="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
        }
        // A month name opens or closes the month (with every currency); a double-click undoes that and opens the month's
        // settings instead.
        const eye = event.target.closest('[data-toggle-month]');
        if (eye) {
          const key = eye.dataset.toggleMonth;
          const isDouble = lastMonthClick.key === key && Date.now() - lastMonthClick.time < DOUBLE_CLICK_MS;
          lastMonthClick = isDouble ? { key: null, time: 0 } : { key, time: Date.now() };
          if (expandedMonths.has(key)) expandedMonths.delete(key);
          else expandedMonths.add(key);
          monthCurrencies.delete(key);
          saveMonthCurrencies();
          if (isDouble) {
            saveExpandedMonths();
            renderLedger();
            // An event's settings live with its year's events.
            if (key.startsWith('ev:')) return openYearSettings(store.events[key.slice(3)]?.year || currentMonth.getFullYear());
            if (key.startsWith('yr:')) return openYearSettings(Number(key.slice(3)));
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
        // The small control in a currency panel's header expands everything in that panel (its Income and Expenses
        // blocks and all their subsections) or collapses it all back to the Income and Expenses headings.
        const expandButton = event.target.closest('[data-panel-expand]');
        if (expandButton) {
          const panel = expandButton.closest('.ledger-panel');
          const cats = [...panel.querySelectorAll('.ledger-cat')];
          const types = [...panel.querySelectorAll('details.ledger-type-section')];
          const open = cats.some(cat => !cat.open) || types.some(section => !section.open);
          cats.forEach(cat => { cat.open = open; });
          types.forEach(section => { section.open = open; });
          const code = panel.querySelector('.ledger-panel-head h3')?.textContent.trim() || '';
          expandButton.querySelector('i').className = `ti ti-chevrons-${open ? 'up' : 'down'}`;
          expandButton.title = open ? 'Collapse all' : 'Expand all';
          expandButton.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} all ${code} subsections`);
        }
      });
      ledger.addEventListener('submit', event => {
        const form = event.target.closest('[data-ledger-form]');
        if (!form) return;
        event.preventDefault();
        if (form.dataset.ledgerForm === 'entry') return saveEntryDraft(form);
        if (form.dataset.ledgerForm === 'edit-entry' || form.dataset.ledgerForm === 'edit-note') return saveEditDraft(form);
        if (form.dataset.ledgerForm === 'rename-category') return form.dataset.month.startsWith('yr:') ? saveYearCategoryRename(form) : saveCategoryRename(form);
        if (form.dataset.ledgerForm === 'rename-year-section') return saveYearSectionRename(form);
        if (form.dataset.ledgerForm === 'rename-section') return saveSectionRename(form);
        if (form.dataset.ledgerForm === 'rename-block') return saveBlockRename(form);
        if (form.dataset.ledgerForm === 'rename-year-item') return saveYearItemRename(form);
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
          if (parsed.error || (parsed.value < 0 && parentItem.type !== 'net')) {
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
        if (form.dataset.ledgerForm === 'section' && ledgerDraft) saveDraftSection(form);
      });
      ledger.addEventListener('keydown', event => {
        const form = event.target.closest('[data-ledger-form]');
        if (!form) return;

        if (event.key === 'Escape') {
          if (form.dataset.ledgerForm === 'entry') entryDraft = null;
          else if (form.dataset.ledgerForm === 'sub-entry') subEntryDraftParentId = null;
          else if (['edit-entry', 'edit-note', 'rename-category', 'rename-year-section', 'rename-year-item', 'rename-section', 'rename-block'].includes(form.dataset.ledgerForm)) editDraft = null;
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

      // The year card adds up the months: entries are added in their month (its "from <Month>" lines open it there).
      const blockYearAdd = monthBlock => {
        if (!monthBlock.dataset.monthKey.startsWith('yr:')) return false;
        showToast('Add entries in their month: click “from <month>” in a subsection to open it.');
        return true;
      };
      // An event's rows inside a month are read-only there; they are changed in the event itself.
      const blockEventRow = element => {
        const row = element.closest('.ledger-cat[data-event-id]');
        if (!row) return false;
        showToast(`This comes from the event “${store.eventName(row.dataset.eventId)}”. Edit it under Events.`);
        return true;
      };
      // Opens the inline add form for whatever was pressed: an entry → sub-entry, a category → entry,
      // an Income/Expenses header → subsection, a month's currency header → section. Month and currency come from the pressed panel, not the page state.
      const triggerLongPress = (element) => {
        if (isViewer) return false;
        element = getElement(element);
        if (!element || element.closest('form')) return false;
        const panel = element.closest('.ledger-panel');
        const monthBlock = element.closest('.month-block');
        if (!panel || !monthBlock) return false;
        if (blockEventRow(element)) return true;
        if (blockYearAdd(monthBlock)) return true;
        const property = panel.dataset.property;
        const mKey = monthBlock.dataset.monthKey;
        const sections = panelScope(mKey, property).sections();
        if (hasDraft()) {
          showToast('Save or cancel the current inline edit first.');
          return true;
        }
        // A month's currency header adds a settlement (an event's header stands for its own section). Savings and the
        // Settlements block each have their own Add button, and the row menu offers both.
        if (!mKey.startsWith('ev:') && element.closest('.ledger-panel-head')) {
          ledgerDraft = { month: mKey, property, newSection: 'settlement' };
          renderLedger();
          showToast('Name the settlement.');
          return true;
        }
        // Holding the Settlements or Savings heading adds one of that kind. Only the block's own heading: a hold on a
        // section inside it finds that section first, and goes on adding a subsection as it always did.
        const nearestBlock = element.closest('.ledger-type-section');
        const groupBlock = nearestBlock?.classList.contains('is-group') ? nearestBlock : null;
        if (groupBlock && !mKey.startsWith('ev:')) {
          ledgerDraft = { month: mKey, property, newSection: groupBlock.dataset.group };
          renderLedger();
          showToast(groupBlock.dataset.group === 'savings' ? 'Name the savings pot.' : 'Name the settlement.');
          return true;
        }
        const entryCell = element.closest('.ledger-entry-cell:not(.ledger-sub-entry)');
        const toggle = entryCell?.querySelector('[data-toggle-entry]');
        const cat = element.closest('.ledger-cat');
        // An event panel's currency header stands for the event's own section, which has no title row of its own.
        const typeSection = element.closest('.ledger-type-section') || (element.closest('.ledger-panel-head') && panel.querySelector('.ledger-type-section.is-bare'));
        // The block's own type, not its title: an event's blocks are titled with their section's name.
        const type = ['income', 'net'].includes(typeSection?.dataset.type) ? typeSection.dataset.type : 'expense';
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
          const categoryName = catName(cat);
          const candidates = sections.filter(item => item.type === type);
          const section = candidates.find(item => item.name === namedSection) || candidates.find(item => item.subsections.includes(categoryName)) || candidates[0];
          if (!section) {
            showToast('Add a section for this month first: double-click the month name.');
            return true;
          }
          if (section.closed) {
            showToast(`“${section.name}” is closed. Reopen it to add to it.`);
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
          if (section.closed) {
            showToast(`“${section.name}” is closed. Reopen it to add to it.`);
            return true;
          }
          ledgerDraft = { month: mKey, property, section: section.name, role: ExpenseStore.SECTION_ROLES.fallback[ExpenseStore.sectionKind(section)] };
          renderLedger();
          showToast(`Add a subsection to ${section.name}.`);
          return true;
        }
        return false;
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
          const blockType = element.closest('.ledger-type-section')?.dataset.type;
          const type = ['income', 'net'].includes(blockType) ? blockType : 'expense';
          editDraft = { kind: 'category', month: monthBlock.dataset.monthKey, property: panel.dataset.property, type, category: catName(cat), section: cat.dataset.section };
        } else if (kind === 'ysec') {
          // The first click folded or unfolded the section; put that back.
          const group = element.closest('.ledger-year-group');
          group.open = !group.open;
          return startYearSectionRename(monthBlock.dataset.monthKey, panel.dataset.property, element.closest('.ledger-type-section'), group.querySelector(':scope > summary').dataset.yearSection);
        } else if (kind === 'yitem') {
          const cat = element.closest('.ledger-cat');
          const blockType = element.closest('.ledger-type-section')?.dataset.type;
          const type = ['income', 'net'].includes(blockType) ? blockType : 'expense';
          editDraft = { kind: 'year-item', month: monthBlock.dataset.monthKey, property: panel.dataset.property, type, section: cat.dataset.section, category: catName(cat), item: element.closest('[data-year-item]').dataset.yearItem };
        } else {
          const section = element.closest('.ledger-type-section');
          if (section) section.open = !section.open;
          const mKey = monthBlock.dataset.monthKey;
          if (mKey.startsWith('yr:')) return startYearSectionRename(mKey, panel.dataset.property, section);
          if (mKey.startsWith('ev:')) return showToast('Press and hold the section name to add a subsection.');
          // A block heading and a settlement or pot inside it are renamed right here; Income and Expenses are named
          // in Month settings, where the rest of a month's taxonomy lives.
          if (section?.classList.contains('is-group')) {
            editDraft = { kind: 'block', month: mKey, property: panel.dataset.property, block: section.dataset.group };
            section.open = true;
          } else if (section?.dataset.kind && section.dataset.section) {
            editDraft = { kind: 'section', month: mKey, property: panel.dataset.property, section: section.dataset.section };
            section.open = true;
          } else {
            return openMonthSettings(...yearMonthOf(mKey));
          }
        }
        renderLedger();
      };

      // The row a hold acts on: a note, an entry, a subsection, Income/Expenses, or a panel's currency header.
      const pressRowFor = target => {
        const el = getElement(target);
        if (!el || el.closest('form') || el.closest(ROW_BUTTONS)) return null;
        const note = el.closest('.ledger-sub-entry[data-note-id]');
        if (note) return note.querySelector('.ledger-entry-line') || note;
        const cell = el.closest('.ledger-entry-cell:not(.ledger-sub-entry)');
        if (cell) return cell.querySelector(':scope > .ledger-entry-line');
        return el.closest('.ledger-cat > summary, .ledger-type-section > summary, .ledger-panel-head');
      };
      let pressedRow = null;
      const pointOf = e => e.touches?.[0] ?? e.changedTouches?.[0] ?? e;
      const startLongPress = (target, e) => {
        if (isViewer) return; // no hold to add
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
        // A second finger on a row: tag it, instead of the hold the first finger started (or a pinch).
        if (e.touches.length === 2 && taggableRow(e.target)) {
          endLongPress();
          e.preventDefault();
          openTagPicker(e.target);
          return;
        }
        startLongPress(e.target, e);
      }, { passive: false });

      // After a touch the browser replays mousedown/mouseup/click; ignore that replay so it neither starts a
      // second hold nor clears the click suppression. Touch end events go to the element first touched, which a
      // hold has just re-rendered away, so releases are caught as pointer events on the window instead.
      let lastTouchEnd = 0;
      const endPointer = event => {
        if (event.pointerType !== 'mouse') lastTouchEnd = Date.now();
        endLongPress();
      };
      window.addEventListener('pointerup', endPointer);
      window.addEventListener('pointercancel', endLongPress);
      // A finger or the mouse moving away during the hold cancels it (watched on the window, as the row may re-render).
      window.addEventListener('touchmove', checkLongPressMove, { passive: true });
      window.addEventListener('mousemove', checkLongPressMove);

      ledger.addEventListener('mousedown', (e) => {
        if (e.button === 0 && Date.now() - lastTouchEnd > 500) startLongPress(e.target, e);
      });

      ledger.addEventListener('mouseup', endLongPress);
      // Android raises the context menu mid-hold and cancels the touch; keep the hold alive.
      ledger.addEventListener('contextmenu', (e) => {
        if (longPressTimer || longPressFired || Date.now() < suppressClickUntil) return e.preventDefault();
        // A mouse right-click opens the row menu for whatever it is on (its Tags… item tags an entry or a note).
        const target = Date.now() - lastTouchEnd > 500 && (!e.pointerType || e.pointerType === 'mouse') ? menuTargetFor(e.target) : null;
        if (target) {
          e.preventDefault();
          openRowMenu(target, { x: e.clientX, y: e.clientY }, false, { triggerLongPress });
        }
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
          <label class="check-field is-strong"><input type="checkbox" name="month-active-${key}" data-month-active="${key}"${active ? ' checked' : ''}${active && entries ? ' disabled' : ''}><span><span class="cur-dot ${region.color}"></span>${escapeHtml(region.code)} · ${escapeHtml(region.name)}${active && entries ? ` <em>${entries} ${entries === 1 ? 'entry' : 'entries'} — remove them to turn ${escapeHtml(region.code)} off</em>` : ''}</span></label>
          ${active ? `<label class="check-field"><input type="checkbox" name="month-carry-${key}" data-month-carry="${key}"${carry ? ' checked' : ''}><span>Bring in the balance from ${escapeHtml(from)} <em>${escapeHtml(amount)}</em></span></label>` : ''}
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
          const sectionKind = section.type === 'net' ? ExpenseStore.sectionKind(section) : null;
          // Which block a custom section belongs to, whether it has been closed off, and what each of its subsections
          // stands for — all of it editable here as well as from the ledger itself.
          const kindToggle = !sectionKind ? '' : `<div class="type-toggle" role="group" aria-label="Which block this belongs to"><button type="button" data-section-kind="settlement" aria-pressed="${sectionKind === 'settlement'}">Settlement</button><button type="button" data-section-kind="savings" aria-pressed="${sectionKind === 'savings'}">Savings</button></div>`;
          const closedToggle = !sectionKind ? '' : `<label class="check-field config-closed"><input type="checkbox" data-section-closed${section.closed ? ' checked' : ''}><span>Closed${section.closedOn ? ` <em>on ${escapeHtml(section.closedOn)}</em>` : ' <em>no more entries; its figures stay</em>'}</span></label>`;
          const roleRows = !sectionKind || !section.subsections.length ? '' : `<div class="config-roles"><span class="kv-key">What each one counts as</span>${section.subsections.map(sub => `<label class="config-role"><span>${escapeHtml(sub)}</span><select data-section-role="${escapeHtml(sub)}" aria-label="What ${escapeHtml(sub)} counts as">${window.LedgerBlueprints.ROLE_CHOICES[sectionKind].map(([value, label]) => `<option value="${value}"${value === ExpenseStore.subsectionRole(section, sub) ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>`).join('')}</div>`;
          box.innerHTML = `<div class="config-section-head">
              <input class="config-section-name" name="section-name" value="${escapeHtml(section.name)}" placeholder="Section name" aria-label="Section name" maxlength="40">
              ${section.type === 'net' ? kindToggle : `<div class="type-toggle" role="group" aria-label="Section type"><button type="button" data-section-type="expense" aria-pressed="${section.type === 'expense'}">Expense</button><button type="button" data-section-type="income" aria-pressed="${section.type === 'income'}">Income</button></div>`}
              <span class="config-usage">${entries ? `${entries} ${entries === 1 ? 'entry' : 'entries'}` : ''}</span>
              <button type="button" class="icon-button config-remove" data-remove-section aria-label="Remove section ${escapeHtml(section.name)}" title="Remove section"><i class="ti ti-trash" aria-hidden="true"></i></button>
            </div>
            ${closedToggle}
            ${section.type === 'net' && sectionKind === 'savings' ? window.LedgerBlueprints.SectionRuleFields(ExpenseStore.sectionCalc(section), { esc: escapeHtml }) : ''}
            ${roleRows}
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
    // ---- Section setup: how a custom section (L1) and each of its subsections (L2) count ----
    // Opened from the section heading's settings button, and right after a subsection is added to a custom section.
    // The setup dialog works on one of two things: a section, whose parts are its subsections, or a block, whose
    // parts are the sections in it. `block` holds which kind of block when it is one, and is null for a section.
    const setupState = { month: null, property: null, name: null, draft: null, focus: null, section: null, block: null };
    // The sections of the block being set up, each worked out its own way, which is what a block counts from.
    function setupBlockParts() {
      const { month, property, block } = setupState;
      const scope = panelScope(month, property);
      return scope.sections().filter(item => item.type === 'net' && ExpenseStore.sectionKind(item) === block)
        .map(section => {
          const amounts = Object.fromEntries((section.subsections || []).map(sub => [sub, []]));
          transactions.filter(item => !item.parentId && scope.match(item) && item.type === 'net'
            && (item.section === section.name || (!item.section && section.subsections.includes(item.category))))
            .forEach(item => (amounts[item.category] ||= []).push({ amount: store.entryTotal(item.id), split: item.split || null, alloc: item.alloc || null }));
          return { name: section.name, ...ExpenseStore.runCalc(section, amounts) };
        });
    }
    // This section's entry amounts by subsection, for the preview (an entry counts as the sum of its notes).
    function setupAmounts() {
      const { month, property, name } = setupState;
      const scope = panelScope(month, property);
      const section = scope.sections().find(item => item.name === name);
      setupState.section = section || null;
      const amounts = Object.fromEntries((section?.subsections || []).map(sub => [sub, []]));
      // The same shape the panel builds, splits and allocations included: the preview has to be the figures on the
      // page, or the dialog teaches a formula against numbers the ledger does not have.
      transactions.filter(item => !item.parentId && scope.match(item) && item.type === 'net' && (item.section === name || (!item.section && section?.subsections.includes(item.category))))
        .forEach(item => (amounts[item.category] ||= []).push({ amount: store.entryTotal(item.id), split: item.split || null, alloc: item.alloc || null }));
      return amounts;
    }
    const SIDES = [['income', 'Income'], ['expense', 'Expenses']];
    const CALC_COLORS = 8;
    const colorOf = id => (Number(id.slice(1)) - 1) % CALC_COLORS;
    // Whether a custom section's equations name any subsection by id (a new subsection is then left out until put in).
    function usesSubsectionIds(section) {
      const calc = ExpenseStore.sectionCalc(section);
      return [...calc.lines, calc.income.mode !== 'off' ? calc.income.formula : '', calc.expense.mode !== 'off' ? calc.expense.formula : ''].some(text => /\bE\d+\b/i.test(text));
    }
    // An equation field: the input over a copy of its text, coloured by what each name stands for.
    const calcField = (attrs, value, placeholder) => `<span class="calc-field"><span class="calc-hl" aria-hidden="true"></span><input ${attrs} name="calc-field" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false"></span>`;
    function paintField(input) {
      const { draft } = setupState;
      const ids = new Map(draft.vars.map(item => [item.id, colorOf(item.id)]));
      const defined = new Set(draft.lines.map(line => /^\s*([A-Za-z_]\w*)\s*=/.exec(line)?.[1].toUpperCase()).filter(Boolean));
      const { functions, grand, totals } = ExpenseStore.CALC_NAMES;
      const hl = input.previousElementSibling;
      hl.innerHTML = input.value.replace(/([A-Za-z_]\w*)|[^A-Za-z_]+/g, (text, word) => {
        if (!word) return escapeHtml(text);
        const key = word.toUpperCase();
        const tone = ids.has(key) ? `v${ids.get(key)}` : grand.includes(key) ? `g-${key[1].toLowerCase()}` : totals.includes(key) ? 'is-total' : functions.includes(key) ? 'is-fn' : defined.has(key) ? 'is-var' : 'is-unknown';
        return `<span class="${tone}">${escapeHtml(word)}</span>`;
      });
      hl.scrollLeft = input.scrollLeft;
    }
    // Which kind the dialog is working on: a block's own kind, or the section's.
    const setupKind = () => setupState.block || ExpenseStore.sectionKind(setupState.section);
    // A settlement says in one word what it reports to the month (see ExpenseStore.SETTLE_MODES), because that is the
    // one thing about it nobody can work out from the entries. Picking a word writes its equations below, so the
    // dialog always shows what the word actually means and the two can never drift apart; editing those equations by
    // hand moves it to Custom, which is the honest name for equations nobody chose from a list.
    function renderSettleModes() {
      const row = document.querySelector('#calc-modes');
      if (!row) return;
      const isSettlement = setupKind() === 'settlement';
      row.hidden = !isSettlement;
      if (!isSettlement) return (row.innerHTML = '');
      const now = ExpenseStore.settleMode(setupState.draft);
      row.innerHTML = ExpenseStore.SETTLE_MODES.map(mode => {
        const { label, hint } = ExpenseStore.SETTLE_MODE_LABELS[mode];
        return `<button type="button" class="calc-mode" data-settle-mode="${mode}" aria-pressed="${mode === now}" title="${escapeHtml(hint)}"><b>${escapeHtml(label)}</b><span>${escapeHtml(hint)}</span></button>`;
      }).join('');
    }
    // Everything a word stands for, written out. Keeping the part ids means a settlement that names one of its own
    // subsections in a custom equation can be moved to a word and back without losing which subsection it meant.
    function setSettleMode(mode) {
      const { draft } = setupState;
      if (mode === 'custom') {
        draft.mode = 'custom';
      } else {
        Object.assign(draft, ExpenseStore.settlePreset(mode, draft.vars));
      }
      setupState.target = null;
      renderSectionSetup();
    }
    // A hand-edit is nobody's preset any more. It is said once, when the first edit happens, rather than on every
    // keystroke, so the picker does not flicker while a formula is being typed.
    function markCustom() {
      const { draft } = setupState;
      if (setupKind() !== 'settlement' || ExpenseStore.settleMode(draft) === 'custom') return;
      draft.mode = 'custom';
      renderSettleModes();
    }
    function renderSectionSetup() {
      const { month, property, name, draft } = setupState;
      document.querySelector('#section-setup-title').textContent = name;
      const what = setupState.block ? 'Block setup' : 'Section setup';
      document.querySelector('#section-setup-where').textContent = `${what} · ${regions[property].code} · ${panelScope(month, property).label}`;
      renderSettleModes();
      // The part ids stand for whatever this is counting over: a section's subsections, or a block's sections.
      document.querySelector('[data-calc-parts]').textContent = setupState.block ? 'E1, E2… the sections in it' : 'E1, E2… subsections';
      document.querySelector('#calc-lines').innerHTML = draft.lines.map((line, index) => `<div class="calc-row" data-line="${index}">
          ${calcField(`data-calc-line="${index}" aria-label="Calculation ${index + 1}"`, line, 'Name = E1 / 2')}
          <output class="calc-value"></output>
          <button type="button" class="icon-button calc-remove" data-calc-remove="${index}" aria-label="Remove this line" title="Remove"><i class="ti ti-x" aria-hidden="true"></i></button>
          <p class="calc-error" hidden></p>
        </div>`).join('') || '<p class="config-muted calc-none">No calculations. Add a line to work things out step by step, or write the result straight below.</p>';
      const options = mode => [['count', 'Add to total'], ['show', 'Show only'], ['off', 'Off']].map(([value, label]) => `<option value="${value}"${value === mode ? ' selected' : ''}>${label}</option>`).join('');
      document.querySelector('#calc-out').innerHTML = SIDES.map(([type, label]) => `<div class="calc-row is-out ${type}" data-side="${type}">
          <b>${label}</b>
          <select name="side-mode-${type}" data-side-mode="${type}" aria-label="${label}: add to the month">${options(draft[type].mode)}</select>
          ${calcField(`data-calc-out="${type}" aria-label="${label} for the month"`, draft[type].formula, type === 'income' ? 'e.g. GI (empty: nothing)' : 'e.g. GE (empty: nothing)')}
          <output class="calc-value"></output>
          <p class="calc-error" hidden></p>
        </div>`).join('');
      updateSetupPreview();
    }
    // Live: chips with their values, each line's and each side's result or problem, and the colours in every field.
    function updateSetupPreview() {
      const { property, name, draft, block } = setupState;
      const summary = block
        ? ExpenseStore.runBlockCalc({ name, kind: block }, setupBlockParts(), draft)
        : (() => {
          const amounts = setupAmounts();
          const live = setupState.section;
          return ExpenseStore.runCalc({ name, subsections: Object.keys(amounts), kind: ExpenseStore.sectionKind(live), roles: live?.roles || {}, calc: draft }, amounts);
        })();
      setupState.summary = summary;
      const money = minor => `${minor < 0 ? '−' : ''}${formatMoney(Math.abs(minor), property)}`;
      const chip = (id, label, minor, tone, title = `Put ${id} in the equation`) => `<button type="button" class="calc-chip ${tone}" data-insert="${id}" title="${escapeHtml(title)}"><b>${id}</b>${label ? `<span>${escapeHtml(label)}</span>` : ''}${minor === undefined ? '<em class="is-unset">not set</em>' : `<em class="${minor < 0 ? 'expense' : 'income'}">${money(minor)}</em>`}</button>`;
      // Subsections; the entries' own totals; then GI / GE / GB, shown in the heading only once a line sets them.
      const minorOf = key => Math.round((summary.base[key] || 0) * 100);
      const totalChip = (id, title) => chip(id, '', minorOf(id), 'is-total', title);
      // A settlement is offered the figures a settlement is actually about: what is outstanding, what was really
      // yours, the money that passed between the two sides, and how much of that has been said what it was for.
      const roleChips = setupKind() === 'savings'
        ? totalChip('SV', 'Put into the pot less what was taken out') + totalChip('RT', 'Interest, dividend or gain the pot earned')
        : totalChip('OWED', 'Still outstanding: above zero is owed to you, below zero is what you owe')
          + totalChip('MS', 'Your own share of what the group spent')
          + totalChip('SI', 'Money that came to you from the other side')
          + totalChip('SO', 'Money you handed over to the other side')
          + totalChip('AL', 'Of that, how much has been said what it was for')
          + totalChip('UA', 'Of that, how much has not been said what it was for');
      document.querySelector('#calc-chips').innerHTML = summary.subs.map(sub => chip(sub.id, sub.name, sub.sum, `v${colorOf(sub.id)}`)).join('')
        + totalChip('CI', 'Cash in: every entry that brought money in, leaving notes out')
        + totalChip('CO', 'Cash out: every entry that took money out, leaving notes out')
        + roleChips
        + totalChip('TI', 'All positive entries, notes included') + totalChip('TE', 'All negative entries, notes included, as a positive sum')
        + chip('GI', '', summary.stats.income, 'g-i', 'Income in the heading: set it with a line GI = …')
        + chip('GE', '', summary.stats.expenses, 'g-e', 'Expenses in the heading: set it with a line GE = …')
        + chip('GB', '', summary.stats.balance, 'g-b', 'Balance in the heading: set it with a line GB = …');
      const show = (row, result, mode) => {
        // A result for the month takes its side's colour; a line's value, its sign's.
        const tone = row.dataset.side || (result.value < 0 ? 'expense' : 'income');
        row.querySelector('.calc-value').innerHTML = result.error || result.blank || result.empty || mode === 'off' ? '' : `= <span class="${tone}">${money(result.value)}</span>`;
        const error = row.querySelector('.calc-error');
        error.textContent = result.error || '';
        error.hidden = !result.error;
        error.classList.toggle('is-soft', result.fatal === false);
        row.querySelector('input').toggleAttribute('aria-invalid', Boolean(result.error && result.fatal !== false));
      };
      document.querySelectorAll('#calc-lines .calc-row').forEach(row => show(row, summary.lines[Number(row.dataset.line)] || {}));
      SIDES.forEach(([type]) => {
        const side = summary.sides[type];
        const row = document.querySelector(`#calc-out [data-side="${type}"]`);
        row.toggleAttribute('data-off', side.mode === 'off');
        show(row, side.mode === 'off' ? {} : { value: side.result, error: side.error, fatal: side.fatal, empty: side.empty }, side.mode);
      });
      document.querySelectorAll('#section-setup-form .calc-field input').forEach(paintField);
    }
    // Opens the same dialog on a whole block, its parts being the sections in it. A block that has never been set up
    // starts from the default, which works out to exactly what the block already posts — so opening this and saving
    // without touching anything changes no figure.
    function openBlockSetup(month, property, kind) {
      if (isViewer) return showToast('This account can view the ledger but not change it.');
      if (String(month).startsWith('ev:')) return showToast('An event has no blocks to set up.');
      const [year, monthIndex] = yearMonthOf(month);
      const names = panelScope(month, property).sections()
        .filter(item => item.type === 'net' && ExpenseStore.sectionKind(item) === kind).map(item => item.name);
      const stored = store.storedBlockCalc(year, monthIndex, property, kind);
      const title = store.blockNames(year, monthIndex, property)[kind];
      Object.assign(setupState, { month, property, name: title, focus: null, target: null, section: null, block: kind,
        draft: JSON.parse(JSON.stringify(ExpenseStore.blockCalc(stored, names, kind))) });
      document.querySelector('#section-setup-error').hidden = true;
      renderSectionSetup();
      document.querySelector('#section-setup-dialog').showModal();
    }
    function openSectionSetup(month, property, name, focus = null) {
      if (isViewer) return showToast('This account can view the ledger but not change it.');
      const section = panelScope(month, property).sections().find(item => item.name === name);
      if (!section) return showToast('That section is no longer set up here.');
      Object.assign(setupState, { month, property, name, focus, target: null, section, block: null, draft: JSON.parse(JSON.stringify(ExpenseStore.sectionCalc(section))) });
      document.querySelector('#section-setup-error').hidden = true;
      renderSectionSetup();
      document.querySelector('#section-setup-dialog').showModal();
      // A new subsection: show its chip and start a line with it.
      const id = focus && setupState.draft.vars.find(item => item.name === focus)?.id;
      if (id) {
        document.querySelector(`#calc-chips [data-insert="${id}"]`)?.classList.add('is-focus');
        document.querySelector('#calc-out [data-calc-out="expense"]')?.focus();
      }
    }
    function setupSectionSetup() {
      const dialog = document.querySelector('#section-setup-dialog');
      const form = document.querySelector('#section-setup-form');
      const addLine = (at, text = '') => {
        setupState.draft.lines.splice(at, 0, text);
        markCustom();
        renderSectionSetup();
        const input = form.querySelector(`[data-calc-line="${at}"]`);
        input?.focus();
        input?.setSelectionRange(text.length, text.length);
      };
      form.addEventListener('change', event => {
        const mode = event.target.closest('[data-side-mode]');
        if (!mode) return;
        setupState.draft[mode.dataset.sideMode].mode = mode.value;
        markCustom();
        updateSetupPreview();
      });
      form.addEventListener('focusin', event => {
        if (event.target.closest('.calc-field input')) setupState.target = event.target;
      });
      form.addEventListener('input', event => {
        const input = event.target;
        if (input.dataset.calcLine !== undefined) setupState.draft.lines[Number(input.dataset.calcLine)] = input.value;
        else if (input.dataset.calcOut) setupState.draft[input.dataset.calcOut].formula = input.value;
        else return;
        markCustom();
        document.querySelector('#section-setup-error').hidden = true;
        updateSetupPreview();
      });
      form.addEventListener('scroll', event => {
        if (event.target.closest?.('.calc-field input')) paintField(event.target);
      }, true);
      form.addEventListener('click', event => {
        const pick = event.target.closest('[data-settle-mode]');
        if (pick) return setSettleMode(pick.dataset.settleMode);
        const chip = event.target.closest('[data-insert]');
        if (chip) {
          // Puts the id at the cursor of the field last worked on (else the Expenses result), with a + after a value.
          const input = setupState.target && form.contains(setupState.target) ? setupState.target : form.querySelector('[data-calc-out="expense"]');
          const start = input.selectionStart ?? input.value.length;
          const before = input.value.slice(0, start);
          const join = before.trim() && !/[-+*/(=,]\s*$/.test(before) ? ' + ' : before && !/\s$/.test(before) ? ' ' : '';
          input.setRangeText(`${join}${chip.dataset.insert}`, start, input.selectionEnd ?? start, 'end');
          input.focus();
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
        if (event.target.closest('[data-calc-add]')) return addLine(setupState.draft.lines.length);
        const remove = event.target.closest('[data-calc-remove]');
        if (remove) {
          setupState.draft.lines.splice(Number(remove.dataset.calcRemove), 1);
          setupState.target = null;
          markCustom();
          renderSectionSetup();
        }
      });
      form.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !event.target.closest('.calc-field input')) return;
        event.preventDefault();
        // Enter in a line starts the next one; in a result, it saves.
        if (event.target.dataset.calcLine !== undefined) addLine(Number(event.target.dataset.calcLine) + 1);
        else form.requestSubmit();
      });
      form.addEventListener('submit', event => {
        event.preventDefault();
        updateSetupPreview();
        const { month, property, name, draft, summary } = setupState;
        const error = document.querySelector('#section-setup-error');
        const lineIndex = summary.lines.findIndex(line => line.error && line.fatal !== false);
        const side = SIDES.find(([type]) => summary.sides[type].mode !== 'off' && summary.sides[type].error && summary.sides[type].fatal !== false);
        if (lineIndex >= 0 || side) {
          error.textContent = lineIndex >= 0 ? `Line ${lineIndex + 1}: ${summary.lines[lineIndex].error}` : `${side[1]}: ${summary.sides[side[0]].error}`;
          error.hidden = false;
          return (lineIndex >= 0 ? form.querySelector(`[data-calc-line="${lineIndex}"]`) : form.querySelector(`[data-calc-out="${side[0]}"]`)).focus();
        }
        const result = type => ({ mode: draft[type].mode, formula: draft[type].formula.trim() });
        const calc = { v: 3, vars: draft.vars, lines: draft.lines.map(line => line.trim()).filter(Boolean), income: result('income'), expense: result('expense'),
          ...(setupKind() === 'settlement' && { mode: ExpenseStore.settleMode(draft) }) };
        if (setupState.block) {
          const [year, monthIndex] = yearMonthOf(month);
          trackSave(store.saveBlockCalc(year, monthIndex, property, setupState.block, calc));
          dialog.close();
          renderLedger();
          return showToast(`Saved how the “${name}” block counts.`);
        }
        const scope = panelScope(month, property);
        const section = scope.own().find(item => item.name === name);
        if (!section) return dialog.close();
        ExpenseStore.ensureCalc(section);
        section.calc = calc;
        scope.save();
        dialog.close();
        renderLedger();
        showToast(`Saved how “${name}” counts.`);
      });
    }
    // ---- What a repayment covers -------------------------------------------------------------
    // One payment hardly ever pays off one thing. Hand 130,000 back and it clears the rent, part of the car and the
    // whole of a loan; money arriving is the same question the other way round — what is it for. Without somewhere
    // to say so, a settlement can only tell you a single net figure and you are left remembering the rest.
    //
    // So a "Settled up" entry can be spread over the subsections of its own settlement. The entry's sign still says
    // which way the money went; this only says how much of it belonged to each thing. Nothing has to be allocated,
    // and what is allocated never changes the settlement's own totals — it divides what is outstanding between the
    // things the settlement is about, so each of them can say where it stands on its own.
    const allocState = { id: null, draft: new Map(), rows: [], amount: 0, property: null };
    // The settlement an entry sits in, worked out as the panel works it out, so the figures in the picker are the
    // figures on the page rather than a second opinion about them.
    function settlementFor(item) {
      if (!item || item.type !== 'net') return null;
      const mKey = item.eventId ? `ev:${item.eventId}` : item.date.slice(0, 7);
      const scope = panelScope(mKey, item.property);
      const section = scope.sections().find(entry => entry.type === 'net'
        && (item.section ? entry.name === item.section : entry.subsections.includes(item.category)));
      if (!section || ExpenseStore.sectionKind(section) !== 'settlement') return null;
      const amounts = Object.fromEntries((section.subsections || []).map(sub => [sub, []]));
      transactions.filter(row => !row.parentId && scope.match(row) && row.type === 'net'
        && (row.section === section.name || (!row.section && section.subsections.includes(row.category))))
        .forEach(row => (amounts[row.category] ||= []).push({ amount: store.entryTotal(row.id), split: row.split || null, alloc: row.alloc || null }));
      return { mKey, property: item.property, scope, section, summary: ExpenseStore.runCalc(section, amounts) };
    }
    // Whether this row is one that can say what it covers: a real entry, in a settlement, under a "Settled up"
    // subsection. A cost already says what it was for by sitting under that heading, so it is never asked.
    function allocatable(item) {
      const home = settlementFor(item);
      if (!home || item.parentId) return null;
      return ExpenseStore.subsectionRole(home.section, item.category) === ExpenseStore.ALLOC_ROLE ? home : null;
    }
    function openAllocDialog(id) {
      if (isViewer) return viewOnly();
      const item = transactions.find(row => row.id === id);
      const home = item && allocatable(item);
      if (!home) return showToast('Only a “Settled up” entry in a settlement can say what it covers.');
      const amount = store.entryTotal(item.id);
      if (!amount) return showToast('Give the entry an amount first.');
      const { section, summary, property } = home;
      const owedBy = new Map((summary.settle.purposes || []).map(part => [part.name, part]));
      // Everything in the settlement this money could be for: its own subsection is left out (money cannot pay
      // itself off), and so is a memo subsection, which states a share rather than holding any money.
      const memo = new Set(ExpenseStore.SECTION_ROLES.memo);
      const rows = (section.subsections || [])
        .filter(name => name !== item.category && !memo.has(ExpenseStore.subsectionRole(section, name)))
        .map(name => ({ name, owed: Number(owedBy.get(name)?.owed) || 0, laid: Number(owedBy.get(name)?.laid) || 0 }));
      // An allocation to a subsection that has since gone is still shown, so it can be seen and taken off rather
      // than quietly counting for nothing.
      ExpenseStore.normalizeAlloc(item.alloc).forEach(part => {
        if (!rows.some(row => row.name === part.to)) rows.push({ name: part.to, owed: 0, laid: 0, gone: true });
      });
      Object.assign(allocState, { id, property, amount, rows,
        draft: new Map(ExpenseStore.allocFor(amount, item.alloc).map(part => [part.to, part.a])) });
      document.querySelector('#alloc-dialog-title').textContent = item.description || 'This entry';
      document.querySelector('#alloc-where').textContent = `${section.name} · ${regions[property].code} · ${home.scope.label}`;
      document.querySelector('#alloc-blurb').textContent = amount > 0
        ? `${formatMoney(Math.abs(amount), property)} came in. What was it for?`
        : `${formatMoney(Math.abs(amount), property)} went out. What did it pay off?`;
      document.querySelector('#alloc-error').hidden = true;
      renderAlloc();
      document.querySelector('#alloc-dialog').showModal();
      document.querySelector('#alloc-list input')?.focus();
    }
    const allocUsed = () => [...allocState.draft.values()].reduce((sum, value) => sum + value, 0);
    function renderAlloc() {
      const { rows, property, amount, draft } = allocState;
      const money = minor => `${minor < 0 ? '−' : ''}${formatMoney(Math.abs(minor), property)}`;
      document.querySelector('#alloc-list').innerHTML = rows.length ? rows.map(row => {
        // What is still open on that one thing, said the way round the reader is standing: above zero they owe you.
        const note = row.gone ? 'no longer a subsection here'
          : row.owed > 0 ? `${money(row.owed)} still owed to you`
            : row.owed < 0 ? `${money(-row.owed)} you still owe`
              : row.laid ? 'nothing outstanding' : 'nothing recorded against it yet';
        const value = draft.get(row.name);
        return `<label class="alloc-row${row.gone ? ' is-gone' : ''}"><span class="alloc-name">${escapeHtml(row.name)}<small>${escapeHtml(note)}</small></span><input name="alloc" data-alloc-to="${escapeHtml(row.name)}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${value ? escapeHtml(String(value / 100)) : ''}" placeholder="0" aria-label="How much of this covers ${escapeHtml(row.name)}"></label>`;
      }).join('') : '<p class="config-muted">This settlement has nothing else in it yet. Add what the money was for as a subsection first.</p>';
      const left = Math.abs(amount) - allocUsed();
      const out = document.querySelector('#alloc-left');
      out.textContent = left > 0 ? `${money(left)} of ${money(Math.abs(amount))} not yet said what for.`
        : left < 0 ? `${money(-left)} more than the entry itself.`
          : `All ${money(Math.abs(amount))} accounted for.`;
      out.classList.toggle('is-over', left < 0);
    }
    function setupAllocDialog() {
      const dialog = document.querySelector('#alloc-dialog');
      const form = document.querySelector('#alloc-form');
      form.addEventListener('input', event => {
        const input = event.target.closest('[data-alloc-to]');
        if (!input) return;
        const read = ExpenseStore.readAmount(input.value);
        const minor = read.empty || read.error ? 0 : Math.abs(Math.round(read.value * 100));
        if (minor) allocState.draft.set(input.dataset.allocTo, minor); else allocState.draft.delete(input.dataset.allocTo);
        input.toggleAttribute('aria-invalid', Boolean(read.error));
        document.querySelector('#alloc-error').hidden = true;
        // Only the running total is redrawn while typing: rewriting the rows would take the caret with them.
        const left = Math.abs(allocState.amount) - allocUsed();
        const money = value => `${value < 0 ? '−' : ''}${formatMoney(Math.abs(value), allocState.property)}`;
        const out = document.querySelector('#alloc-left');
        out.textContent = left > 0 ? `${money(left)} of ${money(Math.abs(allocState.amount))} not yet said what for.`
          : left < 0 ? `${money(-left)} more than the entry itself.`
            : `All ${money(Math.abs(allocState.amount))} accounted for.`;
        out.classList.toggle('is-over', left < 0);
      });
      document.querySelector('#alloc-clear').addEventListener('click', () => {
        allocState.draft.clear();
        renderAlloc();
      });
      // What is left over goes against whatever is still outstanding, most outstanding first and never past it —
      // which is what anyone would do by hand, and is the whole gesture for the common case of paying one thing off.
      document.querySelector('#alloc-rest').addEventListener('click', () => {
        let left = Math.abs(allocState.amount) - allocUsed();
        if (left <= 0) return showToast('Nothing left to spread.');
        // Money coming in pays off what they owe me; money going out pays off what I owe. Each way round only ever
        // goes against the things that are actually open in that direction, so a repayment is never put against a
        // thing it could not possibly have paid for.
        const coming = allocState.amount > 0;
        [...allocState.rows]
          .map(row => ({ row, open: coming ? row.owed : -row.owed }))
          .filter(item => item.open > 0)
          .sort((a, b) => b.open - a.open)
          .forEach(({ row, open }) => {
            const already = allocState.draft.get(row.name) || 0;
            const take = Math.min(left, Math.max(0, open - already));
            if (!take) return;
            left -= take;
            allocState.draft.set(row.name, already + take);
          });
        renderAlloc();
        if (left > 0) showToast('Nothing more is outstanding; the rest is left unsaid.');
      });
      form.addEventListener('submit', event => {
        event.preventDefault();
        const error = document.querySelector('#alloc-error');
        const over = allocUsed() - Math.abs(allocState.amount);
        if (over > 0) {
          error.textContent = `That is ${formatMoney(over, allocState.property)} more than the entry itself. Take some off first.`;
          error.hidden = false;
          return;
        }
        const item = transactions.find(row => row.id === allocState.id);
        if (!item) {
          dialog.close();
          return showToast('Could not find that entry. Refresh and try again.');
        }
        // Kept in the order the settlement lists them, so two entries covering the same things read the same way.
        const list = allocState.rows.map(row => ({ to: row.name, a: allocState.draft.get(row.name) || 0 })).filter(part => part.a);
        if (list.length) item.alloc = list; else delete item.alloc;
        saveTransactions();
        dialog.close();
        renderLedger();
        showToast(list.length
          ? `“${item.description}” covers ${list.length === 1 ? list[0].to : `${list.length} things`}.`
          : `“${item.description}”: nothing said about what it covers.`);
      });
    }

    // ---- Merging closed sections ----
    // Only closed ones are offered: while something is still outstanding it belongs on its own, where it can be
    // followed. Once two or more are settled and were really the same running thing — the same trip, the same person,
    // the same pot — they can be folded into one so the month stops carrying a row per occasion.
    const mergeState = { month: null, property: null, kind: null, picked: new Set() };
    function mergeCandidates() {
      const { month, property, kind } = mergeState;
      return panelScope(month, property).sections()
        .filter(item => item.type === 'net' && item.closed && ExpenseStore.sectionKind(item) === kind);
    }
    // The list is drawn once, when the dialog opens. Ticking a box only refreshes the "keep it all under" choice:
    // redrawing the list under the pointer would throw away the tick that was just made.
    function renderMergeDialog() {
      const { property, picked } = mergeState;
      const one = mergeState.kind === 'savings' ? 'pot' : 'settlement';
      document.querySelector('#merge-blurb').textContent = `Pick the closed ${one}s that were really the same thing. Their subsections and every entry move across; nothing is lost and no figure changes.`;
      document.querySelector('#merge-list').innerHTML = mergeCandidates().map(section => {
        const settle = sectionSettle(mergeState.month, property, section);
        const sum = `${formatMoney(settle.cashIn, property)} in · ${formatMoney(settle.cashOut, property)} out`;
        return `<label class="check-field merge-row"><input type="checkbox" data-merge-pick="${escapeHtml(section.name)}"${picked.has(section.name) ? ' checked' : ''}><span>${escapeHtml(section.name)}<em>${escapeHtml(sum)}${section.closedOn ? ` · closed ${escapeHtml(section.closedOn)}` : ''}</em></span></label>`;
      }).join('') || '<p class="config-muted">Nothing closed here yet.</p>';
      renderMergeTarget();
    }
    function renderMergeTarget() {
      const target = document.querySelector('#merge-target');
      const chosen = mergeCandidates().filter(section => mergeState.picked.has(section.name));
      const was = target.value;
      target.innerHTML = chosen.map(section => `<option value="${escapeHtml(section.name)}">${escapeHtml(section.name)}</option>`).join('')
        || '<option value="">Pick two or more first</option>';
      if (chosen.some(section => section.name === was)) target.value = was;
      target.disabled = chosen.length < 2;
    }
    function openMergeDialog(month, property, kind) {
      if (isViewer) return viewOnly();
      Object.assign(mergeState, { month, property, kind, picked: new Set() });
      const list = mergeCandidates();
      if (list.length < 2) return showToast('Close at least two of them first.');
      document.querySelector('#merge-dialog-title').textContent = kind === 'savings' ? 'Merge settled pots' : 'Merge settled settlements';
      document.querySelector('#merge-where').textContent = `${regions[property].code} · ${panelScope(month, property).label}`;
      document.querySelector('#merge-error').hidden = true;
      renderMergeDialog();
      document.querySelector('#merge-dialog').showModal();
    }
    function setupMergeDialog() {
      const dialog = document.querySelector('#merge-dialog');
      if (!dialog) return;
      const form = document.querySelector('#merge-form');
      form.addEventListener('change', event => {
        const pick = event.target.closest('[data-merge-pick]');
        if (!pick) return;
        const name = pick.dataset.mergePick;
        if (pick.checked) mergeState.picked.add(name); else mergeState.picked.delete(name);
        document.querySelector('#merge-error').hidden = true;
        renderMergeTarget();
      });
      form.addEventListener('submit', event => {
        event.preventDefault();
        const error = document.querySelector('#merge-error');
        const names = mergeCandidates().map(section => section.name).filter(name => mergeState.picked.has(name));
        if (names.length < 2) {
          error.textContent = 'Pick at least two.';
          error.hidden = false;
          return;
        }
        const target = document.querySelector('#merge-target').value || names[0];
        mergeSections(mergeState.month, mergeState.property, mergeState.kind, names, target);
        dialog.close();
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
        // A custom section's counting rule: how it counts in the month, and which side positive amounts go to.
        const rule = event.target.closest('[data-side-mode]');
        const block = rule?.closest('[data-currency]');
        if (rule && block) {
          const section = monthSectionsFor(block.dataset.currency)[Number(rule.closest('.config-section').dataset.sectionIndex)];
          ExpenseStore.ensureCalc(section)[rule.dataset.sideMode].mode = rule.value;
          monthState.dirty.add(block.dataset.currency);
        }
        const sectionOf = element => {
          const holder = element.closest('[data-currency]');
          const box = element.closest('.config-section');
          if (!holder || !box) return null;
          monthState.dirty.add(holder.dataset.currency);
          return monthSectionsFor(holder.dataset.currency)[Number(box.dataset.sectionIndex)];
        };
        // What a subsection of a settlement or a pot stands for.
        const roleField = event.target.closest('[data-section-role]');
        if (roleField) {
          const section = sectionOf(roleField);
          if (section) {
            section.roles ||= {};
            section.roles[roleField.dataset.sectionRole] = roleField.value;
          }
        }
        // Closing one off, or opening it again.
        const closedBox = event.target.closest('[data-section-closed]');
        if (closedBox) {
          const section = sectionOf(closedBox);
          if (section && closedBox.checked) Object.assign(section, { closed: true, closedOn: section.closedOn || todayKey().slice(0, 10) });
          else if (section) { delete section.closed; delete section.closedOn; }
          if (section) renderMonthSections();
        }
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
        const changed = (typeButton && box) || (event.target.closest('[data-section-kind]') && box) || (event.target.closest('[data-remove-section]') && box) || event.target.closest('[data-month-add-section]');
        if (!changed) return;
        const kindButton = event.target.closest('[data-section-kind]');
        if (kindButton && box) {
          const section = list[Number(box.dataset.sectionIndex)];
          const was = ExpenseStore.sectionKind(section);
          section.kind = kindButton.dataset.sectionKind;
          if (was !== section.kind) {
            section.roles = {};
            section.calc = ExpenseStore.defaultCalc(section.kind);
          }
        } else if (typeButton) list[Number(box.dataset.sectionIndex)].type = typeButton.dataset.sectionType;
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
          // Keep every setting a section has (custom sections' block flag and counting rule), not just its name and type.
          // A subsection added or renamed here gets its role settled now, so nothing is left without one.
          list.filter(section => section.type === 'net').forEach(section => ExpenseStore.ensureCalc(section));
          trackSave(store.saveMonthSections(year, month, key, list.map(({ originalName, ...section }) => ({ ...section, name: section.name.trim(), subsections: [...section.subsections] }))));
        });
        if (renamed) saveTransactions();
        trackSave(store.saveMonthSetup(year, month, setup));
        dialog.close();
        renderLedger();
        showToast(`Saved ${monthLabel(new Date(year, month, 1))} settings.`);
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
      root.innerHTML = `<div class="chip-input"><input type="text" name="chip-input" aria-label="${escapeHtml(label)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"></div><p class="chip-hint" aria-live="polite"></p>`;
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
          <label class="money-field"><select name="from-${key}" data-config-from="${key}" aria-label="${escapeHtml(region.code)} starts">${['', ...MONTH_NAMES].map(name => `<option value="${name}"${draft.from[key] === name ? ' selected' : ''}>${name ? `from ${name}` : 'Not used this year'}</option>`).join('')}</select></label>
          ${used ? `<label class="check-field"><input type="checkbox" name="carry-in-${key}" data-config-carry-in="${key}"${draft.carryIn[key] ? ' checked' : ''}${previousYear ? '' : ' disabled'}><span>Bring in ${year - 1} closing <em>${escapeHtml(carryNote)}</em></span></label>
          <label class="money-field${draft.carryIn[key] ? ' is-disabled' : ''}"><span>Opening</span><input type="number" name="opening-${key}" step="1" inputmode="numeric" value="${escapeHtml(draft.openings[key])}" data-config-money="openings" data-property="${key}" aria-label="${escapeHtml(region.code)} opening balance"${draft.carryIn[key] ? ' disabled' : ''}></label>` : ''}
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
          <input class="config-event-name" name="event-name" value="${escapeHtml(row.name)}" placeholder="Event name, e.g. Marriage" aria-label="Event name" maxlength="60" autocomplete="off">
          <span class="config-usage">${entries ? `${entries} ${entries === 1 ? 'entry' : 'entries'}` : ''}</span>
          ${eventCurrencyChips(row, year)}
          <label class="event-switch" title="Also count this event's entries in the months they happened"><input type="checkbox" name="event-include" data-event-include${row.include ? ' checked' : ''}><span class="event-switch-track" aria-hidden="true"></span><span>Show in months</span></label>
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
          setSpecialMode(true);
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
    // ---- Search (ledger-search.js): every entry and note, this year or all years, by word in either script ----
    // Rows carry where they live (month or ★ event, section › subsection) and how to open them in the ledger.
    function searchRows(year) {
      const byId = new Map(transactions.map(item => [item.id, item]));
      const rows = [];
      transactions.forEach(item => {
        const rowYear = Number(item.date.slice(0, 4));
        if (year && rowYear !== year) return;
        const parent = item.parentId ? byId.get(item.parentId) : null;
        const head = parent || item;
        const headYear = Number(head.date.slice(0, 4));
        const monthIndex = Number(head.date.slice(5, 7)) - 1;
        const eventName = head.eventId ? store.eventName(head.eventId) : '';
        const section = head.eventId ? (head.section || eventName) : store.summarySection(head, store.sections(headYear, monthIndex, head.property)).name;
        const mKey = head.eventId ? `ev:${head.eventId}` : keyOf(headYear, monthIndex);
        rows.push({
          id: item.id, parentId: item.parentId || null, year: rowYear, date: item.date, kind: item.parentId ? 'note' : 'entry', tags: item.tags || [],
          description: item.description, comment: item.place || '', parent: parent?.description || '',
          type: head.type, amount: item.parentId ? Number(item.amount) : store.entryTotal(item.id), property: item.property,
          where: head.eventId ? `★ ${eventName}` : monthLabel(new Date(headYear, monthIndex, 1)), crumbs: `${section} › ${head.category}`,
          category: head.category, section, eventName,
          jump: { year: headYear, mKey, property: head.property, type: head.type, entryId: head.id, noteId: item.parentId ? item.id : null, category: head.category }
        });
      });
      return rows;
    }
    // Opens a result in the ledger: its year and month (or event), its subsection, and its entry's notes for a note;
    // then scrolls it into view and makes it glow. Only already-loaded data is shown; a month not yet fetched is loaded.
    async function openSearchResult({ year, mKey, property, entryId, noteId, category }) {
      // Special events live under the Special tab; anything else under its year.
      setSpecialMode(mKey.startsWith('ev:'));
      if (!specialMode && currentMonth.getFullYear() !== year) selectLedgerYear(year);
      expandedMonths.add(mKey);
      saveExpandedMonths();
      // The currency being opened must be among the panels showing.
      const chosen = monthCurrencies.get(mKey);
      if (chosen && !chosen.includes(property)) {
        monthCurrencies.set(mKey, [...chosen, property]);
        saveMonthCurrencies();
      }
      if (noteId && entryId) expandedEntries.add(entryId);
      if (!mKey.startsWith('ev:')) {
        const [y, m] = yearMonthOf(mKey);
        if (!store.isLoaded(y, m)) await store.ensureMonth(y, m);
      }
      renderLedger();
      const block = document.querySelector(`.month-block[data-month-key="${CSS.escape(mKey)}"]`);
      if (!block) return showToast('Could not find that in the ledger.');
      const lineOf = el => el?.closest('.ledger-entry-line');
      let target = noteId ? block.querySelector(`[data-note-id="${CSS.escape(noteId)}"] .ledger-entry-line`) : null;
      target ||= entryId ? lineOf(block.querySelector(`[data-toggle-entry][data-entry-id="${CSS.escape(entryId)}"]`)) : null;
      target ||= [...block.querySelectorAll(`.ledger-panel[data-property="${CSS.escape(property)}"] .ledger-cat`)]
        .find(cat => catName(cat) === category)?.querySelector(':scope > summary');
      target ||= block.querySelector('.month-ledger-head');
      for (let details = target.closest('details'); details; details = details.parentElement.closest('details')) details.open = true;
      target.classList.remove('is-search-hit');
      void target.offsetWidth; // restart the glow when the same row is opened twice
      target.classList.add('is-search-hit');
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    // ---- Hashtags: a tag given by gesture (right-click or two-finger tap on a row), or #word in an entry's description or
    // comment, or in its subsection's or section's name, groups entries
    // across every month, year and event; a note can carry its own. The ★ page lists every tag and sums each one up.
    function hashtagIndex() {
      const tags = new Map();
      searchRows(null).forEach(row => {
        const own = LedgerSearch.rowTags(row, `${row.description} ${row.comment}`);
        const fromNames = row.kind === 'entry' ? LedgerSearch.hashtags(`${row.category} ${row.section}`) : [];
        new Set([...own, ...fromNames]).forEach(tag => {
          const entry = tags.get(tag) || { tag, rows: [], latest: '' };
          entry.rows.push(row);
          if (row.date > entry.latest) entry.latest = row.date;
          tags.set(tag, entry);
        });
      });
      // A tagged note inside a tagged entry is already in the entry's amount.
      tags.forEach(entry => {
        const ids = new Set(entry.rows.map(row => row.id));
        entry.rows = entry.rows.filter(row => !(row.kind === 'note' && ids.has(row.parentId)));
      });
      return [...tags.values()].sort((a, b) => b.latest.localeCompare(a.latest) || a.tag.localeCompare(b.tag));
    }
    // Income and expenses per currency: income entries and positive custom-section amounts in, the rest out.
    function hashtagSums(rows) {
      const sums = new Map();
      rows.forEach(row => {
        const sum = sums.get(row.property) || { in: 0, out: 0 };
        const incoming = row.type === 'income' || (row.type === 'net' && row.amount > 0);
        sum[incoming ? 'in' : 'out'] += Math.abs(row.amount);
        sums.set(row.property, sum);
      });
      return [...sums].sort(([a], [b]) => store.currencyKeys().indexOf(a) - store.currencyKeys().indexOf(b));
    }
    // ---- Copy and paste: a section (or all of Income or Expenses), a subsection or an entry, from any month or special
    // event into another. A paste copies the names only, or the entries too ("with entries"); copied entries keep their
    // amounts, signs, formulas, notes and tags, take the target's month (same day, within it) or keep their date in an event,
    // and are new rows: the source is never changed. Entries are copied only within one currency.
    let clipboard = null; // { kind: 'sections' | 'subsection' | 'entry', mKey, property, label, ... }
    let copySeq = 0;
    const newRowId = () => `new-${Date.now()}-${++copySeq}`;
    const scopeName = (mKey, property) => `${mKey.startsWith('ev:') ? `★ ${store.eventName(mKey.slice(3))}` : panelScope(mKey, property).label} ${regions[property]?.code || property}`;
    // The date a copied row takes in the target: the same day in the target month, or its own full date in an event.
    function dateIn(mKey, date) {
      if (mKey.startsWith('ev:')) return date;
      const [year, monthIndex] = yearMonthOf(mKey);
      const last = new Date(year, monthIndex + 1, 0).getDate();
      const day = Number(date.slice(8, 10));
      // Day 0 is not a day. It marks a row that stands for a group rather than something that happened on a date (see
      // the level-shifting paste below), so it is carried through rather than nudged to the first of the month.
      if (day === 0) return `${mKey}-00`;
      return `${mKey}-${String(Math.min(day || 1, last)).padStart(2, '0')}`;
    }
    // Copies one entry (and its notes) into a target panel, under the given section and subsection.
    // Income and Expenses hold an amount as a plain size: the block it sits in is what says which way the money went,
    // which is why they refuse a negative one. A settlement or a pot holds it signed, because one section has to show
    // both directions at once. So a row moved between them keeps the direction of the money rather than the number:
    // £500 of expense becomes −£500 inside a settlement, and comes back out of one as £500 again.
    const amountAcross = (amount, from, to) => {
      if (from === to) return amount;
      if (to === 'net') return from === 'expense' ? -Math.abs(amount) : Math.abs(amount);
      return Math.abs(amount);
    };
    // Whether that move turns money in into money out, or the other way. It happens when a block cannot say what the
    // row used to mean — cash that came in, dropped into Expenses — and the ledger says so rather than quietly flipping.
    const flipsAcross = (amount, from, to) => {
      if (from === to || !Number(amount)) return false;
      const wasIn = from === 'net' ? Number(amount) > 0 : from === 'income';
      const isIn = to === 'net' ? amountAcross(amount, from, to) > 0 : to === 'income';
      return wasIn !== isIn;
    };
    // A subsection arriving from Income or Expenses has never had a role, and the section default ("Paid for the
    // group") is wrong for half of them: money coming back is not another thing you paid for. So it takes the role
    // that matches the way its money goes, and the settlement's figures read right the moment it lands.
    const roleArriving = (into, from) => {
      const kindKey = ExpenseStore.sectionKind(into);
      if (from === 'net') return ExpenseStore.SECTION_ROLES.fallback[kindKey];
      if (kindKey === 'savings') return from === 'income' ? 'return' : 'save';
      return from === 'income' ? 'settle' : 'cost';
    };
    // Counted while a paste runs, and reported once when it finishes: a row whose money changed direction is still
    // pasted, but the reader is told, because the figure stays the same size while meaning the opposite.
    let crossed = 0;
    const crossedNote = () => (crossed ? ` ${crossed} ${crossed === 1 ? 'row' : 'rows'} changed direction — check the sign.` : '');
    // A row carried into another block: its amount is converted, and a formula that no longer works out the amount it
    // is shown against is dropped, because a stale formula on a converted row would read as the truth.
    const carryRow = (row, type) => {
      // No block to land in means nothing to convert: a row keeps what it is rather than being left typeless, which
      // would drop it out of every bucket the month adds up.
      if (!type) return row;
      const from = row.type || type;
      if (from === type) return row;
      const amount = amountAcross(row.amount, from, type);
      if (flipsAcross(row.amount, from, type)) crossed += 1;
      row.type = type;
      // Only a settlement divides an amount or says what a repayment covered, so a row leaving one stops saying
      // either: both name subsections of the settlement it has just left.
      if (type !== 'net') { delete row.split; delete row.alloc; }
      if (amount !== row.amount) { row.amount = amount; delete row.formula; }
      return row;
    };
    function cloneEntry(item, mKey, property, section, category, type = item.type) {
      const scope = panelScope(mKey, property);
      const copy = carryRow({ ...item, id: newRowId(), property, date: dateIn(mKey, item.date), section, category, ...scope.fields }, type);
      if (!scope.isEvent) delete copy.eventId;
      // A flow follows one movement of money, so a copy is not part of it. What a repayment covered names the
      // subsections of the settlement it was written in, and a copy landing anywhere else would be naming things
      // that are not there — so it arrives saying nothing about what it covers, to be said again where it lands.
      delete copy.flow;
      if (section !== item.section || type !== 'net') delete copy.alloc;
      if (Array.isArray(item.tags)) copy.tags = [...item.tags];
      const notes = transactions.filter(note => note.parentId === item.id).map(note => carryRow({ ...note, id: newRowId(), parentId: copy.id, property, date: dateIn(mKey, note.date), category, ...(Array.isArray(note.tags) ? { tags: [...note.tags] } : {}), ...scope.fields }, type));
      notes.forEach(note => {
        if (!scope.isEvent) delete note.eventId;
        delete note.flow;
      });
      transactions.push(copy, ...notes);
      return 1;
    }
    // ---- pasting across levels ------------------------------------------------------------------
    // The ledger holds Section → Subsection → Entry → Note. Pasting onto a row of another level says "put it here", so
    // what is pasted is reshaped to fit rather than refused: a subsection dropped where entries live becomes one entry
    // holding what it held, and an entry dropped where subsections live becomes a subsection of the same.
    // A row that stands for a group has no day of its own, so it takes day 0 — which is also what tells it apart.
    const NO_DAY = date => `${String(date).slice(0, 7)}-00`;
    // A subsection becomes one entry, and everything it held becomes that entry's notes, in date order.
    // An entry that had notes of its own kept none of its own amount — noteTotal reads the notes instead — so it comes
    // across as a label worth nothing, with its notes beside it. That is what keeps the total the same: counting both
    // the entry and the notes under it would add the same money twice.
    function foldSubsectionIntoEntry(from, into, category, mKey, property) {
      const scope = panelScope(mKey, property);
      const rows = entriesOf(from.mKey, from.property, from.type, from.section, from.name);
      const date = scope.isEvent ? (rows[0]?.date || ledgerCtx.today()) : NO_DAY(`${mKey}-01`);
      const parent = carryRow({
        id: newRowId(), property, date, section: into.name, category,
        description: from.name, place: '', amount: 0, type: into.type, ...scope.fields
      }, into.type);
      const notes = [];
      const asNote = (row, amount) => {
        const note = carryRow({ ...row, id: newRowId(), parentId: parent.id, property, date: dateIn(mKey, row.date),
          section: into.name, category, amount, ...(Array.isArray(row.tags) ? { tags: [...row.tags] } : {}), ...scope.fields }, into.type);
        delete note.flow;
        delete note.split;
        delete note.alloc;
        if (!scope.isEvent) delete note.eventId;
        notes.push(note);
      };
      rows.forEach(row => {
        const kids = transactions.filter(item => item.parentId === row.id);
        // Worth nothing when its notes already carry the money; worth what it says when it has none.
        asNote(row, kids.length ? 0 : Number(row.amount));
        kids.forEach(kid => asNote(kid, Number(kid.amount)));
      });
      transactions.push(parent, ...notes);
      return { entries: 1, notes: notes.length };
    }
    // An entry becomes a subsection: its notes become the entries, each keeping its own date. An entry with no notes
    // becomes the one entry in it, so nothing arrives empty.
    function openEntryIntoSubsection(item, into, mKey, property) {
      const scope = panelScope(mKey, property);
      const name = ExpenseStore.safeKey(String(item.description || 'Pasted').trim().replace(/\s+/g, ' ')) || 'Pasted';
      if (!into.subsections.includes(name)) {
        into.subsections.push(name);
        if (into.type === 'net') (into.roles ||= {})[name] = roleArriving(into, item.type);
      }
      const kids = transactions.filter(row => row.parentId === item.id);
      const made = (kids.length ? kids : [item]).map(row => {
        const made = carryRow({ ...row, id: newRowId(), property, date: dateIn(mKey, row.date), section: into.name,
          category: name, amount: Number(row.amount), ...(Array.isArray(row.tags) ? { tags: [...row.tags] } : {}), ...scope.fields }, into.type);
        delete made.parentId;
        delete made.flow;
        if (!scope.isEvent) delete made.eventId;
        return made;
      });
      transactions.push(...made);
      return { name, entries: made.length };
    }
    // The entries of a section (by its name, or listed subsections for older rows without one) in a panel.
    const entriesOf = (mKey, property, type, section, category = null) => {
      const scope = panelScope(mKey, property);
      const own = scope.sections().find(item => item.type === type && item.name === section);
      return transactions.filter(item => !item.parentId && scope.match(item) && item.type === type
        && (category === null || item.category === category)
        && (item.section === section || (!item.section && own?.subsections.includes(item.category))));
    };
    function copySections(mKey, property, type, sectionName) {
      const list = panelScope(mKey, property).sections().filter(item => item.type === type && (!sectionName || item.name === sectionName));
      if (!list.length) return showToast('Nothing to copy here yet.');
      clipboard = { kind: 'sections', mKey, property, type, sections: JSON.parse(JSON.stringify(list)), label: sectionName || (type === 'income' ? 'Income' : 'Expenses') };
      clearPicks();
      showToast(`Copied “${clipboard.label}” (${list.reduce((sum, item) => sum + item.subsections.length, 0)} subsections). Right-click or double-tap where it should go, then Paste.`);
    }
    function copySubsection(mKey, property, type, section, name) {
      const home = panelScope(mKey, property).sections().find(item => item.type === type && item.name === section);
      const role = home?.type === 'net' ? ExpenseStore.subsectionRole(home, name) : null;
      const about = home?.subAbout?.[name] || '';
      clipboard = { kind: 'subsection', mKey, property, type, section, name, role, about, label: name };
      clearPicks();
      showToast(`Copied the subsection “${name}”. Paste it on a section in any month or event.`);
    }
    function copyEntry(id) {
      const item = transactions.find(row => row.id === id);
      if (!item) return;
      clipboard = { kind: 'entry', id, property: item.property, type: item.type, label: item.description };
      clearPicks();
      showToast(`Copied the entry “${item.description}”. Paste it on a subsection.`);
    }
    // ---- Cutting rows, one at a time or several together ---------------------------------------
    // Cut on a section, a subsection or an entry puts that row on the clipboard ready to move; cutting another one in
    // the same panel adds it to the same move. The list holds one kind of row, from one month and currency: entries
    // only ever move within a currency, and a list mixing a section with the entries inside it has no sensible meaning
    // when it lands somewhere else. Cutting a row of another kind, or in another panel, starts the list again rather
    // than silently dropping what was there.
    const picks = { kind: null, mKey: null, property: null, type: null, items: [] };
    const PICK_NAMES = { section: ['section', 'sections'], subsection: ['subsection', 'subsections'], entry: ['entry', 'entries'] };
    const pickKey = item => (item.kind === 'entry' ? `entry:${item.id}` : `${item.kind}:${item.type}|${item.section || ''}|${item.category || ''}`);
    const pickCount = () => picks.items.length;
    const pickLabel = (n = pickCount()) => `${n} ${PICK_NAMES[picks.kind][n === 1 ? 0 : 1]}`;
    // The pick a row stands for, or null where picking makes no sense (an event's read-only rows, Income / Expenses
    // as a whole, a block heading).
    function pickFor(target) {
      if (!['section', 'subsection', 'entry'].includes(target.kind)) return null;
      if (target.kind === 'entry') {
        const item = transactions.find(row => row.id === target.id);
        return item ? { kind: 'entry', id: target.id, type: item.type, label: item.description } : null;
      }
      if (!target.section) return null; // Income / Expenses as a whole is not a row to pick
      if (target.kind === 'section') return { kind: 'section', type: target.type, section: target.section, label: target.section };
      return { kind: 'subsection', type: target.type, section: target.section, category: target.category, label: target.category };
    }
    const isPicked = pick => pick && picks.items.some(item => pickKey(item) === pickKey(pick));
    function clearPicks() {
      Object.assign(picks, { kind: null, mKey: null, property: null, type: null, items: [] });
      markPicks();
    }
    // Adds or removes one row of the cut. A row of another kind, or from another panel, starts the list again. The
    // Cut that called this says how it went, so nothing is said here.
    function togglePick(target) {
      const pick = pickFor(target);
      if (!pick) return showToast('That row cannot be cut.');
      const fresh = picks.kind !== pick.kind || picks.mKey !== target.mKey || picks.property !== target.property;
      if (fresh) Object.assign(picks, { kind: pick.kind, mKey: target.mKey, property: target.property, type: pick.type, items: [] });
      const at = picks.items.findIndex(item => pickKey(item) === pickKey(pick));
      if (at >= 0) picks.items.splice(at, 1); else picks.items.push(pick);
      if (!picks.items.length) return clearPicks();
      markPicks();
    }
    // Marks the picked rows in the ledger. Called after every redraw, so a pick survives saving an entry.
    function markPicks() {
      document.querySelectorAll('#ledger .is-picked').forEach(el => el.classList.remove('is-picked'));
      if (!pickCount()) return;
      const panel = document.querySelector(`.month-block[data-month-key="${CSS.escape(picks.mKey)}"] .ledger-panel[data-property="${CSS.escape(picks.property)}"]`);
      if (!panel) return;
      picks.items.forEach(item => {
        const row = item.kind === 'entry'
          ? panel.querySelector(`[data-toggle-entry][data-entry-id="${CSS.escape(item.id)}"]`)?.closest('.ledger-entry-cell')
          : item.kind === 'subsection'
            ? [...panel.querySelectorAll(`.ledger-cat[data-section="${CSS.escape(item.section)}"]`)]
              .find(cat => catName(cat) === item.category)
            : panel.querySelector(`.ledger-type-section[data-section="${CSS.escape(item.section)}"]`);
        row?.classList.add('is-picked');
      });
    }
    // One Cut, one row: the row goes on the clipboard ready to move, and cutting another in the same panel adds it to
    // the same move rather than starting again. Cutting a row that is already cut takes it back out of the move.
    // Nothing leaves where it is until the move lands, so a cut that is never pasted costs nothing.
    function cutRow(target) {
      if (isViewer) return viewOnly();
      togglePick(target);
      if (!pickCount()) { clipboard = null; return showToast('Nothing is cut now.'); }
      clipboard = { kind: 'picks', mode: 'cut', itemKind: picks.kind, mKey: picks.mKey, property: picks.property,
        type: picks.type, items: picks.items.map(item => ({ ...item })), label: pickLabel() };
      showToast(`${pickLabel()} cut. Open the menu where ${pickCount() === 1 ? 'it' : 'they'} should go and choose Move.`);
    }
    // Drops a cut without moving anything: the rows stay exactly where they are.
    function cancelCut() {
      clipboard = null;
      clearPicks();
      showToast('Cut cancelled. Nothing moved.');
    }
    // Whether the clipboard can go to a target ({ kind: 'panel' | 'section' | 'subsection', mKey, property, type, ... }), and
    // whether it may bring its entries along there.
    function pasteFits(target) {
      if (!clipboard || isViewer) return null;
      const sameMoney = clipboard.property === target.property;
      const isEvent = target.mKey.startsWith('ev:');
      if (clipboard.kind === 'sections' && ['panel', 'section'].includes(target.kind)) {
        if (isEvent && clipboard.type === 'net') return null;
        return { entries: sameMoney };
      }
      // A subsection or an entry goes into any of the three blocks, not just the one it came from: Income, Expenses and
      // a settlement all hold the same rows, and what differs between them — the sign, and which way the money points —
      // is converted on the way in (see amountAcross). The currency still has to match: money that would have to be
      // converted on the way is not a paste.
      // Onto a subsection is "put it where entries live": the subsection is folded into one entry. Onto a section is
      // "put it where subsections live": an entry is opened out into one. Both carry rows, and rows never change
      // currency on the way, so both want the same money.
      if (clipboard.kind === 'subsection' && target.kind === 'subsection') return sameMoney ? { entries: true, fold: 'entry' } : null;
      if (clipboard.kind === 'subsection' && target.kind === 'section') return { entries: sameMoney };
      if (clipboard.kind === 'entry' && target.kind === 'section') return sameMoney ? { entries: true, fold: 'subsection' } : null;
      if (clipboard.kind === 'entry' && target.kind === 'subsection') return sameMoney ? { entries: true, only: true } : null;
      // A pick list lands where one of its kind would, and a cut never leaves its currency: the entries would have to
      // change money on the way, which is not a paste but a conversion.
      if (clipboard.kind === 'picks') {
        if (clipboard.mode === 'cut' && (!sameMoney || isEvent !== clipboard.mKey.startsWith('ev:'))) return null;
        if (clipboard.itemKind === 'entry') return target.kind === 'subsection' && sameMoney ? { entries: true, only: true } : null;
        if (clipboard.itemKind === 'subsection') return ['section', 'subsection'].includes(target.kind) ? { entries: sameMoney } : null;
        if (clipboard.itemKind === 'section') {
          if (!['panel', 'section'].includes(target.kind)) return null;
          if (isEvent && clipboard.type === 'net') return null;
          return { entries: sameMoney };
        }
      }
      return null;
    }
    // Moves one entry (and its notes) to another panel, section and subsection: the same rows, re-pointed, so their
    // ids, notes, tags and flow stay with them. Used by a cut; a copy clones instead (see cloneEntry).
    function moveEntry(item, mKey, property, section, category, type = item.type) {
      const scope = panelScope(mKey, property);
      Object.assign(item, { property, date: dateIn(mKey, item.date), section, category, ...scope.fields });
      carryRow(item, type);
      if (!scope.isEvent) delete item.eventId;
      transactions.filter(note => note.parentId === item.id).forEach(note => {
        Object.assign(note, { property, date: dateIn(mKey, note.date), category, ...scope.fields });
        carryRow(note, type);
        if (!scope.isEvent) delete note.eventId;
      });
      return 1;
    }
    // Pastes a pick list. A copy leaves the originals alone; a cut takes each one away only after it has landed, so a
    // paste that cannot be made never loses anything.
    function pastePicks(target, withEntries) {
      const { mKey, property } = target;
      const scope = panelScope(mKey, property);
      const own = scope.own();
      const from = panelScope(clipboard.mKey, clipboard.property);
      const cut = clipboard.mode === 'cut';
      // Where they land decides what they become: the block clicked, falling back to the one they came from.
      const intoType = target.type || clipboard.type;
      const sectionFor = name => own.find(item => item.type === intoType && item.name === name) || own.find(item => item.type === intoType);
      let added = 0;
      let moved = 0;
      if (clipboard.itemKind === 'entry') {
        const into = sectionFor(target.section);
        if (!into) return showToast('That has no section to put them in.');
        if (into.closed) return showToast(`“${into.name}” is closed. Reopen it first.`);
        clipboard.items.forEach(pick => {
          const item = transactions.find(row => row.id === pick.id);
          if (!item) return;
          moved += cut ? moveEntry(item, mKey, property, into.name, target.category, into.type) : cloneEntry(item, mKey, property, into.name, target.category, into.type);
        });
        if (moved) saveTransactions();
      } else if (clipboard.itemKind === 'subsection') {
        const into = sectionFor(target.section);
        if (!into) return showToast('That has no section to put them in.');
        if (into.closed) return showToast(`“${into.name}” is closed. Reopen it first.`);
        clipboard.items.forEach(pick => {
          const source = from.own().find(item => item.type === clipboard.type && item.name === pick.section);
          if (!into.subsections.includes(pick.category)) {
            into.subsections.push(pick.category);
            if (into.type === 'net') {
              (into.roles ||= {})[pick.category] = source?.type === 'net' ? ExpenseStore.subsectionRole(source, pick.category) : roleArriving(into, clipboard.type);
              const note = source?.subAbout?.[pick.category];
              if (note) (into.subAbout ||= {})[pick.category] = note;
            }
            added += 1;
          }
          const rows = entriesOf(clipboard.mKey, clipboard.property, clipboard.type, pick.section, pick.category);
          if (withEntries || cut) rows.forEach(item => { moved += cut ? moveEntry(item, mKey, property, into.name, pick.category, into.type) : cloneEntry(item, mKey, property, into.name, pick.category, into.type); });
          // A cut leaves nothing behind: the name goes from the section it came from, with what it stood for.
          if (cut && source && source !== into) {
            source.subsections = source.subsections.filter(name => name !== pick.category);
            delete source.roles?.[pick.category];
            delete source.subAbout?.[pick.category];
          }
        });
        if (added || cut) { scope.save(); if (cut) from.save(); }
        if (moved) saveTransactions();
      } else {
        clipboard.items.forEach(pick => {
          const source = from.own().find(item => item.type === clipboard.type && item.name === pick.section);
          if (!source) return;
          let into = own.find(item => item.type === source.type && item.name === source.name);
          if (!into) {
            const { closed, closedOn, mergedFrom, about, ...rest } = JSON.parse(JSON.stringify(source));
            into = { ...rest, subsections: [] };
            own.push(into);
            added += 1;
          }
          source.subsections.forEach(sub => {
            if (into.subsections.includes(sub)) return;
            into.subsections.push(sub);
            if (into.type === 'net') {
              (into.roles ||= {})[sub] = ExpenseStore.subsectionRole(source, sub);
              if (source.subAbout?.[sub]) (into.subAbout ||= {})[sub] = source.subAbout[sub];
            }
            added += 1;
          });
          const rows = entriesOf(clipboard.mKey, clipboard.property, source.type, source.name);
          if (withEntries || cut) rows.forEach(item => { moved += cut ? moveEntry(item, mKey, property, into.name, item.category) : cloneEntry(item, mKey, property, into.name, item.category); });
          if (cut && source !== into) from.own().splice(from.own().indexOf(source), 1);
        });
        if (added || cut) { scope.save(); if (cut) from.save(); }
        if (moved) saveTransactions();
      }
      if (cut) { clipboard = null; clearPicks(); }
      renderLedger();
      const what = [added && `${added} ${added === 1 ? 'name' : 'names'}`, moved && `${moved} ${moved === 1 ? 'entry' : 'entries'}`].filter(Boolean).join(' and ');
      showToast(what ? `${cut ? 'Moved' : 'Pasted'} ${what} into ${scopeName(mKey, property)}.${crossedNote()}` : 'Already there: nothing new to paste.');
    }
    function paste(target, withEntries) {
      if (target.closed) return showToast(`“${target.section || target.label}” is closed. Reopen it first.`);
      if (isViewer) return viewOnly();
      if (hasDraft()) return showToast('Save or cancel the current inline edit first.');
      crossed = 0;
      if (clipboard.kind === 'picks') return pastePicks(target, withEntries);
      const { mKey, property } = target;
      const scope = panelScope(mKey, property);
      const own = scope.own();
      let added = 0;
      let copied = 0;
      // The section a subsection or entry goes into: the one clicked, else the first of its type here.
      const sectionFor = (type, name) => own.find(item => item.type === type && item.name === name) || own.find(item => item.type === type);
      if (clipboard.kind === 'sections') {
        clipboard.sections.forEach(source => {
          // Income and Expenses go into the section of their kind already there (adding only what is missing); a custom
          // section matches by name.
          let into = own.find(item => item.type === source.type && item.name === source.name)
            || (source.type === 'net' ? null : own.find(item => item.type === source.type));
          if (!into) {
            // A copy arrives open, whatever the original's state: it is a fresh start here, not a finished settlement.
            const { closed, closedOn, mergedFrom, about, ...rest } = JSON.parse(JSON.stringify(source));
            into = { ...rest, subsections: [] };
            own.push(into);
            added += 1;
          }
          source.subsections.forEach(sub => {
            if (into.subsections.includes(sub)) return;
            into.subsections.push(sub);
            // A subsection keeps what it stood for in the section it came from.
            if (into.type === 'net') {
              (into.roles ||= {})[sub] = ExpenseStore.subsectionRole(source, sub);
              if (source.subAbout?.[sub]) (into.subAbout ||= {})[sub] = source.subAbout[sub];
            }
            added += 1;
          });
          if (withEntries) entriesOf(clipboard.mKey, clipboard.property, source.type, source.name).forEach(item => { copied += cloneEntry(item, mKey, property, into.name, item.category); });
        });
      } else if (clipboard.kind === 'subsection') {
        const into = sectionFor(target.type, target.section);
        if (!into) return showToast(`${scope.label} has no ${target.type === 'income' ? 'income' : target.type === 'net' ? 'settlement or savings' : 'expense'} section yet: add one first.`);
        if (into.closed) return showToast(`“${into.name}” is closed. Reopen it first.`);
        // Dropped on a subsection, so it becomes one entry there, carrying what it held as that entry's notes.
        if (target.kind === 'subsection' && target.category) {
          const made = foldSubsectionIntoEntry({ mKey: clipboard.mKey, property: clipboard.property, type: clipboard.type, section: clipboard.section, name: clipboard.name }, into, target.category, mKey, property);
          saveTransactions();
          revealKey = catKey(mKey, property, into.type, target.category);
          renderLedger();
          return showToast(`“${clipboard.name}” is now one entry in ${target.category}, with ${made.notes} ${made.notes === 1 ? 'note' : 'notes'}.${crossedNote()}`);
        }
        if (!into.subsections.includes(clipboard.name)) {
          into.subsections.push(clipboard.name);
          if (into.type === 'net') {
            (into.roles ||= {})[clipboard.name] = clipboard.role || roleArriving(into, clipboard.type);
            if (clipboard.about) (into.subAbout ||= {})[clipboard.name] = clipboard.about;
          }
          added += 1;
        }
        if (withEntries) entriesOf(clipboard.mKey, clipboard.property, clipboard.type, clipboard.section, clipboard.name).forEach(item => { copied += cloneEntry(item, mKey, property, into.name, clipboard.name, into.type); });
      } else if (clipboard.kind === 'entry') {
        const item = transactions.find(row => row.id === clipboard.id);
        const into = sectionFor(target.type, target.section);
        if (!item || !into) return showToast('Could not paste that entry here.');
        // Dropped on a section, so it becomes a subsection there and its notes become the entries in it.
        if (target.kind === 'section') {
          const made = openEntryIntoSubsection(item, into, mKey, property);
          scope.save();
          saveTransactions();
          revealKey = catKey(mKey, property, into.type, made.name);
          renderLedger();
          return showToast(`“${item.description}” is now the subsection “${made.name}”, with ${made.entries} ${made.entries === 1 ? 'entry' : 'entries'}.${crossedNote()}`);
        }
        copied += cloneEntry(item, mKey, property, into.name, target.category, into.type);
      }
      if (added) scope.save();
      if (copied) saveTransactions();
      renderLedger();
      const what = [added && `${added} ${added === 1 ? 'name' : 'names'}`, copied && `${copied} ${copied === 1 ? 'entry' : 'entries'}`].filter(Boolean).join(' and ');
      showToast(what ? `Pasted ${what} into ${scopeName(mKey, property)}.${crossedNote()}` : 'Already there: nothing new to paste.');
    }

    // ---- Row menu: a right-click (computer) or a double-tap (phone) on a month, a currency panel, a section, a subsection,
    // an entry or a note lists what can be done there. On a computer it opens at the pointer; on a phone it is a sheet at
    // the bottom of the screen (tap outside or swipe it down to close). Holding and double-clicking still work as before.
    const rowMenu = { el: null, open: false, actions: [], target: null };
    // What a ledger element stands for, or null.
    function menuTargetFor(element) {
      const el = element?.nodeType === Node.TEXT_NODE ? element.parentElement : element;
      if (!el || el.closest('form') || el.closest('.ledger-cat[data-event-id]')) return null;
      const block = el.closest('.month-block');
      if (!block || block.classList.contains('is-year')) return null;
      const mKey = block.dataset.monthKey;
      const panel = el.closest('.ledger-panel');
      const property = panel?.dataset.property;
      const note = el.closest('.ledger-sub-entry[data-note-id]');
      if (note) return { kind: 'note', mKey, property, id: note.dataset.noteId, row: note, label: note.querySelector('.ledger-entry-desc')?.textContent.trim() || 'Note' };
      const cell = el.closest('.ledger-entry-cell:not(.ledger-sub-entry)');
      const toggle = cell?.querySelector(':scope > .ledger-entry-line [data-toggle-entry]');
      if (toggle) return { kind: 'entry', mKey, property, id: toggle.dataset.entryId, row: cell, label: toggle.querySelector('.ledger-entry-desc')?.textContent.trim() || 'Entry' };
      const catSummary = el.closest('.ledger-cat > summary');
      const typeBlock = el.closest('.ledger-type-section');
      const blockType = ['income', 'net'].includes(typeBlock?.dataset.type) ? typeBlock.dataset.type : 'expense';
      if (catSummary) {
        const cat = catSummary.parentElement;
        return { kind: 'subsection', mKey, property, type: blockType, section: cat.dataset.section || null, kindOf: typeBlock?.dataset.kind || null, closed: typeBlock?.dataset.closed === 'true', category: catName(cat), row: catSummary, label: cat.querySelector('.ledger-cat-name')?.textContent.trim() || catName(cat) };
      }
      const typeSummary = el.closest('.ledger-type-section > summary');
      if (typeSummary && typeBlock.classList.contains('is-group')) return { kind: 'group', mKey, property, group: typeBlock.dataset.group, row: typeSummary, label: typeSummary.querySelector('strong')?.textContent.trim() || '' };
      if (typeSummary) return { kind: 'section', mKey, property, type: blockType, section: typeBlock.dataset.section || null, kindOf: typeBlock.dataset.kind || null, closed: typeBlock.dataset.closed === 'true', row: typeSummary, label: typeSummary.querySelector('strong')?.textContent.trim() || '' };
      if (el.closest('.ledger-panel-head') && panel) return { kind: 'panel', mKey, property, row: el.closest('.ledger-panel-head'), label: regions[property]?.code || property };
      if (el.closest('.month-ledger-head')) return { kind: 'month', mKey, row: el.closest('.month-ledger-head'), label: block.querySelector('.month-name')?.textContent.trim() || '' };
      return null;
    }
    // The actions for a target; `helpers` are the ledger's own (add a child as a hold does, toggle an entry's notes).
    function menuActions(target, helpers) {
      const { kind, mKey, property } = target;
      const isEvent = mKey.startsWith('ev:');
      const settings = () => (isEvent ? openYearSettings(store.events[mKey.slice(3)]?.year || currentMonth.getFullYear()) : openMonthSettings(...yearMonthOf(mKey)));
      const settingsLabel = isEvent ? 'Event settings…' : 'Month settings…';
      const edit = draft => () => {
        if (hasDraft()) return showToast('Save or cancel the current inline edit first.');
        editDraft = draft;
        renderLedger();
      };
      const add = () => helpers.triggerLongPress(target.row);
      const fits = pasteFits(target);
      const pasteAction = fits ? [clipboard.kind === 'picks'
        ? { icon: clipboard.mode === 'cut' ? 'cut' : 'clipboard', label: `${clipboard.mode === 'cut' ? 'Move' : 'Paste'} ${clipboard.label} here`, hint: `from ${scopeName(clipboard.mKey, clipboard.property)}`, paste: fits }
        : fits.fold === 'entry'
          ? { icon: 'arrow-bar-to-down', label: `Paste “${clipboard.label}” here as an entry`, hint: 'its entries and notes become this entry\u2019s notes', paste: fits }
          : fits.fold === 'subsection'
            ? { icon: 'arrow-bar-to-up', label: 'Paste entry here as a subsection', hint: 'its notes become the entries in it', paste: fits }
            : { icon: 'clipboard', label: `Paste ${clipboard.kind === 'entry' ? 'entry' : `“${clipboard.label}”`}`, hint: clipboard.kind === 'entry' ? 'a copy, with its notes' : `from ${scopeName(clipboard.mKey, clipboard.property)}`, paste: fits }] : [];
      const write = list => (isViewer ? list.filter(item => item.read) : list);
      // Cut this row: it is taken away from here and put down wherever it is next pasted. Cutting a second row in the
      // same panel adds it to the same move, so several go over together, but nothing has to be “picked” first — one
      // Cut is the whole gesture. Copy keeps its own line further down, so the two are never a pair of half-steps.
      const cutItems = () => {
        const pick = pickFor(target);
        if (!pick || isEvent) return [];
        const one = PICK_NAMES[pick.kind][0];
        const here = picks.kind === pick.kind && picks.mKey === mKey && picks.property === property;
        if (here && isPicked(pick)) return [
          { icon: 'cut', label: `Leave this ${one} out of the cut`, hint: `${pickLabel()} waiting to move`, run: () => cutRow(target) },
          { icon: 'square-x', label: `Cancel the cut (${pickLabel()})`, read: true, run: () => cancelCut() }
        ];
        return [{ icon: 'cut', label: `Cut this ${one}`,
          hint: here && pickCount() ? `moves with the ${pickLabel()} already cut` : 'it moves to wherever you paste it',
          run: () => cutRow(target) }];
      };
      // Every menu below reads in the same order, so a row's menu is learnt once rather than per kind:
      //   1. what this row is for      Edit, Add…
      //   2. how it counts             the share chips, settlement roles, savings setup, Close / Reopen
      //   3. what is attached to it    Description…, Tags…, a flow
      //   4. moving it about           Cut, Copy, Move / Paste — always the three together, in that order
      //   5. renaming it               Rename…
      //   6. taking it away            Delete, last, and the only red line
      // Anything about more than this row (open or close all, how the block posts, month settings) comes after all of
      // it, because it is a different subject: those act on the panel or the month, not on what was clicked.
      if (kind === 'month') {
        const panels = [...document.querySelectorAll(`.month-block[data-month-key="${CSS.escape(mKey)}"] .ledger-panel`)].map(panel => panel.dataset.property);
        const pastes = clipboard ? panels.map(cur => ({ cur, fits: pasteFits({ kind: 'panel', mKey, property: cur }) })).filter(item => item.fits)
          .map(({ cur, fits: fit }) => ({ icon: 'clipboard', label: `Paste “${clipboard.label}” into ${regions[cur]?.code || cur}`, hint: `from ${scopeName(clipboard.mKey, clipboard.property)}`, paste: fit, target: { kind: 'panel', mKey, property: cur } })) : [];
        return write([
          ...pastes,
          { icon: 'settings', label: settingsLabel, run: settings }
        ]);
      }
      if (kind === 'panel') {
        const startBlock = which => () => {
          if (hasDraft()) return showToast('Save or cancel the current inline edit first.');
          ledgerDraft = { month: mKey, property, newSection: which };
          renderLedger();
          showToast(which === 'savings' ? 'Name the savings pot.' : 'Name the settlement.');
        };
        return write([
          ...(isEvent ? [{ icon: 'plus', label: 'Add subsection', run: add }] : [
            { icon: 'arrows-exchange', label: 'Add settlement', hint: 'money shared with someone', run: startBlock('settlement') },
            { icon: 'pig-money', label: 'Add savings pot', hint: 'what you set aside', run: startBlock('savings') }
          ]),
          ...pasteAction,
          { icon: 'arrows-vertical', label: 'Open or close all subsections', read: true, run: () => target.row.querySelector('[data-panel-expand]')?.click() },
          { icon: 'settings', label: settingsLabel, run: settings }
        ]);
      }
      if (kind === 'group') {
        const one = target.group === 'savings' ? 'savings pot' : 'settlement';
        const closed = panelScope(mKey, property).sections().filter(item => item.type === 'net' && item.closed && ExpenseStore.sectionKind(item) === target.group);
        // The block has a calculation of its own, over the sections in it, so this opens the block's own setup rather
        // than one of its sections'. Each section is still set up from its own row; this is the figure the block itself
        // posts to the month, written in the same language.
        const inBlock = panelScope(mKey, property).sections().filter(item => item.type === 'net' && ExpenseStore.sectionKind(item) === target.group);
        const setupItems = isEvent ? [] : [
          { icon: 'adjustments-horizontal', label: 'Set up how it counts…',
            hint: inBlock.length ? `this block, over its ${inBlock.length} ${inBlock.length === 1 ? one : `${one}s`}` : 'this block',
            run: () => openBlockSetup(mKey, property, target.group) }
        ];
        return write([
          { icon: 'plus', label: `Add ${one}`, run: add },
          ...setupItems,
          ...(closed.length > 1 ? [{ icon: 'arrow-merge', label: `Merge settled (${closed.length})…`, hint: 'bring closed ones together', run: () => openMergeDialog(mKey, property, target.group) }] : []),
          { icon: 'pencil', label: 'Rename this block…', hint: 'here, in this month', run: edit({ kind: 'block', month: mKey, property, block: target.group }) },
          { icon: 'arrows-vertical', label: 'Open or close all subsections', read: true, run: () => target.row.closest('.ledger-panel')?.querySelector('[data-panel-expand]')?.click() },
          ...POSTING_MODES.filter(mode => mode !== postingMode).map(mode => ({
            icon: 'list-details', label: `Post to Income/Expenses as: ${POSTING_LABELS[mode].label}`,
            hint: POSTING_LABELS[mode].hint, read: true, run: () => setPostingMode(mode)
          })),
          { icon: 'settings', label: settingsLabel, run: settings }
        ]);
      }
      if (kind === 'section') {
        const custom = target.section && target.type === 'net';
        const one = target.kindOf === 'savings' ? 'pot' : 'settlement';
        const section = custom && !isEvent
          ? panelScope(mKey, property).sections().find(item => item.type === 'net' && item.name === target.section)
          : null;
        return write([
          { icon: 'plus', label: 'Add subsection', run: add },
          ...(section?.mergedSections?.length > 1
            ? [{ icon: 'arrow-merge', label: 'Unpack merged sections', hint: 'restore the original sections and entries', run: () => unpackSection(mKey, property, target.section) }]
            : []),
          ...(section?.mergedFrom?.length && !section.mergedSections?.length
            ? [{ icon: 'arrow-merge', label: 'Unpack older merge…', hint: 'assign subsections to the original sections', run: () => openLegacyUnpackDialog(mKey, property, target.section) }]
            : []),
          ...(custom ? [{ icon: 'adjustments-horizontal', label: 'Set up how it counts…',
            hint: target.kindOf === 'savings' ? 'this section and its subsections' : 'what it posts to Income and Expenses',
            run: () => openSectionSetup(mKey, property, target.section) }] : []),
          ...(custom && !isEvent ? [target.closed
            ? { icon: 'lock-open', label: `Reopen this ${one}`, hint: 'so it takes entries again', run: () => setSectionClosed(mKey, property, target.section, false) }
            : { icon: 'lock', label: `Close this ${one}`, hint: 'keeps its figures, takes no more entries', run: () => setSectionClosed(mKey, property, target.section, true) }] : []),
          ...[aboutAction(target)].filter(Boolean),
          ...cutItems(),
          { icon: 'copy', label: `Copy ${target.section ? 'section' : `all of ${target.label}`}`, hint: 'its name and subsections', run: () => copySections(mKey, property, target.type, target.section) },
          ...pasteAction,
          ...(custom && !isEvent ? [{ icon: 'pencil', label: 'Rename…', hint: 'here, in this month', run: edit({ kind: 'section', month: mKey, property, section: target.section }) }]
            : target.section ? [{ icon: 'pencil', label: 'Rename…', hint: settingsLabel.replace('…', ''), run: settings }] : []),
          ...(custom ? [{ icon: 'trash', label: 'Delete section', danger: true, run: () => deleteSection(target) }] : [])
        ]);
      }
      if (kind === 'subsection') {
        const roleItems = !target.kindOf || isEvent ? [] : (() => {
          const section = panelScope(mKey, property).sections().find(item => item.type === 'net' && item.name === target.section);
          if (!section) return [];
          const kindKey = ExpenseStore.sectionKind(section);
          const now = ExpenseStore.subsectionRole(section, target.category);
          return ExpenseStore.SECTION_ROLES.roles[kindKey].filter(role => role !== now).map(role => ({
            icon: 'tag', label: `Count it as: ${ExpenseStore.SECTION_ROLES.labels[role]}`,
            hint: ROLE_HINTS[role], run: () => setSubsectionRole(mKey, property, target.section, target.category, role)
          }));
        })();
        // The section a subsection belongs to, for the two actions that are really its parent's.
        const home = target.section || panelScope(mKey, property).sections().find(item => item.type === target.type && item.subsections.includes(target.category))?.name;
        // How a subsection counts is written in its section's calculation, so this opens that one dialog with this
        // subsection picked out in it, rather than inventing a second place to say the same thing.
        const setupItems = target.kindOf && home && !isEvent
          ? [{ icon: 'adjustments-horizontal', label: 'Set up how it counts…', hint: `in “${home}”`, run: () => openSectionSetup(mKey, property, home, target.category) }]
          : [];
        return write([
          { icon: 'plus', label: 'Add entry', run: add },
          ...roleItems,
          ...setupItems,
          ...[aboutAction(target)].filter(Boolean),
          ...cutItems(),
          { icon: 'copy', label: 'Copy subsection', run: () => copySubsection(mKey, property, target.type, home, target.category) },
          ...pasteAction,
          { icon: 'pencil', label: 'Rename', run: edit({ kind: 'category', month: mKey, property, type: target.type, category: target.category }) },
          { icon: 'trash', label: 'Delete subsection', hint: 'and its entries', danger: true, run: () => deleteRow({ deleteRow: 'category', month: mKey, property, type: target.type, section: target.section, category: target.category }) }
        ]);
      }
      if (kind === 'entry') {
        // Money laid out for a group is divided, so the entry itself says how much of it was mine. Only such an entry
        // is asked: a repayment, a savings pot or an ordinary expense has nothing to split. The choices sit together
        // on one row, each drawn as the share of a circle it stands for — the whole of it, a half, a third, a
        // quarter, none — so sharing reads as one setting rather than as five more commands mixed in with the rest.
        const splitItems = (() => {
          const row = transactions.find(item => item.id === target.id);
          if (!row || row.type !== 'net' || isEvent) return [];
          const section = panelScope(mKey, property).sections().find(item => item.type === 'net' && item.name === row.section);
          if (!section || ExpenseStore.sectionKind(section) !== 'settlement') return [];
          if (ExpenseStore.subsectionRole(section, row.category) !== ExpenseStore.SPLIT_ROLE) return [];
          const now = row.split || null;
          const same = split => now && now.m === split.m && (split.m !== 'equal' || Number(now.n) === split.n);
          const gave = Number(row.amount) < 0;
          const choices = [
            { split: { m: 'mine' }, share: 1, caption: 'All', label: 'All of it was mine', hint: 'nothing owed either way' },
            { split: { m: 'equal', n: 2 }, share: 1 / 2, caption: '½', label: 'Shared equally: 2 ways', hint: 'half of it was mine' },
            { split: { m: 'equal', n: 3 }, share: 1 / 3, caption: '⅓', label: 'Shared equally: 3 ways', hint: 'a third of it was mine' },
            { split: { m: 'equal', n: 4 }, share: 1 / 4, caption: '¼', label: 'Shared equally: 4 ways', hint: 'a quarter of it was mine' },
            { split: { m: 'none' }, share: 0, caption: 'None', label: gave ? 'I gave it all' : 'I got it all', hint: gave ? 'none of it was mine — the lot is owed back to me' : 'none of it was mine — I owe the lot back' }
          ];
          // What the entry already says is marked rather than hidden, so the row always shows where it stands; clicking
          // that one again takes it off, which is what the Clear chip beside them does too.
          return [
            { heading: 'How much of it was mine' },
            ...choices.map(choice => ({
              chip: true, share: choice.share, caption: choice.caption, label: choice.label, on: same(choice.split),
              hint: same(choice.split) ? 'set — click again to clear it' : choice.hint,
              run: () => setEntrySplit(target.id, same(choice.split) ? null : choice.split)
            })),
            ...(now ? [{ chip: true, icon: 'eraser', caption: 'Clear', label: 'Nothing recorded as mine', hint: 'leaves the whole amount outstanding', run: () => setEntrySplit(target.id, null) }] : [])
          ];
        })();
        // A repayment, or money arriving, can say what it was for — across as many of the settlement's subsections as
        // it really covered. It sits with the share chips because it answers the same sort of question: not what this
        // row is, but how it divides.
        const allocItems = (() => {
          const row = transactions.find(item => item.id === target.id);
          if (!row || isEvent || !allocatable(row)) return [];
          const list = ExpenseStore.normalizeAlloc(row.alloc);
          const covers = list.length === 1 ? `covers “${list[0].to}”` : list.length ? `covers ${list.length} things` : 'nothing said yet';
          return [{ icon: 'arrows-split-2', label: list.length ? 'What this covers…' : 'Say what this covers…',
            hint: covers, run: () => openAllocDialog(target.id) }];
        })();
        return write([
          { icon: 'pencil', label: 'Edit', run: edit({ kind: 'entry', id: target.id }) },
          ...splitItems,
          ...allocItems,
          { icon: 'corner-down-right', label: 'Add note', run: add },
          ...[aboutAction(target)].filter(Boolean),
          { icon: 'hash', label: 'Tags…', run: () => openTagPicker(target.row.querySelector('.ledger-entry-desc') || target.row) },
          flowAction(target),
          ...cutItems(),
          { icon: 'copy', label: 'Copy entry', hint: 'with its notes', run: () => copyEntry(target.id) },
          { icon: 'trash', label: 'Delete entry', hint: 'and its notes', danger: true, run: () => deleteRow({ deleteRow: 'entry', entryId: target.id }) }
        ]);
      }
      return write([
        { icon: 'pencil', label: 'Edit', run: edit({ kind: 'note', id: target.id }) },
        ...[aboutAction(target)].filter(Boolean),
        { icon: 'hash', label: 'Tags…', run: () => openTagPicker(target.row.querySelector('.ledger-entry-desc') || target.row) },
        flowAction(target),
        { icon: 'trash', label: 'Delete note', danger: true, run: () => deleteRow({ deleteRow: 'note', entryId: target.id }) }
      ]);
    }
    // "Description…" for any row the menu can be opened on. It says Add when there is none yet, and opens straight
    // into the editor then; an existing one opens read-only, behind its padlock.
    function aboutAction(target) {
      const scope = { entry: () => ({ kind: 'entry', id: target.id }), note: () => ({ kind: 'note', id: target.id }),
        section: () => (target.section ? { kind: 'section', mKey: target.mKey, property: target.property, type: target.type, section: target.section } : null),
        subsection: () => ({ kind: 'subsection', mKey: target.mKey, property: target.property, type: target.type, section: target.section, category: target.category })
      }[target.kind]?.();
      if (!scope || !aboutHome(scope)) return null;
      const has = Boolean(aboutHome(scope).read());
      return { icon: 'notes', label: has ? 'Description…' : 'Add description…', hint: has ? 'read it, or unlock to edit' : 'a longer note, kept off the row',
        read: has, run: () => openAboutPop(scope, target.row, !has) };
    }
    const ROLE_HINTS = {
      cost: 'real money out for the group, or back in',
      share: 'a note about the split — not a movement of money',
      settle: 'money between you and the other side',
      save: 'into the pot, or back out of it',
      return: 'what the pot earned — counted as income'
    };
    // Changes what one subsection of a settlement or a pot stands for. Nothing about the entries changes; what changes
    // is how they are read, so the figures and what is outstanding are worked out again from the same amounts.
    // What part of one settlement entry was mine. It lives on the entry, so the split stays with the money it divides
    // instead of being mirrored by hand into a second subsection that nothing keeps in step with it.
    function setEntrySplit(id, split) {
      if (isViewer) return viewOnly();
      const item = transactions.find(row => row.id === id);
      if (!item) return showToast('Could not find that entry. Refresh and try again.');
      if (split) item.split = split; else delete item.split;
      saveTransactions();
      renderLedger();
      showToast(split
        ? `“${item.description}”: ${ExpenseStore.splitLabel(split).toLowerCase()}.`
        : `“${item.description}”: nothing recorded as mine.`);
    }
    function setSubsectionRole(mKey, property, sectionName, category, role) {
      if (isViewer) return viewOnly();
      const scope = panelScope(mKey, property);
      const section = scope.own().find(item => item.type === 'net' && item.name === sectionName);
      if (!section) return showToast('That section is no longer set up here.');
      section.roles ||= {};
      section.roles[category] = role;
      scope.save();
      renderLedger();
      showToast(`“${category}” now counts as ${ExpenseStore.SECTION_ROLES.labels[role].toLowerCase()}.`);
    }
    // A custom section goes only when it is empty here (its entries would otherwise lose their place).
    function deleteSection(target) {
      const scope = panelScope(target.mKey, target.property);
      const own = scope.own();
      const index = own.findIndex(item => item.type === target.type && item.name === target.section);
      if (index < 0) return;
      if (entriesOf(target.mKey, target.property, target.type, target.section).length) return showToast('Move or delete its entries first.');
      if (!window.confirm(`Delete the section “${target.section}” from ${scope.label}?`)) return;
      own.splice(index, 1);
      scope.save();
      renderLedger();
      showToast(`Deleted “${target.section}”.`);
    }
    // An action is drawn as a full-width line unless it asks to be a chip: chips that sit next to each other in the
    // list become one row of small buttons, which is how a setting with a handful of values (how a cost was shared)
    // stays one thing to read instead of that many commands among everything else the menu offers.
    function drawRowMenu(list, title, subtitle) {
      const { el } = rowMenu;
      rowMenu.actions = list;
      el.querySelector('.row-menu-title').innerHTML = `<b>${escapeHtml(title)}</b>${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ''}`;
      const parts = [];
      list.forEach((item, index) => {
        const last = parts[parts.length - 1];
        if (item.chip && last?.chips) last.chips.push({ item, index });
        else parts.push(item.chip ? { chips: [{ item, index }] } : { item, index });
      });
      el.querySelector('.row-menu-list').innerHTML = parts.map(part => {
        if (part.chips) return `<div class="row-menu-chips" role="group">${part.chips.map(({ item, index }) => chipHtml(item, index)).join('')}</div>`;
        const { item, index } = part;
        if (item.heading) return `<p class="row-menu-head">${escapeHtml(item.heading)}</p>`;
        return `<button type="button" role="menuitem" class="row-menu-item${item.danger ? ' is-danger' : ''}" data-menu-index="${index}"><i class="ti ti-${item.icon}" aria-hidden="true"></i><span>${escapeHtml(item.label)}${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ''}</span></button>`;
      }).join('') || '<p class="row-menu-empty">Nothing to do here.</p>';
    }
    // One chip: an icon, or a circle filled to the share it stands for, over a short caption. The words are kept for
    // the tooltip and for a screen reader, so nothing is lost by the row being short.
    function chipHtml(item, index) {
      const mark = item.icon
        ? `<i class="ti ti-${item.icon}" aria-hidden="true"></i>`
        : `<span class="row-menu-pie${item.share ? '' : ' is-empty'}" style="--share:${item.share}" aria-hidden="true"></span>`;
      // A share is one of a set, so it is a radio; the Clear chip beside them is an ordinary command.
      const role = item.icon ? 'role="menuitem"' : `role="menuitemradio" aria-checked="${item.on ? 'true' : 'false'}"`;
      const tip = escapeHtml(`${item.label}${item.hint ? ` — ${item.hint}` : ''}`);
      return `<button type="button" ${role} class="row-menu-chip${item.on ? ' is-on' : ''}" data-menu-index="${index}" title="${tip}" aria-label="${escapeHtml(item.label)}">${mark}<small>${escapeHtml(item.caption)}</small></button>`;
    }
    const KIND_NAMES = { month: 'Month', panel: 'Currency', group: 'Block', section: 'Section', subsection: 'Subsection', entry: 'Entry', note: 'Note' };
    function openRowMenu(target, point, touch, helpers) {
      const { el } = rowMenu;
      rowMenu.target = target;
      rowMenu.helpers = helpers;
      el.classList.toggle('is-sheet', touch);
      el.style.left = el.style.top = '';
      const where = target.kind === 'month' ? '' : `${scopeName(target.mKey, target.property)}`;
      drawRowMenu(menuActions(target, helpers), `${KIND_NAMES[target.kind]} · ${target.label}`, where);
      el.hidden = false;
      rowMenu.open = true;
      document.querySelector('.row-menu-backdrop').hidden = !touch;
      target.row?.classList.add('is-menu-target');
      if (!touch) {
        // At the pointer, kept inside the window.
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        el.style.left = `${Math.max(8, Math.min(point.x, innerWidth - width - 8))}px`;
        el.style.top = `${Math.max(8, Math.min(point.y, innerHeight - height - 8))}px`;
      }
      requestAnimationFrame(() => el.classList.add('is-shown'));
      el.querySelector('.row-menu-item, .row-menu-chip')?.focus({ preventScroll: true });
    }
    function closeRowMenu() {
      if (!rowMenu.open) return;
      rowMenu.open = false;
      rowMenu.target?.row?.classList.remove('is-menu-target');
      rowMenu.el.classList.remove('is-shown');
      document.querySelector('.row-menu-backdrop').hidden = true;
      rowMenu.el.hidden = true;
    }
    function setupRowMenu() {
      const el = document.createElement('div');
      el.className = 'row-menu';
      el.setAttribute('role', 'menu');
      el.hidden = true;
      el.innerHTML = '<span class="row-menu-grip" aria-hidden="true"></span><p class="row-menu-title"></p><div class="row-menu-list"></div>';
      const backdrop = document.createElement('div');
      backdrop.className = 'row-menu-backdrop';
      backdrop.hidden = true;
      document.body.append(backdrop, el);
      rowMenu.el = el;
      el.addEventListener('click', event => {
        const item = event.target.closest('[data-menu-index]');
        if (!item) return;
        const action = rowMenu.actions[Number(item.dataset.menuIndex)];
        if (action.back) return drawRowMenu(menuActions(rowMenu.target, rowMenu.helpers), `${KIND_NAMES[rowMenu.target.kind]} · ${rowMenu.target.label}`, rowMenu.target.kind === 'month' ? '' : scopeName(rowMenu.target.mKey, rowMenu.target.property));
        // An action that asks something first draws its own page, with a way back to the menu it came from.
        if (action.submenu) {
          return drawRowMenu([...action.submenu.items, { icon: 'arrow-left', label: 'Back', back: true }], action.submenu.title, action.submenu.subtitle);
        }
        if (action.paste) {
          const target = action.target || rowMenu.target;
          // Entries can come along only where they fit (same currency, same kind); then ask which.
          if (action.paste.only || (clipboard.kind === 'picks' && clipboard.mode === 'cut')) { closeRowMenu(); return paste(target, true); }
          if (!action.paste.entries) { closeRowMenu(); return paste(target, false); }
          rowMenu.pasteTarget = target;
          return drawRowMenu([
            { icon: 'list', label: 'Names only', hint: 'no entries; no totals change', pasteMode: false },
            { icon: 'list-details', label: 'With entries', hint: 'copies the entries too; the target\'s totals grow', pasteMode: true },
            { icon: 'arrow-left', label: 'Back', back: true }
          ], `Paste “${clipboard.label}”`, `into ${scopeName(target.mKey, target.property)}`);
        }
        if (action.pasteMode !== undefined) {
          const target = rowMenu.pasteTarget;
          closeRowMenu();
          return paste(target, action.pasteMode);
        }
        closeRowMenu();
        action.run?.();
      });
      el.addEventListener('keydown', event => {
        const items = [...el.querySelectorAll('.row-menu-item, .row-menu-chip')];
        const at = items.indexOf(document.activeElement);
        if (event.key === 'Escape') { event.preventDefault(); closeRowMenu(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
        }
      });
      backdrop.addEventListener('click', closeRowMenu);
      document.addEventListener('pointerdown', event => {
        if (rowMenu.open && !el.contains(event.target) && !el.classList.contains('is-sheet')) closeRowMenu();
      }, true);
      // The ledger scrolling away under the menu closes it; the menu's own list scrolling does not. The list has a
      // max height and scrolls once there are enough items, and that scroll was closing the menu mid-reach.
      addEventListener('scroll', event => {
        if (rowMenu.open && !el.classList.contains('is-sheet') && !el.contains(event.target)) closeRowMenu();
      }, true);
      addEventListener('resize', closeRowMenu);
      // On a phone, the sheet follows a finger dragging it down, and closes past a short distance.
      let drag = null;
      el.addEventListener('touchstart', event => {
        if (!el.classList.contains('is-sheet') || el.querySelector('.row-menu-list').scrollTop > 0) return;
        drag = { y: event.touches[0].clientY, moved: 0 };
      }, { passive: true });
      el.addEventListener('touchmove', event => {
        if (!drag) return;
        drag.moved = Math.max(0, event.touches[0].clientY - drag.y);
        el.style.transform = `translateY(${drag.moved}px)`;
      }, { passive: true });
      el.addEventListener('touchend', () => {
        if (!drag) return;
        el.style.transform = '';
        if (drag.moved > 70) closeRowMenu();
        drag = null;
      });
    }

    // ---- Tag picker: a click on a row's day, a right-click or a two-finger tap on an entry or note row; tags are kept on
    // the row itself ----
    const tagPicker = { pop: null, id: null, row: null };
    // The entry or note a ledger element belongs to (not an open form).
    function taggableRow(element) {
      const cell = element?.closest?.('.ledger-entry-cell');
      if (!cell || element.closest('form')) return null;
      const id = cell.dataset.noteId || cell.querySelector(':scope > .ledger-entry-line [data-entry-id]')?.dataset.entryId;
      return id ? { id, cell } : null;
    }
    function drawTagPicker() {
      const { pop, id } = tagPicker;
      const item = transactions.find(row => row.id === id);
      if (!item) return closeTagPicker();
      const own = LedgerSearch.rowTags({ tags: item.tags });
      const written = LedgerSearch.hashtags(`${item.description} ${item.place || ''}`);
      // Tags in use anywhere (by gesture or in text), most used first, then this row's.
      const counts = new Map();
      transactions.forEach(row => LedgerSearch.rowTags(row, `${row.description} ${row.place || ''}`).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1)));
      const all = [...new Set([...own, ...written, ...[...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag)])];
      pop.querySelector('.tag-pop-title').textContent = item.description;
      pop.querySelector('.tag-pop-list').innerHTML = all.map(tag => {
        const fromText = written.includes(tag);
        const on = own.includes(tag);
        // A tag on the row shows × to take it off; others add with a click.
        return `<button type="button" class="hashtag-chip tag-c${LedgerSearch.tagColour(tag)}" data-pick-tag="${escapeHtml(tag)}" aria-pressed="${on || fromText}"${fromText ? ' disabled title="Written in the text; edit the text to remove it"' : ` title="${on ? 'Remove' : 'Add'} #${escapeHtml(tag)}"`}>#${escapeHtml(tag)}${on ? '<i class="ti ti-x" aria-hidden="true"></i>' : ''}</button>`;
      }).join('') || '<span class="config-muted">No tags yet. Type one below.</span>';
    }
    function placeTagPicker() {
      const { pop, row } = tagPicker;
      if (!row?.isConnected) return;
      const r = row.getBoundingClientRect();
      const below = innerHeight - r.bottom > pop.offsetHeight + 12 || r.top < pop.offsetHeight + 12;
      pop.style.top = `${below ? r.bottom + 4 : r.top - pop.offsetHeight - 4}px`;
      pop.style.left = `${Math.max(8, Math.min(r.left + 24, innerWidth - pop.offsetWidth - 8))}px`;
    }
    function openTagPicker(element) {
      const found = taggableRow(element);
      if (!found) return false;
      if (isViewer) { viewOnly(); return true; }
      Object.assign(tagPicker, { id: found.id, row: found.cell });
      tagPicker.pop.hidden = false;
      drawTagPicker();
      placeTagPicker();
      const input = tagPicker.pop.querySelector('input');
      input.value = '';
      input.focus();
      return true;
    }
    function closeTagPicker() {
      if (!tagPicker.pop || tagPicker.pop.hidden) return;
      tagPicker.pop.hidden = true;
      tagPicker.id = null;
      tagPicker.row = null;
    }
    // Adds or removes a tag on the row, saves, and redraws the ledger (its line) and the picker.
    function toggleRowTag(tag, on) {
      const item = transactions.find(row => row.id === tagPicker.id);
      const clean = String(tag).trim().replace(/^#+/, '').toLocaleLowerCase();
      if (!item || !LedgerSearch.hashtags(`#${clean}`).includes(clean)) return showToast('A tag is letters, digits, _ and -, like gold or trip-2026.');
      const tags = new Set(LedgerSearch.rowTags({ tags: item.tags }));
      if (on) tags.add(clean); else tags.delete(clean);
      if (tags.size) item.tags = [...tags]; else delete item.tags;
      saveTransactions();
      const id = item.id;
      renderLedger();
      // The row was drawn again: follow it.
      tagPicker.row = document.querySelector(`[data-note-id="${CSS.escape(id)}"]`) || document.querySelector(`[data-toggle-entry][data-entry-id="${CSS.escape(id)}"]`)?.closest('.ledger-entry-cell') || null;
      drawTagPicker();
      placeTagPicker();
    }
    function setupTagPicker() {
      const pop = document.createElement('div');
      pop.className = 'tag-pop';
      pop.hidden = true;
      pop.innerHTML = '<p class="tag-pop-title"></p><div class="tag-pop-list"></div><input type="text" name="new-tag" placeholder="New tag, then Enter" aria-label="New tag" autocomplete="off" spellcheck="false" enterkeyhint="done"><p class="tag-pop-hint">Click a tag to add it · × to remove · Esc to close</p>';
      document.body.append(pop);
      tagPicker.pop = pop;
      const input = pop.querySelector('input');
      pop.addEventListener('click', event => {
        const chip = event.target.closest('[data-pick-tag]');
        if (chip) toggleRowTag(chip.dataset.pickTag, chip.getAttribute('aria-pressed') !== 'true');
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && input.value.trim()) {
          event.preventDefault();
          toggleRowTag(input.value, true);
          input.value = '';
        } else if (event.key === 'Escape') {
          event.preventDefault();
          closeTagPicker();
        }
      });
      document.addEventListener('pointerdown', event => {
        if (!pop.hidden && !pop.contains(event.target) && !event.target.closest?.('.ledger-entry-line time')) closeTagPicker();
      }, true);
      // A click on a row's day (an entry or a note, once added) opens its tags, without opening or editing the row.
      document.querySelector('#ledger').addEventListener('click', event => {
        const day = event.target.closest('.ledger-entry-line time');
        if (!day || !taggableRow(day)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!pop.hidden && tagPicker.row === day.closest('.ledger-entry-cell')) return closeTagPicker();
        openTagPicker(day);
      }, true);
      addEventListener('scroll', () => { if (!pop.hidden) placeTagPicker(); }, true);
    }
    // ---- Descriptions ---------------------------------------------------------------------------
    // Any section, subsection, entry or note can carry a longer description. It is kept off the row itself — the row
    // shows only a dot — and opens beside it, read-only. Editing needs the padlock: the ledger is worked by holding and
    // double-clicking rows, and a description is the one thing there that is prose rather than a figure, so it is the
    // easiest thing to overwrite by accident. Locked by default means a stray gesture can never cost you one.
    //
    // A line of the description that reads "=paid" also sets the row's status; the word shows as a capsule, coloured by what it
    // means (see ExpenseStore.readStatus), on the row and in the popover.
    const aboutPop = { pop: null, scope: null, row: null, unlocked: false };
    // Where a description lives, by the scope the mark carries.
    function aboutHome(scope) {
      if (!scope) return null;
      if (scope.kind === 'entry' || scope.kind === 'note') {
        const item = transactions.find(row => row.id === scope.id);
        return item ? { label: item.description, read: () => item.about || '', write: text => { if (text) item.about = text; else delete item.about; saveTransactions(); } } : null;
      }
      const scoped = panelScope(scope.mKey, scope.property);
      const section = scoped.own().find(item => item.name === scope.section);
      if (!section) return null;
      if (scope.kind === 'section') {
        return { label: section.name, read: () => section.about || '', write: text => { if (text) section.about = text; else delete section.about; scoped.save(); } };
      }
      return {
        label: scope.category,
        read: () => section.subAbout?.[scope.category] || '',
        write: text => {
          if (text) (section.subAbout ||= {})[scope.category] = text;
          else if (section.subAbout) delete section.subAbout[scope.category];
          scoped.save();
        }
      };
    }
    const ABOUT_KINDS = { section: 'Section', subsection: 'Subsection', entry: 'Entry', note: 'Note' };
    function drawAboutPop() {
      const { pop, scope, unlocked } = aboutPop;
      const home = aboutHome(scope);
      if (!home) return closeAboutPop();
      const text = home.read();
      const status = ExpenseStore.readStatus(text);
      const body = ExpenseStore.statusless(text);
      pop.querySelector('.about-pop-kind').textContent = ABOUT_KINDS[scope.kind] || '';
      pop.querySelector('.about-pop-title').textContent = home.label || '';
      pop.querySelector('.about-pop-status').innerHTML = status
        ? `<small class="ledger-status is-${status.tone}" title="Set by the line “=${escapeHtml(status.word)}” in the description">${escapeHtml(status.word)}</small>` : '';
      const lock = pop.querySelector('[data-about-lock]');
      lock.setAttribute('aria-pressed', String(unlocked));
      lock.title = unlocked ? 'Lock it again, leaving it as it was' : 'Unlock to edit this description';
      lock.innerHTML = `<i class="ti ti-${unlocked ? 'lock-open' : 'lock'}" aria-hidden="true"></i><span>${unlocked ? 'Editing' : 'Locked'}</span>`;
      lock.hidden = isViewer;
      pop.querySelector('.about-pop-read').innerHTML = body
        ? LedgerSearch.markTags(escapeHtml(body)).replace(/\n/g, '<br>')
        : '<em class="about-pop-empty">No description yet.</em>';
      pop.querySelector('.about-pop-read').hidden = unlocked;
      const edit = pop.querySelector('.about-pop-edit');
      edit.hidden = !unlocked;
      if (unlocked) {
        const field = edit.querySelector('textarea');
        if (document.activeElement !== field) field.value = text;
      }
      pop.querySelector('.about-pop-hint').textContent = unlocked
        ? 'A line of its own reading “=paid” (or done, pending, due…) sets the status · Esc to cancel'
        : 'Read-only. Press the padlock to edit.';
    }
    function placeAboutPop() {
      const { pop, row } = aboutPop;
      if (!row?.isConnected) return;
      const r = row.getBoundingClientRect();
      const below = innerHeight - r.bottom > pop.offsetHeight + 12 || r.top < pop.offsetHeight + 12;
      pop.style.top = `${below ? r.bottom + 4 : r.top - pop.offsetHeight - 4}px`;
      pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    }
    // `startEditing` opens it straight into the editor: that is what "Add description" from the row menu does, since
    // there is nothing to read yet.
    function openAboutPop(scope, row, startEditing = false) {
      if (!aboutHome(scope)) return showToast('That row is no longer here. Refresh and try again.');
      if (startEditing && isViewer) return viewOnly();
      Object.assign(aboutPop, { scope, row: row || aboutPop.row, unlocked: Boolean(startEditing) && !isViewer });
      aboutPop.pop.hidden = false;
      drawAboutPop();
      placeAboutPop();
      if (aboutPop.unlocked) {
        const field = aboutPop.pop.querySelector('textarea');
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
    }
    function closeAboutPop() {
      if (!aboutPop.pop || aboutPop.pop.hidden) return;
      aboutPop.pop.hidden = true;
      Object.assign(aboutPop, { scope: null, row: null, unlocked: false });
    }
    function saveAboutPop() {
      const { pop, scope } = aboutPop;
      const home = aboutHome(scope);
      if (!home) return closeAboutPop();
      const text = pop.querySelector('textarea').value.trim();
      const had = home.read();
      home.write(text);
      aboutPop.unlocked = false;
      renderLedger();
      // The row was drawn again: find it so the popover stays put over it.
      aboutPop.row = aboutRowFor(scope);
      if (!aboutPop.row || !text) closeAboutPop();
      else { drawAboutPop(); placeAboutPop(); }
      showToast(text ? (had ? 'Description updated.' : 'Description added.') : 'Description removed.');
    }
    // The element a scope's popover sits over, after a redraw.
    function aboutRowFor(scope) {
      const mark = [...document.querySelectorAll('#ledger [data-about]')]
        .find(item => { try { return sameScope(JSON.parse(item.dataset.about), scope); } catch (error) { return false; } });
      return mark ? (mark.closest('.ledger-entry-cell, .ledger-cat, .ledger-type-section') || mark) : null;
    }
    const sameScope = (a, b) => a && b && a.kind === b.kind && (a.id ? a.id === b.id
      : a.mKey === b.mKey && a.property === b.property && a.section === b.section && a.category === b.category);
    function setupAboutPop() {
      const pop = document.createElement('div');
      pop.className = 'about-pop';
      pop.hidden = true;
      pop.innerHTML = `<div class="about-pop-head"><span class="about-pop-kind"></span><b class="about-pop-title"></b><span class="about-pop-status"></span>
          <button type="button" class="mini-btn about-pop-lock" data-about-lock aria-pressed="false"></button></div>
        <div class="about-pop-read"></div>
        <div class="about-pop-edit" hidden><textarea rows="4" aria-label="Description" placeholder="What this is about… then a line reading =paid to set a status" spellcheck="false"></textarea>
          <div class="about-pop-actions"><button type="button" class="quiet-button" data-about-cancel>Cancel</button><button type="button" class="primary-button" data-about-save>Save</button></div></div>
        <p class="about-pop-hint"></p>`;
      document.body.append(pop);
      aboutPop.pop = pop;
      pop.addEventListener('click', event => {
        if (event.target.closest('[data-about-lock]')) {
          if (isViewer) return viewOnly();
          aboutPop.unlocked = !aboutPop.unlocked;
          drawAboutPop();
          placeAboutPop();
          if (aboutPop.unlocked) pop.querySelector('textarea').focus();
          return;
        }
        if (event.target.closest('[data-about-save]')) return saveAboutPop();
        if (event.target.closest('[data-about-cancel]')) {
          aboutPop.unlocked = false;
          if (!aboutHome(aboutPop.scope)?.read()) return closeAboutPop();
          drawAboutPop();
          placeAboutPop();
        }
      });
      pop.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeAboutPop(); }
        // Ctrl/Cmd+Enter saves; plain Enter keeps writing, since a description is prose.
        else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); saveAboutPop(); }
      });
      document.addEventListener('pointerdown', event => {
        if (!pop.hidden && !pop.contains(event.target) && !event.target.closest?.('[data-about]')) closeAboutPop();
      }, true);
      // Esc closes it from anywhere: saving hands focus back to the ledger, so the popover rarely holds it.
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || pop.hidden) return;
        event.preventDefault();
        closeAboutPop();
      }, true);
      // The dot on a row opens its description, without opening, editing or toggling the row it sits in.
      document.querySelector('#ledger').addEventListener('click', event => {
        const mark = event.target.closest('[data-about]');
        if (!mark) return;
        event.preventDefault();
        event.stopPropagation();
        let scope;
        try { scope = JSON.parse(mark.dataset.about); } catch (error) { return; }
        const row = mark.closest('.ledger-entry-cell, .ledger-cat, .ledger-type-section') || mark;
        if (!pop.hidden && sameScope(aboutPop.scope, scope)) return closeAboutPop();
        openAboutPop(scope, row);
      }, true);
      addEventListener('scroll', () => { if (!pop.hidden) placeAboutPop(); }, true);
    }

    // ---- Flows: money that goes out and comes back, or comes in and goes back (a loan and its repayments, an advance and
    // its refund). Any entries and notes, in any month, year or special card, can be put in one flow; the flow adds them up
    // per currency, income in and expenses out (a custom section's amount by its sign), and shows what is still open:
    // less in than out is still to receive, more in than out is still to pay back. A note whose entry is in the same flow
    // is counted with its entry. Flows show on the ★ page, as a statement with a running balance. ----
    const todayKey = () => { const now = new Date(); return `${keyOf(now.getFullYear(), now.getMonth())}-${String(now.getDate()).padStart(2, '0')}`; };
    // Every flow with its rows (oldest first, each with its signed `value` and running balance per currency) and its
    // totals per currency: { out, in, balance }.
    function flowIndex() {
      const flows = store.flowList().map(flow => ({ ...flow, rows: [], sums: new Map() }));
      const byFlow = new Map(flows.map(flow => [flow.id, flow]));
      const byId = new Map(transactions.map(item => [item.id, item]));
      const members = transactions.filter(item => byFlow.has(item.flow) && !(item.parentId && byId.get(item.parentId)?.flow === item.flow));
      if (!members.length) return flows;
      const ids = new Set(members.map(item => item.id));
      searchRows(null).filter(row => ids.has(row.id)).forEach(row => {
        const flow = byFlow.get(byId.get(row.id).flow);
        const value = row.type === 'income' ? row.amount : row.type === 'net' ? row.amount : -row.amount;
        flow.rows.push({ ...row, value });
      });
      flows.forEach(flow => {
        flow.rows.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
        flow.rows.forEach(row => {
          const sum = flow.sums.get(row.property) || { out: 0, in: 0, balance: 0 };
          if (row.value < 0) sum.out -= row.value; else sum.in += row.value;
          sum.balance += row.value;
          row.running = sum.balance;
          flow.sums.set(row.property, sum);
        });
        flow.sums = new Map([...flow.sums].sort(([a], [b]) => store.currencyKeys().indexOf(a) - store.currencyKeys().indexOf(b)));
      });
      return flows;
    }
    // What is still open in one currency, in words.
    function flowStatus(balance, property, compact = false) {
      const money = compact ? compactMoney : formatMoney;
      if (!balance) return { text: 'Settled', tone: 'is-settled' };
      return balance < 0 ? { text: `${money(-balance, property)} to receive`, tone: 'is-receive' } : { text: `${money(balance, property)} to pay back`, tone: 'is-pay' };
    }
    // The row menu's flow item: which flow the row is in, or an offer to put it in one.
    function flowAction(target) {
      const flow = store.flow(transactions.find(item => item.id === target.id)?.flow);
      return { icon: 'arrows-exchange', label: flow ? `Flow: ${flow.name}…` : 'Add to a flow…', hint: flow ? 'change or remove' : 'a loan and its repayments, a refund…', run: () => openFlowPicker({ mode: 'assign', id: target.id }, target.row) };
    }

    // The flow picker: puts a row in a flow (an existing one, or a new one named and coloured here) or takes it out; in
    // 'edit' mode it renames, recolours or deletes a flow.
    const flowPop = { el: null, state: null, anchor: null, colour: 0 };
    const FLOW_COLOURS = 8;
    function drawFlowPicker() {
      const { el, state } = flowPop;
      const flows = flowIndex();
      const editing = state.mode === 'edit' ? flows.find(flow => flow.id === state.flowId) : null;
      const item = state.mode === 'assign' ? transactions.find(row => row.id === state.id) : null;
      if (state.mode === 'assign' && !item) return closeFlowPicker();
      if (state.mode === 'edit' && !editing) return closeFlowPicker();
      const statusOf = flow => [...flow.sums].map(([property, sum]) => flowStatus(sum.balance, property, true).text).join(' · ') || 'No entries yet';
      const swatches = `<div class="flow-swatches" role="radiogroup" aria-label="Colour">${Array.from({ length: FLOW_COLOURS }, (_, n) => `<button type="button" class="flow-swatch tag-c${n}" data-flow-colour="${n}" role="radio" aria-checked="${flowPop.colour === n}" aria-label="Colour ${n + 1}"></button>`).join('')}</div>`;
      if (editing) {
        el.innerHTML = `<p class="flow-pop-title"><b>Edit flow</b><small>${escapeHtml(statusOf(editing))}</small></p>
          <form class="flow-pop-new" data-flow-form="edit" novalidate><input name="name" value="${escapeHtml(editing.name)}" maxlength="60" aria-label="Flow name" autocomplete="off" spellcheck="false">${swatches}
          <p class="flow-pop-hint" aria-live="polite"></p>
          <div class="flow-pop-actions"><button type="button" class="quiet-button is-danger" data-flow-delete><i class="ti ti-trash" aria-hidden="true"></i> Delete flow</button><button type="submit" class="primary-button">Save</button></div></form>`;
        return;
      }
      const current = item.flow;
      el.innerHTML = `<p class="flow-pop-title"><b>Flow</b><small>${escapeHtml(item.description)}</small></p>
        <div class="flow-pop-list">${flows.map(flow => `<button type="button" class="flow-choice tag-c${flow.colour}" data-pick-flow="${escapeHtml(flow.id)}" aria-pressed="${flow.id === current}"><span class="flow-dot" aria-hidden="true"></span><span class="flow-choice-name">${escapeHtml(flow.name)}</span><small>${escapeHtml(statusOf(flow))}</small>${flow.id === current ? '<i class="ti ti-check" aria-hidden="true"></i>' : ''}</button>`).join('') || '<p class="flow-pop-empty">No flows yet: name one below.</p>'}</div>
        <form class="flow-pop-new" data-flow-form="new" novalidate><input name="name" maxlength="60" placeholder="New flow, e.g. Loan to Ravi" aria-label="New flow name" autocomplete="off" spellcheck="false" enterkeyhint="done">${swatches}
        <p class="flow-pop-hint" aria-live="polite"></p><div class="flow-pop-actions">${current ? '<button type="button" class="quiet-button" data-flow-remove>Take out of the flow</button>' : ''}<button type="submit" class="primary-button"><i class="ti ti-plus" aria-hidden="true"></i> Create and add</button></div></form>`;
      // Names already in use (sections and subsections of every kind) as suggestions.
      const input = el.querySelector('[data-flow-form="new"] input');
      suggest.attach(input, {
        items: () => {
          const seen = new Set();
          return [...sectionChoices([]), ...['expense', 'income', 'net'].flatMap(type => subsectionChoices(type, []))].filter(choice => !seen.has(nameKey(choice.name)) && seen.add(nameKey(choice.name)));
        },
        onPick: choice => { input.value = choice.name; input.focus(); }
      });
    }
    function placeFlowPicker() {
      const { el, anchor } = flowPop;
      if (!anchor?.isConnected) return;
      const r = anchor.getBoundingClientRect();
      const below = innerHeight - r.bottom > el.offsetHeight + 12 || r.top < el.offsetHeight + 12;
      el.style.top = `${Math.max(8, below ? r.bottom + 4 : r.top - el.offsetHeight - 4)}px`;
      el.style.left = `${Math.max(8, Math.min(r.left + 24, innerWidth - el.offsetWidth - 8))}px`;
    }
    function openFlowPicker(state, anchor) {
      if (isViewer) return viewOnly();
      const flows = store.flowList();
      const own = state.mode === 'edit' ? flows.find(flow => flow.id === state.flowId) : null;
      // A new flow takes the first colour no flow has yet.
      const used = new Set(flows.map(flow => flow.colour));
      flowPop.colour = own ? own.colour : Array.from({ length: FLOW_COLOURS }, (_, n) => n).find(n => !used.has(n)) ?? flows.length % FLOW_COLOURS;
      Object.assign(flowPop, { state, anchor });
      flowPop.el.hidden = false;
      drawFlowPicker();
      placeFlowPicker();
      if (!isPhone()) flowPop.el.querySelector('input')?.focus();
    }
    function closeFlowPicker() {
      if (!flowPop.el || flowPop.el.hidden) return;
      flowPop.el.hidden = true;
      flowPop.state = null;
      flowPop.anchor = null;
      suggest.close();
    }
    function setRowFlow(id, flowId) {
      const item = transactions.find(row => row.id === id);
      if (!item) return;
      if (flowId) item.flow = flowId; else delete item.flow;
      saveTransactions();
      closeFlowPicker();
      renderLedger();
      const flow = flowId && flowIndex().find(entry => entry.id === flowId);
      showToast(flow ? `“${item.description}” is in the flow “${flow.name}”: ${[...flow.sums].map(([property, sum]) => flowStatus(sum.balance, property).text).join(' · ') || 'nothing open'}.` : `“${item.description}” is out of its flow.`);
    }
    function saveFlowForm(form) {
      const input = form.elements.name;
      const hint = form.querySelector('.flow-pop-hint');
      const name = input.value.trim().replace(/\s+/g, ' ');
      const { state } = flowPop;
      const fail = text => {
        hint.textContent = text;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      };
      if (!name) return fail('Give the flow a name.');
      const twin = store.flowList().find(flow => nameKey(flow.name) === nameKey(name) && flow.id !== state.flowId);
      if (twin) return fail(`“${twin.name}” already exists${state.mode === 'assign' ? ': pick it above' : ''}.`);
      if (state.mode === 'edit') {
        trackSave(store.saveFlow(state.flowId, { name, colour: flowPop.colour }));
        closeFlowPicker();
        renderLedger();
        return showToast(`Flow saved as “${name}”.`);
      }
      const year = store.year(currentMonth.getFullYear()) ? currentMonth.getFullYear() : Number(store.yearIds().pop());
      const id = `fl${Date.now().toString(36)}`;
      trackSave(store.saveFlow(id, { name, colour: flowPop.colour, created: todayKey() }, year));
      setRowFlow(state.id, id);
    }
    async function deleteFlow(flowId) {
      const flow = flowIndex().find(entry => entry.id === flowId);
      if (!flow) return;
      if (!window.confirm(`Delete the flow “${flow.name}”? Its ${flow.rows.length} ${flow.rows.length === 1 ? 'entry stays' : 'entries stay'} as ${flow.rows.length === 1 ? 'it is' : 'they are'}, only out of the flow.`)) return;
      closeFlowPicker();
      // Every year is loaded first, so no entry anywhere keeps the deleted flow.
      try { await Promise.all(store.yearIds().map(year => store.ensureYear(Number(year)))); } catch (error) { return showToast('Could not load every month; the flow was not deleted.'); }
      trackSave(store.deleteFlow(flowId));
      renderLedger();
      showToast(`Deleted the flow “${flow.name}”.`);
    }
    function setupFlowPicker() {
      const el = document.createElement('div');
      el.className = 'flow-pop';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Flow');
      el.hidden = true;
      document.body.append(el);
      flowPop.el = el;
      el.addEventListener('click', event => {
        const colour = event.target.closest('[data-flow-colour]');
        if (colour) {
          flowPop.colour = Number(colour.dataset.flowColour);
          return el.querySelectorAll('[data-flow-colour]').forEach(button => button.setAttribute('aria-checked', String(button === colour)));
        }
        const pick = event.target.closest('[data-pick-flow]');
        if (pick) return setRowFlow(flowPop.state.id, pick.getAttribute('aria-pressed') === 'true' ? null : pick.dataset.pickFlow);
        if (event.target.closest('[data-flow-remove]')) return setRowFlow(flowPop.state.id, null);
        if (event.target.closest('[data-flow-delete]')) return deleteFlow(flowPop.state.flowId);
      });
      el.addEventListener('submit', event => {
        event.preventDefault();
        saveFlowForm(event.target);
      });
      el.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeFlowPicker();
        }
      });
      document.addEventListener('pointerdown', event => {
        if (!el.hidden && !el.contains(event.target) && !event.target.closest?.('.suggest-box, [data-flow-edit]')) closeFlowPicker();
      }, true);
      addEventListener('scroll', () => { if (!el.hidden) placeFlowPicker(); }, true);
      // A row's flow mark opens its flow on the ★ page (and does not open or close the row).
      document.querySelector('#ledger').addEventListener('click', event => {
        const mark = event.target.closest('[data-flow-mark]');
        if (!mark) return;
        event.preventDefault();
        event.stopPropagation();
        goToFlow(mark.dataset.flowMark);
      }, true);
    }

    // ---- Special cards and hashtags, on one page (the ★ tab). A legend on the left lists every special card, by year,
    // and every hashtag; the right side holds the cards, grouped by year, then the hashtags. Each group, each card and each
    // tag folds open or closed. The cards are the special events' own ledgers, drawn and edited exactly as before.
    const HUB_FOLDS_KEY = `${STORAGE_KEY}-hub-folds`;
    const hubFolds = (() => {
      try { return JSON.parse(localStorage.getItem(HUB_FOLDS_KEY) || '{}') || {}; } catch (error) { return {}; }
    })();
    const hubOpenTags = new Set(JSON.parse(sessionStorage.getItem(`${STORAGE_KEY}-hub-tags`) || '[]'));
    const hubOpenFlows = new Set(JSON.parse(sessionStorage.getItem(`${STORAGE_KEY}-hub-flows`) || '[]'));
    const saveHubFlows = () => sessionStorage.setItem(`${STORAGE_KEY}-hub-flows`, JSON.stringify([...hubOpenFlows]));
    let hubFilter = '';
    let hubLoading = false;
    // A group is open unless folded; the legend's groups start folded on a phone, where they sit above the cards.
    const hubOpen = key => hubFolds[key] ?? !(key.startsWith('legend:') && isPhone());
    function setHubFold(key, open) {
      if (hubOpen(key) === open) return;
      hubFolds[key] = open;
      try { localStorage.setItem(HUB_FOLDS_KEY, JSON.stringify(hubFolds)); } catch (error) { /* Not remembered; still applies now. */ }
    }
    const saveHubTags = () => sessionStorage.setItem(`${STORAGE_KEY}-hub-tags`, JSON.stringify([...hubOpenTags]));
    const hubMoney = (minor, property) => `${minor < 0 ? '−' : ''}${formatMoney(Math.abs(minor), property)}`;
    const hubSums = rows => hashtagSums(rows).map(([property, sum]) => `<span class="hashtag-sum"><b>${escapeHtml(regions[property]?.code || property)}</b><span class="income">${hubMoney(sum.in, property)}</span><span class="expense">${hubMoney(sum.out, property)}</span><span class="balance">${hubMoney(sum.in - sum.out, property)}</span></span>`).join('');
    const hubFold = (key, cls, head, body) => `<details class="${cls}" data-hub-fold="${key}"${hubOpen(key) ? ' open' : ''}><summary>${head}</summary>${body}</details>`;
    const chevron = '<i class="ti ti-chevron-right hub-caret" aria-hidden="true"></i>';
    // A tag's heading: its name, how many entries over which months, and its sums per currency.
    function hubTagHead(entry) {
      const dates = entry.rows.map(row => row.date).sort();
      const span = dates.length ? [dates[0], dates[dates.length - 1]].map(date => monthLabel(new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1))) : [];
      const when = span.length ? ` · ${span[0] === span[1] ? span[0] : `${span[0]} – ${span[1]}`}` : '';
      return `${chevron}<b>#${escapeHtml(entry.tag)}</b><small>${entry.rows.length} ${entry.rows.length === 1 ? 'entry' : 'entries'}${when}</small><span class="hashtag-sums">${hubSums(entry.rows)}</span>`;
    }
    // A tag's entries: newest place first; within it, newest entry first. A row opens where it lives.
    function hubTagBody(entry) {
      const rows = [...entry.rows].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
      const jumpAttr = jump => `data-search-jump='${escapeHtml(JSON.stringify(jump))}'`;
      return [...new Set(rows.map(row => row.where))].map(place => {
        const own = rows.filter(row => row.where === place);
        return `<section class="search-group"><h3 class="search-group-head"><span>${escapeHtml(place)}</span><small>${own.length}</small><span class="search-sums">${hubSums(own)}</span></h3>${own.map(row =>
          `<button type="button" class="search-row${row.kind === 'note' ? ' is-note' : ''}" ${jumpAttr(row.jump)}><span class="search-when">${escapeHtml(dayLabel(row.date))}</span><span class="search-main"><span class="search-desc">${row.kind === 'note' ? '<i class="ti ti-corner-down-right" aria-hidden="true"></i>' : ''}${LedgerSearch.markTags(escapeHtml(row.description))}${row.comment ? `<span class="search-comment">${LedgerSearch.markTags(escapeHtml(row.comment))}</span>` : ''}</span><span class="search-crumbs">${LedgerSearch.markTags(escapeHtml(row.crumbs))}${row.kind === 'note' && row.parent ? ` · in ${escapeHtml(row.parent)}` : ''}</span></span><strong class="search-amount ${row.type === 'net' ? (row.amount < 0 ? 'expense' : 'income') : row.type}">${hubMoney(row.type === 'net' ? Math.abs(row.amount) : row.amount, row.property)}<small>${escapeHtml(regions[row.property]?.code || '')}</small></strong></button>`).join('')}</section>`;
      }).join('');
    }
    // A flow on the ★ page: its name and what is open per currency; opened, its statement oldest first: day, entry (and
    // where it is), out, in and the balance after it, then the totals. A row opens where it lives.
    function hubFlowBlock(flow) {
      const open = hubOpenFlows.has(flow.id);
      const dates = flow.rows.map(row => row.date);
      const span = dates.length ? [dates[0], dates[dates.length - 1]].map(date => monthLabel(new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1))) : [];
      const when = span.length ? ` · ${span[0] === span[1] ? span[0] : `${span[0]} – ${span[1]}`}` : '';
      const status = [...flow.sums].map(([property, sum]) => {
        const state = flowStatus(sum.balance, property);
        return `<span class="flow-status ${state.tone}"><b>${escapeHtml(regions[property]?.code || property)}</b><span class="expense" title="Out">${formatMoney(sum.out, property)}</span><span class="income" title="In">${formatMoney(sum.in, property)}</span><em>${state.tone === 'is-settled' ? '<i class="ti ti-circle-check" aria-hidden="true"></i>' : ''}${escapeHtml(state.text)}</em></span>`;
      }).join('') || '<span class="flow-status is-empty"><em>No entries yet: right-click an entry, then Add to a flow</em></span>';
      const jumpAttr = jump => `data-search-jump='${escapeHtml(JSON.stringify(jump))}'`;
      const sheet = [...flow.sums.keys()].map(property => {
        const own = flow.rows.filter(row => row.property === property);
        const sum = flow.sums.get(property);
        const code = escapeHtml(regions[property]?.code || property);
        return `<div class="flow-sheet" role="table" aria-label="${escapeHtml(flow.name)} in ${code}">
          <div class="flow-sheet-row is-head" role="row"><span role="columnheader">Day</span><span role="columnheader">Entry · ${code}</span><span role="columnheader">Out</span><span role="columnheader">In</span><span role="columnheader">Balance</span></div>
          ${own.map(row => `<button type="button" class="flow-sheet-row" role="row" ${jumpAttr(row.jump)} title="Open it in ${escapeHtml(row.where)}"><span class="flow-day">${escapeHtml(dayLabel(row.date))} <small>${row.date.slice(0, 4)}</small></span><span class="flow-entry"><span>${row.kind === 'note' ? '<i class="ti ti-corner-down-right" aria-hidden="true"></i>' : ''}${LedgerSearch.markTags(escapeHtml(row.description))}</span><small>${escapeHtml(row.where)} · ${LedgerSearch.markTags(escapeHtml(row.crumbs))}</small></span><span class="expense">${row.value < 0 ? formatMoney(-row.value, property) : ''}</span><span class="income">${row.value > 0 ? formatMoney(row.value, property) : ''}</span><span class="flow-running">${hubMoney(row.running, property)}</span></button>`).join('')}
          <div class="flow-sheet-row is-total" role="row"><span></span><span>${escapeHtml(flowStatus(sum.balance, property).text)}</span><span class="expense">${formatMoney(sum.out, property)}</span><span class="income">${formatMoney(sum.in, property)}</span><span class="flow-running">${hubMoney(sum.balance, property)}</span></div>
        </div>`;
      }).join('');
      const edit = isViewer ? '' : `<div class="flow-tools"><button type="button" class="quiet-button flow-edit" data-flow-edit="${escapeHtml(flow.id)}" aria-label="Edit the flow ${escapeHtml(flow.name)}" title="Rename, recolour or delete"><i class="ti ti-pencil" aria-hidden="true"></i> Edit flow</button></div>`;
      return `<details class="hub-flow tag-c${flow.colour}" data-hub-flow="${escapeHtml(flow.id)}"${open ? ' open' : ''}><summary>${chevron}<i class="ti ti-arrows-exchange flow-icon" aria-hidden="true"></i><b>${escapeHtml(flow.name)}</b><small>${flow.rows.length} ${flow.rows.length === 1 ? 'entry' : 'entries'}${when}</small><span class="flow-statuses">${status}</span></summary><div class="hub-flow-body">${edit}${sheet}</div></details>`;
    }
    function renderHub() {
      const events = store.eventList();
      const years = [...new Set(events.map(event => event.year))].sort((a, b) => b - a);
      const tags = hashtagIndex();
      const flows = flowIndex();
      const state = renderState();
      const entriesIn = id => store.eventItems(id).filter(item => !item.parentId).length;
      const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;
      // Legend: the cards by year (☆ marks one that also counts in its months), then the tags, each with its count.
      const cardLinks = years.map(year => `<p class="hub-legend-year">${year}</p>${events.filter(event => event.year === year).map(event =>
        `<button type="button" class="hub-link${expandedMonths.has(`ev:${event.id}`) ? ' is-open' : ''}" data-hub-card="${escapeHtml(event.id)}" title="Go to ${escapeHtml(event.name)}"><i class="ti ti-star-filled hub-link-icon" aria-hidden="true"></i><span>${escapeHtml(event.name)}</span>${event.include ? '<i class="ti ti-calendar-share hub-link-mark" title="Also counts in its months" aria-label="Also counts in its months"></i>' : ''}<small>${entriesIn(event.id)}</small></button>`).join('')}`).join('');
      const tagLinks = tags.map(entry => `<button type="button" class="hub-link tag-c${LedgerSearch.tagColour(entry.tag)}" data-hub-tag-link="${escapeHtml(entry.tag)}" title="Go to #${escapeHtml(entry.tag)}"><i class="ti ti-hash hub-link-icon" aria-hidden="true"></i><span>${escapeHtml(entry.tag)}</span><small>${entry.rows.length}</small></button>`).join('');
      // Flows: each in its colour, with what is still open in its first currency.
      const flowLinks = flows.map(flow => {
        const [property, sum] = [...flow.sums][0] || [];
        const state = property ? flowStatus(sum.balance, property, true) : { text: 'empty', tone: 'is-empty' };
        return `<button type="button" class="hub-link tag-c${flow.colour}" data-hub-flow-link="${escapeHtml(flow.id)}" title="Go to the flow ${escapeHtml(flow.name)}"><i class="ti ti-arrows-exchange hub-link-icon" aria-hidden="true"></i><span>${escapeHtml(flow.name)}</span><small class="flow-link-state ${state.tone}">${escapeHtml(state.text)}</small></button>`;
      }).join('');
      const loading = hubLoading ? '<i class="ti ti-loader-2 search-spin hub-loading" aria-label="Loading every month"></i>' : '';
      const legend = `<aside class="hub-legend" aria-label="Special cards, flows and hashtags">
        ${hubFold('legend:cards', 'hub-legend-group', `${chevron}<i class="ti ti-star-filled" aria-hidden="true"></i><span>Special cards</span><small>${events.length}</small>`, `<nav class="hub-links">${cardLinks || '<p class="hub-empty">None yet</p>'}</nav>`)}
        ${hubFold('legend:flows', 'hub-legend-group', `${chevron}<i class="ti ti-arrows-exchange" aria-hidden="true"></i><span>Flows</span><small>${flows.length}</small>`, `<nav class="hub-links">${flowLinks || '<p class="hub-empty">None yet</p>'}</nav>`)}
        ${hubFold('legend:tags', 'hub-legend-group', `${chevron}<i class="ti ti-hash" aria-hidden="true"></i><span>Hashtags</span><small>${tags.length}</small>${loading}`, `<input class="hub-filter" type="search" name="hashtag-filter" data-hub-filter placeholder="Find a hashtag" aria-label="Find a hashtag" autocomplete="off" spellcheck="false" value="${escapeHtml(hubFilter)}"><nav class="hub-links">${tagLinks || `<p class="hub-empty">${hubLoading ? 'Loading…' : 'None yet'}</p>`}</nav>`)}
      </aside>`;
      const tools = events.length ? '<div class="hub-tools"><button type="button" class="quiet-button" data-hub-all="open" title="Open every card">Expand all</button><button type="button" class="quiet-button" data-hub-all="close" title="Close every card">Collapse all</button></div>' : '';
      const cards = hubFold('cards', 'hub-section', `${chevron}<h2><i class="ti ti-star-filled" aria-hidden="true"></i>Special cards</h2><small>${plural(events.length, 'card')}</small>`,
        `<div class="hub-section-body">${tools}${years.map(year => {
          const ofYear = events.filter(event => event.year === year);
          return hubFold(`year:${year}`, 'hub-year', `${chevron}<span>${year}</span><small>${plural(ofYear.length, 'card')}</small>`, `<div class="month-group">${ofYear.map(event => ledgerRenderer.eventBlock(event, year, state)).join('')}</div>`);
        }).join('') || '<p class="ledger-none">No special cards yet. Add one in Year settings.</p>'}</div>`);
      const tagBlocks = tags.map(entry => {
        const open = hubOpenTags.has(entry.tag);
        return `<details class="hub-tag tag-c${LedgerSearch.tagColour(entry.tag)}" data-hub-tag="${escapeHtml(entry.tag)}"${open ? ' open' : ''}><summary>${hubTagHead(entry)}</summary><div class="hub-tag-body">${open ? hubTagBody(entry) : ''}</div></details>`;
      }).join('');
      const tagSection = hubFold('tags', 'hub-section', `${chevron}<h2><i class="ti ti-hash" aria-hidden="true"></i>Hashtags</h2><small>${plural(tags.length, 'tag')}</small>${loading}`,
        `<div class="hub-section-body">${tagBlocks || `<p class="ledger-none">${hubLoading ? 'Loading every month…' : 'No hashtags yet. Add one like #gold to an entry’s description or comment, or to a subsection’s name.'}</p>`}</div>`);
      const flowSection = hubFold('flows', 'hub-section', `${chevron}<h2><i class="ti ti-arrows-exchange" aria-hidden="true"></i>Flows</h2><small>${plural(flows.length, 'flow')}</small>${loading}`,
        `<div class="hub-section-body">${flows.map(hubFlowBlock).join('') || '<p class="ledger-none">No flows yet. Right-click (or double-tap) an entry or a note, then “Add to a flow…”: a loan and its repayments, an advance and its refund.</p>'}</div>`);
      return `<div class="hub">${legend}<div class="hub-main">${cards}${flowSection}${tagSection}</div></div>`;
    }
    // The legend's filter hides the tags (in the legend and on the page) that do not match what is typed.
    function applyHubFilter(host) {
      const typed = hubFilter.trim().replace(/^#/, '').toLocaleLowerCase();
      host.querySelectorAll('[data-hub-tag-link]').forEach(link => { link.hidden = Boolean(typed) && !link.dataset.hubTagLink.includes(typed); });
      host.querySelectorAll('.hub-tag[data-hub-tag]').forEach(tag => { tag.hidden = Boolean(typed) && !tag.dataset.hubTag.includes(typed); });
    }
    // Every year's months are loaded once (reads only), so each tag shows all of its entries.
    function loadHubYears() {
      if (hubLoading) return;
      const missing = store.yearIds().map(Number).filter(year => store.year(year) && !store.isYearLoaded(year));
      if (!missing.length) return;
      hubLoading = true;
      Promise.all(missing.map(year => store.ensureYear(year)))
        .catch(() => showToast('Could not load every month from Firebase.'))
        .finally(() => {
          hubLoading = false;
          if (specialMode) renderLedger({ loadMissing: false });
        });
    }
    function hubReveal(element, mark = element) {
      if (!element) return;
      mark.classList.remove('is-search-hit');
      void mark.offsetWidth; // restart the glow when the same place is chosen twice
      mark.classList.add('is-search-hit');
      element.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    // Opens the page at a card (opened) or a tag (opened), unfolding the groups around it.
    function goToCard(id) {
      const key = `ev:${id}`;
      setSpecialMode(true);
      setHubFold('cards', true);
      setHubFold(`year:${store.events[id]?.year}`, true);
      expandedMonths.add(key);
      saveExpandedMonths();
      renderLedger();
      const block = document.querySelector(`.month-block[data-month-key="${CSS.escape(key)}"]`);
      hubReveal(block, block?.querySelector('.month-ledger-head'));
    }
    function goToFlow(id) {
      setSpecialMode(true);
      setHubFold('flows', true);
      hubOpenFlows.add(id);
      saveHubFlows();
      renderLedger();
      const block = document.querySelector(`.hub-flow[data-hub-flow="${CSS.escape(id)}"]`);
      if (!block) return showToast('That flow is gone.');
      hubReveal(block, block.querySelector(':scope > summary'));
    }
    function goToTag(tag) {
      setSpecialMode(true);
      setHubFold('tags', true);
      hubOpenTags.add(tag);
      saveHubTags();
      if (hubFilter && !tag.includes(hubFilter.trim().replace(/^#/, '').toLocaleLowerCase())) hubFilter = '';
      renderLedger();
      const block = document.querySelector(`.hub-tag[data-hub-tag="${CSS.escape(tag)}"]`);
      if (!block) return showToast(hubLoading ? `Loading… #${tag} shows once every month is in.` : `No entries with #${tag}.`);
      hubReveal(block, block.querySelector(':scope > summary'));
    }
    function setupHub() {
      const ledgerMain = document.querySelector('#ledger');
      const host = document.querySelector('#month-ledger');
      // Folding is remembered; a tag's entries are drawn when it is opened.
      host.addEventListener('toggle', event => {
        const el = event.target;
        if (!(el instanceof HTMLDetailsElement)) return;
        if (el.dataset.hubFold) return setHubFold(el.dataset.hubFold, el.open);
        if (el.dataset.hubFlow) {
          if (el.open) hubOpenFlows.add(el.dataset.hubFlow); else hubOpenFlows.delete(el.dataset.hubFlow);
          return saveHubFlows();
        }
        const tag = el.dataset.hubTag;
        if (tag === undefined) return;
        if (el.open) {
          hubOpenTags.add(tag);
          const body = el.querySelector('.hub-tag-body');
          const entry = hashtagIndex().find(item => item.tag === tag);
          if (body && entry && !body.childElementCount) body.innerHTML = hubTagBody(entry);
        } else hubOpenTags.delete(tag);
        saveHubTags();
      }, true);
      host.addEventListener('input', event => {
        if (!event.target.matches('[data-hub-filter]')) return;
        hubFilter = event.target.value;
        applyHubFilter(host);
      });
      host.addEventListener('click', event => {
        if (!specialMode) return;
        const all = event.target.closest('[data-hub-all]');
        if (all) {
          event.preventDefault();
          event.stopPropagation();
          store.eventList().forEach(item => (all.dataset.hubAll === 'open' ? expandedMonths.add(`ev:${item.id}`) : expandedMonths.delete(`ev:${item.id}`)));
          if (all.dataset.hubAll === 'open') store.eventList().forEach(item => setHubFold(`year:${item.year}`, true));
          saveExpandedMonths();
          return renderLedger();
        }
        const card = event.target.closest('[data-hub-card]');
        if (card) {
          event.stopPropagation();
          return goToCard(card.dataset.hubCard);
        }
        const flowLink = event.target.closest('[data-hub-flow-link]');
        if (flowLink) {
          event.stopPropagation();
          return goToFlow(flowLink.dataset.hubFlowLink);
        }
        const flowEdit = event.target.closest('[data-flow-edit]');
        if (flowEdit) {
          event.preventDefault();
          event.stopPropagation();
          return openFlowPicker({ mode: 'edit', flowId: flowEdit.dataset.flowEdit }, flowEdit);
        }
        const tagLink = event.target.closest('[data-hub-tag-link]');
        if (tagLink) {
          event.stopPropagation();
          return goToTag(tagLink.dataset.hubTagLink);
        }
        const row = event.target.closest('.hub-tag [data-search-jump], .hub-flow [data-search-jump]');
        if (row) {
          event.stopPropagation();
          openSearchResult(JSON.parse(row.dataset.searchJump));
        }
      }, true);
      // A tag in any row opens the page at that tag.
      ledgerMain.addEventListener('click', event => {
        const tag = event.target.closest('[data-hashtag]');
        if (!tag) return;
        event.preventDefault();
        event.stopPropagation();
        goToTag(tag.dataset.hashtag);
      }, true);
      // Links to the former Hashtags page (months.html#tags, #tags/<tag>) open this page at the tag.
      if (/^#tags(\/|$)/.test(location.hash)) {
        const tag = decodeURIComponent(location.hash.slice(6));
        history.replaceState(null, '', location.pathname + location.search);
        setSpecialMode(true);
        // Once the ledger is set up.
        if (tag) setTimeout(() => goToTag(tag));
      }
    }
    function setupSearch() {
      const dialog = document.querySelector('#search-dialog');
      const input = document.querySelector('#search-input');
      const termsEl = document.querySelector('#search-terms');
      const list = document.querySelector('#search-results');
      if (!dialog || !window.LedgerSearch) return;
      let scope = 'year';
      let terms = [];
      let query = '';
      let loading = '';
      let active = -1;
      let timer = null;
      const yearOf = () => currentMonth.getFullYear();
      const showScope = () => dialog.querySelectorAll('[data-search-scope]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.searchScope === scope));
        if (button.dataset.searchScope === 'year') button.textContent = String(yearOf());
      });
      const rowsEls = () => [...list.querySelectorAll('[data-search-jump]')];
      const setActive = index => {
        const rows = rowsEls();
        active = rows.length ? Math.max(0, Math.min(index, rows.length - 1)) : -1;
        rows.forEach((row, i) => row.classList.toggle('is-active', i === active));
        rows[active]?.scrollIntoView({ block: 'nearest' });
      };
      const draw = () => {
        if (query.length < 2) {
          termsEl.innerHTML = '';
          list.innerHTML = '<p class="search-empty">Type a word in Telugu or English. It is also searched in the other script and by its meaning.</p>';
          return;
        }
        const found = LedgerSearch.results(searchRows(scope === 'year' ? yearOf() : null), terms);
        termsEl.innerHTML = LedgerSearch.termsHtml(terms, found.counts, escapeHtml);
        list.innerHTML = (loading ? `<p class="search-empty"><i class="ti ti-loader-2 search-spin" aria-hidden="true"></i> Loading ${loading}…</p>` : '') + LedgerSearch.resultsHtml(found, terms, ledgerCtx);
        setActive(0);
      };
      // Months not fetched yet are loaded once (only reads), then the results are drawn again.
      const ensureLoaded = async () => {
        const years = scope === 'year' ? [yearOf()] : store.yearIds().map(Number);
        const missing = years.filter(year => store.year(year) && !store.isYearLoaded(year));
        if (!missing.length) return;
        loading = missing.length === 1 ? String(missing[0]) : `${missing.length} years`;
        draw();
        try { await Promise.all(missing.map(year => store.ensureYear(year))); } catch (error) { showToast('Could not load every month from Firebase.'); }
        loading = '';
        draw();
      };
      const run = () => {
        query = input.value.trim();
        const asked = query;
        if (query.length < 2) { terms = []; return draw(); }
        LedgerSearch.expand(query, next => {
          if (asked !== query) return; // a newer query has started
          terms = next;
          draw();
        });
        ensureLoaded();
      };
      const open = () => {
        if (dialog.open) return input.focus();
        showScope();
        dialog.showModal();
        input.focus();
        input.select();
        run();
      };
      document.querySelector('#search-button')?.addEventListener('click', open);
      document.addEventListener('keydown', event => {
        const typing = event.target.closest?.('input, textarea, select, [contenteditable="true"]');
        if ((event.key === '/' && !typing && !event.ctrlKey && !event.metaKey) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) {
          if (document.querySelector('dialog[open]:not(#search-dialog)')) return;
          event.preventDefault();
          open();
        }
      });
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(run, 220);
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setActive(active + (event.key === 'ArrowDown' ? 1 : -1));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          clearTimeout(timer);
          if (input.value.trim() !== query) return run();
          rowsEls()[active]?.click();
        }
      });
      dialog.querySelectorAll('[data-search-scope]').forEach(button => button.addEventListener('click', () => {
        scope = button.dataset.searchScope;
        showScope();
        input.focus();
        run();
      }));
      list.addEventListener('click', event => {
        const row = event.target.closest('[data-search-jump]');
        if (!row) return;
        dialog.close();
        openSearchResult(JSON.parse(row.dataset.searchJump));
      });
      list.addEventListener('mousemove', event => {
        const row = event.target.closest('[data-search-jump]');
        if (row) setActive(rowsEls().indexOf(row));
      });
    }
    // ---- Sync markers and panel (see "This device and Firebase" below) ----
    // The card a Firebase path belongs to: a month, a special card, or the year card for a year's own node.
    function cardOf(path) {
      const month = /^months\/(\d{4})_(\w+)/.exec(path);
      if (month) return keyOf(Number(month[1]), ExpenseStore.MONTH_NAMES.indexOf(month[2]));
      const event = /^events\/([^/]+)/.exec(path);
      if (event) return `ev:${event[1]}`;
      const year = /^years\/(\d{4})/.exec(path);
      if (year) return `yr:${year[1]}`;
      return null;
    }
    // ↑ on cards changed here and still waiting; ↓ on cards Firebase has newer (both, when both).
    function syncMarks() {
      const marks = new Map();
      const add = (path, kind) => {
        const key = cardOf(path);
        if (!key) return;
        const set = marks.get(key) || new Set();
        set.add(kind);
        marks.set(key, set);
      };
      syncState.pending.forEach(path => add(path, 'local'));
      syncState.newer.forEach(path => add(path, 'remote'));
      return marks;
    }
    function applySyncMarks() {
      const marks = syncMarks();
      document.querySelectorAll('.month-block[data-month-key]').forEach(block => {
        const head = block.querySelector('.month-ledger-head h2');
        if (!head) return;
        head.querySelectorAll('.sync-mark').forEach(mark => mark.remove());
        const kinds = marks.get(block.dataset.monthKey);
        if (!kinds) return;
        [['local', 'arrow-up', 'Changed on this device; not in Firebase yet'], ['remote', 'arrow-down', 'Newer in Firebase; this device is updating']].filter(([kind]) => kinds.has(kind)).forEach(([kind, icon, title]) => {
          head.insertAdjacentHTML('beforeend', `<span class="sync-mark is-${kind}" title="${title}" role="img" aria-label="${title}"><i class="ti ti-${icon}" aria-hidden="true"></i></span>`);
        });
      });
    }
    // After a save, the outbox changes: the ↑ markers follow it at once, with no request to Firebase.
    let pendingTimer = null;
    function refreshPendingMarks() {
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(async () => {
        const queue = await store.sync.vault.pending();
        syncState.pending = [...new Set(queue.flatMap(item => Object.keys(item.update).filter(path => !path.startsWith('meta/'))))];
        applySyncMarks();
        drawSyncPanel();
      }, 150);
    }
    const when = at => (at ? new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not yet');
    function drawSyncPanel() {
      const body = document.querySelector('#sync-body');
      if (!body) return;
      if (!store.sync) {
        body.innerHTML = '<p class="sync-note">This browser cannot keep a copy of the ledger (a private window, say), so it works online only.</p>';
        return;
      }
      const names = paths => [...new Set(paths.map(describePath))];
      const list = paths => `<ul class="sync-paths">${names(paths).slice(0, 12).map(name => `<li>${escapeHtml(name)}</li>`).join('')}${names(paths).length > 12 ? `<li>and ${names(paths).length - 12} more</li>` : ''}</ul>`;
      const rows = [];
      // Why nothing is leaving this device. Without this the panel can only say what is waiting, which reads as patience
      // when it is actually a refusal that will never clear on its own.
      if (syncState.error) rows.push(`<li class="is-error"><i class="ti ti-alert-triangle" aria-hidden="true"></i><div><b>Firebase refused the last send</b><span>${escapeHtml(syncState.error)}</span></div></li>`);
      if (syncState.offline) rows.push(`<li class="is-offline"><i class="ti ti-wifi-off" aria-hidden="true"></i><div><b>Offline</b><span>Working from this device; changes go out when the connection returns.</span></div></li>`);
      if (syncState.pending.length) rows.push(`<li class="is-local"><i class="ti ti-arrow-up" aria-hidden="true"></i><div><b>Changed here, not in Firebase yet</b>${list(syncState.pending)}</div></li>`);
      if (syncState.newer.length) rows.push(`<li class="is-remote"><i class="ti ti-arrow-down" aria-hidden="true"></i><div><b>Newer in Firebase</b>${list(syncState.newer)}</div></li>`);
      if (!rows.length) rows.push(`<li class="is-ok"><i class="ti ti-circle-check" aria-hidden="true"></i><div><b>This device and Firebase match</b><span>Last checked ${when(syncState.checkedAt)}.</span></div></li>`);
      const kb = syncState.bytes / 1024;
      const size = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`;
      const copy = isViewer ? 'what you have opened' : syncState.mirroredAt ? `the whole ledger (downloaded ${when(syncState.mirroredAt)})` : 'being downloaded…';
      body.innerHTML = `<ul class="sync-states">${rows.join('')}</ul><p class="sync-note">On this device: ${copy} · ${syncState.kept} parts · ${size}${syncState.busy ? ' · syncing…' : ''}</p>${syncState.needsRefresh ? '<p class="sync-note is-refresh">This page shows data Firebase has changed since; it refreshes once you finish editing.</p>' : ''}`;
      document.querySelector('[data-sync="download"]').hidden = isViewer;
    }
    function setupSyncPanel() {
      const dialog = document.querySelector('#sync-dialog');
      const button = document.querySelector('#sync-button');
      if (!dialog || !button) return;
      button.addEventListener('click', () => {
        drawSyncPanel();
        dialog.showModal();
      });
      dialog.addEventListener('click', async event => {
        const button = event.target.closest('[data-sync]');
        const action = button?.dataset.sync;
        if (!action) return;
        if (!store.sync) return showToast('This browser cannot keep a copy of the ledger.');
        button.disabled = true;
        drawSyncPanel();
        // Whatever the sync runs into, the button comes back: one that stayed disabled would leave no way to try again.
        try {
          await syncNow({ everything: action === 'download' });
        } catch (error) {
          console.error('Could not sync with Firebase.', error);
          showToast('Could not sync with Firebase. Check your connection and try again.');
        } finally {
          button.disabled = false;
          drawSyncPanel();
        }
        if (syncState.needsRefresh) {
          dialog.close();
          showToast('Showing the newer data from Firebase…');
          setTimeout(() => window.location.reload(), 800);
        }
      });
      dialog.addEventListener('close', () => { if (syncState.needsRefresh && store.sync) setTimeout(() => window.location.reload(), 300); });
    }
    ensureNextYear();
    setupYearConfig();
    setupMonthSettings();
    setupSectionSetup();
    setupAllocDialog();
    setupMergeDialog();
    setupLegacyUnpackDialog();
    setupAboutPop();
    setupHub();
    setupTagPicker();
    setupFlowPicker();
    setupRowMenu();
    setupLedger();
    setupSearch();
    document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
    // Light or dark: remembered per browser; dark is the default.
    const themeButton = document.querySelector('#theme-button');
    const showTheme = () => {
      const light = document.documentElement.dataset.theme === 'light';
      themeButton.innerHTML = `<i class="ti ti-${light ? 'moon' : 'sun'}" aria-hidden="true"></i>`;
      themeButton.setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} theme`);
      themeButton.title = `Switch to ${light ? 'dark' : 'light'} theme`;
      document.querySelector('meta[name="theme-color"]').content = light ? '#f6f3ec' : '#121417';
    };
    themeButton.addEventListener('click', () => {
      const light = document.documentElement.dataset.theme !== 'light';
      if (light) document.documentElement.dataset.theme = 'light';
      else delete document.documentElement.dataset.theme;
      try { localStorage.setItem('kajanauday-theme', light ? 'light' : 'dark'); } catch (error) { /* Not remembered this time. */ }
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
      setSaveStatus('viewer');
    }
    // ---- This device and Firebase, kept the same ----
    // With a copy on this device (store.sync), changes made here go out as soon as there is a connection, and parts that
    // another device changed are fetched again. An admin also keeps the whole ledger here: every month of every year and
    // the special cards, downloaded once in the background and kept up to date, so all of it opens and changes offline.
    // Months (and special cards, and the year card) that differ carry a marker: ↑ changed here, not in Firebase yet;
    // ↓ newer in Firebase. The dot in the top bar opens the Sync panel. Sync runs on opening, every three minutes, when the
    // connection returns and when the tab is shown again. Whatever this page shows that Firebase has changed since, it reads
    // again by reloading, once nothing is being edited.
    if (store.sync) {
      const SYNC_EVERY = 3 * 60 * 1000;
      const MIRRORED = 'mirroredAt';
      const fullCopy = !isViewer;
      // The nodes of a full copy: the shell, the special cards, and every month of every year.
      const allPaths = () => ['currencies', 'years', 'events', ...store.yearIds().flatMap(year => ExpenseStore.MONTH_NAMES.map(name => `months/${year}_${name}`))];
      // Whether the page shows a node: the shell always, a month once loaded.
      const onScreen = path => !path.startsWith('months/') || store.synced.has(path.slice(7));
      const idle = () => !hasDraft() && !document.querySelector('dialog[open]') && !document.activeElement?.matches?.('input, textarea, select');
      const reloadWhenIdle = () => {
        if (!syncState.needsRefresh || !idle() || document.hidden) return;
        showToast('Showing the newer data from Firebase…');
        setTimeout(() => window.location.reload(), 1000);
      };
      async function runSync({ everything = false } = {}) {
        if (syncState.busy) return syncState.busy;
        syncState.busy = (async () => {
          // 1. Changes made here go out first (a clash with another device asks which one stays).
          await store.sync.flush();
          if (store.sync.stale) syncState.needsRefresh = true;
          // 2. What differs now.
          let report = await store.sync.compare();
          const kept = new Set(report.kept);
          const missing = fullCopy ? allPaths().filter(path => !kept.has(path)) : [];
          const toPull = everything && fullCopy ? allPaths() : [...new Set([...report.outdated, ...missing])];
          // 3. Parts newer in Firebase, and parts not here yet, are fetched.
          if (toPull.length && !report.offline) {
            const big = toPull.length > 6;
            if (big) showToast(`Downloading the ledger to this device… 0 of ${toPull.length}`);
            const done = await store.sync.pull(toPull, (n, total) => { if (big && (n % 6 === 0 || n === total)) showToast(`Downloading the ledger to this device… ${n} of ${total}`); });
            if (done === toPull.length && (missing.length || everything)) {
              syncState.mirroredAt = Date.now();
              store.sync.vault.write(MIRRORED, syncState.mirroredAt);
              if (big) showToast('The whole ledger is on this device. It works offline too.');
            }
            if (report.outdated.some(onScreen)) syncState.needsRefresh = true;
            report = await store.sync.compare();
          }
          Object.assign(syncState, { pending: report.pending, outdated: report.outdated, newer: report.newer, kept: report.kept.length, bytes: report.bytes, offline: report.offline, error: report.error || null, checkedAt: report.offline ? syncState.checkedAt : Date.now() });
          setSyncStatus(report.offline ? 'offline' : report.queued ? 'pending' : 'synced');
          applySyncMarks();
          drawSyncPanel();
          reloadWhenIdle();
        })().catch(error => {
          console.error('Could not sync with Firebase.', error);
        }).finally(() => { syncState.busy = null; });
        return syncState.busy;
      }
      syncNow = runSync;
      store.sync.vault.read(MIRRORED).then(at => { syncState.mirroredAt = at || null; });
      window.addEventListener('online', () => runSync());
      window.addEventListener('offline', () => setSyncStatus('offline'));
      document.addEventListener('visibilitychange', () => { if (!document.hidden) runSync(); });
      setInterval(() => (syncState.needsRefresh ? reloadWhenIdle() : runSync()), SYNC_EVERY);
      setTimeout(() => runSync(), 1500);
    }
    setupSyncPanel();
    renderLedger();
    })();
