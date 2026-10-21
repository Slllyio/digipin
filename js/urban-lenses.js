/**
 * UrbanLenses — established urban-analytics methods that combine several
 * cell-store datasets into one interpretable reading per cell, a city summary
 * in people, an equity reading and a hotspot test. docs/ROADMAP_INSIGHTS.md.
 *
 *   frame(city)   every needed dataset aligned onto the population L7 grid
 *                 (coarser datasets broadcast from their parent cell, monthly
 *                 series read as the trailing-12 mean, like UrbanInsights)
 *   run(city)     every lens over that frame → { lenses[], layer }
 *   hotspots()    Getis-Ord Gi*, Local Moran's I (permutation test), Moran's I
 *   gini/lorenz   population-weighted inequality of any lens
 *
 * Pure apart from reading the store; runs in the browser, no build.
 * Depends on DigiPin and UrbanInsights (scalarColumn, cellsInRegion, cityLabel).
 */
const UrbanLenses = (() => {
    const SCHEMA = 'digipin.lenses/1';
    const LEVEL = 7;
    const BASE = 'population';
    const CELL_DEG = 36 / Math.pow(4, LEVEL);    // DIGIPIN spans 36°; 4×4 per level
    const KM_LAT = 110.57, KM_LNG = 111.32;
    const WALK_KM = 1.2;      // 15 min at 4.8 km/h
    const MIX_KM = 0.5;
    const CATCH_KM = 2;       // E2SFCA catchment
    const BAND_KM = 0.5;      // hotspot distance band (~12 neighbours at L7)
    const ESSENTIALS = ['food', 'shopping', 'healthcare', 'education', 'transport', 'leisure', 'finance'];
    const PM25_NAAQS = 40, PM25_WHO = 5;
    const URBAN_PCT = 15;     // a cell counts as urban for the LEI at ≥ 15% built-up
    const LEED_JX = 54;       // LEED-ND connectivity bar: 140 intersections / sq mi ≈ 54 / km²

    // ── catalogue of lenses ─────────────────────────────────────────────────

    const LENSES = [
        { id: 'heat', equity: true, title: 'Heat vulnerability', icon: '🌡',
            question: 'Who suffers most in a heatwave?',
            field: { key: 'hvi', label: 'Heat vulnerability', unit: '0-100', higherIs: 'worse', ramp: 'reds' },
            needs: ['surface_heat.lst_day_c', 'surface_heat.modis_night_c', 'population.density_km2', 'built_up.built_pct',
                'vegetation.tree_canopy_pct', 'vegetation.ndvi', 'accessibility.healthcare_min'],
            method: 'HVI = exposure × sensitivity × (1 − adaptive capacity), each a within-city percentile rank. Exposure: day and night land-surface temperature. Sensitivity: population density and built-up share. Adaptive capacity: tree canopy, NDVI and travel time to healthcare (inverted). Reported as a city percentile.',
            refs: 'IPCC AR5 vulnerability framing; Reid et al. 2009; Wolf & McGregor 2013' },
        { id: 'flood', title: 'Flood exposure', icon: '🌊',
            question: 'How many people live in the floodplain?',
            field: { key: 'flood_people', label: 'People in the 100-yr floodplain', unit: 'people', higherIs: 'worse', ramp: 'blues' },
            extra: [{ key: 'flood_hazard', label: 'Flood hazard', unit: '0-100', higherIs: 'worse', ramp: 'blues' }],
            needs: ['water.flood_rp100_pct', 'water.flood_rp100_depth_m', 'water.flood_rp10_pct', 'terrain.hand_m', 'built_up.built_pct'],
            method: 'Risk = hazard × exposure. Hazard: share of the cell in the GloFAS 100-year floodplain, scaled by depth (1 m or more counts fully), or half weight for low-lying land (height above nearest drainage under 5 m) as a ponding proxy. People exposed = residents × floodplain share.',
            refs: 'UNDRR Sendai risk framing; Nobre et al. 2011 (HAND)' },
        { id: 'fifteen', equity: true, title: '15-minute completeness', icon: '🚶',
            question: 'Can people reach daily needs on foot?',
            field: { key: 'fifteen_min', label: '15-minute completeness', unit: '0-100', higherIs: 'better', ramp: 'greens' },
            extra: [{ key: 'mix', label: 'Land-use mix (entropy)', unit: '0-100', higherIs: 'better', ramp: 'viridis' }],
            needs: ESSENTIALS.map(c => `osm_amenities.${c}`),
            method: `Share of seven essentials (${ESSENTIALS.join(', ')}) with at least one place within ${WALK_KM} km (a 15-minute walk, straight line). Land-use mix is the normalised Shannon entropy of the same categories within ${MIX_KM * 1000} m.`,
            refs: 'Moreno et al. 2021; Frank et al. 2006 (entropy mix)' },
        { id: 'health', equity: true, title: 'Healthcare access', icon: '🏥',
            question: 'Where is care scarce for the people who need it?',
            field: { key: 'health_access', label: 'Healthcare places per 10k in reach', unit: 'per 10k', higherIs: 'better', ramp: 'greens' },
            needs: ['osm_amenities.healthcare'],
            method: `Enhanced two-step floating catchment (E2SFCA): each facility’s supply is shared among the residents within ${CATCH_KM} km with Gaussian distance decay, then each cell sums the ratios it can reach. Facilities per 10 000 residents in reach.`,
            refs: 'Luo & Wang 2003; Luo & Qi 2009; Dai 2010' },
        { id: 'air', title: 'Air pollution exposure', icon: '🌫',
            question: 'How many people breathe air above the standard?',
            field: { key: 'pm25', label: 'PM2.5 where people live', unit: 'µg/m³', higherIs: 'worse', ramp: 'heat' },
            needs: ['air_quality.pm25_ugm3', 'air_quality.no2_umol_m2'],
            method: `Population-weighted mean PM2.5 (the GBD/WHO exposure metric) and residents above India’s annual NAAQS (${PM25_NAAQS} µg/m³) and the WHO 2021 guideline (${PM25_WHO} µg/m³). Satellite/model data at ~1–10 km.`,
            refs: 'WHO AQG 2021; CPCB NAAQS 2009' },
        { id: 'lights', title: 'Night lights vs people', icon: '💡',
            question: 'Where is activity above or below what residents explain?',
            field: { key: 'ntl_resid', label: 'Lights vs residents (z)', unit: 'z', higherIs: null, ramp: 'diverging' },
            needs: ['nightlights.radiance'],
            method: 'OLS of ln(radiance + 0.1) on ln(population + 1) over populated cells; the standardised residual. Above +1: lit beyond its residents (commerce, industry, hubs). Below −1 in dense cells: under-lit for its population, a flag worth checking (energy poverty, informal housing), not a label.',
            refs: 'Henderson, Storeygard & Weil 2012; Chen & Nordhaus 2011' },
        { id: 'walk', title: 'Walkability index', icon: '👣', equity: true,
            question: 'Is the street fabric walkable, beyond counting shops?',
            field: { key: 'walk_index', label: 'Walkability index', unit: '0-100', higherIs: 'better', ramp: 'greens' },
            needs: ['osm_roads.junctions_km2', 'scores.walkability'],
            after: ['fifteen'],
            method: 'Frank et al. walkability index: 2 × z(intersection density) + z(residential density) + z(land-use mix), over the city’s populated cells, reported as a city percentile. Retail floor-area ratio, the fourth term, has no open data here. The correlation with the OSM-based walkability score says whether the two agree.',
            refs: 'Frank et al. 2010 (Br J Sports Med); Frank et al. 2006' },
        { id: 'sprawl', title: 'Sprawl and compactness', icon: '🏙',
            question: 'Is the city growing by infill, at its edge, or by leapfrogging?',
            field: { key: 'lei', label: 'Landscape expansion index (new built-up)', unit: '0-100', higherIs: null, ramp: 'viridis' },
            needs: ['growth.built_2016_pct', 'growth.built_2023_pct', 'nightlights.radiance'],
            method: `Landscape expansion index for every cell that gained ≥ 5 points of built-up cover 2016→2023: the share of the cells within 500 m that were already urban (≥ ${URBAN_PCT}% built-up) in 2016. ≥ 50 is infill, 2–50 edge expansion, below 2 outlying (leapfrog). Plus Clark’s density gradient (slope of ln density on distance from the night-lights peak, the CBD) and population-weighted density.`,
            refs: 'Liu et al. 2010 (LEI); Clark 1951; Craig 1984; Bertaud & Malpezzi 2003' },
        { id: 'types', title: 'Neighbourhood archetypes', icon: '🧩',
            question: 'What kinds of places make up this city?',
            field: { key: 'archetype', label: 'Neighbourhood archetype', type: 'category' },
            needs: ['built_up.built_pct', 'built_up.avg_height_m', 'vegetation.tree_canopy_pct', 'nightlights.radiance',
                'growth.built_2016_pct', 'growth.built_2023_pct', 'osm_roads.junctions_km2'],
            after: ['fifteen'],
            method: 'k-means (k-means++ seeding, fixed seed) on the urban fabric (cells at ≥ 1 500 people/km², the DEGURBA urban-centre density): standardised log density, built-up share, building height, land-use mix, tree canopy, log night lights, log junction density and 2016–2023 built-up gain ; k = 4–7 chosen by the mean silhouette of a sample. Each cluster is named from its centroid.',
            refs: 'MacQueen 1967; Arthur & Vassilvitskii 2007; Rousseeuw 1987; Stewart & Oke 2012 (Local Climate Zones, the climate analogue)' },
        { id: 'burden', title: 'Compound risk', icon: '⚠',
            question: 'Where do heat, flood and dirty air stack up?',
            field: { key: 'burden', label: 'Hazards in the worst fifth', unit: 'of 3', higherIs: 'worse', ramp: 'reds' },
            needs: [],
            after: ['heat', 'flood', 'air'],
            method: 'Count of hazards (heat vulnerability, flood hazard, PM2.5) for which the cell is in its city’s worst 20%, among populated cells.',
            refs: 'Multi-hazard exposure (Cutter et al. 2003 hazards-of-place)' },
    ];
    const BY_ID = new Map(LENSES.map(l => [l.id, l]));

    // ── small maths ─────────────────────────────────────────────────────────

    const _fin = (x) => typeof x === 'number' && Number.isFinite(x);
    const _round = (x, d = 1) => (_fin(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
    const _num = (v) => (v == null || typeof v === 'boolean' || v === '' ? NaN : Number(v));

    /** Percentile rank 0..1 of each finite value among `idx` (ties averaged); NaN elsewhere. */
    function prank(values, idx) {
        const out = new Float64Array(values.length).fill(NaN);
        const xs = idx.filter(i => _fin(values[i])).sort((a, b) => values[a] - values[b]);
        const n = xs.length;
        if (!n) return out;
        for (let s = 0; s < n;) {
            let e = s;
            while (e + 1 < n && values[xs[e + 1]] === values[xs[s]]) e++;
            const r = n === 1 ? 0.5 : ((s + e) / 2) / (n - 1);
            for (let k = s; k <= e; k++) out[xs[k]] = r;
            s = e + 1;
        }
        return out;
    }

    function _meanOf(arrs, i) {
        let s = 0, n = 0;
        for (const a of arrs) if (a && _fin(a[i])) { s += a[i]; n++; }
        return n ? s / n : NaN;
    }

    /** Weighted mean of values over idx (NaNs skipped). */
    function wmean(values, weights, idx) {
        let s = 0, w = 0;
        for (const i of idx) {
            const v = values[i], wi = weights ? weights[i] : 1;
            if (!_fin(v) || !_fin(wi) || wi <= 0) continue;
            s += v * wi; w += wi;
        }
        return w ? s / w : null;
    }

    /** Weighted quantile (q in 0..1). */
    function wquantile(values, weights, idx, q) {
        const xs = idx.filter(i => _fin(values[i]) && (!weights || weights[i] > 0)).sort((a, b) => values[a] - values[b]);
        if (!xs.length) return null;
        const tot = xs.reduce((a, i) => a + (weights ? weights[i] : 1), 0);
        let cum = 0;
        for (const i of xs) {
            cum += weights ? weights[i] : 1;
            if (cum >= q * tot) return values[i];
        }
        return values[xs[xs.length - 1]];
    }

    /**
     * Population-weighted Gini (0 = equal, 1 = one cell has everything) via
     * the Lorenz trapezoid. Negative values are shifted to 0.
     */
    function gini(values, weights, idx) {
        const pts = lorenz(values, weights, idx, 0);
        if (!pts) return null;
        let area = 0;
        for (let k = 1; k < pts.length; k++) area += (pts[k][0] - pts[k - 1][0]) * (pts[k][1] + pts[k - 1][1]) / 2;
        return Math.max(0, Math.min(1, 1 - 2 * area));
    }

    /**
     * Lorenz curve: [[population share, value share]] from poorest to richest.
     * `n` > 0 samples it at n+1 even population steps (for sparklines).
     */
    function lorenz(values, weights, idx, n = 10) {
        const xs = (idx || values.map((_, i) => i)).filter(i => _fin(values[i]) && (!weights || weights[i] > 0))
            .sort((a, b) => values[a] - values[b]);
        if (xs.length < 2) return null;
        let W = 0, X = 0;
        for (const i of xs) { const w = weights ? weights[i] : 1; W += w; X += Math.max(0, values[i]) * w; }
        if (!(W > 0) || !(X > 0)) return null;
        const pts = [[0, 0]];
        let cw = 0, cx = 0;
        for (const i of xs) {
            const w = weights ? weights[i] : 1;
            cw += w; cx += Math.max(0, values[i]) * w;
            pts.push([cw / W, cx / X]);
        }
        if (!n) return pts;
        const out = [];
        for (let k = 0, j = 0; k <= n; k++) {
            const p = k / n;
            while (j < pts.length - 1 && pts[j + 1][0] < p) j++;
            const a = pts[j], b = pts[Math.min(j + 1, pts.length - 1)];
            const t = b[0] > a[0] ? (p - a[0]) / (b[0] - a[0]) : 0;
            out.push([_round(p, 2), _round(a[1] + Math.max(0, Math.min(1, t)) * (b[1] - a[1]), 3)]);
        }
        return out;
    }

    /** Palma-style ratio: weighted mean of the top 10% ÷ bottom 40%. */
    function palma(values, weights, idx) {
        const q40 = wquantile(values, weights, idx, 0.4), q90 = wquantile(values, weights, idx, 0.9);
        if (q40 == null || q90 == null) return null;
        const lo = wmean(values, weights, idx.filter(i => values[i] <= q40));
        const hi = wmean(values, weights, idx.filter(i => values[i] >= q90));
        return lo && lo > 0 ? hi / lo : null;
    }

    function _breathe() {
        return new Promise(res => {
            if (typeof scheduler !== 'undefined' && scheduler.yield) scheduler.yield().then(res, res);
            else setTimeout(res, 0);
        });
    }

    function _rng(seed) {
        let s = seed >>> 0 || 1;
        return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    }

    // ── the city frame ──────────────────────────────────────────────────────

    /**
     * A grid over `codes` (L7): row/col on the DIGIPIN lattice, km per step,
     * and an offsets-within-radius helper. Exported for tests.
     */
    function grid(codes) {
        const n = codes.length;
        const row = new Int32Array(n), col = new Int32Array(n), lat = new Float64Array(n), lng = new Float64Array(n);
        const at = new Map();
        let latSum = 0;
        for (let i = 0; i < n; i++) {
            const c = DigiPin.decodePartial(codes[i]);
            lat[i] = c.lat; lng[i] = c.lng; latSum += c.lat;
            row[i] = Math.floor((c.lat - 2.5) / CELL_DEG);
            col[i] = Math.floor((c.lng - 63.5) / CELL_DEG);
            at.set(row[i] * 1e6 + col[i], i);
        }
        const lat0 = n ? latSum / n : 20;
        const dy = CELL_DEG * KM_LAT, dx = CELL_DEG * KM_LNG * Math.cos(lat0 * Math.PI / 180);
        const _off = new Map();
        /** [[dRow, dCol, km]] within `km` (self included, at 0). */
        function offsets(km) {
            if (_off.has(km)) return _off.get(km);
            const out = [];
            const rr = Math.ceil(km / dy), rc = Math.ceil(km / dx);
            for (let a = -rr; a <= rr; a++) {
                for (let b = -rc; b <= rc; b++) {
                    const d = Math.hypot(a * dy, b * dx);
                    if (d <= km + 1e-9) out.push([a, b, d]);
                }
            }
            _off.set(km, out);
            return out;
        }
        /** Index of the cell at row+a, col+b, or -1. */
        function cellAt(i, a, b) {
            const j = at.get((row[i] + a) * 1e6 + (col[i] + b));
            return j == null ? -1 : j;
        }
        return { n, codes, row, col, lat, lng, dx, dy, cellKm2: dx * dy, offsets, cellAt };
    }

    /** A frame from in-memory columns (tests, ingested data). */
    function frameFrom(codes, columns, opts = {}) {
        const g = grid(codes);
        const cols = {};
        for (const [k, v] of Object.entries(columns)) cols[k] = Float64Array.from(v, _num);
        return { city: opts.city || null, level: LEVEL, grid: g, cols, sources: opts.sources || [], missing: [] };
    }

    const _frames = new Map();   // `${city}|${needs}` -> Promise<frame>

    function _store(store) { return store || (typeof CellStore !== 'undefined' ? CellStore : null); }
    function _loadView(store, id, bbox) { return (bbox && store.loadView) ? store.loadView(id, bbox) : store.load(id); }

    function allNeeds(ids) {
        const set = new Set(['population.population', 'population.density_km2']);
        for (const id of ids) for (const k of (BY_ID.get(id) || {}).needs || []) set.add(k);
        return [...set];
    }

    /**
     * Every `needs` field ("dataset.field") for a city, on the population L7
     * cells. A coarser dataset reads its parent cell; counts ('sum' fields)
     * missing from a dataset that covers the city are 0, other gaps NaN.
     */
    async function frame(city, store, needs) {
        store = _store(store);
        if (!store) throw new Error('The cell store is not available.');
        needs = needs || allNeeds(LENSES.map(l => l.id));
        const key = `${city}|${needs.slice().sort().join(',')}`;
        if (_frames.has(key)) return _frames.get(key);
        const p = (async () => {
            const popSpec = store.get(BASE);
            const region = popSpec && (popSpec.regions || []).find(r => r.name === city);
            if (!region) throw new Error(`No population grid for ${UrbanInsights.cityLabel(city)}.`);
            const bbox = region.bbox;
            const popT = await _loadView(store, BASE, bbox);
            if (!popT) throw new Error('The population grid did not load.');
            const idx = UrbanInsights.cellsInRegion(popSpec, popT, city);
            const codes = idx.map(i => String(popT.cells[i]).replace(/-/g, '')).filter(c => c.length === LEVEL);
            const g = grid(codes);
            const cols = {}, sources = [], missing = [];
            const byDs = new Map();
            for (const nd of needs) {
                const [ds, f] = nd.split('.');
                if (!byDs.has(ds)) byDs.set(ds, []);
                byDs.get(ds).push(f);
            }
            for (const [ds, fields] of byDs) {
                const spec = store.get(ds);
                const covers = spec && (spec.regions || []).some(r => r.name === city || (r.bbox && bbox && r.bbox.west <= bbox.east && r.bbox.east >= bbox.west && r.bbox.south <= bbox.north && r.bbox.north >= bbox.south));
                const table = covers ? await _loadView(store, ds, bbox).catch(() => null) : null;
                if (!spec || !table || !table.cells || !table.cells.length || table.level > LEVEL) {
                    fields.forEach(f => missing.push(`${ds}.${f}`));
                    continue;
                }
                if (!table.index) { table.index = new Map(); table.cells.forEach((c, i) => table.index.set(c, i)); }
                const lv = table.level;
                const rowOf = new Int32Array(g.n);
                for (let i = 0; i < g.n; i++) {
                    const j = table.index.get(codes[i].slice(0, lv));
                    rowOf[i] = j == null ? -1 : j;
                }
                let used = false;
                for (const f of fields) {
                    const meta = spec.fields.find(x => x.key === f);
                    if (!meta) { missing.push(`${ds}.${f}`); continue; }
                    const src = UrbanInsights.scalarColumn(spec, table, f);
                    const zero = meta.agg === 'sum' || meta.agg === 'count';
                    const out = new Float64Array(g.n);
                    let any = 0;
                    for (let i = 0; i < g.n; i++) {
                        const v = rowOf[i] < 0 ? NaN : _num(src[rowOf[i]]);
                        out[i] = _fin(v) ? v : (zero ? 0 : NaN);
                        if (_fin(v)) any++;
                    }
                    if (!any) { missing.push(`${ds}.${f}`); continue; }
                    cols[`${ds}.${f}`] = out;
                    used = true;
                }
                if (used) sources.push(UrbanInsights.sourceOf(spec, store));
            }
            return { city, level: LEVEL, grid: g, cols, sources, missing };
        })();
        _frames.set(key, p);
        p.catch(() => _frames.delete(key));
        if (_frames.size > 6) _frames.delete(_frames.keys().next().value);
        return p;
    }

    function _residents(fr) {
        const pop = fr.cols['population.population'];
        const idx = [];
        for (let i = 0; i < fr.grid.n; i++) if (pop && pop[i] >= 1) idx.push(i);
        return idx;
    }

    function _people(n) {
        if (!_fin(n)) return '–';
        if (n >= 1e7) return `${_round(n / 1e7, 1)} crore`;
        if (n >= 1e5) return `${_round(n / 1e5, 1)} lakh`;
        return Math.round(n).toLocaleString('en-IN');
    }

    function _sumOver(values, idx, pred) {
        let s = 0;
        for (const i of idx) if (pred(i)) s += values[i];
        return s;
    }

    // ── the lenses ──────────────────────────────────────────────────────────

    function heat(fr) {
        const c = fr.cols, idx = _residents(fr), n = fr.grid.n;
        const R = (k, invert) => {
            if (!c[k]) return null;
            const v = invert ? c[k].map(x => -x) : c[k];
            return prank(v, idx);
        };
        const E = [R('surface_heat.lst_day_c'), R('surface_heat.modis_night_c')];
        const S = [R('population.density_km2'), R('built_up.built_pct')];
        const A = [R('vegetation.tree_canopy_pct'), R('vegetation.ndvi'), R('accessibility.healthcare_min', true)];
        if (!E.some(Boolean) || !S.some(Boolean)) return null;
        const raw = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            const e = _meanOf(E, i), s = _meanOf(S, i);
            let a = _meanOf(A, i);
            if (!_fin(e) || !_fin(s)) continue;
            if (!_fin(a)) a = 0.5;
            raw[i] = e * s * (1 - a);
        }
        const hvi = prank(raw, idx).map(x => (_fin(x) ? x * 100 : NaN));
        const pop = c['population.population'];
        const total = _sumOver(pop, idx, () => true);
        const top = idx.filter(i => hvi[i] >= 90);
        const topPeople = _sumOver(pop, top, () => true);
        const day = c['surface_heat.lst_day_c'], canopy = c['vegetation.tree_canopy_pct'];
        const dayTop = day ? wmean(day, pop, top) : null, dayAll = day ? wmean(day, pop, idx) : null;
        const canTop = canopy ? wmean(canopy, pop, top) : null, canAll = canopy ? wmean(canopy, pop, idx) : null;
        const stats = [
            { label: 'People in the most vulnerable tenth', value: _people(topPeople), raw: Math.round(topPeople) },
            { label: 'Daytime surface temp there vs city', value: dayTop != null ? `${_round(dayTop)} vs ${_round(dayAll)} °C` : '–' },
            { label: 'Tree canopy there vs city', value: canTop != null ? `${_round(canTop)}% vs ${_round(canAll)}%` : '–' },
        ];
        return {
            columns: { hvi }, idx,
            headline: `${_people(topPeople)} people (${_round(100 * topPeople / (total || 1))}% of residents) live in the city’s most heat-vulnerable tenth of neighbourhoods`
                + (dayTop != null ? `, where surfaces run ${_round(Math.abs(dayTop - dayAll))} °C ${dayTop >= dayAll ? 'hotter' : 'cooler'} by day` : '')
                + (canTop != null ? ` and tree canopy is ${_round(canTop)}% against ${_round(canAll)}% city-wide.` : '.'),
            stats,
        };
    }

    function flood(fr) {
        const c = fr.cols, idx = _residents(fr), n = fr.grid.n;
        const rp100 = c['water.flood_rp100_pct'], depth = c['water.flood_rp100_depth_m'], rp10 = c['water.flood_rp10_pct'];
        const hand = c['terrain.hand_m'], built = c['built_up.built_pct'], pop = c['population.population'];
        if (!rp100 && !hand) return null;
        const hazard = new Float64Array(n).fill(NaN), people = new Float64Array(n).fill(NaN);
        let p100 = 0, p10 = 0, builtKm2 = 0;
        for (let i = 0; i < n; i++) {
            const share = rp100 && _fin(rp100[i]) ? Math.max(0, Math.min(1, rp100[i] / 100)) : 0;
            const d = depth && _fin(depth[i]) ? Math.min(1, Math.max(0.25, depth[i])) : 1;
            const fluvial = share * d;
            const pluvial = hand && _fin(hand[i]) && hand[i] < 5 ? 0.5 * (1 - Math.max(0, hand[i]) / 5) : 0;
            hazard[i] = 100 * Math.max(fluvial, pluvial);
            const pp = pop && pop[i] > 0 ? pop[i] : 0;
            people[i] = pp * share;
            p100 += pp * share;
            if (rp10 && _fin(rp10[i])) p10 += pp * Math.max(0, Math.min(1, rp10[i] / 100));
            if (built && _fin(built[i])) builtKm2 += (built[i] / 100) * share * fr.grid.cellKm2;
        }
        const total = _sumOver(pop, idx, () => true);
        const ponding = hand ? _sumOver(pop, idx, i => hand[i] < 2) : null;
        return {
            columns: { flood_people: people, flood_hazard: hazard }, idx, weightKey: 'flood_hazard',
            headline: `${_people(p100)} people (${_round(100 * p100 / (total || 1))}% of residents) live in the 100-year floodplain`
                + (rp10 ? `, ${_people(p10)} of them where floods come about once a decade` : '') + '.',
            stats: [
                { label: 'People in the 100-year floodplain', value: _people(p100), raw: Math.round(p100) },
                { label: 'People in the 10-year floodplain', value: rp10 ? _people(p10) : '–', raw: Math.round(p10) },
                { label: 'Built-up land in the floodplain', value: `${_round(builtKm2, 2)} km²` },
                { label: 'People near drainage level (HAND < 2 m, waterlogging-prone)', value: ponding != null ? _people(ponding) : '–' },
            ],
        };
    }

    function fifteen(fr) {
        const c = fr.cols, g = fr.grid, n = g.n, idx = _residents(fr);
        const cats = ESSENTIALS.filter(k => c[`osm_amenities.${k}`]);
        if (cats.length < 3) return null;
        const has = cats.map(k => c[`osm_amenities.${k}`]);
        const walk = g.offsets(WALK_KM), near = g.offsets(MIX_KM);
        const score = new Float64Array(n), mix = new Float64Array(n);
        const missCount = new Float64Array(cats.length);
        const pop = c['population.population'];
        const isRes = new Uint8Array(n);
        for (const i of idx) isRes[i] = 1;
        const cnt = new Float64Array(cats.length);
        for (let i = 0; i < n; i++) {
            let k = 0;
            for (let q = 0; q < cats.length; q++) {
                let found = false;
                for (const [a, b] of walk) {
                    const j = g.cellAt(i, a, b);
                    if (j >= 0 && has[q][j] > 0) { found = true; break; }
                }
                if (found) k++;
                else if (isRes[i]) missCount[q] += pop[i];
            }
            score[i] = 100 * k / cats.length;
            cnt.fill(0);
            let tot = 0;
            for (const [a, b] of near) {
                const j = g.cellAt(i, a, b);
                if (j < 0) continue;
                for (let q = 0; q < cats.length; q++) { cnt[q] += has[q][j]; tot += has[q][j]; }
            }
            if (tot < 2) { mix[i] = tot ? 0 : NaN; continue; }
            let h = 0;
            for (let q = 0; q < cats.length; q++) if (cnt[q] > 0) { const p = cnt[q] / tot; h -= p * Math.log(p); }
            mix[i] = 100 * h / Math.log(cats.length);
        }
        const total = _sumOver(pop, idx, () => true);
        const complete = _sumOver(pop, idx, i => score[i] >= 100 * (cats.length - 1) / cats.length - 1e-9);
        const none = _sumOver(pop, idx, i => score[i] === 0);
        const worstQ = [...missCount.keys()].sort((a, b) => missCount[b] - missCount[a])[0];
        return {
            columns: { fifteen_min: score, mix }, idx,
            headline: `${_round(100 * complete / (total || 1))}% of residents can walk to at least ${cats.length - 1} of ${cats.length} daily essentials within 15 minutes; `
                + `${cats[worstQ]} is the one most often out of reach (${_people(missCount[worstQ])} people).`,
            stats: [
                { label: 'Mean completeness (per resident)', value: `${_round(wmean(score, pop, idx))} / 100` },
                { label: `Residents with ≥ ${cats.length - 1} of ${cats.length}`, value: _people(complete), raw: Math.round(complete) },
                { label: 'Residents with none in reach', value: _people(none), raw: Math.round(none) },
                { label: 'Most-missing essential', value: cats[worstQ] },
            ],
        };
    }

    /**
     * E2SFCA accessibility. `supply`, `demand` per cell; returns A per cell
     * (supply per person in reach). Gaussian decay, catchment d0 km.
     */
    function e2sfca(g, supply, demand, d0 = CATCH_KM) {
        const off = g.offsets(d0);
        const e = Math.exp(-0.5);
        const G = off.map(([, , d]) => (Math.exp(-0.5 * (d / d0) ** 2) - e) / (1 - e));
        const A = new Float64Array(g.n);
        for (let j = 0; j < g.n; j++) {
            const s = supply[j];
            if (!(s > 0)) continue;
            let den = 0;
            for (let o = 0; o < off.length; o++) {
                const k = g.cellAt(j, off[o][0], off[o][1]);
                if (k >= 0 && demand[k] > 0) den += G[o] * demand[k];
            }
            if (!(den > 0)) continue;
            const R = s / den;
            for (let o = 0; o < off.length; o++) {
                const k = g.cellAt(j, off[o][0], off[o][1]);
                if (k >= 0) A[k] += G[o] * R;
            }
        }
        return A;
    }

    function health(fr) {
        const c = fr.cols, idx = _residents(fr);
        const sup = c['osm_amenities.healthcare'], pop = c['population.population'];
        if (!sup || !pop) return null;
        const A = e2sfca(fr.grid, sup, pop).map(x => x * 1e4);
        const total = _sumOver(pop, idx, () => true);
        const med = wquantile(A, pop, idx, 0.5);
        const desert = _sumOver(pop, idx, i => A[i] === 0);
        const low = med ? _sumOver(pop, idx, i => A[i] < med * 0.25) : null;
        return {
            columns: { health_access: A }, idx,
            headline: `${_people(desert)} people (${_round(100 * desert / (total || 1))}% of residents) have no mapped healthcare within ${CATCH_KM} km; `
                + `the typical resident shares each nearby facility with ${med ? _people(1e4 / med) : '–'} others.`,
            stats: [
                { label: 'Median places per 10k residents in reach', value: med != null ? String(_round(med, 2)) : '–' },
                { label: `No healthcare within ${CATCH_KM} km`, value: _people(desert), raw: Math.round(desert) },
                { label: 'Below a quarter of the median', value: low != null ? _people(low) : '–' },
            ],
        };
    }

    function air(fr) {
        const c = fr.cols, idx = _residents(fr);
        const pm = c['air_quality.pm25_ugm3'], pop = c['population.population'];
        if (!pm) return null;
        const total = _sumOver(pop, idx, () => true);
        const pw = wmean(pm, pop, idx);
        const above = _sumOver(pop, idx, i => pm[i] > PM25_NAAQS);
        const aboveWho = _sumOver(pop, idx, i => pm[i] > PM25_WHO);
        const no2 = c['air_quality.no2_umol_m2'];
        return {
            columns: { pm25: Float64Array.from(pm) }, idx,
            headline: `The average resident breathes ${_round(pw)} µg/m³ of PM2.5 (${_round(pw / PM25_WHO, 1)}× the WHO guideline); `
                + `${_people(above)} people (${_round(100 * above / (total || 1))}%) live above India’s annual standard of ${PM25_NAAQS}.`,
            stats: [
                { label: 'Population-weighted PM2.5', value: `${_round(pw)} µg/m³` },
                { label: `Above NAAQS (${PM25_NAAQS})`, value: _people(above), raw: Math.round(above) },
                { label: `Above WHO (${PM25_WHO})`, value: _people(aboveWho), raw: Math.round(aboveWho) },
                { label: 'Population-weighted NO₂ column', value: no2 ? `${_round(wmean(no2, pop, idx))} µmol/m²` : '–' },
            ],
        };
    }

    /** OLS y = a + b x over idx. */
    function ols(x, y, idx) {
        let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const i of idx) {
            if (!_fin(x[i]) || !_fin(y[i])) continue;
            n++; sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i];
        }
        const den = n * sxx - sx * sx;
        if (n < 3 || !den) return null;
        const b = (n * sxy - sx * sy) / den, a = (sy - b * sx) / n;
        let ss = 0, st = 0;
        const my = sy / n;
        for (const i of idx) {
            if (!_fin(x[i]) || !_fin(y[i])) continue;
            ss += (y[i] - a - b * x[i]) ** 2; st += (y[i] - my) ** 2;
        }
        return { a, b, n, sd: Math.sqrt(ss / Math.max(1, n - 2)), r2: st ? 1 - ss / st : 0 };
    }

    function lights(fr) {
        const c = fr.cols, n = fr.grid.n;
        const rad = c['nightlights.radiance'], pop = c['population.population'];
        if (!rad || !pop) return null;
        const idx = _residents(fr).filter(i => pop[i] >= 10 && _fin(rad[i]));
        const x = new Float64Array(n).fill(NaN), y = new Float64Array(n).fill(NaN);
        for (const i of idx) { x[i] = Math.log(pop[i] + 1); y[i] = Math.log(Math.max(0, rad[i]) + 0.1); }
        const fit = ols(x, y, idx);
        if (!fit || !(fit.sd > 0)) return null;
        const z = new Float64Array(n).fill(NaN);
        for (const i of idx) z[i] = (y[i] - fit.a - fit.b * x[i]) / fit.sd;
        const dense = wquantile(c['population.density_km2'] || pop, null, idx, 0.75);
        const dens = c['population.density_km2'] || pop;
        const over = idx.filter(i => z[i] > 1).length;
        const underIdx = idx.filter(i => z[i] < -1 && dens[i] >= dense);
        const underPeople = _sumOver(pop, underIdx, () => true);
        return {
            columns: { ntl_resid: z }, idx, diverging: true,
            headline: `Night lights rise ${_round(fit.b, 2)}% for each 1% more residents (R² ${_round(fit.r2, 2)}). `
                + `${over} cells glow well above their residents (activity hubs); ${underIdx.length} dense cells with ${_people(underPeople)} people are under-lit for their size.`,
            stats: [
                { label: 'Light–population elasticity', value: String(_round(fit.b, 2)) },
                { label: 'Cells lit above residents (z > 1)', value: String(over) },
                { label: 'Dense, under-lit cells (z < −1)', value: `${underIdx.length} (${_people(underPeople)} people)` },
                { label: 'Fit R²', value: String(_round(fit.r2, 2)) },
            ],
            fit: { a: _round(fit.a, 3), b: _round(fit.b, 3), r2: _round(fit.r2, 3), n: fit.n },
        };
    }

    function burden(fr, done) {
        const parts = [['heat', 'hvi'], ['flood', 'flood_hazard'], ['air', 'pm25']].map(([id, k]) => done[id] && done[id].columns[k]).filter(Boolean);
        if (parts.length < 2) return null;
        const idx = _residents(fr), n = fr.grid.n, pop = fr.cols['population.population'];
        // Percentile ranks with ties averaged, so a coarse field (PM2.5 at
        // ~1 km) cannot put a whole tied block into the worst fifth.
        const ranks = parts.map(v => prank(v, idx));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            let k = 0;
            parts.forEach((v, p) => { if (ranks[p][i] >= 0.8 && v[i] > 0) k++; });
            out[i] = k;
        }
        const two = _sumOver(pop, idx, i => out[i] >= 2), all = _sumOver(pop, idx, i => out[i] >= parts.length);
        const total = _sumOver(pop, idx, () => true);
        return {
            columns: { burden: out }, idx,
            headline: `${_people(two)} people (${_round(100 * two / (total || 1))}%) carry two or more of the city’s worst heat, flood and air burdens; ${_people(all)} carry all ${parts.length}.`,
            stats: [
                { label: 'Residents with ≥ 2 burdens', value: _people(two), raw: Math.round(two) },
                { label: `Residents with all ${parts.length}`, value: _people(all), raw: Math.round(all) },
            ],
        };
    }

    /** Pearson correlation over idx. */
    function pearson(x, y, idx) {
        const f = ols(x, y, idx);
        if (!f) return null;
        return Math.sign(f.b) * Math.sqrt(Math.max(0, f.r2));
    }

    function _z(values, idx) {
        let n = 0, s = 0, q = 0;
        for (const i of idx) if (_fin(values[i])) { n++; s += values[i]; q += values[i] * values[i]; }
        const m = n ? s / n : 0, sd = n ? Math.sqrt(Math.max(0, q / n - m * m)) : 0;
        return Float64Array.from(values, v => (_fin(v) && sd > 0 ? (v - m) / sd : NaN));
    }

    function walk(fr, done) {
        const c = fr.cols, idx = _residents(fr), n = fr.grid.n;
        const jx = c['osm_roads.junctions_km2'], dens = c['population.density_km2'];
        const mix = done.fifteen && done.fifteen.columns.mix;
        if (!jx || !dens) return null;
        const zj = _z(jx, idx), zd = _z(dens.map(v => Math.log1p(Math.max(0, v))), idx), zm = mix ? _z(mix.map(v => (_fin(v) ? v : 0)), idx) : null;
        const raw = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            if (!_fin(zj[i]) || !_fin(zd[i])) continue;
            raw[i] = 2 * zj[i] + zd[i] + (zm && _fin(zm[i]) ? zm[i] : 0);
        }
        const out = prank(raw, idx).map(x => (_fin(x) ? x * 100 : NaN));
        const pop = c['population.population'];
        const total = _sumOver(pop, idx, () => true);
        const sparse = _sumOver(pop, idx, i => _fin(jx[i]) && jx[i] < LEED_JX);
        const low = sparse;
        const osm = c['scores.walkability'];
        const r = osm ? pearson(out, osm, idx.filter(i => _fin(out[i]) && _fin(osm[i]) && osm[i] > 0)) : null;
        const jTop = wmean(jx, pop, idx.filter(i => out[i] >= 80)), jLow = wmean(jx, pop, idx.filter(i => out[i] < 20));
        return {
            columns: { walk_index: out }, idx,
            headline: `${_people(low)} people (${_round(100 * low / (total || 1))}%) live where streets have fewer than ${LEED_JX} junctions per km² (the LEED-ND connectivity bar); `
                + `the most walkable fifth of cells has ${_round(jTop)} per km², the least ${_round(jLow)}.`
                + (r != null ? ` The index ${Math.abs(r) >= 0.5 ? 'agrees with' : Math.abs(r) >= 0.25 ? 'partly agrees with' : 'differs from'} the OSM walkability score (r = ${_round(r, 2)}).` : ''),
            stats: [
                { label: `Residents below ${LEED_JX} junctions / km²`, value: _people(low), raw: Math.round(low) },
                { label: 'Mean index per resident', value: `${_round(wmean(out, pop, idx))} / 100` },
                { label: 'Junctions / km²: top vs bottom fifth', value: `${_round(jTop)} vs ${_round(jLow)}` },
                { label: 'Correlation with OSM walkability score', value: r != null ? String(_round(r, 2)) : '–' },
            ],
        };
    }

    function sprawl(fr) {
        const c = fr.cols, g = fr.grid, n = g.n;
        const b16 = c['growth.built_2016_pct'], b23 = c['growth.built_2023_pct'];
        if (!b16 || !b23) return null;
        const ring = g.offsets(0.5).filter(([a, b]) => a || b);
        const lei = new Float64Array(n).fill(NaN);
        let infill = 0, edge = 0, out = 0;
        const grew = [];
        for (let i = 0; i < n; i++) {
            const gain = b23[i] - b16[i];
            if (!(gain >= 5)) continue;
            // LEI on the cell lattice: the share of ring cells that were
            // already urban (≥ URBAN_PCT built) in 2016, as Liu et al. do with
            // urban-patch pixels in a buffer.
            let s = 0, k = 0;
            for (const [a, b] of ring) {
                const j = g.cellAt(i, a, b);
                if (j < 0 || !_fin(b16[j])) continue;
                if (b16[j] >= URBAN_PCT) s++;
                k++;
            }
            if (!k) continue;
            lei[i] = 100 * s / k;
            grew.push(i);
            const area = gain / 100 * g.cellKm2;
            if (lei[i] >= 50) infill += area; else if (lei[i] >= 2) edge += area; else out += area;
        }
        const tot = infill + edge + out;
        // Clark (1951): ln D(x) = ln D0 − b·x, x = km from the night-lights peak.
        const idx = _residents(fr), pop = c['population.population'], dens = c['population.density_km2'];
        const rad = c['nightlights.radiance'];
        let cbd = -1, best = -Infinity;
        if (rad) {
            const near = g.offsets(1);
            for (const i of idx) {
                let s = 0;
                for (const [a, b] of near) { const j = g.cellAt(i, a, b); if (j >= 0 && _fin(rad[j])) s += rad[j]; }
                if (s > best) { best = s; cbd = i; }
            }
        }
        let fit = null;
        if (cbd >= 0 && dens) {
            const x = new Float64Array(n).fill(NaN), y = new Float64Array(n).fill(NaN);
            const use = idx.filter(i => dens[i] > 50);
            for (const i of use) {
                x[i] = Math.hypot((g.row[i] - g.row[cbd]) * g.dy, (g.col[i] - g.col[cbd]) * g.dx);
                y[i] = Math.log(dens[i]);
            }
            fit = ols(x, y, use);
        }
        const pwd = dens ? wmean(dens, pop, idx) : null;
        const total = _sumOver(pop, idx, () => true);
        const gross = total / ((idx.length || 1) * g.cellKm2);
        const share = (v) => (tot ? _round(100 * v / tot) : null);
        const verdict = !tot ? 'little measurable growth' : share(infill) >= 50 ? 'mostly infill (compact)' : share(out) >= 25 ? 'leapfrogging (sprawling)' : 'mostly edge expansion';
        return {
            columns: { lei }, idx: grew.length >= 10 ? grew : idx, diverging: false,
            headline: tot
                ? `${_round(tot, 1)} km² of land was newly built 2016–2023, ${verdict}: ${share(infill)}% infill, ${share(edge)}% at the edge, ${share(out)}% leapfrog.`
                    + (fit ? ` Density falls ${_round(100 * (1 - Math.exp(fit.b)))}% per km from the centre (Clark gradient ${_round(-fit.b, 3)}/km).` : '')
                : 'Too little new built-up land 2016–2023 to classify growth.',
            stats: [
                { label: 'Newly built 2016–2023', value: `${_round(tot, 2)} km²` },
                { label: 'Infill / edge / leapfrog', value: tot ? `${share(infill)} / ${share(edge)} / ${share(out)}%` : '–' },
                { label: 'Clark density gradient', value: fit ? `${_round(-fit.b, 3)} per km (R² ${_round(fit.r2, 2)})` : '–' },
                { label: 'Population-weighted vs gross density', value: pwd != null ? `${Math.round(pwd).toLocaleString('en-IN')} vs ${Math.round(gross).toLocaleString('en-IN')} /km²` : '–' },
            ],
            fit: fit ? { gradient: _round(-fit.b, 4), r2: _round(fit.r2, 3), centre: g.codes[cbd] } : null,
            noHotspots: grew.length < 10,
        };
    }

    /**
     * k-means with k-means++ seeding on rows of `X` (arrays of equal length).
     * Deterministic for a seed. Returns { labels, centroids, inertia }.
     */
    function kmeans(X, k, opts = {}) {
        const n = X.length, d = n ? X[0].length : 0, rnd = _rng(opts.seed || 7);
        if (n < k) return null;
        const dist2 = (a, b) => { let s = 0; for (let t = 0; t < d; t++) { const u = a[t] - b[t]; s += u * u; } return s; };
        const C = [X[Math.floor(rnd() * n)].slice()];
        const D = new Float64Array(n).fill(Infinity);
        while (C.length < k) {
            let tot = 0;
            for (let i = 0; i < n; i++) { D[i] = Math.min(D[i], dist2(X[i], C[C.length - 1])); tot += D[i]; }
            let r = rnd() * tot, pick = n - 1;
            for (let i = 0; i < n; i++) { r -= D[i]; if (r <= 0) { pick = i; break; } }
            C.push(X[pick].slice());
        }
        const lab = new Int32Array(n);
        let inertia = 0;
        for (let it = 0; it < (opts.iterations || 40); it++) {
            let moved = 0;
            inertia = 0;
            for (let i = 0; i < n; i++) {
                let best = 0, bd = Infinity;
                for (let c = 0; c < k; c++) { const v = dist2(X[i], C[c]); if (v < bd) { bd = v; best = c; } }
                if (lab[i] !== best) { lab[i] = best; moved++; }
                inertia += bd;
            }
            const sum = Array.from({ length: k }, () => new Float64Array(d)), cnt = new Int32Array(k);
            for (let i = 0; i < n; i++) { cnt[lab[i]]++; for (let t = 0; t < d; t++) sum[lab[i]][t] += X[i][t]; }
            for (let c = 0; c < k; c++) if (cnt[c]) for (let t = 0; t < d; t++) C[c][t] = sum[c][t] / cnt[c];
            if (!moved && it) break;
        }
        return { labels: lab, centroids: C, inertia };
    }

    /** Mean silhouette of a labelled sample (Rousseeuw 1987). */
    function silhouette(X, labels, k) {
        const n = X.length;
        if (n < 3) return null;
        const dist = (a, b) => { let s = 0; for (let t = 0; t < a.length; t++) { const u = a[t] - b[t]; s += u * u; } return Math.sqrt(s); };
        let tot = 0;
        for (let i = 0; i < n; i++) {
            const sum = new Float64Array(k), cnt = new Int32Array(k);
            for (let j = 0; j < n; j++) if (j !== i) { sum[labels[j]] += dist(X[i], X[j]); cnt[labels[j]]++; }
            const a = cnt[labels[i]] ? sum[labels[i]] / cnt[labels[i]] : 0;
            let b = Infinity;
            for (let c = 0; c < k; c++) if (c !== labels[i] && cnt[c]) b = Math.min(b, sum[c] / cnt[c]);
            tot += (b === Infinity || Math.max(a, b) === 0) ? 0 : (b - a) / Math.max(a, b);
        }
        return tot / n;
    }

    const TRAITS = {
        dens: ['sparser', 'denser'], built: ['less built-up', 'more built-up'], height: ['low-rise', 'taller'], mix: ['single-use', 'mixed-use'],
        canopy: ['bare', 'greener'], lights: ['darker', 'brighter'], jx: ['fewer junctions', 'finer street grid'], growth: ['settled', 'fast-growing'],
    };
    const URBAN_DENSITY = 1500;   // DEGURBA urban-centre density (Dijkstra et al. 2021)
    const RURAL_TYPE = 'Below urban density';
    const TYPE_COLORS = ['#7f0000', '#d7301f', '#fc8d59', '#fdcc8a', '#41ab5d', '#2c7fb8', '#807dba', '#bdbdbd'];

    /** A plain name for a cluster centroid (z-scores by feature). */
    function archetypeName(cz) {
        if (cz.dens < -0.8 && cz.built < -0.6) return 'Urban fringe';
        if (cz.growth > 0.8) return 'New growth edge';
        if (cz.height > 1) return cz.dens > 0.3 ? 'High-rise core' : 'High-rise district';
        if (cz.dens > 0.6 && cz.jx > 0.4 && cz.mix > 0.2) return 'Dense mixed core';
        if (cz.lights > 0.8 && cz.dens < 0.4) return 'Activity hub (commerce / industry)';
        if (cz.canopy > 0.8) return 'Leafy neighbourhood';
        if (cz.dens > 0.4) return 'Dense residential';
        if (cz.dens > -0.4) return 'Mid-density residential';
        return 'Low-density suburb';
    }

    function types(fr, done) {
        const c = fr.cols, res = _residents(fr);
        const densAll = c['population.density_km2'];
        // Cluster the urban fabric only (DEGURBA's urban-centre density,
        // 1 500 /km²); the rest is one fixed class, else urban vs rural
        // swamps every other difference.
        const idx = densAll ? res.filter(i => densAll[i] >= URBAN_DENSITY) : res;
        const rural = densAll ? res.filter(i => densAll[i] < URBAN_DENSITY) : [];
        const b16 = c['growth.built_2016_pct'], b23 = c['growth.built_2023_pct'];
        const mix = done.fifteen && done.fifteen.columns.mix;
        const feats = {
            dens: c['population.density_km2'] && c['population.density_km2'].map(v => Math.log1p(Math.max(0, v))),
            built: c['built_up.built_pct'], height: c['built_up.avg_height_m'], mix,
            canopy: c['vegetation.tree_canopy_pct'],
            lights: c['nightlights.radiance'] && c['nightlights.radiance'].map(v => Math.log1p(Math.max(0, v))),
            jx: c['osm_roads.junctions_km2'] && c['osm_roads.junctions_km2'].map(v => Math.log1p(Math.max(0, v))),
            growth: b16 && b23 ? b23.map((v, i) => v - b16[i]) : null,
        };
        const keys = Object.keys(feats).filter(k => feats[k]);
        if (keys.length < 4 || idx.length < 50) return null;
        const Z = keys.map(k => _z(feats[k], idx));
        const X = idx.map(i => Z.map(z => (_fin(z[i]) ? Math.max(-4, Math.min(4, z[i])) : 0)));
        // Pick k by silhouette on a fixed sample.
        const rnd = _rng(99), S = Math.min(700, X.length);
        const sample = Array.from({ length: S }, () => Math.floor(rnd() * X.length));
        let best = null;
        for (let k = 4; k <= 7; k++) {
            const km = kmeans(X, k, { seed: 11 });
            if (!km) continue;
            const sil = silhouette(sample.map(i => X[i]), sample.map(i => km.labels[i]), k);
            if (!best || sil > best.sil) best = { k, km, sil };
        }
        if (!best) return null;
        const pop = c['population.population'];
        const groups = best.km.centroids.map((cen, g) => {
            const cz = {};
            keys.forEach((k, t) => { cz[k] = cen[t]; });
            for (const k of Object.keys(TRAITS)) if (cz[k] == null) cz[k] = 0;
            return { g, cz, name: archetypeName(cz), people: 0, cells: 0 };
        });
        idx.forEach((i, p) => { const gr = groups[best.km.labels[p]]; gr.people += pop[i]; gr.cells++; });
        const ruralPeople = _sumOver(pop, rural, () => true);
        // Same name twice: add each one's most distinctive other trait.
        const seen = new Map();
        for (const gr of groups) seen.set(gr.name, (seen.get(gr.name) || 0) + 1);
        for (const gr of groups) {
            if (seen.get(gr.name) < 2) continue;
            const k = keys.filter(x => x !== 'dens').sort((a, b) => Math.abs(gr.cz[b]) - Math.abs(gr.cz[a]))[0];
            gr.name = `${gr.name}, ${TRAITS[k][gr.cz[k] >= 0 ? 1 : 0]}`;
        }
        groups.sort((a, b) => b.people - a.people);
        const order = new Map(groups.map((gr, r) => [gr.g, r]));
        const lab = new Float64Array(fr.grid.n).fill(NaN);
        idx.forEach((i, p) => { lab[i] = order.get(best.km.labels[p]); });
        const total = (groups.reduce((a, g2) => a + g2.people, 0) + ruralPeople) || 1;
        const domain = groups.map(g2 => g2.name);
        if (rural.length) {
            domain.push(RURAL_TYPE);
            for (const i of rural) lab[i] = domain.length - 1;
        }
        const colors = {};
        domain.forEach((nm, r) => { colors[nm] = nm === RURAL_TYPE ? '#d9d9d9' : TYPE_COLORS[r % TYPE_COLORS.length]; });
        const describe = (gr) => keys.filter(k => Math.abs(gr.cz[k]) >= 0.5).sort((a, b) => Math.abs(gr.cz[b]) - Math.abs(gr.cz[a])).slice(0, 3)
            .map(k => TRAITS[k][gr.cz[k] >= 0 ? 1 : 0]).join(', ') || 'close to the city average';
        return {
            columns: { archetype: lab }, idx: res, noHotspots: true,
            categories: { archetype: { domain, colors } },
            headline: `The urban fabric (${idx.length.toLocaleString('en-IN')} cells at ≥ ${URBAN_DENSITY.toLocaleString('en-IN')} people/km²) sorts into ${best.k} kinds of place; `
                + `the most lived-in are “${groups[0].name}” (${_round(100 * groups[0].people / total)}% of residents)`
                + (groups[1] ? ` and “${groups[1].name}” (${_round(100 * groups[1].people / total)}%).` : '.'),
            stats: [
                ...groups.map(gr => ({ label: `${gr.name}: ${describe(gr)}`, value: `${_round(100 * gr.people / total)}% of residents · ${gr.cells} cells` })),
                ...(rural.length ? [{ label: `${RURAL_TYPE} (not clustered)`, value: `${_round(100 * ruralPeople / total)}% of residents · ${rural.length} cells` }] : []),
            ],
            fit: { k: best.k, silhouette: _round(best.sil, 3), features: keys },
        };
    }

    const RUN = { heat, flood, fifteen, health, air, lights, walk, sprawl, types, burden };

    // ── spatial statistics ──────────────────────────────────────────────────

    /**
     * Hotspot statistics of `values` over `idx` on grid `g`, binary weights
     * within `km`. Returns global Moran's I (normal approximation), Gi* z per
     * cell and LISA classes (1 HH, 2 LL, 3 HL, 4 LH, 0 not significant) from
     * a seeded conditional permutation test.
     */
    function hotspots(g, values, idx, opts = {}) {
        const km = opts.km || BAND_KM, perms = opts.permutations ?? 0, alpha = opts.alpha || 0.05;
        const off = g.offsets(km).filter(([a, b]) => a || b);
        const use = idx.filter(i => _fin(values[i]));
        const n = use.length;
        const empty = { n, moranI: null, z: null, reading: 'Not enough data', gi: null, lisa: null, hot: [], cold: [] };
        if (n < 10) return empty;
        const pos = new Int32Array(g.n).fill(-1);
        use.forEach((i, p) => { pos[i] = p; });
        let mean = 0;
        for (const i of use) mean += values[i];
        mean /= n;
        let m2 = 0;
        for (const i of use) m2 += (values[i] - mean) ** 2;
        const sd = Math.sqrt(m2 / n);
        if (!(sd > 0)) return { ...empty, reading: 'No variation' };
        const z = new Float64Array(n);
        use.forEach((i, p) => { z[p] = (values[i] - mean) / sd; });
        const nb = use.map(i => {
            const out = [];
            for (const [a, b] of off) {
                const j = g.cellAt(i, a, b);
                if (j >= 0 && pos[j] >= 0) out.push(pos[j]);
            }
            return out;
        });
        // Global Moran's I, row-standardised weights (as PySAL's default), so
        // I sits in about [-1, 1]; normal-approximation z.
        let num = 0;
        for (let p = 0; p < n; p++) {
            const k = nb[p].length;
            if (!k) continue;
            let lag = 0;
            for (const q of nb[p]) lag += z[q];
            num += z[p] * lag / k;
        }
        const S0 = nb.reduce((a, x) => a + (x.length ? 1 : 0), 0);
        const I = S0 ? num / S0 : null;   // Σz² = n; (n/S0)·Σwzz/Σz²
        let zI = null;
        if (S0 > 2) {
            let S1 = 0, S2 = 0;
            for (let p = 0; p < n; p++) {
                const k = nb[p].length;
                let col = 0;
                for (const q of nb[p]) {
                    const w = 1 / k + 1 / (nb[q].length || 1);
                    S1 += w * w / 2;
                    col += 1 / (nb[q].length || 1);
                }
                S2 += ((k ? 1 : 0) + col) ** 2;
            }
            const E = -1 / (n - 1);
            const v = (n * n * S1 - n * S2 + 3 * S0 * S0) / ((n * n - 1) * S0 * S0) - E * E;
            zI = v > 0 ? (I - E) / Math.sqrt(v) : null;
        }
        // Gi* (self included).
        const gi = new Float64Array(g.n).fill(NaN);
        const hot = [], cold = [];
        for (let p = 0; p < n; p++) {
            const W = nb[p].length + 1;
            let s = values[use[p]];
            for (const q of nb[p]) s += values[use[q]];
            const den = sd * Math.sqrt((n * W - W * W) / (n - 1));
            const gz = den > 0 ? (s - mean * W) / den : 0;
            gi[use[p]] = gz;
            if (gz >= 1.96) hot.push(use[p]); else if (gz <= -1.96) cold.push(use[p]);
        }
        // LISA with conditional permutations.
        const lisa = new Int8Array(g.n);
        if (perms > 0) {
            const rnd = _rng(opts.seed || 12345);
            for (let p = 0; p < n; p++) {
                const k = nb[p].length;
                if (!k) continue;
                let lag = 0;
                for (const q of nb[p]) lag += z[q];
                lag /= k;
                const Ii = z[p] * lag;
                let extreme = 0;
                for (let r = 0; r < perms; r++) {
                    let s = 0;
                    for (let t = 0; t < k; t++) {
                        let q = Math.floor(rnd() * (n - 1));
                        if (q >= p) q++;
                        s += z[q];
                    }
                    const Ir = z[p] * s / k;
                    if (Ii >= 0 ? Ir >= Ii : Ir <= Ii) extreme++;
                }
                if ((extreme + 1) / (perms + 1) > alpha) continue;
                lisa[use[p]] = z[p] >= 0 ? (lag >= 0 ? 1 : 3) : (lag < 0 ? 2 : 4);
            }
        }
        const reading = zI == null ? 'Not enough neighbours'
            : zI > 2.58 ? (I > 0.5 ? 'Strongly clustered' : 'Clustered')
                : zI > 1.96 ? 'Mildly clustered'
                    : zI < -1.96 ? 'Dispersed (checkerboard)' : 'No significant clustering';
        const counts = { HH: 0, LL: 0, HL: 0, LH: 0 };
        for (const i of use) { const L = lisa[i]; if (L) counts[['', 'HH', 'LL', 'HL', 'LH'][L]]++; }
        return { n, moranI: _round(I, 3), z: _round(zI, 2), reading, gi, lisa, hot, cold, lisaCounts: counts, km };
    }

    // ── run ─────────────────────────────────────────────────────────────────

    /**
     * Run lenses for a city. opts: { only: [ids], hotspots: true, permutations (LISA; 0 = Gi* and Moran only) }.
     * Returns { schema, city, cityLabel, lenses: [...], layer, sources, missing }.
     */
    async function run(city, store, opts = {}) {
        const ids = (opts.only && opts.only.length ? opts.only : LENSES.map(l => l.id));
        const want = new Set(ids);
        for (const id of ids) for (const a of (BY_ID.get(id) || {}).after || []) want.add(a);
        const order = LENSES.filter(l => want.has(l.id));
        const fr = opts.frame || await frame(city, store, allNeeds(order.map(l => l.id)));
        const done = {};
        const out = [];
        const layerCols = {};
        const pop = fr.cols['population.population'];
        for (const L of order) {
            // One lens per task: the whole run is ~1 s of maths on a big city.
            if (L !== order[0]) await _breathe();
            const r = RUN[L.id](fr, done);
            if (!r) continue;
            done[L.id] = r;
            if (!ids.includes(L.id)) continue;
            const key = L.field.key, v = r.columns[key];
            const eqIdx = r.idx.filter(i => _fin(v[i]));
            const equity = !L.equity ? null : {
                gini: _round(gini(v, pop, eqIdx), 3),
                lorenz: lorenz(v, pop, eqIdx, 10),
                palma: _round(palma(v, pop, eqIdx), 2),
                mean: _round(wmean(v, pop, eqIdx), 2),
            };
            const hsKey = r.weightKey || key;
            const hs = opts.hotspots === false || r.noHotspots ? null : hotspots(fr.grid, r.columns[hsKey], r.idx, { permutations: opts.permutations ?? 0 });
            const fields = [L.field, ...(L.extra || [])].map(f => (r.categories && r.categories[f.key] ? { ...f, ...r.categories[f.key] } : f));
            for (const f of fields) if (r.columns[f.key]) layerCols[f.key] = r.columns[f.key];
            const srcIds = new Set(L.needs.map(k => k.split('.')[0]).concat(L.after ? L.after.flatMap(a => BY_ID.get(a).needs.map(k => k.split('.')[0])) : []).concat(['population']));
            out.push({
                id: L.id, title: L.title, icon: L.icon, question: L.question, method: L.method, refs: L.refs,
                fields, headline: r.headline, stats: r.stats, equity, fit: r.fit || null,
                hotspots: hs ? { field: hsKey, moranI: hs.moranI, z: hs.z, reading: hs.reading, km: hs.km,
                    hot: hs.hot.map(i => fr.grid.codes[i]), cold: hs.cold.map(i => fr.grid.codes[i]), lisa: hs.lisaCounts } : null,
                sources: fr.sources.filter(s => srcIds.has(s.id)).map(s => s.id),
                missing: fr.missing.filter(k => L.needs.includes(k)),
            });
        }
        // The layer: residents' cells only, so farmland stays unpainted.
        const res = _residents(fr);
        const layer = { level: fr.level, cells: res.map(i => fr.grid.codes[i]), columns: {} };
        for (const [k, v] of Object.entries(layerCols)) layer.columns[k] = res.map(i => (_fin(v[i]) ? _round(v[i], 3) : null));
        const result = {
            schema: SCHEMA, kind: 'lenses', city: fr.city, cityLabel: UrbanInsights.cityLabel(fr.city),
            ranAt: (opts.now ? opts.now() : new Date()).toISOString(),
            residents: Math.round(_sumOver(pop, res, () => true)), cells: res.length,
            lenses: out, layer, sources: fr.sources, missing: fr.missing,
        };
        Object.defineProperty(result, '_work', { value: { frame: fr, done }, enumerable: false });
        return result;
    }

    /**
     * Local Moran's I clusters for one lens of a run, with a seeded
     * permutation test (99 draws): { HH, LL, HL, LH } → [codes].
     */
    function clusters(result, lensId, opts = {}) {
        const w = result && result._work;
        const lens = result && result.lenses.find(l => l.id === lensId);
        if (!w || !lens || !w.done[lensId]) return null;
        const r = w.done[lensId];
        const key = (lens.hotspots && lens.hotspots.field) || lens.fields[0].key;
        const hs = hotspots(w.frame.grid, r.columns[key], r.idx, { permutations: opts.permutations ?? 99, seed: opts.seed });
        const out = { field: key, moranI: hs.moranI, z: hs.z, reading: hs.reading, HH: [], LL: [], HL: [], LH: [] };
        const names = ['', 'HH', 'LL', 'HL', 'LH'];
        if (hs.lisa) for (const i of r.idx) if (hs.lisa[i]) out[names[hs.lisa[i]]].push(w.frame.grid.codes[i]);
        return out;
    }

    /** The runtime cell-store dataset for a run (id 'lenses'). */
    function toLayer(result, id = 'lenses') {
        if (!result || !result.layer || !result.layer.cells.length) return null;
        const fields = [];
        for (const l of result.lenses) for (const f of l.fields) {
            if (!result.layer.columns[f.key] || fields.some(x => x.key === f.key)) continue;
            if (f.type === 'category') {
                fields.push({ key: f.key, label: f.label, type: 'category', agg: 'mode', domain: f.domain.slice().sort(), colors: f.colors });
                continue;
            }
            fields.push({ key: f.key, label: f.label, type: 'number', agg: f.unit === 'people' ? 'sum' : 'mean', unit: f.unit,
                ramp: f.ramp, higherIs: f.higherIs || undefined });
        }
        if (!fields.length) return null;
        const order = result.layer.cells.map((c, i) => i).sort((a, b) => (result.layer.cells[a] < result.layer.cells[b] ? -1 : 1));
        const columns = {};
        for (const f of fields) {
            const src = result.layer.columns[f.key];
            const names = f.type === 'category' ? result.lenses.flatMap(l => l.fields).find(x => x.key === f.key).domain : null;
            columns[f.key] = order.map(i => (names ? (src[i] == null ? null : names[src[i]]) : src[i]));
        }
        return {
            spec: { id, title: `Urban lenses: ${result.cityLabel}`, description: 'Heat vulnerability, flood exposure, 15-minute access, healthcare access, air exposure, night lights and compound risk, computed in the browser.',
                source: 'js/urban-lenses.js', license: 'Derived from the cell store', group: 'Urban lenses', level: result.layer.level,
                fields, default: { field: fields[0].key, extrude: true, heightM: 600 } },
            table: { level: result.layer.level, cells: order.map(i => result.layer.cells[i]), columns },
        };
    }

    /** Plain-text summary (DISHA, copy). */
    function toText(result, ids) {
        const ls = result.lenses.filter(l => !ids || ids.includes(l.id));
        return [`Urban lenses for ${result.cityLabel} (${_people(result.residents)} residents):`,
            ...ls.map(l => `- ${l.title}: ${l.headline}${l.equity && l.equity.gini != null ? ` Gini ${l.equity.gini}.` : ''}${l.hotspots && l.hotspots.moranI != null ? ` ${l.hotspots.reading} (Moran’s I ${l.hotspots.moranI}).` : ''}`)].join('\n');
    }

    return {
        SCHEMA, LENSES, ESSENTIALS, CELL_DEG,
        prank, wmean, wquantile, gini, lorenz, palma, ols, pearson, grid, frameFrom, frame, allNeeds,
        e2sfca, kmeans, silhouette, archetypeName, hotspots, run, clusters, toLayer, toText,
        _lenses: RUN,
    };
})();

if (typeof window !== 'undefined') {
    window.UrbanLenses = UrbanLenses;
}
