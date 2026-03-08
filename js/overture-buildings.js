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
    const TETHER_LAYER_ID = 'overture-tethers-layer';
    const SOURCE_ID = 'overture-buildings-source';

    let _active = false;
    let _map = null;
    let _infoPopup = null;

    /**
     * Create the native MapLibre PMTiles source and fill-extrusion layer
     */
    function initLayer(map) {
        if (map.getSource(SOURCE_ID)) return; // Already initialized

        map.addSource(SOURCE_ID, {
            type: 'vector',
            url: `pmtiles://${PMTILES_URL}`
        });

        // 1. Add the Holographic Tethers (base goes from 0 to the bottom of the floating building)
        map.addLayer({
            id: TETHER_LAYER_ID,
            type: 'fill-extrusion',
            source: SOURCE_ID,
            'source-layer': 'building',
            minzoom: 13,
            paint: {
                'fill-extrusion-color': '#00f0ff',
                'fill-extrusion-base': 0,
                'fill-extrusion-height': [
                    '+',
                    ['coalesce', ['get', 'min_height'], 0],
                    100
                ],
                // Add artificial transparency for the hologram effect
                'fill-extrusion-opacity': 0.15
            },
            layout: {
                'visibility': 'none'
            }
        });

        // 2. Add the actual floating Overture buildings on top of the tethers
        map.addLayer({
            id: LAYER_ID,
            type: 'fill-extrusion',
            source: SOURCE_ID,
            'source-layer': 'building',
            minzoom: 13,
            paint: {
                // Vibrant solid colors inspired by the user's reference image
                'fill-extrusion-color': [
                    'match',
                    ['get', 'class'],
                    'commercial', '#0085CA', // Bright blue
                    'industrial', '#0085CA',
                    'retail', '#0085CA',
                    'residential', '#E32A22', // Bright red
                    'education', '#E32A22',
                    'medical', '#0085CA',
                    'government', '#0085CA',
                    'transportation', '#5C2D91',
                    '#E32A22' // Default red
                ],
                // Generous default heights so buildings pop in 3D
                // Ground base with 100m offset (float above ground)
                'fill-extrusion-base': [
                    '+',
                    ['coalesce', ['get', 'min_height'], 0],
                    100
                ],
                // Height must also be offset by 100m so the building itself doesn't shrink
                'fill-extrusion-height': [
                    '+',
                    [
                        'coalesce',
                        ['get', 'height'],
                        ['*', ['get', 'num_floors'], 3.6],
                        ['case', 
                            ['==', ['get', 'class'], 'commercial'], 35, 
                            ['==', ['get', 'class'], 'industrial'], 25, 
                            ['==', ['get', 'class'], 'residential'], 12, 
                            15
                        ]
                    ],
                    100
                ],
                // Solid opacity and add artificial edge shading through MapLibre light
                'fill-extrusion-opacity': 0.8
            },
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
        map.setLayoutProperty(LAYER_ID, 'visibility', _active ? 'visible' : 'none');
        map.setLayoutProperty(TETHER_LAYER_ID, 'visibility', _active ? 'visible' : 'none');
        
        if (!_active && _infoPopup) {
            _infoPopup.remove();
            _infoPopup = null;
        }

        return _active;
    }

    function onMapClick(e) {
        if (!_active) return;

        const features = e.features;
        if (!features || features.length === 0) return;

        const f = features[0];
        const props = f.properties || {};

        let html = '<div class="overture-popup" style="font-family:Inter,sans-serif; min-width:180px;">';
        html += '<div class="overture-popup-title"><strong>Building Details</strong></div><hr>';

        if (props.class) html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Class:</span> <b>${props.class}</b></div>`;
        if (props.subtype) html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Subtype:</span> <b>${props.subtype}</b></div>`;
        if (props.height > 0) html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Height:</span> <b>${props.height.toFixed(1)}m</b></div>`;
        if (props.num_floors > 0) html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Floors:</span> <b>${props.num_floors}</b></div>`;
        if (props.min_height > 0) html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Min Height:</span> <b>${props.min_height.toFixed(1)}m</b></div>`;
        if (props.roof_shape) html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Roof:</span> <b>${props.roof_shape}</b></div>`;

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

    function isActive() { return _active; }

    return { toggle, isActive, getVisibleStats };
})();
