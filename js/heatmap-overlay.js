/**
 * Heatmap Score Overlay — Color grid cells by a selected intelligence score
 * Migrated to MapLibre Native Vector Overlays
 */
const HeatmapOverlay = (() => {
    let _activeScore = null;
    let _abortController = null;
    let _map = null;
    let _features = [];
    let _reverse = false;   // true → tall/high = RED (hotspot reading)

    const SOURCE_ID = 'heatmap-overlay-source';
    const LAYER_ID = 'heatmap-overlay-layer';
    const LEGEND_ID = 'heatmap-overlay-legend';

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
        { key: 'population_proxy', label: 'Population', reverse: true },
    ];

    // Color for a 0-100 value. Default ("good" scores): high = green. When
    // `reverse` (intensity/hotspot metrics, e.g. population, heat), high = red,
    // so the tallest columns read as the hottest — matching the legend.
    function colorFor(val, reverse) {
        if (reverse) {
            return val >= 70 ? '#ef4444' : val >= 40 ? '#f97316' : val >= 20 ? '#eab308' : '#22c55e';
        }
        return val >= 70 ? '#22c55e' : val >= 40 ? '#eab308' : val >= 20 ? '#f97316' : '#ef4444';
    }

    // A small map-corner legend so the height/colour scale is self-explanatory
    // (the overlay had none). Removed on clear().
    function renderLegend(scoreKey, reverse) {
        removeLegend();
        if (typeof document === 'undefined') return;
        const host = (_map && _map.getContainer) ? _map.getContainer() : document.body;
        const el = document.createElement('div');
        el.id = LEGEND_ID;
        const ramp = reverse
            ? 'linear-gradient(90deg,#22c55e,#eab308,#f97316,#ef4444)'
            : 'linear-gradient(90deg,#ef4444,#f97316,#eab308,#22c55e)';
        const hi = reverse ? 'high · hotspot' : 'high · best';
        el.style.cssText = 'position:absolute;right:14px;bottom:28px;z-index:5;'
            + 'background:rgba(20,22,26,.82);color:#fff;font:600 12px/1.3 Inter,system-ui,sans-serif;'
            + 'padding:10px 12px;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.35);pointer-events:none;';
        // Build with DOM nodes + textContent (scoreKey is never interpolated as HTML).
        const title = document.createElement('div');
        title.style.cssText = 'margin-bottom:6px;letter-spacing:.3px';
        title.textContent = `${scoreKey} — taller = higher`;
        const bar = document.createElement('div');
        bar.style.cssText = `height:9px;border-radius:5px;background:${ramp}`;
        const labels = document.createElement('div');
        labels.style.cssText = 'display:flex;justify-content:space-between;margin-top:4px;opacity:.85;font-weight:500';
        const lo = document.createElement('span'); lo.textContent = 'low';
        const hiEl = document.createElement('span'); hiEl.textContent = hi;
        labels.append(lo, hiEl);
        el.append(title, bar, labels);
        host.appendChild(el);
    }
    /** Remove the map-corner legend element if present. */
    function removeLegend() {
        if (typeof document === 'undefined') return;
        const old = document.getElementById && document.getElementById(LEGEND_ID);
        if (old) old.remove();
    }

    /** Paint the 3D score heatmap for scoreKey over the current viewport, using precomputed tiles when available or sampling live otherwise. */
    async function show(scoreKey, opts = {}) {
        clear();
        _activeScore = scoreKey;
        _reverse = !!opts.reverse;
        _map = MapModule.getMap();
        if (!_map) return;   // map not initialised yet — every other overlay guards this
        // addSource/addLayer throw "Style is not done loading" if the style isn't
        // ready (e.g. a deep-link/URL-state auto-toggle during the basemap swap);
        // defer to the load event instead of throwing.
        if (!_map.isStyleLoaded()) { _map.once('load', () => show(scoreKey, opts)); return; }
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
                    'fill-extrusion-opacity': 0.85,
                    'fill-extrusion-vertical-gradient': true
                }
            });
        }
        renderLegend(scoreKey, _reverse);

        const bounds = _map.getBounds();

        // Precomputed fast path: if static score tiles cover this viewport, paint
        // every real DIGIPIN cell from one shard read instead of sampling 36
        // points live (~250 upstream calls). Falls through to live on a miss.
        if (typeof PrecomputedScores !== 'undefined' && PrecomputedScores.isEnabled()) {
            const vb = { south: bounds.getSouth(), west: bounds.getWest(),
                north: bounds.getNorth(), east: bounds.getEast() };
            const cells = await PrecomputedScores.lookupViewport(vb);
            if (cells && cells.length) {
                _features = cells.map(c => {
                    const val = c.scores[scoreKey] && c.scores[scoreKey].value;
                    if (val == null) return null;
                    const color = colorFor(val, _reverse);
                    const b = c.bounds;
                    return {
                        type: 'Feature',
                        geometry: { type: 'Polygon', coordinates: [[
                            [b.west, b.south], [b.east, b.south], [b.east, b.north],
                            [b.west, b.north], [b.west, b.south],
                        ]] },
                        properties: { color, height: val * 5, score: val },
                    };
                }).filter(Boolean);
                // clear() may have run during the await — guard the source.
                const src = _map.getSource(SOURCE_ID);
                if (!src) return;
                src.setData({ type: 'FeatureCollection', features: _features });
                App.showToast('3D Heatmap Ready', `${scoreKey} from precomputed tiles — instant.`, 'success');
                return;
            }
        }

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

                const color = colorFor(val, _reverse);

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

    /** Abort any in-flight sampling, empty the overlay source, remove the legend, and reset state. */
    function clear() {
        if (_abortController) { _abortController.abort(); _abortController = null; }
        if (_map && _map.getSource(SOURCE_ID)) {
            _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
        }
        removeLegend();
        _features = [];
        _activeScore = null;
        _reverse = false;
    }

    /** Return the list of selectable score options for the heatmap. */
    function getOptions() { return SCORE_OPTIONS; }
    /** Return the currently active score key, or null if no overlay is shown. */
    function getActive() { return _activeScore; }

    return { show, clear, getOptions, getActive };
})();
