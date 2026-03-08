/**
 * Heatmap Score Overlay — Color grid cells by a selected intelligence score
 * Migrated to MapLibre Native Vector Overlays
 */
const HeatmapOverlay = (() => {
    let _activeScore = null;
    let _abortController = null;
    let _map = null;
    let _features = [];
    
    const SOURCE_ID = 'heatmap-overlay-source';
    const LAYER_ID = 'heatmap-overlay-layer';

    const SCORE_OPTIONS = [
        { key: 'livability', label: 'Livability' },
        { key: 'safety', label: 'Safety' },
        { key: 'green', label: 'Green Index' },
        { key: 'connectivity', label: 'Connectivity' },
        { key: 'commercial', label: 'Commercial' },
        { key: 'healthcare_access', label: 'Healthcare' },
        { key: 'walkability', label: 'Walkability' },
        { key: 'food_diversity', label: 'Food Diversity' },
        { key: 'noise_estimate', label: 'Quietness' },
        { key: 'population_proxy', label: 'Population' },
    ];

    async function show(scoreKey) {
        clear();
        _activeScore = scoreKey;
        _map = MapModule.getMap();
        _features = [];

        if (!_map.getSource(SOURCE_ID)) {
            _map.addSource(SOURCE_ID, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
            _map.addLayer({
                id: LAYER_ID,
                type: 'fill-extrusion',
                source: SOURCE_ID,
                paint: {
                    'fill-extrusion-color': ['get', 'color'],
                    'fill-extrusion-height': ['get', 'height'],
                    'fill-extrusion-base': 0,
                    'fill-extrusion-opacity': 0.8
                }
            });
        }

        const bounds = _map.getBounds();
        const gridSize = 6;
        const latStep = (bounds.getNorth() - bounds.getSouth()) / gridSize;
        const lngStep = (bounds.getEast() - bounds.getWest()) / gridSize;

        _abortController = new AbortController();
        const points = [];
        for (let i = 0; i < gridSize; i++) {
            for (let j = 0; j < gridSize; j++) {
                points.push({
                    lat: bounds.getSouth() + latStep * (i + 0.5),
                    lng: bounds.getWest() + lngStep * (j + 0.5),
                    latStep, lngStep
                });
            }
        }

        App.showToast('Heatmap Loading', `Sampling ${points.length} points for ${scoreKey}...`, 'info');

        // Fetch in batches of 6
        for (let batch = 0; batch < points.length; batch += 6) {
            if (_abortController.signal.aborted) break;
            const chunk = points.slice(batch, batch + 6);
            const results = await Promise.allSettled(
                chunk.map(pt => DataFetcher.fetchAllFeatures(pt.lat, pt.lng, 400))
            );

            // True if we added new polygons
            let addedNew = false;

            results.forEach((r, idx) => {
                if (r.status !== 'fulfilled' || _abortController.signal.aborted) return;
                const pt = chunk[idx];
                const val = r.value.scores?.[scoreKey]?.value;
                if (val == null) return;

                const color = val >= 70 ? '#22c55e' : val >= 40 ? '#eab308' : val >= 20 ? '#f97316' : '#ef4444';
                
                // GeoJSON Polygon coordinates
                const coords = [
                    [
                        [pt.lng - pt.lngStep / 2, pt.lat - pt.latStep / 2],
                        [pt.lng + pt.lngStep / 2, pt.lat - pt.latStep / 2],
                        [pt.lng + pt.lngStep / 2, pt.lat + pt.latStep / 2],
                        [pt.lng - pt.lngStep / 2, pt.lat + pt.latStep / 2],
                        [pt.lng - pt.lngStep / 2, pt.lat - pt.latStep / 2]
                    ]
                ];

                const height = val * 5; // e.g., score 80 becomes 400m tall

                _features.push({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: coords },
                    properties: { color, height, score: val }
                });
                addedNew = true;
            });

            if (addedNew && !_abortController.signal.aborted && _map) {
                _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: _features });
            }

            if (batch + 6 < points.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        if (!_abortController.signal.aborted) {
            App.showToast('3D Heatmap Ready', `${scoreKey} overlay applied. Pitch the map to see height!`, 'success');
        }
    }

    function clear() {
        if (_abortController) { _abortController.abort(); _abortController = null; }
        if (_map && _map.getSource(SOURCE_ID)) {
            _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
        }
        _features = [];
        _activeScore = null;
    }

    function getOptions() { return SCORE_OPTIONS; }
    function getActive() { return _activeScore; }

    return { show, clear, getOptions, getActive };
})();
