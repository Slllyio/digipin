/**
 * Planning and regulation lenses for UrbanLenses: construction limits around protected monuments and land-use mix.
 * They read the heritage and landuse cell datasets (pipeline/realestate/heritage.py, landuse.py). Registers itself on load, after urban-lenses.js.
 */
const UrbanLensesPlanning = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _sumOver, within, wquantile, _net, DIRS } = UrbanLenses._kit;

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

    // What changed in a year. The latest three months with good coverage against the same three months a year
    // before (which cancels the season and smooths a cloudy month) in four monthly satellite series. A block is
    // flagged for new building (built-up +15 points), lights coming on (radiance +50% and +2 nW), greenery lost
    // (NDVI -0.15) or dirtier air (NO2 +30% from at least NO2_FLOOR).
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const _mon = st => { const m = /^(\d{4})-(\d{2})/.exec(st || ''); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(st); };
    const NO2_FLOOR = 40;
    const CHANGE_SIGNS = [
        { key: 'construction_monthly.built_pct', name: 'new building', test: (a, b) => b - a >= 15, size: (a, b) => b - a, fmt: d => `+${_round(d)} points built-up` },
        { key: 'nightlights_monthly.radiance', name: 'lights coming on', test: (a, b) => b >= a * 1.5 && b - a >= 2, size: (a, b) => b - a, fmt: d => `+${_round(d, 1)} nW/cm²/sr` },
        { key: 'ndvi_monthly.ndvi', name: 'greenery lost', test: (a, b) => a - b >= 0.15, size: (a, b) => a - b, fmt: d => `NDVI down ${_round(d, 2)}` },
        { key: 'no2_monthly.no2_umol_m2', name: 'dirtier air', test: (a, b) => a >= NO2_FLOOR && b >= a * 1.3, size: (a, b) => (b - a) / a * 100, fmt: d => `NO₂ up ${_round(d)}%` },
    ];
    const COVER_MIN = 0.5, WIN = 3;

    function monthly(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const idx = [];
        for (let i = 0; i < n; i++) if (!pop || pop[i] > 0) idx.push(i);
        const flags = new Float64Array(n).fill(NaN), stats = [], found = [];
        const num = x => (x == null ? NaN : Number(x));
        const mean3 = (a, k) => {
            let t = 0, m = 0;
            for (let j = k - WIN + 1; j <= k; j++) { const x = num(a[j]); if (Number.isFinite(x)) { t += x; m++; } }
            return m >= 2 ? t / m : NaN;
        };
        for (const S of CHANGE_SIGNS) {
            const ser = c[`${S.key}@series`], ds = S.key.split('.')[0], steps = (fr.steps && fr.steps[ds]) || [];
            if (!ser || steps.length < 12 + WIN) continue;
            // Latest window that most blocks have, with the same window a year earlier.
            let t = -1;
            for (let k = steps.length - 1; k >= 11 + WIN && t < 0; k--) {
                let ok = 0;
                for (const i of idx) if (ser[i] && Number.isFinite(mean3(ser[i], k)) && Number.isFinite(mean3(ser[i], k - 12))) ok++;
                if (ok >= COVER_MIN * idx.length) t = k;
            }
            if (t < 0) continue;
            const hit = [], size = new Float64Array(n).fill(NaN);
            for (const i of idx) {
                if (!ser[i]) continue;
                const a = mean3(ser[i], t - 12), b = mean3(ser[i], t);
                if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
                if (!_fin(flags[i])) flags[i] = 0;
                if (S.test(a, b)) { hit.push(i); flags[i] += 1; size[i] = S.size(a, b); }
            }
            const when = `${_mon(steps[t - WIN + 1])}–${_mon(steps[t])} vs a year before`;
            found.push({ S, hit });
            stats.push({ label: `Blocks with ${S.name} (${when})`, value: hit.length.toLocaleString('en-IN'), raw: hit.length });
            spaced(g, hit, size).slice(0, 2).forEach((i, k) => stats.push({ label: `${S.name[0].toUpperCase()}${S.name.slice(1)} ${k + 1}: ${g.codes[i]}`, value: S.fmt(size[i]) }));
        }
        if (!found.length) return null;
        const scored = idx.filter(i => _fin(flags[i]));
        const multi = scored.filter(i => flags[i] >= 2).length;
        const parts = found.map(f => `${f.hit.length.toLocaleString('en-IN')} ${f.S.name}`);
        return {
            columns: { change_signs: flags }, idx: scored, weightKey: 'change_signs', noHotspots: true,
            metric: { label: 'Blocks with a year-on-year change sign', value: scored.filter(i => flags[i] >= 1).length, unit: 'blocks', higherIs: null },
            headline: `Latest three months against the same months a year earlier: ${parts.join(', ')} blocks; ${multi.toLocaleString('en-IN')} show two or more signs at once, the likeliest places where something real happened. Cloud and haze can still fake a sign, so check a flagged block on the satellite view.`,
            stats,
        };
    }

    // Protected forests and their buffers. Overture 'protected' land (national parks, sanctuaries, reserve forests,
    // biodiversity parks) and eco-sensitive zones; building inside them from Open Buildings Temporal 2016 → 2023,
    // assuming building is spread evenly over the block, and tree cover from WorldCover and Hansen loss.
    function greenbelt(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const prot = c['landuse.protected_pct'], esz = c['landuse.esz_pct'];
        const b16 = c['growth.built_2016_pct'], b23 = c['growth.built_2023_pct'], tree = c['land_cover.tree_pct'], lost = c['encroachment.tree_lost_pct'];
        const pop = c['population.population'];
        if (!prot || !b23) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const inP = [], inE = [];
        for (let i = 0; i < n; i++) { if (v(prot, i) > 0) inP.push(i); if (v(esz, i) > 0) inE.push(i); }
        if (!inP.length) return null;
        const km2 = (cells, share, f) => cells.reduce((a, i) => a + v(share, i) / 100 * f(i) * g.cellKm2, 0);
        const area = km2(inP, prot, () => 1), built = km2(inP, prot, i => v(b23, i) / 100), built16 = b16 ? km2(inP, prot, i => v(b16, i) / 100) : null;
        const growth = Float64Array.from({ length: n }, (_, i) => (v(prot, i) + v(esz, i) > 0 ? Math.max(0, v(b23, i) - v(b16, i)) : NaN));
        const stats = [
            { label: 'Protected land mapped (parks, sanctuaries, reserve forests)', value: `${_round(area, 1)} km²` },
            { label: 'Built over inside it, 2023', value: `${_round(built, 2)} km² (${_round(100 * built / Math.max(area, 1e-9), 1)}%)`, raw: _round(built, 3) },
        ];
        if (built16 != null) stats.push({ label: 'Of which built since 2016', value: `${_round(Math.max(0, built - built16), 2)} km²` });
        if (tree) stats.push({ label: 'Tree cover inside (WorldCover 2021)', value: `${_round(100 * km2(inP, prot, i => v(tree, i) / 100) / Math.max(area, 1e-9))}%` });
        if (lost) stats.push({ label: 'Tree cover lost inside since 2001 (Hansen)', value: `${_round(km2(inP, prot, i => v(lost, i) / 100), 2)} km²` });
        if (esz && inE.length) {
            const eArea = km2(inE, esz, () => 1), eBuilt = km2(inE, esz, i => v(b23, i) / 100), e16 = b16 ? km2(inE, esz, i => v(b16, i) / 100) : null;
            stats.push({ label: 'Eco-sensitive zone mapped around them', value: `${_round(eArea, 1)} km², ${_round(100 * eBuilt / Math.max(eArea, 1e-9))}% built${e16 != null ? `, +${_round(Math.max(0, eBuilt - e16), 2)} km² since 2016` : ''}` });
        }
        const both = [...new Set([...inP, ...inE])], share = i => Math.min(100, v(prot, i) + v(esz, i)) / 100;
        if (pop) stats.push({ label: 'Residents inside protected land or its buffer (by block share)', value: _people(both.reduce((a, i) => a + v(pop, i) * share(i), 0)) });
        spaced(g, both.filter(i => growth[i] > 0), Float64Array.from(growth, (x, i) => (_fin(x) ? x * share(i) : NaN))).slice(0, TOP).forEach((i, k) => stats.push({ label: `Building inside ${k + 1}: ${g.codes[i]}`,
            value: `+${_round(growth[i])} points built-up 2016→2023; ${Math.round(v(prot, i))}% protected, ${Math.round(v(esz, i))}% eco-sensitive` }));
        return {
            columns: { protected_growth_pp: growth, protected_pct: prot }, idx: both, weightKey: 'protected_growth_pp', noHotspots: true,
            metric: { label: 'Protected land built over (2023)', value: _round(100 * built / Math.max(area, 1e-9), 1), unit: '%', higherIs: 'worse' },
            headline: `${_round(area, 1)} km² of national parks, sanctuaries and reserve forests is mapped here; ${_round(built, 2)} km² of it (${_round(100 * built / Math.max(area, 1e-9), 1)}%) is built over${built16 != null ? `, ${_round(Math.max(0, built - built16), 2)} km² of that since 2016` : ''}. Boundaries are OpenStreetMap's, not the gazette notification, so check before calling a block an encroachment.`,
            stats,
        };
    }

    // Mosquito season and breeding risk. Aedes aegypti (dengue, chikungunya) transmits between about 18 and 34 °C
    // with a peak near 29 °C (Mordecai et al. 2017). A month is suitable when the mean of day and night land surface
    // temperature, a rough air-temperature proxy, is in that range and that month or the one before had RAIN_WET mm.
    // Risk = 40% suitable months of the last 12, 30% waterlogging index, 30% density percentile.
    const AEDES_MIN = 18, AEDES_MAX = 34, RAIN_WET = 40, MOSQ_TOP = 70;

    function mosquito(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const day = c['lst_monthly.lst_day_c@series'], night = c['lst_monthly.lst_night_c@series'], rain = c['rain_monthly.rain_mm@series'];
        const wl = c['waterlogging.waterlogging_index'], dens = c['population.density_km2'];
        if (!day || !night || !rain || !pop) return null;
        const steps = (fr.steps && fr.steps.lst_monthly) || [];
        const num = x => (x == null ? NaN : Number(x));
        const idx = [];
        for (let i = 0; i < n; i++) if (pop[i] > 0 && day[i] && night[i] && rain[i]) idx.push(i);
        if (idx.length < 5 || steps.length < 13) return null;
        const months = new Float64Array(n).fill(NaN), byMonth = new Array(12).fill(0), seen = new Array(12).fill(0);
        const T = day[idx[0]].length;
        for (const i of idx) {
            let k = 0, ok = 0;
            for (let t = Math.max(1, T - 12); t < T; t++) {
                const tm = (num(day[i][t]) + num(night[i][t])) / 2, r = Math.max(num(rain[i][t]) || 0, num(rain[i][t - 1]) || 0);
                if (!Number.isFinite(tm)) continue;
                ok++;
                const m = Number(String(steps[t] || '').slice(5, 7)) - 1;
                const yes = tm >= AEDES_MIN && tm <= AEDES_MAX && r >= RAIN_WET;
                if (yes) k++;
                if (m >= 0) { seen[m] += pop[i]; if (yes) byMonth[m] += pop[i]; }
            }
            if (ok >= 8) months[i] = k * 12 / ok;
        }
        const scored = idx.filter(i => _fin(months[i]));
        if (scored.length < 5) return null;
        const dSorted = dens ? scored.map(i => dens[i]).filter(_fin).sort((a, b) => a - b) : [];
        const dPct = i => { if (!dens || !_fin(dens[i]) || !dSorted.length) return 50; let lo = 0, hi = dSorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (dSorted[m] < dens[i]) lo = m + 1; else hi = m; } return 100 * lo / dSorted.length; };
        const risk = new Float64Array(n).fill(NaN);
        for (const i of scored) risk[i] = 0.4 * (months[i] / 12 * 100) + 0.3 * (wl && _fin(wl[i]) ? Math.min(100, wl[i]) : 50) + 0.3 * dPct(i);
        const all = _sumOver(pop, scored, () => true), top = scored.filter(i => risk[i] >= MOSQ_TOP), pTop = _sumOver(pop, top, () => true);
        const meanMonths = scored.reduce((a, i) => a + months[i] * pop[i], 0) / Math.max(all, 1);
        const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const season = byMonth.map((v, m) => (seen[m] ? v / seen[m] : 0)).map((v, m) => [MON[m], v]).filter(([, v]) => v >= 0.5).map(([m]) => m);
        const stats = [
            { label: 'Mosquito-suitable months in the last 12 (per resident)', value: `${_round(meanMonths, 1)}` },
            { label: 'Months suitable for most residents', value: season.length ? season.join(', ') : 'none' },
            { label: `People in high-risk blocks (score ${MOSQ_TOP}+)`, value: `${_people(pTop)} (${_round(100 * pTop / Math.max(all, 1), 1)}%)`, raw: Math.round(pTop) },
        ];
        spaced(g, top, Float64Array.from(risk, (x, i) => (_fin(x) ? x * 1e6 + (pop[i] || 0) : NaN))).slice(0, TOP).forEach((i, k) => stats.push({ label: `High risk ${k + 1}: ${g.codes[i]}`,
            value: `score ${_round(risk[i])}; ${_round(months[i], 1)} suitable months${wl && _fin(wl[i]) ? `, waterlogging ${_round(wl[i])}` : ''}; ${_people(pop[i])} residents` }));
        const q = wquantile(risk, pop, scored, 0.5);
        return {
            columns: { mosquito_risk: risk, mosquito_months: months }, idx: scored, weightKey: 'mosquito_risk', noHotspots: true,
            metric: { label: 'People in high mosquito-breeding-risk blocks', value: Math.round(pTop), unit: 'people', higherIs: 'worse' },
            headline: `The average resident lived through ${_round(meanMonths, 1)} months in the last year warm and wet enough for Aedes mosquitoes; ${_people(pTop)} people live in high-risk blocks where that season meets standing water and crowding (median score ${_round(q)}). This is a breeding-conditions index, not a count of dengue cases.`,
            stats,
        };
    }

    // Building age. GHSL built-up share every five years since 1975: each epoch's increase is the area built in
    // those five years. A block's median build year is when half of today's built area was standing.
    function buildingage(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, ser = c['builtup_yearly.built_pct@series'], pop = c['population.population'];
        const steps = ((fr.steps && fr.steps.builtup_yearly) || []).map(Number);
        if (!ser || steps.length < 3) return null;
        const num = x => (x == null ? NaN : Number(x));
        const idx = [], median = new Float64Array(n).fill(NaN), oldShare = new Float64Array(n).fill(NaN);
        const byEpoch = new Array(steps.length).fill(0);
        for (let i = 0; i < n; i++) {
            const a = ser[i];
            if (!a) continue;
            const last = num(a[steps.length - 1]);
            if (!Number.isFinite(last) || last < 5) continue;
            idx.push(i);
            let prev = 0, done = false;
            for (let t = 0; t < steps.length; t++) {
                const v = Math.max(prev, Number.isFinite(num(a[t])) ? num(a[t]) : prev);       // built area does not shrink in GHSL
                byEpoch[t] += (v - prev) / 100 * g.cellKm2;
                if (!done && v >= last / 2) { median[i] = steps[t]; done = true; }
                if (steps[t] === 1990) oldShare[i] = 100 * v / last;
                prev = v;
            }
        }
        if (idx.length < 5) return null;
        const total = byEpoch.reduce((a, b) => a + b, 0);
        const decade = {};
        steps.forEach((y, t) => { const d = y <= 1975 ? 'by 1975' : y <= 1990 ? '1976–1990' : y <= 2005 ? '1991–2005' : y <= 2015 ? '2006–2015' : `2016–${steps[steps.length - 1]}`; decade[d] = (decade[d] || 0) + byEpoch[t]; });
        const stats = Object.entries(decade).map(([k, v]) => ({ label: `Built ${k}`, value: `${_round(v, 1)} km² (${_round(100 * v / Math.max(total, 1e-9))}%)` }));
        const w = pop ? idx.filter(i => pop[i] > 0) : idx;
        const medYear = wquantile(median, pop || null, w.length ? w : idx, 0.5);
        const yr = Math.round(medYear) <= steps[0] ? `${steps[0]} or earlier` : `${Math.round(medYear)}`;
        stats.push({ label: 'Median build year of the home a resident lives in (by block)', value: yr, raw: Math.round(medYear) });
        const newest = Object.entries(decade).pop();
        return {
            columns: { median_build_year: median, built_by_1990_pct: oldShare }, idx, weightKey: 'median_build_year', noHotspots: true,
            metric: { label: 'Median build year (per resident)', value: Math.round(medYear), unit: 'year', higherIs: null },
            headline: `${_round(100 * (decade['by 1975'] || 0) / Math.max(total, 1e-9))}% of today's built-up area was standing by 1975 and ${_round(100 * newest[1] / Math.max(total, 1e-9))}% went up in ${newest[0]}; half the residents live in blocks mostly built by ${yr}. The 1975 epoch comes from coarse early Landsat imagery and is the least certain, and GHSL sees footprints from space, so rebuilding on the same plot does not count as new.`,
            stats,
        };
    }

    // Cooling centres. Heat action plans (Ahmedabad 2013 onwards, NDMA 2019 guidelines) open public buildings with
    // shade, water and fans or air-conditioning to people without a cool home. Candidate sites here are listed
    // libraries, malls and community centres; places of worship, which several plans also use, are reported apart.
    const COOL_KM = 1, COOL_KINDS = ['libraries', 'malls', 'community_centres'], HOT_Q = 0.75;

    function cooling(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], lst = c['surface_heat.lst_day_c'];
        if (!pop || !lst || COOL_KINDS.some(k => !c[`places.${k}`])) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const old = c['demographics.elderly_60plus'], worship = c['places.worship'];
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && _fin(lst[i])) idx.push(i);
        if (idx.length < 5) return null;
        const hotT = wquantile(lst, pop, idx, HOT_Q);
        const sites = within(g, Float64Array.from({ length: n }, (_, i) => COOL_KINDS.reduce((a, k) => a + v(c[`places.${k}`], i), 0)), COOL_KM);
        const shrines = worship ? within(g, Float64Array.from({ length: n }, (_, i) => v(worship, i)), COOL_KM) : null;
        const gap = new Float64Array(n).fill(NaN);
        const hot = idx.filter(i => lst[i] >= hotT), unserved = hot.filter(i => sites[i] <= 0);
        for (const i of idx) gap[i] = lst[i] >= hotT ? (sites[i] > 0 ? 1 : 2) : 0;
        const all = _sumOver(pop, idx, () => true), pHot = _sumOver(pop, hot, () => true), pGap = _sumOver(pop, unserved, () => true);
        const eGap = old ? _sumOver(old, unserved, () => true) : null;
        const viaShrine = shrines ? _sumOver(pop, unserved.filter(i => shrines[i] > 0), () => true) : null;
        const stats = [
            { label: `Hottest quarter of residents (day surface ≥ ${_round(hotT, 1)} °C)`, value: _people(pHot) },
            { label: `…with no library, mall or community centre within ${COOL_KM} km`, value: `${_people(pGap)} (${_round(100 * pGap / Math.max(pHot, 1))}% of them)` },
        ];
        if (eGap !== null) stats.push({ label: '…of whom aged 60 and over', value: _people(eGap) });
        if (viaShrine !== null) stats.push({ label: '…who do have a place of worship within 1 km (a possible stand-in)', value: _people(viaShrine) });
        stats.push({ label: 'Share of all residents in hot blocks without a candidate site', value: `${_round(100 * pGap / Math.max(all, 1), 1)}%` });
        const need = Float64Array.from({ length: n }, (_, i) => (old ? v(old, i) * 3 : 0) + v(pop, i));
        spaced(g, unserved, need).forEach((i, k) => stats.push({
            label: `Cooling centre site ${k + 1}: ${g.codes[i]}`,
            value: `${_round(lst[i], 1)} °C; ${_people(v(pop, i))} residents${old ? `, ${_people(v(old, i))} aged 60+` : ''}` }));
        return {
            columns: { cooling_gap: gap, cool_sites_1km: sites }, idx, weightKey: 'cooling_gap', noHotspots: true,
            metric: { label: `Residents in the hottest blocks with no candidate cooling centre within ${COOL_KM} km`, value: Math.round(pGap), unit: 'people', higherIs: 'worse' },
            headline: `${_people(pGap)} people in the hottest quarter of the city (${_round(100 * pGap / Math.max(pHot, 1))}% of that quarter) have no listed library, mall or community centre within ${COOL_KM} km to open as a cooling centre${eGap !== null ? `, ${_people(eGap)} of them aged 60 or over` : ''}. The five sites listed are the hottest unserved blocks with the most older residents, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Crowd zones. Festivals, fairs and weekend markets draw crowds to places of worship, malls, cultural sites and
    // leisure spots; the crush risk rises where those cluster in dense, crowded streets far from police and fire cover.
    const CROWD_KM = 0.5, CROWD_KINDS = ['worship', 'malls', 'culture', 'leisure'], POLICE_KM = 2, FIRE_KM = 3, CROWD_Q = 0.9;

    function crowds(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], dens = c['population.density_km2'];
        if (!pop || !dens || CROWD_KINDS.some(k => !c[`places.${k}`])) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const pull = within(g, Float64Array.from({ length: n }, (_, i) => CROWD_KINDS.reduce((a, k) => a + v(c[`places.${k}`], i), 0)), CROWD_KM);
        const shrines = within(g, Float64Array.from({ length: n }, (_, i) => v(c['places.worship'], i)), CROWD_KM);
        const police = c['places.police'] ? within(g, Float64Array.from({ length: n }, (_, i) => v(c['places.police'], i)), POLICE_KM) : null;
        const fire = c['places.fire_stations'] ? within(g, Float64Array.from({ length: n }, (_, i) => v(c['places.fire_stations'], i)), FIRE_KM) : null;
        const pq = wquantile(pull, null, idx, CROWD_Q), dq = wquantile(dens, null, idx, 0.5);
        if (!_fin(pq) || pq <= 0) return null;
        const score = new Float64Array(n).fill(NaN);
        for (const i of idx) score[i] = Math.round(100 * Math.min(1, pull[i] / (2 * pq)) * (v(dens, i) >= dq ? 1 : 0.6));
        const zones = idx.filter(i => pull[i] >= pq && v(dens, i) >= dq);
        const far = zones.filter(i => (police && police[i] <= 0) || (fire && fire[i] <= 0));
        const pz = _sumOver(pop, zones, () => true);
        const stats = [
            { label: `Gathering places within ${CROWD_KM} km at the city's top 10% of blocks`, value: `${_round(pq)} or more` },
            { label: 'Crowd zones (that many gathering places and denser than the city median)', value: `${zones.length} blocks, ${_people(pz)} residents` },
            { label: `…with no police station within ${POLICE_KM} km or fire station within ${FIRE_KM} km`, value: `${far.length} blocks` },
        ];
        spaced(g, zones, pull).forEach((i, k) => stats.push({
            label: `Crowd zone ${k + 1}: ${g.codes[i]}`,
            value: `${_round(pull[i])} gathering places within ${CROWD_KM} km (${_round(shrines[i])} of worship); ${_round(v(dens, i))} people per km²${far.includes(i) ? '; far from police or fire cover' : ''}` }));
        return {
            columns: { crowd_score: score, gathering_places: pull }, idx, weightKey: 'crowd_score', noHotspots: true,
            metric: { label: 'Dense blocks among the city\'s busiest gathering clusters', value: zones.length, unit: 'blocks', higherIs: null },
            headline: `${zones.length} dense blocks, home to ${_people(pz)} people, sit among the city's busiest clusters of temples, mosques, churches, gurdwaras, malls and leisure spots, where festival and weekend crowds build up; ${far.length} of them have no police station within ${POLICE_KM} km or fire station within ${FIRE_KM} km listed. Plan crowd routes, barricades and medical posts for these first.`,
            stats,
        };
    }

    // Airport access. Straight-line distance to the nearest jet runway, a road detour factor and typical peak and
    // off-peak car speeds give a rough door-to-terminal drive time.
    const DETOUR = 1.35, PEAK_KMH = 20, OFF_KMH = 35, AIR_NEAR_MIN = 45;

    function airport(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], rk = c['flight_paths.runway_km'];
        if (!pop || !rk) return null;
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(pop[i]) && pop[i] > 0 && _fin(rk[i])) idx.push(i);
        if (idx.length < 5) return null;
        const peak = new Float64Array(n).fill(NaN), off = new Float64Array(n).fill(NaN);
        for (const i of idx) { peak[i] = Math.round(60 * rk[i] * DETOUR / PEAK_KMH); off[i] = Math.round(60 * rk[i] * DETOUR / OFF_KMH); }
        const all = _sumOver(pop, idx, () => true), med = wquantile(peak, pop, idx, 0.5), medOff = wquantile(off, pop, idx, 0.5);
        const bands = [30, 45, 60, 90].map(m => [m, _sumOver(pop, idx, i => peak[i] <= m)]);
        const stats = bands.map(([m, p]) => ({ label: `Within ${m} min of the runway at peak`, value: `${_people(p)} (${_round(100 * p / Math.max(all, 1))}%)` }));
        stats.push({ label: 'Median resident, peak / off-peak', value: `${_round(med)} / ${_round(medOff)} min` });
        stats.push({ label: 'Living within 2 km of a runway (noise and height limits)', value: _people(_sumOver(pop, idx, i => rk[i] <= 2)) });
        const near = bands.find(b => b[0] === AIR_NEAR_MIN)[1];
        return {
            columns: { airport_peak_min: peak, airport_offpeak_min: off }, idx, weightKey: 'airport_peak_min', noHotspots: true,
            metric: { label: 'Median resident\'s peak-hour drive to the airport', value: Math.round(med), unit: 'min', higherIs: 'worse' },
            headline: `Half the city is within about ${_round(med)} minutes of a jet runway at peak hours (${_round(medOff)} off-peak); ${_round(100 * near / Math.max(all, 1))}% of residents can reach it in ${AIR_NEAR_MIN} minutes. These are rough drive times from straight-line distance, not routed, and the nearest runway can be an air force base.`,
            stats,
        };
    }

    // Gardens and rain gardens. Most vegetables and shade trees do best in near-neutral soil (pH 6 to 7.5) with
    // some organic matter; rain gardens need soil that drains, roughly a sandy or loamy texture under 35% clay.
    const PH_LO = 6, PH_HI = 7.5, PH_ALK = 8, SOC_POOR = 5, SOC_GOOD = 10, RAIN_SAND = 40, RAIN_CLAY = 35;

    function gardens(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, ph = c['topsoil.ph'], soc = c['topsoil.soc_g_kg'], sand = c['topsoil.sand_pct'], clay = c['topsoil.clay_pct'];
        const pop = c['population.population'];
        if (!ph || !soc || !sand || !clay) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const open = i => v(c['land_cover.grass_pct'], i) + v(c['land_cover.bare_pct'], i) + v(c['land_cover.shrub_pct'], i);
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(ph[i]) && _fin(soc[i])) idx.push(i);
        if (idx.length < 5) return null;
        const score = new Float64Array(n).fill(NaN), rain = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            const p = ph[i], phS = p >= PH_LO && p <= PH_HI ? 1 : p > PH_HI ? Math.max(0, 1 - (p - PH_HI) / 1.5) : Math.max(0, 1 - (PH_LO - p) / 1.5);
            const socS = Math.max(0, Math.min(1, (soc[i] - SOC_POOR / 2) / (SOC_GOOD - SOC_POOR / 2)));
            const drains = sand[i] >= RAIN_SAND && clay[i] < RAIN_CLAY;
            const texS = clay[i] >= 45 ? 0.3 : clay[i] >= RAIN_CLAY ? 0.6 : 1;
            score[i] = Math.round(100 * (0.45 * phS + 0.35 * socS + 0.2 * texS));
            rain[i] = drains ? 1 : 0;
        }
        const km2 = i => g.cellKm2 * open(i) / 100, sumKm = f => idx.reduce((a, i) => a + (f(i) ? km2(i) : 0), 0);
        const openAll = sumKm(() => true);
        const alk = sumKm(i => ph[i] > PH_ALK), poor = sumKm(i => soc[i] < SOC_POOR), drainKm = sumKm(i => rain[i] === 1), good = sumKm(i => score[i] >= 70);
        const share = x => `${_round(x, 1)} km² (${_round(100 * x / Math.max(openAll, 1e-9))}%)`;
        const stats = [
            { label: 'Open land (grass, bare and scrub)', value: `${_round(openAll, 1)} km²` },
            { label: 'Open land with garden-ready soil (score 70+)', value: share(good) },
            { label: `…alkaline, pH above ${PH_ALK} (needs gypsum or compost)`, value: share(alk) },
            { label: `…low in organic matter, under ${SOC_POOR} g/kg`, value: share(poor) },
            { label: `…draining well enough for rain gardens (sand ${RAIN_SAND}%+, clay under ${RAIN_CLAY}%)`, value: share(drainKm) },
        ];
        const lived = idx.filter(i => v(pop, i) > 0 && score[i] >= 70 && open(i) >= 10);
        spaced(g, lived, Float64Array.from({ length: n }, (_, i) => open(i) * v(pop, i))).forEach((i, k) => stats.push({
            label: `Community garden site ${k + 1}: ${g.codes[i]}`,
            value: `${_round(open(i))}% open land; pH ${_round(ph[i], 1)}, ${_round(soc[i], 1)} g/kg carbon${rain[i] ? ', drains for a rain garden' : ''}; ${_people(v(pop, i))} residents` }));
        const medPh = wquantile(ph, null, idx, 0.5);
        return {
            columns: { garden_score: score, rain_garden: rain }, idx, weightKey: 'garden_score', noHotspots: true,
            metric: { label: 'Open land with garden-ready soil', value: _round(good, 1), unit: 'km²', higherIs: 'better' },
            headline: `${_round(100 * good / Math.max(openAll, 1e-9))}% of the city's ${_round(openAll, 1)} km² of open land has soil ready for gardens; the typical topsoil is pH ${_round(medPh, 1)}, ${_round(100 * alk / Math.max(openAll, 1e-9))}% of open land is alkaline and ${_round(100 * drainKm / Math.max(openAll, 1e-9))}% drains well enough for a rain garden. Soil maps are 250 m predictions; a home or plot can be fill or rubble, so test before planting.`,
            stats,
        };
    }

    // Power line corridors. The right-of-way under a transmission line is cleared of trees and, under the CEA safety
    // regulations' clearances, of most building; homes inside it are encroachments with a fire and shock risk.
    function powerlines(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, cor = c['power_lines.corridor_pct'], km = c['power_lines.line_km'], kv = c['power_lines.max_kv'];
        const pop = c['population.population'], built = c['built_up.built_pct'];
        if (!cor || !km || !pop) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 || v(cor, i) > 0) idx.push(i);
        if (idx.length < 5 || !idx.some(i => v(cor, i) > 0)) return null;
        const inside = new Float64Array(n).fill(NaN), builtIn = new Float64Array(n).fill(NaN);
        for (const i of idx) { inside[i] = v(pop, i) * v(cor, i) / 100; builtIn[i] = v(built, i) * v(cor, i) / 100; }
        const sum = f => idx.reduce((a, i) => a + f(i), 0);
        const lineKm = sum(i => v(km, i)), corKm2 = sum(i => v(cor, i) / 100 * g.cellKm2), people = sum(i => inside[i]);
        const builtKm2 = built ? sum(i => builtIn[i] / 100 * g.cellKm2) : null;
        const ehv = sum(i => (v(kv, i) >= 400 ? inside[i] : 0));
        const stats = [
            { label: 'High-voltage line mapped (66 kV and over)', value: `${_round(lineKm)} km` },
            { label: 'Right-of-way corridors', value: `${_round(corKm2, 1)} km²` },
            { label: 'Residents inside a corridor (if spread evenly over each block)', value: _people(people) },
            { label: '…inside 400 kV and 765 kV corridors', value: _people(ehv) },
        ];
        if (builtKm2 !== null) stats.push({ label: 'Built-up land inside corridors', value: `${_round(builtKm2, 2)} km² (${_round(100 * builtKm2 / Math.max(corKm2, 1e-9))}% of corridor land)` });
        stats.push({ label: 'Substations mapped', value: String(sum(i => v(c['power_lines.substations'], i))) });
        spaced(g, idx.filter(i => inside[i] > 0), inside).forEach((i, k) => stats.push({
            label: `Homes under the wires ${k + 1}: ${g.codes[i]}`,
            value: `${_round(v(cor, i))}% of the block in a ${_round(v(kv, i))} kV corridor; about ${_people(inside[i])} residents inside${built ? `, ${_round(v(built, i))}% built-up` : ''}` }));
        return {
            columns: { corridor_people: inside, corridor_pct: Float64Array.from({ length: n }, (_, i) => (idx.includes(i) ? v(cor, i) : NaN)) },
            idx, weightKey: 'corridor_people', noHotspots: true,
            metric: { label: 'Residents living inside power line corridors', value: Math.round(people), unit: 'people', higherIs: 'worse' },
            headline: `Roughly ${_people(people)} people, counting each block's residents as spread evenly, live inside the right-of-way of ${_round(lineKm)} km of mapped high-voltage lines${builtKm2 !== null ? `, where ${_round(100 * builtKm2 / Math.max(corKm2, 1e-9))}% of the corridor land is built over` : ''}. Building there breaks the CEA clearances and risks fire and shock; check the corridor before buying near a tower line.`,
            stats,
        };
    }

    // Public toilets and drinking water on the street. Planning thresholds for this lens: a public toilet within
    // TOILET_BUSY_KM of busy shopping streets and within TOILET_HOME_KM of homes, and a drinking-water point within
    // WATER_KM. OpenStreetMap mapping of street objects is patchy, so gaps are leads to check, not proof.
    const TOILET_BUSY_KM = 0.5, TOILET_HOME_KM = 1, WATER_KM = 0.5, BUSY_Q = 0.9, TOILET_MIN = 100;

    function toilets(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, t = c['street_infra.toilets'], w = c['street_infra.drinking_water'];
        const pop = c['population.population'], shops = c['places.shopping'], food = c['places.food'];
        if (!t || !pop) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const tCount = Float64Array.from({ length: n }, (_, i) => v(t, i));
        const nearBusy = within(g, tCount, TOILET_BUSY_KM), nearHome = within(g, tCount, TOILET_HOME_KM);
        const water = w ? within(g, Float64Array.from({ length: n }, (_, i) => v(w, i)), WATER_KM) : null;
        const footfall = Float64Array.from({ length: n }, (_, i) => v(shops, i) + v(food, i));
        const fq = wquantile(footfall, null, idx, BUSY_Q);
        const busy = idx.filter(i => footfall[i] > 0 && footfall[i] >= fq);
        const busyGap = busy.filter(i => nearBusy[i] <= 0), homeGap = idx.filter(i => nearHome[i] <= 0);
        const gap = new Float64Array(n).fill(NaN);
        for (const i of idx) gap[i] = (nearHome[i] <= 0 ? 1 : 0) + (busyGap.includes(i) ? 1 : 0);
        const all = _sumOver(pop, idx, () => true), pHome = _sumOver(pop, homeGap, () => true);
        const total = idx.reduce((a, i) => a + tCount[i], 0);
        const stats = [
            { label: 'Public toilets mapped', value: String(total) },
            { label: `Residents with none mapped within ${TOILET_HOME_KM} km`, value: `${_people(pHome)} (${_round(100 * pHome / Math.max(all, 1))}%)` },
            { label: `Busiest shopping and food blocks (top 10%) with none within ${TOILET_BUSY_KM * 1000} m`, value: `${busyGap.length} of ${busy.length}` },
        ];
        if (water) {
            const pw = _sumOver(pop, idx, i => water[i] <= 0);
            stats.push({ label: `Residents with no drinking-water point mapped within ${WATER_KM * 1000} m`, value: `${_people(pw)} (${_round(100 * pw / Math.max(all, 1))}%)` });
        }
        spaced(g, busyGap, footfall).forEach((i, k) => stats.push({
            label: `Toilet needed ${k + 1}: ${g.codes[i]}`,
            value: `${_round(footfall[i])} shops and eateries in the block; nearest mapped public toilet over ${TOILET_BUSY_KM * 1000} m away` }));
        return {
            columns: { toilet_gap: gap, toilets_1km: nearHome }, idx, weightKey: 'toilet_gap', noHotspots: true,
            metric: { label: `Residents with no public toilet mapped within ${TOILET_HOME_KM} km`, value: Math.round(pHome), unit: 'people', higherIs: 'worse' },
            headline: total < TOILET_MIN ? `Only ${total} public toilets are mapped in OpenStreetMap here, too few to judge gaps: the map shows where mapping, not toilets, is missing. Use the Swachh Bharat toilet locator for the real network.` : `${total} public toilets are mapped; ${_round(100 * pHome / Math.max(all, 1))}% of residents have none mapped within ${TOILET_HOME_KM} km, and ${busyGap.length} of the ${busy.length} busiest shopping and food blocks have none within ${TOILET_BUSY_KM * 1000} m, which hits women, older people and street vendors hardest. OpenStreetMap misses many toilets, so check the Swachh Bharat toilet locator before acting.`,
            stats,
        };
    }

    // Gated colonies. Gates and lift barriers across streets (OpenStreetMap) mark colonies that close their roads,
    // which cuts through-routes for walking and emergency vehicles and goes with higher prices.
    const GATE_KM = 0.5, GATED_PER_KM2 = 20;

    function gated(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, gates = c['street_infra.gates'], pop = c['population.population'];
        const res = c['landuse.residential_pct'], vi = c['land_value.value_index'];
        if (!gates || !pop) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const area = Math.PI * GATE_KM * GATE_KM;
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(gates, i)), GATE_KM);
        const dens = new Float64Array(n).fill(NaN);
        for (const i of idx) dens[i] = _round(near[i] / area, 1);
        const gatedIdx = idx.filter(i => dens[i] >= GATED_PER_KM2);
        const all = _sumOver(pop, idx, () => true), pg = _sumOver(pop, gatedIdx, () => true);
        const total = idx.reduce((a, i) => a + v(gates, i), 0);
        const stats = [
            { label: 'Gates and lift barriers mapped', value: String(total) },
            { label: `Residents in gated areas (${GATED_PER_KM2}+ gates per km² within ${GATE_KM * 1000} m)`, value: `${_people(pg)} (${_round(100 * pg / Math.max(all, 1))}%)` },
        ];
        if (res) {
            const resIdx = idx.filter(i => v(res, i) >= 50);
            if (resIdx.length) stats.push({ label: 'Mapped residential blocks that are gated', value: `${_round(100 * resIdx.filter(i => dens[i] >= GATED_PER_KM2).length / resIdx.length)}%` });
        }
        if (vi) {
            const inV = gatedIdx.filter(i => _fin(vi[i])), outV = idx.filter(i => dens[i] < GATED_PER_KM2 && _fin(vi[i]));
            const med = a => wquantile(vi, null, a, 0.5);
            if (inV.length >= 5 && outV.length >= 5) stats.push({ label: 'Median value index, gated vs open blocks', value: `${_round(med(inV))} vs ${_round(med(outV))}` });
        }
        spaced(g, gatedIdx, dens).forEach((i, k) => stats.push({
            label: `Most gated ${k + 1}: ${g.codes[i]}`, value: `${dens[i]} gates per km² nearby; ${_people(v(pop, i))} residents` }));
        return {
            columns: { gate_density: dens }, idx, weightKey: 'gate_density', noHotspots: true,
            metric: { label: 'Residents in gated areas', value: Math.round(pg), unit: 'people', higherIs: null },
            headline: `${_round(100 * pg / Math.max(all, 1))}% of residents (${_people(pg)}) live where gates and barriers close off ${GATED_PER_KM2} or more street points per km². Gated colonies feel safer to residents but cut walking and ambulance routes for everyone else. Only mapped gates count, so read low numbers as unmapped.`,
            stats,
        };
    }

    // Drains and nallahs. The main storm-water network (OpenStreetMap drains and ditches) within DRAIN_KM; low ground that
    // floods after rain with no main drain nearby has nowhere to send the water. Living beside an open nallah brings smell,
    // mosquitoes and overflow; wastewater works bring smell too.
    const DRAIN_KM = 1, WET_INDEX = 50, WW_KM = 1, DRAIN_MIN = 50;

    function drainage(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, dk = c['drains.drain_km'], near = c['drains.drain_near_pct'], ww = c['drains.wastewater'];
        const pop = c['population.population'], wl = c['waterlogging.waterlogging_index'];
        if (!dk || !near || !pop) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) idx.push(i);
        if (idx.length < 5 || !idx.some(i => v(dk, i) > 0)) return null;
        const area = Math.PI * DRAIN_KM * DRAIN_KM;
        const dens = within(g, Float64Array.from({ length: n }, (_, i) => v(dk, i)), DRAIN_KM);
        const wwNear = ww ? within(g, Float64Array.from({ length: n }, (_, i) => v(ww, i)), WW_KM) : null;
        const density = new Float64Array(n).fill(NaN), beside = new Float64Array(n).fill(NaN);
        for (const i of idx) { density[i] = _round(dens[i] / area, 2); beside[i] = v(pop, i) * v(near, i) / 100; }
        const all = _sumOver(pop, idx, () => true);
        const wet = wl ? idx.filter(i => v(wl, i) >= WET_INDEX) : [];
        const dry = wet.filter(i => dens[i] <= 0);
        const pBeside = idx.reduce((a, i) => a + beside[i], 0), pDry = _sumOver(pop, dry, () => true);
        const km = idx.reduce((a, i) => a + v(dk, i), 0);
        const stats = [
            { label: 'Main drains and nallahs mapped', value: `${_round(km)} km` },
            { label: 'Residents within 100 m of an open drain (spread evenly over each block)', value: `${_people(pBeside)} (${_round(100 * pBeside / Math.max(all, 1), 1)}%)` },
        ];
        if (wl) stats.push({ label: `Waterlogging-prone blocks (index ${WET_INDEX}+) with no main drain mapped within ${DRAIN_KM} km`, value: `${dry.length} of ${wet.length}; ${_people(pDry)} residents` });
        if (wwNear) {
            const pw = _sumOver(pop, idx, i => wwNear[i] > 0);
            stats.push({ label: `Residents within ${WW_KM} km of a wastewater works or effluent pond`, value: _people(pw) });
        }
        spaced(g, dry, Float64Array.from({ length: n }, (_, i) => v(wl, i) * v(pop, i))).forEach((i, k) => stats.push({
            label: `Drain needed ${k + 1}: ${g.codes[i]}`, value: `waterlogging index ${_round(v(wl, i))}; ${_people(v(pop, i))} residents; no main drain mapped within ${DRAIN_KM} km` }));
        return {
            columns: { drain_density: density, beside_drain: beside }, idx, weightKey: 'drain_density', noHotspots: true,
            metric: { label: 'Residents living beside an open drain or nallah', value: Math.round(pBeside), unit: 'people', higherIs: 'worse' },
            headline: km < DRAIN_MIN ? `Only ${_round(km)} km of drains and nallahs are mapped in OpenStreetMap here, too little to judge drainage gaps; the map shows where mapping is missing.` : `${_round(km)} km of main drains and nallahs are mapped; about ${_people(pBeside)} people live within 100 m of one${wl ? `, and ${dry.length} of ${wet.length} waterlogging-prone blocks (${_people(pDry)} residents) have no main drain mapped within ${DRAIN_KM} km` : ''}. OpenStreetMap maps trunk drains, not roadside ones, so this is the main network only.`,
            stats,
        };
    }

    // Farms inside the city. Mapped farmland, orchards, allotments and nurseries (OpenStreetMap land use), and how much
    // of it sits in blocks building up fast, where it is likely to be the next layout.
    const FARM_FAST_PP = 5, FARM_KM = 1;

    function cityfarms(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, farm = c['landuse.farm_pct'], pop = c['population.population'];
        const b16 = c['growth.built_2016_pct'], b23 = c['growth.built_2023_pct'];
        if (!farm) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(farm[i]) || v(pop, i) > 0) idx.push(i);
        if (idx.length < 5 || !idx.some(i => v(farm, i) > 0)) return null;
        const km2 = i => v(farm, i) / 100 * g.cellKm2;
        const gain = i => v(b23, i) - v(b16, i);
        const fast = new Float64Array(n).fill(NaN);
        for (const i of idx) fast[i] = v(farm, i) > 0 ? (b16 && b23 && gain(i) >= FARM_FAST_PP ? 2 : 1) : 0;
        const total = idx.reduce((a, i) => a + km2(i), 0), atRisk = idx.reduce((a, i) => a + (fast[i] === 2 ? km2(i) : 0), 0);
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(farm, i)), FARM_KM);
        const all = _sumOver(pop, idx, () => true), pNear = _sumOver(pop, idx, i => near[i] > 0);
        const stats = [
            { label: 'Mapped farmland, orchards, allotments and nurseries', value: `${_round(total, 1)} km²` },
            { label: `…in blocks whose built-up share rose ${FARM_FAST_PP}+ points from 2016 to 2023`, value: `${_round(atRisk, 1)} km² (${_round(100 * atRisk / Math.max(total, 1e-9))}%)` },
            { label: `Residents with farmland mapped within ${FARM_KM} km`, value: `${_people(pNear)} (${_round(100 * pNear / Math.max(all, 1))}%)` },
        ];
        spaced(g, idx.filter(i => fast[i] === 2), Float64Array.from({ length: n }, (_, i) => km2(i) * gain(i))).forEach((i, k) => stats.push({
            label: `Farm under pressure ${k + 1}: ${g.codes[i]}`, value: `${_round(v(farm, i))}% farmland; built-up ${_round(v(b16, i))}% → ${_round(v(b23, i))}%` }));
        return {
            columns: { farm_pressure: fast, farm_pct: Float64Array.from({ length: n }, (_, i) => (idx.includes(i) ? v(farm, i) : NaN)) },
            idx, weightKey: 'farm_pct', noHotspots: true,
            metric: { label: 'Mapped farmland in fast-building blocks', value: _round(atRisk, 1), unit: 'km²', higherIs: 'worse' },
            headline: `${_round(total, 1)} km² of farmland, orchards and nurseries are mapped inside the city's box; ${_round(100 * atRisk / Math.max(total, 1e-9))}% of it lies in blocks that built up ${FARM_FAST_PP}+ points between 2016 and 2023, the likeliest next layouts. Mapping of peri-urban fields is patchy, and the farmloss lens tracks satellite-seen loss.`,
            stats,
        };
    }

    // Visitor magnets. Landmark pull is the sum of Wikipedia language editions for visitor landmarks within PULL_KM;
    // a hotel gap is a high-pull area with few places to stay within STAY_KM, a lead for hotels, homestays and serviced flats.
    const PULL_KM = 1.5, STAY_KM = 1, PULL_Q = 0.9;

    function tourism(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pull = c['landmarks.pull'], lm = c['landmarks.landmarks'];
        const lodging = c['places.lodging'], food = c['places.food'], pop = c['population.population'];
        if (!pull || !lm) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 || v(lm, i) > 0) idx.push(i);
        if (idx.length < 5 || !idx.some(i => v(lm, i) > 0)) return null;
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(pull, i)), PULL_KM);
        const stays = lodging ? within(g, Float64Array.from({ length: n }, (_, i) => v(lodging, i)), STAY_KM) : null;
        const eats = food ? within(g, Float64Array.from({ length: n }, (_, i) => v(food, i)), STAY_KM) : null;
        const pq = wquantile(near, null, idx.filter(i => near[i] > 0), PULL_Q);
        const col = new Float64Array(n).fill(NaN);
        for (const i of idx) col[i] = near[i];
        const magnets = idx.filter(i => near[i] > 0 && near[i] >= pq);
        const sq = stays ? wquantile(stays, null, magnets, 0.25) : null;
        const gaps = stays ? magnets.filter(i => stays[i] <= Math.max(sq, 2)) : [];
        const total = idx.reduce((a, i) => a + v(lm, i), 0);
        const stats = [
            { label: 'Visitor landmarks known in 3+ Wikipedia languages', value: String(total) },
            { label: `Landmark-pull blocks (top 10%, ${_round(pq)}+ language editions within ${PULL_KM} km)`, value: `${magnets.length} blocks` },
        ];
        if (stays) stats.push({ label: `…with ${_round(Math.max(sq, 2))} or fewer places to stay within ${STAY_KM} km (hotel gap)`, value: `${gaps.length} blocks` });
        spaced(g, magnets, near).forEach((i, k) => stats.push({
            label: `Visitor magnet ${k + 1}: ${g.codes[i]}`,
            value: `${_round(near[i])} language editions of landmarks within ${PULL_KM} km${stays ? `; ${_round(stays[i])} places to stay` : ''}${eats ? ` and ${_round(eats[i])} eateries within ${STAY_KM} km` : ''}` }));
        spaced(g, gaps, near, 3).forEach((i, k) => stats.push({
            label: `Hotel gap ${k + 1}: ${g.codes[i]}`, value: `${_round(near[i])} editions of landmarks nearby but only ${_round(stays[i])} places to stay within ${STAY_KM} km` }));
        return {
            columns: { landmark_pull: col }, idx, weightKey: 'landmark_pull', noHotspots: true,
            metric: { label: 'Visitor landmarks known in 3+ Wikipedia languages', value: total, unit: 'landmarks', higherIs: null },
            headline: `${total} visitor landmarks are well known enough to have articles in three or more Wikipedia languages; the top 10% of blocks by landmark pull are the city's visitor magnets${stays ? `, and ${gaps.length} of those ${magnets.length} blocks have few places to stay within ${STAY_KM} km` : ''}. Language editions measure fame, not footfall.`,
            stats,
        };
    }

    // The coast. In blocks near the sea (any 2080 coastal flood exposure within COAST_KM), compare JRC water in 1990 and
    // 2020: land made from water (reclamation, port and road works) and land lost to water (erosion, new channels). The
    // Coastal Regulation Zone covers land within 500 m of the high-tide line; blocks within CRZ_KM of open sea stand in for it.
    const COAST_KM = 2, CRZ_KM = 0.5, SEA_PCT = 80;

    function coast(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, w90 = c['water_history.water_1990_pct'], w20 = c['water_history.water_2020_pct'];
        const cst = c['flood_future.coast_pct_2080_high'], pop = c['population.population'], built = c['built_up.built_pct'];
        if (!w90 || !w20 || !cst) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const zone = within(g, Float64Array.from({ length: n }, (_, i) => (v(cst, i) > 0 ? 1 : 0)), COAST_KM);
        const idx = [];
        for (let i = 0; i < n; i++) if (zone[i] > 0 && _fin(w90[i]) && _fin(w20[i])) idx.push(i);
        if (idx.length < 5) return null;
        const sea = within(g, Float64Array.from({ length: n }, (_, i) => (zone[i] > 0 && v(w20, i) >= SEA_PCT ? 1 : 0)), CRZ_KM);
        const change = new Float64Array(n).fill(NaN);
        for (const i of idx) change[i] = _round(w90[i] - w20[i], 1);
        const km2 = (f) => idx.reduce((a, i) => a + Math.max(0, f(i)) / 100 * g.cellKm2, 0);
        const made = km2(i => w90[i] - w20[i]), lost = km2(i => w20[i] - w90[i]);
        const crz = idx.filter(i => sea[i] > 0 && v(w20, i) < SEA_PCT);
        const pCrz = _sumOver(pop, crz, () => true), bCrz = built ? crz.reduce((a, i) => a + v(built, i) / 100 * g.cellKm2, 0) : null;
        const stats = [
            { label: `Land made from water since 1990 (blocks within ${COAST_KM} km of coastal flooding)`, value: `${_round(made, 2)} km²` },
            { label: 'Land lost to water since 1990', value: `${_round(lost, 2)} km²` },
            { label: `Residents within ${CRZ_KM * 1000} m of open sea, creek or tidal river (Coastal Regulation Zone band)`, value: _people(pCrz) },
        ];
        if (bCrz !== null) stats.push({ label: '…built-up land in that band', value: `${_round(bCrz, 2)} km²` });
        spaced(g, idx.filter(i => change[i] >= 10), change, 3).forEach((i, k) => stats.push({
            label: `Made land ${k + 1}: ${g.codes[i]}`, value: `water ${_round(w90[i])}% of the block in 1990, ${_round(w20[i])}% in 2020` }));
        spaced(g, idx.filter(i => change[i] <= -10), Float64Array.from({ length: n }, (_, i) => -change[i]), 3).forEach((i, k) => stats.push({
            label: `Land lost ${k + 1}: ${g.codes[i]}`, value: `water ${_round(w90[i])}% in 1990, ${_round(w20[i])}% in 2020` }));
        return {
            columns: { coast_change: change }, idx, weightKey: 'coast_change', noHotspots: true,
            metric: { label: 'Land made from water near the coast since 1990', value: _round(made, 2), unit: 'km²', higherIs: null },
            headline: `Near the coast, ${_round(made, 2)} km² of water became land between 1990 and 2020 and ${_round(lost, 2)} km² of land became water; about ${_people(pCrz)} people live within ${CRZ_KM * 1000} m of open sea, creek or tidal river, the band the Coastal Regulation Zone rules restrict. Salt pans, mudflats and mangrove edges flip between land and water in satellite maps, and the CRZ line is drawn from the notified high-tide line, not this proxy.`,
            stats,
        };
    }

    // Packed blocks. Building bye-laws cap ground coverage (roughly 60–75% of a plot for small residential plots) and
    // require setbacks; a whole block with half or more of its land under roofs, streets included, has almost no gaps
    // between buildings. Tall and packed means poor daylight and air, and hard fire-tender access.
    const PACKED_PCT = 50, TALL_M = 10;

    function packed(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, cov = c['building_stock.cover_2023_pct'], h = c['building_stock.height_2023_m'];
        const pop = c['population.population'], fire = c['places.fire_stations'];
        if (!cov) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(cov[i]) && v(pop, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const fireNear = fire ? within(g, Float64Array.from({ length: n }, (_, i) => v(fire, i)), 3) : null;
        const col = new Float64Array(n).fill(NaN);
        for (const i of idx) col[i] = cov[i];
        const pk = idx.filter(i => cov[i] >= PACKED_PCT), tall = pk.filter(i => v(h, i) >= TALL_M);
        const all = _sumOver(pop, idx, () => true), pPk = _sumOver(pop, pk, () => true), pTall = _sumOver(pop, tall, () => true);
        const stats = [
            { label: `Residents in packed blocks (${PACKED_PCT}%+ of all land under roofs)`, value: `${_people(pPk)} (${_round(100 * pPk / Math.max(all, 1), 1)}%)` },
            { label: `…where buildings average ${TALL_M} m (about three storeys) or more`, value: `${_people(pTall)} in ${tall.length} blocks` },
        ];
        if (fireNear) stats.push({ label: '…packed blocks with no fire station listed within 3 km', value: `${pk.filter(i => fireNear[i] <= 0).length} of ${pk.length}` });
        spaced(g, pk, Float64Array.from({ length: n }, (_, i) => v(cov, i) * v(pop, i))).forEach((i, k) => stats.push({
            label: `Most packed ${k + 1}: ${g.codes[i]}`, value: `${_round(cov[i])}% roof cover, ${_round(v(h, i), 1)} m mean height; ${_people(v(pop, i))} residents` }));
        return {
            columns: { roof_cover_pct: col }, idx, weightKey: 'roof_cover_pct', noHotspots: true,
            metric: { label: 'Residents in packed blocks', value: Math.round(pPk), unit: 'people', higherIs: 'worse' },
            headline: `${_people(pPk)} people (${_round(100 * pPk / Math.max(all, 1), 1)}%) live in blocks where roofs cover ${PACKED_PCT}% or more of all the land, streets included, leaving almost no setbacks or open space; ${_people(pTall)} of them in blocks averaging three storeys or more, where daylight, air and fire-tender access suffer. Typical of urban villages, old cores and unauthorised colonies.`,
            stats,
        };
    }

    // Tech hubs. Software, IT, biotech and science firms (Overture places) within TECH_KM; hubs are the densest TECH_Q
    // of blocks. Hub reach: residents living within HUB_KM of a hub, a rough commute shed.
    const TECH_KM = 1, TECH_Q = 0.95, HUB_KM = 5, METRO_OK_MIN = 15;

    function techhubs(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, tech = c['places.tech'], pop = c['population.population'];
        const cow = c['places.coworking'], metro = c['rail_access.metro_walk_min'], vi = c['land_value.value_index'];
        if (!tech) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 || v(tech, i) > 0) idx.push(i);
        const total = idx.reduce((a, i) => a + v(tech, i), 0);
        if (idx.length < 5 || total < 20) return null;
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(tech, i)), TECH_KM);
        const tq = wquantile(near, null, idx.filter(i => near[i] > 0), TECH_Q);
        const hubs = idx.filter(i => near[i] >= Math.max(tq, 5));
        const hubMask = Float64Array.from({ length: n }, () => 0);
        for (const i of hubs) hubMask[i] = 1;
        const shed = within(g, hubMask, HUB_KM);
        const col = new Float64Array(n).fill(NaN);
        for (const i of idx) col[i] = near[i];
        const all = _sumOver(pop, idx, () => true), pShed = _sumOver(pop, idx, i => shed[i] > 0);
        const inHubs = hubs.reduce((a, i) => a + v(tech, i), 0);
        const stats = [
            { label: 'Software, IT, biotech and science firms listed', value: String(total) },
            { label: `Hub blocks (densest 5%, ${_round(Math.max(tq, 5))}+ firms within ${TECH_KM} km)`, value: `${hubs.length} blocks with ${_round(100 * inHubs / Math.max(total, 1))}% of firms` },
            { label: `Residents within ${HUB_KM} km of a hub`, value: `${_people(pShed)} (${_round(100 * pShed / Math.max(all, 1))}%)` },
        ];
        if (metro) {
            const ok = hubs.filter(i => _fin(metro[i]) && metro[i] <= METRO_OK_MIN).length;
            stats.push({ label: `Hub blocks within a ${METRO_OK_MIN}-minute walk of a metro station`, value: `${ok} of ${hubs.length}` });
        }
        if (vi) {
            const med = a => wquantile(vi, null, a.filter(i => _fin(vi[i])), 0.5);
            const hv = med(hubs), cv = med(idx);
            if (_fin(hv) && _fin(cv)) stats.push({ label: 'Median land value index, hubs vs city', value: `${_round(hv)} vs ${_round(cv)}` });
        }
        spaced(g, hubs, near, TOP).forEach((i, k) => stats.push({
            label: `Tech hub ${k + 1}: ${g.codes[i]}`,
            value: `${_round(near[i])} firms within ${TECH_KM} km${cow ? `, ${_round(v(cow, i))} co-working spaces in the block` : ''}${metro && _fin(metro[i]) ? `; metro ${_round(metro[i])} min walk` : ''}` }));
        return {
            columns: { tech_firms_1km: col }, idx, weightKey: 'tech_firms_1km', noHotspots: true,
            metric: { label: 'Software, IT, biotech and science firms listed', value: total, unit: 'firms', higherIs: null },
            headline: `${total} software, IT, biotech and science firms are listed; ${_round(100 * inHubs / Math.max(total, 1))}% sit in ${hubs.length} hub blocks, and ${_round(100 * pShed / Math.max(all, 1))}% of residents live within ${HUB_KM} km of one. Overture lists firms by office, not headcount, so a campus of 20,000 counts once.`,
            stats,
        };
    }

    // Shaded walk to care. The nearest clinic, hospital or pharmacy is found on the walking network, the route is
    // traced back cell by cell, and each step is scored for tree shade and summer surface heat.
    const CARE_KM = 2, SHADE_MIN = 10, SHADE_HOT_Q = 0.5, EXPOSED_PCT = 50;

    /** Network route from the reach search r (js, ds in settled order) back from cell t to its origin: [[cell, metres]]. */
    function traceBack(g, r, t) {
        const d = new Map();
        for (let q = 0; q < r.len; q++) d.set(r.js[q], r.ds[q]);
        const out = [];
        let j = t;
        for (let guard = 0; guard < 400 && d.get(j) > 1e-9; guard++) {
            let prev = -1, step = 0;
            for (const [a, b] of DIRS) {
                const k = g.cellAt(j, a, b), dk = d.get(k);
                if (k < 0 || dk == null) continue;
                const s = Math.hypot(a * g.dy, b * g.dx);
                if (Math.abs(dk + s - d.get(j)) < 1e-6) { prev = k; step = s; break; }
            }
            if (prev < 0) break;
            out.push([j, 1000 * step]);
            j = prev;
        }
        return out;
    }

    function shadecare(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const tree = c['vegetation.tree_canopy_pct'], lst = c['surface_heat.lst_day_c'];
        const care = c['places.health'], osm = c['osm_amenities.healthcare'];
        if (!pop || !tree || !lst || (!care && !osm)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && _fin(lst[i])) idx.push(i);
        if (idx.length < 5) return null;
        const hotT = wquantile(lst, pop, idx, SHADE_HOT_Q);
        const isCare = j => v(care, j) + v(osm, j) > 0;
        const bare = j => v(tree, j) < SHADE_MIN && _fin(lst[j]) && lst[j] >= hotT;
        const net = _net(fr);
        const exposed = new Float64Array(n).fill(NaN), walk = new Float64Array(n).fill(NaN), through = new Float64Array(n);
        let pOwn = 0, pNone = 0, pRoute = 0, pExposed = 0, mRoute = 0, mBare = 0, pOff = 0;
        for (const i of idx) {
            const r = net.reach(i, CARE_KM, isCare);
            if (!r.len || !r.hit) { pNone += pop[i]; continue; }
            const t = r.js[r.len - 1];
            if (t === i) { pOwn += pop[i]; exposed[i] = 0; walk[i] = 0; continue; }
            if (!r.net) { pOff += pop[i]; continue; }
            const route = traceBack(g, r, t);
            let len = 0, hot = 0;
            for (const [j, m] of route) {
                len += m;
                if (bare(j)) { hot += m; through[j] += pop[i]; }
            }
            if (!(len > 0)) continue;
            walk[i] = Math.round(len);
            exposed[i] = Math.round(100 * hot / len);
            pRoute += pop[i]; mRoute += pop[i] * len; mBare += pop[i] * hot;
            if (exposed[i] >= EXPOSED_PCT) pExposed += pop[i];
        }
        if (!(pRoute > 0)) return null;
        const all = _sumOver(pop, idx, () => true), avg = Math.round(mRoute / pRoute / 10) * 10;
        const plant = [];
        for (let j = 0; j < n; j++) if (through[j] > 0) plant.push(j);
        const stats = [
            { label: `Hot (day surface ≥ ${_round(hotT, 1)} °C, the city's residents' median) and bare (tree canopy under ${SHADE_MIN}%)`, value: 'counts as exposed' },
            { label: 'Residents with a clinic, hospital or pharmacy in their own block', value: _people(pOwn) },
            { label: `Residents walking to one within ${CARE_KM} km on the network`, value: _people(pRoute) },
            { label: `…whose walk is at least ${EXPOSED_PCT}% hot and bare`, value: `${_people(pExposed)} (${_round(100 * pExposed / pRoute)}%)` },
            { label: 'Average walk, and its hot and bare share', value: `${avg} m, ${_round(100 * mBare / Math.max(mRoute, 1))}%` },
            { label: `No listed care within ${CARE_KM} km`, value: _people(pNone) },
        ];
        spaced(g, plant, through).forEach((j, k) => stats.push({
            label: `Shade trees first ${k + 1}: ${g.codes[j]}`,
            value: `on the walk to care for ${_people(through[j])} residents; ${_round(lst[j], 1)} °C, ${_round(v(tree, j))}% canopy` }));
        stats.push({ label: 'Care in reach but block not on the walking network (not traced)', value: _people(pOff) });
        return {
            columns: { care_walk_exposed_pct: exposed, care_walk_m: walk }, idx,
            metric: { label: `Residents whose walk to the nearest clinic or pharmacy is mostly hot and bare`, value: _round(100 * pExposed / Math.max(all, 1), 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(pExposed)} people (${_round(100 * pExposed / Math.max(all, 1), 1)}% of residents) walk to their nearest clinic, hospital or pharmacy along a route that is at least ${EXPOSED_PCT}% hot and treeless; the average walk is ${avg} m, ${_round(100 * mBare / Math.max(mRoute, 1))}% of it exposed. The blocks listed are where shade trees would cover the most walks to care, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Cyclone winds. IMD's scale for the sustained wind: cyclonic storm 62-88 km/h, severe 89-117, very severe
    // 118-165, extremely severe 166-221, super cyclone 222+.
    const IMD_SCALE = [[222, 'super cyclone'], [166, 'extremely severe cyclonic storm'], [118, 'very severe cyclonic storm'], [89, 'severe cyclonic storm'], [62, 'cyclonic storm']];
    const imdClass = kmh => (IMD_SCALE.find(([t]) => kmh >= t) || [0, 'below cyclonic-storm'])[1];
    const TOWER_M = 30;

    function cyclone(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const rl = c['cyclones.wind_rl50_kmh'], mx = c['cyclones.wind_max_kmh'], gale = c['cyclones.gale_years'], near = c['cyclones.storms_200km'];
        if (!pop || !rl || !mx) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && _fin(rl[i])) idx.push(i);
        if (idx.length < 5) return null;
        const all = _sumOver(pop, idx, () => true);
        const med = wquantile(rl, pop, idx, 0.5);
        let top = idx[0];
        for (const i of idx) if (mx[i] > mx[top]) top = i;
        const galeMax = Math.max(...idx.map(i => v(gale, i))), nearMax = Math.max(...idx.map(i => v(near, i)));
        const stats = [
            { label: 'Typical 50-year sustained wind (residents\' median)', value: `${Math.round(med)} km/h, ${imdClass(med)} strength` },
            { label: 'Strongest modelled wind 1981-2024', value: `${Math.round(mx[top])} km/h at ${g.codes[top]} (${imdClass(mx[top])} strength)` },
            { label: 'Seasons with gale-force wind (62 km/h+), most exposed block', value: `${galeMax} of 44` },
            { label: 'Cyclonic storms whose centre passed within 200 km', value: String(nearMax) },
        ];
        // From the strongest class reached down to the first that covers everyone.
        for (const [t, name] of IMD_SCALE) {
            const p = _sumOver(pop, idx, i => rl[i] >= t);
            if (p > 0) stats.push({ label: `Residents whose 50-year wind reaches ${name} strength (${t} km/h+)`, value: `${_people(p)} (${_round(100 * p / all)}%)` });
            if (p >= all) break;
        }
        const ht = c['building_stock.height_2023_m'];
        const towers = ht ? _sumOver(pop, idx, i => v(ht, i) >= TOWER_M && rl[i] >= 89) : 0;
        if (towers > 0) {
            stats.push({ label: `Residents in blocks of ${TOWER_M} m+ buildings facing severe-storm winds (glass and cladding risk)`, value: _people(towers) });
        }
        const headline = galeMax === 0
            ? `No cyclone brought gale-force wind (62 km/h) here in 44 seasons; the 50-year wind is about ${Math.round(med)} km/h from weakening depressions, so cyclone wind is not a design driver.`
            : `The 50-year cyclone wind across the city is about ${Math.round(med)} km/h sustained (${imdClass(med)} strength). Gale-force wind reached the most exposed blocks in ${galeMax} of 44 seasons, and ${nearMax} cyclonic storms passed within 200 km; the strongest modelled wind was ${Math.round(mx[top])} km/h.`;
        return {
            columns: { wind_rl50_kmh: Float64Array.from(rl) }, idx,
            metric: { label: '50-year cyclone wind (sustained, residents\' median)', value: Math.round(med), unit: 'km/h', higherIs: 'worse' },
            headline, stats,
        };
    }

    // Delivery riders. Food-delivery and quick-commerce riders wait in clusters near restaurants and grocers between
    // orders, often for hours in the sun with nowhere to sit, drink or use a toilet. Rider hubs are the blocks with
    // the most eateries and grocers within RIDER_KM; rest stops go where hubs are hot and lack toilets and water.
    const RIDER_KM = 1, RIDER_Q = 0.95, RIDER_MIN = 30, REST_KM = 0.5;

    function riders(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const food = c['places.food'], groc = c['places.grocers'], lst = c['surface_heat.lst_day_c'], tree = c['vegetation.tree_canopy_pct'];
        const t = c['street_infra.toilets'], w = c['street_infra.drinking_water'];
        if (!food || !groc || !pop) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 || v(food, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const orders = within(g, Float64Array.from({ length: n }, (_, i) => v(food, i) + v(groc, i)), RIDER_KM);
        const q = Math.max(RIDER_MIN, wquantile(orders, null, idx, RIDER_Q));
        const hubs = idx.filter(i => orders[i] >= q);
        if (!hubs.length) return null;
        const toil = t ? within(g, Float64Array.from({ length: n }, (_, i) => v(t, i)), REST_KM) : null;
        const water = w ? within(g, Float64Array.from({ length: n }, (_, i) => v(w, i)), REST_KM) : null;
        const hotT = lst ? wquantile(lst, pop, idx.filter(i => _fin(lst[i])), 0.5) : null;
        const lacks = i => (toil && toil[i] <= 0) || (water && water[i] <= 0);
        const hot = i => hotT !== null && _fin(lst[i]) && lst[i] >= hotT && v(tree, i) < 10;
        const need = Float64Array.from({ length: n }, (_, i) => orders[i] * (lacks(i) ? 1 : 0) * (hot(i) ? 1.5 : 1));
        const gaps = hubs.filter(i => lacks(i));
        const share = a => (a.length ? `${a.length} of ${hubs.length} (${_round(100 * a.length / hubs.length)}%)` : `0 of ${hubs.length}`);
        const allPlaces = idx.reduce((a, i) => a + v(food, i) + v(groc, i), 0);
        const inHubs = hubs.reduce((a, i) => a + v(food, i) + v(groc, i), 0);
        const stats = [
            { label: `Rider hubs: blocks with ${_round(q)}+ eateries and grocers within ${RIDER_KM} km (city's top 5%)`, value: `${hubs.length} blocks` },
            { label: 'Share of all eateries and grocers inside hub blocks', value: `${_round(100 * inHubs / Math.max(allPlaces, 1))}%` },
        ];
        if (toil) stats.push({ label: `Hubs with no public toilet mapped within ${REST_KM * 1000} m`, value: share(hubs.filter(i => toil[i] <= 0)) });
        if (water) stats.push({ label: `Hubs with no drinking-water point mapped within ${REST_KM * 1000} m`, value: share(hubs.filter(i => water[i] <= 0)) });
        if (hotT !== null) stats.push({ label: `Hubs that are hot (day surface ≥ ${_round(hotT, 1)} °C) and nearly treeless`, value: share(hubs.filter(hot)) });
        spaced(g, gaps, need).forEach((i, k) => stats.push({
            label: `Rider rest stop ${k + 1}: ${g.codes[i]}`,
            value: `${_round(orders[i])} eateries and grocers within ${RIDER_KM} km${_fin(lst?.[i]) ? `; ${_round(lst[i], 1)} °C` : ''}${toil && toil[i] <= 0 ? '; no toilet' : ''}${water && water[i] <= 0 ? '; no water point' : ''}` }));
        const hub = new Float64Array(n).fill(NaN);
        for (const i of idx) hub[i] = orders[i];
        return {
            columns: { delivery_places_1km: hub }, idx,
            metric: { label: 'Rider hubs with no toilet or water point mapped within 500 m', value: _round(100 * gaps.length / hubs.length), unit: '%', higherIs: 'worse' },
            headline: `${hubs.length} blocks are delivery-rider hubs, with ${_round(q)} or more eateries and grocers within ${RIDER_KM} km. ${_round(100 * gaps.length / hubs.length)}% of them have no public toilet or drinking-water point mapped within ${REST_KM * 1000} m. The rest stops listed are the busiest such hubs, with hot, treeless ones weighted up, at least ${SPACING_KM} km apart. OpenStreetMap misses many toilets and taps, so treat gaps as places to check.`,
            stats,
        };
    }

    // Summer shade. Many Indian street and park trees (teak, gulmohar, silk cotton, some figs) drop their leaves in
    // the hot dry months, exactly when shade matters; evergreen and late-shedding trees keep it.
    const SUMMER_CANOPY_MIN = 10, SUMMER_LEAFY_LOW = 40;

    function summershade(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const leafy = c['tree_season.summer_leafy_pct'], sd = c['tree_season.tree_phen_sd'], tree = c['vegetation.tree_canopy_pct'], lst = c['surface_heat.lst_day_c'];
        if (!leafy || !tree) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(leafy[i]) && v(tree, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        let can = 0, green = 0;
        for (const i of idx) { can += tree[i]; green += tree[i] * leafy[i] / 100; }
        const lived = idx.filter(i => v(pop, i) > 0);
        const hotT = lst ? wquantile(lst, pop, lived.filter(i => _fin(lst[i])), 0.75) : null;
        const shady = lived.filter(i => tree[i] >= SUMMER_CANOPY_MIN);
        const bareSummer = shady.filter(i => leafy[i] < SUMMER_LEAFY_LOW);
        const hotBare = hotT !== null ? bareSummer.filter(i => _fin(lst[i]) && lst[i] >= hotT) : [];
        const pShady = _sumOver(pop, shady, () => true), pBare = _sumOver(pop, bareSummer, () => true), pHot = _sumOver(pop, hotBare, () => true);
        const sdMed = sd ? wquantile(sd, tree, idx.filter(i => _fin(sd[i])), 0.5) : null;
        const stats = [
            { label: 'Tree canopy still in leaf in March-May (canopy-weighted)', value: `${_round(100 * green / Math.max(can, 1e-9))}%` },
            { label: `Residents in blocks with ${SUMMER_CANOPY_MIN}%+ tree canopy`, value: _people(pShady) },
            { label: `…where under ${SUMMER_LEAFY_LOW}% of that canopy is in leaf in summer`, value: `${_people(pBare)} (${_round(100 * pBare / Math.max(pShady, 1))}%)` },
        ];
        if (hotT !== null) stats.push({ label: `…and in the hottest quarter (day surface ≥ ${_round(hotT, 1)} °C)`, value: _people(pHot) });
        if (sdMed !== null) stats.push({ label: 'Typical spread of tree greening within a block (variety proxy, NDVI)', value: String(_round(sdMed, 3)) });
        const score = Float64Array.from({ length: n }, (_, i) => v(pop, i) * (hotT !== null && lst[i] >= hotT ? 2 : 1) * (100 - v(leafy, i)) / 100);
        spaced(g, hotT !== null ? hotBare : bareSummer, score).forEach((i, k) => stats.push({
            label: `Add evergreen shade ${k + 1}: ${g.codes[i]}`,
            value: `${_round(tree[i])}% canopy, ${_round(leafy[i])}% of it in leaf in summer${lst && _fin(lst[i]) ? `; ${_round(lst[i], 1)} °C` : ''}; ${_people(v(pop, i))} residents` }));
        return {
            columns: { summer_leafy_pct: Float64Array.from(leafy) }, idx,
            metric: { label: 'Tree canopy in leaf in March-May', value: _round(100 * green / Math.max(can, 1e-9)), unit: '%', higherIs: 'better' },
            headline: `${_round(100 * green / Math.max(can, 1e-9))}% of the city's tree canopy is still in leaf in March-May. ${_people(pBare)} people live in leafy blocks where under ${SUMMER_LEAFY_LOW}% of the canopy keeps its leaves through the hot months${hotT !== null ? `, ${_people(pHot)} of them in the hottest quarter` : ''}: the shade is gone when it is needed most. The blocks listed are where evergreen or late-shedding trees would add the most summer shade, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Building use. Overture land use (OpenStreetMap landuse polygons) labels only the blocks someone has mapped. A
    // Gaussian naive Bayes classifier learns each use from those blocks, in a space of satellite embeddings, building
    // height and cover, night lights, GHSL's non-residential share and business listings, and labels every block.
    const USE_CLASSES = [['residential', 'Homes'], ['commercial', 'Shops and offices'], ['industrial', 'Industry'], ['civic', 'Institutions and campuses']];
    const USE_LABEL_PCT = 50, USE_MAPPED_PCT = 50, USE_TEST_EVERY = 5, USE_BUILT_PCT = 5;
    const USE_FEATURES = [...Array.from({ length: 12 }, (_, k) => [`embeddings.e${k}`, x => x]), ['building_stock.height_2023_m', x => x],
        ['building_stock.cover_2023_pct', x => x], ['nightlights.radiance', x => Math.log1p(Math.max(0, x))], ['built_up.nonres_share_pct', x => x],
        ['population.density_km2', x => Math.log1p(Math.max(0, x))], ['places.places', x => Math.log1p(x)], ['places.offices', x => Math.log1p(x)], ['places.shopping', x => Math.log1p(x)]];

    function builduse(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], mapped = c['landuse.mapped_pct'];
        const share = USE_CLASSES.map(([k]) => c[`landuse.${k}_pct`]), mil = c['landuse.military_pct'];
        const cover = c['building_stock.cover_2023_pct'];
        if (!mapped || share.some(a => !a) || !c['embeddings.e0'] || !cover) return null;
        const feats = USE_FEATURES.filter(([k]) => c[k]);
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(c['embeddings.e0'][i]) && cover[i] >= USE_BUILT_PCT) idx.push(i);
        if (idx.length < 50) return null;
        // Standardise each feature over the city; missing values sit at the mean.
        const d = feats.length, X = new Float64Array(n * d);
        feats.forEach(([k, f], j) => {
            let s1 = 0, s2 = 0, m = 0;
            for (const i of idx) if (_fin(c[k][i])) { const x = f(c[k][i]); s1 += x; s2 += x * x; m++; }
            const mu = m ? s1 / m : 0, sd = m ? Math.sqrt(Math.max(1e-12, s2 / m - mu * mu)) : 1;
            for (const i of idx) X[i * d + j] = _fin(c[k][i]) ? (f(c[k][i]) - mu) / sd : 0;
        });
        const labelOf = i => {
            if (!(mapped[i] >= USE_MAPPED_PCT)) return -1;
            let best = -1, top = USE_LABEL_PCT - 1e-9;
            share.forEach((a, k) => { const x = (a[i] || 0) + (k === 3 && mil ? mil[i] || 0 : 0); if (x > top) { top = x; best = k; } });
            return best;
        };
        const labelled = idx.map(i => [i, labelOf(i)]).filter(([, l]) => l >= 0);
        const fit = rows => {
            const cen = USE_CLASSES.map(() => new Float64Array(d)), vr = USE_CLASSES.map(() => new Float64Array(d)), cnt = new Array(USE_CLASSES.length).fill(0);
            for (const [i, l] of rows) { cnt[l]++; for (let j = 0; j < d; j++) { const x = X[i * d + j]; cen[l][j] += x; vr[l][j] += x * x; } }
            cen.forEach((v, l) => { if (cnt[l]) for (let j = 0; j < d; j++) { v[j] /= cnt[l]; vr[l][j] = Math.max(0.05, vr[l][j] / cnt[l] - v[j] * v[j]); } });
            const tot = cnt.reduce((a, b) => a + b, 0);
            const logdet = vr.map(v => v.reduce((a, x) => a + Math.log(x), 0));
            return { cen, vr, cnt, prior: cnt.map((x, l) => (x ? Math.log(x / tot) - 0.5 * logdet[l] : -Infinity)) };
        };
        const classify = (m, i) => {
            const dist = m.cen.map((v, l) => { if (!m.cnt[l]) return Infinity; let s2 = 0; for (let j = 0; j < d; j++) { const e = X[i * d + j] - v[j]; s2 += e * e / m.vr[l][j]; } return s2; });
            const sc = dist.map((x, l) => -0.5 * x + m.prior[l]), top = Math.max(...sc);
            const w = sc.map(x => Math.exp(x - top));
            const sum = w.reduce((a, b) => a + b, 0);
            const p = w.map(x => x / sum);
            return [p.indexOf(Math.max(...p)), p];
        };
        // Hold out every fifth labelled block to measure accuracy, then refit on all of them.
        const test = labelled.filter((_, t) => t % USE_TEST_EVERY === 0), train = labelled.filter((_, t) => t % USE_TEST_EVERY !== 0);
        const present = fit(train).cnt.filter(x => x > 0).length;
        if (present < 2 || test.length < 10) return null;
        const m0 = fit(train);
        let hit = 0;
        const tp = new Array(USE_CLASSES.length).fill(0), tn = new Array(USE_CLASSES.length).fill(0);
        for (const [i, l] of test) { tn[l]++; if (classify(m0, i)[0] === l) { hit++; tp[l]++; } }
        const acc = hit / test.length;
        const m = fit(labelled);
        const use = new Float64Array(n).fill(NaN), nonres = new Float64Array(n).fill(NaN);
        const blocks = new Array(USE_CLASSES.length).fill(0), people = new Array(USE_CLASSES.length).fill(0);
        for (const i of idx) {
            const [k, p] = classify(m, i);
            use[i] = k + 1;
            nonres[i] = Math.round(100 * (1 - p[0]));
            blocks[k]++;
            people[k] += pop && _fin(pop[i]) ? pop[i] : 0;
        }
        const stats = [
            { label: 'Blocks with mapped land use used to train', value: `${labelled.length} of ${idx.length}` },
            { label: 'Accuracy on held-out mapped blocks', value: `${_round(100 * acc)}% (one in ${USE_TEST_EVERY} held out)` },
            ...USE_CLASSES.map(([, name], k) => ({ label: `${name}: blocks (residents)`, value: `${blocks[k]} (${_people(people[k])})${tn[k] ? `; ${_round(100 * tp[k] / tn[k])}% of held-out ${name.toLowerCase()} found` : ''}` })),
        ];
        return {
            columns: { use_class: use, nonres_prob_pct: nonres }, idx,
            metric: { label: 'Blocks classed as mostly non-residential', value: _round(100 * (idx.length - blocks[0]) / idx.length), unit: '%', higherIs: null },
            headline: `Land use is mapped for ${_round(100 * labelled.length / idx.length)}% of built-up blocks; a classifier trained on them labels the rest from satellite embeddings, building height and cover, night lights and business listings, and gets ${_round(100 * acc)}% of held-out mapped blocks right. ${_round(100 * blocks[0] / idx.length)}% of blocks read as mostly homes, ${_round(100 * blocks[1] / idx.length)}% shops and offices, ${_round(100 * blocks[2] / idx.length)}% industry and ${_round(100 * blocks[3] / idx.length)}% institutions and campuses.${acc < 0.7 ? ' Treat the map as rough here: too few or too unrepresentative blocks are mapped.' : ''}`,
            stats,
        };
    }

    // Scenario builder. Drop a new metro station, clinic or school on the map, edit the frame's columns the way the
    // bake would have, and re-run every lens that reads those columns: before and after, side by side.
    const WALK_M_PER_MIN = 80, WALK_DETOUR = 1.3, METRO_MAX_WALK = 20, LOCAL_KM = 2;
    const EDITS = {
        metro: { label: 'metro station', keys: ['rail_access.metro_walk_min', 'rail_access.metro_stations', 'osm_transit.rapid', 'osm_transit.stops'] },
        clinic: { label: 'clinic', keys: ['places.health', 'osm_amenities.healthcare'] },
        school: { label: 'school', keys: ['places.education', 'osm_amenities.education'] },
    };

    function applyEdit(fr, e) {
        const g = fr.grid, c = fr.cols;
        const code = String(e.code || (typeof DigiPin !== 'undefined' ? DigiPin.encode(e.lat, e.lng) : '')).replace(/-/g, '').toUpperCase().slice(0, 7);
        const s = g.codes.indexOf(code);
        if (s < 0) throw new Error(`${code || 'That point'} is outside the city's blocks.`);
        const bump = (k, d = 1) => { if (c[k]) c[k][s] = (_fin(c[k][s]) ? c[k][s] : 0) + d; };
        if (e.kind === 'metro') {
            bump('rail_access.metro_stations'); bump('osm_transit.rapid'); bump('osm_transit.stops');
            const w = c['rail_access.metro_walk_min'];
            if (w) for (let i = 0; i < g.n; i++) {
                const km = Math.hypot((g.row[i] - g.row[s]) * g.dy, (g.col[i] - g.col[s]) * g.dx);
                const min = km * 1000 * WALK_DETOUR / WALK_M_PER_MIN;
                if (min <= METRO_MAX_WALK && !(w[i] <= min)) w[i] = Math.round(min * 10) / 10;
            }
        } else if (EDITS[e.kind]) {
            for (const k of EDITS[e.kind].keys) bump(k);
        } else throw new Error(`Unknown edit "${e.kind}". Try ${Object.keys(EDITS).join(', ')}.`);
        return code;
    }

    /**
     * Re-score lenses with edits: { edits: [{ kind: 'metro'|'clinic'|'school', lat, lng | code }], only? }.
     * Runs every lens that reads an edited column (or `only`) on the city's frame and on an edited copy, and
     * returns { city, edits, lenses: [{ id, title, label, unit, higherIs, before, after, change, better }] }.
     */
    async function rescore(city, store, opts = {}) {
        const edits = (opts.edits || []).slice(0, 8);
        if (!edits.length) throw new Error('Add at least one edit: a metro station, clinic or school.');
        const keys = new Set(edits.flatMap(e => (EDITS[e.kind] || { keys: [] }).keys));
        const ids = opts.only && opts.only.length ? opts.only
            : UrbanLenses.LENSES.filter(l => l.needs.some(k => keys.has(k.replace(/@.*$/, '')))).map(l => l.id);
        if (!ids.length) return { city, edits: [], lenses: [] };
        const fr = opts.frame || await UrbanLenses.frame(city, store, UrbanLenses.allNeeds(ids));
        const cols = { ...fr.cols };
        for (const k of keys) if (cols[k]) cols[k] = Float64Array.from(cols[k]);
        const fr2 = { ...fr, cols };
        const placed = edits.map(e => ({ ...e, code: applyEdit(fr2, e) }));
        const base = await UrbanLenses.run(city, store, { only: ids, frame: fr, hotspots: false });
        const next = await UrbanLenses.run(city, store, { only: ids, frame: fr2, hotspots: false });
        // Local view: residents within LOCAL_KM of any edit, where one station or clinic actually shows.
        const g = fr.grid, pop = fr.cols['population.population'];
        const at = placed.map(e => g.codes.indexOf(e.code));
        const near = [];
        for (let i = 0; i < g.n; i++) if (pop && pop[i] > 0 && at.some(s => Math.hypot((g.row[i] - g.row[s]) * g.dy, (g.col[i] - g.col[s]) * g.dx) <= LOCAL_KM)) near.push(i);
        const lenses = [];
        for (const a of base.lenses) {
            const b = next.lenses.find(x => x.id === a.id);
            if (!a.metric || !b || !b.metric || !_fin(a.metric.value) || !_fin(b.metric.value)) continue;
            const f = a.fields[0], ca = base._work.done[a.id].columns[f.key], cb = next._work.done[a.id].columns[f.key];
            let moved = 0, w = 0, ma = 0, mb = 0;
            if (ca && cb) for (const i of near) {
                if (!_fin(ca[i]) || !_fin(cb[i])) continue;
                w += pop[i]; ma += pop[i] * ca[i]; mb += pop[i] * cb[i];
                if (Math.abs(cb[i] - ca[i]) > 1e-9) moved += pop[i];
            }
            const change = b.metric.value - a.metric.value;
            if (!moved && !change) continue;
            const dir = (d, hi) => (d === 0 || !hi ? null : (d > 0) === (hi === 'better'));
            lenses.push({ id: a.id, title: a.title, label: a.metric.label, unit: a.metric.unit, higherIs: a.metric.higherIs,
                before: a.metric.value, after: b.metric.value, change: Math.round(change * 100) / 100, better: dir(change, a.metric.higherIs),
                local: w ? { label: f.label, unit: f.unit, before: _round(ma / w, 2), after: _round(mb / w, 2), better: dir(mb - ma, f.higherIs), residentsChanged: Math.round(moved) } : null,
                headline: b.headline });
        }
        lenses.sort((x, y) => (y.local ? y.local.residentsChanged : 0) - (x.local ? x.local.residentsChanged : 0));
        return { city, edits: placed, localKm: LOCAL_KM, residentsNear: Math.round(_sumOver(pop, near, () => true)), lenses };
    }

    const ENTRIES = [
        { id: 'builduse', equity: false, title: 'What the buildings are used for', icon: '🏢',
            question: 'Which blocks are homes, shops and offices, industry or institutions?',
            field: { key: 'use_class', label: 'Main use: 1 homes, 2 shops and offices, 3 industry, 4 institutions and campuses', unit: 'class', higherIs: null, ramp: 'viridis', domain: [1, 4] },
            extra: [{ key: 'nonres_prob_pct', label: 'Chance the block is mostly not homes', unit: '%', higherIs: null, ramp: 'viridis', domain: [0, 100] }],
            needs: ['landuse.residential_pct', 'landuse.commercial_pct', 'landuse.industrial_pct', 'landuse.civic_pct', 'landuse.military_pct', 'landuse.mapped_pct',
                ...USE_FEATURES.map(([k]) => k), 'population.population'],
            method: `Training labels are blocks where Overture land use (OpenStreetMap landuse polygons) covers at least ${USE_MAPPED_PCT}% and one use takes ${USE_LABEL_PCT}% or more (military counts with institutions). Features, standardised per city: the 12 principal components of Google's satellite embeddings (AlphaEarth), Open Buildings 2.5D height and roof cover, VIIRS night lights, GHSL's non-residential built share WorldPop population density and Overture counts of all places, offices and shops. Only blocks with at least ${USE_BUILT_PCT}% roof cover are classed. A Gaussian naive Bayes classifier (per-use mean and variance of each feature, priors from the share of each use among mapped blocks) assigns every block its most likely use; the chance of non-residential use is its posterior probability. Accuracy is measured on every ${USE_TEST_EVERY}th mapped block, held out of training. Mapped blocks are not a random sample (big campuses and industrial estates get mapped first), so small mixed-use blocks are the least certain.`,
            refs: 'Overture Maps land use; Brown et al. 2025 (Google Satellite Embedding); Google Open Buildings 2.5D; GHSL GHS-BUILT-S non-residential; VIIRS' },
        { id: 'summershade', equity: true, title: 'Summer shade from trees', icon: '🍃',
            question: 'Do the trees still give shade in the hot months?',
            field: { key: 'summer_leafy_pct', label: 'Tree canopy still in leaf in March-May', unit: '% of canopy', higherIs: 'better', ramp: 'greens', domain: [0, 100] },
            needs: ['tree_season.summer_leafy_pct', 'tree_season.tree_phen_sd', 'vegetation.tree_canopy_pct', 'surface_heat.lst_day_c', 'population.population'],
            method: `Sentinel-2 NDVI (2025 March-May median) read only over tree canopy (Meta/WRI canopy height ≥ 5 m): a crown counts as in leaf at NDVI 0.4 or more. Blocks with at least ${SUMMER_CANOPY_MIN}% tree canopy are leafy; leafy blocks with under ${SUMMER_LEAFY_LOW}% of that canopy in leaf lose most of their shade in summer. Hot is the residents' hottest quarter by MODIS summer day surface temperature. Picks rank those blocks by residents, doubled when hot, at least ${SPACING_KM} km apart. The spread of greening across a block's trees is a variety proxy (spectral variation hypothesis), not a species count. Stressed or unwatered trees also look leafless, and small street trees share a 20 m pixel with roofs and road, so dense cores read leafless more often than they are.`,
            refs: 'Copernicus Sentinel-2; Tolan et al. 2024 (Meta/WRI canopy height); Rocchini et al. 2010 (spectral variation hypothesis); MODIS LST' },
        { id: 'riders', equity: true, title: 'Delivery riders: hubs and rest stops', icon: '🛵',
            question: 'Where do delivery riders wait, and where do they need rest stops?',
            field: { key: 'delivery_places_1km', label: `Eateries and grocers within ${RIDER_KM} km (delivery demand)`, unit: 'places', higherIs: null, ramp: 'viridis', domain: [0, 300] },
            needs: ['places.food', 'places.grocers', 'street_infra.toilets', 'street_infra.drinking_water', 'surface_heat.lst_day_c', 'vegetation.tree_canopy_pct', 'population.population'],
            method: `Delivery demand is the count of Overture Maps restaurants, cafés and food places plus grocery and convenience stores within ${RIDER_KM} km. Rider hubs are blocks in the city's top 5% of that count (and at least ${RIDER_MIN}), where food-delivery and quick-commerce riders wait between orders. A hub lacks rest facilities when OpenStreetMap maps no public toilet or no drinking-water point within ${REST_KM * 1000} m; hot means a summer day surface temperature (MODIS) at or above the residents' median and under 10% tree canopy. Rest-stop picks rank hubs lacking facilities by demand, half again for hot ones, at least ${SPACING_KM} km apart. Rider counts are not public, so demand stands in for where riders gather.`,
            refs: 'NITI Aayog 2022 (India\'s Booming Gig and Platform Economy); Rajasthan Platform Based Gig Workers (Registration and Welfare) Act 2023; Overture Maps places; OpenStreetMap; MODIS LST' },
        { id: 'cyclone', equity: false, title: 'Cyclone wind risk', icon: '🌀',
            question: 'How strong a cyclone wind should buildings here be ready for?',
            field: { key: 'wind_rl50_kmh', label: '50-year cyclone wind (sustained)', unit: 'km/h', higherIs: 'worse', ramp: 'reds', domain: [40, 140] },
            needs: ['cyclones.wind_rl50_kmh', 'cyclones.wind_max_kmh', 'cyclones.gale_years', 'cyclones.storms_200km', 'building_stock.height_2023_m', 'population.population'],
            method: 'Every North Indian Ocean storm of 1981-2024 in IBTrACS (JTWC 1-minute winds, else IMD 3-minute winds scaled to 1-minute) is interpolated to 30-minute steps and turned into a wind field with a modified Rankine vortex: wind rises to the maximum at the radius of maximum wind (JTWC, else Willoughby et al. 2006) and falls as (R/r)^0.5 beyond it. Each block keeps its strongest wind per season; the 50-year level is a Gumbel fit to the seasons with storm wind, mixed with how often such seasons come. Winds are 1-minute sustained in open exposure: built-up roughness lowers street-level wind, while gusts run higher, so compare with IS 875 (Part 3) basic wind speeds (3-second gusts) only after a gust factor. Forward-motion asymmetry and storm surge are not modelled.',
            refs: 'Knapp et al. 2010 (IBTrACS); Willoughby, Darling and Rahn 2006; IMD cyclone classification; BIS IS 875 (Part 3) 2015' },
        { id: 'shadecare', equity: true, title: 'Shaded walk to the clinic', icon: '🌳',
            question: 'How much of the walk to the nearest clinic is in the sun?',
            field: { key: 'care_walk_exposed_pct', label: 'Share of the walk to the nearest clinic or pharmacy that is hot and treeless', unit: '%', higherIs: 'worse', ramp: 'reds', domain: [0, 100] },
            extra: [{ key: 'care_walk_m', label: 'Walk to the nearest clinic, hospital or pharmacy', unit: 'm', higherIs: 'worse', ramp: 'heat', domain: [0, 2000] }],
            needs: ['places.health', 'osm_amenities.healthcare', 'vegetation.tree_canopy_pct', 'surface_heat.lst_day_c', 'population.population', 'osm_walk.links'],
            method: `For every lived-in block, the nearest clinic, hospital or pharmacy (Overture Maps health places or OSM healthcare) within ${CARE_KM} km is found on DigiPin's walking network (OSM footways and streets between neighbouring blocks), and the route is traced back block by block. A step counts as hot and bare when its block has under ${SHADE_MIN}% of its area under trees 5 m or taller (Meta/WRI 1 m canopy height) and a summer daytime surface temperature (MODIS) at or above the city's population-weighted median. Planting priority adds up the residents whose walk crosses each hot, bare block. Block-level routes (about 250 m steps) show which corridors matter, not which side of the street to plant.`,
            refs: 'Overture Maps places; OpenStreetMap; Tolan et al. 2024 (Meta/WRI canopy height); MODIS LST; NDMA heat-wave guidelines (2019)' },
        { id: 'techhubs', equity: false, title: 'Tech hubs and IT parks', icon: '💻',
            question: 'Where are the tech and IT clusters, and who lives within reach of them?',
            field: { key: 'tech_firms_1km', label: `Software, IT, biotech and science firms within ${TECH_KM} km`, unit: 'firms', higherIs: null, ramp: 'viridis', domain: [0, 80] },
            needs: ['places.tech', 'places.coworking', 'rail_access.metro_walk_min', 'land_value.value_index', 'population.population'],
            method: `Overture Maps places in the categories software development, information technology company, biotechnology company and B2B science and technology service, counted within ${TECH_KM} km of each block. Hubs are blocks in the densest 5% (and at least 5 firms). The commute shed is residents within ${HUB_KM} km (straight line) of a hub. Metro walk is DigiPin's walking time to the nearest metro station; the value index is the hedonic land-value index (100 = median home). Firms are counted by listing, not by jobs, and SEZ boundaries are not open data.`,
            refs: 'Overture Maps places; NASSCOM Strategic Review; Ministry of Commerce SEZ list (names only)' },
        { id: 'packed', equity: true, title: 'Packed blocks with no setbacks', icon: '🧱',
            question: 'Where are buildings packed wall to wall with no setbacks?',
            field: { key: 'roof_cover_pct', label: 'Share of all block land under roofs (2023)', unit: '% of block', higherIs: 'worse', ramp: 'reds', domain: [0, 70] },
            needs: ['building_stock.cover_2023_pct', 'building_stock.height_2023_m', 'places.fire_stations', 'population.population'],
            method: `Google Open Buildings 2.5D Temporal (2023) roof cover and mean building height per block. Building bye-laws cap ground coverage on a plot (roughly 60–75% for small residential plots, less for larger ones) and require setbacks; since a block also holds streets, ${PACKED_PCT}%+ of the whole block under roofs means plots are built almost wall to wall. Tall means a mean height of ${TALL_M} m or more. Fire stations within 3 km are Overture places and undercount. Coverage is from satellite footprints, so courtyards and lightwells under 4 m are missed.`,
            refs: 'Google Open Buildings 2.5D Temporal; Model Building Bye-Laws 2016 (TCPO); National Building Code 2016 Part 4 (fire); WorldPop' },
        { id: 'coast', equity: false, title: 'Coastline change and the CRZ band', icon: '🌊',
            question: 'How has the coastline moved, and who lives in the coastal regulation band?',
            field: { key: 'coast_change', label: 'Water 1990 minus water 2020 (positive = land made, negative = land lost)', unit: 'points', higherIs: null, ramp: 'diverging', domain: [-50, 50] },
            needs: ['water_history.water_1990_pct', 'water_history.water_2020_pct', 'flood_future.coast_pct_2080_high', 'built_up.built_pct', 'population.population'],
            method: `JRC Global Surface Water yearly history (Landsat) gives each block's water share in 1990 and 2020; only blocks within ${COAST_KM} km of any 2080 coastal flood exposure (WRI Aqueduct, high scenario) count, so inland lakes stay out. Land made is the drop in water share, land lost the rise. The Coastal Regulation Zone band is approximated by land blocks within ${CRZ_KM * 1000} m of blocks that are ${SEA_PCT}%+ water in 2020; the real CRZ follows the notified high-tide line in each state's coastal zone management plan.`,
            refs: 'Pekel et al. 2016 (JRC Global Surface Water); WRI Aqueduct Floods; CRZ Notification 2019 (MoEFCC)' },
        { id: 'tourism', equity: false, title: 'Visitor magnets and hotel gaps', icon: '🧭',
            question: 'Where do visitors go, and where are places to stay short?',
            field: { key: 'landmark_pull', label: `Landmark pull within ${PULL_KM} km (Wikipedia language editions)`, unit: 'editions', higherIs: null, ramp: 'heat', domain: [0, 150] },
            needs: ['landmarks.pull', 'landmarks.landmarks', 'places.lodging', 'places.food', 'population.population'],
            method: `Visitor landmarks are Wikidata items that are attractions (places of worship, tombs, forts, museums, monuments, palaces, parks, zoos, lakes, beaches, markets, stadiums and similar) with articles in 3+ Wikipedia languages; each counts by its number of language editions, an open stand-in for fame (Wikipedia page views were rate-limited). Pull is the sum within ${PULL_KM} km. Visitor magnets are the top 10% of blocks by pull; a hotel gap is a magnet in the lowest quarter of magnets for Overture lodging places (hotels, guest houses, hostels) within ${STAY_KM} km.`,
            refs: 'Wikidata (CC0); Overture Maps places; Ministry of Tourism India Tourism Statistics' },
        { id: 'cityfarms', equity: false, title: 'Farms inside the city', icon: '🌾',
            question: 'Where is farmland left inside the city, and which of it is being built over?',
            field: { key: 'farm_pressure', label: 'Farm block (1) or farm block building up fast (2)', unit: '0-2', higherIs: 'worse', ramp: 'heat', domain: [0, 2] },
            extra: [{ key: 'farm_pct', label: 'Mapped farmland, orchards, allotments and nurseries', unit: '% of block', higherIs: null, ramp: 'greens', domain: [0, 100] }],
            needs: ['landuse.farm_pct', 'growth.built_2016_pct', 'growth.built_2023_pct', 'population.population'],
            method: `OpenStreetMap land use (Overture Maps) of farmland, farmyards, orchards, allotments, plant nurseries, greenhouses and vineyards, clipped to each block. A farm block is under pressure when its built-up share (Google Open Buildings 2.5D Temporal) rose ${FARM_FAST_PP} points or more from 2016 to 2023. OpenStreetMap maps peri-urban fields unevenly; the farmloss lens uses Dynamic World land cover instead.`,
            refs: 'OpenStreetMap via Overture Maps; Google Open Buildings 2.5D Temporal; WorldPop' },
        { id: 'drainage', equity: true, title: 'Drains, nallahs and wastewater works', icon: '🕳️',
            question: 'Where does rainwater have no drain, and who lives beside an open nallah?',
            field: { key: 'drain_density', label: `Main drain length within ${DRAIN_KM} km`, unit: 'km/km²', higherIs: 'better', ramp: 'blues', domain: [0, 2] },
            extra: [{ key: 'beside_drain', label: 'Residents within 100 m of an open drain', unit: 'people', higherIs: 'worse', ramp: 'reds', domain: [0, 500] }],
            needs: ['drains.drain_km', 'drains.drain_near_pct', 'drains.wastewater', 'waterlogging.waterlogging_index', 'population.population'],
            method: `OpenStreetMap drains and ditches (Overture Maps base water), which cover the nallahs and trunk storm drains but few roadside drains; wastewater basins mark sewage treatment plants and effluent ponds. Drain density is mapped drain length within ${DRAIN_KM} km ÷ the circle's area. Waterlogging-prone blocks are those with DigiPin's waterlogging index ${WET_INDEX}+ (low, flat, sealed ground that held water after monsoon rain). Residents beside a drain are block residents × the share of the block within 100 m of one.`,
            refs: 'OpenStreetMap via Overture Maps; CPHEEO Manual on Storm Water Drainage Systems (2019); WorldPop' },
        { id: 'toilets', equity: true, title: 'Public toilets and drinking water', icon: '🚻',
            question: 'Where are public toilets and drinking water missing?',
            field: { key: 'toilet_gap', label: 'Toilet gaps (none near homes; none near a busy street)', unit: '0-2', higherIs: 'worse', ramp: 'reds', domain: [0, 2] },
            extra: [{ key: 'toilets_1km', label: `Public toilets mapped within ${TOILET_HOME_KM} km`, unit: 'count', higherIs: 'better', ramp: 'viridis', domain: [0, 10] }],
            needs: ['street_infra.toilets', 'street_infra.drinking_water', 'places.shopping', 'places.food', 'population.population'],
            method: `OpenStreetMap public toilets and drinking-water points (Overture Maps base infrastructure). Gaps: a lived-in block with no public toilet within ${TOILET_HOME_KM} km, and one of the busiest 10% of blocks by shops and eateries (Overture places) with none within ${TOILET_BUSY_KM * 1000} m. Distances are straight-line between block centres and are planning thresholds for this lens, in the spirit of the Swachh Bharat Mission (Urban) public toilet guidance. OpenStreetMap misses many municipal toilets and water points.`,
            refs: 'Swachh Bharat Mission (Urban) public and community toilet guidelines (MoHUA); OpenStreetMap via Overture Maps; WorldPop' },
        { id: 'gated', equity: false, title: 'Gated colonies and closed streets', icon: '🚧',
            question: 'Where have colonies gated their streets?',
            field: { key: 'gate_density', label: `Gates and barriers per km² within ${GATE_KM * 1000} m`, unit: 'per km²', higherIs: null, ramp: 'heat', domain: [0, 60] },
            needs: ['street_infra.gates', 'landuse.residential_pct', 'land_value.value_index', 'population.population'],
            method: `OpenStreetMap gates, lift barriers and swing or sliding gates (Overture Maps base infrastructure), counted within ${GATE_KM * 1000} m of each lived-in block and divided by the circle's area. Blocks at ${GATED_PER_KM2} or more per km² are called gated. Residential blocks are those with half or more of their land mapped residential. The value index is DigiPin's hedonic land-value index (100 = city median home). Unmapped gates are missing, so the share is a floor.`,
            refs: 'OpenStreetMap barrier=gate/lift_gate via Overture Maps; Delhi RWA gating studies; WorldPop' },
        { id: 'powerlines', equity: true, title: 'Homes under power lines', icon: '⚡',
            question: 'Who lives under high-voltage power lines?',
            field: { key: 'corridor_people', label: 'Residents inside a power line right-of-way', unit: 'people', higherIs: 'worse', ramp: 'reds', domain: [0, 200] },
            extra: [{ key: 'corridor_pct', label: 'Block inside a power line right-of-way', unit: '% of block', higherIs: 'worse', ramp: 'heat', domain: [0, 20] }],
            needs: ['power_lines.corridor_pct', 'power_lines.line_km', 'power_lines.max_kv', 'power_lines.substations', 'built_up.built_pct', 'population.population'],
            method: 'OpenStreetMap power lines of 66 kV and over (Overture Maps base infrastructure) with their voltage tag, buffered to the right-of-way width in the Ministry of Power\'s 2015 guidelines (66 kV 18 m up to 765 kV 67 m; untagged lines as 132 kV). Residents and built-up land inside a corridor are each block\'s WorldPop residents and GHSL built-up share times the corridor share, which assumes both are spread evenly over the block. Unmapped and underground lines are missing.',
            refs: 'Ministry of Power, Guidelines for compensation towards Right of Way for transmission lines (2015); CEA (Measures relating to Safety and Electric Supply) Regulations 2010 and 2023; Overture Maps; WorldPop; GHSL' },
        { id: 'gardens', equity: false, title: 'Soil for gardens and rain gardens', icon: '🌱',
            question: 'Where is the soil good for gardens, farms and rain gardens?',
            field: { key: 'garden_score', label: 'Garden soil score (pH, organic carbon, texture)', unit: '0-100', higherIs: 'better', ramp: 'greens', domain: [50, 100] },
            extra: [{ key: 'rain_garden', label: 'Soil drains well enough for a rain garden', unit: 'yes/no', higherIs: 'better', ramp: 'blues', domain: [0, 1] }],
            needs: ['topsoil.ph', 'topsoil.soc_g_kg', 'topsoil.sand_pct', 'topsoil.clay_pct', 'land_cover.grass_pct', 'land_cover.bare_pct', 'land_cover.shrub_pct', 'population.population'],
            method: `OpenLandMap 250 m predictions of surface soil (Hengl et al.). Score = 45% pH (full marks from ${PH_LO} to ${PH_HI}, falling to zero 1.5 units outside), 35% organic carbon (zero at ${SOC_POOR / 2} g/kg, full at ${SOC_GOOD}), 20% texture (clay 35–45% scores 0.6, over 45% 0.3). Rain gardens need draining soil: ${RAIN_SAND}% sand or more and clay under ${RAIN_CLAY}%. Open land is ESA WorldCover grass, bare and shrub. Community garden sites are lived-in blocks scoring 70+ with at least 10% open land, ranked by open land × residents, ${SPACING_KM} km apart. Urban soil is often fill; test before planting.`,
            refs: 'Hengl et al. (OpenLandMap soil, CC BY-SA 4.0); ESA WorldCover 2021; ICAR soil health card pH classes; CPWD / MoHUA rain garden guidance' },
        { id: 'airport', equity: false, title: 'Getting to the airport', icon: '🛫',
            question: 'How long is the drive to the airport from each neighbourhood?',
            field: { key: 'airport_peak_min', label: 'Rough peak-hour drive to the nearest jet runway', unit: 'min', higherIs: 'worse', ramp: 'heat', domain: [10, 120] },
            extra: [{ key: 'airport_offpeak_min', label: 'Rough off-peak drive', unit: 'min', higherIs: 'worse', ramp: 'heat', domain: [5, 90] }],
            needs: ['flight_paths.runway_km', 'population.population'],
            method: `Distance from each block centre to the nearest jet runway (OpenStreetMap runways of 1.8 km or more, as in the flight-path layer), times a road detour factor of ${DETOUR}, at ${PEAK_KMH} km/h peak and ${OFF_KMH} km/h off-peak, typical average car speeds reported for large Indian cities. Not routed: expressways and elevated roads make some trips much faster, and the nearest runway can be an air force base rather than the passenger airport.`,
            refs: 'OpenStreetMap runways; Boston Consulting Group / Uber 2018 urban mobility in India; WorldPop' },
        { id: 'crowds', equity: false, title: 'Festival and crowd zones', icon: '🪔',
            question: 'Where do festival and weekend crowds build up, and is help close by?',
            field: { key: 'crowd_score', label: 'Crowd-pull score (gathering places nearby × density)', unit: '0-100', higherIs: null, ramp: 'heat', domain: [0, 100] },
            extra: [{ key: 'gathering_places', label: `Places of worship, malls, culture and leisure within ${CROWD_KM} km`, unit: 'places', higherIs: null, ramp: 'viridis', domain: [0, 60] }],
            needs: ['places.worship', 'places.malls', 'places.culture', 'places.leisure', 'places.police', 'places.fire_stations', 'population.density_km2', 'population.population'],
            method: `Gathering places are Overture Maps places of worship (every faith's category), shopping malls, culture (museums, theatres, landmarks) and leisure (parks, sports, entertainment), counted within ${CROWD_KM} km. Crowd zones are lived-in blocks in the city's top 10% by that count that are also denser than the city median: where processions, festival darshan, Friday prayers and weekend shopping meet narrow, crowded streets. Score = count ÷ twice the 90th percentile (capped), scaled to 60% outside dense blocks. Police within ${POLICE_KM} km and fire stations within ${FIRE_KM} km are from Overture and undercount. It locates likely crowd zones, not event sizes; NDMA crowd-management guidance asks for venue-by-venue plans.`,
            refs: 'NDMA Managing Crowds at Events and Venues of Mass Gathering (2014); Overture Maps places; WorldPop' },
        { id: 'cooling', equity: true, title: 'Cooling centres for heat waves', icon: '🧊',
            question: 'Where should cooling centres open in a heat wave?',
            field: { key: 'cooling_gap', label: 'Hot block with (1) or without (2) a candidate cooling centre nearby', unit: '0-2', higherIs: 'worse', ramp: 'reds', domain: [0, 2] },
            extra: [{ key: 'cool_sites_1km', label: `Libraries, malls and community centres within ${COOL_KM} km`, unit: 'places', higherIs: 'better', ramp: 'viridis', domain: [0, 10] }],
            needs: ['surface_heat.lst_day_c', 'places.libraries', 'places.malls', 'places.community_centres', 'places.worship', 'demographics.elderly_60plus', 'population.population'],
            method: `Hot blocks are those in the hottest quarter of residents by MODIS summer daytime land surface temperature (population-weighted 75th percentile within the city). Candidate cooling centres are Overture Maps places listed as libraries, shopping malls and community centres, public or semi-public buildings with shade, water and cooling; a hot block is unserved when none lies within ${COOL_KM} km (straight line between block centres). Places of worship, which the Ahmedabad Heat Action Plan and others also open, are counted separately as a possible stand-in. Sites are picked greedily from unserved hot blocks by residents plus three times the residents aged 60 and over, at least ${SPACING_KM} km apart. Overture undercounts government libraries and community halls, so check ward records before siting.`,
            refs: 'Ahmedabad Heat Action Plan (AMC, 2013 onwards); NDMA Guidelines for Preparation of Action Plan on Heat Wave (2019); Overture Maps places; MODIS LST; WorldPop' },
        { id: 'buildingage', equity: false, title: 'How old is the city?', icon: '🏚️',
            question: 'When was each part of the city built?',
            field: { key: 'median_build_year', label: 'Year half of today\'s built area was standing', unit: 'year', higherIs: null, ramp: 'viridis', domain: [1975, 2020] },
            extra: [{ key: 'built_by_1990_pct', label: 'Share of today\'s built area standing by 1990', unit: '%', higherIs: null, ramp: 'heat', domain: [0, 100] }],
            needs: ['builtup_yearly.built_pct@series', 'population.population'],
            method: 'GHSL built-up surface (Landsat and Sentinel-2) every five years from 1975. Each epoch\'s increase in a block\'s built-up share is the area built in those five years (GHSL built area is treated as never shrinking); the median build year is the first epoch by which half of the latest built area was standing. Blocks under 5% built are left out. Footprints only: rebuilding or adding floors on the same plot does not show.',
            refs: 'Pesaresi et al. 2023 (GHSL GHS-BUILT-S R2023A); European Commission JRC' },
        { id: 'mosquito', equity: true, title: 'Mosquito season and breeding risk', icon: '🦟',
            question: 'Where and when are conditions right for dengue mosquitoes?',
            field: { key: 'mosquito_risk', label: 'Mosquito breeding-conditions score', unit: '0-100', higherIs: 'worse', ramp: 'reds', domain: [20, 90] },
            extra: [{ key: 'mosquito_months', label: 'Months in the last 12 warm and wet enough for Aedes', unit: 'months', higherIs: 'worse', ramp: 'heat', domain: [0, 8] }],
            needs: ['lst_monthly.lst_day_c@series', 'lst_monthly.lst_night_c@series', 'rain_monthly.rain_mm@series', 'waterlogging.waterlogging_index', 'population.density_km2', 'population.population'],
            method: `A month counts as suitable for Aedes aegypti, the dengue and chikungunya mosquito, when the mean of MODIS day and night land surface temperature (a rough proxy for air temperature) lies between ${AEDES_MIN} and ${AEDES_MAX} °C, the transmission range in Mordecai et al. 2017, and that month or the one before had ${RAIN_WET} mm of CHIRPS rain for breeding sites. Score = 40% suitable months of the last 12, 30% waterlogging index (standing water after rain), 30% within-city population density percentile (Aedes thrives in crowded, container-rich streets). An index of breeding conditions, not of cases: water storage habits, drainage and fogging matter as much and are not in the data.`,
            refs: 'Mordecai et al. 2017 (PLoS NTD, thermal limits of Aedes transmission); CHIRPS; MODIS LST; NCVBDC dengue situation reports' },
        { id: 'greenbelt', equity: false, title: 'Building inside protected forests', icon: '🌳',
            question: 'How much building is creeping into parks, sanctuaries, reserve forests and their buffers?',
            field: { key: 'protected_growth_pp', label: 'New built-up 2016→2023 inside protected land or its eco-sensitive zone', unit: 'points', higherIs: 'worse', ramp: 'reds', domain: [0, 30] },
            extra: [{ key: 'protected_pct', label: 'Protected land (mapped)', unit: '% of block', higherIs: null, ramp: 'greens', domain: [0, 100] }],
            needs: ['landuse.protected_pct', 'landuse.esz_pct', 'growth.built_2016_pct', 'growth.built_2023_pct', 'land_cover.tree_pct', 'encroachment.tree_lost_pct', 'population.population'],
            method: 'Protected land is Overture Maps land use of subtype protected (from OpenStreetMap: national parks, wildlife sanctuaries, reserve forests, biodiversity parks); polygons named as eco-sensitive zones are counted separately. Built-up share from Google Open Buildings 2.5D Temporal (2016 and 2023), tree cover from ESA WorldCover 2021 and loss from Hansen Global Forest Change, each multiplied by the protected share of the block, which assumes they are spread evenly over it. OpenStreetMap boundaries are not the gazette notification.',
            refs: 'Overture Maps land use; Google Open Buildings 2.5D Temporal; ESA WorldCover 2021; Hansen et al. 2013; Environment (Protection) Act 1986 eco-sensitive zone notifications' },
        { id: 'monthly', equity: false, title: 'What changed in a year', icon: '🛰️',
            question: 'What changed this month compared with a year ago?',
            field: { key: 'change_signs', label: 'Year-on-year change signs (new building, lights, greenery lost, NO₂ up)', unit: 'count', higherIs: null, ramp: 'heat', domain: [0, 3] },
            needs: CHANGE_SIGNS.map(S => `${S.key}@series`).concat(['population.population']),
            method: `Four monthly satellite series in the cell store: Dynamic World built-up probability, VIIRS night lights, Sentinel-2 NDVI and Sentinel-5P NO₂. For each, the mean of the latest three months that at least half the lived-in blocks have is compared with the same three months a year earlier, which cancels the season and smooths over a cloudy month. Signs: built-up up 15+ points (new building), radiance up 50% and 2+ nW/cm²/sr (lights coming on), NDVI down 0.15+ (greenery lost), NO₂ up 30%+ from at least ${NO2_FLOOR} µmol/m² (dirtier air; NO₂ is a 1 km-scale field, so this marks districts, not streets). Cloud and haze can still fake a sign; two signs together are more telling.`,
            refs: 'Brown et al. 2022 (Dynamic World); Elvidge et al. 2017 (VIIRS); Sentinel-2; Sentinel-5P TROPOMI' },
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

    UrbanLenses.register(ENTRIES, { heritage, landmix, reach, monthly, greenbelt, mosquito, buildingage, cooling, crowds, airport, gardens, powerlines, toilets, gated, drainage, cityfarms, tourism, coast, packed, techhubs, shadecare, cyclone, riders, summershade, builduse }, { rescore, applyEdit }, 'jobsmap');
    return { ENTRIES };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesPlanning = UrbanLensesPlanning;
}
