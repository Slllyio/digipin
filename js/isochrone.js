/**
 * Isochrone / Walkability Radius — OpenRouteService free API
 * Shows "reachable in X minutes" polygon overlay on the map using MapLibre
 */
const Isochrone = (() => {
    const ORS_URL = 'https://api.openrouteservice.org/v2/isochrones/foot-walking';
    const API_KEY = '5b3ce3597851110001cf62487c0ef84637174f6f9f20656e6c0d8d8a'; // Free tier key
    
    let _active = false;
    let _loading = false;
    let _map = null;
    let _popup = null;

    const SOURCE_ID = 'isochrone-source';
    const FILL_LAYER = 'isochrone-fill';
    const LINE_LAYER = 'isochrone-line';
    const POINT_SOURCE = 'isochrone-point-source';
    const POINT_LAYER = 'isochrone-point';

    const PRESETS = [
        { minutes: 5, color: '#22c55e', label: '5 min walk' },
        { minutes: 10, color: '#eab308', label: '10 min walk' },
        { minutes: 15, color: '#ef4444', label: '15 min walk' },
    ];

    /**
     * Show isochrone rings for a given lat/lng
     */
    async function show(lat, lng) {
        if (_loading) return;
        _loading = true;
        _active = true;
        _map = MapModule.getMap();
        clear(false); // Clear existing data without deactivating

        try {
            const resp = await fetch(ORS_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': API_KEY
                },
                body: JSON.stringify({
                    locations: [[lng, lat]],
                    range: PRESETS.map(p => p.minutes * 60),
                    range_type: 'time'
                })
            });

            if (!resp.ok) throw new Error(`ORS returned ${resp.status}`);

            const data = await resp.json();
            
            if (!_active) return; // User cleared while loading

            const features = [];
            // Draw in reverse order so smallest is on top
            const orsFeatures = (data.features || []).reverse();
            
            orsFeatures.forEach((feature, idx) => {
                const presetIdx = PRESETS.length - 1 - idx;
                const preset = PRESETS[presetIdx] || PRESETS[0];
                
                // ORS returns [lon, lat], MapLibre expects [lon, lat]
                const coords = feature.geometry.coordinates[0];

                features.push({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [coords] },
                    properties: { color: preset.color, label: preset.label }
                });
            });

            const geojson = { type: 'FeatureCollection', features };
            const pointGeojson = {
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [lng, lat] }
                }]
            };

            // Add Polygon Source & Layers
            if (!_map.getSource(SOURCE_ID)) {
                _map.addSource(SOURCE_ID, { type: 'geojson', data: geojson });
                
                _map.addLayer({
                    id: FILL_LAYER,
                    type: 'fill',
                    source: SOURCE_ID,
                    paint: {
                        'fill-color': ['get', 'color'],
                        'fill-opacity': 0.12
                    }
                });

                _map.addLayer({
                    id: LINE_LAYER,
                    type: 'line',
                    source: SOURCE_ID,
                    paint: {
                        'line-color': ['get', 'color'],
                        'line-width': 2,
                        'line-dasharray': [3, 2]
                    }
                });

                // Interaction
                _map.on('click', FILL_LAYER, (e) => {
                    const props = e.features[0].properties;
                    // GeoJSON props originate from external services
                    // (Overpass / Open-Source Routing Machine) — escape
                    // before interpolating into setHTML.
                    const esc = (v) => String(v == null ? '' : v)
                        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                    if (_popup) _popup.remove();
                    _popup = new maplibregl.Popup()
                        .setLngLat(e.lngLat)
                        .setHTML(`<div style="font-family:Inter,sans-serif;font-weight:bold;">${esc(props.label)}</div>`)
                        .addTo(_map);
                });

                _map.on('mouseenter', FILL_LAYER, () => {
                    _map.getCanvas().style.cursor = 'pointer';
                });
                _map.on('mouseleave', FILL_LAYER, () => {
                    _map.getCanvas().style.cursor = '';
                });
            } else {
                _map.getSource(SOURCE_ID).setData(geojson);
            }

            // Add Center Point Source & Layer
            if (!_map.getSource(POINT_SOURCE)) {
                _map.addSource(POINT_SOURCE, { type: 'geojson', data: pointGeojson });
                
                _map.addLayer({
                    id: POINT_LAYER,
                    type: 'circle',
                    source: POINT_SOURCE,
                    paint: {
                        'circle-radius': 5,
                        'circle-color': '#ffffff',
                        'circle-stroke-width': 2,
                        'circle-stroke-color': '#000000'
                    }
                });
            } else {
                _map.getSource(POINT_SOURCE).setData(pointGeojson);
            }

            App.showToast('Isochrone Ready', 'Showing 5/10/15 min walking zones', 'success');
        } catch (err) {
            App.showToast('Isochrone Failed', err.message, 'error');
            _active = false;
        } finally {
            _loading = false;
        }
    }

    function clear(fullyDeactivate = true) {
        if (fullyDeactivate) _active = false;
        if (_popup) {
            _popup.remove();
            _popup = null;
        }
        if (_map) {
            if (_map.getSource(SOURCE_ID)) {
                _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
            }
            if (_map.getSource(POINT_SOURCE)) {
                _map.getSource(POINT_SOURCE).setData({ type: 'FeatureCollection', features: [] });
            }
        }
    }

    function isVisible() { return _active; }

    return { show, clear, isVisible };
})();
