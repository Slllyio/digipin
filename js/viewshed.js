/**
 * Viewshed — line-of-sight / visibility analysis (map type #5).
 *
 * Reuses the AWS Terrarium DEM tile already used by FloodInundation
 * (https://s3.amazonaws.com/elevation-tiles-prod, free, CORS-enabled, where
 * elev = R*256 + G + B/256 - 32768 metres). From an observer at the current map
 * centre it decodes one z14 tile (256×256 ≈ 9 m/px elevation samples), runs a
 * per-target line-of-sight sweep, and paints visible terrain cyan / hidden
 * terrain dark via a MapLibre canvas source positioned at the tile bounds.
 *
 * computeViewshed() is a pure, side-effect-free function (testable in Vitest).
 * attach/detach are idempotent and clean up the layer, source, and live canvas.
 */
const Viewshed = (() => {
    const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
    const ZOOM = 14;
    const TILE_SIZE = 256;
    const SOURCE_ID = 'viewshed-src';
    const LAYER_ID  = 'viewshed-layer';
    const CANVAS_ID = 'viewshed-live-canvas';

    let _map = null;
    let _active = false;
    let _canvas = null;
    let _reqId = 0;   // guards against overlapping attach() races

    // ---------- pure viewshed ----------
    /** Compute visibility from (ox,oy) over an elevation grid.
     *  @param {Float32Array} elev  row-major heightmap, length width*height (metres)
     *  @param {object} opts { eyeM=1.7, radiusPx=120, metersPerPixel=9 }
     *  @returns {Uint8Array} mask length width*height: 1 visible, 0 hidden/out-of-range. */
    function computeViewshed(elev, width, height, ox, oy, opts = {}) {
        const eyeM = opts.eyeM != null ? opts.eyeM : 1.7;
        const radiusPx = opts.radiusPx != null ? opts.radiusPx : 120;
        const mpp = opts.metersPerPixel != null ? opts.metersPerPixel : 9;
        const mask = new Uint8Array(width * height);
        if (ox < 0 || oy < 0 || ox >= width || oy >= height) return mask;

        const eyeElev = elev[oy * width + ox] + eyeM;
        const EPS = 1e-6;
        mask[oy * width + ox] = 1;   // observer sees itself

        const x0 = Math.max(0, Math.floor(ox - radiusPx));
        const x1 = Math.min(width - 1, Math.ceil(ox + radiusPx));
        const y0 = Math.max(0, Math.floor(oy - radiusPx));
        const y1 = Math.min(height - 1, Math.ceil(oy + radiusPx));

        for (let ty = y0; ty <= y1; ty++) {
            for (let tx = x0; tx <= x1; tx++) {
                if (tx === ox && ty === oy) continue;
                const ddx = tx - ox, ddy = ty - oy;
                const distPx = Math.sqrt(ddx * ddx + ddy * ddy);
                if (distPx > radiusPx) continue;

                // Walk the ray observer→target, tracking the steepest slope so far.
                const steps = Math.ceil(distPx);
                let maxSlope = -Infinity;
                let visible = true;
                for (let s = 1; s < steps; s++) {
                    const f = s / steps;
                    const sx = Math.round(ox + ddx * f);
                    const sy = Math.round(oy + ddy * f);
                    const dMeters = distPx * f * mpp;
                    if (dMeters <= 0) continue;
                    const slope = (elev[sy * width + sx] - eyeElev) / dMeters;
                    if (slope > maxSlope) maxSlope = slope;
                }
                const targetSlope = (elev[ty * width + tx] - eyeElev) / (distPx * mpp);
                visible = targetSlope >= maxSlope - EPS;
                if (visible) mask[ty * width + tx] = 1;
            }
        }
        return mask;
    }

    function _metersPerPixel(lat, zoom) {
        return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    }

    // ---------- tile math (mirrors FloodInundation) ----------
    function _lngToTileX(lng, z) { return Math.floor(((lng + 180) / 360) * Math.pow(2, z)); }
    function _latToTileY(lat, z) {
        const r = lat * Math.PI / 180;
        return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
    }
    function _tileToLngLat(x, y, z) {
        const n = Math.pow(2, z);
        const lng = x / n * 360 - 180;
        const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
        return { lat: latRad * 180 / Math.PI, lng };
    }
    function _tileBounds(x, y, z) {
        const nw = _tileToLngLat(x, y, z);
        const se = _tileToLngLat(x + 1, y + 1, z);
        return { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
    }
    function _cellPixel(lat, lng, tileX, tileY, z) {
        const n = Math.pow(2, z);
        const px = ((lng + 180) / 360 * n - tileX) * TILE_SIZE;
        const r = lat * Math.PI / 180;
        const py = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n - tileY) * TILE_SIZE;
        return {
            x: Math.max(0, Math.min(TILE_SIZE - 1, Math.round(px))),
            y: Math.max(0, Math.min(TILE_SIZE - 1, Math.round(py))),
        };
    }
    function _fetchTile(x, y, z) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = TILE_SIZE; c.height = TILE_SIZE;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0);
                try { resolve(ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE)); }
                catch (e) { reject(e); }
            };
            img.onerror = () => reject(new Error('terrarium tile load failed'));
            img.src = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        });
    }
    function _decode(imageData) {
        const px = imageData.data;
        const elev = new Float32Array(TILE_SIZE * TILE_SIZE);
        for (let i = 0; i < elev.length; i++) {
            const o = i * 4;
            elev[i] = (px[o] * 256 + px[o + 1] + px[o + 2] / 256) - 32768;
        }
        return elev;
    }

    // Visible-cell fill, theme-aware: cyan on dark, coral on the paper theme.
    function _fillRGB() {
        const light = typeof Theme !== 'undefined' && Theme.get && Theme.get() === 'light';
        return light ? [194, 65, 12] : [34, 211, 238];
    }

    function _paint(mask) {
        const ctx = _canvas.getContext('2d');
        const img = ctx.createImageData(TILE_SIZE, TILE_SIZE);
        const px = img.data;
        const [r, g, b] = _fillRGB();
        for (let i = 0; i < mask.length; i++) {
            const o = i * 4;
            if (mask[i] === 1) { px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 120; } // visible
            else { px[o + 3] = 0; }
        }
        ctx.putImageData(img, 0, 0);
    }

    // ---------- public API ----------
    async function attach() {
        if (typeof MapModule === 'undefined') return;
        _map = MapModule.getMap();
        if (!_map) return;
        detach();
        _active = true;
        const reqId = ++_reqId;

        const c = _map.getCenter();
        const lat = c.lat, lng = c.lng;
        const tileX = _lngToTileX(lng, ZOOM);
        const tileY = _latToTileY(lat, ZOOM);

        if (typeof App !== 'undefined') {
            App.showToast('Viewshed', 'Computing line-of-sight from map centre…', 'info');
        }

        let imageData;
        try {
            imageData = await _fetchTile(tileX, tileY, ZOOM);
        } catch (e) {
            console.warn('Viewshed: DEM tile fetch failed', e);
            if (typeof App !== 'undefined') App.showToast('Viewshed unavailable', 'Could not load the elevation tile for this area.', 'error');
            _active = false;
            return;
        }
        if (reqId !== _reqId) return;   // superseded by a newer attach()

        const elev = _decode(imageData);
        const obs = _cellPixel(lat, lng, tileX, tileY, ZOOM);
        const mask = computeViewshed(elev, TILE_SIZE, TILE_SIZE, obs.x, obs.y, {
            eyeM: 1.7,
            radiusPx: 120,
            metersPerPixel: _metersPerPixel(lat, ZOOM),
        });

        _canvas = document.createElement('canvas');
        _canvas.id = CANVAS_ID;
        _canvas.width = TILE_SIZE; _canvas.height = TILE_SIZE;
        _canvas.style.display = 'none';
        document.body.appendChild(_canvas);
        _paint(mask);

        const b = _tileBounds(tileX, tileY, ZOOM);
        _map.addSource(SOURCE_ID, {
            type: 'canvas',
            canvas: CANVAS_ID,
            coordinates: [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south]],
            animate: false,
        });
        _map.addLayer({
            id: LAYER_ID,
            type: 'raster',
            source: SOURCE_ID,
            paint: { 'raster-opacity': 1, 'raster-resampling': 'nearest' },
        });
    }

    function detach() {
        _active = false;
        _reqId++;
        if (_map) {
            if (_map.getLayer(LAYER_ID)) _map.removeLayer(LAYER_ID);
            if (_map.getSource(SOURCE_ID)) _map.removeSource(SOURCE_ID);
        }
        if (_canvas) { _canvas.remove(); _canvas = null; }
    }

    function toggle() { if (_active) detach(); else attach(); }

    return { attach, detach, toggle, computeViewshed };
})();

if (typeof window !== 'undefined') window.Viewshed = Viewshed;
