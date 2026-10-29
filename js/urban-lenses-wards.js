/**
 * Ward records lenses for UrbanLenses: official counts kept by ward (Census 2011 houselisting and households).
 * Registers itself on load, after urban-lenses.js. Started when urban-lenses-commons.js reached the 150 kB per-module budget.
 */
const UrbanLensesWards = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people } = UrbanLenses._kit;

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

    const ENTRIES = [
        { id: 'homes2011', equity: true, title: 'Homes in 2011 by ward', icon: '🏘️',
            question: 'How crowded were homes in each ward at the last census, and who lacked a latrine or owned a car?',
            field: { key: 'one_room_2011', label: 'Households in one room or less (Census 2011)', unit: '%', higherIs: 'worse', ramp: 'viridis', domain: [40, 85] },
            needs: ['census_homes.c11_ward_no', 'census_homes.c11_households', 'census_homes.c11_hh_size', 'census_homes.c11_one_room_pct', 'census_homes.c11_rented_pct', 'census_homes.c11_no_latrine_pct', 'census_homes.c11_open_def_pct', 'census_homes.c11_car_pct', 'census_homes.c11_internet_pct', 'land_value.value_index', 'wealth.rwi', 'population.population'],
            method: `Census of India 2011 Houselisting and Housing table HH-14 (percentage of households by amenities and assets) and the Primary Census Abstract for Greater Mumbai's 97 census wards (via data.opencity.in, public domain). Each census ward lies inside one of BMC's 24 administrative wards, so census wards are summed into them, HH-14 shares weighted by households, and joined to blocks through the BMC ward map (wards). One room or less counts households with no exclusive room or one dwelling room; latrine figures count households without a latrine inside the premises, and those of them that use no public latrine either. Figures are from 2011 and many wards have been rebuilt since (slum redevelopment, towers in the mill lands and suburbs), so they describe the last full count, not today. The rank matches are Spearman correlations across wards between 2011 car ownership and today's residents-weighted land value index (land_value) and Meta's relative wealth index (wealth). Caste and tribe columns are not read.`,
            refs: 'Census of India 2011, Houselisting and Housing Census table HH-14 and Primary Census Abstract, Greater Mumbai census wards (via data.opencity.in); BMC administrative ward map (DataMeet)' },
    ];

    UrbanLenses.register(ENTRIES, { homes2011 });
    return { ENTRIES };
})();
