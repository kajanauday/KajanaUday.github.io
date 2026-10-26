// ExpenseStore: the single owner of ledger data, backed by Firebase Realtime Database (REST API).
//
// Firebase layout under `root`:
//   currencies/<cur>                 display config per currency (name, code, symbol, locale, color, order)
//   years/<year>                     one year, small enough to render the whole shell from:
//     currencies/<cur>               { from: "August", opening, carryIn }  start month; the year opens on `opening`, or on the
//                                    previous year's closing balance when carryIn is true
//     monthConfig/<year>_<Month>     { <cur>: { active, carry } }  per-month overrides: currency on/off, and whether the month
//                                    brings in the previous balance (default: active from `from`, carry on)
//     monthSections/<year>_<Month>/<cur>  { own: true, sections[{ name, type, subsections[] }] }  each month's own taxonomy per
//                                    currency; a month without one has no sections. (A legacy year-wide `sections[]` is moved
//                                    into every month once, on open, and then removed.)
//     metadata                       { entries, currencies[], <cur>: { income, expenses, balance, entries, opening, closing } }
//     months/<year>_<Month>          { name, month, currencies[], metadata: { entries, <cur>: { income, expenses, balance, entries,
//                                    closing, carried, previous } } }
//
// Carry-forward: a month that carries brings in the previous balance (the prior month's closing, or the year's opening for its
// first month) as income when positive or as an expense when negative; one that does not starts from zero. Month income and
// expenses include that carried amount; `carried` records it so the entries-only figures can always be recovered.
//   months/<year>_<Month>            that month's entries: <cur> → income/expenses → [{ category, total, count, entries[] }] → notes[]
//   events/<id>                      a special event (marriage, registration…): a standalone ledger like a month, whose entries
//                                    carry full dates and may fall in any month or year:
//                                    { name, year, created, include, currencies[], sections/<cur>[], entries: <cur> → income/expenses →
//                                    [{ category, total, count, entries[{ date, …, notes[{ date, … }] }] }] }
//                                    With `include` on, each entry also counts in the month of its date (totals, balances, the
//                                    year summary); a month's metadata keeps that share as `fromEvents` so it can be taken out.
//
// The shell (year tabs, month rows, year summary) is drawn from `years` alone. A month's entries are fetched only when it is
// opened (ensureMonth). Amounts are minor units (paise / sen). An entry with notes counts as the sum of its notes.
(function (global) {
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // A balance section (type 'net', drawn beside Income and Expenses) keeps its signed entries in a third bucket.
  const BUCKETS = [['income', 'income'], ['expenses', 'expense'], ['net', 'net']];
  const bucketOf = type => (type === 'income' ? 'income' : type === 'net' ? 'net' : 'expenses');
  const pad = n => String(n).padStart(2, '0');
  const monthIdOf = (year, monthIndex) => `${year}_${MONTH_NAMES[monthIndex]}`;
  const dateKeyOf = (year, monthIndex) => `${year}-${pad(monthIndex + 1)}`;
  const noteTotal = (amount, notes) => (notes.length ? notes.reduce((sum, note) => sum + Number(note.amount), 0) : Number(amount));
  const zeroTotals = () => ({ income: 0, expenses: 0, entries: 0 });
  const otherSectionName = type => (type === 'income' ? 'Other income' : type === 'net' ? 'Other balance' : 'Other expenses');

  // Amount fields accept a formula such as "=(210+178)+178": + - * /, brackets and decimals only. A small parser
  // works it out; nothing is passed to eval. Returns { value, formula } in major units, or { error } / { empty }.
  function readAmount(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { empty: true };
    if (!text.startsWith('=')) {
      const value = Number(text.replace(/,/g, ''));
      return Number.isFinite(value) ? { value, formula: null } : { error: true };
    }
    const src = text.slice(1).replace(/[\s,]/g, '');
    let at = 0;
    const fail = () => { throw new Error('bad formula'); };
    const sum = () => {
      let value = product();
      while (src[at] === '+' || src[at] === '-') value = src[at++] === '+' ? value + product() : value - product();
      return value;
    };
    const product = () => {
      let value = unary();
      while (src[at] === '*' || src[at] === '/') value = src[at++] === '*' ? value * unary() : value / unary();
      return value;
    };
    const unary = () => {
      if (src[at] === '-') { at++; return -unary(); }
      if (src[at] === '+') { at++; return unary(); }
      if (src[at] === '(') {
        at++;
        const value = sum();
        if (src[at++] !== ')') fail();
        return value;
      }
      const match = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(at));
      if (!match) fail();
      at += match[0].length;
      return Number(match[0]);
    };
    try {
      if (!src) fail();
      const value = sum();
      if (at !== src.length || !Number.isFinite(value)) fail();
      return { value, formula: `=${src}` };
    } catch (error) {
      return { error: true };
    }
  }

  function iconFor(category, type) {
    if (type === 'income') return 'ti-arrow-down-left';
    const key = category.toLowerCase();
    if (key.includes('food') || key.includes('dining') || key.includes('grocer')) return 'ti-tools-kitchen-2';
    if (key.includes('travel') || key.includes('transport')) return 'ti-train';
    if (key.includes('house') || key.includes('rent')) return 'ti-home';
    if (key.includes('util')) return 'ti-bolt';
    if (key.includes('shop')) return 'ti-shopping-bag';
    return 'ti-receipt';
  }

  // One key per name for de-duplication: same letters regardless of case, repeated spaces, Unicode composition or the
  // invisible joiners Telugu text often carries.
  const nameKey = name => String(name ?? '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

  class FirebaseDb {
    // readOnly (view-only accounts): reads as usual, but every write is dropped here, before any request is made.
    // auth, when given, resolves to a Firebase Auth ID token that goes with every request, so database rules can tell
    // the admin from a view-only account.
    constructor(databaseURL, root, readOnly = false, auth = null) {
      this.base = `${databaseURL.replace(/\/$/, '')}/${root}`;
      this.readOnly = readOnly;
      this.auth = auth;
    }
    async request(path, options) {
      const token = this.auth ? await this.auth() : null;
      const response = await fetch(`${this.base}${path ? `/${path}` : ''}.json${token ? `?auth=${encodeURIComponent(token)}` : ''}`, options);
      if (!response.ok) throw new Error(`Firebase ${options?.method || 'GET'} ${path || '/'} failed: HTTP ${response.status}`);
      return response.json();
    }
    get(path) { return this.request(path); }
    // Multi-path update: keys are paths under root, null deletes. Applied atomically.
    patch(update) { return this.readOnly ? Promise.resolve(null) : this.request('', { method: 'PATCH', body: JSON.stringify(update) }); }
  }

  // Firebase drops empty arrays and objects, so restore them before the UI reads a year.
  const normalizeSections = sections => (sections || []).map(section => ({ ...section, subsections: section.subsections || [] }));
  function normalizeYear(year = {}) {
    year.currencies ||= {};
    if (year.sections) year.sections = normalizeSections(year.sections);
    year.monthSections ||= {};
    Object.values(year.monthSections).forEach(month => Object.values(month).forEach(own => { own.sections = normalizeSections(own.sections); }));
    year.metadata ||= { entries: 0 };
    year.metadata.currencies ||= [];
    year.months ||= {};
    year.monthConfig ||= {};
    Object.values(year.months).forEach(month => {
      month.currencies ||= [];
      month.metadata ||= { entries: 0 };
    });
    return year;
  }

  // One stored month → flat entries; notes become sub-entries of their entry. Ids are derived from position.
  function flattenMonth(monthId, currencies, currencyKeys) {
    const year = monthId.slice(0, 4);
    const dateKey = dateKeyOf(year, MONTH_NAMES.indexOf(monthId.slice(5)));
    const list = [];
    currencyKeys.forEach(currency => {
      const buckets = currencies?.[currency];
      if (!buckets) return;
      let index = 0;
      BUCKETS.forEach(([bucket, type]) => {
        (buckets[bucket] || []).forEach(({ category, entries = [] }) => entries.forEach(({ day, notes = [], ...entry }) => {
          const id = `${currency}-${dateKey}-${++index}`;
          list.push({ ...entry, id, date: `${dateKey}-${pad(day)}`, property: currency, type, category });
          notes.forEach(({ day: noteDay, ...note }, n) => list.push({ ...note, id: `${id}-note-${n + 1}`, parentId: id, date: `${dateKey}-${pad(noteDay ?? day)}`, property: currency, type, category }));
        }));
      });
    });
    return list;
  }

  // Flat entries of one month → the stored month document (null when the month has no entries). An event's document is
  // the same shape, but entries and notes keep their full date instead of the day.
  function monthDoc(items, dated = false) {
    const doc = {};
    const childrenOf = new Map();
    items.filter(item => item.parentId).forEach(item => {
      if (!childrenOf.has(item.parentId)) childrenOf.set(item.parentId, []);
      childrenOf.get(item.parentId).push(item);
    });
    items.filter(item => !item.parentId).sort((a, b) => a.date.localeCompare(b.date)).forEach(item => {
      const groups = (doc[item.property] ||= { income: [], expenses: [] })[bucketOf(item.type)] ||= [];
      let group = groups.find(g => g.category === item.category);
      if (!group) groups.push(group = { category: item.category, total: 0, count: 0, entries: [] });
      const when = row => (dated ? { date: row.date } : { day: Number(row.date.slice(8, 10)) });
      const notes = (childrenOf.get(item.id) || []).map(note => ({ ...when(note), description: note.description, place: note.place || '', amount: Number(note.amount), ...(note.formula && { formula: note.formula }) }));
      const entry = { ...when(item), description: item.description, place: item.place || '', amount: Number(item.amount) };
      if (item.formula) entry.formula = item.formula;
      if (item.section) entry.section = item.section;
      entry.notes = notes;
      group.entries.push(entry);
      group.count += 1;
      group.total += noteTotal(entry.amount, notes);
    });
    return Object.keys(doc).length ? doc : null;
  }

  // Entries-only totals from a stored month's metadata (which includes any carried balance and any events' share).
  function rawFromStored(stored) {
    if (!stored) return zeroTotals();
    const carried = Number(stored.carried) || 0;
    const events = stored.fromEvents || zeroTotals();
    return { income: stored.income - Math.max(carried, 0) - (events.income || 0), expenses: stored.expenses - Math.max(-carried, 0) - (events.expenses || 0), entries: (stored.entries || 0) - (events.entries || 0) };
  }

  // One event's stored entries → flat items, marked with eventId so they never land in a month's document.
  function flattenEvent(eventId, currencies, currencyKeys) {
    const list = [];
    currencyKeys.forEach(currency => {
      const buckets = currencies?.[currency];
      if (!buckets) return;
      let index = 0;
      BUCKETS.forEach(([bucket, type]) => {
        (buckets[bucket] || []).forEach(({ category, entries = [] }) => entries.forEach(({ date, notes = [], ...entry }) => {
          const id = `ev:${eventId}:${currency}-${++index}`;
          list.push({ ...entry, id, eventId, date, property: currency, type, category });
          notes.forEach(({ date: noteDate, ...note }, n) => list.push({ ...note, id: `${id}-note-${n + 1}`, parentId: id, eventId, date: noteDate || date, property: currency, type, category }));
        }));
      });
    });
    return list;
  }
  function normalizeEvent(event = {}, currencyKeys = []) {
    const sections = event.sections || {};
    const currencies = (event.currencies || []).filter(key => currencyKeys.includes(key));
    return {
      name: event.name || 'Event',
      created: event.created || '',
      // The year whose list the event sits at the top of; older events take the year they were created in.
      year: Number(event.year) || Number(String(event.created || '').slice(0, 4)) || new Date().getFullYear(),
      include: Boolean(event.include),
      currencies: currencies.length ? currencies : currencyKeys.slice(0, 1),
      sections: Object.fromEntries(Object.entries(sections).map(([key, list]) => [key, normalizeSections(list)]))
    };
  }

  // A custom section (L1, beside Income and Expenses) is worked out like a small sheet, kept on the section as `calc`:
  //   vars     [{ id: 'E1', name }]: each subsection (L2) has a fixed id, standing for the sum of its entries (an entry
  //            counts as the sum of its notes). Ids follow renames and are never reused, so equations stay right.
  //   lines    ['Share = (E1 - E2) / 2', 'GI = TI', 'GB = GI - GE', …]: calculations, in any order. GI, GE and GB are
  //            the section's income, expenses and balance as shown in its heading: each only when a line sets it.
  //            TI and TE are its entries' own totals, positive ones and negative ones (as a positive sum), to use anywhere.
  //            Names are not case sensitive.
  //   income / expense  { mode, formula }: what goes to the month's actual income and expenses.
  //            mode 'count' shown there and added to its total; 'show' shown only; 'off' not used. Empty sends nothing.
  //   v        2 since GI / GE / GB are set by hand; before, they were always the entries' totals and an empty formula was GB.
  // Equations use numbers, + − * / ( ), and abs(), min(), max(), round(); amounts are in major units.
  const SIDE_MODES = ['count', 'show', 'off'];
  const CALC_FUNCTIONS = { ABS: Math.abs, MIN: Math.min, MAX: Math.max, ROUND: Math.round };
  const GRAND = ['GI', 'GE', 'GB'];
  const ENTRY_TOTALS = ['TI', 'TE'];
  const SUB_ID = /^E\d+$/;
  // Reads an expression into { refs, run(get) } or { error }; names are upper-cased.
  function parseCalc(text) {
    const tokens = String(text ?? '').match(/[A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*|\.\d+|\S/g) || [];
    let at = 0;
    const refs = new Set();
    const fail = message => { throw new Error(message); };
    const peek = () => tokens[at];
    const sum = () => {
      let node = product();
      while (peek() === '+' || peek() === '-') {
        const op = tokens[at++];
        const left = node;
        const right = product();
        node = get => (op === '+' ? left(get) + right(get) : left(get) - right(get));
      }
      return node;
    };
    const product = () => {
      let node = unary();
      while (peek() === '*' || peek() === '/') {
        const op = tokens[at++];
        const left = node;
        const right = unary();
        node = get => (op === '*' ? left(get) * right(get) : left(get) / right(get));
      }
      return node;
    };
    const unary = () => {
      if (peek() === '-') { at++; const inner = unary(); return get => -inner(get); }
      if (peek() === '+') { at++; return unary(); }
      return primary();
    };
    const primary = () => {
      const token = tokens[at++];
      if (token === undefined) fail('It ends too early.');
      if (token === '(') {
        const inner = sum();
        if (tokens[at++] !== ')') fail('A ( is not closed.');
        return inner;
      }
      if (/^[\d.]/.test(token)) {
        const value = Number(token);
        return () => value;
      }
      if (/^[A-Za-z_]/.test(token)) {
        const name = token.toUpperCase();
        if (CALC_FUNCTIONS[name]) {
          if (tokens[at++] !== '(') fail(`${token} needs ( ), like ${token.toLowerCase()}(GB).`);
          const args = [sum()];
          while (peek() === ',') { at++; args.push(sum()); }
          if (tokens[at++] !== ')') fail(`${token}( is not closed.`);
          return get => CALC_FUNCTIONS[name](...args.map(arg => arg(get)));
        }
        refs.add(name);
        return get => get(name);
      }
      return fail(`“${token}” is not allowed here.`);
    };
    try {
      if (!tokens.length) fail('It is empty.');
      const run = sum();
      if (at < tokens.length) fail(`“${tokens[at]}” is not expected there.`);
      return { refs, run };
    } catch (error) {
      return { error: error.message };
    }
  }
  // One calculation line: "Name = expression".
  function parseLine(text) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(String(text ?? ''));
    if (!match) return { error: 'Write it as Name = …, e.g. Share = E1 / 2.' };
    const name = match[1].toUpperCase();
    if (SUB_ID.test(name)) return { name: match[1], key: name, reserved: true, error: `${match[1]} is a subsection; give the result another name.` };
    if (CALC_FUNCTIONS[name]) return { name: match[1], key: name, reserved: true, error: `${match[1]} is a function name.` };
    if (ENTRY_TOTALS.includes(name)) return { name: match[1], key: name, reserved: true, error: `${match[1]} is the entries' own total and cannot be set.` };
    return { name: match[1], key: name, ...parseCalc(match[2]) };
  }
  const listOf = value => (Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []);
  // Ids for the subsections, keeping those already given and giving the next free number to new ones.
  function calcVars(vars, names) {
    const kept = listOf(vars).filter(item => item && SUB_ID.test(item.id) && typeof item.name === 'string').map(({ id, name }) => ({ id, name }));
    let next = kept.reduce((top, item) => Math.max(top, Number(item.id.slice(1))), 0);
    names.filter(name => !kept.some(item => item.name === name)).forEach(name => kept.push({ id: `E${++next}`, name }));
    return kept;
  }
  // The older ways a section counted: { expense, income } with equations on subsection names, before that { to, positive,
  // formula } with one equation; read here only to turn them into a calc.
  const sideRule = side => ({ mode: SIDE_MODES.includes(side?.mode) ? side.mode : 'off', formula: String(side?.formula ?? '').trim() });
  function legacyRule(section) {
    if (section?.expense || section?.income) return { expense: sideRule(section.expense), income: sideRule(section.income), sign: null };
    const to = ['expense', 'income', 'sign', 'none'].includes(section?.to) ? section.to : section?.count === 'none' ? 'none' : 'sign';
    const formula = String(section?.formula ?? '').trim();
    const one = mode => ({ mode, formula });
    const off = { mode: 'off', formula: '' };
    if (to === 'sign') return { expense: one('count'), income: one('count'), sign: section?.positive === 'expense' ? 'expense' : 'income' };
    return { expense: to === 'income' ? off : one(to === 'none' ? 'show' : 'count'), income: to === 'income' ? one('count') : off, sign: null };
  }
  const isNameChar = char => /[\p{L}\p{M}\p{N}_]/u.test(char || '');
  // Splits an old equation into subsection names (as written, or in [brackets]) and plain arithmetic.
  function readFormula(formula, names) {
    const byLength = [...names].sort((a, b) => b.length - a.length);
    const parts = [];
    const text = String(formula ?? '');
    for (let at = 0; at < text.length;) {
      if (text[at] === '[') {
        const end = text.indexOf(']', at);
        const inside = end < 0 ? '' : text.slice(at + 1, end).trim();
        const name = names.find(item => item.toLowerCase() === inside.toLowerCase());
        if (!name) return { error: true };
        parts.push({ name });
        at = end + 1;
        continue;
      }
      const name = !isNameChar(text[at - 1]) && byLength.find(item => text.slice(at, at + item.length).toLowerCase() === item.toLowerCase() && !isNameChar(text[at + item.length]));
      if (name) {
        parts.push({ name });
        at += name.length;
      } else if (/[0-9+\-*/().\s]/.test(text[at])) {
        parts.push(text[at++]);
      } else {
        return { error: true };
      }
    }
    return { parts };
  }
  // A section's calc: its own, or one made from an older rule (same results).
  function sectionCalc(section) {
    const names = section?.subsections || [];
    if (section?.calc) {
      const { calc } = section;
      return handSetGrand({
        vars: calcVars(calc.vars, names),
        lines: listOf(calc.lines).map(String),
        income: sideRule(calc.income),
        expense: sideRule(calc.expense),
        v: calc.v
      });
    }
    const vars = calcVars([], names);
    const rule = legacyRule(section);
    const totals = { Income: 'GI', Expenses: 'GE', Balance: 'GB' };
    const known = [...names, ...Object.keys(totals).filter(name => !names.some(sub => sub.toLowerCase() === name.toLowerCase()))];
    const convert = formula => {
      const read = formula && readFormula(formula, known);
      if (!read || read.error) return 'GB';
      return read.parts.map(part => (typeof part === 'string' ? part : vars.find(item => item.name === part.name)?.id || totals[part.name])).join('').replace(/\s+/g, ' ').trim();
    };
    const side = ({ mode, formula }) => ({ mode, formula: convert(formula) === 'GB' ? '' : convert(formula) });
    if (rule.sign) {
      // Oldest: the result went to one side by its sign.
      const formula = convert(rule.income.formula);
      const wrap = text => (/^[A-Za-z0-9_]+$/.test(text) ? text : `(${text})`);
      const positive = { mode: 'count', formula: `max(${formula}, 0)` };
      const negative = { mode: 'count', formula: `max(-${wrap(formula)}, 0)` };
      return handSetGrand({ vars, lines: [], income: rule.sign === 'income' ? positive : negative, expense: rule.sign === 'income' ? negative : positive });
    }
    return handSetGrand({ vars, lines: [], income: side(rule.income), expense: side(rule.expense) });
  }
  // An older calc used GI / GE / GB as the entries' totals without setting them, and sent GB for an empty formula: it gets
  // the lines that set the ones it uses, so it works out as before (and shows just those in its heading).
  function handSetGrand(calc) {
    if (calc.v === 2) return calc;
    ['income', 'expense'].forEach(type => {
      if (calc[type].mode !== 'off' && !calc[type].formula) calc[type].formula = 'GB';
    });
    const defined = new Set(calc.lines.map(line => parseLine(line).key).filter(Boolean));
    const used = [...calc.lines, calc.income.formula, calc.expense.formula].join(' ').toUpperCase();
    const sets = { GI: 'GI = TI', GE: 'GE = TE', GB: 'GB = TI - TE' };
    const added = GRAND.filter(name => !defined.has(name) && new RegExp(`\\b${name}\\b`).test(used)).map(name => sets[name]);
    return { ...calc, lines: [...added, ...calc.lines], v: 2 };
  }
  // Works a calc out on a section's entries ({ subsection → [amount…] }, minor units): each subsection's id and sum, each
  // line's value or problem, the section's GI / GE / GB, and what goes to the month's income and expenses.
  // A problem that stops an equation being used is `fatal` (it does not read, names something unknown, loops…); one
  // that only these amounts cause (dividing by zero) is not.
  function runCalc(section, amountsBySub, calc = sectionCalc(section)) {
    const names = [...new Set([...(section?.subsections || []), ...Object.keys(amountsBySub)])];
    const vars = calcVars(calc.vars, names);
    const major = minor => minor / 100;
    const all = names.flatMap(name => amountsBySub[name] || []);
    const income = all.filter(amount => amount > 0).reduce((sum, amount) => sum + amount, 0);
    const expenses = -all.filter(amount => amount < 0).reduce((sum, amount) => sum + amount, 0);
    const base = { TI: major(income), TE: major(expenses) };
    const subs = vars.filter(item => names.includes(item.name)).map(item => {
      const sum = (amountsBySub[item.name] || []).reduce((total, amount) => total + amount, 0);
      base[item.id] = major(sum);
      return { ...item, sum };
    });
    const lines = calc.lines.map(text => (String(text).trim() ? { text, ...parseLine(text) } : { text, blank: true }));
    const defs = new Map();
    lines.forEach(line => {
      if (line.key && defs.has(line.key)) Object.assign(line, { error: `${line.name} is set twice.` });
      else if (line.key && !line.reserved) defs.set(line.key, line);
      if (line.error) line.fatal = true;
    });
    const values = new Map();
    const busy = [];
    const problem = (message, fatal = true) => Object.assign(new Error(message), { fatal });
    const get = name => {
      if (values.has(name)) return values.get(name);
      const def = defs.get(name);
      if (!def) {
        if (name in base) return base[name];
        // A removed subsection's id counts as nothing.
        if (SUB_ID.test(name) && vars.some(item => item.id === name)) return 0;
        throw problem(GRAND.includes(name) ? `${name} is not set: add a line ${name} = …` : `${name} is not known here.`);
      }
      if (def.error) throw problem(`${def.name} has a problem.`, def.fatal);
      if (busy.includes(name)) throw problem(`It loops: ${[...busy.slice(busy.indexOf(name)), name].map(key => defs.get(key).name).join(' → ')}.`);
      busy.push(name);
      try {
        const value = def.run(get);
        if (!Number.isFinite(value)) throw problem(`${def.name} does not work out (dividing by zero?).`, false);
        values.set(name, value);
        return value;
      } finally {
        busy.pop();
      }
    };
    const work = run => {
      try {
        const value = run(get);
        return Number.isFinite(value) ? { value } : { error: 'It does not work out (dividing by zero?).', fatal: false };
      } catch (error) {
        return { error: error.message, fatal: error.fatal !== false };
      }
    };
    const results = lines.map(line => (line.error || line.blank ? null : work(() => get(line.key))));
    lines.forEach((line, index) => {
      const result = results[index];
      if (result) Object.assign(line, result.error ? { error: result.error, fatal: result.fatal } : { value: Math.round(result.value * 100) });
    });
    // Only the ones a line sets (and that work out) are shown.
    const grand = Object.fromEntries(GRAND.map(name => [name, defs.has(name) ? work(() => get(name)).value : undefined]));
    const minor = value => (value === undefined ? undefined : Math.round(value * 100));
    const stats = { income: minor(grand.GI), expenses: minor(grand.GE), balance: minor(grand.GB) };
    const label = section?.name || 'Section';
    const sides = {};
    const out = [];
    const adds = { income: 0, expenses: 0, lines: out };
    ['income', 'expense'].forEach(type => {
      const { mode, formula } = calc[type];
      const parsed = parseCalc(formula);
      const result = mode === 'off' || !formula.trim() ? { value: 0 } : parsed.error ? { error: parsed.error, fatal: true } : work(parsed.run);
      const amount = result.error ? 0 : Math.round(result.value * 100);
      sides[type] = { mode, formula, result: amount, error: result.error, fatal: result.fatal, empty: !formula.trim() };
      if (mode === 'off' || !formula.trim()) return;
      out.push({ type, label, amount, counted: mode === 'count' });
      if (mode === 'count') adds[type === 'income' ? 'income' : 'expenses'] += amount;
    });
    return { calc: { ...calc, vars }, subs, base, lines, stats, sides, adds };
  }
  const netSectionSummary = (section, amountsBySub) => runCalc(section, amountsBySub);
  const CALC_NAMES = { functions: Object.keys(CALC_FUNCTIONS), grand: GRAND, totals: ENTRY_TOTALS };
  // Gives a section its calc (turning an older rule into one) and returns it, for changes made to it.
  function ensureCalc(section) {
    const calc = sectionCalc(section);
    ['to', 'positive', 'count', 'formula', 'subRules', 'expense', 'income'].forEach(key => delete section[key]);
    section.calc = calc;
    return calc;
  }
  function docTotals(buckets, rules = new Map()) {
    const totals = zeroTotals();
    const balances = new Map();
    BUCKETS.forEach(([bucket]) => (buckets?.[bucket] || []).forEach(group => {
      totals.entries += group.count;
      if (bucket !== 'net') {
        totals[bucket] += group.total;
        return;
      }
      (group.entries || []).forEach(entry => {
        const bySub = (balances.get(entry.section || '') || balances.set(entry.section || '', {}).get(entry.section || ''));
        (bySub[group.category] ||= []).push(noteTotal(entry.amount, entry.notes || []));
      });
    }));
    balances.forEach((amountsBySub, key) => {
      const { adds } = netSectionSummary(rules.get(key), amountsBySub);
      totals.income += adds.income;
      totals.expenses += adds.expenses;
    });
    return totals;
  }

  class ExpenseStore {
    // Build with ExpenseStore.open(), which reads currencies and years (not entries) from Firebase.
    constructor({ db, currencies, years, events = {} }) {
      this.db = db;
      this.currencies = currencies;
      this.years = years;
      this.transactions = [];
      this.synced = new Map();   // monthId → JSON of the month document as Firebase holds it
      this.loading = new Map();  // monthId → in-flight fetch
      this.writes = Promise.resolve();
      this.events = {};
      this.eventSynced = new Map(); // eventId → JSON of its entries document as Firebase holds it
      Object.entries(events || {}).forEach(([id, event]) => this.addEvent(id, event));
    }
    // readOnly opens a store that can never write to Firebase (view-only accounts); auth supplies the ID token per request.
    // `offline`, when given ({ vault, deviceId, onState, onConflict }), puts the device's copy and its outbox behind the
    // same get/patch: the app then opens and takes new entries with no connection, and sends them when one returns.
    static async open({ databaseURL, root, readOnly = false, auth = null, offline = null }) {
      const wire = new FirebaseDb(databaseURL, root, readOnly, auth);
      const db = offline?.vault ? new OfflineSync(offline.vault, wire, { ...offline, readOnly }) : wire;
      const [currencies, years, events] = await Promise.all([db.get('currencies'), db.get('years'), db.get('events')]);
      const ordered = Object.fromEntries(Object.entries(currencies || {}).sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0)));
      Object.values(years || {}).forEach(normalizeYear);
      const store = new ExpenseStore({ db, currencies: ordered, years: years || {}, events: events || {} });
      store.sync = db === wire ? null : db;
      // Rebuild metadata in memory so carried balances show even for data saved before they existed; the next save writes it.
      store.yearIds().forEach(year => store.recomputeYear(year));
      await store.moveYearSectionsToMonths();
      await store.migrateEventSections();
      return store;
    }
    // One-time move from year-wide sections to per-month lists. Every month and currency that is on or has entries, and has
    // no list of its own, gets the year's sections with only the subsections it uses; then the year's list is dropped.
    // Nothing is written unless every month of those years loaded. If the write fails, the moved lists stay in memory and
    // the next save writes them with the year; the next open moves again from whatever Firebase still holds.
    async moveYearSectionsToMonths() {
      const years = this.yearIds().filter(year => this.year(year).sections?.length);
      if (!years.length) return;
      await Promise.all(years.map(year => this.ensureYear(year)));
      years.forEach(year => {
        const node = this.year(year);
        MONTH_NAMES.forEach((_, monthIndex) => {
          const id = monthIdOf(year, monthIndex);
          const month = node.monthSections[id] || {};
          const setup = this.monthSetup(year, monthIndex);
          this.currencyKeys().forEach(currency => {
            const items = this.items(year, currency, monthIndex);
            if (month[currency] || !(setup[currency].active || items.length)) return;
            const used = (type, name) => items.some(item => item.type === type && item.category === name);
            month[currency] = { own: true, sections: node.sections.map(section => ({ ...section, subsections: section.subsections.filter(name => used(section.type, name)) })) };
          });
          if (Object.keys(month).length) node.monthSections[id] = month;
        });
        delete node.sections;
      });
      const update = this.recomputeFrom(years[0]);
      await this.queue(() => this.db.patch(update)).catch(error => console.error('Could not save the per-month sections.', error));
    }

    // ---- shell: years, months and their metadata ----
    currencyKeys() { return Object.keys(this.currencies); }
    ordered(list) { return this.currencyKeys().filter(key => list.includes(key)); }
    yearIds() { return Object.keys(this.years).sort(); }
    year(year) { return this.years[String(year)]; }
    // A month's sections for one currency; a month that has none set up has an empty list.
    sections(year, monthIndex, currency) {
      return this.year(year)?.monthSections[monthIdOf(year, monthIndex)]?.[currency]?.sections || [];
    }
    // An editable copy of a month's sections, for the month settings dialog.
    sectionsDraft(year, monthIndex, currency) {
      return this.sections(year, monthIndex, currency).map(section => ({ ...section, subsections: [...section.subsections] }));
    }
    // The month's own list for a currency, created empty if it has none yet.
    ownSections(year, monthIndex, currency) {
      const month = this.year(year).monthSections[monthIdOf(year, monthIndex)] ||= {};
      month[currency] ||= { own: true, sections: [] };
      return month[currency].sections;
    }
    saveMonthSections(year, monthIndex, currency, sections) {
      const node = this.year(year);
      (node.monthSections[monthIdOf(year, monthIndex)] ||= {})[currency] = { own: true, sections: normalizeSections(sections) };
      const update = this.recomputeFrom(String(year));
      return this.queue(() => this.db.patch(update));
    }
    monthNode(year, monthIndex) { return this.year(year)?.months[monthIdOf(year, monthIndex)]; }
    monthCurrencies(year, monthIndex) { return this.ordered(this.monthNode(year, monthIndex)?.currencies || []); }
    yearCurrencies(year) { return this.ordered(this.year(year)?.metadata.currencies || []); }
    monthTotals(year, monthIndex, currency) {
      return { income: 0, expenses: 0, balance: 0, entries: 0, closing: 0, carried: 0, previous: 0, ...this.monthNode(year, monthIndex)?.metadata[currency] };
    }
    // Effective per-currency setup of a month: { <cur>: { active, carry } }, month overrides over the year's defaults.
    monthSetup(year, monthIndex) {
      const node = this.year(year);
      const override = node?.monthConfig?.[monthIdOf(year, monthIndex)] || {};
      return Object.fromEntries(this.currencyKeys().map(key => {
        const config = node?.currencies[key];
        const byYear = Boolean(config) && MONTH_NAMES.indexOf(config.from) <= monthIndex;
        return [key, { active: override[key]?.active ?? byYear, carry: override[key]?.carry ?? true }];
      }));
    }
    // Where a month's carried balance comes from: the previous active month, else the year's opening.
    carriedFrom(year, monthIndex, currency) {
      for (let index = monthIndex - 1; index >= 0; index--) {
        if (this.monthNode(year, index)?.currencies.includes(currency)) return MONTH_NAMES[index];
      }
      return this.year(year)?.currencies[currency]?.carryIn ? String(Number(year) - 1) : 'opening balance';
    }
    // The balance a year opens on for a currency: the previous year's closing when carried in, else the set amount.
    yearOpening(year, currency) {
      const config = this.year(year)?.currencies[currency];
      if (config?.carryIn) return this.year(Number(year) - 1) ? Number(this.yearTotals(Number(year) - 1, currency).closing) || 0 : 0;
      return Number(config?.opening) || 0;
    }
    yearTotals(year, currency) {
      return { income: 0, expenses: 0, balance: 0, entries: 0, opening: 0, closing: 0, ...this.year(year)?.metadata[currency] };
    }

    // ---- lazy month loading ----
    isLoaded(year, monthIndex) { return this.synced.has(monthIdOf(year, monthIndex)); }
    ensureMonth(year, monthIndex) {
      const id = monthIdOf(year, monthIndex);
      if (this.synced.has(id)) return Promise.resolve();
      if (!this.loading.has(id)) {
        this.loading.set(id, this.db.get(`months/${id}`).then(data => {
          const items = flattenMonth(id, data, this.currencyKeys());
          this.transactions.push(...items);
          this.synced.set(id, JSON.stringify(monthDoc(items)));
        }).finally(() => this.loading.delete(id)));
      }
      return this.loading.get(id);
    }
    addEvent(id, stored = {}) {
      this.events[id] = normalizeEvent(stored, this.currencyKeys());
      const items = flattenEvent(id, stored.entries, this.currencyKeys());
      this.transactions.push(...items);
      this.eventSynced.set(id, JSON.stringify(monthDoc(items, true)));
    }
    ensureYear(year) {
      return Promise.all(MONTH_NAMES.map((_, monthIndex) => this.ensureMonth(year, monthIndex)));
    }

    // ---- persistence ----
    // Metadata is rebuilt immediately so the UI shows new totals at once; the write is queued so writes land in order.
    // `year`, when given, is rebuilt and written even if no month's entries changed (e.g. only its section lists did).
    saveTransactions(year) {
      const update = {};
      const years = new Set(year ? [String(year)] : []);
      const monthItems = this.transactions.filter(item => !item.eventId);
      this.synced.forEach((json, id) => {
        const year = id.slice(0, 4);
        const doc = monthDoc(monthItems.filter(item => item.date.startsWith(dateKeyOf(year, MONTH_NAMES.indexOf(id.slice(5))))));
        const next = JSON.stringify(doc);
        if (next === json) return;
        update[`months/${id}`] = doc;
        this.synced.set(id, next);
        years.add(year);
      });
      // An event's entries are saved with the event; when it shows in months, every year's totals are rebuilt.
      this.eventSynced.forEach((json, id) => {
        const doc = monthDoc(this.transactions.filter(item => item.eventId === id), true);
        const next = JSON.stringify(doc);
        if (next === json) return;
        update[`events/${id}/entries`] = doc;
        this.eventSynced.set(id, next);
        if (this.events[id]?.include && this.yearIds().length) years.add(this.yearIds()[0]);
      });
      if (years.size) Object.assign(update, this.recomputeFrom([...years].sort()[0]));
      return this.queue(() => (Object.keys(update).length ? this.db.patch(update) : null));
    }
    // Writes a year's configuration ({ currencies }) and its rebuilt metadata. Creates the year if new.
    saveYear(year, config) {
      const key = String(year);
      this.years[key] = normalizeYear({ ...this.years[key], ...config });
      const update = this.recomputeFrom(key);
      return this.queue(() => this.db.patch(update));
    }
    // Writes one month's currency setup ({ <cur>: { active, carry } }) and the rebuilt metadata.
    saveMonthSetup(year, monthIndex, setup) {
      const node = this.year(year);
      node.monthConfig[monthIdOf(year, monthIndex)] = setup;
      const update = this.recomputeFrom(String(year));
      return this.queue(() => this.db.patch(update));
    }
    // A year's balances feed the next year's opening when it carries in, so later years are rebuilt too.
    recomputeFrom(year) {
      return Object.fromEntries(this.yearIds().filter(id => id >= String(year)).map(id => [`years/${id}`, this.recomputeYear(id)]));
    }
    queue(write) {
      const result = this.writes.then(write);
      this.writes = result.catch(() => {});
      return result;
    }

    // Month totals come from loaded entries when the month is loaded, otherwise from the stored metadata (minus its carry).
    // Each active month opens on the previous balance when it carries, or on zero when it does not.
    // An upcoming month (one that has not begun) carries nothing in: the current month's balance is not known until it
    // ends, so an upcoming month shows only its own entries. The running balance still passes through it underneath, so
    // later totals and the year's closing are unchanged; once the month begins, the next recompute (every time the app
    // opens) carries the balance in as usual.
    recomputeYear(year) {
      const node = this.year(year);
      const now = new Date();
      const keys = this.currencyKeys().filter(key => node.currencies[key] || Object.values(node.monthConfig).some(month => month?.[key]?.active));
      const running = {};
      const sums = {};
      const months = {};
      MONTH_NAMES.forEach((name, monthIndex) => {
        const id = monthIdOf(year, monthIndex);
        const setup = this.monthSetup(year, monthIndex);
        const active = keys.filter(key => setup[key].active);
        const doc = this.synced.has(id) ? JSON.parse(this.synced.get(id)) : null;
        const metadata = { entries: 0 };
        active.forEach(key => {
          const own = this.synced.has(id) ? docTotals(doc?.[key], this.netRules(year, monthIndex, key)) : rawFromStored(node.months[id]?.metadata?.[key]);
          const fromEvents = this.eventMonthTotals(year, monthIndex, key);
          const raw = { income: own.income + fromEvents.income, expenses: own.expenses + fromEvents.expenses, entries: own.entries + fromEvents.entries };
          const first = !(key in running);
          const previous = first ? this.yearOpening(year, key) : running[key];
          const upcoming = new Date(Number(year), monthIndex, 1) > now;
          const carried = setup[key].carry && !upcoming ? previous : 0;
          const income = raw.income + Math.max(carried, 0);
          const expenses = raw.expenses + Math.max(-carried, 0);
          running[key] = upcoming ? (setup[key].carry ? previous : 0) + raw.income - raw.expenses : income - expenses;
          metadata[key] = { income, expenses, balance: income - expenses, entries: raw.entries, closing: upcoming ? income - expenses : running[key], carried, previous, ...(upcoming && { upcoming: true }), ...(fromEvents.entries && { fromEvents }) };
          metadata.entries += raw.entries;
          const sum = sums[key] ||= { ...zeroTotals(), opening: previous, carriedIn: first ? carried : 0 };
          sum.income += raw.income;
          sum.expenses += raw.expenses;
          sum.entries += raw.entries;
        });
        months[id] = { name, month: monthIndex + 1, currencies: active, metadata };
      });
      // The year counts its entries plus the balance it opened on; month-to-month carries are internal and not re-counted.
      const metadata = { entries: 0, currencies: Object.keys(sums) };
      Object.entries(sums).forEach(([key, sum]) => {
        const income = sum.income + Math.max(sum.carriedIn, 0);
        const expenses = sum.expenses + Math.max(-sum.carriedIn, 0);
        metadata[key] = { income, expenses, balance: income - expenses, entries: sum.entries, opening: sum.opening, closing: running[key] };
        metadata.entries += sum.entries;
      });
      Object.assign(node, { months, metadata });
      return node;
    }

    // ---- special events ----
    // An event is a standalone ledger: its own sections, entries and notes, each entry dated in any month. With `include`
    // on, its entries also count in their months; edits always happen in the event.
    eventList() {
      return Object.entries(this.events).map(([id, event]) => ({ id, ...event })).sort((a, b) => a.name.localeCompare(b.name));
    }
    eventName(id) { return this.events[id]?.name || ''; }
    eventItems(id, currency) { return this.transactions.filter(item => item.eventId === id && (!currency || item.property === currency)); }
    eventSections(id, currency) { return this.events[id]?.sections[currency] || []; }
    // The currencies an event is tagged with, plus any it still holds entries in, in display order.
    eventCurrencies(id) {
      const tagged = this.events[id]?.currencies || [];
      return this.ordered([...new Set([...tagged, ...this.eventItems(id).map(item => item.property)])]);
    }
    // The event's editable list for a currency: an expense section named after the event, and an Income section for money
    // it brings in (gifts, refunds…). Either is added if missing, so both can always be used.
    ownEventSections(id, currency) {
      const event = this.events[id];
      const list = event.sections[currency] ||= [];
      if (!list.some(section => section.type === 'expense')) list.unshift({ name: event.name, type: 'expense', subsections: [] });
      if (!list.some(section => section.type === 'income')) list.push({ name: 'Income', type: 'income', subsections: [] });
      return list;
    }
    // One-time move of events made before that: their default "Expenses" section takes the event's name (in the list and
    // on its entries). Written back once; nothing else changes.
    async migrateEventSections() {
      const update = {};
      Object.entries(this.events).forEach(([id, event]) => {
        let changed = false;
        Object.entries(event.sections).forEach(([currency, list]) => {
          const items = this.eventItems(id, currency);
          const legacy = list.find(section => section.type === 'expense' && section.name === 'Expenses');
          if (legacy && !list.some(section => nameKey(section.name) === nameKey(event.name))) {
            legacy.name = event.name;
            items.filter(item => item.section === 'Expenses').forEach(item => { item.section = event.name; });
            changed = true;
          }
        });
        if (!changed) return;
        update[`events/${id}/sections`] = event.sections;
        const doc = monthDoc(this.eventItems(id), true);
        update[`events/${id}/entries`] = doc;
        this.eventSynced.set(id, JSON.stringify(doc));
      });
      if (!Object.keys(update).length) return;
      await this.queue(() => this.db.patch(update)).catch(error => console.error('Could not save the event sections.', error));
    }
    // Each custom section of a month and currency (with its rules), by name.
    netRules(year, monthIndex, currency) {
      return new Map(this.sections(year, monthIndex, currency).filter(section => section.type === 'net').map(section => [section.name, section]));
    }
    // Entries-only totals that included events add to one month and currency.
    eventMonthTotals(year, monthIndex, currency) {
      const totals = zeroTotals();
      const prefix = dateKeyOf(year, monthIndex);
      this.transactions.forEach(item => {
        if (!item.eventId || item.parentId || item.property !== currency || !item.date.startsWith(prefix) || !this.events[item.eventId]?.include) return;
        totals[item.type === 'income' ? 'income' : 'expenses'] += this.entryTotal(item.id);
        totals.entries += 1;
      });
      return totals;
    }
    // A year shows an event only if the event was created for that year, or one of its entries is dated in it.
    eventsOfYear(year) {
      const prefix = `${Number(year)}-`;
      return this.eventList().filter(event => event.year === Number(year) || this.eventItems(event.id).some(item => item.date.startsWith(prefix)));
    }
    createEvent(id, name, year, currencies = []) {
      this.events[id] = normalizeEvent({ name, year, currencies, created: new Date().toISOString().slice(0, 10) }, this.currencyKeys());
      this.eventSynced.set(id, 'null');
      const { sections, ...meta } = this.events[id];
      return this.queue(() => this.db.patch({ [`events/${id}`]: meta }));
    }
    // Saves an event's own settings (name, currencies, sections, include) without touching its entries. Turning `include`
    // on or off rebuilds every year's totals.
    saveEventMeta(id, fields) {
      const event = this.events[id];
      const rebuild = 'include' in fields && Boolean(fields.include) !== event.include;
      Object.assign(event, fields, 'include' in fields ? { include: Boolean(fields.include) } : {});
      const update = Object.fromEntries(Object.keys(fields).map(key => [`events/${id}/${key}`, event[key]]));
      if (rebuild && this.yearIds().length) Object.assign(update, this.recomputeFrom(this.yearIds()[0]));
      return this.queue(() => this.db.patch(update));
    }
    deleteEvent(id) {
      const included = this.events[id]?.include;
      delete this.events[id];
      this.eventSynced.delete(id);
      for (let index = this.transactions.length - 1; index >= 0; index--) if (this.transactions[index].eventId === id) this.transactions.splice(index, 1);
      const update = { [`events/${id}`]: null };
      if (included && this.yearIds().length) Object.assign(update, this.recomputeFrom(this.yearIds()[0]));
      return this.queue(() => this.db.patch(update));
    }
    // One currency's tree for an event, in the same shape as country() so the month panel can draw it.
    eventCountry(id, currency) {
      const region = this.currencies[currency];
      const items = this.eventItems(id, currency);
      const totals = { income: 0, expense: 0 };
      items.filter(item => !item.parentId).forEach(item => { totals[item.type === 'income' ? 'income' : 'expense'] += this.entryTotal(item.id); });
      return {
        _meta: { id: currency, name: region.name, code: region.code, color: region.color, income: totals.income, expense: totals.expense, closing: totals.income - totals.expense, carried: 0, carriedFrom: '' },
        sections: this.groupIntoSections(items, this.eventSections(id, currency))
      };
    }

    // ---- name catalogue ----
    // Every section and subsection name used anywhere (all years, months and currencies), de-duplicated by nameKey within
    // its type. `uses` counts the month lists and loaded entries that use a name, so suggestions can rank common ones
    // first; the spelling shown is the one used most. Worked out from the data each time, so it never goes stale.
    nameCatalog() {
      const tally = () => new Map();
      const sections = tally();
      const subsections = tally();
      const add = (map, type, name, weight) => {
        const key = `${type}:${nameKey(name)}`;
        if (!nameKey(name)) return;
        const entry = map.get(key) || { key, type, uses: 0, spellings: new Map() };
        entry.uses += weight;
        entry.spellings.set(name, (entry.spellings.get(name) || 0) + weight);
        map.set(key, entry);
      };
      Object.values(this.years).forEach(node => Object.values(node.monthSections || {}).forEach(month => Object.values(month).forEach(own => {
        own.sections.forEach(section => {
          add(sections, section.type, section.name, 1);
          section.subsections.forEach(name => add(subsections, section.type, name, 1));
        });
      })));
      Object.values(this.events).forEach(event => Object.values(event.sections).forEach(list => list.forEach(section => {
        add(sections, section.type, section.name, 1);
        section.subsections.forEach(name => add(subsections, section.type, name, 1));
      })));
      this.transactions.filter(item => !item.parentId).forEach(item => {
        add(subsections, item.type, item.category, 1);
        if (item.section) add(sections, item.type, item.section, 1);
      });
      const finish = map => [...map.values()].map(({ spellings, ...entry }) => ({ ...entry, name: [...spellings].sort((a, b) => b[1] - a[1])[0][0] }));
      return { sections: finish(sections), subsections: finish(subsections) };
    }

    // Entry and note descriptions from the loaded months, de-duplicated by nameKey: { entries, notes }, each item
    // { name, uses, last (latest date), categories (subsection keys it was filed under) }. Feeds description suggestions.
    descriptionCatalog() {
      const lists = { entries: new Map(), notes: new Map() };
      this.transactions.forEach(item => {
        const key = nameKey(item.description);
        if (!key) return;
        const map = item.parentId ? lists.notes : lists.entries;
        const entry = map.get(key) || { uses: 0, last: '', spellings: new Map(), categories: new Set() };
        entry.uses += 1;
        if (item.date > entry.last) entry.last = item.date;
        entry.spellings.set(item.description, (entry.spellings.get(item.description) || 0) + 1);
        entry.categories.add(`${item.type}:${nameKey(item.category)}`);
        map.set(key, entry);
      });
      const finish = map => [...map.values()].map(({ spellings, ...entry }) => ({ ...entry, name: [...spellings].sort((a, b) => b[1] - a[1])[0][0] }));
      return { entries: finish(lists.entries), notes: finish(lists.notes) };
    }

    // ---- year breakdown ----
    isYearLoaded(year) { return MONTH_NAMES.every((_, monthIndex) => this.isLoaded(year, monthIndex)); }
    // Entries-only totals for one currency across the whole year (every month loaded): section → subsection → item, with
    // names de-duplicated by nameKey. Items are what a subsection was spent on: each note of an entry with notes (e.g.
    // "EMI - Home Loan" under EMIలు), or the entry itself when it has none. An entry without a stored section is placed
    // by its month's list, else under "Other". A section is `renamable` when it is a real section (stored on entries or
    // in a month's list), not an event's ★ section or the "Other" fallback.
    yearBreakdown(year, currency) {
      const byType = { income: new Map(), expense: new Map(), net: new Map() };
      MONTH_NAMES.forEach((_, monthIndex) => {
        const lists = this.sections(year, monthIndex, currency);
        this.items(year, currency, monthIndex, { withEvents: true }).filter(item => !item.parentId).forEach(item => {
          const { name: sectionName, source } = this.summarySection(item, lists);
          const total = this.entryTotal(item.id);
          const sections = byType[item.type in byType ? item.type : 'expense'];
          const section = sections.get(nameKey(sectionName)) || { name: sectionName, total: 0, subsections: new Map(), renamable: false, event: false };
          section.total += total;
          if (source === 'stored' || source === 'list') section.renamable = true;
          if (source === 'event') section.event = true;
          sections.set(nameKey(sectionName), section);
          const sub = section.subsections.get(nameKey(item.category)) || { name: item.category, total: 0, entries: 0, months: new Set(), items: new Map() };
          sub.total += total;
          sub.entries += 1;
          sub.months.add(monthIndex);
          section.subsections.set(nameKey(item.category), sub);
          const notes = this.transactions.filter(note => note.parentId === item.id);
          (notes.length ? notes.map(note => [note.description, Number(note.amount)]) : [[item.description, total]]).forEach(([name, amount]) => {
            const key = nameKey(name) || '—';
            const part = sub.items.get(key) || { name: name || '—', total: 0, count: 0, months: new Set() };
            part.total += amount;
            part.count += 1;
            part.months.add(monthIndex);
            sub.items.set(key, part);
          });
        });
      });
      const sorted = map => [...map].map(([key, value]) => ({ ...value, key })).sort((a, b) => b.total - a.total);
      const finish = sections => sorted(sections).map(section => ({
        ...section,
        subsections: sorted(section.subsections).map(sub => ({ ...sub, months: sub.months.size, items: sorted(sub.items).map(part => ({ ...part, months: part.months.size })) }))
      }));
      return { expense: finish(byType.expense), income: finish(byType.income), net: finish(byType.net) };
    }

    // The section the year summary files an entry under, and where that came from: 'event' (★ event name), 'stored' (the
    // entry's own section), 'list' (the month's list section holding its subsection) or 'other' (neither).
    summarySection(item, lists) {
      if (item.eventId) return { name: `★ ${this.eventName(item.eventId)}`, source: 'event' };
      if (item.section) return { name: item.section, source: 'stored' };
      const listed = lists.find(section => section.type === item.type && section.subsections.includes(item.category))?.name;
      if (listed) return { name: listed, source: 'list' };
      return { name: otherSectionName(item.type), source: 'other' };
    }

    // ---- year-wide rename (from the year summary) ----
    // Renames one year-summary row for one currency across the whole year: a section, a subsection or an item.
    // target: { level: 'section' | 'sub' | 'item', type, section, sub?, item? }, keys as yearBreakdown gives them (nameKey).
    //   section  every month's list section of that name and type, and every entry (and note) that stores it
    //   sub      in that section, every month's list name and every entry (and its notes) filed under it
    //   item     in that subsection, every note (or note-less entry) of that description
    // Names that already exist where the new name lands are merged: two sections become one list section, a subsection
    // already listed by another section of the month moves there (category names are unique per type within a month).
    // Returns { entries, months, merged, apply() }; nothing changes until apply(), then save with saveTransactions(year).
    planRename(year, currency, target, name) {
      const oldKey = target[target.level];
      const newKey = nameKey(name);
      const changes = [];
      const months = new Set();
      let entries = 0;
      let merged = false;
      const childrenOf = id => this.transactions.filter(item => item.parentId === id);
      MONTH_NAMES.forEach((_, monthIndex) => {
        const lists = this.sections(year, monthIndex, currency);
        const ofType = lists.filter(section => section.type === target.type);
        // Resolve every entry against the month's lists as they are now, before any of them change.
        const matched = this.items(year, currency, monthIndex).filter(item => !item.parentId && item.type === target.type
          && nameKey(this.summarySection(item, lists).name) === target.section
          && (target.level === 'section' || nameKey(item.category) === target.sub));
        const before = changes.length;
        if (target.level === 'section') {
          // Sections already called the new name (other than this one) take this one's subsections.
          const named = ofType.filter(section => [oldKey, newKey].includes(nameKey(section.name)));
          if (named.some(section => nameKey(section.name) === oldKey) && named.length > 1) merged = true;
          if (named.some(section => nameKey(section.name) === oldKey) || matched.length) {
            changes.push(() => {
              const [keep, ...rest] = named;
              if (keep) {
                keep.name = name;
                rest.forEach(section => {
                  section.subsections.forEach(sub => { if (!keep.subsections.some(own => nameKey(own) === nameKey(sub))) keep.subsections.push(sub); });
                  lists.splice(lists.indexOf(section), 1);
                });
              }
              this.items(year, currency, monthIndex).filter(item => item.type === target.type && item.section && [oldKey, newKey].includes(nameKey(item.section)))
                .forEach(item => { item.section = name; });
            });
          }
        } else if (target.level === 'sub') {
          const home = ofType.filter(section => nameKey(section.name) === target.section);
          // Another section of the month already listing the new name holds the renamed entries from now on.
          const holder = ofType.find(section => nameKey(section.name) !== target.section && section.subsections.some(sub => nameKey(sub) === newKey));
          const listed = home.some(section => section.subsections.some(sub => nameKey(sub) === oldKey));
          if (holder && (listed || matched.length)) merged = true;
          if (listed || matched.length) {
            changes.push(() => {
              const finalName = holder ? holder.subsections.find(sub => nameKey(sub) === newKey) : name;
              // Merging drops the old name from this section's list; otherwise it is renamed in place, once.
              home.forEach(section => {
                section.subsections = holder
                  ? section.subsections.filter(sub => nameKey(sub) !== oldKey)
                  : section.subsections.map(sub => (nameKey(sub) === oldKey ? name : sub))
                    .filter((sub, index, all) => all.findIndex(other => nameKey(other) === nameKey(sub)) === index);
              });
              matched.forEach(entry => [entry, ...childrenOf(entry.id)].forEach(item => {
                item.category = finalName;
                if (holder) item.section = holder.name;
              }));
            });
          }
        } else {
          const parts = matched.flatMap(entry => {
            const notes = childrenOf(entry.id);
            return notes.length ? notes.filter(note => nameKey(note.description) === target.item) : nameKey(entry.description) === target.item ? [entry] : [];
          });
          if (parts.length) changes.push(() => parts.forEach(item => { item.description = name; }));
        }
        if (changes.length > before) {
          months.add(monthIndex);
          entries += matched.length;
        }
      });
      return { entries, months: months.size, merged, apply: () => changes.forEach(change => change()) };
    }

    // ---- entry queries (loaded months only) ----
    // A month's own entries; withEvents adds the entries of events shown in months.
    items(year, currency, monthIndex, { withEvents = false } = {}) {
      const prefix = dateKeyOf(year, monthIndex);
      return this.transactions.filter(item => item.property === currency && item.date.startsWith(prefix) && (!item.eventId || (withEvents && this.events[item.eventId]?.include)));
    }
    // A split entry's displayed amount is the sum of its sub-entries; an unsplit one shows its own.
    entryTotal(entryId) {
      const children = this.transactions.filter(t => t.parentId === entryId);
      if (children.length) return children.reduce((sum, t) => sum + Number(t.amount), 0);
      const entry = this.transactions.find(t => t.id === entryId);
      return entry ? Number(entry.amount) : 0;
    }

    // One currency's tree for an opened month: section → category → entry → sub-entries. Header totals are the stored metadata.
    country(year, monthIndex, currency) {
      const region = this.currencies[currency];
      const totals = this.monthTotals(year, monthIndex, currency);
      const sections = this.groupIntoSections(this.items(year, currency, monthIndex), this.sections(year, monthIndex, currency));
      // Events shown in months appear as their own ★ section, read-only here; they are edited in the event.
      const shown = this.items(year, currency, monthIndex, { withEvents: true }).filter(item => item.eventId);
      [...new Set(shown.map(item => item.eventId))].forEach(id => ['expense', 'income'].forEach(type => {
        const own = shown.filter(item => item.eventId === id && item.type === type);
        if (!own.length) return;
        const section = this.buildSection(`★ ${this.eventName(id)}`, type, [], own);
        section._meta.event = id;
        sections[`event:${id}:${type}`] = section;
      }));
      return {
        _meta: { id: currency, name: region.name, code: region.code, color: region.color, income: totals.income, expense: totals.expenses, closing: totals.closing, carried: totals.carried, carriedFrom: this.carriedFrom(year, monthIndex, currency) },
        sections
      };
    }
    // Files items under a section list: by their stored section, else by subsection name, else under "Other".
    groupIntoSections(items, list) {
      const sections = {};
      const claimed = new Set();
      [...list]
        .sort((a, b) => (a.type === 'income' ? 0 : 1) - (b.type === 'income' ? 0 : 1))
        .forEach(section => {
          const own = items.filter(item => item.type === section.type && !claimed.has(item) && (item.section === section.name || (!item.section && section.subsections.includes(item.category))));
          own.forEach(item => claimed.add(item));
          sections[section.name] = this.buildSection(section.name, section.type, section.subsections, own);
          // A section added beside Income and Expenses is drawn as its own block, under its own name.
          if (section.block || section.type === 'net') sections[section.name]._meta.block = true;
          if (section.type === 'net') {
            // What each subsection counts as and what the section adds to the month, by its rules (as stored totals count it).
            const built = sections[section.name];
            const amountsBySub = Object.fromEntries(Object.entries(built.categories).map(([name, category]) => [name, category.entries.map(entry => entry._meta.total)]));
            const summary = netSectionSummary(section, amountsBySub);
            built._meta.adds = summary.adds;
            built._meta.stats = summary.stats;
                      }
        });
      ['income', 'expense', 'net'].forEach(type => {
        const leftover = items.filter(item => item.type === type && !claimed.has(item));
        if (leftover.length) {
          const name = otherSectionName(type);
          sections[name] = this.buildSection(name, type, [], leftover);
          if (type === 'net') sections[name]._meta.block = true;
        }
      });
      return sections;
    }
    buildSection(name, type, subsections, items) {
      const parents = items.filter(item => !item.parentId);
      const categories = {};
      [...new Set([...subsections, ...parents.map(item => item.category)])].forEach(category => {
        const own = parents.filter(item => item.category === category);
        categories[category] = {
          _meta: { id: category, icon: iconFor(category, type), entries: own.length, total: own.reduce((sum, item) => sum + this.entryTotal(item.id), 0) },
          entries: own.map(item => this.buildEntry(item))
        };
      });
      return { _meta: { id: name, type, subsections: [...subsections] }, categories };
    }
    buildEntry(item) {
      const subEntries = this.transactions.filter(t => t.parentId === item.id);
      return {
        id: item.id, date: item.date, description: item.description, place: item.place || '', amount: Number(item.amount), formula: item.formula || null,
        section: item.section, category: item.category, type: item.type, property: item.property, eventId: item.eventId || null,
        _meta: { total: this.entryTotal(item.id), children: subEntries.length },
        subEntries: subEntries.map(sub => ({ id: sub.id, date: sub.date, description: sub.description, place: sub.place || '', amount: Number(sub.amount), formula: sub.formula || null }))
      };
    }
  }

  Object.assign(ExpenseStore, { sectionCalc, ensureCalc, runCalc, CALC_NAMES, netSectionSummary, MONTH_NAMES, monthIdOf, iconFor, flattenMonth, monthDoc, readAmount, nameKey });
  global.ExpenseStore = ExpenseStore;
})(typeof globalThis !== 'undefined' ? globalThis : window);
