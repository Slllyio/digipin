/**
 * Ward records and ground lenses for UrbanLenses: official counts kept by ward (Census 2011 houselisting and households)
 * and the bare-earth ground homes stand on by the sea. Registers itself on load, after urban-lenses.js. Started when
 * urban-lenses-commons.js reached the 150 kB per-module budget.
 */
const UrbanLensesWards = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _residents, wmean, wquantile } = UrbanLenses._kit;

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

    // Measured lake water. KSPCB's monthly samples of Bengaluru's lakes; each block within 2 km takes its nearest lake.
    function lakewater(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`lake_water.lw_${k}`];
        const es = col('e_share'), dox = col('do'), fc = col('fc'), eN = col('e_lakes_2km'), pop = c['population.population'];
        if (!es || !es.some(_fin)) return null;
        const all = _residents(fr), idx = all.filter(i => _fin(es[i]));
        if (idx.length < 5) return null;
        const P = all.reduce((s, i) => s + pop[i], 0) || 1, Pn = idx.reduce((s, i) => s + pop[i], 0);
        const sum = pred => idx.filter(pred).reduce((s, i) => s + pop[i], 0);
        const bad = sum(i => es[i] > 50), lowO = dox ? sum(i => _fin(dox[i]) && dox[i] < 4) : NaN, ringed = eN ? sum(i => eN[i] >= 2) : NaN;
        const medFc = fc ? wquantile(fc, pop, idx.filter(i => _fin(fc[i])), 0.5) : NaN;
        const stats = [
            { label: 'Residents within 2 km of a monitored lake', value: `${_people(Pn)} (${_round(100 * Pn / P, 0)}%)` },
            { label: 'Of them, nearest lake in class E (unfit even for fish) most months', value: `${_people(bad)} (${_round(100 * bad / (Pn || 1), 0)}%)` },
            { label: 'Of them, nearest lake below 4 mg/L dissolved oxygen on average', value: _fin(lowO) ? `${_people(lowO)} (${_round(100 * lowO / (Pn || 1), 0)}%)` : 'n/a' },
            { label: 'Of them, two or more class-E lakes within 2 km', value: _fin(ringed) ? `${_people(ringed)}` : 'n/a' },
            { label: 'Faecal coliform at the nearest lake, middle resident', value: _fin(medFc) ? `${Math.round(medFc).toLocaleString('en-IN')} MPN/100 ml (bathing limit 500)` : 'n/a' },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = es[i];
        return {
            columns: { lake_e_share: out }, idx, weightKey: 'lake_e_share', noHotspots: false,
            metric: { label: 'Samples in class E at the nearest monitored lake (residents-weighted)', value: _round(wmean(es, pop, idx), 0), unit: '%', higherIs: 'worse' },
            headline: `${_people(Pn)} residents here live within 2 km of a lake KSPCB samples every month. For ${_people(bad)} of them (${_round(100 * bad / (Pn || 1), 0)}%) the nearest lake was class E, fit only for irrigation and industrial cooling, in most samples${_fin(medFc) ? `, and the middle resident's lake carried ${Math.round(medFc).toLocaleString('en-IN')} faecal coliform per 100 ml, a sign of sewage` : ''}.`,
            stats,
        };
    }

    // Groundwater quality. Karnataka Ground Water Directorate observation wells; each block takes its nearest well.
    function wellwater(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`well_quality.wq_${k}`];
        const no3 = col('no3'), prev = col('no3_prev'), f = col('f'), th = col('th'), km = col('km'), pop = c['population.population'];
        if (!no3 || !no3.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(no3[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((s, i) => s + pop[i], 0) || 1, sum = pred => idx.filter(pred).reduce((s, i) => s + pop[i], 0);
        const over = sum(i => no3[i] > 45), hard = th ? sum(i => th[i] > 600) : NaN, rose = prev ? sum(i => _fin(prev[i]) && no3[i] > prev[i]) : NaN;
        const med = wquantile(no3, pop, idx, 0.5), medKm = wquantile(km, pop, idx, 0.5);
        const stats = [
            { label: 'Nitrate at the nearest well, middle resident', value: `${_round(med, 0)} mg/L (limit 45)` },
            { label: 'Residents nearest a well over the nitrate limit', value: `${_people(over)} (${_round(100 * over / P, 0)}%)` },
            { label: 'Residents whose nearest well got more nitrate from 2017-18 to 2018-19', value: _fin(rose) ? `${_people(rose)} (${_round(100 * rose / P, 0)}%)` : 'n/a' },
            { label: 'Fluoride at the nearest well, highest in view', value: f ? `${_round(Math.max(...idx.map(i => (_fin(f[i]) ? f[i] : 0))), 2)} mg/L (limit 1.5)` : 'n/a' },
            { label: 'Residents nearest a well harder than 600 mg/L', value: _fin(hard) ? `${_people(hard)} (${_round(100 * hard / P, 0)}%)` : 'n/a' },
            { label: 'Distance to the nearest observation well, middle resident', value: `${_round(medKm, 1)} km` },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = no3[i];
        return {
            columns: { well_no3: out }, idx, weightKey: 'well_no3', noHotspots: true,
            metric: { label: 'Nitrate at the nearest observation well (middle resident)', value: _round(med, 0), unit: 'mg/L', higherIs: 'worse' },
            headline: `${_people(over)} residents here (${_round(100 * over / P, 0)}%) live nearest a government observation well whose groundwater had more nitrate than the 45 mg/L drinking-water limit in 2018-19; the middle resident's well read ${_round(med, 0)} mg/L, ${_round(medKm, 1)} km away. Nitrate in city groundwater mostly comes from leaking sewers and septic tanks; test a borewell before drinking from it.`,
            stats,
        };
    }

    // Measured air. KSPCB's monthly reports for its continuous stations in Bengaluru; each block takes its nearest station.
    function measuredair(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`air_measured.am_${k}`];
        const p25 = col('pm25'), p10 = col('pm10'), no2 = col('no2'), km = col('km'), over = col('pm10_months_over'), pop = c['population.population'];
        if (!p25 || !p25.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(p25[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((s, i) => s + pop[i], 0) || 1;
        const a25 = wmean(p25, pop, idx), a10 = wmean(p10, pop, idx), aNo2 = no2 ? wmean(no2, pop, idx.filter(i => _fin(no2[i]))) : NaN;
        const mo = col('months'), nMonths = mo ? Math.max(...idx.map(i => (_fin(mo[i]) ? mo[i] : 0))) || NaN : NaN;
        const allYear = idx.filter(i => over && mo && over[i] >= mo[i]).reduce((s, i) => s + pop[i], 0);
        const far = idx.filter(i => km[i] > 5).reduce((s, i) => s + pop[i], 0);
        const worst = idx.reduce((b, i) => (p25[i] > p25[b] ? i : b), idx[0]), best = idx.reduce((b, i) => (p25[i] < p25[b] ? i : b), idx[0]);
        const stats = [
            { label: 'PM2.5 at the nearest station, average of the months measured (residents-weighted)', value: `${_round(a25, 1)} µg/m³ (national annual standard 40, WHO 5)` },
            { label: 'PM10 / NO2 at the nearest station, average of the months measured', value: `${_round(a10, 0)} / ${_fin(aNo2) ? _round(aNo2, 0) : 'n/a'} µg/m³` },
            { label: 'Highest / lowest PM2.5 station serving residents in view', value: `${_round(p25[worst], 1)} / ${_round(p25[best], 1)} µg/m³` },
            { label: 'Residents whose station was over the PM10 standard in every month measured', value: `${_people(allYear)} (${_round(100 * allYear / P, 0)}%)` },
            { label: 'Residents more than 5 km from any continuous station', value: `${_people(far)} (${_round(100 * far / P, 0)}%)` },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = p25[i];
        return {
            columns: { measured_pm25: out }, idx, weightKey: 'measured_pm25', noHotspots: true,
            metric: { label: 'PM2.5 measured at the nearest station, average of the months measured', value: _round(a25, 1), unit: 'µg/m³', higherIs: 'worse' },
            headline: `Over the ${_fin(nMonths) ? `${nMonths} months` : 'period'} measured, the stations nearest to residents here averaged ${_round(a25, 1)} µg/m³ of PM2.5 and ${_round(a10, 0)} µg/m³ of PM10, ${a25 > 40 ? 'above' : 'within'} the national PM2.5 standard of 40 but ${_round(a25 / 5, 0)} times the WHO guideline. ${allYear > 0 ? `${_people(allYear)} residents (${_round(100 * allYear / P, 0)}%) live nearest a station whose PM10 was over the national standard in every month measured, and ` : 'No nearby station was over the PM10 standard in every month measured; '}${_round(100 * far / P, 0)}% live more than 5 km from any station.`,
            stats,
        };
    }

    // Piped-water storage. Chennai Metrowater's overhead and underground tanks and lorry filling posts.
    function waterstorage(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`water_storage.ws_${k}`];
        const lpr = col('l_per_res'), km = col('tank_km'), fk = col('fill_km'), pop = c['population.population'];
        if (!km || !km.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(km[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((s, i) => s + pop[i], 0) || 1;
        const far = idx.filter(i => km[i] > 3), farPop = far.reduce((s, i) => s + pop[i], 0);
        const withL = idx.filter(i => lpr && _fin(lpr[i]));
        const medL = withL.length ? wquantile(lpr, pop, withL, 0.5) : NaN, lowL = withL.length ? wquantile(lpr, pop, withL, 0.1) : NaN;
        const medKm = wquantile(km, pop, idx, 0.5), fillNear = fk ? idx.filter(i => fk[i] <= 1).reduce((s, i) => s + pop[i], 0) : NaN;
        const stats = [
            { label: 'Distance to the nearest Metrowater tank, middle resident', value: `${_round(medKm, 1)} km` },
            { label: 'Residents more than 3 km from a tank', value: `${_people(farPop)} (${_round(100 * farPop / P, 0)}%)` },
            { label: 'Tank capacity within 2 km per resident: middle / bottom tenth', value: `${_round(medL, 0)} / ${_round(lowL, 0)} litres` },
            { label: 'Residents within 1 km of a water-lorry filling post', value: _fin(fillNear) ? `${_people(fillNear)} (${_round(100 * fillNear / P, 0)}%)` : 'n/a' },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of withL) out[i] = lpr[i];
        return {
            columns: { storage_lpr: out }, idx: withL.length >= 5 ? withL : idx, weightKey: 'storage_lpr', noHotspots: false,
            metric: { label: 'Tank storage within 2 km per resident (middle resident)', value: _round(medL, 0), unit: 'litres', higherIs: 'better' },
            headline: `The middle resident here is ${_round(medKm, 1)} km from a Metrowater storage tank, and tanks within 2 km hold ${_round(medL, 0)} litres per person living around them (${_round(lowL, 0)} litres for the worst-served tenth). ${_people(farPop)} residents (${_round(100 * farPop / P, 0)}%) are more than 3 km from any tank.`,
            stats,
        };
    }

    // Trees approved for felling. Forest Department notices in Bengaluru, placed at each project's site or alignment.
    const TF_KIND = ['', 'metro', 'rail', 'road', 'defence', 'public building or campus', 'drain, power line or plant'];

    function treefelling(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`tree_felling.tf_${k}`];
        const t2 = col('trees_2km'), km = col('km'), kind = col('kind_nearest'), tn = col('trees_nearest'), pop = c['population.population'];
        if (!t2 || !t2.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(t2[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((s, i) => s + pop[i], 0) || 1;
        const near = idx.filter(i => t2[i] > 0), nearPop = near.reduce((s, i) => s + pop[i], 0);
        const byKind = new Map();
        for (const i of near) { const k = TF_KIND[kind[i]] || 'other'; byKind.set(k, (byKind.get(k) || 0) + pop[i]); }
        const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]);
        const top = idx.reduce((b, i) => (t2[i] > t2[b] ? i : b), idx[0]);
        const medKm = wquantile(km, pop, idx, 0.5), avg = wmean(t2, pop, idx);
        const stats = [
            { label: 'Residents within 2 km of a felling project', value: `${_people(nearPop)} (${_round(100 * nearPop / P, 0)}%)` },
            { label: 'Trees in notices within 2 km, residents-weighted', value: `${Math.round(avg).toLocaleString('en-IN')}` },
            { label: 'Distance to the nearest project, middle resident', value: `${_round(medKm, 1)} km` },
            { label: `Most trees within 2 km of one block (${g.codes[top]})`, value: `${Math.round(t2[top]).toLocaleString('en-IN')} trees; nearest project ${TF_KIND[kind[top]] || 'n/a'}, ${Math.round(tn[top]).toLocaleString('en-IN')} trees` },
            ...kinds.slice(0, 4).map(([k, p]) => ({ label: `Residents whose nearest project is ${k}`, value: _people(p) })),
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = t2[i];
        return {
            columns: { trees_felled: out }, idx, weightKey: 'trees_felled', noHotspots: false,
            metric: { label: 'Trees in felling notices within 2 km (residents-weighted)', value: Math.round(avg), unit: 'trees', higherIs: 'worse' },
            headline: `${_people(nearPop)} residents here (${_round(100 * nearPop / P, 0)}%) live within 2 km of a project the Forest Department has cleared to fell trees${kinds.length ? `, most often for ${kinds[0][0]}` : ''}. The worst-hit block has ${Math.round(t2[top]).toLocaleString('en-IN')} trees in notices within 2 km; the middle resident is ${_round(medKm, 1)} km from the nearest project.`,
            stats,
        };
    }

    // District development indicators (Maharashtra economic survey): banking, electricity, schools and child health of
    // the district most residents in view live in.
    function _mainDistrict(fr, key) {
        const c = fr.cols, k = c[key], pop = c['population.population'];
        if (!k || !k.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(k[i]));
        if (idx.length < 5) return null;
        const D = new Map();
        for (const i of idx) { const s = `${k[i]}`; const a = D.get(s) || { pop: 0, first: i }; a.pop += pop[i]; D.set(s, a); }
        const ds = [...D.values()].sort((a, b) => b.pop - a.pop), P = idx.reduce((t, i) => t + pop[i], 0) || 1;
        return { idx, ds, P, main: ds[0].first };
    }

    function districtdev(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`district_dev.dd_${k}`];
        const m = _mainDistrict(fr, 'district_dev.dd_banks_lakh');
        if (!m) return null;
        const { idx, ds, P, main } = m, pop = c['population.population'], banks = col('banks_lakh');
        const v = (k, i = main) => (col(k) && _fin(col(k)[i]) ? col(k)[i] : NaN);
        const rs = x => `₹${Math.round(x).toLocaleString('en-IN')}`, r0 = x => _round(x, 0), avg = wmean(banks, pop, idx);
        const has = k => _fin(v(k));
        const parts = [
            `${_round(v('banks_lakh'), 1)} bank branches and ${r0(v('atms_lakh'))} ATMs per lakh people`,
            has('deposit_pc') ? `deposits of ${rs(v('deposit_pc'))} and loans of ${rs(v('credit_pc'))} per head` : '',
            has('elec_home_kwh') ? `homes using ${r0(v('elec_home_kwh'))} kWh of electricity per head a year` : '',
            has('schools_lakh') ? `${r0(v('schools_lakh'))} schools per lakh people` : '',
        ].filter(Boolean);
        const health = [has('imr') ? `${_round(v('imr'), 1)} infant deaths per 1,000 births` : '', has('underweight_pct') ? `${_round(v('underweight_pct'), 1)}% of under-fives underweight` : ''].filter(Boolean);
        const stats = [
            ...ds.slice(0, 4).map(a => ({ label: `District at ${g.codes[a.first]} (${r0(100 * a.pop / P)}% of residents): bank branches / ATMs per lakh`, value: `${_round(v('banks_lakh', a.first), 1)} / ${r0(v('atms_lakh', a.first))}` })),
            { label: 'Deposits / credit per head (credit-deposit ratio)', value: has('deposit_pc') ? `${rs(v('deposit_pc'))} / ${rs(v('credit_pc'))} (${r0(v('cd_ratio'))}%)` : 'n/a' },
            { label: 'Electricity per head a year: homes / commercial / industry', value: `${r0(v('elec_home_kwh'))} / ${r0(v('elec_comm_kwh'))} / ${r0(v('elec_ind_kwh'))} kWh` },
            { label: 'Schools per lakh people / pupils per teacher (Std I-VII)', value: `${has('schools_lakh') ? r0(v('schools_lakh')) : 'n/a'} / ${has('ptr_elem') ? r0(v('ptr_elem')) : 'n/a'}` },
            { label: 'Registered factories / their workers (ASI 2023-24)', value: has('factories') ? `${r0(v('factories')).toLocaleString('en-IN')} / ${_people(v('factory_workers'))}` : 'n/a' },
            { label: 'Motor vehicles per lakh people', value: has('vehicles_lakh') ? r0(v('vehicles_lakh')).toLocaleString('en-IN') : 'n/a' },
            { label: 'Infant deaths per 1,000 births / under-fives underweight', value: `${has('imr') ? _round(v('imr'), 1) : 'n/a'} / ${has('underweight_pct') ? `${_round(v('underweight_pct'), 1)}%` : 'n/a'}` },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = banks[i];
        return {
            columns: { district_banks: out }, idx, weightKey: 'district_banks', noHotspots: true,
            metric: { label: 'Bank branches per lakh people (district, residents-weighted)', value: _round(avg, 1), unit: 'per lakh', higherIs: 'better' },
            headline: `Most residents here live in a district with ${parts.join(', ')}${health.length ? `; ${health.join(' and ')}` : ''}${ds.length > 1 ? `. The ${ds.length} districts in view average ${_round(avg, 1)} branches per lakh` : ''}.`,
            stats,
        };
    }

    // Small businesses, informal workers and Class 10 results (Karnataka economic survey) for the district.
    function smallbiz(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`district_dev.dd_${k}`];
        const m = _mainDistrict(fr, 'district_dev.dd_msme_units');
        if (!m) return null;
        const { idx, ds, P, main } = m, ss = col('sslc_pass_pct');
        const v = (k, i = main) => (col(k) && _fin(col(k)[i]) ? col(k)[i] : NaN), r0 = x => _round(x, 0);
        const units = v('msme_units'), jobs = v('msme_jobs'), pass = v('sslc_pass_pct'), prev = v('sslc_pass_2024'), esh = v('eshram_pct');
        const stats = [
            ...ds.slice(0, 4).map(a => ({ label: `District at ${g.codes[a.first]} (${r0(100 * a.pop / P)}% of residents): registered MSMEs / jobs`, value: `${_people(v('msme_units', a.first))} / ${_people(v('msme_jobs', a.first))}` })),
            { label: 'Jobs per registered enterprise', value: _fin(jobs) && units ? _round(jobs / units, 1) : 'n/a' },
            { label: 'Class 10 (SSLC) pass rate, 2025 / 2024', value: _fin(pass) ? `${_round(pass, 1)}% / ${_round(prev, 1)}%` : 'n/a' },
            { label: 'Unorganised workers on eShram, % of the target', value: _fin(esh) ? `${_round(esh, 1)}%` : 'n/a' },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = ss && _fin(ss[i]) ? ss[i] : NaN;
        return {
            columns: { sslc_pass: out }, idx, weightKey: 'sslc_pass', noHotspots: true,
            metric: { label: 'Class 10 pass rate, 2025 (district)', value: _round(pass, 1), unit: '%', higherIs: 'better' },
            headline: `Most residents here live in a district with ${_people(units)} registered micro, small and medium enterprises reporting ${_people(jobs)} jobs${_fin(pass) ? `; ${_round(pass, 1)}% of Class 10 students passed in 2025${_fin(prev) ? ` (${_round(prev, 1)}% in 2024)` : ''}` : ''}${_fin(esh) ? `, and ${r0(esh)}% of its target of unorganised workers have signed up to eShram` : ''}.`,
            stats,
        };
    }

    // District income per head. State economic surveys' district tables: per capita income and the district's rank in
    // its state.
    function districtincome(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`district_income.di_${k}`];
        const pci = col('pci'), pop = c['population.population'];
        if (!pci || !pci.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(pci[i]));
        if (idx.length < 5) return null;
        const D = new Map();
        for (const i of idx) { const k = `${pci[i]}`; const a = D.get(k) || { pop: 0, first: i }; a.pop += pop[i]; D.set(k, a); }
        const P = idx.reduce((t, i) => t + pop[i], 0) || 1, ds = [...D.values()].sort((a, b) => b.pop - a.pop);
        const v = (k, i) => (col(k) && _fin(col(k)[i]) ? col(k)[i] : NaN);
        const rs = x => `₹${Math.round(x).toLocaleString('en-IN')}`, avg = wmean(pci, pop, idx);
        const yr = y => (_fin(y) ? `${y}-${String((y + 1) % 100).padStart(2, '0')}` : 'n/a');
        const main = ds[0].first, med = v('pci_median', main);
        const stats = [
            { label: 'Per capita income, residents-weighted across districts in view', value: `${rs(avg)} a year` },
            ...ds.slice(0, 5).map(a => ({ label: `District at ${g.codes[a.first]} (${pc(a.pop / P)} of residents, ${yr(v('year', a.first))})`, value: `${rs(pci[a.first])} · rank ${Math.round(v('rank', a.first))} of ${Math.round(v('districts', a.first))} in the state` })),
            { label: "Median district's per capita income in the state", value: _fin(med) ? rs(med) : 'n/a' },
            { label: 'Real GDP growth a year of the main district', value: _fin(v('growth_pct', main)) ? `${_round(v('growth_pct', main), 1)}% since ${yr(v('growth_from', main))}` : 'n/a' },
        ];
        function pc(x) { return `${_round(100 * x, 0)}%`; }
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = pci[i];
        const top = pci[main], times = _fin(med) && med ? top / med : NaN;
        return {
            columns: { district_pci: out }, idx, weightKey: 'district_pci', noHotspots: true,
            metric: { label: 'District per capita income (residents-weighted)', value: Math.round(avg), unit: '₹/yr', higherIs: 'better' },
            headline: `Most residents here live in a district with a per capita income of ${rs(top)} a year (${yr(v('year', main))}), rank ${Math.round(v('rank', main))} of ${Math.round(v('districts', main))} in the state${_fin(times) ? ` and ${_round(times, 1)} times the state's median district` : ''}${_fin(v('growth_pct', main)) ? `; its economy grew ${_round(v('growth_pct', main), 1)}% a year in real terms from ${yr(v('growth_from', main))}` : ''}${ds.length > 1 ? `. Across the ${ds.length} districts in view it averages ${rs(avg)}` : ''}.`,
            stats,
        };
    }

    // Groundwater stress. CGWB's 2025 district assessment: pumping as a share of what the aquifer can give each year.
    const GW_CLASS = ['', 'safe', 'semi-critical', 'critical', 'over-exploited'];

    function gwstress(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`gw_district.gw_${k}`];
        const st = col('stage_pct'), cl = col('class'), pop = c['population.population'];
        if (!st || !st.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(st[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((t, i) => t + pop[i], 0) || 1, pc = x => `${_round(100 * x, 0)}%`;
        const by = [0, 0, 0, 0, 0];
        for (const i of idx) if (_fin(cl?.[i])) by[cl[i]] += pop[i];
        const stage = wmean(st, pop, idx), dom = wmean(col('domestic_pct') || [], pop, idx), ind = wmean(col('industry_pct') || [], pop, idx), irr = wmean(col('irrigation_pct') || [], pop, idx);
        const state = wmean(col('state_stage_pct') || [], pop, idx);
        const stats = [
            { label: 'Stage of groundwater extraction, residents-weighted (district, 2025)', value: `${_round(stage, 0)}%` },
            ...[4, 3, 2, 1].filter(k => by[k] > 0).map(k => ({ label: `Residents in ${GW_CLASS[k]} districts`, value: pc(by[k] / P) })),
            { label: 'Pumped for homes / industry / irrigation', value: `${_fin(dom) ? _round(dom, 0) : 'n/a'}% / ${_fin(ind) ? _round(ind, 0) : 'n/a'}% / ${_fin(irr) ? _round(irr, 0) : 'n/a'}%` },
            { label: 'Stage of extraction, whole state', value: _fin(state) ? `${_round(state, 0)}%` : 'n/a' },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = st[i];
        return {
            columns: { gw_stage: out }, idx, weightKey: 'gw_stage', noHotspots: true,
            metric: { label: 'Stage of groundwater extraction (district, 2025)', value: _round(stage, 0), unit: '%', higherIs: 'worse' },
            headline: `Districts here pump ${_round(stage, 0)}% of the groundwater their aquifers recharge in a year (residents-weighted)${by[4] ? `; ${pc(by[4] / P)} of residents live in over-exploited districts, where more is drawn than recharged` : ''}${_fin(dom) ? `, and homes take ${_round(dom, 0)}% of what is pumped` : ''}.`,
            stats,
        };
    }

    // Toll plazas. NHAI's 2024 toll plaza list (via OpenCity): the nearest plaza to each block and what a car pays there.
    function tollring(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, col = k => c[`tolls.toll_${k}`];
        const km = col('km'), pop = c['population.population'], code = col('code');
        if (!km || !km.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(km[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((t, i) => t + pop[i], 0) || 1;
        const share = d => idx.reduce((t, i) => t + (km[i] <= d ? pop[i] : 0), 0) / P;
        const med = wquantile(km, pop, idx, 0.5), car = wmean(col('car') || [], pop, idx), month = wmean(col('car_month') || [], pop, idx), count = wmean(c['tolls.tolls_25km'] || [], pop, idx);
        const rs = x => `₹${Math.round(x).toLocaleString('en-IN')}`, pc = x => `${_round(100 * x, 0)}%`;
        const by = new Map();
        if (code) for (const i of idx) { if (!_fin(code[i])) continue; const a = by.get(code[i]) || { pop: 0, first: i, best: Infinity }; a.pop += pop[i]; if (km[i] < a.best) { a.best = km[i]; a.first = i; } by.set(code[i], a); }
        const top = [...by.values()].sort((a, b) => b.pop - a.pop).slice(0, 3);
        const stats = [
            { label: 'Middle resident: distance to the nearest toll plaza', value: `${_round(med, 1)} km` },
            { label: 'Residents within 5 km / 10 km of a toll plaza', value: `${pc(share(5))} / ${pc(share(10))}` },
            { label: 'Car single journey / monthly pass at the nearest plaza (residents-weighted)', value: `${_fin(car) ? rs(car) : 'n/a'} / ${_fin(month) ? rs(month) : 'n/a'}` },
            { label: 'Toll plazas within 25 km, residents-weighted', value: _fin(count) ? String(_round(count, 1)) : 'n/a' },
            ...top.map((a, k) => ({ label: `Nearest plaza for most residents ${k + 1}: near ${g.codes[a.first]} (car single journey)`, value: `${pc(a.pop / P)} of residents · ${_fin(col('car')?.[a.first]) ? rs(col('car')[a.first]) : 'n/a'}` })),
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = km[i];
        return {
            columns: { toll_km: out }, idx, weightKey: 'toll_km', noHotspots: true,
            metric: { label: 'Distance to the nearest toll plaza (middle resident)', value: _round(med, 1), unit: 'km', higherIs: null },
            headline: `The middle resident lives ${_round(med, 1)} km from a toll plaza, and ${pc(share(5))} live within 5 km of one${_fin(car) ? `; a car pays ${rs(car)} a trip at the nearest plaza on average${_fin(month) ? `, or ${rs(month)} for a monthly pass` : ''}` : ''}.`,
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
        { id: 'lakewater', title: 'Measured lake water', icon: '🦆',
            question: 'How clean is the lake nearest to me, by the pollution board\'s monthly samples?',
            field: { key: 'lake_e_share', label: 'Samples in class E at the nearest monitored lake', unit: '%', higherIs: 'worse', ramp: 'reds', domain: [0, 100] },
            needs: ['lake_water.lw_e_share', 'lake_water.lw_do', 'lake_water.lw_fc', 'lake_water.lw_e_lakes_2km', 'population.population'],
            method: `KSPCB samples about 140 lakes and tanks in and around Bengaluru every month and publishes each sample's use-based class under the CPCB criteria (A drinking water without treatment, B bathing, C drinking after treatment, D fish and wildlife, E irrigation and industrial cooling only) with dissolved oxygen, BOD, faecal coliform and about 40 other readings. This lens reads the monthly reports on data.opencity.in that have a text layer (May to November 2025; earlier months are scans) and gives each block within 2 km of a placed lake the share of its nearest lake's samples that were class E, the lake's mean dissolved oxygen and median faecal coliform. The reports give no coordinates, so 88 of the 140 lakes were placed at their OpenStreetMap location by name; lakes whose name matched two water bodies were left out. Bengaluru only.`,
            refs: 'KSPCB monthly lake water quality reports, May to November 2025 (via data.opencity.in, public domain); CPCB use-based classification of surface waters; lake sites © OpenStreetMap contributors via Overture Maps' },
        { id: 'wellwater', title: 'Groundwater quality at the nearest well', icon: '🧫',
            question: 'Is the groundwater here safe to drink, by the government observation wells?',
            field: { key: 'well_no3', label: 'Nitrate at the nearest observation well, 2018-19', unit: 'mg/L', higherIs: 'worse', ramp: 'reds', domain: [10, 100] },
            needs: ['well_quality.wq_no3', 'well_quality.wq_no3_prev', 'well_quality.wq_f', 'well_quality.wq_th', 'well_quality.wq_km', 'population.population'],
            method: `The Karnataka Ground Water Directorate's yearly water quality tables for its observation wells in Bengaluru Urban (via data.opencity.in, public domain): nitrate, fluoride, iron and total hardness for 2018-19 and 2017-18, the latest on OpenCity. Each block takes its nearest 2018-19 well (31 wells with coordinates, so wells are several kilometres apart), and the 2017-18 nitrate of the same well where it was sampled both years. Limits are from the drinking water standard IS 10500: nitrate 45 mg/L, fluoride 1.5, iron 0.3, hardness 600. One well stands for a wide area and borewells draw from different depths, so treat the map as an indication, not a test of any one borewell. Bengaluru only.`,
            refs: 'Karnataka Ground Water Directorate, Bengaluru Urban taluk-wise ground water quality 2017-18 and 2018-19 (via data.opencity.in); BIS IS 10500:2012' },
        { id: 'measuredair', title: 'Measured air at the nearest station', icon: '🧪',
            question: 'What do the official air monitors near here actually measure over a year?',
            field: { key: 'measured_pm25', label: 'PM2.5 at the nearest station, average of the months measured', unit: 'µg/m³', higherIs: 'worse', ramp: 'reds', domain: [20, 45] },
            needs: ['air_measured.am_pm25', 'air_measured.am_pm10', 'air_measured.am_no2', 'air_measured.am_km', 'air_measured.am_pm10_months_over', 'air_measured.am_months', 'population.population'],
            method: `The Karnataka State Pollution Control Board's monthly air quality reports for its 11 continuous monitoring stations in Bengaluru (via data.opencity.in, public domain), the latest 12 months. Each report gives each station's monthly average of PM10, PM2.5 (nine stations), NO2 and other pollutants; the lens averages the 12 monthly means and gives every block its nearest station's values (PM2.5 from the nearest station that measures it). The national annual standards are 40 µg/m³ for PM2.5 and 60 for PM10; WHO's 2021 guideline for PM2.5 is 5. A station measures the air at one roadside or campus point, so blocks several kilometres away only inherit it; the satellite-based air lenses fill the gaps. Station sites are from KSPCB's station map. Chennai uses the Tamil Nadu Pollution Control Board's daily readings at its five stations (Kodungaiyur, Koyambedu, Manali, Perungudi, Royapuram) for January to August 2024, the latest published, averaged by month the same way; eight months without the north-east monsoon read lower than a full year would.`,
            refs: 'Karnataka State Pollution Control Board, monthly CAAQMS air quality reports, Bengaluru; Tamil Nadu Pollution Control Board daily readings, Chennai 2024 (via data.opencity.in)' },
        { id: 'waterstorage', equity: true, title: 'Piped-water storage tanks', icon: '🚰',
            question: 'Is there a Metrowater storage tank near here, and how much does it hold per person?',
            field: { key: 'storage_lpr', label: 'Tank storage within 2 km per resident', unit: 'litres', higherIs: 'better', ramp: 'viridis', domain: [0, 80] },
            needs: ['water_storage.ws_l_per_res', 'water_storage.ws_tank_km', 'water_storage.ws_fill_km', 'population.population'],
            method: `Chennai Metrowater's (CMWSSB) water distribution station asset maps on data.opencity.in (public domain): 278 overhead tanks and 148 underground reservoirs with their capacity (477 million litres in all), and 318 filling posts where water lorries load. For each block the lens adds the capacity of every tank within 2 km and divides it by the residents living within 2 km of that block, a rough measure of how much piped storage serves the neighbourhood. Tank sites are the centre of each tank's outline; one capacity entered in litres is corrected. Areas far from any tank, mostly the added suburbs, rely more on borewells and lorries. Storage is not supply: how often and how long water flows is not in the maps, and the old city is fed from a few large stations (Kilpauk, Anna Poonga, Triplicane head works) straight into the mains, so it can show little storage per resident without poor supply. Chennai only.`,
            refs: 'Chennai Metropolitan Water Supply and Sewerage Board, water distribution station assets (via data.opencity.in)' },
        { id: 'treefelling', title: 'Trees approved for felling', icon: '🪓',
            question: 'Are trees being cut for projects near here, and for what?',
            field: { key: 'trees_felled', label: 'Trees in felling notices within 2 km', unit: 'trees', higherIs: 'worse', ramp: 'reds', domain: [0, 2500] },
            needs: ['tree_felling.tf_trees_2km', 'tree_felling.tf_km', 'tree_felling.tf_trees_nearest', 'tree_felling.tf_kind_nearest', 'population.population'],
            method: `The Karnataka Forest Department's public notices and orders for felling trees in Bengaluru, as collected by data.opencity.in (public domain): 56 notices covering 25,386 trees for metro, suburban and main-line rail, road, defence, public-building and utility projects. The notices name the project and the number of trees but give no coordinates, so each project is placed by hand at its site, or at points along its alignment for metro, rail, roads and power lines, with the trees shared equally between those points (places from OpenStreetMap, ODbL). A block counts the trees at every point within 2 km. Two notices whose sites could not be found (a virology lab and a fire-service workshop) and a duplicate notice for the same metro package are left out. Notices are permissions, not a record of trees actually cut, and the collection is not complete.`,
            refs: 'Karnataka Forest Department tree-felling notices, Bengaluru (via data.opencity.in); OpenStreetMap' },
        { id: 'smallbiz', equity: true, title: 'Small businesses and Class 10 results', icon: '🏭',
            question: 'How many small businesses and jobs does this district have, and how do its students do?',
            field: { key: 'sslc_pass', label: 'Class 10 (SSLC) pass rate, 2025 (district)', unit: '%', higherIs: 'better', ramp: 'viridis', domain: [60, 95] },
            needs: ['district_dev.dd_msme_units', 'district_dev.dd_msme_jobs', 'district_dev.dd_eshram_pct', 'district_dev.dd_sslc_pass_pct', 'district_dev.dd_sslc_pass_2024', 'population.population'],
            method: `District tables from the Economic Survey of Karnataka 2025-26 (via data.opencity.in, public domain): micro, small and medium enterprises registered with the state and the jobs they report (2025), unorganised workers registered on the eShram portal against the district's target, and SSLC (Class 10) results for 2024 and 2025. SSLC results are reported by educational district; Bengaluru North and South are added together for Bengaluru Urban. Enterprise counts include every registered unit, active or not, and jobs are as reported at registration. Blocks are joined through their NFHS (2011) district (Bangalore is Bengaluru Urban). Karnataka only.`,
            refs: 'Economic Survey of Karnataka 2025-26, district tables (via data.opencity.in)' },
        { id: 'districtdev', equity: true, title: 'District banks, power and child health', icon: '🏦',
            question: 'How well served is this district by banks, power and schools, and how healthy are its children?',
            field: { key: 'district_banks', label: 'Bank branches per lakh people (district)', unit: 'per lakh', higherIs: 'better', ramp: 'viridis', domain: [5, 40] },
            needs: ['district_dev.dd_banks_lakh', 'district_dev.dd_atms_lakh', 'district_dev.dd_deposit_pc', 'district_dev.dd_credit_pc', 'district_dev.dd_cd_ratio', 'district_dev.dd_elec_home_kwh', 'district_dev.dd_elec_comm_kwh', 'district_dev.dd_elec_ind_kwh', 'district_dev.dd_schools_lakh', 'district_dev.dd_ptr_elem', 'district_dev.dd_factories', 'district_dev.dd_factory_workers', 'district_dev.dd_vehicles_lakh', 'district_dev.dd_imr', 'district_dev.dd_underweight_pct', 'population.population'],
            method: `The district statistics table of the Economic Survey of Maharashtra 2025-26 (via data.opencity.in, public domain): bank branches, ATMs, deposits and credit per head (2024-25; ATMs at December 2025), electricity sold per head to homes, shops and offices, and industry (2024-25), schools per lakh people and pupils per teacher (2024-25), registered factories and workers (Annual Survey of Industries 2023-24), motor vehicles per lakh people, infant deaths per 1,000 births and under-fives underweight (moderate plus severe, 2024-25). Mumbai City and Mumbai Suburban are separate districts; Thane's figures are for today's Thane district, without Palghar, which was part of it in 2011. Deposits are booked where the account is held, so city districts with head offices show very high figures. Blocks are joined through their NFHS (2011) district. Maharashtra only.`,
            refs: 'Economic Survey of Maharashtra 2025-26, district statistics (via data.opencity.in)' },
        { id: 'districtincome', equity: true, title: 'District income per head', icon: '💰',
            question: 'How rich is this district per head, and where does it rank in the state?',
            field: { key: 'district_pci', label: 'District per capita income (current prices)', unit: '₹/yr', higherIs: 'better', ramp: 'viridis', domain: [200000, 900000] },
            needs: ['district_income.di_pci', 'district_income.di_year', 'district_income.di_rank', 'district_income.di_districts', 'district_income.di_pci_median', 'district_income.di_growth_pct', 'district_income.di_growth_from', 'population.population'],
            method: `District tables from the state economic surveys (via data.opencity.in, public domain): Karnataka 2025-26 (2024-25 figures), Maharashtra 2025-26 (2024-25 first revised estimates; Mumbai is the city and suburban districts together, Thane includes Palghar), Tamil Nadu district GDDP (2023-24) and Telangana's Socio-Economic Outlook 2024 (2022-23). Per capita income is net district domestic product per head at current prices; it counts income produced in the district, so districts with offices, factories and ports (Rangareddy, Bengaluru Urban) score high even where residents earn less. Each state uses its own method and year, so compare districts within a state. Real growth is the compound yearly rise in GDDP at constant prices: Maharashtra 2021-22 to 2024-25, Tamil Nadu 2021-22 to 2023-24 (provisional); Karnataka and Telangana tables give one year only. Blocks are joined through their NFHS (2011) district; districts split since take their namesake's value (Medak's part near Hyderabad uses Sangareddy).`,
            refs: 'Economic Survey of Karnataka 2025-26; Economic Survey of Maharashtra 2025-26; Tamil Nadu district GDDP 2023-24; Telangana Socio-Economic Outlook 2024 (via data.opencity.in)' },
        { id: 'gwstress', equity: true, title: 'Groundwater stress', icon: '💧',
            question: 'Is the groundwater here being pumped faster than the rain refills it?',
            field: { key: 'gw_stage', label: 'Stage of groundwater extraction (district, 2025)', unit: '%', higherIs: 'worse', ramp: 'reds', domain: [20, 180] },
            needs: ['gw_district.gw_stage_pct', 'gw_district.gw_class', 'gw_district.gw_domestic_pct', 'gw_district.gw_industry_pct', 'gw_district.gw_irrigation_pct', 'gw_district.gw_state_stage_pct', 'population.population'],
            method: `The Central Ground Water Board's Dynamic Ground Water Resources of India 2025 (via data.opencity.in, public domain), district tables for Delhi, Karnataka, Maharashtra, Tamil Nadu, Telangana and Gujarat. Stage of extraction is the year's pumping for irrigation, industry and homes as a share of the extractable resource (recharge from rain, canals, tanks and return flows, less natural discharge); CGWB calls a unit safe up to 70%, semi-critical to 90%, critical to 100% and over-exploited above. Districts are joined through each block's NFHS district (2011 boundaries), so districts carved out since take their 2011 parent's or namesake's value. Figures are district-wide and include rural pumping; city wards inside a district can differ a lot (the borewells and groundwater depth lenses show local detail).`,
            refs: 'Central Ground Water Board, Dynamic Ground Water Resources of India 2025, district tables (via data.opencity.in)' },
        { id: 'tollring', title: 'Toll plazas around the city', icon: '🛣️',
            question: 'How far is the nearest toll plaza, and what does a car pay to get out of town?',
            field: { key: 'toll_km', label: 'Distance to the nearest toll plaza', unit: 'km', higherIs: null, ramp: 'viridis', domain: [0, 30] },
            needs: ['tolls.toll_km', 'tolls.toll_car', 'tolls.toll_car_month', 'tolls.toll_code', 'tolls.tolls_25km', 'population.population'],
            method: `The all-India toll plaza list (NHAI's fee portal, 2024, via data.opencity.in, public domain): 1,563 plazas on national and some state highways with their location and the notified fees for a car, jeep or van (single journey, monthly pass, and the concession for cars registered in the district). NHAI plazas with no car fee listed are not collecting and are left out; state-run plazas are listed without fees, so fee averages cover NHAI plazas only, and some state plazas no longer charge cars (Mumbai's five entry points since October 2024). Each block gets the nearest plaza by straight-line distance, its fees and the number of plazas within 25 km; shares are weighted by GHSL residents. Fees are the 2024 rates, revised each April; expressways and ring roads run by state bodies (Hyderabad's Outer Ring Road, Mumbai's sea links and the Mumbai-Pune Expressway) are missing where NHAI's list leaves them out.`,
            refs: 'NHAI toll plaza fee information via the all-India toll plaza map (data.opencity.in, 2024)' },
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

    UrbanLenses.register(ENTRIES, { homes2011, lowground, feelslike, civicworks, fringevillages, healthnow, mlaseats, roaddeaths, spending, rollrevision, citycrime, wardcouncil, tollring, gwstress, districtincome, districtdev, smallbiz, treefelling, waterstorage, measuredair, wellwater, lakewater });
    return { ENTRIES };
})();
