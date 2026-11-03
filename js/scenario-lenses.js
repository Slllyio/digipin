/**
 * ScenarioLenses — what-ifs and plans read through the urban lenses.
 *
 * A what-if (js/urban-insights.js) changes a few cells; this module applies the
 * same change to the lenses' L7 frame (js/urban-lenses.js), re-runs the lenses
 * the change can move, and reports before → after in people and in the lenses'
 * own units, with the population-weighted Gini for the equity lenses:
 *
 *   cool     tree canopy + added points, daytime LST − the scenario's cooling  → heat
 *   park     tree canopy + boost/2 and a leisure place in the park cell        → heat, 15-minute
 *   density  residents × factor in the cell                                    → healthcare, heat, 15-minute
 *   flood    no lens change: who is in the flooded cells (heat-vulnerable,
 *            far from care, in the floodplain)                                → cross-lens exposure
 *   closure  no lens change (the lenses use straight-line reach): who lives
 *            around the closure and how well served they are today            → cross-lens exposure
 *
 * A plan applies every scenario's change to one frame, so stacked scenarios
 * meet in the lens maths (two parks next to each other count once each).
 * Pure apart from reading the store.
 */
const ScenarioLenses = (() => {
    const SCHEMA = 'digipin.scenario-lenses/1';
    const LEVEL = 7;
    const _fin = (x) => typeof x === 'number' && Number.isFinite(x);
    const _r = (x, d = 1) => (_fin(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

    /** Which lenses each scenario type can move (recomputed) or only read. */
    const MOVES = { cool: ['heat'], park: ['heat', 'fifteen'], density: ['health', 'heat', 'fifteen'], flood: [], closure: [] };
    const READS = { flood: ['heat', 'health', 'flood'], closure: ['health', 'fifteen'] };

    function _people(n) {
        if (!_fin(n)) return '–';
        if (n >= 1e7) return `${_r(n / 1e7, 1)} crore`;
        if (n >= 1e5) return `${_r(n / 1e5, 1)} lakh`;
        return Math.round(n).toLocaleString('en-IN');
    }

    /** Frame cells (indices) under any of the codes (codes of any level ≥ 1). */
    function _under(fr, codes) {
        const pre = new Set((codes || []).map(c => String(c).replace(/-/g, '')).filter(Boolean));
        const lens = [...new Set([...pre].map(p => Math.min(p.length, LEVEL)))];
        const out = [];
        for (let i = 0; i < fr.grid.n; i++) {
            const c = fr.grid.codes[i];
            if (lens.some(n => pre.has(c.slice(0, n)))) out.push(i);
        }
        return out;
    }

    /** A copy-on-write view of a frame: `col(key)` clones a column the first time it is written. */
    function _fork(fr) {
        const cols = { ...fr.cols };
        const owned = new Set();
        return {
            fr: { ...fr, cols },
            col(key) {
                if (!cols[key]) return null;
                if (!owned.has(key)) { cols[key] = Float64Array.from(cols[key]); owned.add(key); }
                return cols[key];
            },
        };
    }

    /** Apply one what-if result to a forked frame. Returns the cells it touched. */
    function apply(fork, r) {
        const fr = fork.fr;
        const sc = r.scenario || {};
        if (r.type === 'cool') {
            const lst = fork.col('surface_heat.lst_day_c'), can = fork.col('vegetation.tree_canopy_pct');
            const touched = [];
            for (const c of r.cells || []) {
                for (const i of _under(fr, [c.code])) {
                    if (lst && _fin(lst[i]) && _fin(c.delta)) lst[i] -= c.delta;
                    if (can && _fin(can[i]) && _fin(c.add)) can[i] = Math.min(100, can[i] + c.add);
                    touched.push(i);
                }
            }
            return touched;
        }
        if (r.type === 'park') {
            const site = (r.cells || []).find(c => c.target) || (r.cells || [])[0];
            if (!site) return [];
            const idx = _under(fr, [site.code]);
            const can = fork.col('vegetation.tree_canopy_pct'), leis = fork.col('osm_amenities.leisure');
            const boost = Math.max(5, Math.min(80, Number(sc.boost) || 40));
            for (const i of idx) if (can && _fin(can[i])) can[i] = Math.min(100, can[i] + boost / 2);
            if (leis && idx.length) {
                // The park is one leisure place, in the most populated child cell.
                const pop = fr.cols['population.population'];
                const k = idx.slice().sort((a, b) => (pop[b] || 0) - (pop[a] || 0))[0];
                leis[k] = (_fin(leis[k]) ? leis[k] : 0) + 1;
            }
            return idx;
        }
        if (r.type === 'density') {
            const code = (r.cells && r.cells[0] && r.cells[0].code) || sc.code;
            const idx = _under(fr, [code]);
            const f = Math.max(1.05, Math.min(5, Number(sc.factor) || 1.5));
            const pop = fork.col('population.population'), den = fork.col('population.density_km2');
            for (const i of idx) {
                if (pop && _fin(pop[i])) pop[i] *= f;
                if (den && _fin(den[i])) den[i] *= f;
            }
            return idx;
        }
        // flood / closure: nothing in the lens inputs changes.
        return _under(fr, [...(r.cells || []), ...(r.closed || [])].map(c => c.code));
    }

    function _resIdx(fr, v) {
        const pop = fr.cols['population.population'];
        const idx = [];
        for (let i = 0; i < fr.grid.n; i++) if (pop[i] >= 1 && (!v || _fin(v[i]))) idx.push(i);
        return idx;
    }

    function _lensRow(id, before, after, frB, frA, site) {
        const L = UrbanLenses.LENSES.find(l => l.id === id);
        const key = L.field.key;
        const vb = before.columns[key], va = after.columns[key];
        const popB = frB.cols['population.population'], popA = frA.cols['population.population'];
        const idxB = _resIdx(frB, vb), idxA = _resIdx(frA, va);
        const sB = site.filter(i => popB[i] >= 1 && _fin(vb[i])), sA = site.filter(i => popA[i] >= 1 && _fin(va[i]));
        const rows = [];
        const statB = (before.stats || []).find(s => s.raw != null), statA = statB && (after.stats || []).find(s => s.label === statB.label);
        if (statB && statA) rows.push({ label: statB.label, before: statB.raw, after: statA.raw, text: [_people(statB.raw), _people(statA.raw)], better: L.field.higherIs === 'worse' ? statA.raw < statB.raw : statA.raw > statB.raw });
        if (sB.length) {
            const mb = UrbanLenses.wmean(vb, popB, sB), ma = UrbanLenses.wmean(va, popA, sA);
            rows.push({ label: `${L.field.label} for the site’s residents`, before: _r(mb, 2), after: _r(ma, 2), unit: L.field.unit,
                better: L.field.higherIs === 'worse' ? ma < mb : L.field.higherIs === 'better' ? ma > mb : null });
        }
        const gini = L.equity ? { before: _r(UrbanLenses.gini(vb, popB, idxB), 3), after: _r(UrbanLenses.gini(va, popA, idxA), 3) } : null;
        return { id, title: L.title, icon: L.icon, field: L.field, rows, gini, method: L.method };
    }

    /** Who is in the touched cells, read through lenses that the scenario does not move. */
    function _exposure(id, res, fr, site) {
        const L = UrbanLenses.LENSES.find(l => l.id === id);
        const v = res.columns[L.field.key];
        const pop = fr.cols['population.population'];
        const people = site.filter(i => pop[i] >= 1);
        const total = people.reduce((a, i) => a + pop[i], 0);
        const rows = [];
        if (id === 'heat') {
            const top = people.filter(i => v[i] >= 90).reduce((a, i) => a + pop[i], 0);
            rows.push({ label: `In the city’s most heat-vulnerable tenth (of ${_people(total)})`, value: _people(top), raw: Math.round(top), flag: top > 0 });
        } else if (id === 'health') {
            const none = people.filter(i => v[i] === 0).reduce((a, i) => a + pop[i], 0);
            rows.push({ label: 'With no mapped healthcare within 2 km', value: _people(none), raw: Math.round(none), flag: none > 0 });
            rows.push({ label: 'Healthcare places per 10k in their reach', value: String(_r(UrbanLenses.wmean(v, pop, people), 2)) });
        } else if (id === 'flood') {
            const fp = people.reduce((a, i) => a + (v[i] || 0), 0);
            rows.push({ label: 'Already in the mapped 100-year floodplain', value: _people(fp), raw: Math.round(fp) });
        } else if (id === 'fifteen') {
            rows.push({ label: 'Their 15-minute completeness', value: `${_r(UrbanLenses.wmean(v, pop, people))} / 100` });
        }
        return { id, title: L.title, icon: L.icon, field: L.field, rows, gini: null, method: L.method, read: true };
    }

    /**
     * Lens impact of one what-if result or several (a plan). Results must be
     * in one city. Returns { schema, city, cityLabel, lenses: [...], summary, sources }.
     */
    async function impact(results, store, opts = {}) {
        const list = (Array.isArray(results) ? results : [results]).filter(r => r && r.kind === 'whatif');
        if (!list.length) throw new Error('No scenario to read through the lenses.');
        const city = list[0].city;
        if (!city) throw new Error('The scenario is outside a covered city.');
        const moves = [...new Set(list.flatMap(r => MOVES[r.type] || []))];
        const reads = [...new Set(list.flatMap(r => READS[r.type] || []))].filter(id => !moves.includes(id));
        const ids = [...moves, ...reads];
        const order = UrbanLenses.LENSES.filter(l => ids.includes(l.id)).map(l => l.id);
        const frB = opts.frame || await UrbanLenses.frame(city, store, UrbanLenses.allNeeds(order));
        const fork = _fork(frB);
        const site = new Set();
        for (const r of list) for (const i of apply(fork, r)) site.add(i);
        const siteIdx = [...site];
        const run = UrbanLenses._lenses;
        const lenses = [];
        for (const id of order) {
            const b = run[id](frB, {});
            if (!b) continue;
            if (moves.includes(id)) {
                const a = run[id](fork.fr, {});
                if (a) lenses.push(_lensRow(id, b, a, frB, fork.fr, siteIdx));
            } else lenses.push(_exposure(id, b, frB, siteIdx));
        }
        const parts = [];
        for (const l of lenses) {
            const r0 = l.rows[0];
            if (!l.read && r0 && _fin(r0.before) && _fin(r0.after) && Math.round(r0.after - r0.before) !== 0) {
                const d = r0.after - r0.before;
                parts.push(`${d > 0 ? '+' : '−'}${_people(Math.abs(d))} ${r0.label.toLowerCase()} (${l.title.toLowerCase()})`);
            }
            const site = !l.read && l.rows.find(x => /site’s residents/.test(x.label));
            if (site && _fin(site.before) && _fin(site.after) && Math.abs(site.after - site.before) >= 0.5) {
                parts.push(`${site.label.toLowerCase()} ${_r(site.before)} → ${_r(site.after)}`);
            }
                        if (l.gini && l.gini.before != null && l.gini.after != null && l.gini.before !== l.gini.after) {
                parts.push(`${l.title.toLowerCase()} inequality (Gini) ${l.gini.before} → ${l.gini.after}`);
            }
        }
        const pop = frB.cols['population.population'];
        const residents = Math.round(siteIdx.reduce((a, i) => a + (pop[i] >= 1 ? pop[i] : 0), 0));
        const sources = frB.sources.filter(s => ['population', 'surface_heat', 'vegetation', 'osm_amenities', 'water', 'terrain', 'built_up', 'accessibility'].includes(s.id));
        return {
            schema: SCHEMA, kind: 'lens-impact', city, cityLabel: UrbanInsights.cityLabel(city), scenarios: list.map(r => r.title),
            site: siteIdx.length, residents, lenses,
            summary: !moves.length && lenses.length
                ? `Of the ${_people(residents)} residents in the affected cells, ${lenses.flatMap(l => l.rows.filter(x => x.raw != null).map(x => `${_people(x.raw)} ${x.label.replace(/ \(of .*\)$/, '').toLowerCase().replace(/^in /, 'are in ').replace(/^with /, 'have ').replace(/^already /, 'are already ')}`)).join(', ')}.`
                : lenses.length
                ? (parts.length ? `Through the lenses: ${parts.join('; ')}.` : 'Through the lenses: no city-level change at this size; the site rows show the local effect.')
                : 'No lens covers this scenario here.',
            residentsText: `${_people(residents)} residents live in the ${siteIdx.length} affected ~244 m cells.`,
            method: 'The scenario’s change is applied to the lenses’ ~244 m frame and the affected lenses are re-run on the whole city; flood and road scenarios read who lives in the affected cells. Lenses use straight-line reach, so road closures do not change them.',
            sources,
        };
    }

    function toText(r) {
        if (!r) return '';
        return [r.summary, r.residentsText, ...r.lenses.flatMap(l => l.rows.map(x => `• ${l.title}: ${x.label} ${x.value != null ? x.value : `${x.before} → ${x.after}`}`))].join('\n');
    }

    return { SCHEMA, MOVES, READS, apply, impact, toText };
})();

if (typeof window !== 'undefined') {
    window.ScenarioLenses = ScenarioLenses;
}
