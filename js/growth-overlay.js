/**
 * GrowthOverlay — map heatmap colouring visible cells by growth score.
 *
 * Requires GEE-derived COGs in data/growth/ (buildings_temporal,
 * viirs, ghsl_pop). When those files are absent, the overlay no-ops
 * with a one-time non-blocking toast pointing the user at the pipeline
 * script — instead of flooding the console with 192 fetches per refresh.
 *
 * Spec §7.2 — composite score per cell, horizon-weighted.
 */
const GrowthOverlay = (() => {
    const SOURCE_ID = 'growth-overlay-src';
    const LAYER_ID  = 'growth-overlay-fill';
    const GRID_SIZE = 8;
    const PROBE_URL = 'data/growth/buildings_temporal_2016-2023.tif';
    let _active = false;
    let _horizon = 'nowcast';
    let _dataAvailable = null;   // tri-state: null|true|false
    let _refreshTimer = null;

    function _colorFor(score) {
        if (score == null) return 'rgba(0,0,0,0)';
        if (score >= 75) return '#dc2626';
        if (score >= 60) return '#f97316';
        if (score >= 45) return '#dbab09';
        if (score >= 30) return '#2dba4e';
        return '#0e6e2e';
    }

    async function _probeDataAvailability() {
        if (_dataAvailable !== null) return _dataAvailable;
        try {
            const r = await fetch(PROBE_URL, { method: 'HEAD', cache: 'no-store' });
            _dataAvailable = r.ok;
        } catch {
            _dataAvailable = false;
        }
        return _dataAvailable;
    }

    function setHorizon(h) {
        _horizon = h;
        if (_active) _scheduleRefresh();
    }

    function _scheduleRefresh() {
        clearTimeout(_refreshTimer);
        _refreshTimer = setTimeout(refresh, 350);
    }

    async function refresh() {
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!map) return;

        if (!map.getSource(SOURCE_ID)) {
            map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({
                id: LAYER_ID,
                type: 'fill',
                source: SOURCE_ID,
                paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.45, 'fill-outline-color': 'rgba(255,255,255,0.15)' },
            });
        }

        const available = await _probeDataAvailability();
        if (!available) {
            if (typeof showToast === 'function') {
                showToast(
                    'Growth overlay — data missing',
                    'Growth COGs (data/growth/*.tif) not generated. Run `python pipeline/growth/extract_*.py` with GEE credentials.',
                    'warn',
                );
            }
            return;
        }

        const b = map.getBounds();
        const dLat = (b.getNorth() - b.getSouth()) / GRID_SIZE;
        const dLng = (b.getEast()  - b.getWest())  / GRID_SIZE;
        const cells = [];
        for (let i = 0; i < GRID_SIZE; i++) {
            for (let j = 0; j < GRID_SIZE; j++) {
                cells.push({
                    lat: b.getSouth() + (i + 0.5) * dLat,
                    lng: b.getWest()  + (j + 0.5) * dLng,
                    south: b.getSouth() + i * dLat,
                    north: b.getSouth() + (i + 1) * dLat,
                    west:  b.getWest()  + j * dLng,
                    east:  b.getWest()  + (j + 1) * dLng,
                });
            }
        }

        const features = await Promise.all(cells.map(async (c) => {
            let score = null;
            try {
                const signals = await RealtimeGrowth.fetchCell(c.lat, c.lng, {});
                const scored = RealtimeGrowth.scoreCell(signals);
                if (scored && scored.horizons && scored.horizons[_horizon]) {
                    score = scored.horizons[_horizon].composite;
                }
            } catch { /* leave score null */ }
            return {
                type: 'Feature',
                properties: { color: _colorFor(score), score },
                geometry: { type: 'Polygon', coordinates: [[
                    [c.west, c.south], [c.east, c.south],
                    [c.east, c.north], [c.west, c.north],
                    [c.west, c.south],
                ]] },
            };
        }));

        const visible = features.filter(f => f.properties.score != null);
        if (map.getSource(SOURCE_ID)) {
            map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: visible });
        }
    }

    function _onMapMove() {
        if (_active && _dataAvailable) _scheduleRefresh();
    }

    function attach() {
        _active = true;
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (map) map.on('moveend', _onMapMove);
        refresh();
    }

    function detach() {
        _active = false;
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!map) return;
        map.off('moveend', _onMapMove);
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }

    function toggle() {
        if (_active) detach();
        else attach();
    }

    return { attach, detach, toggle, setHorizon, refresh };
})();

if (typeof window !== 'undefined') window.GrowthOverlay = GrowthOverlay;
