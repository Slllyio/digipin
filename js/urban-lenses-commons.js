/**
 * Commons lenses for UrbanLenses: shared conditions every resident lives with, read from national and global open
 * data (wind near the ground, the drift between government and private schools). Registers itself on load, after
 * urban-lenses.js.
 */
const UrbanLensesCommons = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _sumOver, _residents } = UrbanLenses._kit;

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

    const ENTRIES = [
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

    UrbanLenses.register(ENTRIES, { stillair, schooldrift });
    return { ENTRIES };
})();
