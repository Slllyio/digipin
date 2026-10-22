/**
 * Real-estate lenses for UrbanLenses: land value, construction hotspots,
 * vacant buildable land, rental demand, price-income gap and undervalued,
 * well-connected land. They read the land_value and re_supply cell datasets
 * (pipeline/realestate). Registers itself on load, so it must load after
 * urban-lenses.js.
 */
const UrbanLensesRealEstate = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _sumOver, _residents, wquantile } = UrbanLenses._kit;
    const prank = UrbanLenses.prank;

    const STATION_WALK = 10, SPACING_KM = 1.5, TOP = 5;
    const HOME_M2 = 60, RESI_EFF = 0.6, DEFAULT_FAR = 2.0;
    const GAP_VALUE = 0.8, GAP_WEALTH = 0.4, POCKET_POP = 200;
    const UPSIDE_MIN = 0.25, MAX_VALUE_RANK = 0.6;
    // Typical base FAR per city, as pipeline/realestate/supply.py BASE_FAR.
    const BASE_FAR = { delhi: 2.0, mumbai: 2.5, bengaluru: 2.25, chennai: 2.0, hyderabad: 3.0, pune: 2.0, ahmedabad: 2.7,
        kolkata: 2.0, jaipur: 2.0, lucknow: 2.0, indore_pilot: 1.5, bhopal: 1.5, guna: 1.5 };
    // Delhi: value index → circle rate (₹/m² of residential land, 2014 categories A–H), rank-matched at the
    // deciles of 244 placed colonies by pipeline/realestate/calibrate.py (Spearman 0.67). Official floors, not market prices.
    const RATE_KNOTS = { delhi: [[26.0, 23280], [45.0, 23280], [76.4, 46200], [101.9, 46200], [114.9, 56640], [122.3, 56640], [130.1, 56640], [142.9, 70080], [156.6, 127680], [175.8, 159840], [200.4, 774000]] };
    const DRIVERS = [['jobs', 'Job reach'], ['metro', 'Metro walk'], ['amenity', 'Shops and services'], ['neigh', 'Neighbourhood and plot size'],
        ['green', 'Green cover'], ['risk', 'Flood and waterlogging'], ['noise', 'Road noise']];

    /** ₹/m² official land rate for a value index, where the city has a fit. */
    function rate(city, vi) {
        const kn = RATE_KNOTS[city];
        if (!kn || !_fin(vi)) return null;
        if (vi <= kn[0][0]) return kn[0][1];
        for (let k = 1; k < kn.length; k++) {
            const [x0, r0] = kn[k - 1], [x1, r1] = kn[k];
            if (vi <= x1) return Math.exp(Math.log(r0) + (x1 > x0 ? (vi - x0) / (x1 - x0) : 0) * (Math.log(r1) - Math.log(r0)));
        }
        return kn[kn.length - 1][1];
    }

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

    function _th(x) {
        const n = Math.round(x), t = n % 100;
        return `${n}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
    }

    function _walk(m) {
        return m > 60 ? 'over an hour on foot to metro' : `${Math.round(m)} min walk to metro`;
    }

    function _rs(v) {
        if (!_fin(v)) return '–';
        return v >= 1e5 ? `₹${_round(v / 1e5, 1)} lakh` : `₹${Math.round(v).toLocaleString('en-IN')}`;
    }

    /** Land value index: where land is dearest and cheapest, and what drives the gap. */
    function landvalue(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const vi = c['land_value.value_index'];
        if (!vi) return null;
        const cells = [];
        for (let i = 0; i < n; i++) if (_fin(vi[i]) && vi[i] > 0) cells.push(i);
        if (cells.length < 10) return null;
        const w = pop && cells.some(i => pop[i] > 0) ? pop : null;
        const p10 = wquantile(vi, w, cells, 0.1), p50 = wquantile(vi, w, cells, 0.5), p90 = wquantile(vi, w, cells, 0.9);
        const spread = _round(p90 / (p10 || 1), 1);
        const col = new Float64Array(n).fill(NaN), rsCol = new Float64Array(n).fill(NaN);
        const cap = wquantile(vi, null, cells, 0.99);
        for (const i of cells) { col[i] = Math.min(cap, vi[i]); const r = rate(fr.city, vi[i]); if (r) rsCol[i] = r; }
        const stats = [
            { label: 'Dearest tenth of homes vs cheapest tenth', value: `${spread}× the land value`, raw: spread },
            { label: 'Value index (100 = the median home)', value: `${_round(p10)} / ${_round(p50)} / ${_round(p90)} at the 10th / 50th / 90th percentile` },
        ];
        const top = cells.filter(i => vi[i] >= p90), low = cells.filter(i => vi[i] <= p10);
        const gaps = DRIVERS.map(([k, label]) => {
            const a = c[`land_value.prem_${k}_pct`];
            if (!a) return null;
            const m = xs => xs.reduce((s, i) => s + (_fin(a[i]) ? a[i] : 0), 0) / (xs.length || 1);
            return { label, gap: m(top) - m(low) };
        }).filter(Boolean).sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap));
        if (gaps.length) stats.push({ label: 'What separates the dearest tenth from the cheapest', value: gaps.slice(0, 3).map(d => `${d.label} ${d.gap >= 0 ? '+' : ''}${_round(d.gap)}%`).join(', ') });
        const r50 = rate(fr.city, p50);
        if (r50) stats.push({ label: 'Circle rate at the median home (Delhi 2014 categories, rank-matched)', value: `${_rs(r50)} per m²` });
        spaced(g, cells, vi).forEach((i, k) => stats.push({ label: `Dearest pocket ${k + 1}: ${g.codes[i]}`, value: `index ${_round(vi[i])}${rate(fr.city, vi[i]) ? `, circle rate about ${_rs(rate(fr.city, vi[i]))}/m²` : ''}` }));
        const columns = { value_index: col };
        if (cells.some(i => _fin(rsCol[i]))) columns.land_rate_rs = rsCol;
        return {
            columns, idx: cells, weightKey: 'value_index',
            metric: { label: 'Land value spread (dearest tenth ÷ cheapest tenth)', value: spread, unit: '×', higherIs: 'worse' },
            headline: `Land under the dearest tenth of homes is worth about ${spread}× that under the cheapest tenth${gaps.length ? `; ${gaps[0].label.toLowerCase()} explains most of the gap` : ''}.`,
            stats,
        };
    }

    /** Where building is happening: floor area added 2016–2023 and whether it lands near the metro or on risky land. */
    function buildhot(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const nf = c['re_supply.new_floor_m2'], br = c['re_supply.build_rate'];
        if (!nf || !br) return null;
        const cells = [];
        let tot = 0;
        for (let i = 0; i < n; i++) if (nf[i] > 0) { cells.push(i); tot += nf[i]; }
        if (cells.length < 5) return null;
        const mw = c['rail_access.metro_walk_min'], risk = c['land_value.prem_risk_pct'];
        const near = mw ? _sumOver(nf, cells, i => mw[i] <= STATION_WALK) : null;
        const risky = risk ? _sumOver(nf, cells, i => risk[i] < 0) : null;
        const sorted = cells.map(i => nf[i]).sort((a, b) => b - a);
        const top10 = sorted.slice(0, Math.ceil(sorted.length / 10)).reduce((a, b) => a + b, 0);
        const stats = [
            { label: 'Floor area built 2016–2023', value: `${_round(tot / 1e6, 1)} km² (${_round(tot / 1e6 / 7, 1)} km² a year)`, raw: _round(tot / 1e6, 1) },
            { label: 'Share in the busiest tenth of blocks', value: `${_round(100 * top10 / tot)}%` },
        ];
        if (near != null) stats.push({ label: `Within a ${STATION_WALK}-minute walk of a metro station`, value: `${_round(100 * near / tot)}%` });
        if (risky != null) stats.push({ label: 'On land in the 1-in-100-year floodplain or prone to waterlogging', value: `${_round(100 * risky / tot)}%` });
        spaced(g, cells, nf).forEach((i, k) => stats.push({ label: `Building hotspot ${k + 1}: ${g.codes[i]}`, value: `${_people(nf[i])} m² of new floor area` }));
        const cap = sorted[Math.floor(0.05 * (sorted.length - 1))];
        const col = new Float64Array(n).fill(NaN), rateCol = new Float64Array(n).fill(NaN);
        for (const i of cells) { col[i] = Math.min(cap, nf[i]); if (_fin(br[i])) rateCol[i] = br[i]; }
        const nearPct = near != null ? _round(100 * near / tot) : null;
        return {
            columns: { new_floor: col, build_rate: rateCol }, idx: cells, weightKey: 'new_floor',
            metric: nearPct != null
                ? { label: 'New floor area within a 10-minute walk of the metro', value: nearPct, unit: '%', higherIs: 'better' }
                : { label: 'Floor area built 2016–2023', value: _round(tot / 1e6, 1), unit: 'km²', higherIs: null },
            headline: `About ${_round(tot / 1e6, 1)} km² of floor area went up between 2016 and 2023${nearPct != null ? `, ${nearPct}% of it within a ${STATION_WALK}-minute walk of the metro` : ''}.`,
            stats,
        };
    }

    /** Vacant buildable land inside the urban area, ranked by how well located it is. */
    function vacant(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const vh = c['re_supply.vacant_ha'], vi = c['land_value.value_index'];
        if (!vh) return null;
        const cells = [];
        let ha = 0;
        for (let i = 0; i < n; i++) if (vh[i] > 0) { cells.push(i); ha += vh[i]; }
        if (!cells.length) return null;
        const mw = c['rail_access.metro_walk_min'];
        const nearHa = mw ? _sumOver(vh, cells, i => mw[i] <= STATION_WALK) : null;
        const far = BASE_FAR[fr.city] || DEFAULT_FAR;
        const homes = ha * 1e4 * far * RESI_EFF / HOME_M2;
        const score = new Float64Array(n).fill(NaN);
        for (const i of cells) score[i] = vh[i] * (vi && _fin(vi[i]) ? vi[i] / 100 : 1);
        const stats = [
            { label: 'Vacant buildable land in the urban area', value: `${_round(ha / 100, 1)} km²`, raw: _round(ha / 100, 1) },
            { label: `Homes it could hold at the base FAR of ${far}`, value: `about ${_people(homes)} (${HOME_M2} m² each, ${RESI_EFF * 100}% of floor area as homes)` },
        ];
        if (nearHa != null) stats.push({ label: `Within a ${STATION_WALK}-minute walk of a metro station`, value: `${_round(nearHa, 1)} ha` });
        spaced(g, cells, score).forEach((i, k) => stats.push({ label: `Best-located vacant land ${k + 1}: ${g.codes[i]}`, value: `${_round(vh[i], 1)} ha${vi && _fin(vi[i]) ? `, value index ${_round(vi[i])}` : ''}${mw && _fin(mw[i]) ? `, ${_walk(mw[i])}` : ''}` }));
        return {
            columns: { vacant_ha: Float64Array.from(vh, v => (v > 0 ? v : NaN)), vacant_score: score }, idx: cells, weightKey: 'vacant_score',
            metric: { label: 'Vacant buildable land in the urban area', value: _round(ha / 100, 1), unit: 'km²', higherIs: null },
            headline: `About ${_round(ha / 100, 1)} km² of open land inside the built-up area could take buildings, enough for roughly ${_people(homes)} homes at the city's base FAR.`,
            stats,
        };
    }

    /** Job reach blended from car and transit, as in pipeline/realestate/land_value.py. */
    function _reach(c, i) {
        const car = c['job_access.jobs_car_pct'], tr = c['job_access.jobs_transit_pct'];
        if (!car || !tr || !_fin(car[i])) return NaN;
        return 0.6 * car[i] + 0.4 * (_fin(tr[i]) ? tr[i] : 0);
    }

    /** Rental demand: where job reach is high relative to land value (renters pay for access, owners for status). */
    function rentdemand(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, idx = _residents(fr), pop = c['population.population'];
        const vi = c['land_value.value_index'], mw = c['rail_access.metro_walk_min'];
        if (!vi || !c['job_access.jobs_car_pct']) return null;
        const dem = new Float64Array(n).fill(NaN);
        const cells = idx.filter(i => _fin(vi[i]));
        for (const i of cells) {
            const r = _reach(c, i);
            if (_fin(r)) dem[i] = r * (mw && mw[i] <= STATION_WALK ? 1.15 : 1);
        }
        const ok = cells.filter(i => _fin(dem[i]));
        if (ok.length < 10) return null;
        const pd = prank(dem, ok), pv = prank(vi, ok);
        const yieldIdx = new Float64Array(n).fill(NaN), demCol = new Float64Array(n).fill(NaN);
        for (const i of ok) { yieldIdx[i] = Math.round(100 * (pd[i] - pv[i])); demCol[i] = Math.round(100 * pd[i]); }
        const hot = ok.filter(i => pd[i] >= 0.7 && pd[i] - pv[i] >= 0.3);
        const total = _sumOver(pop, ok, () => true) || 1, pHot = _sumOver(pop, hot, () => true);
        const share = _round(100 * pHot / total);
        const stats = [
            { label: 'Residents in high-demand, low-price pockets', value: `${_people(pHot)} (${share}%)`, raw: share },
            { label: 'Blocks where job reach is in the top 30% but land value is 30+ points lower in rank', value: `${hot.length}` },
        ];
        spaced(g, hot, yieldIdx).forEach((i, k) => stats.push({ label: `Rental hotspot ${k + 1}: ${g.codes[i]}`, value: `job reach in the top ${Math.max(1, Math.round(100 * (1 - pd[i])))}%, land value at the ${_th(100 * pv[i])} percentile` }));
        return {
            columns: { rent_demand: demCol, yield_gap: yieldIdx }, idx: ok, weightKey: 'yield_gap',
            metric: { label: 'Residents in high-demand, low-price pockets', value: share, unit: '%', higherIs: null },
            headline: `${share}% of residents live where jobs are within easy reach but land is cheap for it: the places renters (students, migrant workers, young professionals) compete for, and where rental yields run highest.`,
            stats,
        };
    }

    /** Price-income gap: land values running ahead of what local households can afford. */
    function affordability(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, idx = _residents(fr), pop = c['population.population'];
        const vi = c['land_value.value_index'], rwi = c['wealth.rwi'];
        if (!vi || !rwi) return null;
        const ok = idx.filter(i => _fin(vi[i]) && _fin(rwi[i]));
        if (ok.length < 10) return null;
        const pv = prank(vi, ok), pw = prank(rwi, ok);
        const gap = new Float64Array(n).fill(NaN);
        for (const i of ok) gap[i] = Math.round(100 * (pv[i] - pw[i]));
        const press = ok.filter(i => pv[i] >= GAP_VALUE && pw[i] <= GAP_WEALTH);
        const total = _sumOver(pop, ok, () => true) || 1, pPress = _sumOver(pop, press, () => true);
        const share = _round(100 * pPress / total);
        const nf = c['re_supply.new_floor_m2'];
        const stats = [
            { label: 'Residents in the dearest fifth of land with incomes in the poorer 40%', value: `${_people(pPress)} (${share}%)`, raw: share },
            { label: 'Value-rank minus wealth-rank (city median)', value: `${_round(wquantile(gap, pop, ok, 0.5))} points` },
        ];
        if (nf) {
            const med = wquantile(nf, null, ok.filter(i => nf[i] > 0), 0.5);
            const building = press.filter(i => nf[i] > med);
            stats.push({ label: '… of them where more was built 2016–2023 than in the median block (redevelopment pressure)', value: `${_people(_sumOver(pop, building, () => true))}` });
        }
        spaced(g, press.filter(i => pop[i] >= POCKET_POP), gap).forEach((i, k) => stats.push({ label: `Pressure pocket ${k + 1}: ${g.codes[i]}`, value: `${_people(pop[i])} residents, land value at the ${_th(100 * pv[i])} percentile, wealth at the ${_th(100 * pw[i])}` }));
        return {
            columns: { price_income_gap: gap }, idx: ok, weightKey: 'price_income_gap',
            metric: { label: 'Residents where land prices outrun local incomes', value: share, unit: '%', higherIs: 'worse' },
            headline: `${_people(pPress)} people (${share}%) live on the city's dearest fifth of land while their neighbourhood's wealth sits in the poorer 40%: the likeliest places for rent rises, redevelopment and displacement.`,
            stats,
        };
    }

    /** Undervalued for its access: cheap land with strong job reach or metro, building momentum and no flood risk. */
    function undervalued(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const vi = c['land_value.value_index'], risk = c['land_value.prem_risk_pct'], noise = c['land_value.prem_noise_pct'];
        const mw = c['rail_access.metro_walk_min'], br = c['re_supply.build_rate'], u35 = c['re_supply.urban_2035_pct'], bp = c['built_up.built_pct'];
        if (!vi || !c['job_access.jobs_car_pct']) return null;
        const acc = new Float64Array(n).fill(NaN), cells = [];
        for (let i = 0; i < n; i++) {
            if (!_fin(vi[i])) continue;
            const r = _reach(c, i);
            if (!_fin(r)) continue;
            acc[i] = r * (mw && mw[i] <= STATION_WALK ? 1.2 : 1);
            cells.push(i);
        }
        if (cells.length < 10) return null;
        const pa = prank(acc, cells), pv = prank(vi, cells), pb = br ? prank(br, cells) : null;
        const up = new Float64Array(n).fill(NaN);
        for (const i of cells) {
            let s = pa[i] - pv[i];
            if (pb && _fin(pb[i])) s += 0.2 * (pb[i] - 0.5);
            if (u35 && bp && _fin(u35[i]) && _fin(bp[i])) s += 0.002 * Math.max(0, u35[i] - bp[i]);
            up[i] = s;
        }
        const picks = cells.filter(i => up[i] >= UPSIDE_MIN && pv[i] <= MAX_VALUE_RANK && !(risk && risk[i] < 0) && !(noise && noise[i] < -4));
        const col = new Float64Array(n).fill(NaN);
        for (const i of cells) col[i] = Math.round(100 * up[i]);
        const stats = [
            { label: 'Blocks priced well below their access, with no flood or waterlogging flag', value: `${picks.length} of ${cells.length}`, raw: picks.length },
        ];
        if (mw) stats.push({ label: `… of them within a ${STATION_WALK}-minute walk of a metro station`, value: `${picks.filter(i => mw[i] <= STATION_WALK).length}` });
        spaced(g, picks, up, 8).forEach((i, k) => stats.push({ label: `Pick ${k + 1}: ${g.codes[i]}`, value: `access in the top ${Math.max(1, Math.round(100 * (1 - pa[i])))}%, land value at the ${_th(100 * pv[i])} percentile${pb && _fin(pb[i]) && pb[i] >= 0.7 ? ', building fast' : ''}${mw && mw[i] <= STATION_WALK ? ', near metro' : ''}` }));
        const share = _round(100 * picks.length / cells.length);
        return {
            columns: { upside: col }, idx: cells, weightKey: 'upside',
            metric: { label: 'Blocks undervalued for their access', value: share, unit: '%', higherIs: null },
            headline: `${picks.length} blocks have land values well below what their job reach and metro access would suggest, with building momentum and no flood flag: candidates for appreciation as the city fills in.`,
            stats,
        };
    }

    const VALUE_METHOD = 'The value index is a hedonic land value surface: log premiums for jobs within 45 minutes (0.6 car + 0.4 transit, from the demand model), metro within a 20-minute walk (up to +10%), shops and services within ~1 km, neighbourhood status (Meta Relative Wealth Index and average building footprint, a proxy for plot size), green cover, and discounts for the 1-in-100-year floodplain, waterlogging and road noise above 60 dB, with coefficients from the Indian and international hedonic literature. 100 is the city\'s median home. No open locality prices exist for Indian cities, so it ranks land rather than quoting it; In Delhi, 244 colonies placed on the map rank with Spearman 0.67 against their circle-rate category (A–H, 2014 rates), and ₹ figures are rank-matched to those rates: official floors that lag the market most in the dearest colonies.';

    const ENTRIES = [
        { id: 'landvalue', equity: false, title: 'Land value', icon: '🏷️',
            question: 'Where is land dearest and cheapest, and what drives the difference?',
            field: { key: 'value_index', label: 'Land value index (100 = the median home)', unit: 'index', higherIs: null, ramp: 'viridis' },
            extra: [{ key: 'land_rate_rs', label: 'Circle-rate equivalent (Delhi, 2014 categories)', unit: '₹/m²', higherIs: null, ramp: 'viridis' }],
            needs: ['land_value.value_index', ...DRIVERS.map(([k]) => `land_value.prem_${k}_pct`)],
            method: VALUE_METHOD, refs: 'Brueckner 2011 (urban land rent); Gibbons & Machin 2005 (rail access premiums); Tiwari & Parikh 1997 (Mumbai hedonic prices); NHB RESIDEX; Delhi Revenue Department circle rates (2014); MCD colony list' },
        { id: 'buildhot', equity: false, title: 'Construction hotspots', icon: '🏗️',
            question: 'Where has the city been building since 2016, and is it near the metro or on risky land?',
            field: { key: 'new_floor', label: 'Floor area built 2016–2023', unit: 'm²', higherIs: null, ramp: 'heat' },
            extra: [{ key: 'build_rate', label: 'Construction intensity', unit: 'm²/km²/yr', higherIs: null, ramp: 'heat' }],
            needs: ['re_supply.new_floor_m2', 're_supply.build_rate', 'rail_access.metro_walk_min', 'land_value.prem_risk_pct'],
            method: 'New buildings between the 2016 and 2023 layers of Google Open Buildings 2.5D Temporal, each at the block\'s 2023 average footprint and storeys (height ÷ 3 m). Footprints miss small sheds and heights are ±3 m, so treat totals as orders of magnitude. The map caps blocks at the busiest 5%.',
            refs: 'Google Open Buildings 2.5D Temporal (Sirko et al. 2023); GHSL 2023' },
        { id: 'vacant', equity: false, title: 'Vacant buildable land', icon: '🟩',
            question: 'Where is open land inside the city that could take new homes, and which of it is best located?',
            field: { key: 'vacant_score', label: 'Vacant land weighted by land value', unit: 'ha', higherIs: null, ramp: 'greens' },
            extra: [{ key: 'vacant_ha', label: 'Vacant buildable land', unit: 'ha', higherIs: null, ramp: 'greens' }],
            needs: ['re_supply.vacant_ha', 'land_value.value_index', 'rail_access.metro_walk_min'],
            method: 'ESA WorldCover bare ground, grass and shrub in blocks where at least 20% of land within ~500 m is built, outside water, wetland, mangrove, the 1-in-100-year floodplain and blocks with mapped parks or leisure places. Homes assume the city\'s typical base FAR, 60% of floor area as homes and 60 m² a home. 10 m land cover counts some playgrounds, ridges and protected forest as open; check ownership and zoning before relying on a parcel.',
            refs: 'ESA WorldCover 2021; JRC flood hazard maps; city master plans (base FAR)' },
        { id: 'rentdemand', equity: false, title: 'Rental demand', icon: '🔑',
            question: 'Where do renters compete for homes: places with strong job reach but cheap land?',
            field: { key: 'yield_gap', label: 'Job reach rank minus land value rank', unit: 'points', higherIs: null, ramp: 'heat' },
            extra: [{ key: 'rent_demand', label: 'Job reach (percentile, metro bonus)', unit: 'pct', higherIs: null, ramp: 'viridis' }],
            needs: ['land_value.value_index', 'job_access.jobs_car_pct', 'job_access.jobs_transit_pct', 'rail_access.metro_walk_min'],
            method: 'Renters pay for access to work more than owners do, so rental demand follows jobs within 45 minutes (0.6 car + 0.4 transit) with a 15% bonus inside a 10-minute metro walk. A hotspot has job reach in the city\'s top 30% and land value at least 30 percentile points lower: high rent relative to price, the usual sign of high gross yields. No open rent data; validate with listings before investing.',
            refs: 'Glaeser, Gyourko & Saks 2005; Anas, Arnott & Small 1998 (urban spatial structure); NHB RESIDEX' },
        { id: 'affordability', equity: true, title: 'Price-income gap', icon: '⚖️',
            question: 'Where do land prices run ahead of what local households can afford, and where is displacement likeliest?',
            field: { key: 'price_income_gap', label: 'Land value rank minus wealth rank', unit: 'points', higherIs: 'worse', ramp: 'reds' },
            needs: ['land_value.value_index', 'wealth.rwi', 're_supply.new_floor_m2'],
            method: 'Each block\'s land value percentile minus its Meta Relative Wealth Index percentile, among residential blocks. Pressure pockets are in the dearest fifth of land with wealth in the poorer 40%: old villages, resettlement colonies and informal settlements surrounded by rising land, where rents and redevelopment push residents out. RWI is a 2.4 km estimate from satellite and phone data, so it blurs mixed neighbourhoods.',
            refs: 'Chi et al. 2022 (Relative Wealth Index); Ghertner 2015 (Delhi displacement); UN-Habitat housing affordability guidance' },
        { id: 'undervalued', equity: false, title: 'Undervalued, well-connected land', icon: '📈',
            question: 'Where is land cheap for its job reach and metro access, with building momentum and no flood risk?',
            field: { key: 'upside', label: 'Access rank minus value rank, plus momentum', unit: 'points', higherIs: null, ramp: 'greens' },
            needs: ['land_value.value_index', 'land_value.prem_risk_pct', 'land_value.prem_noise_pct', 'job_access.jobs_car_pct', 'job_access.jobs_transit_pct', 'rail_access.metro_walk_min', 're_supply.build_rate', 're_supply.urban_2035_pct', 'built_up.built_pct'],
            method: `Upside is the block's access percentile (job reach, ×1.2 within a 10-minute metro walk) minus its land value percentile, plus a fifth of how far its construction rate sits above the median and a small bonus for projected urban growth to 2035. Picks have upside of at least ${UPSIDE_MIN * 100} points, land value below the ${MAX_VALUE_RANK * 100}th percentile, no flood or waterlogging flag and no heavy road noise, spaced 1.5 km apart. A screening list, not investment advice: title, zoning and planned infrastructure decide more than any map.`,
            refs: 'Hedonic access premiums (Debrezion, Pels & Rietveld 2007); Open Buildings 2.5D Temporal; GHSL SSP projections' },
    ];

    UrbanLenses.register(ENTRIES, { landvalue, buildhot, vacant, rentdemand, affordability, undervalued }, { landRate: rate, RE_BASE_FAR: BASE_FAR }, 'tod');
    return { ENTRIES, rate, spaced, RATE_KNOTS };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesRealEstate = UrbanLensesRealEstate;
}
