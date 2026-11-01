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

    // Did the 2015 forecast come true? Seto et al. gave every non-urban 5 km cell a chance of turning urban by 2030 from
    // 2000 data; GHSL shows what was actually built 2000-2020, so the lens is a hindcast of where growth surprised.
    function forecastcheck(fr) {
        const c = fr.cols, n = fr.grid.n, u0 = c['urban_expansion.urban_2000'], pr = c['urban_expansion.p2030'];
        if (!u0 || !u0.some(_fin)) return null;
        const chg = c['built_up.built_change_pct'], pop = c['population.population'];
        const idx = _residents(fr).filter(i => _fin(u0[i]));
        if (idx.length < 5) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0), w = i => v(pop, i);
        let all = 0, urb = 0, likP = 0, unlP = 0, missP = 0, likB = 0, likN = 0, unlB = 0, unlN = 0;
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            const x = w(i); all += x;
            if (v(u0, i) >= 0.5) { urb += x; continue; }
            if (!_fin(pr[i])) continue;
            const likely = pr[i] >= 50, grew = chg && _fin(chg[i]) ? chg[i] : null;
            if (likely) { likP += x; if (grew !== null) { likB += grew; likN++; } } else { unlP += x; if (grew !== null) { unlB += grew; unlN++; } }
            const missed = !likely && grew !== null && grew >= 20;
            if (missed) missP += x;
            out[i] = missed ? 1 : 0;
        }
        if (!all) return null;
        const pc = x => `${_round(100 * x / all, 0)}%`;
        const lm = likN ? likB / likN : null, um = unlN ? unlB / unlN : null;
        const stats = [
            { label: 'Residents today in blocks already urban around 2000 (MODIS)', value: `${_people(urb)} (${pc(urb)})` },
            { label: 'Residents in blocks the 2015 forecast gave 50%+ odds of turning urban by 2030', value: `${_people(likP)} (${pc(likP)})` },
            { label: 'Residents in blocks it gave under 50%', value: `${_people(unlP)} (${pc(unlP)})` },
            { label: 'New built surface 2000→2020 where growth was forecast likely (block mean)', value: lm === null ? 'n/a' : `${_round(lm, 1)} pp` },
            { label: '…where it was forecast unlikely', value: um === null ? 'n/a' : `${_round(um, 1)} pp` },
            { label: 'Residents in blocks the forecast missed (under 50% odds, yet 20 pp or more newly built)', value: `${_people(missP)} (${pc(missP)})` },
        ];
        const verdict = lm === null || um === null ? 'There is too little non-urban land in 2000 to test the forecast here.'
            : lm > um + 1 ? `Growth mostly went where it was expected: blocks given good odds added ${_round(lm, 1)} pp of built surface on average against ${_round(um, 1)} pp elsewhere.`
                : um > lm + 1 ? `Growth mostly surprised the forecast: blocks given poor odds added ${_round(um, 1)} pp of built surface on average, more than the ${_round(lm, 1)} pp where growth was expected.`
                    : `The forecast barely separated fast and slow growth: ${_round(lm, 1)} pp where expected against ${_round(um, 1)} pp elsewhere.`;
        return {
            columns: { missed_growth: out }, idx, weightKey: 'missed_growth', noHotspots: true,
            metric: { label: 'Residents in blocks where growth beat the forecast', value: _round(100 * missP / all, 1), unit: '%', higherIs: null },
            headline: `${pc(urb)} of today's residents live in blocks that were already urban around 2000. Of the rest, the 2015 forecast gave ${pc(likP)} good odds of turning urban by 2030 and ${pc(unlP)} poor odds. ${verdict} ${_people(missP)} residents (${pc(missP)}) now live where the forecast saw little chance yet a fifth or more of the land was built over by 2020. The forecast cells are about 5 km wide, so read it district by district, not street by street.`,
            stats,
        };
    }

    // The UN SDG 11 scorecard for public space (11.7.1) and public transport (11.2.1), computed by NASA SEDAC for every
    // GHSL urban centre on OpenStreetMap, so cities can be set against each other on one yardstick.
    function sdgcard(fr) {
        const c = fr.cols, n = fr.grid.n, g = c['sdg_city.sdg_space_pct'];
        if (!g || !g.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(g[i]));
        if (idx.length < 5) return null;
        const i0 = idx[0], v = k => { const a = c[`sdg_city.${k}`]; return a && _fin(a[i0]) ? a[i0] : NaN; };
        const sp = v('sdg_space_pct'), sa = v('sdg_space_access_pct'), tr = v('sdg_transit_pct');
        const pc = x => (_fin(x) ? `${_round(x, 1)}%` : 'n/a'), rk = k => (_fin(v(k)) ? `${_round(v(k), 0)}%` : 'n/a');
        const stats = [
            { label: 'Open public space, share of the urban area (SDG 11.7.1)', value: pc(sp) },
            { label: '…Indian / world cities of 1 million+ with less', value: `${rk('sdg_space_india_pctile')} / ${rk('sdg_space_world_pctile')}` },
            { label: 'Residents within 400 m of open public space (SDG 11.7.1)', value: pc(sa) },
            { label: '…Indian / world cities of 1 million+ scoring lower', value: `${rk('sdg_space_access_india_pctile')} / ${rk('sdg_space_access_world_pctile')}` },
            { label: 'Residents with convenient public transport (SDG 11.2.1)', value: pc(tr) },
            { label: '…Indian / world cities of 1 million+ scoring lower', value: `${rk('sdg_transit_india_pctile')} / ${rk('sdg_transit_world_pctile')}` },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _fin(sa) ? sa : sp;
        const access = _fin(sa) ? ` and ${pc(sa)} of residents live within 400 m of one (more than in ${rk('sdg_space_access_world_pctile')} of the world's cities of a million or more)` : '';
        const transit = _fin(tr) ? ` ${pc(tr)} of residents can walk to public transport (500 m to a bus stop or 1 km to rail), more than in ${rk('sdg_transit_india_pctile')} of India's big cities and ${rk('sdg_transit_world_pctile')} of the world's.` : '';
        return {
            columns: { sdg_score: out }, idx, weightKey: 'sdg_score',
            metric: { label: 'Residents within 400 m of open public space (SDG 11.7.1)', value: _fin(sa) ? _round(sa, 1) : _round(sp, 1), unit: '%', higherIs: 'better' },
            headline: `On the UN's SDG 11 yardstick, open public space covers ${pc(sp)} of the urban area, more than in ${rk('sdg_space_india_pctile')} of India's cities of a million or more${access}.${transit} Both counts come from OpenStreetMap, so unmapped parks and bus stops pull a city down; the parks and transit lenses show the block-by-block picture. One value for the whole city.`,
            stats,
        };
    }

    // Days too hot and humid to work outdoors safely (ISO WBGT limits), early 1980s against the 2010s, and how much of the
    // extra exposure came from warming rather than from more people. City-level, from NASA SEDAC UHE-Daily.
    function workheat(fr) {
        const c = fr.cols, n = fr.grid.n, g = c['work_heat.wh30_late'];
        if (!g || !g.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(g[i]));
        if (idx.length < 5) return null;
        const i0 = idx[0], v = k => { const a = c[`work_heat.${k}`]; return a && _fin(a[i0]) ? a[i0] : NaN; };
        const e30 = v('wh30_early'), l30 = v('wh30_late'), e32 = v('wh32_early'), l32 = v('wh32_late'), hs = v('wh_heat_share'), ip = v('wh30_india_pctile');
        const d = x => (_fin(x) ? `${_round(x, x < 10 ? 1 : 0)}` : 'n/a');
        const stats = [
            { label: 'Days a year above WBGT 30 °C (heavy outdoor work unsafe), 1983-1992', value: d(e30) },
            { label: '…2007-2016', value: d(l30) },
            { label: 'Days a year above WBGT 32 °C (even light outdoor work unsafe), 1983-1992', value: d(e32) },
            { label: '…2007-2016', value: d(l32) },
            { label: 'Share of the rise in person-days due to warming (rest is population growth)', value: _fin(hs) ? `${_round(hs, 0)}%` : 'n/a' },
            { label: 'Indian settlements of 1 million+ with fewer such days, 2007-2016', value: _fin(ip) ? `${_round(ip, 0)}%` : 'n/a' },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = l30;
        let head;
        if (!(l30 > 0.5)) {
            head = 'Between 1983 and 2016 the city almost never passed a wet-bulb globe temperature of 30 °C, the ISO limit above which heavy outdoor work needs enforced rest; its height keeps humid heat in check, even though hot afternoons are getting more common.';
        } else {
            const light = l32 >= 1 ? ` On ${d(l32)} of those days (${d(e32)} in the 1980s) it passed 32 °C, when even light work outside is unsafe.` : '';
            const why = _fin(hs) ? ` About ${_round(hs, 0)}% of the extra person-days of exposure since 1983 came from warming itself; the rest from more people living there.` : '';
            head = `In 2007-2016 the city averaged ${d(l30)} days a year with a wet-bulb globe temperature above 30 °C, the ISO limit above which heavy outdoor work (construction, loading, street vending) needs enforced rest, up from ${d(e30)} in 1983-1992.${light}${why} Only ${_fin(ip) ? `${_round(100 - ip, 0)}%` : 'a few'} of India's cities of a million or more have more such days.`;
        }
        return {
            columns: { work_heat_days: out }, idx, weightKey: 'work_heat_days',
            metric: { label: 'Days a year above WBGT 30 °C, 2007-2016', value: _fin(l30) ? _round(l30, 0) : 0, unit: 'days', higherIs: 'worse' },
            headline: `${head} Readings are for the whole urban settlement on a ~5 km grid (CHIRTS-daily), so shade, roofs and work hours are left out. One value for the whole city.`,
            stats,
        };
    }

    // Fossil-fuel CO2 where it is burnt, 2004 against 2024 (ODIAC, CC BY 4.0): the open stand-in for EDGAR CO2, whose
    // licence rules out commercial use. Night lights spread most of it, power plants sit at their own coordinates.
    function fossilco2(fr) {
        const c = fr.cols, n = fr.grid.n, now = c['fossil_co2.co2_2024'];
        if (!now || !now.some(_fin)) return null;
        const old = c['fossil_co2.co2_2004'], pop = c['population.population'];
        const idx = _residents(fr).filter(i => _fin(now[i]));
        if (idx.length < 5) return null;
        const km2 = fr.grid.cellKm2, w = i => (pop && _fin(pop[i]) ? pop[i] : 0);
        let tNow = 0, tOld = 0, people = 0;
        const vals = [];
        for (const i of idx) {
            tNow += now[i] * km2; people += w(i); vals.push(now[i] * km2);
            if (old && _fin(old[i])) tOld += old[i] * km2;
        }
        if (!tNow || !people) return null;
        vals.sort((a, b) => b - a);
        const top = vals.slice(0, Math.max(1, Math.round(vals.length / 100))).reduce((a, b) => a + b, 0);
        const mt = x => (x >= 1e6 ? `${_round(x / 1e6, 1)} million t` : `${_round(x / 1e3, 0)} thousand t`);
        const per = tNow / people, ch = tOld ? 100 * (tNow / tOld - 1) : NaN;
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = now[i];
        const stats = [
            { label: 'Fossil CO2 emitted over lived-in blocks, 2024', value: mt(tNow) },
            { label: '…2004', value: tOld ? mt(tOld) : 'n/a' },
            { label: 'Change 2004 → 2024', value: _fin(ch) ? `${ch >= 0 ? '+' : ''}${_round(ch, 0)}%` : 'n/a' },
            { label: 'Per resident of those blocks, 2024', value: `${_round(per, 1)} t CO2` },
            { label: 'Share emitted in the top 1% of blocks', value: `${_round(100 * top / tNow, 0)}%` },
        ];
        return {
            columns: { co2_t_km2: out }, idx, weightKey: 'co2_t_km2',
            metric: { label: 'Fossil CO2 per resident of lived-in blocks, 2024', value: _round(per, 1), unit: 't CO2', higherIs: 'worse' },
            headline: `About ${mt(tNow)} of fossil CO2 were emitted over the city's lived-in blocks in 2024${_fin(ch) ? `, ${ch >= 0 ? 'up' : 'down'} ${_round(Math.abs(ch), 0)}% on 2004` : ''}: roughly ${_round(per, 1)} t per resident, against an Indian average near 2 t. ${top / tNow >= 0.15 ? `The top 1% of blocks account for ${_round(100 * top / tNow, 0)}%, which is where power plants, refineries or the busiest districts sit.` : `Emissions are spread out: the top 1% of blocks account for only ${_round(100 * top / tNow, 0)}%.`} India's national total grew about 2.5 times over the same years, and ODIAC spreads it by night lights, so a fast-brightening city gains more than its share; read it as where fuel is likely burnt, not a measured footprint.`,
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
        { id: 'forecastcheck', title: 'Did the 2015 growth forecast come true?', icon: '🔮',
            question: 'Did my city grow where the 2015 urban expansion forecast said it would?',
            field: { key: 'missed_growth', label: 'Growth the forecast missed', unit: 'yes/no', higherIs: null, ramp: 'heat', domain: [0, 1] },
            needs: ['urban_expansion.urban_2000', 'urban_expansion.p2030', 'built_up.built_change_pct', 'population.population'],
            method: `The Global Grid of Probabilities of Urban Expansion to 2030 (Seto, Güneralp and Hutyra 2015, NASA SEDAC) starts from MODIS urban land around 2000 and gives every cell that was not urban then (about 5 km wide) a Monte-Carlo probability of turning urban by 2030, driven by population density and regional population and GDP projections. Each lived-in L7 block takes the cell at its centre. Because the forecast used only 2000 data, it is checked against GHSL's new built surface 2000→2020 (percentage points of the block): blocks given under 50% odds that still gained 20 pp or more are growth the forecast missed. Across eight cities the forecast and real growth agree only weakly (Spearman 0.41 in Indore, about 0.2 in Bengaluru, −0.38 in Chennai, near 0 elsewhere), so this is a check on forecasting, not a forecast itself.`,
            refs: 'Seto K.C., Güneralp B. & Hutyra L.R. 2012, Global forecasts of urban expansion to 2030, PNAS 109(40):16083; data: NASA SEDAC 2015, doi:10.7927/H4Z899CG (free use with attribution); GHSL R2023A built surface (JRC, CC BY 4.0)' },
        { id: 'sdgcard', title: 'UN SDG 11 scorecard: public space and transit', icon: '🇺🇳',
            question: 'How does my city score on the UN SDG 11 public space and transport indicators?',
            field: { key: 'sdg_score', label: 'Residents within 400 m of open public space', unit: '%', higherIs: 'better', ramp: 'greens', domain: [0, 100] },
            needs: ['sdg_city.sdg_space_pct', 'sdg_city.sdg_space_india_pctile', 'sdg_city.sdg_space_world_pctile', 'sdg_city.sdg_space_access_pct', 'sdg_city.sdg_space_access_india_pctile', 'sdg_city.sdg_space_access_world_pctile', 'sdg_city.sdg_transit_pct', 'sdg_city.sdg_transit_india_pctile', 'sdg_city.sdg_transit_world_pctile', 'population.population'],
            method: `NASA SEDAC's SDG Indicators 2023 release (CIESIN) computes two UN Sustainable Development Goal 11 indicators for every city in the JRC GHS Urban Centre Database. SDG 11.7.1 is the share of the urban centre's area that is OpenStreetMap open public space, and the share of WorldPop residents within 400 m of it; SDG 11.2.1 is the share of residents within 500 m of a low-capacity stop (bus) or 1 km of a high-capacity one (rail, BRT, ferry). Ranks set each score against the 1 million+ urban centres in India and worldwide. Both rest on OSM mapping, which is patchy in Indian cities, and the urban centre outline is GHSL's, not the municipal boundary.`,
            refs: 'CIESIN 2023, SDG Indicator 11.7.1: Urban Public Space, Availability and Access, doi:10.7927/eavc-4k45; SDG Indicator 11.2.1: Urban Access to Public Transport, doi:10.7927/1a5z-3h71; NASA SEDAC (CC BY 4.0)' },
        { id: 'workheat', title: 'Days too hot for safe outdoor work', icon: '👷',
            question: 'How many days a year is it too hot and humid to work outdoors safely in my city?',
            field: { key: 'work_heat_days', label: 'Days above WBGT 30 °C, 2007-2016', unit: 'days/yr', higherIs: 'worse', ramp: 'heat', domain: [0, 150] },
            needs: ['work_heat.wh30_early', 'work_heat.wh30_late', 'work_heat.wh32_early', 'work_heat.wh32_late', 'work_heat.wh_heat_share', 'work_heat.wh30_india_pctile', 'population.population'],
            method: `NASA SEDAC's Global High Resolution Daily Extreme Urban Heat Exposure (UHE-Daily, Tuholske et al. 2021) computes the daily maximum Wet Bulb Globe Temperature from CHIRTS-daily temperature and humidity (~5 km) over more than 10,000 GHSL urban settlements, 1983-2016, and counts days above the ISO occupational heat-stress limits: 30 °C, when heavy work needs enforced rest, and 32 °C, when even light work is unsafe. It splits the rise in person-days of exposure into warming (more hot days for the 1983 population) and population growth; the share here is the warming slope over the total slope for 30 °C. The settlement nearest the city centre (within 25 km, most populous) stands for the city; a city with no row had no such day. Ranks are against India's settlements of a million or more.`,
            refs: 'Tuholske C. et al. 2021, Global urban population exposure to extreme heat, PNAS 118(41):e2024792118; data: CIESIN, NASA SEDAC, doi:10.7927/fq7g-ny13 (CC BY 4.0)' },
        { id: 'fossilco2', title: 'Fossil CO2 where it is burnt', icon: '🏭',
            question: 'Where is fossil CO2 emitted in my city, and how has it grown since 2004?',
            field: { key: 'co2_t_km2', label: 'Fossil CO2, 2024', unit: 't CO2/km²/yr', higherIs: 'worse', ramp: 'reds' },
            needs: ['fossil_co2.co2_2024', 'fossil_co2.co2_2004', 'fossil_co2.co2_change_pct', 'population.population'],
            method: `ODIAC2025 (Oda and Maksyutov, NIES Japan) distributes national fossil-fuel CO2 totals from combustion and cement (international aviation and shipping excluded) on a 30 arc-second (~1 km) grid each month: large power plants are placed at their reported coordinates and the remaining emissions follow VIIRS/DMSP night lights. The twelve monthly grids of 2004 and 2024 are summed and converted from tonnes of carbon to tonnes of CO2 per km²; each lived-in L7 block takes the pixel at its centre and the city total is density times block area over lived-in blocks only. Because lights stand in for fuel use, bright commercial districts look high and dark industrial sites can look low. It replaces EDGAR CO2, which is not licensed for commercial use.`,
            refs: 'Oda T., Maksyutov S. & Andres R.J. 2018, The Open-source Data Inventory for Anthropogenic CO2, version 2016 (ODIAC2016), Earth Syst. Sci. Data 10:87; data: ODIAC2025, NIES, doi:10.17595/20170411.001 (CC BY 4.0)' },
    ];

    UrbanLenses.register(ENTRIES, { deprivation, ruralrun, forecastcheck, sdgcard, workheat, fossilco2 });
    return { ENTRIES };
})();
