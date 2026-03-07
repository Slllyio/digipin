/**
 * Overture Buildings Overlay — 2.3B+ building footprints via PMTiles
 *
 * Renders individual building polygons from the Overture Maps Foundation
 * directly in the browser using protomaps-leaflet + pmtiles.js.
 * No server needed — S3 PMTiles accessed via HTTP range requests.
 *
 * Features:
 *  - Height-coded building coloring (low=blue, mid=orange, high=red)
 *  - Click-to-inspect per-building attributes (height, class, floors)
 *  - Zoom-dependent rendering (visible at zoom >= 13)
 *  - Stats aggregation for visible buildings
 */

const OvertureBuildings = (() => {
    const PMTILES_URL = 'https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/2024-08-20/buildings.pmtiles';

    let _layer = null;
    let _active = false;
    let _map = null;
    let _infoPopup = null;

    // Height-based color palette for building footprints
    function heightColor(height) {
        if (height == null || height <= 0) return 'rgba(100, 149, 237, 0.45)'; // cornflower — unknown
        if (height < 6)   return 'rgba(65, 105, 225, 0.5)';   // royal blue — low (1-2 floors)
        if (height < 15)  return 'rgba(34, 139, 34, 0.55)';   // forest green — mid (3-5 floors)
        if (height < 30)  return 'rgba(255, 165, 0, 0.6)';    // orange — mid-high (6-10 floors)
        if (height < 60)  return 'rgba(255, 69, 0, 0.65)';    // orangered — high (10-20 floors)
        return 'rgba(220, 20, 60, 0.75)';                      // crimson — very high (20+ floors)
    }

    // Class-based color for buildings without height
    function classColor(cls) {
        const colors = {
            'residential':   'rgba(100, 149, 237, 0.4)',
            'commercial':    'rgba(255, 165, 0, 0.5)',
            'industrial':    'rgba(169, 169, 169, 0.5)',
            'transportation':'rgba(147, 112, 219, 0.4)',
            'education':     'rgba(60, 179, 113, 0.5)',
            'medical':       'rgba(220, 20, 60, 0.5)',
            'entertainment': 'rgba(255, 105, 180, 0.5)',
            'religious':     'rgba(218, 165, 32, 0.5)',
            'government':    'rgba(70, 130, 180, 0.5)',
            'agricultural':  'rgba(107, 142, 35, 0.4)',
        };
        return colors[cls] || 'rgba(100, 149, 237, 0.35)';
    }

    /**
     * Custom symbolizer that colors buildings by height or class
     */
    class BuildingSymbolizer {
        draw(context, geom, z, feature) {
            const height = feature.props.height;
            const cls = feature.props.class;

            context.fillStyle = height > 0 ? heightColor(height) : classColor(cls);
            context.strokeStyle = 'rgba(50, 50, 50, 0.3)';
            context.lineWidth = 0.5;

            context.beginPath();
            for (const poly of geom) {
                for (let p = 0; p < poly.length; p++) {
                    const pt = poly[p];
                    if (p === 0) context.moveTo(pt.x, pt.y);
                    else context.lineTo(pt.x, pt.y);
                }
                context.closePath();
            }
            context.fill();

            // Only draw outlines at higher zoom for performance
            if (z >= 15) {
                context.stroke();
            }
        }
    }

    /**
     * Create and return the protomaps-leaflet layer
     */
    function createLayer() {
        if (typeof protomapsL === 'undefined' || typeof pmtiles === 'undefined') {
            console.warn('OvertureBuildings: protomaps-leaflet or pmtiles not loaded');
            return null;
        }

        const paintRules = [
            {
                dataLayer: 'building',
                symbolizer: new BuildingSymbolizer(),
                minzoom: 13
            }
        ];

        const layer = protomapsL.leafletLayer({
            url: PMTILES_URL,
            paintRules: paintRules,
            labelRules: [],
            maxDataZoom: 14,
            attribution: 'Buildings &copy; <a href="https://overturemaps.org">Overture Maps</a>'
        });

        return layer;
    }

    /**
     * Toggle the buildings overlay on/off
     */
    function toggle(map) {
        _map = map;

        if (_active && _layer) {
            map.removeLayer(_layer);
            _layer = null;
            _active = false;
            removeClickHandler();
            return false;
        }

        _layer = createLayer();
        if (!_layer) return false;

        _layer.addTo(map);
        _active = true;
        addClickHandler();

        return true;
    }

    /**
     * Click handler — query building features under cursor
     */
    function addClickHandler() {
        if (!_map) return;
        _map.on('click', onMapClick);
    }

    function removeClickHandler() {
        if (!_map) return;
        _map.off('click', onMapClick);
        if (_infoPopup) {
            _map.closePopup(_infoPopup);
            _infoPopup = null;
        }
    }

    function onMapClick(e) {
        if (!_active || !_layer) return;

        const zoom = _map.getZoom();
        if (zoom < 13) return;

        // Query rendered features at click point
        const features = queryFeaturesAt(e.latlng);
        if (features.length === 0) return;

        const f = features[0]; // closest building
        const props = f.props || {};

        let html = '<div class="overture-popup">';
        html += '<div class="overture-popup-title">Building Details</div>';

        if (props.class) html += `<div class="overture-popup-row"><span>Class:</span><span>${props.class}</span></div>`;
        if (props.subtype) html += `<div class="overture-popup-row"><span>Subtype:</span><span>${props.subtype}</span></div>`;
        if (props.height > 0) html += `<div class="overture-popup-row"><span>Height:</span><span>${props.height.toFixed(1)}m</span></div>`;
        if (props.num_floors > 0) html += `<div class="overture-popup-row"><span>Floors:</span><span>${props.num_floors}</span></div>`;
        if (props.min_height > 0) html += `<div class="overture-popup-row"><span>Min Height:</span><span>${props.min_height.toFixed(1)}m</span></div>`;
        if (props.facade_color) html += `<div class="overture-popup-row"><span>Facade:</span><span>${props.facade_color}</span></div>`;
        if (props.roof_shape) html += `<div class="overture-popup-row"><span>Roof:</span><span>${props.roof_shape}</span></div>`;
        if (props.has_parts !== undefined) html += `<div class="overture-popup-row"><span>Has Parts:</span><span>${props.has_parts ? 'Yes' : 'No'}</span></div>`;

        // Show estimated floors if height available but no num_floors
        if (props.height > 0 && !props.num_floors) {
            const estFloors = Math.round(props.height / 3.2);
            html += `<div class="overture-popup-row muted"><span>Est. Floors:</span><span>~${estFloors}</span></div>`;
        }

        // If no detailed props, show what we have
        if (!props.class && !props.height) {
            html += '<div class="overture-popup-row muted"><span>Minimal data available</span></div>';
        }

        html += '</div>';

        _infoPopup = L.popup({ className: 'overture-building-popup', maxWidth: 250 })
            .setLatLng(e.latlng)
            .setContent(html)
            .openOn(_map);
    }

    /**
     * Query features rendered at a point.
     * protomaps-leaflet renders to canvas, so we check the tile data directly.
     */
    function queryFeaturesAt(latlng) {
        if (!_layer || !_layer.paintRules) return [];

        // Access the internal tile cache of the protomaps layer
        try {
            const tileSize = 256;
            const zoom = _map.getZoom();
            const point = _map.project(latlng, zoom);
            const tileX = Math.floor(point.x / tileSize);
            const tileY = Math.floor(point.y / tileSize);

            // Try to get features from protomaps internal cache
            const key = `${zoom}:${tileX}:${tileY}`;
            const tileData = _layer._tiles?.[key]?.el?._data;

            if (tileData && tileData.building) {
                return tileData.building.slice(0, 5); // return top features
            }
        } catch {
            // Feature querying not available — expected for canvas-based rendering
        }

        return [];
    }

    /**
     * Get aggregate stats for visible buildings in current viewport
     */
    function getVisibleStats() {
        if (!_active || !_layer) return null;

        try {
            const tiles = _layer._tiles || {};
            let totalBuildings = 0;
            let withHeight = 0;
            let withFloors = 0;
            let totalHeight = 0;
            const classes = {};

            for (const tile of Object.values(tiles)) {
                const data = tile?.el?._data;
                if (!data || !data.building) continue;

                for (const f of data.building) {
                    totalBuildings++;
                    const p = f.props || {};

                    if (p.height > 0) {
                        withHeight++;
                        totalHeight += p.height;
                    }
                    if (p.num_floors > 0) withFloors++;
                    if (p.class) classes[p.class] = (classes[p.class] || 0) + 1;
                }
            }

            return {
                totalBuildings,
                withHeight,
                withFloors,
                avgHeight: withHeight > 0 ? +(totalHeight / withHeight).toFixed(1) : null,
                classes
            };
        } catch {
            return null;
        }
    }

    function isActive() { return _active; }
    function getLayer() { return _layer; }

    return { toggle, isActive, getLayer, getVisibleStats };
})();
