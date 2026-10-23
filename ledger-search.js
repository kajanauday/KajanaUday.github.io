// LedgerSearch: finding entries by word, in Telugu or English script.
//
// A query becomes up to three terms:
//   typed    the word as entered (gold, బంగారం)
//   script   the same word in the other script (గోల్డ్ for gold; bangaram for బంగారం)
//   meaning  its translation (బంగారం for gold; gold for బంగారం)
// Romanising Telugu is done here. English to Telugu script asks Google Input Tools and falls back to the simple rules
// below; meanings come from Google Translate, then MyMemory. Only the search word is sent, never ledger data, and
// answers are cached for the session.
// Matching is case-insensitive on description, comment and note text, plus a loose comparison of both sides spelled
// in Latin letters, so "gold" also finds గోల్డ్ when no service can be reached.
// The app gathers the rows (with their year, month, section and amounts) and draws what results() returns with
// resultsHtml(); this file never touches the store or the page.
(function (global) {
  const TELUGU = /[ఀ-౿]/;
  const isTelugu = text => TELUGU.test(text);
  const clean = text => String(text ?? '').normalize('NFC').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
  const lower = text => clean(text).toLocaleLowerCase();

  // ---- Telugu → Latin (romanised the way names are usually written: బంగారం → bangaram) ----
  const VOWELS = { 'అ': 'a', 'ఆ': 'a', 'ఇ': 'i', 'ఈ': 'ee', 'ఉ': 'u', 'ఊ': 'oo', 'ఋ': 'ru', 'ఎ': 'e', 'ఏ': 'e', 'ఐ': 'ai', 'ఒ': 'o', 'ఓ': 'o', 'ఔ': 'au' };
  const SIGNS = { 'ా': 'a', 'ి': 'i', 'ీ': 'ee', 'ు': 'u', 'ూ': 'oo', 'ృ': 'ru', 'ె': 'e', 'ే': 'e', 'ై': 'ai', 'ొ': 'o', 'ో': 'o', 'ౌ': 'au' };
  const CONSONANTS = { 'క': 'k', 'ఖ': 'kh', 'గ': 'g', 'ఘ': 'gh', 'ఙ': 'n', 'చ': 'ch', 'ఛ': 'chh', 'జ': 'j', 'ఝ': 'jh', 'ఞ': 'n', 'ట': 't', 'ఠ': 'th', 'డ': 'd', 'ఢ': 'dh', 'ణ': 'n', 'త': 't', 'థ': 'th', 'ద': 'd', 'ధ': 'dh', 'న': 'n', 'ప': 'p', 'ఫ': 'ph', 'బ': 'b', 'భ': 'bh', 'మ': 'm', 'య': 'y', 'ర': 'r', 'ఱ': 'r', 'ల': 'l', 'ళ': 'l', 'వ': 'v', 'శ': 'sh', 'ష': 'sh', 'స': 's', 'హ': 'h' };
  function romanize(text) {
    const chars = [...clean(text)];
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      const next = chars[i + 1];
      if (CONSONANTS[char]) {
        out += CONSONANTS[char];
        if (next === '్') i++;
        else if (SIGNS[next]) { out += SIGNS[next]; i++; } else out += 'a';
      } else if (VOWELS[char]) out += VOWELS[char];
      else if (char === 'ం') out += /[పఫబభమ]/.test(next || '') ? 'm' : CONSONANTS[next] ? 'n' : 'm';
      else if (char === 'ః') out += 'h';
      else if (!SIGNS[char] && char !== '్') out += char;
    }
    return out;
  }

  // ---- English → Telugu script, simple rules (used only when Google Input Tools cannot be reached) ----
  const DIGRAPHS = [['chh', 'ఛ'], ['sh', 'శ'], ['ch', 'చ'], ['th', 'త'], ['ph', 'ఫ'], ['kh', 'ఖ'], ['gh', 'ఘ'], ['bh', 'భ'], ['dh', 'ధ'], ['ck', 'క'], ['qu', 'క్వ'], ['x', 'క్స']];
  const SINGLE = { k: 'క', g: 'గ', c: 'క', j: 'జ', t: 'ట', d: 'డ', n: 'న', p: 'ప', b: 'బ', m: 'మ', y: 'య', r: 'ర', l: 'ల', v: 'వ', w: 'వ', s: 'స', h: 'హ', f: 'ఫ', z: 'జ', q: 'క' };
  const VOWEL_RULES = [['aa', 'ా', 'ఆ'], ['ee', 'ీ', 'ఈ'], ['ii', 'ీ', 'ఈ'], ['oo', 'ూ', 'ఊ'], ['uu', 'ూ', 'ఊ'], ['ai', 'ై', 'ఐ'], ['ay', 'ే', 'ఏ'], ['au', 'ౌ', 'ఔ'], ['ou', 'ౌ', 'ఔ'], ['a', '', 'అ'], ['e', 'ె', 'ఎ'], ['i', 'ి', 'ఇ'], ['o', 'ో', 'ఒ'], ['u', 'ు', 'ఉ']];
  function toTeluguScript(text) {
    return clean(text).toLowerCase().split(/(\s+)/).map(word => {
      if (!/^[a-z]+$/.test(word)) return word;
      // A few English spelling habits first: -tion, igh, double l, final -ie, and the silent e that lengthens the vowel
      // before it (rice → rais, tube → tyoob, cake → kayk); then the silent e itself goes (phone → phon).
      let w = word.replace(/tion/g, 'shan').replace(/igh/g, 'ai').replace(/ll/g, 'l').replace(/ie$/, 'ee').replace(/ce$/, 'se');
      if (w.length > 3) w = w.replace(/([aeiou])([^aeiou])e$/, (all, vowel, consonant) => `${{ a: 'ay', e: 'ee', i: 'ai', o: 'o', u: 'yoo' }[vowel]}${consonant}`).replace(/([^aeiou])e$/, '$1');
      let out = '';
      let pending = ''; // a consonant waiting for its vowel
      for (let i = 0; i < w.length;) {
        const vowel = VOWEL_RULES.find(([latin]) => w.startsWith(latin, i));
        if (vowel) {
          out += pending ? pending + vowel[1] : vowel[2];
          pending = '';
          i += vowel[0].length;
          continue;
        }
        const pair = DIGRAPHS.find(([latin]) => w.startsWith(latin, i));
        const letter = pair ? pair[1] : SINGLE[w[i]] || '';
        if (pending) out += `${pending}్`;
        pending = letter;
        i += pair ? pair[0].length : 1;
      }
      return out + (pending ? `${pending}్` : '');
    }).join('');
  }

  // ---- loose comparison: both sides in Latin letters, with the differences spelling does not decide flattened ----
  function looseKey(text) {
    let s = ` ${romanize(lower(text)).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    s = s.replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u').replace(/aa/g, 'a');
    s = s.replace(/([a-z]{3,})e /g, '$1 ');               // silent final e
    s = s.replace(/x/g, 'ks').replace(/ch/g, '\u0001').replace(/ck/g, 'k').replace(/c/g, 'k').replace(/\u0001/g, 'c');
    s = s.replace(/([bdgjkpt])h/g, '$1').replace(/sh/g, 's').replace(/ph|f/g, 'p').replace(/w/g, 'v').replace(/z/g, 'j');
    s = s.replace(/ee|ii|y(?=[^aeiou]|$)/g, 'i').replace(/oo|uu/g, 'u').replace(/aa/g, 'a');
    s = s.replace(/([a-z])\1+/g, '$1');
    return s.replace(/\s+/g, ' ').trim();
  }

  // ---- the three terms ----
  const cache = new Map();
  const remember = (key, work) => {
    if (!cache.has(key)) cache.set(key, work().catch(error => { cache.delete(key); throw error; }));
    return cache.get(key);
  };
  async function getJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  function otherScript(word) {
    if (isTelugu(word)) return Promise.resolve(romanize(word));
    return remember(`script:${word}`, async () => {
      const data = await getJson(`https://inputtools.google.com/request?text=${encodeURIComponent(word)}&itc=te-t-i0-und&num=1&ie=utf-8&oe=utf-8`);
      const words = data?.[0] === 'SUCCESS' ? data[1].map(([, choices]) => choices?.[0]).filter(Boolean) : [];
      if (!words.length) throw new Error('no transliteration');
      return words.join(' ');
    }).catch(() => toTeluguScript(word));
  }
  function meaning(word) {
    const [from, to] = isTelugu(word) ? ['te', 'en'] : ['en', 'te'];
    return remember(`meaning:${from}:${word}`, async () => {
      try {
        const data = await getJson(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(word)}`);
        const text = clean((data?.[0] || []).map(part => part?.[0] || '').join(''));
        if (text) return text;
      } catch (error) { /* try the next service */ }
      const data = await getJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=${from}|${to}`);
      const text = clean(data?.responseData?.translatedText);
      if (!text || /MYMEMORY|QUERY LENGTH/i.test(text)) throw new Error('no translation');
      return text;
    });
  }
  // The terms for a query: what can be worked out here at once, then the rest as it arrives. onUpdate(terms) is
  // called each time; every term is { kind: 'typed' | 'script' | 'meaning', text, pending?, failed? }.
  function expand(query, onUpdate) {
    const typed = clean(query);
    const terms = [{ kind: 'typed', text: typed }, { kind: 'script', text: isTelugu(typed) ? romanize(typed) : toTeluguScript(typed), pending: !isTelugu(typed) }, { kind: 'meaning', text: '', pending: true }];
    const publish = () => onUpdate(terms.map(term => ({ ...term })));
    publish();
    otherScript(typed).then(text => { Object.assign(terms[1], { text, pending: false }); publish(); });
    meaning(typed).then(text => {
      const same = lower(text) === lower(typed) || lower(text) === lower(terms[1].text);
      Object.assign(terms[2], { text: same ? '' : (isTelugu(text) ? text : text.toLowerCase()), pending: false, failed: same });
      publish();
    }, () => { Object.assign(terms[2], { pending: false, failed: true }); publish(); });
  }

  // ---- matching ----
  // matcher(terms) → (text) → { hit, terms: Set of matched kinds } ; exact matches can also be highlighted.
  function matcher(terms) {
    const usable = terms.filter(term => term.text && !term.pending).map(term => ({ ...term, key: lower(term.text), loose: looseKey(term.text) }));
    return text => {
      const value = lower(text);
      if (!value) return null;
      let loose = null;
      const kinds = new Set();
      usable.forEach(term => {
        if (value.includes(term.key)) kinds.add(term.kind);
        else if (term.loose.length >= 4) {
          loose ??= looseKey(text);
          if (loose.includes(term.loose)) kinds.add(term.kind);
        }
      });
      return kinds.size ? kinds : null;
    };
  }
  function highlight(text, terms, esc) {
    const value = String(text ?? '');
    const low = value.toLocaleLowerCase();
    const marks = [];
    terms.filter(term => term.text && !term.pending).forEach(term => {
      const key = lower(term.text);
      for (let at = low.indexOf(key); key && at >= 0; at = low.indexOf(key, at + key.length)) marks.push([at, at + key.length]);
    });
    marks.sort((a, b) => a[0] - b[0]);
    let out = '';
    let at = 0;
    marks.forEach(([from, to]) => {
      if (from < at) return;
      out += esc(value.slice(at, from)) + `<mark>${esc(value.slice(from, to))}</mark>`;
      at = to;
    });
    return out + esc(value.slice(at));
  }

  // rows: [{ id, year, date, kind: 'entry' | 'note', description, comment, parent?, type, amount, property, where, crumbs,
  //          category, section, jump }]
  // Returns { entries: matched rows newest first, subsections: [{ year, name, type, property, count, total, jump }],
  // counts: { typed, script, meaning } }.
  function results(rows, terms) {
    const test = matcher(terms);
    const counts = { typed: 0, script: 0, meaning: 0 };
    const entries = [];
    const subsections = new Map();
    rows.forEach(row => {
      const kinds = test(`${row.description} \u0001 ${row.comment || ''}`);
      if (kinds) {
        entries.push(row);
        kinds.forEach(kind => { counts[kind] += 1; });
      }
      if (row.kind !== 'entry') return;
      const named = test(row.category) || test(row.section);
      if (!named) return;
      const key = `${row.year}|${row.type}|${row.property}|${lower(row.category)}|${row.eventName || ''}`;
      const group = subsections.get(key) || { year: row.year, name: row.category, section: row.section, type: row.type, property: row.property, eventName: row.eventName, count: 0, total: 0, months: new Set(), jump: row.jump, latest: '' };
      group.count += 1;
      group.total += row.amount;
      group.months.add(row.where);
      if (row.date > group.latest) { group.latest = row.date; group.jump = { ...row.jump, entryId: null, noteId: null, category: row.category }; }
      subsections.set(key, group);
    });
    entries.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    const subs = [...subsections.values()].sort((a, b) => b.year - a.year || b.total - a.total);
    return { entries, subsections: subs, counts };
  }

  // ---- drawing ----
  const LABELS = { typed: 'Typed', script: 'Other script', meaning: 'Meaning' };
  function termsHtml(terms, counts, esc) {
    return terms.map(term => {
      if (term.kind === 'meaning' && !term.text && !term.pending) return `<span class="search-term is-off" title="No meaning found">${LABELS.meaning} · —</span>`;
      if (!term.text && !term.pending) return '';
      const count = term.pending ? '<i class="ti ti-loader-2 search-spin" aria-hidden="true"></i>' : `<b>${counts?.[term.kind] ?? 0}</b>`;
      return `<span class="search-term is-${term.kind}" title="${LABELS[term.kind]}"><small>${LABELS[term.kind]}</small>${term.text ? esc(term.text) : '…'}${count}</span>`;
    }).join('');
  }
  // Totals per currency and direction, for a summary line.
  function totals(rows, ctx) {
    const byKey = new Map();
    rows.forEach(row => {
      // A matched note inside a matched entry is already in the entry's total.
      if (row.kind === 'note' && rows.some(other => other.id === row.parentId)) return;
      const key = `${row.property}|${row.type}`;
      byKey.set(key, (byKey.get(key) || 0) + row.amount);
    });
    return [...byKey].map(([key, minor]) => {
      const [property, type] = key.split('|');
      return `<span class="search-sum ${type}">${type === 'income' ? 'In' : 'Out'} ${ctx.fmt(minor, property)}<small>${ctx.regions[property]?.code || ''}</small></span>`;
    }).join('');
  }
  function resultsHtml({ entries, subsections }, terms, ctx, { limit = 400 } = {}) {
    if (!entries.length && !subsections.length) return '<p class="search-empty">Nothing found. Try fewer letters, or switch to All years.</p>';
    const esc = ctx.esc;
    let index = 0;
    const jumpAttr = jump => `data-search-jump='${esc(JSON.stringify(jump))}'`;
    const subsHtml = subsections.length ? `<section class="search-group"><h3 class="search-group-head"><span>Subsections</span><small>${subsections.length}</small></h3>${subsections.map(group =>
      `<button type="button" class="search-row is-sub" ${jumpAttr(group.jump)} data-search-index="${index++}"><span class="search-when">${group.year}</span><span class="search-main"><span class="search-desc">${highlight(group.name, terms, esc)}</span><span class="search-crumbs">${group.eventName ? `★ ${esc(group.eventName)} · ` : ''}${highlight(group.section, terms, esc)} · ${group.count} ${group.count === 1 ? 'entry' : 'entries'} in ${group.months.size} ${group.months.size === 1 ? 'place' : 'places'}</span></span><strong class="search-amount ${group.type}">${ctx.fmt(group.total, group.property)}</strong></button>`).join('')}</section>` : '';
    const shown = entries.slice(0, limit);
    const years = [...new Set(shown.map(row => row.year))];
    const entriesHtml = years.map(year => {
      const rows = shown.filter(row => row.year === year);
      return `<section class="search-group"><h3 class="search-group-head"><span>${year}</span><small>${rows.length} ${rows.length === 1 ? 'result' : 'results'}</small><span class="search-sums">${totals(rows, ctx)}</span></h3>${rows.map(row =>
        `<button type="button" class="search-row${row.kind === 'note' ? ' is-note' : ''}" ${jumpAttr(row.jump)} data-search-index="${index++}"><span class="search-when">${esc(ctx.dayLabel(row.date))}</span><span class="search-main"><span class="search-desc">${row.kind === 'note' ? '<i class="ti ti-corner-down-right" aria-hidden="true"></i>' : ''}${highlight(row.description, terms, esc)}${row.comment ? `<span class="search-comment">${highlight(row.comment, terms, esc)}</span>` : ''}</span><span class="search-crumbs">${esc(row.where)} · ${esc(row.crumbs)}${row.kind === 'note' && row.parent ? ` · in ${esc(row.parent)}` : ''}</span></span><strong class="search-amount ${row.type}">${ctx.fmt(row.amount, row.property)}<small>${ctx.regions[row.property]?.code || ''}</small></strong></button>`).join('')}</section>`;
    }).join('');
    const more = entries.length > limit ? `<p class="search-empty">Showing the newest ${limit} of ${entries.length}. Add a word to narrow it down.</p>` : '';
    return subsHtml + entriesHtml + more;
  }

  global.LedgerSearch = { isTelugu, romanize, toTeluguScript, looseKey, expand, matcher, results, termsHtml, resultsHtml, totals };
})(typeof globalThis !== 'undefined' ? globalThis : window);
