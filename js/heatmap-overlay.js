/**
 * Heatmap Score Overlay — Color grid cells by a selected intelligence score
 */
const HeatmapOverlay = (() => {
    let _layer = null;
    let _activeScore = null;
    let _abortController = null;

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
        _layer = L.layerGroup().addTo(MapModule.getMap());

        const map = MapModule.getMap();
        const bounds = map.getBounds();
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

            results.forEach((r, idx) => {
                if (r.status !== 'fulfilled' || _abortController.signal.aborted) return;
                const pt = chunk[idx];
                const val = r.value.scores?.[scoreKey]?.value;
                if (val == null) return;

                const color = val >= 70 ? '#22c55e' : val >= 40 ? '#eab308' : val >= 20 ? '#f97316' : '#ef4444';
                L.rectangle(
                    [[pt.lat - pt.latStep / 2, pt.lng - pt.lngStep / 2],
                     [pt.lat + pt.latStep / 2, pt.lng + pt.lngStep / 2]],
                    { color: 'transparent', fillColor: color, fillOpacity: 0.25, weight: 0 }
                ).addTo(_layer);
            });

            if (batch + 6 < points.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        App.showToast('Heatmap Ready', `${scoreKey} overlay applied`, 'success');
    }

    function clear() {
        if (_abortController) { _abortController.abort(); _abortController = null; }
        if (_layer) { MapModule.getMap().removeLayer(_layer); _layer = null; }
        _activeScore = null;
    }

    function getOptions() { return SCORE_OPTIONS; }
    function getActive() { return _activeScore; }

    return { show, clear, getOptions, getActive };
})();
