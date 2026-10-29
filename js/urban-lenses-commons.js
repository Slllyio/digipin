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
            'West of Chord Road–Outer Ring Road', 'MEI Junction'].map(n => `${n} elevated corridor`).concat('Bengaluru Business Corridor (Peripheral Ring Road)'),
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
            headline: `${_round(km, 1)} km of planned elevated corridor and ring road crosses this map; ${_people(sumPop(on))} residents live in the blocks it runs through and ${_people(nearPop)} within ${ROAD_NEAR_M} m, who face the construction years and the traffic it brings${top ? `, most of them along the ${top}` : ''}.`,
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
            method: `Alignment maps on data.opencity.in (public domain): Greater Bengaluru Authority's eleven elevated corridors from the August 2026 list (categories A to C, tenders floated), one centreline each (right-of-way edge lines drawn beside a centreline are dropped), and BDA's Peripheral Ring Road, now the 73 km Bengaluru Business Corridor (October 2022 alignment, land acquisition under way in 2026), drawn as its right-of-way outline, whose length counts once. Each block within 3 km takes the distance from its centre to the nearest alignment and the alignment length inside it. Residents are WorldPop; road noise is the traffic model's Lden; trees are the Bengaluru tree census. Alignments in tender documents can still shift, an elevated corridor touches the ground only at its piers and ramps, while the ring road takes its whole right of way. Bengaluru only: the pipeline also reads MSRDC's Pune Outer Ring Road, but it runs almost entirely outside the Pune map.`,
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
    ];

    UrbanLenses.register(ENTRIES, { howbuilt, floodnews, badairdays, stillair, schooldrift, hotnights, newroads, raingaugegap, tbcare, servicecentres });
    return { ENTRIES };
})();
