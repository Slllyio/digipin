/**
 * Service Worker — Offline cache for DigiPin portal
 * Caches static assets; API calls use network-first strategy
 */
const CACHE_NAME = 'digipin-v3';
const STATIC_ASSETS = [
    './',
    './index.html',
    './css/styles.css',
    './js/digipin.js',
    './js/data-fetcher.js',
    './js/map.js',
    './js/panel.js',
    './js/query-engine.js',
    './js/disha.js',
    './js/disha-panel.js',
    './js/app.js',
    './js/compare.js',
    './js/isochrone.js',
    './js/report.js',
    './js/heatmap-overlay.js',
    './js/bookmarks.js',
    './js/city-selector.js',
    './js/ward-overlay.js',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Network-first for API calls
    if (url.hostname !== location.hostname) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
        return;
    }

    // Cache-first for static assets
    event.respondWith(
        caches.match(event.request).then(cached => {
            const fetched = fetch(event.request).then(response => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            });
            return cached || fetched;
        })
    );
});
