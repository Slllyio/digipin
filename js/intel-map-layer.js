/**
 * IntelMapLayer — the render target for agent results. When the user asks to
 * "show / map / highlight" something, the agent paints DigiPin cells (graded by
 * the relevant value) or routes onto the live map through here. Pure-analysis
 * questions skip it.
 *
 * Cells reuse MapModule's existing heatmap source (already styled); routes use a
 * dedicated line layer added lazily to the map. All methods are browser-only and
 * no-op safely when the map isn't present (e.g. tests).
 *
 *   IntelMapLayer.paintCells([{ lat, lng, score, code }])
 *   IntelMapLayer.paintRoutes(geojsonLineStrings)
 *   IntelMapLayer.clear()
 */
const IntelMapLayer = (() => {
    const ROUTE_SRC = 'intel-routes';
    const CHORO_SRC = 'intel-choro';
    const CHORO_FILL = 'intel-choro-fill';

    function _map() {
        return (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
    }

    /** Paint a set of cells as a graded heatmap (reuses MapModule.showHeatmap). */
    function paintCells(cells) {
        if (typeof MapModule === 'undefined' || !MapModule.showHeatmap) return false;
        const results = (cells || [])
            .map((c, i) => {
                const ctr = c.center || {};
                const lat = c.lat != null ? c.lat : ctr.lat;
                const lng = c.lng != null ? c.lng : ctr.lng;
                if (lat == null || lng == null) return null;
                const score = c.score != null ? c.score : (c.value != null ? c.value : c.exposure);
                return { lat, lng, code: c.code, score: score != null ? score : (100 - i) };
            })
            .filter(Boolean);
        if (!results.length) return false;
        MapModule.showHeatmap(results);
        return true;
    }

    function _ensureRouteLayer(map) {
        if (map.getSource(ROUTE_SRC)) return;
        map.addSource(ROUTE_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
            id: ROUTE_SRC + '-line', type: 'line', source: ROUTE_SRC,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#ff3b6b', 'line-width': 3, 'line-opacity': 0.85, 'line-dasharray': [2, 1] },
        });
    }

    /** Paint evacuation/route LineStrings. */
    function paintRoutes(geojson) {
        const map = _map();
        if (!map) return false;
        try {
            _ensureRouteLayer(map);
            map.getSource(ROUTE_SRC).setData(geojson || { type: 'FeatureCollection', features: [] });
            return true;
        } catch { return false; }
    }

    function _ensureChoro(map) {
        if (map.getSource(CHORO_SRC)) return;
        map.addSource(CHORO_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
            id: CHORO_FILL, type: 'fill', source: CHORO_SRC,
            paint: { 'fill-color': '#888', 'fill-opacity': 0.55, 'fill-outline-color': 'rgba(0,0,0,0.18)' },
        });
        // click a painted cell → open its brief
        map.on('click', CHORO_FILL, (e) => {
            const code = e.features && e.features[0] && e.features[0].properties.code;
            if (code && typeof MapModule !== 'undefined' && MapModule.selectByCode) MapModule.selectByCode(code);
        });
        map.on('mouseenter', CHORO_FILL, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', CHORO_FILL, () => { map.getCanvas().style.cursor = ''; });
    }

    function _fit(map, cells) {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const c of cells) {
            const b = c.bounds; if (!b || b.north == null) continue;
            w = Math.min(w, b.west); s = Math.min(s, b.south); e = Math.max(e, b.east); n = Math.max(n, b.north);
        }
        if (w === Infinity) return;
        try { map.fitBounds([[w, s], [e, n]], { padding: 60, duration: 800, maxZoom: 15 }); } catch { /* */ }
    }

    function _legend(opts) {
        if (typeof document === 'undefined') return;
        let el = document.getElementById('intel-legend');
        if (!el) {
            el = document.createElement('div');
            el.id = 'intel-legend';
            el.style.cssText = 'position:fixed;left:14px;bottom:30px;z-index:1402;background:rgba(18,22,32,0.92);'
                + 'color:#e8ecf4;border:1px solid #2a3350;border-radius:8px;padding:8px 10px;font:11px system-ui;';
            document.body.appendChild(el);
        }
        const grad = opts.reverse
            ? 'linear-gradient(90deg,#1a9641,#ffffbf,#d7191c)'
            : 'linear-gradient(90deg,#d7191c,#ffffbf,#1a9641)';
        el.textContent = '';
        const t = document.createElement('div'); t.style.cssText = 'font-weight:600;margin-bottom:4px;';
        t.textContent = opts.label || 'Value'; el.appendChild(t);
        const bar = document.createElement('div'); bar.style.cssText = `width:150px;height:8px;border-radius:4px;background:${grad};`; el.appendChild(bar);
        const ticks = document.createElement('div'); ticks.style.cssText = 'display:flex;justify-content:space-between;color:#9fb0c8;margin-top:2px;';
        const a = document.createElement('span'); a.textContent = opts.reverse ? 'low risk' : 'low';
        const b = document.createElement('span'); b.textContent = opts.reverse ? 'high risk' : 'high';
        ticks.appendChild(a); ticks.appendChild(b); el.appendChild(ticks);
    }
    function _removeLegend() {
        const el = (typeof document !== 'undefined') && document.getElementById('intel-legend');
        if (el) el.remove();
    }

    /** Paint every cell as a value-graded DigiPin rectangle (true choropleth),
     *  with a legend + auto-fit + click-to-brief. Falls back to points if a cell
     *  has no bounds. opts: { label, reverse (risk: high=red) }. */
    function paintChoropleth(cells, opts = {}) {
        const map = _map();
        if (!map) return false;
        const polys = (cells || []).filter(c => c.bounds && c.bounds.north != null).map(c => ({
            type: 'Feature',
            properties: { value: Math.round(c.value), code: c.code },
            geometry: { type: 'Polygon', coordinates: [[
                [c.bounds.west, c.bounds.south], [c.bounds.east, c.bounds.south],
                [c.bounds.east, c.bounds.north], [c.bounds.west, c.bounds.north], [c.bounds.west, c.bounds.south],
            ]] },
        }));
        if (!polys.length) return paintCells(cells);   // no bounds → graded points
        try {
            _ensureChoro(map);
            const ramp = opts.reverse
                ? ['interpolate', ['linear'], ['get', 'value'], 0, '#1a9641', 50, '#ffffbf', 100, '#d7191c']
                : ['interpolate', ['linear'], ['get', 'value'], 0, '#d7191c', 50, '#ffffbf', 100, '#1a9641'];
            map.setPaintProperty(CHORO_FILL, 'fill-color', ramp);
            map.getSource(CHORO_SRC).setData({ type: 'FeatureCollection', features: polys });
            _fit(map, cells);
            _legend(opts);
            return true;
        } catch { return false; }
    }

    /** Clear heatmap, routes, choropleth and legend. */
    function clear() {
        if (typeof MapModule !== 'undefined' && MapModule.clearHeatmap) { try { MapModule.clearHeatmap(); } catch { /* */ } }
        const map = _map();
        if (map) {
            const empty = { type: 'FeatureCollection', features: [] };
            try { if (map.getSource(ROUTE_SRC)) map.getSource(ROUTE_SRC).setData(empty); } catch { /* */ }
            try { if (map.getSource(CHORO_SRC)) map.getSource(CHORO_SRC).setData(empty); } catch { /* */ }
        }
        _removeLegend();
    }

    return { paintCells, paintChoropleth, paintRoutes, clear };
})();

if (typeof window !== 'undefined') window.IntelMapLayer = IntelMapLayer;
