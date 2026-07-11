const CACHE_NAME = 'balaka-v9';

// Derive BASE from the service worker's own location instead of hardcoding
// '/balakasangha-attendance'. Previously, if this file were ever served from
// a different path (different repo name, custom domain root, a subpath
// change), every entry in ASSETS would 404 during install; each failure was
// individually swallowed by .catch(), so you'd get a silently incomplete
// offline cache with no visible error. Deriving BASE from
// self.registration.scope means this works wherever the file is actually
// deployed, with no manual path to keep in sync.
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');

const ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/Balakasangha_Enhanced.html',
  BASE + '/manifest.json',
  BASE + '/swamiji.jpg',
  BASE + '/rkmission_logo.png'
];

// Max time to wait for the network before falling back to cache on a
// navigation request. Previously there was no timeout at all, so on a slow
// or flaky connection (very plausible on mobile data during a live Sunday
// session) the fetch could hang indefinitely instead of falling back
// quickly.
const NETWORK_TIMEOUT_MS = 4000;

function fetchWithTimeout(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), timeoutMs);
    fetch(req).then(
      res => { clearTimeout(timer); resolve(res); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        ASSETS.map(url =>
          cache.add(url).catch(err =>
            console.warn('[SW] Could not cache:', url, err.message)
          )
        )
      );
    })
  );
  self.skipWaiting(); // activate immediately
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(k => {
          if (k !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          }
        })
      )
    ).then(() => self.clients.claim()) // take control of all tabs immediately
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const acceptHeader = req.headers.get('accept') || '';
  const isNavigation = req.mode === 'navigate' || acceptHeader.includes('text/html');

  // For HTML pages: try network first (bounded by a timeout), fall back to cache
  if (isNavigation) {
    event.respondWith(
      fetchWithTimeout(req, NETWORK_TIMEOUT_MS).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        return res;
      }).catch(() => caches.match(BASE + '/Balakasangha_Enhanced.html'))
    );
    return;
  }

  // For other assets: cache first, then network
  event.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy));
        return res;
      }).catch(() => cached)
    )
  );
});
