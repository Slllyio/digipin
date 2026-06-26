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
    // Slimmed, committed assets (built by pipeline/build_aino_assets_guna.py) so
    // the twin works on deploy — the full google_open_buildings geojson is
    // gitignored and was local-only.
    const BUILDINGS_URL = 'data/vectors/buildings_lite_guna.geojson';
    const TREES_URL = 'data/vectors/aino_trees_guna.json';
    const WATER_URL = 'data/vectors/osm_water_guna.geojson';
    const ROADS_URL = 'data/vectors/osm_roads_guna.geojson';
    const VERT_EXAG = 1.0;          // true proportions — accurate low-rise, no skyline inflation
    let _trees = null;              // [{position:[lng,lat], s}] scattered in green areas

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

    /** Low-poly tree mesh: a cone canopy on a short trunk, in metres, +Z up. */
    function _treeMesh(seg = 7) {
        const pos = [], nrm = [], idx = [];
        const R = 2.4, base = 1.6, top = 5.8;        // canopy radius / start / apex (m)
        pos.push(0, 0, top); nrm.push(0, 0, 1);      // 0: apex
        for (let i = 0; i < seg; i++) {
            const a = 2 * Math.PI * i / seg;
            pos.push(Math.cos(a) * R, Math.sin(a) * R, base);
            nrm.push(Math.cos(a), Math.sin(a), 0.45);
        }
        for (let i = 0; i < seg; i++) idx.push(0, 1 + i, 1 + (i + 1) % seg);   // cone sides
        const c = pos.length / 3; pos.push(0, 0, base); nrm.push(0, 0, -1);    // base centre
        for (let i = 0; i < seg; i++) idx.push(c, 1 + (i + 1) % seg, 1 + i);   // base cap
        // trunk (thin box-ish quad column)
        const t = 0.35, tb = 0, tt = base + 0.3, s0 = pos.length / 3;
        const corners = [[-t, -t], [t, -t], [t, t], [-t, t]];
        for (const [x, y] of corners) { pos.push(x, y, tb); nrm.push(x, y, 0); }
        for (const [x, y] of corners) { pos.push(x, y, tt); nrm.push(x, y, 0); }
        for (let i = 0; i < 4; i++) {
            const a = s0 + i, b = s0 + (i + 1) % 4, c2 = s0 + 4 + i, d = s0 + 4 + (i + 1) % 4;
            idx.push(a, b, c2, b, d, c2);
        }
        return {
            attributes: {
                positions: { value: new Float32Array(pos), size: 3 },
                normals: { value: new Float32Array(nrm), size: 3 },
            },
            indices: { value: new Uint16Array(idx), size: 1 },
        };
    }

    /** Load the precomputed tree points (green-area + street trees) — a small
     *  committed [[lng,lat,scale], ...] set from build_aino_assets_guna.py. */
    function _loadTrees() {
        if (_trees) return Promise.resolve(_trees);
        return fetch(TREES_URL, { cache: 'force-cache' })
            .then(r => r.ok ? r.json() : { trees: [] })
            .then(obj => {
                _trees = (obj.trees || []).map(t => ({ position: [t[0], t[1]], s: t[2] || 1 }));
                return _trees;
            })
            .catch(() => { _trees = []; return []; });
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

    // Building fill layer with a procedural facade shader: a thin dark band once
    // per 3.2 m of height, on WALLS only → reads as floors/windows. Uses
    // geometry.worldPosition.z (elevation in metres) so spacing is metric at any
    // zoom, and geometry.normal.z to skip roofs. Built lazily (needs deck loaded).
    let _WindowLayer = null;
    function _windowLayerClass() {
        if (_WindowLayer) return _WindowLayer;
        _WindowLayer = class extends deck.SolidPolygonLayer {
            getShaders() {
                const s = super.getShaders();
                const inj = s.inject || {};
                s.inject = Object.assign({}, inj, {
                    'vs:#decl': (inj['vs:#decl'] || '') + '\nout float vAlt;\nout float vNz;\n',
                    'vs:DECKGL_FILTER_GL_POSITION': (inj['vs:DECKGL_FILTER_GL_POSITION'] || '')
                        + '\nvAlt = geometry.worldPosition.z;\nvNz = geometry.normal.z;\n',
                    'fs:#decl': (inj['fs:#decl'] || '') + '\nin float vAlt;\nin float vNz;\n',
                    'fs:DECKGL_FILTER_COLOR': (inj['fs:DECKGL_FILTER_COLOR'] || '') + `
                        if (abs(vNz) < 0.5) {                 // walls only, not roofs
                            float f = fract(vAlt / 3.2);      // one band per ~3.2 m floor
                            float line = (1.0 - smoothstep(0.0, 0.09, f)) + smoothstep(0.82, 1.0, f);
                            color.rgb *= mix(1.0, 0.74, clamp(line, 0.0, 1.0));
                        }
                    `,
                });
                return s;
            }
        };
        return _WindowLayer;
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
            // Water bodies + rivers — flat on the ground (depthTest off so they
            // sit cleanly on the table; buildings draw after and occlude them).
            new deck.GeoJsonLayer({
                id: 'aino-water',
                data: WATER_URL,
                extruded: false, stroked: true, filled: true,
                getFillColor: [158, 196, 222, 235],    // soft Aino blue
                getLineColor: [120, 168, 200, 255],
                lineWidthUnits: 'pixels', getLineWidth: 1,
                parameters: { depthTest: false },
            }),
            // Road network — thin grey lines drawn on the white ground.
            new deck.GeoJsonLayer({
                id: 'aino-roads',
                data: ROADS_URL,
                extruded: false, stroked: true, filled: false,
                getLineColor: [176, 182, 196, 220],
                lineWidthUnits: 'pixels', getLineWidth: 0.7, lineWidthMinPixels: 0.5,
                parameters: { depthTest: false },
            }),
            new (_windowLayerClass())({
                id: 'aino-buildings',
                data: _records || [],
                extruded: true,
                filled: true,
                wireframe: true,                       // crisp massing edges
                getPolygon: d => d.polygon,
                getElevation: d => d.height * VERT_EXAG,
                getFillColor: [250, 250, 253],         // near-white blocks, lighter than the grey ground
                getLineColor: [88, 96, 116, 235],      // crisp dark-grey edges
                material: { ambient: 0.5, diffuse: 0.85, shininess: 10, specularColor: [255, 255, 255] },
                parameters: { depthTest: true },
            }),
            new deck.SimpleMeshLayer({
                id: 'aino-trees',
                data: _trees || [],
                mesh: _treeMesh(),
                getPosition: d => d.position,
                getColor: [104, 142, 92],              // stylized canopy green
                getScale: d => [d.s, d.s, d.s],
                material: { ambient: 0.6, diffuse: 0.75, shininess: 4, specularColor: [120, 150, 120] },
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
        // Load building geometry + scatter trees, then push the real layers in.
        Promise.all([_load(), _loadTrees()]).then(() => {
            if (_active && _overlay) _overlay.setProps({ layers: _layers() });
        });
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
