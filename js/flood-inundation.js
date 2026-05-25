/**
 * FloodInundation — DEM-driven animated flood polygon on the MapLibre map.
 *
 * Upgrade from the previous 16-point ring model: now uses **AWS Terrarium
 * elevation tiles**, a free no-auth DEM raster served as PNG where each
 * pixel encodes elevation via `elev = (R*256 + G + B/256) - 32768` metres.
 * One tile = 256×256 = **65,536 elevation samples** at ~9 m resolution
 * for zoom 14. Same single HTTP request as the previous version, 4096×
 * more terrain data.
 *
 * Pipeline (per cell):
 *   1. Compute which tile contains the cell at zoom 14
 *   2. Fetch the tile PNG with crossOrigin='anonymous' (AWS sends
 *      Access-Control-Allow-Origin: * when the Origin header is present)
 *   3. Draw to an offscreen canvas, getImageData, decode every pixel
 *      to an elevation (Float32Array of length 65536)
 *   4. For each of the 7 forecast days, build a frame canvas (256×256):
 *      every pixel where elev < cell_elev + day_depth gets the day's
 *      risk color with alpha=140/255; everything else is transparent
 *   5. Create a MapLibre `canvas` source positioned at the tile's
 *      geographic bounds; animate by drawing the right frame canvas
 *      into the live canvas every 350 ms
 *
 * Cleanup: detach() removes the layer + source + the live canvas DOM
 * node. Idempotent.
 */

const FloodInundation = (() => {
    const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
    const ZOOM = 14;
    const TILE_SIZE = 256;
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

    // ---------- tile math ----------
    function _lngToTileX(lng, zoom) {
        return Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
    }
    function _latToTileY(lat, zoom) {
        const radians = lat * Math.PI / 180;
        return Math.floor(
            (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * Math.pow(2, zoom)
        );
    }
    function _tileToLngLat(x, y, zoom) {
        const n = Math.pow(2, zoom);
        const lng = x / n * 360 - 180;
        const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
        return { lat: latRad * 180 / Math.PI, lng };
    }

    function _tileBounds(x, y, zoom) {
        const nw = _tileToLngLat(x,     y,     zoom);
        const se = _tileToLngLat(x + 1, y + 1, zoom);
        return { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
    }

    function _cellPixelInTile(lat, lng, tileX, tileY, zoom) {
        const n = Math.pow(2, zoom);
        const px = ((lng + 180) / 360 * n - tileX) * TILE_SIZE;
        const radians = lat * Math.PI / 180;
        const py = ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * n - tileY) * TILE_SIZE;
        return {
            x: Math.max(0, Math.min(TILE_SIZE - 1, Math.round(px))),
            y: Math.max(0, Math.min(TILE_SIZE - 1, Math.round(py))),
        };
    }

    // ---------- DEM fetch + decode ----------
    function _fetchTerrainTile(x, y, zoom) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = TILE_SIZE;
                c.height = TILE_SIZE;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0);
                try {
                    const data = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
                    resolve(data);
                } catch (e) {
                    reject(e); // canvas tainted — fallback path
                }
            };
            img.onerror = () => reject(new Error('terrarium tile load failed'));
            img.src = TILE_URL.replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
        });
    }

    function _decodeElevations(imageData) {
        const px = imageData.data;
        const elev = new Float32Array(TILE_SIZE * TILE_SIZE);
        for (let i = 0; i < elev.length; i++) {
            const o = i * 4;
            elev[i] = (px[o] * 256 + px[o + 1] + px[o + 2] / 256) - 32768;
        }
        return elev;
    }

    // ---------- frame building ----------
    function _hexToRgb(hex) {
        const s = hex.replace('#', '');
        return [
            parseInt(s.substr(0, 2), 16),
            parseInt(s.substr(2, 2), 16),
            parseInt(s.substr(4, 2), 16),
        ];
    }

    function _buildFrameCanvas(elev, cellElev, depth, color) {
        const c = document.createElement('canvas');
        c.width = TILE_SIZE;
        c.height = TILE_SIZE;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(TILE_SIZE, TILE_SIZE);
        const px = img.data;
        const [r, g, b] = _hexToRgb(color);
        const threshold = cellElev + depth;
        for (let i = 0; i < elev.length; i++) {
            const o = i * 4;
            if (elev[i] < threshold) {
                px[o]     = r;
                px[o + 1] = g;
                px[o + 2] = b;
                px[o + 3] = 140;
            } else {
                px[o + 3] = 0;
            }
        }
        ctx.putImageData(img, 0, 0);
        return c;
    }

    // ---------- MapLibre wiring ----------
    function _setupMapLayer(map, bounds) {
        if (_liveCanvas) {
            _liveCanvas.remove();
            _liveCanvas = null;
        }
        _liveCanvas = document.createElement('canvas');
        _liveCanvas.id = CANVAS_ID;
        _liveCanvas.width = TILE_SIZE;
        _liveCanvas.height = TILE_SIZE;
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
            paint: { 'raster-opacity': 1, 'raster-resampling': 'linear' },
        });
    }

    function _drawFrame(idx) {
        if (!_liveCanvas || !_frameCanvases[idx]) return;
        const ctx = _liveCanvas.getContext('2d');
        ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
        ctx.drawImage(_frameCanvases[idx], 0, 0);
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
        const tileX = _lngToTileX(lng, ZOOM);
        const tileY = _latToTileY(lat, ZOOM);

        let imageData;
        try {
            imageData = await _fetchTerrainTile(tileX, tileY, ZOOM);
        } catch (e) {
            // Tile fetch failed (CORS, network, missing tile). Silently noop
            // — the sparkline widget is still useful on its own.
            console.warn('FloodInundation: tile fetch failed', e);
            return;
        }
        if (_attachedCellCode !== cell.code) return;

        const elev = _decodeElevations(imageData);
        const px = _cellPixelInTile(lat, lng, tileX, tileY, ZOOM);
        const cellElev = elev[px.y * TILE_SIZE + px.x];

        _frameCanvases = forecast.days.map(day => {
            const ratio = day.discharge / forecast.baseline_m3s;
            const depth = Math.max(0, (ratio - 1) * DEPTH_PER_RATIO);
            return _buildFrameCanvas(elev, cellElev, depth, day.risk_color);
        });
        _frameIdx = 0;

        const bounds = _tileBounds(tileX, tileY, ZOOM);
        _setupMapLayer(map, bounds);
        _drawFrame(0);

        _animTimer = setInterval(() => {
            _frameIdx = (_frameIdx + 1) % _frameCanvases.length;
            _drawFrame(_frameIdx);
        }, FRAME_MS);
    }

    function detach() {
        if (_animTimer) {
            clearInterval(_animTimer);
            _animTimer = null;
        }
        _attachedCellCode = null;
        _frameCanvases = [];
        _frameIdx = 0;

        if (typeof MapModule !== 'undefined') {
            const map = MapModule.getMap();
            if (map) {
                if (map.getLayer(LAYER_ID))  map.removeLayer(LAYER_ID);
                if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
            }
        }
        if (_liveCanvas) {
            _liveCanvas.remove();
            _liveCanvas = null;
        }
    }

    return { attach, detach };
})();

if (typeof window !== 'undefined') {
    window.FloodInundation = FloodInundation;
}
