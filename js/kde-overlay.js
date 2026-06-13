/**
 * KDEOverlay — Kernel Density / Hotspot surface (map type #3).
 *
 * Upgrades the blocky point-heatmap to a smooth Gaussian kernel-density
 * surface. Grid-samples a chosen intelligence score across the viewport
 * (reusing the HeatmapOverlay sampling pattern), then evaluates a weighted
 * 2-D Gaussian KDE on a fine render raster and paints it to a MapLibre canvas
 * source pinned at the viewport bounds (same canvas pattern as FloodInundation
 * / Viewshed).
 *
 * The kernel maths (gaussian, kdeAt) are pure and unit-tested. attach/detach
 * are idempotent and clean up the layer, source, live canvas, and any in-flight
 * sampling run (per-run AbortController ownership).
 *
 * The surface is computed for the view at attach time and pinned to those
 * bounds; re-toggle after panning to recompute (matches the static-tile
 * overlays). Idempotent.
 */
const KDEOverlay = (() => {
    const SOURCE_ID = 'kde-overlay-src';
    const LAYER_ID  = 'kde-overlay-layer';
    const CANVAS_ID = 'kde-overlay-canvas';

    const GRID = 8;          // sampling grid (GRID×GRID fetched cells)
    const RENDER = 96;       // KDE render raster (RENDER×RENDER px)
    const BANDWIDTH = 0.13;  // Gaussian bandwidth in normalised [0,1] viewport units

    const SCORE_OPTIONS = [
        { key: 'commercial', label: 'Commercial' },
        { key: 'population_proxy', label: 'Population' },
        { key: 'food_diversity', label: 'Food Diversity' },
        { key: 'livability', label: 'Livability' },
        { key: 'safety', label: 'Safety' },
        { key: 'green', label: 'Green Index' },
        { key: 'connectivity', label: 'Connectivity' },
        { key: 'healthcare_access', label: 'Healthcare' },
        { key: 'walkability', label: 'Walkability' },
    ];

    let _map = null;
    let _active = false;
    let _canvas = null;
    let _abort = null;
    let _scoreKey = 'commercial';

    // ---------- pure KDE maths ----------
    /** Unnormalised Gaussian of a squared distance. invTwoBw2 = 1/(2·bw²). */
    function gaussian(d2, invTwoBw2) { return Math.exp(-d2 * invTwoBw2); }

    /** Weighted 2-D KDE at normalised point (nx,ny) over samples
     *  [{x,y,w}] (all in [0,1]). Returns the summed weighted density. */
    function kdeAt(nx, ny, samples, bandwidth) {
        const invTwoBw2 = 1 / (2 * bandwidth * bandwidth);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            const dx = nx - samples[i].x;
            const dy = ny - samples[i].y;
            sum += (samples[i].w != null ? samples[i].w : 1) * gaussian(dx * dx + dy * dy, invTwoBw2);
        }
        return sum;
    }

    // ---------- colour ramp (transparent → blue → cyan → yellow → red) ----------
    function _ramp(t) {
        // t in [0,1]; alpha fades in over the low end so empty areas stay clear.
        const stops = [
            [0.00, [13, 27, 62, 0]],
            [0.20, [33, 102, 172, 90]],
            [0.45, [103, 169, 207, 150]],
            [0.65, [253, 219, 99, 190]],
            [0.85, [244, 109, 67, 210]],
            [1.00, [178, 24, 43, 230]],
        ];
        for (let i = 1; i < stops.length; i++) {
            if (t <= stops[i][0]) {
                const [t0, c0] = stops[i - 1];
                const [t1, c1] = stops[i];
                const f = (t - t0) / (t1 - t0 || 1);
                return [
                    Math.round(c0[0] + (c1[0] - c0[0]) * f),
                    Math.round(c0[1] + (c1[1] - c0[1]) * f),
                    Math.round(c0[2] + (c1[2] - c0[2]) * f),
                    Math.round(c0[3] + (c1[3] - c0[3]) * f),
                ];
            }
        }
        return stops[stops.length - 1][1];
    }

    function _paint(samples) {
        const ctx = _canvas.getContext('2d');
        const img = ctx.createImageData(RENDER, RENDER);
        const px = img.data;

        // First pass: raw densities + max for normalisation.
        const dens = new Float32Array(RENDER * RENDER);
        let max = 0;
        for (let py = 0; py < RENDER; py++) {
            for (let pxd = 0; pxd < RENDER; pxd++) {
                // canvas y grows downward; sample-space y (lat) grows upward → flip.
                const nx = (pxd + 0.5) / RENDER;
                const ny = 1 - (py + 0.5) / RENDER;
                const v = kdeAt(nx, ny, samples, BANDWIDTH);
                dens[py * RENDER + pxd] = v;
                if (v > max) max = v;
            }
        }
        const inv = max > 0 ? 1 / max : 0;
        for (let i = 0; i < dens.length; i++) {
            const [r, g, b, a] = _ramp(dens[i] * inv);
            const o = i * 4;
            px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
        }
        ctx.putImageData(img, 0, 0);
    }

    function _labelFor(key) {
        return (SCORE_OPTIONS.find(o => o.key === key) || {}).label || key;
    }

    async function _run() {
        if (_abort) _abort.abort();
        const myAbort = new AbortController();
        _abort = myAbort;

        const bounds = _map.getBounds();
        const south = bounds.getSouth(), north = bounds.getNorth();
        const west = bounds.getWest(), east = bounds.getEast();
        const latSpan = north - south, lngSpan = east - west;
        const latStep = latSpan / GRID, lngStep = lngSpan / GRID;

        const points = [];
        for (let i = 0; i < GRID; i++) {
            for (let j = 0; j < GRID; j++) {
                points.push({
                    lat: south + latStep * (i + 0.5),
                    lng: west + lngStep * (j + 0.5),
                });
            }
        }

        if (typeof App !== 'undefined') {
            App.showToast('Hotspot (KDE)', `Sampling ${points.length} cells for ${_labelFor(_scoreKey)}…`, 'info');
        }

        const samples = [];
        for (let batch = 0; batch < points.length; batch += 8) {
            if (myAbort.signal.aborted) return;
            const chunk = points.slice(batch, batch + 8);
            const results = await Promise.allSettled(
                chunk.map(pt => DataFetcher.fetchAllFeatures(pt.lat, pt.lng, 400))
            );
            results.forEach((r, idx) => {
                if (r.status !== 'fulfilled') return;
                const w = r.value.scores?.[_scoreKey]?.value;
                if (w == null || !Number.isFinite(w) || w <= 0) return;
                const pt = chunk[idx];
                samples.push({
                    x: (pt.lng - west) / (lngSpan || 1),
                    y: (pt.lat - south) / (latSpan || 1),
                    w,
                });
            });
            if (batch + 8 < points.length) await new Promise(r => setTimeout(r, 200));
        }
        if (myAbort.signal.aborted) return;

        if (samples.length === 0) {
            if (typeof App !== 'undefined') App.showToast('Hotspot (KDE)', 'No data in view for this score.', 'error');
            return;
        }

        // (Re)create the canvas + source pinned to the bounds we sampled.
        if (_canvas) { _canvas.remove(); _canvas = null; }
        _canvas = document.createElement('canvas');
        _canvas.id = CANVAS_ID;
        _canvas.width = RENDER; _canvas.height = RENDER;
        _canvas.style.display = 'none';
        document.body.appendChild(_canvas);
        _paint(samples);

        if (_map.getLayer(LAYER_ID)) _map.removeLayer(LAYER_ID);
        if (_map.getSource(SOURCE_ID)) _map.removeSource(SOURCE_ID);
        _map.addSource(SOURCE_ID, {
            type: 'canvas',
            canvas: CANVAS_ID,
            coordinates: [[west, north], [east, north], [east, south], [west, south]],
            animate: false,
        });
        _map.addLayer({
            id: LAYER_ID,
            type: 'raster',
            source: SOURCE_ID,
            paint: { 'raster-opacity': 0.75, 'raster-resampling': 'linear' },
        });

        if (typeof App !== 'undefined') {
            App.showToast('Hotspot Ready', `${_labelFor(_scoreKey)} kernel-density surface (${samples.length} cells).`, 'success');
        }
    }

    function setScore(key) { _scoreKey = key; if (_active) _run(); }

    function attach() {
        if (typeof MapModule === 'undefined') return;
        _map = MapModule.getMap();
        if (!_map) return;
        _active = true;
        _run();
    }

    function detach() {
        _active = false;
        if (_abort) { _abort.abort(); _abort = null; }
        if (_map) {
            if (_map.getLayer(LAYER_ID)) _map.removeLayer(LAYER_ID);
            if (_map.getSource(SOURCE_ID)) _map.removeSource(SOURCE_ID);
        }
        if (_canvas) { _canvas.remove(); _canvas = null; }
    }

    function toggle() { if (_active) detach(); else attach(); }

    return { attach, detach, toggle, setScore, gaussian, kdeAt, getScoreOptions: () => SCORE_OPTIONS.slice() };
})();

if (typeof window !== 'undefined') window.KDEOverlay = KDEOverlay;
