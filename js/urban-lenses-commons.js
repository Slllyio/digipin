/**
 * Commons lenses for UrbanLenses: shared conditions every resident lives with, read from national and global open
 * data (floods in the news, bad-air days, wind near the ground, the drift between government and private schools). Registers itself on load, after
 * urban-lenses.js.
 */
const UrbanLensesCommons = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _sumOver, _residents, within } = UrbanLenses._kit;

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

    const ENTRIES = [
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
    ];

    UrbanLenses.register(ENTRIES, { floodnews, badairdays, stillair, schooldrift });
    return { ENTRIES };
})();
