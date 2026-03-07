/**
 * Isochrone / Walkability Radius — OpenRouteService free API
 * Shows "reachable in X minutes" polygon overlay on the map
 */
const Isochrone = (() => {
    const ORS_URL = 'https://api.openrouteservice.org/v2/isochrones/foot-walking';
    const API_KEY = '5b3ce3597851110001cf62487c0ef84637174f6f9f20656e6c0d8d8a'; // Free tier key
    let _layer = null;
    let _loading = false;

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
        clear();

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
            _layer = L.layerGroup().addTo(MapModule.getMap());

            // Draw in reverse order so smallest is on top
            const features = (data.features || []).reverse();
            features.forEach((feature, idx) => {
                const presetIdx = PRESETS.length - 1 - idx;
                const preset = PRESETS[presetIdx] || PRESETS[0];
                const coords = feature.geometry.coordinates[0].map(c => [c[1], c[0]]);

                L.polygon(coords, {
                    color: preset.color,
                    fillColor: preset.color,
                    fillOpacity: 0.12,
                    weight: 2,
                    dashArray: '6 4'
                }).bindPopup(preset.label).addTo(_layer);
            });

            // Center marker
            L.circleMarker([lat, lng], {
                radius: 5, color: '#fff', fillColor: '#fff', fillOpacity: 1, weight: 0
            }).addTo(_layer);

            App.showToast('Isochrone Ready', 'Showing 5/10/15 min walking zones', 'success');
        } catch (err) {
            App.showToast('Isochrone Failed', err.message, 'error');
        } finally {
            _loading = false;
        }
    }

    function clear() {
        if (_layer) {
            MapModule.getMap().removeLayer(_layer);
            _layer = null;
        }
    }

    function isVisible() { return !!_layer; }

    return { show, clear, isVisible };
})();
