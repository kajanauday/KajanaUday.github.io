// FamilyAuth: Firebase Authentication (email and password, over its REST API) behind the passkey sign-in.
//
// Nothing here names a passkey, an account or a password. The Firebase account's email and password are both derived
// from what is typed, as two separate SHA-256 hashes, so only the right passkey reaches an account and a wrong one is
// simply a failed sign-in. The account itself says what it may do: its Firebase display name is its role, and anything
// other than 'admin' is treated as view-only. Database rules check the account's user ID, so the role here only shapes
// the screen.
// The session (ID token, refresh token, role, never the passkey) stays on this device until logout: sessionStorage
// holds it for the tab, and a copy is kept encrypted in localStorage so a new tab or visit restores it without signing
// in again. Its AES key is generated in the browser as non-extractable and kept in IndexedDB: scripts here can use it
// but nobody can read it out, so the stored copy is useless anywhere else. Where IndexedDB is unavailable (some private
// windows), the session simply lasts for the tab.
// token() hands out a valid ID token for Realtime Database requests, refreshing it shortly before it expires.
(function (global) {
  const SESSION_KEY = 'family-budget-static-demo-v1-auth';
  const REFRESH_EARLY_MS = 5 * 60 * 1000;
  const apiKey = () => FIREBASE_CONFIG.apiKey;

  const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  // The Firebase account a passkey opens: e-mail and password are separate hashes of it, never stored anywhere.
  async function credentialsFor(passkey) {
    const [account, secret] = await Promise.all([sha256(`family-budget:account:${passkey}`), sha256(`family-budget:password:${passkey}`)]);
    return { email: `u${account.slice(0, 32)}@${FIREBASE_CONFIG.authDomain}`, password: secret };
  }

  const failure = (code, message) => Object.assign(new Error(message || code), { code });
  // Firebase error messages → what the sign-in form can say.
  const reason = message => {
    if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND|MISSING_PASSWORD/.test(message)) return 'not-recognized';
    if (/TOO_MANY_ATTEMPTS/.test(message)) return 'too-many';
    if (/USER_DISABLED/.test(message)) return 'disabled';
    return 'unavailable';
  };

  // ---- device vault: the encrypted copy of the session ----
  const VAULT_ITEM = 'fb.v';
  const toBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
  function keyStore(mode, use) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('family-budget-vault', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('keys');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const request = use(db.transaction('keys', mode).objectStore('keys'));
        request.onsuccess = () => { resolve(request.result); db.close(); };
        request.onerror = () => { reject(request.error); db.close(); };
      };
    });
  }
  async function vaultKey(create) {
    const existing = await keyStore('readonly', store => store.get('session'));
    if (existing || !create) return existing || null;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await keyStore('readwrite', store => store.put(key, 'session'));
    return key;
  }
  async function keepOnDevice(data) {
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await vaultKey(true), new TextEncoder().encode(JSON.stringify(data)));
      if (session()?.uid === data.uid) localStorage.setItem(VAULT_ITEM, `${toBase64(iv)}.${toBase64(sealed)}`);
    } catch (error) { /* Not kept on this device; the session still lasts for the tab. */ }
  }
  // The session kept on this device, if any, put back for this tab. Anything that cannot be opened is discarded.
  async function restore() {
    const current = session();
    if (current) return current;
    const sealed = localStorage.getItem(VAULT_ITEM);
    if (!sealed) return null;
    try {
      const [iv, data] = sealed.split('.').map(fromBase64);
      const key = await vaultKey(false);
      if (!key) throw new Error('no key');
      const opened = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)));
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(opened));
      return opened;
    } catch (error) {
      localStorage.removeItem(VAULT_ITEM);
      return null;
    }
  }

  function session() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (error) { return null; }
  }
  function save(data) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
    keepOnDevice(data);
    return data;
  }
  // Ends the session here and on this device.
  function signOut() {
    sessionStorage.removeItem(SESSION_KEY);
    try { localStorage.removeItem(VAULT_ITEM); } catch (error) { /* Nothing kept. */ }
  }

  // Signs in with a passkey; resolves to the account's role ('admin' | 'viewer'), or rejects with code
  // 'not-recognized', 'too-many', 'disabled' or 'unavailable'.
  async function signIn(passkey) {
    const typed = String(passkey ?? '').trim();
    if (!typed) throw failure('not-recognized');
    const { email, password } = await credentialsFor(typed);
    let response;
    try {
      response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      });
    } catch (error) {
      throw failure('unavailable', error.message);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw failure(reason(data.error?.message || ''), data.error?.message);
    const role = data.displayName === 'admin' ? 'admin' : 'viewer';
    // Kept on this device before handing back, so going straight to the ledger cannot cut the encrypted copy short.
    await keepOnDevice(save({ uid: data.localId, role, idToken: data.idToken, refreshToken: data.refreshToken, expiresAt: Date.now() + Number(data.expiresIn) * 1000 }));
    return role;
  }

  // A valid ID token for database requests. One refresh at a time; a refresh Firebase refuses ends the session
  // (code 'signed-out'), while a network failure leaves it for the next try.
  let refreshing = null;
  async function token() {
    const current = session();
    if (!current) throw failure('signed-out');
    if (Date.now() < current.expiresAt - REFRESH_EARLY_MS) return current.idToken;
    refreshing ||= (async () => {
      let response;
      try {
        response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken })
        });
      } catch (error) {
        throw failure('unavailable', error.message);
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        signOut();
        throw failure('signed-out', data.error?.message);
      }
      return save({ ...current, idToken: data.id_token, refreshToken: data.refresh_token, expiresAt: Date.now() + Number(data.expires_in) * 1000 }).idToken;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  global.FamilyAuth = { signIn, signOut, session, restore, token };
})(typeof globalThis !== 'undefined' ? globalThis : window);
