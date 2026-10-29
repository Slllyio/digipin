/**
 * Ward records and ground lenses for UrbanLenses: official counts kept by ward (Census 2011 houselisting and households)
 * and the bare-earth ground homes stand on by the sea. Registers itself on load, after urban-lenses.js. Started when
 * urban-lenses-commons.js reached the 150 kB per-module budget.
 */
const UrbanLensesWards = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _residents } = UrbanLenses._kit;

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

    /** Spearman rank correlation of two equal-length arrays (no tie correction; NaN under 5 pairs). */
    function _rankCorr(x, y) {
        const rank = a => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = new Float64Array(a.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
        const m = x.length;
        if (m < 5) return NaN;
        const rx = rank(x), ry = rank(y);
        let d = 0;
        for (let i = 0; i < m; i++) d += (rx[i] - ry[i]) ** 2;
        return 1 - 6 * d / (m * (m * m - 1));
    }

    // Homes in 2011. Census 2011 houselisting (HH-14) and Primary Census Abstract by census ward, summed into BMC's 24
    // administrative wards: how many households lived in one room, rented, lacked their own latrine, or owned a car.
    // The last full count of how Mumbai lived, ward by ward; car ownership then is set against today's land values.
    const BMC_WARDS = ['A', 'B', 'C', 'D', 'E', 'F/N', 'F/S', 'G/N', 'G/S', 'H/E', 'H/W', 'K/E', 'K/W', 'L', 'M/E', 'M/W', 'N', 'P/N', 'P/S', 'R/C', 'R/N', 'R/S', 'S', 'T'];
    const BMC_AREAS = {
        A: 'Colaba, Fort', B: 'Dongri, Masjid', C: 'Kalbadevi, Marine Lines', D: 'Malabar Hill, Grant Road', E: 'Byculla', 'F/N': 'Matunga, Sion',
        'F/S': 'Parel', 'G/N': 'Dadar, Dharavi', 'G/S': 'Worli, Lower Parel', 'H/E': 'Bandra East, Santacruz East', 'H/W': 'Bandra West, Khar',
        'K/E': 'Andheri East', 'K/W': 'Andheri West', L: 'Kurla', 'M/E': 'Govandi, Mankhurd', 'M/W': 'Chembur', N: 'Ghatkopar', 'P/N': 'Malad',
        'P/S': 'Goregaon', 'R/C': 'Borivali', 'R/N': 'Dahisar', 'R/S': 'Kandivali', S: 'Bhandup, Powai', T: 'Mulund',
    };
    const CROWDED = 70;     // % of households in one room or less that marks a crowded ward

    function homes2011(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, wno = c['census_homes.c11_ward_no'], hh = c['census_homes.c11_households'];
        const room = c['census_homes.c11_one_room_pct'], rent = c['census_homes.c11_rented_pct'], lat = c['census_homes.c11_no_latrine_pct'];
        const open = c['census_homes.c11_open_def_pct'], car = c['census_homes.c11_car_pct'], net = c['census_homes.c11_internet_pct'];
        const size = c['census_homes.c11_hh_size'], pop = c['population.population'], vi = c['land_value.value_index'], rwi = c['wealth.rwi'];
        if (!wno || !hh || !room || !room.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const W = new Map();
        for (let i = 0; i < n; i++) {
            if (!_fin(wno[i]) || !_fin(hh[i])) continue;
            const w = W.get(wno[i]) || { no: wno[i], blocks: [], pop: 0, vi: 0, viw: 0, rw: 0, rww: 0, first: i };
            w.blocks.push(i); w.pop += v(pop, i);
            if (vi && _fin(vi[i])) { w.vi += v(pop, i) * vi[i]; w.viw += v(pop, i); }
            if (rwi && _fin(rwi[i])) { w.rw += v(pop, i) * rwi[i]; w.rww += v(pop, i); }
            W.set(wno[i], w);
        }
        const ws = [...W.values()].filter(w => w.blocks.length >= 3);
        if (ws.length < 5) return null;
        const name = w => { const k = BMC_WARDS[w.no - 1] || String(w.no); return `${k} ward${BMC_AREAS[k] ? ` (${BMC_AREAS[k]})` : ''}`; };
        for (const w of ws) { const i = w.first; w.hh = hh[i]; w.val = w.viw ? w.vi / w.viw : NaN; w.rwi = w.rww ? w.rw / w.rww : NaN; }
        const tHH = ws.reduce((s, w) => s + w.hh, 0) || 1;
        const share = a => (a ? ws.reduce((s, w) => s + v(a, w.first) * w.hh, 0) / tHH : NaN);
        const people = ws.reduce((s, w) => s + w.hh * v(size, w.first), 0);
        const byRoom = ws.slice().sort((a, b) => room[b.first] - room[a.first]);
        const crowded = ws.filter(w => room[w.first] >= CROWDED);
        const stats = [
            { label: `Households counted in 2011 across ${ws.length} wards / people per household`, value: `${_people(tHH)} / ${_round(people / tHH, 1)}` },
            { label: 'Households in one room or less / renting', value: `${_round(share(room), 0)}% / ${_round(share(rent), 0)}%` },
            { label: 'Households without a latrine of their own / going in the open', value: `${_round(share(lat), 0)}% / ${_round(share(open), 1)}%` },
            { label: 'Households with a car / a computer and internet', value: `${_round(share(car), 0)}% / ${_round(share(net), 0)}%` },
            { label: `Wards where ${CROWDED}% or more of households lived in one room or less`, value: `${crowded.length} of ${ws.length} (${_people(crowded.reduce((s, w) => s + w.hh, 0))} households)` },
        ];
        byRoom.slice(0, 3).forEach((w, k) => stats.push({ label: `Most crowded ${k + 1}: ${name(w)}, ${g.codes[w.first]}`, value: `${_round(room[w.first], 0)}% in one room or less; ${_round(v(lat, w.first), 0)}% without their own latrine` }));
        if (lat) ws.slice().sort((a, b) => lat[b.first] - lat[a.first]).slice(0, 3).forEach((w, k) => stats.push({ label: `Fewest own latrines ${k + 1}: ${name(w)}, ${g.codes[w.first]}`, value: `${_round(lat[w.first], 0)}% of households without one; ${_round(v(open, w.first), 1)}% going in the open` }));
        let rho = NaN, rhoW = NaN;
        const carOk = w => car && _fin(car[w.first]);
        const both = ws.filter(w => _fin(w.val) && carOk(w)), withW = ws.filter(w => _fin(w.rwi) && carOk(w));
        if (both.length >= 10) rho = _rankCorr(both.map(w => car[w.first]), both.map(w => w.val));
        if (withW.length >= 10) rhoW = _rankCorr(withW.map(w => car[w.first]), withW.map(w => w.rwi));
        if (_fin(rho) || _fin(rhoW)) stats.push({ label: 'Rank match by ward, car ownership in 2011 against today: land value index / relative wealth index', value: `${_fin(rho) ? _round(rho, 2) : 'n/a'} / ${_fin(rhoW) ? _round(rhoW, 2) : 'n/a'}` });
        const out = new Float64Array(n).fill(NaN), idx = [];
        for (const w of ws) for (const i of w.blocks) { out[i] = room[w.first]; idx.push(i); }
        const top = byRoom[0], low = byRoom[byRoom.length - 1];
        return {
            columns: { one_room_2011: out }, idx, weightKey: 'one_room_2011', noHotspots: true,
            metric: { label: 'Households in one room or less (Census 2011)', value: _round(share(room), 1), unit: '%', higherIs: 'worse' },
            headline: `In 2011, ${_round(share(room), 0)}% of the ${_people(tHH)} households counted in ${ws.length} wards lived in one room or less, from ${_round(room[top.first], 0)}% in ${name(top)} to ${_round(room[low.first], 0)}% in ${name(low)}, and ${_round(share(lat), 0)}% had no latrine of their own${_fin(rhoW) ? (rhoW >= 0.5 ? `; the wards where more households owned a car then are still the better-off ones by today's satellite wealth estimate (rank match ${_round(rhoW, 2)})` : `; car ownership then barely matches today's satellite wealth estimate by ward (rank match ${_round(rhoW, 2)}), since each ward blends towers and slums and the satellite estimate works on 2.4 km tiles`) : ''}.`,
            stats,
        };
    }


    // Low ground by the sea. DeltaDTM strips buildings and trees from the Copernicus DEM with satellite lidar, so it gives
    // the height of the ground itself. Homes on ground a few metres above mean sea level drain through outfalls that
    // back up at high tide, and sea-level rise (IPCC AR6: about 0.4 to 0.8 m by 2100 for India's coast, more if ice sheets
    // go fast) narrows that margin further.
    const LOW_M = 3;

    function lowground(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, z = c['low_ground.ground_m'], b2 = c['low_ground.below2_pct'], b3 = c['low_ground.below3_pct'];
        const b5 = c['low_ground.below5_pct'], cst = c['flood_future.coast_pct_now'], wl = c['waterlogging.waterlogging_index'], pop = c['population.population'];
        if (!z || !b3 || !z.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => _fin(z[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const on = a => idx.reduce((s, i) => s + v(pop, i) * v(a, i) / 100, 0);
        const p2 = on(b2), p3 = on(b3), p5 = on(b5);
        let acc = 0, mid = NaN;
        for (const i of idx.slice().sort((a, b) => z[a] - z[b])) { acc += v(pop, i); if (acc >= all / 2) { mid = z[i]; break; } }
        const low = idx.filter(i => v(b3, i) >= 50);
        const stats = [
            { label: `Residents on ground 2 m / ${LOW_M} m / 5 m or less above mean sea level`, value: `${_people(p2)} / ${_people(p3)} / ${_people(p5)}` },
            { label: 'Ground height under the median resident\'s block', value: `${_round(mid, 1)} m` },
            { label: `Blocks with homes where half the ground or more is ${LOW_M} m or less`, value: `${low.length} (${_people(low.reduce((s, i) => s + v(pop, i), 0))} residents)` },
        ];
        if (cst) {
            const lowPop = low.reduce((s, i) => s + v(pop, i), 0) || 1, mapped = low.filter(i => v(cst, i) > 0).reduce((s, i) => s + v(pop, i), 0);
            stats.push({ label: `Of them, in blocks the 1-in-100-year coastal flood map already reaches (WRI Aqueduct, ~1 km)`, value: `${_round(100 * mapped / lowPop, 0)}%` });
        }
        if (wl) {
            const wet = low.filter(i => v(wl, i) >= 60).reduce((s, i) => s + v(pop, i), 0);
            stats.push({ label: 'Of them, also in a rain waterlogging hotspot (index 60 or more)', value: _people(wet) });
        }
        const score = new Float64Array(n);
        for (const i of idx) score[i] = v(pop, i) * v(b3, i);
        spaced(g, idx.filter(i => score[i] > 0), score).forEach((i, k) => stats.push({ label: `Low and lived-in ${k + 1}: ${g.codes[i]}`, value: `ground ${_round(z[i], 1)} m on average, ${_round(v(b3, i), 0)}% at ${LOW_M} m or less; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = z[i];
        return {
            columns: { ground_height_m: out }, idx, weightKey: 'ground_height_m',
            metric: { label: `Residents on ground ${LOW_M} m or less above mean sea level`, value: Math.round(p3), unit: 'people', higherIs: 'worse' },
            headline: `${_people(p3)} residents live on ground ${LOW_M} m or less above mean sea level and ${_people(p5)} on ground 5 m or less (the median resident's block sits at ${_round(mid, 1)} m); there, storm drains back up when heavy rain meets high tide, and the half metre or more of sea-level rise expected this century cuts that margin further.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'homes2011', equity: true, title: 'Homes in 2011 by ward', icon: '🏘️',
            question: 'How crowded were homes in each ward at the last census, and who lacked a latrine or owned a car?',
            field: { key: 'one_room_2011', label: 'Households in one room or less (Census 2011)', unit: '%', higherIs: 'worse', ramp: 'viridis', domain: [40, 85] },
            needs: ['census_homes.c11_ward_no', 'census_homes.c11_households', 'census_homes.c11_hh_size', 'census_homes.c11_one_room_pct', 'census_homes.c11_rented_pct', 'census_homes.c11_no_latrine_pct', 'census_homes.c11_open_def_pct', 'census_homes.c11_car_pct', 'census_homes.c11_internet_pct', 'land_value.value_index', 'wealth.rwi', 'population.population'],
            method: `Census of India 2011 Houselisting and Housing table HH-14 (percentage of households by amenities and assets) and the Primary Census Abstract for Greater Mumbai's 97 census wards (via data.opencity.in, public domain). Each census ward lies inside one of BMC's 24 administrative wards, so census wards are summed into them, HH-14 shares weighted by households, and joined to blocks through the BMC ward map (wards). One room or less counts households with no exclusive room or one dwelling room; latrine figures count households without a latrine inside the premises, and those of them that use no public latrine either. Figures are from 2011 and many wards have been rebuilt since (slum redevelopment, towers in the mill lands and suburbs), so they describe the last full count, not today. The rank matches are Spearman correlations across wards between 2011 car ownership and today's residents-weighted land value index (land_value) and Meta's relative wealth index (wealth). Caste and tribe columns are not read.`,
            refs: 'Census of India 2011, Houselisting and Housing Census table HH-14 and Primary Census Abstract, Greater Mumbai census wards (via data.opencity.in); BMC administrative ward map (DataMeet)' },
        { id: 'lowground', equity: true, title: 'Low ground by the sea', icon: '🌊',
            question: 'Who lives on ground only a few metres above the sea, where high tides back up the drains?',
            field: { key: 'ground_height_m', label: 'Bare-earth ground height above mean sea level (DeltaDTM)', unit: 'm', higherIs: 'better', ramp: 'viridis', domain: [0, 12] },
            needs: ['low_ground.ground_m', 'low_ground.below2_pct', 'low_ground.below3_pct', 'low_ground.below5_pct', 'flood_future.coast_pct_now', 'waterlogging.waterlogging_index', 'population.population'],
            method: `Deltares DeltaDTM v1.1 (CC BY 4.0): a 30 m coastal terrain model made from the Copernicus DEM with buildings and vegetation removed using ICESat-2 and GEDI lidar heights, giving the ground itself in metres above mean sea level (EGM2008; vertical error about half a metre on flat land). It covers land up to 30 m, so it is baked for Mumbai, Chennai and Kolkata. Residents (GHSL) are counted on the share of each block at 2, ${LOW_M} and 5 m or less. Ground this low drains through outfalls into the sea or tidal rivers, which back up at high tide, so heavy rain at high tide floods it; IPCC AR6 projects about 0.4 to 0.8 m of sea-level rise along India's coast by 2100. The coastal flood comparison uses WRI Aqueduct's 1-in-100-year coastal flood today (~1 km); the waterlogging comparison uses the rain waterlogging index. Picks are blocks ${SPACING_KM} km apart ranked by residents × share at ${LOW_M} m or less. Seawalls, flap gates and pumping stations are not modelled.`,
            refs: 'Pronk et al., DeltaDTM: a global coastal digital terrain model, Scientific Data (2024); IPCC AR6 WG1 Chapter 9 and regional sea-level projections; WRI Aqueduct Floods v2' },
    ];

    UrbanLenses.register(ENTRIES, { homes2011, lowground });
    return { ENTRIES };
})();
