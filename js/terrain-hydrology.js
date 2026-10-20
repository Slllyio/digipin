/**
 * TerrainHydrology — where rain ponds and runs, from the DEM, in the browser.
 *
 * Mosaics the AWS Terrarium DEM tiles under the view (z13, ~18 m/px over
 * India), writes them as a GeoTIFF and runs Whitebox hydrology tools on it
 * through geolibre-wasm (opengeos/geolibre-rust, MIT; Whitebox Next Gen
 * compiled to WebAssembly) inside a worker:
 *
 *   depth_in_sink                 ponding depth in closed depressions (m)
 *   breach_depressions_least_cost → d8_flow_accum (sca)   upslope area / width
 *   slope (degrees)               → wetness_index (TWI)
 *
 * The result is painted as a raster of ponding depth and registered with
 * CellStore as a DIGIPIN L8 dataset, so CellLayers draws every field in 2D or
 * as 3D extruded cells and it joins other cell data by code.
 *
 * The runtime (~24 MB wasm) loads from jsDelivr on first use only.
 * Pure helpers (tileRange, decodeTerrarium, mosaic, writeGeoTiff, toRecords)
 * are unit-tested; attach/detach follow the overlay contract and are idempotent.
 */
const TerrainHydrology = (() => {
    const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
    const PKG = 'https://cdn.jsdelivr.net/npm/geolibre-wasm@1.7.1/';
    const ZOOM = 13;
    const TILE = 256;
    const MAX_TILES = 3;            // per side → at most 768×768 px (~14 km at Indore)
    const LEVEL = 8;                // ~61 m DIGIPIN cells
    const DATASET_ID = 'terrain_hydrology';
    const SOURCE_ID = 'terrain-hydrology-src';
    const LAYER_ID = 'terrain-hydrology-layer';
    const CANVAS_ID = 'terrain-hydrology-canvas';
    const NODATA = -32768;
    const EARTH = 40075016.68557849; // web-mercator world width (m)
    // SRTM heights are whole metres, so shallower "sinks" are mostly noise.
    const POND_MIN_M = 0.5;

    let _map = null;
    let _active = false;
    let _canvas = null;
    let _reqId = 0;
    let _worker = null;
    let _jobs = 0;
    const _pending = new Map();

    // ---------- pure: tiles and DEM ----------

    function lngToX(lng, z) { return ((lng + 180) / 360) * Math.pow(2, z); }
    function latToY(lat, z) {
        const r = lat * Math.PI / 180;
        return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
    }
    function yToLat(y, z) {
        return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / Math.pow(2, z)))) * 180 / Math.PI;
    }
    function xToLng(x, z) { return x / Math.pow(2, z) * 360 - 180; }

    /**
     * Tile window covering bbox {west,south,east,north} at zoom z, shrunk
     * around its centre to at most `max` tiles per side.
     * @returns {{x0,y0,nx,ny,z}}
     */
    function tileRange(bbox, z = ZOOM, max = MAX_TILES) {
        let x0 = Math.floor(lngToX(bbox.west, z)), x1 = Math.floor(lngToX(bbox.east, z));
        let y0 = Math.floor(latToY(bbox.north, z)), y1 = Math.floor(latToY(bbox.south, z));
        const clamp = (a, b) => {
            if (b - a + 1 <= max) return [a, b];
            const mid = Math.floor((a + b) / 2);
            const lo = mid - Math.floor((max - 1) / 2);
            return [lo, lo + max - 1];
        };
        [x0, x1] = clamp(x0, x1);
        [y0, y1] = clamp(y0, y1);
        return { x0, y0, nx: x1 - x0 + 1, ny: y1 - y0 + 1, z };
    }

    /** Terrarium RGBA → metres: R*256 + G + B/256 − 32768. */
    function decodeTerrarium(rgba, n = rgba.length / 4) {
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const o = i * 4;
            out[i] = rgba[o] * 256 + rgba[o + 1] + rgba[o + 2] / 256 - 32768;
        }
        return out;
    }

    /** Stitch per-tile Float32Arrays (row-major, tiles[ty][tx]) into one grid. */
    function mosaic(tiles, nx, ny, size = TILE) {
        const w = nx * size, h = ny * size;
        const out = new Float32Array(w * h);
        for (let ty = 0; ty < ny; ty++) {
            for (let tx = 0; tx < nx; tx++) {
                const t = tiles[ty][tx];
                for (let r = 0; r < size; r++) {
                    const dst = (ty * size + r) * w + tx * size;
                    if (t) out.set(t.subarray(r * size, (r + 1) * size), dst);
                    else out.fill(NODATA, dst, dst + size);
                }
            }
        }
        return { data: out, width: w, height: h };
    }

    /** Web-mercator origin (upper-left, metres) and pixel size for a tile window. */
    function mercatorGeo(range, size = TILE) {
        const n = Math.pow(2, range.z);
        const px = EARTH / (n * size);
        return { x0: range.x0 * EARTH / n - EARTH / 2, y0: EARTH / 2 - range.y0 * EARTH / n, px };
    }

    /**
     * Minimal single-strip, uncompressed Float32 GeoTIFF (little-endian),
     * north-up, PixelIsArea, for an EPSG code that is projected (3857) or
     * geographic (4326).
     */
    function writeGeoTiff(data, width, height, { x0, y0, px, epsg = 3857, nodata = NODATA }) {
        const geographic = epsg === 4326;
        const geoKeys = [1, 1, 0, 3,
            1024, 0, 1, geographic ? 2 : 1,
            1025, 0, 1, 1,
            geographic ? 2048 : 3072, 0, 1, epsg];
        const nodataStr = String(nodata) + '\0';
        // [tag, type, count, values]; types: 2 ASCII, 3 SHORT, 4 LONG, 12 DOUBLE
        const entries = [
            [256, 4, 1, [width]], [257, 4, 1, [height]], [258, 3, 1, [32]], [259, 3, 1, [1]],
            [262, 3, 1, [1]], [273, 4, 1, [0]], [277, 3, 1, [1]], [278, 4, 1, [height]],
            [279, 4, 1, [width * height * 4]], [284, 3, 1, [1]], [339, 3, 1, [3]],
            [33550, 12, 3, [px, px, 0]], [33922, 12, 6, [0, 0, 0, x0, y0, 0]],
            [34735, 3, geoKeys.length, geoKeys], [42113, 2, nodataStr.length, nodataStr],
        ];
        const SIZE = { 2: 1, 3: 2, 4: 4, 12: 8 };
        const ifdLen = 2 + entries.length * 12 + 4;
        let extra = 8 + ifdLen;
        const extraAt = entries.map(([, type, count]) => {
            const bytes = SIZE[type] * count;
            if (bytes <= 4) return -1;
            const at = extra;
            extra += bytes + (bytes % 2);
            return at;
        });
        const dataAt = extra + (extra % 4 ? 4 - (extra % 4) : 0);
        entries[5][3] = [dataAt];
        const buf = new ArrayBuffer(dataAt + width * height * 4);
        const dv = new DataView(buf);
        dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
        dv.setUint16(8, entries.length, true);
        const put = (at, type, vals) => {
            for (let i = 0; i < vals.length; i++) {
                const o = at + i * SIZE[type];
                if (type === 2) dv.setUint8(o, vals.charCodeAt(i));
                else if (type === 3) dv.setUint16(o, vals[i], true);
                else if (type === 4) dv.setUint32(o, vals[i], true);
                else dv.setFloat64(o, vals[i], true);
            }
        };
        entries.forEach(([tag, type, count, vals], i) => {
            const e = 10 + i * 12;
            dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true);
            if (extraAt[i] < 0) put(e + 8, type, vals);
            else { dv.setUint32(e + 8, extraAt[i], true); put(extraAt[i], type, vals); }
        });
        dv.setUint32(10 + entries.length * 12, 0, true);
        new Float32Array(buf, dataAt, width * height).set(data);
        return new Uint8Array(buf);
    }

    /**
     * One record per pixel centre ({lat,lng,<key>:value}) for CellStore.binRecords,
     * skipping pixels where every layer is nodata. `layers` is {key: Float32Array}.
     * `step` subsamples (2 = every other pixel).
     */
    function toRecords(layers, width, height, range, step = 1) {
        const keys = Object.keys(layers);
        const out = [];
        const z = range.z;
        for (let r = 0; r < height; r += step) {
            const lat = yToLat(range.y0 + (r + 0.5) / TILE, z);
            for (let c = 0; c < width; c += step) {
                const i = r * width + c;
                const rec = { lat, lng: xToLng(range.x0 + (c + 0.5) / TILE, z) };
                let any = false;
                for (const k of keys) {
                    const v = layers[k][i];
                    if (Number.isFinite(v) && v > NODATA + 1) { rec[k] = v; any = true; } else rec[k] = null;
                }
                if (any) out.push(rec);
            }
        }
        return out;
    }

    const FIELDS = [
        { key: 'sink_depth_m', label: 'Ponding depth', type: 'number', agg: 'max', unit: 'm', ramp: 'blues', higherIs: 'worse' },
        { key: 'flow_log', label: 'Upslope area (log10 m²/m)', type: 'number', agg: 'max', unit: 'log10', ramp: 'blues' },
        { key: 'twi', label: 'Wetness index (TWI)', type: 'number', agg: 'mean', unit: 'TWI', ramp: 'viridis', higherIs: 'worse' },
        { key: 'slope_deg', label: 'Slope', type: 'number', agg: 'mean', unit: '°', ramp: 'reds' },
    ];

    // ---------- worker (Whitebox via geolibre-wasm) ----------

    const WORKER_SRC = `
// Dynamic import: a static import from a blob module worker fails in Chromium.
let ready = null;
function load() {
    ready = ready || import('${PKG}tools.mjs/+esm').then(async m => { await m.initTools('${PKG}geolibre-cli.wasm'); return m; });
    return ready;
}
async function run(tool, args, input) {
    const r = await (await load()).runTool(tool, { args, input });
    if (r.exitCode !== 0) throw new Error(tool + ' failed: ' + r.stdout.slice(-3).join(' '));
    return r.files;
}
self.onmessage = async ({ data }) => {
    const { id, dem, zFactor } = data;
    try {
        await load();
        const inp = { 'dem.tif': dem };
        const sink = (await run('depth_in_sink', ['--dem=/work/dem.tif', '--zero_background', '--output=/work/sink.tif'], inp))['sink.tif'];
        const breached = (await run('breach_depressions_least_cost', ['--dem=/work/dem.tif', '--fill_deps', '--output=/work/breached.tif'], inp))['breached.tif'];
        const sca = (await run('d8_flow_accum', ['--input=/work/breached.tif', '--out_type=sca', '--output=/work/sca.tif'], { 'breached.tif': breached }))['sca.tif'];
        const slope = (await run('slope', ['--input=/work/dem.tif', '--units=degrees', '--z_factor=' + zFactor, '--output=/work/slope.tif'], inp))['slope.tif'];
        const twi = (await run('wetness_index', ['--sca=/work/sca.tif', '--slope=/work/slope.tif', '--output=/work/twi.tif'], { 'sca.tif': sca, 'slope.tif': slope }))['twi.tif'];
        self.postMessage({ id, files: { sink, sca, slope, twi } });
    } catch (e) {
        self.postMessage({ id, error: String(e && e.message || e) });
    }
};`;

    function _getWorker() {
        if (_worker) return _worker;
        const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
        _worker = new Worker(url, { type: 'module' });
        _worker.onmessage = ({ data }) => {
            const p = _pending.get(data.id);
            if (!p) return;
            _pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.files);
        };
        _worker.onerror = (e) => {
            _pending.forEach(p => p.reject(new Error(e.message || 'hydrology worker failed to load')));
            _pending.clear();
            _worker = null;
        };
        return _worker;
    }

    function _runWhitebox(dem, zFactor) {
        const id = ++_jobs;
        return new Promise((resolve, reject) => {
            _pending.set(id, { resolve, reject });
            _getWorker().postMessage({ id, dem, zFactor }, [dem.buffer]);
        });
    }

    // ---------- browser I/O ----------

    function _fetchTile(x, y, z) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = TILE; c.height = TILE;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0);
                try { resolve(decodeTerrarium(ctx.getImageData(0, 0, TILE, TILE).data)); }
                catch { resolve(null); }
            };
            img.onerror = () => resolve(null);
            img.src = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        });
    }

    async function _readBand(bytes) {
        const g = await parseGeoraster(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        const rows = g.values[0];
        const out = new Float32Array(g.width * g.height);
        for (let r = 0; r < g.height; r++) out.set(rows[r], r * g.width);
        if (g.noDataValue != null) for (let i = 0; i < out.length; i++) if (out[i] === g.noDataValue) out[i] = NaN;
        return out;
    }

    function _toast(title, msg, kind) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast(title, msg, kind);
    }

    /** Ponding depth → translucent blue (< POND_MIN_M transparent, ≥3 m deep blue). */
    function _paint(depth, width, height) {
        _canvas.width = width; _canvas.height = height;
        const ctx = _canvas.getContext('2d');
        const img = ctx.createImageData(width, height);
        const px = img.data;
        for (let i = 0; i < depth.length; i++) {
            const d = depth[i];
            if (!(d >= POND_MIN_M)) continue;
            const t = Math.min(1, (d - POND_MIN_M) / 2.5);
            const o = i * 4;
            px[o] = Math.round(120 - 100 * t); px[o + 1] = Math.round(190 - 110 * t); px[o + 2] = 255;
            px[o + 3] = Math.round(90 + 140 * t);
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
        const b = _map.getBounds();
        const range = tileRange({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
        _toast('Terrain hydrology', 'Loading the DEM and the Whitebox runtime (first run downloads ~24 MB)…', 'info');

        try {
            const tiles = [];
            for (let ty = 0; ty < range.ny; ty++) {
                tiles.push(await Promise.all(Array.from({ length: range.nx },
                    (_, tx) => _fetchTile(range.x0 + tx, range.y0 + ty, range.z))));
            }
            if (!tiles.flat().some(Boolean)) throw new Error('No elevation tiles loaded for this area.');
            const { data, width, height } = mosaic(tiles, range.nx, range.ny);
            const geo = mercatorGeo(range);
            const lat = yToLat(range.y0 + range.ny / 2, range.z);
            // Mercator metres stretch by 1/cos(lat); scale z so slope stays true.
            const zFactor = 1 / Math.cos(lat * Math.PI / 180);
            const dem = writeGeoTiff(data, width, height, { ...geo, epsg: 3857 });
            const files = await _runWhitebox(dem, zFactor);
            if (reqId !== _reqId) return;

            const [sink, sca, slope, twi] = await Promise.all([files.sink, files.sca, files.slope, files.twi].map(_readBand));
            const flowLog = sca.map(v => (v > 0 ? Math.log10(v) : NaN));
            if (reqId !== _reqId) return;

            _canvas = document.createElement('canvas');
            _canvas.id = CANVAS_ID;
            _canvas.style.display = 'none';
            document.body.appendChild(_canvas);
            _paint(sink, width, height);
            const north = yToLat(range.y0, range.z), south = yToLat(range.y0 + range.ny, range.z);
            const west = xToLng(range.x0, range.z), east = xToLng(range.x0 + range.nx, range.z);
            _map.addSource(SOURCE_ID, {
                type: 'canvas', canvas: CANVAS_ID, animate: false,
                coordinates: [[west, north], [east, north], [east, south], [west, south]],
            });
            _map.addLayer({ id: LAYER_ID, type: 'raster', source: SOURCE_ID, paint: { 'raster-opacity': 0.9, 'raster-resampling': 'nearest' } });

            if (typeof CellStore !== 'undefined') {
                const records = toRecords({ sink_depth_m: sink, flow_log: flowLog, twi, slope_deg: slope }, width, height, range);
                const table = CellStore.binRecords(records, LEVEL, FIELDS);
                CellStore.register({
                    id: DATASET_ID, title: 'Terrain hydrology (DEM)', level: LEVEL, approxCellM: 61,
                    description: 'Ponding depth, upslope area, wetness index and slope from the SRTM-based Terrarium DEM, computed in the browser with Whitebox tools (geolibre-wasm).',
                    source: 'AWS Terrarium DEM + Whitebox Next Gen via geolibre-wasm (MIT)', license: 'Public domain DEM; MIT tools',
                    group: 'Analysis', fields: FIELDS, default: { field: 'sink_depth_m', extrude: false, heightM: 300 },
                }, table);
            }
            const ponded = sink.reduce((n, v) => n + (v >= POND_MIN_M ? 1 : 0), 0);
            const pxM = geo.px * Math.cos(lat * Math.PI / 180);
            _toast('Terrain hydrology', `${(ponded * pxM * pxM / 1e6).toFixed(2)} km² sits in closed depressions ≥${POND_MIN_M} m deep, where rain can pond. Per-cell results are in Layers → Analysis.`, 'success');
        } catch (e) {
            console.warn('TerrainHydrology:', e);
            if (reqId === _reqId) {
                _toast('Terrain hydrology unavailable', e.message || 'The analysis could not run here.', 'error');
                _active = false;
            }
        }
    }

    function detach() {
        _active = false;
        _reqId++;
        if (_map) {
            if (_map.getLayer(LAYER_ID)) _map.removeLayer(LAYER_ID);
            if (_map.getSource(SOURCE_ID)) _map.removeSource(SOURCE_ID);
        }
        if (_canvas) { _canvas.remove(); _canvas = null; }
        if (typeof CellLayers !== 'undefined' && CellLayers.isVisible && CellLayers.isVisible(DATASET_ID)) CellLayers.hide(DATASET_ID);
        if (typeof CellStore !== 'undefined' && CellStore.unregister) CellStore.unregister(DATASET_ID);
    }

    function toggle() { if (_active) detach(); else attach(); }
    function isActive() { return _active; }

    return { attach, detach, toggle, isActive, tileRange, decodeTerrarium, mosaic, mercatorGeo, writeGeoTiff, toRecords, FIELDS, DATASET_ID, WORKER_SRC };
})();

if (typeof window !== 'undefined') window.TerrainHydrology = TerrainHydrology;
