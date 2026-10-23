/**
 * Planning and regulation lenses for UrbanLenses: construction limits around protected monuments and land-use mix.
 * They read the heritage and landuse cell datasets (pipeline/realestate/heritage.py, landuse.py). Registers itself on load, after urban-lenses.js.
 */
const UrbanLensesPlanning = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _sumOver, within } = UrbanLenses._kit;

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

    // Land-use mix. Mapped land use (Overture, from OpenStreetMap) within MIX_KM of each lived-in block, in four
    // groups; the mix is Shannon evenness (0 one use, 100 an even spread). Homes next to industry: blocks with
    // INDUSTRY_NEXT% or more industrial land within INDUSTRY_KM.
    const MIX_KM = 1, INDUSTRY_KM = 0.5, INDUSTRY_NEXT = 20, MIX_GROUPS = ['residential', 'commercial', 'civic', 'industrial'];

    function landmix(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const L = Object.fromEntries(MIX_GROUPS.map(k => [k, c[`landuse.${k}_pct`]]));
        if (MIX_GROUPS.some(k => !L[k]) || !pop) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const near = Object.fromEntries(MIX_GROUPS.map(k => [k, within(g, Float64Array.from({ length: n }, (_, i) => v(L[k], i)), MIX_KM)]));
        const ind = within(g, Float64Array.from({ length: n }, (_, i) => v(L.industrial, i)), INDUSTRY_KM, true);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const mix = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            const tot = MIX_GROUPS.reduce((a, k) => a + near[k][i], 0);
            if (tot <= 0) continue;
            let h = 0;
            for (const k of MIX_GROUPS) { const p = near[k][i] / tot; if (p > 0) h -= p * Math.log(p); }
            mix[i] = 100 * h / Math.log(MIX_GROUPS.length);
        }
        const scored = idx.filter(i => _fin(mix[i]));
        if (scored.length < 5) return null;
        const next = idx.filter(i => ind[i] >= INDUSTRY_NEXT);
        const exposed = _sumOver(pop, next, () => true), all = _sumOver(pop, idx, () => true);
        const area = k => idx.reduce((a, i) => a + v(L[k], i), 0);
        const tot = MIX_GROUPS.reduce((a, k) => a + area(k), 0);
        const mapped = c['landuse.mapped_pct'];
        const cover = mapped ? idx.reduce((a, i) => a + v(mapped, i), 0) / idx.length : null;
        const meanMix = scored.reduce((a, i) => a + mix[i], 0) / scored.length;
        const stats = [
            { label: 'Mapped land in lived-in blocks: homes / commerce / civic / industry', value: MIX_GROUPS.map(k => `${_round(100 * area(k) / Math.max(tot, 1e-9))}%`).join(' / ') },
            { label: 'Average land-use mix within 1 km (0 one use, 100 even)', value: `${_round(meanMix)}` },
            { label: `People in homes with ${INDUSTRY_NEXT}%+ industrial land within ${INDUSTRY_KM} km`, value: `${_people(exposed)} (${_round(100 * exposed / Math.max(all, 1), 1)}%)`, raw: Math.round(exposed) },
        ];
        if (cover != null) stats.push({ label: 'Share of lived-in land with any land use mapped (coverage)', value: `${_round(cover)}%` });
        spaced(g, scored.filter(i => v(pop, i) > 0), mix).slice(0, 3).forEach((i, k) => stats.push({ label: `Most mixed ${k + 1}: ${g.codes[i]}`, value: `mix ${_round(mix[i])}` }));
        spaced(g, next, Float64Array.from({ length: n }, (_, i) => ind[i] * v(pop, i))).slice(0, 3).forEach((i, k) => stats.push({ label: `Homes beside industry ${k + 1}: ${g.codes[i]}`,
            value: `${_round(ind[i])}% industrial within ${INDUSTRY_KM} km; ${_people(v(pop, i))} residents` }));
        return {
            columns: { landuse_mix: mix, industry_near_pct: ind }, idx: scored, weightKey: 'landuse_mix', noHotspots: true,
            metric: { label: 'Average land-use mix within 1 km', value: _round(meanMix), unit: '0-100', higherIs: 'better' },
            headline: `Homes here sit in an average land-use mix of ${_round(meanMix)} out of 100 within 1 km, and ${_people(exposed)} people (${_round(100 * exposed / Math.max(all, 1), 1)}%) live with ${INDUSTRY_NEXT}%+ industrial land within ${INDUSTRY_KM} km.${cover != null && cover < 50 ? ` Only ${_round(cover)}% of lived-in land has a use mapped, so read the mix as a sketch.` : ''}`,
            stats,
        };
    }

    // Everyday and public services reach. A block lacks a service when no listed place of that kind is within its
    // distance: a short walk for daily needs, a short ride for post offices, police and fire stations.
    const REACH_KINDS = [
        { key: 'grocers', name: 'grocer', km: 0.5 }, { key: 'pharmacies', name: 'pharmacy', km: 1 }, { key: 'preschools', name: 'preschool', km: 1 },
        { key: 'post_offices', name: 'post office', km: 2 }, { key: 'police', name: 'police station', km: 2 }, { key: 'fire_stations', name: 'fire station', km: 3 },
    ];

    function reach(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        if (!pop || REACH_KINDS.some(k => !c[`places.${k.key}`])) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const missing = new Float64Array(n).fill(NaN), lack = {};
        for (const i of idx) missing[i] = 0;
        for (const k of REACH_KINDS) {
            const a = c[`places.${k.key}`];
            const near = within(g, Float64Array.from({ length: n }, (_, i) => v(a, i)), k.km);
            lack[k.key] = idx.filter(i => near[i] <= 0);
            for (const i of lack[k.key]) missing[i] += 1;
        }
        const all = _sumOver(pop, idx, () => true);
        const stats = REACH_KINDS.map(k => {
            const p = _sumOver(pop, lack[k.key], () => true);
            return { label: `No ${k.name} listed within ${k.km} km`, value: `${_people(p)} (${_round(100 * p / Math.max(all, 1), 1)}%)`, raw: Math.round(p) };
        });
        const three = idx.filter(i => missing[i] >= 3);
        const p3 = _sumOver(pop, three, () => true);
        stats.push({ label: 'People missing three or more of the six', value: `${_people(p3)} (${_round(100 * p3 / Math.max(all, 1), 1)}%)` });
        spaced(g, three, Float64Array.from({ length: n }, (_, i) => (missing[i] || 0) * 1e6 + v(pop, i))).slice(0, TOP).forEach((i, k) => stats.push({
            label: `Underserved ${k + 1}: ${g.codes[i]}`,
            value: `no ${REACH_KINDS.filter(kk => lack[kk.key].includes(i)).map(kk => kk.name).join(', ')}; ${_people(v(pop, i))} residents` }));
        const worst = REACH_KINDS.map((k, j) => [k, stats[j].raw]).sort((a, b) => b[1] - a[1])[0];
        return {
            columns: { services_lacking: missing }, idx, weightKey: 'services_lacking', noHotspots: true,
            metric: { label: 'People missing three or more everyday or public services nearby', value: Math.round(p3), unit: 'people', higherIs: 'worse' },
            headline: `${_people(p3)} people (${_round(100 * p3 / Math.max(all, 1), 1)}%) lack three or more of six nearby services; the most common gap is a ${worst[0].name} within ${worst[0].km} km (${_people(worst[1])} people). Overture lists fewer kirana shops, post offices and fire stations than actually exist, so read every gap as a possible listing gap until checked.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'reach', equity: true, title: 'Everyday and public services reach', icon: '📮',
            question: 'Who lives far from a grocer, pharmacy, preschool, post office, police or fire station?',
            field: { key: 'services_lacking', label: 'Services of six with none listed nearby', unit: 'count', higherIs: 'worse', ramp: 'reds', domain: [0, 6] },
            needs: ['places.grocers', 'places.pharmacies', 'places.preschools', 'places.post_offices', 'places.police', 'places.fire_stations', 'population.population'],
            method: `Overture Maps places in exact categories (grocery, Indian grocery, supermarket and convenience stores; pharmacies; preschools and day care; post offices; police stations; fire stations). A lived-in block lacks a service when no place of that kind lies within its distance: ${REACH_KINDS.map(k => `${k.name} ${k.km} km`).join(', ')}. Distances are straight-line between block centres and are planning thresholds for this lens, not statutory norms. Overture lists fewer post offices and fire stations than India Post and the fire services run, and few kirana shops, so gaps can be listing gaps.`,
            refs: 'Overture Maps Foundation places; URDPFI Guidelines 2015 (social infrastructure); WorldPop' },
        { id: 'landmix', equity: false, title: 'Land-use mix and homes beside industry', icon: '🧩',
            question: 'How mixed are neighbourhoods, and who lives next to industry?',
            field: { key: 'landuse_mix', label: 'Land-use mix within 1 km (Shannon evenness)', unit: '0-100', higherIs: 'better', ramp: 'viridis', domain: [0, 100] },
            extra: [{ key: 'industry_near_pct', label: `Industrial land within ${INDUSTRY_KM} km`, unit: '% of land', higherIs: 'worse', ramp: 'reds', domain: [0, 60] }],
            needs: ['landuse.residential_pct', 'landuse.commercial_pct', 'landuse.civic_pct', 'landuse.industrial_pct', 'landuse.mapped_pct', 'population.population'],
            method: `Overture Maps land use (from OpenStreetMap) grouped into homes, commerce (commercial and retail), civic (schools, hospitals, institutions, religious) and industry (industrial and works), summed within ${MIX_KM} km of each lived-in block. Mix = Shannon entropy of the four shares ÷ ln 4 × 100, a standard land-use mix measure in walkability research. Homes beside industry are lived-in blocks whose land within ${INDUSTRY_KM} km is ${INDUSTRY_NEXT}% or more industrial. Mapping is uneven, so the coverage figure shows how much land has a use drawn at all.`,
            refs: 'Frank et al. 2006 (land-use mix entropy, J. Am. Planning Assoc.); Overture Maps land use; WorldPop' },
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

    UrbanLenses.register(ENTRIES, { heritage, landmix, reach }, {}, 'jobsmap');
    return { ENTRIES };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesPlanning = UrbanLensesPlanning;
}
