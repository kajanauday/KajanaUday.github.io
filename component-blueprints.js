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

  // An amount typed as a formula shows its total, with the formula on hover.
  const amountTag = (type, formula, text, ctx) =>
    `<strong class="${type}${formula ? ' has-formula' : ''}"${formula ? ` title="${ctx.esc(formula)}"` : ''}>${text}</strong>`;

  // Inline forms --------------------------------------------------------------------------------
  // Save / Cancel buttons: hidden with a mouse (Enter and Esc do it), shown on touch screens, whose number pad has no Enter.
  // A Delete button, when given, shows for every pointer; it carries the data-delete-row attributes the click handler reads.
  const FormActions = (cancelAttr, deleteAttrs = '') =>
    `<span class="ledger-entry-actions">${deleteAttrs ? DeleteButton(deleteAttrs) : ''}<button type="button" class="mini-btn" ${cancelAttr} aria-label="Cancel" title="Cancel"><i class="ti ti-x" aria-hidden="true"></i><span>Cancel</span></button><button type="submit" class="mini-btn is-save" aria-label="Save" title="Save"><i class="ti ti-check" aria-hidden="true"></i><span>Save</span></button></span>`;
  const DeleteButton = attrs =>
    `<button type="button" class="mini-btn is-delete" ${attrs} aria-label="Delete" title="Delete"><i class="ti ti-trash" aria-hidden="true"></i><span>Delete</span></button>`;
  const EntryForm = ({ mKey, property, type, category, sectionName }, ctx) =>
    `<form class="ledger-entry ledger-entry-form" data-ledger-form="entry" data-month="${mKey}" data-property="${property}" data-section="${ctx.esc(sectionName)}" data-type="${type}" data-category="${ctx.esc(category)}" novalidate>${dateField(mKey, isEventKey(mKey) ? ctx.today() : '')}<input class="ledger-entry-desc" name="description" enterkeyhint="next" maxlength="80" placeholder="Description"  aria-label="Description" autocomplete="off" required><input class="ledger-entry-place" name="place" enterkeyhint="next" maxlength="60" placeholder="Place"  aria-label="Place" autocomplete="off"><input name="amount" enterkeyhint="done" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Amount or =formula"  aria-label="Amount" required>${FormActions('data-cancel-entry')}</form>`;

  const SubEntryForm = ({ mKey, parentId }, ctx) =>
    `<form class="ledger-entry ledger-entry-form" data-ledger-form="sub-entry" data-parent-id="${ctx.esc(parentId)}" novalidate>${dateField(mKey, '', { required: false })}<input class="ledger-entry-desc" name="description" enterkeyhint="next" maxlength="80" placeholder="Description"  aria-label="Description" autocomplete="off" required><input class="ledger-entry-place" name="place" enterkeyhint="next" maxlength="60" placeholder="Place"  aria-label="Place" autocomplete="off"><input name="amount" enterkeyhint="done" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Amount or =formula"  aria-label="Amount">${FormActions('data-cancel-sub-entry')}</form>`;

  // Double-click edit: the entry's or note's own fields, prefilled, in the same columns as the row it replaces.
  const EditEntryForm = ({ mKey, item, kind }, ctx) =>
    `<form class="ledger-entry ledger-entry-form is-edit" data-ledger-form="${kind === 'note' ? 'edit-note' : 'edit-entry'}" data-entry-id="${ctx.esc(item.id)}" novalidate>${dateField(mKey, item.date)}<input class="ledger-entry-desc" name="description" enterkeyhint="next" maxlength="80" value="${ctx.esc(item.description)}" placeholder="Description" aria-label="Description" autocomplete="off" required><input class="ledger-entry-place" name="place" enterkeyhint="next" maxlength="60" value="${ctx.esc(item.place || '')}" placeholder="Place" aria-label="Place" autocomplete="off"><input name="amount" enterkeyhint="done" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${ctx.esc(item.formula || String(Number(item.amount) / 100))}" placeholder="Amount or =formula" aria-label="Amount" required>${FormActions('data-cancel-edit', `data-delete-row="${kind === 'note' ? 'note' : 'entry'}" data-entry-id="${ctx.esc(item.id)}"`)}</form>`;

  const SubsectionForm = ({ sectionName }, ctx) =>
    `<form class="ledger-form sub-form" data-ledger-form="subsection" novalidate><input name="name" placeholder="New subsection in ${ctx.esc(sectionName)}" maxlength="40" aria-label="New subsection name" autocomplete="off"><button type="submit" class="mini-btn is-save" aria-label="Add subsection" title="Add (Enter)"><i class="ti ti-check" aria-hidden="true"></i></button><button type="button" class="mini-btn" data-cancel-draft aria-label="Cancel" title="Cancel (Esc)"><i class="ti ti-x" aria-hidden="true"></i></button><p class="ledger-form-hint" aria-live="polite"></p></form>`;

  // Level 6: sub-entry row ----------------------------------------------------------------------
  const SubEntryRow = (sub, { mKey, type, property }, state, ctx) => (state.editDraft?.kind === 'note' && state.editDraft.id === sub.id)
    ? EditEntryForm({ mKey, item: sub, kind: 'note' }, ctx)
    : `<div class="ledger-entry-cell ledger-sub-entry" data-note-id="${ctx.esc(sub.id)}"><div class="ledger-entry-line"><span class="ledger-entry"><time datetime="${sub.date}">${dateText(mKey, sub.date, ctx)}</time><span class="ledger-entry-desc">${ctx.esc(sub.description)}</span><span class="ledger-entry-place">${ctx.esc(sub.place || '')}</span>${amountTag(type, sub.formula, ctx.fmt(sub.amount, property), ctx)}</span></div></div>`;

  // Level 5: entry row, with its sub-entries and sub-entry form when expanded -------------------
  const EntryRow = (entry, { mKey, type, property }, state, ctx) => {
    const isExpanded = state.expandedEntries.has(entry.id);
    const subItems = entry.subEntries.filter(sub => sub.date.startsWith(mKey));
    const hasSubItems = subItems.length > 0;
    const showingSubEntryForm = state.subEntryDraftParentId === entry.id;
    const subEntriesHtml = subItems.map(sub => SubEntryRow(sub, { mKey, type, property }, state, ctx)).join('');
    const subEntryForm = showingSubEntryForm ? SubEntryForm({ mKey, parentId: entry.id }, ctx) : '';
    // Notes are always in the DOM and only shown or hidden, so opening an entry needs no re-render.
    const notes = (hasSubItems || subEntryForm) ? `<div class="ledger-notes"${isExpanded || subEntryForm ? '' : ' hidden'}>${subEntriesHtml}${subEntryForm}</div>` : '';
    if (state.editDraft?.kind === 'entry' && state.editDraft.id === entry.id) {
      return `<div class="ledger-entry-cell">${EditEntryForm({ mKey, item: entry, kind: 'entry' }, ctx)}${notes}</div>`;
    }
    return `<div class="ledger-entry-cell"><div class="ledger-entry-line${hasSubItems ? ' has-notes' : ''}"><button type="button" class="ledger-entry ledger-entry-toggle" data-toggle-entry data-entry-id="${ctx.esc(entry.id)}" aria-expanded="${isExpanded}" title="${ctx.esc(ctx.dayLabel(entry.date))} · ${ctx.esc(entry.description)}${entry.place ? ` · ${ctx.esc(entry.place)}` : ''}"><time datetime="${entry.date}">${dateText(mKey, entry.date, ctx)}</time><span class="ledger-entry-desc">${hasSubItems ? `<i class="ti ti-chevron-right ledger-entry-caret" aria-hidden="true" title="${subItems.length} ${subItems.length === 1 ? 'note' : 'notes'}"></i>` : ''}${ctx.esc(entry.description)}</span><span class="ledger-entry-place">${ctx.esc(entry.place || '')}</span>${amountTag(type, entry._meta.children ? null : entry.formula, ctx.fmt(entry._meta.total, property), ctx)}</button></div>${notes}</div>`;
  };

  // Level 4: category (collapsible) -------------------------------------------------------------
  const entryDraftMatches = (d, { mKey, property, sectionName, name }) =>
    Boolean(d && d.month === mKey && d.property === property && d.section === sectionName && d.category === name);

  const CategoryBlock = (name, category, { mKey, type, property, sectionName, eventId }, state, ctx) => {
    const entries = [...category.entries]
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
      .map(entry => EntryRow(entry, { mKey, type, property }, state, ctx))
      .join('');
    const draftHere = entryDraftMatches(state.entryDraft, { mKey, property, sectionName, name });
    const e = state.editDraft;
    if (e?.kind === 'category' && e.month === mKey && e.property === property && e.type === type && e.category === name) {
      return `<div class="ledger-cat is-editing" data-key="${ctx.esc(ctx.catKey(mKey, property, type, name))}"><form class="ledger-form cat-rename-form" data-ledger-form="rename-category" data-month="${mKey}" data-property="${property}" data-type="${type}" data-category="${ctx.esc(name)}" novalidate><input name="name" value="${ctx.esc(name)}" maxlength="40" aria-label="Subsection name" autocomplete="off"><strong>${ctx.fmt(category._meta.total, property)}</strong><p class="ledger-form-hint" aria-live="polite"></p><span class="ledger-entry-actions">${DeleteButton(`data-delete-row="category" data-month="${mKey}" data-property="${property}" data-type="${type}" data-category="${ctx.esc(name)}"`)}</span></form><div class="ledger-entries">${entries}</div></div>`;
    }
    // A subsection with nothing under it shows no arrow, so the arrow always means there is something to open.
    // An event's subsection shown inside a month is read-only there (data-event-id); it is edited in the event.
    const eventAttr = eventId ? ` data-event-id="${ctx.esc(eventId)}" title="From the event ${ctx.esc(sectionName.replace(/^★ /, ''))}; edit it in Events"` : '';
    return `<details class="ledger-cat${category.entries.length || draftHere ? '' : ' is-empty'}${eventId ? ' is-event-cat' : ''}" data-key="${ctx.esc(ctx.catKey(mKey, property, type, eventId ? `${eventId}:${name}` : name))}" data-section="${ctx.esc(sectionName)}"${eventAttr}><summary><i class="ti ti-chevron-right" aria-hidden="true"></i><span class="ledger-cat-name">${ctx.esc(name)}</span>${eventId ? `<small class="ledger-cat-event"><i class="ti ti-star-filled" aria-hidden="true"></i>${ctx.esc(sectionName.replace(/^★ /, ''))}</small>` : ''}<strong>${ctx.fmt(category._meta.total, property)}</strong></summary><div class="ledger-entries">${entries}${draftHere ? EntryForm({ mKey, property, type, category: name, sectionName }, ctx) : ''}</div></details>`;
  };

  // Level 3: Income / Expenses block. Merges every configured section of that type and shows the categories that
  // have entries (plus one being added to). A block holding an open form is forced open so the form is visible.
  const TypeSection = (type, sections, { mKey, property }, state, ctx, isOpen, carry = null) => {
    if (!sections.length && !carry) return '';
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
    const total = categories.reduce((sum, { category }) => sum + category._meta.total, 0) + (carry ? carry.amount : 0);
    const categoriesHtml = categories
      .sort((a, b) => b.category._meta.total - a.category._meta.total)
      .map(({ name, category, sectionName, eventId }) => CategoryBlock(name, category, { mKey, type, property, sectionName, eventId }, state, ctx))
      .join('');
    const l = state.ledgerDraft;
    const subForm = l && l.month === mKey && l.property === property && sections.some(section => section._meta.id === l.section)
      ? SubsectionForm({ sectionName: l.section }, ctx)
      : '';
    const title = type === 'income' ? 'Income' : 'Expenses';
    const open = isOpen || Boolean(carry) || Boolean(subForm) || categoriesHtml.includes('data-ledger-form=');
    return `<details class="ledger-type-section" data-type="${type}" ${open ? 'open' : ''}><summary><strong>${title}</strong><span class="${type}">${ctx.fmt(total, property)}</span></summary><div>${carryHtml}${subForm}${categoriesHtml || (subForm || carryHtml ? '' : '<p class="ledger-none">Nothing recorded</p>')}</div></details>`;
  };

  // Level 2: one currency's panel for a month. Same blueprint for every country; `country._meta.color` drives the tint.
  const CurrencyPanel = (country, { year, monthIndex, mKey: key }, state, ctx) => {
    const property = country._meta.id;
    const mKey = key || ctx.keyOf(year, monthIndex);
    const byType = { income: [], expense: [] };
    Object.values(country.sections).forEach(section => byType[section._meta.type].push(section));
    const m = country._meta;
    const carried = Number(m.carried) || 0;
    const carryFor = type => (type === 'income' ? carried > 0 : carried < 0) ? { amount: Math.abs(carried), from: m.carriedFrom } : null;
    const sections = TypeSection('expense', byType.expense, { mKey, property }, state, ctx, true, carryFor('expense'))
      + TypeSection('income', byType.income, { mKey, property }, state, ctx, false, carryFor('income'));
    return `<section class="ledger-panel ${m.color}" data-property="${property}" aria-label="${m.name}">
        <header class="ledger-panel-head">
          <h3>${m.name}<small>${m.code}</small></h3>
          <div class="ledger-totals"><span class="income" title="Income">${ctx.fmt(m.income, property)}</span><span class="expense" title="Expenses">${ctx.fmt(m.expense, property)}</span><span class="balance" title="Closing balance at month end">${ctx.fmt(m.closing, property)}</span></div>
        </header>
        <div class="ledger-sections">${sections}</div>
      </section>`;
  };

  // Level 1: year-to-date KPI card, one per active currency ------------------------------------
  // Category totals for the year, three levels deep and collapsed until opened: each section, its subsections by size,
  // and what each subsection was spent on (its entries' notes, or the entries themselves). Each row shows its share of the
  // level above and how many months it appeared in. data-key lets an open row stay open across re-renders.
  const YearBreakdown = (breakdown, property, ctx) => {
    if (!breakdown) return '<p class="kb-loading">Adding up the year…</p>';
    const months = n => `${n} ${n === 1 ? 'month' : 'months'}`;
    const shareOf = (part, whole) => (whole ? Math.round(part / whole * 100) : 0);
    const bar = share => `<span class="kb-bar" aria-hidden="true"><i style="width:${Math.max(share, 1)}%"></i></span>`;
    const block = (type, sections) => {
      if (!sections.length) return '';
      const all = sections.reduce((sum, section) => sum + section.total, 0);
      const title = type === 'income' ? 'Income' : 'Expenses';
      const rows = sections.map(section => {
        const sectionKey = `${property}|${type}|${section.key}`;
        const subs = section.subsections.map(sub => {
          const items = sub.items.map(part => {
            const share = shareOf(part.total, sub.total);
            return `<li class="kb-item"><span class="kb-name" title="${ctx.esc(part.name)}">${ctx.esc(part.name)}</span>${bar(share)}<span class="kb-share">${share}%</span><strong class="kb-amount ${type}">${ctx.fmt(part.total, property)}</strong><small class="kb-months" title="${part.count} ${part.count === 1 ? 'payment' : 'payments'}">${months(part.months)}</small></li>`;
          }).join('');
          const share = shareOf(sub.total, section.total);
          return `<details class="kb-sub" data-key="${ctx.esc(`${sectionKey}|${sub.key}`)}"><summary><i class="ti ti-chevron-right" aria-hidden="true"></i><span class="kb-name" title="${ctx.esc(sub.name)}">${ctx.esc(sub.name)}</span>${bar(share)}<span class="kb-share">${share}%</span><strong class="kb-amount ${type}">${ctx.fmt(sub.total, property)}</strong><small class="kb-months" title="${sub.entries} ${sub.entries === 1 ? 'entry' : 'entries'}">${months(sub.months)}</small></summary><ul class="kb-items">${items}</ul></details>`;
        }).join('');
        const share = shareOf(section.total, all);
        // A lone section would only repeat the Income/Expenses heading above it, so its subsections stand directly there.
        if (sections.length === 1) return `<div class="kb-subs is-flat">${subs}</div>`;
        return `<details class="kb-section" data-key="${ctx.esc(sectionKey)}"><summary><i class="ti ti-chevron-right" aria-hidden="true"></i><span class="kb-section-name">${ctx.esc(section.name)}</span><span class="kb-share">${share}%</span><strong class="kb-amount ${type}">${ctx.fmt(section.total, property)}</strong></summary><div class="kb-subs">${subs}</div></details>`;
      }).join('');
      // Income and Expenses open and close like every row below them, closed until clicked.
      return `<details class="kb-type ${type}" data-key="${ctx.esc(`${property}|${type}`)}"><summary><i class="ti ti-chevron-right" aria-hidden="true"></i><span>${title}</span><strong class="${type}">${ctx.fmt(all, property)}</strong></summary><div class="kb-type-body">${rows}</div></details>`;
    };
    const html = block('expense', breakdown.expense) + block('income', breakdown.income);
    return html ? `${html}<p class="kb-note">Entries only; balances brought forward are not included.</p>` : '<p class="kb-loading">No entries yet this year.</p>';
  };

  const YearKpiCard = (country, year, ctx) => {
    const { id: property, name, code, color, income, expense, net, opening, closing, breakdown } = country;
    const rate = income ? Math.round(net / income * 100) : null;
    return `<article class="kpi-card ${color}">
          <header class="kpi-head"><strong>${name}</strong><span>${code} · ${year} to date</span></header>
          <dl class="kpi-values">
            <div><dt>Income</dt><dd class="income">${ctx.fmt(income, property)}</dd></div>
            <div><dt>Expenses</dt><dd class="expense">${ctx.fmt(expense, property)}</dd></div>
            <div><dt>Net</dt><dd class="${ctx.netClass(net)}">${ctx.signed(net, property)}</dd></div>
            <div><dt>Saved</dt><dd>${rate === null ? '—' : `${rate}%`}</dd></div>
            <div title="Opening ${ctx.fmt(opening, property)} + net"><dt>Balance</dt><dd>${ctx.fmt(closing, property)}</dd></div>
          </dl>
          <div class="kpi-breakdown">${YearBreakdown(breakdown, property, ctx)}</div>
        </article>`;
  };

  // The selected year's tab also opens its settings, so it carries a small settings mark.
  const YearTabs = (years, activeYear) =>
    years.map(value => value === activeYear
      ? `<button type="button" class="year-tab" data-ledger-year="${value}" aria-pressed="true" title="${value} settings">${value}<i class="ti ti-adjustments-horizontal" aria-hidden="true"></i></button>`
      : `<button type="button" class="year-tab" data-ledger-year="${value}" aria-pressed="false" title="Show ${value}">${value}</button>`).join('');

  // Pills next to a closed month's name: In / Out / Bal per currency, or a countdown for upcoming months.
  const MonthSummary = (rows, { isFuture, daysAway }, ctx) => {
    if (isFuture) return `<span class="month-summary"><span class="month-tag">Upcoming · in ${daysAway} ${daysAway === 1 ? 'day' : 'days'}</span></span>`;
    // The short-form suffix (K, L, Cr, M, B) is set apart so it reads as a unit, not a digit.
    const unitTag = text => text.replace(/([A-Za-z]+)$/, '<span class="ms-unit">$1</span>');
    const value = (amount, property, kind, label) => `<span class="ms-kv ${kind}${amount ? '' : ' is-zero'}" title="${ctx.regions[property].code} ${label === 'Bal' ? 'closing balance' : label === 'In' ? 'income' : 'expenses'} ${ctx.fmt(amount, property)}">${amount || label === 'Bal' ? unitTag(ctx.compact(amount, property)) : '–'}</span>`;
    return `<span class="month-summary">${rows.map(({ property, income, expense, balance }) =>
      `<span class="month-tag ms-cur ${ctx.regions[property].color}"><span class="ms-code">${ctx.regions[property].code}</span>${value(income, property, 'income', 'In')}${value(expense, property, 'expense', 'Out')}${value(balance, property, 'balance', 'Bal')}</span>`).join('')}</span>`;
  };

  // Month row: header always, currency panels only while open (closed months stay cheap).
  const MonthBlock = ({ mKey, label, name, open, isNow, isFuture, isEmpty, isEvent, summaryHtml, panelsHtml, single }) =>
    `<section class="month-block${open ? ' is-open' : ''}${isNow ? ' is-now' : ''}${isFuture ? ' is-future' : ''}${isEmpty ? ' is-empty' : ''}${isEvent ? ' is-event' : ''}" data-month-key="${mKey}" aria-label="${label}">
        <header class="month-ledger-head">
          <h2><button type="button" class="month-name" data-toggle-month="${mKey}" aria-expanded="${open}" aria-controls="month-body-${mKey}" title="${open ? 'Hide' : 'Show'} ${label} · double-click for ${isEvent ? 'year' : 'month'} settings">${isEvent ? '<i class="ti ti-star-filled month-name-star" aria-hidden="true"></i>' : ''}${name}</button></h2>
          ${open ? '<button type="button" class="quiet-button month-ledger-toggle" data-ledger-expand>Expand all</button>' : summaryHtml}
        </header>
        ${open ? `<div class="ledger-panels${single ? ' is-single' : ''}" id="month-body-${mKey}">${panelsHtml}</div>` : ''}
      </section>`;

  const MonthGroup = (title, count, blocksHtml, unit = 'months') =>
    `<div class="month-group"><p class="month-group-label"><span>${title}</span>${count > 1 ? `<small>${count} ${unit}</small>` : ''}</p>${blocksHtml}</div>`;

  global.LedgerBlueprints = { YearBreakdown, EntryForm, SubEntryForm, EditEntryForm, SubsectionForm, SubEntryRow, EntryRow, CategoryBlock, TypeSection, CurrencyPanel, YearKpiCard, YearTabs, MonthSummary, MonthBlock, MonthGroup };
})(typeof globalThis !== 'undefined' ? globalThis : window);
