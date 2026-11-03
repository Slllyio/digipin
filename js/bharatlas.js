/**
 * Bharatlas integration — India-wide curated geospatial layers.
 *
 * Bharatlas (bharatlas.com) serves 59 open-licence layers as PMTiles
 * from a Cloudflare R2 CDN. DigiPin uses a curated subset:
 *
 *   - Administrative containment per cell (state, district, sub-district)
 *     replaces 4 Overpass calls per click with one PMTiles featureset.
 *   - Postal containment (pincode polygon) gives every 4×4m DigiPin cell
 *     a deterministic pincode — directly serving DigiPin's mission.
 *   - Optional visual layers (wildlife sanctuaries, eco-sensitive zones,
 *     river basins) light up via the Layers dropdown.
 *
 * Architecture:
 *   - On init(map) we add invisible source+layer pairs for the lookup
 *     layers (states, districts, subdistricts, pincodes) using
 *     `fill-opacity: 0` so MapLibre fetches their PMTiles and they
 *     remain queryable via queryRenderedFeatures.
 *   - lookup(lat, lng) returns the containing feature properties for
 *     each lookup layer.
 *   - showLayer(layerId) / hideLayer(layerId) toggle visibility of
 *     additional Bharatlas layers (visual overlays).
 *
 * Catalog source: https://bharatlas.com/catalog.json
 * Licence: CC0-1.0 / CC-BY-4.0 (per-layer; see Bharatlas card)
 */
