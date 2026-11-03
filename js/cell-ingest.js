/**
 * CellIngest — "plot any dataset": drop a CSV or GeoJSON on the map (or pick
 * one from the Layers panel) and it is binned to DIGIPIN cells, registered in
 * the cell store (js/cell-store.js) and drawn by the generic renderer
 * (js/cell-layers.js) as 2D or 3D extruded cells. Nothing leaves the browser.
 *
 * Location comes from (first match wins):
 *   • a `digipin` / `digipin_code` / `pin` column (any code length ≥ level)
 *   • `lat|latitude|y` + `lng|lon|long|longitude|x` columns
 *   • GeoJSON geometry (Point; other geometries use their vertex-bbox centre)
 *
 * Every row adds to `count`; numeric columns become `mean` fields and
 * low-cardinality text columns `mode` category fields. This mirrors
 * pipeline/cells/ingest.py, so `python -m pipeline.cells.ingest <file>` commits
 * exactly what the drop previewed.
 *
 * parseCSV/readRows/inferFields/toRecords/autoLevel are pure and unit-tested.
 */
const CellIngest = (() => {
    const LAT_KEYS = ['lat', 'latitude', 'y'];
    const LNG_KEYS = ['lng', 'lon', 'long', 'longitude', 'x'];
    const PIN_KEYS = ['digipin', 'digipin_code', 'pin'];
    const RESERVED = new Set(['count', 'digipin', 'level', 'lat', 'lng', 'geometry', 'bbox']);
    const MAX_CATEGORIES = 24;
    const MAX_BYTES = 50 * 1024 * 1024;
    const _sources = new Map();   // dataset id -> { name, rows, fields, source }
    let _wired = false;

    /** RFC-4180-ish CSV → array of objects keyed by the header row. */
    function parseCSV(text) {
        const rows = [];
        let row = [], cell = '', inQ = false;
        const s = String(text).replace(/^\uFEFF/, '');
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (inQ) {
                if (ch === '"') {
                    if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
                } else cell += ch;
            } else if (ch === '"') inQ = true;
            else if (ch === ',') { row.push(cell); cell = ''; }
            else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && s[i + 1] === '\n') i++;
                row.push(cell); rows.push(row); row = []; cell = '';
            } else cell += ch;
        }
        if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
        const nonEmpty = rows.filter(r => r.some(c => c.trim() !== ''));
        if (!nonEmpty.length) return [];
        const header = nonEmpty[0].map(h => h.trim());
        return nonEmpty.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
    }

    function _geomCenter(g) {
        if (!g || !g.coordinates) return null;
        if (g.type === 'Point') return { lat: g.coordinates[1], lng: g.coordinates[0] };
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        const walk = (c) => {
            if (typeof c[0] === 'number') {
                if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0];
                if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
            } else c.forEach(walk);
        };
        walk(g.coordinates);
        return isFinite(w) ? { lat: (s + n) / 2, lng: (w + e) / 2 } : null;
    }

    /** Uniform rows from a file's text: GeoJSON features or CSV records. */
    function readRows(text, filename = '') {
        const t = String(text).trim();
        const looksJson = /\.(geo)?json$/i.test(filename) || t.startsWith('{');
        if (looksJson) {
            const doc = JSON.parse(t);
            const feats = doc.type === 'FeatureCollection' ? (doc.features || []) : [doc];
            return feats.map(f => {
                const props = { ...(f.properties || {}) };
                const c = _geomCenter(f.geometry);
                if (c) { props.lat = c.lat; props.lng = c.lng; }
                return props;
            });
        }
        return parseCSV(t);
    }

    function slug(s) {
        let k = String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (!k || !/^[a-z]/.test(k)) k = 'f_' + k;
        return k.slice(0, 64);
    }

    function _num(v) {
        if (v == null || typeof v === 'boolean') return null;
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        const x = Number(String(v).trim().replace(/,/g, ''));
        return String(v).trim() !== '' && Number.isFinite(x) ? x : null;
    }

    function _columns(rows) {
        const cols = [];
        const seen = new Set();
        for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
        return cols;
    }

    function _find(cols, cands) {
        const low = new Map(cols.map(c => [c.toLowerCase().trim(), c]));
        for (const c of cands) if (low.has(c)) return low.get(c);
        return null;
    }

    /** Location columns { lat, lng, pin } (any may be null). */
    function locationColumns(rows) {
        const cols = _columns(rows);
        return { lat: _find(cols, LAT_KEYS), lng: _find(cols, LNG_KEYS), pin: _find(cols, PIN_KEYS) };
    }

    /** { fields, source } — field specs + field key → source column. */
    function inferFields(rows) {
        const loc = locationColumns(rows);
        const skip = new Set([loc.lat, loc.lng, loc.pin].filter(Boolean));
        const fields = [{ key: 'count', label: 'Count', type: 'number', agg: 'count', unit: 'count', ramp: 'heat' }];
        const source = {};
        for (const col of _columns(rows)) {
            if (skip.has(col)) continue;
            const key = slug(col);
            if (source[key] || RESERVED.has(key)) continue;
            const vals = rows.map(r => r[col]).filter(v => v != null && v !== '');
            if (!vals.length) continue;
            if (vals.every(v => _num(v) !== null)) {
                fields.push({ key, label: String(col), type: 'number', agg: 'mean', ramp: 'viridis' });
            } else if (new Set(vals.map(String)).size <= MAX_CATEGORIES && vals.every(v => typeof v !== 'object')) {
                fields.push({ key, label: String(col), type: 'category', agg: 'mode' });
            } else continue;   // free text / nested objects — not plottable
            source[key] = col;
        }
        return { fields, source };
    }

    /** Records for CellStore.binRecords. */
    function toRecords(rows, fields, source) {
        const loc = locationColumns(rows);
        return rows.map(r => {
            const rec = {};
            if (loc.pin && r[loc.pin]) rec.digipin = r[loc.pin];
            else if (loc.lat && loc.lng) { rec.lat = _num(r[loc.lat]); rec.lng = _num(r[loc.lng]); }
            for (const f of fields) {
                if (f.key === 'count') continue;
                const v = r[source[f.key]];
                rec[f.key] = f.type === 'number' ? _num(v) : (v == null || v === '' ? null : String(v));
            }
            return rec;
        });
    }

    /**
     * Pick a level so the data's extent spans at most ~200 cells across:
     * a city-wide file lands on L7 (~244 m), a neighbourhood on L8 (~61 m).
     * Clamped to [4, 8]; DIGIPIN_CONFIG.ingestLevel overrides.
     */
    function autoLevel(records) {
        const cfg = (typeof window !== 'undefined' && window.DIGIPIN_CONFIG) || {};
        if (Number.isInteger(cfg.ingestLevel)) return cfg.ingestLevel;
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const r of records) {
            let lat = r.lat, lng = r.lng;
            if (r.digipin) {
                try { const d = DigiPin.decodePartial(String(r.digipin)); lat = d.lat; lng = d.lng; } catch { continue; }
            }
            if (lat == null || lng == null) continue;
            if (lng < w) w = lng; if (lng > e) e = lng; if (lat < s) s = lat; if (lat > n) n = lat;
        }
        if (!isFinite(w)) return 7;
        const span = Math.max(e - w, n - s);
        for (let L = 8; L >= 4; L--) {
            if (span / (36 / Math.pow(4, L)) <= 200) return L;
        }
        return 4;
    }

    function _uniqueId(name) {
        const base = slug(String(name).replace(/\.[^.]+$/, '')).slice(0, 48) || 'dataset';
        let id = 'user_' + base, i = 2;
        while (typeof CellStore !== 'undefined' && CellStore.get(id) && !CellStore.isLocal(id)) id = `user_${base}_${i++}`;
        return id;
    }

    /**
     * Bin parsed rows and register them as a dataset. Returns the registered
     * spec (or throws with a user-facing message when nothing is locatable).
     */
    function ingestRows(rows, name, level) {
        if (!rows.length) throw new Error('The file has no rows.');
        const loc = locationColumns(rows);
        if (!loc.pin && !(loc.lat && loc.lng)) {
            throw new Error('No location found — add lat/lng columns, a digipin column, or use GeoJSON.');
        }
        const { fields, source } = inferFields(rows);
        const records = toRecords(rows, fields, source);
        const L = level || autoLevel(records);
        const table = CellStore.binRecords(records, L, fields);
        if (!table.cells.length) throw new Error('No rows fell inside India’s DIGIPIN grid.');
        const id = _uniqueId(name);
        const numeric = fields.find(f => f.key !== 'count' && f.type === 'number');
        const spec = CellStore.register({
            id, title: String(name).replace(/\.[^.]+$/, ''), level: L,
            approxCellM: [0, 1e6, 25e4, 62500, 15600, 3900, 975, 244, 61, 15, 4][L],
            description: `${rows.length} rows from ${name}`, source: name, group: 'Ingested data',
            fields, default: { field: (numeric || fields[0]).key, extrude: true, heightM: 400 },
        }, table);
        _sources.set(id, { name, rows, fields, source });
        return spec;
    }

    /** Re-bin a dropped dataset at another level (keeps the toggle state). */
    async function rebin(id, level) {
        const src = _sources.get(id);
        if (!src) return false;
        const table = CellStore.binRecords(toRecords(src.rows, src.fields, src.source), level, src.fields);
        const prev = CellStore.get(id);
        CellStore.register({ ...prev, level, approxCellM: [0, 1e6, 25e4, 62500, 15600, 3900, 975, 244, 61, 15, 4][level],
            fields: src.fields.map(f => ({ ...f })) }, table);
        if (typeof CellLayers !== 'undefined' && CellLayers.isVisible(id)) await CellLayers.show(id);
        return true;
    }

    function isRebinnable(id) { return _sources.has(id); }

    function _toast(title, msg, kind) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast(title, msg, kind);
    }

    /** Read a File, ingest it, and render it in 3D. */
    async function ingestFile(file) {
        if (!file) return null;
        if (file.size > MAX_BYTES) { _toast('Plot data', `${file.name} is over 50 MB.`, 'error'); return null; }
        try {
            const rows = readRows(await file.text(), file.name);
            const spec = ingestRows(rows, file.name);
            const table = await CellStore.load(spec.id);
            _toast('Plot data', `${file.name}: ${rows.length} rows → ${table.cells.length} DIGIPIN cells at L${spec.level}.`, 'success');
            if (typeof CellLayers !== 'undefined') await CellLayers.show(spec.id);
            _flyTo(table);
            return spec;
        } catch (err) {
            _toast('Plot data', `${file.name}: ${err.message || err}`, 'error');
            return null;
        }
    }

    function _flyTo(table) {
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!map || !map.fitBounds || !table.cells.length) return;
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const c of table.cells) {
            const b = DigiPin.decodePartial(c).bounds;
            if (b.west < w) w = b.west; if (b.east > e) e = b.east;
            if (b.south < s) s = b.south; if (b.north > n) n = b.north;
        }
        map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 15, pitch: 55 });
    }

    /** Open the OS file picker. */
    function pickFile() {
        if (typeof document === 'undefined') return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv,.geojson,.json,text/csv,application/geo+json,application/json';
        input.onchange = () => ingestFile(input.files && input.files[0]);
        input.click();
    }

    /** Make the map a drop target for CSV / GeoJSON files. Idempotent. */
    function wireDropTarget(el) {
        if (_wired || !el) return;
        _wired = true;
        const isFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
        el.addEventListener('dragover', (e) => {
            if (!isFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            el.classList.add('cell-drop-active');
        });
        el.addEventListener('dragleave', () => el.classList.remove('cell-drop-active'));
        el.addEventListener('drop', (e) => {
            if (!isFiles(e)) return;
            e.preventDefault();
            el.classList.remove('cell-drop-active');
            [...e.dataTransfer.files].forEach(ingestFile);
        });
    }

    /**
     * Ranked Text2Map results → ingestible rows. Every answer becomes its own
     * layer (the source scores are never touched): rank 1 = best, `score` is
     * the weighted 0-100 value. Results without a usable position are skipped.
     */
    function rowsFromRanking(results) {
        return (results || [])
            .filter(r => r && (r.code || (Number.isFinite(r.lat) && Number.isFinite(r.lng))))
            .map((r, i) => {
                const row = { rank: i + 1, score: Math.round(Number(r.score) * 10) / 10 };
                if (r.code) row.digipin = String(r.code);
                if (Number.isFinite(r.lat)) { row.lat = r.lat; row.lng = r.lng; }
                if (r.area) row.area = String(r.area);
                return row;
            });
    }

    /** Layer name for a saved ranking: the question, no dots (they read as file extensions). */
    function rankingName(question) {
        const q = String(question || '').replace(/[.?!]+/g, ' ').replace(/\s+/g, ' ').trim();
        return 'Ranking ' + (q.length > 40 ? q.slice(0, 40).trim() + '…' : q || 'result');
    }

    /** Register a ranking as a cell-store layer; returns the spec. */
    function saveRanking(results, question) {
        const rows = rowsFromRanking(results);
        return ingestRows(rows, rankingName(question));
    }

    return {
        rowsFromRanking, rankingName, saveRanking,
        parseCSV, readRows, slug, locationColumns, inferFields, toRecords, autoLevel,
        ingestRows, ingestFile, rebin, isRebinnable, pickFile, wireDropTarget,
    };
})();

if (typeof window !== 'undefined') {
    window.CellIngest = CellIngest;
}
