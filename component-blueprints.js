// Ledger blueprints: pure functions from (data, state, ctx) → HTML string, one per level of the hierarchy.
// The markup is lifted verbatim from the original inline templates so the CSS grid contract is unchanged:
//   .ledger-panel > .ledger-sections > details.ledger-type-section > details.ledger-cat > .ledger-entries > .ledger-entry-cell
// `ctx` carries the app's formatting helpers (fmt, esc, dayLabel, keyOf, catKey) so the blueprints have no globals.
// `state` is { expandedEntries, entryDraft, subEntryDraftParentId, ledgerDraft } — the inline-edit state the UI reflects.
(function (global) {
  const daysIn = mKey => new Date(Number(mKey.slice(0, 4)), Number(mKey.slice(5, 7)), 0).getDate();
  // Panels of a special event use the key "ev:<id>": their entries can fall in any month, so they carry a full date.
  const isEventKey = mKey => String(mKey).startsWith('ev:');
  const dateField = (mKey, value, { required = true, label = 'Day of month' } = {}) => (isEventKey(mKey)
    ? `<input name="date" type="date" value="${value || ''}" aria-label="Date"${required ? ' required' : ''}>`
    : `<input name="day" enterkeyhint="next" type="number" min="1" max="${daysIn(mKey)}" step="1" inputmode="numeric" ${value ? `value="${Number(value.slice(8, 10))}"` : 'placeholder="DD" '} aria-label="${label}"${required ? ' required' : ''}>`);
  const dateText = (mKey, date, ctx) => (isEventKey(mKey) ? ctx.dayLabel(date) : date.slice(8, 10));

  // The colour of an amount: its type's, except in a balance section ('net'), where zero or more is income and less is an expense.
  const toneOf = (type, amount) => (type === 'net' ? (Number(amount) < 0 ? 'expense' : 'income') : type);
  // A custom section's amounts show without a minus sign: red already says it is negative. Editing still shows the sign.
  const amountText = (type, amount, property, ctx) => ctx.fmt(type === 'net' ? Math.abs(Number(amount)) : amount, property);

  // An amount typed as a formula shows its total, with the formula on hover. The formula rides in data-formula, not in
  // `title`: the row around it is a button with its own title, and a native tooltip inside one is unreliable, so the CSS
  // draws this one itself.
  const amountTag = (type, formula, text, ctx) =>
    `<strong class="${type}${formula ? ' has-formula' : ''}"${formula ? ` data-formula="${ctx.esc(formula)}"` : ''}>${text}</strong>`;

  // Inline forms --------------------------------------------------------------------------------
  // Save / Cancel buttons: hidden with a mouse (Enter and Esc do it), shown on touch screens, whose number pad has no Enter.
  // A Delete button, when given, shows for every pointer; it carries the data-delete-row attributes the click handler reads.
  // A Move button (entries only) opens the move dialog: another month or year, or into or out of a special event.
  const FormActions = (cancelAttr, deleteAttrs = '', moveId = '') =>
    `<span class="ledger-entry-actions">${deleteAttrs ? DeleteButton(deleteAttrs) : ''}${moveId ? `<button type="button" class="mini-btn is-move" data-move-entry="${moveId}" aria-label="Move" title="Move to another month, year or special event"><i class="ti ti-arrows-move" aria-hidden="true"></i><span>Move</span></button>` : ''}<button type="button" class="mini-btn" ${cancelAttr} aria-label="Cancel" title="Cancel"><i class="ti ti-x" aria-hidden="true"></i><span>Cancel</span></button><button type="submit" class="mini-btn is-save" aria-label="Save" title="Save"><i class="ti ti-check" aria-hidden="true"></i><span>Save</span></button></span>`;
  const DeleteButton = attrs =>
    `<button type="button" class="mini-btn is-delete" ${attrs} aria-label="Delete" title="Delete"><i class="ti ti-trash" aria-hidden="true"></i><span>Delete</span></button>`;
  const EntryForm = ({ mKey, property, type, category, sectionName }, ctx) =>
    `<form class="ledger-entry ledger-entry-form" data-ledger-form="entry" data-month="${mKey}" data-property="${property}" data-section="${ctx.esc(sectionName)}" data-type="${type}" data-category="${ctx.esc(category)}" novalidate>${dateField(mKey, isEventKey(mKey) ? ctx.today() : '')}<input class="ledger-entry-desc" name="description" enterkeyhint="next" maxlength="80" placeholder="Description"  aria-label="Description" autocomplete="off" required><input class="ledger-entry-place" name="place" enterkeyhint="next" maxlength="60" placeholder="Comment"  aria-label="Comment" autocomplete="off"><input name="amount" enterkeyhint="done" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Amount or =formula"  aria-label="Amount" required>${FormActions('data-cancel-entry')}</form>`;

  const SubEntryForm = ({ mKey, parentId }, ctx) =>
    `<form class="ledger-entry ledger-entry-form" data-ledger-form="sub-entry" data-parent-id="${ctx.esc(parentId)}" novalidate>${dateField(mKey, '', { required: false })}<input class="ledger-entry-desc" name="description" enterkeyhint="next" maxlength="80" placeholder="Description"  aria-label="Description" autocomplete="off" required><input class="ledger-entry-place" name="place" enterkeyhint="next" maxlength="60" placeholder="Comment"  aria-label="Comment" autocomplete="off"><input name="amount" enterkeyhint="done" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Amount or =formula"  aria-label="Amount">${FormActions('data-cancel-sub-entry')}</form>`;

  // Double-click edit: the entry's or note's own fields, prefilled, in the same columns as the row it replaces.
  const EditEntryForm = ({ mKey, item, kind }, ctx) =>
    `<form class="ledger-entry ledger-entry-form is-edit" data-ledger-form="${kind === 'note' ? 'edit-note' : 'edit-entry'}" data-entry-id="${ctx.esc(item.id)}" novalidate>${dateField(mKey, item.date)}<input class="ledger-entry-desc" name="description" enterkeyhint="next" maxlength="80" value="${ctx.esc(item.description)}" placeholder="Description" aria-label="Description" autocomplete="off" required><input class="ledger-entry-place" name="place" enterkeyhint="next" maxlength="60" value="${ctx.esc(item.place || '')}" placeholder="Comment" aria-label="Comment" autocomplete="off"><input name="amount" enterkeyhint="done" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${ctx.esc(item.formula || String(Number(item.amount) / 100))}" placeholder="Amount or =formula" aria-label="Amount" required>${FormActions('data-cancel-edit', `data-delete-row="${kind === 'note' ? 'note' : 'entry'}" data-entry-id="${ctx.esc(item.id)}"`, kind === 'note' ? '' : ctx.esc(item.id))}</form>`;

  const SubsectionForm = ({ sectionName }, ctx) =>
    `<form class="ledger-form sub-form" data-ledger-form="subsection" novalidate><input name="name" placeholder="New subsection in ${ctx.esc(sectionName)}" maxlength="40" aria-label="New subsection name" autocomplete="off"><button type="submit" class="mini-btn is-save" aria-label="Add subsection" title="Add (Enter)"><i class="ti ti-check" aria-hidden="true"></i></button><button type="button" class="mini-btn" data-cancel-draft aria-label="Cancel" title="Cancel (Esc)"><i class="ti ti-x" aria-hidden="true"></i></button><p class="ledger-form-hint" aria-live="polite"></p></form>`;

  // A new balance section beside Income and Expenses: just its name. Its entries may be negative.
  // Whether a custom section's result goes to the month's income and expenses (see ExpenseStore.sectionCalc): asked when it
  // is made, and in Month settings and Section setup later. The equations are written in Section setup.
  const SIDE_MODES = [['count', 'Show and add to total'], ['show', 'Show only'], ['off', "Don't show"]];
  const SideModeField = (type, mode, ctx) =>
    `<label><span>${type === 'income' ? 'Income' : 'Expenses'}</span><select name="${type}" data-side-mode="${type}" aria-label="${type === 'income' ? 'Income' : 'Expenses'}: show and count">${SIDE_MODES.map(([value, label]) => `<option value="${value}"${mode === value ? ' selected' : ''}>${ctx.esc(label)}</option>`).join('')}</select></label>`;
  const SectionRuleFields = (rule = { expense: { mode: 'count' }, income: { mode: 'off' } }, ctx) =>
    `<div class="section-rule">${SideModeField('expense', rule.expense.mode, ctx)}${SideModeField('income', rule.income.mode, ctx)}</div>`;
  const SectionForm = ({ code }, ctx) =>
    `<form class="ledger-form sub-form section-form" data-ledger-form="section" novalidate><input name="name" placeholder="New ${ctx.esc(code)} section (amounts may be negative)" maxlength="40" aria-label="New section name" autocomplete="off"><button type="submit" class="mini-btn is-save" aria-label="Add section" title="Add (Enter)"><i class="ti ti-check" aria-hidden="true"></i></button><button type="button" class="mini-btn" data-cancel-draft aria-label="Cancel" title="Cancel (Esc)"><i class="ti ti-x" aria-hidden="true"></i></button>${SectionRuleFields(undefined, ctx)}<p class="ledger-form-hint" aria-live="polite"></p></form>`;

  // Child order ---------------------------------------------------------------------------------
  // A subsection has two sort buttons, Day and Amount; exactly one is active. Clicking the active one flips its
  // direction, clicking the other switches to it. The mode is null for the default (day, newest first: entries as
  // before, notes as entered), else 'date-asc' | 'amount-desc' | 'amount-asc'.
  const SORT_LABELS = { 'date-desc': 'day, newest first', 'date-asc': 'day, oldest first', 'amount-desc': 'amount, largest first', 'amount-asc': 'amount, smallest first' };
  const byEntries = {
    'date-asc': (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    'amount-desc': (a, b) => b._meta.total - a._meta.total || b.date.localeCompare(a.date),
    'amount-asc': (a, b) => a._meta.total - b._meta.total || b.date.localeCompare(a.date)
  };
  const byNotes = {
    'date-asc': (a, b) => a.date.localeCompare(b.date),
    'amount-desc': (a, b) => b.amount - a.amount,
    'amount-asc': (a, b) => a.amount - b.amount
  };
  const SortButtons = (key, mode, name, ctx) => {
    const current = mode || 'date-desc';
    const button = (field, icons) => {
      const active = current.startsWith(field);
      const dir = active ? current.slice(field.length + 1) : 'desc';
      const to = active ? `${field}-${dir === 'desc' ? 'asc' : 'desc'}` : `${field}-desc`;
      const now = active ? SORT_LABELS[current] : `${field === 'date' ? 'day' : 'amount'}, off`;
      return `<button type="button" class="ledger-sort${active ? ' is-active' : ''}" data-sort-cat="${ctx.esc(key)}" data-sort-field="${field}" data-sort-to="${to}" data-sort-name="${ctx.esc(name)}" aria-pressed="${active}" aria-label="Order ${ctx.esc(name)} by ${SORT_LABELS[to]}" title="${now} · click for ${SORT_LABELS[to]}"><i class="ti ${dir === 'asc' ? icons[1] : icons[0]}" aria-hidden="true"></i></button>`;
    };
    return `<span class="ledger-sorts">${button('date', ['ti-calendar-down', 'ti-calendar-up'])}${button('amount', ['ti-sort-descending-numbers', 'ti-sort-ascending-numbers'])}</span>`;
  };

  // A row's description and comment (stored as `place`). Without a comment, the description also takes the comment's
  // column, so long descriptions show in full far more often, on phones above all.
  const descAndComment = (description, comment, ctx, lead = '') => (comment
    ? `<span class="ledger-entry-desc">${lead}${ctx.esc(description)}</span><span class="ledger-entry-place">${ctx.esc(comment)}</span>`
    : `<span class="ledger-entry-desc is-wide">${lead}${ctx.esc(description)}</span>`);

  // Level 6: sub-entry row ----------------------------------------------------------------------
  const SubEntryRow = (sub, { mKey, type, property }, state, ctx) => (state.editDraft?.kind === 'note' && state.editDraft.id === sub.id)
    ? EditEntryForm({ mKey, item: sub, kind: 'note' }, ctx)
    : `<div class="ledger-entry-cell ledger-sub-entry" data-note-id="${ctx.esc(sub.id)}"><div class="ledger-entry-line"><span class="ledger-entry"><time datetime="${sub.date}">${dateText(mKey, sub.date, ctx)}</time>${descAndComment(sub.description, sub.place, ctx)}${amountTag(toneOf(type, sub.amount), sub.formula, amountText(type, sub.amount, property, ctx), ctx)}</span></div></div>`;

  // Level 5: entry row, with its sub-entries and sub-entry form when expanded -------------------
  const EntryRow = (entry, { mKey, type, property, order = null }, state, ctx) => {
    const isExpanded = state.expandedEntries.has(entry.id);
    // In a month, a note dated in another month is not drawn here; an event shows all of an entry's notes.
    const shown = entry.subEntries.filter(sub => isEventKey(mKey) || sub.date.startsWith(mKey));
    const subItems = byNotes[order] ? [...shown].sort(byNotes[order]) : shown;
    const hasSubItems = subItems.length > 0;
    const showingSubEntryForm = state.subEntryDraftParentId === entry.id;
    const subEntriesHtml = subItems.map(sub => SubEntryRow(sub, { mKey, type, property }, state, ctx)).join('');
    const subEntryForm = showingSubEntryForm ? SubEntryForm({ mKey, parentId: entry.id }, ctx) : '';
    // Notes are always in the DOM and only shown or hidden, so opening an entry needs no re-render.
    const notes = (hasSubItems || subEntryForm) ? `<div class="ledger-notes"${isExpanded || subEntryForm ? '' : ' hidden'}>${subEntriesHtml}${subEntryForm}</div>` : '';
    if (state.editDraft?.kind === 'entry' && state.editDraft.id === entry.id) {
      return `<div class="ledger-entry-cell">${EditEntryForm({ mKey, item: entry, kind: 'entry' }, ctx)}${notes}</div>`;
    }
    return `<div class="ledger-entry-cell"><div class="ledger-entry-line${hasSubItems ? ' has-notes' : ''}"><button type="button" class="ledger-entry ledger-entry-toggle" data-toggle-entry data-entry-id="${ctx.esc(entry.id)}" aria-expanded="${isExpanded}" title="${ctx.esc(ctx.dayLabel(entry.date))} · ${ctx.esc(entry.description)}${entry.place ? ` · ${ctx.esc(entry.place)}` : ''}${hasSubItems ? ` · ${subItems.length} ${subItems.length === 1 ? 'note' : 'notes'}` : ''}"><time datetime="${entry.date}">${dateText(mKey, entry.date, ctx)}</time>${descAndComment(entry.description, entry.place, ctx)}${amountTag(toneOf(type, entry._meta.total), entry._meta.children ? null : entry.formula, amountText(type, entry._meta.total, property, ctx), ctx)}</button></div>${notes}</div>`;
  };

  // Level 4: category (collapsible) -------------------------------------------------------------
  const entryDraftMatches = (d, { mKey, property, sectionName, name }) =>
    Boolean(d && d.month === mKey && d.property === property && d.section === sectionName && d.category === name);

  const CategoryBlock = (name, category, { mKey, type, property, sectionName, eventId }, state, ctx) => {
    const key = ctx.catKey(mKey, property, type, eventId ? `${eventId}:${name}` : name);
    const order = state.sortModes?.[key] || null;
    const entries = [...category.entries]
      .sort(byEntries[order] || ((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)))
      .map(entry => EntryRow(entry, { mKey, type, property, order }, state, ctx))
      .join('');
    // The sort button shows only where there is something to order: two entries, or an entry with two notes.
    const sortable = category.entries.length > 1 || category.entries.some(entry => entry.subEntries.filter(sub => isEventKey(mKey) || sub.date.startsWith(mKey)).length > 1);
    const draftHere = entryDraftMatches(state.entryDraft, { mKey, property, sectionName, name });
    const e = state.editDraft;
    if (e?.kind === 'category' && e.month === mKey && e.property === property && e.type === type && e.category === name) {
      return `<div class="ledger-cat is-editing" data-key="${ctx.esc(ctx.catKey(mKey, property, type, name))}"><form class="ledger-form cat-rename-form" data-ledger-form="rename-category" data-month="${mKey}" data-property="${property}" data-type="${type}" data-category="${ctx.esc(name)}" novalidate><input name="name" value="${ctx.esc(name)}" maxlength="40" aria-label="Subsection name" autocomplete="off"><strong${type === 'net' ? ` class="${toneOf(type, category._meta.total)}"` : ''}>${amountText(type, category._meta.total, property, ctx)}</strong><p class="ledger-form-hint" aria-live="polite"></p><span class="ledger-entry-actions">${DeleteButton(`data-delete-row="category" data-month="${mKey}" data-property="${property}" data-type="${type}" data-category="${ctx.esc(name)}"`)}</span></form><div class="ledger-entries">${entries}</div></div>`;
    }
    // A subsection with nothing under it shows no arrow, so the arrow always means there is something to open.
    // An event's subsection shown inside a month is read-only there (data-event-id); it is edited in the event.
    const eventAttr = eventId ? ` data-event-id="${ctx.esc(eventId)}" title="From the event ${ctx.esc(sectionName.replace(/^★ /, ''))}; edit it in Events"` : '';
    return `<details class="ledger-cat${category.entries.length || draftHere ? '' : ' is-empty'}${eventId ? ' is-event-cat' : ''}" data-key="${ctx.esc(key)}" data-section="${ctx.esc(sectionName)}"${eventAttr}><summary><i class="ti ti-chevron-right" aria-hidden="true"></i><span class="ledger-cat-name">${ctx.esc(name)}</span>${eventId ? `<small class="ledger-cat-event"><i class="ti ti-star-filled" aria-hidden="true"></i>${ctx.esc(sectionName.replace(/^★ /, ''))}</small>` : ''}${sortable ? SortButtons(key, order, name, ctx) : ''}<strong${type === 'net' ? ` class="${toneOf(type, category._meta.total)}"` : ''}>${amountText(type, category._meta.total, property, ctx)}</strong></summary><div class="ledger-entries">${entries}${draftHere ? EntryForm({ mKey, property, type, category: name, sectionName }, ctx) : ''}</div></details>`;
  };

  // Level 3: Income / Expenses block. Merges every configured section of that type and shows the categories that
  // have entries (plus one being added to). A block holding an open form is forced open so the form is visible.
  // `heading` ({ title, section }), when given, titles the block with one section's own name instead of Income/Expenses;
  // an event's panel draws each of its sections this way. With `heading.bare` the block has no title row at all: an
  // event's own section is the panel itself, so its subsections sit straight under the currency header.
  // `balances` ([{ label, amount, counted }]) are what the month's custom sections show in this block, one line each; only
  // counted ones are in its total.
  // A custom section's own income, expenses and balance, side by side as a month shows its own: only those its
  // calculations set (GI, GE, GB), told apart by colour.
  const SectionTotals = ({ income, expenses, balance }, property, ctx) => {
    const parts = [['income', income, 'Income'], ['expense', expenses, 'Expenses'], ['balance', balance, 'Balance']].filter(([, amount]) => amount !== undefined);
    return parts.length ? `<span class="ledger-totals section-totals">${parts.map(([tone, amount, title]) => `<span class="${tone}" title="${title}">${amount < 0 ? '−' : ''}${ctx.fmt(Math.abs(amount), property)}</span>`).join('')}</span>` : '';
  };
  const TypeSection = (type, sections, { mKey, property }, state, ctx, isOpen, carry = null, heading = null, balances = []) => {
    if (!sections.length && !carry && !balances.length) return '';
    const categories = [];
    sections.forEach(section => {
      const sectionName = section._meta.id;
      const eventId = section._meta.event;
      Object.entries(section.categories).forEach(([name, category]) => {
        // Every subsection on the month's list shows, used or not; entries outside the list show too.
        if (category.entries.length || section._meta.subsections.includes(name) || entryDraftMatches(state.entryDraft, { mKey, property, sectionName, name })) categories.push({ name, category, sectionName, eventId });
      });
    });
    // The balance a month brings in is shown as its own line: under Income when positive, under Expenses when negative.
    const carryHtml = carry ? `<div class="ledger-carry" title="Previous balance brought into this month"><i class="ti ti-arrow-forward-up" aria-hidden="true"></i><span>Brought forward from ${ctx.esc(carry.from)}</span><strong class="${type}">${ctx.fmt(carry.amount, property)}</strong></div>` : '';
    const balancesHtml = balances.map(({ label, amount, counted = true }) => `<div class="ledger-carry is-balance${counted ? '' : ' is-shown-only'}" title="${ctx.esc(label)}, ${counted ? `counted as ${type === 'income' ? 'income' : 'an expense'}` : 'shown only, not added to the total'}"><i class="ti ti-arrows-exchange" aria-hidden="true"></i><span>${ctx.esc(label)}</span><strong class="${type}">${amount < 0 ? '−' : ''}${ctx.fmt(Math.abs(amount), property)}</strong></div>`).join('');
    const total = categories.reduce((sum, { category }) => sum + category._meta.total, 0) + (carry ? carry.amount : 0) + balances.reduce((sum, { amount, counted = true }) => sum + (counted ? amount : 0), 0);
    const categoriesHtml = categories
      .sort((a, b) => b.category._meta.total - a.category._meta.total)
      .map(({ name, category, sectionName, eventId }) => CategoryBlock(name, category, { mKey, type, property, sectionName, eventId }, state, ctx))
      .join('');
    const l = state.ledgerDraft;
    const subForm = l && l.month === mKey && l.property === property && sections.some(section => section._meta.id === l.section)
      ? SubsectionForm({ sectionName: l.section }, ctx)
      : '';
    const title = heading ? ctx.esc(heading.title) : type === 'income' ? 'Income' : 'Expenses';
    // Income and Expenses start closed (a month opens on just these headings); an open form keeps its block open, and
    // the app reopens the blocks that were open before a redraw (data-key).
    const open = Boolean(subForm) || categoriesHtml.includes('data-ledger-form=');
    const typeKey = [mKey, property, type, heading?.section || ''].join('|');
    if (heading?.bare) {
      return `<div class="ledger-type-section is-bare" data-type="${type}" data-section="${ctx.esc(heading.section)}"><div>${subForm}${categoriesHtml || (subForm ? '' : `<p class="ledger-none">Nothing yet. Press and hold ${heading.panel} above to add a subsection.</p>`)}</div></div>`;
    }
    return `<details class="ledger-type-section${heading ? ' is-named' : ''}" data-type="${type}" data-key="${ctx.esc(typeKey)}"${heading ? ` data-section="${ctx.esc(heading.section)}"` : ''} ${open ? 'open' : ''}><summary><i class="ti ti-chevron-right ledger-type-caret" aria-hidden="true"></i><strong>${title}</strong>${type === 'net' && heading ? `<button type="button" class="mini-btn section-setup-btn" data-section-setup="${ctx.esc(heading.section)}" data-month="${mKey}" data-property="${property}" aria-label="Set up how ${title} counts" title="Set up how this section and its subsections count"><i class="ti ti-adjustments-horizontal" aria-hidden="true"></i></button>` : ''}${type === 'net' && sections[0]?._meta.stats ? SectionTotals(sections[0]._meta.stats, property, ctx) : `<span class="${toneOf(type, total)}">${amountText(type, total, property, ctx)}</span>`}</summary><div>${carryHtml}${balancesHtml}${subForm}${categoriesHtml || (subForm || carryHtml || balancesHtml ? '' : `<p class="ledger-none">${heading ? 'Nothing yet. Press and hold the name above to add a subsection.' : 'Nothing recorded'}</p>`)}</div></details>`;
  };

  // Level 2: one currency's panel for a month. Same blueprint for every country; `country._meta.color` drives the tint.
  const CurrencyPanel = (country, { year, monthIndex, mKey: key }, state, ctx) => {
    const property = country._meta.id;
    const mKey = key || ctx.keyOf(year, monthIndex);
    const byType = { income: [], expense: [], net: [] };
    const blocks = [];
    Object.values(country.sections).forEach(section => (section._meta.block ? blocks : byType[section._meta.type]).push(section));
    const m = country._meta;
    const carried = Number(m.carried) || 0;
    const carryFor = type => (type === 'income' ? carried > 0 : carried < 0) ? { amount: Math.abs(carried), from: m.carriedFrom } : null;
    // An event's own section (the first expense section) fills the panel untitled, other expense sections are open blocks
    // under their own names, and an Income block follows for money the event brought in (gifts, refunds…).
    const isEvent = isEventKey(mKey);
    // What each custom section adds to Income and Expenses this month, as its rules work it out (see
    // ExpenseStore.runCalc): one line per side it is sent to, shown only or added to the total.
    const lines = blocks.filter(section => section._meta.type === 'net' && section._meta.adds).flatMap(section => section._meta.adds.lines);
    const balancesFor = type => lines.filter(line => line.type === type);
    const sections = isEvent
      ? byType.expense.map((section, index) => TypeSection('expense', [section], { mKey, property }, state, ctx, true, null, { title: section._meta.id, section: section._meta.id, bare: index === 0, panel: m.name })).join('')
        + TypeSection('income', byType.income, { mKey, property }, state, ctx, true)
      : TypeSection('expense', byType.expense, { mKey, property }, state, ctx, true, carryFor('expense'), null, balancesFor('expense'))
        + TypeSection('income', byType.income, { mKey, property }, state, ctx, false, carryFor('income'), null, balancesFor('income'))
        + blocks.map(section => TypeSection(section._meta.type, [section], { mKey, property }, state, ctx, false, null, { title: section._meta.id, section: section._meta.id })).join('');
    const l = state.ledgerDraft;
    const sectionForm = l?.newSection && l.month === mKey && l.property === property ? SectionForm(m, ctx) : '';
    const totals = `<span class="income" title="Income">${ctx.fmt(m.income, property)}</span><span class="expense" title="Expenses">${ctx.fmt(m.expense, property)}</span><span class="balance" title="${isEvent ? 'Net: income minus expenses' : 'Closing balance at month end'}">${ctx.fmt(m.closing, property)}</span>`;
    return `<section class="ledger-panel ${m.color}" data-property="${property}" aria-label="${m.name}">
        <header class="ledger-panel-head">
          <button type="button" class="panel-expand" data-panel-expand aria-label="Expand all ${m.code} subsections" title="Expand all"><i class="ti ti-chevrons-down" aria-hidden="true"></i></button>
          <h3>${m.code}</h3>
          <div class="ledger-totals">${totals}</div>
        </header>
        <div class="ledger-sections">${sections}${sectionForm}</div>
      </section>`;
  };

  // Level 1: year-to-date KPI card, one per active currency ------------------------------------
  // Category totals for the year, three levels deep and collapsed until opened: each section, its subsections by size,
  // and what each subsection was spent on (its entries' notes, or the entries themselves). Each row shows its share of the
  // level above and how many months it appeared in. data-key lets an open row stay open across re-renders.
  // Section, subsection and item names can be renamed for the whole year: a renamable row carries data-kb-level and the
  // keys that identify it, and the row named by `edit` ({ key, name, open }) shows a name field in place of its name.
  // Event (★) sections and the "Other" fallback are not real sections, so they are not renamable.
  const YearBreakdown = (breakdown, property, ctx, edit = null) => {
    if (!breakdown) return '<p class="kb-loading">Adding up the year…</p>';
    const months = n => `${n} ${n === 1 ? 'month' : 'months'}`;
    const shareOf = (part, whole) => (whole ? Math.round(part / whole * 100) : 0);
    const bar = share => `<span class="kb-bar" aria-hidden="true"><i style="width:${Math.max(share, 1)}%"></i></span>`;
    const renameAttrs = (level, keys, name) =>
      ` data-kb-level="${level}" data-kb-property="${property}"${Object.entries(keys).map(([part, key]) => ` data-kb-${part}="${ctx.esc(key)}"`).join('')} data-kb-name="${ctx.esc(name)}"`;
    const renameField = (key, name) =>
      `<form class="kb-rename-form" data-kb-rename data-key="${ctx.esc(key)}" novalidate><input name="name" value="${ctx.esc(edit.name ?? name)}" maxlength="80" aria-label="New name for ${ctx.esc(name)}, for the whole year" title="Enter renames it in every month of the year; Esc cancels" autocomplete="off" spellcheck="false" enterkeyhint="done"></form>`;
    const renameHint = ' · double-click to rename';
    const block = (type, sections) => {
      if (!sections.length) return '';
      const all = sections.reduce((sum, section) => sum + section.total, 0);
      const title = type === 'income' ? 'Income' : type === 'net' ? 'Balances' : 'Expenses';
      const tone = amount => toneOf(type, amount);
      const rows = sections.map(section => {
        const sectionKey = `${property}|${type}|${section.key}`;
        const subs = section.subsections.map(sub => {
          const subKey = `${sectionKey}|${sub.key}`;
          const items = sub.items.map(part => {
            const share = shareOf(part.total, sub.total);
            const itemKey = `${subKey}|${part.key}`;
            const canRename = !section.event && part.key !== '—';
            const nameHtml = edit?.key === itemKey ? renameField(itemKey, part.name) : `<span class="kb-name" title="${ctx.esc(part.name)}${canRename ? renameHint : ''}">${ctx.esc(part.name)}</span>`;
            return `<li class="kb-item${edit?.key === itemKey ? ' is-renaming' : ''}"${canRename ? renameAttrs('item', { type, section: section.key, sub: sub.key, item: part.key }, part.name) : ''}>${nameHtml}${bar(share)}<span class="kb-share">${share}%</span><strong class="kb-amount ${tone(part.total)}">${amountText(type, part.total, property, ctx)}</strong><small class="kb-months" title="${part.count} ${part.count === 1 ? 'payment' : 'payments'}">${months(part.months)}</small></li>`;
          }).join('');
          const share = shareOf(sub.total, section.total);
          const subCells = `${bar(share)}<span class="kb-share">${share}%</span><strong class="kb-amount ${tone(sub.total)}">${amountText(type, sub.total, property, ctx)}</strong><small class="kb-months" title="${sub.entries} ${sub.entries === 1 ? 'entry' : 'entries'}">${months(sub.months)}</small>`;
          // While renamed, the row is a plain block (a field inside <summary> would toggle it); it keeps its items if open.
          if (edit?.key === subKey) return `<div class="kb-sub is-renaming" data-key="${ctx.esc(subKey)}"${edit.open ? ' data-open' : ''}><div class="kb-edit-row"><i class="ti ti-pencil" aria-hidden="true"></i>${renameField(subKey, sub.name)}${subCells}</div>${edit.open ? `<ul class="kb-items">${items}</ul>` : ''}</div>`;
          const subAttrs = section.event ? '' : renameAttrs('sub', { type, section: section.key, sub: sub.key }, sub.name);
          return `<details class="kb-sub" data-key="${ctx.esc(subKey)}"><summary${subAttrs}><i class="ti ti-chevron-right" aria-hidden="true"></i><span class="kb-name" title="${ctx.esc(sub.name)}${subAttrs ? renameHint : ''}">${ctx.esc(sub.name)}</span>${subCells}</summary><ul class="kb-items">${items}</ul></details>`;
        }).join('');
        const share = shareOf(section.total, all);
        // A lone section would only repeat the Income/Expenses heading above it, so its subsections stand directly there.
        if (sections.length === 1) return `<div class="kb-subs is-flat">${subs}</div>`;
        const sectionCells = `<span class="kb-share">${share}%</span><strong class="kb-amount ${tone(section.total)}">${amountText(type, section.total, property, ctx)}</strong>`;
        if (edit?.key === sectionKey) return `<div class="kb-section is-renaming" data-key="${ctx.esc(sectionKey)}"${edit.open ? ' data-open' : ''}><div class="kb-edit-row"><i class="ti ti-pencil" aria-hidden="true"></i>${renameField(sectionKey, section.name)}${sectionCells}</div>${edit.open ? `<div class="kb-subs">${subs}</div>` : ''}</div>`;
        const sectionAttrs = section.renamable && !section.event ? renameAttrs('section', { type, section: section.key }, section.name) : '';
        return `<details class="kb-section" data-key="${ctx.esc(sectionKey)}"><summary${sectionAttrs}><i class="ti ti-chevron-right" aria-hidden="true"></i><span class="kb-section-name"${sectionAttrs ? ` title="${ctx.esc(section.name)}${renameHint}"` : ''}>${ctx.esc(section.name)}</span>${sectionCells}</summary><div class="kb-subs">${subs}</div></details>`;
      }).join('');
      // Income and Expenses open and close like every row below them, closed until clicked.
      return `<details class="kb-type ${type}" data-key="${ctx.esc(`${property}|${type}`)}"><summary><i class="ti ti-chevron-right" aria-hidden="true"></i><span>${title}</span><strong class="${tone(all)}">${ctx.fmt(all, property)}</strong></summary><div class="kb-type-body">${rows}</div></details>`;
    };
    const html = block('expense', breakdown.expense) + block('income', breakdown.income) + block('net', breakdown.net || []);
    return html ? `${html}<p class="kb-note">Entries only; balances brought forward are not included.</p>` : '<p class="kb-loading">No entries yet this year.</p>';
  };

  const YearKpiCard = (country, year, ctx, edit = null) => {
    const { id: property, name, code, color, income, expense, net, opening, closing, breakdown } = country;
    const rate = income ? Math.round(net / income * 100) : null;
    return `<article class="kpi-card ${color}">
          <header class="kpi-head"><strong>${code}</strong><span>${year} to date</span></header>
          <dl class="kpi-values">
            <div><dt>Income</dt><dd class="income">${ctx.fmt(income, property)}</dd></div>
            <div><dt>Expenses</dt><dd class="expense">${ctx.fmt(expense, property)}</dd></div>
            <div><dt>Net</dt><dd class="${ctx.netClass(net)}">${ctx.signed(net, property)}</dd></div>
            <div><dt>Saved</dt><dd>${rate === null ? '—' : `${rate}%`}</dd></div>
            <div title="Opening ${ctx.fmt(opening, property)} + net"><dt>Balance</dt><dd>${ctx.fmt(closing, property)}</dd></div>
          </dl>
          <div class="kpi-breakdown">${YearBreakdown(breakdown, property, ctx, edit?.property === property ? edit : null)}</div>
        </article>`;
  };

  // The selected year's tab also opens its settings, so it carries a small settings mark.
  // After the years, a ★ Special tab: every special event, of every year. While it is chosen no year tab is.
  const YearTabs = (years, activeYear, special = false) =>
    years.map(value => value === activeYear && !special
      ? `<button type="button" class="year-tab" data-ledger-year="${value}" aria-pressed="true" title="${value} settings">${value}<i class="ti ti-adjustments-horizontal" aria-hidden="true"></i></button>`
      : `<button type="button" class="year-tab" data-ledger-year="${value}" aria-pressed="false" title="Show ${value}">${value}</button>`).join('')
    + `<button type="button" class="year-tab is-special" data-ledger-special aria-pressed="${special}" aria-label="Special events" title="Special events of every year"><span class="special-stars" aria-hidden="true">${`<i class="ti ti-star${special ? '-filled' : ''}"></i>`.repeat(2)}</span></button>`;

  // Pills next to a closed month's name: In / Out / Bal per currency, or a countdown for upcoming months.
  // With `mKey`, each currency's summary is a button: on a closed month it opens the month with just that currency; on an
  // open one it shows or hides that currency's panel (`shown` lists the currencies whose panels are showing).
  // `slots` (every currency, in order) keeps each currency's figures in the same columns in every month: a currency a
  // month does not have leaves an invisible placeholder of the same width.
  const MonthSummary = (rows, { isFuture, daysAway, mKey = '', shown = null, slots = null }, ctx) => {
    if (isFuture) return `<span class="month-summary"><span class="month-tag">Upcoming · in ${daysAway} ${daysAway === 1 ? 'day' : 'days'}</span></span>`;
    // The short-form suffix (K, L, Cr, M, B) is set apart so it reads as a unit, not a digit.
    const unitTag = text => text.replace(/([A-Za-z]+)$/, '<span class="ms-unit">$1</span>');
    const value = (amount, property, kind, label) => `<span class="ms-kv ${kind}${amount ? '' : ' is-zero'}" title="${ctx.regions[property].code} ${label === 'Bal' ? 'closing balance' : label === 'In' ? 'income' : 'expenses'} ${ctx.fmt(amount, property)}">${amount || label === 'Bal' ? unitTag(ctx.compact(amount, property)) : '–'}</span>`;
    const ordered = slots ? slots.map(property => rows.find(row => row.property === property) || { property, placeholder: true }) : rows;
    while (ordered.length && ordered[ordered.length - 1].placeholder) ordered.pop(); // nothing to line up after the last
    return `<span class="month-summary">${ordered.map(({ property, income, expense, balance, placeholder }) => {
        if (placeholder) return '<span class="month-tag ms-cur is-placeholder" aria-hidden="true"></span>';
        const body = `<span class="ms-code">${ctx.regions[property].code}</span>${value(income, property, 'income', 'In')}${value(expense, property, 'expense', 'Out')}${value(balance, property, 'balance', 'Bal')}`;
        if (!mKey) return `<span class="month-tag ms-cur ${ctx.regions[property].color}">${body}</span>`;
        const on = Boolean(shown?.includes(property));
        const tip = shown ? `${on ? 'Hide' : 'Show'} ${ctx.regions[property].code}` : `Open with ${ctx.regions[property].code} only`;
        return `<button type="button" class="month-tag ms-cur ${ctx.regions[property].color}" data-month-currency="${property}" data-month="${mKey}" aria-pressed="${on}" title="${tip}">${body}</button>`;
      }).join('')}</span>`;
  };

  // Month row: header always, currency panels only while open (closed months stay cheap).
  const MonthBlock = ({ mKey, label, name, open, isNow, isFuture, isEmpty, isEvent, summaryHtml, panelsHtml, single }) =>
    `<section class="month-block${open ? ' is-open' : ''}${isNow ? ' is-now' : ''}${isFuture ? ' is-future' : ''}${isEmpty ? ' is-empty' : ''}${isEvent ? ' is-event' : ''}" data-month-key="${mKey}" aria-label="${label}">
        <header class="month-ledger-head">
          <h2><button type="button" class="month-name" data-toggle-month="${mKey}" aria-expanded="${open}" aria-controls="month-body-${mKey}" title="${open ? 'Hide' : 'Show'} ${label} · double-click for ${isEvent ? 'year' : 'month'} settings">${isEvent ? '<i class="ti ti-star-filled month-name-star" aria-hidden="true"></i>' : ''}${name}</button></h2>
          ${summaryHtml}
        </header>
        ${open ? `<div class="ledger-panels${single ? ' is-single' : ''}" id="month-body-${mKey}">${panelsHtml}</div>` : ''}
      </section>`;

  const MonthGroup = (title, count, blocksHtml, unit = 'months') =>
    `<div class="month-group"><p class="month-group-label"><span>${title}</span>${count > 1 ? `<small>${count} ${unit}</small>` : ''}</p>${blocksHtml}</div>`;

  global.LedgerBlueprints = { SectionRuleFields, SORT_LABELS, YearBreakdown, EntryForm, SubEntryForm, EditEntryForm, SubsectionForm, SectionForm, SubEntryRow, EntryRow, CategoryBlock, TypeSection, CurrencyPanel, YearKpiCard, YearTabs, MonthSummary, MonthBlock, MonthGroup };
})(typeof globalThis !== 'undefined' ? globalThis : window);
