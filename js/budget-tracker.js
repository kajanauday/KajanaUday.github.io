const STORAGE_KEY = 'ledger-budget-tracker-v1';
const CURRENCIES = { JPY: { name: 'Japanese yen', symbol: '¥', decimals: 0 }, INR: { name: 'Indian rupee', symbol: '₹', decimals: 2 } };
const FIRST_YEAR = 2025;
const COLUMN_LABELS = { date: 'Date', item: 'Item', place: 'Place', amount: 'Amount', shared: 'Shared', note: 'Note' };
const COLUMNS = Object.keys(COLUMN_LABELS);
const today = new Date();
const todayKey = dateKey(today);
let model = loadModel();
let activeFormSubmit = null;
let activeDayKey = null;
const monthsElement = document.querySelector('#months');
const emptyState = document.querySelector('#empty-state');
const formDialog = document.querySelector('#form-dialog');
const dayDialog = document.querySelector('#day-dialog');
const columnsDialog = document.querySelector('#columns-dialog');

function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function currentMonthKey() { return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`; }
function monthDate(key) { return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1); }
function monthName(key) { return monthDate(key).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function amountFor(section) {
  const income = section.incomes.reduce((sum, item) => sum + Number(item.amount), 0);
  const expenses = section.categories.reduce((sum, category) => sum + category.entries.reduce((entrySum, entry) => entrySum + Number(entry.amount), 0), 0);
  return { income, expenses, balance: income - expenses };
}
function formatAmount(value, code) {
  const currency = CURRENCIES[code] || CURRENCIES.JPY;
  const formatted = new Intl.NumberFormat('en-US', { minimumFractionDigits: currency.decimals, maximumFractionDigits: currency.decimals }).format(value);
  return `${currency.symbol}${formatted}`;
}
function loadModel() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.months)) return { months: saved.months, prefs: { view: saved.prefs?.view === 'list' ? 'list' : 'calendar', calendarYear: Math.max(FIRST_YEAR, Number(saved.prefs?.calendarYear) || today.getFullYear()), expandedCalendarMonth: saved.prefs?.expandedCalendarMonth, expandedMonths: saved.prefs?.expandedMonths || {}, expandedCategories: saved.prefs?.expandedCategories || {}, expandedIncome: saved.prefs?.expandedIncome || {}, visibleColumns: saved.prefs?.visibleColumns || [...COLUMNS] } };
  } catch (error) { console.warn('Could not load saved ledger data.', error); }
  return { months: [], prefs: { view: 'calendar', calendarYear: today.getFullYear(), expandedCalendarMonth: currentMonthKey(), expandedMonths: {}, expandedCategories: {}, expandedIncome: {}, visibleColumns: [...COLUMNS] } };
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(model)); document.querySelector('#save-state').innerHTML = '<span class="save-dot"></span> Saved on this device'; }
  catch (error) { document.querySelector('#save-state').textContent = 'Could not save'; console.error('Could not save ledger data.', error); }
}
function sortMonths() { model.months.sort((a, b) => b.id.localeCompare(a.id)); }
function findMonth(key) { return model.months.find(month => month.id === key); }
function sectionKey(month, currency) { return `${month.id}:${currency}`; }
function categoryKey(month, currency, category) { return `${sectionKey(month, currency)}:${category.id}`; }
function ensureMonth(key) { let month = findMonth(key); if (!month) { month = { id: key, currencies: {} }; model.months.push(month); sortMonths(); } return month; }
function listEntries(month) { return Object.entries(month.currencies).flatMap(([currency, section]) => section.categories.flatMap(category => category.entries.map(entry => ({ ...entry, currency, category: category.name, categoryId: category.id })))); }
function countEntries(section) { return section.categories.reduce((count, category) => count + category.entries.length, 0); }
function summaryMarkup(month) {
  return Object.entries(month.currencies).sort(([a], [b]) => a.localeCompare(b)).map(([currency, section]) => {
    const totals = amountFor(section);
    return `<div class="summary-currency"><span class="currency-tag">${esc(currency)}</span><span class="summary-metric"><span>Income</span><strong>${formatAmount(totals.income, currency)}</strong></span><span class="summary-metric"><span>Expenses</span><strong>${formatAmount(totals.expenses, currency)}</strong></span><span class="summary-metric"><span>Balance</span><strong class="${totals.balance < 0 ? 'negative' : ''}">${formatAmount(totals.balance, currency)}</strong></span></div>`;
  }).join('') || '<span class="category-count">Add a currency to begin</span>';
}
function render() {
  sortMonths();
  const isCalendar = model.prefs.view === 'calendar';
  const visibleMonths = isCalendar
    ? Array.from({ length: 12 }, (_, index) => {
      const id = `${model.prefs.calendarYear}-${String(index + 1).padStart(2, '0')}`;
      return findMonth(id) || { id, currencies: {} };
    })
    : model.months;
  monthsElement.classList.toggle('year-calendar', isCalendar);
  const latestYear = Math.max(today.getFullYear(), model.prefs.calendarYear, ...model.months.map(month => Number(month.id.slice(0, 4))));
  const years = Array.from({ length: Math.max(1, latestYear - FIRST_YEAR + 1) }, (_, index) => FIRST_YEAR + index);
  monthsElement.innerHTML = isCalendar
    ? `<nav class="calendar-years" aria-label="Select year">${years.map(year => `<button type="button" class="calendar-year-choice" data-action="select-calendar-year" data-year="${year}" aria-current="${year === model.prefs.calendarYear ? 'true' : 'false'}">${year}</button>`).join('')}</nav><div class="year-month-list">${visibleMonths.map(renderYearMonth).join('')}</div>`
    : visibleMonths.map(renderMonth).join('');
  monthsElement.hidden = !isCalendar && model.months.length === 0;
  emptyState.hidden = isCalendar || model.months.length !== 0;
  document.querySelectorAll('.view-choice').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === model.prefs.view)));
}
function renderYearMonth(month, index) {
  const isCurrent = month.id === currentMonthKey();
  const isExpanded = model.prefs.expandedCalendarMonth === month.id;
  const label = monthName(month.id);
  const content = isExpanded ? `<div class="month-content"><div class="month-actions"><button class="text-button" data-action="add-income" data-month="${month.id}">＋ Add income</button><button class="text-button" data-action="add-expense" data-month="${month.id}">＋ Add expense</button><button class="text-button" data-action="add-category" data-month="${month.id}">＋ Add category</button><button class="text-button" data-action="add-currency" data-month="${month.id}">＋ Add currency</button></div>${renderCalendar(month)}</div>` : '';
  return `<article class="month-card year-month${isCurrent ? ' current-month' : ''}" style="animation-delay:${Math.min(index * 20, 220)}ms"><header class="year-month-header"><button class="year-month-toggle" type="button" data-action="toggle-calendar-month" data-month="${month.id}" aria-expanded="${isExpanded}" aria-label="${isExpanded ? 'Collapse' : 'Expand'} ${esc(label)}"><span aria-hidden="true">${isExpanded ? '⌄' : '›'}</span><h2 class="year-month-name">${esc(label)}</h2></button>${isCurrent ? '<span class="current-month-label">Current month</span>' : ''}${yearSummaryMarkup(month)}</header>${content}</article>`;
}
function yearSummaryMarkup(month) {
  return Object.entries(month.currencies).sort(([a], [b]) => a.localeCompare(b)).map(([currency, section]) => {
    const totals = amountFor(section);
    return `<div class="year-currency-summary"><strong>${esc(currency)}</strong><span>Expenses ${formatAmount(totals.expenses, currency)}</span><span class="${totals.balance < 0 ? 'negative' : ''}">Balance ${formatAmount(totals.balance, currency)}</span></div>`;
  }).join('') || '<div class="year-currency-summary"><span>Expenses —</span><span>Balance —</span></div>';
}
function renderMonth(month, index) {
  const isExpanded = Boolean(model.prefs.expandedMonths[month.id]);
  const content = model.prefs.view === 'list' ? Object.entries(month.currencies).sort(([a], [b]) => a.localeCompare(b)).map(([currency, section]) => renderCurrency(month, currency, section)).join('') : renderCalendar(month);
  const calendarStrip = model.prefs.view === 'calendar' && !isExpanded ? `<div class="month-content">${content}</div>` : '';
  const expandedContent = isExpanded ? `<div class="month-content"><div class="month-actions"><button class="text-button" data-action="add-income" data-month="${month.id}">＋ Add income</button><button class="text-button" data-action="add-expense" data-month="${month.id}">＋ Add expense</button><button class="text-button" data-action="add-category" data-month="${month.id}">＋ Add category</button><button class="text-button" data-action="add-currency" data-month="${month.id}">＋ Add currency</button></div>${content}</div>` : '';
  return `<article class="month-card" style="animation-delay:${Math.min(index * 35, 175)}ms"><div class="month-header"><div class="month-heading"><button class="toggle-month" data-action="toggle-month" data-month="${month.id}" aria-label="${isExpanded ? 'Collapse' : 'Expand'} ${esc(monthName(month.id))}">${isExpanded ? '⌄' : '›'}</button><h2 class="month-name">${esc(monthName(month.id))}</h2><div class="section-actions"><button class="small-icon" data-action="edit-month" data-month="${month.id}" title="Edit month" aria-label="Edit month">✎</button><button class="small-icon" data-action="delete-month" data-month="${month.id}" title="Delete month" aria-label="Delete month">⌫</button></div></div><div class="month-summary">${summaryMarkup(month)}</div></div>${expandedContent}${calendarStrip}</article>`;
}
function renderCurrency(month, currency, section) {
  const key = sectionKey(month, currency); const incomeOpen = Boolean(model.prefs.expandedIncome[key]); const totals = amountFor(section);
  const categoryMarkup = section.categories.map(category => renderCategory(month, currency, category)).join('');
  const carry = previousMonthKey(month.id); const prevSection = carry && findMonth(carry)?.currencies[currency]; const carryBalance = prevSection ? amountFor(prevSection).balance : 0;
  return `<section class="currency-section"><div class="currency-head"><div class="currency-title"><h3>${esc(currency)}</h3><span class="currency-symbol">${esc(CURRENCIES[currency]?.name || currency)}</span></div><div class="section-actions"><button class="text-button" data-action="add-income" data-month="${month.id}" data-currency="${currency}">＋ Income</button><button class="text-button" data-action="add-expense" data-month="${month.id}" data-currency="${currency}">＋ Expense</button><button class="text-button" data-action="add-category" data-month="${month.id}" data-currency="${currency}">＋ Category</button><button class="small-icon" data-action="delete-currency" data-month="${month.id}" data-currency="${currency}" title="Remove section" aria-label="Remove ${currency} section">⌫</button></div></div><button class="income-heading" data-action="toggle-income" data-month="${month.id}" data-currency="${currency}"><span>Income <span class="category-count">${incomeOpen ? '· hide items' : '· show items'}</span></span><strong>${formatAmount(totals.income, currency)}</strong></button>${incomeOpen ? `<div class="income-items">${section.incomes.length ? section.incomes.map(item => `<div class="income-row"><div class="income-main"><span class="income-date">${esc(item.date)}</span><span class="income-source">${esc(item.source)}</span><span class="income-amount">${formatAmount(item.amount, currency)}</span></div><div class="section-actions"><button class="small-icon" data-action="edit-income" data-month="${month.id}" data-currency="${currency}" data-id="${item.id}" title="Edit income" aria-label="Edit income">✎</button><button class="small-icon" data-action="delete-income" data-month="${month.id}" data-currency="${currency}" data-id="${item.id}" title="Delete income" aria-label="Delete income">⌫</button></div></div>`).join('') : '<div class="income-row category-count">No income items yet.</div>'}<div class="income-row"><span class="category-count">Previous month balance ${carry ? `(${esc(monthName(carry))}: ${formatAmount(carryBalance, currency)})` : '(no previous month)'}</span><button class="text-button" data-action="carry-over" data-month="${month.id}" data-currency="${currency}" ${carryBalance <= 0 ? 'disabled' : ''}>Carry over</button></div></div>` : ''}<div class="category-list">${categoryMarkup || '<p class="category-count">No categories yet. Add one to organize expenses.</p>'}</div></section>`;
}
function renderCategory(month, currency, category) {
  const open = Boolean(model.prefs.expandedCategories[categoryKey(month, currency, category)]);
  const total = category.entries.reduce((sum, entry) => sum + Number(entry.amount), 0);
  const entries = [...category.entries].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)); const visibleColumns = model.prefs.visibleColumns;
  const headers = visibleColumns.map(column => `<th>${esc(COLUMN_LABELS[column])}</th>`).join('');
  const rows = entries.map(entry => `<tr>${visibleColumns.map(column => {
    if (column === 'date') return `<td class="date-cell">${esc(entry.date)}</td>`;
    if (column === 'item') return `<td><strong>${esc(entry.item)}</strong></td>`;
    if (column === 'place') return `<td>${esc(entry.place || '—')}</td>`;
    if (column === 'amount') return `<td class="amount-cell">${formatAmount(entry.amount, currency)}</td>`;
    if (column === 'shared') return `<td>${entry.shared ? '<span class="shared-mark">Shared</span>' : '<span class="shared-no">—</span>'}</td>`;
    return `<td class="note-cell">${esc(entry.note || '—')}</td>`;
  }).join('')}<td class="row-actions"><button class="small-icon" data-action="edit-expense" data-month="${month.id}" data-currency="${currency}" data-category="${category.id}" data-id="${entry.id}" aria-label="Edit expense" title="Edit">✎</button><button class="small-icon" data-action="delete-expense" data-month="${month.id}" data-currency="${currency}" data-category="${category.id}" data-id="${entry.id}" aria-label="Delete expense" title="Delete">⌫</button></td></tr>`).join('');
  return `<div class="category-block"><div class="category-heading"><button class="category-toggle" data-action="toggle-category" data-month="${month.id}" data-currency="${currency}" data-category="${category.id}"><span class="caret">${open ? '⌄' : '›'}</span><span class="category-name">${esc(category.name)}</span><span class="category-count">${category.entries.length} ${category.entries.length === 1 ? 'entry' : 'entries'}</span><span class="category-total">${formatAmount(total, currency)}</span></button><div class="section-actions"><button class="small-icon" data-action="add-expense" data-month="${month.id}" data-currency="${currency}" data-category="${category.id}" title="Add expense" aria-label="Add expense to ${esc(category.name)}">＋</button><button class="small-icon" data-action="edit-category" data-month="${month.id}" data-currency="${currency}" data-category="${category.id}" title="Rename category" aria-label="Rename category">✎</button><button class="small-icon" data-action="delete-category" data-month="${month.id}" data-currency="${currency}" data-category="${category.id}" title="Delete category" aria-label="Delete category">⌫</button></div></div>${open ? `<div class="expense-table-wrap"><table class="expense-table"><thead><tr>${headers}<th aria-label="Actions"></th></tr></thead><tbody>${rows || `<tr><td colspan="${visibleColumns.length + 1}" class="category-count">No expenses in this category yet.</td></tr>`}</tbody></table></div>` : ''}</div>`;
}
function renderCalendar(month) {
  const [year, monthNumber] = month.id.split('-').map(Number); const monthStart = new Date(year, monthNumber - 1, 1); const dayCount = new Date(year, monthNumber, 0).getDate(); const offset = (monthStart.getDay() + 6) % 7;
  const allEntries = listEntries(month); const spentByDay = new Map();
  allEntries.forEach(entry => { const currencyMap = spentByDay.get(entry.date) || {}; currencyMap[entry.currency] = (currencyMap[entry.currency] || 0) + Number(entry.amount); spentByDay.set(entry.date, currencyMap); });
  const days = Array.from({ length: offset }, () => '<span class="year-day year-day-blank"></span>');
  for (let day = 1; day <= dayCount; day++) {
    const key = `${month.id}-${String(day).padStart(2, '0')}`;
    const currencyTotals = spentByDay.get(key) || {};
    const classes = ['year-day'];
    if (!spentByDay.has(key) && key <= todayKey) classes.push('no-spend');
    if (key > todayKey) classes.push('future');
    if (key === todayKey) classes.push('today');
    const amounts = Object.entries(currencyTotals).sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => `<span>${formatAmount(amount, currency)}</span>`).join('');
    days.push(`<button class="${classes.join(' ')}" data-action="open-day" data-date="${key}" aria-label="${esc(key)}${amounts ? `, ${esc(Object.keys(currencyTotals).join(', '))} spending` : ', no spending'}"><span class="year-day-number">${day}</span><span class="year-day-spend">${amounts}</span></button>`);
  }
  return `<div class="year-weekdays">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(day => `<span>${day}</span>`).join('')}</div><div class="year-calendar-grid">${days.join('')}</div>`;
}
function previousMonthKey(key) { const date = monthDate(key); date.setMonth(date.getMonth() - 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }
function validMonthKey(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
function validDateInMonth(value, month) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !value.startsWith(`${month}-`)) return false; const date = new Date(`${value}T00:00:00`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }
function openForm(title, fields, submit, submitLabel = 'Save') {
  activeFormSubmit = submit; document.querySelector('#form-title').textContent = title;
  document.querySelector('#form-fields').innerHTML = fields.map(field => {
    const id = `field-${field.name}`;
    if (field.type === 'checkbox') return `<label class="field-check"><input id="${id}" name="${field.name}" type="checkbox" ${field.value ? 'checked' : ''}> ${esc(field.label)}</label>`;
    const attrs = `${field.required ? 'required' : ''} ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.step ? `step="${field.step}"` : ''} ${field.max ? `max="${field.max}"` : ''}`;
    const control = field.type === 'select' ? `<select id="${id}" name="${field.name}" ${field.required ? 'required' : ''}>${field.options.map(option => `<option value="${esc(option.value)}" ${option.value === field.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>` : field.type === 'textarea' ? `<textarea id="${id}" name="${field.name}" ${field.required ? 'required' : ''}>${esc(field.value || '')}</textarea>` : `<input id="${id}" name="${field.name}" type="${field.type || 'text'}" value="${esc(field.value ?? '')}" ${attrs}>`;
    return `<label class="field" for="${id}">${esc(field.label)}${control}</label>`;
  }).join(''); document.querySelector('#form-submit').textContent = submitLabel; formDialog.showModal();
}
function selectCurrencyFields(current = '') { return [{ name: 'currency', label: 'Currency', type: 'select', required: true, value: current || 'JPY', options: Object.entries(CURRENCIES).map(([code, currency]) => ({ value: code, label: `${code} · ${currency.name}` })) }]; }
function ensureCurrency(month, currency) { if (!month.currencies[currency]) month.currencies[currency] = { incomes: [], categories: [] }; return month.currencies[currency]; }
function chooseCurrency(month, requestedCurrency, callback) {
  if (requestedCurrency && month.currencies[requestedCurrency]) { callback(requestedCurrency); return; }
  const unused = Object.keys(CURRENCIES).filter(currency => !month.currencies[currency]); const fields = selectCurrencyFields(unused[0] || 'JPY');
  fields[0].options = Object.entries(CURRENCIES).map(([code, currency]) => ({ value: code, label: `${code} · ${currency.name}${month.currencies[code] ? ' (already added)' : ''}` }));
  openForm(`Choose currency · ${monthName(month.id)}`, fields, values => { ensureCurrency(month, values.currency); save(); render(); callback(values.currency); }, 'Continue');
}
function addIncome(month, currency, income = null) {
  const section = ensureCurrency(month, currency); const fields = [{ name: 'date', label: 'Date', type: 'date', required: true, value: income?.date || `${month.id}-01` }, { name: 'source', label: 'Source', required: true, value: income?.source || '' }, { name: 'amount', label: `Amount (${currency})`, type: 'number', required: true, min: '0.01', step: CURRENCIES[currency].decimals ? '0.01' : '1', value: income?.amount ?? '' }];
  openForm(income ? 'Edit income' : 'Add income', fields, values => {
    const amount = Number(values.amount); if (!validDateInMonth(values.date, month.id) || !values.source.trim() || !Number.isFinite(amount) || amount <= 0 || (CURRENCIES[currency].decimals === 0 && !Number.isInteger(amount))) return alert('Enter a valid date in this month, a source, and a positive amount.');
    const item = { id: income?.id || uid(), date: values.date, source: values.source.trim(), amount }; const index = section.incomes.findIndex(entry => entry.id === item.id); if (index >= 0) section.incomes[index] = item; else section.incomes.push(item);
    model.prefs.expandedIncome[sectionKey(month, currency)] = true; save(); render();
  });
}
function addCategory(month, currency, category = null, afterCreate = null) {
  const section = ensureCurrency(month, currency);
  openForm(category ? 'Rename category' : 'Add category', [{ name: 'name', label: 'Category name', required: true, value: category?.name || '' }], values => {
    const name = values.name.trim(); if (!name) return alert('Enter a category name.');
    if (section.categories.some(item => item.id !== category?.id && item.name.toLowerCase() === name.toLowerCase())) return alert('A category with that name already exists in this currency section.');
    let created = category;
    if (category) category.name = name;
    else { created = { id: uid(), name, entries: [] }; section.categories.push(created); }
    save(); render(); if (afterCreate) afterCreate(created);
  });
}
function addExpense(month, currency, category, entry = null, presetDate = '') {
  const section = ensureCurrency(month, currency); if (!section.categories.length) return addCategory(month, currency);
  const fields = [{ name: 'date', label: 'Date', type: 'date', required: true, value: entry?.date || (presetDate.startsWith(month.id) ? presetDate : `${month.id}-01`) }, { name: 'item', label: 'Item', required: true, value: entry?.item || '' }, { name: 'place', label: 'Place (optional)', value: entry?.place || '' }, { name: 'amount', label: `Amount (${currency})`, type: 'number', required: true, min: '0.01', step: CURRENCIES[currency].decimals ? '0.01' : '1', value: entry?.amount ?? '' }, { name: 'shared', label: 'Shared with others', type: 'checkbox', value: Boolean(entry?.shared) }, { name: 'note', label: 'Note (optional)', type: 'textarea', value: entry?.note || '' }];
  fields.splice(1, 0, { name: 'categoryId', label: 'Category', type: 'select', required: true, value: category?.id || section.categories[0].id, options: section.categories.map(item => ({ value: item.id, label: item.name })) });
  openForm(entry ? 'Edit expense' : 'Add expense', fields, values => {
    const amount = Number(values.amount); if (!validDateInMonth(values.date, month.id) || !values.item.trim() || !Number.isFinite(amount) || amount <= 0 || (CURRENCIES[currency].decimals === 0 && !Number.isInteger(amount))) return alert('Enter a valid date in this month, an item, and a positive amount.');
    const target = section.categories.find(item => item.id === values.categoryId); if (!target) return;
    if (entry) { const oldCategory = section.categories.find(item => item.entries.some(oldEntry => oldEntry.id === entry.id)); if (oldCategory && oldCategory.id !== target.id) oldCategory.entries = oldCategory.entries.filter(oldEntry => oldEntry.id !== entry.id); }
    const result = { id: entry?.id || uid(), date: values.date, item: values.item.trim(), place: values.place.trim(), amount, shared: Boolean(values.shared), note: values.note.trim() };
    const oldTarget = target.entries.findIndex(oldEntry => oldEntry.id === result.id); if (oldTarget >= 0) target.entries[oldTarget] = result; else target.entries.push(result);
    save(); render(); if (activeDayKey) showDay(activeDayKey);
  });
}
function addMonth() {
  openForm('Add month', [{ name: 'month', label: 'Month', type: 'month', required: true, value: currentMonthKey() }], values => {
    if (!validMonthKey(values.month)) return alert('Choose a valid month.'); const month = ensureMonth(values.month); model.prefs.expandedMonths[month.id] = true;
    chooseCurrency(month, '', () => { save(); render(); });
  }, 'Continue');
}
function shiftDate(oldDate, year, monthNumber) { const day = Number(oldDate.slice(-2)); const finalDay = new Date(year, monthNumber, 0).getDate(); return `${year}-${String(monthNumber).padStart(2, '0')}-${String(Math.min(day, finalDay)).padStart(2, '0')}`; }
function remapMonthPreferences(preferences, oldKey, newKey) {
  Object.entries(preferences).forEach(([key, value]) => {
    if (key === oldKey || key.startsWith(`${oldKey}:`)) {
      preferences[`${newKey}${key.slice(oldKey.length)}`] = value;
      delete preferences[key];
    }
  });
}
function editMonth(month) {
  openForm('Edit month', [{ name: 'month', label: 'Month', type: 'month', required: true, value: month.id }], values => {
    if (!validMonthKey(values.month)) return alert('Choose a valid month.'); if (values.month === month.id) return; if (findMonth(values.month)) return alert('That month already exists. Move or delete it first.');
    const [year, monthNumber] = values.month.split('-').map(Number); for (const section of Object.values(month.currencies)) { for (const item of section.incomes) item.date = shiftDate(item.date, year, monthNumber); for (const category of section.categories) for (const entry of category.entries) entry.date = shiftDate(entry.date, year, monthNumber); }
    const oldKey = month.id; month.id = values.month;
    remapMonthPreferences(model.prefs.expandedMonths, oldKey, month.id);
    remapMonthPreferences(model.prefs.expandedIncome, oldKey, month.id);
    remapMonthPreferences(model.prefs.expandedCategories, oldKey, month.id);
    save(); render();
  });
}
function deleteMonth(month) {
  const count = listEntries(month).length; const incomeCount = Object.values(month.currencies).reduce((sum, section) => sum + section.incomes.length, 0); const detail = `${count} expense${count === 1 ? '' : 's'} and ${incomeCount} income item${incomeCount === 1 ? '' : 's'}`;
  if (!confirm(`Delete ${monthName(month.id)} and its ${detail}? This cannot be undone.`)) return; model.months = model.months.filter(item => item.id !== month.id); save(); render();
}
function handleAddIncome(month, currency) { chooseCurrency(month, currency, chosen => addIncome(month, chosen)); }
function handleAddExpense(month, currency, category, date) {
  chooseCurrency(month, currency, chosen => { const section = ensureCurrency(month, chosen); const selectedCategory = section.categories.find(item => item.id === category); if (!section.categories.length) return addCategory(month, chosen, null, created => addExpense(month, chosen, created, null, date)); addExpense(month, chosen, selectedCategory, null, date); });
}
function showDay(key) {
  activeDayKey = key; const month = findMonth(key.slice(0, 7)); const entries = month ? listEntries(month).filter(entry => entry.date === key).sort((a, b) => a.currency.localeCompare(b.currency) || a.item.localeCompare(b.item)) : [];
  document.querySelector('#day-title').textContent = new Date(`${key}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); const totals = {};
  entries.forEach(entry => { totals[entry.currency] = (totals[entry.currency] || 0) + Number(entry.amount); });
  document.querySelector('#day-content').innerHTML = `${entries.length ? `<div class="day-list">${entries.map(entry => `<div class="day-entry"><div class="day-entry-main"><span class="day-entry-title">${esc(entry.item)}${entry.shared ? ' · Shared' : ''}</span><span class="day-entry-meta">${esc(entry.category)} · ${esc(entry.currency)}${entry.place ? ` · ${esc(entry.place)}` : ''}</span></div><span class="day-entry-amount">${formatAmount(entry.amount, entry.currency)}</span><span class="section-actions"><button class="small-icon" data-action="edit-day-expense" data-month="${key.slice(0, 7)}" data-currency="${entry.currency}" data-category="${entry.categoryId}" data-id="${entry.id}" aria-label="Edit expense">✎</button><button class="small-icon" data-action="delete-day-expense" data-month="${key.slice(0, 7)}" data-currency="${entry.currency}" data-category="${entry.categoryId}" data-id="${entry.id}" aria-label="Delete expense">⌫</button></span></div>`).join('')}</div><div>${Object.entries(totals).sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => `<div class="day-total"><span>${esc(currency)} total</span><strong>${formatAmount(amount, currency)}</strong></div>`).join('')}</div>` : '<p class="day-empty">No expenses recorded for this date.</p>'}`;
  dayDialog.showModal();
}
function getTarget(button) {
  const month = findMonth(button.dataset.month); const section = month?.currencies[button.dataset.currency]; const category = section?.categories.find(item => item.id === button.dataset.category); const income = section?.incomes.find(item => item.id === button.dataset.id);
  const entry = category?.entries.find(item => item.id === button.dataset.id) || section?.categories.flatMap(item => item.entries).find(item => item.id === button.dataset.id);
  return { month, section, category, income, entry };
}
function deleteExpense(month, section, category, entry, currency) {
  if (!confirm(`Delete “${entry.item}” (${formatAmount(entry.amount, currency)})?`)) return; category.entries = category.entries.filter(item => item.id !== entry.id); save(); render(); if (activeDayKey) showDay(activeDayKey);
}
monthsElement.addEventListener('click', event => {
  const button = event.target.closest('[data-action]'); if (!button) return; const action = button.dataset.action; const { month, section, category, income, entry } = getTarget(button);
  if (action === 'select-calendar-year') { model.prefs.calendarYear = Number(button.dataset.year); model.prefs.expandedCalendarMonth = model.prefs.calendarYear === today.getFullYear() ? currentMonthKey() : null; save(); render(); }
  else if (action === 'toggle-calendar-month') { model.prefs.expandedCalendarMonth = model.prefs.expandedCalendarMonth === month.id ? null : month.id; save(); render(); }
  else if (action === 'toggle-month') { model.prefs.expandedMonths[month.id] = !model.prefs.expandedMonths[month.id]; save(); render(); }
  else if (action === 'toggle-category') { const key = categoryKey(month, button.dataset.currency, category); model.prefs.expandedCategories[key] = !model.prefs.expandedCategories[key]; save(); render(); }
  else if (action === 'toggle-income') { const key = sectionKey(month, button.dataset.currency); model.prefs.expandedIncome[key] = !model.prefs.expandedIncome[key]; save(); render(); }
  else if (action === 'add-currency') chooseCurrency(month, '', () => { save(); render(); });
  else if (action === 'add-income') handleAddIncome(month, button.dataset.currency)
  else if (action === 'edit-income') addIncome(month, button.dataset.currency, income)
  else if (action === 'delete-income' && confirm(`Delete income item “${income.source}”?`)) { section.incomes = section.incomes.filter(item => item.id !== income.id); save(); render(); }
  else if (action === 'carry-over') { const previous = findMonth(previousMonthKey(month.id))?.currencies[button.dataset.currency]; const balance = previous ? amountFor(previous).balance : 0; if (balance > 0) { section.incomes.push({ id: uid(), date: `${month.id}-01`, source: 'Previous month balance', amount: balance }); model.prefs.expandedIncome[sectionKey(month, button.dataset.currency)] = true; save(); render(); } }
  else if (action === 'add-category') chooseCurrency(month, button.dataset.currency, currency => addCategory(month, currency))
  else if (action === 'edit-category') addCategory(month, button.dataset.currency, category)
  else if (action === 'delete-category') { const count = category.entries.length; if (confirm(`Delete category “${category.name}”${count ? ` and its ${count} entr${count === 1 ? 'y' : 'ies'}` : ''}? This cannot be undone.`)) { section.categories = section.categories.filter(item => item.id !== category.id); save(); render(); } }
  else if (action === 'delete-currency') { const count = countEntries(section); const incomes = section.incomes.length; if (confirm(`Remove ${button.dataset.currency} section${count ? ` and its ${count} entr${count === 1 ? 'y' : 'ies'}` : ''}${incomes ? ` and ${incomes} income item${incomes === 1 ? '' : 's'}` : ''}? This cannot be undone.`)) { delete month.currencies[button.dataset.currency]; save(); render(); } }
  else if (action === 'add-expense') handleAddExpense(month, button.dataset.currency, button.dataset.category)
  else if (action === 'edit-expense') addExpense(month, button.dataset.currency, category, entry)
  else if (action === 'delete-expense') deleteExpense(month, section, category, entry, button.dataset.currency)
  else if (action === 'edit-month') editMonth(month)
  else if (action === 'delete-month') deleteMonth(month)
  else if (action === 'open-day') showDay(button.dataset.date);
});
document.querySelector('#dynamic-form').addEventListener('submit', event => {
  event.preventDefault(); if (!activeFormSubmit) return; const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  event.currentTarget.querySelectorAll('input[type="checkbox"]').forEach(input => { values[input.name] = input.checked; }); const submit = activeFormSubmit; activeFormSubmit = null; formDialog.close(); submit(values);
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelector('#add-month').addEventListener('click', addMonth); document.querySelector('#empty-add-month').addEventListener('click', addMonth);
document.querySelectorAll('.view-choice').forEach(button => button.addEventListener('click', () => { model.prefs.view = button.dataset.view; if (model.prefs.view === 'calendar' && model.prefs.expandedMonths[currentMonthKey()] === undefined) model.prefs.expandedMonths[currentMonthKey()] = true; save(); render(); }));
document.querySelector('#day-add').addEventListener('click', () => { const key = activeDayKey; const month = ensureMonth(key.slice(0, 7)); if (!model.prefs.expandedMonths[month.id]) model.prefs.expandedMonths[month.id] = true; dayDialog.close(); handleAddExpense(month, '', '', key); });
document.querySelector('#columns-button').addEventListener('click', () => { document.querySelector('#column-options').innerHTML = COLUMNS.map(column => `<label class="column-option"><input type="checkbox" name="${column}" ${model.prefs.visibleColumns.includes(column) ? 'checked' : ''}> ${COLUMN_LABELS[column]}</label>`).join(''); columnsDialog.showModal(); });
document.querySelector('#columns-form').addEventListener('submit', event => { event.preventDefault(); model.prefs.visibleColumns = [...event.currentTarget.querySelectorAll('input:checked')].map(input => input.name); save(); columnsDialog.close(); render(); });
dayDialog.addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (!button) return; const { month, section, category, entry } = getTarget(button); if (button.dataset.action === 'edit-day-expense') addExpense(month, button.dataset.currency, category, entry); else if (button.dataset.action === 'delete-day-expense') deleteExpense(month, section, category, entry, button.dataset.currency); });
dayDialog.addEventListener('close', () => { activeDayKey = null; });
function updateThemeButton() {
  const isDark = document.documentElement.classList.contains('dark');
  document.querySelector('#theme-icon').textContent = isDark ? '☀' : '☾';
  document.querySelector('#theme-toggle').title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  document.querySelector('#theme-toggle').setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
}
document.querySelector('#theme-toggle').addEventListener('click', () => {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  updateThemeButton();
});
updateThemeButton();
if (model.prefs.expandedCalendarMonth === undefined) model.prefs.expandedCalendarMonth = currentMonthKey();
if (model.prefs.view === 'calendar' && model.prefs.expandedMonths[currentMonthKey()] === undefined) model.prefs.expandedMonths[currentMonthKey()] = true;
render();