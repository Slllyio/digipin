/**
 * CellStore — the browser side of the per-DIGIPIN-cell data store
 * (docs/CELL_STORE.md, written by pipeline/cells/).
 *
 * Reads data/cells/catalog.json — the layer registry — and loads any dataset
 * in it on demand from its columnar JSON (no WASM needed). Every dataset has
 * the same shape: one row per DIGIPIN cell at the dataset's level, so a single
 * renderer (js/cell-layers.js) can plot all of them, and user-dropped files
 * (js/cell-ingest.js) join the same registry via register().
 *
 *   catalog.json               { version, generated, datasets:[spec] }
 *   <id>/<region>.json         { level, fields, cells:[code], columns:{key:[v]} }
 *   <id>/<region>.parquet      same table as GeoParquet — for sql()
 *
 * Temporal datasets (spec.time = { unit, steps:[label], default }) hold a
 * series per cell: columns[key][i] is an array aligned with spec.time.steps.
 * toGeoJSON() flattens it to one property per step (stepKey(key, t)) so the
 * renderer can animate by swapping paint expressions, with no setData.
 *
 * sql() lazily loads DuckDB-WASM and exposes each catalog dataset as a view
 * named after its id, for ad-hoc spatial SQL over the GeoParquet copies.
 *
 * binRecords/cellCode/dataDomain/toGeoJSON are pure and unit-tested; they
 * mirror pipeline/cells/store.py so a file binned in the browser and one
 * binned by the pipeline produce the same cells.
 *
 * Config (window.DIGIPIN_CONFIG):
 *   cellStore: false     — kill switch
 *   cellsBase: 'https://r2…/cells/'  — override the data/cells/ base
 */
