// Here and there: an expense added in one month but for another. The real entry stays in the month it was added in, with
// its amount. The month it is for gets a marker: the same description, the amount in its note, no amount of its own,
// in a "Here and there" section of the same type, under a subsection that names the month it came from.
//
// The markers are a function of the real entries, worked out from scratch: the same real entries always give the same
// markers. Saving runs this, so every add, edit, move, copy and delete ends with the markers in step, whichever path made
// the change. A marker that no longer matches is replaced; a marker whose entry is gone is removed.
//
// Everything here is plain data: nothing is read from or written to the database, which is left to the caller.
(function (global) {
  const SECTION = 'Here and there';
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  const isReal = row => !row.parentId && !row.eventId && !row.markerOf && DATE.test(String(row.refDate || ''));
  const kindOf = type => (type === 'income' ? 'income' : 'expense');

  // The marker a real entry needs in its reference month, or null when it needs none (no reference, or the same month).
  function markerFor(row, key, { labelFor, amountText }) {
    const from = String(row.date).slice(0, 7);
    if (String(row.refDate).slice(0, 7) === from || row.type === 'net') return null;
    const minor = Math.abs(Math.round(Number(row.amount) || 0));
    return {
      key, date: row.refDate, property: row.property, type: kindOf(row.type), description: row.description,
      place: amountText(minor, row.property), category: labelFor(row.date), section: SECTION, amount: 0, markerOf: { key, amount: minor, from: row.date }
    };
  }
  // Whether an existing marker says what the desired one says.
  const same = (have, want) => ['date', 'property', 'type', 'description', 'place', 'category', 'section'].every(field => have[field] === want[field])
    && Number(have.amount) === 0 && have.markerOf?.key === want.markerOf.key && have.markerOf?.amount === want.markerOf.amount
    && have.markerOf?.from === want.markerOf.from;

  // Returns what to change, and never changes the rows it is given:
  //   rekey:  real entries whose key is missing or already used by another real entry get a new one (a copy takes its own).
  //   remove: ids of markers to delete.
  //   add:    marker rows to insert (without an id).
  //   months: 'YYYY-MM' months a marker was added to or removed from, so their section lists can be tidied.
  // A marker whose entry is in a month that is not loaded cannot be judged, so it is left as it is: nothing is removed
  // or added for it. `isLoaded('YYYY-MM')` says whether a month is loaded.
  function reconcileReferences(rows, { labelFor, amountText, newKey, isLoaded = () => true }) {
    const real = rows.filter(isReal);
    const rekey = [];
    const taken = new Set();
    const keyOf = new Map();
    real.forEach(row => {
      let key = row.refKey;
      if (!key || taken.has(key)) {
        key = newKey();
        rekey.push({ item: row, refKey: key });
      }
      taken.add(key);
      keyOf.set(row, key);
    });

    const want = new Map();
    real.forEach(row => {
      const marker = markerFor(row, keyOf.get(row), { labelFor, amountText });
      if (marker) want.set(marker.key, marker);
    });
    const have = new Map();
    rows.filter(row => row.markerOf?.key).forEach(row => {
      if (!have.has(row.markerOf.key)) have.set(row.markerOf.key, []);
      have.get(row.markerOf.key).push(row);
    });

    const remove = [];
    const add = [];
    const months = new Set();
    new Set([...want.keys(), ...have.keys()]).forEach(key => {
      const current = have.get(key) || [];
      const wanted = want.get(key) || null;
      if (!wanted && current.some(row => !isLoaded(String(row.markerOf.from || '').slice(0, 7)))) return;
      if (wanted && current.length === 1 && same(current[0], wanted)) return;
      if (!wanted && !current.length) return;
      current.forEach(row => { remove.push(row.id); months.add(String(row.date).slice(0, 7)); });
      if (wanted) { add.push(wanted); months.add(String(wanted.date).slice(0, 7)); }
    });
    return { rekey, remove, add, months: [...months].sort() };
  }

  const api = { SECTION, reconcileReferences, markerFor, isReal };
  if (typeof module === 'object' && module.exports) module.exports = api;
  global.HereAndThere = api;
})(typeof window !== 'undefined' ? window : globalThis);
