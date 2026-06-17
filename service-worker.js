const CACHE_NAME = 'balaka-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/Balakasangha_Synced.html',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => { if(k!==CACHE_NAME) return caches.delete(k); })))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      try{ const copy = res.clone(); caches.open(CACHE_NAME).then(c=>c.put(req, copy)); }catch(e){}
      return res;
    }).catch(()=>caches.match('/Balakasangha_Synced.html')))
  );
});
