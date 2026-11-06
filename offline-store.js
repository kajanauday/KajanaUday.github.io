// OfflineVault and OfflineSync: the ledger on this device, so it opens and takes new entries with no connection.
//
// What is read from Firebase is kept in IndexedDB as it arrives — the currencies, the year shell, the events and each
// month's entries — up to a budget (200 MB). Past the budget the least recently used month documents go first; the shell
// is never dropped. With no connection those copies answer the reads, so the app opens and reads as usual.
//
// Writes never go straight out. Each multi-path update is applied to the copy on this device and added to an outbox, so a
// change made offline survives a reload and is sent, in order, as soon as there is a connection again.
//
// Two devices, one ledger: every update also stamps `meta/nodes/<path>` with the server's clock and this device's id, and
// the stamp a path carried when it was read is kept beside its data. Before anything is sent those stamps are read back;
// a path another device has written since is a clash, and `onConflict` decides whether this device's change goes out or
// gives way to the newer one.
//
// Freshness: each node kept here remembers the newest Firebase write it includes (its watermark, from those stamps). A
// stamp written by another device after that is a part that is newer in Firebase; compare() lists those beside the
// changes still waiting here, and pull() fetches such parts again. The app uses these to keep a full copy (an admin
// downloads every month) and to mark what is out of date on either side.
(function (global) {
  const DB_NAME = 'kajanauday-offline';
  // The copy as kept under the app's former name (written in two halves so the old name is nowhere a word): moved over
  // once, the first time the new one is made, so neither the copy nor changes still waiting to be sent are lost.
  const FORMER_DB_NAME = `${['family', 'budget'].join('-')}-offline`;
  const VERSION = 1;
  const NODES = 'nodes';
  const OUTBOX = 'outbox';
  // Firebase refuses these in a key, and refuses the whole update with them anywhere in it — so one bad name stops
  // every later save too, for good, and the only sign of it is a request that keeps failing. Names typed by hand reach
  // keys in a few places (a section's roles and its subsection descriptions are kept per subsection name), so an
  // update is looked over before it is sent and the offending name is named.
  const BAD_KEY = /[.$#[\]/\u0000-\u001f\u007f]/;
  // The same swap data-layer.js makes when it loads and when it renames (see safeKey there), repeated here for what is
  // already waiting in the outbox: an update queued before names were made safe still carries the old spelling and
  // would be refused for ever, taking every save behind it down with it. Swapped on the way out, it can leave, and it
  // lands spelled the way everything loaded since already agrees on. The keys of the update itself are paths, so they
  // are left alone; everything below them is data.
  const KEY_SWAPS = { '.': '․', $: '＄', '#': '＃', '[': '［', ']': '］', '/': '／' };
  const safeKey = name => String(name).replace(/[.$#[\]/]/g, character => KEY_SWAPS[character]);
  const safeKeysDeep = (value, top = false) => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => safeKeysDeep(item));
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [top ? key : safeKey(key), safeKeysDeep(inner)]));
  };
  const badKeyIn = (value, top = false, trail = []) => {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (let at = 0; at < value.length; at += 1) {
        const found = badKeyIn(value[at], false, [...trail, at]);
        if (found) return found;
      }
      return null;
    }
    for (const [key, inner] of Object.entries(value)) {
      // The keys of the update itself are paths, so a slash belongs there; everything below is data.
      if (!top && BAD_KEY.test(key)) return { key, at: [...trail, key].join(' → ') };
      const found = badKeyIn(inner, false, [...trail, key]);
      if (found) return found;
    }
    return null;
  };
  const NOTES = 'notes';
  const DEFAULT_BUDGET = 200 * 1024 * 1024;
  // How many times one flush may go back for whatever was saved while it was running, so a save that keeps on
  // failing to leave the outbox cannot spin here for ever.
  const MAX_ROUNDS = 20;
  // The shell is what the app needs to open at all, so it is never evicted; only month documents are.
  const evictable = path => path.startsWith('months/');
  // Firebase keys cannot hold "/", so a path becomes one key under meta/nodes.
  const stampKey = path => String(path).replace(/\//g, '~') || 'root';
  const sizeOf = data => (data === null || data === undefined ? 0 : JSON.stringify(data).length);
  // A failed request is a lost connection; anything with a status came back from Firebase and is a real error.
  const isOffline = error => !/HTTP \d/.test(String(error?.message || ''));

  const ask = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  // Sets or deletes a value deep inside a plain object, creating the objects on the way.
  function setIn(root, parts, value) {
    let node = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const part = parts[index];
      if (!node[part] || typeof node[part] !== 'object') node[part] = {};
      node = node[part];
    }
    const last = parts[parts.length - 1];
    if (value === null || value === undefined) delete node[last];
    else node[last] = value;
  }

  // Copies every record of the former database (if there is one) into the new one, keys as they were, then deletes it.
  async function moveFormerCopy(db) {
    try {
      const former = await new Promise(resolve => {
        const request = indexedDB.open(FORMER_DB_NAME);
        // No former database: opening would make an empty one, so that is called off.
        request.onupgradeneeded = () => request.transaction.abort();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
      if (!former) return;
      const stores = [NODES, OUTBOX, NOTES].filter(name => former.objectStoreNames.contains(name));
      for (const name of stores) {
        const from = former.transaction(name, 'readonly').objectStore(name);
        const [values, keys] = await Promise.all([ask(from.getAll()), ask(from.getAllKeys())]);
        const to = db.transaction(name, 'readwrite').objectStore(name);
        values.forEach((value, i) => (to.keyPath ? to.put(value) : to.put(value, keys[i])));
        await new Promise((resolve, reject) => { to.transaction.oncomplete = resolve; to.transaction.onerror = () => reject(to.transaction.error); });
      }
      former.close();
      indexedDB.deleteDatabase(FORMER_DB_NAME);
    } catch (error) {
      console.warn('The offline copy kept under the former name could not be moved.', error);
    }
  }

  class OfflineVault {
    // Resolves to null where IndexedDB cannot be used (some private windows); the app then runs online-only, as before.
    static async open({ budget = DEFAULT_BUDGET } = {}) {
      try {
        let created = false;
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(DB_NAME, VERSION);
          request.onupgradeneeded = event => {
            created = event.oldVersion === 0;
            const open = request.result;
            if (!open.objectStoreNames.contains(NODES)) open.createObjectStore(NODES, { keyPath: 'path' });
            if (!open.objectStoreNames.contains(OUTBOX)) open.createObjectStore(OUTBOX, { keyPath: 'id', autoIncrement: true });
            if (!open.objectStoreNames.contains(NOTES)) open.createObjectStore(NOTES);
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('blocked'));
        });
        if (created) await moveFormerCopy(db);
        const vault = new OfflineVault(db, budget);
        // Asking to persist keeps the browser from clearing the copy when the device runs low on space.
        navigator.storage?.persist?.().catch(() => {});
        return vault;
      } catch (error) {
        console.warn('This device cannot keep an offline copy.', error);
        return null;
      }
    }
    constructor(db, budget) {
      this.db = db;
      this.budget = budget;
    }
    store(name, mode) { return this.db.transaction(name, mode).objectStore(name); }

    // ---- the copy of Firebase's nodes ----
    node(path) { return ask(this.store(NODES, 'readonly').get(path)).catch(() => null); }
    paths() { return ask(this.store(NODES, 'readonly').getAllKeys()).catch(() => []); }
    async keep(path, data, at = 0) {
      await ask(this.store(NODES, 'readwrite').put({ path, data, at, bytes: sizeOf(data), touched: Date.now() })).catch(() => {});
      return this.trim();
    }
    forget(path) { return ask(this.store(NODES, 'readwrite').delete(path)).catch(() => {}); }
    rows() { return ask(this.store(NODES, 'readonly').getAll()).catch(() => []); }
    async usage() {
      const rows = await ask(this.store(NODES, 'readonly').getAll()).catch(() => []);
      return { bytes: rows.reduce((sum, row) => sum + (row.bytes || 0), 0), nodes: rows.length, budget: this.budget };
    }
    // Keeps the copy inside its budget: the month documents untouched for longest go first.
    async trim() {
      const rows = await ask(this.store(NODES, 'readonly').getAll()).catch(() => []);
      let bytes = rows.reduce((sum, row) => sum + (row.bytes || 0), 0);
      if (bytes <= this.budget) return { bytes, dropped: 0 };
      let dropped = 0;
      for (const row of rows.filter(item => evictable(item.path)).sort((a, b) => (a.touched || 0) - (b.touched || 0))) {
        if (bytes <= this.budget) break;
        await this.forget(row.path);
        bytes -= row.bytes || 0;
        dropped += 1;
      }
      return { bytes, dropped };
    }

    // ---- the outbox: updates made here that Firebase has not taken yet ----
    queue(update, seen) { return ask(this.store(OUTBOX, 'readwrite').add({ update, seen, at: Date.now() })); }
    pending() { return ask(this.store(OUTBOX, 'readonly').getAll()).catch(() => []); }
    release(id) { return ask(this.store(OUTBOX, 'readwrite').delete(id)).catch(() => {}); }

    read(key) { return ask(this.store(NOTES, 'readonly').get(key)).catch(() => undefined); }
    write(key, value) { return ask(this.store(NOTES, 'readwrite').put(value, key)).catch(() => {}); }

    // Applies an update to the copy on this device, so a reload with no connection shows what was just changed. Paths are
    // written to the node they belong to: a whole node when one is cached at that path, else deep inside its nearest
    // cached parent (years/2026 inside `years`, events/<id>/entries inside `events`).
    async apply(update) {
      const cached = await this.paths();
      const targets = new Map();
      for (const [path, value] of Object.entries(update)) {
        if (path.startsWith('meta/')) continue;
        const parent = cached.includes(path) ? path : cached.filter(key => path.startsWith(`${key}/`)).sort((a, b) => b.length - a.length)[0];
        const key = parent || (path.startsWith('months/') ? path : null);
        if (!key) continue;
        if (!targets.has(key)) targets.set(key, { row: await this.node(key), writes: [] });
        targets.get(key).writes.push([path, value]);
      }
      for (const [key, { row, writes }] of targets) {
        let data = row ? row.data : null;
        for (const [path, value] of writes) {
          if (path === key) data = value;
          else {
            if (!data || typeof data !== 'object') data = {};
            setIn(data, path.slice(key.length + 1).split('/'), value);
          }
        }
        await this.keep(key, data, row?.at || 0);
      }
    }
  }

  // The database the store talks to when this device keeps a copy: the same get/patch, with the copy and the outbox behind
  // them. `onState` reports 'synced' | 'pending' | 'offline' | 'error' for the save dot; `onConflict` is asked to choose
  // when another device has written a path this one is about to overwrite.
  class OfflineSync {
    constructor(vault, raw, { deviceId, onState = () => {}, onConflict = null, readOnly = false } = {}) {
      this.vault = vault;
      this.raw = raw;
      this.deviceId = deviceId;
      this.onState = onState;
      this.onConflict = onConflict;
      this.readOnly = readOnly;
      this.stamps = {};
      this.offline = false;
      this.flushing = null;
      this.stale = false; // a clash was settled in the other device's favour; the page has to be read again
      this.lastError = null; // why the last send failed, kept so the Sync panel can say it rather than only the console
    }
    // The stamps every path carried when last read, so a clash can be told from this device's own earlier write.
    async stampsNow() {
      const stamps = await this.raw.get('meta/nodes');
      this.stamps = stamps || {};
      return this.stamps;
    }
    report(state) {
      if (state) return this.onState(state);
      this.vault.pending().then(queue => this.onState(queue.length ? (this.offline ? 'offline' : 'pending') : (this.offline ? 'offline' : 'synced')));
    }
    async get(path) {
      if (navigator.onLine !== false) {
        try {
          if (!this.loadedStamps) this.loadedStamps = this.stampsNow().catch(() => ({}));
          const [data] = await Promise.all([this.raw.get(path), this.loadedStamps]);
          if (this.offline) { this.offline = false; this.report(); }
          await this.vault.keep(path, data, this.watermark(path));
          return data;
        } catch (error) {
          if (!isOffline(error)) throw error;
        }
      }
      const row = await this.vault.node(path);
      if (!row) throw new Error(`No connection, and ${path || 'the ledger'} is not on this device yet.`);
      this.offline = true;
      this.report();
      return row.data;
    }
    // The newest write Firebase has recorded for a path: at it, under it, or above it (a write above replaces it whole).
    watermark(path, stamps = this.stamps) {
      let at = 0;
      Object.entries(stamps || {}).forEach(([key, stamp]) => {
        const written = key === 'root' ? '' : key.replace(/~/g, '/');
        if (written === path || written.startsWith(`${path}/`) || path.startsWith(`${written}/`)) at = Math.max(at, Number(stamp?.at) || 0);
      });
      return at;
    }
    // What differs between this device and Firebase. `pending`: paths changed here and still waiting to go out.
    // `outdated`: nodes kept here that another device has written since (the node paths to fetch again), with `newer`, the
    // written paths themselves. `kept`: every node on this device. With no connection only `pending` can be known.
    async compare() {
      const [queue, rows] = await Promise.all([this.vault.pending(), this.vault.rows()]);
      const pending = [...new Set(queue.flatMap(item => Object.keys(item.update).filter(path => !path.startsWith('meta/'))))];
      let remote = null;
      if (navigator.onLine !== false) {
        try {
          remote = await this.stampsNow();
          this.offline = false;
        } catch (error) {
          if (!isOffline(error)) throw error;
        }
      }
      if (!remote) this.offline = true;
      const kept = new Map(rows.map(row => [row.path, row]));
      const outdated = new Set();
      const newer = [];
      Object.entries(remote || {}).forEach(([key, stamp]) => {
        if (!stamp || stamp.by === this.deviceId) return;
        const path = key === 'root' ? '' : key.replace(/~/g, '/');
        const holder = kept.has(path) ? path : [...kept.keys()].filter(other => path.startsWith(`${other}/`)).sort((a, b) => b.length - a.length)[0];
        if (holder !== undefined && Number(stamp.at) > Number(kept.get(holder).at || 0)) {
          outdated.add(holder);
          newer.push(path);
        }
      });
      return { pending, queued: queue.length, outdated: [...outdated], newer, kept: [...kept.keys()], bytes: rows.reduce((sum, row) => sum + (row.bytes || 0), 0), offline: this.offline, error: this.lastError || null };
    }
    // Fetches paths again, one at a time, so this device holds what Firebase holds now. Stops at a lost connection.
    async pull(paths, onProgress = () => {}) {
      await this.stampsNow();
      let done = 0;
      for (const path of paths) {
        if (navigator.onLine === false) break;
        await this.get(path);
        if (this.offline) break;
        done += 1;
        onProgress(done, paths.length);
      }
      return done;
    }
    // Written to this device and queued; sending is tried at once and again whenever the connection returns.
    async patch(update) {
      if (this.readOnly) return null;
      const seen = Object.fromEntries(Object.keys(update).map(path => [stampKey(path), this.stamps[stampKey(path)]?.at || 0]));
      await this.vault.apply(update);
      const id = await this.vault.queue(update, seen);
      this.report();
      await this.flush();
      // A flush already under way may have read the outbox a moment before this went into it. If this very change is
      // still waiting afterwards, and there is a connection to try, send it now rather than leave it for the next sync.
      if (!this.offline && (await this.vault.pending()).some(item => item.id === id)) await this.flush();
      return null;
    }
    // Each update also records, for every path it touches, when it was written and by which device.
    stamped(update) {
      const stamps = {};
      Object.keys(update).filter(path => !path.startsWith('meta/')).forEach(path => {
        stamps[`meta/nodes/${stampKey(path)}`] = { at: { '.sv': 'timestamp' }, by: this.deviceId };
      });
      return { ...update, ...stamps, 'meta/updatedAt': { '.sv': 'timestamp' }, 'meta/updatedBy': this.deviceId };
    }
    // The paths in a queued update that another device has written since this one last read them.
    clashes(item, remote) {
      return Object.keys(item.update).filter(path => {
        if (path.startsWith('meta/')) return false;
        const stamp = remote?.[stampKey(path)];
        return stamp && stamp.by !== this.deviceId && Number(stamp.at) > Number(item.seen?.[stampKey(path)] || 0);
      });
    }
    // Which version stays, when another device wrote the same path. Asking must always come back with an answer, and
    // never with a rejection: a flush left waiting on it would hold `flushing` for good, and every later save and sync
    // queues behind that. Anything but a plain "theirs" keeps this device's change, which loses nothing.
    async whichStays(clash) {
      try {
        return (await this.onConflict(clash)) === 'theirs' ? 'theirs' : 'mine';
      } catch (error) {
        console.warn('Could not ask which version to keep; this device\'s change stays.', error);
        return 'mine';
      }
    }
    // Sends the outbox in order. One flush at a time; anything still queued waits for the next connection. A save made
    // while a flush is running is picked up by that same flush (rounds below), so it goes out at once instead of
    // sitting in the outbox — with the dot on amber — until the next three-minute sync.
    flush() {
      if (this.readOnly || this.flushing) return this.flushing || Promise.resolve();
      const send = async (round = 0) => {
        const queue = await this.vault.pending();
        if (!queue.length) return this.report();
        if (navigator.onLine === false) { this.offline = true; return this.report(); }
        this.report('saving');
        let remote;
        try {
          remote = await this.stampsNow();
        } catch (error) {
          this.offline = isOffline(error);
          return this.report(this.offline ? 'offline' : 'error');
        }
        for (const item of queue) {
          // Names Firebase cannot store are swapped for ones it can, here as everywhere else. Anything still unusable
          // after that is reported by name rather than retried for ever, since nothing here could put it right.
          const payload = safeKeysDeep(item.update, true);
          const bad = badKeyIn(payload, true);
          if (bad) {
            this.lastError = `Firebase cannot store the name “${bad.key}” — a name cannot contain . $ # [ ] or /. Rename it (at ${bad.at}), then sync again.`;
            return this.report('error');
          }
          const clashes = this.clashes(item, remote);
          if (clashes.length && this.onConflict) {
            const choice = await this.whichStays({ paths: clashes, at: item.at, remote: remote[stampKey(clashes[0])] });
            if (choice !== 'mine') {
              await this.vault.release(item.id);
              this.stale = true;
              continue;
            }
          }
          try {
            await this.raw.patch(this.stamped(payload));
            await this.vault.release(item.id);
          } catch (error) {
            this.offline = isOffline(error);
            // Why it failed, kept where the Sync panel can show it: a send that fails silently looks exactly like one
            // that never happened, and leaves nothing to act on.
            this.lastError = this.offline ? null : (error?.message || String(error));
            return this.report(this.offline ? 'offline' : 'error');
          }
        }
        this.lastError = null;
        this.offline = false;
        await this.stampsNow().catch(() => {});
        if (round < MAX_ROUNDS && (await this.vault.pending()).length) return send(round + 1);
        this.report();
      };
      this.flushing = send().finally(() => { this.flushing = null; });
      return this.flushing;
    }
  }

  global.OfflineVault = OfflineVault;
  global.OfflineSync = OfflineSync;
})(typeof globalThis !== 'undefined' ? globalThis : window);
