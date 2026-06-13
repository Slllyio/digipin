/**
 * Service Worker — Offline cache for DigiPin portal
 * Caches static assets; API calls use network-first strategy
 */
const CACHE_NAME = 'digipin-v5';

// Same-origin app shell. The remaining js/*.js modules are picked up by the
// runtime cache-first handler on first online load.
const LOCAL_ASSETS = [
    './',                 // landing page (index.html)
    './index.html',
    './app.html',         // the live map app shell
    './css/landing.css',
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
];

// Third-party libraries the map actually depends on. The app uses MapLibre GL
// (not Leaflet), and the cross-origin fetch handler below is network-first and
// never caches these — so precaching them here is what makes the map usable
// offline. Versions must match the <script>/<link> tags in app.html.
const CDN_ASSETS = [
    'https://unpkg.com/maplibre-gl@4.1.3/dist/maplibre-gl.css',
    'https://unpkg.com/maplibre-gl@4.1.3/dist/maplibre-gl.js',
    'https://unpkg.com/pmtiles@3.0.7/dist/pmtiles.js',
    'https://unpkg.com/georaster@1.6.0/dist/georaster.browser.bundle.min.js',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            // Best-effort per asset: a single unreachable URL (e.g. a momentary
            // CDN blip) must not abort the whole install the way cache.addAll
            // would — that would leave the user with no offline support at all.
            Promise.allSettled([...LOCAL_ASSETS, ...CDN_ASSETS].map(url => cache.add(url)))
        ).then(() => self.skipWaiting())
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

    // Precomputed-score manifest: network-first so a monthly tile refresh is
    // picked up promptly (falls back to cache offline). The score *shards*
    // themselves fall through to the cache-first + background-revalidate handler
    // below — instant and offline-capable, refreshed in the background.
    if (url.pathname.endsWith('/data/scores/coverage.json')) {
        event.respondWith(
            fetch(event.request).then(response => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            }).catch(() => caches.match(event.request))
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
