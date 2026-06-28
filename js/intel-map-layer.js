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

    /** Clear both heatmap and routes. */
    function clear() {
        if (typeof MapModule !== 'undefined' && MapModule.clearHeatmap) { try { MapModule.clearHeatmap(); } catch { /* */ } }
        const map = _map();
        if (map) { try { if (map.getSource(ROUTE_SRC)) map.getSource(ROUTE_SRC).setData({ type: 'FeatureCollection', features: [] }); } catch { /* */ } }
    }

    return { paintCells, paintRoutes, clear };
})();

if (typeof window !== 'undefined') window.IntelMapLayer = IntelMapLayer;
