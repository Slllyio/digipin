/**
 * GrowthOverlay — colours visible cells by their Urban Growth Forecast.
 *
 * Mirrors HeatmapOverlay's viewport-sampling pattern (js/heatmap-overlay.js):
 * sample a grid of points across the view, batch-fetch each through
 * DataFetcher.fetchAllFeatures (which stashes the forecast on
 * result.realtime.growth via RealtimeGrowth, data-fetcher.js:835), read the
 * composite for the active horizon, and paint a polygon per point. A small
 * theme-aware legend lets the user switch horizon (Now / 1–2 yr / 5 yr).
 *
 * Spec §7.2. (Previously a stub that rendered an empty layer.)
 */
const GrowthOverlay = (() => {
    const SOURCE_ID = 'growth-overlay-src';
    const LAYER_ID  = 'growth-overlay-fill';
    const LEGEND_ID = 'growth-legend';
    const GRID_SIZE = 5;          // 25 sample points per viewport
    const SAMPLE_RADIUS_M = 400;

    const HORIZONS = [
        { key: 'nowcast', label: 'Now' },
        { key: 'year_2',  label: '1–2 yr' },
        { key: 'year_5',  label: '5 yr' },
    ];

    // Growth-intensity bands (composite 0–100) — diverging red→blue so
    // intensifying areas read hot and stable/cooling read cool.
    const BANDS = [
        { min: 75, color: '#b2182b', label: 'Intensifying (75+)' },
        { min: 60, color: '#ef8a62', label: 'Rising (60–74)' },
        { min: 45, color: '#fddbc7', label: 'Emerging (45–59)' },
        { min: 0,  color: '#67a9cf', label: 'Stable / cooling (<45)' },
    ];

    let _active = false;
    let _horizon = 'nowcast';
    let _map = null;
    let _features = [];
    let _abort = null;

    /** Per-theme band colours (light deepens the pale stops for the Positron basemap). */
    function _colors() {
        return (typeof Theme !== 'undefined' && Theme.scale && Theme.scale('growth')) || BANDS.map(b => b.color);
    }

    /** Band colour for a composite score (transparent when no signal). */
    function colorFor(score) {
        if (score == null || !Number.isFinite(score)) return 'rgba(0,0,0,0)';
        const cols = _colors();
        for (let i = 0; i < BANDS.length; i++) if (score >= BANDS[i].min) return cols[i];
        return 'rgba(0,0,0,0)';
    }

    /** Square GeoJSON polygon for a sampled point, coloured by its score. */
    function cellFeature(pt, score) {
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
            properties: { color: colorFor(score), score },
        };
    }

    function _horizonLabel(key) {
        return (HORIZONS.find(h => h.key === (key || _horizon)) || HORIZONS[0]).label;
    }

    function setHorizon(h) {
        if (!HORIZONS.some(x => x.key === h)) return;
        _horizon = h;
        if (_active) { _renderLegend(); refresh(); }
    }

    function _ensureLayer() {
        if (!_map.getSource(SOURCE_ID)) {
            _map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            _map.addLayer({
                id: LAYER_ID,
                type: 'fill',
                source: SOURCE_ID,
                paint: { 'fill-color': ['get', 'color'],
                    'fill-opacity': (typeof Theme !== 'undefined' && Theme.get() === 'light') ? 0.62 : 0.5 },
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
                points.push({
                    lat: bounds.getSouth() + latStep * (i + 0.5),
                    lng: bounds.getWest() + lngStep * (j + 0.5),
                    latStep, lngStep,
                });
            }
        }

        App.showToast('Growth Forecast', `Sampling ${points.length} cells (${_horizonLabel()})…`, 'info');

        for (let b = 0; b < points.length; b += 6) {
            if (signal.aborted) return;
            const chunk = points.slice(b, b + 6);
            const results = await Promise.allSettled(
                chunk.map(pt => DataFetcher.fetchAllFeatures(pt.lat, pt.lng, SAMPLE_RADIUS_M))
            );
            let added = false;
            results.forEach((r, idx) => {
                if (r.status !== 'fulfilled' || signal.aborted) return;
                const composite = r.value?.realtime?.growth?.horizons?.[_horizon]?.composite;
                if (composite == null) return;
                _features.push(cellFeature(chunk[idx], composite));
                added = true;
            });
            if (added && !signal.aborted && _map.getSource(SOURCE_ID)) {
                _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: _features });
            }
            if (b + 6 < points.length) await new Promise(res => setTimeout(res, 200));
        }

        if (!signal.aborted) {
            App.showToast('Growth Forecast',
                _features.length ? `${_features.length} cells scored (${_horizonLabel()}).` : 'No growth signal in this view.',
                _features.length ? 'success' : 'warning');
        }
    }

    // ── Legend + horizon selector (theme-aware; a theme switch reloads) ──────
    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8',
                 surface: 'rgba(10,14,39,0.92)', surfaceSolid: '#111638', border: 'rgba(255,255,255,0.12)' };
    }

    function _renderLegend() {
        let el = document.getElementById(LEGEND_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = LEGEND_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'Growth forecast legend and horizon selector');
            document.body.appendChild(el);
        }
        const pal = _palette();
        el.style.cssText = `position:absolute;bottom:24px;left:24px;z-index:5;background:${pal.surface};`
            + `border:1px solid ${pal.border};border-radius:10px;padding:12px 14px;color:${pal.ink};`
            + 'font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);';
        const sel = `background:${pal.surfaceSolid};color:${pal.ink};border:1px solid ${pal.border};border-radius:4px;padding:2px 4px;`;
        const hopts = HORIZONS.map(h => `<option value="${h.key}">${h.label}</option>`).join('');
        const cols = _colors();
        const swatches = BANDS.map((b, i) =>
            `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">`
            + `<span style="width:14px;height:14px;border-radius:3px;background:${cols[i]};flex:none;"></span>`
            + `<span style="color:${pal.sub};">${b.label}</span></div>`).join('');
        el.innerHTML = `
            <div style="font-weight:600;margin-bottom:8px;color:${pal.primary};">Growth Forecast</div>
            ${swatches}
            <label style="display:block;margin-top:10px;">Horizon&nbsp;<select id="growth-horizon" style="${sel}">${hopts}</select></label>`;
        const hsel = el.querySelector('#growth-horizon');
        hsel.value = _horizon;
        hsel.onchange = (e) => setHorizon(e.target.value);
    }

    function _removeLegend() {
        const el = document.getElementById(LEGEND_ID);
        if (el) el.remove();
    }

    function attach() {
        _active = true;
        _renderLegend();
        refresh();
    }

    function detach() {
        _active = false;
        if (_abort) { _abort.abort(); _abort = null; }
        _removeLegend();
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!map) return;
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }

    function toggle() {
        if (_active) detach();
        else attach();
    }

    function isVisible() { return _active; }
    function getHorizon() { return _horizon; }

    return { attach, detach, toggle, setHorizon, getHorizon, isVisible, colorFor, cellFeature, HORIZONS, BANDS };
})();

if (typeof window !== 'undefined') window.GrowthOverlay = GrowthOverlay;
