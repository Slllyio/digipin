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
    const { _fin, _round, _people, _sumOver, _residents, wquantile, within } = UrbanLenses._kit;
    const prank = UrbanLenses.prank;

    const STATION_WALK = 10, SPACING_KM = 1.5, TOP = 5;
    const HOME_M2 = 60, RESI_EFF = 0.6, DEFAULT_FAR = 2.0;
    const GAP_VALUE = 0.8, GAP_WEALTH = 0.4, POCKET_POP = 200;
    const UPSIDE_MIN = 0.25, MAX_VALUE_RANK = 0.6;
    const COUNT_BIAS = 1.5, NET_EFF = 0.7, HH_SIZE = 4.3, HOME_FLOOR = 50, RESI_SHARE = 0.75, BUILD_YEARS = 7, YEARS_TO_2030 = 7, LOCAL_KM = 1, GAP_MIN = 200;
    // JRC global depth-damage function, residential, Asia (Huizinga et al. 2017): [depth m, damage factor].
    const DEPTH_DAMAGE = [[0, 0], [0.5, 0.33], [1, 0.49], [1.5, 0.62], [2, 0.72], [3, 0.87], [4, 0.93], [5, 0.98], [6, 1]];
    const MAX_DMG = 30000, BUILD_COST = 22000, RP10_DEPTH = 0.6, DISCOUNT = 0.06, WLOG_EAD = [[65, 0.01], [45, 0.004]], PROTECT_RP = 25;
    const OLD_YEAR = 2000, OLD_1975 = 20, REDEV_M = 1.5, TOWER_M = 15, FRONTIER = 10;
    // Typical base FAR per city, as pipeline/realestate/supply.py BASE_FAR.
    const BASE_FAR = { delhi: 2.0, mumbai: 2.5, bengaluru: 2.25, chennai: 2.0, hyderabad: 3.0, pune: 2.0, ahmedabad: 2.7,
        kolkata: 2.0, jaipur: 2.0, lucknow: 2.0, indore_pilot: 1.5, bhopal: 1.5, guna: 1.5 };
    // Delhi: value index → circle rate (₹/m² of residential land, 2014 categories A–H), rank-matched at the
    // deciles of 244 placed colonies by pipeline/realestate/calibrate.py (Spearman 0.67). Official floors, not market prices.
    const RATE_KNOTS = { delhi: [[26.0, 23280], [45.0, 23280], [76.4, 46200], [101.9, 46200], [114.9, 56640], [122.3, 56640], [130.1, 56640], [142.9, 70080], [156.6, 127680], [175.8, 159840], [200.4, 774000]] };
    // City-average new-home asking price, ₹ per sq ft of saleable area. Top seven: ANAROCK Q3 2025 (Delhi = NCR,
    // Mumbai = MMR). The rest are rough placeholders from listings until licensed market data (end-of-project keys).
    const PRICE_SQFT = { mumbai: 17230, delhi: 8900, bengaluru: 8870, pune: 7935, hyderabad: 7750, chennai: 7010, kolkata: 6060,
        ahmedabad: 5500, jaipur: 5000, lucknow: 5500, indore_pilot: 4500, bhopal: 4000, guna: 2500 };
    const PRICE_ROUGH = new Set(['ahmedabad', 'jaipur', 'lucknow', 'indore_pilot', 'bhopal', 'guna']);
    const SQFT_M2 = 10.764, SALE_LOADING = 1.25, BUILT_PER_FAR = 1.4, SOFT = 0.15, MARGIN = 0.2, OLD_STOCK = 0.6, TOD_FAR = 4, TOD_WALK = 10, REBUILD_FAR = 0.5;
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
        if (v < 0) return `−${_rs(-v)}`;
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

    /** Redevelopment: old neighbourhoods where buildings are getting taller (rebuilt or floors added). */
    function redevelop(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const dh = c['building_dynamics.height_change_m'], sy = c['building_dynamics.settled_year'], b75 = c['building_dynamics.built_1975_pct'];
        if (!dh || !(sy || b75)) return null;
        const old = i => (sy && _fin(sy[i]) && sy[i] <= OLD_YEAR) || (b75 && b75[i] >= OLD_1975);
        const cells = [], rising = [];
        for (let i = 0; i < n; i++) {
            if (!_fin(dh[i]) || !old(i)) continue;
            cells.push(i);
            if (dh[i] >= REDEV_M) rising.push(i);
        }
        if (cells.length < 5) return null;
        const col = new Float64Array(n).fill(NaN);
        for (const i of cells) col[i] = Math.max(-3, Math.min(6, dh[i]));
        const pOld = _sumOver(pop, cells, i => _fin(pop[i])) || 1;
        const pRise = _sumOver(pop, rising, i => _fin(pop[i]));
        const share = _round(100 * rising.length / cells.length);
        const hr = c['building_dynamics.highrise_pct'], vi = c['land_value.value_index'];
        const stats = [
            { label: `Old blocks (settled by ${OLD_YEAR}) where buildings grew ${REDEV_M} m or more, 2016–2023`, value: `${rising.length} of ${cells.length} (${share}%)`, raw: share },
            { label: 'Residents of those blocks', value: `${_people(pRise)} (${_round(100 * pRise / pOld)}% of old-block residents)` },
        ];
        if (vi) {
            const m = xs => xs.filter(i => _fin(vi[i])).reduce((a, i, _, arr) => a + vi[i] / arr.length, 0);
            stats.push({ label: 'Land value index, redeveloping vs other old blocks', value: `${_round(m(rising))} vs ${_round(m(cells.filter(i => dh[i] < REDEV_M)))}` });
        }
        if (hr) stats.push({ label: 'Built-up in buildings over 15 m, redeveloping blocks (GHSL 2018)', value: `${_round(rising.reduce((a, i) => a + (_fin(hr[i]) ? hr[i] : 0), 0) / (rising.length || 1))}%` });
        spaced(g, rising, col).forEach((i, k) => stats.push({ label: `Redevelopment hotspot ${k + 1}: ${g.codes[i]}`, value: `${dh[i] > TOWER_M ? 'new high-rise, ' : ''}+${_round(dh[i], 1)} m average height${sy && _fin(sy[i]) ? `, settled by ${sy[i] <= 1985 ? '1985' : Math.round(sy[i])}` : ''}` }));
        return {
            columns: { height_change: col }, idx: cells, weightKey: 'height_change',
            metric: { label: 'Old blocks being rebuilt taller', value: share, unit: '%', higherIs: null },
            headline: `In ${share}% of the city's older blocks (settled by ${OLD_YEAR}), buildings got ${REDEV_M} m or more taller between 2016 and 2023: floors added or plots rebuilt as builder floors and apartments.`,
            stats,
        };
    }

    /** Next growth: where satellites see building now and GHSL projects it by 2030. */
    function nextgrowth(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const pg = c['building_dynamics.proj_gain_pp'], dw = c['building_dynamics.dw_built_change'], ac = c['building_dynamics.accel'];
        if (!pg) return null;
        const score = new Float64Array(n).fill(NaN), cells = [];
        let km2 = 0;
        for (let i = 0; i < n; i++) {
            if (!_fin(pg[i])) continue;
            const s = Math.max(0, pg[i]) + (dw && _fin(dw[i]) ? Math.max(0, dw[i]) / 2 : 0) + (ac && _fin(ac[i]) ? 2 * Math.min(2, Math.max(0, ac[i] - 1)) : 0);
            score[i] = s; cells.push(i);
            km2 += Math.max(0, pg[i]) / 100 * g.dx * g.dy;
        }
        if (cells.length < 10) return null;
        const front = cells.filter(i => score[i] >= FRONTIER);
        const mw = c['rail_access.metro_walk_min'], risk = c['land_value.prem_risk_pct'];
        const stats = [
            { label: 'Land GHSL projects to be built over 2020–2030', value: `${_round(km2, 1)} km²`, raw: _round(km2, 1) },
            { label: 'Growth-frontier blocks (projected gain, building since 2023, speeding up)', value: `${front.length}` },
        ];
        if (dw) {
            const recent = cells.filter(i => dw[i] >= 10).length;
            stats.push({ label: 'Blocks where Dynamic World sees new built area since 2023 (+10 points or more)', value: `${recent}` });
        }
        if (mw) stats.push({ label: `… frontier within a ${STATION_WALK}-minute walk of a metro station`, value: `${front.filter(i => mw[i] <= STATION_WALK).length}` });
        if (risk) stats.push({ label: '… frontier on flood- or waterlogging-prone land', value: `${front.filter(i => risk[i] < 0).length}` });
        spaced(g, front, score).forEach((i, k) => stats.push({ label: `Growth frontier ${k + 1}: ${g.codes[i]}`, value: [pg[i] >= 1 ? `+${_round(pg[i])} points built-up by 2030 (GHSL)` : '', dw && _fin(dw[i]) && dw[i] >= 1 ? `+${_round(dw[i])} points built-up seen since 2023` : '', ac && _fin(ac[i]) && ac[i] > 1.5 ? 'building speeding up' : ''].filter(Boolean).join(', ') }));
        return {
            columns: { growth_score: score }, idx: cells, weightKey: 'growth_score', noHotspots: front.length < 10,
            metric: { label: 'Land projected to be built 2020–2030', value: _round(km2, 1), unit: 'km²', higherIs: null },
            headline: `GHSL projects about ${_round(km2, 1)} km² of new built-up land by 2030; ${front.length} blocks are already on the move, with building seen since 2023 and a quickening pace.`,
            stats,
        };
    }

    /** Housing gap 2030: projected new households within ~1 km against homes at the 2016–23 building pace, and vacant land to close it. */
    function housinggap(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], p30 = c['population.projected_2030'];
        const nf = c['re_supply.new_floor_m2'];
        if (!pop || !p30 || !nf) return null;
        const vh = c['re_supply.vacant_ha'], nr = c['building_dynamics.nonres_pct'];
        const need = new Float64Array(n).fill(NaN), pace = new Float64Array(n).fill(NaN), land = new Float64Array(n).fill(NaN);
        let needT = 0, paceT = 0;
        for (let i = 0; i < n; i++) {
            if (!_fin(pop[i]) || !_fin(p30[i])) continue;
            need[i] = Math.max(0, p30[i] - pop[i]) / HH_SIZE;
            const res = nr && _fin(nr[i]) ? 1 - nr[i] / 100 : RESI_SHARE;
            pace[i] = (_fin(nf[i]) ? nf[i] : 0) / COUNT_BIAS * NET_EFF / BUILD_YEARS * YEARS_TO_2030 * res / HOME_FLOOR;
            land[i] = vh && vh[i] > 0 ? vh[i] * 1e4 * DEFAULT_FAR * RESI_EFF / HOME_M2 : 0;
            needT += need[i]; paceT += pace[i];
        }
        const N = within(g, need, LOCAL_KM), P = within(g, pace, LOCAL_KM), V = within(g, land, LOCAL_KM);
        const gap = new Float64Array(n).fill(NaN), cells = [];
        for (let i = 0; i < n; i++) {
            if (!_fin(need[i])) continue;
            cells.push(i);
            gap[i] = N[i] - P[i];
        }
        if (cells.length < 10) return null;
        const short = cells.filter(i => gap[i] >= GAP_MIN);
        const fixable = short.filter(i => V[i] >= gap[i]).length;
        const extra = cells.reduce((a, i) => a + Math.max(0, p30[i] - pop[i]), 0);
        const ratio = _round(paceT / (needT || 1), 2);
        const stats = [
            { label: 'Extra residents projected 2020→2030 (GHSL)', value: `${_people(extra)} (${_people(needT)} households at ${HH_SIZE} a home)` },
            { label: 'Homes the 2016–23 building pace adds by 2030', value: `about ${_people(paceT)} (${HOME_FLOOR} m² each, net of walls, stairs and non-residential space)` },
            { label: 'Building pace vs projected need, city-wide', value: `${ratio}×`, raw: ratio },
            { label: `Blocks where need within ${LOCAL_KM} km outruns supply by ${GAP_MIN}+ homes`, value: `${short.length}` },
            { label: '… of them with enough vacant land nearby to close the gap at base FAR', value: `${fixable}` },
        ];
        const col = new Float64Array(n).fill(NaN);
        for (const i of cells) col[i] = Math.max(-2000, Math.min(5000, gap[i]));
        spaced(g, short, gap).forEach((i, k) => stats.push({ label: `Shortfall pocket ${k + 1}: ${g.codes[i]}`, value: `about ${_people(gap[i])} homes short within ${LOCAL_KM} km${V[i] > 0 ? `; vacant land nearby for ${_people(V[i])}` : '; no vacant land nearby'}` }));
        return {
            columns: { housing_gap: col }, idx: cells, weightKey: 'housing_gap',
            metric: { label: 'Building pace vs projected housing need to 2030', value: ratio, unit: '×', higherIs: 'better' },
            headline: ratio >= 1
                ? `At the 2016–23 pace the city builds about ${ratio}× the homes its projected growth needs by 2030, but ${short.length} blocks still face local shortfalls where growth lands away from construction.`
                : `At the 2016–23 pace the city builds only ${ratio}× the homes its projected growth needs by 2030: a shortfall of about ${_people(needT - paceT)} homes, concentrated in ${short.length} blocks.`,
            stats,
        };
    }

    /** Depth-damage factor (0–1), linear between the JRC Asia residential points. */
    function damage(depth) {
        if (!_fin(depth) || depth <= 0) return 0;
        for (let k = 1; k < DEPTH_DAMAGE.length; k++) {
            const [d0, f0] = DEPTH_DAMAGE[k - 1], [d1, f1] = DEPTH_DAMAGE[k];
            if (depth <= d1) return f0 + (f1 - f0) * (depth - d0) / (d1 - d0);
        }
        return 1;
    }

    /**
     * Expected annual damage from the 10- and 100-year events: trapezoid over exceedance probability above the
     * protection standard (damage at the protected return period interpolated in log return period), then the
     * 100-year damage for rarer events. protectRp ≤ 2 means no protection.
     */
    function ead(d10, d100, protectRp = PROTECT_RP) {
        const pts = [[2, 0], [10, d10], [100, d100]];
        const at = rp => {
            if (rp <= 2) return 0;
            const k = rp <= 10 ? 1 : 2, [r0, v0] = pts[k - 1], [r1, v1] = pts[k];
            return v0 + (v1 - v0) * (Math.log(rp) - Math.log(r0)) / (Math.log(r1) - Math.log(r0));
        };
        const rp0 = Math.min(100, Math.max(2, protectRp));
        const knots = [[rp0, at(rp0)], ...pts.filter(([r]) => r > rp0)];
        let e = 0;
        for (let k = 1; k < knots.length; k++) e += (1 / knots[k - 1][0] - 1 / knots[k][0]) * (knots[k - 1][1] + knots[k][1]) / 2;
        return e + 0.01 * d100;
    }

    /** Climate risk to property: expected yearly flood and waterlogging damage to buildings, in rupees. */
    function floodloss(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const f100 = c['water.flood_rp100_pct'], f10 = c['water.flood_rp10_pct'], dm = c['water.flood_rp100_depth_m'];
        const cover = c['building_stock.cover_2023_pct'], ht = c['building_stock.height_2023_m'], wl = c['waterlogging.waterlogging_index'];
        if (!f100 || !dm || !cover) return null;
        const loss = new Float64Array(n).fill(NaN), pct = new Float64Array(n).fill(NaN), cells = [];
        let tot = 0, stock = 0, river = 0, pluvial = 0;
        for (let i = 0; i < n; i++) {
            if (!(cover[i] > 0)) continue;
            const foot = cover[i] / 100 * g.dx * g.dy * 1e6;
            const floors = Math.max(1, (_fin(ht && ht[i]) ? ht[i] : 3) / 3);
            const value = foot * floors * BUILD_COST;
            stock += value;
            let e = 0;
            if (f100[i] > 0 && dm[i] > 0) {
                const depth = dm[i] / (f100[i] / 100);
                const d100 = f100[i] / 100 * foot * MAX_DMG * damage(depth);
                const d10 = (_fin(f10 && f10[i]) ? f10[i] : 0) / 100 * foot * MAX_DMG * damage(depth * RP10_DEPTH);
                const r = ead(d10, d100);
                e += r; river += r;
            }
            if (wl && _fin(wl[i])) {
                const w = WLOG_EAD.find(([t]) => wl[i] >= t);
                if (w) { const r = foot * MAX_DMG * w[1]; e += r; pluvial += r; }
            }
            if (e <= 0) continue;
            cells.push(i); tot += e;
            loss[i] = e / 1e5;
            pct[i] = 100 * e / value;
        }
        if (cells.length < 5) return null;
        const share = 100 * tot / (stock || 1);
        const capital = tot / DISCOUNT;
        const stats = [
            { label: 'Expected flood and waterlogging damage to buildings a year', value: `₹${_people(tot / 1e7)} crore`, raw: _round(tot / 1e7) },
            { label: `… river flooding beyond 1-in-${PROTECT_RP}-year protection vs waterlogging`, value: `${_round(100 * river / tot)}% / ${_round(100 * pluvial / tot)}%` },
            { label: 'As a share of the building stock\'s replacement value', value: `${_round(share, 2)}% a year` },
            { label: `Value at risk if buyers price it in (capitalised at ${DISCOUNT * 100}%)`, value: `₹${_people(capital / 1e7)} crore` },
        ];
        spaced(g, cells, loss).forEach((i, k) => stats.push({ label: `Costliest block ${k + 1}: ${g.codes[i]}`, value: `₹${_round(loss[i], 1)} lakh a year, ${_round(pct[i], 1)}% of its building value` }));
        const cap = wquantile(loss, null, cells, 0.98);
        for (const i of cells) if (loss[i] > cap) loss[i] = cap;
        return {
            columns: { flood_loss: loss, flood_loss_pct: pct }, idx: cells, weightKey: 'flood_loss',
            metric: { label: 'Expected yearly flood damage, share of building value', value: _round(share, 2), unit: '%/yr', higherIs: 'worse' },
            headline: `Floods and waterlogging are expected to cost the city's buildings about ₹${_people(tot / 1e7)} crore a year (${_round(share, 2)}% of their replacement value); priced into property, that is about ₹${_people(capital / 1e7)} crore of value at risk.`,
            stats,
        };
    }

    /** Encroachment watch: water bodies, floodplains and tree cover lost to building. */
    function encroach(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const wl = c['encroachment.water_lost_pct'], wb = c['encroachment.water_built_pct'], fn = c['encroachment.flood_new_pct'];
        const tl = c['encroachment.tree_lost_pct'], tb = c['encroachment.tree_built_pct'], rb = c['encroachment.recent_built_pct'];
        if (!wl || !wb) return null;
        const ha = i => g.dx * g.dy * 100;                                  // block area in ha
        const sum = a => (a ? Array.from(a).reduce((s, v, i) => s + (_fin(v) ? v / 100 * ha(i) : 0), 0) : 0);
        const score = new Float64Array(n).fill(NaN), cells = [];
        for (let i = 0; i < n; i++) {
            const v = (_fin(wb[i]) ? wb[i] : 0) + (fn && _fin(fn[i]) ? 3 * fn[i] : 0) + (tb && _fin(tb[i]) ? tb[i] : 0) + (rb && _fin(rb[i]) ? 2 * rb[i] : 0);
            if (_fin(wl[i]) || v > 0) { score[i] = v; cells.push(i); }
        }
        if (!cells.length) return null;
        const hot = cells.filter(i => score[i] >= 2);
        const stats = [
            { label: 'Surface water lost since 1984', value: `${_round(sum(wl))} ha` },
            { label: '… of it now built up', value: `${_round(sum(wb))} ha`, raw: _round(sum(wb)) },
        ];
        if (fn) stats.push({ label: 'New building footprint in the 100-year floodplain, 2016→2023', value: `${_round(sum(fn), 1)} ha` });
        if (tl) stats.push({ label: 'Tree cover lost 2001–2024 / now built up', value: `${_round(sum(tl))} ha / ${_round(sum(tb))} ha` });
        if (rb) stats.push({ label: 'Built since 2023 on former water, floodplain or lost trees', value: `${_round(sum(rb), 1)} ha` });
        spaced(g, hot, score).forEach((i, k) => stats.push({ label: `Encroachment hotspot ${k + 1}: ${g.codes[i]}`, value: [wb[i] >= 1 ? `${_round(wb[i])}% former water built` : '', fn && fn[i] >= 0.5 ? `${_round(fn[i], 1)}% new floodplain building` : '', tb && tb[i] >= 1 ? `${_round(tb[i])}% lost trees built` : '', rb && rb[i] >= 0.5 ? `${_round(rb[i], 1)}% built since 2023` : ''].filter(Boolean).join(', ') }));
        return {
            columns: { encroach_score: score }, idx: cells, weightKey: 'encroach_score', noHotspots: hot.length < 10,
            metric: { label: 'Former water now built up', value: _round(sum(wb)), unit: 'ha', higherIs: 'worse' },
            headline: `About ${_round(sum(wb))} ha of former lakes, ponds and river channels are now built up${fn ? `, and ${_round(sum(fn), 1)} ha of new building footprint went into the 100-year floodplain between 2016 and 2023` : ''}.`,
            stats,
        };
    }

    /**
     * Residual land value per m² of plot: sales at FAR `far` (saleable = FAR area × loading, at ₹`price`/m²) minus
     * build cost (built area incl. parking/services × ₹BUILD_COST × (1 + soft costs)) minus developer margin.
     * Redevelopment pays when it beats the existing floor area sold as old stock.
     */
    function feasibility({ price, far, farNow = 0, cost = BUILD_COST }) {
        if (!_fin(price) || !_fin(far)) return null;
        const gdv = far * SALE_LOADING * price, build = far * BUILT_PER_FAR * cost * (1 + SOFT), margin = MARGIN * gdv;
        const rlv = gdv - build - margin, euv = (_fin(farNow) ? farNow : 0) * SALE_LOADING * price * OLD_STOCK;
        return { gdv, build, margin, rlv, euv, redevGain: rlv - euv, breakEvenPrice: far * BUILT_PER_FAR * cost * (1 + SOFT) / (far * SALE_LOADING * (1 - MARGIN)) };
    }

    function blockPrice(city, vi) {
        const p = PRICE_SQFT[city];
        return p && _fin(vi) ? p * SQFT_M2 * vi / 100 : null;
    }

    /** Development feasibility: what land is worth to a developer at the allowed FAR, and what a TOD FAR would add. */
    function feasible(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, city = fr.city;
        const vi = c['land_value.value_index'], fn = c['re_supply.far_now'], vh = c['re_supply.vacant_ha'], mw = c['rail_access.metro_walk_min'];
        if (!vi || !PRICE_SQFT[city]) return null;
        const far = BASE_FAR[city] || DEFAULT_FAR;
        const rlv = new Float64Array(n).fill(NaN), gain = new Float64Array(n).fill(NaN), tod = new Float64Array(n).fill(NaN), cells = [];
        let viable = 0, redev = 0, vacVal = 0, todVal = 0, todHa = 0;
        for (let i = 0; i < n; i++) {
            const price = blockPrice(city, vi[i]);
            if (price == null) continue;
            const f = feasibility({ price, far, farNow: fn && _fin(fn[i]) ? fn[i] : 0 });
            cells.push(i);
            rlv[i] = f.rlv / 1e3;
            gain[i] = f.redevGain / 1e3;
            if (f.rlv > 0) viable++;
            if (f.redevGain > 0 && fn && fn[i] >= REBUILD_FAR) redev++;
            const vac = vh && vh[i] > 0 ? vh[i] : 0;
            vacVal += vac * 1e4 * Math.max(0, f.rlv);
            if (mw && mw[i] <= TOD_WALK && TOD_FAR > far) {
                const t = feasibility({ price, far: TOD_FAR }).rlv - f.rlv;
                tod[i] = t / 1e3;
                if (t > 0) { todVal += vac * 1e4 * t; todHa += vac; }
            }
        }
        if (cells.length < 5) return null;
        const med = wquantile(rlv, null, cells, 0.5);
        const be = feasibility({ price: 1, far }).breakEvenPrice;
        const rough = PRICE_ROUGH.has(city);
        const stats = [
            { label: `City-average new-home price${rough ? ' (rough placeholder)' : ' (ANAROCK Q3 2025)'}`, value: `₹${PRICE_SQFT[city].toLocaleString('en-IN')} per sq ft` },
            { label: 'New-home price at which building breaks even on cost and margin', value: `₹${Math.round(be / SQFT_M2).toLocaleString('en-IN')} per sq ft` },
            { label: `Blocks where new building pays at the base FAR of ${far}`, value: `${_round(100 * viable / cells.length)}%`, raw: _round(100 * viable / cells.length) },
            { label: 'Median residual land value', value: `${_rs(med * 1e3)} per m² of plot` },
            { label: `Built-up blocks (FAR ≥ ${REBUILD_FAR}) where rebuilding to the base FAR beats selling the existing floors`, value: `${redev.toLocaleString('en-IN')}` },
            { label: 'Developer value of the vacant buildable land, if all of it could be built', value: `₹${_people(vacVal / 1e7)} crore` },
        ];
        if (todHa > 0) stats.push({ label: `Extra value if vacant land within a ${TOD_WALK}-minute metro walk got FAR ${TOD_FAR} (TOD)`, value: `₹${_people(todVal / 1e7)} crore on ${_round(todHa, 1)} ha` });
        spaced(g, cells.filter(i => gain[i] > 0 && fn && fn[i] >= REBUILD_FAR), gain).forEach((i, k) => stats.push({ label: `Redevelopment candidate ${k + 1}: ${g.codes[i]}`, value: `rebuilding adds ${_rs(gain[i] * 1e3)} per m² of plot (FAR now ${_round(fn[i], 1)})` }));
        const cap = wquantile(rlv, null, cells, 0.98);
        for (const i of cells) if (rlv[i] > cap) rlv[i] = cap;
        return {
            columns: { rlv, redev_gain: gain, tod_uplift: tod }, idx: cells, weightKey: 'rlv',
            metric: { label: `Blocks where building pays at FAR ${far}`, value: _round(100 * viable / cells.length), unit: '%', higherIs: null },
            headline: `At the city's base FAR of ${far}, new building pays in ${_round(100 * viable / cells.length)}% of blocks; ${med > 0 ? `the median plot is worth about ${_rs(med * 1e3)} per m² to a developer` : 'at the median price, apartment building does not cover its cost and margin, so plotted houses dominate'}${rough ? ' (prices here are rough placeholders)' : ''}.`,
            stats,
        };
    }

    // pipeline/realestate/metro_effect.json, pooled over 9 cities: floor area added 2016–23 within 800 m of stations
    // opened 2017–22 ÷ the same 1.5–3 km away. 1.00 ± 0.03: new stations did not draw extra building.
    const METRO_EFFECT = { ratio: 1.0, ci: 0.03, near: 5364, ring: 8834 };

    /** Upcoming metro: who gains a station within a walk, and the land value it should add. */
    function metroboost(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, city = fr.city;
        const fw = c['metro_future.future_walk_min'], up = c['metro_future.value_uplift_pct'], sv = c['metro_future.walk_saved_min'];
        if (!fw || !up) return null;
        const pop = c['population.population'], vi = c['land_value.value_index'], fn = c['re_supply.far_now'], now = c['rail_access.metro_walk_min'];
        const cells = [], score = new Float64Array(n).fill(NaN);
        let newly = 0, people = 0, worth = 0;
        const land = g.dx * g.dy * 1e6;
        for (let i = 0; i < n; i++) {
            if (!_fin(fw[i])) continue;
            cells.push(i);
            const p = pop && _fin(pop[i]) ? pop[i] : 0;
            score[i] = (_fin(up[i]) ? up[i] : 0) * (1 + Math.log1p(p) / 10);
            if (fw[i] <= STATION_WALK && !(now && now[i] <= STATION_WALK)) { newly++; people += p; }
            const price = blockPrice(city, vi && vi[i]);
            if (price != null && fn && _fin(fn[i]) && _fin(up[i])) worth += up[i] / 100 * price * fn[i] * land;
        }
        if (!cells.length) return null;
        const meanUp = cells.reduce((a, i) => a + (_fin(up[i]) ? up[i] : 0), 0) / cells.length;
        const stats = [
            { label: `Blocks that get a metro station within a ${STATION_WALK}-minute walk`, value: `${newly.toLocaleString('en-IN')}`, raw: newly },
            { label: '… residents in them', value: _people(people) },
            { label: 'Blocks with a shorter walk to metro', value: `${cells.length.toLocaleString('en-IN')}, average value uplift ${_round(meanUp, 1)}%` },
        ];
        if (worth > 0) stats.push({ label: 'Value added to existing homes and offices (city prices × floor area)', value: `₹${_people(worth / 1e7)} crore` });
        stats.push({ label: 'Past openings, 2017–22: building near new stations vs 1.5–3 km away', value: `${METRO_EFFECT.ratio.toFixed(2)}× (±${METRO_EFFECT.ci}): no extra building followed` });
        spaced(g, cells, score).forEach((i, k) => stats.push({ label: `Biggest gain ${k + 1}: ${g.codes[i]}`, value: `+${_round(up[i], 1)}% value, ${_round(fw[i])} min walk to the new station${sv && _fin(sv[i]) ? (now && now[i] > 60 ? ' (today over an hour on foot)' : ` (${_round(sv[i])} min saved)`) : ''}` }));
        return {
            columns: { metro_uplift: Float64Array.from(up, v => (_fin(v) ? v : NaN)), metro_score: score }, idx: cells, weightKey: 'metro_score',
            metric: { label: 'Residents newly within a 10-minute walk of metro', value: Math.round(people), unit: 'people', higherIs: 'better' },
            headline: newly < 10
                ? `Wikidata lists few upcoming metro stations for this city: ${newly.toLocaleString('en-IN')} block${newly === 1 ? '' : 's'} gain a station within a ${STATION_WALK}-minute walk.`
                : `Upcoming stations put ${_people(people)} residents in ${newly.toLocaleString('en-IN')} blocks within a ${STATION_WALK}-minute walk of metro${worth > 0 ? `, adding about ₹${_people(worth / 1e7)} crore to existing property` : ''}; past openings drew no extra building nearby, so new homes there need a TOD FAR.`,
            stats,
        };
    }

    // Features for "places like this": each block's percentile within its own city, so a match means the same
    // standing in the target city (the "Hauz Khas of Pune"), not the same absolute numbers.
    const SIM_FEATURES = [['land_value.value_index', 'land value', 2, 'dearer', 'cheaper'], ['population.density_km2', 'density', 1, 'denser', 'sparser'],
        ['job_access.jobs_car_pct', 'job reach', 1, 'more jobs in reach', 'fewer jobs in reach'], ['rail_access.metro_walk_min', 'metro walk', 1, 'further from metro', 'nearer metro', true],
        ['wealth.rwi', 'wealth', 1, 'wealthier', 'less wealthy'], ['osm_amenities.poi_total', 'shops and services', 1, 'more shops', 'fewer shops'],
        ['building_dynamics.settled_year', 'newness', 1, 'newer', 'older'], ['building_dynamics.highrise_pct', 'high-rise share', 1, 'more high-rise', 'fewer high-rises'],
        ['vegetation.ndvi', 'greenery', 0.5, 'greener', 'less green']];
    const SIM_KM = 0.5, SIM_EXCLUDE_KM = 3;

    async function _simFrame(city, store) {
        const fr = await UrbanLenses.frame(city, store, ['population.population', ...SIM_FEATURES.map(f => f[0])]);
        const g = fr.grid, idx = _residents(fr);
        const ranks = SIM_FEATURES.map(([k]) => {
            const v = fr.cols[k];
            if (!v) return null;
            const sm = within(g, v, SIM_KM, true);
            return prank(sm, idx);
        });
        return { fr, g, idx, ranks };
    }

    /**
     * Places like a reference block: the k blocks of `toCity` (default the same city) whose percentile profile
     * is closest to the block at lat/lng in `fromCity`. Returns { ref, matches: [{ code, dist, same, differs }] }.
     */
    async function similar({ fromCity, lat, lng, toCity, k = TOP }, store) {
        const A = await _simFrame(fromCity, store);
        const code = DigiPin.encode(lat, lng).replace(/-/g, '').slice(0, 7);
        const i0 = A.g.codes.indexOf(code);
        if (i0 < 0) return null;
        const ref = A.ranks.map(r => (r && _fin(r[i0]) ? r[i0] : null));
        const B = toCity && toCity !== fromCity ? await _simFrame(toCity, store) : A;
        const dist = new Float64Array(B.g.n).fill(NaN), cand = [];
        for (const i of B.idx) {
            if (B === A && Math.hypot((B.g.row[i] - B.g.row[i0]) * B.g.dy, (B.g.col[i] - B.g.col[i0]) * B.g.dx) < SIM_EXCLUDE_KM) continue;
            let d = 0, w = 0;
            SIM_FEATURES.forEach(([, , wt], f) => {
                const r = B.ranks[f];
                if (ref[f] == null || !r || !_fin(r[i])) return;
                d += wt * (r[i] - ref[f]) ** 2; w += wt;
            });
            if (w >= 4) { dist[i] = Math.sqrt(d / w); cand.push(i); }
        }
        const score = Float64Array.from(dist, v => (_fin(v) ? -v : NaN));
        const matches = spaced(B.g, cand, score, k).map(i => {
            const diffs = SIM_FEATURES.map(([, , , up, down], f) => ({ up, down, d: ref[f] != null && B.ranks[f] && _fin(B.ranks[f][i]) ? B.ranks[f][i] - ref[f] : 0 }));
            const big = diffs.filter(x => Math.abs(x.d) >= 0.2).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 2);
            return { code: B.g.codes[i], similarity: Math.round(100 * (1 - dist[i])), differs: big.map(x => (x.d > 0 ? x.up : x.down)) };
        });
        const profile = SIM_FEATURES.map(([, label, , , , inv], f) => ref[f] != null && { label: inv ? 'metro access' : label, pct: Math.round(100 * (inv ? 1 - ref[f] : ref[f])) }).filter(Boolean);
        return { fromCity, toCity: toCity || fromCity, ref: { code, profile }, matches };
    }

    function similarText(r) {
        if (!r) return 'That spot is outside the populated blocks I have data for. Click a block inside the city and ask again.';
        const L = typeof UrbanInsights !== 'undefined' ? UrbanInsights.cityLabel : (c => c);
        const top = r.ref.profile.slice().sort((a, b) => Math.abs(b.pct - 50) - Math.abs(a.pct - 50)).slice(0, 3).map(p => `${p.label} ${_th(p.pct)} percentile`).join(', ');
        return [`Places in ${L(r.toCity)} most like ${r.ref.code} in ${L(r.fromCity)} (${top}):`,
            ...r.matches.map((m, i) => `${i + 1}. ${m.code}: ${m.similarity}% similar${m.differs.length ? `; ${m.differs.join(', ')}` : ''}`)].join('\n');
    }

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
        { id: 'redevelop', equity: false, title: 'Redevelopment', icon: '🏚️',
            question: 'Which older neighbourhoods are being rebuilt taller?',
            field: { key: 'height_change', label: 'Change in mean building height 2016→2023, older blocks', unit: 'm', higherIs: null, ramp: 'diverging' },
            needs: ['building_dynamics.height_change_m', 'building_dynamics.settled_year', 'building_dynamics.built_1975_pct', 'building_dynamics.highrise_pct', 'land_value.value_index'],
            method: `Older blocks were settled by ${OLD_YEAR} in the World Settlement Footprint Evolution (Landsat, 1985–2015) or were at least ${OLD_1975}% built in GHSL 1975. Height change is the mean building height in Google Open Buildings 2.5D Temporal, 2023 minus 2016; ${REDEV_M} m is about half a storey on average across the block, beyond the model's year-to-year noise. Heights are model estimates (±3 m per building), so read the pattern, not single blocks.`,
            refs: 'Google Open Buildings 2.5D Temporal (Sirko et al. 2023); Marconcini et al. 2021 (WSF Evolution); GHSL P2023A (Pesaresi et al.)' },
        { id: 'nextgrowth', equity: false, title: 'Where the city grows next', icon: '🌱',
            question: 'Where will the city build next, and is building already under way there?',
            field: { key: 'growth_score', label: 'Growth signal (projected gain + recent building + pace)', unit: 'points', higherIs: null, ramp: 'reds' },
            needs: ['building_dynamics.proj_gain_pp', 'building_dynamics.dw_built_change', 'building_dynamics.accel', 'rail_access.metro_walk_min', 'land_value.prem_risk_pct'],
            method: `The growth signal adds GHSL's projected built-up gain 2020→2030 (percentage points of the block), half of Dynamic World's rise in built-area probability from 2023 to 2026 (Sentinel-2, after the last Open Buildings year) and up to 4 points for building faster than the city's median block in 2020–23 than in 2016–20 (Open Buildings yearly counts). Frontier blocks score ${FRONTIER} or more. GHSL projections extend past trends; they do not know master plans or new roads.`,
            refs: 'GHSL P2023A built-up projections; Brown et al. 2022 (Dynamic World); Google Open Buildings 2.5D Temporal' },
        { id: 'housinggap', equity: false, title: 'Housing gap 2030', icon: '🏘️',
            question: 'Where will population growth to 2030 outrun the homes being built, and is there land to close the gap?',
            field: { key: 'housing_gap', label: 'Homes short by 2030 within ~1 km (need − building pace)', unit: 'homes', higherIs: 'worse', ramp: 'diverging' },
            needs: ['population.population', 'population.projected_2030', 're_supply.new_floor_m2', 're_supply.vacant_ha', 'building_dynamics.nonres_pct'],
            method: `Need is GHSL's projected population gain 2020→2030 divided by ${HH_SIZE} people a household (urban India, NFHS-5). Supply carries the 2016–23 floor area added (Open Buildings 2.5D Temporal) forward ${YEARS_TO_2030} years, deflates the Open Buildings count by ${COUNT_BIAS}× (it runs above the v3 footprint count) and keeps ${NET_EFF * 100}% of gross floor area as usable homes, keeps the residential share (GHSL non-residential share, else ${RESI_SHARE * 100}%) and divides by ${HOME_FLOOR} m² a home. Both are summed within ${LOCAL_KM} km, since people move locally. Vacant land capacity is vacant buildable land at a base FAR of ${DEFAULT_FAR}, 60% residential and ${HOME_M2} m² a home. GHSL projections extend past trends, construction pace from satellites misses interiors and upper floors under construction, and household size varies by income: read the pattern, not exact counts.`,
            refs: 'GHSL P2023A population projections; Google Open Buildings 2.5D Temporal; NFHS-5 (household size); MoHUA Technical Group on Urban Housing Shortage (2012)' },
        { id: 'floodloss', equity: false, title: 'Climate risk to property', icon: '🌊',
            question: 'How much do floods and waterlogging cost the city\'s buildings each year, and where?',
            field: { key: 'flood_loss', label: 'Expected flood and waterlogging damage a year', unit: '₹ lakh/yr', higherIs: 'worse', ramp: 'reds' },
            extra: [{ key: 'flood_loss_pct', label: 'Expected yearly damage, share of building value', unit: '%/yr', higherIs: 'worse', ramp: 'heat' }],
            needs: ['water.flood_rp100_pct', 'water.flood_rp10_pct', 'water.flood_rp100_depth_m', 'building_stock.cover_2023_pct', 'building_stock.height_2023_m', 'waterlogging.waterlogging_index'],
            method: `River flooding: the block's footprint (Open Buildings roof cover) in the JRC/GloFAS 1-in-100-year flood zone takes the JRC Asia residential depth-damage factor at the zone's mean depth, times ₹${MAX_DMG.toLocaleString('en-IN')} per m² of footprint (structure and contents of the flooded floor); the 1-in-10-year zone takes ${RP10_DEPTH * 100}% of that depth. Global flood maps ignore embankments, so cities are assumed protected up to the 1-in-${PROTECT_RP}-year flood (FLOPROS-style urban standard); expected annual damage integrates the rarer events over exceedance probability. Waterlogging adds ${WLOG_EAD[0][1] * 100}% (very high) or ${WLOG_EAD[1][1] * 100}% (high) of footprint value a year. Building value is floor area (footprint × height ÷ 3 m) at ₹${BUILD_COST.toLocaleString('en-IN')}/m² (CPWD plinth-area rates); value at risk capitalises the yearly loss at ${DISCOUNT * 100}%. Coarse flood maps (~90 m) miss drains and local embankments.`,
            refs: 'Huizinga, de Moel & Szewczyk 2017 (JRC global depth-damage functions); Scussolini et al. 2016 (FLOPROS protection standards); JRC/CEMS GloFAS flood hazard maps; CPWD plinth area rates; Bin & Landry 2013 (flood risk capitalisation)' },
        { id: 'feasible', equity: false, title: 'Development feasibility', icon: '🏗️',
            question: 'Where does building at the allowed FAR pay, what is land worth to a developer, and what would a metro TOD FAR add?',
            field: { key: 'rlv', label: 'Residual land value at the base FAR', unit: '₹k/m² plot', higherIs: null, ramp: 'viridis' },
            extra: [{ key: 'redev_gain', label: 'Rebuild gain over the existing floors', unit: '₹k/m² plot', higherIs: null, ramp: 'diverging' },
                { key: 'tod_uplift', label: `Extra value at FAR ${TOD_FAR} near metro`, unit: '₹k/m² plot', higherIs: null, ramp: 'greens' }],
            needs: ['land_value.value_index', 're_supply.far_now', 're_supply.vacant_ha', 'rail_access.metro_walk_min'],
            method: `Sale price per m² is the city-average new-home price scaled by the block's value index (100 = median). Residual land value = sales (FAR area × ${SALE_LOADING} loading to saleable area) − build cost (${BUILT_PER_FAR}× FAR area for parking and services at ₹${BUILD_COST.toLocaleString('en-IN')}/m², CPWD plinth-area rates, plus ${SOFT * 100}% approvals, fees and finance) − ${MARGIN * 100}% developer margin. Rebuilding pays when that beats selling the existing floor area (GHSL volume ÷ 3 m) as old stock at ${OLD_STOCK * 100}% of new prices. TOD tests FAR ${TOD_FAR} within a ${TOD_WALK}-minute walk of a metro station, as in the MoHUA TOD policy and Delhi's TOD regulations. Base FAR is a typical master-plan level, not plot zoning; prices are city averages until licensed market data arrives.`,
            refs: 'ANAROCK Research Q3 2025 (city prices); CPWD plinth area rates; RICS residual valuation method; MoHUA National TOD Policy 2017' },
        { id: 'metroboost', equity: false, title: 'Upcoming metro uplift', icon: '🚇',
            question: 'Which blocks will a metro line under construction bring within walking distance, and what will it add to land value?',
            field: { key: 'metro_uplift', label: 'Expected land value uplift from upcoming stations', unit: '%', higherIs: null, ramp: 'greens' },
            needs: ['metro_future.future_walk_min', 'metro_future.walk_saved_min', 'metro_future.value_uplift_pct', 'rail_access.metro_walk_min', 'population.population', 'land_value.value_index', 're_supply.far_now'],
            method: `Upcoming stations are Wikidata metro stations under construction or proposed, plus stations opened since 2025 that the Overture station layer may lack; Wikidata lists them for some cities only. Each block's walk to the nearest one (straight line × 1.3 at 4.8 km/h) replaces today's metro walk in the land-value model's metro premium (+10% within 6 minutes, tapering to 0 at 20). Value added is the uplift × city-average price × value index × existing floor area. Evidence: blocks within 800 m of stations opened 2017–22 (no older station within 2 km) added ${METRO_EFFECT.ratio.toFixed(2)}× (±${METRO_EFFECT.ci}) the floor area of blocks 1.5–3 km away (Open Buildings 2.5D Temporal, 9 cities), so stations alone did not densify their surroundings.`,
            refs: 'Wikidata (CC0); Debrezion, Pels & Rietveld 2007; Agarwal 2023 (Delhi metro and property values); MoHUA National TOD Policy 2017' },
        { id: 'encroach', equity: true, title: 'Encroachment watch', icon: '🚧',
            question: 'Which lakes, floodplains and green areas have been lost to building, and where is it still happening?',
            field: { key: 'encroach_score', label: 'Encroachment score (former water, floodplain and tree loss built up)', unit: 'points', higherIs: 'worse', ramp: 'reds' },
            needs: ['encroachment.water_lost_pct', 'encroachment.water_built_pct', 'encroachment.flood_new_pct', 'encroachment.tree_lost_pct', 'encroachment.tree_built_pct', 'encroachment.recent_built_pct'],
            method: 'Lost water is JRC Global Surface Water (Landsat, 1984–2021) permanent or seasonal water that has gone; built means Dynamic World (Sentinel-2) labels it built most of the time in 2025–26; built since 2023 needs a mean built probability of at least 0.6 now and at most 0.3 in 2023, since labels flicker in dense blocks. New floodplain building is Open Buildings 2.5D Temporal presence of at least 0.5 in 2023 and below 0.2 in 2016 inside the JRC/GloFAS 1-in-100-year zone. Tree loss is Hansen Global Forest Change (≥ 30% canopy in 2000, lost 2001–2024). The score weights floodplain building 3× and building since 2023 2×. Satellite screens only: some loss is legal (planned reclamation, metro depots), so confirm against land records and the master plan.',
            refs: 'Pekel et al. 2016 (Global Surface Water); Hansen et al. 2013 (Global Forest Change); Brown et al. 2022 (Dynamic World); Google Open Buildings 2.5D Temporal' },
    ];

    UrbanLenses.register(ENTRIES, { landvalue, buildhot, vacant, rentdemand, affordability, undervalued, redevelop, nextgrowth, housinggap, floodloss, encroach, feasible, metroboost }, { landRate: rate, RE_BASE_FAR: BASE_FAR, similar, similarText, feasibility, blockPrice }, 'tod');
    return { ENTRIES, rate, spaced, RATE_KNOTS, damage, ead, similar, similarText, feasibility, blockPrice, PRICE_SQFT };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesRealEstate = UrbanLensesRealEstate;
}
