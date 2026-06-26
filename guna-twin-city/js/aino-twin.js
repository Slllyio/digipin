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
    const RIVERS_URL = 'data/vectors/osm_rivers_guna_continuous.geojson';
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

    /** Metric road width (m) by OSM class — wide arterials, thin lanes. */
    function _roadW(f) {
        const k = ((f.properties && (f.properties.highway || f.properties.fclass || f.properties.class)) || '') + '';
        if (/motorway|trunk/.test(k)) return 16;
        if (/primary/.test(k)) return 13;
        if (/secondary/.test(k)) return 10;
        if (/tertiary/.test(k)) return 7.5;
        if (/residential|unclassified|living_street/.test(k)) return 5;
        return 3.2;
    }

    /** Low-poly tree mesh: a rounded (slightly flattened) canopy sphere on a
     *  short trunk, in metres, +Z up — a stylised deciduous tree, not a pine. */
    function _treeMesh() {
        const pos = [], nrm = [], idx = [];
        const rings = 5, segs = 9;                    // canopy resolution
        const R = 3.0;                               // canopy radius
        const cz = 4.2;                              // canopy centre height
        const squash = 0.85;                         // flatten slightly -> fuller crown
        // canopy sphere
        for (let i = 0; i <= rings; i++) {
            const phi = Math.PI * i / rings;
            for (let j = 0; j <= segs; j++) {
                const th = 2 * Math.PI * j / segs;
                const x = R * Math.sin(phi) * Math.cos(th);
                const y = R * Math.sin(phi) * Math.sin(th);
                const z = R * squash * Math.cos(phi);
                pos.push(x, y, cz + z);
                const l = Math.hypot(x, y, z) || 1;
                nrm.push(x / l, y / l, z / l);
            }
        }
        for (let i = 0; i < rings; i++) {
            for (let j = 0; j < segs; j++) {
                const a = i * (segs + 1) + j, b = a + segs + 1;
                idx.push(a, b, a + 1, b, b + 1, a + 1);
            }
        }
        // trunk (square column up to the canopy)
        const t = 0.4, tt = cz, s0 = pos.length / 3;
        const corners = [[-t, -t], [t, -t], [t, t], [-t, t]];
        for (const [x, y] of corners) { pos.push(x, y, 0); nrm.push(x, y, 0); }
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
                        if (abs(vNz) < 0.5 && vAlt > 0.4) {   // walls only, skip ground sill
                            // horizontal floor lines (one per ~3.2 m)
                            float fy = abs(fract(vAlt / 3.2) - 0.5);
                            float floors = 1.0 - smoothstep(0.40, 0.49, fy);   // thin dark line
                            // vertical mullions across the facade via the wall UV
                            float fx = abs(fract(geometry.uv.x * 26.0) - 0.5);
                            float mull = 1.0 - smoothstep(0.40, 0.49, fx);
                            float grid = clamp(max(floors, mull * 0.7), 0.0, 1.0);
                            color.rgb *= mix(1.0, 0.86, grid);  // subtle, clean window grid
                        }
                    `,
                });
                return s;
            }
        };
        _WindowLayer.layerName = 'AinoWindowLayer';   // silence deck's componentName warning
        return _WindowLayer;
    }

    // A white "table" under the model. Two jobs: (1) the clean white Aino ground,
    // (2) a surface for building shadows to fall on — in overlay mode deck renders
    // on a transparent canvas, so without a ground plane cast shadows have nothing
    // to land on and the model looks flat. Covers the whole Guna metro generously.
    const GROUND = [[77.02, 24.46], [77.60, 24.46], [77.60, 24.84], [77.02, 24.84]];

    function _layers() {
        const layers = [
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
            // Water bodies — clear Aino blue fill, drawn flat on the table.
            new deck.GeoJsonLayer({
                id: 'aino-water',
                data: WATER_URL,
                extruded: false, stroked: true, filled: true,
                getFillColor: [120, 176, 214, 245],    // clear water blue
                getLineColor: [86, 146, 190, 255],
                lineWidthUnits: 'pixels', getLineWidth: 1.2,
                parameters: { depthTest: false },
            }),
            // Roads — grey ribbons with real metric width by class (like the Aino
            // theme): trunk/primary wide, residential thin. Casing + fill for a
            // clean "drawn road" read.
            new deck.GeoJsonLayer({
                id: 'aino-roads-casing',
                data: ROADS_URL,
                stroked: true, filled: false,
                getLineColor: [188, 192, 202, 255],
                lineWidthUnits: 'meters', getLineWidth: _roadW, lineWidthScale: 1.5,
                lineWidthMinPixels: 1.5, lineWidthMaxPixels: 26, lineJointRounded: true, lineCapRounded: true,
                parameters: { depthTest: false },
            }),
            new deck.GeoJsonLayer({
                id: 'aino-roads',
                data: ROADS_URL,
                stroked: true, filled: false,
                getLineColor: [232, 234, 238, 255],    // light fill so roads read as paved ribbons
                lineWidthUnits: 'meters', getLineWidth: _roadW,
                lineWidthMinPixels: 0.8, lineWidthMaxPixels: 20, lineJointRounded: true, lineCapRounded: true,
                parameters: { depthTest: false },
            }),
            // Water pathways — rivers/canals/streams/drains as BLUE lines with
            // observable metric width so they clearly read as water.
            new deck.GeoJsonLayer({
                id: 'aino-rivers',
                data: RIVERS_URL,
                stroked: true, filled: false,
                getLineColor: [86, 150, 200, 255],     // water blue
                lineWidthUnits: 'meters',
                getLineWidth: f => {
                    const k = f.properties && f.properties.waterway;
                    return k === 'river' ? 24 : k === 'canal' ? 18 : k === 'stream' ? 10 : 7;
                },
                lineWidthMinPixels: 3, lineWidthMaxPixels: 30, lineJointRounded: true, lineCapRounded: true,
                parameters: { depthTest: false },
            }),
        ];
        // Only add the data-driven layers once their data is in — drawing an
        // empty extruded SolidPolygon / SimpleMesh triggers deck's primcount<0 warning.
        if (_records && _records.length) {
            layers.push(new (_windowLayerClass())({
                id: 'aino-buildings',
                data: _records,
                extruded: true,
                filled: true,
                wireframe: true,                       // crisp massing edges
                getPolygon: d => d.polygon,
                getElevation: d => d.height * VERT_EXAG,
                getFillColor: [250, 250, 253],         // near-white blocks, lighter than the grey ground
                getLineColor: [150, 158, 174, 200],    // soft architectural edges
                material: { ambient: 0.5, diffuse: 0.85, shininess: 10, specularColor: [255, 255, 255] },
                parameters: { depthTest: true },
            }));
        }
        if (_trees && _trees.length) {
            layers.push(new deck.SimpleMeshLayer({
                id: 'aino-trees',
                data: _trees,
                mesh: _treeMesh(),
                getPosition: d => d.position,
                getColor: [88, 138, 86],               // richer canopy green
                getScale: d => [d.s * 1.15, d.s * 1.15, d.s * 1.15],
                material: { ambient: 0.65, diffuse: 0.7, shininess: 2, specularColor: [110, 140, 110] },
                parameters: { depthTest: true },
            }));
        }
        return layers;
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
