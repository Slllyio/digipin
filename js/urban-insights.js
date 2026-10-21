/**
 * UrbanInsights — the explainable intelligence layer over the per-cell data
 * store (docs/CELL_STORE.md). Everything is computed in the browser from the
 * static store, and every number carries the dataset it came from, so each
 * finding can show its source card (js/provenance.js).
 *
 *   areaInsights(area)   "what's notable here": ranked strengths, concerns and
 *                        notable mixes vs the city, hotspots inside the area,
 *                        year-on-year trends and anomalies from temporal data
 *   cityDashboard()      key indicators per city, city rankings, best/worst zones
 *   compare(a, b)        area-vs-area or city-vs-city on every shared field
 *   whatIf(scenario)     park / density / flood-event scenarios: affected
 *                        cells and buildings, with the formula and assumptions
 *   evidence(lat, lng)   a cited text block that grounds DISHA's answers
 *   changes(store, city) "what changed": each monthly field's latest step vs the
 *                        same step a year earlier, with the cells that moved most
 *
 * Areas are what Analysis.parseArea accepts (a DIGIPIN prefix or a bbox), plus
 * { city: '<region>' } for a whole city and { polygon: [[lng, lat], …] } for a
 * drawn shape (cells whose centre is inside). The store is injected ({ datasets,
 * get, load, generated }), so everything here is pure and unit-tested on the
 * committed data; js/insights-panel.js owns the DOM and the map.
 *
 * Method, in one line per output:
 *   - a numeric finding is the area mean against the distribution of that
 *     field over the city's cells: effect size d = (area − city mean) / city SD,
 *     plus the area's percentile; |d| ranks the findings
 *   - a temporal field is read as its trailing-12-step mean; its trend is the
 *     mean of the last 12 steps minus the 12 before (year on year, so seasons
 *     cancel), and an anomaly is a cell whose latest year-on-year change is
 *     2+ SD from the city's
 *   - a hotspot is a parent cell where many children sit in the city's worst
 *     (or best) 10% for a finding's field
 */
