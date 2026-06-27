/**
 * Overture Buildings Overlay — 2.3B+ building footprints via MapLibre PMTiles
 *
 * Renders individual building polygons from the Overture Maps Foundation
 * directly in the browser via native MapLibre vector tiles + 3D fill-extrusion.
 *
 * Features:
 *  - Native 3D Extrusion
 *  - Height-coded building coloring
 *  - Click-to-inspect per-building attributes
 *  - Stats aggregation for visible buildings
 */

const OvertureBuildings = (() => {
    const PMTILES_URL = 'https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/2024-08-20/buildings.pmtiles';
    const LAYER_ID = 'overture-buildings-layer';
    const EDGE_LAYER_ID = 'overture-edges-layer';
    const RINGS_LAYER_ID = 'overture-rings-layer';
    const HL_LAYER_ID = 'overture-highlight-layer';
    const SOURCE_ID = 'overture-buildings-source';
    const RINGS_SRC = 'overture-rings-source';
    const HL_SRC = 'overture-highlight-source';

    // Range rings drawn around the focused DIGIPIN cell (metres) + the radius
    // within which nearby buildings glow amber as the "selected properties".
    const RING_RADII = [150, 300, 450];
    const HIGHLIGHT_RADIUS_M = 220;

    let _active = false;
    let _map = null;
    let _infoPopup = null;
    let _focus = null;          // {lat,lng} of the focused cell, or null
    let _moveBound = false;     // moveend listener attached once
    let _deck = false;          // deck.gl WebGL renderer is driving the view

    // ---- pure geometry helpers (unit-tested) ------------------------------
    /** Great-circle distance between two {lat,lng} points, in metres. */
    function _haversineM(a, b) {
        const R = 6371000, toR = Math.PI / 180;
        const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
        const s = Math.sin(dLat / 2) ** 2
            + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    }
    /** Centroid {lat,lng} of a (Multi)Polygon's first outer ring. */
    function _centroid(geometry) {
        if (!geometry) return null;
        let ring = null;
        if (geometry.type === 'Polygon') ring = geometry.coordinates[0];
        else if (geometry.type === 'MultiPolygon') ring = geometry.coordinates[0] && geometry.coordinates[0][0];
        if (!ring || !ring.length) return null;
        let lng = 0, lat = 0;
        for (const c of ring) { lng += c[0]; lat += c[1]; }
        return { lng: lng / ring.length, lat: lat / ring.length };
    }
    /** A closed ring of [lng,lat] points approximating a circle of radius rM. */
    function _circle(center, rM, steps = 64) {
        const latR = rM / 111320;
        const lngR = rM / (111320 * Math.cos(center.lat * Math.PI / 180) || 1);
        const coords = [];
        for (let i = 0; i <= steps; i++) {
            const t = (2 * Math.PI * i) / steps;
            coords.push([center.lng + lngR * Math.cos(t), center.lat + latR * Math.sin(t)]);
        }
        return coords;
    }
    /** GeoJSON LineString rings (concentric circles) around a centre. Pure. */
    function ringsGeoJSON(center, radii = RING_RADII) {
        return {
            type: 'FeatureCollection',
            features: (center ? radii : []).map(r => ({
                type: 'Feature',
                properties: { radius: r },
                geometry: { type: 'LineString', coordinates: _circle(center, r) }
            }))
        };
    }
    /** Buildings whose centroid falls within rM of the focus centre. Pure. */
    function nearbyHighlight(features, center, rM = HIGHLIGHT_RADIUS_M) {
        if (!center || !Array.isArray(features)) return { type: 'FeatureCollection', features: [] };
        const seen = new Set();
        const out = [];
        for (const f of features) {
            const c = _centroid(f.geometry);
            if (!c || _haversineM(center, c) > rM) continue;
            const key = `${c.lng.toFixed(6)},${c.lat.toFixed(6)}`;
            if (seen.has(key)) continue;        // de-dupe tile-split repeats
            seen.add(key);
            out.push({ type: 'Feature', geometry: f.geometry, properties: f.properties || {} });
        }
        return { type: 'FeatureCollection', features: out };
    }

    /** True when the paper-light theme is active. */
    function isLight() {
        return typeof Theme !== 'undefined' && Theme.get && Theme.get() === 'light';
    }

    // Real building height (metres), independent of theme. NULL-SAFE: every
    // arithmetic branch is guarded by ['has', …] because MapLibre's `coalesce`
    // does NOT recover from a runtime error, and `['*', ['get','num_floors'], …]`
    // *throws* when num_floors is absent — which it is for most Overture
    // footprints (they often carry no height/floors/class at all). The old
    // coalesce form errored for those features, collapsing height to 0 (flat)
    // and the fill-extrusion-color to its black default — so buildings rendered
    // as flat black footprints in light AND zero-height specks in dark. The
    // case+has form below always returns a finite number (12m fallback).
    const REAL_HEIGHT = [
        'case',
        ['has', 'height'], ['max', 3, ['to-number', ['get', 'height'], 12]],
        ['has', 'num_floors'], ['*', ['to-number', ['get', 'num_floors'], 3], 3.6],
        ['==', ['get', 'class'], 'commercial'], 35,
        ['==', ['get', 'class'], 'industrial'], 25,
        ['==', ['get', 'class'], 'residential'], 12,
        12
    ];

    // Dark theme: an Esri-style "digital twin" — grounded, translucent cyan
    // glass volumes that deepen to teal at street level and glow toward the
    // towers. The earlier floating-hologram treatment read as broken (buildings
    // detached 100m in the air); this grounds them (base = min_height) and uses
    // MapLibre's vertical gradient + a height colour ramp for the glow, paired
    // with the bright footprint-edge line layer below for the wireframe look.
    const PAINT_DARK = {
        'fill-extrusion-color': [
            'interpolate', ['linear'], REAL_HEIGHT,
            0, '#0b4a59',    // deep teal at the base
            25, '#0f7d94',
            70, '#19b6d6',
            160, '#5cf0ff'   // bright cyan for tall towers
        ],
        'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
        'fill-extrusion-height': REAL_HEIGHT,
        // Translucent so overlapping volumes layer like glass (the Esri look).
        'fill-extrusion-opacity': 0.62,
        'fill-extrusion-vertical-gradient': true
    };

    // Paper (reference design) light: a white architectural massing model — cool
    // near-white volumes deepening to light grey by height (pseudo ambient
    // occlusion), grounded (not floating, no tethers). MapLibre's vertical
    // gradient + the directional map light (set on attach) supply the model
    // shading, mirroring the Google Open Buildings treatment.
    const PAINT_LIGHT = {
        'fill-extrusion-color': [
            'interpolate', ['linear'], REAL_HEIGHT,
            0, '#f3f5f7',
            15, '#e9edf0',
            40, '#dce1e6',
            120, '#ccd2d9'
        ],
        'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
        'fill-extrusion-height': REAL_HEIGHT,
        'fill-extrusion-opacity': 0.96,
        'fill-extrusion-vertical-gradient': true
    };

    /**
     * Create the native MapLibre PMTiles source and fill-extrusion layer
     */
    function initLayer(map) {
        if (map.getSource(SOURCE_ID)) return; // Already initialized

        map.addSource(SOURCE_ID, {
            type: 'vector',
            url: `pmtiles://${PMTILES_URL}`
        });

        // 1. Glowing footprint edges — a bright cyan outline of every building
        // base. This is the signature of the Esri "digital twin" wireframe-glass
        // look and the closest MapLibre's renderer gets to lit building edges
        // (fill-extrusion has no native edge stroke). Dark-theme only; the Paper
        // light massing model is a clean white solid with no glow.
        map.addLayer({
            id: EDGE_LAYER_ID,
            type: 'line',
            source: SOURCE_ID,
            'source-layer': 'building',
            minzoom: 13,
            paint: {
                'line-color': '#7df4ff',
                'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.3, 17, 0.9],
                'line-opacity': 0.55
            },
            layout: {
                'visibility': 'none'
            }
        });

        // 2. Add the Overture buildings: a grounded white massing model under
        // the Paper light theme, or the floating neon volumes under dark.
        map.addLayer({
            id: LAYER_ID,
            type: 'fill-extrusion',
            source: SOURCE_ID,
            'source-layer': 'building',
            minzoom: 13,
            paint: isLight() ? PAINT_LIGHT : PAINT_DARK,
            layout: {
                'visibility': 'none'
            }
        });

        // 3. Range rings around the focused DIGIPIN cell (drawn before the
        // highlight so towers occlude them like a ground plane). Dark-only.
        map.addSource(RINGS_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
            id: RINGS_LAYER_ID,
            type: 'line',
            source: RINGS_SRC,
            paint: {
                'line-color': '#8fe9ff',
                'line-width': 1.2,
                'line-opacity': ['interpolate', ['linear'], ['get', 'radius'], 150, 0.6, 450, 0.18],
                'line-dasharray': [3, 3]
            },
            layout: { 'visibility': 'none' }
        });

        // 4. Amber "selected properties" — the buildings near the focused cell,
        // re-extruded in glowing amber on top of the cyan twin. Source is filled
        // at focus time from queryRenderedFeatures (see _refreshHighlight).
        map.addSource(HL_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
            id: HL_LAYER_ID,
            type: 'fill-extrusion',
            source: HL_SRC,
            minzoom: 13,
            paint: {
                'fill-extrusion-color': [
                    'interpolate', ['linear'], REAL_HEIGHT,
                    0, '#b35e00',
                    40, '#ff9d2e',
                    140, '#ffcf6b'
                ],
                'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
                'fill-extrusion-height': REAL_HEIGHT,
                'fill-extrusion-opacity': 0.92,
                'fill-extrusion-vertical-gradient': true
            },
            layout: { 'visibility': 'none' }
        });

        map.on('click', LAYER_ID, onMapClick);
        map.on('mouseenter', LAYER_ID, () => {
            if (_active) map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', LAYER_ID, () => {
            if (_active) map.getCanvas().style.cursor = '';
        });
    }

    /**
     * Toggle the buildings overlay on/off
     */
    function toggle(map) {
        _map = map;
        initLayer(map);

        _active = !_active;
        const light = isLight();

        // Preferred dark-theme renderer: a deck.gl WebGL "digital twin" with true
        // wireframe-glass volumes (Esri SceneView look). deck.gl reads the
        // geometry MapLibre already loaded, so we keep the MapLibre extrusion
        // layer present-but-invisible (opacity ~0, still queryRenderedFeatures-
        // able) and let deck draw the visuals. Falls back to MapLibre's own
        // fill-extrusion glass when deck.gl isn't loaded.
        const useDeck = _active && !light
            && typeof DeckBuildings !== 'undefined' && DeckBuildings.available && DeckBuildings.available();

        if (useDeck) {
            map.setLayoutProperty(LAYER_ID, 'visibility', 'visible');
            map.setPaintProperty(LAYER_ID, 'fill-extrusion-opacity', 0.01); // invisible but queryable
            map.setLayoutProperty(EDGE_LAYER_ID, 'visibility', 'none');     // deck draws edges
            clearFocus();                                                   // deck draws rings + amber
            DeckBuildings.enable(map, () => _focus);
            _deck = true;
            if (!_active && _infoPopup) { _infoPopup.remove(); _infoPopup = null; }
            return _active;
        }

        if (_deck) {   // leaving the deck path (overlay off)
            try { DeckBuildings.disable(map); } catch { /* not enabled */ }
            try { map.setPaintProperty(LAYER_ID, 'fill-extrusion-opacity', PAINT_DARK['fill-extrusion-opacity']); } catch { /* layer gone */ }
            _deck = false;
        }

        map.setLayoutProperty(LAYER_ID, 'visibility', _active ? 'visible' : 'none');
        // Glowing footprint edges are the dark "digital twin" device; the Paper
        // light massing model is a clean white solid, so keep edges hidden there.
        map.setLayoutProperty(EDGE_LAYER_ID, 'visibility', (_active && !light) ? 'visible' : 'none');

        // Paper light: give the white volumes a fixed directional "sun" so they
        // read with a consistent lit/shadow side (anchor:'map' keeps the light
        // tied to geography as you rotate). map.setLight is a *global* map
        // property, deliberately identical to DigitalTwinLayers' light (same
        // position/intensity), so the two building overlays share one lit model
        // and never fight. It is set-only (never reset on hide) — matching
        // DigitalTwinLayers — so toggling either overlay off leaves the shared
        // light in place rather than clearing the other's shading.
        if (_active && light) {
            try {
                map.setLight({ anchor: 'map', position: [1.4, 210, 38], color: '#ffffff', intensity: 0.45 });
            } catch { /* older MapLibre without setLight — vertical gradient still applies */ }
        }

        // Range rings + amber highlight are a dark-theme device tied to the
        // focused cell. Draw them when turning on (dark) over a known focus,
        // clear them otherwise.
        if (_active && !light && _focus) drawFocus();
        else clearFocus();

        if (!_active && _infoPopup) {
            _infoPopup.remove();
            _infoPopup = null;
        }

        return _active;
    }

    /**
     * Focus the overlay on a DIGIPIN cell: draw range rings around its centre
     * and glow the nearby buildings amber. Called from MapModule.selectCell on
     * every cell selection; a no-op visual unless the dark overlay is active.
     */
    function focusCell(center) {
        _focus = (center && Number.isFinite(center.lat) && Number.isFinite(center.lng))
            ? { lat: center.lat, lng: center.lng } : null;
        if (_deck && typeof DeckBuildings !== 'undefined') { DeckBuildings.setFocus(_focus); return; }
        if (_map && _active && !isLight() && _focus) drawFocus();
        else if (_map) clearFocus();
    }

    /** Render the rings + amber highlight for the current `_focus`. */
    function drawFocus() {
        if (!_map || !_focus) return;
        const rs = _map.getSource(RINGS_SRC);
        if (rs) rs.setData(ringsGeoJSON(_focus));
        _map.setLayoutProperty(RINGS_LAYER_ID, 'visibility', 'visible');
        // Re-pick nearby buildings whenever tiles finish loading/panning, since
        // queryRenderedFeatures only sees what's currently rendered.
        if (!_moveBound) {
            _map.on('moveend', () => { if (_active && !isLight() && _focus) _refreshHighlight(); });
            _moveBound = true;
        }
        _refreshHighlight();
    }

    /** Fill the amber highlight source from the buildings currently rendered. */
    function _refreshHighlight() {
        if (!_map || !_focus) return;
        let feats = [];
        try { feats = _map.queryRenderedFeatures({ layers: [LAYER_ID] }) || []; }
        catch { /* layer not rendered yet */ }
        const fc = nearbyHighlight(feats, _focus, HIGHLIGHT_RADIUS_M);
        const hs = _map.getSource(HL_SRC);
        if (hs) hs.setData(fc);
        _map.setLayoutProperty(HL_LAYER_ID, 'visibility', fc.features.length ? 'visible' : 'none');
    }

    /** Hide the rings + amber highlight (overlay off, light theme, or no cell). */
    function clearFocus() {
        if (!_map) return;
        try {
            _map.setLayoutProperty(RINGS_LAYER_ID, 'visibility', 'none');
            _map.setLayoutProperty(HL_LAYER_ID, 'visibility', 'none');
        } catch { /* layers not added yet */ }
    }

    /** Click handler: show a popup of the clicked building's attributes. */
    function onMapClick(e) {
        if (!_active) return;

        const features = e.features;
        if (!features || features.length === 0) return;

        const f = features[0];
        const props = f.properties || {};

        // PMTiles feature properties are externally-sourced (Overture
        // releases) — treat as untrusted and HTML-escape before any
        // string-into-HTML interpolation.
        const esc = (v) => String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

        let html = '<div class="overture-popup" style="font-family:Inter,sans-serif; min-width:180px;">';
        html += '<div class="overture-popup-title"><strong>Building Details</strong></div><hr>';

        if (props.class) html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Class:</span> <b>${esc(props.class)}</b></div>`;
        if (props.subtype) html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Subtype:</span> <b>${esc(props.subtype)}</b></div>`;
        if (props.height > 0) html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Height:</span> <b>${props.height.toFixed(1)}m</b></div>`;
        if (props.num_floors > 0) html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Floors:</span> <b>${esc(props.num_floors)}</b></div>`;
        if (props.min_height > 0) html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Min Height:</span> <b>${props.min_height.toFixed(1)}m</b></div>`;
        if (props.roof_shape) html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Roof:</span> <b>${esc(props.roof_shape)}</b></div>`;

        if (props.height > 0 && !props.num_floors) {
            const estFloors = Math.round(props.height / 3.2);
            html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px; color:#888;"><span>Est. Floors:</span> <span>~${estFloors}</span></div>`;
        }

        if (!props.class && !props.height) {
            html += '<div style="color:#888; text-align:center; padding-top:10px;">Minimal data available</div>';
        }

        html += '</div>';

        if (_infoPopup) _infoPopup.remove();
        
        _infoPopup = new maplibregl.Popup({ className: 'overture-building-popup', maxWidth: '250px' })
            .setLngLat(e.lngLat)
            .setHTML(html)
            .addTo(_map);
    }

    /**
     * Get aggregate stats for visible buildings in current viewport
     */
    function getVisibleStats() {
        if (!_active || !_map) return null;

        try {
            const features = _map.queryRenderedFeatures({ layers: [LAYER_ID] });
            if (!features || features.length === 0) return null;

            let totalBuildings = 0;
            let withHeight = 0;
            let withFloors = 0;
            let totalHeight = 0;
            const classes = {};
            const processedIds = new Set(); // Prevent duplicates

            // Overture buildings in PMTiles don't always have a standard 'id'. 
            // We use geometry string as a simple deduplication heuristic for rendered features.
            for (const f of features) {
                const geomKey = f.geometry.coordinates[0]?.[0]?.join(',') || Math.random().toString();
                if (processedIds.has(geomKey)) continue;
                processedIds.add(geomKey);

                totalBuildings++;
                const p = f.properties || {};

                if (p.height > 0) {
                    withHeight++;
                    totalHeight += p.height;
                }
                if (p.num_floors > 0) withFloors++;
                if (p.class) classes[p.class] = (classes[p.class] || 0) + 1;
            }

            return {
                totalBuildings,
                withHeight,
                withFloors,
                avgHeight: withHeight > 0 ? +(totalHeight / withHeight).toFixed(1) : null,
                classes
            };
        } catch (e) {
            console.warn('Overture stats error:', e);
            return null;
        }
    }

    /** True while the buildings overlay is visible. */
    function isActive() { return _active; }

    return { toggle, isActive, getVisibleStats, focusCell, ringsGeoJSON, nearbyHighlight };
})();
