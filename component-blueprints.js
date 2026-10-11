// Ledger blueprints: pure functions from (data, state, ctx) → HTML string, one per level of the hierarchy.
// The markup is lifted verbatim from the original inline templates so the CSS grid contract is unchanged:
//   .ledger-panel > .ledger-sections > details.ledger-type-section > details.ledger-cat > .ledger-entries > .ledger-entry-cell
// `ctx` carries the app's formatting helpers (fmt, esc, dayLabel, keyOf, catKey) so the blueprints have no globals.
// `state` is { expandedEntries, entryDraft, subEntryDraftParentId, ledgerDraft } — the inline-edit state the UI reflects.
(function (global) {
  const daysIn = mKey => new Date(Number(mKey.slice(0, 4)), Number(mKey.slice(5, 7)), 0).getDate();

  // Inline forms --------------------------------------------------------------------------------
  const EntryForm = ({ mKey, property, type, category }, ctx) =>
    `<form class="ledger-entry ledger-entry-form" data-ledger-form="entry" data-month="${mKey}" data-property="${property}" data-section="${type}" data-type="${type}" data-category="${ctx.esc(category)}" novalidate><input name="day" type="number" min="1" max="${daysIn(mKey)}" step="1" inputmode="numeric"  aria-label="Day of month" required><input class="ledger-entry-desc" name="description" maxlength="80"  aria-label="Description" autocomplete="off" required><input class="ledger-entry-place" name="place" maxlength="60"  aria-label="Place" autocomplete="off"><input name="amount" type="number" min="0" step="any" inputmode="decimal"  aria-label="Amount" required><span class="ledger-entry-actions"><button type="submit" class="mini-btn is-save" aria-label="Save entry" title="Save entry"><i class="ti ti-check" aria-hidden="true"></i></button><button type="button" class="mini-btn" data-cancel-entry aria-label="Cancel entry" title="Cancel"><i class="ti ti-x" aria-hidden="true"></i></button></span></form>`;

  const SubEntryForm = ({ mKey, parentId }, ctx) =>
    `<form class="ledger-entry ledger-entry-form" data-ledger-form="sub-entry" data-parent-id="${ctx.esc(parentId)}" novalidate><input name="day" type="number" min="1" max="${daysIn(mKey)}" step="1" inputmode="numeric"  aria-label="Day of month"><input class="ledger-entry-desc" name="description" maxlength="80"  aria-label="Description" autocomplete="off" required><input class="ledger-entry-place" name="place" maxlength="60"  aria-label="Place" autocomplete="off"><input name="amount" type="number" min="0" step="any" inputmode="decimal"  aria-label="Amount"><span class="ledger-entry-actions"></span></form>`;

  const SubsectionForm = ({ sectionName }, ctx) =>
    `<form class="ledger-form sub-form" data-ledger-form="subsection" novalidate><input name="name" placeholder="New subsection in ${ctx.esc(sectionName)}" maxlength="40" aria-label="New subsection name" autocomplete="off"><button type="submit" class="mini-btn is-save" aria-label="Add subsection" title="Add (Enter)"><i class="ti ti-check" aria-hidden="true"></i></button><button type="button" class="mini-btn" data-cancel-draft aria-label="Cancel" title="Cancel (Esc)"><i class="ti ti-x" aria-hidden="true"></i></button><p class="ledger-form-hint" aria-live="polite"></p></form>`;

  // Level 6: sub-entry row ----------------------------------------------------------------------
  const SubEntryRow = (sub, { type, property }, ctx) =>
    `<div class="ledger-entry-cell ledger-sub-entry"><div class="ledger-entry-line"><span class="ledger-entry"><time datetime="${sub.date}">${sub.date.slice(8, 10)}</time><span class="ledger-entry-desc">${ctx.esc(sub.description)}</span><span class="ledger-entry-place">${ctx.esc(sub.place || '')}</span><strong class="${type}">${ctx.fmt(sub.amount, property)}</strong></span></div></div>`;

  // Level 5: entry row, with its sub-entries and sub-entry form when expanded -------------------
  const EntryRow = (entry, { mKey, type, property }, state, ctx) => {
    const isExpanded = state.expandedEntries.has(entry.id);
    const subItems = entry.subEntries.filter(sub => sub.date.startsWith(mKey));
    const hasSubItems = subItems.length > 0;
    const showingSubEntryForm = state.subEntryDraftParentId === entry.id;
    const subEntriesHtml = subItems.map(sub => SubEntryRow(sub, { type, property }, ctx)).join('');
    const subEntryForm = showingSubEntryForm ? SubEntryForm({ mKey, parentId: entry.id }, ctx) : '';
    const subContent = (isExpanded && hasSubItems) ? subEntriesHtml : '';
    const allSubContent = subContent + (showingSubEntryForm || isExpanded ? subEntryForm : '');
    return `<div class="ledger-entry-cell"><div class="ledger-entry-line"><button type="button" class="ledger-entry ledger-entry-toggle" data-toggle-entry data-entry-id="${ctx.esc(entry.id)}" aria-expanded="${isExpanded}" style="cursor: ${hasSubItems ? 'pointer' : 'default'}" title="${ctx.esc(ctx.dayLabel(entry.date))} · ${ctx.esc(entry.description)}${entry.place ? ` · ${ctx.esc(entry.place)}` : ''}"><time datetime="${entry.date}">${entry.date.slice(8, 10)}</time><span class="ledger-entry-desc">${ctx.esc(entry.description)}</span><span class="ledger-entry-place">${ctx.esc(entry.place || '')}</span><strong class="${type}">${ctx.fmt(entry._meta.total, property)}</strong></button></div>${allSubContent}</div>`;
  };

  // Level 4: category (collapsible) -------------------------------------------------------------
  const CategoryBlock = (name, category, { mKey, type, property }, state, ctx) => {
    const entries = [...category.entries]
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
      .map(entry => EntryRow(entry, { mKey, type, property }, state, ctx))
      .join('');
    const d = state.entryDraft;
    const draftHere = d && d.month === mKey && d.property === property && d.section === type && d.category === name;
    return `<details class="ledger-cat" data-key="${ctx.esc(ctx.catKey(mKey, property, type, name))}"><summary><i class="ti ti-chevron-right" aria-hidden="true"></i><span class="ledger-cat-name">${ctx.esc(name)}</span><strong>${ctx.fmt(category._meta.total, property)}</strong></summary><div class="ledger-entries">${entries}${draftHere ? EntryForm({ mKey, property, type, category: name }, ctx) : ''}</div></details>`;
  };

  // Level 3: Income / Expenses block. Merges every configured section of that type, shows only categories with entries.
  const TypeSection = (type, sections, { mKey, property }, state, ctx, isOpen) => {
    if (!sections.length) return '';
    const categories = [];
    sections.forEach(section => {
      Object.entries(section.categories).forEach(([name, category]) => {
        if (category.entries.length) categories.push([name, category]);
      });
    });
    const total = categories.reduce((sum, [, category]) => sum + category._meta.total, 0);
    const categoriesHtml = categories
      .sort((a, b) => b[1]._meta.total - a[1]._meta.total)
      .map(([name, category]) => CategoryBlock(name, category, { mKey, type, property }, state, ctx))
      .join('');
    const title = type === 'income' ? 'Income' : 'Expenses';
    return `<details class="ledger-type-section" ${isOpen ? 'open' : ''}><summary><strong>${title}</strong><span class="${type}">${ctx.fmt(total, property)}</span></summary><div>${categoriesHtml || '<p class="ledger-none">Nothing recorded</p>'}</div></details>`;
  };

  // Level 2: one currency's panel for a month. Same blueprint for every country; `country._meta.color` drives the tint.
  const CurrencyPanel = (country, { year, monthIndex }, state, ctx) => {
    const property = country._meta.id;
    const mKey = ctx.keyOf(year, monthIndex);
    const byType = { income: [], expense: [] };
    Object.values(country.sections).forEach(section => byType[section._meta.type].push(section));
    const sections = TypeSection('expense', byType.expense, { mKey, property }, state, ctx, true)
      + TypeSection('income', byType.income, { mKey, property }, state, ctx, false);
    const m = country._meta;
    return `<section class="ledger-panel ${property}" aria-label="${m.name}">
        <header class="ledger-panel-head">
          <h3>${m.name}<small>${m.code}</small></h3>
          <div class="ledger-totals"><span class="income">${ctx.fmt(m.income, property)}</span><span class="expense">${ctx.fmt(m.expense, property)}</span><span class="balance" title="Closing balance at month end">${ctx.fmt(m.closing, property)}</span></div>
        </header>
        <div class="ledger-sections">${sections}</div>
      </section>`;
  };

  // Level 1: year-to-date KPI card, one per active currency ------------------------------------
  const YearKpiCard = (country, year, ctx) => {
    const { id: property, name, code, income, expense, net, opening } = country;
    const rate = income ? Math.round(net / income * 100) : null;
    return `<article class="kpi-card ${property}">
          <header class="kpi-head"><strong>${name}</strong><span>${code} · ${year} to date</span></header>
          <dl class="kpi-values">
            <div><dt>Income</dt><dd class="income">${ctx.fmt(income, property)}</dd></div>
            <div><dt>Expenses</dt><dd class="expense">${ctx.fmt(expense, property)}</dd></div>
            <div><dt>Net</dt><dd class="${ctx.netClass(net)}">${ctx.signed(net, property)}</dd></div>
            <div><dt>Saved</dt><dd>${rate === null ? '—' : `${rate}%`}</dd></div>
            <div title="Opening ${ctx.fmt(opening, property)} + net"><dt>Balance</dt><dd>${ctx.fmt(opening + net, property)}</dd></div>
          </dl>
        </article>`;
  };

  const YearTabs = (years, activeYear) =>
    years.map(value => `<button type="button" class="year-tab" data-ledger-year="${value}" aria-pressed="${value === activeYear}">${value}</button>`).join('');

  // Pills next to a closed month's name: In / Out / Bal per currency, or a countdown for upcoming months.
  const MonthSummary = (rows, { isFuture, daysAway }, ctx) => {
    if (isFuture) return `<span class="month-summary"><span class="month-tag">Upcoming · in ${daysAway} ${daysAway === 1 ? 'day' : 'days'}</span></span>`;
    const value = (amount, property, kind, label) => `<span class="ms-kv ${kind}${amount ? '' : ' is-zero'}" title="${ctx.regions[property].code} ${label === 'Bal' ? 'closing balance' : label === 'In' ? 'income' : 'expenses'} ${ctx.fmt(amount, property)}">${ctx.compact(amount, property)}</span>`;
    return `<span class="month-summary">${rows.map(({ property, income, expense, balance }) =>
      `<span class="month-tag ms-cur ${property}">${ctx.regions[property].code}${value(income, property, 'income', 'In')}${value(expense, property, 'expense', 'Out')}${value(balance, property, 'balance', 'Bal')}</span>`).join('')}</span>`;
  };

  // Month row: header always, currency panels only while open (closed months stay cheap).
  const MonthBlock = ({ mKey, month, label, open, isNow, isFuture, summaryHtml, panelsHtml, single }) =>
    `<section class="month-block${open ? ' is-open' : ''}${isNow ? ' is-now' : ''}${isFuture ? ' is-future' : ''}" data-month-key="${mKey}" aria-label="${label}">
        <header class="month-ledger-head">
          <span class="month-index" aria-hidden="true">${String(month + 1).padStart(2, '0')}</span>
          <h2><button type="button" class="month-name" data-toggle-month="${mKey}" aria-expanded="${open}" aria-controls="month-body-${mKey}" title="${open ? 'Hide' : 'Show'} ${label}">${label}</button></h2>
          ${open ? '<button type="button" class="quiet-button month-ledger-toggle" data-ledger-expand>Expand all</button>' : summaryHtml}
        </header>
        ${open ? `<div class="ledger-panels${single ? ' is-single' : ''}" id="month-body-${mKey}">${panelsHtml}</div>` : ''}
      </section>`;

  const MonthGroup = (title, count, blocksHtml) =>
    `<div class="month-group"><p class="month-group-label"><span>${title}</span>${count > 1 ? `<small>${count} months</small>` : ''}</p>${blocksHtml}</div>`;

  // Overview / property pages: the per-country summary card ------------------------------------
  const PropertyCard = ({ region, property, stats, budget, spentPercent, recentHtml }, ctx) =>
    `<div class="property-inner"><header class="property-header"><div class="property-identity"><span class="property-badge"><i class="ti ${region.icon}" aria-hidden="true"></i></span><div><h2 class="property-title">${region.name.toUpperCase()}</h2><span class="property-meta">${region.home}</span></div></div><span class="currency-chip"><span>${region.code}</span></span></header><div class="property-stats"><div class="stat-box"><span class="stat-label">Income</span><strong class="stat-value income">${ctx.fmt(stats.income, property)}</strong></div><div class="stat-box"><span class="stat-label">Expenses</span><strong class="stat-value expense">${ctx.fmt(stats.expense, property)}</strong></div></div><div class="balance-box"><div><span class="balance-label">Current balance</span><strong class="balance-value">${ctx.fmt(stats.balance, property)}</strong><span class="balance-change"><i class="ti ti-trending-up" aria-hidden="true"></i> ${stats.income ? 'On pace this month' : 'Opening balance'}</span></div>${ctx.spark()}</div><section aria-label="Monthly budget"><div class="card-section-head"><h3>Monthly spend</h3><button type="button" class="subtle-action" data-page-link="budgets">Budget details <i class="ti ti-arrow-up-right" aria-hidden="true"></i></button></div><div class="budget-line"><span>${ctx.fmt(stats.expense, property)} spent</span><strong>${Math.round(spentPercent)}% of ${ctx.fmt(budget, property)}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${spentPercent}%"></div></div></section><section aria-label="Recent transactions"><div class="card-section-head"><h3>Recent activity</h3><button type="button" class="subtle-action" data-page-link="transactions">See all <i class="ti ti-arrow-right" aria-hidden="true"></i></button></div><div class="transaction-list">${recentHtml}</div></section></div>`;

  global.LedgerBlueprints = { EntryForm, SubEntryForm, SubsectionForm, SubEntryRow, EntryRow, CategoryBlock, TypeSection, CurrencyPanel, YearKpiCard, YearTabs, MonthSummary, MonthBlock, MonthGroup, PropertyCard };
})(typeof globalThis !== 'undefined' ? globalThis : window);
