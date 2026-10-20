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
        const present = values.filter(v => v != null);
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
        for (const t of parts) {
            if (!t || !Array.isArray(t.cells)) continue;
            out.cells.push(...t.cells);
            for (const f of spec.fields) {
                const col = (t.columns && t.columns[f.key]) || [];
                for (let i = 0; i < t.cells.length; i++) out.columns[f.key].push(col[i] ?? null);
            }
        }
        return out;
    }

    /**
     * URL of one region file, versioned by the catalog build stamp. Like Aino's
     * version-in-the-path tiles, a new build is a new URL, so the browser can
     * reuse its cached copy for as long as the stamp is unchanged instead of
     * revalidating every file on every visit.
     */
    function tableUrl(region) {
        const v = generated();
        return base() + region.json + (v ? '?v=' + encodeURIComponent(v) : '');
    }

    /** The dataset's table (all regions), loaded once. null when unavailable. */
    function load(id) {
        if (_tables.has(id)) return _tables.get(id);
        const spec = get(id);
        if (!spec) return Promise.resolve(null);
        const p = (async () => {
            const parts = await Promise.all((spec.regions || []).map(async r => {
                try {
                    const resp = await fetch(tableUrl(r), { signal: AbortSignal.timeout(15000) });
                    return resp.ok ? await resp.json() : null;
                } catch { return null; }
            }));
            const table = _index(_concat(parts, spec));
            if (!table.cells.length) { _tables.delete(id); return null; }
            return table;
        })();
        _tables.set(id, p);
        return p;
    }

    /** A dataset's row for the cell containing (lat,lng), or null. */
    async function rowAt(id, lat, lng) {
        const spec = get(id);
        if (!spec) return null;
        const table = await load(id);
        if (!table) return null;
        const code = cellCode(table.level, lat, lng);
        const i = table.index.get(code);
        if (i === undefined) return null;
        const row = { digipin: DigiPin.format(code) };
        for (const f of spec.fields) row[f.key] = table.columns[f.key][i];
        return row;
    }

    /** Add a runtime dataset (e.g. a dropped file). Replaces one with the same id. */
    function register(spec, table) {
        const s = { group: 'Ingested data', regions: [], default: {}, ...spec };
        s.fields = s.fields.map(f => (f.domain == null ? { ...f, domain: dataDomain(f, table.columns[f.key] || []) } : f));
        s.default = { field: s.fields[0].key, extrude: false, heightM: 400, ...s.default };
        _local.set(s.id, { spec: s, table: _index(table) });
        _tables.set(s.id, Promise.resolve(_index(table)));
        _emit();
        return s;
    }

    function unregister(id) {
        const had = _local.delete(id);
        if (had) { _tables.delete(id); _emit(); }
        return had;
    }

    function isLocal(id) { return _local.has(id); }

    // ── geometry ────────────────────────────────────────────────────────────

    /**
     * FeatureCollection of cell rectangles. Each feature carries the row's
     * fields plus `digipin`; null `fieldKey` values are skipped so empty cells
     * don't paint. Bounds are clipped to `bbox` ({south,west,north,east}) if given.
     */
    function toGeoJSON(spec, table, fieldKey, bbox) {
        const features = [];
        const col = fieldKey ? table.columns[fieldKey] : null;
        for (let i = 0; i < table.cells.length; i++) {
            if (col && col[i] == null) continue;
            const code = table.cells[i];
            let b;
            try { b = DigiPin.decodePartial(code).bounds; } catch { continue; }
            if (bbox && (b.north < bbox.south || b.south > bbox.north || b.east < bbox.west || b.west > bbox.east)) continue;
            const props = { digipin: DigiPin.format(code) };
            for (const f of spec.fields) props[f.key] = table.columns[f.key][i];
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
        init, isEnabled, base, datasets, get, generated, tableUrl, field, onChange,
        cellCode, binRecords, dataDomain, load, rowAt,
        register, unregister, isLocal, toGeoJSON,
        sqlSources, viewStatements, sql,
    };
})();

if (typeof window !== 'undefined') {
    window.CellStore = CellStore;
}
