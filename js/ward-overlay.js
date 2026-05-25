/**
 * Ward Boundary Overlay — Fetches administrative boundaries from Overpass
 * Migrated to MapLibre GL JS Native Vector Layers
 */
const WardOverlay = (() => {
    let _active = false;
    let _loading = false;
    let _map = null;
    let _popup = null;
    const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

    const SOURCE_ID = 'ward-overlay-source';
    const FILL_LAYER_ID = 'ward-overlay-fill';
    const LINE_LAYER_ID = 'ward-overlay-line';

    /**
     * Fetch and display ward boundaries for the current map view
     */
    async function show() {
        if (_loading) return;
        clear();
        _loading = true;
        _active = true;

        _map = MapModule.getMap();
        const bounds = _map.getBounds();
        const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

        // Query admin boundaries (level 9 = ward, level 8 = sub-district)
        const query = `[out:json][timeout:15];
(
  relation["boundary"="administrative"]["admin_level"~"^(8|9|10)$"](${bbox});
);
out geom;`;

        App.showToast('Loading Wards', 'Fetching administrative boundaries...', 'info');

        try {
            const resp = await fetch(OVERPASS_URL, {
                method: 'POST',
                body: `data=${encodeURIComponent(query)}`,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            if (!resp.ok) throw new Error(`Overpass returned ${resp.status}`);

            const data = await resp.json();
            
            const features = [];
            let count = 0;

            (data.elements || []).forEach(el => {
                if (!el.members) return;

                // Build polygon from outer ways
                const outerWays = el.members
                    .filter(m => m.type === 'way' && (m.role === 'outer' || m.role === ''))
                    .filter(m => m.geometry);

                outerWays.forEach(way => {
                    // Overpass returns lat/lon, GeoJSON needs lon/lat
                    const coords = way.geometry.map(pt => [pt.lon, pt.lat]);
                    if (coords.length < 3) return;

                    // Ensure ring is closed
                    if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
                        coords.push([...coords[0]]);
                    }

                    const name = el.tags?.name || el.tags?.['name:en'] || `Ward ${el.id}`;
                    features.push({
                        type: 'Feature',
                        geometry: { type: 'Polygon', coordinates: [coords] },
                        properties: { name, admin_level: el.tags?.admin_level }
                    });
                    count++;
                });
            });

            if (!_active) return; // User cleared while loading

            const geojson = { type: 'FeatureCollection', features };

            if (!_map.getSource(SOURCE_ID)) {
                _map.addSource(SOURCE_ID, { type: 'geojson', data: geojson });
                
                _map.addLayer({
                    id: FILL_LAYER_ID,
                    type: 'fill',
                    source: SOURCE_ID,
                    paint: {
                        'fill-color': '#a855f7',
                        'fill-opacity': 0.05
                    }
                });

                _map.addLayer({
                    id: LINE_LAYER_ID,
                    type: 'line',
                    source: SOURCE_ID,
                    paint: {
                        'line-color': '#a855f7',
                        'line-width': 2,
                        'line-dasharray': [4, 3]
                    }
                });

                _map.on('click', FILL_LAYER_ID, (e) => {
                    const props = e.features[0].properties;
                    // GeoJSON props come from external admin-boundary
                    // sources — escape before interpolating into setHTML.
                    const esc = (v) => String(v == null ? '' : v)
                        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                    let html = `<div style="font-family:Inter,sans-serif;"><strong>${esc(props.name)}</strong>`;
                    if (props.admin_level) html += `<br><span style="font-size:11px;">Admin Level: ${esc(props.admin_level)}</span>`;
                    html += `</div>`;

                    if (_popup) _popup.remove();
                    _popup = new maplibregl.Popup()
                        .setLngLat(e.lngLat)
                        .setHTML(html)
                        .addTo(_map);
                });

                _map.on('mouseenter', FILL_LAYER_ID, () => {
                    _map.getCanvas().style.cursor = 'pointer';
                });
                _map.on('mouseleave', FILL_LAYER_ID, () => {
                    _map.getCanvas().style.cursor = '';
                });

            } else {
                _map.getSource(SOURCE_ID).setData(geojson);
            }

            App.showToast('Wards Loaded', `${count} boundary segments displayed`, 'success');
        } catch (err) {
            App.showToast('Ward Fetch Failed', err.message, 'error');
            _active = false;
        } finally {
            _loading = false;
        }
    }

    function clear() {
        _active = false;
        if (_popup) {
            _popup.remove();
            _popup = null;
        }
        if (_map && _map.getSource(SOURCE_ID)) {
            _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
        }
    }

    function isVisible() { return _active; }

    return { show, clear, isVisible };
})();
