/**
 * UrbanAgents — named analysis agents a user picks from a gallery and runs on
 * an area: plan first, then run, then a structured report that becomes a map
 * layer plus a report card (the Aino.world "agents" pattern, done in the
 * browser over the static cell store).
 *
 *   TEMPLATES          the gallery: id, title, icon, question, params
 *   plan(input)        the steps a run will take, before anything runs
 *   run(input, store)  execute the steps → { report, layer }
 *
 * input = { agent, area, params } where `area` is anything
 * UrbanInsights.resolveArea accepts: { code } (a DIGIPIN prefix), { bbox },
 * { city } or { polygon }.
 *
 * The report (schema digipin.agent-report/1) is plain JSON so it can be saved,
 * shared and re-rendered:
 *   { schema, id, agent, title, question, ranAt, input, area, city, cityLabel,
 *     summary, metrics[{label, value}], findings[{kind, title, detail, cells,
 *     sources}], layers[{id, title, field, unit, runtime}], sources[], steps[],
 *     method, refs }
 * `layer` is a runtime cell-store dataset ({ spec, table }) or null; it is kept
 * out of the report because it is large and a re-run rebuilds it.
 *
 * Every number comes from the engines that already back the Intel dialog:
 * UrbanInsights (area insights, what changed, what-if) and UrbanLenses (heat,
 * flood, 15-minute, healthcare). Site suitability and growth hotspots are
 * computed here from the scores, water and growth datasets. No model call is
 * needed to run an agent; DISHA can narrate a finished report (agents-panel).
 */
