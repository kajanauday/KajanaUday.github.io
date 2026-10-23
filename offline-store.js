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
(function (global) {
  const DB_NAME = 'family-budget-offline';
  const VERSION = 1;
  const NODES = 'nodes';
  const OUTBOX = 'outbox';
  const NOTES = 'notes';
  const DEFAULT_BUDGET = 200 * 1024 * 1024;
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

  class OfflineVault {
    // Resolves to null where IndexedDB cannot be used (some private windows); the app then runs online-only, as before.
    static async open({ budget = DEFAULT_BUDGET } = {}) {
      try {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(DB_NAME, VERSION);
          request.onupgradeneeded = () => {
            const open = request.result;
            if (!open.objectStoreNames.contains(NODES)) open.createObjectStore(NODES, { keyPath: 'path' });
            if (!open.objectStoreNames.contains(OUTBOX)) open.createObjectStore(OUTBOX, { keyPath: 'id', autoIncrement: true });
            if (!open.objectStoreNames.contains(NOTES)) open.createObjectStore(NOTES);
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('blocked'));
        });
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
          await this.vault.keep(path, data, this.stamps[stampKey(path)]?.at || 0);
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
    // Written to this device and queued; sending is tried at once and again whenever the connection returns.
    async patch(update) {
      if (this.readOnly) return null;
      const seen = Object.fromEntries(Object.keys(update).map(path => [stampKey(path), this.stamps[stampKey(path)]?.at || 0]));
      await this.vault.apply(update);
      await this.vault.queue(update, seen);
      this.report();
      await this.flush();
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
    // Sends the outbox in order. One flush at a time; anything still queued waits for the next connection.
    flush() {
      if (this.readOnly || this.flushing) return this.flushing || Promise.resolve();
      this.flushing = (async () => {
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
          const clashes = this.clashes(item, remote);
          if (clashes.length && this.onConflict) {
            const choice = await this.onConflict({ paths: clashes, at: item.at, remote: remote[stampKey(clashes[0])] });
            if (choice !== 'mine') {
              await this.vault.release(item.id);
              this.stale = true;
              continue;
            }
          }
          try {
            await this.raw.patch(this.stamped(item.update));
            await this.vault.release(item.id);
          } catch (error) {
            this.offline = isOffline(error);
            return this.report(this.offline ? 'offline' : 'error');
          }
        }
        this.offline = false;
        await this.stampsNow().catch(() => {});
        this.report();
      })().finally(() => { this.flushing = null; });
      return this.flushing;
    }
  }

  global.OfflineVault = OfflineVault;
  global.OfflineSync = OfflineSync;
})(typeof globalThis !== 'undefined' ? globalThis : window);
