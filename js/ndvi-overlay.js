/**
 * NDVIOverlay — satellite vegetation-health raster (map type #7).
 *
 * Source: NASA GIBS MODIS/Terra NDVI 8-Day (250 m), served as keyless
 * EPSG:3857 WMTS PNG tiles — the canonical free NDVI tile service, no API key.
 * Greens = healthy/dense vegetation, browns = sparse/stressed.
 *
 * The 8-day product needs a valid period-start date in the path; gibsDateFor()
 * snaps a date to the MODIS 8-day grid (DOY 1,9,17,…) and backs off ~16 days so
 * a published granule always exists. If tiles fail to load (network / blocked),
 * a one-shot toast fires so the layer never sits blank *silently* — it just
 * shows whatever granules resolve. Idempotent attach/detach.
 *
 * NOTE: GIBS is unreachable from CI sandboxes (proxy 403) but is a stable
 * public service in real browsers; the error handler covers the failure case.
 */
const NDVIOverlay = (() => {
    const SOURCE_ID = 'ndvi-overlay-source';
    const LAYER_ID  = 'ndvi-overlay-layer';
    const LAYER = 'MODIS_Terra_NDVI_8Day';
    const TMS = 'GoogleMapsCompatible_Level8';   // 8-day NDVI maxes at level 8
    const MAXZOOM = 8;

    let _map = null;
    let _active = false;
    let _errHandler = null;
    let _warned = false;

    /** Snap a date to the MODIS 8-day period start (UTC), backing off `backDays`
     *  first so the granule is already published. Returns 'YYYY-MM-DD'. */
    function gibsDateFor(date = new Date(), backDays = 16) {
        const d = new Date(date.getTime() - backDays * 86400000);
        const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
        const doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - yearStart) / 86400000); // 0-based
        const periodStart = new Date(yearStart + Math.floor(doy / 8) * 8 * 86400000);
        return periodStart.toISOString().slice(0, 10);
    }

    function _tileUrl() {
        return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${LAYER}/default/${gibsDateFor()}/${TMS}/{z}/{y}/{x}.png`;
    }

    function attach() {
        if (typeof MapModule === 'undefined') return;
        _map = MapModule.getMap();
        if (!_map) return;
        _active = true;
        _warned = false;

        if (!_map.getSource(SOURCE_ID)) {
            _map.addSource(SOURCE_ID, {
                type: 'raster',
                tiles: [_tileUrl()],
                tileSize: 256,
                maxzoom: MAXZOOM,
                attribution: 'NDVI: NASA GIBS / MODIS Terra',
            });
            _map.addLayer({
                id: LAYER_ID,
                type: 'raster',
                source: SOURCE_ID,
                paint: { 'raster-opacity': 0.7 },
            });
        }

        // One-shot notice if NDVI tiles can't load, so the layer never sits
        // blank without explanation.
        _errHandler = (e) => {
            if (_warned) return;
            if (e && e.sourceId === SOURCE_ID) {
                _warned = true;
                if (typeof App !== 'undefined') {
                    App.showToast('NDVI unavailable', 'Could not load NASA GIBS NDVI tiles for this view.', 'error');
                }
            }
        };
        _map.on('error', _errHandler);

        if (typeof App !== 'undefined') {
            App.showToast('NDVI Vegetation', `MODIS NDVI (8-day, ${gibsDateFor()}) — greener = healthier vegetation.`, 'info');
        }
    }

    function detach() {
        _active = false;
        if (_map) {
            if (_errHandler) { _map.off('error', _errHandler); _errHandler = null; }
            if (_map.getLayer(LAYER_ID)) _map.removeLayer(LAYER_ID);
            if (_map.getSource(SOURCE_ID)) _map.removeSource(SOURCE_ID);
        }
    }

    function toggle() { if (_active) detach(); else attach(); }

    return { attach, detach, toggle, gibsDateFor };
})();

if (typeof window !== 'undefined') window.NDVIOverlay = NDVIOverlay;
