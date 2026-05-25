/**
 * Service Worker — offline cache for DigiPin portal
 *
 * Design rules (the previous v3 violated all three):
 *   1. NEVER cache /data/* — those are large, frequently-updated, and
 *      many (PMTiles, COGs) use HTTP Range requests. Caching a 200
 *      response and replaying it against a Range request returns the
 *      whole file with status 200, which PMTiles + georaster choke on.
 *   2. NEVER cache Range requests — they're byte-range partial
 *      responses (206); the cache API doesn't preserve range semantics.
 *      Always go to network for these.
 *   3. NEVER cache non-OK responses. v3 stored 404s on first miss, then
 *      replayed them forever — exactly the bug that hid Heat / Growth
 *      / 3D Buildings while their data files were being added.
 *
 * Cache versioning: bump CACHE_NAME on any rule change so old caches
 * are evicted on the next page load via the 'activate' handler.
 */
const CACHE_NAME = 'digipin-v4';

// Precache shell only — everything else is lazy via the fetch handler.
// Listing every JS file here forced the previous version to drift; the
// new approach lets the page+css be available offline and lazy-caches
// scripts as they get used.
const SHELL = [
    './',
    './index.html',
    './css/styles.css',
    './manifest.json',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    const url = new URL(req.url);

    // === Rule 1: bypass for everything under /data/ ===
    // Realtime JSON snapshots, PMTiles, COGs, geojsons — all live data
    // that should never be cached by the SW. The browser's built-in
    // HTTP cache (with the no-cache headers the server already sends)
    // is the right layer for these.
    if (url.pathname.startsWith('/data/')) return;   // pass-through to network

    // === Rule 2: bypass for Range requests ===
    // PMTiles (and any HTTP-Range-aware client) sends `Range:` headers
    // expecting 206 Partial Content. The Cache API can't faithfully
    // round-trip 206 responses — always go straight to network.
    if (req.headers.has('range')) return;

    // === Rule 3: skip non-GET methods ===
    if (req.method !== 'GET') return;

    // Network-first for cross-origin requests (CDN scripts, external APIs)
    if (url.hostname !== self.location.hostname) {
        event.respondWith(
            fetch(req).catch(() => caches.match(req))
        );
        return;
    }

    // Same-origin static assets: cache-first, but never cache errors.
    event.respondWith(
        caches.match(req).then(cached => {
            const fetched = fetch(req).then(response => {
                // === Rule 4: never cache non-OK responses ===
                // 404 / 500 / opaque redirects all stay out of the cache.
                // This is the v3 → v4 fix that unblocked Heat + Growth +
                // 3D Buildings — those features' data files 404'd before
                // they were copied in, and the SW had pinned the 404
                // for every subsequent request.
                if (response.ok && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
                }
                return response;
            });
            return cached || fetched;
        })
    );
});
