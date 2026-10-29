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

    // Fringe villages. Mission Antyodaya's 2020 survey of the rural villages at the city's edge: piped water, drains,
    // kuccha homes, buses, health centres. These are where the city builds next, so the lens sets the services against
    // the new floor space going up there.
    const DRAIN_BAD = 4;

    function fringevillages(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, vno = c['village_services.ma_village_no'], hh = c['village_services.ma_households'];
        const piped = c['village_services.ma_piped_pct'], kuccha = c['village_services.ma_kuccha_pct'], nolat = c['village_services.ma_no_latrine_pct'];
        const drain = c['village_services.ma_drain'], bus = c['village_services.ma_bus'], phc = c['village_services.ma_phc_km'], nf = c['re_supply.new_floor_m2'];
        if (!vno || !hh || !piped || !piped.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const V = new Map();
        for (let i = 0; i < n; i++) {
            if (!_fin(vno[i]) || !_fin(hh[i]) || !_fin(piped[i])) continue;
            const a = V.get(vno[i]) || { blocks: [], first: i, floor: 0 };
            a.blocks.push(i); a.floor += v(nf, i);
            V.set(vno[i], a);
        }
        const vs = [...V.values()];
        if (vs.length < 8) return null;
        const at = (a, x) => (x && _fin(x[a.first]) ? x[a.first] : NaN);
        const H = vs.reduce((s, a) => s + at(a, hh), 0) || 1;
        const share = x => vs.reduce((s, a) => s + at(a, hh) * (_fin(at(a, x)) ? at(a, x) : 0), 0) / H;
        const badDrain = vs.filter(a => at(a, drain) >= DRAIN_BAD), noBus = bus ? vs.filter(a => at(a, bus) === 0) : [];
        const sumHH = xs => xs.reduce((s, a) => s + at(a, hh), 0);
        const stats = [
            { label: 'Villages at the edge matched to the survey / households', value: `${vs.length} / ${_people(H)}` },
            { label: 'Households with a piped water connection / in a kuccha house / without a sanitary latrine', value: `${_round(share(piped), 0)}% / ${_round(share(kuccha), 1)}% / ${_round(share(nolat), 1)}%` },
            { label: 'Villages with open kuccha drains or none', value: `${badDrain.length} (${_people(sumHH(badDrain))} households)` },
        ];
        if (bus) stats.push({ label: 'Villages where no bus stops', value: `${noBus.length} (${_people(sumHH(noBus))} households)` });
        if (phc) stats.push({ label: 'Distance to a health centre (households-weighted)', value: `${_round(share(phc), 1)} km` });
        let dry = NaN, rho = NaN;
        if (nf && vs.some(a => a.floor > 0)) {
            const busy = vs.slice().sort((a, b) => b.floor - a.floor).slice(0, TOP);
            dry = busy.filter(a => at(a, piped) < 50).length;
            rho = _rankCorr(vs.map(a => a.floor), vs.map(a => at(a, piped)));
            stats.push({ label: 'Rank match by village: new floor space against piped water share', value: _round(rho, 2) });
            busy.forEach((a, k) => stats.push({ label: `Building fastest ${k + 1}: ${g.codes[a.first]}`, value: `${_round(a.floor / 1e4, 1)} ha of new floor; ${_round(at(a, piped), 0)}% piped water, drains ${at(a, drain) >= DRAIN_BAD ? 'open kuccha or none' : 'pucca or closed'}` }));
        }
        const out = new Float64Array(n).fill(NaN), idx = [];
        for (const a of vs) for (const i of a.blocks) { out[i] = at(a, piped); idx.push(i); }
        return {
            columns: { piped_water_pct: out }, idx, weightKey: 'piped_water_pct', noHotspots: true,
            metric: { label: 'Fringe-village households with piped water (2020)', value: _round(share(piped), 0), unit: '%', higherIs: 'better' },
            headline: `In the ${vs.length} villages at the city's edge surveyed in 2020 (${_people(H)} households), ${_round(share(piped), 0)}% of households had a piped water connection and ${badDrain.length} villages had open kuccha drains or none${_fin(dry) ? `; ${dry} of the ${TOP} villages putting up the most new floor space piped water to fewer than half their homes` : ''}.`,
            stats,
        };
    }

    // Health now. NFHS-6 (2023-24) state fact sheets are out before the district ones, so the lens sets the state's
    // newest figures, overall and in its towns and cities, against the state in 2019-21 and the city's own NFHS-5
    // districts: which way blood sugar, weight, blood pressure, stunting and insurance have moved since.
    const HEALTH6 = [
        ['sugar_women', 'women with raised blood sugar', 'sugar_women_pct'], ['sugar_men', 'men with raised blood sugar', 'sugar_men_pct'],
        ['women_obese', 'women overweight or obese', 'women_obese_pct'], ['men_obese', 'men overweight or obese', null],
        ['bp_women', 'women with raised blood pressure', 'bp_women_pct'], ['bp_men', 'men with raised blood pressure', 'bp_men_pct'],
        ['stunted', 'children under 5 stunted', 'stunted_pct'], ['wasted', 'children under 5 wasted', 'wasted_pct'],
        ['insurance', 'households with health insurance', 'insurance_pct'],
    ];

    function healthnow(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const col = k => c[`nfhs6.${k}`];
        if (!col('n6_sugar_women') || !col('n6_sugar_women').some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(col('n6_sugar_women')[i]));
        if (idx.length < 5) return null;
        const i0 = idx[0], v = (a, i) => (a && _fin(a[i]) ? a[i] : NaN);
        const P = idx.reduce((s, i) => s + (_fin(pop[i]) ? pop[i] : 0), 0) || 1;
        const dist = k => { const a = c[`nfhs.${k}`]; if (!a) return NaN; let s = 0, w = 0; for (const i of idx) if (_fin(a[i]) && _fin(pop[i])) { s += a[i] * pop[i]; w += pop[i]; } return w > P / 2 ? s / w : NaN; };
        const rows = HEALTH6.map(([f, label, d]) => ({ f, label, then: v(col(`n5_${f}`), i0), now: v(col(`n6_${f}`), i0), urban: v(col(`n6u_${f}`), i0), city: d ? dist(d) : NaN }))
            .filter(r => _fin(r.now) && _fin(r.then));
        if (rows.length < 3) return null;
        const pp = x => (_fin(x) ? `${_round(x, 1)}%` : 'n/a');
        const stats = rows.map(r => ({ label: `${r.label[0].toUpperCase()}${r.label.slice(1)}: state 2019-21 → 2023-24 / its towns and cities 2023-24 / this city's districts 2019-21`, value: `${pp(r.then)} → ${pp(r.now)} / ${pp(r.urban)} / ${pp(r.city)}` }));
        const worse = rows.filter(r => r.f !== 'insurance').sort((a, b) => (b.now - b.then) - (a.now - a.then));
        const up = worse.filter(r => r.now > r.then).slice(0, 2), down = worse.slice().reverse().find(r => r.now < r.then);
        const ins = rows.find(r => r.f === 'insurance');
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = v(col('n6u_sugar_women'), i);
        return {
            columns: { sugar_women_urban: out }, idx, weightKey: 'sugar_women_urban', noHotspots: true,
            metric: { label: "Women with raised blood sugar, the state's towns and cities (NFHS-6 2023-24)", value: _round(v(col('n6u_sugar_women'), i0), 1), unit: '%', higherIs: 'worse' },
            headline: `Across the state, ${up.map((r, k) => `${r.label}${k ? '' : ' rose'} from ${pp(r.then)} to ${pp(r.now)} (${pp(r.urban)} in its towns and cities)`).join(' and ')} between NFHS-5 (2019-21) and NFHS-6 (2023-24)${down ? `, while ${down.label} fell from ${pp(down.then)} to ${pp(down.now)}` : ''}${ins ? `; ${pp(ins.now)} of households now have health insurance (${pp(ins.then)} before)` : ''}. District figures for 2023-24 are not out yet, so this city's own districts are still the 2019-21 values.`,
            stats,
        };
    }

    // Assembly seats. The party holding each seat after the latest state election (ECI results via OpenCity), how close
    // the race was, and where the MLA's party differs from the 2024 MP's. Mirrors PARTIES in pipeline/realestate/assembly.py.
    const PARTY = ['another party', 'BJP', 'INC', 'AAP', 'AITC', 'DMK', 'AIADMK', 'TVK', 'Shiv Sena', 'Shiv Sena (UBT)', 'NCP', 'NCP (SP)',
        'BRS', 'AIMIM', 'JD(S)', 'CPI(M)', 'SP', 'Independent', 'MNS', 'RLD', 'VCK'];
    const CLOSE = 5;

    function mlaseats(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, ac = c['assembly_results.mla_ac'], pid = c['assembly_results.mla_party_id'];
        const mar = c['assembly_results.mla_margin_pct'], yr = c['assembly_results.mla_year'], mp = c['assembly_results.mp_party_id'];
        const pop = c['population.population'];
        if (!ac || !pid || !ac.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const S = new Map();
        for (let i = 0; i < n; i++) {
            if (!_fin(ac[i]) || !_fin(pid[i])) continue;
            const a = S.get(ac[i]) || { blocks: [], pop: 0, first: i, mp: new Map() };
            a.blocks.push(i); a.pop += v(pop, i);
            if (mp && _fin(mp[i])) a.mp.set(mp[i], (a.mp.get(mp[i]) || 0) + v(pop, i));
            S.set(ac[i], a);
        }
        const ss = [...S.values()].filter(a => a.pop >= 5000);
        if (ss.length < 5) return null;
        const P = ss.reduce((t, a) => t + a.pop, 0) || 1;
        const name = id => PARTY[id] || PARTY[0];
        const by = new Map();
        for (const a of ss) { a.party = pid[a.first]; a.margin = _fin(mar[a.first]) ? mar[a.first] : NaN; const b = by.get(a.party) || { seats: 0, pop: 0 }; b.seats++; b.pop += a.pop; by.set(a.party, b); }
        const parties = [...by.entries()].sort((x, y) => y[1].pop - x[1].pop);
        const year = Math.round(v(yr, ss[0].first));
        const known = ss.filter(a => _fin(a.margin)).sort((x, y) => x.margin - y.margin);
        const close = known.filter(a => a.margin < CLOSE), closePop = close.reduce((t, a) => t + a.pop, 0);
        const medMargin = known.length ? known[Math.floor(known.length / 2)].margin : NaN;
        let split = 0, splitKnown = 0;
        for (const a of ss) {
            const top = [...a.mp.entries()].sort((x, y) => y[1] - x[1])[0];
            if (!top || !a.party || !top[0]) continue;
            splitKnown += a.pop;
            if (top[0] !== a.party) split += a.pop;
        }
        const pct = x => `${_round(100 * x, 0)}%`;
        const stats = [
            { label: `Assembly seats in view (${year} election) / residents`, value: `${ss.length} / ${_people(P)}` },
            ...parties.slice(0, 4).map(([id, b]) => ({ label: `${name(id)}: seats / share of residents`, value: `${b.seats} / ${pct(b.pop / P)}` })),
            { label: `Seats won by under ${CLOSE} points of the vote / their residents`, value: `${close.length} / ${pct(closePop / P)}` },
            { label: 'Middle seat winning margin', value: _fin(medMargin) ? `${_round(medMargin, 1)} points` : 'n/a' },
        ];
        if (splitKnown > P / 2) stats.push({ label: "Residents whose MLA's party differs from their 2024 MP's", value: pct(split / splitKnown) });
        known.slice(0, 3).forEach((a, k) => stats.push({ label: `Closest seat ${k + 1}: ${name(a.party)} held it, ${g.codes[a.first]}`, value: `${_round(a.margin, 1)} points` }));
        const safe = known[known.length - 1];
        if (safe) stats.push({ label: `Safest seat: ${name(safe.party)}, ${g.codes[safe.first]}`, value: `${_round(safe.margin, 1)} points` });
        const out = new Float64Array(n).fill(NaN), idx = [];
        for (const a of ss) for (const i of a.blocks) if (_fin(a.margin)) { out[i] = a.margin; idx.push(i); }
        const [lead, lb] = parties[0];
        return {
            columns: { seat_margin: out }, idx, weightKey: 'seat_margin', noHotspots: true,
            metric: { label: `Assembly winning margin (${year})`, value: _round(medMargin, 1), unit: 'points', higherIs: null },
            headline: `At the ${year} assembly election, ${name(lead)} won ${lb.seats} of the ${ss.length} seats in view, home to ${pct(lb.pop / P)} of residents${parties[1] ? `, and ${name(parties[1][0])} ${parties[1][1].seats}` : ''}; ${close.length ? `${close.length} seat${close.length > 1 ? 's were' : ' was'} won by under ${CLOSE} points (closest ${_round(known[0].margin, 1)})` : `no seat was won by under ${CLOSE} points`}${splitKnown > P / 2 ? `, and ${pct(split / splitKnown)} of residents have an MLA from a different party than their 2024 MP` : ''}.`,
            stats,
        };
    }

    // City road deaths. MoRTH's Road Accidents in India 2024 tables for 50 large cities (police city areas): deaths and
    // crashes in 2023 and 2024, who died (pedestrians, two-wheeler riders ...) and the violation the police recorded.
    const RD_USERS = [['pedestrian', 'pedestrians'], ['twowheeler', 'two-wheeler riders'], ['cycle', 'cyclists'], ['auto', 'auto-rickshaw users'],
        ['car', 'car and van users'], ['truck', 'truck users'], ['bus', 'bus users'], ['other', 'others']];
    const RD_CAUSES = [['speeding', 'over-speeding'], ['wrongside', 'driving on the wrong side'], ['drunk', 'drunk driving'], ['redlight', 'jumping a red light'], ['phone', 'using a phone']];

    function roaddeaths(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`city_road_deaths.rd_${k}`];
        const k24 = col('killed_2024');
        if (!k24 || !k24.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(k24[i]));
        if (idx.length < 5) return null;
        const i0 = idx[0], v = k => (col(k) && _fin(col(k)[i0]) ? col(k)[i0] : NaN);
        const killed = v('killed_2024'), before = v('killed_2023'), per = v('per100'), med = v('per100_median'), rank = v('rank_killed_2024');
        const users = RD_USERS.map(([k, label]) => ({ label, pct: v(`${k}_pct`) })).filter(u => _fin(u.pct)).sort((a, b) => b.pct - a.pct);
        const causes = RD_CAUSES.map(([k, label]) => ({ label, pct: v(`${k}_pct`) })).filter(u => _fin(u.pct));
        const chg = _fin(before) && before ? 100 * (killed - before) / before : NaN;
        const pp = x => `${_round(x, 0)}%`;
        const ord = r => `${r}${r % 100 >= 11 && r % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][r % 10] || 'th'}`;
        const stats = [
            { label: 'Road deaths in the police city, 2024 (2023)', value: `${Math.round(killed)} (${_fin(before) ? Math.round(before) : 'n/a'})` },
            { label: 'Rank among 50 large cities by road deaths, 2024', value: _fin(rank) ? `${Math.round(rank)} of 50` : 'n/a' },
            { label: 'Deaths per 100 crashes / median of the 50 cities', value: `${_round(per, 1)} / ${_round(med, 1)}` },
            { label: 'Crashes / people injured, 2024', value: `${Math.round(v('crashes_2024'))} / ${_fin(v('injured_2024')) ? Math.round(v('injured_2024')) : 'n/a'}` },
            ...users.map(u => ({ label: `Share of deaths: ${u.label}`, value: pp(u.pct) })),
            ...causes.map(u => ({ label: `Share of deaths recorded as ${u.label}`, value: pp(u.pct) })),
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = per;
        const top = users.slice(0, 2), speed = causes.find(u => u.label === 'over-speeding');
        const sev = !_fin(per) || !_fin(med) ? '' : per > med * 1.25 ? `, more than the 50-city median of ${_round(med, 1)}` : per < med * 0.8 ? `, fewer than the 50-city median of ${_round(med, 1)}` : `, close to the 50-city median of ${_round(med, 1)}`;
        return {
            columns: { deaths_per100: out }, idx, weightKey: 'deaths_per100', noHotspots: true,
            metric: { label: 'Road deaths per 100 crashes (police city, 2024)', value: _round(per, 1), unit: 'per 100', higherIs: 'worse' },
            headline: `${Math.round(killed)} people died on the roads in the police city in 2024${_fin(chg) ? ` (${chg >= 0 ? 'up' : 'down'} ${_round(Math.abs(chg), 0)}% on 2023)` : ''}${_fin(rank) ? `, the ${Math.round(rank) === 1 ? '' : `${ord(Math.round(rank))} `}most of 50 large cities` : ''}; ${_round(per, 1)} died per 100 crashes${sev}.${top.length ? ` ${top[0].label[0].toUpperCase()}${top[0].label.slice(1)} were ${pp(top[0].pct)} of the dead${top[1] ? ` and ${top[1].label} ${pp(top[1].pct)}` : ''}` : ''}${speed ? `; police put ${pp(speed.pct)} of deaths down to over-speeding` : ''}.`,
            stats,
        };
    }

    // Household spending. MoSPI's HCES 2023-24 household files for the city's districts (urban households): consumption
    // per person, where it goes, and the rent that renting households pay.
    const HC_SHARES = [['food', 'food'], ['rent', 'rent'], ['goods', 'clothing, footwear and durables'], ['transport', 'transport'], ['education', 'education'],
        ['medical', 'medical care'], ['fuel', 'fuel and light']];

    function spending(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`hces.hc_${k}`];
        const mp = col('mpce');
        if (!mp || !mp.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(mp[i]));
        if (idx.length < 5) return null;
        const i0 = idx[0], v = k => (col(k) && _fin(col(k)[i0]) ? col(k)[i0] : NaN);
        const rs = x => `₹${Math.round(x).toLocaleString('en-IN')}`;
        const shares = HC_SHARES.map(([k, label]) => ({ label, pct: v(`${k}_pct`) })).filter(x => _fin(x.pct));
        const sh = k => shares.find(x => x.label === k);
        const stats = [
            { label: 'Monthly consumption per person, urban households 2023-24 (average / middle person)', value: `${rs(v('mpce'))} / ${rs(v('mpce_median'))}` },
            ...shares.map(x => ({ label: `Share spent on ${x.label}`, value: `${_round(x.pct, 1)}%` })),
            { label: 'Households paying rent / their average rent a month', value: `${_round(v('renters_pct'), 0)}% / ${_fin(v('rent')) ? rs(v('rent')) : 'n/a'}` },
            { label: 'Richest fifth against the poorest fifth (consumption per person) / Gini', value: `${_round(v('top_bottom'), 1)} times / ${_round(v('gini'), 2)}` },
            { label: 'Urban households surveyed', value: String(Math.round(v('households'))) },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = v('mpce');
        const food = sh('food'), rent = sh('rent');
        return {
            columns: { mpce: out }, idx, weightKey: 'mpce', noHotspots: true,
            metric: { label: 'Monthly consumption per person, urban (HCES 2023-24)', value: Math.round(v('mpce')), unit: '₹', higherIs: null },
            headline: `Urban households here spent ${rs(v('mpce'))} a month per person in 2023-24 (the middle person ${rs(v('mpce_median'))})${food ? `; food took ${_round(food.pct, 0)}%` : ''}${rent ? ` and rent ${_round(rent.pct, 0)}%` : ''}${_fin(v('renters_pct')) ? `, with ${_round(v('renters_pct'), 0)}% of households renting at ${rs(v('rent'))} a month on average` : ''}. The richest fifth consumed ${_round(v('top_bottom'), 1)} times as much per person as the poorest fifth.`,
            stats,
        };
    }

    // Ward councillors. Corporation election results per ward (PMC 2026 prabhags, GHMC 2020 wards): the party holding
    // each ward, how many of its seats it holds, the margin where wards elect one member, and whether the ward's party
    // matches the assembly seat's MLA.
    function wardcouncil(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`ward_results.corp_${k}`];
        const wn = col('ward_no'), pid = col('party_id'), pop = c['population.population'], mla = c['assembly_results.mla_party_id'];
        if (!wn || !pid || !wn.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : NaN);
        const W = new Map();
        for (let i = 0; i < n; i++) {
            if (!_fin(wn[i]) || !_fin(pid[i])) continue;
            const a = W.get(wn[i]) || { blocks: [], pop: 0, first: i, mla: new Map() };
            const p = _fin(pop?.[i]) ? pop[i] : 0;
            a.blocks.push(i); a.pop += p;
            if (_fin(v(mla, i))) a.mla.set(mla[i], (a.mla.get(mla[i]) || 0) + p);
            W.set(wn[i], a);
        }
        const ws = [...W.values()].filter(a => a.pop >= 2000);
        if (ws.length < 3) return null;
        const P = ws.reduce((t, a) => t + a.pop, 0) || 1, name = id => PARTY[id] || PARTY[0];
        const year = Math.round(v(col('year'), ws[0].first));
        const by = new Map();
        let seats = 0, split = 0, splitKnown = 0;
        for (const a of ws) {
            a.party = pid[a.first]; a.seats = v(col('seats'), a.first); a.lead = v(col('lead_seats'), a.first); a.margin = v(col('margin_pct'), a.first);
            const b = by.get(a.party) || { wards: 0, pop: 0 }; b.wards++; b.pop += a.pop; by.set(a.party, b);
            if (_fin(a.seats)) seats += a.seats;
            const top = [...a.mla.entries()].sort((x, y) => y[1] - x[1])[0];
            if (top && a.party && top[0]) { splitKnown += a.pop; if (top[0] !== a.party) split += a.pop; }
        }
        const parties = [...by.entries()].sort((x, y) => y[1].wards - x[1].wards || y[1].pop - x[1].pop);
        const pct = x => `${_round(100 * x, 0)}%`;
        const multi = ws.some(a => a.seats > 1), mixed = ws.filter(a => a.seats > 1 && a.lead < a.seats);
        const known = ws.filter(a => _fin(a.margin)).sort((x, y) => x.margin - y.margin);
        const close = known.filter(a => a.margin < CLOSE);
        const stats = [
            { label: `Wards in view (${year} corporation election)${multi ? ' / council seats' : ''}`, value: multi ? `${ws.length} / ${seats}` : String(ws.length) },
            ...parties.slice(0, 4).map(([id, b]) => ({ label: `${name(id)}: wards / share of residents`, value: `${b.wards} / ${pct(b.pop / P)}` })),
        ];
        if (multi) stats.push({ label: 'Multi-member wards whose seats are split between parties', value: `${mixed.length} of ${ws.filter(a => a.seats > 1).length}` });
        if (known.length) {
            stats.push({ label: `Wards won by under ${CLOSE} points of the vote`, value: String(close.length) });
            known.slice(0, 3).forEach((a, k) => stats.push({ label: `Closest ward ${k + 1}: ${name(a.party)} won ward ${Math.round(wn[a.first])}, ${g.codes[a.first]}`, value: `${_round(a.margin, 1)} points` }));
            const t = ws.filter(a => _fin(v(col('turnout_pct'), a.first)));
            if (t.length) stats.push({ label: 'Turnout, residents-weighted', value: `${_round(t.reduce((s, a) => s + a.pop * v(col('turnout_pct'), a.first), 0) / t.reduce((s, a) => s + a.pop, 0), 0)}%` });
        }
        if (splitKnown > P / 2) stats.push({ label: "Residents whose ward party differs from their MLA's", value: pct(split / splitKnown) });
        const out = new Float64Array(n).fill(NaN), idx = [];
        for (const a of ws) for (const i of a.blocks) { out[i] = a.party; idx.push(i); }
        const [lead, lb] = parties[0];
        return {
            columns: { ward_party: out }, idx, weightKey: 'ward_party', noHotspots: true,
            metric: { label: `Wards held by ${name(lead)} (${year})`, value: lb.wards, unit: 'wards', higherIs: null },
            headline: `At the ${year} corporation election, ${name(lead)} won ${lb.wards} of the ${ws.length} wards in view, home to ${pct(lb.pop / P)} of residents${parties[1] ? `, and ${name(parties[1][0])} ${parties[1][1].wards}` : ''}${multi ? `; ${mixed.length} multi-member ward${mixed.length === 1 ? ' splits its' : 's split their'} seats between parties` : ''}${known.length ? `; ${close.length} ward${close.length === 1 ? ' was' : 's were'} won by under ${CLOSE} points` : ''}${splitKnown > P / 2 ? `, and ${pct(split / splitKnown)} of residents have a ward party different from their MLA's` : ''}.`,
            stats,
        };
    }

    // Recorded crime. NCRB's Crime in India 2024 tables for the 19 metropolitan cities (police commissionerates): cases
    // registered 2022-2024, the rate per lakh people, charge-sheeting, and crimes against women, children, older people,
    // economic offences and cyber crime.
    const CR_KEYS = ['total_2022', 'total_2023', 'total_2024', 'rate', 'rate_median', 'ipc_rate', 'chargesheet_pct', 'ipc_chargesheet_pct', 'women_2024', 'women_rate',
        'children_2024', 'senior_2024', 'econ_2024', 'fraud_2024', 'cyber_2022', 'cyber_2024', 'cyber_rate', 'cyber_chargesheet_pct'];

    function citycrime(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`city_crime.cr_${k}`];
        const tot = col('total_2024');
        if (!tot || !tot.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(tot[i]));
        if (idx.length < 5) return null;
        const i0 = idx[0], v = k => (col(k) && _fin(col(k)[i0]) ? col(k)[i0] : NaN);
        const N = x => (_fin(x) ? Math.round(x).toLocaleString('en-IN') : 'n/a');
        const pc = x => (_fin(x) ? `${_round(x, 0)}%` : 'n/a');
        const rate = v('rate'), med = v('rate_median'), c22 = v('total_2022'), c24 = v('total_2024');
        const cy22 = v('cyber_2022'), cy24 = v('cyber_2024');
        const stats = [
            { label: 'Cognizable crimes registered, 2024 (2023, 2022)', value: `${N(c24)} (${N(v('total_2023'))}, ${N(c22)})` },
            { label: 'Per lakh people, 2024 / median of 19 metropolitan cities', value: `${_round(rate, 0)} / ${_round(med, 0)}` },
            { label: 'IPC/BNS crimes per lakh people, 2024', value: _fin(v('ipc_rate')) ? String(_round(v('ipc_rate'), 0)) : 'n/a' },
            { label: 'Cases charge-sheeted: all / IPC-BNS / cyber', value: `${pc(v('chargesheet_pct'))} / ${pc(v('ipc_chargesheet_pct'))} / ${pc(v('cyber_chargesheet_pct'))}` },
            { label: 'Crimes against women, 2024 / per lakh women', value: `${N(v('women_2024'))} / ${_fin(v('women_rate')) ? _round(v('women_rate'), 0) : 'n/a'}` },
            { label: 'Crimes against children / against people 60 or older, 2024', value: `${N(v('children_2024'))} / ${N(v('senior_2024'))}` },
            { label: 'Economic offences, 2024 (of which forgery, cheating and fraud)', value: `${N(v('econ_2024'))} (${N(v('fraud_2024'))})` },
            { label: 'Cyber crimes, 2024 (2022) / per lakh people', value: `${N(cy24)} (${N(cy22)}) / ${_fin(v('cyber_rate')) ? _round(v('cyber_rate'), 1) : 'n/a'}` },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = rate;
        const chg = _fin(c22) && c22 ? 100 * (c24 - c22) / c22 : NaN, cyx = _fin(cy22) && cy22 > 0 ? cy24 / cy22 : NaN;
        const vs = !_fin(med) ? '' : rate > med * 1.25 ? `, above the 19-city median of ${_round(med, 0)}` : rate < med * 0.8 ? `, below the 19-city median of ${_round(med, 0)}` : `, close to the 19-city median of ${_round(med, 0)}`;
        return {
            columns: { crime_rate: out }, idx, weightKey: 'crime_rate', noHotspots: true,
            metric: { label: 'Cognizable crimes per lakh people (police city, 2024)', value: _round(rate, 0), unit: 'per lakh', higherIs: 'worse' },
            headline: `Police registered ${N(c24)} cognizable crimes in the city in 2024${_fin(chg) ? ` (${chg >= 0 ? 'up' : 'down'} ${_round(Math.abs(chg), 0)}% on 2022)` : ''}, ${_round(rate, 0)} per lakh people${vs}; ${pc(v('chargesheet_pct'))} of cases were charge-sheeted.${_fin(cy24) ? ` Cyber crime cases numbered ${N(cy24)}${_fin(cyx) && cyx >= 1.5 ? `, ${_round(cyx, 1)} times 2022's` : ''}.` : ''}`,
            stats,
        };
    }

    // Voter roll revision. The Election Commission's 2026 Special Intensive Revision re-verified every elector; seat-wise
    // counts after it (West Bengal, Tamil Nadu, Karnataka) against the 2024 Lok Sabha roll.
    const SIR_WHY = [['dead', 'as dead'], ['shifted', 'as shifted or absent'], ['multiple', 'as enrolled in more than one place']];

    function rollrevision(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`roll_revision.sir_${k}`];
        const ac = col('ac'), now = col('electors'), was = col('electors_2024'), pop = c['population.population'];
        if (!ac || !now || !ac.some(_fin)) return null;
        const S = new Map();
        for (let i = 0; i < n; i++) {
            if (!_fin(ac[i]) || !_fin(now[i])) continue;
            const a = S.get(ac[i]) || { blocks: [], pop: 0, first: i };
            a.blocks.push(i); a.pop += pop && _fin(pop[i]) ? pop[i] : 0;
            S.set(ac[i], a);
        }
        const ss = [...S.values()].filter(a => a.pop >= 5000);
        if (ss.length < 3) return null;
        const at = (k, a) => (col(k) && _fin(col(k)[a.first]) ? col(k)[a.first] : NaN);
        let N = 0, W = 0;
        for (const a of ss) { a.now = now[a.first]; a.was = _fin(was?.[a.first]) ? was[a.first] : NaN; a.chg = at('change_pct', a); N += a.now; if (_fin(a.was)) W += a.was; }
        const known = ss.filter(a => _fin(a.chg)).sort((x, y) => x.chg - y.chg);
        const chg = W ? 100 * (ss.filter(a => _fin(a.was)).reduce((t, a) => t + a.now, 0) - W) / W : NaN;
        const wmean = k => { let s = 0, w = 0; for (const a of ss) { const x = at(k, a); if (_fin(x)) { s += x * a.now; w += a.now; } } return w ? s / w : NaN; };
        const women = wmean('women_per_1000'), del = wmean('deleted_pct'), draft = wmean('draft_change_pct'), notice = wmean('notice_pct');
        const pp = x => `${x > 0 ? '+' : ''}${_round(x, 1)}%`;
        const stats = [
            { label: 'Assembly seats in view', value: String(ss.length) },
            { label: 'Electors in those seats: 2024 Lok Sabha / final 2026 roll', value: `${_people(W)} / ${_people(N)}` },
            { label: 'Change, 2024 to the final 2026 roll', value: _fin(chg) ? pp(chg) : 'n/a' },
            { label: 'Women per 1,000 men on the final roll', value: _fin(women) ? String(Math.round(women)) : 'n/a' },
        ];
        if (_fin(del)) {
            stats.push({ label: 'Struck off at the draft stage, % of the roll before revision', value: `${_round(del, 1)}%` });
            for (const [k, label] of SIR_WHY) { const x = wmean(`${k}_pct`); if (_fin(x)) stats.push({ label: `Struck off ${label}`, value: `${_round(x, 1)}%` }); }
        }
        if (_fin(draft)) stats.push({ label: 'Change from the January 2026 draft roll to the final roll', value: pp(draft) });
        if (_fin(notice)) stats.push({ label: 'Electors sent a notice to prove eligibility, % of the final roll', value: `${_round(notice, 1)}%` });
        known.slice(0, 3).forEach((a, k) => stats.push({ label: `Biggest cut ${k + 1}: seat ${Math.round(ac[a.first])}, ${g.codes[a.first]}`, value: pp(a.chg) }));
        const least = known[known.length - 1];
        if (least) stats.push({ label: `Smallest cut: seat ${Math.round(ac[least.first])}, ${g.codes[least.first]}`, value: pp(least.chg) });
        const out = new Float64Array(n).fill(NaN), idx = [];
        for (const a of known) for (const i of a.blocks) { out[i] = a.chg; idx.push(i); }
        return {
            columns: { roll_change: out }, idx, weightKey: 'roll_change', noHotspots: true,
            metric: { label: 'Change in electors, 2024 to the final 2026 roll', value: _round(chg, 1), unit: '%', higherIs: null },
            headline: `The ${ss.length} assembly seats in view had ${_people(W)} electors in 2024 and ${_people(N)} on the final roll after the 2026 revision (${pp(chg)})${known.length ? `; cuts ran from ${_round(-known[known.length - 1].chg, 0)}% to ${_round(-known[0].chg, 0)}% a seat` : ''}${_fin(del) ? `, and ${_round(del, 0)}% of the old roll was struck off at the draft stage` : ''}${_fin(notice) ? `, and ${_round(notice, 0)}% of those left were sent a notice to prove eligibility` : ''}.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'wardcouncil', title: 'Who holds the ward', icon: '🏛️',
            question: 'Which party runs the municipal wards here, and does it match the MLA?',
            field: { key: 'ward_party', label: 'Party holding the ward (latest corporation election)', unit: 'party', higherIs: null, ramp: 'viridis', domain: [0, 20] },
            needs: ['ward_results.corp_ward_no', 'ward_results.corp_party_id', 'ward_results.corp_seats', 'ward_results.corp_lead_seats', 'ward_results.corp_margin_pct', 'ward_results.corp_turnout_pct', 'ward_results.corp_year', 'assembly_results.mla_party_id', 'population.population'],
            method: `Corporation election results from the State Election Commissions (via data.opencity.in, public domain): Pune Municipal Corporation 2026, where 41 prabhags elect four or five councillors each, joined through PMC's 2025 electoral ward map; and GHMC 2020 in Hyderabad, 150 single-member wards with the margin over the runner-up and turnout, joined through the GHMC ward map (whose names agree with the results). A multi-member ward is shown under the party holding most of its seats. The MLA comparison uses the assembly results lens's party for most of each ward's residents. Other cities are left out until a result file and a ward map of the same delimitation are both public (Mumbai's 2026 results have no 227-ward map; Delhi's 2022 results have no 250-ward map). Candidate names are not kept.`,
            refs: 'State Election Commission of Maharashtra (PMC 2026) and Telangana (GHMC 2020) results via data.opencity.in; PMC 2025 electoral ward map and GHMC ward map (OpenCity)' },
        { id: 'citycrime', equity: true, title: 'Recorded crime in the city', icon: '🚓',
            question: 'How much crime do police record here, how fast is cyber crime growing, and how many cases reach a charge sheet?',
            field: { key: 'crime_rate', label: 'Cognizable crimes per lakh people (police city, 2024)', unit: 'per lakh', higherIs: 'worse', ramp: 'reds', domain: [100, 1800] },
            needs: [...CR_KEYS.map(k => `city_crime.cr_${k}`), 'population.population'],
            method: `NCRB's Crime in India 2024 tables for the 19 metropolitan cities (cities of 20 lakh or more in 2011; via data.opencity.in, public domain): cognizable crimes registered under the IPC/BNS and special and local laws for 2022-2024, the 2024 rate per lakh people, the share of cases the police charge-sheeted, and crimes against women, children and people 60 or older, economic offences and cyber crime. NCRB divides by the 2011 census population, so rates run high in cities that have grown since. Figures are for the police commissionerate, not the map box, so the map shows one value across the city. Recorded crime depends on how readily police register cases (Delhi registers most theft complaints as e-FIRs; Kolkata registers few), so read it as recorded, not as the crime that happened. Bhopal and Guna are not among the 19 cities. Tables on crimes against Scheduled Castes and Tribes are not read.`,
            refs: 'National Crime Records Bureau, Crime in India 2024, metropolitan-city tables 1B.1, 1B.3, 3B.1, 4B.1, 6B.1, 8B.2 and 9B.1 (via data.opencity.in)' },
        { id: 'rollrevision', title: 'Voter roll revision 2026', icon: '📋',
            question: 'How many electors did the 2026 roll revision remove from the seats here?',
            field: { key: 'roll_change', label: 'Change in electors, 2024 to the final 2026 roll', unit: '%', higherIs: null, ramp: 'viridis', domain: [-50, 0] },
            needs: ['roll_revision.sir_ac', 'roll_revision.sir_electors', 'roll_revision.sir_electors_2024', 'roll_revision.sir_change_pct', 'roll_revision.sir_women_per_1000', 'roll_revision.sir_draft_change_pct', 'roll_revision.sir_deleted_pct',
                ...SIR_WHY.map(([k]) => `roll_revision.sir_${k}_pct`), 'roll_revision.sir_notice_pct', 'population.population'],
            method: `Seat-wise elector counts from the Chief Electoral Officers after the Election Commission's 2026 Special Intensive Revision (via data.opencity.in, public domain): West Bengal (draft January 2026, final at the 2026 nominations), Tamil Nadu (draft-stage deletions by reason, final April 2026) and Karnataka (final October 2026, with the notices sent to electors who could not be linked to an earlier roll). The 2024 count is the Election Commission's assembly-segment table for the Lok Sabha election. Seats are joined to blocks through the constituencies dataset by number and name; seats cut by the view edge count whole. Shares are weighted by each seat's final electors. A smaller roll can mean dead, moved or duplicate entries removed, or eligible people left off; the counts alone cannot tell which. No names or addresses are read.`,
            refs: 'Chief Electoral Officers of West Bengal, Tamil Nadu and Karnataka, SIR 2026 seat-wise rolls (via data.opencity.in); Election Commission of India 2024 Lok Sabha assembly-segment results' },
        { id: 'spending', equity: true, title: 'What households spend', icon: '🧾',
            question: 'How much do households here spend a month, and how much of it goes on food and rent?',
            field: { key: 'mpce', label: 'Monthly consumption per person, urban households (HCES 2023-24)', unit: '₹', higherIs: null, ramp: 'viridis', domain: [5000, 15000] },
            needs: ['hces.hc_mpce', 'hces.hc_mpce_median', ...HC_SHARES.map(([k]) => `hces.hc_${k}_pct`), 'hces.hc_renters_pct', 'hces.hc_rent', 'hces.hc_top_bottom', 'hces.hc_gini', 'hces.hc_households', 'population.population'],
            method: `MoSPI's Household Consumption Expenditure Survey 2023-24 household files for the city's districts (via data.opencity.in, public domain), urban households only, with the survey's weights. Each household's item-group values are turned to a month from their recall period (7 days for milk, vegetables, fruit, meat, oil, spices, drinks and processed food; a year for education, hospitalisation, clothing and durables; 30 days for the rest), imputed rent of owned homes is left out and free items from welfare schemes are not valued, as in MoSPI's MPCE without imputation (this gives Delhi ₹8,542). Rent is what renting households paid. The survey is about 1,000-3,000 urban households a city, so one value covers the whole city; the religion, caste and occupation fields are not read.`,
            refs: 'MoSPI Household Consumption Expenditure Survey 2023-24 unit-level data (via data.opencity.in)' },
        { id: 'roaddeaths', equity: true, title: 'Road deaths in the city', icon: '🚑',
            question: 'How many people die on the roads here, who are they, and is it getting worse?',
            field: { key: 'deaths_per100', label: 'Road deaths per 100 crashes (police city, 2024)', unit: 'per 100', higherIs: 'worse', ramp: 'reds', domain: [5, 40] },
            needs: ['city_road_deaths.rd_killed_2024', 'city_road_deaths.rd_killed_2023', 'city_road_deaths.rd_crashes_2024', 'city_road_deaths.rd_injured_2024', 'city_road_deaths.rd_rank_killed_2024', 'city_road_deaths.rd_per100', 'city_road_deaths.rd_per100_median',
                ...RD_USERS.map(([k]) => `city_road_deaths.rd_${k}_pct`), ...RD_CAUSES.map(([k]) => `city_road_deaths.rd_${k}_pct`), 'population.population'],
            method: `The Ministry of Road Transport and Highways' Road Accidents in India 2024 (via data.opencity.in, public domain) tables 50 large cities: crashes, deaths and injuries for 2023 and 2024 with each city's rank, deaths by the road user killed, and deaths by the traffic violation the police recorded. Figures are for the police city area (Hyderabad's excludes Cyberabad and Rachakonda, for example), not the map box, so the map shows one value across the city. Deaths per 100 crashes measures how severe crashes are; cities that record fewer minor crashes look worse on it. Police put most deaths down to over-speeding in some cities and to "others" in others, so the cause shares say as much about recording as about causes. Guna is not among the 50 cities.`,
            refs: 'MoRTH Road Accidents in India 2024 (city tables) via data.opencity.in' },
        { id: 'mlaseats', title: 'Who holds the assembly seat', icon: '🗳️',
            question: 'Which party holds the assembly seats here, and how close were the races?',
            field: { key: 'seat_margin', label: 'Assembly winning margin (latest state election)', unit: 'points', higherIs: null, ramp: 'viridis', domain: [0, 40] },
            needs: ['assembly_results.mla_ac', 'assembly_results.mla_party_id', 'assembly_results.mla_margin_pct', 'assembly_results.mla_year', 'assembly_results.mp_party_id', 'population.population'],
            method: `The latest state assembly results from the Election Commission (via data.opencity.in, public domain): Delhi 2025, Maharashtra 2024 (Mumbai, Pune), West Bengal 2026 (Kolkata), Tamil Nadu 2026 (Chennai), Telangana 2023 (Hyderabad) and Karnataka 2023 (Bengaluru, general election only). Each seat's winner, runner-up and margin (a share of all votes, NOTA included) are joined to blocks through the constituencies dataset by seat number and name; seats of a neighbouring state are left out. Residents are GHSL's, reshared by census wards or 2024 electors where GHSL is known to be off. The split count compares the MLA's party with the party of the Lok Sabha member elected in 2024 for most of the seat's residents. Seats cut by the view edge count only the part in view.`,
            refs: 'Election Commission of India assembly results (Delhi 2025, Maharashtra 2024, West Bengal 2026, Tamil Nadu 2026, Telangana 2023, Karnataka 2023) via data.opencity.in; constituency maps from the state governments (OpenCity) and DataMeet' },
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
            method: `BBMP work orders for 2018-19 to 2022-23 (gross amounts, via data.opencity.in, public domain), categorised by OpenCity and summed per assembly constituency. Work tagged to several wards or none (₹8,023 crore, about a third) is left out, so the figures cover ward-level works only. Constituency totals are joined to blocks inside both the constituency (2008 delimitation map) and the corporation's ward map, and divided by residents in those blocks (GHSL, which in Bengaluru is reshared by each GBA ward's electors on the January 2026 roll because GHSL alone puts far too few people in the south and east) and by five years. Roads combine "roads and infrastructure" with "roads and drains". The rank match is a Spearman correlation across constituencies between storm-water drain orders per resident and the residents-weighted rain waterlogging index. Work orders are commitments, not money spent or work done.`,
            refs: 'BBMP work orders categorised by ward and constituency, 2018-2023, via data.opencity.in; Election Commission of India assembly constituency maps (2008 delimitation, DataMeet)' },
        { id: 'fringevillages', equity: true, title: 'Services in the fringe villages', icon: '🏡',
            question: 'Do the villages the city is spreading into have piped water, drains and buses yet?',
            field: { key: 'piped_water_pct', label: 'Village households with a piped water connection (2020)', unit: '%', higherIs: 'better', ramp: 'viridis', domain: [0, 100] },
            needs: ['village_services.ma_village_no', 'village_services.ma_households', 'village_services.ma_piped_pct', 'village_services.ma_kuccha_pct', 'village_services.ma_no_latrine_pct', 'village_services.ma_drain', 'village_services.ma_bus', 'village_services.ma_phc_km', 're_supply.new_floor_m2', 'population.population'],
            method: `Mission Antyodaya 2020 (Ministry of Rural Development, via data.opencity.in, public domain): a survey of every rural village and habitation, here the villages of Bengaluru Urban and Pune districts (Ahmedabad's box has too few villages left rural). The survey carries 2011 village codes but the Survey of India village maps do not, so rows are matched to map villages by name within the same tehsil (spelling-normalised; close spellings only when the first two letters agree) and several rows of one village are summed; about a third of Bengaluru's mapped villages and almost half of Pune's match, the rest being villages since swallowed by the city or spelt too differently to match safely. Shares are households-weighted. Drains are coded 1 closed, 2 open and covered, 3 open pucca, ${DRAIN_BAD} open kuccha, 5 none; health-centre distance is the midpoint of the survey's band. New floor space is the floor area added 2016-2023 (re_supply, from Open Buildings 2.5D Temporal). Village-reported counts are self-declared and some are rounded, so read them as the village's own account.`,
            refs: 'Ministry of Rural Development, Mission Antyodaya 2020 village survey (via data.opencity.in); Survey of India village maps (via data.opencity.in)' },
        { id: 'healthnow', equity: true, title: 'Health now (NFHS-6)', icon: '📈',
            question: 'Has blood sugar, weight, blood pressure or child stunting got better or worse since the last health survey?',
            field: { key: 'sugar_women_urban', label: "Women with raised blood sugar, the state's towns and cities (NFHS-6 2023-24)", unit: '%', higherIs: 'worse', ramp: 'viridis', domain: [10, 35] },
            needs: ['nfhs6.n6u_sugar_women', 'nfhs6.n6_sugar_women', 'nfhs6.n5_sugar_women', 'nfhs6.n6u_sugar_men', 'nfhs6.n6_sugar_men', 'nfhs6.n5_sugar_men', 'nfhs6.n6u_women_obese', 'nfhs6.n6_women_obese', 'nfhs6.n5_women_obese', 'nfhs6.n6u_men_obese', 'nfhs6.n6_men_obese', 'nfhs6.n5_men_obese', 'nfhs6.n6u_bp_women', 'nfhs6.n6_bp_women', 'nfhs6.n5_bp_women', 'nfhs6.n6u_bp_men', 'nfhs6.n6_bp_men', 'nfhs6.n5_bp_men', 'nfhs6.n6u_stunted', 'nfhs6.n6_stunted', 'nfhs6.n5_stunted', 'nfhs6.n6u_wasted', 'nfhs6.n6_wasted', 'nfhs6.n5_wasted', 'nfhs6.n6u_insurance', 'nfhs6.n6_insurance', 'nfhs6.n5_insurance', 'nfhs.sugar_women_pct', 'nfhs.sugar_men_pct', 'nfhs.women_obese_pct', 'nfhs.bp_women_pct', 'nfhs.bp_men_pct', 'nfhs.stunted_pct', 'nfhs.wasted_pct', 'nfhs.insurance_pct', 'population.population'],
            method: `National Family Health Survey 2023-24 (NFHS-6) state fact sheets (IIPS and the Ministry of Health, via data.opencity.in, public domain), which give each indicator for the state's urban areas, rural areas and the whole state, with the state's 2019-21 (NFHS-5) value alongside. District fact sheets for NFHS-6 are not out yet, so the city's own figures are its NFHS-5 districts weighted by residents (nfhs). Raised blood sugar is over 140 mg/dl or taking medicine; raised blood pressure is 140/90 mm Hg or more or taking medicine; overweight is a BMI of 25 or more. The state's towns and cities are not this city alone, and the change from 2019-21 is for the whole state. Available for states whose NFHS-6 sheets are published (Karnataka, Maharashtra, Tamil Nadu, Telangana, West Bengal, Gujarat).`,
            refs: 'NFHS-6 (2023-24) state fact sheets, IIPS and MoHFW (via data.opencity.in); NFHS-5 (2019-21) district fact sheets' },
    ];

    UrbanLenses.register(ENTRIES, { homes2011, lowground, feelslike, civicworks, fringevillages, healthnow, mlaseats, roaddeaths, spending, rollrevision, citycrime, wardcouncil });
    return { ENTRIES };
})();
