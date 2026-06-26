/**
 * AinoTwin — deck.gl "white architectural massing" digital-twin renderer.
 *
 * Goal: the Aino (aino.world) aesthetic — a clean white 3D city model with soft
 * shadows, crisp edges, (later) procedural window facades and instanced trees.
 *
 * M1 (this file): load the Guna building footprints, extrude them as a white
 * massing model with area-estimated heights, crisp grey edges, and a deck.gl
 * LightingEffect (ambient + directional sun with shadows) for the soft-shadow /
 * ambient-occlusion look. Overlaid on MapLibre via deck.MapboxOverlay so the
 * camera stays in sync.
 *
 * Reuses DeckBuildings.estimateHeight (footprint-area heuristic) — Guna's Google
 * Open Buildings carry height_m = -1, so heights must be estimated.
 *
 * Subsequent milestones add: M2 procedural window shader, M3 instanced 3D trees,
 * M4 water/drainage + render polish.
 */
const AinoTwin = (() => {
    const BUILDINGS_URL = 'data/vectors/google_open_buildings_guna.geojson';
    const VERT_EXAG = 1.0;          // true proportions — accurate low-rise, no skyline inflation

    let _map = null;
    let _overlay = null;
    let _active = false;
    let _prevCamera = null;         // restore pitch/bearing on exit
    let _records = null;            // [{polygon:[[lng,lat]...], height}] built from the geojson
    let _loading = null;            // in-flight load promise

    /** deck.gl present with the layers/effects M1 needs. */
    function available() {
        return typeof deck !== 'undefined' && !!deck.MapboxOverlay
            && !!deck.GeoJsonLayer && !!deck.LightingEffect;
    }

    /** Deterministic 0..1 hash of a string (stable per-building roofline jitter). */
    function _hash01(s) {
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return ((h >>> 0) % 100000) / 100000;
    }

    /** Realistic building height (m) for a low-rise Indian town. Google Open
     *  Buildings carry no height (height_m = -1), so we infer FLOORS from the
     *  footprint — small plots are 1–2 storeys, larger plots a few more, capped
     *  at ~6 — then × ~3.2 m/floor with a stable ±1-floor jitter so rooflines
     *  vary. Result ~3–20 m: accurate proportions, not an inflated skyline. */
    function _height(props) {
        const p = props || {};
        const real = +p.height_m > 0 ? +p.height_m : (+p.height > 0 ? +p.height : 0);
        if (real > 0) return Math.max(3, real);
        const area = +p.area_m2 || +p.area_in_meters || 0;
        let floors = area < 50 ? 1 : area < 110 ? 2 : area < 220 ? 3
            : area < 450 ? 4 : area < 900 ? 5 : 6;
        const j = _hash01(`${p.id || ''}:${Math.round(area)}`);
        if (j > 0.86) floors += 1; else if (j < 0.16 && floors > 1) floors -= 1;
        return floors * 3.2;
    }

    /** Fetch the building geojson ONCE and pre-build {polygon, height} records —
     *  the proven PolygonLayer pattern (DeckBuildings/diagnostic) rather than a
     *  GeoJsonLayer URL, which didn't extrude reliably here. */
    function _load() {
        if (_records) return Promise.resolve(_records);
        if (_loading) return _loading;
        _loading = fetch(BUILDINGS_URL, { cache: 'force-cache' })
            .then(r => r.json())
            .then(gj => {
                const out = [];
                for (const f of (gj.features || [])) {
                    const g = f.geometry; if (!g) continue;
                    const polys = g.type === 'Polygon' ? [g.coordinates]
                        : g.type === 'MultiPolygon' ? g.coordinates : [];
                    const h = _height(f.properties);
                    for (const poly of polys) {
                        const outer = poly && poly[0];
                        if (outer && outer.length >= 4) out.push({ polygon: outer, height: h });
                    }
                }
                _records = out;
                return out;
            })
            .catch(e => { console.warn('[AinoTwin] building load failed', e); return []; });
        return _loading;
    }

    /** Ambient + two directional lights → the white-model look. NOTE: no
     *  `_shadow: true` — deck.gl's shadow pass breaks extrusion rendering under
     *  MapboxOverlay (geometry collapses flat). Face shading from the directional
     *  lights (bright tops, darker sides) gives the 3D depth instead. Ambient is
     *  kept moderate so the side faces stay legibly darker than the tops. */
    function _lighting() {
        const ambient = new deck.AmbientLight({ color: [255, 255, 255], intensity: 0.6 });
        const sun = new deck.DirectionalLight({
            color: [255, 255, 255], intensity: 1.4, direction: [-0.8, -1.6, -0.9],
        });
        const fill = new deck.DirectionalLight({
            color: [224, 231, 245], intensity: 0.35, direction: [1.4, -1, 1.2],
        });
        return new deck.LightingEffect({ ambient, sun, fill });
    }

    // A white "table" under the model. Two jobs: (1) the clean white Aino ground,
    // (2) a surface for building shadows to fall on — in overlay mode deck renders
    // on a transparent canvas, so without a ground plane cast shadows have nothing
    // to land on and the model looks flat. Covers the whole Guna metro generously.
    const GROUND = [[77.02, 24.46], [77.60, 24.46], [77.60, 24.84], [77.02, 24.84]];

    function _layers() {
        return [
            new deck.SolidPolygonLayer({
                id: 'aino-ground',
                data: [{ polygon: GROUND }],
                getPolygon: d => d.polygon,
                getFillColor: [222, 225, 231],         // light GREY table — buildings (white) pop above it
                material: { ambient: 0.9, diffuse: 0.5, shininess: 1, specularColor: [255, 255, 255] },
                parameters: { depthTest: true },
            }),
            new deck.PolygonLayer({
                id: 'aino-buildings',
                data: _records || [],
                extruded: true,
                filled: true,
                wireframe: true,                       // draws the crisp massing edges
                getPolygon: d => d.polygon,
                getElevation: d => d.height * VERT_EXAG,
                getFillColor: [250, 250, 253],         // near-white blocks, lighter than the grey ground
                getLineColor: [88, 96, 116, 235],      // crisp dark-grey edges
                lineWidthUnits: 'pixels',
                getLineWidth: 1.2,
                lineWidthMinPixels: 1,
                material: { ambient: 0.5, diffuse: 0.85, shininess: 10, specularColor: [255, 255, 255] },
                parameters: { depthTest: true },
            }),
        ];
    }

    function attach() {
        _map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!_map) return false;
        if (!available()) {
            if (typeof App !== 'undefined' && App.showToast) {
                App.showToast('Aino 3D unavailable', 'deck.gl failed to load — check the network.', 'warning');
            }
            return false;
        }
        _active = true;
        _prevCamera = { pitch: _map.getPitch(), bearing: _map.getBearing() };
        _map.easeTo({ pitch: 60, bearing: -20, duration: 900 });
        _overlay = new deck.MapboxOverlay({ interleaved: false, effects: [_lighting()], layers: _layers() });
        _map.addControl(_overlay);
        if (typeof App !== 'undefined' && App.showToast) {
            App.showToast('Aino 3D Twin', 'Loading white architectural massing…', 'info');
        }
        // Load building geometry, then push the real layers in.
        _load().then(() => { if (_active && _overlay) _overlay.setProps({ layers: _layers() }); });
        return true;
    }

    function detach() {
        _active = false;
        if (_overlay && _map) { try { _map.removeControl(_overlay); } catch { /* gone */ } }
        _overlay = null;
        if (_map && _prevCamera) _map.easeTo({ ...(_prevCamera), duration: 600 });
    }

    function toggle() { if (_active) detach(); else attach(); }
    function isActive() { return _active; }

    return { available, attach, detach, toggle, isActive };
})();

if (typeof window !== 'undefined') window.AinoTwin = AinoTwin;
