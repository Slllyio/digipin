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
    const SOURCE_ID = 'overture-buildings-source';

    let _active = false;
    let _map = null;
    let _infoPopup = null;

    /** True when the Aino paper-light theme is active. */
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

    // Aino (aino.world) light: a white architectural massing model — cool
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
        // (fill-extrusion has no native edge stroke). Dark-theme only; the Aino
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
        // the Aino light theme, or the floating neon volumes under dark.
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
        map.setLayoutProperty(LAYER_ID, 'visibility', _active ? 'visible' : 'none');
        // Glowing footprint edges are the dark "digital twin" device; the Aino
        // light massing model is a clean white solid, so keep edges hidden there.
        map.setLayoutProperty(EDGE_LAYER_ID, 'visibility', (_active && !light) ? 'visible' : 'none');

        // Aino light: give the white volumes a fixed directional "sun" so they
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

        if (!_active && _infoPopup) {
            _infoPopup.remove();
            _infoPopup = null;
        }

        return _active;
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

    return { toggle, isActive, getVisibleStats };
})();