const Bharatlas = (() => {
    const R2_BASE = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev';

    // Curated subset of the 59-layer catalog. Pick layers that are
    // small enough for global lazy-load + directly useful for the
    // DigiPin cell-detail panel.
    // Source-layer names + display field names below were verified by
    // querying the live PMTiles at runtime (2026-05-25). The schema
    // inside each file is the upstream SHP attribute set:
    //   - LGD layers use UPPER_SNAKE_CASE or shortened ALL CAPS columns
    //   - data.gov.in pincodes use Pascal_Case
    const LAYERS = {
        // ---- Lookup layers (invisible, queried per cell click) ----
        lgd_states: {
            label: 'States (LGD)',
            url: `${R2_BASE}/admin/states/LGD_States.pmtiles`,
            sourceLayer: 'LGD_States',
            kind: 'lookup',
            rows: 36,
            bytes: 3.5e6,
            displayField: 'STNAME',   // e.g. "MADHYA PRADESH"
        },
        lgd_districts: {
            label: 'Districts (LGD)',
            url: `${R2_BASE}/admin/districts/LGD_Districts.pmtiles`,
            sourceLayer: 'LGD_Districts',
            kind: 'lookup',
            rows: 785,
            bytes: 12.7e6,
            displayField: 'dtname',   // e.g. "Indore"
        },
        lgd_subdistricts: {
            label: 'Sub-districts / Tehsils (LGD)',
            url: `${R2_BASE}/admin/subdistricts/LGD_Subdistricts.pmtiles`,
            sourceLayer: 'LGD_Subdistricts',
            kind: 'lookup',
            rows: 6471,
            bytes: 34.1e6,
            displayField: 'sdtname',   // e.g. "Indore Tehsil"
        },
        datagov_pincodes: {
            label: 'Pin codes (data.gov.in)',
            url: `${R2_BASE}/postal/boundaries/Datagov_Pincode_Boundaries.pmtiles`,
            sourceLayer: 'Datagov_Pincode_Boundaries',
            kind: 'lookup',
            rows: 19312,
            bytes: 20.9e6,
            displayField: 'Pincode',   // e.g. "452001"
        },
        // ---- Visual overlays (toggleable by user) ----
        gs_wildlife: {
            label: 'Wildlife sanctuaries + national parks',
            url: `${R2_BASE}/environment/forests/GatiShakti_Wildlife_Sanctuaries_and_National_Parks.pmtiles`,
            sourceLayer: 'gs_wildlife',
            kind: 'visual',
            rows: 665,
            bytes: 9.4e6,
            paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.35, 'fill-outline-color': '#16a34a' },
        },
        bm_eco_zones: {
            label: 'Eco-sensitive zones',
            url: `${R2_BASE}/environment/forests/Bharatmaps_Parivesh_Eco_Sensitive_Zones.pmtiles`,
            sourceLayer: 'bm_eco_zones',
            kind: 'visual',
            rows: 249,
            bytes: 1.1e6,
            paint: { 'fill-color': '#84cc16', 'fill-opacity': 0.3 },
        },
        wris_basin: {
            label: 'River basins',
            url: `${R2_BASE}/water/hydro-boundaries/WRIS_Basin.pmtiles`,
            sourceLayer: 'wris_basin',
            kind: 'visual',
            rows: 25,
            bytes: 1.6e6,
            paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.2, 'fill-outline-color': '#0369a1' },
        },
        lgd_parliament: {
            label: 'Lok Sabha constituencies',
            url: `${R2_BASE}/electoral/constituencies/LGD_Parliament_Constituencies.pmtiles`,
            sourceLayer: 'lgd_parliament',
            kind: 'visual',
            rows: 543,
            bytes: 10.8e6,
            paint: { 'fill-color': '#a855f7', 'fill-opacity': 0.25, 'fill-outline-color': '#7e22ce' },
        },
    };

    let _map = null;
    let _initialised = false;
    const _added = new Set();

    function _sourceId(id)   { return `bharatlas-${id}-src`; }
    function _layerId(id)    { return `bharatlas-${id}-fill`; }
    function _outlineId(id)  { return `bharatlas-${id}-line`; }

    function _ensurePmtilesProtocol() {
        // PMTiles protocol is registered globally in overture-buildings.js
        // and digital-twin-layers.js. If neither has run yet, register here.
        if (typeof maplibregl === 'undefined' || typeof pmtiles === 'undefined') return false;
        const proto = maplibregl.config?.REGISTERED_PROTOCOLS?.pmtiles
            || (maplibregl.config && maplibregl.config.pmtilesProtocol);
        if (!proto && typeof maplibregl.addProtocol === 'function') {
            const p = new pmtiles.Protocol();
            maplibregl.addProtocol('pmtiles', p.tile);
        }
        return true;
    }

    function _addLayer(id, def) {
        if (!_map) return;
        if (_added.has(id)) return;
        const srcId = _sourceId(id);
        const lyrId = _layerId(id);

        if (!_map.getSource(srcId)) {
            _map.addSource(srcId, {
                type: 'vector',
                url: `pmtiles://${def.url}`,
            });
        }

        if (!_map.getLayer(lyrId)) {
            const paint = def.kind === 'lookup'
                ? { 'fill-color': '#000', 'fill-opacity': 0 }   // invisible but queryable
                : def.paint;
            _map.addLayer({
                id: lyrId,
                type: 'fill',
                source: srcId,
                'source-layer': def.sourceLayer,
                paint,
            });
            // Add a thin outline for visual layers
            if (def.kind === 'visual') {
                _map.addLayer({
                    id: _outlineId(id),
                    type: 'line',
                    source: srcId,
                    'source-layer': def.sourceLayer,
                    paint: { 'line-color': def.paint['fill-outline-color'] || def.paint['fill-color'], 'line-width': 0.5, 'line-opacity': 0.5 },
                });
            }
        }
        _added.add(id);
    }

    function init(map) {
        if (_initialised) return;
        _map = map;
        if (!_ensurePmtilesProtocol()) {
            // Retry once the deps load
            setTimeout(() => init(map), 250);
            return;
        }
        // Pre-attach all lookup layers so they're queryable from first
        // cell click. Visual layers are added lazily via showLayer().
        for (const [id, def] of Object.entries(LAYERS)) {
            if (def.kind === 'lookup') _addLayer(id, def);
        }
        _initialised = true;
    }

    function showLayer(id) {
        const def = LAYERS[id];
        if (!def || !_map) return;
        _addLayer(id, def);
        const lyrId = _layerId(id);
        if (_map.getLayer(lyrId)) _map.setLayoutProperty(lyrId, 'visibility', 'visible');
        const outId = _outlineId(id);
        if (_map.getLayer(outId)) _map.setLayoutProperty(outId, 'visibility', 'visible');
    }

    function hideLayer(id) {
        if (!_map) return;
        const lyrId = _layerId(id);
        const outId = _outlineId(id);
        if (_map.getLayer(lyrId)) _map.setLayoutProperty(lyrId, 'visibility', 'none');
        if (_map.getLayer(outId)) _map.setLayoutProperty(outId, 'visibility', 'none');
    }

    function isVisible(id) {
        if (!_map) return false;
        const lyrId = _layerId(id);
        if (!_map.getLayer(lyrId)) return false;
        return (_map.getLayoutProperty(lyrId, 'visibility') || 'visible') !== 'none';
    }

    /**
     * Look up the polygon containing (lat, lng) in each lookup layer.
     * Returns { state, district, subdistrict, pincode } with the most-
     * relevant property from each layer, or null if the tile isn't
     * loaded yet (the user can retry after a moment).
     */
    function lookup(lat, lng) {
        if (!_map) return null;
        const point = _map.project([lng, lat]);
        const result = {};
        for (const [id, def] of Object.entries(LAYERS)) {
            if (def.kind !== 'lookup') continue;
            const lyrId = _layerId(id);
            if (!_map.getLayer(lyrId)) { result[id] = null; continue; }
            try {
                const features = _map.queryRenderedFeatures(point, { layers: [lyrId] });
                if (features.length === 0) { result[id] = null; continue; }
                const props = features[0].properties || {};
                result[id] = {
                    primary: props[def.displayField] != null ? String(props[def.displayField]) : null,
                    all: props,
                };
            } catch (e) {
                result[id] = null;
            }
        }
        return result;
    }

    function getCatalog() {
        return JSON.parse(JSON.stringify(LAYERS));
    }

    return { init, showLayer, hideLayer, isVisible, lookup, getCatalog, LAYERS };
})();

if (typeof window !== 'undefined') window.Bharatlas = Bharatlas;
