/**
 * CAGrowthOverlay — colours visible cells by the CA-ML urban-growth PREDICTION
 * (probability a cell is built-up by the model horizon, ~2035).
 *
 * A separate layer from the SSP-based Growth Forecast (GrowthOverlay): it reads
 * result.realtime.growth.ca_growth_prob (0..1, from data/growth/
 * ca_urban_prediction.tif via realtime-growth.js). Same viewport-sampling
 * pattern as GrowthOverlay / HeatmapOverlay. Honest framing: a model projection,
 * validated by hindcast (FoM/Kappa) — see docs/CA_GROWTH_MODEL.md.
 */
const CAGrowthOverlay = (() => {
    const SOURCE_ID = 'ca-growth-overlay-src';
    const LAYER_ID  = 'ca-growth-overlay-fill';
    const LEGEND_ID = 'ca-growth-legend';
    const GRID_SIZE = 5;
    const SAMPLE_RADIUS_M = 400;

    // Probability bands (0–100), sequential pale→deep purple ("future build-up").
    const BANDS = [
        { min: 70, color: '#54278f', label: 'Very likely (70+)' },
        { min: 45, color: '#756bb1', label: 'Likely (45–69)' },
        { min: 20, color: '#bcbddc', label: 'Possible (20–44)' },
        { min: 0,  color: '#efedf5', label: 'Unlikely (<20)' },
    ];

    let _active = false;
    let _map = null;
    let _features = [];
    let _abort = null;

    /** Band colour for a 0..100 probability (transparent when no signal). */
    function colorFor(prob) {
        if (prob == null || !Number.isFinite(prob)) return 'rgba(0,0,0,0)';
        for (let i = 0; i < BANDS.length; i++) if (prob >= BANDS[i].min) return BANDS[i].color;
        return 'rgba(0,0,0,0)';
    }

    /** Square GeoJSON polygon for a sampled point, coloured by its probability. */
    function cellFeature(pt, prob) {
        const halfLat = pt.latStep / 2, halfLng = pt.lngStep / 2;
        return {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [[
                [pt.lng - halfLng, pt.lat - halfLat],
                [pt.lng + halfLng, pt.lat - halfLat],
                [pt.lng + halfLng, pt.lat + halfLat],
                [pt.lng - halfLng, pt.lat + halfLat],
                [pt.lng - halfLng, pt.lat - halfLat],
            ]] },
            properties: { color: colorFor(prob), prob },
        };
    }

    /** Pull the CA probability (0..100) from a fetched cell result, or null. */
    function probOf(result) {
        const p = result && result.realtime && result.realtime.growth
            && result.realtime.growth.ca_growth_prob;
        return Number.isFinite(p) ? Math.round(Math.max(0, Math.min(1, p)) * 100) : null;
    }

    function _ensureLayer() {
        if (!_map.getSource(SOURCE_ID)) {
            _map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            _map.addLayer({
                id: LAYER_ID, type: 'fill', source: SOURCE_ID,
                paint: { 'fill-color': ['get', 'color'],
                    'fill-opacity': (typeof Theme !== 'undefined' && Theme.get() === 'light') ? 0.6 : 0.5 },
            });
        }
    }

    async function refresh() {
        _map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!_map || typeof DataFetcher === 'undefined') return;
        if (_abort) _abort.abort();
        _abort = new AbortController();
        const signal = _abort.signal;
        _features = [];
        _ensureLayer();
        _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });

        const bounds = _map.getBounds();
        const latStep = (bounds.getNorth() - bounds.getSouth()) / GRID_SIZE;
        const lngStep = (bounds.getEast() - bounds.getWest()) / GRID_SIZE;
        const points = [];
        for (let i = 0; i < GRID_SIZE; i++) {
            for (let j = 0; j < GRID_SIZE; j++) {
                points.push({ lat: bounds.getSouth() + latStep * (i + 0.5),
                    lng: bounds.getWest() + lngStep * (j + 0.5), latStep, lngStep });
            }
        }
        if (typeof App !== 'undefined') App.showToast('Growth prediction', `Sampling ${points.length} cells (CA-ML)…`, 'info');

        for (let b = 0; b < points.length; b += 6) {
            if (signal.aborted) return;
            const chunk = points.slice(b, b + 6);
            const results = await Promise.allSettled(
                chunk.map(pt => DataFetcher.fetchAllFeatures(pt.lat, pt.lng, SAMPLE_RADIUS_M)));
            let added = false;
            results.forEach((r, idx) => {
                if (r.status !== 'fulfilled' || signal.aborted) return;
                const prob = probOf(r.value);
                if (prob == null) return;
                _features.push(cellFeature(chunk[idx], prob));
                added = true;
            });
            if (added && !signal.aborted && _map.getSource(SOURCE_ID)) {
                _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: _features });
            }
            if (b + 6 < points.length) await new Promise(res => setTimeout(res, 200));
        }
        if (!signal.aborted && typeof App !== 'undefined') {
            App.showToast('Growth prediction',
                _features.length ? `${_features.length} cells (CA-ML prediction).`
                                 : 'No CA prediction layer for this view (run the model).',
                _features.length ? 'success' : 'warning');
        }
    }

    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8',
            surface: 'rgba(10,14,39,0.92)', border: 'rgba(255,255,255,0.12)' };
    }
    function _renderLegend() {
        let el = document.getElementById(LEGEND_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = LEGEND_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'CA-ML growth prediction legend');
            document.body.appendChild(el);
        }
        const pal = _palette();
        const titleFont = (typeof Theme !== 'undefined' && Theme.get && Theme.get() === 'light')
            ? "'Newsreader',Georgia,serif" : 'inherit';
        el.style.cssText = `position:absolute;bottom:24px;left:24px;z-index:5;background:${pal.surface};`
            + `border:1px solid ${pal.border};border-radius:10px;padding:12px 14px;color:${pal.ink};`
            + 'font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);';
        const rows = BANDS.map(b => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">`
            + `<span style="width:14px;height:14px;border-radius:3px;background:${b.color};flex:none;"></span>`
            + `<span style="color:${pal.sub};">${b.label}</span></div>`).join('');
        el.innerHTML = `<div style="font-family:${titleFont};font-weight:600;font-size:15px;margin-bottom:8px;color:${pal.primary};">Growth prediction (CA-ML)</div>`
            + rows
            + `<div style="margin-top:6px;color:${pal.sub};font-size:11px;">Model projection to ~2035 · hindcast-validated</div>`;
    }
    function _removeLegend() { const el = document.getElementById(LEGEND_ID); if (el) el.remove(); }

    function attach() { _active = true; _renderLegend(); refresh(); }
    function detach() {
        _active = false;
        if (_abort) { _abort.abort(); _abort = null; }
        _removeLegend();
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!map) return;
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }
    function toggle() { if (_active) detach(); else attach(); }
    function isVisible() { return _active; }

    return { attach, detach, toggle, isVisible, colorFor, cellFeature, probOf, BANDS };
})();

if (typeof window !== 'undefined') window.CAGrowthOverlay = CAGrowthOverlay;