const UrbanInsights = (() => {
    const SCHEMA = 'digipin.insights/1';
    const HEADLINE = ['livability', 'safety', 'walkability', 'green', 'connectivity',
        'healthcare_access', 'education_score', 'flood_risk'];
    // Cells with any of these > 0 are the built-up footprint of a city (the
    // grids cover a bbox that includes farmland, where every score is 0).
    const ACTIVE_KEYS = ['population_proxy', 'connectivity', 'infra_maturity'];
    // Direction for fields the catalog leaves neutral but are plainly risks.
    const DIRECTION = { sealable: 'worse', on_chokepoint: 'worse', has_critical_link: 'worse' };
    // Composite scores and their component weights, as in the pipeline, so a
    // finding on the composite can say which components drive it.
    const COMPOSITES = {
        'scores.livability': {
            source: 'pipeline/scores/composite.py',
            weights: { walkability: 2, safety: 3, green: 2, connectivity: 1.5, healthcare_access: 2, noise_estimate: 1.5, food_diversity: 1 },
        },
    };
    // Runtime layers this module (or the analyses) painted: never analysed.
    const OWN_LAYERS = new Set(['whatif', 'insights_hotspots', 'analysis_result', 'zones', 'lenses']);
    const FLOOD_LEVELS = { moderate: 0.9, severe: 0.75, extreme: 0.5 };
    const TREND_WINDOW = 12;

    // ── small maths ─────────────────────────────────────────────────────────

    const _isNum = (x) => x != null && typeof x !== 'boolean' && Number.isFinite(Number(x));
    const _round = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

    function stats(values) {
        let n = 0, sum = 0, sq = 0, lo = Infinity, hi = -Infinity;
        for (const v of values) {
            if (!_isNum(v)) continue;
            const x = Number(v);
            n++; sum += x; sq += x * x;
            if (x < lo) lo = x;
            if (x > hi) hi = x;
        }
        if (!n) return { n: 0, mean: null, sd: null, min: null, max: null };
        const mean = sum / n;
        return { n, mean, sd: Math.sqrt(Math.max(0, sq / n - mean * mean)), min: lo, max: hi };
    }

    function sortedFinite(values) {
        return values.filter(_isNum).map(Number).sort((a, b) => a - b);
    }

    /** Mid-rank percentile of v in ascending `sorted`, in [0,1] (ties count half). */
    function percentile(sorted, v) {
        if (!sorted || !sorted.length || !_isNum(v)) return null;
        const x = Number(v);
        let lo = 0, hi = sorted.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; }
        const below = lo;
        hi = sorted.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) lo = m + 1; else hi = m; }
        return (below + lo) / 2 / sorted.length;
    }

    /** Value at quantile q (0-1) of ascending `sorted`, linear between ranks. */
    function quantile(sorted, q) {
        if (!sorted || !sorted.length) return null;
        const pos = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
        const i = Math.floor(pos);
        const t = pos - i;
        return i + 1 < sorted.length ? sorted[i] * (1 - t) + sorted[i + 1] * t : sorted[i];
    }

    function _mean(arr) {
        let n = 0, s = 0;
        for (const v of arr || []) if (_isNum(v)) { n++; s += Number(v); }
        return n ? s / n : null;
    }

    // ── labels and formatting ───────────────────────────────────────────────

    /** "indore_pilot" → "Indore", "new_delhi" → "New Delhi". */
    function cityLabel(region) {
        if (!region) return 'the city';
        return String(region).replace(/_pilot$/, '').split('_')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    function _unit(u) {
        // "0-100"-style units restate the scale; only real units are printed.
        return u && !/^[\d.]+\s*[-–]\s*[\d.]+$/.test(u) ? u : '';
    }

    function fmt(v, unit) {
        if (v == null || !Number.isFinite(Number(v))) return '—';
        const x = Number(v), a = Math.abs(x);
        const s = a >= 100 ? String(Math.round(x)) : a >= 10 ? String(_round(x, 1)) : a >= 1 ? String(_round(x, 2)) : String(_round(x, 3));
        const u = _unit(unit);
        return u ? `${s} ${u}` : s;
    }

    function _pctText(p) {
        if (p == null) return '';
        return p >= 0.5 ? `top ${Math.max(1, Math.round((1 - p) * 100))}%` : `bottom ${Math.max(1, Math.round(p * 100))}%`;
    }

    /** "Flood Risk (Higher=Riskier)" → "Flood Risk". */
    function cleanLabel(l) {
        return String(l || '').replace(/\s*\(higher\s*=\s*[a-z]+\)/i, '').trim();
    }

    /** Lower-case a label for mid-sentence use, keeping acronyms (LST, NO₂, NDVI). */
    function lc(l) {
        const str = String(l || '');
        const cut = str.indexOf('(');
        const head = cut < 0 ? str : str.slice(0, cut), tail = cut < 0 ? '' : str.slice(cut);
        const keep = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;
        return head.split(' ').map(w => ((/^[A-Z][a-z]/.test(w) || /^[A-Z]$/.test(w)) && !keep.test(w) ? w.toLowerCase() : w)).join(' ') + tail;
    }

    function _code(c) {
        try { return DigiPin.format(c); } catch { return c; }
    }

    // ── areas, cities, columns ──────────────────────────────────────────────

    function _parseArea(a) {
        return (typeof Analysis !== 'undefined' && Analysis.parseArea) ? Analysis.parseArea(a) : null;
    }

    /** Every region (city) any dataset in the store covers, with its bbox. */
    function cities(store) {
        const out = new Map();
        for (const s of store.datasets()) {
            for (const r of s.regions || []) {
                if (!r || !r.name || !r.bbox) continue;
                const prev = out.get(r.name);
                if (!prev || (r.cells || 0) > (prev.cells || 0)) out.set(r.name, { name: r.name, label: cityLabel(r.name), bbox: r.bbox, cells: r.cells || 0 });
            }
        }
        return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    }

    function _bboxHit(a, b) {
        return !a || !b || !(a.north < b.south || a.south > b.north || a.east < b.west || a.west > b.east);
    }

    function _inBbox(b, lat, lng) {
        return !!b && lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
    }

    /** The region (city) containing a point, preferring the scores grid. */
    function cityAt(store, lat, lng) {
        const scores = store.get('scores');
        const pick = (spec) => ((spec && spec.regions) || []).find(r => _inBbox(r.bbox, lat, lng));
        const r = pick(scores) || store.datasets().map(pick).find(Boolean);
        return r ? r.name : null;
    }

    /**
     * Normalise an area: Analysis.parseArea forms, or { city }. A city area
     * keeps its region name so the city's own cells are used, not just a bbox.
     */
    /** Even-odd point-in-polygon on a [[lng, lat], …] ring. */
    function pointInPolygon(ring, lng, lat) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    /** Approximate area of a lng/lat ring in km² (equirectangular, fine at city scale). */
    function polygonKm2(ring) {
        if (!ring || ring.length < 3) return 0;
        const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length;
        const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57;
        let a = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
        return Math.abs(a) / 2;
    }

    function _polygonArea(a) {
        const ring = (a.polygon || []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
            && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180).map(p => [Number(p[0]), Number(p[1])]);
        if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
        if (ring.length < 3) return null;
        const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
        const bbox = { west: Math.min(...xs), south: Math.min(...ys), east: Math.max(...xs), north: Math.max(...ys) };
        if (!(bbox.east > bbox.west && bbox.north > bbox.south)) return null;
        const km2 = polygonKm2(ring);
        return { kind: 'polygon', polygon: ring, bbox, km2: _round(km2, 2),
            label: a.label || `Drawn area (~${km2 >= 10 ? Math.round(km2) : _round(km2, 1)} km²)` };
    }

    function resolveArea(a, store) {
        if (a && typeof a === 'object' && Array.isArray(a.polygon)) return _polygonArea(a);
        if (a && typeof a === 'object' && a.city) {
            const c = cities(store).find(x => x.name === a.city);
            if (!c) return null;
            return { kind: 'city', city: c.name, bbox: { ...c.bbox }, label: a.label || c.label };
        }
        return _parseArea(a);
    }

    function _center(area) {
        const b = area.bbox;
        return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
    }

    const _regionIdx = new WeakMap();   // table -> Map(region -> [i])

    /** Indices of a table's cells inside a catalog region (by the region bbox). */
    function cellsInRegion(spec, table, region) {
        let byRegion = _regionIdx.get(table);
        if (!byRegion) { byRegion = new Map(); _regionIdx.set(table, byRegion); }
        if (byRegion.has(region)) return byRegion.get(region);
        const r = (spec.regions || []).find(x => x.name === region);
        const out = [];
        if (r && r.bbox) {
            for (let i = 0; i < table.cells.length; i++) {
                let c;
                try { c = DigiPin.decodePartial(table.cells[i]); } catch { continue; }
                if (_inBbox(r.bbox, c.lat, c.lng)) out.push(i);
            }
        }
        byRegion.set(region, out);
        return out;
    }

    function cellsIn(spec, table, area) {
        if (area.kind === 'city') return cellsInRegion(spec, table, area.city);
        if (area.kind === 'polygon') {
            const box = Analysis.cellsInArea(table, { kind: 'bbox', bbox: area.bbox });
            const hit = box.filter(i => {
                let c;
                try { c = DigiPin.decodePartial(table.cells[i]); } catch { return false; }
                return pointInPolygon(area.polygon, c.lng, c.lat);
            });
            // A shape smaller than the data's cells: fall back to the cells in its box.
            return hit.length ? hit : box;
        }
        return Analysis.cellsInArea(table, area);
    }

    function _isTemporal(spec) {
        return !!(spec && spec.time && Array.isArray(spec.time.steps) && spec.time.steps.length);
    }

    const _scalar = new WeakMap();      // table -> Map(key -> values)

    /**
     * One value per cell for a field. A temporal field (one array per cell)
     * reads as the mean of its last 12 steps, so a monthly series compares
     * like a static score without one month's weather dominating.
     */
    function scalarColumn(spec, table, key) {
        let m = _scalar.get(table);
        if (!m) { m = new Map(); _scalar.set(table, m); }
        if (m.has(key)) return m.get(key);
        const col = (table.columns && table.columns[key]) || [];
        const out = _isTemporal(spec) || Array.isArray(col.find(v => v != null))
            ? col.map(arr => (Array.isArray(arr) ? _mean(arr.slice(-TREND_WINDOW)) : null))
            : col;
        m.set(key, out);
        return out;
    }

    /** Built-up cells of a scores-like table (any ACTIVE_KEYS value > 0). */
    function activeCells(table, idx) {
        const cols = ACTIVE_KEYS.map(k => table.columns[k]).filter(Boolean);
        if (!cols.length) return idx;
        const out = idx.filter(i => cols.some(c => Number(c[i]) > 0));
        return out.length ? out : idx;
    }

    function _fieldMeta(spec, f) {
        return { dataset: spec.id, key: f.key, label: cleanLabel(f.label || f.key), unit: f.unit || '', type: f.type || 'number',
            higherIs: f.higherIs || DIRECTION[f.key] || null };
    }

    function sourceOf(spec, store) {
        const t = spec.time;
        return {
            id: spec.id, title: spec.title || spec.id, source: spec.source || '', license: spec.license || '',
            level: spec.level, approxCellM: spec.approxCellM || null,
            generated: store && store.generated ? store.generated() : null,
            period: t && t.steps && t.steps.length ? `${t.steps[0]} to ${t.steps[t.steps.length - 1]}` : null,
            local: !!(store && store.isLocal && store.isLocal(spec.id)),
        };
    }

    function _usable(store) {
        return store.datasets().filter(s => s && Array.isArray(s.fields) && s.fields.length && !OWN_LAYERS.has(s.id));
    }

    /** Union of bboxes (nulls skipped). */
    function _union(...bs) {
        const xs = bs.filter(Boolean);
        if (!xs.length) return null;
        return { west: Math.min(...xs.map(b => b.west)), south: Math.min(...xs.map(b => b.south)),
            east: Math.max(...xs.map(b => b.east)), north: Math.max(...xs.map(b => b.north)) };
    }

    function _regionBbox(spec, region) {
        const r = ((spec && spec.regions) || []).find(x => x.name === region);
        return r ? r.bbox : null;
    }

    /**
     * A dataset's cells covering `bbox` only (the store has 20+ datasets over
     * 13 cities, so loading everything is never an option). Uses the store's
     * viewport loader when it has one; plain stores load the whole table.
     */
    /** Give the event loop a turn between heavy datasets. */
    function _breathe() {
        return new Promise(res => {
            if (typeof scheduler !== 'undefined' && scheduler.yield) scheduler.yield().then(res, res);
            else setTimeout(res, 0);
        });
    }

    function _load(store, id, bbox) {
        if (bbox && store.loadView) return store.loadView(id, bbox);
        return store.load(id);
    }

    // ── insights ────────────────────────────────────────────────────────────

    function _drivers(spec, table, f, idxA, idxC) {
        const comp = COMPOSITES[`${spec.id}.${f.key}`];
        if (!comp) return null;
        const total = Object.values(comp.weights).reduce((a, b) => a + b, 0);
        const out = [];
        for (const [k, w] of Object.entries(comp.weights)) {
            const sf = spec.fields.find(x => x.key === k);
            if (!sf) continue;
            const col = scalarColumn(spec, table, k);
            const a = stats(idxA.map(i => col[i])).mean;
            const c = stats(idxC.map(i => col[i])).mean;
            if (a == null || c == null) continue;
            out.push({ key: k, label: sf.label || k, area: _round(a), city: _round(c), contribution: _round((a - c) * w / total, 2), weight: w });
        }
        out.sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
        return { formula: `${f.label || f.key} = weighted mean of ${out.map(d => `${d.label} ×${d.weight}`).join(', ')} (÷${total})`,
            source: comp.source, parts: out };
    }

    function _numericFinding(spec, table, f, idxA, idxC, ctx) {
        const col = scalarColumn(spec, table, f.key);
        const a = stats(idxA.map(i => col[i]));
        const cVals = idxC.map(i => col[i]);
        const c = stats(cVals);
        if (!a.n || c.n < 5 || !(c.sd > 0)) return null;
        const d = (a.mean - c.mean) / c.sd;
        if (Math.abs(d) < ctx.minEffect) return null;
        const meta = _fieldMeta(spec, f);
        const sorted = sortedFinite(cVals);
        const pct = percentile(sorted, a.mean);
        const good = meta.higherIs === 'better' ? d : meta.higherIs === 'worse' ? -d : null;
        const kind = good == null ? 'notable' : good > 0 ? 'strength' : 'concern';
        const up = d > 0;
        const ratio = c.mean > 0 && a.mean >= 0 ? a.mean / c.mean : null;
        const vs = ratio != null && (ratio >= 1.25 || ratio <= 0.8) && c.mean >= 1
            ? (ratio >= 1.25 ? `${_round(ratio, 1)}× the ${ctx.cityLabel} average` : `${Math.round((1 - ratio) * 100)}% below the ${ctx.cityLabel} average`)
            : `${up ? 'above' : 'below'} the ${ctx.cityLabel} average`;
        const extreme = idxA.filter(i => _isNum(col[i])).sort((x, y) => (up ? col[y] - col[x] : col[x] - col[y])).slice(0, 3)
            .map(i => ({ digipin: _code(table.cells[i]), code: table.cells[i], value: _round(Number(col[i]), 2) }));
        const nCells = `${a.n} cell${a.n === 1 ? '' : 's'}`;
        const temporal = _isTemporal(spec) ? ' (12-month mean)' : '';
        const detail = `${meta.label}${temporal} is ${fmt(a.mean, meta.unit)} here across ${nCells}, vs ${fmt(c.mean, meta.unit)} for ${ctx.cityLabel} (${c.n} cells)`
            + (pct != null ? `, ${_pctText(pct)} of the city.` : '.');
        return {
            id: `${spec.id}.${f.key}`, kind, ...meta, value: _round(a.mean, 2), baseline: _round(c.mean, 2),
            effect: _round(d, 2), percentile: _round(pct, 3), n: a.n,
            salience: _round(Math.min(4, Math.abs(d)) * (kind === 'concern' ? 1.15 : 1) * (a.n >= 3 ? 1 : 0.85), 3),
            title: `${meta.label} ${vs}`, detail, cells: extreme,
            drivers: _drivers(spec, table, f, idxA, idxC),
            threshold: { up, value: quantile(sorted, up ? 0.9 : 0.1) },
            sources: [spec.id],
        };
    }

    function _shareFinding(spec, table, f, idxA, idxC, ctx) {
        const col = table.columns[f.key] || [];
        const meta = _fieldMeta(spec, f);
        const share = (idx, pred) => {
            const vals = idx.map(i => col[i]).filter(v => v != null);
            return vals.length ? { n: vals.length, share: vals.filter(pred).length / vals.length } : null;
        };
        let pred, what;
        if (f.type === 'boolean') {
            pred = (v) => !!v;
            what = `${lc(meta.label)}`;
        } else {
            const counts = new Map();
            idxA.forEach(i => { const v = col[i]; if (v != null) counts.set(String(v), (counts.get(String(v)) || 0) + 1); });
            if (!counts.size) return null;
            const mode = [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0];
            pred = (v) => String(v) === mode;
            what = `${lc(meta.label)} "${mode}"`;
        }
        const a = share(idxA, pred), c = share(idxC, pred);
        if (!a || !c || a.n < 3) return null;
        const diff = a.share - c.share;
        if (Math.abs(diff) < 0.15 || (f.type !== 'boolean' && (a.share < 0.35 || diff < 0.2))) return null;
        const kind = meta.higherIs === 'worse' ? (diff > 0 ? 'concern' : 'strength') : meta.higherIs === 'better' ? (diff > 0 ? 'strength' : 'concern') : 'notable';
        const hits = idxA.filter(i => col[i] != null && pred(col[i])).slice(0, 3)
            .map(i => ({ digipin: _code(table.cells[i]), code: table.cells[i], value: col[i] }));
        return {
            id: `${spec.id}.${f.key}`, kind, ...meta, value: _round(a.share * 100), baseline: _round(c.share * 100),
            unit: '%', n: a.n, salience: _round(Math.min(3, Math.abs(diff) * 4) * (f.type === 'boolean' ? 1 : 0.6), 3),
            title: `${Math.round(a.share * 100)}% of cells: ${what}`,
            detail: `${Math.round(a.share * 100)}% of ${a.n} ${spec.title} cells here are ${what}, vs ${Math.round(c.share * 100)}% across ${ctx.cityLabel}.`,
            cells: hits, sources: [spec.id],
        };
    }

    /**
     * Year-on-year view of one temporal field: per-cell change between the
     * last TREND_WINDOW steps and the TREND_WINDOW before, the area's and the
     * city's mean series, and the cells whose latest change is unusual.
     */
    function trendOf(spec, table, f, idxA, idxC) {
        const steps = table.times || (spec.time && spec.time.steps) || [];
        const col = table.columns[f.key] || [];
        const T = steps.length;
        if (T < 4) return null;
        const w = Math.min(TREND_WINDOW, Math.floor(T / 2));
        const yoy = (arr) => {
            if (!Array.isArray(arr)) return null;
            const late = arr.slice(T - w), early = arr.slice(T - 2 * w, T - w);
            const ok = (xs) => xs.filter(_isNum).length >= Math.ceil(xs.length / 2);
            return ok(late) && ok(early) ? _mean(late) - _mean(early) : null;
        };
        const latestDelta = (arr) => {
            if (!Array.isArray(arr) || T < w + 1) return null;
            let t = T - 1;
            while (t >= w && !_isNum(arr[t])) t--;
            return t >= w && _isNum(arr[t - w]) ? { step: t, delta: Number(arr[t]) - Number(arr[t - w]) } : null;
        };
        const seriesMean = (idx) => steps.map((_, t) => _round(_mean(idx.map(i => (col[i] || [])[t])), 3));
        const cityYoy = idxC.map(i => yoy(col[i])).filter(_isNum);
        const areaYoy = idxA.map(i => yoy(col[i])).filter(_isNum);
        if (!areaYoy.length || cityYoy.length < 5) return null;
        const cs = stats(cityYoy);
        const level = stats(idxC.map(i => _mean((col[i] || []).slice(-w))));
        const aMean = _mean(areaYoy);
        // Unusual cells: latest step vs the same step a window earlier.
        const cityLatest = idxC.map(i => latestDelta(col[i])).filter(Boolean);
        const ls = stats(cityLatest.map(x => x.delta));
        const anomalies = [];
        if (ls.n >= 5 && ls.sd > 0) {
            for (const i of idxA) {
                const ld = latestDelta(col[i]);
                if (!ld) continue;
                const z = (ld.delta - ls.mean) / ls.sd;
                if (Math.abs(z) >= 2) anomalies.push({ digipin: _code(table.cells[i]), code: table.cells[i], z: _round(z, 2), delta: _round(ld.delta, 3), step: steps[ld.step], vs: steps[ld.step - w] });
            }
            anomalies.sort((x, y) => Math.abs(y.z) - Math.abs(x.z));
        }
        return {
            window: w, steps, unit: spec.time && spec.time.unit,
            area: { yoy: _round(aMean, 3), series: seriesMean(idxA) },
            city: { yoy: _round(cs.mean, 3), sd: _round(cs.sd, 3), series: seriesMean(idxC) },
            levelSd: level.sd,
            anomalies: anomalies.slice(0, 5), anomalyCount: anomalies.length,
            to: `${steps[T - w]}–${steps[T - 1]}`, from: `${steps[T - 2 * w]}–${steps[T - w - 1]}`,
        };
    }

    function _trendFindings(spec, table, f, idxA, idxC, ctx) {
        const tr = trendOf(spec, table, f, idxA, idxC);
        if (!tr) return [];
        const meta = _fieldMeta(spec, f);
        const out = [];
        const yoy = tr.area.yoy;
        const scale = tr.levelSd > 0 ? tr.levelSd : (tr.city.sd || 1);
        const rel = Math.abs(yoy) / scale;
        const dir = yoy > 0 ? 'rising' : 'falling';
        const good = meta.higherIs === 'better' ? yoy > 0 : meta.higherIs === 'worse' ? yoy < 0 : null;
        const inLine = tr.city.sd > 0 && Math.abs(yoy - tr.city.yoy) < 0.5 * tr.city.sd;
        const per = tr.unit === 'month' ? 'year on year' : `over ${tr.window} ${tr.unit || 'step'}s`;
        out.push({
            id: `${spec.id}.${f.key}.trend`, kind: 'trend', good, ...meta, value: yoy, baseline: tr.city.yoy,
            n: idxA.length, salience: _round(Math.min(3, Math.abs(yoy - tr.city.yoy) / (tr.city.sd || scale)) + 0.5 * Math.min(1, rel), 3),
            title: `${meta.label} ${dir} ${per}: ${yoy > 0 ? '+' : ''}${fmt(yoy, meta.unit)}${inLine ? `, in line with ${ctx.cityLabel}` : ''}`,
            detail: `Mean ${lc(meta.label)} for ${tr.to} vs ${tr.from}: ${yoy > 0 ? '+' : ''}${fmt(yoy, meta.unit)} here, ${tr.city.yoy > 0 ? '+' : ''}${fmt(tr.city.yoy, meta.unit)} across ${ctx.cityLabel}.`,
            series: { steps: tr.steps, area: tr.area.series, city: tr.city.series },
            cells: [], sources: [spec.id],
        });
        if (tr.anomalyCount) {
            const top = tr.anomalies[0];
            out.push({
                id: `${spec.id}.${f.key}.anomaly`, kind: 'anomaly', good: null, ...meta, value: top.delta, n: tr.anomalyCount,
                salience: _round(Math.min(3.5, Math.abs(top.z) * 0.8), 3),
                title: `Unusual ${lc(meta.label)} in ${top.step}: ${tr.anomalyCount} cell${tr.anomalyCount === 1 ? '' : 's'}`,
                detail: `${tr.anomalyCount} cell${tr.anomalyCount === 1 ? ' here' : 's here'} changed by 2+ standard deviations more than ${ctx.cityLabel}'s cells between ${top.vs} and ${top.step}. Largest: ${top.digipin}, ${top.delta > 0 ? '+' : ''}${fmt(top.delta, meta.unit)} (z = ${top.z}).`,
                cells: tr.anomalies.map(a => ({ digipin: a.digipin, code: a.code, value: a.delta, z: a.z })), sources: [spec.id],
            });
        }
        return out;
    }

    /** Parent cells of the area where many children sit past a finding's city threshold. */
    function _hotspots(finding, spec, table, idxA, area, ctx) {
        if (!finding.threshold || finding.threshold.value == null || idxA.length < 6) return [];
        const col = scalarColumn(spec, table, finding.key);
        const lvl = table.level;
        const minLen = area.kind === 'prefix' ? area.code.length + 1 : 1;
        const plen = Math.max(minLen, lvl - 1);
        if (plen >= lvl) return [];
        const { up, value } = finding.threshold;
        const groups = new Map();
        for (const i of idxA) {
            const v = col[i];
            if (!_isNum(v)) continue;
            const key = table.cells[i].slice(0, plen);
            const g = groups.get(key) || { code: key, of: 0, n: 0, sum: 0 };
            g.of++;
            if (up ? v >= value : v <= value) { g.n++; g.sum += Number(v); }
            groups.set(key, g);
        }
        const tail = finding.kind === 'strength' ? 'best' : finding.kind === 'concern' ? 'worst' : (up ? 'highest' : 'lowest');
        return [...groups.values()].filter(g => g.n >= 2 && g.n / g.of >= 0.25)
            .sort((a, b) => b.n - a.n || (up ? b.sum / b.n - a.sum / a.n : a.sum / a.n - b.sum / b.n))
            .slice(0, 2)
            .map(g => {
                let c = null;
                try { c = DigiPin.decodePartial(g.code); } catch { /* bad code */ }
                return {
                    code: g.code, digipin: _code(g.code), level: plen, kind: finding.kind, finding: finding.id,
                    dataset: spec.id, field: finding.key, label: finding.label, unit: finding.unit,
                    n: g.n, of: g.of, mean: _round(g.sum / g.n, 2), lat: c ? c.lat : null, lng: c ? c.lng : null,
                    why: `${g.n} of ${g.of} cells in ${_code(g.code)} are in ${ctx.cityLabel}'s ${tail} 10% for ${lc(finding.label)} (mean ${fmt(g.sum / g.n, finding.unit)}).`,
                    sources: [spec.id],
                };
            });
    }

    /**
     * "What's notable here": ranked findings for an area against its city.
     * opts: { city, limit (8), minEffect (0.35), now }.
     */
    async function areaInsights(areaIn, store, opts = {}) {
        store = store || (typeof CellStore !== 'undefined' ? CellStore : null);
        if (!store) throw new Error('The cell store is not available.');
        const area = resolveArea(areaIn, store);
        if (!area) throw new Error('Pick an area: a DIGIPIN prefix, a map extent or a city.');
        const ctr = _center(area);
        const city = area.kind === 'city' ? area.city : (opts.city || cityAt(store, ctr.lat, ctr.lng));
        const ctx = { cityLabel: cityLabel(city), minEffect: opts.minEffect ?? 0.35 };
        const findings = [], hotspots = [], used = [], coverage = [];
        const specs = _usable(store).filter(sp => (sp.regions || []).length === 0 || (sp.regions || []).some(r => !r.bbox || _bboxHit(r.bbox, area.bbox)));
        const tables = await Promise.all(specs.map(sp => _load(store, sp.id, _union(area.bbox, city ? _regionBbox(sp, city) : null)).catch(() => null)));
        for (let k = 0; k < specs.length; k++) {
            const spec = specs[k], table = tables[k];
            if (!table || !table.cells || !table.cells.length) continue;
            // One dataset per task: ~30 datasets of stats in one go froze the
            // page for over a second on a cell click.
            if (k) await _breathe();
            const idxA = cellsIn(spec, table, area);
            if (!idxA.length) continue;
            let idxC = city ? cellsInRegion(spec, table, city) : [];
            if (!idxC.length) idxC = table.cells.map((_, i) => i);
            if (spec.id === 'scores') idxC = activeCells(table, idxC);
            coverage.push({ id: spec.id, title: spec.title || spec.id, cells: idxA.length, level: table.level });
            used.push(sourceOf(spec, store));
            const temporal = _isTemporal(spec);
            for (const f of spec.fields) {
                const type = f.type || 'number';
                if (type === 'number') {
                    if (area.kind !== 'city') {
                        const fd = _numericFinding(spec, table, f, idxA, idxC, ctx);
                        if (fd) {
                            findings.push(fd);
                            hotspots.push(..._hotspots(fd, spec, table, idxA, area, ctx));
                        }
                    }
                    if (temporal) findings.push(..._trendFindings(spec, table, f, idxA, idxC, ctx));
                } else if (area.kind !== 'city') {
                    const fd = _shareFinding(spec, table, f, idxA, idxC, ctx);
                    if (fd) findings.push(fd);
                }
            }
        }
        // A composite and its own components say the same thing twice: keep
        // the components only when they are notable in their own right.
        findings.sort((a, b) => b.salience - a.salience || (a.id < b.id ? -1 : 1));
        const limit = opts.limit || 8;
        // At most two findings per dataset, so one rich dataset (many related
        // fields saying the same thing) cannot crowd out the rest.
        const perDs = new Map();
        const ranked = findings.filter(f => {
            const n = perDs.get(f.dataset) || 0;
            perDs.set(f.dataset, n + 1);
            return n < (opts.perDataset || 2);
        });
        const top = ranked.slice(0, limit);
        const seen = new Set();
        const hs = hotspots.filter(h => top.some(f => f.id === h.finding))
            .sort((a, b) => b.n - a.n)
            .filter(h => (seen.has(h.code) || seen.has(h.dataset) ? false : (seen.add(h.code), seen.add(h.dataset), true)))
            .slice(0, 5);
        return {
            schema: SCHEMA, kind: 'insights', ranAt: (opts.now ? opts.now() : new Date()).toISOString(),
            area, city, cityLabel: ctx.cityLabel,
            headline: headline(top, area, ctx),
            findings: top, more: Math.max(0, findings.length - top.length), hotspots: hs,
            coverage, sources: used,
            method: 'Each finding compares the area mean with the distribution of the same field over the city’s cells '
                + '(effect size = difference ÷ city standard deviation). Monthly series read as their last-12-month mean; '
                + 'trends compare the last 12 months with the 12 before. Scores are compared over built-up cells only.',
        };
    }

    /** One sentence for the top of an insights report. */
    function headline(findings, area, ctx) {
        if (!findings.length) return `Nothing here stands out from the ${ctx.cityLabel} average in the published data.`;
        const pick = (kind) => {
            const ds = new Set();
            const names = [];
            for (const f of findings) {
                if (f.kind !== kind || ds.has(f.dataset) || names.length >= 2) continue;
                const n = lc(f.label);
                // "daytime LST" and "daytime LST Apr–Jun 2025" are one point.
                if (names.some(x => n.startsWith(x.split(' (')[0]) || x.startsWith(n.split(' (')[0]))) continue;
                ds.add(f.dataset);
                names.push(n);
            }
            return names;
        };
        const s = pick('strength'), c = pick('concern');
        const parts = [];
        if (s.length) parts.push(`stands out for ${s.join(' and ')}`);
        if (c.length) parts.push(`${s.length ? 'but ' : ''}lags on ${c.join(' and ')}`);
        const t = findings.find(f => f.kind === 'trend' && Math.abs(f.salience) >= 1);
        if (t) parts.push(`and ${lc(t.label)} is ${t.value > 0 ? 'rising' : 'falling'}`);
        return parts.length ? `${area.label} ${parts.join(', ')} compared with ${ctx.cityLabel}.`
            : `${area.label}: ${findings[0].title}.`;
    }

    // ── city dashboard ──────────────────────────────────────────────────────

    /**
     * Key indicators for every city on the scores grid (built-up cells only),
     * the city rankings, an overall index, and each city's best and worst
     * level-5 zones. Temporal datasets add their latest-year means where a
     * city has them. opts: { dataset ('scores'), fields (HEADLINE), now }.
     */
    async function cityDashboard(store, opts = {}) {
        store = store || (typeof CellStore !== 'undefined' ? CellStore : null);
        const spec = store && store.get(opts.dataset || 'scores');
        const table = spec ? await store.load(spec.id) : null;
        if (!spec || !table) return { schema: SCHEMA, kind: 'dashboard', cities: [], fields: [], sources: [] };
        const fields = (opts.fields || HEADLINE).map(k => spec.fields.find(f => f.key === k)).filter(Boolean).map(f => _fieldMeta(spec, f));
        const out = [];
        for (const r of spec.regions || []) {
            const all = cellsInRegion(spec, table, r.name);
            if (!all.length) continue;
            const idx = activeCells(table, all);
            const indicators = {};
            for (const f of fields) {
                const col = table.columns[f.key] || [];
                const st = stats(idx.map(i => col[i]));
                indicators[f.key] = { mean: _round(st.mean), sd: _round(st.sd) };
            }
            const zones = _zones(spec, table, idx);
            out.push({ region: r.name, label: cityLabel(r.name), cells: all.length, active: idx.length,
                areaKm2: Math.round(idx.length * Math.pow((spec.approxCellM || 975) / 1000, 2)), indicators, zones, extras: [] });
        }
        // Rankings per indicator, direction-aware (1 = best).
        for (const f of fields) {
            const sign = f.higherIs === 'worse' ? 1 : -1;
            [...out].filter(c => c.indicators[f.key].mean != null)
                .sort((a, b) => sign * (a.indicators[f.key].mean - b.indicators[f.key].mean))
                .forEach((c, i) => { c.indicators[f.key].rank = i + 1; });
        }
        for (const c of out) {
            const parts = fields.map(f => {
                const m = c.indicators[f.key].mean;
                return m == null ? null : (f.higherIs === 'worse' ? 100 - m : m);
            }).filter(v => v != null);
            c.index = _round(_mean(parts));
            const ranked = fields.filter(f => c.indicators[f.key].rank).sort((a, b) => c.indicators[a.key].rank - c.indicators[b.key].rank);
            c.strengths = ranked.slice(0, 2).map(f => ({ key: f.key, label: f.label, rank: c.indicators[f.key].rank }));
            c.weaknesses = ranked.slice(-2).reverse().map(f => ({ key: f.key, label: f.label, rank: c.indicators[f.key].rank }));
        }
        out.sort((a, b) => (b.index ?? -1) - (a.index ?? -1));
        out.forEach((c, i) => { c.rank = i + 1; });
        // Temporal extras: latest-12-step mean per city that has the series.
        const sources = [sourceOf(spec, store)];
        // Only the coarse (level ≤ 6) series: they are small enough to read for every city.
        for (const ts of _usable(store).filter(x => _isTemporal(x) && x.level <= 6)) {
            const tt = await store.load(ts.id);
            if (!tt) continue;
            let usedTs = false;
            for (const c of out) {
                const idx = cellsInRegion(ts, tt, c.region);
                if (!idx.length) continue;
                for (const f of ts.fields) {
                    const col = scalarColumn(ts, tt, f.key);
                    const m = stats(idx.map(i => col[i])).mean;
                    if (m == null) continue;
                    const tr = trendOf(ts, tt, f, idx, idx);
                    c.extras.push({ dataset: ts.id, key: f.key, label: f.label || f.key, unit: f.unit || '', higherIs: f.higherIs || null,
                        mean: _round(m, 3), yoy: tr ? tr.city.yoy : null, series: tr ? tr.city.series : null, steps: tr ? tr.steps : null });
                    usedTs = true;
                }
            }
            if (usedTs) sources.push(sourceOf(ts, store));
        }
        return {
            schema: SCHEMA, kind: 'dashboard', ranAt: (opts.now ? opts.now() : new Date()).toISOString(),
            dataset: spec.id, fields, cities: out, sources,
            method: 'Means over each city’s built-up cells (population, connectivity or infrastructure above 0). '
                + 'The urban index is the mean of the headline scores with flood risk inverted. Rank 1 is best.',
        };
    }

    /** Best / worst level-5 zones (~4 km) of a city by livability, and its flood hotspots. */
    function _zones(spec, table, idx) {
        const lvl = Math.max(1, table.level - 1);
        const roll = (key) => {
            const col = table.columns[key];
            if (!col) return [];
            const acc = new Map();
            for (const i of idx) {
                if (!_isNum(col[i])) continue;
                const k = table.cells[i].slice(0, lvl);
                const a = acc.get(k) || { n: 0, s: 0 };
                a.n++; a.s += Number(col[i]);
                acc.set(k, a);
            }
            return [...acc].filter(([, a]) => a.n >= 3).map(([k, a]) => ({ code: k, digipin: _code(k), mean: _round(a.s / a.n), cells: a.n }));
        };
        const liv = roll('livability').sort((a, b) => b.mean - a.mean);
        const flood = roll('flood_risk').sort((a, b) => b.mean - a.mean);
        return { level: lvl, best: liv.slice(0, 3), worst: liv.slice(-3).reverse(), flood: flood.slice(0, 3) };
    }

    // ── zone leaderboard ────────────────────────────────────────────────────

    /** Numeric fields a city can be ranked on: [{ dataset, key, label, unit, higherIs, group }]. */
    function rankableFields(store, city) {
        const out = [];
        for (const spec of _usable(store)) {
            if (city && !(spec.regions || []).some(r => r.name === city)) continue;
            if (!(spec.level >= 6)) continue;
            for (const f of spec.fields) {
                if (f.type && f.type !== 'number') continue;
                const m = _fieldMeta(spec, f);
                out.push({ dataset: spec.id, key: f.key, label: m.label, unit: m.unit, higherIs: m.higherIs, group: spec.title || spec.id });
            }
        }
        return out;
    }

    /**
     * Rank a city's zones (DIGIPIN level 5, ~4 km by default) on one field:
     * the mean of their cells (built-up cells only for the scores grid; a
     * monthly series reads as its last-12-step mean). Rank 1 is the best
     * zone when the field has a direction, else the highest.
     */
    async function zoneRanking(store, opts = {}) {
        const { city, dataset, field } = opts;
        const spec = store.get(dataset);
        if (!spec) throw new Error(`No dataset "${dataset}".`);
        const f = spec.fields.find(x => x.key === field);
        if (!f) throw new Error(`No field "${field}" in ${dataset}.`);
        const table = await _load(store, dataset, city ? _regionBbox(spec, city) : null);
        if (!table || !table.cells) throw new Error(`No ${dataset} data here.`);
        const lvl = Math.max(1, Math.min(opts.level || 5, table.level - 1));
        let idx = city ? cellsInRegion(spec, table, city) : table.cells.map((_, i) => i);
        if (dataset === 'scores') idx = activeCells(table, idx);
        const col = scalarColumn(spec, table, field);
        const minCells = opts.minCells || 3;
        const acc = new Map();
        for (const i of idx) {
            if (!_isNum(col[i])) continue;
            const k = table.cells[i].slice(0, lvl);
            const a = acc.get(k) || { n: 0, s: 0 };
            a.n++; a.s += Number(col[i]);
            acc.set(k, a);
        }
        const meta = _fieldMeta(spec, f);
        const sign = meta.higherIs === 'worse' ? 1 : -1;
        const zones = [...acc].filter(([, a]) => a.n >= minCells)
            .map(([k, a]) => ({ code: k, digipin: _code(k), mean: _round(a.s / a.n, 3), cells: a.n }))
            .sort((a, b) => sign * (a.mean - b.mean));
        const sorted = sortedFinite(zones.map(z => z.mean));
        zones.forEach((z, i) => { z.rank = i + 1; z.pct = _round(percentile(sorted, z.mean), 3); });
        const cityMean = _round(stats(idx.map(i => col[i])).mean, 3);
        return {
            schema: SCHEMA, kind: 'zones', city, cityLabel: cityLabel(city), ...meta, level: lvl,
            zones, cityMean, temporal: _isTemporal(spec),
            sources: [sourceOf(spec, store)],
            method: `Mean of each zone’s ${spec.approxCellM ? `~${spec.approxCellM} m ` : ''}cells (zones with at least ${minCells} cells)`
                + (dataset === 'scores' ? ', built-up cells only' : '') + (_isTemporal(spec) ? ', reading the series as its last-12-step mean' : '')
                + `. Rank 1 is ${meta.higherIs ? 'the best' : 'the highest'}.`,
        };
    }

    // ── compare ─────────────────────────────────────────────────────────────

    /**
     * Area-vs-area (or city-vs-city) on every numeric field both have data
     * for. A side "wins" a field when it is better by 5% of the field's span.
     */
    async function compare(aIn, bIn, store, opts = {}) {
        store = store || (typeof CellStore !== 'undefined' ? CellStore : null);
        const A = resolveArea(aIn, store), B = resolveArea(bIn, store);
        if (!A || !B) throw new Error('Pick two areas (DIGIPIN prefixes, map extents or cities).');
        const rows = [], used = [];
        const covers = (sp, ar) => (sp.regions || []).some(r => !r.bbox || _bboxHit(r.bbox, ar.bbox));
        const specs = _usable(store).filter(sp => covers(sp, A) && covers(sp, B));
        const side = (sp, ar) => _load(store, sp.id, ar.kind === 'city' ? (_regionBbox(sp, ar.city) || ar.bbox) : ar.bbox).catch(() => null);
        const tA = await Promise.all(specs.map(sp => side(sp, A)));
        const tB = await Promise.all(specs.map(sp => side(sp, B)));
        for (let k = 0; k < specs.length; k++) {
            const spec = specs[k], ta = tA[k], tb = tB[k];
            if (!ta || !tb) continue;
            const ia = cellsIn(spec, ta, A), ib = cellsIn(spec, tb, B);
            if (!ia.length || !ib.length) continue;
            const isScores = spec.id === 'scores';
            const fa = isScores && A.kind !== 'prefix' ? activeCells(ta, ia) : ia;
            const fb = isScores && B.kind !== 'prefix' ? activeCells(tb, ib) : ib;
            used.push(sourceOf(spec, store));
            for (const f of spec.fields) {
                if ((f.type || 'number') !== 'number') continue;
                const ca = scalarColumn(spec, ta, f.key), cb = scalarColumn(spec, tb, f.key);
                const sa = stats(fa.map(i => ca[i])), sb = stats(fb.map(i => cb[i]));
                if (!sa.n || !sb.n) continue;
                const meta = _fieldMeta(spec, f);
                const both = stats([...fa.map(i => ca[i]), ...fb.map(i => cb[i])]);
                const span = Array.isArray(f.domain) && f.domain.length === 2 && f.domain[1] > f.domain[0]
                    ? f.domain[1] - f.domain[0] : (both.max - both.min) || 1;
                const delta = sa.mean - sb.mean;
                let winner = 'tie';
                if (Math.abs(delta) >= 0.05 * span && meta.higherIs) {
                    winner = (meta.higherIs === 'better') === (delta > 0) ? 'a' : 'b';
                }
                rows.push({ ...meta, a: _round(sa.mean, 2), b: _round(sb.mean, 2), delta: _round(delta, 2), na: sa.n, nb: sb.n, winner, span });
            }
        }
        rows.sort((x, y) => Math.abs(y.delta / y.span) - Math.abs(x.delta / x.span));
        const wins = { a: rows.filter(r => r.winner === 'a').length, b: rows.filter(r => r.winner === 'b').length };
        const directional = rows.filter(r => r.higherIs).length;
        wins.tie = directional - wins.a - wins.b;
        const lead = (side) => rows.filter(r => r.winner === side).slice(0, 3).map(r => lc(r.label));
        const better = wins.a === wins.b ? null : wins.a > wins.b ? 'a' : 'b';
        const L = { a: A.label, b: B.label };
        const summary = !rows.length ? 'These two areas share no datasets to compare.'
            : better
                ? `${L[better]} comes out ahead on ${wins[better]} of ${directional} indicators that have a better direction (notably ${lead(better).join(', ') || 'overall'}); `
                  + `${L[better === 'a' ? 'b' : 'a']} leads on ${wins[better === 'a' ? 'b' : 'a']}${lead(better === 'a' ? 'b' : 'a').length ? ` (${lead(better === 'a' ? 'b' : 'a').join(', ')})` : ''}.`
                : `${L.a} and ${L.b} are evenly matched: ${wins.a} wins each of ${directional} indicators that have a better direction.`;
        return { schema: SCHEMA, kind: 'compare', ranAt: (opts.now ? opts.now() : new Date()).toISOString(),
            a: A, b: B, rows, wins, directional, better, summary, sources: used };
    }

    // ── what-if scenarios ───────────────────────────────────────────────────

    /** The 8 DIGIPIN neighbours of a cell at the same level (fewer at the grid edge). */
    function neighbours(code) {
        let c;
        try { c = DigiPin.decodePartial(code); } catch { return []; }
        const b = c.bounds;
        const dLat = b.north - b.south, dLng = b.east - b.west;
        const out = new Set();
        for (const di of [-1, 0, 1]) {
            for (const dj of [-1, 0, 1]) {
                if (!di && !dj) continue;
                try {
                    const n = DigiPin.encode(c.lat + di * dLat, c.lng + dj * dLng).replace(/-/g, '').slice(0, code.length);
                    if (n !== code) out.add(n);
                } catch { /* off the grid */ }
            }
        }
        return [...out];
    }

    function _idxOf(table, code) {
        if (!table || !code) return -1;
        const i = table.index ? table.index.get(code) : table.cells.indexOf(code);
        return i == null ? -1 : i;
    }

    function _children(table, prefixes) {
        const out = [];
        if (!table) return out;
        for (let i = 0; i < table.cells.length; i++) {
            const c = table.cells[i];
            if (prefixes.some(p => c.startsWith(p))) out.push(i);
        }
        return out;
    }

    function _heightsUnder(heights, prefixes) {
        if (!heights || !heights.cells) return null;
        const hs = [];
        for (const [code, m] of Object.entries(heights.cells)) {
            if (_isNum(m) && prefixes.some(p => code.startsWith(p))) hs.push(Number(m));
        }
        if (!hs.length) return { blocks: 0 };
        const st = stats(hs);
        return { blocks: hs.length, meanM: _round(st.mean), floors: _round(st.mean / 3.2, 1),
            lowRise: _round(hs.filter(h => h < 6.5).length / hs.length * 100), level: heights.level || 8 };
    }

    function _scoresCtx(store) {
        const spec = store.get('scores');
        if (!spec) throw new Error('The scores grid is not in the cell store.');
        return spec;
    }

    async function _park(sc, store) {
        const spec = _scoresCtx(store);
        const table = await store.load('scores');
        const code = String(sc.code || '').replace(/-/g, '').toUpperCase().slice(0, table.level);
        if (code.length < table.level) throw new Error(`Pick a cell (at least ${table.level} DIGIPIN characters) for the park.`);
        const boost = Math.max(5, Math.min(80, Number(sc.boost) || 40));
        const ring = _round(boost * 0.35);
        const comp = COMPOSITES['scores.livability'];
        const W = Object.values(comp.weights).reduce((a, b) => a + b, 0);
        const wg = comp.weights.green;
        const ctr = DigiPin.decodePartial(code);
        const city = cityAt(store, ctr.lat, ctr.lng);
        const cityIdx = activeCells(table, city ? cellsInRegion(spec, table, city) : table.cells.map((_, i) => i));
        const sortedLiv = sortedFinite(cityIdx.map(i => table.columns.livability[i]));
        const cells = [];
        for (const [c, b] of [[code, boost], ...neighbours(code).map(n => [n, ring])]) {
            const i = _idxOf(table, c);
            if (i < 0) continue;
            const g0 = Number(table.columns.green[i]) || 0, l0 = Number(table.columns.livability[i]) || 0;
            const g1 = Math.min(100, g0 + b);
            const l1 = l0 + (g1 - g0) * wg / W;
            cells.push({ code: c, digipin: _code(c), target: c === code,
                before: { green: _round(g0), livability: _round(l0), pct: _round(percentile(sortedLiv, l0), 3) },
                after: { green: _round(g1), livability: _round(l1), pct: _round(percentile(sortedLiv, l1), 3) },
                delta: _round(l1 - l0, 2) });
        }
        if (!cells.length) throw new Error(`No scores for ${_code(code)}: pick a cell inside a covered city.`);
        const t = cells.find(c => c.target) || cells[0];
        const ring8 = cells.filter(c => !c.target);
        return {
            title: `New park at ${_code(code)}`,
            summary: `Livability at ${t.digipin} would rise from ${t.before.livability} to ${t.after.livability} `
                + `(${_pctText(t.before.pct)} → ${_pctText(t.after.pct)} of ${cityLabel(city)})`
                + (ring8.length ? `, and ${ring8.length} neighbouring cells gain about ${_round(_mean(ring8.map(c => c.delta)))} points.` : '.'),
            metrics: [
                { label: 'Livability (park cell)', before: t.before.livability, after: t.after.livability },
                { label: 'Green score (park cell)', before: t.before.green, after: t.after.green },
                { label: 'Cells improved', value: cells.filter(c => c.delta > 0).length },
            ],
            cells, layer: { key: 'delta_livability', label: 'Livability gain', unit: 'points', higherIs: 'better', level: table.level,
                values: cells.map(c => [c.code, c.delta]) },
            formula: `Δ livability = Δ green × ${wg}/${W} (${comp.source})`,
            assumptions: [
                `The park lifts the green score of its cell by ${boost} points and each neighbouring cell by ${ring} (scores cap at 100).`,
                `Livability is recomputed with the pipeline’s own weights: green carries ${wg} of ${W}.`,
                'Other scores are held fixed; cooling, flood and land-value effects are not modelled.',
            ],
            sources: [sourceOf(spec, store)], city,
        };
    }

    async function _density(sc, store, opts) {
        const spec = _scoresCtx(store);
        const table = await store.load('scores');
        const code = String(sc.code || '').replace(/-/g, '').toUpperCase().slice(0, table.level);
        if (code.length < table.level) throw new Error(`Pick a cell (at least ${table.level} DIGIPIN characters) to densify.`);
        const factor = Math.max(1.05, Math.min(5, Number(sc.factor) || 1.5));
        const i = _idxOf(table, code);
        if (i < 0) throw new Error(`No scores for ${_code(code)}.`);
        const ctr = DigiPin.decodePartial(code);
        const city = cityAt(store, ctr.lat, ctr.lng);
        const cityIdx = activeCells(table, city ? cellsInRegion(spec, table, city) : table.cells.map((_, k) => k));
        const pop = table.columns.population_proxy || [];
        const popCity = sortedFinite(cityIdx.map(k => pop[k]).filter(v => Number(v) > 0));
        let p0 = Number(pop[i]) || 0;
        const assumedPop = p0 <= 0;
        if (assumedPop) p0 = quantile(popCity, 0.5) || 10;
        const p1 = p0 * factor;   // an index, so it may pass 100 in a scenario
        const services = ['healthcare_access', 'education_score', 'public_service', 'connectivity']
            .filter(k => table.columns[k]).map(k => {
                const f = spec.fields.find(x => x.key === k) || { key: k };
                const col = table.columns[k];
                const ratios = sortedFinite(cityIdx.filter(j => Number(pop[j]) > 0).map(j => (Number(col[j]) || 0) / Number(pop[j])));
                const p25 = quantile(ratios, 0.25);
                const s = Number(col[i]) || 0;
                const r0 = s / p0, r1 = s / p1;
                // Shown per 100 population-index points so small ratios stay readable.
                return { key: k, label: cleanLabel(f.label || k), score: _round(s), perCapitaBefore: _round(r0 * 100, 2), perCapitaAfter: _round(r1 * 100, 2),
                    cityP25: _round((p25 || 0) * 100, 2), none: s <= 0, underServed: s <= 0 || (p25 != null && r1 < p25),
                    newlyUnderServed: s > 0 && p25 != null && r1 < p25 && r0 >= p25 };
            });
        const kids = [code];
        const heights = _heightsUnder(opts.heights, kids);
        const cb = DigiPin.decodePartial(code).bounds;
        const traffic = store.get('traffic') ? await _load(store, 'traffic', cb) : null;
        const tIdx = _children(traffic, kids);
        let road = null;
        if (tIdx.length) {
            const cr = stats(tIdx.map(k => traffic.columns.congestion_risk[k]));
            const los = traffic.columns.worst_los || [];
            const ef = tIdx.filter(k => los[k] === 'E' || los[k] === 'F').length;
            road = { cells: tIdx.length, congestion: _round(cr.mean), losEF: _round(ef / tIdx.length * 100) };
        }
        const gaps = services.filter(s => s.underServed);
        const none = services.filter(s => s.none), fresh = services.filter(s => s.newlyUnderServed);
        const metrics = [
            { label: 'Population index', before: _round(p0), after: _round(p1) },
            ...services.map(s => ({ label: `${s.label} per 100 residents (index)`, before: s.perCapitaBefore, after: s.perCapitaAfter, flag: s.underServed })),
        ];
        if (heights && heights.blocks) metrics.push({ label: 'Avg floors needed (same footprint)', before: heights.floors, after: _round(heights.floors * factor, 1) });
        if (road) metrics.push({ label: 'Road cells at LOS E/F', value: `${road.losEF}% of ${road.cells}` });
        const sources = [sourceOf(spec, store)];
        if (road) sources.push(sourceOf(store.get('traffic'), store));
        return {
            title: `${factor}× density at ${_code(code)}`,
            summary: `With ${factor}× the residents at ${_code(code)}, `
                + (none.length ? `${none.map(s => lc(s.label)).join(', ')} ${none.length === 1 ? 'is' : 'are'} missing within reach today` : '')
                + (none.length && fresh.length ? ', and ' : '')
                + (fresh.length ? `${fresh.map(s => lc(s.label)).join(', ')} would drop into ${cityLabel(city)}’s bottom quarter per resident` : '')
                + (!none.length && !fresh.length ? `local services stay above ${cityLabel(city)}’s bottom quarter per resident` : '')
                + (heights && heights.blocks ? `; today’s ${heights.blocks} built blocks average ${heights.floors} floors, so the same footprint needs about ${_round(heights.floors * factor, 1)}` : '')
                + (road ? `; ${road.losEF}% of its road cells already run at LOS E/F.` : '.'),
            metrics, services, heights, road,
            cells: [{ code, digipin: _code(code), target: true, delta: _round(p1 - p0, 1) }],
            layer: { key: 'service_gaps', label: 'Services short per resident', unit: 'count', higherIs: 'worse', level: table.level, values: [[code, gaps.length]] },
            formula: 'Service per resident = service score ÷ population index; flagged below the city’s 25th percentile of built-up cells',
            assumptions: [
                assumedPop ? `No residents are mapped in this cell, so it starts at the ${cityLabel(city)} median population index (${_round(p0)}).` : `Population index scales by ${factor} (it may pass 100: it is relative to today’s densest cells).`,
                'Service scores (facilities within reach) are held fixed: nothing new is built.',
                'Floors = mean Open Buildings height ÷ 3.2 m; the extra floors assume the same footprint.',
            ],
            sources, city,
        };
    }

    const _truthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';

    /** Load a dataset over a city (or a bbox) and index it by cell code. */
    async function _byCode(store, id, bbox) {
        if (!store.get(id)) return null;
        const t = await _load(store, id, bbox).catch(() => null);
        if (!t || !t.cells) return null;
        const m = new Map();
        t.cells.forEach((c, i) => m.set(c, i));
        return { t, m, col: (k) => (t.columns && t.columns[k]) || [] };
    }

    /** Least squares y = a + b1·x1 + b2·x2 (normal equations). Null when degenerate. */
    function ols2(rows) {
        const n = rows.length;
        if (n < 10) return null;
        let s1 = 0, s2 = 0, sy = 0;
        for (const [x1, x2, y] of rows) { s1 += x1; s2 += x2; sy += y; }
        const m1 = s1 / n, m2 = s2 / n, my = sy / n;
        let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0, syy = 0;
        for (const [x1, x2, y] of rows) {
            const d1 = x1 - m1, d2 = x2 - m2, dy = y - my;
            a11 += d1 * d1; a12 += d1 * d2; a22 += d2 * d2; b1 += d1 * dy; b2 += d2 * dy; syy += dy * dy;
        }
        const det = a11 * a22 - a12 * a12;
        if (!(Math.abs(det) > 1e-9) || syy <= 0) return null;
        const k1 = (b1 * a22 - b2 * a12) / det, k2 = (a11 * b2 - a12 * b1) / det;
        const r2 = (k1 * b1 + k2 * b2) / syy;
        return { b1: k1, b2: k2, a: my - k1 * m1 - k2 * m2, r2, n };
    }

    /** Trees for heat: city-fitted cooling per point of tree cover, applied to a ~1 km site. */
    async function _cool(sc, store) {
        const code = String(sc.code || '').replace(/-/g, '').toUpperCase().slice(0, 6);
        if (code.length < 6) throw new Error('Pick a cell (at least 6 DIGIPIN characters) to green.');
        const trees = Math.max(5, Math.min(60, Number(sc.trees) || 20));
        const heat = store.get('surface_heat'), lc_ = store.get('land_cover');
        if (!heat || !lc_) throw new Error('The cooling scenario needs the surface heat and land cover layers.');
        const ctr = DigiPin.decodePartial(code);
        const city = cityAt(store, ctr.lat, ctr.lng);
        const H = await _byCode(store, 'surface_heat', city ? _regionBbox(heat, city) : DigiPin.decodePartial(code).bounds);
        const L = await _byCode(store, 'land_cover', city ? _regionBbox(lc_, city) : DigiPin.decodePartial(code).bounds);
        if (!H || !L) throw new Error('No heat or land-cover data here.');
        const lst = H.col('lst_day_c'), uhi = H.col('uhi_anomaly_c');
        const tree = L.col('tree_pct'), built = L.col('built_pct'), water = L.col('water_pct');
        const cityIdx = city ? cellsInRegion(heat, H.t, city) : H.t.cells.map((_, i) => i);
        const rows = [];
        for (const i of cityIdx) {
            const j = L.m.get(H.t.cells[i]);
            if (j == null || !_isNum(lst[i]) || !_isNum(tree[j]) || !_isNum(built[j])) continue;
            rows.push([Number(tree[j]), Number(built[j]), Number(lst[i])]);
        }
        const fit = ols2(rows);
        const slope = fit && fit.b1 < 0 ? fit.b1 : 0;
        const sortedLst = sortedFinite(cityIdx.map(i => lst[i]));
        const hot = quantile(sortedLst, 0.9);
        const P = await _byCode(store, 'population', DigiPin.decodePartial(code).bounds);
        const cells = [];
        for (let i = 0; i < H.t.cells.length; i++) {
            const c = H.t.cells[i];
            if (!c.startsWith(code) || !_isNum(lst[i])) continue;
            const j = L.m.get(c);
            const t0 = j != null && _isNum(tree[j]) ? Number(tree[j]) : 0;
            const w0 = j != null && _isNum(water[j]) ? Number(water[j]) : 0;
            const add = Math.max(0, Math.min(trees, 100 - t0 - w0));
            const d = slope * add;
            const pi = P ? P.m.get(c) : null;
            cells.push({ code: c, digipin: _code(c), tree0: _round(t0), add: _round(add, 1),
                before: _round(Number(lst[i]), 2), after: _round(Number(lst[i]) + d, 2), delta: _round(-d, 2),
                uhi0: _isNum(uhi[i]) ? Number(uhi[i]) : null, people: pi != null ? Number(P.col('population')[pi]) || 0 : 0 });
        }
        if (!cells.length) throw new Error(`No surface temperature for ${_code(code)}: pick a cell inside a covered city.`);
        const mb = _mean(cells.map(c => c.before)), ma = _mean(cells.map(c => c.after));
        const uh = cells.filter(c => c.uhi0 != null);
        const hotB = cells.filter(c => c.before >= hot).length, hotA = cells.filter(c => c.after >= hot).length;
        const people = Math.round(cells.reduce((a, c) => a + c.people, 0));
        const per10 = _round(-slope * 10, 2);
        const sources = [sourceOf(heat, store), sourceOf(lc_, store)];
        if (P) sources.push(sourceOf(store.get('population'), store));
        return {
            title: `+${trees} pts tree cover at ${_code(code)}`,
            summary: slope < 0
                ? `Adding up to ${trees} points of tree cover across ${cells.length} cells at ${_code(code)} would cool daytime surfaces by about ${_round(mb - ma, 1)} °C `
                    + `(${_round(mb, 1)} → ${_round(ma, 1)} °C)${hotB ? `, taking ${hotB - hotA} of ${hotB} cells out of ${cityLabel(city)}’s hottest 10%` : ''}`
                    + (people ? ` for about ${people.toLocaleString('en-IN')} residents.` : '.')
                : `${cityLabel(city)}’s own data shows no cooling from tree cover once built-up share is accounted for, so this scenario predicts no change.`,
            metrics: [
                { label: 'Daytime surface temp (mean)', before: _round(mb, 1), after: _round(ma, 1) },
                ...(uh.length ? [{ label: 'Urban heat island anomaly', before: _round(_mean(uh.map(c => c.uhi0)), 1), after: _round(_mean(uh.map(c => c.uhi0 - c.delta)), 1) }] : []),
                ...(hotB ? [{ label: `Cells in the city’s hottest 10% (≥ ${_round(hot, 1)} °C)`, before: hotB, after: hotA }] : []),
                { label: 'Cooling per +10 pts tree cover (fitted)', value: `${per10} °C · R² ${fit ? _round(fit.r2, 2) : '—'} · ${fit ? fit.n : 0} cells` },
                ...(people ? [{ label: 'Residents in the site', value: people.toLocaleString('en-IN') }] : []),
            ],
            cells: cells.sort((a, b) => b.delta - a.delta),
            layer: { key: 'cooling_c', label: 'Daytime cooling', unit: '°C', higherIs: 'better', level: H.t.level, values: cells.map(c => [c.code, c.delta]) },
            formula: `Δ LST = b × Δ tree %, with b = ${fit ? _round(fit.b1, 4) : '—'} °C per point fitted on ${cityLabel(city)}: LST ~ tree % + built %`,
            assumptions: [
                `Each ~244 m cell gains up to ${trees} points of tree cover (never past 100% with water).`,
                'Built-up share is held fixed: the trees go on streets, yards and open land.',
                'The slope is the city’s own cross-sectional association, not a measured experiment; shade and evapotranspiration at street level can differ.',
                'Landsat daytime land surface temperature, not air temperature.',
            ],
            sources, city,
        };
    }

    /** Road closure: roads in the closed cells divert onto the roads two rings around them. */
    async function _closure(sc, store) {
        const raw = String(sc.code || '').replace(/-/g, '').toUpperCase();
        const code = raw.slice(0, Math.min(7, raw.length));
        if (code.length < 6) throw new Error('Pick a cell (at least 6 DIGIPIN characters) to close.');
        const tr = store.get('traffic');
        if (!tr) throw new Error('The road closure scenario needs the traffic layer.');
        const ctr = DigiPin.decodePartial(code);
        const city = cityAt(store, ctr.lat, ctr.lng);
        const b = DigiPin.decodePartial(code).bounds;
        const pad = 0.012;
        const box = { west: b.west - pad, south: b.south - pad, east: b.east + pad, north: b.north + pad };
        const T = await _byCode(store, 'traffic', box);
        if (!T) throw new Error('No road data here.');
        const lvl = T.t.level;
        const closed = T.t.cells.filter(c => c.startsWith(code));
        if (!closed.length) throw new Error(`No mapped roads in ${_code(code)}.`);
        const closedSet = new Set(closed);
        let ring = new Set(closed);
        for (let k = 0; k < 2; k++) {
            const next = new Set(ring);
            for (const c of ring) for (const n of neighbours(c.slice(0, lvl))) next.add(n);
            ring = next;
        }
        const around = [...ring].filter(c => !closedSet.has(c) && T.m.has(c));
        const len = T.col('road_density_m'), cong = T.col('congestion_risk'), crit = T.col('has_critical_link');
        const stops = T.col('transit_stops');
        const L = (c) => Number(len[T.m.get(c)]) || 0;
        const closedLen = closed.reduce((a, c) => a + L(c), 0);
        const aroundLen = around.reduce((a, c) => a + L(c), 0);
        const extra = aroundLen > 0 ? closedLen / aroundLen : 0;
        const M = await _byCode(store, 'mobility', box);
        const P = await _byCode(store, 'population', box);
        const mob = (c, k) => (M && M.m.has(c) ? M.col(k)[M.m.get(c)] : null);
        const ppl = (c) => (P && P.m.has(c) ? Number(P.col('population')[P.m.get(c)]) || 0 : 0);
        const cells = around.map(c => {
            const c0 = Number(cong[T.m.get(c)]) || 0;
            const c1 = Math.min(100, c0 * (1 + extra));
            return { code: c, digipin: _code(c), before: _round(c0), after: _round(c1), delta: _round(c1 - c0, 1), roadM: Math.round(L(c)) };
        }).filter(x => x.roadM > 0).sort((x, y) => y.delta - x.delta);
        const jamB = cells.filter(x => x.before >= 70).length, jamA = cells.filter(x => x.after >= 70).length;
        const critClosed = closed.filter(c => _truthy(crit[T.m.get(c)])).length;
        const chokes = closed.filter(c => _truthy(mob(c, 'on_chokepoint'))).length;
        const sealNear = [...closed, ...around].filter(c => _truthy(mob(c, 'sealable')));
        const cutPeople = Math.round(sealNear.reduce((a, c) => a + ppl(c), 0));
        const stopsLost = closed.reduce((a, c) => a + (Number(stops[T.m.get(c)]) || 0), 0);
        const sources = [sourceOf(tr, store)];
        if (M) sources.push(sourceOf(store.get('mobility'), store));
        if (P) sources.push(sourceOf(store.get('population'), store));
        return {
            title: `Road closure at ${_code(code)}`,
            summary: `Closing ${closedLen < 1000 ? `${Math.round(closedLen)} m` : `${Math.round(closedLen / 100) / 10} km`} of road in ${closed.length} cell${closed.length === 1 ? '' : 's'} at ${_code(code)} pushes about ${Math.round(extra * 100)}% more traffic onto `
                + `${cells.length} surrounding road cells: ${jamA} would run congested (risk ≥ 70), up from ${jamB}`
                + (critClosed ? `; ${critClosed} closed cell${critClosed === 1 ? '' : 's'} carr${critClosed === 1 ? 'ies' : 'y'} a critical link` : '')
                + (chokes ? `; ${chokes} sit${chokes === 1 ? 's' : ''} on a chokepoint` : '')
                + (cutPeople ? `; about ${cutPeople.toLocaleString('en-IN')} people live in sealable pockets nearby` : '') + '.',
            metrics: [
                { label: 'Road closed', value: `${closedLen < 1000 ? `${Math.round(closedLen)} m` : `${Math.round(closedLen / 100) / 10} km`} in ${closed.length} cells` },
                { label: 'Extra load on nearby roads', value: `+${Math.round(extra * 100)}%` },
                { label: 'Nearby road cells congested (≥ 70)', before: jamB, after: jamA, flag: jamA > jamB },
                { label: 'Mean congestion risk nearby', before: _round(_mean(cells.map(x => x.before))), after: _round(_mean(cells.map(x => x.after))) },
                { label: 'Critical links closed', value: critClosed, flag: critClosed > 0 },
                ...(M ? [{ label: 'Chokepoints closed', value: chokes, flag: chokes > 0 }] : []),
                ...(stopsLost ? [{ label: 'Transit stops inside the closure', value: stopsLost }] : []),
                ...(P && M ? [{ label: 'People in sealable pockets nearby', value: cutPeople.toLocaleString('en-IN') }] : []),
            ],
            cells, closed: closed.map(c => ({ code: c, digipin: _code(c) })),
            layer: { key: 'congestion_delta', label: 'Extra congestion risk', unit: 'points', higherIs: 'worse', level: lvl, values: cells.map(x => [x.code, x.delta]) },
            formula: 'Diverted share = closed road length ÷ road length in the two rings of cells around it; congestion after = congestion × (1 + share), capped at 100',
            assumptions: [
                'Traffic on the closed roads spreads over nearby roads in proportion to their length; trips are not cancelled or rerouted further out.',
                'Congestion risk is the pipeline’s structural score (road class, density, junctions), not live traffic.',
                'Sealable pockets and chokepoints come from the law & order mobility layer (pipeline/safety/mobility.py).',
            ],
            sources, city,
        };
    }

    async function _flood(sc, store, opts) {
        const spec = _scoresCtx(store);
        const table = await store.load('scores');
        const level = FLOOD_LEVELS[sc.level] ? sc.level : 'severe';
        let area = sc.area ? resolveArea(sc.area, store) : null;
        if (!area) {
            const city = sc.city || (sc.lat != null ? cityAt(store, sc.lat, sc.lng) : (spec.regions[0] || {}).name);
            area = resolveArea({ city }, store);
        }
        if (!area) throw new Error('Pick an area or city for the flood event.');
        const ctr = _center(area);
        const city = area.kind === 'city' ? area.city : cityAt(store, ctr.lat, ctr.lng);
        const cityIdx = activeCells(table, city ? cellsInRegion(spec, table, city) : table.cells.map((_, i) => i));
        const fr = table.columns.flood_risk, pop = table.columns.population_proxy || [], liv = table.columns.livability || [];
        // The event floods the city's riskiest share of cells (rank-based, so
        // the many ties in a coarse score don't swell or shrink the event);
        // ties go to the more populated cell.
        const order = cityIdx.filter(i => _isNum(fr[i]))
            .sort((a, b) => fr[b] - fr[a] || (Number(pop[b]) || 0) - (Number(pop[a]) || 0));
        const flooded = new Set(order.slice(0, Math.ceil(order.length * (1 - FLOOD_LEVELS[level]))));
        const thr = order.length ? Number(fr[[...flooded].pop()]) : null;
        const inArea = new Set(activeCells(table, cellsIn(spec, table, area)));
        const hit = [...inArea].filter(i => flooded.has(i));
        const codes = hit.map(i => table.cells[i]);
        const mob = store.get('mobility') ? await _load(store, 'mobility', area.bbox) : null;
        const tra = store.get('traffic') ? await _load(store, 'traffic', area.bbox) : null;
        const mi = _children(mob, codes), ti = _children(tra, codes);
        const mobility = mi.length ? {
            cells: mi.length,
            sealable: mi.filter(i => mob.columns.sealable && mob.columns.sealable[i]).length,
            chokepoints: mi.filter(i => mob.columns.on_chokepoint && mob.columns.on_chokepoint[i]).length,
            policeKm: _round(stats(mi.map(i => (mob.columns.nearest_police_km || [])[i])).mean, 2),
        } : null;
        const roads = ti.length ? { cells: ti.length, criticalLinks: ti.filter(i => tra.columns.has_critical_link && tra.columns.has_critical_link[i]).length } : null;
        const heights = _heightsUnder(opts.heights, codes);
        const exposure = hit.reduce((a, i) => a + (Number(pop[i]) || 0), 0);
        const ranked = hit.map(i => ({ code: table.cells[i], digipin: _code(table.cells[i]), flood_risk: _round(Number(fr[i])),
            population: _round(Number(pop[i]) || 0), livability: _round(Number(liv[i]) || 0),
            exposure: _round(Number(fr[i]) * (1 + (Number(pop[i]) || 0) / 100), 1) }))
            .sort((a, b) => b.exposure - a.exposure);
        const sources = [sourceOf(spec, store)];
        if (mobility) sources.push(sourceOf(store.get('mobility'), store));
        if (roads) sources.push(sourceOf(store.get('traffic'), store));
        const metrics = [
            { label: 'Cells flooded', value: `${hit.length} of ${inArea.size}` },
            { label: 'Population exposure (index sum)', value: _round(exposure) },
        ];
        if (heights && heights.blocks) metrics.push({ label: 'Built blocks (~61 m) affected', value: `${heights.blocks} · ${heights.lowRise}% low-rise` });
        if (mobility) metrics.push({ label: 'Sealable pockets / chokepoints', value: `${mobility.sealable} / ${mobility.chokepoints}` }, { label: 'Mean distance to police', value: `${mobility.policeKm} km` });
        if (roads) metrics.push({ label: 'Critical road links under water', value: roads.criticalLinks });
        return {
            title: `${level.charAt(0).toUpperCase() + level.slice(1)} flood event · ${area.label}`,
            summary: `A ${level} event (the riskiest ${Math.round((1 - FLOOD_LEVELS[level]) * 100)}% of ${cityLabel(city)}’s built-up cells, flood risk ≥ ${_round(thr)}) reaches ${hit.length} of ${inArea.size} built-up cells`
                + (heights && heights.blocks ? `, ${heights.blocks} built blocks (${heights.lowRise}% low-rise, ground plus one at most)` : '')
                + (mobility && (mobility.sealable || mobility.chokepoints) ? `, ${mobility.sealable} sealable pockets and ${mobility.chokepoints} chokepoints` : '')
                + (roads && roads.criticalLinks ? `, and ${roads.criticalLinks} critical road links` : '') + '.',
            metrics, mobility, roads, heights, threshold: _round(thr), level,
            cells: ranked,
            layer: { key: 'exposure', label: 'Flood exposure', unit: '', higherIs: 'worse', level: table.level, values: ranked.map(c => [c.code, c.exposure]) },
            formula: 'Flooded = the city’s riskiest cells by flood_risk for the event level (ties to the more populated cell); exposure = flood_risk × (1 + population index ÷ 100)',
            assumptions: [
                'Flood risk is the pipeline’s terrain and drainage score (pipeline/scores/flood_scs.py), not a hydraulic model.',
                'Event levels flood the riskiest 10% (moderate), 25% (severe) or 50% (extreme) of the city’s built-up cells.',
                'Buildings are Open Buildings 2.5D height blocks at DIGIPIN level 8; low-rise means under 6.5 m.',
            ],
            sources, city, area,
        };
    }

    /**
     * Run a what-if scenario. { type: 'park', code, boost } |
     * { type: 'density', code, factor } | { type: 'flood', level, area|city|lat,lng } |
     * { type: 'cool', code, trees } | { type: 'closure', code }.
     * opts.heights = a baked height grid ({ level, cells }) for building counts.
     */
    async function whatIf(scenario, store, opts = {}) {
        store = store || (typeof CellStore !== 'undefined' ? CellStore : null);
        if (!scenario || !store) throw new Error('No scenario.');
        const run = { park: _park, density: _density, flood: _flood, cool: _cool, closure: _closure }[scenario.type];
        if (!run) throw new Error(`Unknown scenario "${scenario.type}". Try park, density, flood, cool or closure.`);
        const res = await run(scenario, store, opts);
        return { schema: SCHEMA, kind: 'whatif', type: scenario.type, scenario, ranAt: (opts.now ? opts.now() : new Date()).toISOString(), ...res };
    }

    const BENEFIT = { park: true, cool: true, density: null, flood: false, closure: false };

    /**
     * A plan: several what-ifs run together. Each runs on its own (their models
     * do not interact), then the plan reports where they overlap, which is
     * where a benefit and a burden land on the same place.
     */
    async function runPlan(scenarios, store, opts = {}) {
        const list = (scenarios || []).slice(0, 8);
        if (!list.length) throw new Error('The plan is empty: add a scenario first.');
        const items = [];
        for (const sc of list) {
            try { items.push(await whatIf(sc, store, opts)); } catch (e) { items.push({ kind: 'error', type: sc.type, scenario: sc, title: sc.type, error: e && e.message ? e.message : String(e) }); }
        }
        const ok = items.filter(r => r.kind === 'whatif');
        // Cells touched, keyed at level 6 (~1 km) so park/heat (L6) and road/flood (L7) cells meet.
        const touch = new Map();
        ok.forEach((r, k) => {
            const cells = [...(r.cells || []), ...(r.closed || [])];
            for (const c of cells) {
                const key = String(c.code).slice(0, 6);
                if (!touch.has(key)) touch.set(key, new Set());
                touch.get(key).add(k);
            }
        });
        const overlaps = [];
        for (const [code, ks] of touch) {
            if (ks.size < 2) continue;
            const types = [...ks].map(k => ok[k].type);
            const good = types.some(t => BENEFIT[t] === true), bad = types.some(t => BENEFIT[t] === false);
            overlaps.push({ code, digipin: _code(code), scenarios: [...ks].map(k => ok[k].title), tradeOff: good && bad });
        }
        overlaps.sort((a, b) => (b.tradeOff - a.tradeOff) || (b.scenarios.length - a.scenarios.length));
        const seen = new Set(), sources = [];
        ok.forEach(r => (r.sources || []).forEach(x => { if (!seen.has(x.id)) { seen.add(x.id); sources.push(x); } }));
        const trade = overlaps.filter(o => o.tradeOff).length;
        const failed = items.length - ok.length;
        return {
            schema: SCHEMA, kind: 'plan', ranAt: (opts.now ? opts.now() : new Date()).toISOString(),
            items, overlaps: overlaps.slice(0, 20), cells: touch.size, sources,
            summary: `${ok.length} scenario${ok.length === 1 ? '' : 's'} touch ${touch.size} ~1 km cell${touch.size === 1 ? '' : 's'}`
                + (overlaps.length ? `; ${overlaps.length} cell${overlaps.length === 1 ? ' is' : 's are'} hit by more than one scenario${trade ? `, and ${trade === 1 ? 'it mixes' : `${trade} of them mix`} a benefit with a burden` : ''}` : '; none overlap')
                + (failed ? ` (${failed} could not run)` : '') + '.',
            method: 'Each scenario runs with its own model and inputs; they are not chained. Overlaps are counted on ~1 km cells.',
        };
    }

    /** A what-if or hotspot result as a runtime cell-store dataset ({ spec, table }). */
    function toLayer(result, id = 'whatif') {
        const l = result && result.layer;
        if (!l || !l.values || !l.values.length) return null;
        const sorted = l.values.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1));
        return {
            spec: { id, title: `What-if: ${result.title}`, description: result.summary, source: 'js/urban-insights.js',
                license: 'Derived from the cell store', group: 'What-if scenarios', level: l.level,
                fields: [{ key: l.key, label: l.label, type: 'number', agg: 'mean', unit: l.unit, ramp: l.higherIs === 'worse' ? 'reds' : 'greens', higherIs: l.higherIs }],
                default: { field: l.key, extrude: true, heightM: 500 } },
            table: { level: l.level, cells: sorted.map(v => v[0]), columns: { [l.key]: sorted.map(v => v[1]) } },
        };
    }

    // ── DISHA grounding ─────────────────────────────────────────────────────

    /**
     * Cited evidence for a point: the cell's values in every dataset (with its
     * city percentile) and the top findings for its ~1 km neighbourhood. Each
     * dataset gets a tag [C1], [C2]… that DISHA cites and the chat renders as
     * a source card. Returns { text, citations:[{tag, ...source}], insights }.
     */
    async function evidence(lat, lng, store, opts = {}) {
        store = store || (typeof CellStore !== 'undefined' ? CellStore : null);
        if (!store || !store.datasets().length) return { text: '', citations: [], insights: null };
        const tags = new Map();
        const tag = (spec) => {
            if (!tags.has(spec.id)) tags.set(spec.id, { tag: `C${tags.size + 1}`, ...sourceOf(spec, store) });
            return tags.get(spec.id).tag;
        };
        const city = cityAt(store, lat, lng);
        const lines = [];
        const here = { west: lng, east: lng, south: lat, north: lat };
        const specs = _usable(store).filter(sp => !(sp.regions || []).length || sp.regions.some(r => !r.bbox || _inBbox(r.bbox, lat, lng)));
        const tables = await Promise.all(specs.map(sp => _load(store, sp.id, (city && _regionBbox(sp, city)) || here).catch(() => null)));
        for (let k = 0; k < specs.length; k++) {
            const spec = specs[k], table = tables[k];
            if (!table) continue;
            const code = (() => { try { return DigiPin.encode(lat, lng).replace(/-/g, '').slice(0, table.level); } catch { return null; } })();
            const i = _idxOf(table, code);
            if (i < 0) continue;
            const cityIdx = city ? cellsInRegion(spec, table, city) : [];
            const vals = [];
            for (const f of spec.fields) {
                const col = (f.type || 'number') === 'number' ? scalarColumn(spec, table, f.key) : (table.columns[f.key] || []);
                const v = col[i];
                if (v == null) continue;
                if ((f.type || 'number') === 'number') {
                    const sorted = cityIdx.length ? sortedFinite(cityIdx.map(k => col[k])) : [];
                    const p = sorted.length && sorted[0] !== sorted[sorted.length - 1] ? percentile(sorted, v) : null;
                    vals.push(`${f.label || f.key}=${fmt(v, f.unit)}${p != null ? ` (${_pctText(p)} of ${cityLabel(city)})` : ''}`);
                } else vals.push(`${f.label || f.key}=${f.type === 'boolean' ? (v ? 'yes' : 'no') : v}`);
            }
            if (vals.length) lines.push(`[${tag(spec)}] ${spec.title} at ${_code(code)}${_isTemporal(spec) ? ' (12-month mean)' : ''}: ${vals.join('; ')}`);
        }
        let ins = null;
        try {
            const code6 = DigiPin.encode(lat, lng).replace(/-/g, '').slice(0, opts.level || 5);
            ins = await areaInsights({ code: code6, label: `the area around ${_code(code6)}` }, store, { limit: opts.limit || 5 });
            if (ins.findings.length) {
                lines.push('', `Notable in ${ins.area.label} (vs ${ins.cityLabel}):`);
                for (const f of ins.findings) {
                    const spec = store.get(f.dataset);
                    lines.push(`- [${spec ? tag(spec) : '?'}] ${f.kind.toUpperCase()}: ${f.title}. ${f.detail}`);
                }
                for (const h of ins.hotspots.slice(0, 3)) {
                    const spec = store.get(h.dataset);
                    lines.push(`- [${spec ? tag(spec) : '?'}] HOTSPOT: ${h.why}`);
                }
            }
        } catch { /* outside every dataset */ }
        if (!lines.length) return { text: '', citations: [], insights: ins };
        const citations = [...tags.values()];
        const text = ['=== CELL STORE EVIDENCE (cite as [C#]) ===', ...lines, '', 'Sources:',
            ...citations.map(c => `[${c.tag}] ${c.title} — ${c.source || 'cell store'}${c.license ? `, ${c.license}` : ''}${c.period ? `, ${c.period}` : ''}`)].join('\n');
        return { text, citations, insights: ins };
    }

    /** Plain-text rendering of any result (offline DISHA answers, copy, export). */
    // ── what changed ────────────────────────────────────────────────────────

    /**
     * "What changed": for every temporal field covering the city, the city mean
     * at its latest step vs the same step one window (a year, for monthly data)
     * earlier, how unusual that move is against the series' own year-on-year
     * swings, and the cells whose own change stands out (|z| ≥ 2).
     */
    async function changes(store, opts = {}) {
        const city = opts.city || null;
        const items = [], used = [];
        for (const spec of _usable(store).filter(_isTemporal)) {
            if (city && !(spec.regions || []).some(r => r.name === city)) continue;
            const table = await _load(store, spec.id, city ? _regionBbox(spec, city) : null).catch(() => null);
            if (!table || !table.cells || !table.cells.length) continue;
            const idx = city ? cellsInRegion(spec, table, city) : table.cells.map((_, i) => i);
            if (idx.length < 5) continue;
            let usedHere = false;
            for (const f of spec.fields) {
                if (f.type && f.type !== 'number') continue;
                const tr = trendOf(spec, table, f, idx, idx);
                if (!tr) continue;
                const ser = tr.city.series;
                let t = ser.length - 1;
                while (t >= 0 && !_isNum(ser[t])) t--;
                const w = tr.window;
                if (t < w || !_isNum(ser[t - w])) continue;
                const latest = ser[t], prev = ser[t - w];
                const delta = latest - prev;
                // Typical size of a same-step-a-year-apart move in this series.
                const swings = [];
                for (let k = w; k < ser.length; k++) if (_isNum(ser[k]) && _isNum(ser[k - w])) swings.push(Math.abs(ser[k] - ser[k - w]));
                const typical = _mean(swings) || 0;
                const meta = _fieldMeta(spec, f);
                const good = meta.higherIs === 'better' ? delta > 0 : meta.higherIs === 'worse' ? delta < 0 : null;
                const z = typical > 0 ? Math.abs(delta) / typical : 0;
                const share = tr.anomalyCount / idx.length;
                const label = meta.label;
                const step = tr.steps[t], vs = tr.steps[t - w];
                const yrs = /^\d{4}$/.test(step) && /^\d{4}$/.test(vs) ? Number(step) - Number(vs) : null;
                const per = tr.unit === 'month' ? 'same-month' : yrs ? `${yrs}-year` : `${w}-step`;
                const pct = Math.abs(prev) > 1e-9 ? (delta / Math.abs(prev)) * 100 : null;
                items.push({
                    ...meta, step, vs, latest: _round(latest, 3), prev: _round(prev, 3), delta: _round(delta, 3),
                    pct: _round(pct, 1), good, unusual: _round(z, 2), cells: idx.length,
                    anomalyCount: tr.anomalyCount, anomalies: tr.anomalies,
                    series: ser, steps: tr.steps,
                    salience: _round(Math.min(3, z) + Math.min(1, share * 10), 3),
                    title: `${label} in ${step}: ${fmt(latest, meta.unit)}, ${delta >= 0 ? 'up' : 'down'} ${fmt(Math.abs(delta), meta.unit)} on ${vs}`,
                    detail: `${z >= 1.5 ? 'A bigger move than usual' : z >= 0.75 ? 'A typical-sized move' : 'A small move'} for ${cityLabel(city)} `
                        + `(typical ${per} change ${fmt(typical, meta.unit)})`
                        + (tr.anomalyCount ? `; ${tr.anomalyCount} cell${tr.anomalyCount === 1 ? '' : 's'} changed unusually.` : '.'),
                    sources: [spec.id],
                });
                usedHere = true;
            }
            if (usedHere) used.push(sourceOf(spec, store));
        }
        items.sort((a, b) => b.salience - a.salience);
        const latest = items.reduce((m, x) => (x.step > m ? x.step : m), '');
        return {
            schema: SCHEMA, kind: 'changes', ranAt: (opts.now ? opts.now() : new Date()).toISOString(),
            city, cityLabel: cityLabel(city), latest, items: items.slice(0, opts.limit || 12), more: Math.max(0, items.length - (opts.limit || 12)),
            sources: used,
            method: 'City mean at each series’ latest step vs the same step one year earlier. “Unusual” compares that move with the '
                + 'series’ typical same-month change; flagged cells changed 2+ SD more than the city’s cells did.',
        };
    }

    function toText(r) {
        if (!r) return '';
        if (r.kind === 'insights') {
            return [r.headline, ...r.findings.map(f => `• ${f.title}. ${f.detail}`),
                ...(r.hotspots.length ? ['Hotspots:', ...r.hotspots.map(h => `• ${h.why}`)] : [])].join('\n');
        }
        if (r.kind === 'compare') return [r.summary, ...r.rows.slice(0, 8).map(x => `• ${x.label}: ${fmt(x.a, x.unit)} vs ${fmt(x.b, x.unit)}`)].join('\n');
        if (r.kind === 'whatif') return [r.summary, ...r.metrics.map(m => `• ${m.label}: ${m.value != null ? m.value : `${m.before} → ${m.after}`}`), `Formula: ${r.formula}`].join('\n');
        if (r.kind === 'plan') return [`Plan: ${r.summary}`, ...r.items.map(x => (x.kind === 'whatif' ? `• ${x.summary}` : `• ${x.type}: ${x.error}`))].join('\n');
        if (r.kind === 'changes') return [`What changed in ${r.cityLabel}:`, ...r.items.map(x => `• ${x.title}. ${x.detail}`)].join('\n');
        if (r.kind === 'dashboard') {
            return r.cities.map(c => `${c.rank}. ${c.label}: urban index ${c.index}; best at ${c.strengths.map(s => lc(s.label)).join(', ')}; weakest at ${c.weaknesses.map(s => lc(s.label)).join(', ')}`).join('\n');
        }
        return '';
    }

    // ── heights (for building counts in what-ifs) ───────────────────────────

    let _hIndex = null;
    const _hGrids = new Map();

    /** The baked height grid covering a point (data/heights/), or null. */
    async function loadHeights(lat, lng) {
        if (typeof fetch === 'undefined') return null;
        if (!_hIndex) _hIndex = fetch('data/heights/index.json').then(r => (r.ok ? r.json() : [])).catch(() => []);
        const idx = await _hIndex;
        const g = (Array.isArray(idx) ? idx : []).find(e => Array.isArray(e.bbox) && lng >= e.bbox[0] && lat >= e.bbox[1] && lng <= e.bbox[2] && lat <= e.bbox[3]);
        if (!g) return null;
        if (!_hGrids.has(g.file)) {
            _hGrids.set(g.file, fetch(g.file, { cache: 'force-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null));
            // Keep the two most recent cities only: each grid is tens of MB parsed.
            while (_hGrids.size > 2) _hGrids.delete(_hGrids.keys().next().value);
        } else {
            const p = _hGrids.get(g.file); _hGrids.delete(g.file); _hGrids.set(g.file, p);   // touch
        }
        return _hGrids.get(g.file);
    }

    return {
        SCHEMA, HEADLINE, COMPOSITES, FLOOD_LEVELS,
        stats, percentile, quantile, cityLabel, fmt, cities, cityAt, resolveArea, cellsInRegion, scalarColumn,
        activeCells, trendOf, neighbours, sourceOf, pointInPolygon, polygonKm2, ols2,
        areaInsights, changes, runPlan, rankableFields, zoneRanking, headline, cityDashboard, compare, whatIf, toLayer, evidence, toText, loadHeights,
    };
})();

if (typeof window !== 'undefined') {
    window.UrbanInsights = UrbanInsights;
}
