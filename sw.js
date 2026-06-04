const CACHE = 'barhub-v4';

self.addEventListener('install', e => {
  // No pre-cacheamos nada — evita servir HTML desactualizado
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Borra todos los cachés viejos y toma control inmediato
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Llamadas API → siempre red, sin caché
  if (url.includes('/api/')) return;

  // HTML principal (/barhub) → siempre red, sin fallback a caché
  // Garantiza que el usuario tenga el código más reciente en cada apertura
  if (e.request.mode === 'navigate' || url.endsWith('/barhub') || url.includes('/barhub?')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Demás assets (iconos, manifest) → red primero, caché como fallback offline
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
