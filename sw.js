/**
 * Service Worker — Offline cache for DigiPin portal
 * Caches static assets; API calls use network-first strategy
 */
const CACHE_NAME = 'digipin-v89';

// Full same-origin app shell — EVERY js/ module referenced by app.html, so the
// app is genuinely usable offline. (Previously only ~19 were precached and the
// rest were runtime-cached on first online use, which silently broke offline for
// any feature the user hadn't already opened.) tests/sw-precache.test.js parses
// app.html and fails CI if a <script> here drifts out of sync.
const LOCAL_ASSETS = [
    './',                 // landing page (index.html)
    './index.html',
    './app.html',         // the live map app shell
    './css/landing.css',
    './css/styles.css',
    './css/analyses.css',
    './css/polish.css',
    './css/insights.css',
    './css/agents.css',
    './assets/icon.svg',
    './assets/icon-maskable.svg',
    './manifest.json',
    './js/digipin.js',
    './js/lazy-libs.js',
    './js/data-fetcher-cache.js',
    './js/growth-score.js',
    './js/realtime-growth.js',
    './js/growth-widget.js',
    './js/growth-overlay.js',
    './js/ca-growth-overlay.js',
    './js/scenario-model.js',
    './js/scenario-panel.js',
    './js/area-aggregate.js',
    './js/traffic-score.js',
    './js/traffic-grid.js',
    './js/realtime-traffic.js',
    './js/traffic-widget.js',
    './js/traffic-overlay.js',
    './js/mobility-score.js',
    './js/mobility-grid.js',
    './js/emergency-access-score.js',
    './js/emergency-access.js',
    './js/realtime-mobility.js',
    './js/mobility-widget.js',
    './js/mobility-overlay.js',
    './js/emergency-access-overlay.js',
    './js/heat-score.js',
    './js/realtime-heat.js',
    './js/heat-widget.js',
    './js/heat-overlay.js',
    './js/flood-scs.js',
    './js/flood-inundation.js',
    './js/flood-animation.js',
    './js/realtime-alerts.js',
    './js/realtime-imd.js',
    './js/realtime-quakes.js',
    './js/realtime-flood.js',
    './js/utilities.js',
    './js/data-fetcher.js',
    './js/precomputed-scores.js',
    './js/score-choropleth.js',
    './js/data-status.js',
    './js/crash-guard.js',
    './js/cell-store.js',
    './js/cell-layers.js',
    './js/cell-ingest.js',
    './js/cell-profile.js',
    './js/time-slider.js',
    './js/footprint-grid.js',
    './js/building-intelligence.js',
    './js/overture-release.js',
    './js/terrain.js',
    './js/buildings-deck.js',
    './js/building-data.js',
    './js/overture-buildings.js',
    './js/theme.js',
    './js/i18n-ui.js',
    './js/i18n.js',
    './js/map.js',
    './js/keyboard-nav.js',
    './js/cell-hierarchy.js',
    './js/panel.js',
    './js/query-engine.js',
    './js/disha-cache.js',
    './js/disha-providers.js',
    './js/disha.js',
    './js/disha-actions.js',
    './js/text2map-embeddings.js',
    './js/text2map.js',
    './js/text2map-results-layer.js',
    './js/provenance.js',
    './js/map-snapshot.js',
    './js/open-data-finder.js',
    './js/disha-mentions.js',
    './js/disha-tools.js',
    './js/disha-agent.js',
    './js/disha-panel.js',
    './js/compare.js',
    './js/isochrone.js',
    './js/report.js',
    './js/heatmap-overlay.js',
    './js/bookmarks.js',
    './js/city-selector.js',
    './js/ward-overlay.js',
    './js/floating-dialogs.js',
    './js/building-intel-dialog.js',
    './js/scores-dialog.js',
    './js/digital-twin-layers.js',
    './js/bharatlas.js',
    './js/training-data-gen.js',
    './js/bivariate-overlay.js',
    './js/ndvi-overlay.js',
    './js/viewshed.js',
    './js/terrain-hydrology.js',
    './js/layer-swipe.js',
    './js/sentinel-imagery.js',
    './js/point-cloud.js',
    './js/kde-overlay.js',
    './js/accessibility-overlay.js',
    './js/url-state.js',
    './js/saved-views.js',
    './js/analysis.js',
    './js/analyses-panel.js',
    './js/urban-insights.js',
    './js/urban-lenses.js',
    './js/lenses-panel.js',
    './js/scenario-lenses.js',
    './js/intel-brief.js',
    './js/insights-panel.js',
    './js/urban-agents.js',
    './js/agents-panel.js',
    './js/disha-intel.js',
    './js/onboarding.js',
    './js/layers-panel.js',
    './js/dtdl-export.js',
    './js/real-estate-model.js',
    './js/real-estate-widget.js',
    './js/export-dialog.js',
    './js/footprint-export.js',
    './js/pitch-map.js',
    './js/sun-shadows.js',
    './js/sun-study.js',
    './js/camera-presets.js',
    './js/view-handoff.js',
    './js/sun-hours.js',
    './js/floor-area.js',
    './js/gltf-export.js',
    './js/site-brief.js',
    './js/measure-tool.js',
    './js/present-mode.js',
    './js/annotations.js',
    './js/app.js',
    './js/ui-polish.js',
    './js/trees-3d.js',
    './js/city-overview.js',
];

// Third-party libraries the map actually depends on. The app uses MapLibre GL
// (not Leaflet), and the cross-origin fetch handler below is network-first and
// never caches these — so precaching them here is what makes the map usable
// offline. Versions must match the <script>/<link> tags in app.html.
const CDN_ASSETS = [
    'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css',
    'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js',
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

// Only full 200s go in the cache. Caching a 404 for a data file that was
// deployed later pinned the 404 for every visitor until the next SW bump.
function _cacheIfOk(request, response) {
    if (response.status !== 200) return;
    const clone = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
}

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Range requests (PMTiles, COG readers) expect 206 Partial Content, which
    // the Cache API can't store — leave them to the network. Same for non-GET.
    if (event.request.method !== 'GET' || event.request.headers.has('range')) return;

    // Network-first for API calls
    if (url.hostname !== location.hostname) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
        return;
    }

    // Offline navigation fallback: a deep link to an un-precached route (or any
    // navigation while offline) should land on the app shell rather than the
    // browser's offline-error page. ('./', index.html, app.html are precached.)
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).catch(() =>
                caches.match(event.request).then(c => c || caches.match('./app.html')))
        );
        return;
    }

    // Precomputed-score manifest: network-first so a monthly tile refresh is
    // picked up promptly (falls back to cache offline). The score *shards*
    // themselves fall through to the cache-first + background-revalidate handler
    // below — instant and offline-capable, refreshed in the background.
    if (url.pathname.endsWith('/data/scores/coverage.json') || url.pathname.endsWith('/data/heights/index.json')) {
        event.respondWith(
            fetch(event.request).then(response => {
                _cacheIfOk(event.request, response);
                return response;
            }).catch(() => caches.match(event.request))
        );
        return;
    }

    // Cache-first for static assets
    event.respondWith(
        caches.match(event.request).then(cached => {
            const fetched = fetch(event.request).then(response => {
                _cacheIfOk(event.request, response);
                return response;
            });
            return cached || fetched;
        })
    );
});
