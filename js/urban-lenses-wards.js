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

    // Feels-like heat. The Universal Thermal Climate Index folds humidity, wind and sun into air temperature: the heat the
    // body has to shed outdoors. A month whose mean daily peak is 38 °C UTCI or more is a month of very strong heat stress
    // for anyone working or walking outside in the afternoon.
    const UTCI_VS = 38;

    function feelslike(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, vs = c['feels_like.utci_vstrong_months'], st = c['feels_like.utci_strong_months'];
        const amj = c['feels_like.utci_amj_c'], then = c['feels_like.utci_vstrong_months_then'], chg = c['feels_like.utci_amj_change_c'];
        const air = c['air_heat.tmax_amj_c'], pop = c['population.population'];
        if (!vs || !amj || !amj.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => _fin(amj[i]) && _fin(vs[i]));
        if (idx.length < 5) return null;
        const all = idx.reduce((s, i) => s + v(pop, i), 0) || 1;
        const wavg = a => idx.reduce((s, i) => s + v(pop, i) * v(a, i), 0) / all;
        const mVS = wavg(vs), mS = wavg(st), mA = wavg(amj);
        const two = idx.filter(i => vs[i] >= 2).reduce((s, i) => s + v(pop, i), 0);
        const stats = [
            { label: `Months a year of very strong heat stress (UTCI ${UTCI_VS} °C or more), average resident, 2013-2022`, value: `${_round(mVS, 1)}${then ? ` (${_round(wavg(then), 1)} in 2000-2009)` : ''}` },
            { label: 'Months a year of strong heat stress or worse (UTCI 32 °C or more)', value: _round(mS, 1) },
            { label: 'April-June feels-like daily peak, average resident', value: `${_round(mA, 1)} °C${chg ? ` (${wavg(chg) >= 0 ? '+' : ''}${_round(wavg(chg), 1)} °C since 2000-2009)` : ''}` },
            { label: 'Residents with two months or more of very strong heat stress a year', value: `${_people(two)} (${_round(100 * two / all, 0)}%)` },
        ];
        if (air) {
            const both = idx.filter(i => _fin(air[i]));
            if (both.length >= 5) {
                const gap = both.reduce((s, i) => s + v(pop, i) * (amj[i] - air[i]), 0) / (both.reduce((s, i) => s + v(pop, i), 0) || 1);
                stats.push({ label: 'April-June feels-like peak against the air-temperature peak (1 km daily air temperature)', value: `${gap >= 0 ? '+' : ''}${_round(gap, 1)} °C` });
            }
        }
        const score = new Float64Array(n);
        for (const i of idx) score[i] = v(pop, i) * Math.max(0, amj[i] - mA + 1);
        spaced(g, idx.filter(i => score[i] > 0), score).forEach((i, k) => stats.push({ label: `Hottest to be outdoors ${k + 1}: ${g.codes[i]}`, value: `${_round(amj[i], 1)} °C feels-like April-June peak; ${_round(vs[i], 1)} months a year at ${UTCI_VS} °C or more` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = amj[i];
        return {
            columns: { utci_amj: out }, idx, weightKey: 'utci_amj',
            metric: { label: 'April-June feels-like daily peak (UTCI), average resident', value: _round(mA, 1), unit: '°C', higherIs: 'worse' },
            headline: `Outdoors, the average resident's April-June afternoons feel like ${_round(mA, 1)} °C (UTCI), with ${_round(mVS, 1)} months a year of very strong heat stress and ${_round(mS, 1)} of strong heat stress or worse; ${_people(two)} residents face two months or more of very strong heat stress.`,
            stats,
        };
    }

    // Civic works ordered. BBMP's work orders for 2018-2023, summed per assembly constituency: how much the corporation
    // put into roads, drains, water, lights and buildings per resident it serves, and whether drain money went where
    // the rain pools.
    const BLR_AC = {
        150: 'Yelahanka', 151: 'K R Pura', 152: 'Byatarayanapura', 153: 'Yeshwanthpur', 154: 'Rajarajeshwari Nagar', 155: 'Dasarahalli',
        156: 'Mahalakshmi Layout', 157: 'Malleshwaram', 158: 'Hebbal', 159: 'Pulakeshinagar', 160: 'Sarvagnanagar', 161: 'C V Raman Nagar',
        162: 'Shivajinagar', 163: 'Shantinagar', 164: 'Gandhinagar', 165: 'Rajajinagar', 166: 'Govindarajanagar', 167: 'Vijayanagar',
        168: 'Chamarajpet', 169: 'Chickpet', 170: 'Basavanagudi', 171: 'Padmanabhanagar', 172: 'BTM Layout', 173: 'Jayanagar',
        174: 'Mahadevapura', 175: 'Bommanahalli', 176: 'Bengaluru South', 177: 'Anekal',
    };

    function civicworks(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, ac = c['work_orders.wo_ac'], tot = c['work_orders.wo_total_cr'];
        const parts = { roads: c['work_orders.wo_roads_cr'], drains: c['work_orders.wo_drains_cr'], water: c['work_orders.wo_water_cr'], lights: c['work_orders.wo_lights_cr'], waste: c['work_orders.wo_waste_cr'], buildings: c['work_orders.wo_buildings_cr'] };
        const pop = c['population.population'], wl = c['waterlogging.waterlogging_index'];
        if (!ac || !tot || !tot.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const A = new Map();
        for (let i = 0; i < n; i++) {
            if (!_fin(ac[i]) || !_fin(tot[i])) continue;
            const a = A.get(ac[i]) || { no: ac[i], blocks: [], pop: 0, wl: 0, wlw: 0, first: i };
            a.blocks.push(i); a.pop += v(pop, i);
            if (wl && _fin(wl[i])) { a.wl += v(pop, i) * wl[i]; a.wlw += v(pop, i); }
            A.set(ac[i], a);
        }
        const as = [...A.values()].filter(a => a.blocks.length >= 3 && a.pop >= 5000);
        if (as.length < 5) return null;
        const name = a => BLR_AC[a.no] || `constituency ${a.no}`;
        for (const a of as) { a.tot = tot[a.first] * 1e7; a.per = a.tot / a.pop; }
        const tAll = as.reduce((s, a) => s + a.tot, 0), tPop = as.reduce((s, a) => s + a.pop, 0) || 1;
        const share = k => (parts[k] ? as.reduce((s, a) => s + v(parts[k], a.first), 0) * 1e7 / (tAll || 1) : NaN);
        const byPer = as.slice().sort((a, b) => b.per - a.per);
        const stats = [
            { label: `Work orders tagged to ${as.length} constituencies, 2018-2023 / per resident a year`, value: `₹${_round(tAll / 1e7, 0)} crore / ₹${Math.round(tAll / tPop / 5)}` },
            { label: 'Share for roads / drains / water and sanitation / street lights / buildings', value: ['roads', 'drains', 'water', 'lights', 'buildings'].map(k => `${_round(100 * share(k), 0)}%`).join(' / ') },
            { label: 'Most per resident against least (constituency averages)', value: `${_round(byPer[0].per / byPer[byPer.length - 1].per, 1)} times` },
        ];
        byPer.slice(0, 3).forEach((a, k) => stats.push({ label: `Most per resident ${k + 1}: ${name(a)}, ${g.codes[a.first]}`, value: `₹${Math.round(a.per / 5)} a year per resident (₹${_round(a.tot / 1e7, 0)} crore)` }));
        byPer.slice(-3).reverse().forEach((a, k) => stats.push({ label: `Least per resident ${k + 1}: ${name(a)}, ${g.codes[a.first]}`, value: `₹${Math.round(a.per / 5)} a year per resident (₹${_round(a.tot / 1e7, 0)} crore)` }));
        let rho = NaN;
        const wet = as.filter(a => a.wlw && parts.drains);
        if (wet.length >= 10) {
            rho = _rankCorr(wet.map(a => v(parts.drains, a.first) / a.pop), wet.map(a => a.wl / a.wlw));
            stats.push({ label: 'Rank match by constituency: drain work per resident against the rain waterlogging index', value: _round(rho, 2) });
        }
        const out = new Float64Array(n).fill(NaN), idx = [];
        for (const a of as) for (const i of a.blocks) { out[i] = Math.round(a.per / 5); idx.push(i); }
        return {
            columns: { works_per_resident_yr: out }, idx, weightKey: 'works_per_resident_yr', noHotspots: true,
            metric: { label: 'Civic work orders per resident a year (2018-2023)', value: Math.round(tAll / tPop / 5), unit: '₹/yr', higherIs: null },
            headline: `BBMP ordered ₹${_round(tAll / 1e7, 0)} crore of works tagged to constituencies in 2018-2023, about ₹${Math.round(tAll / tPop / 5)} a year per resident, from ₹${Math.round(byPer[0].per / 5)} in ${name(byPer[0])} to ₹${Math.round(byPer[byPer.length - 1].per / 5)} in ${name(byPer[byPer.length - 1])}; ${_round(100 * share('roads'), 0)}% went to roads${_fin(rho) ? `, and drain work per resident ${rho >= 0.4 ? 'broadly follows' : 'barely follows'} where rain pools (rank match ${_round(rho, 2)})` : ''}.`,
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
        { id: 'feelslike', equity: true, title: 'Feels-like heat outdoors', icon: '🥵',
            question: 'How hot does it feel outdoors once humidity, sun and wind are counted, and for how many months?',
            field: { key: 'utci_amj', label: 'April-June feels-like daily peak (UTCI)', unit: '°C', higherIs: 'worse', ramp: 'heat', domain: [30, 42] },
            needs: ['feels_like.utci_vstrong_months', 'feels_like.utci_strong_months', 'feels_like.utci_amj_c', 'feels_like.utci_vstrong_months_then', 'feels_like.utci_amj_change_c', 'air_heat.tmax_amj_c', 'population.population'],
            method: `GloUTCI-M (CC BY 4.0): monthly Universal Thermal Climate Index at 1 km for 2000-2022, the outdoor temperature the body feels once humidity, wind and solar radiation are combined with air temperature (mean of the daily peak each month). UTCI bands: 32 to 38 °C strong heat stress, ${UTCI_VS} to 46 °C very strong, above 46 °C extreme. Months are counted per year and averaged over 2013-2022 and 2000-2009, and weighted by GHSL residents. The air-temperature comparison uses the 1 km daily air temperature dataset (air_heat); a positive gap means humidity and sun make it feel hotter than the thermometer reads. Monthly means smooth single heatwave days, so these counts are lower bounds on hard days. Picks are blocks ${SPACING_KM} km apart ranked by residents × how far the block's April-June peak sits above the city's average.`,
            refs: 'Yang et al., GloUTCI-M: a global monthly 1 km Universal Thermal Climate Index dataset 2000-2022 (Earth System Science Data, 2024); Bröde et al., Deriving the operational procedure for the UTCI (Int. J. Biometeorology, 2012)' },
        { id: 'civicworks', title: 'Civic works ordered', icon: '🚧',
            question: 'How much has the corporation spent on works per resident in each constituency, and on what?',
            field: { key: 'works_per_resident_yr', label: 'Civic work orders per resident a year (2018-2023)', unit: '₹/yr', higherIs: null, ramp: 'viridis', domain: [0, 6000] },
            needs: ['work_orders.wo_ac', 'work_orders.wo_total_cr', 'work_orders.wo_roads_cr', 'work_orders.wo_drains_cr', 'work_orders.wo_water_cr', 'work_orders.wo_lights_cr', 'work_orders.wo_waste_cr', 'work_orders.wo_buildings_cr', 'waterlogging.waterlogging_index', 'population.population'],
            method: `BBMP work orders for 2018-19 to 2022-23 (gross amounts, via data.opencity.in, public domain), categorised by OpenCity and summed per assembly constituency. Work tagged to several wards or none (₹8,023 crore, about a third) is left out, so the figures cover ward-level works only. Constituency totals are joined to blocks inside both the constituency (2008 delimitation map) and the corporation's ward map, and divided by residents in those blocks (GHSL, which in Bengaluru is reshared by each GBA ward's Census 2011 count because GHSL alone puts far too few people in the south and east) and by five years. Roads combine "roads and infrastructure" with "roads and drains". The rank match is a Spearman correlation across constituencies between storm-water drain orders per resident and the residents-weighted rain waterlogging index. Work orders are commitments, not money spent or work done.`,
            refs: 'BBMP work orders categorised by ward and constituency, 2018-2023, via data.opencity.in; Election Commission of India assembly constituency maps (2008 delimitation, DataMeet)' },
    ];

    UrbanLenses.register(ENTRIES, { homes2011, lowground, feelslike, civicworks });
    return { ENTRIES };
})();
