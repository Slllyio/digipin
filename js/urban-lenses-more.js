/**
 * More lenses for UrbanLenses, added after urban-lenses-extra.js neared the 150 kB per-module budget (first: relative
 * deprivation from NASA SEDAC GRDI). Registers itself on load, after urban-lenses.js.
 */
const UrbanLensesMore = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _residents, wmean, wquantile, within } = UrbanLenses._kit;

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

    // The long view: how many people lived in each block in 1975 against 2020 (GHSL back-cast), and which period filled it.
    function since1975(fr) {
        const c = fr.cols, n = fr.grid.n, p20 = c['pop_history.pop_2020'];
        if (!p20 || !p20.some(_fin)) return null;
        const p75 = c['pop_history.pop_1975'], emp = c['pop_history.empty_1975'], boom = c['pop_history.boom_period'], pop = c['population.population'];
        const idx = _residents(fr).filter(i => _fin(p20[i]));
        if (idx.length < 5) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0), w = i => v(pop, i);
        let all = 0, then = 0, nowRaw = 0, empty = 0;
        const byP = [0, 0, 0, 0, 0];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            const x = w(i); all += x; then += v(p75, i); nowRaw += v(p20, i);
            if (v(emp, i) >= 0.5) empty += x;
            const b = boom && _fin(boom[i]) ? Math.round(boom[i]) : 0;
            if (b >= 1 && b <= 4) { byP[b] += x; out[i] = b; }
        }
        if (!all || !then) return null;
        const pc = x => `${_round(100 * x / all, 0)}%`, names = ['', '1975-1990', '1990-2000', '2000-2010', '2010-2020'];
        const top = [1, 2, 3, 4].reduce((a, b) => (byP[b] > byP[a] ? b : a), 1);
        const stats = [
            { label: 'Residents in these blocks, 1975 (GHSL)', value: _people(then) },
            { label: '…2020 (GHSL)', value: _people(nowRaw) },
            { label: 'Today’s residents in blocks almost empty in 1975 (under 300 per km²)', value: `${_people(empty)} (${pc(empty)})` },
            ...[1, 2, 3, 4].map(b => ({ label: `Today’s residents in blocks that grew fastest in ${names[b]}`, value: `${_people(byP[b])} (${pc(byP[b])})` })),
        ];
        return {
            columns: { boom_period: out }, idx, weightKey: 'boom_period', noHotspots: true,
            metric: { label: 'Today’s residents in blocks almost empty in 1975', value: _round(100 * empty / all, 0), unit: '%', higherIs: null },
            headline: `These blocks held about ${_people(then)} people in 1975 and ${_people(nowRaw)} in 2020 on GHSL's count, ${_round(nowRaw / then, 1)} times as many. ${pc(empty)} of today's residents live where there were fewer than 300 people per km² in 1975 (then fields, villages or scrub). For the largest share of residents (${pc(byP[top])}) the fastest growth came in ${names[top]}. GHSL back-casts 1975 from Landsat built-up land and census totals, so read districts rather than single blocks.`,
            stats,
        };
    }

    // Afternoon heat that morning satellites miss: ECOSTRESS passes 12:30-16:30, Landsat at 10:30. Blocks ordinary in the
    // morning but hot in the afternoon are usually metal and asbestos roofs, bare ground and wide paved yards.
    function afternoonheat(fr) {
        const c = fr.cols, n = fr.grid.n, an = c['afternoon_heat.pm_anom_c'];
        if (!an || !an.some(_fin)) return null;
        const lst = c['afternoon_heat.pm_lst_c'], am = c['surface_heat.uhi_anomaly_c'], pop = c['population.population'];
        const idx = _residents(fr).filter(i => _fin(an[i]));
        if (idx.length < 5) return null;
        const w = i => (pop && _fin(pop[i]) ? pop[i] : 0);
        // Re-centre on the typical resident: the stored gaps are to the median lived-in block, which in cities with
        // mangroves, forest or wet fields inside the lived-in area is cooler than where most people live.
        const mid = wquantile(an, pop, idx, 0.5), amIdx = am ? idx.filter(i => _fin(am[i])) : [];
        const amMid = amIdx.length ? wquantile(am, pop, amIdx, 0.5) : 0;
        const med = lst ? wquantile(lst, pop, idx.filter(i => _fin(lst[i])), 0.5) : NaN;
        let all = 0, hot = 0, cool = 0, hidden = 0;
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            const x = w(i), g = an[i] - (_fin(mid) ? mid : 0); all += x; out[i] = g;
            if (g >= 3) { hot += x; if (am && _fin(am[i]) && am[i] - amMid < 1) hidden += x; }
            if (g <= -3) cool += x;
        }
        if (!all) return null;
        const pc = x => `${_round(100 * x / all, 1)}%`;
        const stats = [
            { label: 'Typical resident’s block, afternoon surface temperature (pre-monsoon, 12:30-16:30)', value: _fin(med) ? `${_round(med, 1)} °C` : 'n/a' },
            { label: 'Residents in blocks 3 °C or more hotter than the typical resident’s in the afternoon', value: `${_people(hot)} (${pc(hot)})` },
            { label: '…of them in blocks within 1 °C of the median on the 10:30 Landsat pass', value: am ? `${_people(hidden)} (${pc(hidden)})` : 'n/a' },
            { label: 'Residents in blocks 3 °C or more cooler', value: `${_people(cool)} (${pc(cool)})` },
        ];
        return {
            columns: { pm_anom_c: out }, idx, weightKey: 'pm_anom_c',
            metric: { label: 'Residents in blocks 3 °C+ hotter than the typical resident’s in the afternoon', value: _round(100 * hot / all, 1), unit: '%', higherIs: 'worse' },
            headline: `On clear pre-monsoon afternoons the ground in the typical resident's block reaches ${_fin(med) ? `${_round(med, 0)} °C` : 'n/a'}. ${_people(hot)} residents (${pc(hot)}) live in blocks at least 3 °C hotter than that${!am ? '' : hot && hidden >= 0.25 * hot ? `, and ${_people(hidden)} of them live where the 10:30 morning satellite pass shows nothing unusual: tin and asbestos roofs, bare yards and paved lots heat up after the morning` : `; only ${_people(hidden)} of them look ordinary on the 10:30 morning pass, so morning heat maps find most of the same hotspots`}. ${_people(cool)} (${pc(cool)}) live in blocks 3 °C or more cooler, mostly under trees or near water. Surface temperature, not air temperature; NASA ECOSTRESS, 2019-2025.`,
            stats,
        };
    }

    // River, canal and creek colour from Sentinel-2: floating weeds (NDVI on permanent water) and algae (NDCI on open
    // water). Lakes and tanks are the lakehealth lens's; this one keeps blocks the Copernicus DEM calls river.
    function riverwater(fr) {
        const c = fr.cols, n = fr.grid.n, wp = c['water_colour.wc_water_pct'];
        if (!wp || !wp.some(_fin)) return null;
        const weed = c['water_colour.wc_weed_pct'], ndci = c['water_colour.wc_ndci'], pop = c['population.population'];
        const riv = c['water_colour.wc_river'];
        const wet = [];
        for (let i = 0; i < n; i++) if (_fin(wp[i]) && wp[i] > 0 && (!riv || riv[i] === 1)) wet.push(i);
        if (wet.length < 3) return null;
        const state = new Float64Array(n).fill(NaN), bad = new Float64Array(n), any = new Float64Array(n);
        let nWeed = 0, nAlgae = 0, waterKm2 = 0;
        for (const i of wet) {
            const isWeed = weed && _fin(weed[i]) && weed[i] >= 25, isAlgae = ndci && _fin(ndci[i]) && ndci[i] >= 0.15;
            state[i] = isWeed ? 2 : isAlgae ? 1 : 0;
            if (isWeed) nWeed++; else if (isAlgae) nAlgae++;
            if (isWeed || isAlgae) bad[i] = 1;
            any[i] = 1;
            waterKm2 += (wp[i] / 100) * fr.grid.cellKm2;
        }
        const nearBad = within(fr.grid, bad, 0.5), nearAny = within(fr.grid, any, 0.5);
        let all = 0, near = 0, nearB = 0;
        for (const i of _residents(fr)) {
            const x = pop && _fin(pop[i]) ? pop[i] : 0; all += x;
            if (nearAny[i] > 0) near += x;
            if (nearBad[i] > 0) nearB += x;
        }
        if (!all) return null;
        const score = i => (weed && _fin(weed[i]) ? weed[i] : 0) + (ndci && _fin(ndci[i]) ? 100 * ndci[i] : 0);
        const worst = wet.slice().sort((a, b) => score(b) - score(a)).slice(0, 3);
        const pc = (x, t) => `${_round(100 * x / (t || 1), 1)}%`;
        const stats = [
            { label: 'Blocks with permanent river, canal or creek water', value: `${wet.length} (${_round(waterKm2, 1)} km² of water)` },
            { label: 'Water blocks covered by floating weeds or a dense bloom (25%+ of the water)', value: `${nWeed} (${pc(nWeed, wet.length)})` },
            { label: '…other water blocks with algae-rich water (chlorophyll index 0.15+)', value: `${nAlgae} (${pc(nAlgae, wet.length)})` },
            { label: 'Residents within about 500 m of the river, canals or creeks', value: `${_people(near)} (${pc(near, all)})` },
            { label: '…of them next to weed-covered or algae-rich water', value: `${_people(nearB)} (${pc(nearB, near)})` },
            ...worst.map((i, k) => ({ label: `Worst-looking stretch ${k + 1}: ${fr.grid.codes[i]}`,
                value: `weeds ${weed && _fin(weed[i]) ? _round(weed[i], 0) : 'n/a'}% of the water; chlorophyll index ${ndci && _fin(ndci[i]) ? _round(ndci[i], 2) : 'n/a (no open water)'}` })),
        ];
        const share = _round(100 * (nWeed + nAlgae) / wet.length, 0);
        return {
            columns: { water_state: state }, idx: wet, weightKey: 'water_state',
            metric: { label: 'Residents near rivers and creeks whose water looks weed-covered or algae-rich', value: _round(100 * nearB / (near || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `From space, ${share}% of the city's ${wet.length} blocks of river, canal and creek water look unhealthy in the dry season: ${nWeed} are mostly covered by floating weeds or a dense bloom and ${nAlgae} more are green with algae, the usual sign of sewage and fertiliser feeding the water. ${_people(nearB)} residents (${pc(nearB, near)} of the ${_people(near)} living within about 500 m of the river) live next to such stretches. This is water colour seen by Sentinel-2, not a lab test for sewage or oxygen; dark, deep polluted water can look clean.`,
            stats,
        };
    }

    // Building fabric (after urbanity / momepy footprint morphology). Overture footprints per block: how big they are,
    // how many touch a neighbour, how well they line up and how far apart they stand. Packed attached fabric is old
    // cores, urban villages and slums: little light and air between homes and hard for fire engines; open detached
    // fabric is bungalows, sheds and the urban edge.
    const FAB_MIN = 10, FAB_PACKED_ATT = 60, FAB_PACKED_AREA = 70, FAB_LARGE = 250, FAB_GRID_ALIGN = 85, FAB_GRID_ATT = 40, FAB_OPEN_GAP = 4;
    const FAB_NAMES = ['Open, detached', 'Packed, small and attached', 'Attached rows on a grid', 'Large footprints', 'Mixed'];

    function fabricClass(area, att, align, gap) {
        if (area >= FAB_LARGE) return 3;
        if (att >= FAB_PACKED_ATT && area < FAB_PACKED_AREA) return 1;
        if (att >= FAB_GRID_ATT && align >= FAB_GRID_ALIGN) return 2;
        if (gap >= FAB_OPEN_GAP) return 0;
        return 4;
    }

    function fabric(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, cnt = c['building_form.bf_count'], area = c['building_form.bf_area_m2'];
        const att = c['building_form.bf_attached_pct'], al = c['building_form.bf_align'], gap = c['building_form.bf_gap_m'];
        const swr = c['building_form.bf_shared_wall'], pop = c['population.population'], heat = c['surface_heat.uhi_anomaly_c'];
        if (!cnt || !area || !att || !cnt.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0), w = i => v(pop, i);
        const idx = _residents(fr).filter(i => _fin(cnt[i]) && cnt[i] >= FAB_MIN && _fin(area[i]) && _fin(att[i]));
        if (idx.length < 5) return null;
        const cls = new Float64Array(n).fill(NaN), byCls = [0, 0, 0, 0, 0], set = [[], [], [], [], []];
        let all = 0;
        for (const i of idx) {
            const k = fabricClass(area[i], att[i], v(al, i), v(gap, i));
            cls[i] = k; byCls[k] += w(i); set[k].push(i); all += w(i);
        }
        if (!all) return null;
        const pc = x => `${_round(100 * x / all, 0)}%`;
        const stats = FAB_NAMES.map((name, k) => ({ label: `Residents in ${name.toLowerCase()} fabric`, value: `${_people(byCls[k])} (${pc(byCls[k])})` }));
        stats.push({ label: 'Typical resident: footprint area / attached share / gap to the next building',
            value: `${_round(wquantile(area, pop, idx, 0.5), 0)} m² / ${_round(wquantile(att, pop, idx, 0.5), 0)}% / ${_round(wquantile(gap, pop, idx, 0.5), 1)} m` });
        if (swr) stats.push({ label: 'Shared wall ratio around the typical resident (share of outline against a neighbour)', value: `${_round(wquantile(swr, pop, idx, 0.5), 0)}%` });
        if (heat && set[1].length >= 5 && set[0].length >= 5) {
            const hm = s => wmean(heat, pop, s.filter(i => _fin(heat[i])));
            stats.push({ label: 'Surface heat vs region, packed attached vs open detached fabric', value: `${_round(hm(set[1]), 1)} °C vs ${_round(hm(set[0]), 1)} °C` });
        }
        const score = Float64Array.from({ length: n }, (_, i) => (cls[i] === 1 ? w(i) * v(att, i) / Math.max(20, v(area, i)) : 0));
        const picks = [];
        for (const i of set[1].slice().sort((a, b) => score[b] - score[a])) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1.5)) continue;
            picks.push(i);
        }
        picks.forEach((i, k) => stats.push({ label: `Most packed ${k + 1}: ${g.codes[i]}`,
            value: `${_round(area[i], 0)} m² footprints, ${_round(att[i], 0)}% attached, ${_round(v(gap, i), 1)} m gaps; ${_people(w(i))} residents` }));
        return {
            columns: { fabric_class: cls }, idx, weightKey: 'fabric_class', noHotspots: true,
            metric: { label: 'Residents in packed, small, attached fabric', value: _round(100 * byCls[1] / all, 0), unit: '%', higherIs: 'worse' },
            headline: `${_people(byCls[1])} residents (${pc(byCls[1])}) live in packed fabric, where most buildings are under ${FAB_PACKED_AREA} m² and touch a neighbour; ${pc(byCls[2])} live in attached rows laid out on a grid, ${pc(byCls[0])} in open, detached fabric and ${pc(byCls[3])} among large footprints (apartment blocks, institutions, sheds). The typical resident's building covers ${_round(wquantile(area, pop, idx, 0.5), 0)} m² and stands ${_round(wquantile(gap, pop, idx, 0.5), 1)} m from the next one.`,
            stats,
        };
    }

    // Street pattern (after urbanity / OSMnx network form). Orientation order says whether streets run on a grid or
    // every which way; circuity, link length and street-block size say how direct and fine-grained the network is.
    const SP_GRID = 70, SP_TANGLE = 30, SP_BIG_BLOCK_HA = 5;

    function streetpattern(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, ord = c['street_form.sf_order'], circ = c['street_form.sf_circuity'];
        const link = c['street_form.sf_link_m'], blk = c['street_form.sf_block_ha'], pop = c['population.population'];
        if (!ord || !ord.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0), w = i => v(pop, i);
        const idx = _residents(fr).filter(i => _fin(ord[i]));
        if (idx.length < 5) return null;
        let all = 0, grid = 0, tangle = 0, big = 0, bigAll = 0;
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            all += w(i); out[i] = Math.round(ord[i]);
            if (ord[i] >= SP_GRID) grid += w(i);
            if (ord[i] < SP_TANGLE) tangle += w(i);
            if (blk && _fin(blk[i])) { bigAll += w(i); if (blk[i] >= SP_BIG_BLOCK_HA) big += w(i); }
        }
        if (!all) return null;
        const pc = (x, t = all) => `${_round(100 * x / (t || 1), 0)}%`, med = wquantile(ord, pop, idx, 0.5);
        const q = (a, p) => { const s = idx.filter(i => a && _fin(a[i])); return s.length ? wquantile(a, pop, s, p) : NaN; };
        const stats = [
            { label: 'Grid order around the typical resident (100 = perfect grid)', value: `${_round(med, 0)}` },
            { label: `Residents on gridded streets (order ${SP_GRID}+)`, value: `${_people(grid)} (${pc(grid)})` },
            { label: `Residents on tangled streets (order under ${SP_TANGLE})`, value: `${_people(tangle)} (${pc(tangle)})` },
        ];
        if (circ) stats.push({ label: 'Street circuity around the typical resident (1 = dead straight)', value: `${_round(q(circ, 0.5), 2)}` });
        if (link) stats.push({ label: 'Typical street link between junctions', value: `${_round(q(link, 0.5), 0)} m` });
        if (blk) stats.push({ label: 'Typical street block (land ringed by streets)', value: `${_round(q(blk, 0.5), 2)} ha` },
            { label: `Residents where street blocks are ${SP_BIG_BLOCK_HA} ha or more`, value: `${_people(big)} (${pc(big, bigAll)} of those with closed blocks)` });
        const spacedPick = (score, k) => {
            const picks = [];
            for (const i of idx.slice().sort((a, b) => score[b] - score[a])) {
                if (picks.length >= k || score[i] <= 0) break;
                if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1.5)) continue;
                picks.push(i);
            }
            return picks;
        };
        const gridScore = Float64Array.from({ length: n }, (_, i) => (_fin(ord[i]) && ord[i] >= SP_GRID ? w(i) * ord[i] : 0));
        const tangleScore = Float64Array.from({ length: n }, (_, i) => (_fin(ord[i]) && ord[i] < SP_TANGLE ? w(i) * (SP_TANGLE - ord[i]) : 0));
        spacedPick(gridScore, 3).forEach((i, k) => stats.push({ label: `Most gridded ${k + 1}: ${g.codes[i]}`, value: `order ${Math.round(ord[i])}; ${_people(w(i))} residents` }));
        spacedPick(tangleScore, 3).forEach((i, k) => stats.push({ label: `Most tangled ${k + 1}: ${g.codes[i]}`, value: `order ${Math.round(ord[i])}${circ && _fin(circ[i]) ? `, circuity ${_round(circ[i], 2)}` : ''}; ${_people(w(i))} residents` }));
        return {
            columns: { grid_order: out }, idx, weightKey: 'grid_order',
            metric: { label: 'Grid order around the typical resident', value: _round(med, 0), unit: '0-100', higherIs: null },
            headline: `Streets around the typical resident score ${_round(med, 0)} of 100 for grid order: ${pc(grid)} of residents live where streets run on a clear grid and ${pc(tangle)} where they run every which way. A grid makes routes easy to read and spreads traffic; a tangle of lanes is typical of old cores and villages the city swallowed.`,
            stats,
        };
    }

    // Map quality (after urbanity's OSM completeness checks). How much of each block was drawn by people rather than
    // machine-learning footprints, and how much carries heights, building types and street names: the trust level of
    // every other lens that leans on open maps.
    const MQ_THIN_OSM = 10, MQ_THIN_NAMED = 30;

    function mapquality(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, nb = c['map_quality.mq_buildings'], osm = c['map_quality.mq_osm_pct'];
        const ht = c['map_quality.mq_height_pct'], ty = c['map_quality.mq_type_pct'], km = c['map_quality.mq_street_km'];
        const nm = c['map_quality.mq_named_pct'], pop = c['population.population'];
        if (!nb || !osm || !nb.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0), w = i => v(pop, i);
        const idx = _residents(fr).filter(i => _fin(nb[i]) && nb[i] > 0);
        if (idx.length < 5) return null;
        let B = 0, O = 0, H = 0, T = 0, S = 0, N = 0, all = 0, thin = 0;
        for (let i = 0; i < n; i++) {
            const b = v(nb, i); B += b; O += b * v(osm, i) / 100; H += b * v(ht, i) / 100; T += b * v(ty, i) / 100;
            const k = v(km, i); S += k; N += k * v(nm, i) / 100;
        }
        const thinSet = [];
        for (const i of idx) {
            all += w(i);
            if (v(osm, i) < MQ_THIN_OSM && (!km || !_fin(km[i]) || v(nm, i) < MQ_THIN_NAMED)) { thin += w(i); thinSet.push(i); }
        }
        if (!all || !B) return null;
        const pc = (x, t) => `${_round(100 * x / (t || 1), 0)}%`;
        const stats = [
            { label: 'Building footprints on the map', value: `${_people(B)}` },
            { label: '…drawn by OpenStreetMap mappers (rest: Google / Microsoft machine-learning footprints)', value: pc(O, B) },
            { label: '…with a height or number of floors', value: pc(H, B) },
            { label: '…with a building type (homes, shop, school…)', value: pc(T, B) },
            { label: 'Public street length with a name', value: `${pc(N, S)} of ${_round(S, 0)} km` },
            { label: `Residents in thinly mapped blocks (under ${MQ_THIN_OSM}% hand-drawn buildings and under ${MQ_THIN_NAMED}% named streets)`, value: `${_people(thin)} (${pc(thin, all)})` },
        ];
        const score = Float64Array.from({ length: n }, (_, i) => w(i) * (100 - v(osm, i)));
        const picks = [];
        for (const i of thinSet.slice().sort((a, b) => score[b] - score[a])) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1.5)) continue;
            picks.push(i);
        }
        picks.forEach((i, k) => stats.push({ label: `Most residents on a thin map ${k + 1}: ${g.codes[i]}`,
            value: `${_round(v(osm, i), 0)}% hand-drawn buildings, ${_round(v(nm, i), 0)}% named streets; ${_people(w(i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(v(osm, i), 0);
        return {
            columns: { osm_drawn_pct: out }, idx, weightKey: 'osm_drawn_pct', noHotspots: true,
            metric: { label: 'Building footprints drawn by OpenStreetMap mappers', value: _round(100 * O / B, 0), unit: '%', higherIs: 'better' },
            headline: `${pc(O, B)} of the ${_people(B)} buildings on the map were drawn by OpenStreetMap mappers; the rest are machine-learning footprints from Google and Microsoft, which get the outline but not what the building is. Only ${pc(H, B)} carry a height or floor count and ${pc(T, B)} a building type, and ${pc(N, S)} of street length has a name. ${_people(thin)} residents (${pc(thin, all)}) live in thinly mapped blocks, where lenses built on map tags (shops, schools, building use, street names) deserve the most caution.`,
            stats,
        };
    }

    // Through streets (after urbanity's network centralities; Sevtsuk's local betweenness). Edge betweenness within
    // 1.2 km says which street links most short walks pass along: where foot traffic, and so shopfronts, gather.
    const TS_TOP = 0.9, TS_MAPPED = 3;

    function throughstreets(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, mx = c['through_streets.ts_max'], pop = c['population.population'];
        const food = c['places.food'], shop = c['places.shopping'], anyp = c['places.places'];
        if (!mx || !mx.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0), w = i => v(pop, i);
        const blocks = [];
        for (let i = 0; i < n; i++) if (_fin(mx[i])) blocks.push(i);
        if (blocks.length < 20) return null;
        const sorted = blocks.map(i => mx[i]).sort((a, b) => a - b);
        const cut = sorted[Math.floor(TS_TOP * (sorted.length - 1))];
        const rank = new Float64Array(n).fill(NaN);
        // percentile rank within the city (ties averaged by binary search on the sorted array)
        const lower = x => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; } return lo; };
        const upper = x => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) lo = m + 1; else hi = m; } return lo; };
        for (const i of blocks) rank[i] = Math.round(100 * ((lower(mx[i]) + upper(mx[i])) / 2) / sorted.length);
        const top = blocks.filter(i => mx[i] >= cut && mx[i] > 0);
        const shops = i => v(food, i) + v(shop, i);
        let shopAll = 0, shopTop = 0;
        for (const i of blocks) shopAll += shops(i);
        for (const i of top) shopTop += shops(i);
        const lived = blocks.filter(i => w(i) > 0);
        const shopMed = (() => { const a = lived.map(shops).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; })();
        // Only where the shop map is not itself thin: the 1 km around must hold at least the typical lived-in block's
        // nearby count, so an empty block reads as a gap in trade, not a gap in the map.
        const near = within(g, Float64Array.from({ length: n }, (_, i) => shops(i)), 1, false);
        const nearMed = (() => { const a = lived.map(i => near[i]).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; })();
        const mapped = i => !anyp || v(anyp, i) >= TS_MAPPED;
        const untapped = top.filter(i => w(i) > 0 && shops(i) <= shopMed && near[i] >= nearMed && mapped(i));
        const unmapped = top.filter(i => !mapped(i));
        const stats = [
            { label: `Shops and eateries on the busiest tenth of through-street blocks`, value: `${_round(100 * shopTop / (shopAll || 1), 0)}% (from ${_round(100 * top.length / blocks.length, 0)}% of blocks)` },
            { label: 'Busy through-street blocks with no more shops than a typical lived-in block (untapped frontage)', value: `${untapped.length} blocks` },
            { label: `Busy through-street blocks with under ${TS_MAPPED} mapped places of any kind (likely a gap in the places map, e.g. old bazaars)`, value: `${unmapped.length} blocks (${_round(100 * unmapped.length / (top.length || 1), 0)}%)` },
        ];
        const pick = (set, score, k) => {
            const out = [];
            for (const i of set.slice().sort((a, b) => score(b) - score(a))) {
                if (out.length >= k) break;
                if (out.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1.5)) continue;
                out.push(i);
            }
            return out;
        };
        pick(top, i => mx[i], 3).forEach((i, k) => stats.push({ label: `Busiest through street ${k + 1}: ${g.codes[i]}`, value: `${_round(mx[i], 1)} thousand short walks pass; ${shops(i)} shops and eateries` }));
        pick(untapped, i => mx[i] * Math.log1p(w(i)), 5).forEach((i, k) => stats.push({ label: `Untapped frontage ${k + 1}: ${g.codes[i]}`, value: `${_round(mx[i], 1)} thousand short walks pass; ${shops(i)} shops and eateries; ${_people(w(i))} residents` }));
        const idx = _residents(fr).filter(i => _fin(rank[i]));
        return {
            columns: { through_rank: rank }, idx: idx.length >= 5 ? idx : blocks, weightKey: 'through_rank',
            metric: { label: 'Shops and eateries on the busiest tenth of through-street blocks', value: _round(100 * shopTop / (shopAll || 1), 0), unit: '%', higherIs: null },
            headline: `The busiest tenth of blocks for through-movement on foot (short walks up to 1.2 km passing along their streets) hold ${_round(100 * shopTop / (shopAll || 1), 0)}% of the city's mapped shops and eateries. ${untapped.length} of those busy blocks have no more shops than a typical lived-in block: frontage that walking routes already favour but trade has not yet found, or where the street is hostile to stopping.`,
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
        { id: 'since1975', title: 'Who lived here in 1975?', icon: '⏳',
            question: 'How many people lived in my area in 1975, and when did it fill up?',
            field: { key: 'boom_period', label: 'Period that added the most residents (1 = 1975-90, 2 = 1990-2000, 3 = 2000-10, 4 = 2010-20)', unit: 'period', higherIs: null, ramp: 'viridis', domain: [1, 4] },
            needs: ['pop_history.pop_1975', 'pop_history.pop_2020', 'pop_history.empty_1975', 'pop_history.boom_period', 'population.population'],
            method: `JRC's GHS-POP R2023A gives residents on a 100 m grid for every five-year epoch from 1975, back-cast from Landsat built-up area and census totals. Each lived-in L7 block sums the 1975, 1990, 2000, 2010 and 2020 epochs; a block is counted as almost empty in 1975 below 300 people per km², and its boom period is the gap that added the most residents per year (the first gap is 15 years, the others 10). Shares of today's residents use the calibrated 2020 population; the 1975-to-2020 totals are GHSL's own, uncalibrated, so they differ from census city figures and from the population lens in Bengaluru and the five electors-calibrated cities.`,
            refs: 'Schiavina M. et al. 2023, GHS-POP R2023A - GHS population grid multitemporal (1975-2030), European Commission JRC, doi:10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE (CC BY 4.0)' },
        { id: 'afternoonheat', title: 'Afternoon heat the morning satellites miss', icon: '🌇',
            question: 'Which parts of my city get hottest in the afternoon, when morning satellites can’t see?',
            field: { key: 'pm_anom_c', label: 'Afternoon surface heat vs the typical resident’s block', unit: '°C', higherIs: 'worse', ramp: 'diverging', domain: [-8, 8] },
            needs: ['afternoon_heat.pm_lst_c', 'afternoon_heat.pm_anom_c', 'surface_heat.uhi_anomaly_c', 'population.population'],
            method: `NASA's ECOSTRESS radiometer on the International Space Station measures land surface temperature at 70 m. Because the station's orbit drifts, it sees Indian cities at all hours, unlike Landsat, which always passes around 10:30. Every ECOSTRESS v002 tile (ECO_L2T_LSTE) acquired between 12:30 and 16:30 IST from 15 March to 20 June in 2019-2025 is cloud-masked. Each lived-in L7 block takes the mean of the 3×3 pixels at its centre, and its gap to that scene's median block is averaged over all clear scenes, which removes day-to-day weather; the lens then re-centres the gaps on the resident-weighted median. Hidden afternoon hotspots are blocks 3 °C or more above that in the afternoon but within 1 °C of the resident-weighted median in the Landsat morning layer (surface_heat, 2025).`,
            refs: 'Hook S. & Hulley G. 2022, ECOSTRESS Tiled Land Surface Temperature and Emissivity L2 Global 70 m V002, NASA LP DAAC, doi:10.5067/ECOSTRESS/ECO_L2T_LSTE.002 (NASA open data)' },
        { id: 'riverwater', title: 'Rivers and creeks: weeds and algae from space', icon: '🦠',
            question: 'Is the river, canal or creek near me polluted, choked with weeds or green with algae?',
            field: { key: 'water_state', label: 'Water state (0 clearer, 1 algae-rich, 2 weed-covered)', unit: 'class', higherIs: 'worse', ramp: 'reds', domain: [0, 2] },
            needs: ['water_colour.wc_water_pct', 'water_colour.wc_weed_pct', 'water_colour.wc_ndci', 'water_colour.wc_ndti', 'population.population'],
            method: `Copernicus Sentinel-2 surface reflectance scenes from March to May 2024 and 2025 (the dry season, when blooms and weed mats peak and cloud is low) are cloud-masked and reduced to a median. Permanent water is where JRC Global Surface Water found water in 60% or more of observations since 1984, minus the sea; the Copernicus DEM GLO-30 water body mask then keeps blocks whose water is mostly river or canal (lakes and tanks are the lake health lens). Narrow streams and nalas under about 30 m wide are not in the mask and are missed. On that water, pixels with NDVI 0.3 or more are floating weeds (mostly water hyacinth) or a dense surface bloom; on the remaining open water (NDVI under 0.1) the Normalised Difference Chlorophyll Index (B5−B4)/(B5+B4) estimates chlorophyll, and 0.15 or more points to eutrophic, nutrient-rich water (Mishra & Mishra 2012). Each L7 block with 5% or more water is classed weed-covered (25%+ of its water), algae-rich, or clearer; residents within about 500 m of such a block count as living next to it. Colour cannot see coliform, BOD or toxic effluent, so treat clearer as "no visible bloom", not as clean.`,
            refs: 'Copernicus Sentinel-2 MSI Level-2A (ESA, free and open); Pekel J.-F. et al. 2016, High-resolution mapping of global surface water and its long-term changes, Nature 540:418 (JRC GSW v1.4, CC BY 4.0); Mishra S. & Mishra D.R. 2012, Normalized difference chlorophyll index, Remote Sens. Environ. 117:394' },
        { id: 'fabric', title: 'Building fabric: packed, rows or open', icon: '🧩',
            question: 'Where are buildings packed wall to wall, set in rows, or standing apart?',
            field: { key: 'fabric_class', label: 'Building fabric (0 open, 1 packed attached, 2 rows on a grid, 3 large footprints, 4 mixed)', unit: 'class', higherIs: null, ramp: 'viridis', domain: [0, 4] },
            needs: ['building_form.bf_count', 'building_form.bf_area_m2', 'building_form.bf_attached_pct', 'building_form.bf_align', 'building_form.bf_gap_m', 'building_form.bf_shared_wall', 'surface_heat.uhi_anomaly_c', 'population.population'],
            method: `Overture Maps buildings (release 2026-10-21.0: OpenStreetMap, Google Open Buildings and Microsoft ML footprints) are measured one by one on a local metre grid with the footprint morphology used by urbanity and momepy: area, the share of the outline within 1 m of another footprint (shared wall ratio), the bearing of the long axis of the minimum rotated rectangle, and the distance to the nearest other footprint. Each L7 block with ${FAB_MIN} or more footprints takes medians, the share of footprints within 1 m of another (attached), and grid alignment, the length of the mean four-fold orientation vector (100 when every building sits on one grid). Classes, in order: large footprints (median ${FAB_LARGE} m² or more), packed (${FAB_PACKED_ATT}%+ attached and median under ${FAB_PACKED_AREA} m²), attached rows on a grid (${FAB_GRID_ATT}%+ attached, alignment ${FAB_GRID_ALIGN}+), open detached (median gap ${FAB_OPEN_GAP} m or more), otherwise mixed. ML footprints merge touching roofs in places and miss small sheds, so attached shares are approximate; the How neighbourhoods were built lens gives WRI's planned and unplanned reading of the same ground.`,
            refs: 'Yap W., Stouffs R. & Biljecki F. 2023, Urbanity: automated modelling and analysis of multidimensional networks in cities, npj Urban Sustainability 3:45 (urbanity, MIT); Fleischmann M. 2019, momepy: Urban Morphology Measuring Toolkit, JOSS 4(43):1807; Hamaina R., Leduc T. & Moreau G. 2012 (shared wall ratio); Overture Maps Foundation buildings theme (ODbL)' },
        { id: 'streetpattern', title: 'Street pattern: grid or tangle', icon: '🧭',
            question: 'Do the streets in my area run on a grid, or every which way?',
            field: { key: 'grid_order', label: 'Street grid order (100 = perfect grid)', unit: '0-100', higherIs: null, ramp: 'viridis', domain: [0, 100] },
            needs: ['street_form.sf_order', 'street_form.sf_circuity', 'street_form.sf_link_m', 'street_form.sf_block_ha', 'population.population'],
            method: `Overture Maps transportation segments (from OpenStreetMap, ODbL), public streets only (trunk to residential, unclassified, living and pedestrian). Every straight piece of street adds its length to a 36-bin histogram of compass bearings (both directions), pooled over the 5 × 5 blocks around each block (about 1.2 km, at least 1 km of street). Orientation order is Boeing's 1 − ((H − H_grid) / (H_max − H_grid))², where H is the histogram's entropy, H_max that of uniformly spread bearings and H_grid that of a perfect four-way grid; shown 0-100. Circuity is street length between junctions over the straight distance between them, link length is the median junction-to-junction length, and street blocks are the parcels of land that public streets fully ring (polygonised network, 0.05-50 ha), by the block holding their centre. Grid order ${SP_GRID}+ counts as gridded and under ${SP_TANGLE} as tangled. Lanes mapped as service roads or footpaths are left out, so very fine old-city lanes can read as large blocks.`,
            refs: 'Boeing G. 2019, Urban spatial order: street network orientation, configuration, and entropy, Applied Network Science 4:67; Boeing G. 2017, OSMnx, Computers, Environment and Urban Systems 65:126; Yap W., Stouffs R. & Biljecki F. 2023, Urbanity, npj Urban Sustainability 3:45 (MIT); Overture Maps Foundation transportation theme' },
        { id: 'mapquality', title: 'How well is my area mapped?', icon: '🗺️',
            question: 'How complete is the open map here, and how far can I trust map-based answers?',
            field: { key: 'osm_drawn_pct', label: 'Buildings drawn by OpenStreetMap mappers', unit: '%', higherIs: 'better', ramp: 'viridis', domain: [0, 100] },
            needs: ['map_quality.mq_buildings', 'map_quality.mq_osm_pct', 'map_quality.mq_height_pct', 'map_quality.mq_type_pct', 'map_quality.mq_street_km', 'map_quality.mq_named_pct', 'population.population'],
            method: `Overture Maps (release 2026-10-21.0) records where every feature came from. Each L7 block counts its building footprints and the share drawn in OpenStreetMap (the rest come from Google Open Buildings or Microsoft's machine-learning footprints, which have an outline but no use, height or name), the shares carrying a height or floor count and a building type, and the share of public street length (trunk to residential, unclassified, living and pedestrian) with a name. A block is thinly mapped below ${MQ_THIN_OSM}% hand-drawn buildings and ${MQ_THIN_NAMED}% named streets. This is the kind of completeness check urbanity runs on OpenStreetMap before trusting a city's graph; it measures the map, not the place.`,
            refs: 'Yap W., Stouffs R. & Biljecki F. 2023, Urbanity, npj Urban Sustainability 3:45 (MIT); Barrington-Leigh C. & Millard-Ball A. 2017, The world’s user-generated road map is more than 80% complete, PLOS ONE 12(8):e0180698; Overture Maps Foundation (ODbL)' },
        { id: 'throughstreets', title: 'Through streets: where foot traffic funnels', icon: '🚶',
            question: 'Which streets do most short walks pass along, and which of them still lack shops?',
            field: { key: 'through_rank', label: 'Through-movement on foot, city percentile', unit: 'percentile', higherIs: null, ramp: 'heat', domain: [0, 100] },
            needs: ['through_streets.ts_max', 'through_streets.ts_mean', 'places.places', 'places.food', 'places.shopping', 'population.population'],
            method: `Overture Maps public streets (trunk to residential, unclassified, living and pedestrian; ODbL) are split at every connector into links weighted by length. Edge betweenness with a 1.2 km cut-off counts, for every pair of junctions up to 1.2 km apart along the network (about a 15-minute walk), how many shortest paths run along each link: the local through-movement potential that Sevtsuk found predicts where shops locate, and the network centrality urbanity computes on city graphs. Each block takes its busiest link and is ranked 0-100 within the city. The busiest tenth are compared with Overture places (food and shopping, confidence 0.6+): untapped frontage is a busy lived-in block with no more shops than the median lived-in block, counted only where the shops mapped within 1 km reach the median lived-in block's, and only blocks with ${TS_MAPPED} or more mapped places of any kind, so a gap in the map is not read as a gap in trade (Overture places are thin in some old bazaars, such as central Indore). Footpaths and service lanes are left out (mapped too unevenly), and every junction counts equally, not weighted by residents or jobs.`,
            refs: 'Sevtsuk A. 2014, Location and agglomeration: the distribution of retail and food businesses in dense urban environments, J. Planning Education and Research 34(4):374; Hillier B. et al. 1993, Natural movement, Environment and Planning B 20:29; Yap W., Stouffs R. & Biljecki F. 2023, Urbanity (MIT); Overture Maps Foundation' },
    ];

    UrbanLenses.register(ENTRIES, { deprivation, ruralrun, forecastcheck, sdgcard, workheat, fossilco2, since1975, afternoonheat, riverwater, fabric, streetpattern, mapquality, throughstreets });
    return { ENTRIES };
})();
