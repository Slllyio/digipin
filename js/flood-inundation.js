/**
 * FloodInundation — DEM-driven animated flood polygon on the MapLibre map.
 *
 * Why this was rewritten: the previous version read AWS Terrarium elevation
 * PNG tiles via an <img crossOrigin="anonymous"> + canvas.getImageData()
 * pipeline. That bucket serves the tiles fine but sends **no
 * Access-Control-Allow-Origin header**, so the browser fails the cross-origin
 * image load outright — the inundation overlay silently never appeared.
 *
 * This version samples elevation from the **Open-Meteo Elevation API**
 * (https://api.open-meteo.com/v1/elevation) — the same provider as the flood
 * forecast, free, no key, and CORS-enabled (ACAO: *). It pulls a GRID×GRID
 * grid of real elevations around the cell, bilinearly upsamples it to a smooth
 * field, and floods every point below `cell_elev + day_depth`.
 *
 * Pipeline (per cell):
 *   1. Build a GRID×GRID lat/lng grid over a ~2 km box around the cell
 *   2. Fetch elevations in ≤100-point batches (the API's per-request cap)
 *   3. Bilinearly upsample the coarse grid to a FIELD×FIELD elevation field
 *   4. For each of the 7 forecast days, build a frame canvas: every field
 *      cell below the day's water level gets the day's risk colour
 *   5. Drive a MapLibre `canvas` source (linear-resampled) at the grid's
 *      geographic bounds, animating one frame per day every 350 ms
 *
 * Cleanup: detach() removes the layer + source + live canvas. Idempotent.
 * Pure helpers (grid math, bilinear, frame build) are exported for testing.
 */

