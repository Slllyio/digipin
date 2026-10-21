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
    // Vertical exaggeration for the 3D view only. Indore is mostly low-rise
    // (median real height ~6m), so true heights render as a flat carpet. We
    // scale the *display* elevation so the skyline variation is legible — the
    // underlying data and the building inspector still report real heights.
    let _vertExag = 3;

    let _map = null;
    let _overlay = null;
    let _enabled = false;
    let _focus = null;          // {lat,lng} of the focused DIGIPIN cell
    let _data = [];             // harvested deck polygon records
    // Draw-cost record for the perf spec: how much geometry each refresh hands
    // deck.gl and how long the harvest + layer build held the main thread.
    let _refreshes = 0, _lastRefreshMs = 0, _maxRefreshMs = 0, _drawMode = 'off', _drawData = [];
    let _moveBound = false;
    let _grid = null;           // { levels:[…], cells: Map<dashless DIGIPIN, metres> }, when loaded
    const _gridLoads = new Map();   // grid url -> in-flight/finished loadHeights() promise
    let _index = null;          // in-flight/finished fetch of the grid index
    // Per-region height grids baked by scripts/build_building_heights.py, which
    // also writes this index ([{ region, bbox:[w,s,e,n], file }]). Only the grid
    // covering the viewed city is fetched; the big metros run to several MB each.
    const HEIGHT_INDEX = 'data/heights/index.json';

    /** The baked-heights index ([{ region, bbox, file }]), fetched once and shared
     *  with any other module that needs it (city overview) so boot does not
     *  request it twice. Resolves to [] when missing. */
    // A stalled link (no bytes, no error) would otherwise leave a grid "loading"
    // forever: no row, no Retry, estimates with no explanation. Grids are a few
    // MB, so give them longer than the index.
    const INDEX_TIMEOUT_MS = 10000;
    const GRID_TIMEOUT_MS = 120000;   // Delhi's grid is 5 MB: ~25 s on slow 3G, and CI's software renderer stalls the body read behind 3-7 s frames (a 45 s cap tripped there)

    function heightIndex() {
        if (!_index) {
            // A 404 means no grids are baked (final for this build); a failed
            // or 5xx fetch is forgotten so the next call asks again.
            _index = fetch(HEIGHT_INDEX, { cache: 'no-cache', signal: AbortSignal.timeout(INDEX_TIMEOUT_MS) })
                .then(r => { if (r.ok) return r.json(); if (r.status !== 404) _index = null; return []; })
                .catch(() => { _index = null; return []; });
        }
        return _index;
    }

    // Grids whose last fetch failed for a reason other than 404 (url -> status
    // or 'network'). While any is listed the user sees one DataStatus row: the
    // 3D city is drawing estimated heights, and Retry refetches just those.
    const HEIGHTS_KEY = 'heights';
    const _failedGrids = new Map();

    function _reportHeights() {
        if (typeof DataStatus === 'undefined') return;
        if (!_failedGrids.size) { DataStatus.clear(HEIGHTS_KEY); return; }
        DataStatus.set(HEIGHTS_KEY, {
            kind: 'warning',
            text: '3D building heights did not load — buildings show estimated heights until they do.',
            action: { label: 'Retry', busy: 'Loading…', run: retryHeights },
        });
    }

    /** Forget every grid, failure and the index (tests; a republished index). */
    function resetHeights() {
        _index = null;
        _gridLoads.clear();
        _gridDocs.clear();
        _failedGrids.clear();
        _grid = null;
        _reportHeights();
    }

    /**
     * Refetch every grid whose last load failed (not only the ones under the
     * current view: a grid the camera has since left would otherwise keep the
     * row up), plus whatever the view needs now. True when nothing is failed
     * afterwards, which is what lets the row clear.
     */
    async function retryHeights() {
        const urls = [..._failedGrids.keys()];
        await Promise.all(urls.map(u => {
            if (!_gridLoads.has(u)) _gridLoads.set(u, loadHeights(u));
            return _gridLoads.get(u);
        }).concat([ensureHeights()]));
        return _failedGrids.size === 0;
    }

    /**
     * Load a baked DIGIPIN height grid ({ level, cells: { code: metres } })
     * produced from Google Open Buildings 2.5D (scripts/build_building_heights.py)
     * and merge it into the lookup. Keyed by cell rather than Overture id, so it
     * survives Overture releases re-issuing ids. Safe to call with a missing
     * file — a 404 just leaves the footprint estimate in place.
     */
    // Baked grids kept in memory, most recent last. One Delhi-size grid is a
    // few hundred thousand Map entries; merging every visited city into one
    // grid forever made a city sweep leak. Three covers a city plus neighbours.
    const MAX_GRIDS = 3;
    const _gridDocs = new Map();    // grid url -> parsed doc

    function _rebuildGrid() {
        _grid = null;
        for (const doc of _gridDocs.values()) _grid = mergeHeightGrid(_grid, doc);
    }

    async function loadHeights(url) {
        try {
            const res = await fetch(url, { cache: 'force-cache', signal: AbortSignal.timeout(GRID_TIMEOUT_MS) });
            if (!res.ok) {
                // 404: not baked for this city, the estimate stays (nothing to
                // retry). Anything else is a link that failed: forget the load
                // so the next ensureHeights() asks again, and say so.
                if (res.status !== 404) { _failedGrids.set(url, res.status); _gridLoads.delete(url); _reportHeights(); }
                return false;
            }
            const doc = await res.json();
            _failedGrids.delete(url);
            _reportHeights();
            _gridDocs.delete(url);
            _gridDocs.set(url, doc);
            let rebuilt = false;
            while (_gridDocs.size > MAX_GRIDS) {
                const old = _gridDocs.keys().next().value;
                _gridDocs.delete(old);
                _gridLoads.delete(old);      // reloadable later (force-cache makes it cheap)
                rebuilt = true;
            }
            if (rebuilt) _rebuildGrid(); else _grid = mergeHeightGrid(_grid, doc);
            if (_enabled) refresh();
            return true;
        } catch (e) {
            console.warn('DeckBuildings.loadHeights failed:', e);
            _failedGrids.set(url, e && e.name === 'TimeoutError' ? 'timeout' : 'network');
            _gridLoads.delete(url);
            _reportHeights();
            return false;
        }
    }

    /** Grid files from the index whose bbox contains {lat,lng}. Pure. */
    function gridsFor(index, pt) {
        if (!Array.isArray(index) || !pt || !isFinite(pt.lat) || !isFinite(pt.lng)) return [];
        return index.filter(g => Array.isArray(g.bbox) && g.file
            && pt.lng >= g.bbox[0] && pt.lat >= g.bbox[1] && pt.lng <= g.bbox[2] && pt.lat <= g.bbox[3])
            .map(g => g.file);
    }

    /**
     * Load the baked grid(s) covering `pt` (default: the focused cell, else the
     * map centre) once each; resolves when done. Missing files are skipped.
     */
    async function ensureHeights(pt) {
        if (!pt) {
            pt = _focus;
            if (!pt && _map && _map.getCenter) { const c = _map.getCenter(); pt = { lat: c.lat, lng: c.lng }; }
        }
        const files = gridsFor(await heightIndex(), pt);
        return Promise.all(files.map(f => {
            if (!_gridLoads.has(f)) _gridLoads.set(f, loadHeights(f));
            return _gridLoads.get(f);
        }));
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
    /** Merge a baked grid file into a lookup (null-safe, returns the lookup). Pure. */
    function mergeHeightGrid(grid, doc) {
        if (!doc || !doc.cells || !Number.isInteger(doc.level)) return grid;
        const out = grid || { levels: [], cells: new Map() };
        for (const [code, h] of Object.entries(doc.cells)) out.cells.set(code, h);
        if (!out.levels.includes(doc.level)) out.levels = [...out.levels, doc.level].sort((x, y) => y - x);
        return out;
    }
    /** Baked height (m) of the DIGIPIN cell containing a point, finest level first, or null. Pure. */
    function cellHeight(grid, lat, lng) {
        if (!grid || !grid.levels.length || typeof DigiPin === 'undefined') return null;
        let code;
        try { code = DigiPin.encode(lat, lng).replace(/-/g, ''); } catch { return null; }   // outside India
        for (const level of grid.levels) {
            const h = grid.cells.get(code.slice(0, level));
            if (h != null && isFinite(+h) && +h > 0) return +h;
        }
        return null;
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
    function featuresToPolygons(features, focus, radiusM = HIGHLIGHT_RADIUS_M, grid = _grid) {
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
                // Overture's own height/floors win (they describe this exact
                // building). Otherwise use the baked Open Buildings 2.5D height of
                // the building's DIGIPIN cell, jittered ±15% per building so a block
                // doesn't render as one flat slab; else the footprint estimate.
                const explicit = props.height != null || props.num_floors != null;
                const cellH = explicit ? null : cellHeight(grid, cy, cx);
                const height = cellH != null
                    ? Math.max(3, cellH * (0.85 + 0.3 * _hash01(key)))
                    : estimateHeight(props, _ringAreaM2(outer, cy), key);
                const hsrc = explicit ? 'overture' : cellH != null ? 'baked' : 'estimate';
                out.push({ polygon: outer, height, sel, hsrc, cls: props.class || null });
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
            getElevation: d => d.height * _vertExag,
            getFillColor: _fill,
            getLineColor: _line,
            lineWidthUnits: 'pixels',
            getLineWidth: 1.2,
            material: { ambient: 0.5, diffuse: 0.55, shininess: 64, specularColor: [140, 225, 255] },
            opacity: 1,
            updateTriggers: { getFillColor: [_focusKey()], getLineColor: [_focusKey()], getElevation: [_vertExag] }
        }));
        return layers;
    }
    function _focusKey() { return _focus ? `${_focus.lat.toFixed(5)},${_focus.lng.toFixed(5)}` : 'none'; }

    /** Re-harvest the rendered buildings and push fresh layers to the overlay. */
    function refresh() {
        if (!_enabled || !_map || !_overlay) return;
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        let feats = [];
        try { feats = _map.queryRenderedFeatures({ layers: [SRC_LAYER_ID] }) || []; }
        catch { /* layer not rendered yet */ }
        _data = featuresToPolygons(feats, _focus, HIGHLIGHT_RADIUS_M);
        _overlay.setProps({ layers: _layers() });
        noteDraw('deck', _data, ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0);
    }

    /**
     * Record one draw of building geometry: `mode` is 'deck' (this overlay)
     * or 'twin' (OvertureBuildings' MapLibre extrusion source, which harvests
     * through featuresToPolygons too), `data` the polygon records, `ms` the
     * harvest + build time. renderStats() reports the last one.
     */
    function noteDraw(mode, data, ms) {
        _drawMode = mode || 'off';
        _drawData = Array.isArray(data) ? data : [];
        _lastRefreshMs = Math.max(0, Number(ms) || 0);
        _maxRefreshMs = Math.max(_maxRefreshMs, _lastRefreshMs);
        _refreshes++;
    }

    /** Geometry handed to deck.gl for a polygon record list. Pure. */
    function polygonStats(data) {
        const out = { polygons: 0, vertices: 0, selected: 0, bySource: { overture: 0, baked: 0, estimate: 0 } };
        for (const d of (data || [])) {
            out.polygons++;
            out.vertices += d.polygon ? d.polygon.length : 0;
            if (d.sel) out.selected++;
            if (d.hsrc in out.bySource) out.bySource[d.hsrc]++;
        }
        return out;
    }

    /** Current draw cost: geometry of the last draw (deck overlay or twin source) plus refresh timings since the last reset. */
    function renderStats() {
        return Object.assign(polygonStats(_drawData), {
            mode: _drawMode, enabled: _enabled, refreshes: _refreshes,
            lastRefreshMs: Math.round(_lastRefreshMs), maxRefreshMs: Math.round(_maxRefreshMs),
        });
    }
    function resetRenderStats() { _refreshes = 0; _lastRefreshMs = 0; _maxRefreshMs = 0; _drawMode = 'off'; _drawData = []; }

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
        if (!_moveBound) {
            map.on('moveend', () => { ensureHeights(); refresh(); });
            // Footprint tiles keep streaming in after the camera stops: harvest
            // again on the first frame after the source has finished loading.
            let dirty = false;
            map.on('sourcedata', (e) => { if (_enabled && e && e.sourceId === 'overture-buildings-source' && e.tile) dirty = true; });
            map.on('render', () => {
                if (!_enabled || !dirty) return;
                let loaded = true;
                try { loaded = map.isSourceLoaded('overture-buildings-source'); } catch { /* source gone */ }
                if (!loaded) return;
                dirty = false;
                setTimeout(() => { if (_enabled) refresh(); }, 300);
            });
            _moveBound = true;
        }
        ensureHeights();   // real heights when available
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
        if (_enabled) { ensureHeights(); refresh(); }
    }

    /** True while the deck overlay is attached. */
    function isEnabled() { return _enabled; }
    /** Current 3D vertical exaggeration (display-only). */
    function getExaggeration() { return _vertExag; }
    /** Set the 3D vertical exaggeration (display-only) and re-render. */
    function setExaggeration(x) {
        if (Number.isFinite(+x) && +x > 0) { _vertExag = +x; if (_enabled) refresh(); }
        return _vertExag;
    }

    /** Grids currently held, for tests / diagnostics. */
    function heightsCacheStats() { return { grids: _gridDocs.size, max: MAX_GRIDS, cells: _grid ? _grid.cells.size : 0, failed: _failedGrids.size, failedReasons: Object.fromEntries(_failedGrids) }; }

    return { available, enable, disable, setFocus, refresh, isEnabled, loadHeights, ensureHeights, retryHeights, resetHeights, heightIndex, heightsCacheStats,
        polygonStats, renderStats, resetRenderStats, noteDraw,
        setExaggeration, getExaggeration,
        featureHeight, estimateHeight, featuresToPolygons, ringPaths, mergeHeightGrid, cellHeight, gridsFor };
})();

if (typeof window !== 'undefined') window.DeckBuildings = DeckBuildings;
