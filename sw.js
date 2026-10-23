// The app itself, kept on the device, so it opens with no connection. The ledger's data is handled separately, by
// offline-store.js; this only keeps the files the browser needs to start: the two pages, the scripts, the stylesheet and
// the icon and font files they pull in.
//
// A page goes to the network first and falls back to its copy, so a new build shows as soon as it is published and the
// app still opens with no connection. The scripts and the stylesheet are served from the copy at once, since a changed
// one carries a new ?v= tag and so is a new URL. Firebase and sign-in are never cached: those always go to the network,
// and when there is none the app falls back to the copy of the ledger instead.
const CACHE = 'family-budget-shell-v1';
const SHELL = ['./family-budget/months.html', './family-budget-vertical.html'];
const neverCache = url => /firebasedatabase\.app|identitytoolkit|securetoken/.test(url);

const offlineNote = () => new Response('Offline, and this part of the app is not on this device yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || neverCache(request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fresh = fetch(request).then(response => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    }).catch(() => null);
    // A page is fetched first and falls back to the copy, so a new build is picked up the moment it is published; the
    // scripts and the stylesheet carry a ?v= tag, so a changed one is a new URL and its copy can be used straight away.
    if (request.mode === 'navigate') {
      return (await fresh) || await cache.match(request, { ignoreSearch: true }) || offlineNote();
    }
    return (await cache.match(request, { ignoreSearch: false })) || (await fresh) || offlineNote();
  })());
});
