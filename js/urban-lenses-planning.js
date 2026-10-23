/**
 * Planning and regulation lenses for UrbanLenses: construction limits around protected monuments. They read
 * the heritage cell dataset (pipeline/realestate/heritage.py). Registers itself on load, after urban-lenses.js.
 */
const UrbanLensesPlanning = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people } = UrbanLenses._kit;

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

    // Heritage limits. AMASR Act 1958 (amended 2010): no new construction within 100 m of a Monument of National
    // Importance, and only with National Monuments Authority permission under height limits from 100 to 300 m.
    const PROHIBITED_M = 100, REGULATED_M = 300;

    function heritage(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const pro = c['heritage.prohibited_pct'], reg = c['heritage.regulated_pct'], nat = c['heritage.national'];
        const pop = c['population.population'], built = c['built_up.built_pct'];
        if (!pro || !reg) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(pro[i]) || _fin(reg[i])) idx.push(i);
        const zoned = idx.filter(i => v(pro, i) + v(reg, i) > 0);
        if (!zoned.length) return null;
        const limit = new Float64Array(n).fill(NaN);
        for (const i of zoned) limit[i] = v(pro, i) + v(reg, i);
        const sum = f => zoned.reduce((a, i) => a + f(i), 0);
        const proKm2 = sum(i => v(pro, i) / 100 * g.cellKm2), regKm2 = sum(i => v(reg, i) / 100 * g.cellKm2);
        const people = sum(i => v(pop, i) * (v(pro, i) + v(reg, i)) / 100);
        const builtKm2 = built ? sum(i => v(built, i) / 100 * (v(pro, i) + v(reg, i)) / 100 * g.cellKm2) : null;
        const monuments = nat ? idx.reduce((a, i) => a + v(nat, i), 0) : null;
        const stats = [
            { label: 'Monuments of National Importance mapped', value: monuments != null ? `${Math.round(monuments)}` : 'n/a' },
            { label: `Prohibited area (within ${PROHIBITED_M} m): no new construction`, value: `${_round(proKm2, 2)} km²` },
            { label: `Regulated area (${PROHIBITED_M}–${REGULATED_M} m): NMA permission and height limits`, value: `${_round(regKm2, 2)} km²` },
            { label: 'Residents inside either zone', value: _people(people), raw: Math.round(people) },
        ];
        if (builtKm2 != null) stats.push({ label: 'Built-up land inside either zone (repairs and rebuilding need permission)', value: `${_round(builtKm2, 2)} km²` });
        const pressure = Float64Array.from({ length: n }, (_, i) => (v(pro, i) + v(reg, i)) * (built ? v(built, i) : 1));
        spaced(g, zoned, pressure).slice(0, TOP).forEach((i, k) => stats.push({ label: `Most built-up limit zone ${k + 1}: ${g.codes[i]}`,
            value: `${Math.round(v(pro, i))}% prohibited, ${Math.round(v(reg, i))}% regulated${built ? `; ${Math.round(v(built, i))}% built-up` : ''}` }));
        return {
            columns: { heritage_limit_pct: limit, prohibited_pct: pro, regulated_pct: reg }, idx: zoned, weightKey: 'heritage_limit_pct', noHotspots: true,
            metric: { label: 'Land under monument construction limits', value: _round(proKm2 + regKm2, 1), unit: 'km²', higherIs: null },
            headline: `${_round(proKm2 + regKm2, 1)} km² lies within ${REGULATED_M} m of a protected national monument, where building is banned (${_round(proKm2, 1)} km²) or needs National Monuments Authority permission; about ${_people(people)} people live there. Zones are drawn from one point per monument, so check the notified boundary before buying.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'heritage', equity: false, title: 'Monument construction limits', icon: '🏛️',
            question: 'Where do protected monuments limit building?',
            field: { key: 'heritage_limit_pct', label: `Block area within ${REGULATED_M} m of a national monument`, unit: '% of block', higherIs: null, ramp: 'heat', domain: [0, 100] },
            extra: [{ key: 'prohibited_pct', label: `Within ${PROHIBITED_M} m (no new construction)`, unit: '% of block', higherIs: null, ramp: 'reds', domain: [0, 100] },
                { key: 'regulated_pct', label: `${PROHIBITED_M}–${REGULATED_M} m (NMA permission, height limits)`, unit: '% of block', higherIs: null, ramp: 'heat', domain: [0, 100] }],
            needs: ['heritage.prohibited_pct', 'heritage.regulated_pct', 'heritage.national', 'heritage.state', 'heritage.local', 'heritage.monument_m',
                'population.population', 'built_up.built_pct'],
            method: `Monuments of National Importance from Wikidata (heritage designation P1435, with coordinates). The Ancient Monuments and Archaeological Sites and Remains Act 1958, amended 2010, bans new construction within ${PROHIBITED_M} m of a monument's protected limits and requires National Monuments Authority permission, under height limits set in each monument's heritage bye-laws, from ${PROHIBITED_M} to ${REGULATED_M} m. Each block is sampled on an 8 × 8 grid to find the share in each zone. Wikidata holds one point per monument, not the notified boundary, so zones around forts, tombs with gardens and large complexes are too small. State Protected Monuments have their own state rules and are counted but not zoned.`,
            refs: 'AMASR Act 1958 and Amendment and Validation Act 2010; National Monuments Authority; Wikidata (CC0)' },
    ];

    UrbanLenses.register(ENTRIES, { heritage }, {}, 'jobsmap');
    return { ENTRIES };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesPlanning = UrbanLensesPlanning;
}
