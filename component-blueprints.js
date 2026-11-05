// Ledger blueprints: pure functions from (data, state, ctx) → HTML string, one per level of the hierarchy.
// The markup is lifted verbatim from the original inline templates so the CSS grid contract is unchanged:
//   .ledger-panel > .ledger-sections > details.ledger-type-section > details.ledger-cat > .ledger-entries > .ledger-entry-cell
// `ctx` carries the app's formatting helpers (fmt, esc, dayLabel, keyOf, catKey) so the blueprints have no globals.
// `state` is { expandedEntries, entryDraft, subEntryDraftParentId, ledgerDraft } — the inline-edit state the UI reflects.
(function (global) {
  const daysIn = mKey => new Date(Number(mKey.slice(0, 4)), Number(mKey.slice(5, 7)), 0).getDate();
  // Panels of a special event use the key "ev:<id>": their entries can fall in any month, so they carry a full date.
  const isEventKey = mKey => String(mKey).startsWith('ev:');
  // The year card uses "yr:<year>": it shows every month's entries, each still in (and edited within) its own month.
  const isYearKey = mKey => String(mKey).startsWith('yr:');
  const dateField = (mKey, value, { required = true, label = 'Day of month' } = {}) => (isEventKey(mKey)
    ? `<input name="date" type="date" value="${value || ''}" aria-label="Date"${required ? ' required' : ''}>`
    : `<input name="day" enterkeyhint="next" type="number" min="1" max="${daysIn(isYearKey(mKey) ? String(value).slice(0, 7) : mKey)}" step="1" inputmode="numeric" ${value ? `value="${Number(value.slice(8, 10))}"` : 'placeholder="DD" '} aria-label="${label}"${required ? ' required' : ''}>`);
  const dateText = (mKey, date, ctx) => (isEventKey(mKey) || isYearKey(mKey) ? ctx.dayLabel(date) : date.slice(8, 10));
  // The notes an entry shows: in a month, those dated in it; in the year card, those dated in the year; in an event, all.
  const notesShownIn = (mKey, sub) => isEventKey(mKey) || sub.date.startsWith(isYearKey(mKey) ? mKey.slice(3) : mKey);

  // The colour of an amount: its type's, except in a balance section ('net'), where zero or more is income and less is an expense.
  const toneOf = (type, amount) => (type === 'net' ? (Number(amount) < 0 ? 'expense' : 'income') : type);
  // A part's share of a whole, in whole percent (sizes compared, so a custom section's negative amounts share too).
  const shareOf = (part, whole) => (whole ? Math.round(Math.abs(part) / Math.abs(whole) * 100) : 0);
  // In the year card, how many months a subsection (or a section) has entries in: a small grey ×N after its name.
  const MonthsUsed = count => (!count ? '' : `<small class="ledger-months-used" title="Has entries in ${count} ${count === 1 ? 'month' : 'months'} of the year">×${count}</small>`);
  const monthsOf = categories => new Set(categories.flatMap(category => (category._meta.months || []).map(item => item.month))).size;
  // A custom section's amounts show without a minus sign: red already says it is negative. Editing still shows the sign.
  const amountText = (type, amount, property, ctx) => ctx.fmt(type === 'net' ? Math.abs(Number(amount)) : amount, property);
  const signed = (minor, property, ctx) => `${Number(minor) < 0 ? '−' : ''}${ctx.fmt(Math.abs(Number(minor)), property)}`;

  // The two blocks a custom section can live in. A month has exactly one of each: every settlement sits inside
  // Settlements and every pot inside Savings, instead of each one standing on its own beside Income and Expenses.
  const GROUPS = {
    settlement: {
      kind: 'settlement', title: 'Settlements', icon: 'ti-arrows-exchange', one: 'settlement',
      blurb: 'Money shared with someone: a split bill, a loan, someone putting money into you.',
      empty: 'No settlements this month.'
    },
    savings: {
      kind: 'savings', title: 'Savings', icon: 'ti-pig-money', one: 'savings pot',
      blurb: 'What you set aside, take back out, and what it earns.',
      empty: 'No savings recorded this month.'
    }
  };
  const groupOf = section => GROUPS[section?._meta?.kind] || GROUPS.settlement;
  // What each subsection of a settlement or a pot stands for; the short word rides beside its name so a glance says
  // whether a row is money that moved or a note explaining the split.
  const ROLE_TAGS = {
    cost: { short: 'paid', title: 'Paid for the group — real money out (or back in)' },
    share: { short: 'my share', title: 'My own share of the cost — a note, not a movement of money' },
    settle: { short: 'settled', title: 'Money between me and the other side — they paid me (+) or I paid them (−)' },
    save: { short: 'in / out', title: 'Put into the pot (+) or taken back out (−)' },
    return: { short: 'gain', title: 'Interest, dividend or gain the pot earned — counted as real income' }
  };
  const RoleTag = role => (ROLE_TAGS[role] ? `<small class="ledger-role is-${role}" title="${ROLE_TAGS[role].title}">${ROLE_TAGS[role].short}</small>` : '');

  // ---- descriptions ---------------------------------------------------------------------------
  // A row that carries a description shows the smallest mark that can still be aimed at: a dot. Clicking it opens the
  // description beside the row, read-only, with a padlock to unlock it for editing. The dot takes the colour of the
  // row's status word, so a glance down a column already says what is paid and what is still due.
  const store = () => global.ExpenseStore;
  const statusOf = about => (store()?.readStatus ? store().readStatus(about) : null);
  // A line of its own that reads "=paid" → a capsule. Known words are coloured by what they mean, not how spelled.
  const StatusCapsule = (about, ctx) => {
    const status = statusOf(about);
    return status ? `<small class="ledger-status is-${status.tone}" title="Status from the description: ${ctx.esc(status.word)}">${ctx.esc(status.word)}</small>` : '';
  };
  // The dot. A span, not a button: it sits inside <summary> and inside the entry row's own button, where a nested
  // button would be invalid, so the click handler picks it out by data-about instead.
  const AboutMark = (about, scope, ctx) => {
    if (!about) return '';
    const status = statusOf(about);
    const plain = store()?.statusless ? store().statusless(about) : String(about);
    const first = plain.trim().split('\n')[0] || (status ? status.word : '');
    return `<span class="about-mark${status ? ` is-${status.tone}` : ''}" data-about="${ctx.esc(JSON.stringify(scope))}" role="img" aria-label="Has a description" title="${ctx.esc(first.length > 90 ? `${first.slice(0, 90)}…` : first)}"></span>`;
  };
  // A description's mark and its status word together, in the order a row reads: status first, then the dot.
  const AboutTags = (about, scope, ctx) => `${StatusCapsule(about, ctx)}${AboutMark(about, scope, ctx)}`;

  // ---- a settlement's or a pot's lifecycle ------------------------------------------------------
  // Draft → Open → Clear → Settled → Merged. Worked out from what the section holds (see ExpenseStore.sectionState),
  // so it can never disagree with its entries.
  const StateCapsule = (meta, ctx) => {
    const state = store()?.sectionState ? store().sectionState(meta) : null;
    return state ? `<span class="ledger-state is-${state.key}" title="${ctx.esc(state.title)}">${ctx.esc(state.label)}</span>` : '';
  };

  // The figures that say what a settlement or a pot really amounts to, under its own heading. For a settlement the
  // last cell is the one that matters: nothing outstanding means it can be closed.
  const StatStrip = (meta, property, ctx) => {
    const s = meta.settle;
    if (!s) return '';
    const cells = meta.kind === 'savings'
      ? [
        ['Put in', s.byRole?.save?.in || 0, 'income', 'Money moved into the pot'],
        ['Taken out', s.byRole?.save?.out || 0, 'expense', 'Money taken back out of the pot'],
        ['Gain', s.returns, 'income', 'Interest, dividend or gain — counted as income'],
        ['Pot', s.saved + s.returns, 'balance', 'What this pot grew by']
      ]
      : [
        ['Cash in', s.cashIn, 'income', 'Everything that came in — counted as income'],
        ['Cash out', s.cashOut, 'expense', 'Everything that went out — counted as an expense'],
        ['My share', s.share, 'expense', 'My own part of what the group spent'],
        [s.owed < 0 ? 'I owe' : 'Owed to me', Math.abs(s.owed), s.owed < 0 ? 'expense' : 'income', s.owed === 0 ? 'Nothing outstanding — this one is clear' : s.owed < 0 ? 'Still to pay the other side' : 'Still to come back to me']
      ];
    const state = meta.kind === 'savings' ? '' : s.cleared
      ? '<span class="ledger-stat-flag is-clear" title="Nothing outstanding"><i class="ti ti-circle-check" aria-hidden="true"></i>Clear</span>'
      : '<span class="ledger-stat-flag is-open" title="Still outstanding"><i class="ti ti-circle-dashed" aria-hidden="true"></i>Open</span>';
    if (cells.every(([, amount]) => !amount)) return '';
    return `<div class="ledger-stat-strip">${cells.map(([label, amount, tone, title]) => `<span class="ledger-stat" title="${ctx.esc(title)}"><small>${label}</small><b class="${tone}">${signed(amount, property, ctx)}</b></span>`).join('')}${state}</div>`;
  };

  // An amount typed as a formula shows its total, with the formula on hover. The formula rides in data-formula, not in
  // `title`: the row around it is a button with its own title, and a native tooltip inside one is unreliable, so the CSS
  // draws this one itself.
  const amountTag = (type, formula, text, ctx) =>
    `<strong class="${type}${formula ? ' has-formula' : ''}"${formula ? ` data-formula="${ctx.esc(formula)}"` : ''}>${text}</strong>`;

  // Inline forms --------------------------------------------------------------------------------
  // Save / Cancel buttons: hidden with a mouse (Enter and Esc do it), shown on touch screens, whose number pad has no Enter.
  // A Delete button, when given, shows for every pointer; it carries the data-delete-row attributes the click handler reads.
  const FormActions = (cancelAttr, deleteAttrs = '') =>
    `<span class="ledger-entry-actions">${deleteAttrs ? DeleteButton(deleteAttrs) : ''}<button type="button" class="mini-btn" ${cancelAttr} aria-label="Cancel" title="Cancel"><i class="ti ti-x" aria-hidden="true"></i><span>Cancel</span></button><button type="submit" class="mini-btn is-save" aria-label="Save" title="Save"><i class="ti ti-check" aria-hidden="true"></i><span>Save</span></button></span>`;
  const DeleteButton = attrs =>
    `<button type="button" class="mini-btn is-delete" ${attrs} aria-label="Delete" title="Delete"><i class="ti ti-trash" aria-hidden="true"></i><span>Delete</span></button>`;
  const EntryForm = ({ mKey, property, type, category, sectionName }, ctx) =>
    `<form class="ledger-entry ledger-entry-form" data-ledger-form="entry" data-month="${mKey}" data-property="${property}" data-section="${ctx.esc(sectionName)}" data-type="${type}" data-category="${ctx.esc(category)}" novalidate>${dateField(mKey, isEventKey(mKey) ? ctx.today() : '')}<input class="ledger-entry-desc" name="description" enterkeyhint="next" maxlength="80" placeholder="Description"  aria-label="Description" autocomplete="off" required><input class="ledger-entry-place" name="place" enterkeyhint="next" maxlength="60" placeholder="Comment"  aria-label="Comment" autocomplete="off"><input name="amount" enterkeyhint="done" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Amount or =formula"  aria-label="Amount" required>${FormActions('data-cancel-entry')}</form>`;

  const SubEntryForm = ({ mKey, parentId }, ctx) =>
    `<form class="ledger-entry ledger-entry-form" data-ledger-form="sub-entry" data-parent-id="${ctx.esc(parentId)}" novalidate>${dateField(mKey, '', { required: false })}<input class="ledger-entry-desc" name="description" enterkeyhint="next" maxlength="80" placeholder="Description"  aria-label="Description" autocomplete="off" required><input class="ledger-entry-place" name="place" enterkeyhint="next" maxlength="60" placeholder="Comment"  aria-label="Comment" autocomplete="off"><input name="amount" enterkeyhint="done" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Amount or =formula"  aria-label="Amount">${FormActions('data-cancel-sub-entry')}</form>`;

  // Double-click edit: the entry's or note's own fields, prefilled, in the same columns as the row it replaces.
  const EditEntryForm = ({ mKey, item, kind }, ctx) =>
    `<form class="ledger-entry ledger-entry-form is-edit" data-ledger-form="${kind === 'note' ? 'edit-note' : 'edit-entry'}" data-entry-id="${ctx.esc(item.id)}" novalidate>${dateField(mKey, item.date)}<input class="ledger-entry-desc" name="description" enterkeyhint="next" maxlength="80" value="${ctx.esc(item.description)}" placeholder="Description" aria-label="Description" autocomplete="off" required><input class="ledger-entry-place" name="place" enterkeyhint="next" maxlength="60" value="${ctx.esc(item.place || '')}" placeholder="Comment" aria-label="Comment" autocomplete="off"><input name="amount" enterkeyhint="done" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${ctx.esc(item.formula || String(Number(item.amount) / 100))}" placeholder="Amount or =formula" aria-label="Amount" required>${FormActions('data-cancel-edit', `data-delete-row="${kind === 'note' ? 'note' : 'entry'}" data-entry-id="${ctx.esc(item.id)}"`)}</form>`;

  // Inside a settlement or a pot a subsection has to say what it stands for, because that is what decides whether its
  // amounts are money that moved or only a note about the split. Everywhere else the picker is left out.
  const ROLE_CHOICES = {
    settlement: [['cost', 'Paid for the group'], ['share', 'My share'], ['settle', 'Settled up / lent / received']],
    savings: [['save', 'Put in or taken out'], ['return', 'Interest or gain']]
  };
  const RoleField = (kind, selected, ctx) => (!ROLE_CHOICES[kind] ? '' :
    `<select class="role-select" name="role" aria-label="What this subsection stands for" title="What this subsection stands for">${ROLE_CHOICES[kind].map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${ctx.esc(label)}</option>`).join('')}</select>`);
  const SubsectionForm = ({ sectionName, kind = null, role = null }, ctx) =>
    `<form class="ledger-form sub-form${kind ? ' has-role' : ''}" data-ledger-form="subsection" novalidate><input name="name" placeholder="New subsection in ${ctx.esc(sectionName)}" maxlength="40" aria-label="New subsection name" autocomplete="off">${RoleField(kind, role, ctx)}<button type="submit" class="mini-btn is-save" aria-label="Add subsection" title="Add (Enter)"><i class="ti ti-check" aria-hidden="true"></i></button><button type="button" class="mini-btn" data-cancel-draft aria-label="Cancel" title="Cancel (Esc)"><i class="ti ti-x" aria-hidden="true"></i></button><p class="ledger-form-hint" aria-live="polite"></p></form>`;

  // A new balance section beside Income and Expenses: just its name. Its entries may be negative.
  // Whether a custom section's result goes to the month's income and expenses (see ExpenseStore.sectionCalc): asked when it
  // is made, and in Month settings and Section setup later. The equations are written in Section setup.
  const SIDE_MODES = [['count', 'Show and add to total'], ['show', 'Show only'], ['off', "Don't show"]];
  const SideModeField = (type, mode, ctx) =>
    `<label><span>${type === 'income' ? 'Income' : 'Expenses'}</span><select name="${type}" data-side-mode="${type}" aria-label="${type === 'income' ? 'Income' : 'Expenses'}: show and count">${SIDE_MODES.map(([value, label]) => `<option value="${value}"${mode === value ? ' selected' : ''}>${ctx.esc(label)}</option>`).join('')}</select></label>`;
  const SectionRuleFields = (rule = { expense: { mode: 'count' }, income: { mode: 'off' } }, ctx) =>
    `<div class="section-rule">${SideModeField('expense', rule.expense.mode, ctx)}${SideModeField('income', rule.income.mode, ctx)}</div>`;
  // A new settlement or pot inside its block. It comes ready to count realistically — everything in as income,
  // everything out as an expense for a settlement; only the gain for a pot — so there is nothing to set up first.
  const SectionForm = ({ kind = 'settlement' }, ctx) => {
    const group = GROUPS[kind] || GROUPS.settlement;
    return `<form class="ledger-form sub-form section-form" data-ledger-form="section" data-kind="${group.kind}" novalidate><input name="name" placeholder="New ${ctx.esc(group.one)} (amounts may be negative)" maxlength="40" aria-label="New ${ctx.esc(group.one)} name" autocomplete="off"><input type="hidden" name="kind" value="${group.kind}"><button type="submit" class="mini-btn is-save" aria-label="Add ${ctx.esc(group.one)}" title="Add (Enter)"><i class="ti ti-check" aria-hidden="true"></i></button><button type="button" class="mini-btn" data-cancel-draft aria-label="Cancel" title="Cancel (Esc)"><i class="ti ti-x" aria-hidden="true"></i></button><p class="ledger-form-hint" aria-live="polite">${ctx.esc(group.blurb)}</p></form>`;
  };

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
  // A tagged row has a 1px line at its left in its tags' colours (split evenly between them, top to bottom).
  const tagLine = (row, ctx) => {
    const search = global.LedgerSearch;
    const tags = search ? search.rowTags(row, `${row.description} ${row.place || ''}`) : [];
    if (!tags.length) return '';
    const step = 100 / tags.length;
    const stops = tags.map((tag, i) => `var(--tag${search.tagColour(tag)}) ${(i * step).toFixed(2)}% ${((i + 1) * step).toFixed(2)}%`).join(', ');
    return ` data-tags="${ctx.esc(tags.map(tag => `#${tag}`).join(' '))}" style="--tag-line: linear-gradient(${stops})"`;
  };
  // #hashtags in a description or comment show as tags; a click opens that tag's summary.
  // A row in a flow carries a small ⇄ in the flow's colour before its description; a click opens the flow.
  const FlowMark = (id, ctx) => {
    const flow = id && ctx.flow ? ctx.flow(id) : null;
    return flow ? `<span class="flow-mark tag-c${flow.colour}" data-flow-mark="${ctx.esc(id)}" title="Flow: ${ctx.esc(flow.name)} · click to open it"><i class="ti ti-arrows-exchange" aria-hidden="true"></i><span class="sr-only">Flow ${ctx.esc(flow.name)}</span></span>` : '';
  };
  const tagged = (text, ctx) => (global.LedgerSearch ? global.LedgerSearch.markTags(ctx.esc(text)) : ctx.esc(text));
  // `tail` (a status capsule and the description dot) goes inside the description cell, not beside it: the row is a
  // grid whose columns are exactly time / description / comment / amount, and an extra child would shift them all.
  const descAndComment = (description, comment, ctx, lead = '', tail = '') => {
    const text = `${lead}${tagged(description, ctx)}`;
    const body = tail ? `<span class="entry-text">${text}</span>${tail}` : text;
    const cls = tail ? ' has-tail' : '';
    return comment
      ? `<span class="ledger-entry-desc${cls}">${body}</span><span class="ledger-entry-place">${tagged(comment, ctx)}</span>`
      : `<span class="ledger-entry-desc is-wide${cls}">${body}</span>`;
  };

  // Level 6: sub-entry row ----------------------------------------------------------------------
  const SubEntryRow = (sub, { mKey, type, property }, state, ctx) => (state.editDraft?.kind === 'note' && state.editDraft.id === sub.id)
    ? EditEntryForm({ mKey, item: sub, kind: 'note' }, ctx)
    : `<div class="ledger-entry-cell ledger-sub-entry" data-note-id="${ctx.esc(sub.id)}"${tagLine(sub, ctx)}><div class="ledger-entry-line"><span class="ledger-entry"><time datetime="${sub.date}">${dateText(mKey, sub.date, ctx)}</time>${descAndComment(sub.description, sub.place, ctx, FlowMark(sub.flow, ctx), AboutTags(sub.about, { kind: 'note', id: sub.id }, ctx))}${amountTag(toneOf(type, sub.amount), sub.formula, amountText(type, sub.amount, property, ctx), ctx)}</span></div></div>`;

  // Level 5: entry row, with its sub-entries and sub-entry form when expanded -------------------
  const EntryRow = (entry, { mKey, type, property, order = null }, state, ctx) => {
    const isExpanded = state.expandedEntries.has(entry.id);
    // In a month, a note dated in another month is not drawn here; an event shows all of an entry's notes.
    const shown = entry.subEntries.filter(sub => notesShownIn(mKey, sub));
    const subItems = byNotes[order] ? [...shown].sort(byNotes[order]) : shown;
    const hasSubItems = subItems.length > 0;
    const showingSubEntryForm = state.subEntryDraftParentId === entry.id;
    const subEntriesHtml = subItems.map(sub => SubEntryRow(sub, { mKey, type, property }, state, ctx)).join('');
    const subEntryForm = showingSubEntryForm ? SubEntryForm({ mKey, parentId: entry.id }, ctx) : '';
    // Notes are always in the DOM and only shown or hidden, so opening an entry needs no re-render.
    const notes = (hasSubItems || subEntryForm) ? `<div class="ledger-notes"${isExpanded || subEntryForm ? '' : ' hidden'}>${subEntryForm}${subEntriesHtml}</div>` : '';
    if (state.editDraft?.kind === 'entry' && state.editDraft.id === entry.id) {
      return `<div class="ledger-entry-cell">${EditEntryForm({ mKey, item: entry, kind: 'entry' }, ctx)}${notes}</div>`;
    }
    return `<div class="ledger-entry-cell"${tagLine(entry, ctx)}><div class="ledger-entry-line${hasSubItems ? ' has-notes' : ''}"><button type="button" class="ledger-entry ledger-entry-toggle" data-toggle-entry data-entry-id="${ctx.esc(entry.id)}" aria-expanded="${isExpanded}" title="${ctx.esc(ctx.dayLabel(entry.date))} · ${ctx.esc(entry.description)}${entry.place ? ` · ${ctx.esc(entry.place)}` : ''}${hasSubItems ? ` · ${subItems.length} ${subItems.length === 1 ? 'note' : 'notes'}` : ''}"><time datetime="${entry.date}">${dateText(mKey, entry.date, ctx)}</time>${descAndComment(entry.description, entry.place, ctx, FlowMark(entry.flow, ctx), AboutTags(entry.about, { kind: 'entry', id: entry.id }, ctx))}${amountTag(toneOf(type, entry._meta.total), entry._meta.children ? null : entry.formula, amountText(type, entry._meta.total, property, ctx), ctx)}</button></div>${notes}</div>`;
  };

  // Level 4: category (collapsible) -------------------------------------------------------------
  const entryDraftMatches = (d, { mKey, property, sectionName, name }) =>
    Boolean(d && d.month === mKey && d.property === property && d.section === sectionName && d.category === name);

  // In the year card a subsection lists its months, newest first: each month's name, how many entries and what they came
  // to, closed until clicked, like a section or a subsection. Opened, it shows that month's entries as in the month, and a
  // link that opens the month itself there. A month holding an entry or note being edited stays open.
  const YearEntries = (key, name, category, { mKey, type, property }, state, ctx) => {
    const year = mKey.slice(3);
    const editing = state.editDraft && ['entry', 'note'].includes(state.editDraft.kind) ? state.editDraft.id : null;
    const byMonth = [...category._meta.months].sort((a, b) => b.month - a.month);
    return byMonth.map(({ month, total, entries: count }) => {
      const own = category.entries.filter(entry => entry.month === month).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
      const monthName = global.ExpenseStore.MONTH_NAMES[month];
      const open = Boolean(editing) && own.some(entry => entry.id === editing || entry.subEntries.some(sub => sub.id === editing));
      const jump = `<button type="button" class="ledger-month-jump" data-year-jump="${year}-${String(month + 1).padStart(2, '0')}" data-property="${property}" data-category="${ctx.esc(name)}" title="Open ${ctx.esc(monthName)} ${year} at ${ctx.esc(name)}"><i class="ti ti-external-link" aria-hidden="true"></i>Open ${ctx.esc(monthName)} ${year}</button>`;
      return `<details class="ledger-year-month" data-key="${ctx.esc(key)}|m${month}"${open ? ' open' : ''}><summary class="ledger-month-from"><i class="ti ti-chevron-right" aria-hidden="true"></i><span class="ledger-month-name">${ctx.esc(monthName)}</span><small>${count} ${count === 1 ? 'entry' : 'entries'}</small><strong${type === 'net' ? ` class="${toneOf(type, total)}"` : ''}>${amountText(type, total, property, ctx)}</strong></summary><div class="ledger-year-month-body">${jump}${own.map(entry => EntryRow(entry, { mKey, type, property }, state, ctx)).join('')}</div></details>`;
    }).join('');
  };

  // In the year card, what a subsection went on: its entries' notes (or the entries themselves) added up by description
  // over the year, each with its share of the subsection, how many and in how many months. Closed until opened. A
  // double-click on a description renames it in every entry and note of the year (not in an event's ★ section).
  const YearItems = (key, name, category, { mKey, type, property, sectionName, eventId }, state, ctx) => {
    const items = category._meta.items || [];
    if (!items.length) return '';
    const e = state.editDraft;
    const renamingKey = e?.kind === 'year-item' && e.month === mKey && e.property === property && e.type === type && e.section === sectionName && e.category === name ? e.item : null;
    const rows = items.map(item => {
      const share = shareOf(item.total, category._meta.total);
      const canRename = !eventId && item.key !== '—';
      const label = renamingKey === item.key
        ? `<form class="ledger-item-form" data-ledger-form="rename-year-item" data-month="${mKey}" data-property="${property}" data-type="${type}" data-section="${ctx.esc(sectionName)}" data-category="${ctx.esc(name)}" data-item="${ctx.esc(item.key)}" data-name="${ctx.esc(item.name)}" data-count="${item.count}" novalidate><input name="name" value="${ctx.esc(item.name)}" maxlength="80" aria-label="New name for ${ctx.esc(item.name)}, in every month of ${mKey.slice(3)}" autocomplete="off" spellcheck="false" enterkeyhint="done"><p class="ledger-form-hint" aria-live="polite">Renames it in every entry and note of ${mKey.slice(3)}</p></form>`
        : `<span class="ledger-item-name">${ctx.esc(item.name)}</span>`;
      return `<li class="ledger-item${renamingKey === item.key ? ' is-renaming' : ''}"${canRename ? ` data-year-item="${ctx.esc(item.key)}"` : ''} title="${ctx.esc(item.name)} · ${item.count} ${item.count === 1 ? 'time' : 'times'} in ${item.months} ${item.months === 1 ? 'month' : 'months'}${canRename ? ' · double-click to rename' : ''}">${label}<span class="ledger-share-bar" aria-hidden="true"><i style="width:${Math.max(share, 1)}%"></i></span><small class="ledger-item-count">${item.count}× · ${item.months} mo</small><span class="ledger-share">${share}%</span><strong class="${toneOf(type, item.total)}">${amountText(type, item.total, property, ctx)}</strong></li>`;
    }).join('');
    return `<details class="ledger-year-items" data-key="${ctx.esc(key)}|items"${renamingKey ? ' open' : ''}><summary><i class="ti ti-chevron-right" aria-hidden="true"></i><span>By description</span><small>${items.length}</small></summary><ul>${rows}</ul></details>`;
  };

  const CategoryBlock = (name, category, { mKey, type, property, sectionName, eventId, share = null, role = null, about = '' }, state, ctx) => {
    const key = ctx.catKey(mKey, property, type, eventId ? `${eventId}:${name}` : name);
    const inYear = isYearKey(mKey);
    const order = inYear ? null : state.sortModes?.[key] || null;
    const entries = inYear ? YearItems(key, name, category, { mKey, type, property, sectionName, eventId }, state, ctx) + YearEntries(key, name, category, { mKey, type, property }, state, ctx) : [...category.entries]
      .sort(byEntries[order] || ((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)))
      .map(entry => EntryRow(entry, { mKey, type, property, order }, state, ctx))
      .join('');
    // The sort buttons sit on the subsection's own line, straight after its name (and its event's section name). They
    // show only where there is something to order: two entries, or an entry with two notes. The year card keeps its
    // month-by-month order.
    const sortable = !inYear && (category.entries.length > 1 || category.entries.some(entry => entry.subEntries.filter(sub => notesShownIn(mKey, sub)).length > 1));
    const draftHere = entryDraftMatches(state.entryDraft, { mKey, property, sectionName, name });
    const e = state.editDraft;
    // In the year card a subsection is a row per section, so the section must match too.
    if (e?.kind === 'category' && e.month === mKey && e.property === property && e.type === type && e.category === name && (!inYear || e.section === sectionName)) {
      return `<div class="ledger-cat is-editing" data-key="${ctx.esc(ctx.catKey(mKey, property, type, name))}"><form class="ledger-form cat-rename-form" data-ledger-form="rename-category" data-month="${mKey}" data-property="${property}" data-type="${type}" data-section="${ctx.esc(sectionName)}" data-category="${ctx.esc(name)}" novalidate><input name="name" value="${ctx.esc(name)}" maxlength="40" aria-label="Subsection name" autocomplete="off"><strong${type === 'net' ? ` class="${toneOf(type, category._meta.total)}"` : ''}>${amountText(type, category._meta.total, property, ctx)}</strong><p class="ledger-form-hint" aria-live="polite">${inYear ? `Renames it in every month of ${mKey.slice(3)}` : ''}</p>${inYear ? '' : `<span class="ledger-entry-actions">${DeleteButton(`data-delete-row="category" data-month="${mKey}" data-property="${property}" data-type="${type}" data-section="${ctx.esc(sectionName)}" data-category="${ctx.esc(name)}"`)}</span>`}</form><div class="ledger-entries">${entries}</div></div>`;
    }
    // A subsection with nothing under it shows no arrow, so the arrow always means there is something to open.
    // An event's subsection shown inside a month is read-only there (data-event-id); it is edited in the event.
    const eventAttr = eventId ? ` data-event-id="${ctx.esc(eventId)}" title="From the event ${ctx.esc(sectionName.replace(/^★ /, ''))}; edit it in Events"` : '';
    const eventTag = eventId ? `<small class="ledger-cat-event"><i class="ti ti-star-filled" aria-hidden="true"></i>${ctx.esc(sectionName.replace(/^★ /, ''))}</small>` : '';
    return `<details class="ledger-cat${category.entries.length || draftHere ? '' : ' is-empty'}${eventId ? ' is-event-cat' : ''}" data-key="${ctx.esc(key)}" data-section="${ctx.esc(sectionName)}"${eventAttr}><summary><i class="ti ti-chevron-right" aria-hidden="true"></i><span class="ledger-cat-title"><span class="ledger-cat-name">${ctx.esc(name)}</span>${RoleTag(role)}${AboutTags(about, { kind: 'subsection', mKey, property, type, section: sectionName, category: name }, ctx)}${inYear ? MonthsUsed(category._meta.months.length) : ''}${eventTag}${sortable ? SortButtons(key, order, name, ctx) : ''}</span>${share === null ? '' : `<span class="ledger-share" title="Share of its section">${share}%</span>`}<strong${type === 'net' ? ` class="${toneOf(type, category._meta.total)}"` : ''}>${amountText(type, category._meta.total, property, ctx)}</strong></summary><div class="ledger-entries">${draftHere ? EntryForm({ mKey, property, type, category: name, sectionName }, ctx) : ''}${entries}</div></details>`;
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
        if (category.entries.length || section._meta.subsections.includes(name) || entryDraftMatches(state.entryDraft, { mKey, property, sectionName, name })) categories.push({ name, category, sectionName, eventId, section, role: section._meta.roles?.[name] || null, about: section._meta.subAbout?.[name] || '' });
      });
    });
    // The balance a month brings in is shown as its own line: under Income when positive, under Expenses when negative.
    const carryHtml = carry ? `<div class="ledger-carry" title="Previous balance brought into this ${isYearKey(mKey) ? 'year' : 'month'}"><i class="ti ti-arrow-forward-up" aria-hidden="true"></i><span>Brought forward from ${ctx.esc(carry.from)}</span><strong class="${type}">${ctx.fmt(carry.amount, property)}</strong></div>` : '';
    const balancesHtml = balances.map(({ label, amount, counted = true }) => `<div class="ledger-carry is-balance${counted ? '' : ' is-shown-only'}" title="${ctx.esc(label)}, ${counted ? `counted as ${type === 'income' ? 'income' : 'an expense'}` : 'shown only, not added to the total'}"><i class="ti ti-arrows-exchange" aria-hidden="true"></i><span>${ctx.esc(label)}</span><strong class="${type}">${amount < 0 ? '−' : ''}${ctx.fmt(Math.abs(amount), property)}</strong></div>`).join('');
    const total = categories.reduce((sum, { category }) => sum + category._meta.total, 0) + (carry ? carry.amount : 0) + balances.reduce((sum, { amount, counted = true }) => sum + (counted ? amount : 0), 0);
    const inYear = isYearKey(mKey);
    const typeKey = [mKey, property, type, heading?.section || ''].join('|');
    const e = state.editDraft;
    // The year card renames a section (in every month) from a field: at the top of its block, or in place of its heading
    // where a block holds several sections.
    const YearSectionForm = section => `<form class="ledger-form cat-rename-form year-section-form" data-ledger-form="rename-year-section" data-month="${mKey}" data-property="${property}" data-type="${type}" data-section="${ctx.esc(section)}" novalidate><input name="name" value="${ctx.esc(section)}" maxlength="40" aria-label="Section name" autocomplete="off"><p class="ledger-form-hint" aria-live="polite">Renames the section “${ctx.esc(section)}” in every month of ${mKey.slice(3)}</p></form>`;
    const sumOf = list => list.reduce((sum, { category }) => sum + category._meta.total, 0);
    // In the year card each subsection shows its share of its section.
    const categoryRows = (list, whole) => [...list]
      .sort((a, b) => b.category._meta.total - a.category._meta.total)
      .map(({ name, category, sectionName, eventId, role, about }) => CategoryBlock(name, category, { mKey, type, property, sectionName, eventId, role, about, share: inYear ? shareOf(category._meta.total, whole) : null }, state, ctx))
      .join('');
    // A year card's Income or Expenses block that holds several sections shows each under its own heading, with its share
    // of the block (a double-click renames it); with one section, its subsections stand straight under the block.
    const grouped = inYear && !heading && sections.filter(section => categories.some(item => item.section === section)).length > 1;
    const categoriesHtml = !grouped ? categoryRows(categories, sumOf(categories)) : sections.map(section => {
      const own = categories.filter(item => item.section === section);
      if (!own.length) return '';
      const name = section._meta.id;
      const sectionTotal = sumOf(own);
      const rows = categoryRows(own, sectionTotal);
      if (e?.kind === 'year-section' && e.month === mKey && e.property === property && e.type === type && e.group === name) return `<div class="ledger-year-group is-renaming">${YearSectionForm(name)}${rows}</div>`;
      const renamable = !section._meta.event;
      return `<details class="ledger-year-group" data-key="${ctx.esc(`${typeKey}|${name}`)}" open><summary${renamable ? ` data-year-section="${ctx.esc(name)}"` : ''} title="${ctx.esc(name)}${renamable ? ' · double-click to rename it in every month' : ''}"><i class="ti ti-chevron-right" aria-hidden="true"></i><span class="ledger-cat-title"><span class="ledger-year-group-name">${ctx.esc(name)}</span>${MonthsUsed(monthsOf(own.map(item => item.category)))}</span><span class="ledger-share" title="Share of ${type === 'income' ? 'Income' : 'Expenses'}">${shareOf(sectionTotal, sumOf(categories))}%</span><strong class="${toneOf(type, sectionTotal)}">${amountText(type, sectionTotal, property, ctx)}</strong></summary><div>${rows}</div></details>`;
    }).join('');
    const l = state.ledgerDraft;
    const draftSection = l && l.month === mKey && l.property === property ? sections.find(section => section._meta.id === l.section) : null;
    const subForm = draftSection
      ? SubsectionForm({ sectionName: l.section, kind: draftSection._meta.kind || null, role: l.role || null }, ctx)
      : '';
    const title = heading ? ctx.esc(heading.title) : type === 'income' ? 'Income' : 'Expenses';
    // Income and Expenses start closed (a month opens on just these headings); an open form keeps its block open, and
    // the app reopens the blocks that were open before a redraw (data-key).
    const renaming = e?.kind === 'year-section' && e.month === mKey && e.property === property && e.type === type && !e.group && e.block === (heading?.section || '');
    const renameForm = renaming ? YearSectionForm(e.section) : '';
    // Set up and Close sit on the heading itself, beside the name, rather than on a line of their own underneath.
    // A <summary> is awkward ground for a button — the keyboard reaches the summary, not what is inside it — so the
    // same two actions are also in this row's menu (right-click or double-tap), which is the keyboard-reachable way in.
    // A subsection's sort buttons already live in a <summary> here, so this is the pattern the ledger already uses.
    const meta = heading?.meta || null;
    const live = type === 'net' && heading && !isYearKey(mKey);
    // In a month, a settlement or a pot is renamed in place: its entries follow it, here and nowhere else.
    const ownRename = live && meta && e?.kind === 'section' && e.month === mKey && e.property === property && e.section === heading?.section
      ? `<form class="ledger-form cat-rename-form section-rename-form" data-ledger-form="rename-section" data-month="${mKey}" data-property="${property}" data-type="${type}" data-section="${ctx.esc(heading.section)}" novalidate><input name="name" value="${ctx.esc(heading.section)}" maxlength="40" aria-label="Name for this ${meta.kind === 'savings' ? 'savings pot' : 'settlement'}" autocomplete="off"><p class="ledger-form-hint" aria-live="polite">Renames it in this month; its entries follow it</p></form>`
      : '';
    const open = Boolean(subForm) || Boolean(renameForm) || Boolean(ownRename) || categoriesHtml.includes('data-ledger-form=');
    const setupButton = live ? `<button type="button" class="mini-btn section-setup-btn" data-section-setup="${ctx.esc(heading.section)}" data-month="${mKey}" data-property="${property}" aria-label="Set up how ${title} counts" title="Set up how this section and its subsections count"><i class="ti ti-adjustments-horizontal" aria-hidden="true"></i><span>Set up</span></button>` : '';
    // Closing one off is the point of a settlement: it is done, it stays in the figures, and it stops taking entries
    // until it is opened again. Whether it is clear or still outstanding is on the button, so closing is never blind.
    const closeButton = live && meta ? (meta.closed
      ? `<button type="button" class="mini-btn section-open-btn" data-section-close="${ctx.esc(heading.section)}" data-month="${mKey}" data-property="${property}" data-to="open" title="Open ${ctx.esc(title)} again so it takes entries"><i class="ti ti-lock-open" aria-hidden="true"></i><span>Reopen</span></button>`
      : `<button type="button" class="mini-btn section-close-btn${meta.settle?.cleared === false ? ' is-unsettled' : ''}" data-section-close="${ctx.esc(heading.section)}" data-month="${mKey}" data-property="${property}" data-to="closed" title="${meta.settle?.cleared === false ? 'Still outstanding — closing will ask first' : 'Nothing outstanding — close it off'}"><i class="ti ti-lock" aria-hidden="true"></i><span>Close</span></button>`) : '';
    const mergedNote = meta?.mergedFrom?.length ? `<p class="ledger-merged-note" title="Closed sections brought together here"><i class="ti ti-arrow-merge" aria-hidden="true"></i>Merged from ${meta.mergedFrom.map(from => ctx.esc(from)).join(', ')}</p>` : '';
    const statStrip = meta && type === 'net' ? StatStrip(meta, property, ctx) : '';
    const blockTools = setupButton || closeButton ? `<div class="ledger-block-tools">${setupButton}${closeButton}</div>` : '';
    if (heading?.bare) {
      return `<div class="ledger-type-section is-bare" data-type="${type}" data-section="${ctx.esc(heading.section)}"><div>${subForm}${categoriesHtml || (subForm ? '' : `<p class="ledger-none">Nothing yet. Press and hold ${heading.panel} above to add a subsection.</p>`)}</div></div>`;
    }
    // Where this settlement or pot stands, and its own description, beside its name.
    const lifeState = meta?.kind && store()?.sectionState ? store().sectionState(meta) : null;
    const stateBadge = lifeState ? StateCapsule(meta, ctx) : '';
    const aboutBadge = meta?.kind && heading ? AboutTags(meta.about, { kind: 'section', mKey, property, type, section: heading.section }, ctx) : '';
    const emptyNote = heading
      ? (meta?.closed ? 'Closed with nothing in it.' : 'Nothing yet. Press and hold the name above to add a subsection.')
      : 'Nothing recorded';
    return `<details class="ledger-type-section${heading ? ' is-named' : ''}${meta?.kind ? ` is-${meta.kind}` : ''}${meta?.closed ? ' is-closed' : ''}" data-type="${type}" data-key="${ctx.esc(typeKey)}"${heading ? ` data-section="${ctx.esc(heading.section)}"` : ''}${meta?.kind ? ` data-kind="${meta.kind}"` : ''}${lifeState ? ` data-state="${lifeState.key}"` : ''}${meta?.closed ? ' data-closed="true"' : ''} ${open ? 'open' : ''}><summary><i class="ti ti-chevron-right ledger-type-caret" aria-hidden="true"></i><strong>${title}</strong>${stateBadge}${aboutBadge}${blockTools}${type === 'net' && sections[0]?._meta.stats ? SectionTotals(sections[0]._meta.stats, property, ctx) : `<span class="${toneOf(type, total)}">${amountText(type, total, property, ctx)}</span>`}</summary><div>${ownRename}${statStrip}${mergedNote}${renameForm}${carryHtml}${balancesHtml}${subForm}${categoriesHtml || (subForm || carryHtml || balancesHtml ? '' : `<p class="ledger-none">${emptyNote}</p>`)}</div></details>`;
  };

  // Level 3: the one Settlements block, or the one Savings block, with every section of that kind inside it.
  // There is never more than one of each: a settlement is not a sibling of Income and Expenses any more, it is a
  // section inside Settlements, so the panel reads Expenses / Income / Settlements / Savings and nothing else.
  // Closed sections fold away into "Settled" at the bottom, where two or more of them can be merged into one.
  const GroupBlock = (kind, sections, { mKey, property, title }, state, ctx) => {
    const group = GROUPS[kind];
    const heading = title || group.title;
    const l = state.ledgerDraft;
    const newForm = l?.newSection === kind && l.month === mKey && l.property === property ? SectionForm({ kind }, ctx) : '';
    const live = !isYearKey(mKey) && !isEventKey(mKey);
    // The block is not part of a month until it is asked for: with nothing in it and nothing being added, it is not
    // drawn at all. The first one is added from the currency header (press and hold, or its row menu).
    if (!sections.length && !newForm) return '';
    const open = sections.filter(section => !section._meta.closed);
    const done = sections.filter(section => section._meta.closed);
    // The block's own figures are its sections added up, each only where its own calculations set one.
    const stats = {};
    sections.forEach(section => Object.entries(section._meta.stats || {}).forEach(([field, amount]) => { if (amount !== undefined) stats[field] = (stats[field] || 0) + amount; }));
    const blockOf = section => TypeSection('net', [section], { mKey, property }, state, ctx, false, null, { title: section._meta.id, section: section._meta.id, meta: section._meta });
    // No Add button here: it sat alone on a line of its own above the figures and left the block looking lopsided.
    // A new one is added the way the first one was — hold this block's heading, or the currency header, or their
    // row menus. Merge only appears when there is actually something to merge, so the row is never empty.
    const tools = live && done.length > 1
      ? `<div class="ledger-block-tools"><button type="button" class="mini-btn" data-group-merge="${kind}" data-month="${mKey}" data-property="${property}" title="Bring closed ${ctx.esc(group.one)}s of the same sort together into one"><i class="ti ti-arrow-merge" aria-hidden="true"></i><span>Merge settled (${done.length})</span></button></div>`
      : '';
    const settledKey = ctx.esc([mKey, property, kind, 'settled'].join('|'));
    const settledHtml = !done.length ? '' : `<details class="ledger-settled" data-key="${settledKey}"><summary><i class="ti ti-chevron-right" aria-hidden="true"></i><span>Settled</span><small>${done.length}</small></summary><div>${done.map(blockOf).join('')}</div></details>`;
    // No figures of its own across the top: the heading already carries the block's income, expenses and balance, and
    // each settlement below states its own cash and what is outstanding. A third set in between only repeated them.
    // Double-clicking the heading renames the block for this month and currency.
    const e = state.editDraft;
    const renaming = live && e?.kind === 'block' && e.month === mKey && e.property === property && e.block === kind;
    const renameForm = renaming
      ? `<form class="ledger-form cat-rename-form block-rename-form" data-ledger-form="rename-block" data-month="${mKey}" data-property="${property}" data-block="${kind}" novalidate><input name="name" value="${ctx.esc(heading)}" maxlength="40" aria-label="Name for this block" autocomplete="off"><p class="ledger-form-hint" aria-live="polite">Renames this block for this month · leave it empty to go back to “${ctx.esc(group.title)}”</p></form>`
      : '';
    const body = `${renameForm}${newForm}${open.map(blockOf).join('')}${settledHtml}`;
    const totalsHtml = Object.keys(stats).length ? SectionTotals(stats, property, ctx) : '';
    const isOpen = Boolean(newForm) || Boolean(renameForm) || body.includes('data-ledger-form=');
    return `<details class="ledger-type-section is-group is-${kind}" data-type="net" data-group="${kind}" data-key="${ctx.esc([mKey, property, 'group', kind].join('|'))}" ${isOpen ? 'open' : ''}><summary><i class="ti ti-chevron-right ledger-type-caret" aria-hidden="true"></i><i class="ti ${group.icon} ledger-group-icon" aria-hidden="true"></i><strong>${ctx.esc(heading)}</strong><small class="ledger-group-count">${sections.length}</small>${tools}${totalsHtml}</summary><div>${body || `<p class="ledger-none">${group.empty}</p>`}</div></details>`;
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
    const balancesFor = type => lines.filter(line => line.type === type && line.amount);
    // Every custom section belongs to one of the two blocks, so the panel holds four at most: Expenses, Income,
    // Settlements, Savings. An event's own sections are drawn as before — an event is not a month.
    const settlements = blocks.filter(section => section._meta.type === 'net' && groupOf(section).kind === 'settlement');
    const savings = blocks.filter(section => section._meta.type === 'net' && groupOf(section).kind === 'savings');
    const other = blocks.filter(section => section._meta.type !== 'net');
    const sections = isEvent
      ? byType.expense.map((section, index) => TypeSection('expense', [section], { mKey, property }, state, ctx, true, null, { title: section._meta.id, section: section._meta.id, bare: index === 0, panel: m.name })).join('')
        + TypeSection('income', byType.income, { mKey, property }, state, ctx, true)
      : TypeSection('expense', byType.expense, { mKey, property }, state, ctx, true, carryFor('expense'), null, balancesFor('expense'))
        + TypeSection('income', byType.income, { mKey, property }, state, ctx, false, carryFor('income'), null, balancesFor('income'))
        + GroupBlock('settlement', settlements, { mKey, property, title: m.blockNames?.settlement }, state, ctx)
        + GroupBlock('savings', savings, { mKey, property, title: m.blockNames?.savings }, state, ctx)
        + other.map(section => TypeSection(section._meta.type, [section], { mKey, property }, state, ctx, false, null, { title: section._meta.id, section: section._meta.id, meta: section._meta })).join('');
    const totals = `<span class="income" title="Income">${ctx.fmt(m.income, property)}</span><span class="expense" title="Expenses">${ctx.fmt(m.expense, property)}</span><span class="balance" title="${isEvent ? 'Net: income minus expenses' : isYearKey(mKey) ? 'Closing balance at year end' : 'Closing balance at month end'}">${ctx.fmt(m.closing, property)}</span>`;
    return `<section class="ledger-panel ${m.color}" data-property="${property}" aria-label="${m.name}">
        <header class="ledger-panel-head">
          <button type="button" class="panel-expand" data-panel-expand aria-label="Expand all ${m.code} subsections" title="Expand all"><i class="ti ti-chevrons-down" aria-hidden="true"></i></button>
          <h3>${m.code}</h3>
          <div class="ledger-totals">${totals}</div>
        </header>
        <div class="ledger-sections">${sections}</div>
      </section>`;
  };

  // The selected year's tab also opens its settings, so it carries a small settings mark.
  // While the special cards and hashtags page is showing (its button sits beside the tabs), no year tab is chosen.
  const YearTabs = (years, activeYear, special = false) =>
    years.map(value => value === activeYear && !special
      ? `<button type="button" class="year-tab" data-ledger-year="${value}" aria-pressed="true" title="${value} settings">${value}<i class="ti ti-adjustments-horizontal" aria-hidden="true"></i></button>`
      : `<button type="button" class="year-tab" data-ledger-year="${value}" aria-pressed="false" title="Show ${value}">${value}</button>`).join('');

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
  // The year card (isYear) leads the list: the year's months as one ledger.
  const MonthBlock = ({ mKey, label, name, open, isNow, isFuture, isEmpty, isEvent, isYear, summaryHtml, panelsHtml, single }) =>
    `<section class="month-block${open ? ' is-open' : ''}${isNow ? ' is-now' : ''}${isFuture ? ' is-future' : ''}${isEmpty ? ' is-empty' : ''}${isEvent ? ' is-event' : ''}${isYear ? ' is-year' : ''}" data-month-key="${mKey}" aria-label="${label}">
        <header class="month-ledger-head">
          <h2><button type="button" class="month-name" data-toggle-month="${mKey}" aria-expanded="${open}" aria-controls="month-body-${mKey}" title="${open ? 'Hide' : 'Show'} ${label} · double-click for ${isEvent || isYear ? 'year' : 'month'} settings">${isEvent ? '<i class="ti ti-star-filled month-name-star" aria-hidden="true"></i>' : ''}${isYear ? '<i class="ti ti-calendar-stats month-name-star" aria-hidden="true"></i>' : ''}${name}</button></h2>
          ${summaryHtml}
        </header>
        ${open ? `<div class="ledger-panels${single ? ' is-single' : ''}" id="month-body-${mKey}">${panelsHtml}</div>` : ''}
      </section>`;

  const MonthGroup = (title, count, blocksHtml, unit = 'months') =>
    `<div class="month-group"><p class="month-group-label"><span>${title}</span>${count > 1 ? `<small>${count} ${unit}</small>` : ''}</p>${blocksHtml}</div>`;

  global.LedgerBlueprints = { SectionRuleFields, SORT_LABELS, GROUPS, ROLE_CHOICES, RoleTag, StatStrip, StatusCapsule, AboutMark, AboutTags, StateCapsule, EntryForm, SubEntryForm, EditEntryForm, SubsectionForm, SectionForm, SubEntryRow, EntryRow, CategoryBlock, TypeSection, GroupBlock, CurrencyPanel, YearTabs, MonthSummary, MonthBlock, MonthGroup };
})(typeof globalThis !== 'undefined' ? globalThis : window);
