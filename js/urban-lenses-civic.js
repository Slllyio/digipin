/**
 * Civic plan lenses for UrbanLenses: what statutory plans and municipal networks say about a block (planned road
 * widths and new links). They read datasets baked from city and development-authority maps. Registers itself on load,
 * after urban-lenses.js.
 */
const UrbanLensesCivic = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _sumOver } = UrbanLenses._kit;

    const SPACING_KM = 1.5, TOP = 5;

    /** Greedy picks from `cells` by descending `score`, at least SPACING_KM apart. */
    function spaced(g, cells, score, k = TOP) {
        const picks = [];
        for (const i of cells.slice().sort((a, b) => score[b] - score[a])) {
            if (picks.length >= k) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < SPACING_KM)) continue;
            picks.push(i);
        }
        return picks;
    }

    // Planned road widths. Bengaluru's Revised Master Plan 2015 fixes a right of way for every major road and proposes
    // new links. Plots on roads to be widened give up a front strip (compensated in transferable development rights),
    // and road width decides how densely and for what a plot may be built, so the plan reshapes value along these roads.
    const WIDE_M = 24;

    function roadplan(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const pk = c['road_plan.plan_km'], wk = c['road_plan.wide_km'], lk = c['road_plan.link_km'], mw = c['road_plan.max_width_m'];
        if (!pop || !pk || !mw || !pk.some(v => v > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pk, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const lived = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) lived.push(i);
        const all = _sumOver(pop, lived, () => true);
        const pWide = _sumOver(pop, lived, i => v(mw, i) >= WIDE_M), pLink = _sumOver(pop, lived, i => v(lk, i) > 0);
        const sum = a => idx.reduce((t, i) => t + v(a, i), 0);
        const stats = [
            { label: 'Roads with a planned width (RMP 2015)', value: `${_people(sum(pk))} km` },
            { label: `…planned ${WIDE_M} m wide or more`, value: `${_people(sum(wk))} km` },
            { label: '…proposed new link roads', value: `${_people(sum(lk))} km` },
            { label: `Residents in blocks on a road planned ${WIDE_M} m or wider`, value: `${_people(pWide)} (${_round(100 * pWide / (all || 1))}%)` },
            { label: 'Residents in blocks a proposed new link crosses', value: `${_people(pLink)} (${_round(100 * pLink / (all || 1))}%)` },
        ];
        const score = Float64Array.from({ length: n }, (_, i) => v(lk, i) * v(pop, i));
        spaced(g, idx.filter(i => v(lk, i) > 0 && v(pop, i) > 0), score).forEach((i, k) => stats.push({
            label: `New link through homes ${k + 1}: ${g.codes[i]}`,
            value: `${_round(v(lk, i) * 1000)} m of proposed link road; widest planned road here ${_round(v(mw, i))} m; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = v(mw, i);
        return {
            columns: { planned_width_m: out }, idx, weightKey: 'planned_width_m', noHotspots: true,
            metric: { label: `Residents on roads planned ${WIDE_M} m or wider`, value: _round(100 * pWide / (all || 1), 1), unit: '%', higherIs: 'better' },
            headline: `Bengaluru's Revised Master Plan 2015 sets widths for ${_people(sum(pk))} km of roads, ${_people(sum(wk))} km of them ${WIDE_M} m or wider, and proposes ${_people(sum(lk))} km of new links. ${_people(pWide)} residents (${_round(100 * pWide / (all || 1))}%) live in blocks on a road planned ${WIDE_M} m or wider, where frontages face widening and denser building is allowed; many widenings are years behind the plan.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'roadplan', equity: false, title: 'Planned road widening', icon: '🛣️',
            question: 'Which roads does the master plan widen or add, and whose homes are on them?',
            field: { key: 'planned_width_m', label: 'Widest planned road in the block (RMP 2015)', unit: 'm', higherIs: 'better', ramp: 'viridis', domain: [0, 45] },
            needs: ['road_plan.plan_km', 'road_plan.wide_km', 'road_plan.link_km', 'road_plan.max_width_m', 'population.population'],
            method: `BDA's Revised Master Plan 2015 road width map on data.opencity.in (public domain): 23,238 road segments with a planned right of way (12 to 67 m, a few 100 m corridors) and a type, widening or new connection. Each line is cut into pieces of at most 25 m summed per block, with the widest planned road per block. Residents are WorldPop counts in blocks on a road planned ${WIDE_M} m or wider, or crossed by a proposed link; picks are populated blocks 1.5 km apart with the most proposed link length times residents, where new roads would need land. The plan's widths are targets: many are not yet acquired or built, and the 2041 plan may change them. Bengaluru only.`,
            refs: 'BDA Revised Master Plan 2015 (Zoning of Land Use and Regulations); Karnataka TDR rules; OpenCity Bengaluru road width map' },
    ];

    UrbanLenses.register(ENTRIES, { roadplan });
    return { ENTRIES };
})();