const UrbanAgents = (() => {
    const SCHEMA = 'digipin.agent-report/1';
    const LAYER_PREFIX = 'agent_';
    const MAX_CELLS = 6;

    const SITE_USES = {
        housing: { label: 'Housing', weights: { livability: 3, safety: 2, healthcare_access: 1.5, education_score: 1.5, green: 1, noise_estimate: 1 } },
        clinic: { label: 'Clinic', weights: { population_proxy: 3, healthcare_access: -3, connectivity: 1.5, walkability: 1 } },
        school: { label: 'School', weights: { population_proxy: 2.5, education_score: -2.5, safety: 1.5, walkability: 1.5 } },
        retail: { label: 'Shop or market', weights: { population_proxy: 2, connectivity: 2, walkability: 1.5, commercial: 1 } },
        park: { label: 'Park', weights: { population_proxy: 2.5, green: -3, flood_risk: 0.5 } },
    };

    const TEMPLATES = [
        {
            id: 'brief', title: 'Area brief', icon: '◆',
            question: 'What stands out about this place?',
            blurb: 'Ranks every dataset for the area against its city: strengths, concerns, trends and hotspots.',
            params: [],
        },
        {
            id: 'site', title: 'Site suitability', icon: '◎',
            question: 'Where should this go?',
            blurb: 'Scores every cell for a use from walkability, access, safety, demand and flood risk, and picks the best sites.',
            params: [{ key: 'use', label: 'Use', options: Object.entries(SITE_USES).map(([k, v]) => ({ value: k, label: v.label })), default: 'clinic' }],
        },
        {
            id: 'flood', title: 'Flood exposure', icon: '🌊',
            question: 'Who lives in the floodplain here?',
            blurb: 'People and buildings in the 100-year floodplain, the riskiest cells, and a severe-flood what-if.',
            params: [],
        },
        {
            id: 'heat', title: 'Heat vulnerability', icon: '🌡',
            question: 'Who suffers most in a heatwave?',
            blurb: 'Heat exposure × sensitivity × (1 − adaptive capacity) per cell, and where shade would help most.',
            params: [],
        },
        {
            id: 'access', title: '15-minute access', icon: '🚶',
            question: 'Can people reach daily needs on foot?',
            blurb: 'Seven daily essentials within a 15-minute walk, healthcare per resident in reach, and the gaps.',
            params: [],
        },
        {
            id: 'growth', title: 'Growth hotspots', icon: '↗',
            question: 'Where is the city growing fastest?',
            blurb: 'Built-up change 2016–2023, new buildings and the 2035 urban outlook, clustered into hotspots.',
            params: [],
        },
        {
            id: 'changes', title: 'What changed', icon: '⟳',
            question: 'What moved in the latest data?',
            blurb: 'Each monthly and yearly series against a year earlier, with the cells that changed unusually.',
            params: [],
        },
        {
            id: 'air', title: 'Air exposure', icon: '🌫', lens: 'air',
            question: 'How many people breathe air above the standard?',
            blurb: 'Population-weighted PM2.5 against India’s NAAQS and the WHO guideline, and the worst-exposed cells.',
            params: [],
        },
        {
            id: 'green', title: '3-30-300 green', icon: '🌳', lens: 'green',
            question: 'Does every home have canopy and a park nearby?',
            blurb: '30% tree canopy within 500 m and green space within 300 m of home, and who misses both.',
            params: [],
        },
        {
            id: 'solar', title: 'Rooftop solar', icon: '☀', lens: 'solar',
            question: 'How much power could these roofs make?',
            blurb: 'Usable roof area × NASA POWER irradiance, against what residents use, and the best roofs to start with.',
            params: [],
        },
        {
            id: 'risk', title: 'Compound risk', icon: '⚠', lens: 'burden',
            question: 'Where do heat, flood and dirty air stack up?',
            blurb: 'Cells in the city’s worst fifth for two or three hazards at once, and the people living there.',
            params: [],
        },
        {
            id: 'programme', title: 'Programme siting', icon: '📍',
            question: 'Where should a city programme start?',
            blurb: 'AHP-weighted multi-criteria siting for cool roofs or EV charging hubs, spaced apart, with why each site ranks.',
            params: [{ key: 'preset', label: 'Programme', options: [{ value: 'cool_roofs', label: 'Cool roofs' }, { value: 'ev_charging', label: 'EV charging' }], default: 'cool_roofs' }],
        },
        {
            id: 'health', title: 'Data health', icon: '♥', scope: 'project',
            question: 'Can I trust the live feeds right now?',
            blurb: 'The Pipeline Steward: freshness, emptiness and wiring of every live feed, with what to fix.',
            params: [],
        },
    ];
    const BY_ID = new Map(TEMPLATES.map(t => [t.id, t]));

    // ── helpers ─────────────────────────────────────────────────────────────

    const _fin = (x) => x != null && Number.isFinite(Number(x));
    const _round = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
    const _people = (n) => (n >= 1e5 ? `${_round(n / 1e5, 1)} lakh` : Math.round(n).toLocaleString('en-IN'));
    const _pct = (x) => `${Math.round(x)}%`;

    /** End a sentence once. */
    const _sentence = (t) => { const x = String(t || '').trim().replace(/\.+$/, ''); return x ? `${x}.` : ''; };

    function _store(store) { return store || (typeof CellStore !== 'undefined' ? CellStore : null); }

    function template(id) { return BY_ID.get(id) || null; }

    function _params(t, params) {
        const out = {};
        for (const p of t.params) {
            const v = params && params[p.key];
            out[p.key] = p.options.some(o => o.value === v) ? v : p.default;
        }
        return out;
    }

    function _loadTable(store, id, bbox) {
        return (bbox && store.loadView) ? store.loadView(id, bbox) : store.load(id);
    }

    /** Area for a run, with its city. */
    function resolve(input, store) {
        const area = UrbanInsights.resolveArea(input.area, store);
        if (!area) throw new Error('Pick an area first: the selected neighbourhood, the map view, a city or a drawn shape.');
        const b = area.bbox;
        const city = area.kind === 'city' ? area.city : UrbanInsights.cityAt(store, (b.south + b.north) / 2, (b.west + b.east) / 2);
        return { area, city, cityLabel: UrbanInsights.cityLabel(city) };
    }

    /** True when a cell code's centre falls inside the area. */
    function inArea(code, area) {
        if (!area) return false;
        if (area.kind === 'city') return true;
        if (area.kind === 'prefix') {
            const c = String(code), p = area.code;
            return c.length >= p.length ? c.startsWith(p) : p.startsWith(c);
        }
        let c;
        try { c = DigiPin.decodePartial(String(code)); } catch { return false; }
        const b = area.bbox;
        if (!(c.lat >= b.south && c.lat <= b.north && c.lng >= b.west && c.lng <= b.east)) return false;
        return area.kind !== 'polygon' || UrbanInsights.pointInPolygon(area.polygon, c.lng, c.lat);
    }

    /** Within-set percentile rank in [0, 1] for each index in `idx`; NaN elsewhere. */
    function prank(values, idx) {
        const out = new Float64Array(values.length).fill(NaN);
        const pts = idx.filter(i => _fin(values[i])).sort((a, b) => values[a] - values[b]);
        const n = pts.length;
        if (!n) return out;
        let k = 0;
        while (k < n) {
            let j = k;
            while (j + 1 < n && values[pts[j + 1]] === values[pts[k]]) j++;
            const r = n === 1 ? 0.5 : ((k + j) / 2) / (n - 1);
            for (let m = k; m <= j; m++) out[pts[m]] = r;
            k = j + 1;
        }
        return out;
    }

    /** Pick up to `n` cells by score, at most one per parent of length `parentLen`. */
    function spread(ranked, n, parentLen) {
        const seen = new Set(), out = [];
        for (const r of ranked) {
            const p = String(r.code).slice(0, parentLen);
            if (seen.has(p)) continue;
            seen.add(p);
            out.push(r);
            if (out.length >= n) break;
        }
        return out;
    }

    function _layerFrom(id, title, description, level, rows, field) {
        if (!rows.length) return null;
        const sorted = rows.slice().sort((a, b) => (a.code < b.code ? -1 : 1));
        return {
            spec: { id, title, description, source: 'js/urban-agents.js', license: 'Derived from the cell store', group: 'Agent results', level,
                fields: [{ key: field.key, label: field.label, type: 'number', agg: field.agg || 'mean', unit: field.unit, ramp: field.ramp, higherIs: field.higherIs }],
                default: { field: field.key, extrude: true, heightM: 500 } },
            table: { level, cells: sorted.map(r => r.code), columns: { [field.key]: sorted.map(r => r.value) } },
        };
    }

    function _sourcesFor(store, ids) {
        const out = [];
        for (const id of new Set(ids)) {
            const spec = store.get(id);
            if (spec) out.push(UrbanInsights.sourceOf(spec, store));
        }
        return out;
    }

    // ── plans ───────────────────────────────────────────────────────────────

    const _lensPlan = (lensId, what) => () => [
        { tool: 'lens', label: `Run the ${what} lens for the city`, detail: _lensMethod(lensId) },
        { tool: 'slice', label: 'Slice it to the area: residents, the city’s worst tenth, the cells that stand out' },
        { tool: 'layer', label: `Paint ${what} as a layer` },
    ];
    function _lensMethod(id) {
        const l = typeof UrbanLenses !== 'undefined' && UrbanLenses.catalog ? UrbanLenses.catalog().find(x => x.id === id) : null;
        return l ? l.method : '';
    }

    const PLANS = {
        air: _lensPlan('air', 'air-pollution exposure'),
        green: _lensPlan('green', '3-30-300 green rule'),
        solar: _lensPlan('solar', 'rooftop solar potential'),
        risk: _lensPlan('burden', 'compound-risk'),
        programme: (p) => [
            { tool: 'lens', label: `Run the ${p.preset === 'ev_charging' ? 'EV charging hub' : 'cool-roof programme'} siting lens for the city`, detail: 'AHP weights from a pairwise matrix; each criterion a within-city percentile rank' },
            { tool: 'pickSites', label: 'Keep the best-ranked sites inside the area, at least 1.5 km apart' },
            { tool: 'layer', label: 'Paint suitability (0–100) as a layer' },
        ],
        health: () => [
            { tool: 'stewardReport', label: "Read the Pipeline Steward's last report", detail: 'data/steward/report.json, written every 6 hours by the steward workflow' },
            { tool: 'liveCheck', label: 'Re-check every live snapshot now (age and row count)', detail: `stale after ${STALE_H}h (imd_cityforecast ${STALE_H_SLOW}h), dead after ${DEAD_D} days` },
            { tool: 'report', label: 'List what is broken and how to fix it' },
        ],
        brief: () => [
            { tool: 'areaInsights', label: 'Rank every dataset for the area against its city' },
            { tool: 'hotspots', label: 'Find hotspot cells for the top findings' },
            { tool: 'report', label: 'Write the brief and suggest the most telling layer' },
        ],
        site: (p) => [
            { tool: 'loadData', label: 'Load the scores grid and the 100-year floodplain' },
            { tool: 'rankSites', label: `Score every built-up cell for a ${SITE_USES[p.use].label.toLowerCase()}`,
                detail: Object.entries(SITE_USES[p.use].weights).map(([k, w]) => `${k} ${w > 0 ? '+' : '−'}${Math.abs(w)}`).join(', ') + '; floodplain share discounts the score' },
            { tool: 'pickSites', label: `Pick the ${MAX_CELLS - 1} best sites, one per neighbourhood` },
            { tool: 'layer', label: 'Paint suitability (0–100) as a layer' },
        ],
        flood: () => [
            { tool: 'lens', label: 'Run the flood-exposure lens for the city (hazard × residents)' },
            { tool: 'slice', label: 'Count residents and riskiest cells inside the area' },
            { tool: 'whatIf', label: 'Simulate a severe flood event over the area (buildings affected)' },
            { tool: 'layer', label: 'Paint people in the floodplain as a layer' },
        ],
        heat: () => [
            { tool: 'lens', label: 'Run the heat-vulnerability lens for the city (exposure × sensitivity × capacity)' },
            { tool: 'slice', label: 'Find the most vulnerable residents and cells inside the area' },
            { tool: 'layer', label: 'Paint heat vulnerability (city percentile) as a layer' },
        ],
        access: () => [
            { tool: 'lens', label: 'Run the 15-minute and healthcare-access lenses for the city' },
            { tool: 'slice', label: 'Find populated cells with the poorest access inside the area' },
            { tool: 'layer', label: 'Paint 15-minute completeness as a layer' },
        ],
        growth: () => [
            { tool: 'loadData', label: 'Load built-up growth 2016–2023, new buildings and the 2035 outlook' },
            { tool: 'hotspots', label: 'Rank cells by built-up change and cluster them by neighbourhood' },
            { tool: 'layer', label: 'Paint built-up change as a layer' },
        ],
        changes: () => [
            { tool: 'changes', label: 'Compare every time series’ latest step with a year earlier' },
            { tool: 'slice', label: 'Keep the cells that changed unusually inside the area' },
            { tool: 'report', label: 'Rank the moves by how unusual they are' },
        ],
    };

    /** The steps a run will take, before anything runs. Pure. */
    function plan(input) {
        const t = template(input && input.agent);
        if (!t) throw new Error(`Unknown agent "${input && input.agent}".`);
        const params = _params(t, input.params);
        return { agent: t.id, title: t.title, question: t.question, params, steps: PLANS[t.id](params) };
    }

    // ── runners ─────────────────────────────────────────────────────────────

    async function _brief(ctx, store, step) {
        const r = await step('areaInsights', () => UrbanInsights.areaInsights(ctx.area.kind === 'city' ? { city: ctx.city } : ctx.input.area, store, { limit: 8 }),
            (x) => `${x.findings.length} findings from ${x.coverage.length} datasets`);
        await step('hotspots', () => r.hotspots, (h) => `${h.length} hotspot${h.length === 1 ? '' : 's'}`);
        const top = r.findings[0];
        const findings = r.findings.map(f => ({
            kind: f.kind, title: f.title, detail: f.detail || '', sources: f.sources || [f.dataset],
            cells: r.hotspots.filter(h => h.finding === f.id).map(h => h.code),
        }));
        await step('report', () => true, () => 'done');
        return {
            summary: r.headline,
            metrics: [{ label: 'Datasets compared', value: String(r.coverage.length) }, { label: 'Notable findings', value: String(r.findings.length + r.more) }],
            findings,
            layers: top ? [{ id: top.dataset, title: top.label, field: top.key, unit: top.unit || '', runtime: false }] : [],
            sources: r.sources, method: r.method,
            layer: null,
        };
    }

    async function _site(ctx, store, step) {
        const use = SITE_USES[ctx.params.use];
        const spec = store.get('scores');
        if (!spec) throw new Error('The scores grid is not in the store.');
        const bbox = ctx.area.bbox;
        const [table, water] = await step('loadData', () => Promise.all([
            _loadTable(store, 'scores', bbox), store.get('water') ? _loadTable(store, 'water', bbox).catch(() => null) : null,
        ]), ([t, w]) => `${t ? t.cells.length : 0} score cells${w ? ', floodplain loaded' : ''}`);
        if (!table) throw new Error('No scores for this area.');

        const rows = await step('rankSites', () => {
            let idx = [];
            for (let i = 0; i < table.cells.length; i++) if (inArea(table.cells[i], ctx.area)) idx.push(i);
            idx = UrbanInsights.activeCells(table, idx);
            // Floodplain share per score cell: the mean of its finer water cells.
            const flood = new Map();
            if (water && water.columns && water.columns.flood_rp100_pct) {
                const acc = new Map();
                const col = water.columns.flood_rp100_pct;
                for (let i = 0; i < water.cells.length; i++) {
                    if (!_fin(col[i])) continue;
                    const p = String(water.cells[i]).slice(0, table.level);
                    const a = acc.get(p) || [0, 0];
                    a[0] += Number(col[i]); a[1]++;
                    acc.set(p, a);
                }
                for (const [k, [s, n]] of acc) flood.set(k, s / n);
            }
            const ranks = {};
            for (const k of Object.keys(use.weights)) {
                const col = UrbanInsights.scalarColumn(spec, table, k);
                if (col) ranks[k] = prank(col, idx);
            }
            const keys = Object.keys(ranks);
            if (!keys.length) return [];
            const total = keys.reduce((a, k) => a + Math.abs(use.weights[k]), 0);
            const out = [];
            for (const i of idx) {
                let s = 0, ok = true;
                for (const k of keys) {
                    const r = ranks[k][i];
                    if (!_fin(r)) { ok = false; break; }
                    const w = use.weights[k];
                    s += Math.abs(w) * (w > 0 ? r : 1 - r);
                }
                if (!ok) continue;
                const code = table.cells[i];
                const fp = flood.get(code) || 0;
                const score = 100 * (s / total) * (1 - Math.min(0.6, fp / 100));
                out.push({ code, value: _round(score, 1), flood: _round(fp, 1) });
            }
            return out.sort((a, b) => b.value - a.value);
        }, (r) => `${r.length} candidate cells`);
        if (!rows.length) throw new Error('No built-up cells with scores in this area.');

        // One site per neighbourhood: a parent one level below the area (or
        // one level above the cells), so a small area still yields several.
        const plen = ctx.area.kind === 'prefix' ? Math.min(table.level, ctx.area.code.length + 1) : Math.max(1, table.level - 1);
        const picks = await step('pickSites', () => spread(rows, MAX_CELLS - 1, plen),
            (p) => p.map(x => DigiPin.format(x.code)).join(', '));
        const layer = _layerFrom(`${LAYER_PREFIX}site`, `Agent: ${use.label} suitability`, `${use.label} suitability for ${ctx.area.label}`,
            table.level, rows, { key: 'suitability', label: `${use.label} suitability`, unit: '0-100', ramp: 'greens', higherIs: 'better' });
        await step('layer', () => layer, () => `${rows.length} cells`);

        const weightText = Object.entries(use.weights).map(([k, w]) => `${w > 0 ? 'high' : 'low'} ${k.replace(/_/g, ' ')}`).join(', ');
        return {
            summary: `The best ${use.label.toLowerCase()} site in ${ctx.area.label} is ${DigiPin.format(picks[0].code)} (score ${picks[0].value}/100), `
                + `ranked among ${rows.length} built-up cells for ${weightText}.`,
            metrics: [
                { label: 'Cells scored', value: String(rows.length) },
                { label: 'Best score', value: `${picks[0].value}/100` },
                { label: 'Median score', value: `${rows[Math.floor(rows.length / 2)].value}/100` },
            ],
            findings: picks.map((p, i) => ({
                kind: 'site', title: `#${i + 1} ${DigiPin.format(p.code)}: ${p.value}/100`,
                detail: p.flood ? `${p.flood}% of the cell is in the 100-year floodplain, which lowers its score.` : 'Outside the mapped 100-year floodplain.',
                cells: [p.code], sources: p.flood ? ['scores', 'water'] : ['scores'],
            })),
            layers: layer ? [{ id: layer.spec.id, title: layer.spec.title, field: 'suitability', unit: '0-100', runtime: true }] : [],
            sources: _sourcesFor(store, ['scores', 'water']),
            method: `Each built-up cell gets its within-area percentile on each factor (inverted where lower is better: ${weightText}); `
                + 'the weighted mean is scaled to 0–100 and discounted by the share of the cell in the 100-year floodplain (at most 60%). '
                + 'Sites are the top cells, at most one per neighbourhood.',
            layer,
        };
    }

    /**
     * Run one lens for the area's city and read it inside the area: residents,
     * the population-weighted mean, how many residents fall in the city's
     * worst tenth, and the worst cells.
     */
    async function _lensSlice(ctx, store, step, lensId, extra = []) {
        if (!ctx.city) throw new Error('This area is outside the cities the data covers.');
        const res = await step('lens', () => UrbanLenses.run(ctx.city, store, { only: [lensId, ...extra], hotspots: true }),
            (r) => `${r.cells} populated cells in ${r.cityLabel}`);
        const lens = res.lenses.find(l => l.id === lensId);
        if (!lens) throw new Error(`The ${lensId} lens needs data this city does not have (${(res.missing || []).join(', ') || 'unknown'}).`);
        const { frame, done } = res._work;
        const key = lens.fields[0].key, worse = lens.fields[0].higherIs !== 'better';
        const vals = done[lensId].columns[key];
        const idxCity = done[lensId].idx.filter(i => _fin(vals[i]));
        const pop = frame.cols['population.population'] || [];
        const codes = frame.grid.codes;
        const slice = await step('slice', () => {
            const idx = idxCity.filter(i => inArea(codes[i], ctx.area));
            // The city's worst tenth by value, ties included (many cells share
            // the floor of a bounded index, e.g. 0% of essentials in reach).
            const sorted = idxCity.map(i => vals[i]).sort((a, b) => a - b);
            const cut = sorted.length ? sorted[Math.floor((worse ? 0.9 : 0.1) * (sorted.length - 1))] : null;
            const bad = (i) => cut != null && (worse ? vals[i] >= cut : vals[i] <= cut);
            let people = 0, badPeople = 0, wsum = 0, cityPeople = 0, cityW = 0;
            for (const i of idx) {
                const p = _fin(pop[i]) ? Number(pop[i]) : 0;
                people += p; wsum += p * vals[i];
                if (bad(i)) badPeople += p;
            }
            for (const i of idxCity) { const p = _fin(pop[i]) ? Number(pop[i]) : 0; cityPeople += p; cityW += p * vals[i]; }
            // The worst cells people actually live in: near-empty cells (a farmhouse
            // at the edge) would otherwise top every list. Ties go to more residents.
            const lived = idx.filter(i => (Number(pop[i]) || 0) >= 50);
            const worst = (lived.length >= MAX_CELLS ? lived : idx).slice()
                .sort((a, b) => (worse ? vals[b] - vals[a] : vals[a] - vals[b]) || (Number(pop[b]) || 0) - (Number(pop[a]) || 0))
                .map(i => ({ code: codes[i], value: _round(vals[i], 1), people: Math.round(_fin(pop[i]) ? pop[i] : 0) }));
            return {
                idx, people, badPeople, mean: people ? wsum / people : null, cityMean: cityPeople ? cityW / cityPeople : null,
                worst: spread(worst, MAX_CELLS, Math.max(1, frame.level - 1)),
                hot: lens.hotspots ? lens.hotspots.hot.filter(c => inArea(c, ctx.area)) : [],
            };
        }, (s) => `${s.idx.length} cells, ${_people(s.people)} residents in the area`);
        const rows = slice.idx.map(i => ({ code: codes[i], value: _round(vals[i], 2) }));
        const f = lens.fields[0];
        const layer = _layerFrom(`${LAYER_PREFIX}${ctx.agent}`, `Agent: ${lens.title}`, `${lens.title} for ${ctx.area.label}`, frame.level, rows,
            { key: f.key, label: f.label, unit: f.unit, ramp: f.ramp, higherIs: f.higherIs || undefined, agg: f.unit === 'people' ? 'sum' : 'mean' });
        await step('layer', () => layer, () => `${rows.length} cells`);
        return { res, lens, slice, layer, field: f };
    }

    async function _flood(ctx, store, step) {
        const { res, lens, slice, layer, field } = await _lensSlice(ctx, store, step, 'flood');
        const wi = await step('whatIf', () => UrbanInsights.whatIf({ type: 'flood', level: 'severe', ...(ctx.area.kind === 'city' ? { city: ctx.city } : { area: ctx.input.area }) }, store).catch(() => null),
            (w) => (w ? w.summary || 'done' : 'no flood model for this area'));
        const inPlain = slice.idx.reduce((a, i) => a + (Number(res._work.done.flood.columns.flood_people[i]) || 0), 0);
        const share = slice.people ? (100 * inPlain) / slice.people : 0;
        const summary = ctx.area.kind === 'city' ? _sentence(lens.headline)
            : `${_people(inPlain)} of ${_people(slice.people)} residents in ${ctx.area.label} (${_pct(share)}) live in the 100-year floodplain.`;
        const findings = slice.worst.filter(w => w.value > 0).map(w => ({
            kind: 'concern', title: `${DigiPin.format(w.code)}: ${_people(w.value)} people in the floodplain`,
            detail: `${_people(w.people)} residents in the cell.`, cells: [w.code], sources: lens.sources,
        }));
        if (wi && wi.summary) findings.push({ kind: 'notable', title: 'Severe flood what-if', detail: wi.summary, cells: [], sources: wi.sources ? wi.sources.map(s => s.id || s) : ['water'] });
        if (slice.hot.length) findings.push({ kind: 'notable', title: `${slice.hot.length} flood-exposure hotspot cells`, detail: `Getis-Ord Gi* clusters of exposure (${lens.hotspots.reading}).`, cells: slice.hot.slice(0, MAX_CELLS), sources: lens.sources });
        return {
            summary,
            metrics: [
                { label: 'Residents in the area', value: _people(slice.people) },
                { label: 'In the 100-year floodplain', value: `${_people(inPlain)} (${_pct(share)})` },
                ...(ctx.area.kind === 'city' ? lens.stats.slice(1, 2) : lens.stats.slice(0, 2))
                    .map(s => ({ label: `${ctx.cityLabel}: ${s.label.charAt(0).toLowerCase()}${s.label.slice(1)}`, value: s.value })),
            ],
            findings, layers: layer ? [{ id: layer.spec.id, title: layer.spec.title, field: field.key, unit: field.unit, runtime: true }] : [],
            sources: res.sources.filter(s => lens.sources.includes(s.id)), method: lens.method, refs: lens.refs, layer,
        };
    }

    async function _heat(ctx, store, step) {
        const { res, lens, slice, layer, field } = await _lensSlice(ctx, store, step, 'heat');
        const share = slice.people ? (100 * slice.badPeople) / slice.people : 0;
        const summary = ctx.area.kind === 'city' ? _sentence(lens.headline)
            : `${_people(slice.badPeople)} of ${_people(slice.people)} residents in ${ctx.area.label} (${_pct(share)}) live in ${ctx.cityLabel}’s most heat-vulnerable tenth; `
              + `the area averages ${_round(slice.mean)} against ${_round(slice.cityMean)} city-wide on the 0–100 index.`;
        const findings = slice.worst.map(w => ({
            kind: 'concern', title: `${DigiPin.format(w.code)}: heat vulnerability ${w.value}`,
            detail: `${_people(w.people)} residents. Shade trees, cool roofs or a cooling centre here reach the most vulnerable.`, cells: [w.code], sources: lens.sources,
        }));
        if (slice.hot.length) findings.push({ kind: 'notable', title: `${slice.hot.length} heat hotspot cells`, detail: `Getis-Ord Gi* clusters (${lens.hotspots.reading}).`, cells: slice.hot.slice(0, MAX_CELLS), sources: lens.sources });
        return {
            summary,
            metrics: [
                { label: 'Residents in the area', value: _people(slice.people) },
                { label: 'In the city’s most vulnerable tenth', value: `${_people(slice.badPeople)} (${_pct(share)})` },
                { label: 'Area vs city mean (0–100)', value: `${_round(slice.mean)} vs ${_round(slice.cityMean)}` },
            ],
            findings, layers: layer ? [{ id: layer.spec.id, title: layer.spec.title, field: field.key, unit: field.unit, runtime: true }] : [],
            sources: res.sources.filter(s => lens.sources.includes(s.id)), method: lens.method, refs: lens.refs, layer,
        };
    }

    async function _access(ctx, store, step) {
        const { res, lens, slice, layer, field } = await _lensSlice(ctx, store, step, 'fifteen', ['health']);
        const health = res.lenses.find(l => l.id === 'health');
        const share = slice.people ? (100 * slice.badPeople) / slice.people : 0;
        const summary = ctx.area.kind === 'city' ? _sentence(lens.headline)
            : `Residents of ${ctx.area.label} reach on average ${_round(slice.mean)}% of daily essentials on foot (city ${_round(slice.cityMean)}%); `
              + `${_people(slice.badPeople)} (${_pct(share)}) live in the city’s least walkable tenth.`;
        const findings = slice.worst.map(w => ({
            kind: 'concern', title: `${DigiPin.format(w.code)}: ${w.value}% of essentials within 15 minutes`,
            detail: `${_people(w.people)} residents. A gap here is a candidate for a market, clinic or school.`, cells: [w.code], sources: lens.sources,
        }));
        if (health) findings.push({ kind: 'notable', title: 'Healthcare access', detail: health.headline, cells: [], sources: health.sources });
        return {
            summary,
            metrics: [
                { label: 'Residents in the area', value: _people(slice.people) },
                { label: 'Essentials in reach (area vs city)', value: `${_round(slice.mean)}% vs ${_round(slice.cityMean)}%` },
                { label: 'In the least walkable tenth', value: `${_people(slice.badPeople)} (${_pct(share)})` },
            ],
            findings, layers: layer ? [{ id: layer.spec.id, title: layer.spec.title, field: field.key, unit: field.unit, runtime: true }] : [],
            sources: res.sources.filter(s => lens.sources.concat(health ? health.sources : []).includes(s.id)),
            method: lens.method + (health ? ` ${health.method}` : ''), refs: lens.refs, layer,
        };
    }

    async function _growth(ctx, store, step) {
        const spec = store.get('growth');
        if (!spec) throw new Error('The growth dataset is not in the store.');
        const bbox = ctx.area.kind === 'city' ? null : ctx.area.bbox;
        const [g, bs] = await step('loadData', () => Promise.all([
            _loadTable(store, 'growth', bbox), store.get('building_stock') ? _loadTable(store, 'building_stock', bbox).catch(() => null) : null,
        ]), ([t]) => `${t ? t.cells.length : 0} growth cells`);
        if (!g) throw new Error('No growth data for this area.');
        const out = await step('hotspots', () => {
            const ch = UrbanInsights.scalarColumn(spec, g, 'built_change_pp') || [];
            const fut = UrbanInsights.scalarColumn(spec, g, 'urban_2035_pct') || [];
            const region = ctx.area.kind === 'city' ? new Set(UrbanInsights.cellsInRegion(spec, g, ctx.city)) : null;
            const idx = [];
            for (let i = 0; i < g.cells.length; i++) {
                if (_fin(ch[i]) && (region ? region.has(i) : inArea(g.cells[i], ctx.area))) idx.push(i);
            }
            const nb = new Map();
            if (bs && bs.columns && bs.columns.new_buildings) bs.cells.forEach((c, i) => { if (_fin(bs.columns.new_buildings[i])) nb.set(c, Number(bs.columns.new_buildings[i])); });
            const rows = idx.map(i => ({ code: g.cells[i], value: _round(Number(ch[i]), 2), future: _fin(fut[i]) ? Number(fut[i]) : null, newB: nb.get(g.cells[i]) || 0 }));
            // Neighbourhoods one level up (16 cells each) inside a small area,
            // two levels up (256 cells) for a whole city.
            const plen = Math.max(1, g.level - (ctx.area.kind === 'city' ? 2 : 1));
            const groups = new Map();
            for (const r of rows) {
                const p = r.code.slice(0, plen);
                const a = groups.get(p) || { code: p, n: 0, sum: 0, newB: 0, cells: [] };
                a.n++; a.sum += r.value; a.newB += r.newB; a.cells.push(r);
                groups.set(p, a);
            }
            const hot = [...groups.values()].filter(a => a.n >= 3).map(a => ({ ...a, mean: a.sum / a.n }))
                .sort((a, b) => b.mean - a.mean).slice(0, MAX_CELLS - 1);
            return { rows, hot };
        }, (o) => `${o.rows.length} cells, ${o.hot.length} hotspots`);
        if (!out.rows.length) throw new Error('No growth data inside this area.');
        const layer = _layerFrom(`${LAYER_PREFIX}growth`, 'Agent: Built-up change 2016–2023', `Built-up change for ${ctx.area.label}`, g.level,
            out.rows.map(r => ({ code: r.code, value: r.value })), { key: 'built_change_pp', label: 'Built-up change 2016–2023', unit: 'pp', ramp: 'reds', higherIs: null });
        await step('layer', () => layer, () => `${out.rows.length} cells`);
        const mean = out.rows.reduce((a, r) => a + r.value, 0) / out.rows.length;
        const newB = out.rows.reduce((a, r) => a + r.newB, 0);
        const futs = out.rows.filter(r => r.future != null);
        const fut = futs.length ? futs.reduce((a, r) => a + r.future, 0) / futs.length : null;
        const top = out.hot[0];
        return {
            summary: `${ctx.area.label} added ${_round(mean, 1)} percentage points of built-up land on average from 2016 to 2023`
                + (newB ? ` and about ${_people(newB)} new buildings` : '')
                + (top ? `; growth is fastest around ${DigiPin.format(top.code)} (+${_round(top.mean, 1)} pp).` : '.'),
            metrics: [
                { label: 'Cells', value: String(out.rows.length) },
                { label: 'Mean built-up change', value: `+${_round(mean, 1)} pp` },
                { label: 'New buildings 2016–2023', value: newB ? _people(newB) : '–' },
                { label: 'Projected urban share 2035', value: fut != null ? `${_round(fut)}%` : '–' },
            ],
            findings: out.hot.map(h => ({
                kind: 'trend', title: `${DigiPin.format(h.code)}: +${_round(h.mean, 1)} pp built-up`,
                detail: `${h.n} cells${h.newB ? `, ~${_people(h.newB)} new buildings` : ''}.`,
                cells: h.cells.sort((a, b) => b.value - a.value).slice(0, 3).map(c => c.code), sources: ['growth', 'building_stock'],
            })),
            layers: layer ? [{ id: layer.spec.id, title: layer.spec.title, field: 'built_change_pp', unit: 'pp', runtime: true }] : [],
            sources: _sourcesFor(store, ['growth', 'building_stock']),
            method: 'Built-up share per cell in 2016 and 2023 (and its 2035 projection) from the growth dataset; hotspots are the neighbourhoods '
                + '(two DIGIPIN levels up, at least three cells) with the highest mean change.',
            layer,
        };
    }

    async function _changes(ctx, store, step) {
        if (!ctx.city) throw new Error('This area is outside the cities the data covers.');
        const r = await step('changes', () => UrbanInsights.changes(store, { city: ctx.city, limit: 8 }), (x) => `${x.items.length} series moved`);
        const items = await step('slice', () => r.items.map(it => ({
            ...it, here: (it.anomalies || []).map(a => (typeof a === 'string' ? a : a.code)).filter(c => c && inArea(c, ctx.area)),
        })), (xs) => `${xs.reduce((a, x) => a + x.here.length, 0)} unusual cells in the area`);
        await step('report', () => true, () => 'done');
        const big = items.filter(x => x.unusual >= 1.5);
        return {
            summary: items.length
                ? `${items.length} series moved in ${ctx.cityLabel}'s latest data${big.length ? `; the most unusual: ${big[0].title.toLowerCase()}` : ''}.`
                : `Nothing in ${ctx.cityLabel}'s time series has a year-earlier step to compare with.`,
            metrics: [{ label: 'Series compared', value: String(items.length + (r.more || 0)) }, { label: 'Bigger than usual', value: String(big.length) }],
            findings: items.map(x => ({
                kind: x.good === true ? 'strength' : x.good === false ? 'concern' : 'trend', title: x.title,
                detail: x.detail + (ctx.area.kind !== 'city' && x.here.length ? ` ${x.here.length} of the unusual cells are in this area.` : ''),
                cells: x.here.slice(0, MAX_CELLS), sources: x.sources,
            })),
            layers: items[0] ? [{ id: items[0].dataset, title: items[0].label, field: items[0].key, unit: items[0].unit || '', runtime: false }] : [],
            sources: r.sources, method: r.method, layer: null,
        };
    }

    // ── data health (Pipeline Steward) ───────────────────────────────────────

    // Same windows as pipeline/steward/checks.py.
    const STALE_H = 6, STALE_H_SLOW = 24, DEAD_D = 7;
    const SLOW_FEEDS = new Set(['imd_cityforecast']);
    const STEWARD_REPORT = 'data/steward/report.json';
    const SEV = { ok: 0, info: 1, warn: 2, fail: 3 };

    function _ago(h) {
        if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
        if (h < 48) return `${Math.round(h)}h`;
        return `${Math.round(h / 24)}d`;
    }

    /** Grade one snapshot's age and size against the steward's windows. Pure. */
    function gradeFeed(id, snap, nowMs) {
        const at = snap && (snap.generated_at_iso || snap.generated_at);
        const t = at ? Date.parse(at) : NaN;
        const rows = snap ? (Array.isArray(snap.records) ? snap.records.length : Number(snap.count) || 0) : 0;
        if (!snap) return { id, status: 'fail', rows: 0, ageH: null, issues: ['snapshot is missing'] };
        const issues = [];
        let status = 'ok';
        const bump = (sev, msg) => { issues.push(msg); if (SEV[sev] > SEV[status]) status = sev; };
        if (!Number.isFinite(t)) bump('warn', 'snapshot has no timestamp');
        const ageH = Number.isFinite(t) ? Math.max(0, (nowMs - t) / 36e5) : null;
        const limit = SLOW_FEEDS.has(id) ? STALE_H_SLOW : STALE_H;
        if (ageH != null && ageH > DEAD_D * 24) bump('fail', `last refreshed ${_ago(ageH)} ago; the feed looks dead`);
        else if (ageH != null && ageH > limit) bump('warn', `last refreshed ${_ago(ageH)} ago, older than the ${limit}h window`);
        if (!rows) bump('warn', 'snapshot is empty');
        return { id, status, rows, ageH, issues };
    }

    async function _getJSON(fetcher, url) {
        const res = await fetcher(url, { cache: 'no-store' });
        if (!res || !res.ok) return null;
        try { return await res.json(); } catch { return null; }
    }

    async function _health(ctx, store, step) {
        const fetcher = ctx.fetch;
        if (!fetcher) throw new Error('Fetching is not available here.');
        const nowMs = ctx.now();
        const rep = await step('stewardReport', () => _getJSON(fetcher, STEWARD_REPORT),
            (r) => (r ? `${String(r.status || '?').toUpperCase()} at ${String(r.generated_at || '').slice(0, 16).replace('T', ' ')}Z, ${(r.findings || []).length} findings` : 'no steward report yet; checking the feeds directly'));
        const ids = rep && rep.sources ? Object.keys(rep.sources) : ctx.feeds || [];
        if (!ids.length) throw new Error('No live feeds are listed: the steward has not run yet.');
        const graded = await step('liveCheck', () => Promise.all(ids.map(async id => gradeFeed(id, await _getJSON(fetcher, `data/realtime/${id}/latest.json`), nowMs))),
            (g) => `${g.filter(x => x.status === 'ok').length} of ${g.length} feeds healthy`);
        await step('report', () => true, () => 'done');

        const bad = graded.filter(g => g.status === 'fail'), warn = graded.filter(g => g.status === 'warn');
        const ok = graded.filter(g => g.status === 'ok');
        const env = (id) => ((rep && rep.sources && rep.sources[id] && rep.sources[id].required_env) || []);
        const hints = new Map();
        for (const f of (rep && rep.findings) || []) if (f.hint && !hints.has(f.source)) hints.set(f.source, f.hint);
        const order = [...bad, ...warn].sort((a, b) => SEV[b.status] - SEV[a.status] || (b.ageH || 0) - (a.ageH || 0));
        const findings = order.map(g => {
            const keys = env(g.id);
            const fix = !g.rows && keys.length ? `needs ${keys.join(', ')} in the Actions secrets` : hints.get(g.id) || '';
            return {
                kind: 'concern', title: `${g.id}: ${g.issues[0]}`,
                detail: [g.issues.slice(1).join('; '), fix].filter(Boolean).join(' — '),
                sources: [g.id], cells: [],
            };
        });
        // Steward-only findings (wiring, contract, drift, products) the live check cannot see.
        for (const f of (rep && rep.findings) || []) {
            if (f.check === 'freshness' || f.check === 'volume') continue;
            findings.push({ kind: f.severity === 'fail' ? 'concern' : 'note', title: `${f.source}: ${f.message}`, detail: f.hint || '', sources: [f.source], cells: [] });
        }
        if (ok.length) findings.push({ kind: 'strength', title: `Healthy: ${ok.map(g => g.id).join(', ')}`, detail: 'Fresh within their window and not empty.', sources: ok.map(g => g.id), cells: [] });

        const repAgeH = rep && rep.generated_at ? (nowMs - Date.parse(rep.generated_at)) / 36e5 : null;
        const verdict = bad.length ? `${bad.length} of ${graded.length} live feeds are failing` : warn.length ? `${warn.length} of ${graded.length} live feeds need attention` : `All ${graded.length} live feeds are healthy`;
        const worst = order[0];
        return {
            summary: _sentence(`${verdict}${worst ? `; worst is ${worst.id} (${worst.issues[0]})` : ''}`),
            metrics: [
                { label: 'Feeds checked', value: String(graded.length) },
                { label: 'Failing', value: String(bad.length) },
                { label: 'Need attention', value: String(warn.length) },
                { label: 'Healthy', value: String(ok.length) },
                { label: 'Steward report age', value: repAgeH == null ? 'none yet' : _ago(repAgeH) },
            ],
            findings,
            sources: [{ id: 'steward', title: 'Pipeline Steward (pipeline/steward)' }, ...graded.map(g => ({ id: g.id, title: `data/realtime/${g.id}/latest.json` }))],
            method: `Each live snapshot is re-read in the browser and graded with the steward's windows: stale after ${STALE_H}h (${STALE_H_SLOW}h for slow feeds), dead after ${DEAD_D} days, and empty snapshots flagged. Wiring, contract and drift findings come from the steward's last report.`,
        };
    }

    // ── lens-backed agents (air, green, solar, compound risk, programme siting) ──

    const _SUM_UNITS = new Set(['people', 'MWh/yr']);
    const _num = (x, unit) => (unit === 'people' ? _people(x) : `${_round(x, x >= 100 ? 0 : 1).toLocaleString('en-IN')}${unit && !unit.startsWith('0-') && unit !== 'z' ? ` ${unit}` : ''}`);

    // A fixed threshold reads better than "the city's worst tenth" for coarse
    // or bounded fields (PM2.5 is ~1 km, the rule counts are 0–3).
    const LENS_BAD = {
        air: { test: (v) => v > 40, label: 'Above India’s annual PM2.5 standard', phrase: 'breathe PM2.5 above India’s annual standard (40 µg/m³)' },
        green: { test: (v) => v === 0, label: 'Meeting neither rule', phrase: 'have neither 30% canopy around home nor green space within 300 m' },
        burden: { test: (v) => v >= 2, label: 'Facing two or more hazards', phrase: 'face two or more of heat, flood and dirty air at their city’s worst' },
    };

    /** A lens sliced to the area: one runner for every single-field lens. */
    function _lensAgent(lensId) {
        return async (ctx, store, step) => {
            const { res, lens, slice, layer, field } = await _lensSlice(ctx, store, step, lensId);
            const vals = res._work.done[lensId].columns[field.key];
            const pop = res._work.frame.cols['population.population'] || [];
            const better = field.higherIs === 'better';
            const sum = _SUM_UNITS.has(field.unit);
            const total = sum ? slice.idx.reduce((a, i) => a + (_fin(vals[i]) ? Number(vals[i]) : 0), 0) : null;
            const rule = LENS_BAD[lensId];
            const badPeople = rule ? slice.idx.reduce((a, i) => a + (_fin(vals[i]) && rule.test(Number(vals[i])) ? Number(pop[i]) || 0 : 0), 0) : slice.badPeople;
            const share = slice.people ? (100 * badPeople) / slice.people : 0;
            const city = ctx.area.kind === 'city';
            const tail = better ? 'lowest' : 'worst';
            const badLabel = rule ? rule.label : `In the city’s ${tail} tenth`;
            const avg = `the area averages ${_num(slice.mean, field.unit)} against ${_num(slice.cityMean, field.unit)} city-wide`;
            const summary = city ? _sentence(lens.headline)
                : sum
                    ? _sentence(`${ctx.area.label} adds up to ${_num(total, field.unit)} of ${field.label.toLowerCase()} across ${_people(slice.people)} residents`)
                    : rule
                        ? _sentence(`${_people(badPeople)} of ${_people(slice.people)} residents in ${ctx.area.label} (${_pct(share)}) ${rule.phrase}; ${avg}`)
                        : _sentence(`${_people(badPeople)} of ${_people(slice.people)} residents in ${ctx.area.label} (${_pct(share)}) are in ${ctx.cityLabel}’s ${tail} tenth for ${field.label}; ${avg}`);
            // Solar's interesting cells are the best roofs; everyone else's are the worst-off.
            const findings = better && sum
                ? slice.idx.slice().sort((a, b) => (Number(vals[b]) || 0) - (Number(vals[a]) || 0)).slice(0, MAX_CELLS).map(i => ({
                    kind: 'strength', title: `${DigiPin.format(res._work.frame.grid.codes[i])}: ${_num(Number(vals[i]), field.unit)}`,
                    detail: 'Among the best roofs in the area; start a rooftop programme here.', cells: [res._work.frame.grid.codes[i]], sources: lens.sources,
                }))
                : slice.worst.map(w => ({
                    kind: 'concern', title: `${DigiPin.format(w.code)}: ${field.label} ${_num(w.value, field.unit)}`,
                    detail: `${_people(w.people)} residents.`, cells: [w.code], sources: lens.sources,
                }));
            if (slice.hot.length) findings.push({ kind: 'notable', title: `${slice.hot.length} hotspot cells`, detail: `Getis-Ord Gi* clusters (${lens.hotspots.reading}).`, cells: slice.hot.slice(0, MAX_CELLS), sources: lens.sources });
            const metrics = [{ label: 'Residents in the area', value: _people(slice.people) }];
            if (sum) metrics.push({ label: field.label, value: _num(total, field.unit) });
            else {
                metrics.push({ label: badLabel, value: `${_people(badPeople)} (${_pct(share)})` });
                metrics.push({ label: 'Area vs city mean', value: `${_num(slice.mean, field.unit)} vs ${_num(slice.cityMean, field.unit)}` });
            }
            for (const st of lens.stats.slice(0, 2)) metrics.push({ label: `${ctx.cityLabel}: ${st.label.charAt(0).toLowerCase()}${st.label.slice(1)}`, value: st.value });
            return {
                summary, metrics, findings,
                layers: layer ? [{ id: layer.spec.id, title: layer.spec.title, field: field.key, unit: field.unit, runtime: true }] : [],
                sources: res.sources.filter(x => lens.sources.includes(x.id)), method: lens.method, refs: lens.refs, layer,
            };
        };
    }

    async function _programme(ctx, store, step) {
        if (!ctx.city) throw new Error('This area is outside the cities the data covers.');
        const preset = ctx.params.preset;
        const r = await step('lens', () => UrbanLenses.lens('siting', ctx.city, store, { preset, sites: 24 }),
            (x) => `${(x.sites || []).length} candidate sites in ${x.cityLabel}`);
        const all = r.sites || [];
        const inside = all.filter(x => inArea(x.code, ctx.area));
        const picks = await step('pickSites', () => (inside.length ? inside : all).slice(0, MAX_CELLS - 1),
            (p) => (inside.length ? `${p.length} sites inside the area` : `none inside the area; showing the city's best ${p.length}`));
        const key = r.layer.spec.fields[0].key;
        const t = r.layer.table, col = t.columns[key];
        const rows = t.cells.map((c, i) => ({ code: c, value: col[i] })).filter(x => _fin(x.value) && inArea(x.code, ctx.area));
        const f = r.layer.spec.fields[0];
        const layer = _layerFrom(`${LAYER_PREFIX}${ctx.agent}`, `Agent: ${r.title}`, `${r.title} for ${ctx.area.label}`, t.level, rows,
            { key, label: f.label, unit: f.unit, ramp: f.ramp, higherIs: f.higherIs });
        await step('layer', () => layer, () => `${rows.length} cells`);
        const name = preset === 'ev_charging' ? 'EV charging hub' : 'cool-roof programme';
        const summary = picks.length
            ? _sentence(`${inside.length ? `The best ${name} site${picks.length === 1 ? '' : 's'} in ${ctx.area.label}` : `No top-ranked ${name} site falls inside ${ctx.area.label}; the city's best`} ${picks.length === 1 ? 'is' : 'are'} ${picks.map(x => DigiPin.format(x.code)).join(', ')}`)
            : 'No cell passes the siting constraints here.';
        const findings = picks.map(x => ({
            kind: 'notable', title: `Site ${x.rank}: ${DigiPin.format(x.code)} (score ${x.score})`,
            detail: `${_people(x.people)} residents in the cell; ranks on ${x.why}.`, cells: [x.code], sources: r.sources.map(s => s.id || s),
        }));
        return {
            summary,
            metrics: [
                { label: 'Candidate sites in the city', value: String(all.length) },
                { label: 'Inside the area', value: String(inside.length) },
                ...(r.weights || []).map(w => ({ label: `Weight: ${w.label}`, value: `${Math.round(100 * w.weight)}%` })),
                ...(r.consistency != null ? [{ label: 'AHP consistency ratio', value: String(r.consistency) }] : []),
            ],
            findings, layers: layer ? [{ id: layer.spec.id, title: layer.spec.title, field: key, unit: f.unit, runtime: true }] : [],
            sources: r.sources || [], method: r.method, refs: r.refs, layer,
        };
    }

    const RUNNERS = { air: _lensAgent('air'), green: _lensAgent('green'), solar: _lensAgent('solar'), risk: _lensAgent('burden'), programme: _programme, health: _health, brief: _brief, site: _site, flood: _flood, heat: _heat, access: _access, growth: _growth, changes: _changes };

    /**
     * Run an agent. hooks.onStep({ i, tool, label, status, detail, ms }) fires as
     * each planned step starts and ends. Never leaves a step "running": a
     * failure marks it failed and rethrows. Resolves to { report, layer }.
     */
    async function run(input, storeIn, hooks = {}) {
        const store = _store(storeIn);
        if (!store) throw new Error('The cell store is not available.');
        const p = plan(input);
        const t = template(p.agent);
        const now = hooks.now || (() => Date.now());
        const fetcher = hooks.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
        const where = t.scope === 'project'
            ? { area: { kind: 'project', label: 'All live feeds' }, city: null, cityLabel: '' }
            : resolve(input, store);
        const ctx = { agent: t.id, input, params: p.params, now, fetch: fetcher, ...where };
        const steps = p.steps.map((s, i) => ({ i, ...s, status: 'pending', detail: s.detail || '' }));
        const emit = (s) => { if (hooks.onStep) { try { hooks.onStep({ ...s }); } catch { /* UI errors are the UI's */ } } };

        async function step(tool, fn, describe) {
            const s = steps.find(x => x.tool === tool && x.status === 'pending');
            const t0 = now();
            if (s) { s.status = 'running'; emit(s); }
            try {
                const v = await fn();
                if (s) {
                    s.status = 'done';
                    s.ms = now() - t0;
                    try { s.result = describe ? describe(v) : ''; } catch { s.result = ''; }
                    emit(s);
                }
                return v;
            } catch (err) {
                if (s) { s.status = 'failed'; s.ms = now() - t0; s.result = err.message; emit(s); }
                throw err;
            }
        }

        let out;
        try {
            out = await RUNNERS[t.id](ctx, store, step);
        } catch (err) {
            // A check between steps failed: pin it on the next step so the run
            // log never shows a stalled plan.
            const next = steps.find(x => x.status === 'pending');
            if (next) { next.status = 'failed'; next.result = err.message; emit(next); }
            throw err;
        }
        // A step the runner had no work for (e.g. no layer) still closes.
        for (const s of steps) if (s.status === 'pending') { s.status = 'skipped'; emit(s); }
        const ranAt = new Date(hooks.now ? hooks.now() : Date.now()).toISOString();
        const report = {
            schema: SCHEMA,
            id: `${t.id}-${ranAt.replace(/[^0-9]/g, '').slice(0, 14)}`,
            agent: t.id, title: t.title, icon: t.icon, question: t.question, ranAt,
            input: { agent: t.id, area: input.area, params: p.params },
            area: { kind: ctx.area.kind, label: ctx.area.label }, city: ctx.city, cityLabel: ctx.cityLabel,
            summary: out.summary, metrics: out.metrics || [], findings: out.findings || [], layers: out.layers || [],
            sources: out.sources || [], method: out.method || '', refs: out.refs || '',
            steps: steps.map(s => ({ tool: s.tool, label: s.label, status: s.status, result: s.result || '', ms: s.ms || 0 })),
        };
        return { report, layer: out.layer || null };
    }

    /** Plain-text report (DISHA grounding, copy). Pure. */
    function toText(report) {
        const where = report.cityLabel && report.cityLabel !== report.area.label ? `${report.area.label}, ${report.cityLabel}` : report.area.label;
        const lines = [`${report.title} — ${where}`, report.summary];
        for (const m of report.metrics) lines.push(`- ${m.label}: ${m.value}`);
        for (const f of report.findings.slice(0, 8)) lines.push(`* ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
        if (report.sources.length) lines.push(`Sources: ${report.sources.map(s => s.title || s.id).join('; ')}`);
        return lines.join('\n');
    }

    return { SCHEMA, LAYER_PREFIX, TEMPLATES, SITE_USES, template, plan, run, resolve, inArea, prank, spread, gradeFeed, toText };
})();

if (typeof window !== 'undefined') {
    window.UrbanAgents = UrbanAgents;
}