const CellStore = (() => {
    const DUCKDB_VERSION = '1.29.0';
    let _catalog = null;            // parsed catalog.json, or null
    let _enabled = false;
    const _local = new Map();       // id -> { spec, table } registered at runtime
    const _tables = new Map();      // id -> Promise<table>
    const _parts = new Map();       // url -> Promise<columnar doc | null> (region file or shard), LRU order
    const _partCells = new Map();   // url -> decoded JSON bytes of that part (for the memory budget)
    // Decoded parts kept in memory, measured as JSON text bytes (the live
    // objects weigh roughly 3-5× that). A city sweep with the profile open
    // pulls in every region of every dataset (3.4 M cells, many with monthly
    // series); without a cap the heap passed 800 MB.
    const PART_BYTE_BUDGET = 48 * 1024 * 1024;
    let _partCellTotal = 0;
    const _partBudget = () => {
        const c = (typeof window !== 'undefined' && window.DIGIPIN_CONFIG) || {};
        return Number.isFinite(c.partByteBudget) ? c.partByteBudget : PART_BYTE_BUDGET;
    };
    let _duck = null;               // Promise<{ db, conn }>
    const _listeners = new Set();

    function _cfg() {
        return (typeof window !== 'undefined' && window.DIGIPIN_CONFIG) || {};
    }

    function base() {
        return _cfg().cellsBase || 'data/cells/';
    }

    /** Fetch catalog.json. Idempotent; silently disabled on 404 / kill switch. */
    async function init() {
        _catalog = null;
        _enabled = false;
        _tables.clear();
        _parts.clear();
        _partCells.clear();
        _partCellTotal = 0;
        _views.clear();
        _viewBytes.clear();
        if (_cfg().cellStore === false) return false;
        try {
            const resp = await fetch(`${base()}catalog.json`, { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
            if (!resp.ok) return false;
            const cat = await resp.json();
            if (!cat || !Array.isArray(cat.datasets)) return false;
            _catalog = cat;
            _enabled = true;
            _emit();
            return true;
        } catch {
            return false;
        } finally {
            // Runtime-registered datasets survive a re-init.
            for (const [id, d] of _local) _tables.set(id, Promise.resolve(d.table));
        }
    }

    function isEnabled() { return _enabled || _local.size > 0; }

    /** All registry entries: catalog datasets, then runtime-registered ones. */
    function datasets() {
        const fromCatalog = _enabled ? _catalog.datasets : [];
        return [...fromCatalog, ...[..._local.values()].map(d => d.spec)];
    }

    function get(id) {
        return datasets().find(d => d.id === id) || null;
    }

    /** catalog.json's build timestamp (ISO string), or null when not loaded. */
    function generated() {
        return _enabled ? (_catalog.generated || null) : null;
    }

    /** True when the dataset holds a series per cell (spec.time). */
    function isTemporal(spec) {
        return !!(spec && spec.time && Array.isArray(spec.time.steps) && spec.time.steps.length);
    }

    /** Feature property holding step `t` of a temporal field. */
    function stepKey(key, t) { return `${key}@${t}`; }

    function field(spec, key) {
        if (!spec) return null;
        return spec.fields.find(f => f.key === key) || null;
    }

    function onChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
    function _emit() { _listeners.forEach(fn => { try { fn(); } catch { /* listener errors are theirs */ } }); }

    // ── addressing ──────────────────────────────────────────────────────────

    /** Dash-less code at `level` for a point, or a truncated existing code. */
    function cellCode(level, lat, lng, code) {
        if (code) {
            const c = String(code).replace(/-/g, '').trim().toUpperCase();
            return c.length >= level ? c.slice(0, level) : null;
        }
        if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return null;
        try {
            return DigiPin.encode(Number(lat), Number(lng)).replace(/-/g, '').slice(0, level);
        } catch {
            return null;
        }
    }

    // ── binning (mirror of pipeline/cells/store.py bin_records) ─────────────

    function _acc(agg) {
        return { agg, n: 0, total: 0, lo: null, hi: null, counts: new Map(), first: null, any: false };
    }

    function _add(a, v) {
        if (a.agg === 'count') { a.n++; return; }
        if (v == null || (typeof v === 'number' && Number.isNaN(v))) return;
        a.n++;
        if (a.first === null) a.first = v;
        if (a.agg === 'mode') {
            a.counts.set(v, (a.counts.get(v) || 0) + 1);
        } else if (a.agg === 'any') {
            a.any = a.any || !!v;
        } else if ((a.agg === 'min' || a.agg === 'max') && typeof v === 'string') {
            if (a.lo === null || v < a.lo) a.lo = v;
            if (a.hi === null || v > a.hi) a.hi = v;
        } else if (a.agg === 'mean' || a.agg === 'sum' || a.agg === 'min' || a.agg === 'max') {
            const x = Number(v);
            a.total += x;
            if (a.lo === null || x < a.lo) a.lo = x;
            if (a.hi === null || x > a.hi) a.hi = x;
        }
    }

    function _value(a) {
        if (a.agg === 'count') return a.n;
        if (a.n === 0) return null;
        switch (a.agg) {
            case 'mean': return a.total / a.n;
            case 'sum': return a.total;
            case 'min': return a.lo;
            case 'max': return a.hi;
            case 'any': return a.any;
            case 'mode': {
                let best = null, bestN = -1;
                for (const [k, n] of a.counts) {
                    if (n > bestN || (n === bestN && String(k) < String(best))) { best = k; bestN = n; }
                }
                return best;
            }
            default: return a.first;
        }
    }

    function _coerce(f, v) {
        if (v == null) return null;
        if (f.type === 'boolean') return !!v;
        if (f.type === 'category') return String(v);
        const x = Number(v);
        return Number.isFinite(x) ? x : null;
    }

    /**
     * Aggregate records into cells at `level`. Each record has `digipin` or
     * `lat`+`lng`, plus a value per field key. Returns { level, cells, columns }
     * with cells sorted; cells whose every field is null are dropped.
     */
    function binRecords(records, level, fields) {
        const accs = new Map();
        for (const rec of records) {
            const code = cellCode(level, rec.lat, rec.lng, rec.digipin);
            if (!code) continue;
            let row = accs.get(code);
            if (!row) { row = fields.map(f => _acc(f.agg)); accs.set(code, row); }
            fields.forEach((f, i) => _add(row[i], rec[f.key]));
        }
        const cells = [];
        const columns = Object.fromEntries(fields.map(f => [f.key, []]));
        for (const code of [...accs.keys()].sort()) {
            const vals = accs.get(code).map(_value);
            if (vals.every(v => v == null)) continue;
            cells.push(code);
            fields.forEach((f, i) => columns[f.key].push(_coerce(f, vals[i])));
        }
        return { level, cells, columns };
    }

    /** [min,max] for numbers, sorted categories for categories, else null. */
    function dataDomain(f, values) {
        const present = values.flat().filter(v => v != null);
        if (!present.length) return null;
        if (f.type === 'number') {
            let lo = Infinity, hi = -Infinity;
            for (const v of present) { if (v < lo) lo = v; if (v > hi) hi = v; }
            return [lo, hi];
        }
        if (f.type === 'category') return [...new Set(present.map(String))].sort();
        return null;
    }

    // ── loading ─────────────────────────────────────────────────────────────

    function _index(table) {
        if (!table.index) {
            table.index = new Map();
            table.cells.forEach((c, i) => table.index.set(c, i));
        }
        return table;
    }

    /** Concatenate per-region tables of one dataset (same level + fields). */
    function _concat(parts, spec) {
        const out = { level: spec.level, cells: [], columns: Object.fromEntries(spec.fields.map(f => [f.key, []])) };
        const steps = isTemporal(spec) ? spec.time.steps : null;
        if (steps) out.times = steps.slice();
        for (const t of parts) {
            if (!t || !Array.isArray(t.cells)) continue;
            // No spread: a 50k-cell region would overflow the argument limit.
            for (let i = 0; i < t.cells.length; i++) out.cells.push(t.cells[i]);
            for (const f of spec.fields) {
                const col = (t.columns && t.columns[f.key]) || [];
                for (let i = 0; i < t.cells.length; i++) {
                    let v = col[i] ?? null;
                    // Re-align a region's series to the catalog's steps by label.
                    if (steps) {
                        const own = t.times || steps;
                        const arr = Array.isArray(v) ? v : [];
                        v = steps.map(s => { const j = own.indexOf(s); return j < 0 ? null : (arr[j] ?? null); });
                    }
                    out.columns[f.key].push(v);
                }
            }
        }
        return out;
    }

    /**
     * URL of one region file, versioned by the catalog build stamp. Like Aino's
     * version-in-the-path tiles, a new build is a new URL, so the browser can
     * reuse its cached copy for as long as the stamp is unchanged instead of
     * revalidating every file on every visit. For a sharded region this is the
     * `{prefix}` template; regionParts() expands it.
     */
    function tableUrl(region) {
        return _versioned(base() + region.json);
    }

    function _versioned(url) {
        const v = generated();
        return url + (v ? '?v=' + encodeURIComponent(v) : '');
    }

    /**
     * The files behind one catalog region: one part for an unsharded region,
     * one per shard key when the region carries `shards: { prefixLen, keys }`
     * (json is then a template, "<id>/<region>/{prefix}.json").
     */
    function regionParts(region) {
        if (!region || !region.json) return [];
        const sh = region.shards;
        if (sh && Array.isArray(sh.keys)) {
            return sh.keys.map(key => ({ key, url: _versioned(base() + region.json.replace('{prefix}', key)) }));
        }
        return [{ key: '', url: tableUrl(region) }];
    }

    /** Multiply a quantised column (ints, or per-cell int arrays) back by its scale. */
    function _dequantise(col, scale) {
        const r = Math.max(0, Math.round(-Math.log10(scale)));
        const f = (v) => (v == null ? null : Number((v * scale).toFixed(r)));
        return col.map(v => (Array.isArray(v) ? v.map(f) : f(v)));
    }

    /**
     * A region file's bytes → its JSON doc. `.json.gz` files (temporal
     * datasets) are gzipped on disk and served as-is by static hosts, so the
     * gzip magic is checked and inflated here; a host that already sent
     * Content-Encoding: gzip hands over plain JSON. `scale` columns hold
     * quantised integers (pipeline/cells/store.py write_json).
     */
    async function decodeDoc(buf) {
        let bytes = new Uint8Array(buf);
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
            const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
            bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        }
        const doc = JSON.parse(new TextDecoder().decode(bytes));
        Object.defineProperty(doc, 'bytes', { value: bytes.byteLength, enumerable: false });
        for (const [k, sc] of Object.entries(doc.scale || {})) {
            if (doc.columns && doc.columns[k]) doc.columns[k] = _dequantise(doc.columns[k], sc);
        }
        return doc;
    }

    function _forgetPart(url) {
        _parts.delete(url);
        _partCellTotal -= _partCells.get(url) || 0;
        _partCells.delete(url);
    }

    /** Drop least-recently-used decoded parts until the cell budget holds. */
    function _evictParts() {
        const budget = _partBudget();
        for (const url of _parts.keys()) {
            if (_partCellTotal <= budget) break;
            if (!_partCells.has(url)) continue;   // still loading
            _forgetPart(url);
        }
    }

    // Parts that did not load, by url → 'timeout' | 'network' | HTTP status.
    // A 404 means "not published"; anything else is a link that failed, which
    // the UI reports differently and can retry (a failed part is forgotten,
    // so the next load refetches it).
    const _failed = new Map();
    const _lastLoad = new Map();   // dataset id → { parts, of, unreachable } of its latest table build

    function _fetchPart(url) {
        if (_parts.has(url)) {
            // Touch: most recently used goes last.
            const p = _parts.get(url);
            _parts.delete(url);
            _parts.set(url, p);
            return p;
        }
        const p = (async () => {
            try {
                const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
                if (!resp.ok) { _failed.set(url, resp.status); return null; }
                const doc = decodeDoc(await resp.arrayBuffer());
                _failed.delete(url);
                return doc;
            } catch (e) {
                _failed.set(url, e && e.name === 'TimeoutError' ? 'timeout' : 'network');
                return null;
            }
        })();
        _parts.set(url, p);
        p.then(doc => {
            if (!doc) { _forgetPart(url); return; }      // let a failed part be retried
            if (!_parts.has(url)) return;                 // evicted or reset while loading
            const n = doc.bytes || 0;
            _partCells.set(url, n);
            _partCellTotal += n;
            _evictParts();
        });
        return p;
    }

    /** Parts whose last fetch failed for a reason other than 404: [{ url, reason }]. */
    function failedParts() {
        return [..._failed.entries()].filter(([, r]) => r !== 404).map(([url, reason]) => ({ url, reason }));
    }

    /** How the dataset's latest table build went: { parts, of, unreachable } or null. */
    function lastLoad(id) { return _lastLoad.get(id) || null; }

    /** Decoded-part cache size, for tests and diagnostics. */
    function cacheStats() {
        return { parts: _parts.size, bytes: _partCellTotal, budget: _partBudget(), views: _views.size, viewBytes: [..._viewBytes.values()].reduce((a, b) => a + b, 0), tables: _tables.size };
    }

    async function _tableFrom(spec, parts) {
        const docs = await Promise.all(parts.map(pt => _fetchPart(pt.url)));
        const table = _index(_concat(docs, spec));
        // Source bytes behind this table, for the view cache's memory budget.
        Object.defineProperty(table, 'bytes', { value: docs.reduce((a, d) => a + ((d && d.bytes) || 0), 0), enumerable: false });
        // What did not arrive: unpublished (404) parts are expected gaps,
        // unreachable ones (timeout, network, 5xx) are a degraded load.
        const miss = parts.filter((pt, i) => !docs[i]);
        const unreachable = miss.filter(pt => _failed.get(pt.url) !== 404).length;
        const missing = { parts: miss.length, of: parts.length, unreachable };
        Object.defineProperty(table, 'missing', { value: missing, enumerable: false });
        _lastLoad.set(spec.id, missing);
        return table;
    }

    /** The dataset's whole table (every region and shard), loaded once. null when unavailable. */
    function load(id) {
        if (_tables.has(id)) return _tables.get(id);
        const spec = get(id);
        if (!spec) return Promise.resolve(null);
        const p = (async () => {
            const parts = (spec.regions || []).flatMap(regionParts);
            const table = await _tableFrom(spec, parts);
            // A degraded table is not kept: the next load refetches the failed parts.
            if (!table.cells.length || table.missing.unreachable) _tables.delete(id);
            return table.cells.length ? table : null;
        })();
        _tables.set(id, p);
        return p;
    }

    /**
     * Only the parts of a dataset covering `prefixes` (DIGIPIN codes of any
     * length, e.g. a viewport cover): a sharded region contributes the shards
     * that overlap a prefix; an unsharded region is included whole. Runtime
     * datasets return their full table. Never cached as a whole — parts are.
     */
    async function loadCells(id, prefixes) {
        const spec = get(id);
        if (!spec) return null;
        if (_local.has(id)) return load(id);
        const want = (prefixes || []).map(p => String(p).replace(/-/g, '').toUpperCase());
        const overlaps = (key) => !key || want.some(p => p.startsWith(key) || key.startsWith(p));
        const parts = (spec.regions || []).flatMap(regionParts).filter(pt => overlaps(pt.key));
        return _tableFrom(spec, parts);
    }

    function _inBbox(b, lat, lng) {
        return !b || (lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east);
    }

    /**
     * Does a dataset have data for a city? `city` is { region, lat, lng }:
     * a catalog region named `region` counts, as does any region whose bbox
     * holds the city centre. Datasets dropped on the map always count (the
     * user brought them), and so does every dataset when `city` is null.
     */
    function coversCity(spec, city) {
        if (!spec) return false;
        if (!city || _local.has(spec.id)) return true;
        return (spec.regions || []).some(r => (city.region && r.name === city.region)
            || (r.bbox && city.lat != null && _inBbox(r.bbox, city.lat, city.lng)));
    }

    /** Registry entries that have data for `city` (see coversCity). */
    function datasetsFor(city) {
        return datasets().filter(d => coversCity(d, city));
    }

    // ── hierarchy roll-up ───────────────────────────────────────────────────

    // How native cells combine into a parent. Cells at one level are equal
    // area, so a plain mean of child means is the area-weighted mean; counts
    // and sums add up; min/max/mode/any carry over.
    const ROLLUP_AGG = { mean: 'mean', sum: 'sum', count: 'sum', min: 'min', max: 'max', mode: 'mode', any: 'any', first: 'first' };

    /**
     * Aggregate a table up the DIGIPIN hierarchy to a coarser `level` by code
     * prefix, using each field's agg. Returns a table of the same shape plus
     * `counts` (native cells per parent) and `nativeLevel`. A level at or
     * finer than the table's is returned unchanged (data can't be refined).
     */
    function rollup(spec, table, level) {
        if (!table || level >= table.level) return table;
        const fields = spec.fields;
        const temporal = isTemporal(spec);
        const accs = new Map();
        for (let i = 0; i < table.cells.length; i++) {
            const code = table.cells[i].slice(0, level);
            let a = accs.get(code);
            if (!a) {
                a = { n: 0, f: fields.map(f => _acc(ROLLUP_AGG[f.agg] || 'first')) };
                accs.set(code, a);
            }
            a.n++;
            fields.forEach((f, k) => {
                const v = table.columns[f.key][i];
                if (!temporal) { _add(a.f[k], v); return; }
                // Temporal fields hold one value per step: aggregate per step.
                if (!Array.isArray(a.f[k])) a.f[k] = [];
                (v || []).forEach((x, t) => {
                    if (!a.f[k][t]) a.f[k][t] = _acc(ROLLUP_AGG[f.agg] || 'first');
                    _add(a.f[k][t], x);
                });
            });
        }
        const cells = [...accs.keys()].sort();
        const columns = Object.fromEntries(fields.map(f => [f.key, []]));
        const counts = [];
        for (const code of cells) {
            const a = accs.get(code);
            counts.push(a.n);
            const out = (f, acc) => {
                const v = acc ? _value(acc) : null;
                return v == null ? null : (f.type === 'number' ? Math.round(v * 1e4) / 1e4 : _coerce(f, v));
            };
            fields.forEach((f, k) => {
                columns[f.key].push(temporal ? (a.f[k] || []).map(acc => out(f, acc)) : out(f, a.f[k]));
            });
        }
        return _index({ level, nativeLevel: table.nativeLevel || table.level, cells, columns, counts });
    }

    function _bboxHit(a, b) {
        return !a || !b || !(a.north < b.south || a.south > b.north || a.east < b.west || a.west > b.east);
    }

    /**
     * The parts of a dataset a viewport needs: regions whose catalog bbox
     * misses `bbox` are dropped, and a sharded region keeps only the shards
     * under the view's cover at the shard prefix length. Pure given the catalog.
     */
    function viewParts(spec, bbox) {
        const out = [];
        for (const r of (spec && spec.regions) || []) {
            if (!_bboxHit(r.bbox, bbox)) continue;
            const parts = regionParts(r);
            const sh = r.shards;
            if (bbox && sh && sh.prefixLen && typeof DigiPin !== 'undefined' && DigiPin.cover) {
                const want = DigiPin.cover(bbox, sh.prefixLen, 4096);
                if (want) {
                    const set = new Set(want);
                    out.push(...parts.filter(pt => set.has(pt.key)));
                    continue;
                }
            }
            out.push(...parts);
        }
        return out;
    }

    const _views = new Map();    // `${id}|${urls}` -> Promise<table>, most recent last
    const _viewBytes = new Map(); // key -> source bytes of the resolved table
    // Concatenated view tables are copies of their parts (series re-aligned
    // per cell), so they are budgeted too: by count and by source bytes.
    const VIEW_BYTE_BUDGET = 40 * 1024 * 1024;
    const MAX_VIEWS = 24;
    function _evictViews() {
        let total = 0;
        for (const v of _viewBytes.values()) total += v;
        for (const key of _views.keys()) {
            if (_views.size <= MAX_VIEWS && total <= VIEW_BYTE_BUDGET) break;
            total -= _viewBytes.get(key) || 0;
            _views.delete(key);
            _viewBytes.delete(key);
        }
    }

    /**
     * The dataset's cells for a viewport (see viewParts). The same set of
     * parts returns the same table object, so callers can tell when a pan
     * brought new data into view. Runtime datasets return their whole table.
     */
    function loadView(id, bbox) {
        const spec = get(id);
        if (!spec) return Promise.resolve(null);
        if (_local.has(id) || !bbox) return load(id);
        const parts = viewParts(spec, bbox);
        const key = id + '|' + parts.map(p => p.url).join(',');
        if (_views.has(key)) {
            const p = _views.get(key); _views.delete(key); _views.set(key, p);   // touch (LRU)
            return p;
        }
        const p = _tableFrom(spec, parts);
        _views.set(key, p);
        p.then(t => {
            if (!_views.has(key)) return;
            if (t && t.missing && t.missing.unreachable) { _views.delete(key); return; }   // degraded: refetch next time
            _viewBytes.set(key, (t && t.bytes) || 0);
            _evictViews();
        }, () => { _views.delete(key); });
        _evictViews();
        return p;
    }

    const _rolled = new Map();   // `${id}@${level}` -> { src, table }

    /**
     * The dataset at `level`: rolled up when coarser than native, else native.
     * With `bbox`, only the regions / shards in view are loaded (loadView).
     */
    async function loadAt(id, level, bbox) {
        const table = await (bbox ? loadView(id, bbox) : load(id));
        if (!table || level == null || level >= table.level) return table;
        const key = `${id}@${level}`;
        if (!_rolled.has(key) || _rolled.get(key).src !== table) {
            _rolled.set(key, { src: table, table: rollup(get(id), table, level) });
        }
        return _rolled.get(key).table;
    }

    /**
     * A dataset's row for the cell containing (lat,lng), or null. Loads at
     * most one shard per region. With `level` coarser than the dataset's, the
     * row is the rolled-up parent (plus `cells`: how many native cells it
     * summarises), built from just the shards under that parent.
     */
    async function rowAt(id, lat, lng, level) {
        const spec = get(id);
        if (!spec) return null;
        const L = level != null && level < spec.level ? level : spec.level;
        const code = cellCode(L, lat, lng);
        if (!code) return null;
        let table;
        if (_local.has(id)) {
            table = await load(id);
        } else {
            const regions = (spec.regions || []).filter(r => _inBbox(r.bbox, lat, lng));
            if (!regions.length) return null;
            const parts = regions.flatMap(regionParts)
                .filter(pt => !pt.key || code.startsWith(pt.key) || pt.key.startsWith(code));
            table = await _tableFrom(spec, parts);
        }
        if (table && L < table.level) table = rollup(spec, table, L);
        const i = table && table.index.get(code);
        if (i === undefined || i === null) return null;
        const row = { digipin: DigiPin.format(code), level: L };
        for (const f of spec.fields) row[f.key] = table.columns[f.key][i];
        if (table.counts) row.cells = table.counts[i];
        return row;
    }


    /** Add a runtime dataset (e.g. a dropped file). Replaces one with the same id. */
    function register(spec, table) {
        const s = { group: 'Ingested data', regions: [], default: {}, ...spec };
        s.fields = s.fields.map(f => (f.domain == null ? { ...f, domain: dataDomain(f, table.columns[f.key] || []) } : f));
        s.default = { field: s.fields[0].key, extrude: false, heightM: 400, ...s.default };
        _local.set(s.id, { spec: s, table: _index(table) });
        _dropRolled(s.id);
        _tables.set(s.id, Promise.resolve(_index(table)));
        _emit();
        return s;
    }

    function unregister(id) {
        const had = _local.delete(id);
        if (had) { _tables.delete(id); _dropRolled(id); _emit(); }
        return had;
    }

    function isLocal(id) { return _local.has(id); }

    function _dropRolled(id) {
        for (const k of [..._rolled.keys()]) if (k.startsWith(id + '@')) _rolled.delete(k);
    }

    // ── geometry ────────────────────────────────────────────────────────────

    /**
     * FeatureCollection of cell rectangles. Each feature carries the row's
     * fields plus `digipin`; null `fieldKey` values are skipped so empty cells
     * don't paint. Bounds are clipped to `bbox` ({south,west,north,east}) if given.
     */
    function toGeoJSON(spec, table, fieldKey, bbox) {
        const features = [];
        const col = fieldKey ? table.columns[fieldKey] : null;
        const temporal = isTemporal(spec);
        for (let i = 0; i < table.cells.length; i++) {
            if (col && (temporal ? !(col[i] || []).some(v => v != null) : col[i] == null)) continue;
            const code = table.cells[i];
            let b;
            try { b = DigiPin.decodePartial(code).bounds; } catch { continue; }
            if (bbox && (b.north < bbox.south || b.south > bbox.north || b.east < bbox.west || b.west > bbox.east)) continue;
            const props = { digipin: DigiPin.format(code), level: table.level };
            if (table.counts) props.cells = table.counts[i];
            for (const f of spec.fields) {
                const v = table.columns[f.key][i];
                if (temporal) (v || []).forEach((x, t) => { props[stepKey(f.key, t)] = x; });
                else props[f.key] = v;
            }
            features.push({
                type: 'Feature',
                id: i,
                properties: props,
                geometry: {
                    type: 'Polygon',
                    coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]],
                },
            });
        }
        return { type: 'FeatureCollection', features };
    }

    // ── SQL over GeoParquet (DuckDB-WASM, loaded on first use) ──────────────

    function _abs(url) {
        try { return new URL(url, (typeof location !== 'undefined' && location.href) || undefined).href; } catch { return url; }
    }

    /** [{ view, file, url }] for every catalog dataset region with a parquet copy. */
    function sqlSources() {
        const out = [];
        for (const d of (_enabled ? _catalog.datasets : [])) {
            for (const r of d.regions || []) {
                if (!r.parquet) continue;
                out.push({ view: d.id, file: `${d.id}__${r.name}.parquet`, url: _abs(base() + r.parquet) });
            }
        }
        return out;
    }

    /** CREATE VIEW statements: one view per dataset, UNION ALL over its regions. */
    function viewStatements(sources) {
        const byView = new Map();
        for (const s of sources) {
            if (!byView.has(s.view)) byView.set(s.view, []);
            byView.get(s.view).push(s.file);
        }
        return [...byView].map(([view, files]) =>
            `CREATE OR REPLACE VIEW "${view}" AS ` +
            files.map(f => `SELECT * FROM read_parquet('${f}')`).join(' UNION ALL '));
    }

    async function _duckdb() {
        if (_duck) return _duck;
        _duck = (async () => {
            const duckdb = await import(`https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`);
            const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
            const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
            const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
            await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
            URL.revokeObjectURL(workerUrl);
            const sources = sqlSources();
            for (const s of sources) {
                await db.registerFileURL(s.file, s.url, duckdb.DuckDBDataProtocol.HTTP, false);
            }
            const conn = await db.connect();
            for (const stmt of viewStatements(sources)) await conn.query(stmt);
            return { db, conn };
        })();
        _duck.catch(() => { _duck = null; });   // allow a retry after a failed load
        return _duck;
    }

    /**
     * Run SQL over the store, e.g.
     *   CellStore.sql(`SELECT t.digipin, t.congestion_risk, s.livability
     *                  FROM traffic t JOIN scores s ON substr(t.digipin,1,6)=s.digipin`)
     * Returns an array of plain row objects. Loads DuckDB-WASM (~7 MB) on first call.
     */
    async function sql(query) {
        const { conn } = await _duckdb();
        const res = await conn.query(query);
        return res.toArray().map(r => (typeof r.toJSON === 'function' ? r.toJSON() : { ...r }));
    }

    return {
        init, isEnabled, base, datasets, get, generated, tableUrl, field, onChange, isTemporal, stepKey,
        cellCode, binRecords, dataDomain, decodeDoc, load, loadCells, regionParts, viewParts, loadView, loadAt, rollup, rowAt, cacheStats, failedParts, lastLoad,
        register, unregister, isLocal, toGeoJSON, coversCity, datasetsFor,
        sqlSources, viewStatements, sql,
    };
})();

if (typeof window !== 'undefined') {
    window.CellStore = CellStore;
}
