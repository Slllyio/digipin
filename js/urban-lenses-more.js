/**
 * More lenses for UrbanLenses, added after urban-lenses-extra.js neared the 150 kB per-module budget (first: relative
 * deprivation from NASA SEDAC GRDI). Registers itself on load, after urban-lenses.js.
 */
const UrbanLensesMore = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _residents, wmean } = UrbanLenses._kit;

    // Relative deprivation. GRDI v1 indexes each ~1 km pixel 0-100 from built-up density, night lights and their trend,
    // child dependency, infant mortality and subnational HDI; an openly licensed alternative to proprietary wealth maps.
    function deprivation(fr) {
        const c = fr.cols, n = fr.grid.n, g = c['deprivation.grdi'], pop = c['population.population'];
        if (!g || !g.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(g[i]));
        if (idx.length < 5) return null;
        const w = i => (pop && _fin(pop[i]) ? pop[i] : 0);
        let all = 0, hi = 0, lo = 0;
        for (const i of idx) { all += w(i); if (g[i] >= 50) hi += w(i); if (g[i] < 20) lo += w(i); }
        if (!all) return null;
        const mean = wmean(g, pop, idx);
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = g[i];
        const pc = x => `${_round(100 * x / all, 0)}%`;
        const stats = [
            { label: 'Residents in blocks scoring 50 or more (more deprived)', value: `${_people(hi)} (${pc(hi)})` },
            { label: 'Residents in blocks scoring under 20 (least deprived)', value: `${_people(lo)} (${pc(lo)})` },
            { label: 'Typical score, resident-weighted', value: `${_round(mean, 0)} of 100` },
        ];
        return {
            columns: { grdi: out }, idx, weightKey: 'grdi',
            metric: { label: 'Residents in more deprived blocks (GRDI 50+)', value: _round(100 * hi / all, 0), unit: '%', higherIs: 'worse' },
            headline: `${_people(hi)} residents (${pc(hi)}) live in blocks that NASA's relative deprivation index scores 50 or more out of 100, and ${pc(lo)} in blocks under 20; the typical resident's block scores ${_round(mean, 0)}. Red blocks are more deprived. Inside a city the score moves mostly with how built-up and how brightly lit a place is (its health and income parts are state or district averages), so it marks thin, dim, fast-growing edges more than poor dense cores; use it with the slum and services lenses.`,
            stats,
        };
    }

    // Built up but not a town in 2011. Census towns and outgrowths are urban by the census but run by rural bodies; villages
    // that have since filled with buildings are the city's newest, least-serviced edge.
    function ruralrun(fr) {
        const c = fr.cols, n = fr.grid.n, town = c['settlement_2011.s11_town'], pop = c['population.population'];
        if (!town || !town.some(_fin)) return null;
        const ct = c['settlement_2011.s11_census_town'], og = c['settlement_2011.s11_outgrowth'], vil = c['settlement_2011.s11_village'], cov = c['building_stock.cover_2023_pct'];
        const idx = _residents(fr).filter(i => _fin(town[i]));
        if (idx.length < 5) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0), w = i => v(pop, i);
        let all = 0, ctP = 0, ogP = 0, vilP = 0, vilBuilt = 0;
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            const x = w(i); all += x;
            const notTown = v(town, i) < 0.5;
            if (v(ct, i) >= 0.5) ctP += x;
            if (v(og, i) >= 0.5) ogP += x;
            if (v(vil, i) >= 0.5) { vilP += x; if (v(cov, i) >= 25) vilBuilt += x; }
            out[i] = notTown ? 1 : 0;
        }
        if (!all) return null;
        const pc = x => `${_round(100 * x / all, 0)}%`, rural = ctP + ogP + vilP;
        const stats = [
            { label: 'Residents today in blocks that were a statutory town (municipal) in 2011', value: `${_people(all - rural)} (${pc(all - rural)})` },
            { label: '…in census towns (urban, run by a panchayat)', value: `${_people(ctP)} (${pc(ctP)})` },
            { label: '…in outgrowths of a town', value: `${_people(ogP)} (${pc(ogP)})` },
            { label: '…in villages', value: `${_people(vilP)} (${pc(vilP)})` },
            { label: '…in villages now a quarter or more built over', value: `${_people(vilBuilt)} (${pc(vilBuilt)})` },
        ];
        return {
            columns: { not_town_2011: out }, idx, weightKey: 'not_town_2011', noHotspots: true,
            metric: { label: 'Residents in blocks outside a municipal town in 2011', value: _round(100 * rural / all, 0), unit: '%', higherIs: null },
            headline: `${_people(rural)} of today's residents (${pc(rural)}) live in blocks that in the 2011 Census were outside any municipal town: ${pc(ctP)} in census towns, ${pc(ogP)} in outgrowths and ${pc(vilP)} in villages, ${pc(vilBuilt)} in villages that are now a quarter or more built over. These places grew under panchayat rules, which is where piped water, sewers and building control lag. Coloured blocks were outside a town in 2011; many have been absorbed since, so check today's ward map.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'deprivation', title: 'Relative deprivation (open index)', icon: '📉',
            question: 'Which parts of my city are most deprived on an open index?',
            field: { key: 'grdi', label: 'Relative deprivation (GRDI v1)', unit: '0-100', higherIs: 'worse', ramp: 'reds', domain: [0, 100] },
            needs: ['deprivation.grdi', 'population.population'],
            method: `NASA SEDAC's Global Gridded Relative Deprivation Index v1 (CIESIN, 2022; inputs 2010-2020) combines six components on a ~1 km grid: built-up area ratio, VIIRS night lights in 2020, the 2012-2020 night-light trend, child dependency ratio, infant mortality rate and the subnational Human Development Index, each indexed and weighted to a 0 (least) to 100 (most deprived) score. Each lived-in L7 block takes the pixel at its centre; residents are GHSL/WorldPop. Compared with Meta's Relative Wealth Index at L6 in ten cities, Spearman runs from -0.04 (Hyderabad) to -0.52 (Delhi): the two agree on direction but differ a lot block by block.`,
            refs: 'CIESIN 2022, Global Gridded Relative Deprivation Index (GRDI) v1, NASA SEDAC, doi:10.7927/3xxe-ap97 (CC BY 4.0)' },
        { id: 'ruralrun', title: 'Built up but not a town in 2011', icon: '🏘️',
            question: 'Which parts of my city were still villages or census towns in 2011?',
            field: { key: 'not_town_2011', label: 'Outside a municipal town in 2011', unit: 'yes/no', higherIs: null, ramp: 'viridis', domain: [0, 1] },
            needs: ['settlement_2011.s11_town', 'settlement_2011.s11_census_town', 'settlement_2011.s11_outgrowth', 'settlement_2011.s11_village', 'building_stock.cover_2023_pct', 'population.population'],
            method: `SEDAC's Spatial Data from the 2011 India Census (Balk et al., CIESIN) gives the majority 2011 settlement class of each ~1 km cell: statutory town (municipal body), census town (urban by census rules but governed by a panchayat), outgrowth (dense area next to a town, outside it) or village. Each lived-in L7 block takes the class at its centre; residents are today's GHSL/WorldPop counts, and built-over villages are those with 25% or more building cover in 2023 (Open Buildings). Municipal limits have grown since 2011, so read it as where the city outran its government.`,
            refs: 'Balk D. et al. 2019, Urbanization in India: population and urban classification grids for 2011, Data 4(1):35; NASA SEDAC (CC BY 4.0)' },
    ];

    UrbanLenses.register(ENTRIES, { deprivation, ruralrun });
    return { ENTRIES };
})();
