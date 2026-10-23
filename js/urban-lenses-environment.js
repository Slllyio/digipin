/**
 * Environment and city-systems lenses for UrbanLenses: cool roofs, what changed (satellite embeddings) and
 * look-alike blocks, air trend, open burning, ground conditions, tree planting, lake health and where the jobs
 * are. They read the roofs, embeddings, air_trend, fires, subsoil and lakes cell datasets
 * (pipeline/cells/ee_layers.py, pipeline/cells/embeddings.py). Registers itself on load, after urban-lenses.js.
 */
const UrbanLensesEnvironment = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _sumOver, wquantile, within } = UrbanLenses._kit;

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

    // Cool roofs. Painting or lime-washing a dark roof lifts its albedo to about 0.65; trials in Ahmedabad's informal
    // homes found rooms under cool roofs 2–5 °C cooler. Low-rise homes (under 6 m) feel the roof most.
    const COOL_ALBEDO = 0.65, COOL_COST_M2 = 300, LOW_RISE_M = 6, DARK_LIMIT = 0.17;

    /** Cool roofs: dark roof area, who lives under it, and where painting roofs white helps the hottest, poorest blocks first. */
    function coolroof(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const alb = c['roofs.roof_albedo'], dark = c['roofs.dark_roof_pct'], cover = c['building_stock.cover_2023_pct'];
        const pop = c['population.population'], lst = c['surface_heat.lst_day_c'], h = c['building_stock.height_2023_m'], rwi = c['wealth.rwi'];
        if (!alb || !dark || !cover || !pop) return null;
        const cells = [];
        for (let i = 0; i < n; i++) if (_fin(alb[i]) && _fin(dark[i]) && _fin(cover[i]) && cover[i] > 0) cells.push(i);
        if (cells.length < 5) return null;
        const res = cells.filter(i => pop[i] > 0), people = _sumOver(pop, res, () => true);
        let hotMean = null;
        if (lst) { let s = 0, w = 0; for (const i of res) if (_fin(lst[i])) { s += lst[i] * pop[i]; w += pop[i]; } hotMean = w ? s / w : null; }
        const darkM2 = new Float64Array(n).fill(NaN), prio = new Float64Array(n).fill(NaN);
        let roofAll = 0, roofDark = 0, albSum = 0;
        for (const i of cells) {
            const roof = cover[i] / 100 * g.cellKm2 * 1e6;
            darkM2[i] = roof * dark[i] / 100; roofAll += roof; roofDark += darkM2[i]; albSum += alb[i] * roof;
            if (pop[i] > 0) {
                const heat = hotMean != null && _fin(lst[i]) ? 1 + Math.max(0, lst[i] - hotMean) / 5 : 1;
                const poor = rwi && _fin(rwi[i]) && rwi[i] < 0 ? 1.5 : 1;
                const low = h && _fin(h[i]) && h[i] < LOW_RISE_M ? 1.5 : 1;
                prio[i] = pop[i] * dark[i] / 100 * heat * poor * low;
            }
        }
        const underDark = res.reduce((s, i) => s + pop[i] * dark[i] / 100, 0);
        const lowDark = h ? res.reduce((s, i) => s + (_fin(h[i]) && h[i] < LOW_RISE_M ? pop[i] * dark[i] / 100 : 0), 0) : null;
        const crore = roofDark * COOL_COST_M2 / 1e7;
        const stats = [
            { label: `Roof area that is dark (10 m albedo under ${DARK_LIMIT})`, value: `${_round(roofDark / 1e6, 1)} km² of ${_round(roofAll / 1e6, 1)} km² (${_round(100 * roofDark / roofAll)}%)`, raw: _round(100 * roofDark / roofAll) },
            { label: 'Average roof albedo (share of sunlight reflected)', value: `${_round(albSum / roofAll, 2)}; cool paint reaches ${COOL_ALBEDO}` },
            { label: 'Residents under dark roofs (block share of dark roof × residents)', value: `${_people(underDark)} (${_round(100 * underDark / people)}%)` },
        ];
        if (lowDark != null) stats.push({ label: `Of them in low-rise blocks (under ${LOW_RISE_M} m), where the roof heats the rooms directly`, value: `${_people(lowDark)}` });
        stats.push({ label: `Cost to coat every dark roof (about ₹${COOL_COST_M2}/m²)`, value: `₹${Math.round(crore).toLocaleString('en-IN')} crore` });
        if (hotMean != null) {
            const hot = wquantile(lst, pop, res.filter(i => _fin(lst[i])), 0.8), cool = wquantile(lst, pop, res.filter(i => _fin(lst[i])), 0.2);
            const share = sel => { let d = 0, a = 0; for (const i of sel) { const r = cover[i] / 100; d += r * dark[i]; a += r; } return a ? d / a : null; };
            const sh = share(res.filter(i => _fin(lst[i]) && lst[i] >= hot)), sc = share(res.filter(i => _fin(lst[i]) && lst[i] <= cool));
            if (sh != null && sc != null) stats.push({ label: 'Dark share of roofs: hottest fifth of residents vs coolest fifth', value: `${Math.round(sh)}% vs ${Math.round(sc)}%` });
        }
        return {
            columns: { cool_priority: prio, dark_roof_m2: darkM2 }, idx: cells, weightKey: 'cool_priority',
            metric: { label: 'Residents under dark roofs', value: Math.round(underDark), unit: 'people', higherIs: 'worse' },
            headline: `${_round(100 * roofDark / roofAll)}% of the city's roof area reads dark from space (10 m albedo under ${DARK_LIMIT}), over about ${_people(underDark)} residents; coating it white would cost roughly ₹${Math.round(crore).toLocaleString('en-IN')} crore, and trials in Ahmedabad found rooms under cool roofs 2–5 °C cooler.`,
            stats,
        };
    }

    // "Looks like this from space": distance between blocks' satellite embeddings (12 shared principal components of
    // Google's AlphaEarth 64-number summary), so matches share built form, materials, greenery and water, in any city.
    const EMB_DIMS = 12, EMB_KEYS = Array.from({ length: EMB_DIMS }, (_, k) => `embeddings.e${k}`), LOOK_EXCLUDE_KM = 1;

    async function _embFrame(city, store) {
        const fr = await UrbanLenses.frame(city, store, ['population.population', 'embeddings.change_8yr', ...EMB_KEYS]);
        const E = EMB_KEYS.map(k => fr.cols[k]);
        if (E.some(a => !a)) return null;
        const idx = [];
        for (let i = 0; i < fr.grid.n; i++) if (E.every(a => _fin(a[i]))) idx.push(i);
        return { fr, g: fr.grid, E, idx };
    }

    /** Blocks of `toCity` (default the same city) whose satellite embedding is nearest the block at lat/lng in `fromCity`. */
    async function lookalike({ fromCity, lat, lng, toCity, k = TOP }, store) {
        const A = await _embFrame(fromCity, store);
        if (!A) return null;
        const code = DigiPin.encode(lat, lng).replace(/-/g, '').slice(0, 7), i0 = A.g.codes.indexOf(code);
        if (i0 < 0 || !A.E.every(a => _fin(a[i0]))) return null;
        const ref = A.E.map(a => a[i0]);
        const B = toCity && toCity !== fromCity ? await _embFrame(toCity, store) : A;
        if (!B) return null;
        const dist = new Float64Array(B.g.n).fill(NaN), cand = [];
        for (const i of B.idx) {
            if (B === A && Math.hypot((B.g.row[i] - B.g.row[i0]) * B.g.dy, (B.g.col[i] - B.g.col[i0]) * B.g.dx) < LOOK_EXCLUDE_KM) continue;
            let d = 0;
            for (let f = 0; f < EMB_DIMS; f++) d += (B.E[f][i] - ref[f]) ** 2;
            dist[i] = Math.sqrt(d); cand.push(i);
        }
        if (!cand.length) return null;
        const sorted = cand.map(i => dist[i]).sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
        const score = Float64Array.from(dist, v => (_fin(v) ? -v : NaN));
        const pop = B.fr.cols['population.population'], chg = B.fr.cols['embeddings.change_8yr'];
        const matches = spaced(B.g, cand, score, k).map(i => ({
            code: B.g.codes[i], similarity: Math.max(0, Math.round(100 * (1 - dist[i] / med))),
            people: pop && _fin(pop[i]) ? Math.round(pop[i]) : null, change: chg && _fin(chg[i]) ? chg[i] : null,
        }));
        return { fromCity, toCity: toCity || fromCity, ref: { code }, matches };
    }

    function lookalikeText(r) {
        if (!r) return 'That spot has no satellite embedding yet. Click a block inside one of the cities and ask again.';
        const L = typeof UrbanInsights !== 'undefined' ? UrbanInsights.cityLabel : (c => c);
        return [`Blocks in ${L(r.toCity)} that look most like ${r.ref.code} in ${L(r.fromCity)} from space (built form, roofs, greenery, water; 100% = identical, 0% = as different as a typical block):`,
            ...r.matches.map((m, i) => `${i + 1}. ${m.code}: ${m.similarity}% match${m.people != null ? `, ${_people(m.people)} residents` : ''}`)].join('\n');
    }

    // Change since 2017: 1 − cosine similarity of a block's mean satellite embedding. Years differ in rain and haze, so
    // a block counts as strongly changed when it moved at least CHG_X times as much as the city's median block.
    const CHG_X = 3;

    /** What changed: blocks whose satellite signature moved most since 2017 and since 2023, and what the change was. */
    function change(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const c8 = c['embeddings.change_8yr'], c2 = c['embeddings.change_2yr'], pop = c['population.population'];
        const nb = c['building_stock.new_buildings'], gp = c['building_stock.growth_pct'], tree = c['vegetation.tree_canopy_pct'];
        if (!c8) return null;
        const cells = [];
        for (let i = 0; i < n; i++) if (_fin(c8[i])) cells.push(i);
        if (cells.length < 5) return null;
        const med = a => { const v = cells.filter(i => _fin(a[i])).map(i => a[i]).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
        const m8 = med(c8), m2 = c2 ? med(c2) : null;
        const strong = cells.filter(i => c8[i] >= CHG_X * m8), recent = c2 ? cells.filter(i => _fin(c2[i]) && c2[i] >= CHG_X * m2) : [];
        const km2 = strong.length * g.cellKm2;
        const stats = [
            { label: `Land that changed strongly since 2017 (${CHG_X}× the city's typical block)`, value: `${_round(km2, 1)} km² (${_round(100 * strong.length / cells.length, 1)}% of blocks)`, raw: _round(100 * strong.length / cells.length, 1) },
        ];
        if (c2) stats.push({ label: 'Changing strongly in the last two years (since 2023)', value: `${_round(recent.length * g.cellKm2, 1)} km² (${recent.length} blocks)` });
        if (pop) stats.push({ label: 'Residents in strongly changed blocks', value: _people(_sumOver(pop, strong, () => true)) });
        const lc = k => c[`land_cover.${k}_pct`];
        const share = (k, i) => (lc(k) && _fin(lc(k)[i]) ? lc(k)[i] : 0);
        const what = i => (nb && _fin(nb[i]) && nb[i] >= 20 ? `${Math.round(nb[i])} new buildings${gp && _fin(gp[i]) ? ` (+${Math.round(gp[i])}%)` : ''}`
            : share('water', i) >= 20 ? 'water body: extent or level changed' : share('bare', i) >= 30 ? 'bare ground: quarry, clearing or building site'
                : share('crop', i) >= 30 ? 'farmland: cropping changed or land left fallow' : tree && _fin(tree[i]) && tree[i] >= 30 ? 'tree-covered: greening or clearing'
                    : 'land-surface change, few new buildings');
        spaced(g, strong, c8).slice(0, 4).forEach((i, k) => stats.push({ label: `Change hotspot ${k + 1}: ${g.codes[i]}`, value: `${_round(c8[i] / m8, 1)}× typical; ${what(i)}` }));
        if (c2) spaced(g, recent, c2).slice(0, 2).forEach((i, k) => stats.push({ label: `Changing now ${k + 1}: ${g.codes[i]}`, value: `${_round(c2[i] / m2, 1)}× typical since 2023; ${what(i)}` }));
        const builtShare = nb ? _round(100 * strong.filter(i => _fin(nb[i]) && nb[i] >= 20).length / Math.max(1, strong.length)) : null;
        return {
            columns: c2 ? { change_8yr: c8, change_2yr: c2 } : { change_8yr: c8 }, idx: cells, weightKey: 'change_8yr',
            metric: { label: 'Land that changed strongly since 2017', value: _round(km2, 1), unit: 'km²', higherIs: null },
            headline: `Satellite embeddings show ${_round(km2, 1)} km² of the city changed strongly between 2017 and 2025${builtShare != null ? `; ${builtShare}% of it gained 20 or more new buildings` : ''}${c2 ? `, and ${recent.length} blocks are changing fast right now` : ''}.`,
            stats,
        };
    }

    // Air trend: changes under 10% are within year-to-year weather swings, so they count as flat.
    // SO₂ columns under ~100 µmol/m² are background and retrieval noise, so hotspots are named only above that.
    const AIR_FLAT = 10, SO2_NOTABLE = 100;

    /** Air trend: who now breathes more or less NO₂ than in 2019, how PM2.5 moved over ten years, and SO₂ hotspots. */
    function airtrend(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const dn = c['air_trend.no2_change_pct'], n0 = c['air_trend.no2_2019'], n1 = c['air_trend.no2_latest'];
        const p0 = c['air_trend.pm25_2012'], p1 = c['air_trend.pm25_2022'], so2 = c['air_trend.so2_umol_m2'], pop = c['population.population'];
        if (!dn || !pop) return null;
        const cells = [];
        for (let i = 0; i < n; i++) if (pop[i] > 0 && _fin(dn[i])) cells.push(i);
        if (cells.length < 5) return null;
        const people = _sumOver(pop, cells, () => true);
        const pw = a => { let s = 0, w = 0; for (const i of cells) if (a && _fin(a[i])) { s += a[i] * pop[i]; w += pop[i]; } return w ? s / w : null; };
        const up = _sumOver(pop, cells, i => dn[i] >= AIR_FLAT), down = _sumOver(pop, cells, i => dn[i] <= -AIR_FLAT);
        const a0 = pw(n0), a1 = pw(n1), q0 = pw(p0), q1 = pw(p1);
        const chg = a0 ? 100 * (a1 - a0) / a0 : pw(dn);
        const stats = [
            { label: 'NO₂ for the average resident, 2019 → 2025', value: a0 != null ? `${_round(a0)} → ${_round(a1)} µmol/m² (${chg >= 0 ? '+' : ''}${_round(chg)}%)` : `${_round(chg)}%`, raw: _round(chg) },
            { label: `Residents where NO₂ rose ${AIR_FLAT}% or more / fell ${AIR_FLAT}% or more`, value: `${_people(up)} (${_round(100 * up / people)}%) / ${_people(down)} (${_round(100 * down / people)}%)` },
        ];
        if (q0 != null && q1 != null) stats.push({ label: 'PM2.5 for the average resident, 2012 → 2022', value: `${_round(q0)} → ${_round(q1)} µg/m³ (${q1 >= q0 ? '+' : ''}${_round(100 * (q1 - q0) / q0)}%)` });
        if (so2) {
            const top = cells.filter(i => _fin(so2[i]) && so2[i] >= SO2_NOTABLE).sort((a, b) => so2[b] - so2[a]);
            spaced(g, top.slice(0, Math.max(5, Math.ceil(top.length / 50))), so2).slice(0, 3)
                .forEach((i, k) => stats.push({ label: `SO₂ hotspot ${k + 1}: ${g.codes[i]}`, value: `${_round(so2[i])} µmol/m² (industry, power or brick kilns nearby)` }));
        }
        const hz = k => pw(c[`haze_mix.${k}`]);
        const dust = hz('dust_share_pct'), smoke = hz('smoke_share_pct'), sulph = hz('sulphate_share_pct'), salt = hz('seasalt_share_pct'), dd = hz('dust_days_yr');
        if (dust != null) {
            stats.push({ label: 'What the haze is made of (CAMS model, city scale)', value: `dust ${_round(dust)}%, smoke ${_round(smoke)}%, sulphate ${_round(sulph)}%${salt >= 3 ? `, sea salt ${_round(salt)}%` : ''}; the rest is mostly nitrate and ammonium` });
            if (dd != null) stats.push({ label: 'Dust-haze days a year (daily dust optical depth over 0.3)', value: `${Math.round(dd)}` });
        }
        const word = Math.abs(chg) < AIR_FLAT ? 'is roughly flat' : chg > 0 ? 'has risen' : 'has fallen';
        return {
            columns: { no2_change_pct: dn }, idx: cells, weightKey: 'no2_change_pct', noHotspots: true,
            metric: { label: 'Change in NO₂ for the average resident since 2019', value: _round(chg), unit: '%', higherIs: 'worse' },
            headline: `Traffic and combustion NO₂ ${word} since 2019 (${chg >= 0 ? '+' : ''}${_round(chg)}% for the average resident); ${_people(up)} residents live where it rose ${AIR_FLAT}% or more${q0 != null && q1 != null ? `, and fine-dust PM2.5 went from ${_round(q0)} to ${_round(q1)} µg/m³ between 2012 and 2022` : ''}.`,
            stats,
        };
    }

    // Deaths from fine-particle air. GEMM NCD+LRI hazard (Burnett et al. 2018, adults 25+, with the Chinese cohort):
    // RR(z) = exp(θ·log(z/α + 1) / (1 + exp(−(z − μ)/ν))), z = PM2.5 above 2.4 µg/m³. Baseline NCD+LRI deaths
    // per 1,000 residents of all ages a year from GBD 2019 India (about 70% of a crude death rate near 7).
    const GEMM = { theta: 0.143, alpha: 1.6, mu: 15.5, nu: 36.8, cf: 2.4 }, BASE_DEATHS_PER_1000 = 5.0, NAAQS_PM25 = 40, WHO_PM25 = 5;

    function _gemmRR(pm) {
        const z = Math.max(0, pm - GEMM.cf);
        return Math.exp(GEMM.theta * Math.log(z / GEMM.alpha + 1) / (1 + Math.exp(-(z - GEMM.mu) / GEMM.nu)));
    }

    function airdeaths(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const pm = c['air_trend.pm25_2022'], pop = c['population.population'];
        if (!pm || !pop) return null;
        const idx = [];
        for (let i = 0; i < n; i++) if (pop[i] > 0 && _fin(pm[i])) idx.push(i);
        if (idx.length < 5) return null;
        const deaths = new Float64Array(n).fill(NaN), rate = new Float64Array(n).fill(NaN);
        let all = 0, base = 0, toNaaqs = 0, people = 0, pmw = 0;
        for (const i of idx) {
            const b = pop[i] * BASE_DEATHS_PER_1000 / 1000, rr = _gemmRR(pm[i]);
            const d = b * (1 - 1 / rr);
            deaths[i] = d; rate[i] = 1e5 * d / pop[i];
            all += d; base += b; people += pop[i]; pmw += pm[i] * pop[i];
            if (pm[i] > NAAQS_PM25) toNaaqs += b * (1 - _gemmRR(NAAQS_PM25) / rr);
        }
        const meanPm = pmw / people;
        const stats = [
            { label: 'PM2.5 for the average resident (satellite-derived, 2022)', value: `${_round(meanPm)} µg/m³ (WHO guideline ${WHO_PM25}, India's standard ${NAAQS_PM25})` },
            { label: 'Early deaths a year from fine-particle air (GEMM, adults)', value: `about ${_people(all)}`, raw: Math.round(all) },
            { label: 'Share of the city\'s heart, lung, stroke, diabetes and lower-respiratory deaths', value: `${_round(100 * all / base)}%` },
            { label: `Deaths a year avoided if every block met India's ${NAAQS_PM25} µg/m³ standard`, value: `about ${_people(toNaaqs)}` },
            { label: 'Early deaths per 1 lakh residents a year', value: `${_round(1e5 * all / people)}` },
        ];
        spaced(g, idx, rate).slice(0, 3).forEach((i, k) => stats.push({ label: `Worst air ${k + 1}: ${g.codes[i]}`,
            value: `PM2.5 ${_round(pm[i])} µg/m³; ${_round(rate[i])} early deaths per lakh a year` }));
        return {
            columns: { air_deaths: deaths, air_deaths_per_lakh: rate }, idx, weightKey: 'air_deaths', noHotspots: true,
            metric: { label: 'Early deaths a year from PM2.5', value: Math.round(all), unit: 'deaths/yr', higherIs: 'worse' },
            headline: `Fine-particle air (PM2.5 ${_round(meanPm)} µg/m³ for the average resident) causes about ${_people(all)} early deaths a year here, ${_round(100 * all / base)}% of deaths from heart, lung and related disease; meeting India's own ${NAAQS_PM25} µg/m³ standard everywhere would avoid about ${_people(toNaaqs)} a year.`,
            stats,
        };
    }

    // Open burning. A block burns "often" with 3 or more fire days a year at its worst spot; 30 or more is almost
    // always a steady industrial heat source (furnaces, kilns, flares) rather than fires.
    const FIRE_OFTEN = 3, FIRE_INDUSTRY = 30, SMOKE_KM = 1;

    /** Open burning: where VIIRS sees fires again and again, who lives in the smoke, and what is likely burning. */
    function burning(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const fd = c['fires.fire_days_yr'], wd = c['fires.winter_fire_days_yr'], pop = c['population.population'];
        const crop = c['land_cover.crop_pct'], bare = c['land_cover.bare_pct'], built = c['land_cover.built_pct'];
        if (!fd || !pop) return null;
        const cells = [];
        for (let i = 0; i < n; i++) if (_fin(fd[i])) cells.push(i);
        if (cells.length < 5) return null;
        const often = new Float64Array(n);
        for (const i of cells) often[i] = fd[i] >= FIRE_OFTEN && fd[i] < FIRE_INDUSTRY ? 1 : 0;
        const near = within(g, often, SMOKE_KM);
        const res = cells.filter(i => pop[i] > 0), people = _sumOver(pop, res, () => true);
        const inSmoke = _sumOver(pop, res, i => near[i] > 0);
        const hot = cells.filter(i => often[i]), ind = cells.filter(i => fd[i] >= FIRE_INDUSTRY);
        const wShare = wd ? hot.reduce((s, i) => s + (_fin(wd[i]) ? wd[i] : 0), 0) / Math.max(1e-9, hot.reduce((s, i) => s + fd[i], 0)) : null;
        const kind = i => (crop && crop[i] >= 30 ? 'farmland: crop-residue burning' : bare && bare[i] >= 20 ? 'bare ground: dump, landfill or kiln'
            : built && built[i] >= 50 ? 'built-up: garbage or industrial burning' : 'mixed land');
        const stats = [
            { label: `Blocks with fires on ${FIRE_OFTEN} or more days a year`, value: `${hot.length}`, raw: hot.length },
            { label: `Residents within ${SMOKE_KM} km of them`, value: `${_people(inSmoke)} (${_round(100 * inSmoke / people, 1)}%)` },
        ];
        if (wShare != null && hot.length) stats.push({ label: 'Share of those fire days in October–February (crop and garbage burning season)', value: `${_round(100 * wShare)}%` });
        if (ind.length) stats.push({ label: `Steady heat sources (${FIRE_INDUSTRY}+ days a year: furnaces, kilns, flares)`, value: `${ind.length} blocks` });
        spaced(g, hot, fd).slice(0, 4).forEach((i, k) => stats.push({ label: `Burning hotspot ${k + 1}: ${g.codes[i]}`, value: `${_round(fd[i], 1)} days a year; ${kind(i)}` }));
        return {
            columns: { fire_days_yr: fd }, idx: cells, weightKey: 'fire_days_yr', noHotspots: true,
            metric: { label: `Residents within ${SMOKE_KM} km of frequent open burning`, value: Math.round(inSmoke), unit: 'people', higherIs: 'worse' },
            headline: hot.length ? `Satellites see fires on ${FIRE_OFTEN} or more days a year in ${hot.length} blocks, with ${_people(inSmoke)} residents living within ${SMOKE_KM} km${wShare != null ? `; ${_round(100 * wShare)}% of those fire days fall in October–February` : ''}.`
                : `Satellites see no block burning on ${FIRE_OFTEN} or more days a year.`,
            stats,
        };
    }

    // Ground conditions for building. Seismic zones are IS 1893 (Part 1): 2016, Annex E; the zone factor Z is the design
    // peak ground acceleration as a share of g. Expansive clay, low-lying wet ground and steep slopes are flagged per block.
    const SEISMIC_ZONE = { delhi: 'IV', mumbai: 'III', kolkata: 'III', chennai: 'III', pune: 'III', ahmedabad: 'III', lucknow: 'III',
        bengaluru: 'II', hyderabad: 'II', jaipur: 'II', bhopal: 'II', indore_pilot: 'II', guna: 'II' };
    const ZONE_Z = { II: 0.10, III: 0.16, IV: 0.24, V: 0.36 };
    const CLAY_EXPANSIVE = 40, HAND_LOW_M = 1, WLOG_HIGH = 50, SLOPE_STEEP = 10;

    /** Ground conditions: expansive clay, low-lying wet ground, steep slopes and the city's seismic zone, per block. */
    function ground(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const clay = c['subsoil.clay_60cm_pct'], hand = c['terrain.hand_m'], wl = c['waterlogging.waterlogging_index'], slope = c['terrain.slope_deg'];
        const pop = c['population.population'], nb = c['building_stock.new_buildings'];
        if (!clay) return null;
        const cells = [];
        for (let i = 0; i < n; i++) if (_fin(clay[i])) cells.push(i);
        if (cells.length < 5) return null;
        const exp = i => clay[i] >= CLAY_EXPANSIVE;
        const wet = i => (wl && _fin(wl[i]) ? wl[i] >= WLOG_HIGH : hand && _fin(hand[i]) && hand[i] < HAND_LOW_M);
        const steep = i => slope && _fin(slope[i]) && slope[i] >= SLOPE_STEEP;
        const issues = new Float64Array(n).fill(NaN);
        for (const i of cells) issues[i] = (exp(i) ? 1 : 0) + (wet(i) ? 1 : 0) + (steep(i) ? 1 : 0);
        const share = f => _round(100 * cells.filter(f).length / cells.length);
        const zone = SEISMIC_ZONE[fr.city];
        const newOn = f => (nb ? Math.round(cells.reduce((s, i) => s + (f(i) && _fin(nb[i]) ? Math.max(0, nb[i]) : 0), 0)) : null);
        const stats = [];
        if (zone) stats.push({ label: 'Seismic zone (IS 1893: 2016)', value: `Zone ${zone}, design ground acceleration ${ZONE_Z[zone]} g${zone === 'IV' ? ': ductile detailing (IS 13920) is a must' : ''}` });
        stats.push({ label: `Land on expansive clay (${CLAY_EXPANSIVE}% or more at 60 cm; black cotton soil)`, value: `${share(exp)}%`, raw: share(exp) });
        if (hand || wl) stats.push({ label: `Low-lying, waterlogging-prone land (waterlogging index ${WLOG_HIGH}+)`, value: `${share(wet)}%` });
        if (slope) stats.push({ label: `Steep land (${SLOPE_STEEP}° or more)`, value: `${share(steep)}%` });
        const both = i => exp(i) && wet(i);
        if (hand || wl) stats.push({ label: 'Expansive clay that is also low-lying or wet (swells most)', value: `${share(both)}% of land` });
        const nExp = newOn(exp);
        if (nExp != null) stats.push({ label: 'New buildings 2016–2023 on expansive clay', value: nExp.toLocaleString('en-IN') });
        if (pop) stats.push({ label: 'Residents on land with two or more ground issues', value: _people(_sumOver(pop, cells, i => issues[i] >= 2)) });
        return {
            columns: { ground_issues: issues }, idx: cells, weightKey: 'ground_issues', noHotspots: true,
            metric: { label: 'Land on expansive clay', value: share(exp), unit: '%', higherIs: 'worse' },
            headline: `${zone ? `Seismic zone ${zone}. ` : ''}${share(exp) < 1 ? 'Almost none of the land is expansive clay' : `${share(exp)}% of the land sits on expansive clay that swells and shrinks with the monsoon`}${hand || wl ? `, ${share(wet)}% is low-lying or prone to waterlogging` : ''}${slope ? ` and ${share(steep)}% is steep` : ''}: these blocks need a soil test and deeper or piled footings before building.`,
            stats,
        };
    }

    // Tree planting. 3-30-300 asks for 30% canopy around every home; a mature shade tree's crown covers about 50 m².
    // Open land (grass, shrub, bare) in the block is where new trees can go without breaking up paving.
    const CANOPY_TARGET = 30, CROWN_M2 = 50, OPEN_USABLE = 0.5;

    /** Plant trees here: trees each block needs for 30% canopy, how many fit on its open land, hottest gaps first. */
    function treeplant(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const can = c['vegetation.tree_canopy_pct'], pop = c['population.population'], lst = c['surface_heat.lst_day_c'];
        const grass = c['land_cover.grass_pct'], bare = c['land_cover.bare_pct'], shrub = c['land_cover.shrub_pct'];
        if (!can || !pop || !(grass || bare || shrub)) return null;
        const res = [];
        for (let i = 0; i < n; i++) if (pop[i] > 0 && _fin(can[i])) res.push(i);
        if (res.length < 5) return null;
        const m2 = g.cellKm2 * 1e6, v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        let hotMean = null;
        if (lst) { let sm = 0, w = 0; for (const i of res) if (_fin(lst[i])) { sm += lst[i] * pop[i]; w += pop[i]; } hotMean = w ? sm / w : null; }
        const need = new Float64Array(n).fill(NaN), fit = new Float64Array(n).fill(NaN), prio = new Float64Array(n).fill(NaN);
        let needAll = 0, fitAll = 0;
        for (const i of res) {
            const gap = Math.max(0, CANOPY_TARGET - can[i]) / 100 * m2 / CROWN_M2;
            const room = (v(grass, i) + v(bare, i) + v(shrub, i)) / 100 * m2 * OPEN_USABLE / CROWN_M2;
            need[i] = gap; fit[i] = Math.min(gap, room); needAll += gap; fitAll += fit[i];
            const heat = hotMean != null && _fin(lst[i]) ? 1 + Math.max(0, lst[i] - hotMean) / 3 : 1;
            prio[i] = fit[i] * heat * Math.min(1, pop[i] / 2000);
        }
        const people = _sumOver(pop, res, () => true), low = _sumOver(pop, res, i => can[i] < CANOPY_TARGET);
        const stats = [
            { label: `Trees needed for ${CANOPY_TARGET}% canopy in every lived-in block (about ${CROWN_M2} m² of crown each)`, value: `${_people(needAll)}`, raw: Math.round(needAll) },
            { label: `Of them that fit on the blocks' own open land (half of grass, shrub and bare ground)`, value: `${_people(fitAll)} (${_round(100 * fitAll / Math.max(1, needAll))}%)` },
            { label: `Residents in blocks under ${CANOPY_TARGET}% canopy`, value: `${_people(low)} (${_round(100 * low / people)}%)` },
            { label: 'The rest needs street trees, rooftop and courtyard planting, or parks on reclaimed land', value: `${_people(Math.max(0, needAll - fitAll))} trees` },
        ];
        spaced(g, res.filter(i => prio[i] > 0), prio).slice(0, 4).forEach((i, k) => stats.push({ label: `Plant first ${k + 1}: ${g.codes[i]}`,
            value: `${Math.round(fit[i]).toLocaleString('en-IN')} trees fit; canopy ${_round(can[i])}%${hotMean != null && _fin(lst[i]) ? `, ${_round(lst[i] - hotMean, 1)} °C hotter than the average home` : ''}` }));
        return {
            columns: { plant_trees: fit, trees_needed: need }, idx: res, weightKey: 'plant_trees', noHotspots: true,
            metric: { label: `Trees that fit on open land toward ${CANOPY_TARGET}% canopy`, value: Math.round(fitAll), unit: 'trees', higherIs: null },
            headline: `Bringing every lived-in block to ${CANOPY_TARGET}% tree canopy takes about ${_people(needAll)} trees; ${_people(fitAll)} (${_round(100 * fitAll / Math.max(1, needAll))}%) fit on open ground in those blocks, and the rest needs street and rooftop planting.`,
            stats,
        };
    }

    // Farmland at the edge. Dynamic World yearly mode labels, 2018 and 2025. An active edge block still has
    // EDGE_CROP% crops and already EDGE_BUILT% building. Farmland expected to go by 2035 weights each block's
    // farmland by the CA-ML model's projected urban share of that block.
    const EDGE_CROP = 30, EDGE_BUILT = 20, FARM_NOISE = 10;

    function farmloss(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const c0 = c['farmland.crop_2018_pct'], c1 = c['farmland.crop_now_pct'], cb = c['farmland.crop_built_pp'];
        const b1 = c['farmland.built_now_pct'], u35 = c['growth.urban_2035_pct'];
        if (!c0 || !c1 || !cb) return null;
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(c0[i]) && _fin(c1[i])) idx.push(i);
        if (idx.length < 5) return null;
        const km2 = g.cellKm2, lostHa = new Float64Array(n).fill(NaN), edge = new Float64Array(n).fill(NaN);
        let a0 = 0, a1 = 0, built = 0, edgeKm2 = 0, edgeN = 0, atRisk = 0;
        for (const i of idx) {
            a0 += c0[i] / 100 * km2; a1 += c1[i] / 100 * km2;
            const b = _fin(cb[i]) ? cb[i] / 100 * km2 : 0;
            built += b; lostHa[i] = b * 100;
            const isEdge = c1[i] >= EDGE_CROP && b1 && _fin(b1[i]) && b1[i] >= EDGE_BUILT;
            edge[i] = isEdge ? 1 : 0;
            if (isEdge) { edgeN++; edgeKm2 += c1[i] / 100 * km2; }
            if (u35 && _fin(u35[i])) atRisk += c1[i] / 100 * km2 * Math.min(100, u35[i]) / 100;
        }
        if (a0 < 1) return null;
        const net = a0 - a1, other = Math.max(0, net - built);
        const stats = [
            { label: 'Farmland in 2018 → 2025', value: `${_round(a0)} → ${_round(a1)} km² (${net >= 0 ? '−' : '+'}${_round(Math.abs(net))} km²)` },
            { label: 'Farmland turned built-up since 2018 (buildings, roads or cleared plots)', value: `${_round(built, 1)} km² (${_round(100 * built / a0)}% of 2018 farmland)`, raw: _round(built, 2) },
            { label: 'Lost to fallow, scrub or bare ground (not built yet; part is fallow-year noise)', value: `${_round(other, 1)} km²` },
            { label: `Active edge: blocks still ${EDGE_CROP}%+ crops and already ${EDGE_BUILT}%+ built`, value: `${edgeN} blocks, ${_round(edgeKm2, 1)} km² of farmland` },
        ];
        if (u35) stats.push({ label: 'Today\'s farmland the growth model expects to turn urban by 2035', value: `${_round(atRisk, 1)} km² (${_round(100 * atRisk / Math.max(1e-9, a1))}%)` });
        const hs = idx.filter(i => lostHa[i] > 0);
        spaced(g, hs, lostHa).slice(0, 4).forEach((i, k) => stats.push({ label: `Fastest conversion ${k + 1}: ${g.codes[i]}`,
            value: `${_round(lostHa[i], 1)} ha of farmland built; crops ${_round(c0[i])}% → ${_round(c1[i])}%` }));
        return {
            columns: { farm_built_ha: lostHa, farm_edge: edge }, idx, weightKey: 'farm_built_ha',
            metric: { label: 'Farmland turned built-up since 2018', value: _round(built, 1), unit: 'km²', higherIs: 'worse' },
            headline: `${_round(built, 1)} km² of farmland (${_round(100 * built / a0)}% of what was farmed in 2018) has turned built-up since 2018, as buildings, roads or cleared plots; ${edgeN} edge blocks are still part farm, part built${u35 ? `, and the growth model expects another ${_round(atRisk, 1)} km² to go by 2035` : ''}.`,
            stats,
        };
    }

    // Property market activity. Overture places tagged as estate agents or brokers, summed within MARKET_KM of each
    // block. Hot = top MARKET_HOT share of blocks; emerging = hot but land value index below the city median.
    const MARKET_KM = 1, MARKET_HOT = 0.9;

    function _spearman(x, y) {
        const rank = a => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = new Float64Array(a.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
        const n = x.length;
        if (n < 5) return null;
        const rx = rank(x), ry = rank(y);
        let d = 0;
        for (let i = 0; i < n; i++) d += (rx[i] - ry[i]) ** 2;
        return 1 - 6 * d / (n * (n * n - 1));
    }

    function market(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const ag = c['places.property_agents'], vi = c['land_value.value_index'], br = c['re_supply.build_rate'], pop = c['population.population'];
        if (!ag) return null;
        const vals = Float64Array.from(ag, v => (_fin(v) ? v : 0));
        let total = 0;
        for (const v of vals) total += v;
        if (total < 10) return null;
        const near = within(g, vals, MARKET_KM);
        const idx = [];
        for (let i = 0; i < n; i++) if (near[i] > 0 || (pop && pop[i] > 0)) idx.push(i);
        const hotCut = wquantile(near, null, idx.filter(i => near[i] > 0), MARKET_HOT);
        const viMed = vi ? wquantile(vi, null, idx, 0.5) : null;
        const emerging = new Float64Array(n).fill(NaN);
        let emN = 0, emPop = 0;
        for (const i of idx) {
            const e = near[i] >= hotCut && viMed != null && _fin(vi[i]) && vi[i] < viMed ? 1 : 0;
            emerging[i] = e;
            if (e) { emN++; emPop += pop && pop[i] > 0 ? pop[i] : 0; }
        }
        const sorted = Array.from(vals).sort((a, b) => b - a), top = sorted.slice(0, Math.ceil(0.01 * idx.length)).reduce((a, b) => a + b, 0);
        const both = vi ? idx.filter(i => _fin(vi[i]) && near[i] > 0) : [];
        const rho = both.length >= 30 ? _spearman(both.map(i => near[i]), both.map(i => vi[i])) : null;
        const stats = [
            { label: 'Estate agents and brokers on the map (Overture places)', value: `${Math.round(total).toLocaleString('en-IN')}`, raw: Math.round(total) },
            { label: 'Share of them in the busiest 1% of blocks', value: `${_round(100 * top / total)}%` },
            { label: `Hot markets: blocks in the top ${_round(100 * (1 - MARKET_HOT))}% for agents within ${MARKET_KM} km`, value: `${_round(hotCut, 1)}+ agents within ${MARKET_KM} km` },
        ];
        if (rho != null) stats.push({ label: 'How closely agent density tracks the land value index (Spearman ρ)', value: `${_round(rho, 2)}` });
        if (viMed != null) stats.push({ label: 'Emerging: hot for agents but land value below the city median', value: `${emN} blocks${pop ? `, ${_people(emPop)} residents` : ''}` });
        const hs = idx.filter(i => near[i] >= hotCut);
        spaced(g, hs, near).slice(0, 4).forEach((i, k) => stats.push({ label: `Busiest market ${k + 1}: ${g.codes[i]}`,
            value: `${Math.round(near[i])} agents within ${MARKET_KM} km${vi && _fin(vi[i]) ? `; value index ${_round(vi[i])}` : ''}${br && _fin(br[i]) ? `; ${Math.round(br[i]).toLocaleString('en-IN')} m² of floor built per km² a year` : ''}` }));
        return {
            columns: { agents_1km: near, market_emerging: emerging }, idx, weightKey: 'agents_1km',
            metric: { label: `Estate agents within ${MARKET_KM} km`, value: Math.round(total), unit: 'agents', higherIs: null },
            headline: `${Math.round(total).toLocaleString('en-IN')} estate agents and brokers are on the map, ${_round(100 * top / total)}% of them in the busiest 1% of blocks${rho != null ? `; agent density tracks land value with ρ ${_round(rho, 2)}` : ''}${viMed != null ? `, and ${emN} blocks are busy markets with land still below the city median` : ''}.`,
            stats,
        };
    }

    // Park space per resident. Public green and play space within PARK_KM of home, shared by everyone living within
    // PARK_KM (a catchment ratio). WHO suggests 9 m² of green space per person; India's URDPFI guidelines 10–12 m².
    // WHO Europe: a green area of at least 0.5 ha within 300 m of home.
    const PARK_KM = 1, WHO_M2 = 9, URDPFI_M2 = 10, PARK_SHORT_M2 = 2, NEAR_PARK_KM = 0.3;

    function parkshare(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const pk = c['parks.park_m2'], big = c['parks.big_park'], pop = c['population.population'];
        if (!pk || !pop) return null;
        const res = [];
        for (let i = 0; i < n; i++) if (pop[i] > 0) res.push(i);
        if (res.length < 5) return null;
        const pkv = Float64Array.from(pk, v => (_fin(v) ? v : 0));
        let parkAll = 0;
        for (const v of pkv) parkAll += v;
        if (parkAll <= 0) return null;
        const pkNear = within(g, pkv, PARK_KM), popNear = within(g, Float64Array.from(pop, v => (v > 0 ? v : 0)), PARK_KM);
        const bigNear = big ? within(g, Float64Array.from(big, v => (_fin(v) ? v : 0)), NEAR_PARK_KM) : null;
        const per = new Float64Array(n).fill(NaN), gap = new Float64Array(n).fill(NaN);
        for (const i of res) {
            per[i] = popNear[i] > 0 ? pkNear[i] / popNear[i] : NaN;
            gap[i] = _fin(per[i]) ? Math.max(0, URDPFI_M2 - per[i]) * pop[i] : NaN;
        }
        const people = _sumOver(pop, res, () => true);
        const cityPer = parkAll / people;
        const short = _sumOver(pop, res, i => per[i] < PARK_SHORT_M2), meets = _sumOver(pop, res, i => per[i] >= WHO_M2);
        const noBig = bigNear ? _sumOver(pop, res, i => bigNear[i] === 0) : null;
        let gapAll = 0;
        for (const i of res) if (_fin(gap[i])) gapAll += gap[i];
        const stats = [
            { label: 'Mapped public park and play space per resident, city-wide', value: `${_round(cityPer, 1)} m² (WHO ${WHO_M2} m², URDPFI ${URDPFI_M2}–12 m²)`, raw: _round(cityPer, 2) },
            { label: `Residents with under ${PARK_SHORT_M2} m² each within ${PARK_KM} km`, value: `${_people(short)} (${_round(100 * short / people)}%)` },
            { label: `Residents with ${WHO_M2} m² or more each within ${PARK_KM} km`, value: `${_people(meets)} (${_round(100 * meets / people)}%)` },
        ];
        if (noBig != null) stats.push({ label: 'Residents with no park of 0.5 ha or more within 300 m', value: `${_people(noBig)} (${_round(100 * noBig / people)}%)` });
        stats.push({ label: `Park space needed to give every block ${URDPFI_M2} m² a resident within ${PARK_KM} km`, value: `${_round(gapAll / 1e6, 1)} km²` });
        spaced(g, res.filter(i => gap[i] > 0), gap).slice(0, 4).forEach((i, k) => stats.push({ label: `Park need ${k + 1}: ${g.codes[i]}`,
            value: `${_round(per[i], 1)} m² a resident within ${PARK_KM} km; ${_people(pop[i])} residents in the block` }));
        return {
            columns: { park_m2_per_resident: per, park_gap_m2: gap }, idx: res, weightKey: 'park_gap_m2', noHotspots: true,
            metric: { label: 'Public park space per resident', value: _round(cityPer, 1), unit: 'm²', higherIs: 'better' },
            headline: `The city has ${_round(cityPer, 1)} m² of mapped public park and play space per resident against WHO's ${WHO_M2} m²; ${_people(short)} residents (${_round(100 * short / people)}%) have under ${PARK_SHORT_M2} m² each within ${PARK_KM} km${noBig != null ? `, and ${_round(100 * noBig / people)}% have no half-hectare park within 300 m` : ''}.`,
            stats,
        };
    }

    // Mangroves. Global Mangrove Watch v3, 1996 and 2020. Residents within SURGE_KM of mangroves get some storm-surge
    // buffering; blocks that lost MANGROVE_LOST% or more of their area as mangrove are named.
    const SURGE_KM = 1, MANGROVE_LOST = 5;

    function mangrove(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const m0 = c['mangroves.mangrove_1996_pct'], m1 = c['mangroves.mangrove_2020_pct'], lost = c['mangroves.mangrove_lost_pct'];
        const pop = c['population.population'], built = c['growth.built_change_pp'];
        if (!m0 || !m1) return null;
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(m0[i]) || _fin(m1[i])) idx.push(i);
        if (idx.length < 3) return null;
        const km2 = g.cellKm2, v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        let a0 = 0, a1 = 0, gone = 0;
        const lostHa = new Float64Array(n).fill(NaN), now = new Float64Array(n);
        for (const i of idx) {
            a0 += v(m0, i) / 100 * km2; a1 += v(m1, i) / 100 * km2;
            gone += v(lost, i) / 100 * km2; lostHa[i] = v(lost, i) / 100 * km2 * 100; now[i] = v(m1, i) > 0 ? 1 : 0;
        }
        const stats = [
            { label: 'Mangroves 1996 → 2020', value: `${_round(a0, 1)} → ${_round(a1, 1)} km²`, raw: _round(a1, 2) },
            { label: 'Mangrove area lost since 1996 (some regrew elsewhere)', value: `${_round(gone, 1)} km² (${_round(100 * gone / Math.max(1e-9, a0))}%)` },
        ];
        if (pop) {
            const near = within(g, now, SURGE_KM);
            let people = 0;
            for (let i = 0; i < n; i++) if (pop[i] > 0 && near[i] > 0) people += pop[i];
            stats.push({ label: `Residents within ${SURGE_KM} km of mangroves (some storm-surge shelter)`, value: _people(people) });
        }
        const hs = idx.filter(i => v(lost, i) >= MANGROVE_LOST);
        spaced(g, hs, lostHa).slice(0, 4).forEach((i, k) => stats.push({ label: `Mangrove loss ${k + 1}: ${g.codes[i]}`,
            value: `${_round(lostHa[i], 1)} ha lost${built && _fin(built[i]) && built[i] > 1 ? `; buildings up ${_round(built[i], 1)} points since 2016` : ''}` }));
        return {
            columns: { mangrove_lost_ha: lostHa, mangrove_now_pct: m1 }, idx, weightKey: 'mangrove_lost_ha', noHotspots: true,
            metric: { label: 'Mangroves in 2020', value: _round(a1, 1), unit: 'km²', higherIs: 'better' },
            headline: `The city has ${_round(a1, 1)} km² of mangroves (${_round(a0, 1)} km² in 1996); ${_round(gone, 1)} km² of the 1996 stands have gone.`,
            stats,
        };
    }

    // Storm runoff. SCS curve number (USDA TR-55, average wetness) per land cover and hydrologic soil group, on the
    // city's wettest day of the year. Soil group from SoilGrids texture: A sand ≥ 70% and clay < 10%, D clay ≥ 40%,
    // C clay ≥ 27%, else B. GREEN_SWAP is the share of each block's built area that becomes permeable in the what-if.
    const CN = { built: [89, 92, 94, 95], tree: [30, 55, 70, 77], shrub: [35, 56, 70, 77], grass: [39, 61, 74, 80],
        crop: [67, 78, 85, 89], bare: [77, 86, 91, 94], water: [98, 98, 98, 98] };
    const GREEN_SWAP = 0.1;

    function _soilGroup(sand, clay) {
        if (!_fin(sand) || !_fin(clay)) return 1;
        if (sand >= 70 && clay < 10) return 0;
        if (clay >= 40) return 3;
        if (clay >= 27) return 2;
        return 1;
    }

    function _scsQ(p, cn) {
        const sMax = 25400 / cn - 254, ia = 0.2 * sMax;
        return p > ia ? (p - ia) ** 2 / (p + 0.8 * sMax) : 0;
    }

    function runoff(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const lc = k => c[`land_cover.${k}_pct`];
        const rain = c['rainfall.rain_max_day_mm'], sand = c['soil.sand_pct'], clay = c['soil.clay_pct'], wl = c['waterlogging.waterlogging_index'];
        if (!lc('built') || !rain) return null;
        const keys = { built: ['built'], tree: ['tree'], shrub: ['shrub'], grass: ['grass'], crop: ['crop'], bare: ['bare'], water: ['water', 'wetland', 'mangrove'] };
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(lc('built')[i]) && _fin(rain[i])) idx.push(i);
        if (idx.length < 5) return null;
        const m2 = g.cellKm2 * 1e6, qmm = new Float64Array(n).fill(NaN), vol = new Float64Array(n).fill(NaN);
        let rainAll = 0, qAll = 0, saved = 0, pSum = 0;
        for (const i of idx) {
            const sg = _soilGroup(sand && sand[i], clay && clay[i]);
            let tot = 0, cnw = 0, built = 0;
            for (const [k, ks] of Object.entries(keys)) {
                let sh = 0;
                for (const kk of ks) { const a = lc(kk); if (a && _fin(a[i])) sh += a[i]; }
                tot += sh; cnw += sh * CN[k][sg];
                if (k === 'built') built = sh;
            }
            if (tot <= 0) continue;
            const cn = cnw / tot, p = rain[i];
            const q = _scsQ(p, cn);
            const cn2 = (cnw - GREEN_SWAP * built * (CN.built[sg] - CN.grass[sg])) / tot;
            qmm[i] = q; vol[i] = q / 1000 * m2;
            rainAll += p / 1000 * m2; qAll += vol[i]; saved += (q - _scsQ(p, cn2)) / 1000 * m2; pSum += p;
        }
        if (qAll <= 0) return null;
        const pMean = pSum / idx.length;
        const stats = [
            { label: 'Wettest day of 2025 (block average)', value: `${_round(pMean)} mm` },
            { label: 'Rain that runs off instead of soaking in on that day', value: `${_round(100 * qAll / rainAll)}% (${_round(qAll / 1e6, 1)} million m³)`, raw: Math.round(qAll) },
            { label: `Runoff avoided if ${GREEN_SWAP * 100}% of every block's built area were made permeable (grass, permeable paving, rain gardens)`, value: `${_round(saved / 1e6, 2)} million m³ (${_round(100 * saved / qAll)}%)` },
        ];
        if (wl) {
            const wet = idx.filter(i => _fin(wl[i]) && wl[i] >= WLOG_HIGH);
            if (wet.length) {
                const up = within(g, Float64Array.from(vol, v => (_fin(v) ? v : 0)), 1);
                spaced(g, wet, up).slice(0, 3).forEach((i, k) => stats.push({ label: `Floods first ${k + 1}: ${g.codes[i]}`,
                    value: `waterlogging index ${_round(wl[i])}; ${_round(up[i] / 1e3)} thousand m³ runs off within 1 km` }));
            }
        }
        spaced(g, idx.filter(i => qmm[i] > 0), qmm).slice(0, 3).forEach((i, k) => stats.push({ label: `Most sealed ${k + 1}: ${g.codes[i]}`,
            value: `${_round(qmm[i])} of ${_round(rain[i])} mm runs off` }));
        return {
            columns: { runoff_mm: qmm, runoff_m3: vol }, idx, weightKey: 'runoff_m3', noHotspots: true,
            metric: { label: 'Share of 2025\'s wettest-day rain that runs off', value: _round(100 * qAll / rainAll), unit: '%', higherIs: 'worse' },
            headline: `On the wettest day of 2025 (${_round(pMean)} mm), ${_round(100 * qAll / rainAll)}% of the rain runs off sealed and saturated ground, ${_round(qAll / 1e6, 1)} million m³ for the drains; making a tenth of the built area permeable would cut that by ${_round(100 * saved / qAll)}%.`,
            stats,
        };
    }

    // Night-time economy. VIIRS passes at about 1:30 am, so its radiance is late-night light. A night district has
    // NIGHT_TOP-share radiance and NIGHT_TOP-share density of food, leisure and lodging places within NIGHT_KM.
    const NIGHT_KM = 0.5, NIGHT_TOP = 0.9;

    function nighteconomy(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const rad = c['nightlights.radiance'], food = c['places.food'], leis = c['places.leisure'], lodg = c['places.lodging'];
        const pop = c['population.population'];
        if (!rad || !food) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const nightPl = Float64Array.from({ length: n }, (_, i) => v(food, i) + v(leis, i) + v(lodg, i));
        let all = 0;
        for (const x of nightPl) all += x;
        if (all < 20) return null;
        const near = within(g, nightPl, NIGHT_KM);
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(rad[i])) idx.push(i);
        if (idx.length < 5) return null;
        const radCut = wquantile(rad, null, idx, NIGHT_TOP), plCut = wquantile(near, null, idx.filter(i => near[i] > 0), NIGHT_TOP);
        const score = new Float64Array(n).fill(NaN), hub = new Float64Array(n).fill(NaN);
        const lr = idx.map(i => Math.log1p(Math.max(0, rad[i]))), lp = idx.map(i => Math.log1p(near[i]));
        const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return [m, Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) || 1]; };
        const [mr, sr] = sd(lr), [mp, sp] = sd(lp);
        let hubN = 0, hubPl = 0;
        idx.forEach((i, k) => {
            score[i] = (lr[k] - mr) / sr + (lp[k] - mp) / sp;
            hub[i] = rad[i] >= radCut && near[i] >= plCut ? 1 : 0;
            if (hub[i]) { hubN++; hubPl += nightPl[i]; }
        });
        const stats = [
            { label: 'Eateries, bars, leisure and hotels on the map (Overture places)', value: `${Math.round(all).toLocaleString('en-IN')}`, raw: Math.round(all) },
            { label: `Night districts: top ${_round(100 * (1 - NIGHT_TOP))}% for late-night light and for these places within ${NIGHT_KM} km`, value: `${hubN} blocks, ${_round(100 * hubPl / all)}% of the places` },
        ];
        if (pop) {
            const dark = idx.filter(i => pop[i] > 0);
            const darkPop = _sumOver(pop, dark, i => near[i] === 0);
            stats.push({ label: `Residents with no eatery, leisure place or hotel within ${NIGHT_KM} km`, value: `${_people(darkPop)} (${_round(100 * darkPop / Math.max(1, _sumOver(pop, dark, () => true)))}%)` });
        }
        spaced(g, idx.filter(i => hub[i] === 1), score).slice(0, 5).forEach((i, k) => stats.push({ label: `Night district ${k + 1}: ${g.codes[i]}`,
            value: `${Math.round(near[i])} places within ${NIGHT_KM} km; ${_round(rad[i], 1)} nW/cm²/sr at 1:30 am` }));
        return {
            columns: { night_score: score, night_district: hub }, idx, weightKey: 'night_score', noHotspots: true,
            metric: { label: 'Night-district blocks', value: hubN, unit: 'blocks', higherIs: null },
            headline: `${hubN} blocks form the city's night districts, bright at 1:30 am and dense with eateries, leisure and hotels; they hold ${_round(100 * hubPl / all)}% of those places.`,
            stats,
        };
    }

    // Retail catchments (Huff 1963). Shopping centres are blocks in the top HUFF_TOP share for shops; each block's
    // residents split their trips across centres within HUFF_KM in proportion to shops ÷ distance^HUFF_BETA.
    const HUFF_KM = 5, HUFF_BETA = 2, HUFF_TOP = 0.95, HUFF_MIN_KM = 0.3;

    function catchment(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const shop = c['places.shopping'], pop = c['population.population'];
        if (!shop || !pop) return null;
        const withShops = [];
        for (let i = 0; i < n; i++) if (_fin(shop[i]) && shop[i] > 0) withShops.push(i);
        if (withShops.length < 10) return null;
        const cut = Math.max(3, wquantile(shop, null, withShops, HUFF_TOP));
        const isCentre = new Uint8Array(n);
        for (const i of withShops) if (shop[i] >= cut) isCentre[i] = 1;
        const off = g.offsets(HUFF_KM);
        const draw = new Float64Array(n), reach = new Float64Array(n).fill(NaN);
        const res = [];
        for (let i = 0; i < n; i++) if (pop[i] > 0) res.push(i);
        for (const i of res) {
            const js = [], ws = [];
            let tot = 0;
            for (const [a, b, d] of off) {
                const j = g.cellAt(i, a, b);
                if (j < 0 || !isCentre[j]) continue;
                const w = shop[j] / Math.max(HUFF_MIN_KM, d) ** HUFF_BETA;
                js.push(j); ws.push(w); tot += w;
            }
            reach[i] = tot;
            if (tot > 0) js.forEach((j, k) => { draw[j] += pop[i] * ws[k] / tot; });
        }
        const centres = withShops.filter(i => isCentre[i]);
        const perShop = new Float64Array(n).fill(NaN), drawCol = new Float64Array(n).fill(NaN);
        let drawn = 0;
        for (const i of centres) { drawCol[i] = draw[i]; perShop[i] = draw[i] / shop[i]; drawn += draw[i]; }
        const people = _sumOver(pop, res, () => true), none = _sumOver(pop, res, i => !(reach[i] > 0));
        const medPer = wquantile(perShop, null, centres, 0.5);
        const stats = [
            { label: `Shopping centres (blocks with ${Math.round(cut)}+ shops, the top ${_round(100 * (1 - HUFF_TOP))}%)`, value: `${centres.length}` },
            { label: `Residents with no centre within ${HUFF_KM} km`, value: `${_people(none)} (${_round(100 * none / people)}%)` },
            { label: 'Residents per listed shop at the median centre', value: `${Math.round(medPer)}` },
        ];
        spaced(g, centres, drawCol).slice(0, 4).forEach((i, k) => stats.push({ label: `Biggest catchment ${k + 1}: ${g.codes[i]}`,
            value: `${_people(draw[i])} residents' trips; ${Math.round(shop[i])} shops` }));
        spaced(g, centres.filter(i => perShop[i] >= 2 * medPer), perShop).slice(0, 3).forEach((i, k) => stats.push({ label: `Room for more shops ${k + 1}: ${g.codes[i]}`,
            value: `${Math.round(perShop[i])} residents per listed shop, ${_round(perShop[i] / medPer, 1)}× the median centre` }));
        return {
            columns: { huff_draw: drawCol, residents_per_shop: perShop }, idx: centres, weightKey: 'huff_draw', noHotspots: true,
            metric: { label: 'Shopping centres', value: centres.length, unit: 'centres', higherIs: null },
            headline: `${centres.length} shopping centres share the city's ${_people(drawn)} residents in a gravity model; the median centre serves ${Math.round(medPer)} residents per listed shop, and centres at twice that have room for more shops.`,
            stats,
        };
    }

    // Construction sites from two dry seasons of Dynamic World (pipeline/realestate/stalled.py).
    function sites(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const st = c['sites.site_status'], b1 = c['sites.bare_now'], u0 = c['sites.built_then'], u1 = c['sites.built_now'], pop = c['population.population'];
        if (!st) return null;
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(st[i]) && st[i] > 0) idx.push(i);
        if (!idx.length) return null;
        const count = k => idx.filter(i => st[i] === k).length;
        const ha = k => idx.filter(i => st[i] === k).reduce((a, i) => a + (b1 && _fin(b1[i]) ? b1[i] : 0) / 100 * g.cellKm2 * 100, 0);
        const stalledN = count(3), growN = count(2), clearN = count(1);
        const stats = [
            { label: 'Stalled sites or idle plots: bare ground in built-up areas, unchanged for a year', value: `${stalledN} blocks, about ${_round(ha(3))} ha bare`, raw: stalledN },
            { label: 'Building up: built-up rising 10+ points in a year', value: `${growN} blocks` },
            { label: 'Cleared this year', value: `${clearN} blocks, about ${_round(ha(1))} ha` },
        ];
        if (pop) {
            const near = within(g, Float64Array.from({ length: n }, (_, i) => (st[i] === 3 ? 1 : 0)), 0.3);
            const people = _sumOver(pop, Array.from({ length: n }, (_, i) => i).filter(i => pop[i] > 0), i => near[i] > 0);
            stats.push({ label: 'Residents within 300 m of a stalled site (dust, stagnant water, safety)', value: _people(people) });
        }
        const bare = Float64Array.from({ length: n }, (_, i) => (st[i] === 3 && b1 && _fin(b1[i]) ? b1[i] : 0));
        spaced(g, idx.filter(i => st[i] === 3), bare).slice(0, 4).forEach((i, k) => stats.push({ label: `Stalled site ${k + 1}: ${g.codes[i]}`,
            value: `${_round(b1[i])}% bare now; built-up ${_round(u0[i])}% → ${_round(u1[i])}%` }));
        const grow = Float64Array.from({ length: n }, (_, i) => (st[i] === 2 && u0 && u1 && _fin(u1[i]) ? u1[i] - u0[i] : 0));
        spaced(g, idx.filter(i => st[i] === 2), grow).slice(0, 3).forEach((i, k) => stats.push({ label: `Building fastest ${k + 1}: ${g.codes[i]}`,
            value: `built-up ${_round(u0[i])}% → ${_round(u1[i])}%` }));
        return {
            columns: { site_status: st }, idx, weightKey: 'site_status', noHotspots: true,
            metric: { label: 'Stalled sites or idle plots', value: stalledN, unit: 'blocks', higherIs: 'worse' },
            headline: `${stalledN} blocks hold bare ground inside built-up areas that has not changed in a year (stalled sites or idle plots), ${growN} are building up fast and ${clearN} were cleared this year.`,
            stats,
        };
    }

    // Informal-housing likelihood. Four signs of a dense informal settlement, each 0/1: small footprints (mean under
    // SMALL_M2 m²), packed roofs (cover INF_COVER%+), low rise (under LOW_M m) and low wealth (RWI quintile 1–2).
    // Likely informal = INF_LIKELY or more signs. OSM maps slum lanes well, so road density is not a sign.
    const SMALL_M2 = 60, INF_COVER = 35, LOW_M = 8, INF_LIKELY = 3;

    function informal(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const nb = c['building_stock.buildings_2023'], cov = c['building_stock.cover_2023_pct'], h = c['building_stock.height_2023_m'];
        const q = c['wealth.wealth_quintile'], pop = c['population.population'];
        if (!nb || !cov || !pop) return null;
        const idx = [];
        for (let i = 0; i < n; i++) if (pop[i] > 0 && _fin(nb[i]) && nb[i] >= 20 && _fin(cov[i])) idx.push(i);
        if (idx.length < 5) return null;
        const m2 = g.cellKm2 * 1e6, foot = new Float64Array(n).fill(NaN), signs = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            foot[i] = cov[i] / 100 * m2 / nb[i];
            signs[i] = (foot[i] < SMALL_M2 ? 1 : 0) + (cov[i] >= INF_COVER ? 1 : 0) + (h && _fin(h[i]) && h[i] < LOW_M ? 1 : 0)
                + (q && _fin(q[i]) && q[i] <= 2 ? 1 : 0);
        }
        const people = _sumOver(pop, idx, () => true), likely = _sumOver(pop, idx, i => signs[i] >= INF_LIKELY);
        const nLikely = idx.filter(i => signs[i] >= INF_LIKELY).length;
        const stats = [
            { label: `Residents in blocks with ${INF_LIKELY}+ of 4 informal-settlement signs`, value: `${_people(likely)} (${_round(100 * likely / people)}%)`, raw: Math.round(likely) },
            { label: 'Blocks that look informal', value: `${nLikely}` },
            { label: 'Median building footprint, lived-in blocks', value: `${Math.round(wquantile(foot, null, idx, 0.5))} m²` },
        ];
        const score = Float64Array.from({ length: n }, (_, i) => (signs[i] >= INF_LIKELY ? signs[i] * pop[i] : 0));
        spaced(g, idx.filter(i => signs[i] >= INF_LIKELY), score).slice(0, 5).forEach((i, k) => stats.push({ label: `Likely informal ${k + 1}: ${g.codes[i]}`,
            value: `${_people(pop[i])} residents; ${Math.round(nb[i])} buildings averaging ${Math.round(foot[i])} m², ${_round(cov[i])}% roof cover` }));
        return {
            columns: { informal_signs: signs, footprint_m2: foot }, idx, weightKey: 'informal_signs', noHotspots: true,
            metric: { label: 'Residents in likely informal blocks', value: _round(100 * likely / people), unit: '%', higherIs: null },
            headline: `${_people(likely)} residents (${_round(100 * likely / people)}%) live in blocks that look like dense informal settlements from space: small, packed, low-rise roofs in a low-wealth area.`,
            stats,
        };
    }

    // Lake health. Blocks with at least LAKE_MIN% water in either year are joined into lakes by edge contact.
    // NDCI above 0.1 is algae-rich water (Mishra & Mishra 2012); 30%+ of the old water surface gone green is weed-choked.
    const LAKE_MIN = 20, NDCI_ALGAE = 0.1, WEED_CHOKED = 30, LAKE_SHRUNK = 0.2;

    function _lakeGroups(g, isLake) {
        const at = new Map(), lab = new Int32Array(g.n).fill(-1), groups = [];
        for (let i = 0; i < g.n; i++) if (isLake(i)) at.set(`${g.row[i]},${g.col[i]}`, i);
        for (const [, i0] of at) {
            if (lab[i0] >= 0) continue;
            const grp = [], stack = [i0];
            lab[i0] = groups.length;
            while (stack.length) {
                const i = stack.pop();
                grp.push(i);
                for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const j = at.get(`${g.row[i] + dr},${g.col[i] + dc}`);
                    if (j != null && lab[j] < 0) { lab[j] = groups.length; stack.push(j); }
                }
            }
            groups.push(grp);
        }
        return groups;
    }

    /** Lake health: lakes that shrank since 2019, algae-rich or weed-choked water, and the people living around them. */
    function lakehealth(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const w0 = c['lakes.water_2019_pct'], w1 = c['lakes.water_now_pct'], ndci = c['lakes.chlorophyll_ndci'], weed = c['lakes.weed_pct'];
        const pop = c['population.population'];
        if (!w0 || !w1) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const lakes = _lakeGroups(g, i => Math.max(v(w0, i), v(w1, i)) >= LAKE_MIN).filter(l => l.length >= 2);
        if (!lakes.length) return null;
        const km2 = g.cellKm2;
        const info = lakes.map(l => {
            const a0 = l.reduce((s, i) => s + v(w0, i), 0) / 100 * km2, a1 = l.reduce((s, i) => s + v(w1, i), 0) / 100 * km2;
            const qi = l.filter(i => ndci && _fin(ndci[i])), q = qi.length ? qi.reduce((s, i) => s + ndci[i], 0) / qi.length : null;
            const wi = l.filter(i => weed && _fin(weed[i])), wd = wi.length ? wi.reduce((s, i) => s + weed[i] * v(w0, i), 0) / Math.max(1e-9, wi.reduce((s, i) => s + v(w0, i), 0)) : null;
            const big = l.reduce((b, i) => (Math.max(v(w0, i), v(w1, i)) > Math.max(v(w0, b), v(w1, b)) ? i : b), l[0]);
            return { l, a0, a1, q, wd, code: g.codes[big] };
        });
        const health = new Float64Array(n).fill(NaN), cells = [];
        for (const L of info) {
            const bad = (L.a0 > 0 && (L.a0 - L.a1) / L.a0 >= LAKE_SHRUNK ? 1 : 0) + (L.q != null && L.q >= NDCI_ALGAE ? 1 : 0) + (L.wd != null && L.wd >= WEED_CHOKED ? 1 : 0);
            for (const i of L.l) { health[i] = bad; cells.push(i); }
        }
        const sum0 = info.reduce((s, L) => s + L.a0, 0), sum1 = info.reduce((s, L) => s + L.a1, 0);
        const shrunk = info.filter(L => L.a0 > 0 && (L.a0 - L.a1) / L.a0 >= LAKE_SHRUNK), algae = info.filter(L => L.q != null && L.q >= NDCI_ALGAE);
        const choked = info.filter(L => L.wd != null && L.wd >= WEED_CHOKED);
        let around = null;
        if (pop) {
            const lakeMask = new Float64Array(n);
            for (const i of cells) lakeMask[i] = health[i] >= 1 ? 1 : 0;
            const near = within(g, lakeMask, 0.5);
            around = _sumOver(pop, Array.from({ length: n }, (_, i) => i).filter(i => pop[i] > 0), i => near[i] > 0);
        }
        const stats = [
            { label: `Lakes and reservoirs mapped (2+ blocks with ${LAKE_MIN}%+ water)`, value: `${info.length}: ${_round(sum0, 1)} km² of open water in 2019, ${_round(sum1, 1)} km² now`, raw: info.length },
            { label: `Lakes that lost ${LAKE_SHRUNK * 100}% or more of their open water since 2019`, value: `${shrunk.length}` },
            { label: `Algae-rich lakes (chlorophyll index ${NDCI_ALGAE} or more)`, value: `${algae.length} of ${info.filter(L => L.q != null).length} measured` },
            { label: `Weed-choked lakes (${WEED_CHOKED}%+ of the 2019 water surface now green)`, value: `${choked.length}` },
        ];
        if (around != null) stats.push({ label: 'Residents within 500 m of a lake with at least one problem', value: _people(around) });
        info.filter(L => L.a0 + L.a1 >= 0.1).sort((a, b) => (b.a0 - b.a1) - (a.a0 - a.a1)).slice(0, 3)
            .forEach((L, k) => stats.push({ label: `Shrinking ${k + 1}: lake at ${L.code}`, value: `${_round(L.a0, 2)} → ${_round(L.a1, 2)} km²${L.q != null ? `, chlorophyll ${_round(L.q, 2)}` : ''}${L.wd != null ? `, ${Math.round(L.wd)}% weeds` : ''}` }));
        return {
            columns: { lake_problems: health }, idx: cells, weightKey: 'lake_problems', noHotspots: true,
            metric: { label: 'Lakes with algae, weeds or lost water', value: info.filter(L => health[L.l[0]] >= 1).length, unit: 'lakes', higherIs: 'worse' },
            headline: `${info.length} lakes hold ${_round(sum1, 1)} km² of open water in the dry season (${sum1 >= sum0 ? 'up' : 'down'} from ${_round(sum0, 1)} km² in 2019); ${algae.length} are algae-rich, ${choked.length} are choked by weeds and ${shrunk.length} lost a fifth or more of their water.`,
            stats,
        };
    }

    // Where the jobs are. City workers = residents × the urban work participation rate (Census 2011: 35.3%). They are
    // spread over blocks by an activity weight: half non-residential floor area (GHSL volume × non-residential share ÷ a
    // 3.5 m storey) and half Overture places, so offices and shops both count.
    const WPR_URBAN = 0.353, STOREY_M = 3.5, JOB_KM = 3, CENTRE_Q = 0.99;

    /** Where the jobs are: estimated jobs per block, employment centres, and the jobs–homes balance within 3 km. */
    function jobsmap(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const vol = c['built_up.volume_m3_m2'], nr = c['built_up.nonres_share_pct'], pl = c['places.places'], pop = c['population.population'];
        if (!pop || !(vol && nr) || !pl) return null;
        const m2 = g.cellKm2 * 1e6, floor = new Float64Array(n), places = new Float64Array(n);
        let fSum = 0, pSum = 0, people = 0;
        for (let i = 0; i < n; i++) {
            floor[i] = _fin(vol[i]) && _fin(nr[i]) ? vol[i] * m2 * nr[i] / 100 / STOREY_M : 0;
            places[i] = _fin(pl[i]) ? pl[i] : 0;
            fSum += floor[i]; pSum += places[i]; people += pop[i] > 0 ? pop[i] : 0;
        }
        if (!fSum || !pSum || !people) return null;
        const workers = people * WPR_URBAN, jobs = new Float64Array(n).fill(NaN), cells = [];
        for (let i = 0; i < n; i++) {
            const w = 0.5 * floor[i] / fSum + 0.5 * places[i] / pSum;
            if (w > 0) { jobs[i] = workers * w; cells.push(i); }
        }
        if (cells.length < 5) return null;
        const jNear = within(g, Float64Array.from(jobs, v => (_fin(v) ? v : 0)), JOB_KM);
        const wNear = within(g, Float64Array.from(pop, v => (v > 0 ? v * WPR_URBAN : 0)), JOB_KM);
        const ratio = new Float64Array(n).fill(NaN);
        for (let i = 0; i < n; i++) if (wNear[i] > 0) ratio[i] = jNear[i] / wNear[i];
        const res = [];
        for (let i = 0; i < n; i++) if (pop[i] > 0 && _fin(ratio[i])) res.push(i);
        const dorm = _sumOver(pop, res, i => ratio[i] < 0.5), busy = _sumOver(pop, res, i => ratio[i] >= 1.5);
        const sorted = cells.map(i => jobs[i]).sort((a, b) => a - b), cut = sorted[Math.floor(CENTRE_Q * (sorted.length - 1))];
        const centres = cells.filter(i => jobs[i] >= cut);
        const top = cells.slice().sort((a, b) => jobs[b] - jobs[a]), tenth = top.slice(0, Math.ceil(top.length / 10));
        const share10 = tenth.reduce((s, i) => s + jobs[i], 0) / workers;
        const stats = [
            { label: `Jobs in the city (residents × ${WPR_URBAN * 100}% urban work participation, Census 2011)`, value: _people(workers), raw: Math.round(workers) },
            { label: 'Share of jobs in the busiest tenth of blocks', value: `${_round(100 * share10)}%` },
            { label: `Residents in "bedroom" areas (under half a job per worker within ${JOB_KM} km)`, value: `${_people(dorm)} (${_round(100 * dorm / Math.max(1, people))}%)` },
            { label: `Residents in job-rich areas (1.5+ jobs per worker within ${JOB_KM} km)`, value: `${_people(busy)} (${_round(100 * busy / Math.max(1, people))}%)` },
        ];
        spaced(g, centres, jobs).slice(0, 4).forEach((i, k) => stats.push({ label: `Employment centre ${k + 1}: ${g.codes[i]}`, value: `about ${_people(jobs[i])} jobs in the block, ${_people(jNear[i])} within ${JOB_KM} km` }));
        return {
            columns: { jobs_est: jobs, jobs_per_worker_3km: ratio }, idx: cells, weightKey: 'jobs_est', noHotspots: true,
            metric: { label: 'Share of jobs in the busiest tenth of blocks', value: _round(100 * share10), unit: '%', higherIs: null },
            headline: `About ${_people(workers)} jobs, ${_round(100 * share10)}% of them in the busiest tenth of blocks; ${_people(dorm)} residents (${_round(100 * dorm / Math.max(1, people))}%) live in bedroom areas with under half a job per worker within ${JOB_KM} km.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'coolroof', equity: true, title: 'Cool roofs', icon: '🏠',
            question: 'Where are roofs dark and soaking up heat, who lives under them, and where would painting them white help most?',
            field: { key: 'cool_priority', label: 'Cool-roof priority (residents under dark roofs, weighted for heat, poverty and low-rise homes)', unit: 'people', higherIs: 'worse', ramp: 'reds' },
            extra: [{ key: 'dark_roof_m2', label: 'Dark roof area', unit: 'm²', higherIs: 'worse', ramp: 'reds' }],
            needs: ['roofs.roof_albedo', 'roofs.dark_roof_pct', 'building_stock.cover_2023_pct', 'building_stock.height_2023_m', 'surface_heat.lst_day_c', 'wealth.rwi', 'population.population'],
            method: `Roof albedo is the dry-season (March–May) Sentinel-2 broadband albedo (Liang 2001) over 10 m pixels that are mostly roof in Open Buildings 2023; a roof is dark below ${DARK_LIMIT}. Dark roof area = roof cover × block area × dark share. Priority = residents × dark share, × (1 + degrees the block's daytime surface is above the resident average ÷ 5), × 1.5 where Meta's Relative Wealth Index is below zero, × 1.5 where buildings average under ${LOW_RISE_M} m. Cost assumes about ₹${COOL_COST_M2} a m² for a reflective coating; lime wash is cheaper, membranes dearer. 10 m pixels blend roofs with streets and shade, so dense small-roof areas read a little darker than they are.`,
            refs: 'Liang 2001 and Naegeli et al. 2017 (Sentinel-2 albedo); Vellingiri et al. 2020 (cool roofs in Ahmedabad slums); Telangana Cool Roof Policy 2023–28; Akbari et al. 2009 (global cooling from cool roofs)' },
        { id: 'change', title: 'What changed', icon: '🛰️',
            question: 'Which places have changed most since 2017, and which are changing right now?',
            field: { key: 'change_8yr', label: 'Change since 2017 (satellite embedding distance)', unit: '0-1', higherIs: null, ramp: 'reds', domain: [0, 0.15] },
            extra: [{ key: 'change_2yr', label: 'Change since 2023', unit: '0-1', higherIs: null, ramp: 'reds', domain: [0, 0.1] }],
            needs: ['embeddings.change_8yr', 'embeddings.change_2yr', 'building_stock.new_buildings', 'building_stock.growth_pct', 'vegetation.tree_canopy_pct', 'land_cover.water_pct', 'land_cover.bare_pct', 'land_cover.crop_pct', 'population.population'],
            method: `Google Satellite Embedding V1 (AlphaEarth Foundations) sums up each 10 m pixel's year of optical, radar, thermal, terrain and climate data as 64 numbers. Change is 1 − cosine similarity between a block's mean embedding in 2017 (or 2023) and 2025. Years differ in rain and haze, so "strong" means ${CHG_X}× the city's median block. The kind of change is read from Open Buildings new buildings (2016–2023), then ESA WorldCover water, bare ground and cropland, then tree canopy; embeddings say how much changed, not what.`,
            refs: 'Brown et al. 2025 (AlphaEarth Foundations, Google DeepMind); Google Satellite Embedding V1 (CC BY 4.0); Sirko et al. 2023 (Open Buildings 2.5D Temporal)' },
        { id: 'airtrend', equity: true, title: 'Air trend', icon: '📉',
            question: 'Is the air getting cleaner or dirtier, and for whom?',
            field: { key: 'no2_change_pct', label: 'Change in NO₂ since 2019', unit: '%', higherIs: 'worse', ramp: 'diverging', domain: [-30, 30] },
            needs: ['air_trend.no2_change_pct', 'air_trend.no2_2019', 'air_trend.no2_latest', 'air_trend.pm25_2012', 'air_trend.pm25_2022', 'air_trend.so2_umol_m2', 'haze_mix.dust_share_pct', 'haze_mix.smoke_share_pct', 'haze_mix.sulphate_share_pct', 'haze_mix.seasalt_share_pct', 'haze_mix.dust_days_yr', 'population.population'],
            method: `Sentinel-5P TROPOMI tropospheric NO₂ annual means, 2019 against 2025 (~5 km columns, so neighbouring blocks share values); Washington University satellite-derived surface PM2.5 (V6.GL, ~1 km), 2012 against 2022; and the 2025 SO₂ column, which is noisy except near big sources (hotspots are named only above ${SO2_NOTABLE} µmol/m²). Changes under ${AIR_FLAT}% are within weather swings between years and count as flat. Columns measure the whole air above a place, not what reaches the street. The haze mix is the CAMS model's 2025 split of aerosol optical depth into dust, smoke (black carbon plus organic matter), sulphate and sea salt on a ~40 km grid; dust-haze days have a daily mean dust optical depth over 0.3.`,
            refs: 'Veefkind et al. 2012 (TROPOMI); van Donkelaar et al. 2021 (V5/V6.GL PM2.5); Inness et al. 2019 (CAMS reanalysis); NCAP progress reports (MoEFCC)' },
        { id: 'airdeaths', equity: true, title: 'Deaths from air pollution', icon: '🫁',
            question: 'How many early deaths does the city\'s PM2.5 cause a year, where, and how many would meeting the standard save?',
            field: { key: 'air_deaths_per_lakh', label: 'Early deaths from PM2.5 per 1 lakh residents a year', unit: 'per lakh/yr', higherIs: 'worse', ramp: 'reds' },
            extra: [{ key: 'air_deaths', label: 'Early deaths from PM2.5 a year (block)', unit: 'deaths/yr', higherIs: 'worse', ramp: 'reds' }],
            needs: ['air_trend.pm25_2022', 'population.population'],
            method: `Attributable deaths = residents × ${BASE_DEATHS_PER_1000} non-communicable plus lower-respiratory deaths per 1,000 a year (GBD 2019 India, all ages) × (1 − 1/RR). RR is the Global Exposure Mortality Model for NCD+LRI with the Chinese cohort (θ ${GEMM.theta}, α ${GEMM.alpha}, μ ${GEMM.mu}, ν ${GEMM.nu}, counterfactual ${GEMM.cf} µg/m³) at the block's 2022 satellite-derived PM2.5 (Washington University V6.GL, ~1 km). Avoided deaths compare each block's RR with RR at ${NAAQS_PM25} µg/m³. One national baseline rate is used everywhere, so the map shows where air kills more, not local death records; GEMM covers adults 25+, and children's deaths are not counted.`,
            refs: 'Burnett et al. 2018 (GEMM, PNAS); GBD 2019 India State-Level Disease Burden Initiative (Lancet Planetary Health 2021); van Donkelaar et al. 2021 (V6.GL PM2.5); WHO 2021 air quality guidelines' },
        { id: 'burning', equity: true, title: 'Open burning', icon: '🔥',
            question: 'Where do satellites see fires again and again, and who lives in the smoke?',
            field: { key: 'fire_days_yr', label: 'Days a year with an active fire', unit: 'days', higherIs: 'worse', ramp: 'reds', domain: [0, 20] },
            needs: ['fires.fire_days_yr', 'fires.winter_fire_days_yr', 'land_cover.crop_pct', 'land_cover.bare_pct', 'land_cover.built_pct', 'population.population'],
            method: `NASA VIIRS (Suomi NPP) 375 m active-fire detections of nominal or high confidence since September 2023, counted as days a year at each block's most-burned spot. Blocks with ${FIRE_OFTEN}–${FIRE_INDUSTRY} days a year count as frequent burning; ${FIRE_INDUSTRY} or more is nearly always a steady heat source such as a furnace or kiln and is listed apart. Residents within ${SMOKE_KM} km of a frequent-burning block are counted. The likely kind comes from ESA WorldCover. The satellite passes about 1:30 am and pm, so small and short fires are missed.`,
            refs: 'Schroeder et al. 2014 (VIIRS 375 m active fire); NASA FIRMS; CAQM directions on open burning; Jethva et al. 2019 (crop-residue fires)' },
        { id: 'ground', title: 'Ground conditions', icon: '🪨',
            question: 'What is the ground like for building: black cotton soil, low wet land, slopes and earthquake zone?',
            field: { key: 'ground_issues', label: 'Ground issues (expansive clay, low-lying or wet, steep)', unit: 'of 3', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            needs: ['subsoil.clay_60cm_pct', 'terrain.hand_m', 'terrain.slope_deg', 'waterlogging.waterlogging_index', 'building_stock.new_buildings', 'population.population'],
            method: `Expansive clay: OpenLandMap predicted clay of ${CLAY_EXPANSIVE}% or more at 60 cm (250 m). Low-lying or wet: a waterlogging index of ${WLOG_HIGH}+ (the Waterlogging lens), or under ${HAND_LOW_M} m above the nearest drainage line (MERIT Hydro HAND) where that index is missing. Steep: a slope of ${SLOPE_STEEP}° or more (Copernicus DEM). Seismic zone is the city's zone in IS 1893 (Part 1): 2016, Annex E. Soil maps are model predictions under cities: they say where to test, not what a borehole will find.`,
            refs: 'IS 1893 (Part 1): 2016; IS 2911 (Part 3) under-reamed piles; IS 13920 ductile detailing; Hengl et al. 2017 (SoilGrids/OpenLandMap); Yamazaki et al. 2019 (MERIT Hydro)' },
        { id: 'treeplant', equity: true, title: 'Plant trees here', icon: '🌱',
            question: 'How many trees does each neighbourhood need for 30% canopy, where can they go, and where first?',
            field: { key: 'plant_trees', label: 'Trees that fit on the block\'s open land toward 30% canopy', unit: 'trees', higherIs: null, ramp: 'greens' },
            extra: [{ key: 'trees_needed', label: 'Trees needed for 30% canopy', unit: 'trees', higherIs: 'worse', ramp: 'reds' }],
            needs: ['vegetation.tree_canopy_pct', 'land_cover.grass_pct', 'land_cover.bare_pct', 'land_cover.shrub_pct', 'surface_heat.lst_day_c', 'population.population'],
            method: `Canopy gap = ${CANOPY_TARGET}% (the 3-30-300 rule) minus the block's tree canopy ≥ 5 m (Meta/WRI 1 m canopy height), turned into trees at ${CROWN_M2} m² of mature crown each. Room = ${OPEN_USABLE * 100}% of the block's grass, shrub and bare ground (ESA WorldCover), as paths, playing fields and utilities take the rest. Priority = trees that fit × (1 + degrees the block's daytime surface is above the resident average ÷ 3) × residents (full weight at 2,000). Private land, ownership and soil are not modelled.`,
            refs: 'Konijnendijk 2023 (3-30-300 rule); Tolan et al. 2024 (Meta/WRI canopy height); Zanaga et al. 2022 (ESA WorldCover); Ziter et al. 2019 (canopy cooling thresholds)' },
        { id: 'farmloss', equity: false, title: 'Farmland at the edge', icon: '🌾',
            question: 'How much farmland has the city built over since 2018, and where is the edge moving now?',
            field: { key: 'farm_built_ha', label: 'Farmland turned built-up since 2018', unit: 'ha', higherIs: 'worse', ramp: 'reds' },
            extra: [{ key: 'farm_edge', label: 'Active edge (part farm, part building)', unit: 'yes/no', higherIs: null, ramp: 'heat', domain: [0, 1] }],
            needs: ['farmland.crop_2018_pct', 'farmland.crop_now_pct', 'farmland.crop_built_pp', 'farmland.built_now_pct', 'growth.urban_2035_pct'],
            method: `Dynamic World V1 yearly mode label at 10 m for 2018 and 2025 (crops = class 4, built = class 6). Built over = pixels that were crops in 2018 and are built in 2025. An active edge block is still ${EDGE_CROP}%+ crops and already ${EDGE_BUILT}%+ built. Farmland expected to go by 2035 = each block's 2025 farmland × the CA-ML growth model's projected urban share of the block. Dynamic World calls roads and cleared, plotted land built-up too: in Bengaluru and Pune the blocks that lost most farmland had only about 4–5% roof cover in Open Buildings 2023, so much of the conversion is layouts waiting for houses. Dynamic World mixes dry fallow with bare ground and grass, so net loss beyond the built part, and any block change under ${FARM_NOISE} points, is partly a wet or dry year rather than lost farming.`,
            refs: 'Brown et al. 2022 (Dynamic World); Pandey & Seto 2015 (urbanisation and farmland loss in India); d\'Amour et al. 2017 (future urban expansion and cropland)' },
        { id: 'market', equity: false, title: 'Property market activity', icon: '🏷️',
            question: 'Where is the property market busiest, and where is it busy while land is still cheap?',
            field: { key: 'agents_1km', label: 'Estate agents and brokers within 1 km', unit: 'agents', higherIs: null, ramp: 'heat' },
            extra: [{ key: 'market_emerging', label: 'Emerging market (busy, land below the city median)', unit: 'yes/no', higherIs: null, ramp: 'viridis', domain: [0, 1] }],
            needs: ['places.property_agents', 'land_value.value_index', 're_supply.build_rate', 'population.population'],
            method: `Overture places (confidence 0.6+, not closed) whose category or name marks an estate agent, broker or property dealer, summed within ${MARKET_KM} km of each block. Agents cluster where deals happen, so the count is a proxy for transaction activity, not prices. Hot = top ${_round(100 * (1 - MARKET_HOT))}% of blocks; emerging = hot while the block's land value index is below the city median. ρ is the Spearman rank correlation between agent density and the land value index over blocks with any agents. Coverage of small dealers in Overture is uneven, so compare blocks within a city, not across cities.`,
            refs: 'Overture Maps Foundation places (2026-10); Glaeser, Kim & Luca 2018 (online listings as a proxy for local economic activity); DigiPin land value model (docs/REAL_ESTATE_MODEL.md)' },
        { id: 'parkshare', equity: true, title: 'Park space per resident', icon: '🏞',
            question: 'How much public park space does each neighbourhood have per person, and where is it most short?',
            field: { key: 'park_m2_per_resident', label: 'Public park space per resident within 1 km', unit: 'm²', higherIs: 'better', ramp: 'greens', domain: [0, 20] },
            extra: [{ key: 'park_gap_m2', label: 'Park space short of 10 m² a resident (block total)', unit: 'm²', higherIs: 'worse', ramp: 'reds' }],
            needs: ['parks.park_m2', 'parks.big_park', 'population.population'],
            method: `Public green and play space = Overture Maps land use (from OpenStreetMap) of class park, garden, recreation ground, playground, pitch, dog park, village green or common, clipped to each block. Per resident = park area within ${PARK_KM} km of the block ÷ residents within ${PARK_KM} km (GHSL), so a big park is shared by everyone around it. Targets: WHO ${WHO_M2} m² of green space per person; URDPFI (India, 2014) ${URDPFI_M2}–12 m² of organised open space per person; WHO Europe 0.5 ha of green within 300 m. Ridge forests, nature reserves and unmapped or private green are not counted; tree cover is in the Green lens.`,
            refs: 'WHO Regional Office for Europe 2016 (Urban green spaces and health); MoHUA URDPFI Guidelines 2014; Overture Maps base theme (2026-10); GHSL population' },
        { id: 'mangrove', equity: false, title: 'Mangroves', icon: '🌿',
            question: 'How much mangrove does the city have, what has been lost since 1996, and who does it shelter?',
            field: { key: 'mangrove_lost_ha', label: 'Mangrove lost since 1996', unit: 'ha', higherIs: 'worse', ramp: 'reds' },
            extra: [{ key: 'mangrove_now_pct', label: 'Mangrove share of the block, 2020', unit: '%', higherIs: 'better', ramp: 'greens', domain: [0, 100] }],
            needs: ['mangroves.mangrove_1996_pct', 'mangroves.mangrove_2020_pct', 'mangroves.mangrove_lost_pct', 'growth.built_change_pp', 'population.population'],
            method: `Global Mangrove Watch v3 extent polygons (25 m, ALOS PALSAR radar and Landsat) for 1996 and 2020, rasterised per block. Lost = mangrove in 1996 and not in 2020; some stands also grew back or spread on new mud, so net change is smaller than loss. Residents within ${SURGE_KM} km of a mangrove block are counted as getting some storm-surge and erosion shelter; the real buffer depends on belt width. Only cities whose map extent reaches mangroves (Mumbai) have this layer.`,
            refs: 'Bunting et al. 2022 (Global Mangrove Watch v3, Remote Sensing); Menéndez et al. 2020 (global flood protection benefits of mangroves); Bombay High Court 2018 order protecting Maharashtra mangroves' },
        { id: 'runoff', equity: false, title: 'Storm runoff', icon: '🌧️',
            question: 'How much of a heavy day\'s rain runs off into the drains, from where, and how much would greening help?',
            field: { key: 'runoff_mm', label: 'Runoff on the wettest day of 2025', unit: 'mm', higherIs: 'worse', ramp: 'blues' },
            extra: [{ key: 'runoff_m3', label: 'Runoff volume from the block', unit: 'm³', higherIs: 'worse', ramp: 'blues' }],
            needs: ['land_cover.built_pct', 'land_cover.tree_pct', 'land_cover.shrub_pct', 'land_cover.grass_pct', 'land_cover.crop_pct', 'land_cover.bare_pct', 'land_cover.water_pct', 'land_cover.wetland_pct', 'land_cover.mangrove_pct', 'rainfall.rain_max_day_mm', 'soil.sand_pct', 'soil.clay_pct', 'waterlogging.waterlogging_index'],
            method: `SCS curve-number runoff Q = (P − 0.2S)² / (P + 0.8S), S = 25400/CN − 254 mm, with P the block's wettest day of 2025 (CHIRPS v2, ~5 km) and CN the land-cover-weighted TR-55 curve number for average wetness (ESA WorldCover 2021 classes; built 89–95, trees 30–77, grass 39–80, crops 67–89, bare 77–94 across soil groups A–D) on the SoilGrids hydrologic soil group (A sand ≥ 70% and clay < 10%; D clay ≥ 40%; C clay ≥ 27%; else B). The what-if turns ${GREEN_SWAP * 100}% of each block's built cover into grass-like cover. Blocks where floods start are those with a waterlogging index of ${WLOG_HIGH}+, ranked by runoff generated within 1 km. Drains, slope routing and storage are not modelled.`,
            refs: 'USDA NRCS 1986 (TR-55 Urban Hydrology for Small Watersheds); Hawkins et al. 2009 (curve number hydrology); Funk et al. 2015 (CHIRPS); Hengl et al. 2017 (SoilGrids)' },
        { id: 'nighteconomy', equity: false, title: 'Night-time economy', icon: '🌃',
            question: 'Where is the city awake late at night, with places to eat, meet and stay?',
            field: { key: 'night_score', label: 'Late-night light plus eateries, leisure and hotels nearby', unit: 'z', higherIs: null, ramp: 'viridis' },
            extra: [{ key: 'night_district', label: 'Night district (top 10% for both)', unit: 'yes/no', higherIs: null, ramp: 'heat', domain: [0, 1] }],
            needs: ['nightlights.radiance', 'places.food', 'places.leisure', 'places.lodging', 'population.population'],
            method: `VIIRS Day/Night Band radiance (2025 median) is recorded at about 1:30 am local time, so it measures late-night light. Places = Overture eateries and bars, leisure and entertainment, and hotels, summed within ${NIGHT_KM} km. Score = standardised log radiance + standardised log places. A night district is in the top ${_round(100 * (1 - NIGHT_TOP))}% of blocks for both. Industrial yards, depots and floodlit stations are bright but have few such places, so they score on light alone. Opening hours are not in the data.`,
            refs: 'Elvidge et al. 2017 (VIIRS DNB); Overture Maps Foundation places; Roberts & Eldridge 2009 (planning the night-time city)' },
        { id: 'catchment', equity: false, title: 'Retail catchments', icon: '🛍️',
            question: 'Which shopping centres draw the most residents, and which are short of shops for the people they serve?',
            field: { key: 'huff_draw', label: 'Residents whose shopping trips the centre draws', unit: 'people', higherIs: null, ramp: 'viridis' },
            extra: [{ key: 'residents_per_shop', label: 'Residents per shop at the centre', unit: 'people', higherIs: 'worse', ramp: 'heat' }],
            needs: ['places.shopping', 'population.population'],
            method: `Huff gravity model. Centres are blocks in the top ${_round(100 * (1 - HUFF_TOP))}% for Overture shops (at least 3). Each block's residents (GHSL) split their trips across centres within ${HUFF_KM} km in proportion to shops ÷ distance^${HUFF_BETA} (distance at least ${HUFF_MIN_KM} km). Draw = residents' trips a centre wins; residents per shop = draw ÷ shops. Centres at twice the median residents per shop are flagged as having room for more shops. Income, parking and online shopping are not modelled.`,
            refs: 'Huff 1963 (a probabilistic analysis of shopping centre trade areas); Dolega, Pavlis & Singleton 2016 (estimating retail catchments); Overture Maps Foundation places' },
        { id: 'sites', equity: false, title: 'Construction sites', icon: '🏗️',
            question: 'Where is construction starting, moving fast, or stalled?',
            field: { key: 'site_status', label: 'Site: 1 cleared this year, 2 building up, 3 stalled', unit: 'class', higherIs: null, ramp: 'heat', domain: [0, 3] },
            needs: ['sites.site_status', 'sites.bare_now', 'sites.built_then', 'sites.built_now', 'population.population'],
            method: 'Dynamic World monthly built-up and bare-ground probabilities averaged over two dry seasons a year apart (Dec 2024–May 2025 and Dec 2025–May 2026). In blocks at least 15% built-up, a site is 25%+ bare ground. Stalled = bare in both seasons with built-up moving under 5 points; building up = built-up up 10+ points; cleared this year = bare up 15+ points, or built-up down 10+ with bare ground up as much (demolition). Quarries, dry open plots and fair grounds can look like stalled sites, so check them on the satellite view. Residents near stalled sites are counted within 300 m.',
            refs: 'Brown et al. 2022 (Dynamic World); RERA project status as the ground truth to compare against (state portals)' },
        { id: 'informal', equity: true, title: 'Informal housing (likely)', icon: '🏘️',
            question: 'Which neighbourhoods look like dense informal settlements, and how many people live there?',
            field: { key: 'informal_signs', label: 'Informal-settlement signs (of 4)', unit: 'of 4', higherIs: null, ramp: 'heat', domain: [0, 4] },
            extra: [{ key: 'footprint_m2', label: 'Mean building footprint', unit: 'm²', higherIs: null, ramp: 'viridis', domain: [0, 300] }],
            needs: ['building_stock.buildings_2023', 'building_stock.cover_2023_pct', 'building_stock.height_2023_m', 'wealth.wealth_quintile', 'population.population'],
            method: `Four signs per lived-in block with 20+ buildings: mean footprint under ${SMALL_M2} m² (Open Buildings 2.5D 2023 roof cover × block area ÷ building count); roof cover ${INF_COVER}%+; mean height under ${LOW_M} m; Meta Relative Wealth Index quintile 1–2. ${INF_LIKELY}+ signs = likely informal. Open Buildings often merges touching slum roofs into one polygon, which inflates footprints, so dense settlements can be undercounted. This is a look-alike from space, not a legal status: notified slums, urban villages and old walled cores can all score high, and Census 2011 slum shares (Mumbai 41%, Delhi 15%) count differently.`,
            refs: 'Kuffer, Pfeffer & Sliuzas 2016 (slums from space); Sirko et al. 2023 (Open Buildings 2.5D); Chi et al. 2022 (Relative Wealth Index); Census of India 2011 slum tables' },
        { id: 'lakehealth', equity: false, title: 'Lake health', icon: '🏞️',
            question: 'Which lakes are shrinking, green with algae or choked with weeds?',
            field: { key: 'lake_problems', label: 'Lake problems (lost water, algae, weeds)', unit: 'of 3', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            needs: ['lakes.water_2019_pct', 'lakes.water_now_pct', 'lakes.chlorophyll_ndci', 'lakes.turbidity_ndti', 'lakes.weed_pct', 'population.population'],
            method: `Sentinel-2 dry-season (Feb–Apr) medians, 2019 and 2025. Water is MNDWI above 0.2; blocks with ${LAKE_MIN}% or more water in either year are joined into lakes by shared edges (2+ blocks). A lake has lost water if its open area fell ${LAKE_SHRUNK * 100}% or more; it is algae-rich if the mean chlorophyll index (NDCI) over clear water is ${NDCI_ALGAE}+; it is weed-choked if ${WEED_CHOKED}%+ of its 2019 water now reads as vegetation (NDVI above 0.3: water hyacinth, reeds or infill). A dry or wet year before either season moves open water a lot, so small changes are noise.`,
            refs: 'Mishra & Mishra 2012 (NDCI); Xu 2006 (MNDWI); Lacaux et al. 2007 (NDTI); Ramachandra et al. (IISc Bengaluru lakes studies)' },
        { id: 'jobsmap', equity: false, title: 'Where the jobs are', icon: '💼',
            question: 'Where are the jobs, where are the employment centres, and which areas are only bedrooms?',
            field: { key: 'jobs_est', label: 'Estimated jobs in the block', unit: 'jobs', higherIs: null, ramp: 'viridis' },
            extra: [{ key: 'jobs_per_worker_3km', label: `Jobs per resident worker within 3 km`, unit: 'ratio', higherIs: null, ramp: 'diverging', domain: [0, 2] }],
            needs: ['built_up.volume_m3_m2', 'built_up.nonres_share_pct', 'places.places', 'population.population'],
            method: `City jobs = residents × ${WPR_URBAN * 100}% (Census 2011 urban work participation rate), assuming as many jobs as resident workers. They are spread over blocks by an activity weight: half the block's share of non-residential floor area (GHSL 2020 built volume × non-residential share ÷ ${STOREY_M} m a storey) and half its share of Overture places. Jobs–homes balance compares jobs and resident workers within ${JOB_KM} km. Home-based and street work are spread with homes and places only roughly, and in-commuting from outside the city is ignored: a pattern, not a count.`,
            refs: 'Census of India 2011 (work participation, urban); Pesaresi et al. 2023 (GHSL built volume and non-residential share); Overture Maps places; Cervero 1989 (jobs–housing balance)' },
    ];

    UrbanLenses.register(ENTRIES, { coolroof, change, airtrend, airdeaths, burning, ground, treeplant, farmloss, market, parkshare, mangrove, runoff, nighteconomy, catchment, sites, informal, lakehealth, jobsmap },
        { lookalike, lookalikeText, SEISMIC_ZONE }, 'vitality');
    return { ENTRIES, SEISMIC_ZONE, lookalike, lookalikeText };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesEnvironment = UrbanLensesEnvironment;
}
