/**
 * Text2MapResultsLayer — paint the Text2Map answer ON the map.
 *
 * Closes the "ask a question → get a map" loop: when Text2Map ranks the grid,
 * this draws the top-N DIGIPIN cells as a highlight layer (cell rectangles,
 * graded by rank, with the #1 match emphasised) and frames them in view — so
 * the answer is a map, not just a list. Clicking a cell flies to it.
 *
 * Mirrors the established source+layer+clear pattern (score-choropleth.js /
 * overture-buildings.js): an add-once guard on the source, idempotent
 * attach/detach via clear(), theme-aware paint read at show() time (a theme
 * switch reloads the page, so init-time colours are sufficient). Cell geometry
 * comes from DigiPin.decode(code).bounds; results without a decodable code fall
 * back to a small square around their centre so live (off-grid) scans still
 * render.
 */
const Text2MapResultsLayer = (() => {
    const SOURCE_ID = 't2m-results-src';
    const FILL_LAYER = 't2m-results-fill';
    const LINE_LAYER = 't2m-results-line';
    const TOP_LAYER = 't2m-results-top';   // emphasised outline for the #1 match

    let _map = null;
    let _active = false;
    let _handlersBound = false;   // delegated layer handlers are bound once

    /** Theme palette with a safe fallback when Theme is unavailable (tests). */
    function _pal() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', success: '#22c55e',
            warn: '#eab308', danger: '#ef4444' };
    }

    /** A closed rectangle ring for a cell's bounds {south,north,west,east}. */
    function _ring(b) {
        return [[
            [b.west, b.south], [b.east, b.south],
            [b.east, b.north], [b.west, b.north], [b.west, b.south],
        ]];
    }

    /** True when a bounds object has all four finite edges. */
    function _validBounds(b) {
        return b && ['south', 'north', 'west', 'east'].every(k => Number.isFinite(b[k]));
    }

    /** Bounds for one result: explicit bounds, the true DIGIPIN cell, or a square.
     *  Precomputed lookups return region-level codes (e.g. 6-char), which
     *  DigiPin.decode() rejects (it requires 10 chars) — so we fall back to
     *  decodePartial() before the lat/lng square, otherwise every precomputed
     *  result would shrink to the same ~90 m footprint. */
    function _boundsFor(r) {
        if (!r) return null;
        if (_validBounds(r.bounds)) return r.bounds;          // carried by the caller
        if (r.code && typeof DigiPin !== 'undefined') {
            try {
                const d = DigiPin.decode && DigiPin.decode(r.code);   // full 10-char cell
                if (d && d.bounds) return d.bounds;
            } catch { /* not a full code — try a partial/region decode */ }
            try {
                const d = DigiPin.decodePartial && DigiPin.decodePartial(r.code);
                if (d && _validBounds(d.bounds)) return d.bounds;
            } catch { /* not decodable — fall through to the square */ }
        }
        if (typeof r.lat === 'number' && typeof r.lng === 'number') {
            const e = 0.0008; // ~90m half-side, a sensible cell-ish footprint
            return { south: r.lat - e, north: r.lat + e, west: r.lng - e, east: r.lng + e };
        }
        return null;
    }

    /** Build a FeatureCollection of ranked cells + the overall extent. */
    function _toGeoJSON(results) {
        const features = [];
        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;

        results.forEach((r, i) => {
            const b = _boundsFor(r);
            if (!b) return;
            features.push({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: _ring(b) },
                properties: {
                    rank: i + 1,
                    score: typeof r.score === 'number' ? r.score : 0,
                    code: r.code || '',
                },
            });
            minLat = Math.min(minLat, b.south); maxLat = Math.max(maxLat, b.north);
            minLng = Math.min(minLng, b.west);  maxLng = Math.max(maxLng, b.east);
        });

        const extent = features.length
            ? [[minLng, minLat], [maxLng, maxLat]]
            : null;
        return { fc: { type: 'FeatureCollection', features }, extent };
    }

    /** Remove the layers + source. Idempotent. */
    function clear() {
        if (_map) {
            [TOP_LAYER, LINE_LAYER, FILL_LAYER].forEach(id => {
                if (_map.getLayer(id)) _map.removeLayer(id);
            });
            if (_map.getSource(SOURCE_ID)) _map.removeSource(SOURCE_ID);
        }
        _active = false;
    }

    /**
     * Paint the ranked results on the map and frame them. Returns the number of
     * cells drawn (0 = nothing renderable, layer left cleared).
     */
    function show(results) {
        if (typeof MapModule === 'undefined' || !MapModule.getMap) return 0;
        _map = MapModule.getMap();
        if (!_map || !Array.isArray(results)) return 0;

        clear();

        const { fc, extent } = _toGeoJSON(results);
        if (!fc.features.length) return 0;

        const pal = _pal();

        _map.addSource(SOURCE_ID, { type: 'geojson', data: fc });

        // Fill: graded by score (red→amber→green), brightest for the top ranks.
        _map.addLayer({
            id: FILL_LAYER,
            type: 'fill',
            source: SOURCE_ID,
            paint: {
                'fill-color': [
                    'step', ['get', 'score'],
                    pal.danger, 40, pal.warn, 70, pal.success,
                ],
                'fill-opacity': [
                    'interpolate', ['linear'], ['get', 'rank'],
                    1, 0.55, 8, 0.22,
                ],
            },
        });

        // Hairline outline on every match.
        _map.addLayer({
            id: LINE_LAYER,
            type: 'line',
            source: SOURCE_ID,
            paint: { 'line-color': pal.ink, 'line-width': 1, 'line-opacity': 0.5 },
        });

        // Emphasised accent outline on the #1 match.
        _map.addLayer({
            id: TOP_LAYER,
            type: 'line',
            source: SOURCE_ID,
            filter: ['==', ['get', 'rank'], 1],
            paint: { 'line-color': pal.primary, 'line-width': 3 },
        });

        // Click a cell → fly to it (mirrors the result-card row behaviour).
        // Bind the delegated handlers ONCE: removeLayer() in clear() does not
        // detach map.on(type, layerId, fn) listeners and map.on doesn't dedupe,
        // so re-binding on every show() would stack a copy per scan. The layer
        // id is constant and the handlers tolerate the layer being absent.
        if (!_handlersBound) {
            _map.on('click', FILL_LAYER, _onClick);
            _map.on('mouseenter', FILL_LAYER, _onEnter);
            _map.on('mouseleave', FILL_LAYER, _onLeave);
            _handlersBound = true;
        }

        if (extent && _map.fitBounds) {
            try {
                _map.fitBounds(extent, { padding: 64, maxZoom: 16, duration: 1200 });
            } catch { /* degenerate extent — leave the view as-is */ }
        }

        _active = true;
        return fc.features.length;
    }

    /** Click handler: fly to the centre of the clicked result cell. */
    function _onClick(e) {
        const f = e.features && e.features[0];
        if (!f || typeof MapModule === 'undefined' || !MapModule.flyTo) return;
        const c = f.geometry.coordinates[0];
        // ring is [SW, SE, NE, NW, SW] → centre = midpoint of SW and NE
        const lng = (c[0][0] + c[2][0]) / 2;
        const lat = (c[0][1] + c[2][1]) / 2;
        MapModule.flyTo(lat, lng, 17);
    }

    /** Hover-enter handler: show the pointer cursor over result cells. */
    function _onEnter() { if (_map) _map.getCanvas().style.cursor = 'pointer'; }
    /** Hover-leave handler: restore the default cursor. */
    function _onLeave() { if (_map) _map.getCanvas().style.cursor = ''; }

    /** True while result cells are drawn on the map. */
    function isActive() { return _active; }

    return { show, clear, isActive, _toGeoJSON };
})();

if (typeof window !== 'undefined') {
    window.Text2MapResultsLayer = Text2MapResultsLayer;
}