const FloodInundation = (() => {
    const ELEV_URL = 'https://api.open-meteo.com/v1/elevation';
    const GRID = 16;                 // sampled elevation grid (16×16 = 256 points)
    const FIELD = 96;                // upsampled render resolution (smooth contours)
    const HALF_LAT_DEG = 0.011;      // ~1.2 km half-height of the sampled box
    const MAX_BATCH = 100;           // Open-Meteo elevation per-request location cap
    const FRAME_MS = 350;
    const DEPTH_PER_RATIO = 2.5;     // metres of effective rise per unit ratio above baseline

    const SOURCE_ID = 'flood-inundation-src';
    const LAYER_ID  = 'flood-inundation-layer';
    const CANVAS_ID = 'flood-inundation-live-canvas';

    let _animTimer = null;
    let _attachedCellCode = null;
    let _frameCanvases = [];
    let _frameIdx = 0;
    let _liveCanvas = null;
    // Cache the upsampled field + cell elevation + forecast so perturb() can
    // rebuild frames on the rainfall slider without re-fetching elevations.
    let _state = null;   // { field, cellElev, forecast }

    // ---------- pure geometry / sampling ----------
    /** GRID×GRID grid of lat/lng over a box around (lat,lng), row 0 = north. */
    function gridPoints(lat, lng, g = GRID, halfLat = HALF_LAT_DEG) {
        const halfLng = halfLat / Math.max(0.05, Math.cos(lat * Math.PI / 180));
        const north = lat + halfLat, south = lat - halfLat;
        const west = lng - halfLng, east = lng + halfLng;
        const lats = [], lngs = [];
        for (let i = 0; i < g; i++) {
            const la = north - (north - south) * (i / (g - 1));
            for (let j = 0; j < g; j++) {
                lats.push(la);
                lngs.push(west + (east - west) * (j / (g - 1)));
            }
        }
        return { lats, lngs, bounds: { north, south, west, east } };
    }

    /** Bilinear sample of a g×g grid (row-major) at fractional (col u, row v). */
    function bilinear(grid, g, u, v) {
        u = Math.max(0, Math.min(g - 1, u));
        v = Math.max(0, Math.min(g - 1, v));
        const x0 = Math.floor(u), y0 = Math.floor(v);
        const x1 = Math.min(g - 1, x0 + 1), y1 = Math.min(g - 1, y0 + 1);
        const fx = u - x0, fy = v - y0;
        const a = grid[y0 * g + x0], b = grid[y0 * g + x1];
        const c = grid[y1 * g + x0], d = grid[y1 * g + x1];
        return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy)
             + c * (1 - fx) * fy + d * fx * fy;
    }

    /** Upsample a g×g grid to an r×r field (Float32Array) via bilinear interp. */
    function upsample(grid, g, r = FIELD) {
        const field = new Float32Array(r * r);
        for (let y = 0; y < r; y++) {
            const v = (y / (r - 1)) * (g - 1);
            for (let x = 0; x < r; x++) {
                const u = (x / (r - 1)) * (g - 1);
                field[y * r + x] = bilinear(grid, g, u, v);
            }
        }
        return field;
    }

    // ---------- elevation fetch ----------
    async function _fetchElevations(lats, lngs) {
        const out = new Float32Array(lats.length);
        for (let start = 0; start < lats.length; start += MAX_BATCH) {
            const la = lats.slice(start, start + MAX_BATCH);
            const ln = lngs.slice(start, start + MAX_BATCH);
            const url = `${ELEV_URL}?latitude=${la.join(',')}&longitude=${ln.join(',')}`;
            const r = await fetch(url, { cache: 'no-store' });
            if (!r.ok) throw new Error(`elevation API ${r.status}`);
            const payload = await r.json();
            const elev = payload && payload.elevation;
            if (!Array.isArray(elev)) throw new Error('elevation API: no data');
            if (elev.length !== la.length) {
                throw new Error(`elevation API: expected ${la.length} points, got ${elev.length}`);
            }
            for (let k = 0; k < elev.length; k++) {
                const v = Number(elev[k]);
                if (!Number.isFinite(v)) throw new Error('elevation API: non-numeric value');
                out[start + k] = v;
            }
        }
        return out;
    }

    // ---------- frame building ----------
    function _hexToRgb(hex) {
        const s = hex.replace('#', '');
        return [parseInt(s.substr(0, 2), 16), parseInt(s.substr(2, 2), 16), parseInt(s.substr(4, 2), 16)];
    }

    /** Build a FIELD×FIELD frame: cells below the water level get the risk
     *  colour, with a touch of edge softening so the shoreline reads as water. */
    function buildFrameCanvas(field, r, cellElev, depth, color) {
        const c = document.createElement('canvas');
        c.width = r; c.height = r;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(r, r);
        const px = img.data;
        const [rr, gg, bb] = _hexToRgb(color);
        const level = cellElev + depth;
        for (let i = 0; i < field.length; i++) {
            const o = i * 4;
            const below = level - field[i];   // metres under water (>0 = flooded)
            if (below > 0) {
                px[o] = rr; px[o + 1] = gg; px[o + 2] = bb;
                // deeper water = more opaque (0.5 m → faint edge, ≥3 m → solid)
                px[o + 3] = Math.round(90 + Math.min(1, below / 3) * 110);
            } else {
                px[o + 3] = 0;
            }
        }
        ctx.putImageData(img, 0, 0);
        return c;
    }

    // ---------- MapLibre wiring ----------
    function _setupMapLayer(map, bounds) {
        if (_liveCanvas) { _liveCanvas.remove(); _liveCanvas = null; }
        _liveCanvas = document.createElement('canvas');
        _liveCanvas.id = CANVAS_ID;
        _liveCanvas.width = FIELD;
        _liveCanvas.height = FIELD;
        _liveCanvas.style.display = 'none';
        document.body.appendChild(_liveCanvas);

        map.addSource(SOURCE_ID, {
            type: 'canvas',
            canvas: CANVAS_ID,
            coordinates: [
                [bounds.west, bounds.north],
                [bounds.east, bounds.north],
                [bounds.east, bounds.south],
                [bounds.west, bounds.south],
            ],
            animate: true,
        });
        map.addLayer({
            id: LAYER_ID,
            type: 'raster',
            source: SOURCE_ID,
            paint: { 'raster-opacity': 0.85, 'raster-resampling': 'linear' },
        });
    }

    /** Blit the pre-rendered frame `idx` onto the live source canvas. */
    function _drawFrame(idx) {
        if (!_liveCanvas || !_frameCanvases[idx]) return;
        const ctx = _liveCanvas.getContext('2d');
        ctx.clearRect(0, 0, FIELD, FIELD);
        ctx.drawImage(_frameCanvases[idx], 0, 0);
    }

    /** Rebuild the per-day frame canvases from cached state, adding `extraDepthM` of rise. */
    function _rebuildFrames(extraDepthM) {
        if (!_state) return;
        const { field, cellElev, forecast } = _state;
        const baseline = Number(forecast.baseline_m3s);
        const safeBaseline = (Number.isFinite(baseline) && baseline > 0) ? baseline : null;
        _frameCanvases = forecast.days.map(day => {
            const discharge = Number(day.discharge);
            const ratio = (safeBaseline && Number.isFinite(discharge)) ? discharge / safeBaseline : 1;
            const baseDepth = Math.max(0, (ratio - 1) * DEPTH_PER_RATIO);
            const totalDepth = baseDepth + Math.max(0, extraDepthM || 0);
            return buildFrameCanvas(field, FIELD, cellElev, totalDepth, day.risk_color);
        });
    }

    // ---------- public API ----------
    async function attach(cell, forecast) {
        if (!cell || !forecast || !forecast.days?.length) return;
        if (typeof MapModule === 'undefined') return;
        const map = MapModule.getMap();
        if (!map) return;

        detach();
        _attachedCellCode = cell.code;

        const { lat, lng } = cell.center;
        const { lats, lngs, bounds } = gridPoints(lat, lng);

        let elev;
        try {
            elev = await _fetchElevations(lats, lngs);
        } catch (e) {
            console.warn('FloodInundation: elevation fetch failed', e);
            if (typeof App !== 'undefined') {
                App.showToast('Flood map', 'Elevation data unavailable right now', 'warning');
            }
            return;
        }
        if (_attachedCellCode !== cell.code) return;   // cell changed mid-fetch

        const field = upsample(elev, GRID, FIELD);
        const cellElev = bilinear(elev, GRID, (GRID - 1) / 2, (GRID - 1) / 2);

        _state = { field, cellElev, forecast };
        _rebuildFrames(0);
        _frameIdx = 0;

        _setupMapLayer(map, bounds);
        _drawFrame(0);

        _animTimer = setInterval(() => {
            _frameIdx = (_frameIdx + 1) % _frameCanvases.length;
            _drawFrame(_frameIdx);
        }, FRAME_MS);
    }

    /** Apply extra flood depth (metres) on top of the forecast depth and
     *  re-render. Called by the rainfall what-if slider. */
    function perturb(extraDepthM) {
        if (!_state || !_liveCanvas) return;
        _rebuildFrames(extraDepthM);
        _drawFrame(_frameIdx);
    }

    /** Stop the animation and remove the layer, source, and live canvas. Idempotent. */
    function detach() {
        if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
        _attachedCellCode = null;
        _frameCanvases = [];
        _frameIdx = 0;
        _state = null;

        if (typeof MapModule !== 'undefined') {
            const map = MapModule.getMap();
            if (map) {
                if (map.getLayer(LAYER_ID))  map.removeLayer(LAYER_ID);
                if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
            }
        }
        if (_liveCanvas) { _liveCanvas.remove(); _liveCanvas = null; }
    }

    return { attach, detach, perturb,
        gridPoints, bilinear, upsample, buildFrameCanvas };
})();

if (typeof window !== 'undefined') {
    window.FloodInundation = FloodInundation;
}
