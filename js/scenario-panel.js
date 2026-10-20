/**
 * ScenarioPanel — interactive "what-if" planner on top of the CA-ML growth
 * prediction. Samples the viewport (like CAGrowthOverlay), applies a transparent
 * ScenarioModel lens to each cell's base probability, recolours the cells, and
 * shows the aggregate delta (cells gained/lost vs the baseline, mean shift).
 *
 * Honest framing: an illustrative lens on the base model, not a re-trained run
 * (that needs the offline pipeline). Reuses CAGrowthOverlay.colorFor/cellFeature
 * for rendering. See docs/CA_GROWTH_MODEL.md.
 */
const ScenarioPanel = (() => {
    const SOURCE_ID = 'scenario-src';
    const LAYER_ID  = 'scenario-fill';
    const PANEL_ID  = 'scenario-control';
    const GRID_SIZE = 5;
    const SAMPLE_RADIUS_M = 400;

    let _active = false;
    let _map = null;
    let _scenario = 'baseline';
    let _anchor = null;            // {lat,lng} for transit_hub
    let _awaitingAnchor = false;
    let _features = [];
    let _abort = null;

    function _haversineKm(aLat, aLng, bLat, bLng) {
        const R = 6371, toR = Math.PI / 180;
        const dLat = (bLat - aLat) * toR, dLng = (bLng - aLng) * toR;
        const h = Math.sin(dLat / 2) ** 2
            + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    /** Per-cell context for ScenarioModel from a fetched result. */
    function _ctx(result, pt) {
        const prob = (typeof CAGrowthOverlay !== 'undefined') ? CAGrowthOverlay.probOf(result) : null;
        const floodRisk = result && result.scores && result.scores.flood_risk
            && Number(result.scores.flood_risk.value);
        const roadDensity = result && result.realtime && result.realtime.traffic
            && Number(result.realtime.traffic.road_density_m);
        const anchorKm = _anchor ? _haversineKm(pt.lat, pt.lng, _anchor.lat, _anchor.lng) : null;
        return {
            prob,
            floodRisk: Number.isFinite(floodRisk) ? floodRisk : null,
            roadDensity: Number.isFinite(roadDensity) ? roadDensity : null,
            anchorKm,
        };
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

    /** Sample the viewport, apply the scenario lens, recolour cells, update readout. */
    async function refresh() {
        _map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!_map || typeof DataFetcher === 'undefined' || typeof ScenarioModel === 'undefined') return;
        if (_abort) _abort.abort();
        _abort = new AbortController();
        const signal = _abort.signal;
        _features = [];
        _ensureLayer();
        _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });

        const b = _map.getBounds();
        const latStep = (b.getNorth() - b.getSouth()) / GRID_SIZE;
        const lngStep = (b.getEast() - b.getWest()) / GRID_SIZE;
        const points = [];
        for (let i = 0; i < GRID_SIZE; i++) {
            for (let j = 0; j < GRID_SIZE; j++) {
                points.push({ lat: b.getSouth() + latStep * (i + 0.5),
                    lng: b.getWest() + lngStep * (j + 0.5), latStep, lngStep });
            }
        }

        const pairs = [];
        for (let k = 0; k < points.length; k += 6) {
            if (signal.aborted) return;
            const chunk = points.slice(k, k + 6);
            const results = await Promise.allSettled(
                chunk.map(pt => DataFetcher.fetchAllFeatures(pt.lat, pt.lng, SAMPLE_RADIUS_M)));
            results.forEach((r, idx) => {
                if (r.status !== 'fulfilled' || signal.aborted) return;
                const ctx = _ctx(r.value, chunk[idx]);
                if (ctx.prob == null) return;
                const { prob } = ScenarioModel.adjust(_scenario, ctx);
                pairs.push({ base: ctx.prob, scen: prob });
                if (typeof CAGrowthOverlay !== 'undefined') {
                    _features.push(CAGrowthOverlay.cellFeature(chunk[idx], prob));
                }
            });
            if (!signal.aborted && _map.getSource(SOURCE_ID)) {
                _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: _features });
            }
            if (k + 6 < points.length) await new Promise(res => setTimeout(res, 200));
        }
        if (!signal.aborted) _renderReadout(ScenarioModel.summarize(pairs));
    }

    /** Update the delta readout line in the control panel. */
    function _renderReadout(summary) {
        const el = document.getElementById('scenario-readout');
        if (!el) return;
        if (_scenario === 'baseline') {
            el.textContent = `${summary.n} cells · baseline (no change)`;
            return;
        }
        el.textContent = `${summary.n} cells · +${summary.gained} now likely · −${summary.lost} no longer · mean Δ ${summary.meanDelta > 0 ? '+' : ''}${summary.meanDelta}`;
    }

    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8',
            surface: 'rgba(10,14,39,0.92)', border: 'rgba(255,255,255,0.12)' };
    }

    /** Build the floating scenario control (selector + anchor hint + readout). */
    function _renderControl() {
        let el = document.getElementById(PANEL_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = PANEL_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'Growth scenario planner');
            document.body.appendChild(el);
        }
        const pal = _palette();
        el.style.cssText = `position:absolute;top:84px;right:16px;z-index:6;max-width:260px;`
            + `background:${pal.surface};border:1px solid ${pal.border};border-radius:10px;`
            + `padding:12px 14px;color:${pal.ink};font:12px/1.4 system-ui,sans-serif;`
            + 'box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);';
        const opts = ScenarioModel.SCENARIOS.map(s =>
            `<option value="${s.id}"${s.id === _scenario ? ' selected' : ''}>${s.label}</option>`).join('');
        el.innerHTML = `<div style="font-weight:600;font-size:14px;margin-bottom:8px;color:${pal.primary};">Growth scenario — what-if</div>`
            + `<label class="sr-only" for="scenario-select">Scenario</label>`
            + `<select id="scenario-select" style="width:100%;padding:6px;border-radius:6px;background:transparent;color:inherit;border:1px solid ${pal.border};">${opts}</select>`
            + `<div id="scenario-anchor" style="margin-top:6px;color:${pal.sub};font-size:11px;"></div>`
            + `<div id="scenario-readout" style="margin-top:8px;font-size:12px;">Sampling…</div>`
            + `<div style="margin-top:8px;color:${pal.sub};font-size:10px;">Illustrative lens on the CA-ML base — not a re-trained run.</div>`;

        const sel = el.querySelector('#scenario-select');
        sel.addEventListener('change', () => {
            _scenario = sel.value;
            const meta = ScenarioModel.SCENARIOS.find(s => s.id === _scenario);
            if (meta && meta.needsAnchor && !_anchor) { _promptAnchor(); }
            else { refresh(); }
            _updateAnchorHint();
        });
        _updateAnchorHint();
    }

    function _updateAnchorHint() {
        const hint = document.getElementById('scenario-anchor');
        if (!hint) return;
        const meta = ScenarioModel.SCENARIOS.find(s => s.id === _scenario);
        if (meta && meta.needsAnchor) {
            hint.textContent = _anchor
                ? `Hub at ${_anchor.lat.toFixed(3)}, ${_anchor.lng.toFixed(3)} — click map to move`
                : 'Click the map to place the hub';
            hint.style.cursor = 'default';
        } else {
            hint.textContent = '';
        }
    }

    /** Wait for one map click to set the transit-hub anchor, then refresh. */
    function _promptAnchor() {
        if (!_map) return;
        _awaitingAnchor = true;
        _updateAnchorHint();
        if (typeof App !== 'undefined') App.showToast('Scenario', 'Click the map to place the transit hub.', 'info');
        _map.once('click', (e) => {
            if (!_awaitingAnchor) return;
            _awaitingAnchor = false;
            _anchor = { lat: e.lngLat.lat, lng: e.lngLat.lng };
            _updateAnchorHint();
            refresh();
        });
    }

    function attach() { _active = true; _renderControl(); refresh(); }
    function detach() {
        _active = false;
        _awaitingAnchor = false;
        if (_abort) { _abort.abort(); _abort = null; }
        const el = document.getElementById(PANEL_ID);
        if (el) el.remove();
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!map) return;
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }
    function toggle() { if (_active) detach(); else attach(); }
    function isVisible() { return _active; }

    return { attach, detach, toggle, isVisible, refresh };
})();

if (typeof window !== 'undefined') window.ScenarioPanel = ScenarioPanel;
