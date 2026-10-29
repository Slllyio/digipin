/**
 * Commons lenses for UrbanLenses: shared conditions every resident lives with, read from national and global open
 * data (how neighbourhoods were built, floods in the news, bad-air days, wind near the ground, the drift between government and private schools, hot summer nights, big roads to come, rain gauge gaps, TB care reach). Registers itself on load, after
 * urban-lenses.js.
 */
const UrbanLensesCommons = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _sumOver, _residents, within } = UrbanLenses._kit;

    const SPACING_KM = 1.5, TOP = 5;

    /** Greedy picks from `cells` by descending `score`, at least `km` apart. */
    function spaced(g, cells, score, k = TOP, km = SPACING_KM) {
        const picks = [];
        for (const i of cells.slice().sort((a, b) => score[b] - score[a])) {
            if (picks.length >= k) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < km)) continue;
            picks.push(i);
        }
        return picks;
    }

    // Still air. Global Wind Atlas mean wind at 10 m: where the breeze barely reaches the street, smoke and exhaust
    // linger. Most Indian city blocks sit under 2 m/s, so the stillest fifth of homes (city-relative) is the target;
    // still blocks with heavy road exhaust (traffic model) are where cleaner traffic or greener streets help most.
    const STILL_MS = 2, KEPT_LOW = 45, STILL_SHARE = 0.2;

    function stillair(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, w10 = c['wind.wind10_ms'], kept = c['wind.wind_kept_pct'];
        const ex = c['traffic_noise.pm25_exhaust_g_day'], pm = c['air_quality.pm25_ugm3'], pop = c['population.population'];
        if (!w10 || !w10.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => _fin(w10[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        let acc = 0, cut = Infinity;          // wind below which the stillest fifth of residents live
        for (const i of idx.slice().sort((a, b) => w10[a] - w10[b])) { acc += v(pop, i); if (acc >= STILL_SHARE * all) { cut = w10[i]; break; } }
        const still = idx.filter(i => w10[i] <= cut);
        const calm = idx.filter(i => w10[i] < STILL_MS).reduce((s, i) => s + v(pop, i), 0);
        const mean = idx.reduce((s, i) => s + v(pop, i) * w10[i], 0) / all;
        const exs = ex ? idx.map(i => v(ex, i)).filter(x => x > 0).sort((a, b) => a - b) : [];
        const exHigh = exs.length ? exs[Math.floor(exs.length * 0.75)] : Infinity;
        const trapped = still.filter(i => v(ex, i) >= exHigh), trappedPop = trapped.reduce((s, i) => s + v(pop, i), 0);
        const score = Float64Array.from({ length: n }, (_, i) => (_fin(w10[i]) ? v(pop, i) * (v(ex, i) + 1) * Math.max(v(pm, i), 1) / Math.max(w10[i], 0.5) : 0));
        const stats = [
            { label: 'Mean wind at 10 m where residents live', value: `${_round(mean, 2)} m/s` },
            { label: `Residents under ${STILL_MS} m/s (light air)`, value: `${_people(calm)} (${_round(100 * calm / all, 1)}%)` },
            { label: 'The stillest fifth of residents live under', value: `${_round(cut, 2)} m/s` },
        ];
        if (kept) {
            const low = idx.filter(i => v(kept, i) > 0 && kept[i] < KEPT_LOW).reduce((s, i) => s + v(pop, i), 0);
            stats.push({ label: `Residents where buildings and terrain keep under ${KEPT_LOW}% of the 100 m wind`, value: `${_people(low)} (${_round(100 * low / all, 1)}%)` });
        }
        if (ex) stats.push({ label: '…of the stillest fifth, on the heaviest road exhaust (top quarter of blocks)', value: `${_people(trappedPop)} residents` });
        spaced(g, still, score, 5).forEach((i, k) => stats.push({ label: `Trapped air ${k + 1}: ${g.codes[i]}`,
            value: `${_round(w10[i], 2)} m/s at 10 m${kept && _fin(kept[i]) ? ` (${_round(kept[i])}% of the 100 m wind)` : ''}${ex ? `; road exhaust ${Math.round(v(ex, i)).toLocaleString('en-IN')} g PM2.5 a day` : ''}${pm ? `; PM2.5 ${_round(v(pm, i), 1)} µg/m³` : ''}; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = w10[i];
        return {
            columns: { wind10_ms: out }, idx, weightKey: 'wind10_ms', noHotspots: true,
            metric: ex ? { label: 'Residents in the stillest fifth of the city on its heaviest road exhaust', value: Math.round(trappedPop), unit: 'people', higherIs: 'worse' }
                : { label: `Residents under ${STILL_MS} m/s mean wind at 10 m`, value: _round(100 * calm / all, 1), unit: '%', higherIs: 'worse' },
            headline: `The average resident gets ${_round(mean, 2)} m/s of wind at 10 m and ${_round(100 * calm / all)}% live in light air under ${STILL_MS} m/s, where smoke and exhaust disperse slowly. The stillest fifth live under ${_round(cut, 2)} m/s${ex && trappedPop ? `, and ${_people(trappedPop)} of them sit on the city's heaviest road exhaust` : ''}.`,
            stats,
        };
    }

    // Government school drift. UDISE+ share of pupils in government (versus private unaided) schools per PIN code, and
    // its change since 2021-22: where families are leaving or returning to government schools.
    const DRIFT_PP = 5;

    function schooldrift(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], sh = c['schools_udise.govt_share_pct'];
        const ch = c['schools_udise.govt_share_change_pp'], age = c['demographics.school_age'];
        if (!pop || !sh || !ch) return null;
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(pop[i]) && pop[i] > 0 && _fin(ch[i]) && _fin(sh[i])) idx.push(i);
        if (idx.length < 5) return null;
        const w = age && idx.some(i => age[i] > 0) ? age : pop, who = w === age ? 'school-age children' : 'residents';
        const all = _sumOver(w, idx, () => true), pct = p => _round(100 * p / (all || 1), 1);
        const mean = a => idx.reduce((s, i) => s + (_fin(w[i]) ? w[i] : 0) * a[i], 0) / (all || 1);
        const leaving = _sumOver(w, idx, i => ch[i] <= -DRIFT_PP), back = _sumOver(w, idx, i => ch[i] >= DRIFT_PP);
        const groups = new Map();       // one group per PIN code
        for (const i of idx) {
            const k = `${sh[i]}|${ch[i]}`;
            const gr = groups.get(k) || { w: 0, rep: i, best: 0 };
            gr.w += _fin(w[i]) ? w[i] : 0;
            if (pop[i] > gr.best) { gr.best = pop[i]; gr.rep = i; }
            groups.set(k, gr);
        }
        const list = [...groups.values()];
        const stats = [
            { label: 'PIN-code school areas with both years', value: String(groups.size) },
            { label: `Pupils in government schools (the average ${who === 'school-age children' ? 'child' : 'resident'}'s PIN code)`, value: `${_round(mean(sh), 1)}%` },
            { label: 'Change since 2021-22, weighted', value: `${_round(mean(ch), 1)} pp` },
            { label: `${who[0].toUpperCase()}${who.slice(1)} where the government share fell ${DRIFT_PP}+ points`, value: `${_people(leaving)} (${pct(leaving)}%)` },
            { label: `…where it rose ${DRIFT_PP}+ points`, value: `${_people(back)} (${pct(back)}%)` },
        ];
        const line = gr => `${_round(ch[gr.rep], 1)} pp to ${_round(sh[gr.rep], 1)}% government; ${_people(gr.w)} ${who}`;
        list.filter(gr => ch[gr.rep] <= -DRIFT_PP).sort((a, b) => ch[a.rep] - ch[b.rep]).slice(0, 5)
            .forEach((gr, k) => stats.push({ label: `Leaving ${k + 1}, around ${g.codes[gr.rep]}`, value: line(gr) }));
        list.filter(gr => ch[gr.rep] >= DRIFT_PP).sort((a, b) => ch[b.rep] - ch[a.rep]).slice(0, 3)
            .forEach((gr, k) => stats.push({ label: `Returning ${k + 1}, around ${g.codes[gr.rep]}`, value: line(gr) }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = ch[i];
        return {
            columns: { govt_share_change_pp: out }, idx, weightKey: 'govt_share_change_pp', noHotspots: true,
            metric: { label: `${who[0].toUpperCase()}${who.slice(1)} where the government school share fell ${DRIFT_PP}+ points since 2021-22`, value: pct(leaving), unit: '%', higherIs: null },
            headline: `In the average ${who === 'school-age children' ? 'child' : 'resident'}'s PIN code, ${_round(mean(sh), 1)}% of pupils in government and private unaided schools are in government schools, ${_round(Math.abs(mean(ch)), 1)} points ${mean(ch) < 0 ? 'down' : 'up'} on 2021-22; ${_people(leaving)} ${who} (${pct(leaving)}%) live where the share fell ${DRIFT_PP} points or more. Shares, not counts, are compared because UDISE+ began verifying individual pupils in 2022-23, and 2021-22 was a pandemic year when many families had moved to government schools.`,
            stats,
        };
    }

    // Bad-air days. GHAP daily PM2.5 (1 km): how many days a year each block breathes air above India's 24-hour
    // standard, and how that count moved since 2017. Annual means hide the winter weeks that do most harm.
    const NAAQS_24H = 60, MANY_DAYS = 100;

    function badairdays(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, d60 = c['pm25_days.days_over_60'], d90 = c['pm25_days.days_over_90'];
        const d120 = c['pm25_days.days_over_120'], ch = c['pm25_days.days_over_60_change'], mean = c['pm25_days.pm25_2022'];
        const pop = c['population.population'];
        if (!d60 || !d60.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => _fin(d60[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const avg = a => idx.reduce((s, i) => s + v(pop, i) * v(a, i), 0) / all;
        const many = idx.filter(i => d60[i] >= MANY_DAYS).reduce((s, i) => s + v(pop, i), 0);
        const stats = [
            { label: `Days above ${NAAQS_24H} µg/m³ in 2022 (the average resident)`, value: `${Math.round(avg(d60))}` },
        ];
        if (d90) stats.push({ label: '…at "poor" or worse (over 90 µg/m³)', value: `${Math.round(avg(d90))}` });
        if (d120) stats.push({ label: '…at "very poor" or worse (over 120 µg/m³)', value: `${Math.round(avg(d120))}` });
        stats.push({ label: `Residents with ${MANY_DAYS}+ days above the standard`, value: `${_people(many)} (${_round(100 * many / all, 1)}%)` });
        if (mean) stats.push({ label: 'Mean PM2.5, 2022 (the average resident)', value: `${_round(avg(mean), 1)} µg/m³` });
        if (ch && idx.some(i => _fin(ch[i]))) stats.push({ label: 'Change in days above the standard since 2017 (the average resident)', value: `${avg(ch) > 0 ? '+' : ''}${Math.round(avg(ch))}` });
        const score = Float64Array.from({ length: n }, (_, i) => v(pop, i) * (v(d90, i) + v(d60, i) / 4));
        spaced(g, idx, score, 5).forEach((i, k) => stats.push({ label: `Worst air ${k + 1}: ${g.codes[i]}`,
            value: `${Math.round(d60[i])} days over ${NAAQS_24H}${d90 ? `, ${Math.round(v(d90, i))} over 90` : ''}${mean ? `; mean ${_round(v(mean, i), 1)} µg/m³` : ''}; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = d60[i];
        const a60 = Math.round(avg(d60));
        return {
            columns: { days_over_60: out }, idx, weightKey: 'days_over_60', noHotspots: true,
            metric: { label: `Days in 2022 above the ${NAAQS_24H} µg/m³ PM2.5 standard, average resident`, value: a60, unit: 'days', higherIs: 'worse' },
            headline: `The average resident breathed PM2.5 above India's 24-hour standard of ${NAAQS_24H} µg/m³ on ${a60} days in 2022${d90 ? `, ${Math.round(avg(d90))} of them 'poor' or worse` : ''}; ${_people(many)} residents (${_round(100 * many / all, 1)}%) had ${MANY_DAYS} or more such days.${ch && idx.some(i => _fin(ch[i])) ? ` That is ${Math.abs(Math.round(avg(ch)))} days ${avg(ch) < 0 ? 'fewer' : 'more'} than in 2017 (a modelled estimate; weather years differ).` : ''}`,
            stats,
        };
    }

    // Floods in the news. Groundsource (Google Research, 2026) places on news-reported flood days, geocoded to a street,
    // landmark or neighbourhood: where the same spots flood year after year, in every city, not just those with
    // official flood maps.
    const NEWS_KM = 0.5, NEWS_REPEAT = 3;

    function floodnews(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, days = c['news_floods.flood_news_days'], recent = c['news_floods.flood_news_recent'];
        const last = c['news_floods.flood_news_last'], pop = c['population.population'];
        if (!days || !days.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const d = Float64Array.from({ length: n }, (_, i) => v(days, i));
        const near = within(g, d, NEWS_KM), idx = _residents(fr);
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const exposed = idx.filter(i => near[i] >= NEWS_REPEAT), expPop = exposed.reduce((s, i) => s + v(pop, i), 0);
        const spots = [];
        for (let i = 0; i < n; i++) if (d[i] > 0) spots.push(i);
        const totalDays = spots.reduce((s, i) => s + d[i], 0), rec = recent ? spots.reduce((s, i) => s + v(recent, i), 0) : 0;
        const stats = [
            { label: 'Blocks named in flood news (2000 to 2026)', value: String(spots.length) },
            { label: 'Block-days of reported flooding', value: `${Math.round(totalDays).toLocaleString('en-IN')}${recent ? `, ${Math.round(rec).toLocaleString('en-IN')} since 2021` : ''}` },
            { label: `Residents within ${NEWS_KM * 1000} m of spots reported flooded on ${NEWS_REPEAT}+ days`, value: `${_people(expPop)} (${_round(100 * expPop / all, 1)}%)` },
        ];
        spaced(g, spots, d, 8).forEach((i, k) => stats.push({ label: `Repeat flood spot ${k + 1}: ${g.codes[i]}`,
            value: `${Math.round(d[i])} reported days${recent ? `, ${Math.round(v(recent, i))} since 2021` : ''}${last && _fin(last[i]) ? `, latest ${last[i]}` : ''}` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = Math.min(near[i], 30);
        return {
            columns: { flood_news_500m: out }, idx, weightKey: 'flood_news_500m', noHotspots: true,
            metric: { label: `Residents within ${NEWS_KM * 1000} m of a spot reported flooded on ${NEWS_REPEAT}+ days`, value: Math.round(expPop), unit: 'people', higherIs: 'worse' },
            headline: `News reports placed floods in ${spots.length} blocks here on ${Math.round(totalDays).toLocaleString('en-IN')} block-days since 2000; ${_people(expPop)} residents (${_round(100 * expPop / all, 1)}%) live within ${NEWS_KM * 1000} m of a spot reported flooded on ${NEWS_REPEAT} or more days. These are reported floods: busy, newsworthy places and recent years are over-represented, and quiet streets that flood go unreported.`,
            stats,
        };
    }

    // How neighbourhoods were built. WRI's intra-urban land use map (2020, 5 m) sorts residential ground into
    // unplanned (atomistic), informal subdivisions, formal subdivisions and housing projects: who lives where the plots,
    // lanes and services were never planned, and how much road and open space those areas got.
    const UNPLANNED_PCT = 50;

    function howbuilt(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, at = c['urban_form.res_atomistic_pct'], inf = c['urban_form.res_informal_pct'];
        const fo = c['urban_form.res_formal_pct'], pr = c['urban_form.res_project_pct'], road = c['urban_form.ulu_road_pct'];
        const open = c['urban_form.ulu_open_pct'], pop = c['population.population'];
        if (!at || !fo || !at.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => _fin(at[i]) && _fin(fo[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const un = Float64Array.from({ length: n }, (_, i) => (_fin(at[i]) ? v(at, i) + v(inf, i) : NaN));
        const share = a => _round(idx.reduce((s, i) => s + v(pop, i) * v(a, i), 0) / all, 1);
        const unpl = idx.filter(i => un[i] > UNPLANNED_PCT), plan = idx.filter(i => un[i] <= UNPLANNED_PCT);
        const unPop = unpl.reduce((s, i) => s + v(pop, i), 0);
        const mean = (a, set) => { const w = set.reduce((s, i) => s + v(pop, i), 0); return w ? set.reduce((s, i) => s + v(pop, i) * v(a, i), 0) / w : 0; };
        const stats = [
            { label: 'Residents\' homes on unplanned, irregular plots', value: `${share(at)}%` },
            { label: '…on informal subdivisions (regular plots laid out without approval)', value: `${share(inf)}%` },
            { label: '…on formal, approved subdivisions', value: `${share(fo)}%` },
            { label: '…in housing projects', value: `${share(pr)}%` },
            { label: `Residents in mostly unplanned or informal blocks (over ${UNPLANNED_PCT}%)`, value: `${_people(unPop)} (${_round(100 * unPop / all, 1)}%)` },
        ];
        if (road) stats.push({ label: 'Road share of the ground, unplanned vs planned blocks', value: `${_round(mean(road, unpl), 1)}% vs ${_round(mean(road, plan), 1)}%` });
        if (open) stats.push({ label: 'Open space share, unplanned vs planned blocks', value: `${_round(mean(open, unpl), 1)}% vs ${_round(mean(open, plan), 1)}%` });
        const score = Float64Array.from({ length: n }, (_, i) => (_fin(un[i]) ? v(pop, i) * un[i] : 0));
        spaced(g, unpl, score, 5).forEach((i, k) => stats.push({ label: `Unplanned area ${k + 1}: ${g.codes[i]}`,
            value: `${Math.round(v(at, i))}% unplanned, ${Math.round(v(inf, i))}% informal plots${road ? `; roads ${_round(v(road, i), 1)}% of the ground` : ''}; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = un[i];
        return {
            columns: { res_unplanned_pct: out }, idx, weightKey: 'res_unplanned_pct', noHotspots: true,
            metric: { label: `Residents in mostly unplanned or informal blocks`, value: _round(100 * unPop / all, 1), unit: '%', higherIs: null },
            headline: `By the satellite land use model, ${share(at)}% of residents' homes stand on unplanned, irregular plots and ${share(inf)}% on informal subdivisions laid out without approval; ${_people(unPop)} residents (${_round(100 * unPop / all, 1)}%) live in blocks that are mostly one or the other${road ? `, where roads take ${_round(mean(road, unpl), 1)}% of the ground against ${_round(mean(road, plan), 1)}% in planned blocks` : ''}.`,
            stats,
        };
    }

    // Hot nights. ECOSTRESS 70 m surface temperature on cloud-free summer nights: blocks whose streets and roofs hold the
    // day's heat when bodies need to cool. Ranked against the city's own median block; elderly and young children
    // in the hottest-night blocks are the people most at risk.
    const HOT_NIGHT_C = 1;

    function hotnights(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, an = c['night_heat.night_anomaly_c'], lst = c['night_heat.night_lst_c'];
        const pop = c['population.population'], old = c['demographics.elderly_60plus'], kid = c['demographics.under5'];
        const day = c['surface_heat.lst_day_c'], tree = c['vegetation.tree_canopy_pct'], pm = c['pm_heat.pm_lst_c'];
        if (!lst || !lst.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => _fin(lst[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        let acc = 0, med = NaN;               // the night the median resident sleeps through
        for (const i of idx.slice().sort((a, b) => lst[a] - lst[b])) { acc += v(pop, i); if (acc >= all / 2) { med = lst[i]; break; } }
        const ex = Float64Array.from({ length: n }, (_, i) => (_fin(lst[i]) ? lst[i] - med : NaN));
        const hot = idx.filter(i => ex[i] >= HOT_NIGHT_C), hotPop = hot.reduce((s, i) => s + v(pop, i), 0);
        const sorted = idx.map(i => lst[i]).sort((a, b) => a - b);
        const spread = sorted[Math.floor(0.95 * (sorted.length - 1))] - sorted[Math.floor(0.05 * (sorted.length - 1))];
        const uhi = an ? idx.reduce((s, i) => s + v(pop, i) * v(an, i), 0) / all : NaN;
        const stats = [
            { label: 'Summer night surface temperature under the median resident', value: `${_round(med, 1)} °C` },
            { label: 'Spread across homes, coolest to hottest twentieth of blocks', value: `${_round(spread, 1)} °C` },
        ];
        if (pm && idx.filter(i => _fin(pm[i])).length >= idx.length / 2) {     // afternoon scenes are sparse in cloudier cities
            const drop = set => { const s = set.filter(i => _fin(pm[i])), w = s.reduce((a, i) => a + v(pop, i), 0); return w ? s.reduce((a, i) => a + v(pop, i) * (pm[i] - lst[i]), 0) / w : NaN; };
            const hotSet = idx.filter(i => lst[i] - med >= HOT_NIGHT_C), rest = idx.filter(i => lst[i] - med < HOT_NIGHT_C);
            stats.push({ label: 'Overnight cooling, summer afternoon to night (where residents live)', value: `${_round(drop(idx), 1)} °C` });
            if (_fin(drop(hotSet)) && _fin(drop(rest))) stats.push({ label: 'Overnight cooling, hottest-night blocks vs the rest', value: `${_round(drop(hotSet), 1)} vs ${_round(drop(rest), 1)} °C` });
        }
        if (_fin(uhi)) stats.push({ label: 'Average resident\'s night above the median block of the wider region (heat island)', value: `${uhi >= 0 ? '+' : ''}${_round(uhi, 1)} °C` });
        stats.push({ label: `Residents ${HOT_NIGHT_C} °C or more above the median resident's night`, value: `${_people(hotPop)} (${_round(100 * hotPop / all, 1)}%)` });
        if (old) stats.push({ label: '…of them aged 60 and over', value: _people(_sumOver(old, hot, i => _fin(old[i]))) });
        if (kid) stats.push({ label: '…of them under 5', value: _people(_sumOver(kid, hot, i => _fin(kid[i]))) });
        if (tree && hot.length) {
            const tm = set => { const w = set.reduce((s, i) => s + v(pop, i), 0); return w ? set.reduce((s, i) => s + v(pop, i) * v(tree, i), 0) / w : 0; };
            stats.push({ label: 'Tree canopy, hottest-night blocks vs the rest', value: `${_round(tm(hot), 1)}% vs ${_round(tm(idx.filter(i => ex[i] < HOT_NIGHT_C)), 1)}%` });
        }
        const score = Float64Array.from({ length: n }, (_, i) => (_fin(ex[i]) ? (v(pop, i) + 3 * v(old, i)) * Math.max(ex[i], 0) : 0));
        spaced(g, idx.filter(i => ex[i] > 0), score, 5).forEach((i, k) => stats.push({ label: `Hot night ${k + 1}: ${g.codes[i]}`,
            value: `${_round(lst[i], 1)} °C at night (+${_round(ex[i], 1)} °C)${pm && _fin(pm[i]) ? `, ${_round(pm[i], 1)} °C in the afternoon` : day && _fin(day[i]) ? `, ${_round(day[i], 1)} °C by day` : ''}${tree ? `; tree canopy ${_round(v(tree, i), 1)}%` : ''}; ${_people(v(pop, i))} residents${old ? `, ${_people(v(old, i))} aged 60+` : ''}` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = ex[i];
        const hotOld = old ? _sumOver(old, hot, i => _fin(old[i])) : 0;
        return {
            columns: { night_excess_c: out }, idx, weightKey: 'night_excess_c', noHotspots: true,
            metric: { label: `Residents ${HOT_NIGHT_C} °C or more above the median resident's summer night`, value: _round(100 * hotPop / all, 1), unit: '%', higherIs: 'worse' },
            headline: `On cloud-free summer nights the ground under the median resident stays at ${_round(med, 1)} °C${!_fin(uhi) ? '' : Math.abs(uhi) < 0.1 ? `, about the same as the wider region's median block` : `, ${_round(Math.abs(uhi), 1)} °C ${uhi >= 0 ? 'warmer' : 'cooler'} than the wider region's median block`}, with ${_round(spread, 1)} °C between the coolest and hottest homes; ${_people(hotPop)} residents (${_round(100 * hotPop / all, 1)}%) live where streets and roofs stay ${HOT_NIGHT_C} °C or more hotter still${hotOld ? `, ${_people(hotOld)} of them aged 60 and over` : ''}.`,
            stats,
        };
    }

    // Big roads to come. Bengaluru's planned elevated corridors and the Peripheral Ring Road from the alignment maps on OpenCity: who lives on the line (construction years, land take, a deck at bedroom height), who lives near it
    // and what stands in its way.
    const ROAD_NEAR_M = 500, ROAD_REACH_M = 2000;
    const NEW_ROADS = {
        bengaluru: ['Marenahalli–Kanakapura Main Road', 'Yeshwanthapura–Old Madras Road', 'Old Madras Road–Silk Board', 'Sholay Circle–St. John\'s Hospital',
            'Sirsi Circle–Nayandahalli', 'Minerva Circle–Hudson Circle', 'Ananda Bhavan–Raghuvanahalli', 'Konanakunte Cross', 'Doddaballapura Road–NH-7',
            'West of Chord Road–Outer Ring Road', 'MEI Junction'].map(n => `${n} elevated corridor`).concat('Bengaluru Business Corridor (Peripheral Ring Road)', 'NPKG Layout arterial road'),
    };

    function newroads(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, dist = c['new_roads.newroad_dist_m'], len = c['new_roads.newroad_len_m'], ref = c['new_roads.newroad_ref'];
        const pop = c['population.population'], noise = c['traffic_noise.lden_db'], trees = c['tree_census.trees'], big = c['tree_census.big_trees'];
        const schools = c['schools_official.schools'], lv = c['land_value.value_index'];
        if (!dist || !dist.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const res = _residents(fr), idx = res.filter(i => _fin(dist[i]));
        if (idx.length < 5) return null;
        const sumPop = set => set.reduce((s, i) => s + v(pop, i), 0);
        const on = idx.filter(i => v(len, i) > 0), near = idx.filter(i => dist[i] <= ROAD_NEAR_M), reach = idx.filter(i => dist[i] <= ROAD_REACH_M);
        const onAll = Array.from({ length: n }, (_, i) => i).filter(i => v(len, i) > 0);
        const km = onAll.reduce((s, i) => s + v(len, i), 0) / 1000;
        const names = NEW_ROADS[fr.city] || [];
        const nearPop = sumPop(near);
        const stats = [
            { label: 'Planned alignment on the map', value: `${_round(km, 1)} km` },
            { label: 'Residents in blocks the alignment crosses', value: _people(sumPop(on)) },
            { label: `Residents within ${ROAD_NEAR_M} m`, value: _people(nearPop) },
            { label: `Residents within ${ROAD_REACH_M / 1000} km`, value: _people(sumPop(reach)) },
        ];
        if (noise && on.some(i => _fin(noise[i]))) {
            const m = on.filter(i => _fin(noise[i])), w = sumPop(m) || m.length;
            stats.push({ label: 'Road noise today on the alignment (Lden, modelled)', value: `${_round(m.reduce((s, i) => s + (sumPop([i]) || 1) * noise[i], 0) / w, 1)} dB` });
        }
        if (trees) stats.push({ label: 'Trees counted in blocks the alignment crosses (tree census)', value: `${Math.round(onAll.reduce((s, i) => s + v(trees, i), 0)).toLocaleString('en-IN')}${big ? `, ${Math.round(onAll.reduce((s, i) => s + v(big, i), 0)).toLocaleString('en-IN')} of them big` : ''}` });
        if (schools) stats.push({ label: 'Schools in blocks the alignment crosses', value: String(Math.round(onAll.reduce((s, i) => s + v(schools, i), 0))) });
        if (lv) {
            const mean = set => { const w = sumPop(set); return w ? set.reduce((s, i) => s + v(pop, i) * v(lv, i), 0) / w : 0; };
            stats.push({ label: `Land value index within ${ROAD_NEAR_M} m vs the rest of the city`, value: `${_round(mean(near), 1)} vs ${_round(mean(res.filter(i => !(dist[i] <= ROAD_NEAR_M))), 1)}` });
        }
        let top = null;
        if (ref) {
            const by = new Map();
            for (const i of near) { const r = Math.round(v(ref, i)); by.set(r, (by.get(r) || 0) + v(pop, i)); }
            const ranked = [...by].sort((a, b) => b[1] - a[1]);
            if (ranked.length) top = names[ranked[0][0] - 1] || null;
            ranked.slice(0, 5).forEach(([r, p], k) => stats.push({ label: `Most residents nearby ${k + 1}: ${names[r - 1] || `road ${r}`}`, value: `${_people(p)} within ${ROAD_NEAR_M} m` }));
        }
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = dist[i];
        return {
            columns: { newroad_dist_m: out }, idx, weightKey: 'newroad_dist_m', noHotspots: true,
            metric: { label: `Residents within ${ROAD_NEAR_M} m of a planned elevated corridor or ring road`, value: Math.round(nearPop), unit: 'people', higherIs: null },
            headline: `${_round(km, 1)} km of planned elevated corridor, ring road and arterial road crosses this map; ${_people(sumPop(on))} residents live in the blocks it runs through and ${_people(nearPop)} within ${ROAD_NEAR_M} m, who face the construction years and the traffic it brings${top ? `, most of them along the ${top}` : ''}.`,
            stats,
        };
    }

    // Rain gauge gaps. KSNDMC's telemetric rain gauges report every 15 minutes and feed Bengaluru's flood alerts; where
    // the nearest gauge is far, a cloudburst over a low-lying street can go unmeasured. New gauges go where reported
    // flood spots and waterlogging-prone homes sit beyond reach of one.
    const GAUGE_KM = 2, WLOG_PRONE = 60;

    function raingaugegap(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, rg = c['rain_gauges.rain_gauges'], ws = c['rain_gauges.weather_stations'];
        const pop = c['population.population'], spots = c['flood_reports.flood_spots'], wl = c['waterlogging.waterlogging_index'];
        if (!rg || !rg.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const m = Float64Array.from({ length: n }, (_, i) => v(rg, i) + v(ws, i));
        const near = within(g, m, GAUGE_KM);
        const idx = _residents(fr);
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const gauges = Math.round(Array.from(rg).reduce((s, x) => s + (_fin(x) ? x : 0), 0)), stations = ws ? Math.round(Array.from(ws).reduce((s, x) => s + (_fin(x) ? x : 0), 0)) : 0;
        const far = idx.filter(i => near[i] < 0.5), farPop = far.reduce((s, i) => s + v(pop, i), 0);
        const prone = i => v(wl, i) >= WLOG_PRONE;
        const stats = [
            { label: 'Telemetric rain gauges on the map', value: `${gauges}${stations ? ` (plus ${stations} weather stations)` : ''}` },
            { label: 'Residents per gauge', value: _people(all / ((gauges + stations) || 1)) },
            { label: `Residents more than ${GAUGE_KM} km from any gauge`, value: `${_people(farPop)} (${_round(100 * farPop / all, 1)}%)` },
        ];
        const wet = i => v(spots, i) > 0;
        if (spots) {
            const blocks = Array.from({ length: n }, (_, i) => i).filter(wet);
            stats.push({ label: `Blocks near a reported flood spot that are more than ${GAUGE_KM} km from a gauge`, value: `${blocks.filter(i => near[i] < 0.5).length} of ${blocks.length}` });
        }
        if (wl) {
            const p = far.filter(prone).reduce((s, i) => s + v(pop, i), 0);
            stats.push({ label: `Residents more than ${GAUGE_KM} km from a gauge in waterlogging-prone blocks (index ${WLOG_PRONE}+)`, value: _people(p) });
        }
        const need = Float64Array.from({ length: n }, (_, i) => (near[i] < 0.5 ? (wet(i) ? 20000 : 0) + v(pop, i) * (prone(i) ? 2 : 1) : 0));
        const gain = within(g, need, GAUGE_KM), farPopNear = within(g, Float64Array.from({ length: n }, (_, j) => (near[j] < 0.5 ? v(pop, j) : 0)), GAUGE_KM);
        const farSpotsNear = spots ? within(g, Float64Array.from({ length: n }, (_, j) => (near[j] < 0.5 && wet(j) ? 1 : 0)), GAUGE_KM) : null;
        spaced(g, far, gain, 5).forEach((i, k) => stats.push({ label: `New gauge ${k + 1}: ${g.codes[i]}`,
            value: `${_people(farPopNear[i])} unmeasured residents within ${GAUGE_KM} km${farSpotsNear ? `, ${Math.round(farSpotsNear[i])} blocks near reported flood spots` : ''}` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = Math.min(near[i], 5);
        return {
            columns: { gauges_2km: out }, idx, weightKey: 'gauges_2km', noHotspots: true,
            metric: { label: `Residents more than ${GAUGE_KM} km from a telemetric rain gauge`, value: Math.round(farPop), unit: 'people', higherIs: 'worse' },
            headline: `${gauges} telemetric rain gauges${stations ? ` and ${stations} weather stations` : ''} measure this city's rain every 15 minutes; ${_people(farPop)} residents (${_round(100 * farPop / all, 1)}%) live more than ${GAUGE_KM} km from the nearest, where a downpour over their street goes unmeasured.`,
            stats,
        };
    }

    // TB care reach. Karnataka's TB units and CBNAAT testing sites (KGIS): TB clusters in crowded, poorer housing, so the
    // test is how far slum residents must travel to the unit that diagnoses and treats them.
    const TBU_KM = 3, TEST_KM = 5;

    function tbcare(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, tbu = c['tb_care.tb_units'], test = c['tb_care.tb_tests'], dr = c['tb_care.drtb_centres'];
        const pop = c['population.population'], slum = c['slums_mapped.slum_pct'];
        if (!tbu || !tbu.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const count = a => (a ? Math.round(Array.from(a).reduce((s, x) => s + (_fin(x) ? x : 0), 0)) : 0);
        const nearU = within(g, Float64Array.from({ length: n }, (_, i) => v(tbu, i) + v(dr, i)), TBU_KM);
        const nearT = test ? within(g, Float64Array.from({ length: n }, (_, i) => v(test, i)), TEST_KM) : null;
        const idx = _residents(fr);
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const slumPop = i => v(pop, i) * Math.min(v(slum, i), 100) / 100;
        const far = idx.filter(i => nearU[i] < 0.5), farPop = far.reduce((s, i) => s + v(pop, i), 0);
        const units = count(tbu), tests = count(test);
        const stats = [
            { label: 'TB units on the map', value: `${units}${dr ? ` (plus ${count(dr)} drug-resistant and district TB centres)` : ''}` },
            { label: 'Residents per TB unit', value: _people(all / (units || 1)) },
            { label: `Residents more than ${TBU_KM} km from a TB unit`, value: `${_people(farPop)} (${_round(100 * farPop / all, 1)}%)` },
        ];
        if (slum) {
            const sAll = idx.reduce((s, i) => s + slumPop(i), 0), sFar = far.reduce((s, i) => s + slumPop(i), 0);
            if (sAll > 0) stats.push({ label: `Residents of mapped slums more than ${TBU_KM} km from a TB unit`, value: `${_people(sFar)} of ${_people(sAll)} (${_round(100 * sFar / sAll, 1)}%)` });
        }
        if (nearT) {
            const tFar = idx.filter(i => nearT[i] < 0.5).reduce((s, i) => s + v(pop, i), 0);
            stats.push({ label: `Residents more than ${TEST_KM} km from a CBNAAT rapid test site (${tests} sites)`, value: `${_people(tFar)} (${_round(100 * tFar / all, 1)}%)` });
        }
        const need = Float64Array.from({ length: n }, (_, i) => (nearU[i] < 0.5 ? v(pop, i) + 4 * slumPop(i) : 0));
        const gain = within(g, need, TBU_KM);
        const farNear = within(g, Float64Array.from({ length: n }, (_, j) => (nearU[j] < 0.5 ? v(pop, j) : 0)), TBU_KM);
        const slumNear = slum ? within(g, Float64Array.from({ length: n }, (_, j) => (nearU[j] < 0.5 ? slumPop(j) : 0)), TBU_KM) : null;
        spaced(g, far, gain, 5, 2 * TBU_KM).forEach((i, k) => stats.push({ label: `New TB unit ${k + 1}: ${g.codes[i]}`,
            value: `${_people(farNear[i])} residents beyond reach within ${TBU_KM} km${slumNear && slumNear[i] >= 1 ? `, ${_people(slumNear[i])} of them in mapped slums` : ''}` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = Math.min(nearU[i], 5);
        return {
            columns: { tb_units_3km: out }, idx, weightKey: 'tb_units_3km', noHotspots: true,
            metric: { label: `Residents more than ${TBU_KM} km from a TB unit`, value: Math.round(farPop), unit: 'people', higherIs: 'worse' },
            headline: `${units} TB units diagnose and treat TB for this city, one per ${_people(all / (units || 1))} residents; ${_people(farPop)} residents (${_round(100 * farPop / all, 1)}%) live more than ${TBU_KM} km from one${tests ? `, and ${tests} sites run the rapid CBNAAT test` : ''}.`,
            stats,
        };
    }

    // Citizen service centres. Karnataka's Common Service Centres and Grama One centres (OpenCity maps): where people get
    // Aadhaar updates, certificates, bill payments and scheme applications done, which the poor and the elderly do in person.
    const CSC_KM = 1;

    function servicecentres(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, csc = c['service_centres.csc'], g1 = c['service_centres.grama_one'], aad = c['service_centres.aadhaar'];
        const pop = c['population.population'], old = c['demographics.elderly_60plus'], slum = c['slums_mapped.slum_pct'];
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const count = a => (a ? Math.round(Array.from(a).reduce((s, x) => s + (_fin(x) ? x : 0), 0)) : 0);
        const kinds = [[csc, 'Common Service Centres'], [g1, 'Grama One centres'], [aad, 'Aadhaar enrolment centres']].map(([a, l]) => [count(a), l]).filter(([k]) => k > 0);
        if (!kinds.length) return null;
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(csc, i) + v(g1, i) + v(aad, i)), CSC_KM);
        const idx = _residents(fr);
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const centres = kinds.reduce((s, [k]) => s + k, 0);
        const far = idx.filter(i => near[i] < 0.5), farPop = far.reduce((s, i) => s + v(pop, i), 0);
        const stats = [
            { label: `${kinds[0][1]} on the map`, value: `${kinds[0][0]}${kinds.slice(1).map(([k, l]) => ` (plus ${k} ${l})`).join('')}` },
            { label: 'Residents per centre', value: _people(all / (centres || 1)) },
            { label: `Residents more than ${CSC_KM} km from a centre`, value: `${_people(farPop)} (${_round(100 * farPop / all, 1)}%)` },
        ];
        if (old) {
            const oAll = idx.reduce((s, i) => s + v(old, i), 0), oFar = far.reduce((s, i) => s + v(old, i), 0);
            if (oAll > 0) stats.push({ label: `Residents aged 60+ more than ${CSC_KM} km from a centre`, value: `${_people(oFar)} of ${_people(oAll)} (${_round(100 * oFar / oAll, 1)}%)` });
        }
        const slumPop = i => v(pop, i) * Math.min(v(slum, i), 100) / 100;
        if (slum) {
            const sAll = idx.reduce((s, i) => s + slumPop(i), 0), sFar = far.reduce((s, i) => s + slumPop(i), 0);
            if (sAll > 0) stats.push({ label: `Residents of mapped slums more than ${CSC_KM} km from a centre`, value: `${_people(sFar)} of ${_people(sAll)} (${_round(100 * sFar / sAll, 1)}%)` });
        }
        const need = Float64Array.from({ length: n }, (_, i) => (near[i] < 0.5 ? v(pop, i) + 2 * v(old, i) + 2 * slumPop(i) : 0));
        const gain = within(g, need, CSC_KM);
        const farNear = within(g, Float64Array.from({ length: n }, (_, j) => (near[j] < 0.5 ? v(pop, j) : 0)), CSC_KM);
        spaced(g, far, gain, 5, 2 * CSC_KM).forEach((i, k) => stats.push({ label: `New centre ${k + 1}: ${g.codes[i]}`,
            value: `${_people(farNear[i])} residents beyond reach within ${CSC_KM} km` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = Math.min(near[i], 10);
        return {
            columns: { service_centres_1km: out }, idx, weightKey: 'service_centres_1km', noHotspots: true,
            metric: { label: `Residents more than ${CSC_KM} km from a citizen service centre`, value: Math.round(farPop), unit: 'people', higherIs: 'worse' },
            headline: `${centres} ${kinds.length === 1 && aad ? 'Aadhaar enrolment centres handle Aadhaar enrolment and updates' : 'citizen service centres handle Aadhaar updates, certificates and bill payments'} here, one per ${_people(all / (centres || 1))} residents; ${_people(farPop)} residents (${_round(100 * farPop / all, 1)}%) live more than ${CSC_KM} km from one.`,
            stats,
        };
    }

    // Recycling reach. Drop-off centres for reusables, recyclables and e-waste (BBMP RRR, KSPCB, GCC resource recovery
    // centres), and the homes right next to Chennai's compost yards and biogas plants.
    const RECYCLE_KM = 1, PROCESS_M = 250;

    function recycling(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, rc = c['waste_recovery.recovery_centres'], ps = c['waste_recovery.processing_sites'];
        const pop = c['population.population'];
        if (!rc || !rc.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const count = a => (a ? Math.round(Array.from(a).reduce((s, x) => s + (_fin(x) ? x : 0), 0)) : 0);
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(rc, i)), RECYCLE_KM);
        const idx = _residents(fr);
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const centres = count(rc), sites = count(ps);
        const far = idx.filter(i => near[i] < 0.5), farPop = far.reduce((s, i) => s + v(pop, i), 0);
        const stats = [
            { label: 'Recycling drop-off centres on the map', value: String(centres) },
            { label: 'Residents per centre', value: _people(all / (centres || 1)) },
            { label: `Residents more than ${RECYCLE_KM} km from a centre`, value: `${_people(farPop)} (${_round(100 * farPop / all, 1)}%)` },
        ];
        if (sites) {
            const nextTo = within(g, Float64Array.from({ length: n }, (_, i) => v(ps, i)), PROCESS_M / 1000);
            const besidePop = idx.filter(i => nextTo[i] >= 0.5).reduce((s, i) => s + v(pop, i), 0);
            stats.push({ label: 'Wet-waste processing sites (compost yards, biogas plants)', value: String(sites) });
            stats.push({ label: `Residents within about ${PROCESS_M} m of a processing site`, value: `${_people(besidePop)} (${_round(100 * besidePop / all, 1)}%)` });
        }
        const gain = within(g, Float64Array.from({ length: n }, (_, i) => (near[i] < 0.5 ? v(pop, i) : 0)), RECYCLE_KM);
        spaced(g, far, gain, 5, 2 * RECYCLE_KM).forEach((i, k) => stats.push({ label: `New drop-off centre ${k + 1}: ${g.codes[i]}`,
            value: `${_people(gain[i])} residents beyond reach within ${RECYCLE_KM} km` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = Math.min(near[i], 5);
        return {
            columns: { recycle_1km: out }, idx, weightKey: 'recycle_1km', noHotspots: true,
            metric: { label: `Residents more than ${RECYCLE_KM} km from a recycling drop-off centre`, value: Math.round(farPop), unit: 'people', higherIs: 'worse' },
            headline: `${centres} drop-off centres take reusables, recyclables and e-waste here, one per ${_people(all / (centres || 1))} residents; ${_people(farPop)} residents (${_round(100 * farPop / all, 1)}%) live more than ${RECYCLE_KM} km from one.`,
            stats,
        };
    }

    // Public land bank. The Greater Bengaluru Authority's property register: how much land the corporation owns, which plots
    // stand vacant, and which vacant plots sit among residents with no public clinic or anganwadi nearby.
    const LAND_NEAR_KM = 0.5, CLINIC_KM = 1;

    function publicland(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, plots = c['public_land.gba_plots'], land = c['public_land.gba_land_m2'];
        const vac = c['public_land.vacant_plots'], vacM2 = c['public_land.vacant_m2'], amen = c['public_land.amenity_plots'];
        const pop = c['population.population'], clinic = c['public_care.primary'], anga = c['anganwadis.centres'];
        if (!plots || !plots.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const sum = a => (a ? Array.from(a).reduce((s, x) => s + (_fin(x) ? x : 0), 0) : 0);
        const idx = _residents(fr);
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const vacBlocks = Array.from({ length: n }, (_, i) => i).filter(i => v(vac, i) > 0);
        const nearVac = within(g, Float64Array.from({ length: n }, (_, i) => v(vac, i)), LAND_NEAR_KM);
        const nearVacPop = idx.filter(i => nearVac[i] >= 0.5).reduce((s, i) => s + v(pop, i), 0);
        const stats = [
            { label: 'Corporation properties located to the plot', value: `${Math.round(sum(plots)).toLocaleString('en-IN')} (${_round(sum(land) / 1e4, 1)} ha recorded)` },
            { label: 'Vacant plots', value: `${Math.round(sum(vac))} (${_round(sum(vacM2) / 1e4, 1)} ha)` },
            { label: 'Plots used for schools, clinics, anganwadis, libraries, halls, toilets or markets', value: String(Math.round(sum(amen))) },
            { label: `Residents within ${LAND_NEAR_KM * 1000} m of a vacant corporation plot`, value: `${_people(nearVacPop)} (${_round(100 * nearVacPop / all, 1)}%)` },
        ];
        const nearClinic = clinic ? within(g, Float64Array.from({ length: n }, (_, i) => v(clinic, i)), CLINIC_KM) : null;
        const nearAnga = anga ? within(g, Float64Array.from({ length: n }, (_, i) => v(anga, i)), LAND_NEAR_KM) : null;
        const gapPop = Float64Array.from({ length: n }, (_, i) => v(pop, i) * ((nearClinic && nearClinic[i] < 0.5 ? 1 : 0) + (nearAnga && nearAnga[i] < 0.5 ? 1 : 0)));
        const gain = within(g, gapPop, CLINIC_KM);
        if (nearClinic || nearAnga) {
            const inGap = vacBlocks.filter(i => (nearClinic && nearClinic[i] < 0.5) || (nearAnga && nearAnga[i] < 0.5));
            stats.push({ label: `Vacant plots where there is no public clinic within ${CLINIC_KM} km${nearAnga ? ` or no anganwadi within ${LAND_NEAR_KM * 1000} m` : ''}`, value: `${Math.round(inGap.reduce((s, i) => s + v(vac, i), 0))} of ${Math.round(sum(vac))}` });
            spaced(g, vacBlocks.filter(i => gain[i] > 0), Float64Array.from({ length: n }, (_, i) => gain[i] * Math.sqrt(1 + v(vacM2, i) / 100)), 5).forEach((i, k) => stats.push({ label: `Vacant plot to put to use ${k + 1}: ${g.codes[i]}`,
                value: `${_round(v(vacM2, i), 0).toLocaleString('en-IN')} m² vacant; ${nearClinic && nearClinic[i] < 0.5 ? 'no public clinic' : 'a public clinic'} within ${CLINIC_KM} km${nearAnga ? `, ${nearAnga[i] < 0.5 ? 'no anganwadi' : 'an anganwadi'} within ${LAND_NEAR_KM * 1000} m` : ''}` }));
        }
        const out = new Float64Array(n).fill(NaN);
        for (let i = 0; i < n; i++) if (v(plots, i) > 0) out[i] = v(land, i);
        return {
            columns: { gba_land_m2: out }, idx, weightKey: 'gba_land_m2', noHotspots: true,
            metric: { label: 'Vacant corporation land', value: _round(sum(vacM2) / 1e4, 1), unit: 'ha', higherIs: null },
            headline: `The corporation's register places ${Math.round(sum(plots)).toLocaleString('en-IN')} of its properties to the plot, ${_round(sum(land) / 1e4, 0)} ha in all; ${Math.round(sum(vac))} plots (${_round(sum(vacM2) / 1e4, 1)} ha) stand vacant, within ${LAND_NEAR_KM * 1000} m of ${_people(nearVacPop)} residents.`,
            stats,
        };
    }

    // Day and night. LandScan's ambient (24-hour average) population against residents: blocks that fill up by day (offices,
    // markets, campuses, stations) and bedroom blocks that empty out. LandScan's city totals run below the resident counts, so
    // ambient people are rescaled to the residents' total and only the pattern is compared.
    const DAY_KM = 1;

    function daytime(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, amb = c['ambient_pop.ambient_pop'], chg = c['ambient_pop.ambient_change_pct'];
        const pop = c['population.population'];
        if (!amb || !pop || !amb.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const both = Array.from({ length: n }, (_, i) => i).filter(i => _fin(amb[i]) && _fin(pop[i]) && (amb[i] > 0 || pop[i] > 0));
        if (both.length < 20) return null;
        const R = both.reduce((s, i) => s + pop[i], 0), A = both.reduce((s, i) => s + amb[i], 0);
        if (!(R > 0 && A > 0)) return null;
        // LandScan is a ~1 km grid; residents are smoothed over the same ~1 km window so that resolution alone does not show as movement.
        const ok = Float64Array.from({ length: n }, (_, i) => (_fin(amb[i]) && _fin(pop[i]) ? 1 : 0));
        const popSum = within(g, Float64Array.from({ length: n }, (_, i) => (ok[i] ? pop[i] : 0)), 0.5), cnt = within(g, ok, 0.5);
        const res = Float64Array.from({ length: n }, (_, i) => (ok[i] && cnt[i] > 0 ? popSum[i] / cnt[i] : 0));
        const Rs = both.reduce((s, i) => s + res[i], 0) || R;
        const k = Rs / A, day = i => k * amb[i];
        const inflow = Float64Array.from({ length: n }, (_, i) => (ok[i] ? day(i) - res[i] : 0));
        const sortedDay = both.map(day).sort((a, b) => b - a), top = sortedDay.slice(0, Math.ceil(sortedDay.length / 20));
        const magnets = both.filter(i => day(i) >= 2 * res[i] && day(i) - res[i] >= 500);
        const beds = both.filter(i => res[i] >= 2 * day(i) && res[i] - day(i) >= 500);
        const stats = [
            { label: 'Share of daytime people in the busiest 5% of blocks', value: `${_round(100 * top.reduce((s, x) => s + x, 0) / Rs, 1)}%` },
            { label: 'Daytime magnet blocks (at least twice their residents by day)', value: `${magnets.length} blocks, ${_people(magnets.reduce((s, i) => s + inflow[i], 0))} extra people` },
            { label: 'Bedroom blocks (at least twice as many residents as daytime people)', value: `${beds.length} blocks, ${_people(beds.reduce((s, i) => s - inflow[i], 0))} people away by day` },
            { label: 'LandScan ambient total against residents', value: `${_round(100 * A / R, 0)}% (rescaled to residents for comparison)` },
        ];
        if (chg) {
            const w = both.filter(i => _fin(chg[i])), wt = w.reduce((s, i) => s + amb[i], 0);
            if (wt > 0) stats.push({ label: 'Change in ambient population, 2019 to 2024 (people-weighted)', value: `${_round(w.reduce((s, i) => s + amb[i] * chg[i], 0) / wt, 1)}%` });
        }
        const pull = within(g, Float64Array.from({ length: n }, (_, i) => Math.max(0, inflow[i])), DAY_KM);
        spaced(g, both.filter(i => inflow[i] > 0), pull, 5).forEach((i, k2) => stats.push({ label: `Daytime magnet ${k2 + 1}: ${g.codes[i]}`,
            value: `about ${_people(pull[i])} more people by day than live within ${DAY_KM} km` }));
        const push = within(g, Float64Array.from({ length: n }, (_, i) => Math.max(0, -inflow[i])), DAY_KM);
        spaced(g, both.filter(i => inflow[i] < 0), push, 3).forEach((i, k2) => stats.push({ label: `Bedroom area ${k2 + 1}: ${g.codes[i]}`,
            value: `about ${_people(push[i])} fewer people by day than live within ${DAY_KM} km` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of both) out[i] = _round(100 * (day(i) - res[i]) / (day(i) + res[i] + 50), 0);
        return {
            columns: { day_night_pct: out }, idx: both, weightKey: 'day_night_pct', noHotspots: true,
            metric: { label: 'Share of daytime people in the busiest 5% of blocks', value: _round(100 * top.reduce((s, x) => s + x, 0) / Rs, 1), unit: '%', higherIs: null },
            headline: `${magnets.length} blocks hold at least twice their residents by day, while ${beds.length} bedroom blocks empty out; the busiest 5% of blocks hold ${_round(100 * top.reduce((s, x) => s + x, 0) / Rs, 1)}% of the daytime crowd.`,
            stats,
        };
    }

    // Sinking ground. Hasan et al.'s global model of where groundwater pumping and soft ground make land subside by more than
    // 1 cm a year: who lives where the chance is high, a slow risk to foundations, drains and pipes.
    const SINK_HIGH = 60, SINK_VERY = 75;

    function sinking(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, p = c['subsidence.subsid_prob_pct'], pop = c['population.population'];
        const tall = c['building_stock.height_2023_m'];
        if (!p || !p.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => _fin(p[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const share = t => idx.filter(i => p[i] >= t).reduce((s, i) => s + v(pop, i), 0);
        const hi = share(SINK_HIGH), very = share(SINK_VERY);
        const mean = idx.reduce((s, i) => s + v(pop, i) * p[i], 0) / all;
        const stats = [
            { label: 'Chance of sinking more than 1 cm a year, average resident', value: `${_round(mean, 0)}%` },
            { label: `Residents where the chance is ${SINK_HIGH}% or more`, value: `${_people(hi)} (${_round(100 * hi / all, 1)}%)` },
            { label: `Residents where the chance is ${SINK_VERY}% or more`, value: `${_people(very)} (${_round(100 * very / all, 1)}%)` },
        ];
        if (tall) {
            const t = idx.filter(i => p[i] >= SINK_HIGH && v(tall, i) >= 15);
            stats.push({ label: `Blocks with buildings averaging 15 m or taller where the chance is ${SINK_HIGH}% or more`, value: String(t.length) });
        }
        const risk = Float64Array.from({ length: n }, (_, i) => (_fin(p[i]) && p[i] >= SINK_HIGH ? v(pop, i) * p[i] / 100 : 0));
        const near = within(g, risk, 1);
        spaced(g, idx.filter(i => p[i] >= SINK_HIGH), near, 5).forEach((i, k) => stats.push({ label: `Sinking hotspot ${k + 1}: ${g.codes[i]}`,
            value: `${_round(p[i], 0)}% chance; ${_people(within(g, Float64Array.from({ length: n }, (_, j) => (_fin(p[j]) && p[j] >= SINK_HIGH ? v(pop, j) : 0)), 1)[i])} residents within 1 km at ${SINK_HIGH}% or more` }));
        const out = new Float64Array(n).fill(NaN);
        for (let i = 0; i < n; i++) if (_fin(p[i])) out[i] = p[i];
        return {
            columns: { subsid_prob_pct: out }, idx, weightKey: 'subsid_prob_pct', noHotspots: true,
            metric: { label: `Residents where the chance of sinking over 1 cm a year is ${SINK_HIGH}% or more`, value: Math.round(hi), unit: 'people', higherIs: 'worse' },
            headline: `The average resident here lives where a global model gives a ${_round(mean, 0)}% chance that the ground sank more than 1 cm a year in 2013-19; ${_people(hi)} residents (${_round(100 * hi / all, 1)}%) live where the chance is ${SINK_HIGH}% or more.`,
            stats,
        };
    }

    // Hillside homes. Homes on steep ground, above all informal ones cut into hillsides, are where monsoon landslides and
    // retaining-wall collapses kill people (Mumbai's Ghatkopar, Bhandup and Chembur hills). Slope from the DEM, slums from the
    // official maps, past slides from NASA's Global Landslide Catalog.
    const STEEP_DEG = 10, VERY_STEEP_DEG = 15, SLIDE_KM = 0.5;

    function hillside(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, slope = c['terrain.slope_deg'], pop = c['population.population'];
        const slum = c['slums_mapped.slum_pct'], ls = c['landslides.landslides'], dead = c['landslides.landslide_deaths'];
        if (!slope || !slope.some(x => _fin(x) && x >= STEEP_DEG)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const sum = a => (a ? Array.from(a).reduce((s, x) => s + (_fin(x) ? x : 0), 0) : 0);
        const idx = _residents(fr).filter(i => _fin(slope[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const slumPop = i => v(pop, i) * Math.min(v(slum, i), 100) / 100;
        const steep = idx.filter(i => slope[i] >= STEEP_DEG), steepPop = steep.reduce((s, i) => s + v(pop, i), 0);
        const veryPop = idx.filter(i => slope[i] >= VERY_STEEP_DEG).reduce((s, i) => s + v(pop, i), 0);
        const stats = [
            { label: `Residents on ground averaging ${STEEP_DEG}° or steeper`, value: `${_people(steepPop)} (${_round(100 * steepPop / all, 1)}%)` },
            { label: `Residents on ground averaging ${VERY_STEEP_DEG}° or steeper`, value: `${_people(veryPop)} (${_round(100 * veryPop / all, 1)}%)` },
        ];
        if (slum) {
            const sAll = idx.reduce((s, i) => s + slumPop(i), 0), sSteep = steep.reduce((s, i) => s + slumPop(i), 0);
            if (sAll > 0) stats.push({ label: `Residents of mapped slums on ${STEEP_DEG}° or steeper ground`, value: `${_people(sSteep)} of ${_people(sAll)} (${_round(100 * sSteep / sAll, 1)}%)` });
        }
        let slides = 0;
        if (ls && ls.some(x => x > 0)) {
            slides = Math.round(sum(ls));
            const near = within(g, Float64Array.from({ length: n }, (_, i) => v(ls, i)), SLIDE_KM);
            const nearPop = idx.filter(i => near[i] >= 0.5).reduce((s, i) => s + v(pop, i), 0);
            stats.push({ label: 'Recorded landslides, 1970-2019 (NASA catalog)', value: `${slides}${dead ? `, ${Math.round(sum(dead))} deaths` : ''}` });
            stats.push({ label: `Residents within ${SLIDE_KM * 1000} m of a recorded landslide`, value: _people(nearPop) });
        }
        const risk = Float64Array.from({ length: n }, (_, i) => (_fin(slope[i]) && slope[i] >= STEEP_DEG ? (v(pop, i) + 4 * slumPop(i)) * slope[i] : 0));
        const near1 = within(g, risk, 0.5);
        spaced(g, steep, near1, 5).forEach((i, k) => stats.push({ label: `Hillside to check ${k + 1}: ${g.codes[i]}`,
            value: `${_round(slope[i], 0)}° average slope, ${_people(v(pop, i))} residents${slum && slumPop(i) >= 1 ? `, ${_people(slumPop(i))} in mapped slums` : ''}${ls && v(ls, i) > 0 ? `, ${Math.round(v(ls, i))} recorded landslide${v(ls, i) > 1 ? 's' : ''}` : ''}` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = slope[i];
        return {
            columns: { slope_deg: out }, idx, weightKey: 'slope_deg', noHotspots: true,
            metric: { label: `Residents on ground averaging ${STEEP_DEG}° or steeper`, value: Math.round(steepPop), unit: 'people', higherIs: 'worse' },
            headline: `${_people(steepPop)} residents (${_round(100 * steepPop / all, 1)}%) live on ground averaging ${STEEP_DEG}° or steeper${slides ? `, and NASA's catalog records ${slides} landslides here from 1970 to 2019` : ''}; homes cut into hillsides, above all informal ones, are where monsoon slides and wall collapses strike.`,
            stats,
        };
    }

    // Cold nights. ECOSTRESS 70 m surface temperature on clear winter nights: the open edges, fields and floodplains that
    // lose heat fastest after dark. North Indian cold waves kill mostly the homeless and people in thin-walled homes, so
    // the elderly, young children and unplanned settlements in the coldest pockets come first.
    const COLD_NIGHT_C = 1, UNPLANNED_COLD_PCT = 50;

    function coldnights(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, lst = c['winter_nights.winter_lst_c'], an = c['winter_nights.winter_anomaly_c'];
        const pop = c['population.population'], old = c['demographics.elderly_60plus'], kid = c['demographics.under5'];
        const at = c['urban_form.res_atomistic_pct'], inf = c['urban_form.res_informal_pct'], slum = c['slums_mapped.slum_pct'];
        if (!lst || !lst.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => _fin(lst[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        let acc = 0, med = NaN;               // the night the median resident sleeps through
        for (const i of idx.slice().sort((a, b) => lst[a] - lst[b])) { acc += v(pop, i); if (acc >= all / 2) { med = lst[i]; break; } }
        const cold = Float64Array.from({ length: n }, (_, i) => (_fin(lst[i]) ? med - lst[i] : NaN));
        const pocket = idx.filter(i => cold[i] >= COLD_NIGHT_C), pocketPop = pocket.reduce((s, i) => s + v(pop, i), 0);
        const sorted = idx.map(i => lst[i]).sort((a, b) => a - b);
        const spread = sorted[Math.floor(0.95 * (sorted.length - 1))] - sorted[Math.floor(0.05 * (sorted.length - 1))];
        const uhi = an ? idx.reduce((s, i) => s + v(pop, i) * v(an, i), 0) / all : NaN;
        const unpl = i => (at || inf) && v(at, i) + v(inf, i) > UNPLANNED_COLD_PCT;
        const stats = [
            { label: 'Clear winter night surface temperature under the median resident', value: `${_round(med, 1)} °C` },
            { label: 'Spread across homes, coldest to warmest twentieth of blocks', value: `${_round(spread, 1)} °C` },
        ];
        if (_fin(uhi)) stats.push({ label: 'Average resident\'s winter night against the median block of the wider region', value: `${uhi >= 0 ? '+' : ''}${_round(uhi, 1)} °C` });
        stats.push({ label: `Residents in cold pockets, ${COLD_NIGHT_C} °C or more below the median resident's night`, value: `${_people(pocketPop)} (${_round(100 * pocketPop / all, 1)}%)` });
        if (old) stats.push({ label: '…of them aged 60 and over', value: _people(_sumOver(old, pocket, i => _fin(old[i]))) });
        if (kid) stats.push({ label: '…of them under 5', value: _people(_sumOver(kid, pocket, i => _fin(kid[i]))) });
        if (at || inf) {
            const u = pocket.filter(unpl).reduce((s, i) => s + v(pop, i), 0);
            stats.push({ label: `…of them in mostly unplanned or informal blocks (over ${UNPLANNED_COLD_PCT}%)`, value: `${_people(u)} (${_round(100 * u / (pocketPop || 1), 1)}%)` });
        }
        if (slum) {
            const sp = i => v(pop, i) * Math.min(v(slum, i), 100) / 100;
            const sAll = idx.reduce((s, i) => s + sp(i), 0), sCold = pocket.reduce((s, i) => s + sp(i), 0);
            if (sAll > 0) stats.push({ label: 'Residents of mapped slums in cold pockets', value: `${_people(sCold)} of ${_people(sAll)} (${_round(100 * sCold / sAll, 1)}%)` });
        }
        const score = Float64Array.from({ length: n }, (_, i) => (_fin(cold[i]) && cold[i] > 0 ? (v(pop, i) + 3 * v(old, i) + 3 * v(kid, i)) * cold[i] * (unpl(i) ? 2 : 1) : 0));
        spaced(g, pocket, score, 5).forEach((i, k) => stats.push({ label: `Cold pocket ${k + 1}: ${g.codes[i]}`,
            value: `${_round(lst[i], 1)} °C on clear winter nights (−${_round(cold[i], 1)} °C)${unpl(i) ? '; mostly unplanned or informal homes' : ''}; ${_people(v(pop, i))} residents${old ? `, ${_people(v(old, i))} aged 60+` : ''}` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = -cold[i];
        const coldOld = old ? _sumOver(old, pocket, i => _fin(old[i])) : 0;
        return {
            columns: { winter_excess_c: out }, idx, weightKey: 'winter_excess_c', noHotspots: true,
            metric: { label: `Residents ${COLD_NIGHT_C} °C or more below the median resident's winter night`, value: _round(100 * pocketPop / all, 1), unit: '%', higherIs: 'worse' },
            headline: `On clear winter nights the ground under the median resident cools to ${_round(med, 1)} °C, with ${_round(spread, 1)} °C between the coldest and warmest homes; ${_people(pocketPop)} residents (${_round(100 * pocketPop / all, 1)}%) live in cold pockets ${COLD_NIGHT_C} °C or more colder still${coldOld ? `, ${_people(coldOld)} of them aged 60 and over` : ''}. Open ground, fields and floodplains lose heat fastest after dark.`,
            stats,
        };
    }

    // Heated up. Landsat April-May surface temperature in 2000-2006 and 2021-2025: which blocks turned hotter than the
    // city around them and which turned cooler. Each scene is read as its gap to that scene's city median, which cancels
    // the different sensors and weather years. Building on hot bare fallow can read as cooling, so drivers vary by city.
    const WARMED_C = 2, NEW_BUILT_PCT = 20;

    function heatedup(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, rel = c['heat_change.heat_rel_change_c'], now = c['heat_change.lst_2020s_c'];
        const pop = c['population.population'], nb = c['built_up.built_change_pct'], tree = c['vegetation.tree_canopy_pct'];
        if (!rel || !rel.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => _fin(rel[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const wmean = set => { const w = set.reduce((s, i) => s + v(pop, i), 0); return w ? set.reduce((s, i) => s + v(pop, i) * rel[i], 0) / w : NaN; };
        const warm = idx.filter(i => rel[i] >= WARMED_C), warmPop = warm.reduce((s, i) => s + v(pop, i), 0);
        const coolPop = idx.filter(i => rel[i] <= -WARMED_C).reduce((s, i) => s + v(pop, i), 0);
        const stats = [
            { label: `Residents in blocks that turned ${WARMED_C} °C or more hotter than the city since 2000-06`, value: `${_people(warmPop)} (${_round(100 * warmPop / all, 1)}%)` },
            { label: `Residents in blocks that turned ${WARMED_C} °C or more cooler than the city`, value: `${_people(coolPop)} (${_round(100 * coolPop / all, 1)}%)` },
        ];
        let built = null;
        if (nb) {
            const fresh = idx.filter(i => v(nb, i) >= NEW_BUILT_PCT), old = idx.filter(i => _fin(nb[i]) && nb[i] < 5);
            if (fresh.length >= 5 && old.length >= 5) {
                built = { fresh: wmean(fresh), old: wmean(old) };
                stats.push({ label: `Change against the city, homes built over since 2000 (${NEW_BUILT_PCT}%+ new built surface) vs older blocks`, value: `${built.fresh >= 0 ? '+' : ''}${_round(built.fresh, 1)} vs ${built.old >= 0 ? '+' : ''}${_round(built.old, 1)} °C` });
            }
        }
        if (tree && warm.length) {
            const tm = set => { const w = set.reduce((s, i) => s + v(pop, i), 0); return w ? set.reduce((s, i) => s + v(pop, i) * v(tree, i), 0) / w : 0; };
            stats.push({ label: 'Tree canopy today, blocks that warmed vs the rest', value: `${_round(tm(warm), 1)}% vs ${_round(tm(idx.filter(i => rel[i] < WARMED_C)), 1)}%` });
        }
        const score = Float64Array.from({ length: n }, (_, i) => (_fin(rel[i]) && rel[i] > 0 ? v(pop, i) * rel[i] : 0));
        spaced(g, warm, score, 5).forEach((i, k) => stats.push({ label: `Heated up ${k + 1}: ${g.codes[i]}`,
            value: `+${_round(rel[i], 1)} °C against the city${now && _fin(now[i]) ? `, ${_round(now[i], 1)} °C now` : ''}${nb && _fin(nb[i]) ? `; ${Math.round(nb[i])}% of the ground built over since 2000` : ''}; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = rel[i];
        return {
            columns: { heat_rel_change_c: out }, idx, weightKey: 'heat_rel_change_c', noHotspots: true,
            metric: { label: `Residents in blocks ${WARMED_C} °C or more hotter against the city than in 2000-06`, value: _round(100 * warmPop / all, 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(warmPop)} residents (${_round(100 * warmPop / all, 1)}%) live in blocks whose April-May surface has turned ${WARMED_C} °C or more hotter than the city around them since 2000-06, and ${_people(coolPop)} (${_round(100 * coolPop / all, 1)}%) in blocks that turned as much cooler${built && _fin(built.fresh) && _fin(built.old) ? `; blocks built over since 2000 moved ${built.fresh >= 0 ? '+' : ''}${_round(built.fresh, 1)} °C against the city, older blocks ${built.old >= 0 ? '+' : ''}${_round(built.old, 1)} °C` : ''}.`,
            stats,
        };
    }

    // Green then and now. Landsat April-May greenness in 2000-2006 and 2021-2025, each scene read as its gap to the city's
    // median: which blocks lost their green against the city and which gained it, and whether the ones that browned
    // also heated up.
    const GREEN_SHIFT = 0.1;

    function greenchange(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, rel = c['green_change.green_rel_change'], now = c['green_change.ndvi_2020s'], then = c['green_change.ndvi_2000s'];
        const pop = c['population.population'], heat = c['heat_change.heat_rel_change_c'];
        if (!rel || !rel.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => _fin(rel[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const brown = idx.filter(i => rel[i] <= -GREEN_SHIFT), brownPop = brown.reduce((s, i) => s + v(pop, i), 0);
        const green = idx.filter(i => rel[i] >= GREEN_SHIFT), greenPop = green.reduce((s, i) => s + v(pop, i), 0);
        const stats = [
            { label: `Residents in blocks that browned against the city since 2000-06 (NDVI gap down ${GREEN_SHIFT} or more)`, value: `${_people(brownPop)} (${_round(100 * brownPop / all, 1)}%)` },
            { label: `Residents in blocks that greened against the city (gap up ${GREEN_SHIFT} or more)`, value: `${_people(greenPop)} (${_round(100 * greenPop / all, 1)}%)` },
        ];
        let link = null;
        if (heat) {
            const hm = set => { const s = set.filter(i => _fin(heat[i])), w = s.reduce((a, i) => a + v(pop, i), 0); return w ? s.reduce((a, i) => a + v(pop, i) * heat[i], 0) / w : NaN; };
            const rest = idx.filter(i => Math.abs(rel[i]) < GREEN_SHIFT);
            link = { brown: hm(brown), green: hm(green), rest: hm(rest) };
            if (_fin(link.brown) && _fin(link.green)) stats.push({ label: 'Surface heat change against the city: browned, greened and other blocks', value: `${link.brown >= 0 ? '+' : ''}${_round(link.brown, 1)}, ${link.green >= 0 ? '+' : ''}${_round(link.green, 1)} and ${link.rest >= 0 ? '+' : ''}${_round(link.rest, 1)} °C` });
        }
        const score = Float64Array.from({ length: n }, (_, i) => (_fin(rel[i]) && rel[i] < 0 ? v(pop, i) * -rel[i] : 0));
        spaced(g, brown, score, 5).forEach((i, k) => stats.push({ label: `Lost green ${k + 1}: ${g.codes[i]}`,
            value: `NDVI ${then && _fin(then[i]) ? _round(then[i], 2) : '?'} → ${now && _fin(now[i]) ? _round(now[i], 2) : '?'} (${_round(rel[i], 2)} against the city)${heat && _fin(heat[i]) ? `; surface ${heat[i] >= 0 ? '+' : ''}${_round(heat[i], 1)} °C against the city` : ''}; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = -rel[i];
        return {
            columns: { green_loss: out }, idx, weightKey: 'green_loss', noHotspots: true,
            metric: { label: `Residents in blocks that browned against the city since 2000-06`, value: _round(100 * brownPop / all, 1), unit: '%', higherIs: 'worse' },
            headline: `Against the rest of the city, ${_people(brownPop)} residents (${_round(100 * brownPop / all, 1)}%) live in blocks that have browned since 2000-06 and ${_people(greenPop)} (${_round(100 * greenPop / all, 1)}%) in blocks that greened${link && _fin(link.brown) && _fin(link.green) ? `; the browned blocks moved ${link.brown >= 0 ? '+' : ''}${_round(link.brown, 1)} °C in surface heat against the city, the greened ones ${link.green >= 0 ? '+' : ''}${_round(link.green, 1)} °C` : ''}.`,
            stats,
        };
    }

    // Night shelters. Greater Chennai Corporation's Shelter for Urban Homeless map against the NULM norm of one permanent
    // shelter per lakh people, and the busy places (stations, markets) where homeless people gather that have none nearby.
    const SHELTER_KM = 2, SHELTER_PER_LAKH = 1;

    function nightshelters(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, sh = c['night_shelters.shelters'], pop = c['population.population'];
        const men = c['night_shelters.for_men'], women = c['night_shelters.for_women'], kids = c['night_shelters.for_children'], sp = c['night_shelters.special'];
        const amb = c['ambient_pop.ambient_pop'], rail = c['rail_access.rail_stations'], metro = c['rail_access.metro_stations'], wn = c['wards.ward_no'];
        if (!sh || !sh.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const sum = a => (a ? Array.from(a).reduce((s, x) => s + (_fin(x) ? x : 0), 0) : 0);
        const corp = wn && wn.some(_fin);       // the map covers the corporation only, so judge its wards
        const idx = _residents(fr).filter(i => !corp || _fin(wn[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const total = Math.round(sum(sh)), need = Math.ceil(SHELTER_PER_LAKH * all / 1e5);
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(sh, i)), SHELTER_KM);
        const reachPop = idx.filter(i => near[i] >= 0.5).reduce((s, i) => s + v(pop, i), 0);
        const stats = [
            { label: 'Night shelters mapped', value: `${total} (${[[men, 'for men'], [women, 'for women'], [kids, 'for children'], [sp, 'special']].filter(([a]) => a).map(([a, l]) => `${Math.round(sum(a))} ${l}`).join(', ')})` },
            { label: `Shelters needed at the NULM norm (${SHELTER_PER_LAKH} per lakh residents)`, value: `${need} (${_round(total / Math.max(need, 1) * 100, 0)}% met)` },
            { label: `Residents within ${SHELTER_KM} km of a shelter`, value: `${_people(reachPop)} (${_round(100 * reachPop / all, 1)}%)` },
        ];
        const hub = i => v(rail, i) + v(metro, i) > 0;
        const hubs = idx.filter(hub), farHubs = hubs.filter(i => near[i] < 0.5);
        if (rail || metro) stats.push({ label: `Railway and metro station blocks more than ${SHELTER_KM} km from a shelter`, value: `${farHubs.length} of ${hubs.length}` });
        const day = amb ? within(g, Float64Array.from({ length: n }, (_, i) => v(amb, i)), 1) : null;
        const score = Float64Array.from({ length: n }, (_, i) => (near[i] < 0.5 ? (day ? day[i] : v(pop, i)) * (hub(i) ? 3 : 1) : 0));
        spaced(g, idx.filter(i => near[i] < 0.5), score, 5, 2 * SHELTER_KM).forEach((i, k) => stats.push({ label: `Shelter to add ${k + 1}: ${g.codes[i]}`,
            value: `${hub(i) ? 'station block; ' : ''}${day ? `${_people(day[i])} people around by day within 1 km` : `${_people(v(pop, i))} residents`}; no shelter within ${SHELTER_KM} km` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = near[i];
        return {
            columns: { shelters_2km: out }, idx, weightKey: 'shelters_2km', noHotspots: true,
            metric: { label: `Night shelters against the NULM norm of ${SHELTER_PER_LAKH} per lakh residents`, value: _round(100 * total / Math.max(need, 1), 0), unit: '%', higherIs: 'better' },
            headline: `${total} night shelters are mapped for ${_people(all)} residents${corp ? ' of the corporation' : ''}, against about ${need} at the NULM norm of one per lakh; ${_round(100 * reachPop / all, 1)}% of residents live within ${SHELTER_KM} km of one${rail || metro ? `, and ${farHubs.length} of ${hubs.length} station blocks, where homeless people often sleep, have none that close` : ''}.`,
            stats,
        };
    }

    // Hot days, measured. 1 km daily air temperature (Zhang et al.) gives days at 40 and 45 °C and nights that stay at 28 °C
    // for each neighbourhood, for 2015-2024 against 2005-2014: finer than the 9 km reanalysis behind the 2050 outlook,
    // and air rather than ground temperature.
    const HOT_MORE_DAYS = 7;

    function hotdays(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, d40 = c['air_heat.days40_now'], d40a = c['air_heat.days40_then'];
        const d45 = c['air_heat.days45_now'], d45a = c['air_heat.days45_then'], n28 = c['air_heat.nights28_now'], n28a = c['air_heat.nights28_then'];
        const pop = c['population.population'], old = c['demographics.elderly_60plus'], era = c['climate_future.hot_days_now'];
        if (!d40 || !d40.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => _fin(d40[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const wm = a => (a ? idx.reduce((s, i) => s + v(pop, i) * v(a, i), 0) / all : NaN);
        let acc = 0, med = NaN;
        for (const i of idx.slice().sort((a, b) => d40[a] - d40[b])) { acc += v(pop, i); if (acc >= all / 2) { med = d40[i]; break; } }
        const hot = idx.filter(i => d40[i] >= med + HOT_MORE_DAYS), hotPop = hot.reduce((s, i) => s + v(pop, i), 0);
        const sorted = idx.map(i => d40[i]).sort((a, b) => a - b);
        const lo = sorted[Math.floor(0.05 * (sorted.length - 1))], hi = sorted[Math.floor(0.95 * (sorted.length - 1))];
        const D40 = wm(d40), D40a = wm(d40a), D45 = wm(d45), D45a = wm(d45a), N28 = wm(n28), N28a = wm(n28a);
        const stats = [
            { label: 'Days a year at 40 °C or more where the average resident lives, 2005-2014 → 2015-2024', value: `${_round(D40a, 1)} → ${_round(D40, 1)}` },
        ];
        if (d45) stats.push({ label: 'Days a year at 45 °C or more, 2005-2014 → 2015-2024', value: `${_round(D45a, 1)} → ${_round(D45, 1)}` });
        if (n28) stats.push({ label: 'Nights a year that stay at 28 °C or more, 2005-2014 → 2015-2024', value: `${_round(N28a, 1)} → ${_round(N28, 1)}` });
        stats.push({ label: 'Spread across homes, coolest to hottest twentieth of blocks', value: `${Math.round(lo)} to ${Math.round(hi)} days at 40 °C+` });
        stats.push({ label: `Residents with ${HOT_MORE_DAYS} or more extra days at 40 °C+ than the median resident`, value: `${_people(hotPop)} (${_round(100 * hotPop / all, 1)}%)` });
        if (old) stats.push({ label: '…of them aged 60 and over', value: _people(_sumOver(old, hot, i => _fin(old[i]))) });
        if (era && era.some(_fin)) stats.push({ label: 'Same count from the 9 km ERA5-Land reanalysis, 2015-2024 (2050 outlook baseline)', value: `${_round(wm(era), 1)} days` });
        const score = Float64Array.from({ length: n }, (_, i) => (_fin(d40[i]) && d40[i] > med ? (v(pop, i) + 3 * v(old, i)) * (d40[i] - med) : 0));
        spaced(g, idx.filter(i => d40[i] > med), score, 5).forEach((i, k) => stats.push({ label: `Hottest homes ${k + 1}: ${g.codes[i]}`,
            value: `${Math.round(d40[i])} days at 40 °C+ a year${d45 && _fin(d45[i]) ? `, ${_round(d45[i], 1)} at 45 °C+` : ''}${n28 && _fin(n28[i]) ? `, ${Math.round(n28[i])} nights at 28 °C+` : ''}; ${_people(v(pop, i))} residents${old ? `, ${_people(v(old, i))} aged 60+` : ''}` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = d40[i];
        const ch = D40 - D40a;
        return {
            columns: { days40_now: out }, idx, weightKey: 'days40_now', noHotspots: true,
            metric: { label: 'Days a year at 40 °C or more where the average resident lives (2015-2024)', value: _round(D40, 1), unit: 'days', higherIs: 'worse' },
            headline: `The average resident now lives through ${_round(D40, 1)} days a year at 40 °C or more, ${Math.abs(ch) < 0.5 ? 'about the same as' : `${_round(Math.abs(ch), 1)} ${ch > 0 ? 'more' : 'fewer'} than`} in 2005-2014${n28 ? `, and ${_round(N28, 1)} nights that stay at 28 °C or more` : ''}; homes range from ${Math.round(lo)} to ${Math.round(hi)} such days, and ${_people(hotPop)} residents (${_round(100 * hotPop / all, 1)}%) get ${HOT_MORE_DAYS} or more extra days than the median resident.`,
            stats,
        };
    }

    // Old tank beds. HYDRAA's survey of Hyderabad's tanks on their old village-map outlines shows which parts are built up
    // in 2023: who lives on a former tank bed, how many tanks are gone or shrank since 2014, and whether reported flood
    // spots cluster on the built-up beds.
    const TANKBED_BUILT_PCT = 10;

    function tankbeds(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, bed = c['tank_beds.tankbed_pct'], built = c['tank_beds.tankbed_built_pct'];
        const water = c['tank_beds.tankbed_water_pct'], tk = c['tank_beds.tanks'], live = c['tank_beds.tanks_live'];
        const lost = c['tank_beds.tanks_lost'], worse = c['tank_beds.tanks_worse'], spots = c['flood_reports.flood_spots'], wl = c['waterlogging.waterlogging_index'];
        const pop = c['population.population'];
        if (!bed || !tk || !tk.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr);
        if (idx.length < 5) return null;
        const sum = a => { let t = 0; for (let i = 0; i < n; i++) t += v(a, i); return t; };
        const T = sum(tk), Live = sum(live), Lost = sum(lost), Worse = sum(worse);
        const onBed = i => v(pop, i) * v(built, i) / 100;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1, bedPop = idx.reduce((s, i) => s + onBed(i), 0);
        const area = a => idx.reduce((s, i) => s + v(a, i), 0) / 100 * g.cellKm2;
        const stats = [
            { label: 'Tanks surveyed on their old outlines (largest part on the map)', value: `${Math.round(T)}` },
            { label: '…live in 2023 / wholly encroached', value: `${Math.round(Live)} (${_round(100 * Live / (T || 1), 0)}%) / ${Math.round(Lost)} (${_round(100 * Lost / (T || 1), 0)}%)` },
            { label: '…encroachment grew between 2014 and 2023', value: `${Math.round(Worse)} tanks` },
        ];
        if (built && water) stats.push({ label: 'Old tank bed in lived-in blocks: built up / still water', value: `${_round(area(built), 1)} / ${_round(area(water), 1)} km²` });
        stats.push({ label: 'Residents living on a built-up tank bed (block residents × built-up bed share)', value: `${_people(bedPop)} (${_round(100 * bedPop / all, 1)}%)` });
        const onB = idx.filter(i => v(built, i) >= TANKBED_BUILT_PCT), off = idx.filter(i => v(bed, i) === 0);
        let ratio = NaN;
        if (wl && onB.length >= 5 && off.length >= 5) {
            const mean = a => a.reduce((s, i) => s + v(wl, i), 0) / a.length;
            const mOn = mean(onB), mOff = mean(off);
            ratio = mOff > 0 ? mOn / mOff : NaN;
            stats.push({ label: `Satellite waterlogging index: ${TANKBED_BUILT_PCT}%+ built-up tank bed / no tank bed`, value: `${_round(mOn, 0)} / ${_round(mOff, 0)}` });
        }
        if (spots) stats.push({ label: 'Reported flood spots near blocks on a built-up tank bed', value: `${onB.filter(i => v(spots, i) > 0).length} of ${onB.length} blocks` });
        const score = Float64Array.from({ length: n }, (_, i) => onBed(i) * (1 + v(wl, i) / 100));
        spaced(g, idx.filter(i => v(built, i) >= TANKBED_BUILT_PCT), score, 5).forEach((i, k) => stats.push({ label: `Homes on a tank bed ${k + 1}: ${g.codes[i]}`,
            value: `${Math.round(v(built, i))}% of the block is built-up tank bed; ~${_people(onBed(i))} residents on it${wl && _fin(wl[i]) ? `; waterlogging index ${Math.round(wl[i])}` : ''}` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = v(built, i);
        return {
            columns: { tankbed_built_pct: out }, idx, weightKey: 'tankbed_built_pct', noHotspots: true,
            metric: { label: 'Residents living on a built-up old tank bed', value: Math.round(bedPop), unit: 'people', higherIs: 'worse' },
            headline: `About ${_people(bedPop)} residents (${_round(100 * bedPop / all, 1)}%) live on old tank beds that are built up today; of ${Math.round(T)} tanks surveyed, ${Math.round(Lost)} are wholly encroached and ${Math.round(Worse)} lost more ground between 2014 and 2023${_fin(ratio) ? `, and blocks on built-up beds score ${_round(ratio, 1)}× the waterlogging of blocks off them` : ''}.`,
            stats,
        };
    }

    // Workplaces counted. The 6th Economic Census (2012-13) listed every establishment in Kolkata with its ward: where the
    // jobs actually were, against where people live, what kind of work, and how much of it ran from homes or employed women.
    function _rankCorr(x, y) {
        const rank = a => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = new Float64Array(a.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
        const m = x.length;
        if (m < 5) return NaN;
        const rx = rank(x), ry = rank(y);
        let d = 0;
        for (let i = 0; i < m; i++) d += (rx[i] - ry[i]) ** 2;
        return 1 - 6 * d / (m * (m * m - 1));
    }

    function jobcount(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, ward = c['econ_census.ec_ward'], wk = c['econ_census.ec_workers'], es = c['econ_census.ec_estabs'];
        const mfg = c['econ_census.mfg_pct'], trade = c['econ_census.trade_pct'], home = c['econ_census.home_pct'], women = c['econ_census.women_pct'];
        const wown = c['econ_census.women_owner_pct'], pop = c['population.population'], places = c['places.places'];
        if (!ward || !wk || !wk.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const W = new Map();
        for (let i = 0; i < n; i++) {
            if (!_fin(ward[i]) || !_fin(wk[i])) continue;
            const w = W.get(ward[i]) || { no: ward[i], blocks: [], pop: 0, places: 0, first: i };
            w.blocks.push(i); w.pop += v(pop, i); w.places += v(places, i);
            W.set(ward[i], w);
        }
        const ws = [...W.values()].filter(w => w.blocks.length >= 2);
        if (ws.length < 5) return null;
        for (const w of ws) { const i = w.first; w.workers = v(wk, i); w.estabs = v(es, i); w.km2 = w.blocks.length * g.cellKm2; w.dens = w.workers / w.km2; w.ratio = w.pop > 0 ? 100 * w.workers / w.pop : NaN; }
        const tw = ws.reduce((s, w) => s + w.workers, 0), te = ws.reduce((s, w) => s + w.estabs, 0), tp = ws.reduce((s, w) => s + w.pop, 0) || 1;
        const wavg = a => ws.reduce((s, w) => s + w.workers * v(a, w.first), 0) / (tw || 1);
        const eavg = a => ws.reduce((s, w) => s + w.estabs * v(a, w.first), 0) / (te || 1);
        const byDens = ws.slice().sort((a, b) => b.dens - a.dens), lived = ws.filter(w => w.pop >= 5000 && _fin(w.ratio)).sort((a, b) => a.ratio - b.ratio);
        const top10 = byDens.slice(0, Math.ceil(ws.length / 10)).reduce((s, w) => s + w.workers, 0);
        const stats = [
            { label: 'Workers and establishments counted in the wards on the map (2012-13)', value: `${_people(tw)} workers in ${_people(te)} establishments` },
            { label: 'Workers per 100 residents (2012-13 workers, today\'s GHSL residents)', value: `${_round(100 * tw / tp, 0)}` },
            { label: 'Share of workers in the densest tenth of wards', value: `${_round(100 * top10 / (tw || 1), 0)}%` },
        ];
        if (mfg) stats.push({ label: 'Workers in manufacturing / trade', value: `${_round(wavg(mfg), 0)}% / ${_round(wavg(trade), 0)}%` });
        if (home) stats.push({ label: 'Establishments run from inside a home', value: `${_round(eavg(home), 0)}%` });
        if (women) stats.push({ label: 'Workers who are women / proprietary establishments owned by women', value: `${_round(wavg(women), 1)}% / ${_round(eavg(wown), 1)}%` });
        let rho = NaN;
        if (places && ws.some(w => w.places > 0)) {
            rho = _rankCorr(ws.map(w => w.dens), ws.map(w => w.places / w.km2));
            stats.push({ label: 'Rank match between 2012-13 workers per km² and today\'s Overture places per km², by ward', value: _round(rho, 2) });
        }
        const name = w => g.codes[w.first];
        byDens.slice(0, 5).forEach((w, k) => stats.push({ label: `Densest jobs ${k + 1}: ward ${w.no}, ${name(w)}`,
            value: `${_people(w.dens)} workers per km²; ${_people(w.workers)} workers${mfg ? `, ${_round(v(mfg, w.first), 0)}% manufacturing, ${_round(v(trade, w.first), 0)}% trade` : ''}` }));
        lived.slice(0, 3).forEach((w, k) => stats.push({ label: `Fewest jobs per resident ${k + 1}: ward ${w.no}, ${name(w)}`,
            value: `${_round(w.ratio, 0)} workers per 100 residents; ${_people(w.pop)} residents` }));
        if (mfg) ws.slice().sort((a, b) => v(mfg, b.first) - v(mfg, a.first)).slice(0, 3).forEach((w, k) => stats.push({ label: `Workshop ward ${k + 1}: ward ${w.no}, ${name(w)}`,
            value: `${_round(v(mfg, w.first), 0)}% of ${_people(w.workers)} workers in manufacturing${home ? `; ${_round(v(home, w.first), 0)}% of establishments in homes` : ''}` }));
        const out = new Float64Array(n).fill(NaN), idx = [];
        for (const w of ws) for (const i of w.blocks) { out[i] = Math.round(w.dens); idx.push(i); }
        return {
            columns: { ec_workers_km2: out }, idx, weightKey: 'ec_workers_km2', noHotspots: true,
            metric: { label: 'Workers per 100 residents in the wards on the map (2012-13 census)', value: _round(100 * tw / tp, 0), unit: 'per 100', higherIs: null },
            headline: `The Economic Census counted ${_people(tw)} workers in ${_people(te)} establishments across ${ws.length} wards; the densest tenth of wards held ${_round(100 * top10 / (tw || 1), 0)}% of them${mfg ? `, ${_round(wavg(mfg), 0)}% worked in manufacturing and ${_round(wavg(trade), 0)}% in trade` : ''}${women ? `, and only ${_round(wavg(women), 1)}% were women` : ''}${_fin(rho) ? `; today's mapped places follow the 2012-13 job density with a rank match of ${_round(rho, 2)}` : ''}.`,
            stats,
        };
    }

    // Property tax by ward. GCC bills residential property tax on assessed rental value, so demand per resident is an
    // official read of how dear homes are: set against the land value model, with how much of the bill gets collected.
    function ptax(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, ward = c['property_tax.pt_ward'], res = c['property_tax.pt_res_demand_lakh'];
        const com = c['property_tax.pt_com_demand_lakh'], coll = c['property_tax.pt_collect_pct'], gr = c['property_tax.pt_res_growth_pct'];
        const pop = c['population.population'], vi = c['land_value.value_index'];
        if (!ward || !res || !res.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const W = new Map();
        for (let i = 0; i < n; i++) {
            if (!_fin(ward[i]) || !_fin(res[i])) continue;
            const w = W.get(ward[i]) || { no: ward[i], blocks: [], pop: 0, vi: 0, viw: 0, first: i };
            w.blocks.push(i); w.pop += v(pop, i);
            if (vi && _fin(vi[i])) { w.vi += v(pop, i) * vi[i]; w.viw += v(pop, i); }
            W.set(ward[i], w);
        }
        const ws = [...W.values()].filter(w => w.blocks.length >= 3 && w.pop >= 2000);
        if (ws.length < 5) return null;
        for (const w of ws) { const i = w.first; w.res = v(res, i) * 1e5; w.per = w.res / w.pop; w.val = w.viw ? w.vi / w.viw : NaN; }
        const tRes = ws.reduce((s, w) => s + w.res, 0), tCom = ws.reduce((s, w) => s + v(com, w.first) * 1e5, 0), tPop = ws.reduce((s, w) => s + w.pop, 0) || 1;
        const pers = ws.map(w => w.per).sort((a, b) => a - b), q = f => pers[Math.floor(f * (pers.length - 1))];
        const stats = [
            { label: `Residential property tax billed in 2017-18 across ${ws.length} wards / commercial`, value: `₹${_round(tRes / 1e7, 0)} crore / ₹${_round(tCom / 1e7, 0)} crore` },
            { label: 'Residential tax billed per resident: city / poorest-billed fifth of wards / richest-billed fifth', value: `₹${Math.round(tRes / tPop)} / ₹${Math.round(q(0.2))} / ₹${Math.round(q(0.8))} a year` },
        ];
        if (coll) {
            const cs = ws.filter(w => _fin(coll[w.first]));
            const cAvg = cs.reduce((s, w) => s + coll[w.first] * w.res, 0) / (cs.reduce((s, w) => s + w.res, 0) || 1);
            stats.push({ label: 'Collected over billed, 2013-14 to 2017-18 (weighted by residential bill)', value: `${_round(cAvg, 0)}%` });
            cs.slice().sort((a, b) => coll[a.first] - coll[b.first]).slice(0, 3).forEach((w, k) => stats.push({ label: `Lowest collection ${k + 1}: ward ${w.no}, ${g.codes[w.first]}`, value: `${_round(coll[w.first], 0)}% of the bill collected` }));
        }
        if (gr) {
            const gs = ws.filter(w => _fin(gr[w.first]));
            stats.push({ label: 'Wards whose residential bill grew 20% or more, 2013-14 to 2017-18', value: `${gs.filter(w => gr[w.first] >= 20).length} of ${gs.length}` });
        }
        let rho = NaN;
        const both = ws.filter(w => _fin(w.val));
        if (both.length >= 10) {
            rho = _rankCorr(both.map(w => w.per), both.map(w => w.val));
            stats.push({ label: 'Rank match with the land value index, by ward: tax billed per resident / per km²', value: `${_round(rho, 2)} / ${_round(_rankCorr(both.map(w => w.res / w.blocks.length), both.map(w => w.val)), 2)}` });
            const gap = both.map(w => ({ w, d: _rankPct(both, x => x.per, w) - _rankPct(both, x => x.val, w) })).sort((a, b) => a.d - b.d);
            gap.slice(0, 3).forEach(({ w, d }, k) => stats.push({ label: `Billed low for its land value ${k + 1}: ward ${w.no}, ${g.codes[w.first]}`, value: `₹${Math.round(w.per)} per resident; land value index ${_round(w.val, 0)} (${Math.round(-100 * d)} percentile points apart)` }));
        }
        ws.slice().sort((a, b) => b.per - a.per).slice(0, 3).forEach((w, k) => stats.push({ label: `Highest billed per resident ${k + 1}: ward ${w.no}, ${g.codes[w.first]}`, value: `₹${Math.round(w.per)} a year per resident` }));
        const out = new Float64Array(n).fill(NaN), idx = [];
        for (const w of ws) for (const i of w.blocks) { out[i] = Math.round(w.per); idx.push(i); }
        return {
            columns: { ptax_per_resident: out }, idx, weightKey: 'ptax_per_resident', noHotspots: true,
            metric: { label: 'Residential property tax billed per resident (2017-18)', value: Math.round(tRes / tPop), unit: '₹/yr', higherIs: null },
            headline: `GCC billed ₹${_round(tRes / 1e7, 0)} crore of residential property tax in 2017-18, ₹${Math.round(tRes / tPop)} a year per resident, from ₹${Math.round(q(0.2))} in the lowest-billed fifth of wards to ₹${Math.round(q(0.8))} in the highest${_fin(rho) ? `; per resident the bills barely follow the land value model (rank match ${_round(rho, 2)}): rental values assessed decades ago, the model or both miss today's prices there` : ''}.`,
            stats,
        };
    }

    function _rankPct(arr, key, item) {
        const x = key(item);
        return arr.filter(a => key(a) < x).length / Math.max(1, arr.length - 1);
    }

    // Street connectivity. Intersections per km² and the share of street ends that are dead ends, around each home
    // (500 m), from Overture's road graph: fine-grained grids make short walks and many routes; cul-de-sacs and gated
    // lanes make long detours and funnel traffic onto a few roads.
    const GRID_KM = 0.5, GRID_LOW = 50, GRID_DEAD = 0.4;

    function streetgrid(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, xs = c['street_grid.intersections'], de = c['street_grid.dead_ends'], pop = c['population.population'];
        if (!xs || !xs.some(x => _fin(x) && x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const X = within(g, Float64Array.from({ length: n }, (_, i) => v(xs, i)), GRID_KM, true);
        const D = within(g, Float64Array.from({ length: n }, (_, i) => v(de, i)), GRID_KM, true);
        const idx = _residents(fr).filter(i => _fin(X[i]));
        if (idx.length < 5) return null;
        const dens = i => X[i] / g.cellKm2, dead = i => (X[i] + D[i] > 0 ? D[i] / (X[i] + D[i]) : 0);
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const wq = (f, q) => { const o = idx.slice().sort((a, b) => f(a) - f(b)); let acc = 0; for (const i of o) { acc += v(pop, i); if (acc >= q * all) return f(i); } return NaN; };
        const poor = idx.filter(i => dens(i) < GRID_LOW && dead(i) >= GRID_DEAD), pPoor = poor.reduce((s, i) => s + v(pop, i), 0);
        const low = idx.filter(i => dens(i) < GRID_LOW), pLow = low.reduce((s, i) => s + v(pop, i), 0);
        const tX = Array.from({ length: n }, (_, i) => v(xs, i)).reduce((a, b) => a + b, 0), tD = Array.from({ length: n }, (_, i) => v(de, i)).reduce((a, b) => a + b, 0);
        const med = wq(dens, 0.5);
        const stats = [
            { label: 'Intersections per km² around the median resident (500 m)', value: `${Math.round(med)}` },
            { label: 'Fifth of residents with the sparsest / densest street grids', value: `${Math.round(wq(dens, 0.2))} / ${Math.round(wq(dens, 0.8))} per km²` },
            { label: 'Street ends that are dead ends, whole map', value: `${_round(100 * tD / ((tX + tD) || 1), 0)}% (${_people(tD)} dead ends, ${_people(tX)} intersections)` },
            { label: `Residents where intersections are under ${GRID_LOW} per km²`, value: `${_people(pLow)} (${_round(100 * pLow / all, 1)}%)` },
            { label: `…and ${Math.round(GRID_DEAD * 100)}% or more of street ends are dead ends`, value: `${_people(pPoor)} (${_round(100 * pPoor / all, 1)}%)` },
        ];
        const score = Float64Array.from({ length: n }, (_, i) => (_fin(X[i]) ? v(pop, i) * Math.max(0, 1 - dens(i) / GRID_LOW) * dead(i) : 0));
        spaced(g, poor, score, 5).forEach((i, k) => stats.push({ label: `Cut-off streets ${k + 1}: ${g.codes[i]}`,
            value: `${Math.round(dens(i))} intersections per km², ${_round(100 * dead(i), 0)}% dead ends; ${_people(v(pop, i))} residents` }));
        const fine = Float64Array.from({ length: n }, (_, i) => (_fin(X[i]) ? dens(i) : 0));
        spaced(g, idx, fine, 3).forEach((i, k) => stats.push({ label: `Finest grain ${k + 1}: ${g.codes[i]}`, value: `${Math.round(dens(i))} intersections per km²` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = Math.round(dens(i));
        return {
            columns: { intersections_km2: out }, idx, weightKey: 'intersections_km2', noHotspots: true,
            metric: { label: 'Intersections per km² around the median resident', value: Math.round(med), unit: 'per km²', higherIs: 'better' },
            headline: `The median resident lives among ${Math.round(med)} street intersections per km² (500 m around home); ${_people(pLow)} residents (${_round(100 * pLow / all, 0)}%) have fewer than ${GRID_LOW}, and ${_people(pPoor)} of them also face ${Math.round(GRID_DEAD * 100)}% or more dead ends: places where a short trip on foot becomes a long detour.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'howbuilt', equity: true, title: 'How neighbourhoods were built', icon: '🧱',
            question: 'Which neighbourhoods grew without a plan, and which were laid out as approved layouts?',
            field: { key: 'res_unplanned_pct', label: 'Residential ground that is unplanned or informal subdivision', unit: '%', higherIs: null, ramp: 'reds', domain: [0, 100] },
            needs: ['urban_form.res_atomistic_pct', 'urban_form.res_informal_pct', 'urban_form.res_formal_pct', 'urban_form.res_project_pct', 'urban_form.ulu_road_pct', 'urban_form.ulu_open_pct', 'population.population'],
            method: `WRI's Global Intra-Urban Land Use map (2020, CC BY 4.0): a neural network on Sentinel-2 imagery classes every 5 m pixel of the world's cities with over 100,000 people into the Atlas of Urban Expansion categories. Residential ground is atomistic (irregular plots and lanes that grew one house at a time), informal subdivision (a regular grid of plots laid out without planning approval, as in many unauthorised colonies and revenue layouts), formal subdivision (approved layouts) or housing project (large uniform developments). Each block takes the shares of its residential ground, sampled at 10 m; residents are WorldPop. Mostly unplanned means atomistic plus informal over ${UNPLANNED_PCT}%. A model reading of the roof and street pattern, not a legal status: it cannot see approvals or titles.`,
            refs: 'Guzder-Williams et al. 2023, Intra-urban land use maps for a global sample of cities (Computers, Environment and Urban Systems); Angel et al., Atlas of Urban Expansion (2016)' },
        { id: 'floodnews', equity: true, title: 'Floods in the news', icon: '📰',
            question: 'Which streets and neighbourhoods keep making the news for flooding?',
            field: { key: 'flood_news_500m', label: `Reported flood days within ${NEWS_KM * 1000} m (capped at 30)`, unit: 'days', higherIs: 'worse', ramp: 'blues', domain: [0, 30] },
            needs: ['news_floods.flood_news_days', 'news_floods.flood_news_recent', 'news_floods.flood_news_last', 'population.population'],
            method: `Groundsource (Google Research, 2026, CC BY 4.0): flooded places extracted from news articles in many languages by Gemini and geocoded with the Google Maps geocoder, one record per place and day, 2000 to March 2026. Only records geocoded to a street, landmark or neighbourhood (footprint up to 2 km²) are kept, at the footprint's centre; district- and city-wide records are dropped. Each block counts distinct reported days; each resident's block sums the days within ${NEWS_KM * 1000} m. Repeat spots are blocks ${SPACING_KM} km apart with the most reported days. News coverage, not flood frequency: recall is higher for big events, busy places and recent years, and geocoding errors can cluster on ambiguous names. Works in every city, including those without official flood maps.`,
            refs: 'Mayo, Zlydenko et al. 2026, Groundsource: a global dataset of flood events from news (EarthArXiv preprint; Zenodo 10.5281/zenodo.18647054)' },
        { id: 'badairdays', equity: true, title: 'Bad-air days', icon: '😷',
            question: 'On how many days a year is the air here above the safe limit?',
            field: { key: 'days_over_60', label: `Days in 2022 above ${NAAQS_24H} µg/m³ PM2.5`, unit: 'days', higherIs: 'worse', ramp: 'reds', domain: [0, 250] },
            needs: ['pm25_days.days_over_60', 'pm25_days.days_over_90', 'pm25_days.days_over_120', 'pm25_days.days_over_60_change', 'pm25_days.pm25_2022', 'population.population'],
            method: `Global High Air Pollutants (GHAP, Wei et al., CC BY 4.0): gap-free daily surface PM2.5 on a 1 km grid, estimated by machine learning from satellite aerosol, weather, land use and ground monitors. Each block counts the days in 2022 above India's 24-hour standard (NAAQS, ${NAAQS_24H} µg/m³) and above the CPCB AQI breakpoints for 'poor' (90) and 'very poor' (120), and the change in days above ${NAAQS_24H} since 2017. Residents are weighted by WorldPop. Worst-air picks are blocks ${SPACING_KM} km apart ranked by residents × (poor days + a quarter of the days above the standard). A modelled estimate: it smooths spikes next to a single chimney or junction, and the 2017 to 2022 change mixes cleaner air with different weather years.`,
            refs: 'Wei et al. 2023, GHAP daily PM2.5 (Earth System Science Data); CPCB National Ambient Air Quality Standards 2009; CPCB National AQI (2014); National Clean Air Programme' },
        { id: 'stillair', equity: true, title: 'Still air', icon: '🍃',
            question: 'Where does the wind barely reach the street, so smoke and exhaust hang in the air?',
            field: { key: 'wind10_ms', label: 'Mean wind speed at 10 m', unit: 'm/s', higherIs: 'better', ramp: 'blues', domain: [1.4, 3] },
            needs: ['wind.wind10_ms', 'wind.wind100_ms', 'wind.wind_kept_pct', 'traffic_noise.pm25_exhaust_g_day', 'air_quality.pm25_ugm3', 'population.population'],
            method: `Global Wind Atlas 3 (DTU and the World Bank, CC BY 4.0): mean annual wind speed at 10 m and 100 m on a 250 m grid, from ten years of reanalysis downscaled over terrain and surface roughness, so dense building and hills show as slower wind near the ground. Light air is a mean under ${STILL_MS} m/s at 10 m (Beaufort scale), where pollution disperses poorly; most blocks in Indian cities fall below it, so the lens ranks within the city and targets the stillest fifth of residents; the share of the 100 m wind kept at 10 m shows how much buildings and terrain shelter the street (under ${KEPT_LOW}% is heavily sheltered). Trapped-air picks are blocks in that stillest fifth, ${SPACING_KM} km apart, ranked by residents × road PM2.5 exhaust (traffic model) × satellite PM2.5 ÷ wind. Mean annual wind hides calm winter nights, when inversions trap pollution most, and 250 m cells cannot resolve single street canyons.`,
            refs: 'Global Wind Atlas 3 (DTU Wind Energy, World Bank Group, ESMAP); WMO Beaufort scale; Oke et al. 2017, Urban Climates (street canyon ventilation)' },
        { id: 'schooldrift', equity: true, title: 'Leaving government schools', icon: '🎒',
            question: 'Where are families moving children out of government schools, and where are they coming back?',
            field: { key: 'govt_share_change_pp', label: 'Change in the government school share of pupils since 2021-22', unit: 'pp', higherIs: null, ramp: 'diverging', domain: [-20, 20] },
            needs: ['schools_udise.govt_share_pct', 'schools_udise.govt_share_change_pp', 'demographics.school_age', 'population.population'],
            method: `UDISE+ 2021-22 and 2024-25 district school files on data.opencity.in. Pupils in government schools (education department, local bodies, other departments, central schools) and in private unaided schools are summed by PIN code; aided schools are left out of both. Each block takes its PIN code's share of pupils in government schools and its change in percentage points; PIN codes with under 200 such pupils in a year are left out. Counts are not compared because from 2022-23 UDISE+ verified individual pupils, which removed duplicate and ghost enrolment; 2021-22 also came right after the pandemic, when many families had moved to government schools, so part of a fall is that move unwinding. ${DRIFT_PP} points or more counts as a real shift. Delhi, Mumbai, Bengaluru, Pune, Chennai, Hyderabad and Kolkata only.`,
            refs: 'UDISE+ 2021-22 and 2024-25 (Ministry of Education) via data.opencity.in; UDISE+ 2022-23 report (student-level data collection)' },
        { id: 'hotnights', equity: true, title: 'Hot nights', icon: '🌙',
            question: 'Where do streets and roofs stay hot through summer nights, when bodies need to cool?',
            field: { key: 'night_excess_c', label: "Summer night surface temperature above the median resident's", unit: '°C', higherIs: 'worse', ramp: 'diverging', domain: [-3, 3] },
            needs: ['night_heat.night_lst_c', 'night_heat.night_anomaly_c', 'night_heat.night_scenes', 'pm_heat.pm_lst_c', 'surface_heat.lst_day_c', 'vegetation.tree_canopy_pct', 'demographics.elderly_60plus', 'demographics.under5', 'population.population'],
            method: `NASA ECOSTRESS (thermal radiometer on the International Space Station, public domain): land surface temperature at 70 m. The space station's drifting orbit passes at different hours, so night scenes exist, which the fixed-time Landsat and MODIS mornings and afternoons miss. Each block takes the median of cloud-free, non-water pixels from April to June nights (21:30 to 05:30 IST) in 2023 to 2025. The map shows each block against the night the median resident sleeps through, and hot-night blocks are ${HOT_NIGHT_C} °C or more above it; the heat island figure compares homes with the median block of the whole city region, farmland included. Overnight cooling is the drop from the median cloud-free afternoon (12:30 to 15:30 IST, same months and years) to the median night: blocks that cool least are holding the day's heat in concrete and asphalt. residents, the elderly and children under 5 are WorldPop. Picks are blocks ${SPACING_KM} km apart ranked by (residents + 3 × residents aged 60+) × heat above the median resident's night. Surface, not air, temperature, and some blocks rest on a handful of scenes (see night_scenes); a few overpasses near dawn run cooler than ones near midnight.`,
            refs: 'Hook and Hulley, ECOSTRESS L2T LSTE V2 (NASA LP DAAC); Laaidi et al. 2012, The impact of heat islands on mortality in Paris during the August 2003 heat wave (Environmental Health Perspectives); NDMA Heat Action Plan guidelines (2019)' },
        { id: 'newroads', equity: false, title: 'Big roads to come', icon: '🛣️',
            question: 'Where will the planned elevated corridors and ring road run, and who lives along them?',
            field: { key: 'newroad_dist_m', label: 'Distance to the nearest planned elevated corridor or ring road', unit: 'm', higherIs: null, ramp: 'viridis', domain: [0, 3000] },
            needs: ['new_roads.newroad_dist_m', 'new_roads.newroad_len_m', 'new_roads.newroad_ref', 'traffic_noise.lden_db', 'tree_census.trees', 'tree_census.big_trees', 'schools_official.schools', 'land_value.value_index', 'population.population'],
            method: `Alignment maps on data.opencity.in (public domain): Greater Bengaluru Authority's eleven elevated corridors from the August 2026 list (categories A to C, tenders floated), one centreline each (right-of-way edge lines drawn beside a centreline are dropped), and BDA's Peripheral Ring Road, now the 73 km Bengaluru Business Corridor (October 2022 alignment, land acquisition under way in 2026), drawn as its right-of-way outline, whose length counts once, and BDA's 11 km major arterial road through Nadaprabhu Kempegowda Layout on the map's western edge. Each block within 3 km takes the distance from its centre to the nearest alignment and the alignment length inside it. Residents are WorldPop; road noise is the traffic model's Lden; trees are the Bengaluru tree census. Alignments in tender documents can still shift, an elevated corridor touches the ground only at its piers and ramps, while the ring road takes its whole right of way. Bengaluru only: the pipeline also reads MSRDC's Pune Outer Ring Road, but it runs almost entirely outside the Pune map.`,
            refs: 'Greater Bengaluru Authority elevated corridor documents (2026); BDA Peripheral Ring Road DPR, EIA and alignment maps (2020 to 2022); all via data.opencity.in' },
        { id: 'raingaugegap', equity: true, title: 'Rain gauge gaps', icon: '🌧️',
            question: 'Where does heavy rain fall unmeasured, far from any rain gauge?',
            field: { key: 'gauges_2km', label: `Rain gauges and weather stations within ${GAUGE_KM} km`, unit: 'gauges', higherIs: 'better', ramp: 'blues', domain: [0, 5] },
            needs: ['rain_gauges.rain_gauges', 'rain_gauges.weather_stations', 'flood_reports.flood_spots', 'waterlogging.waterlogging_index', 'population.population'],
            method: `Karnataka State Natural Disaster Monitoring Centre (KSNDMC) telemetric rain gauges and weather stations from the KGIS maps on data.opencity.in (public domain); gauges on both the state and the Bengaluru Urban layer count once. Each block counts gauges and stations within ${GAUGE_KM} km; residents are WorldPop. Flood spots are the reported flood-vulnerable and low-lying locations (flood_reports, within 300 m of a block); waterlogging-prone means the satellite waterlogging index is ${WLOG_PRONE} or more. New gauge picks are blocks ${SPACING_KM} km apart, beyond ${GAUGE_KM} km of a gauge, ranked by unmeasured blocks near flood spots (weighted heavily) and residents (twice in waterlogging-prone blocks) within ${GAUGE_KM} km. Urban convective storms can be a few kilometres across, so gauge spacing matters for street-level alerts. Bengaluru only.`,
            refs: 'KSNDMC telemetric rain gauge network via KGIS and data.opencity.in; WMO Guide to Hydrological Practices (WMO-No. 168), precipitation network density' },
        { id: 'tbcare', equity: true, title: 'TB care reach', icon: '🫁',
            question: 'How far must people, especially in slums, travel to a TB unit or a rapid TB test?',
            field: { key: 'tb_units_3km', label: `TB units and centres within ${TBU_KM} km`, unit: 'units', higherIs: 'better', ramp: 'greens', domain: [0, 5] },
            needs: ['tb_care.tb_units', 'tb_care.tb_tests', 'tb_care.drtb_centres', 'slums_mapped.slum_pct', 'population.population'],
            method: `Karnataka health department maps on KGIS via data.opencity.in (public domain): National TB Elimination Programme TB units, CBNAAT molecular testing sites, drug-resistant and district TB centres. Each block counts TB units and centres within ${TBU_KM} km and CBNAAT sites within ${TEST_KM} km; residents are WorldPop and slum residents are residents × the share of the block inside a mapped slum. New TB unit picks are blocks ${2 * TBU_KM} km apart beyond ${TBU_KM} km of one, ranked by residents plus four times slum residents within ${TBU_KM} km. Sputum is also collected at many primary health centres and private labs, which these maps do not show, so this is reach to the programme's diagnosing and treating units. Bengaluru, and Chennai from Greater Chennai Corporation's TB centre map (TB centres only, no testing-site layer).`,
            refs: 'Karnataka health department TB facility maps (KGIS) and Greater Chennai Corporation TB centre map via data.opencity.in; National TB Elimination Programme (NTEP) technical and operational guidelines' },
        { id: 'servicecentres', equity: true, title: 'Citizen service centres', icon: '🏛️',
            question: 'How far must people walk to get an Aadhaar update, a certificate or a scheme application done?',
            field: { key: 'service_centres_1km', label: `Citizen service centres within ${CSC_KM} km`, unit: 'centres', higherIs: 'better', ramp: 'greens', domain: [0, 10] },
            needs: ['service_centres.csc', 'service_centres.grama_one', 'service_centres.aadhaar', 'demographics.elderly_60plus', 'slums_mapped.slum_pct', 'population.population'],
            method: `Karnataka e-governance maps on data.opencity.in (public domain): Common Service Centre and Grama One locations in Bengaluru Urban district, and the Aadhaar enrolment centre map for Chennai. Only the locations are used; operator names and phone numbers on the maps are not read. Each block counts centres within ${CSC_KM} km (straight line between block centres); residents and residents aged 60+ are WorldPop and slum residents are residents × the share of the block inside a mapped slum. New centre picks are blocks ${2 * CSC_KM} km apart beyond ${CSC_KM} km of a centre, ranked by residents plus twice the elderly and twice slum residents within ${CSC_KM} km. Bangalore One, ward offices, banks and post offices also offer some of these services and are not on these maps; in Chennai only Aadhaar centres are mapped, so certificates and bill-payment counters are missing. Bengaluru and Chennai only.`,
            refs: 'Karnataka Centre for e-Governance, Common Service Centre and Grama One location maps via data.opencity.in; Ministry of Electronics and IT, CSC 2.0 scheme guidelines' },
        { id: 'recycling', equity: false, title: 'Recycling reach', icon: '♻️',
            question: 'Who can drop off recyclables, old clothes or e-waste nearby, and who lives next to a compost yard?',
            field: { key: 'recycle_1km', label: `Recycling drop-off centres within ${RECYCLE_KM} km`, unit: 'centres', higherIs: 'better', ramp: 'greens', domain: [0, 5] },
            needs: ['waste_recovery.recovery_centres', 'waste_recovery.processing_sites', 'population.population'],
            method: `Maps on data.opencity.in (public domain): BBMP's Reduce-Reuse-Recycle centres and KSPCB e-waste collection centres in Bengaluru; Greater Chennai Corporation's resource recovery centres, compost yards, vermicompost, biogas and biomethanisation plants (2022) in Chennai. Each block counts drop-off centres within ${RECYCLE_KM} km (straight line between block centres) and processing sites in and next to it (about ${PROCESS_M} m); residents are WorldPop. New drop-off picks are blocks ${2 * RECYCLE_KM} km apart beyond ${RECYCLE_KM} km of a centre, ranked by residents beyond reach within ${RECYCLE_KM} km. Door-to-door segregated collection and kabadiwalas carry most recyclables in Indian cities, so a centre is a drop-off option, not the only route; Bengaluru's dry waste collection centres are not on an openly licensed map. Bengaluru and Chennai only.`,
            refs: 'BBMP Reduce-Reuse-Recycle centre notification; KSPCB waste facility maps (KGIS); Greater Chennai Corporation solid waste maps (2022); all via data.opencity.in; Solid Waste Management Rules 2016' },
        { id: 'publicland', equity: false, title: 'Public land bank', icon: '🏛️',
            question: 'Which plots does the city corporation own, which stand vacant, and which could host a clinic or anganwadi?',
            field: { key: 'gba_land_m2', label: 'Corporation-owned land in the block (recorded area)', unit: 'm²', higherIs: null, ramp: 'blues', domain: [0, 20000] },
            needs: ['public_land.gba_plots', 'public_land.gba_land_m2', 'public_land.vacant_plots', 'public_land.vacant_m2', 'public_land.amenity_plots', 'public_care.primary', 'anganwadis.centres', 'population.population'],
            method: `The Greater Bengaluru Authority's 2026 property register on data.opencity.in (public domain): 6,817 properties with a recorded area and a description. Only the 2,792 the register places on the plot (quality 'unique') are used; the rest sit on about 200 shared ward or locality points. Descriptions (mostly in Kannada) are matched by keyword: vacant land (ಖಾಲಿ ಜಾಗ, including undeveloped park plots) and plots used for a school, clinic, anganwadi, library, community hall, toilet or market. Public clinics are the corporation's health centres and Namma Clinics; anganwadis are the ICDS map. Plots to put to use are vacant plots ${SPACING_KM} km apart ranked by residents within ${CLINIC_KM} km lacking a public clinic within ${CLINIC_KM} km or an anganwadi within ${LAND_NEAR_KM * 1000} m, weighted up for larger plots. Recorded areas can be out of date, and a plot listed as vacant may be encroached, disputed or already earmarked. Bengaluru only.`,
            refs: 'Greater Bengaluru Authority property register (2026) via data.opencity.in' },
        { id: 'daytime', equity: false, title: 'Day and night', icon: '🌗',
            question: 'Which blocks fill up by day and which empty out, and how many people move between them?',
            field: { key: 'day_night_pct', label: 'Daytime people against residents (+100 all day, −100 all night)', unit: '', higherIs: null, ramp: 'diverging', domain: [-100, 100] },
            needs: ['ambient_pop.ambient_pop', 'ambient_pop.ambient_change_pct', 'population.population'],
            method: `LandScan Global 2024 (Oak Ridge National Laboratory, CC BY 4.0, about 1 km): the average number of people present over 24 hours, modelled from census counts, land use, roads, buildings and points of interest, so offices, markets, campuses and stations carry the people who spend the day there. Residents are the GHSL 2020 counts, averaged over the blocks within 500 m so both sit on a ~1 km footing. LandScan's city totals run 30 to 40% below the resident counts, so ambient people are rescaled to the residents' total and only the pattern is compared: each block shows (daytime − residents) ÷ (daytime + residents). Magnets hold at least twice their residents by day (and 500 people more); bedroom blocks the reverse. Picks are blocks ${SPACING_KM} km apart with the largest net gain or loss within ${DAY_KM} km. A 24-hour average, not a daytime count, from a different model than the resident counts: the pattern of magnets and bedroom areas is meaningful, but the size of any one gap mixes real movement with differences between the two models, and night markets and night shifts do not show.`,
            refs: 'Sims et al., LandScan Global 2024 (Oak Ridge National Laboratory, CC BY 4.0); Bhaduri et al. 2007, LandScan USA: a high-resolution geospatial and temporal modeling approach for population distribution and dynamics (GeoJournal)' },
        { id: 'sinking', equity: false, title: 'Sinking ground', icon: '⬇️',
            question: 'Where is the ground likely to be sinking, and who lives and builds on it?',
            field: { key: 'subsid_prob_pct', label: 'Chance the ground sank more than 1 cm a year, 2013-2019 (modelled)', unit: '%', higherIs: 'worse', ramp: 'reds', domain: [20, 80] },
            needs: ['subsidence.subsid_prob_pct', 'building_stock.height_2023_m', 'population.population'],
            method: `Hasan et al. 2023 (Nature Communications, CC BY 4.0): a random-forest model trained on InSAR and GPS subsidence measurements from around the world, with groundwater depletion, irrigation, climate, soil, sediment thickness, geology and land cover as predictors, gives the probability that land subsided more than 1 cm a year in 2013-2019 on a grid of about 2 km. Each block takes its cell's probability; residents are GHSL. Hotspots are blocks ${SPACING_KM} km apart with a ${SINK_HIGH}% chance or more, ranked by residents within 1 km weighted by the chance. A global model at 2 km, not a measurement: it shows where conditions favour subsidence (heavy pumping on soft alluvium), not the rate under a given building, and local InSAR studies should confirm any hotspot.`,
            refs: 'Hasan, Smith, Vajedian, Pommerenke, Majumdar 2023, Global land subsidence mapping reveals widespread loss of aquifer storage capacity (Nature Communications 14, 6180)' },
        { id: 'hillside', equity: true, title: 'Hillside homes', icon: '⛰️',
            question: 'Who lives on steep hillsides where monsoon landslides and wall collapses strike?',
            field: { key: 'slope_deg', label: 'Average ground slope', unit: '°', higherIs: 'worse', ramp: 'reds', domain: [0, 20] },
            needs: ['terrain.slope_deg', 'slums_mapped.slum_pct', 'landslides.landslides', 'landslides.landslide_deaths', 'population.population'],
            method: `Average slope of each block from the 30 m Copernicus DEM (block averages flatten the steepest pockets, so ${STEEP_DEG}° on average means much steeper ground in places); residents are GHSL and slum residents are residents × the share of the block inside a mapped slum. Recorded landslides are NASA's Global Landslide Catalog (rainfall-triggered events from news, official and scientific reports, 1970-2019), which misses many small slides and everything after 2019. Hillsides to check are blocks ${SPACING_KM} km apart on ${STEEP_DEG}° or steeper ground, ranked by (residents + 4 × slum residents) × slope within 500 m. Slope is a screen, not a slope-stability survey: rock type, cutting, drainage and retaining walls decide whether a hill fails.`,
            refs: 'Kirby, Juang and Stanley, NASA Global Landslide Catalog (1970-2019); Copernicus GLO-30 DEM; MCGM landslide-prone locations lists (monsoon preparedness)' },
        { id: 'coldnights', equity: true, title: 'Cold nights', icon: '🥶',
            question: 'Where do winter nights bite hardest, and who sleeps there in thin-walled homes?',
            field: { key: 'winter_excess_c', label: "Clear winter night surface temperature against the median resident's", unit: '°C', higherIs: 'better', ramp: 'diverging', domain: [-3, 3] },
            needs: ['winter_nights.winter_lst_c', 'winter_nights.winter_anomaly_c', 'winter_nights.winter_scenes', 'urban_form.res_atomistic_pct', 'urban_form.res_informal_pct', 'slums_mapped.slum_pct', 'demographics.elderly_60plus', 'demographics.under5', 'population.population'],
            method: `NASA ECOSTRESS (thermal radiometer on the International Space Station, public domain): land surface temperature at 70 m. Each block takes the median of cloud-free, non-water pixels on December to February nights (21:30 to 05:30 IST) from winter 2019-20 to 2025-26; fog and cloud are masked, so it is the clear, still nights when the ground radiates its heat away and cold waves set in. The map shows each block against the night the median resident sleeps through, and cold pockets are ${COLD_NIGHT_C} °C or more below it. Residents, the elderly and children under 5 are WorldPop; unplanned or informal blocks are those where WRI's intra-urban land use map puts over ${UNPLANNED_COLD_PCT}% of the residential ground in irregular plots or unapproved subdivisions, a rough stand-in for thin walls and roofs; slum residents are residents × the share of the block inside a mapped slum. Picks are cold-pocket blocks ${SPACING_KM} km apart ranked by (residents + 3 × elderly + 3 × under 5) × degrees below the median, doubled in unplanned blocks. Surface, not air, temperature: air indoors and on the street is milder, but the pattern of where nights run coldest holds. Run for the eight cities with a real winter (Delhi, Lucknow, Jaipur, Bhopal, Indore, Guna, Ahmedabad, Kolkata); the homeless, who die most in cold waves, are not counted by any of these maps.`,
            refs: 'Hook and Hulley, ECOSTRESS L2T LSTE V2 (NASA LP DAAC); NDMA National Guidelines on Cold Wave (2021); IMD cold wave criteria; Guzder-Williams et al. 2023, Intra-urban land use maps (WRI)' },
        { id: 'heatedup', equity: false, title: 'Heated up', icon: '📈',
            question: 'Which neighbourhoods have turned hotter than the rest of the city since the early 2000s, and why?',
            field: { key: 'heat_rel_change_c', label: 'April-May surface heat against the city, change since 2000-06', unit: '°C', higherIs: 'worse', ramp: 'diverging', domain: [-6, 6] },
            needs: ['heat_change.lst_2000s_c', 'heat_change.lst_2020s_c', 'heat_change.heat_rel_change_c', 'built_up.built_change_pct', 'vegetation.tree_canopy_pct', 'population.population'],
            method: `USGS Landsat Collection 2 surface temperature (public domain, 30 m): cloud-free April and May scenes in 2000-2006 (Landsat 5 and 7) and in 2021-2025 (Landsat 8 and 9). The two periods use different sensors and years with different weather, so the raw change is not trusted; every scene is first turned into each pixel's gap to that scene's median over the city region's land (pixels that are water at least half the time in JRC's Global Surface Water are left out), each period takes the median gap, and the lens maps how the gap changed. In hot, dry cities bare fallow and rock heat up more by day than built ground, so new building on them can read as relative cooling, while dense old cores that lost trees and gained roofs read as warming. Warmed blocks moved ${WARMED_C} °C or more hotter against the city. New built surface 2000 to 2020 is GHSL; blocks with ${NEW_BUILT_PCT}% or more of their ground newly built are compared with blocks under 5%. Tree canopy is today's (Meta/WRI). Residents are today's (WorldPop). Picks are warmed blocks ${SPACING_KM} km apart ranked by residents × warming. Surface, not air, temperature, and a relative measure: if the whole city warmed, a block that kept pace shows zero.`,
            refs: 'USGS Landsat Collection 2 Level-2 surface temperature; Pesaresi et al., GHSL GHS-BUILT-S R2023A; Peng et al. 2012, Surface urban heat island across 419 global big cities (Environmental Science & Technology)' },
        { id: 'greenchange', equity: false, title: 'Green then and now', icon: '🌳',
            question: 'Which neighbourhoods have lost their green since the early 2000s, and did they heat up?',
            field: { key: 'green_loss', label: 'Greenness (NDVI) lost against the city since 2000-06 (negative: gained)', unit: '', higherIs: 'worse', ramp: 'diverging', domain: [-0.3, 0.3] },
            needs: ['green_change.ndvi_2000s', 'green_change.ndvi_2020s', 'green_change.green_rel_change', 'heat_change.heat_rel_change_c', 'population.population'],
            method: `USGS Landsat Collection 2 surface reflectance (public domain, 30 m): NDVI on cloud-free April and May scenes in 2000-2006 (Landsat 5 and 7) and 2021-2025 (Landsat 8 and 9). April and May are dry, so trees, watered parks and irrigated plots stand out while most fields lie harvested. Every scene is turned into each pixel's gap to that scene's median over the city region's land (pixels that are water at least half the time in JRC's Global Surface Water are left out), each period takes the median gap, and the lens maps how the gap changed, which cancels the different sensors and weather years. Browned and greened blocks moved ${GREEN_SHIFT} NDVI or more against the city. Surface heat change is the Heated up lens's Landsat measure for the same scenes. Residents are today's (WorldPop). Picks are browned blocks ${SPACING_KM} km apart ranked by residents × loss. A relative measure: if the whole city lost green, a block that kept pace shows zero; fields that were irrigated in one period and fallow in the other can swing either way.`,
            refs: 'USGS Landsat Collection 2 Level-2 surface reflectance; Pekel et al. 2016, JRC Global Surface Water (Nature)' },
        { id: 'nightshelters', equity: true, title: 'Night shelters', icon: '🛏️',
            question: 'Are there enough night shelters for the homeless, and are they where homeless people sleep?',
            field: { key: 'shelters_2km', label: `Night shelters within ${SHELTER_KM} km`, unit: 'shelters', higherIs: 'better', ramp: 'greens', domain: [0, 5] },
            needs: ['night_shelters.shelters', 'night_shelters.for_men', 'night_shelters.for_women', 'night_shelters.for_children', 'night_shelters.special', 'ambient_pop.ambient_pop', 'rail_access.rail_stations', 'rail_access.metro_stations', 'wards.ward_no', 'population.population'],
            method: `Greater Chennai Corporation's night shelter map on data.opencity.in (public domain), the shelters run under the National Urban Livelihoods Mission's Shelter for Urban Homeless scheme, by who they take in (men, women, children, and special shelters for psycho-social needs, disability, the elderly and transgender people). Only locations and shelter types are read; the caretakers' names and phone numbers on the map are not. The norm is the scheme's one permanent shelter per lakh people; residents are GHSL, counted inside the corporation's wards only, as the map stops there. Each block counts shelters within ${SHELTER_KM} km (straight line between block centres). Homeless people gather where there is daytime work and footfall, around stations, markets and bus stands, so shelters to add are blocks ${2 * SHELTER_KM} km apart beyond ${SHELTER_KM} km of a shelter, ranked by LandScan daytime people within 1 km, tripled for railway and metro station blocks. No count of homeless people by place is published, so this is about reach and the norm, not demand. Chennai only: Bengaluru's shelter list gives addresses without locations.`,
            refs: 'Greater Chennai Corporation night shelters map via data.opencity.in; MoHUA, DAY-NULM Scheme of Shelter for Urban Homeless operational guidelines; Supreme Court of India, E.R. Kumar v. Union of India (shelter monitoring)' },
        { id: 'hotdays', equity: true, title: 'Hot days, measured', icon: '🌡️',
            question: 'How many days a year does it pass 40 °C in each neighbourhood, and is that rising?',
            field: { key: 'days40_now', label: 'Days a year with air temperature at 40 °C or more (2015-2024)', unit: 'days', higherIs: 'worse', ramp: 'heat', domain: [0, 60] },
            needs: ['air_heat.days40_now', 'air_heat.days40_then', 'air_heat.days45_now', 'air_heat.days45_then', 'air_heat.nights28_now', 'air_heat.nights28_then', 'climate_future.hot_days_now', 'demographics.elderly_60plus', 'population.population'],
            method: `Zhang et al.'s global 1 km daily maximum and minimum near-surface air temperature (CC BY 4.0), modelled from MODIS land surface temperature, elevation and weather-station records (cross-validated error 1.2 to 2.4 °C). Each block takes its 1 km cell's yearly counts of days at 40 °C or more (IMD's heatwave threshold for the plains), days at 45 °C or more (a heatwave whatever the normal) and nights at 28 °C or more, averaged over 2005-2014 and 2015-2024. City figures weight blocks by today's residents (GHSL); the elderly are WorldPop. Hottest homes are blocks ${SPACING_KM} km apart ranked by (residents + 3 × residents aged 60+) × days above the median resident's. The ERA5-Land count behind the 2050 outlook is shown for comparison: it is a 9 km reanalysis and smooths the city out. Modelled air temperature, not a station record: errors of 1 to 2 °C shift counts near the thresholds, so compare places and decades rather than reading single days.`,
            refs: 'Zhang, Zhou et al. 2022, A global dataset of daily maximum and minimum near-surface air temperature at 1 km resolution over land (Earth System Science Data); IMD heatwave criteria; NDMA Heat Action Plan guidelines (2019)' },
        { id: 'tankbeds', equity: true, title: 'Old tank beds', icon: '🏞️',
            question: 'Who lives on the beds of old tanks, and how many tanks have been built over?',
            field: { key: 'tankbed_built_pct', label: 'Share of the block on a tank bed built up by 2023', unit: '%', higherIs: 'worse', ramp: 'reds', domain: [0, 60] },
            needs: ['tank_beds.tankbed_pct', 'tank_beds.tankbed_built_pct', 'tank_beds.tankbed_water_pct', 'tank_beds.tanks', 'tank_beds.tanks_live', 'tank_beds.tanks_lost', 'tank_beds.tanks_worse', 'flood_reports.flood_spots', 'waterlogging.waterlogging_index', 'population.population'],
            method: `HYDRAA's survey of 920 tanks inside Hyderabad's Outer Ring Road (via data.opencity.in, public domain) draws each tank on its old village-map outline (before the 1940s to the 1970s), classes each part as water or built up in 2023, and gives each tank's status in 2014 and 2023: live, or partly or wholly encroached by buildings or farming. Outlines are filled on a 10 m raster and shared out to blocks; each tank is counted once, in the block holding its largest part. Residents on a tank bed are block residents (GHSL) times the block's built-up bed share, assuming people spread evenly over the block. Waterlogging is the Sentinel-1 radar index (waterlogging); reported flood spots are GHMC's inundation points (flood_reports). Picks are blocks ${SPACING_KM} km apart ranked by residents on the bed × (1 + waterlogging index / 100). Only the survey's tanks are drawn; the Musi floodplain and tanks outside the survey are not.`,
            refs: 'HYDRAA (Hyderabad Disaster Response and Asset Protection Agency) ORR tank survey via data.opencity.in; Telangana GO Ms 168 (2012) tank buffers; GHMC inundation points' },
        { id: 'jobcount', title: 'Workplaces counted', icon: '🏭',
            question: 'Where were the jobs actually counted, and what kind of work was it?',
            field: { key: 'ec_workers_km2', label: 'Workers per km² in the ward (6th Economic Census, 2012-13)', unit: 'workers/km²', higherIs: null, ramp: 'viridis', domain: [0, 60000] },
            needs: ['econ_census.ec_ward', 'econ_census.ec_workers', 'econ_census.ec_estabs', 'econ_census.mfg_pct', 'econ_census.trade_pct', 'econ_census.home_pct', 'econ_census.women_pct', 'econ_census.women_owner_pct', 'places.places', 'population.population'],
            method: `MoSPI's 6th Economic Census (2012-13) microdata for Kolkata (via data.opencity.in, public domain): every establishment, fixed or not, with its KMC ward, broad activity, whether it runs from inside a household, ownership, the proprietor's sex and workers by sex. Crop farming, public administration and defence are outside the census, so government offices and the port are undercounted. Ward figures are joined to blocks through the KMC ward map (wards); ward area is its mapped blocks, and residents are today's GHSL estimate, so workers per resident mixes 2012-13 jobs with 2020s homes. The rank match is a Spearman correlation across wards between census workers per km² and Overture places per km², a check on how well today's place data stands in for jobs. Social group and religion columns are not read.`,
            refs: 'Ministry of Statistics and Programme Implementation, 6th Economic Census 2012-13 (all-India report and Kolkata microdata via data.opencity.in); Overture Maps places' },
        { id: 'ptax', title: 'Property tax by ward', icon: '🧾',
            question: 'How much property tax does each ward pay per resident, and does it match land values?',
            field: { key: 'ptax_per_resident', label: 'Residential property tax billed per resident (2017-18)', unit: '₹/yr', higherIs: null, ramp: 'viridis', domain: [0, 1500] },
            needs: ['property_tax.pt_ward', 'property_tax.pt_res_demand_lakh', 'property_tax.pt_com_demand_lakh', 'property_tax.pt_collect_pct', 'property_tax.pt_res_growth_pct', 'land_value.value_index', 'population.population'],
            method: `Greater Chennai Corporation's ward-wise property tax demand and collection for 2013-14 to 2017-18 (via data.opencity.in, public domain), joined to blocks through the GCC 200-ward map (wards). Residential demand is billed on the annual rental value GCC assesses (rates last revised in 1998 until the 2018 revision), so per resident it is an old but official gauge of home values; residents are today's GHSL estimate. The rank match is a Spearman correlation across wards between tax billed (per resident, and per km² of mapped ward) and the residents-weighted land value index (land_value); per km² both rise with density, so the per-resident match is the fairer test; wards billed low for their land value are those whose percentile on the bill sits furthest below their percentile on land value: candidates for reassessment or for a check on the model. Collection is collected over billed across the five years; above 100% means arrears were cleared.`,
            refs: 'Greater Chennai Corporation property tax, ward-wise demand and collection 2013-18 via data.opencity.in; Chennai City Municipal Corporation Act 1919 (annual rental value assessment)' },
        { id: 'streetgrid', equity: true, title: 'Street connectivity', icon: '🔀',
            question: 'Where do streets connect well, and where do dead ends and long blocks force detours?',
            field: { key: 'intersections_km2', label: 'Street intersections per km² within 500 m', unit: 'per km²', higherIs: 'better', ramp: 'viridis', domain: [0, 250] },
            needs: ['street_grid.intersections', 'street_grid.dead_ends', 'population.population'],
            method: `Overture Maps transportation segments (from OpenStreetMap, ODbL), public streets only: trunk to residential, unclassified, living and pedestrian streets; motorways, service lanes, footways and paths are left out because Indian cities map them so unevenly. Each connector's degree is the number of street ends meeting there, a segment passing through counting twice: three or more is an intersection, one is a dead end. Densities are averaged over blocks within ${GRID_KM * 1000} m of each home. UN-Habitat's street-connectivity guidance and walkability studies treat about 80 to 100 intersections per km² as a fine, walkable grid; under ${GRID_LOW} is coarse. Dead ends include true cul-de-sacs, gated lanes and gaps in the map, so a high share can also mean incomplete mapping. Picks are blocks ${SPACING_KM} km apart ranked by residents × how far below ${GRID_LOW} the grid falls × dead-end share.`,
            refs: 'UN-Habitat, A New Strategy of Sustainable Neighbourhood Planning: Five Principles (2014); Ewing & Cervero, Travel and the Built Environment (JAPA 2010); Overture Maps Foundation transportation theme' },
    ];

    UrbanLenses.register(ENTRIES, { howbuilt, floodnews, badairdays, stillair, schooldrift, hotnights, newroads, raingaugegap, tbcare, servicecentres, recycling, publicland, daytime, sinking, hillside, coldnights, heatedup, greenchange, nightshelters, hotdays, tankbeds, jobcount, ptax, streetgrid });
    return { ENTRIES };
})();
