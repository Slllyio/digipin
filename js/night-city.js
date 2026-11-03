/**
 * NightCity — the 3D city after dark: lit windows, glowing streets, dark ground.
 *
 * When the sun study's hour puts the sun more than 4° under the horizon (or the
 * Night button on the 3D shot bar is pressed, which jumps the study to 20:30),
 * the twin buildings take a window texture (fill-extrusion-pattern) in one of
 * three seeded variants so neighbours differ, a thin dark slab caps each roof
 * (patterns would otherwise tile windows across the roofs), the basemap dims
 * under a navy veil and the roads glow amber above it. Buildings coloured by a
 * dataset keep their colours; only the veil and streets change. Proposals from
 * MassingSketch stay terracotta so they read as new.
 *
 * strength()/windowImage()/patternExpr() are pure (unit-tested); apply()/clear()
 * touch the map. SunShadows.apply/clear call apply/clear on every sun change.
 */
const NightCity = (() => {
    const TWIN = 'overture-twin-layer';
    const TWIN_SRC = 'overture-twin-source';
    const ROOFS = 'night-roofs-layer';
    const VEIL = 'night-veil-layer';
    const VEIL_SRC = 'night-veil-src';
    const GLOW = 'night-roads-glow';
    const ON_BELOW = -4;            // solar altitude (°) under which windows light up
    const VARIANTS = 3;
    const SIZE = 32;                // pattern tile (px): 4 × 4 windows

    /** Night strength 0..1 from solar altitude: 0 above the horizon, 1 by −8°. Pure. */
    function strength(altitude) {
        if (!(altitude < 0)) return 0;
        return Math.min(1, -altitude / 8);
    }

    /**
     * RGBA window tile for variant k (0..2): k sets the share of lit windows
     * (about a third, half, two thirds) and the warm/cool mix. Pure.
     */
    function windowImage(k, wall = [34, 40, 58]) {
        const d = new Uint8Array(SIZE * SIZE * 4);
        const litShare = [0.32, 0.5, 0.68][k % VARIANTS];
        let seed = 7919 * (k + 1);
        const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
        const cells = [];
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
            const lit = rnd() < litShare;
            const cool = rnd() < (k === 2 ? 0.5 : 0.15);        // variant 2 reads as offices
            const dim = 0.72 + 0.28 * rnd();
            const col = !lit ? [52, 60, 82] : (cool ? [205, 226, 255] : [255, 207, 122]);
            cells.push(lit ? col.map(v => Math.round(v * dim)) : col);
        }
        for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
            const cx = x % 8, cy = y % 8;
            const win = cx >= 2 && cx <= 5 && cy >= 2 && cy <= 6;
            const c = win ? cells[Math.floor(y / 8) * 4 + Math.floor(x / 8)] : wall;
            d.set([c[0], c[1], c[2], 255], (y * SIZE + x) * 4);
        }
        return { width: SIZE, height: SIZE, data: d };
    }

    /** Pattern expression picking a stable variant per building from its footprint area. Pure. */
    function patternExpr() {
        return ['match', ['%', ['floor', ['*', ['coalesce', ['get', 'area'], ['get', 'rh'], 7], 7.31]], VARIANTS],
            0, 'night-win-0', 1, 'night-win-1', 'night-win-2'];
    }

    let _on = false, _map = null, _treeColor = null;
    const TREES = 'trees3d-layer';

    /** Trees go dark at night (they would glow pale green otherwise). */
    function _trees(map, night) {
        if (!map.getLayer(TREES)) return;
        try {
            if (night && _treeColor == null) {
                _treeColor = map.getPaintProperty(TREES, 'fill-extrusion-color') || null;
                map.setPaintProperty(TREES, 'fill-extrusion-color', ['case', ['==', ['get', 'part'], 'trunk'], '#1a2026', '#1d3a2c']);
            } else if (!night && _treeColor != null) {
                map.setPaintProperty(TREES, 'fill-extrusion-color', _treeColor);
                _treeColor = null;
            }
        } catch { /* layer reloading */ }
    }

    function _theme() {
        return (typeof Theme !== 'undefined' && Theme.get && Theme.get() === 'dark') ? 'dark' : 'light';
    }
    function _dataDriven() {
        return typeof BuildingData !== 'undefined' && BuildingData.isActive && BuildingData.isActive();
    }

    /** The first layer above the basemap's roads and flat buildings: the veil and glow go just under it. */
    function _aboveRoads(map) {
        const layers = (map.getStyle() && map.getStyle().layers) || [];
        let last = -1;
        layers.forEach((l, i) => { if (l.type !== 'symbol' && (l['source-layer'] === 'buildings' || l['source-layer'] === 'roads')) last = i; });
        const next = last >= 0 ? layers[last + 1] : layers.find(l => l.type === 'symbol');
        return next ? next.id : undefined;
    }

    function _roadSource(map) {
        const layers = (map.getStyle() && map.getStyle().layers) || [];
        const r = layers.find(l => l.type === 'line' && l['source-layer'] === 'roads' && /^road_/.test(l.id));
        return r ? r.source : null;
    }

    function _ensure(map, k) {
        const dark = _theme() === 'dark';
        for (let i = 0; i < VARIANTS; i++) {
            const id = `night-win-${i}`;
            if (map.hasImage(id)) map.removeImage(id);
            map.addImage(id, windowImage(i, dark ? [14, 20, 36] : [34, 40, 58]));
        }
        const before = _aboveRoads(map);
        if (!map.getSource(VEIL_SRC)) {
            map.addSource(VEIL_SRC, { type: 'geojson', data: { type: 'Feature', properties: {},
                geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } });
        }
        if (!map.getLayer(VEIL)) map.addLayer({ id: VEIL, type: 'fill', source: VEIL_SRC, paint: { 'fill-color': '#0d1426', 'fill-opacity': 0 } }, before);
        map.setPaintProperty(VEIL, 'fill-opacity', (dark ? 0.45 : 0.72) * k);
        const roads = _roadSource(map);
        if (roads && !map.getLayer(GLOW)) {
            map.addLayer({ id: GLOW, type: 'line', source: roads, 'source-layer': 'roads', minzoom: 12,
                filter: ['!=', ['get', 'kind'], 'rail'],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-color': '#ffb85c', 'line-blur': 2,
                    'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 0.6, 16, 3.5, 19, 14],
                    'line-opacity': 0 } }, before);
        }
        if (map.getLayer(GLOW)) map.setPaintProperty(GLOW, 'line-opacity', 0.55 * k);
    }

    function _windows(map, show) {
        if (!map.getLayer(TWIN)) return;
        const want = show && !_dataDriven();
        try { map.setPaintProperty(TWIN, 'fill-extrusion-pattern', want ? patternExpr() : undefined); } catch { /* old MapLibre */ }
        const lite = typeof Quality3D !== 'undefined' && Quality3D.get && Quality3D.get().tier === 'lite';
        if (want && !lite && map.getSource(TWIN_SRC) && !map.getLayer(ROOFS)) {
            map.addLayer({ id: ROOFS, type: 'fill-extrusion', source: TWIN_SRC, paint: {
                'fill-extrusion-color': _theme() === 'dark' ? '#101828' : '#2b3246',
                'fill-extrusion-base': ['get', 'h'], 'fill-extrusion-height': ['+', ['get', 'h'], 0.4],
                'fill-extrusion-opacity': 1 } });
        } else if ((!want || lite) && map.getLayer(ROOFS)) {
            map.removeLayer(ROOFS);
        }
    }

    /** Called by SunShadows with every sun change. */
    function apply(map, altitude) {
        if (!map) return;
        _map = map;
        const k = strength(altitude);
        const on = altitude < ON_BELOW;
        try {
            if (k > 0) _ensure(map, k);
            else _remove(map);
            _windows(map, on);
            _trees(map, on);
            // Lit windows glow on their own; a flat white light keeps the texture bright.
            if (on && map.setLight) {
                map.setLight({ anchor: 'map', color: '#ffffff', intensity: 0.18, position: [1.5, 200, 40] });
            }
        } catch { /* style reloading */ }
        _on = on;
        _sync();
    }

    function _remove(map) {
        for (const id of [ROOFS, GLOW, VEIL]) { try { if (map.getLayer(id)) map.removeLayer(id); } catch { /* gone */ } }
        try { if (map.getSource(VEIL_SRC)) map.removeSource(VEIL_SRC); } catch { /* gone */ }
    }

    /** Back to daytime (sun study closed). */
    function clear(map) {
        map = map || _map;
        _on = false;
        if (map) {
            try { _windows(map, false); _trees(map, false); _remove(map); } catch { /* style reloading */ }
        }
        _sync();
    }

    function isOn() { return _on; }

    // Night button on the 3D shot bar ------------------------------------------
    let _btn = null, _before = null;
    function _sync() {
        if (!_btn) return;
        _btn.classList.toggle('active', _on);
        _btn.setAttribute('aria-pressed', _on ? 'true' : 'false');
    }

    function toggle() {
        if (typeof SunStudy === 'undefined' || !SunStudy.setState) return;
        if (!_on) {
            _before = SunStudy.isActive && SunStudy.isActive() ? SunStudy.getState() : 'closed';
            const date = (_before && _before.date) || new Date().toISOString().slice(0, 10);
            SunStudy.setState({ date, min: 20 * 60 + 30 });
        } else if (_before === 'closed' || !_before) {
            if (SunStudy.isActive && SunStudy.isActive() && SunStudy.toggle) SunStudy.toggle();
            else clear();
            _before = null;
        } else {
            SunStudy.setState(_before.min >= 18 * 60 || _before.min < 6 * 60 ? { date: _before.date, min: 12 * 60 } : _before);
            _before = null;
        }
    }

    /** Mount the Night button into the 3D shot bar (CameraPresets calls this). */
    function mount(bar) {
        if (!bar || typeof document === 'undefined') return;
        _btn = document.createElement('button');
        _btn.type = 'button';
        _btn.className = 'cp-btn cp-night';
        _btn.dataset.act = 'night';
        _btn.title = 'Night view: lit windows and street lights (sets the sun study to 20:30)';
        _btn.setAttribute('aria-pressed', 'false');
        _btn.innerHTML = '<span class="cp-ico" aria-hidden="true">☾</span><span class="cp-label">Night</span>';
        _btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
        bar.appendChild(_btn);
        _sync();
    }

    return { apply, clear, isOn, toggle, mount, strength, windowImage, patternExpr, ON_BELOW, ROOFS, VEIL, GLOW };
})();

if (typeof window !== 'undefined') {
    window.NightCity = NightCity;
}
