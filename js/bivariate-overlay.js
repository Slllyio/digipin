/**
 * BivariateOverlay — render two intelligence scores in a single 3×3 bivariate
 * choropleth (map type #10 from the Urban Design Lab "10 must-have maps" list).
 *
 * Each visible cell is sampled, both scores are binned into low/med/high, and
 * the (x-bin, y-bin) pair selects one of 9 colours from the classic GnBu×Pu
 * bivariate palette. A legend + axis picker let the user choose the two scores.
 *
 * Follows the HeatmapOverlay sampling pattern (grid sample → fetchAllFeatures →
 * setData) and the idempotent attach/detach contract used across the overlays.
 * The classifier is a pure function (classify) so it is unit-testable.
 */
const BivariateOverlay = (() => {
    const SOURCE_ID = 'bivariate-overlay-source';
    const LAYER_ID  = 'bivariate-overlay-layer';
    const LEGEND_ID = 'bivariate-legend';

    // Bin thresholds on the 0–100 score scale: low [0,T1) / med [T1,T2) / high [T2,100].
    const T1 = 40, T2 = 70;

    // Classic Joshua-Stevens bivariate palette. PALETTE[yBin][xBin].
    const PALETTE = [
        ['#e8e8e8', '#ace4e4', '#5ac8c8'],  // y-low
        ['#dfb0d6', '#a5add3', '#5698b9'],  // y-med
        ['#be64ac', '#8c62aa', '#3b4994'],  // y-high
    ];

    // Reuse the same score catalogue as the single-variable heatmap overlay.
    const SCORE_OPTIONS = [
        { key: 'livability', label: 'Livability' },
        { key: 'safety', label: 'Safety' },
        { key: 'green', label: 'Green Index' },
        { key: 'connectivity', label: 'Connectivity' },
        { key: 'commercial', label: 'Commercial' },
        { key: 'healthcare_access', label: 'Healthcare' },
        { key: 'walkability', label: 'Walkability' },
        { key: 'food_diversity', label: 'Food Diversity' },
        { key: 'noise_estimate', label: 'Quietness' },
        { key: 'population_proxy', label: 'Population' },
    ];

    let _map = null;
    let _features = [];
    let _abort = null;
    let _keyX = 'population_proxy';
    let _keyY = 'green';
    let _active = false;

    function _bin(v) { return v < T1 ? 0 : v < T2 ? 1 : 2; }

    /** Pure classifier. Returns { xBin, yBin, idx, color }.
     *  null score on either axis → transparent (idx null). */
    function classify(x, y) {
        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
            return { xBin: null, yBin: null, idx: null, color: 'rgba(0,0,0,0)' };
        }
        const xBin = _bin(x), yBin = _bin(y);
        return { xBin, yBin, idx: yBin * 3 + xBin, color: PALETTE[yBin][xBin] };
    }

    function _labelFor(key) {
        return (SCORE_OPTIONS.find(o => o.key === key) || {}).label || key;
    }

    function _ensureLayer() {
        if (!_map.getSource(SOURCE_ID)) {
            _map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            _map.addLayer({
                id: LAYER_ID,
                type: 'fill',
                source: SOURCE_ID,
                paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.6, 'fill-outline-color': 'rgba(255,255,255,0.25)' },
            });
        }
    }

    async function _sample() {
        const bounds = _map.getBounds();
        const gridSize = 6;
        const latStep = (bounds.getNorth() - bounds.getSouth()) / gridSize;
        const lngStep = (bounds.getEast() - bounds.getWest()) / gridSize;

        // Cancel any prior run (double attach / rapid axis change), then take
        // per-run ownership: a stale loop must test *its own* controller, not the
        // module-level one a newer attach()/_restart() may have replaced — else it
        // would resume as "not aborted" and interleave stale features.
        if (_abort) _abort.abort();
        const myAbort = new AbortController();
        _abort = myAbort;
        const myFeatures = [];
        _features = myFeatures;
        const points = [];
        for (let i = 0; i < gridSize; i++) {
            for (let j = 0; j < gridSize; j++) {
                points.push({
                    lat: bounds.getSouth() + latStep * (i + 0.5),
                    lng: bounds.getWest() + lngStep * (j + 0.5),
                    latStep, lngStep,
                });
            }
        }

        if (typeof App !== 'undefined') {
            App.showToast('Bivariate Map', `Sampling ${points.length} cells: ${_labelFor(_keyX)} × ${_labelFor(_keyY)}…`, 'info');
        }

        for (let batch = 0; batch < points.length; batch += 6) {
            if (myAbort.signal.aborted) return;
            const chunk = points.slice(batch, batch + 6);
            const results = await Promise.allSettled(
                chunk.map(pt => DataFetcher.fetchAllFeatures(pt.lat, pt.lng, 400))
            );
            let addedNew = false;
            results.forEach((r, idx) => {
                if (r.status !== 'fulfilled' || myAbort.signal.aborted) return;
                const pt = chunk[idx];
                const x = r.value.scores?.[_keyX]?.value;
                const y = r.value.scores?.[_keyY]?.value;
                const cls = classify(x, y);
                if (cls.idx == null) return;
                myFeatures.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [pt.lng - pt.lngStep / 2, pt.lat - pt.latStep / 2],
                            [pt.lng + pt.lngStep / 2, pt.lat - pt.latStep / 2],
                            [pt.lng + pt.lngStep / 2, pt.lat + pt.latStep / 2],
                            [pt.lng - pt.lngStep / 2, pt.lat + pt.latStep / 2],
                            [pt.lng - pt.lngStep / 2, pt.lat - pt.latStep / 2],
                        ]],
                    },
                    properties: { color: cls.color, x, y, idx: cls.idx },
                });
                addedNew = true;
            });
            if (addedNew && !myAbort.signal.aborted && _map.getSource(SOURCE_ID)) {
                _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: myFeatures });
            }
            if (batch + 6 < points.length) await new Promise(r => setTimeout(r, 200));
        }
    }

    function _renderLegend() {
        let el = document.getElementById(LEGEND_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = LEGEND_ID;
            el.style.cssText = 'position:absolute;bottom:24px;left:24px;z-index:5;background:rgba(10,14,39,0.92);'
                + 'border:1px solid rgba(0,245,255,0.25);border-radius:10px;padding:12px 14px;color:#cfe;'
                + 'font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.4);';
            document.body.appendChild(el);
        }
        const opts = SCORE_OPTIONS.map(o => `<option value="${o.key}">${o.label}</option>`).join('');
        // 3×3 swatch grid (rows top=high Y → bottom=low Y so it reads like an axis).
        let grid = '<div style="display:grid;grid-template-columns:repeat(3,16px);gap:2px;">';
        for (let yBin = 2; yBin >= 0; yBin--) {
            for (let xBin = 0; xBin <= 2; xBin++) {
                grid += `<div title="x=${xBin} y=${yBin}" style="width:16px;height:16px;background:${PALETTE[yBin][xBin]};border-radius:2px;"></div>`;
            }
        }
        grid += '</div>';
        el.innerHTML = `
            <div style="font-weight:600;margin-bottom:8px;color:#00f5ff;">Bivariate Map</div>
            <div style="display:flex;align-items:flex-end;gap:8px;">
                <div style="writing-mode:vertical-rl;transform:rotate(180deg);font-size:11px;color:#9bd;">${_labelFor(_keyY)} →</div>
                ${grid}
            </div>
            <div style="text-align:center;font-size:11px;color:#9bd;margin:4px 0 10px 22px;">${_labelFor(_keyX)} →</div>
            <label style="display:block;margin-bottom:4px;">X &nbsp;<select id="biv-x" style="background:#0a0e27;color:#cfe;border:1px solid #245;border-radius:4px;">${opts}</select></label>
            <label style="display:block;">Y &nbsp;<select id="biv-y" style="background:#0a0e27;color:#cfe;border:1px solid #245;border-radius:4px;">${opts}</select></label>`;
        el.querySelector('#biv-x').value = _keyX;
        el.querySelector('#biv-y').value = _keyY;
        el.querySelector('#biv-x').onchange = (e) => { _keyX = e.target.value; _renderLegend(); _restart(); };
        el.querySelector('#biv-y').onchange = (e) => { _keyY = e.target.value; _renderLegend(); _restart(); };
    }

    function _removeLegend() {
        const el = document.getElementById(LEGEND_ID);
        if (el) el.remove();
    }

    function _restart() {
        if (_abort) { _abort.abort(); _abort = null; }
        if (_map.getSource(SOURCE_ID)) _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
        _sample();
    }

    function attach() {
        if (typeof MapModule === 'undefined') return;
        _map = MapModule.getMap();
        if (!_map) return;
        _active = true;
        _ensureLayer();
        _renderLegend();
        _sample();
    }

    function detach() {
        _active = false;
        if (_abort) { _abort.abort(); _abort = null; }
        _features = [];
        _removeLegend();
        if (_map) {
            if (_map.getLayer(LAYER_ID)) _map.removeLayer(LAYER_ID);
            if (_map.getSource(SOURCE_ID)) _map.removeSource(SOURCE_ID);
        }
    }

    function toggle() { if (_active) detach(); else attach(); }

    return { attach, detach, toggle, classify, getScoreOptions: () => SCORE_OPTIONS.slice() };
})();

if (typeof window !== 'undefined') window.BivariateOverlay = BivariateOverlay;
