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
    const RING_RADII = [150, 300, 450];
    const HIGHLIGHT_RADIUS_M = 220;

    let _map = null;
    let _overlay = null;
    let _enabled = false;
    let _focus = null;          // {lat,lng} of the focused DIGIPIN cell
    let _data = [];             // harvested deck polygon records
    let _moveBound = false;
    let _heightById = null;     // Map<overtureId, metres> of real heights, when loaded

    /**
     * Load a baked per-building height lookup ({ overtureId: metres }) produced
     * from Google Open Buildings 2.5D (see scripts/build_building_heights.py).
     * When present, featuresToPolygons uses these real heights; otherwise it
     * falls back to the footprint-area estimate. Safe to call with a missing
     * file — a 404 just leaves the estimate in place.
     */
    async function loadHeights(url) {
        try {
            const res = await fetch(url, { cache: 'force-cache' });
            if (!res.ok) return false;
            const obj = await res.json();
            _heightById = new Map(Object.entries(obj));
            if (_enabled) refresh();
            return true;
        } catch { return false; }
    }

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
    /** Building height (m) from explicit Overture props, or null when absent. */
    function featureHeight(props) {
        const p = props || {};
        if (p.height != null && isFinite(+p.height)) return Math.max(3, +p.height);
        if (p.num_floors != null && isFinite(+p.num_floors)) return Math.floor(+p.num_floors) * 3.6;
        if (p.class === 'commercial') return 35;
        if (p.class === 'industrial') return 25;
        if (p.class === 'residential') return 12;
        return 12;
    }
    /** Deterministic 0..1 hash of a string (for stable per-building jitter). */
    function _hash01(s) {
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return ((h >>> 0) % 100000) / 100000;
    }
    /** Footprint area (m²) of a lng/lat ring via the planar shoelace formula. */
    function _ringAreaM2(ring, lat0) {
        if (!ring || ring.length < 3) return 0;
        const mLng = 111320 * Math.cos(lat0 * Math.PI / 180), mLat = 111320;
        let a = 0;
        for (let i = 0, n = ring.length; i < n; i++) {
            const p1 = ring[i], p2 = ring[(i + 1) % n];
            a += (p1[0] * mLng) * (p2[1] * mLat) - (p2[0] * mLng) * (p1[1] * mLat);
        }
        return Math.abs(a / 2);
    }
    /**
     * Display height (m) for a building. Uses Overture's real height/num_floors
     * when present; otherwise — the common case for Indian footprints, which
     * carry no height at all — ESTIMATES from footprint area (larger plots tend
     * to be taller) with a stable per-building jitter so the skyline varies
     * instead of rendering as a flat grid of identical boxes. Pure.
     */
    function estimateHeight(props, areaM2, seed) {
        const p = props || {};
        if (p.height != null && isFinite(+p.height)) return Math.max(3, +p.height);
        if (p.num_floors != null && isFinite(+p.num_floors)) return Math.floor(+p.num_floors) * 3.6;
        const base = p.class === 'commercial' ? 16 : p.class === 'industrial' ? 11 : 7;
        const areaPart = 0.72 * Math.sqrt(Math.max(0, areaM2 || 0));   // ~taller for bigger plots
        const jitter = 0.78 + 0.55 * _hash01(seed || '');             // 0.78..1.33, stable per building
        return Math.min(150, Math.max(6, (base + areaPart) * jitter));
    }
    /**
     * Convert MapLibre rendered building features into deck polygon records
     * (outer ring + height), de-duped by centroid and tagged `sel` when within
     * `radiusM` of the focus centre. Pure.
     */
    function featuresToPolygons(features, focus, radiusM = HIGHLIGHT_RADIUS_M, heightById = _heightById) {
        const out = [];
        const seen = new Set();
        for (const f of (features || [])) {
            const g = f && f.geometry;
            if (!g) continue;
            const props = f.properties || {};
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
                // Prefer a real baked height (Open Buildings 2.5D) keyed by the
                // Overture id; fall back to the footprint-area estimate.
                const real = heightById && props.id != null ? heightById.get(props.id) : null;
                const height = (real != null && isFinite(+real) && +real > 0)
                    ? Math.max(3, +real)
                    : estimateHeight(props, _ringAreaM2(outer, cy), key);
                out.push({ polygon: outer, height, sel });
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
        if (!_heightById) loadHeights('data/heights/indore_building_heights.json');   // real heights when available
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

    return { available, enable, disable, setFocus, refresh, isEnabled, loadHeights,
        featureHeight, estimateHeight, featuresToPolygons, ringPaths };
})();

if (typeof window !== 'undefined') window.DeckBuildings = DeckBuildings;
