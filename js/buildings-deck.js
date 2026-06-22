/**
 * DeckBuildings — deck.gl WebGL "digital twin" building layer (dark theme)
 *
 * MapLibre's `fill-extrusion` can only draw flat-shaded boxes; it has no edge
 * stroke, so it can't reproduce the Esri SceneView look of translucent cyan
 * glass volumes with glowing wireframe edges. deck.gl's PolygonLayer *can*
 * (`extruded + wireframe`), so when deck.gl is present we overlay it on the
 * MapLibre canvas via MapboxOverlay (which keeps the camera in sync) and feed
 * it the Overture building geometry already loaded by MapLibre's PMTiles source
 * (harvested with queryRenderedFeatures, refreshed on moveend).
 *
 * This module is OPTIONAL: OvertureBuildings falls back to its MapLibre
 * fill-extrusion rendering when deck.gl isn't available. The pure data helpers
 * (featureHeight / featuresToPolygons / ringPaths) are unit-tested; the GL
 * rendering itself is verified in a headless browser.
 */

const DeckBuildings = (() => {
    // The MapLibre layer whose rendered features we harvest for geometry.
    const SRC_LAYER_ID = 'overture-buildings-layer';
    const RING_RADII = [150, 300, 460];
    const HIGHLIGHT_RADIUS_M = 220;

    let _map = null;
    let _overlay = null;
    let _enabled = false;
    let _focus = null;          // {lat,lng} of the focused DIGIPIN cell
    let _data = [];             // harvested deck polygon records
    let _moveBound = false;

    /** True when deck.gl (with the pieces we use) is loaded. */
    function available() {
        return typeof deck !== 'undefined'
            && !!deck.MapboxOverlay && !!deck.PolygonLayer && !!deck.PathLayer;
    }

    // ---- pure helpers (unit-tested) ---------------------------------------
    /** Great-circle distance between two {lat,lng} points, in metres. */
    function _haversineM(a, b) {
        const R = 6371000, toR = Math.PI / 180;
        const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
        const s = Math.sin(dLat / 2) ** 2
            + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    }
    /** Building height (m) from Overture props — mirrors OvertureBuildings. */
    function featureHeight(props) {
        const p = props || {};
        if (p.height != null && isFinite(+p.height)) return Math.max(3, +p.height);
        if (p.num_floors != null && isFinite(+p.num_floors)) return (+p.num_floors) * 3.6;
        if (p.class === 'commercial') return 35;
        if (p.class === 'industrial') return 25;
        if (p.class === 'residential') return 12;
        return 12;
    }
    /**
     * Convert MapLibre rendered building features into deck polygon records
     * (outer ring + height), de-duped by centroid and tagged `sel` when within
     * `radiusM` of the focus centre. Pure.
     */
    function featuresToPolygons(features, focus, radiusM = HIGHLIGHT_RADIUS_M) {
        const out = [];
        const seen = new Set();
        for (const f of (features || [])) {
            const g = f && f.geometry;
            if (!g) continue;
            const polys = g.type === 'Polygon' ? [g.coordinates]
                : g.type === 'MultiPolygon' ? g.coordinates : [];
            for (const poly of polys) {
                const outer = poly && poly[0];
                if (!outer || outer.length < 4) continue;
                let lng = 0, lat = 0;
                for (const c of outer) { lng += c[0]; lat += c[1]; }
                const cx = lng / outer.length, cy = lat / outer.length;
                const key = `${cx.toFixed(6)},${cy.toFixed(6)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const sel = !!focus && _haversineM(focus, { lng: cx, lat: cy }) <= radiusM;
                out.push({ polygon: outer, height: featureHeight(f.properties), sel });
            }
        }
        return out;
    }
    /** Concentric range-ring paths ([{path:[[lng,lat]…]}]) around a centre. Pure. */
    function ringPaths(center, radii = RING_RADII) {
        if (!center) return [];
        const latR0 = 1 / 111320;
        const lngR0 = 1 / (111320 * Math.cos(center.lat * Math.PI / 180) || 1);
        return radii.map(r => {
            const path = [];
            for (let k = 0; k <= 72; k++) {
                const t = (2 * Math.PI * k) / 72;
                path.push([center.lng + r * lngR0 * Math.cos(t), center.lat + r * latR0 * Math.sin(t)]);
            }
            return { path, radius: r };
        });
    }

    // ---- styling (validated against the reference in a headless browser) ---
    /** Cyan-glass fill ramped by height; amber for the focused selection. */
    function _fill(d) {
        if (d.sel) return [255, 150, 40, 225];
        const t = Math.min(1, d.height / 170);
        return [10 + t * 40, 90 + t * 120, 120 + t * 120, 95];
    }
    /** Bright wireframe edges; warm amber on the selection. */
    function _line(d) {
        return d.sel ? [255, 205, 110, 255] : [120, 242, 255, 235];
    }

    /** Build the deck layer stack for the current data + focus. */
    function _layers() {
        const layers = [];
        if (_focus) {
            layers.push(new deck.PathLayer({
                id: 'deck-rings',
                data: ringPaths(_focus),
                getPath: d => d.path,
                getColor: [143, 233, 255, 150],
                widthUnits: 'pixels',
                getWidth: 1.2,
                jointRounded: true
            }));
        }
        layers.push(new deck.PolygonLayer({
            id: 'deck-buildings',
            data: _data,
            extruded: true,
            wireframe: true,
            filled: true,
            getPolygon: d => d.polygon,
            getElevation: d => d.height,
            getFillColor: _fill,
            getLineColor: _line,
            lineWidthUnits: 'pixels',
            getLineWidth: 1.2,
            material: { ambient: 0.5, diffuse: 0.55, shininess: 64, specularColor: [140, 225, 255] },
            opacity: 1,
            updateTriggers: { getFillColor: [_focusKey()], getLineColor: [_focusKey()] }
        }));
        return layers;
    }
    function _focusKey() { return _focus ? `${_focus.lat.toFixed(5)},${_focus.lng.toFixed(5)}` : 'none'; }

    /** Re-harvest the rendered buildings and push fresh layers to the overlay. */
    function refresh() {
        if (!_enabled || !_map || !_overlay) return;
        let feats = [];
        try { feats = _map.queryRenderedFeatures({ layers: [SRC_LAYER_ID] }) || []; }
        catch { /* layer not rendered yet */ }
        _data = featuresToPolygons(feats, _focus, HIGHLIGHT_RADIUS_M);
        _overlay.setProps({ layers: _layers() });
    }

    /** Attach the deck overlay to the map. Returns false if deck is unavailable. */
    function enable(map, getFocus) {
        if (!available() || !map) return false;
        _map = map;
        _enabled = true;
        if (typeof getFocus === 'function') {
            const f = getFocus();
            _focus = (f && isFinite(f.lat) && isFinite(f.lng)) ? { lat: f.lat, lng: f.lng } : _focus;
        }
        _overlay = new deck.MapboxOverlay({ interleaved: false, layers: [] });
        map.addControl(_overlay);
        if (!_moveBound) { map.on('moveend', refresh); _moveBound = true; }
        refresh();
        return true;
    }

    /** Detach the overlay (overlay off / theme change). */
    function disable(map) {
        _enabled = false;
        const m = map || _map;
        if (_overlay && m) { try { m.removeControl(_overlay); } catch { /* already gone */ } }
        _overlay = null;
        _data = [];
    }

    /** Focus on a DIGIPIN cell centre — redraws rings + amber selection. */
    function setFocus(center) {
        _focus = (center && isFinite(center.lat) && isFinite(center.lng))
            ? { lat: center.lat, lng: center.lng } : null;
        if (_enabled) refresh();
    }

    /** True while the deck overlay is attached. */
    function isEnabled() { return _enabled; }

    return { available, enable, disable, setFocus, refresh, isEnabled,
        featureHeight, featuresToPolygons, ringPaths };
})();

if (typeof window !== 'undefined') window.DeckBuildings = DeckBuildings;
