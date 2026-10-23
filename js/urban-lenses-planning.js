/**
 * Planning and regulation lenses for UrbanLenses: construction limits around protected monuments and land-use mix.
 * They read the heritage and landuse cell datasets (pipeline/realestate/heritage.py, landuse.py). Registers itself on load, after urban-lenses.js.
 */
const UrbanLensesPlanning = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _sumOver, within, wquantile } = UrbanLenses._kit;

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

    const ENTRIES = [
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

    UrbanLenses.register(ENTRIES, { heritage, landmix, reach, monthly, greenbelt, mosquito, buildingage }, {}, 'jobsmap');
    return { ENTRIES };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesPlanning = UrbanLensesPlanning;
}
