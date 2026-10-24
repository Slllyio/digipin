/**
 * Safety and resilience lenses for UrbanLenses: fire risk in crowded markets and other hazards where people, buildings
 * and access meet, and what roofs can give back (rainwater). They read places, building_stock and osm_roads. Registers itself on load, after urban-lenses.js.
 */
const UrbanLensesSafety = (() => {
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

    // Market fires. Old bazaars pack shops, stock and wiring into blocks built wall to wall, reached by lanes a fire
    // engine cannot enter. A market block is in the city's busiest 5% for shops and eateries within MARKET_KM; it is
    // packed when roofs cover PACKED_PCT of the block, and far when no fire station is listed within FIRE_KM.
    const MARKET_KM = 0.5, MARKET_Q = 0.95, MARKET_MIN = 50, PACKED_PCT = 50, FIRE_KM = 3, FIRE_MIN = 5;

    function marketfire(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const shops = c['places.shopping'], food = c['places.food'], cover = c['building_stock.cover_2023_pct'], fire = c['places.fire_stations'];
        if (!shops || !food || !cover || !fire) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 || v(shops, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const trade = within(g, Float64Array.from({ length: n }, (_, i) => v(shops, i) + v(food, i)), MARKET_KM);
        const q = Math.max(MARKET_MIN, wquantile(trade, null, idx, MARKET_Q));
        const markets = idx.filter(i => trade[i] >= q);
        if (!markets.length) return null;
        const stations = idx.reduce((a, i) => a + v(fire, i), 0);
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(fire, i)), FIRE_KM);
        const packed = markets.filter(i => v(cover, i) >= PACKED_PCT);
        const far = stations >= FIRE_MIN ? markets.filter(i => near[i] <= 0) : [];
        const both = packed.filter(i => far.includes(i));
        const risk = new Float64Array(n).fill(NaN);
        for (const i of idx) risk[i] = trade[i] >= q ? 1 + (v(cover, i) >= PACKED_PCT ? 1 : 0) + (stations >= FIRE_MIN && near[i] <= 0 ? 1 : 0) : 0;
        const pMarket = _sumOver(pop, markets, () => true), pPacked = _sumOver(pop, packed, () => true);
        const stats = [
            { label: `Market blocks: ${_round(q)}+ shops and eateries within ${MARKET_KM * 1000} m (city's top 5%)`, value: `${markets.length} blocks, ${_people(pMarket)} residents` },
            { label: `…packed, with ${PACKED_PCT}%+ of the block under roofs`, value: `${packed.length} blocks, ${_people(pPacked)} residents` },
            { label: 'Fire stations listed', value: String(stations) },
        ];
        if (stations >= FIRE_MIN) {
            stats.push({ label: `…market blocks with none listed within ${FIRE_KM} km`, value: `${far.length} of ${markets.length}` });
            stats.push({ label: '…packed and far from a fire station', value: `${both.length} blocks` });
        }
        const score = Float64Array.from({ length: n }, (_, i) => trade[i] * (1 + v(cover, i) / 100) * (stations >= FIRE_MIN && near[i] <= 0 ? 2 : 1));
        spaced(g, packed.length ? packed : markets, score).forEach((i, k) => stats.push({
            label: `Fire audit ${k + 1}: ${g.codes[i]}`,
            value: `${_round(trade[i])} shops and eateries within ${MARKET_KM * 1000} m; ${_round(v(cover, i))}% under roofs${stations >= FIRE_MIN ? `; ${near[i] > 0 ? `${_round(near[i])} fire station${near[i] > 1 ? 's' : ''}` : 'no fire station'} within ${FIRE_KM} km` : ''}` }));
        return {
            columns: { market_fire: risk, trade_500m: trade }, idx, weightKey: 'market_fire', noHotspots: true,
            metric: { label: `Market blocks packed ${PACKED_PCT}%+ under roofs`, value: _round(100 * packed.length / markets.length), unit: '%', higherIs: 'worse' },
            headline: `${markets.length} blocks are the city's busiest markets, with ${_round(q)} or more shops and eateries within ${MARKET_KM * 1000} m; ${packed.length} of them are packed with ${PACKED_PCT}% or more of the block under roofs${stations >= FIRE_MIN ? `, and ${both.length} of those have no fire station listed within ${FIRE_KM} km` : ''}. These are where a market fire spreads fastest and engines struggle to reach.${stations < FIRE_MIN ? ` Only ${stations} fire stations are listed here, too few to judge reach.` : ''} The blocks listed are the first to audit for wiring, stock storage and access, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Old buildings, now tall. Frames built before 1985 went up before IS 1893 and IS 13920 shaped how Indian buildings
    // resist earthquakes, and many have since had floors added on top. An old block was settled by OLD_YEAR (WSF
    // Evolution) or at least OLD_1975 percent built in 1975 (GHSL); tall means a mean building height of TALL_M or more
    // (about G+2); added means mean height rose ADDED_M to REBUILT_M from 2016 to 2023 (Open Buildings 2.5D Temporal),
    // about half a storey to a storey across the block. A bigger rise means the old stock was torn down and rebuilt.
    const OLD_YEAR = 1985, OLD_1975 = 20, TALL_M = 10, ADDED_M = 1.5, REBUILT_M = 4, MID_M = 25;

    function oldtall(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const sy = c['building_dynamics.settled_year'], b75 = c['building_dynamics.built_1975_pct'];
        const h = c['building_stock.height_2023_m'], dh = c['building_dynamics.height_change_m'];
        if (!h || !(sy || b75)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && v(h, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const old = i => (sy && _fin(sy[i]) && sy[i] <= OLD_YEAR) || v(b75, i) >= OLD_1975;
        const rebuilt = i => v(dh, i) >= REBUILT_M, added = i => v(dh, i) >= ADDED_M && !rebuilt(i);
        const olds = idx.filter(old), tall = olds.filter(i => h[i] >= TALL_M && !rebuilt(i)), grown = olds.filter(added);
        const both = tall.filter(added);
        const due = new Float64Array(n).fill(NaN);
        for (const i of idx) due[i] = old(i) ? (rebuilt(i) ? 1 : 1 + (h[i] >= TALL_M ? 1 : 0) + (added(i) ? 1 : 0)) : 0;
        const all = _sumOver(pop, idx, () => true), pOld = _sumOver(pop, olds, () => true), pTall = _sumOver(pop, tall, () => true);
        const zone = (UrbanLenses.SEISMIC_ZONE || {})[fr.city];
        const stats = [
            { label: `Blocks settled by ${OLD_YEAR}`, value: `${olds.length} of ${idx.length} blocks, ${_people(pOld)} residents` },
            { label: `…with buildings ${TALL_M} m tall or more on average (about G+2)`, value: `${tall.length} blocks, ${_people(pTall)} residents (${_round(100 * pTall / (all || 1))}% of the city)` },
            { label: `…where mean height rose ${ADDED_M}-${REBUILT_M} m since 2016 (floors added)`, value: `${grown.length} blocks` },
            { label: `…rebuilt (mean height up ${REBUILT_M} m or more), left out above`, value: `${olds.filter(rebuilt).length} blocks` },
            { label: '…old, tall and with floors added', value: `${both.length} blocks, ${_people(_sumOver(pop, both, () => true))} residents` },
        ];
        if (zone) stats.push({ label: 'Seismic zone (IS 1893: 2016)', value: `Zone ${zone}` });
        const score = Float64Array.from({ length: n }, (_, i) => v(pop, i) * Math.min(v(h, i), MID_M) * (added(i) ? 1.5 : 1));
        spaced(g, tall.length ? tall : olds, score).forEach((i, k) => stats.push({
            label: `Audit ${k + 1}: ${g.codes[i]}`,
            value: `${_people(v(pop, i))} residents; buildings ${_round(h[i])} m on average${dh && _fin(dh[i]) ? `, ${dh[i] >= 0 ? '+' : ''}${_round(dh[i], 1)} m since 2016` : ''}` }));
        return {
            columns: { audit_due: due }, idx, weightKey: 'audit_due', noHotspots: true,
            metric: { label: `Residents in old blocks with buildings ${TALL_M} m+`, value: _round(100 * pTall / (all || 1)), unit: '%', higherIs: 'worse' },
            headline: `${_people(pTall)} residents live in ${tall.length} blocks that were settled by ${OLD_YEAR} and now have buildings ${TALL_M} m or more tall on average; in ${both.length} of them mean height rose by half a storey to a storey since 2016, a sign of floors added on old frames.${zone ? ` The city is in seismic zone ${zone}.` : ''} Buildings this old went up before India's earthquake codes were widely applied, so these blocks are where structural audits matter most. The blocks listed are the most crowded, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Critical facilities on wet ground. A hospital, fire station or police station that floods is lost exactly when it
    // is needed. A block is flood-prone where FLOOD_PCT of it lies in the 1-in-100-year river or coastal flood (Aqueduct),
    // and waterlogged where its rain waterlogging index reaches WET_INDEX (radar-seen standing water, hollows, wetness).
    const FLOOD_PCT = 25, WET_INDEX = 60, CARE_KM_WET = 3;
    const FACILITIES = [['places.hospitals', 'hospitals', 'hospital'], ['places.fire_stations', 'fire stations', 'fire station'], ['places.police', 'police stations', 'police station'], ['emergency_access.schools', 'schools (relief camps)', 'school']];

    function critwater(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const fl = c['flood_future.any_pct_now'], wl = c['waterlogging.waterlogging_index'], hosp = c['places.hospitals'];
        if (!(fl || wl) || !hosp) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const level = i => (v(fl, i) >= FLOOD_PCT ? 2 : v(wl, i) >= WET_INDEX ? 1 : 0);
        const any = i => FACILITIES.some(([k]) => v(c[k], i) > 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (any(i)) idx.push(i);
        if (idx.length < 5) return null;
        const wet = new Float64Array(n).fill(NaN);
        for (const i of idx) wet[i] = level(i);
        const stats = [];
        for (const [k, label] of FACILITIES) {
            const a = c[k];
            if (!a) continue;
            let tot = 0, f = 0, w = 0;
            for (const i of idx) { const x = v(a, i); tot += x; if (level(i) === 2) f += x; else if (level(i) === 1) w += x; }
            if (tot) stats.unshift({ label: `${label[0].toUpperCase()}${label.slice(1)} in flood-prone / waterlogged blocks`, value: `${_round(f)} / ${_round(w)} of ${_round(tot)}` });
        }
        stats.reverse();
        // Residents whose every hospital within CARE_KM_WET sits on wet ground: in a flood they have none nearby.
        const dry = within(g, Float64Array.from({ length: n }, (_, i) => (level(i) ? 0 : v(hosp, i))), CARE_KM_WET);
        const allNear = within(g, Float64Array.from({ length: n }, (_, i) => v(hosp, i)), CARE_KM_WET);
        const lived = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) lived.push(i);
        const stranded = lived.filter(i => allNear[i] > 0 && dry[i] <= 0);
        const pStr = _sumOver(pop, stranded, () => true), pAll = _sumOver(pop, lived, () => true);
        stats.push({ label: `Residents whose every hospital within ${CARE_KM_WET} km is on wet ground`, value: `${_people(pStr)} (${_round(100 * pStr / (pAll || 1), 1)}%)` });
        const totH = idx.reduce((a, i) => a + v(hosp, i), 0), wetH = idx.reduce((a, i) => a + (level(i) ? v(hosp, i) : 0), 0);
        const people = within(g, Float64Array.from({ length: n }, (_, i) => v(pop, i)), CARE_KM_WET);
        const score = Float64Array.from({ length: n }, (_, i) => (level(i) ? FACILITIES.reduce((a, [k]) => a + v(c[k], i), 0) * people[i] * level(i) : 0));
        spaced(g, idx.filter(i => level(i) > 0), score).forEach((i, k) => stats.push({
            label: `Flood-proof ${k + 1}: ${g.codes[i]}`,
            value: `${FACILITIES.filter(([key]) => v(c[key], i) > 0).map(([key, l, one]) => `${_round(v(c[key], i))} ${v(c[key], i) === 1 ? one : l.replace(/ \(.*\)/, '')}`).join(', ')}; ${level(i) === 2 ? `${_round(v(fl, i))}% in the 100-year flood` : `waterlogging index ${_round(v(wl, i))}`}; ${_people(people[i])} residents within ${CARE_KM_WET} km` }));
        return {
            columns: { facility_wet: wet }, idx, weightKey: 'facility_wet', noHotspots: true,
            metric: { label: 'Hospitals on flood-prone or waterlogged ground', value: _round(100 * wetH / (totH || 1)), unit: '%', higherIs: 'worse' },
            headline: `${_round(wetH)} of ${_round(totH)} listed hospitals stand on flood-prone or waterlogged ground, and ${_people(pStr)} residents have no hospital within ${CARE_KM_WET} km that stays dry. Fire and police stations and the schools that serve as relief camps are counted the same way. The blocks listed hold the most emergency services on wet ground, weighted by how many people they serve: the first to flood-proof (raised plinths, backup power above flood level, a dry access road).`,
            stats,
        };
    }

    // Earthquake shaking on soft ground. Young river and coastal sediments with a shallow water table amplify shaking
    // and, where they are sandy, can liquefy; tall buildings on them sway longest. Soft ground is height above the
    // nearest drain under SOFT_HAND_M (MERIT Hydro, a proxy for floodplain alluvium and shallow groundwater); sandy
    // means SAND_PCT or more sand in the topsoil (SoilGrids); tall means a mean building height of QUAKE_TALL_M or more.
    const SOFT_HAND_M = 2, SAND_PCT = 45, QUAKE_TALL_M = 15;

    function quake(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const hand = c['terrain.hand_m'], sand = c['soil.sand_pct'], h = c['building_stock.height_2023_m'];
        if (!hand || !h) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && _fin(hand[i])) idx.push(i);
        if (idx.length < 5) return null;
        const soft = i => hand[i] < SOFT_HAND_M, sandy = i => soft(i) && v(sand, i) >= SAND_PCT, tall = i => v(h, i) >= QUAKE_TALL_M;
        const risk = new Float64Array(n).fill(NaN);
        for (const i of idx) risk[i] = (soft(i) ? 1 : 0) + (sandy(i) ? 1 : 0) + (soft(i) && tall(i) ? 1 : 0);
        const zone = (UrbanLenses.SEISMIC_ZONE || {})[fr.city];
        const all = _sumOver(pop, idx, () => true);
        const softs = idx.filter(soft), sandys = idx.filter(sandy), tallSoft = softs.filter(tall);
        const pSoft = _sumOver(pop, softs, () => true), pTall = _sumOver(pop, tallSoft, () => true);
        const stats = [];
        if (zone) stats.push({ label: 'Seismic zone (IS 1893: 2016)', value: `Zone ${zone}` });
        stats.push(
            { label: `Residents on soft ground (under ${SOFT_HAND_M} m above the nearest drain)`, value: `${_people(pSoft)} (${_round(100 * pSoft / (all || 1))}%)` },
            { label: `…on sandy soft ground (${SAND_PCT}%+ sand), where shaking can liquefy the soil`, value: `${sandys.length} blocks, ${_people(_sumOver(pop, sandys, () => true))} residents` },
            { label: `…in blocks of buildings ${QUAKE_TALL_M} m+ on soft ground`, value: `${tallSoft.length} blocks, ${_people(pTall)} residents` });
        const score = Float64Array.from({ length: n }, (_, i) => (soft(i) ? v(pop, i) * (1 + (sandy(i) ? 1 : 0)) * (tall(i) ? 2 : 1) : 0));
        spaced(g, softs, score).forEach((i, k) => stats.push({
            label: `Check ${k + 1}: ${g.codes[i]}`,
            value: `${_people(v(pop, i))} residents; ${_round(hand[i], 1)} m above the nearest drain${sand ? `, ${_round(v(sand, i))}% sand` : ''}; buildings ${_round(v(h, i))} m on average` }));
        return {
            columns: { quake_ground: risk }, idx, weightKey: 'quake_ground', noHotspots: true,
            metric: { label: 'Residents on soft ground', value: _round(100 * pSoft / (all || 1)), unit: '%', higherIs: 'worse' },
            headline: `${zone ? `Seismic zone ${zone}. ` : ''}${_people(pSoft)} residents (${_round(100 * pSoft / (all || 1))}%) live on soft, low, wet ground less than ${SOFT_HAND_M} m above the nearest drain or river, where earthquake shaking is amplified; ${sandys.length} of those blocks are sandy enough to liquefy, and ${_people(pTall)} residents live in blocks of buildings ${QUAKE_TALL_M} m or taller on soft ground. Seismic microzonation maps, where a city has one, replace this proxy. The blocks listed are where soil tests and retrofits should start, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Homes beside factories. Industry inside housing (workshops in residential lanes, like the 2019 Anaj Mandi and 2022
    // Mundka fires in Delhi) puts fire, fumes and stored chemicals beside bedrooms. An industrial block has INDUSTRY_PCT
    // of its mapped land in industrial use (OpenStreetMap via Overture land use); a mixed block has both INDUSTRY_PCT
    // industry and HOMES_PCT housing; hot means satellite thermal anomalies (VIIRS, furnaces, kilns or burning) there.
    const INDUSTRY_PCT = 20, HOMES_PCT = 20, NEXT_KM = 0.5, HOT_DAYS = 1;

    function factoryhomes(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const ind = c['landuse.industrial_pct'], res = c['landuse.residential_pct'], fire = c['fires.fire_days_yr'];
        if (!ind || !res) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const isInd = Float64Array.from({ length: n }, (_, i) => (v(ind, i) >= INDUSTRY_PCT ? 1 : 0));
        const nearInd = within(g, isInd, NEXT_KM);
        const mixed = i => isInd[i] > 0 && v(res, i) >= HOMES_PCT, hot = i => v(fire, i) >= HOT_DAYS;
        const level = i => (mixed(i) ? (hot(i) ? 3 : 2) : nearInd[i] > 0 ? 1 : 0);
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = level(i);
        const indBlocks = [];
        for (let i = 0; i < n; i++) if (isInd[i]) indBlocks.push(i);
        if (!indBlocks.length) return null;
        const near = idx.filter(i => level(i) >= 1), mix = idx.filter(i => level(i) >= 2), hots = idx.filter(i => level(i) === 3);
        const all = _sumOver(pop, idx, () => true), pNear = _sumOver(pop, near, () => true), pMix = _sumOver(pop, mix, () => true);
        const stats = [
            { label: `Industrial blocks (${INDUSTRY_PCT}%+ of mapped land)`, value: String(indBlocks.length) },
            { label: `Residents within ${NEXT_KM * 1000} m of an industrial block`, value: `${_people(pNear)} (${_round(100 * pNear / (all || 1))}%)` },
            { label: `…in mixed blocks, with homes (${HOMES_PCT}%+) and industry side by side`, value: `${mix.length} blocks, ${_people(pMix)} residents` },
        ];
        if (fire) stats.push({ label: '…mixed blocks with satellite thermal anomalies (furnaces, kilns or burning)', value: `${hots.length} blocks, ${_people(_sumOver(pop, hots, () => true))} residents` });
        const score = Float64Array.from({ length: n }, (_, i) => v(pop, i) * level(i) * (1 + v(ind, i) / 100));
        spaced(g, mix.length ? mix : near, score).forEach((i, k) => stats.push({
            label: `Inspect ${k + 1}: ${g.codes[i]}`,
            value: `${_people(v(pop, i))} residents; ${_round(v(ind, i))}% industrial, ${_round(v(res, i))}% housing${hot(i) ? `; thermal anomalies ${_round(v(fire, i), 1)} days a year` : ''}` }));
        return {
            columns: { factory_homes: out }, idx, weightKey: 'factory_homes', noHotspots: true,
            metric: { label: `Residents within ${NEXT_KM * 1000} m of industry`, value: _round(100 * pNear / (all || 1)), unit: '%', higherIs: 'worse' },
            headline: `${_people(pNear)} residents (${_round(100 * pNear / (all || 1))}%) live within ${NEXT_KM * 1000} m of an industrial block, and ${_people(pMix)} live in ${mix.length} blocks where homes and industry share the same ground${fire ? `, ${hots.length} of them with furnace or burning hotspots seen from space` : ''}. Mixed blocks are where fire, fumes and stored chemicals sit closest to bedrooms. The blocks listed are the most crowded, the first for fire and pollution inspections, at least ${SPACING_KM} km apart. Land use is only as complete as the map; unmapped workshops are missed.`,
            stats,
        };
    }

    // Storm-surge refuge. In a city most homes are pucca and ride out the wind; the surge is what forces people out.
    // Exposed blocks have SURGE_PCT of their area in the coastal 1-in-100-year flood today or by 2050 (storm surge, sea
    // level and subsidence, Aqueduct). Schools and community halls are the refuges disaster plans open (Odisha's
    // multipurpose cyclone shelters are schools); a block is covered with one within REFUGE_KM, a walk in rising wind.
    const SURGE_PCT = 25, REFUGE_KM = 1;

    function refuge(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const now = c['flood_future.coast_pct_now'], later = c['flood_future.coast_pct_2050'], wind = c['cyclones.wind_rl50_kmh'];
        const sch = c['emergency_access.schools'], hall = c['places.community_centres'];
        if (!(now || later) || !(sch || hall)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const exposedNow = i => v(now, i) >= SURGE_PCT, exposed = i => exposedNow(i) || v(later, i) >= SURGE_PCT;
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) idx.push(i);
        const hit = idx.filter(exposed);
        if (idx.length < 5 || !hit.length) return null;
        const halls = within(g, Float64Array.from({ length: n }, (_, i) => v(sch, i) + v(hall, i)), REFUGE_KM);
        const crowd = within(g, Float64Array.from({ length: n }, (_, i) => (exposed(i) ? v(pop, i) : 0)), REFUGE_KM);
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = !exposed(i) ? 0 : halls[i] > 0 ? 1 : 2;
        const none = hit.filter(i => halls[i] <= 0);
        const pHit = _sumOver(pop, hit, () => true), pNow = _sumOver(pop, hit.filter(exposedNow), () => true), pNone = _sumOver(pop, none, () => true);
        const covered = hit.filter(i => halls[i] > 0);
        const perRefuge = covered.length ? wquantile(Float64Array.from({ length: n }, (_, i) => (halls[i] > 0 ? crowd[i] / halls[i] : 0)), pop, covered, 0.5) : 0;
        const windMax = wind ? Math.max(0, ...hit.map(i => v(wind, i))) : 0;
        const stats = [
            { label: `Residents in the coastal 100-year flood (${SURGE_PCT}%+ of the block), today / by 2050`, value: `${_people(pNow)} / ${_people(pHit)}` },
            { label: `…with no school or community hall within ${REFUGE_KM} km`, value: `${_people(pNone)} (${none.length} blocks)` },
            { label: `…exposed residents per school or hall within ${REFUGE_KM} km (median resident)`, value: Math.round(perRefuge).toLocaleString('en-IN') },
        ];
        if (windMax) stats.push({ label: 'Strongest 50-year cyclone wind in the surge zone', value: `${_round(windMax)} km/h` });
        const score = Float64Array.from({ length: n }, (_, i) => (exposed(i) ? crowd[i] / (1 + halls[i]) * (exposedNow(i) ? 2 : 1) : 0));
        spaced(g, hit, score).forEach((i, k) => stats.push({
            label: `Shelter ${k + 1}: ${g.codes[i]}`,
            value: `${_people(crowd[i])} exposed residents within ${REFUGE_KM} km; ${halls[i] > 0 ? `${_round(halls[i])} school${halls[i] > 1 ? 's or halls' : ' or hall'}` : 'no school or hall'}; ${_round(Math.max(v(now, i), v(later, i)))}% of the block in the surge zone${exposedNow(i) ? '' : ' by 2050'}` }));
        return {
            columns: { refuge_gap: out }, idx, weightKey: 'refuge_gap', noHotspots: true,
            metric: { label: 'Surge-zone residents with no refuge within 1 km', value: _round(100 * pNone / (pHit || 1)), unit: '%', higherIs: 'worse' },
            headline: `${_people(pNow)} residents live in the coastal 100-year flood zone today, ${_people(pHit)} by 2050, where a cyclone's storm surge forces people out of their homes. ${_people(pNone)} of them have no school or community hall within ${REFUGE_KM} km to shelter in, and for the median resident each nearby refuge serves ${Math.round(perRefuge).toLocaleString('en-IN')} exposed people. The blocks listed have the most exposed residents per refuge, the first places for a raised, cyclone-proof shelter, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Fire engines in packed lanes. A fire tender needs a road about 4.5 m wide (NBC 2016 Part 4); in packed old
    // quarters and unplanned colonies the nearest such road can be hundreds of metres from a burning house. Packed means
    // roofs cover PACKED_PCT of the block; deep means no main or secondary road (OSM) in the block or within DEEP_KM;
    // far means no fire station listed within FIRE_KM (judged only where FIRE_MIN stations are listed).
    const DEEP_KM = 0.3;

    function firelanes(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const cover = c['building_stock.cover_2023_pct'], major = c['osm_roads.major_km_km2'], sec = c['osm_roads.secondary_km_km2'];
        const fire = c['places.fire_stations'];
        if (!cover || !major || !fire) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const road = within(g, Float64Array.from({ length: n }, (_, i) => v(major, i) + v(sec, i)), DEEP_KM);
        const stations = idx.reduce((a, i) => a + v(fire, i), 0);
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(fire, i)), FIRE_KM);
        const judged = stations >= FIRE_MIN;
        const packed = i => v(cover, i) >= PACKED_PCT, deep = i => packed(i) && road[i] <= 0, far = i => judged && near[i] <= 0;
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = packed(i) ? 1 + (deep(i) ? 1 : 0) + (deep(i) && far(i) ? 1 : 0) : 0;
        const ps = idx.filter(packed), ds = ps.filter(deep), fs = ds.filter(far);
        const all = _sumOver(pop, idx, () => true), pP = _sumOver(pop, ps, () => true), pD = _sumOver(pop, ds, () => true);
        const stats = [
            { label: `Residents in packed blocks (${PACKED_PCT}%+ under roofs)`, value: `${_people(pP)} (${_round(100 * pP / (all || 1))}%)` },
            { label: `…with no main or secondary road in or within ${DEEP_KM * 1000} m of the block`, value: `${ds.length} blocks, ${_people(pD)} residents` },
        ];
        if (judged) stats.push({ label: `…and no fire station listed within ${FIRE_KM} km`, value: `${fs.length} blocks, ${_people(_sumOver(pop, fs, () => true))} residents` });
        else stats.push({ label: 'Fire stations listed', value: `${stations}, too few to judge reach` });
        const score = Float64Array.from({ length: n }, (_, i) => (deep(i) ? v(pop, i) * (1 + v(cover, i) / 100) * (far(i) ? 2 : 1) : 0));
        spaced(g, ds.length ? ds : ps, score).forEach((i, k) => stats.push({
            label: `Fire access ${k + 1}: ${g.codes[i]}`,
            value: `${_people(v(pop, i))} residents; ${_round(v(cover, i))}% under roofs; ${road[i] > 0 ? 'a main road nearby' : `no main road within ${DEEP_KM * 1000} m`}${judged ? `; ${near[i] > 0 ? `${_round(near[i])} fire station${near[i] > 1 ? 's' : ''}` : 'no fire station'} within ${FIRE_KM} km` : ''}` }));
        return {
            columns: { fire_lanes: out }, idx, weightKey: 'fire_lanes', noHotspots: true,
            metric: { label: 'Residents in packed blocks far from a main road', value: _round(100 * pD / (all || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(pD)} residents live in ${ds.length} packed blocks (${PACKED_PCT}% or more under roofs) with no main or secondary road within ${DEEP_KM * 1000} m, where a fire tender must stop short and run hoses down narrow lanes${judged ? `; ${fs.length} of those blocks also have no fire station listed within ${FIRE_KM} km` : ''}. The blocks listed are the most crowded, where hydrants, small fire vehicles (bike and mist units) and kept-clear access lanes would help most, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // School safety. The NDMA School Safety Policy (2016) asks for a hazard check of every school. Each block with a
    // school is checked against the hazards above: river or coastal flood, rain waterlogging, soft ground in seismic
    // zone III or higher, a packed block deep in lanes, industry within NEXT_KM, and road noise of LOUD_DB or more.
    const LOUD_DB = 70;

    /** Hazards counted at each block holding `key` sites (one/many name them; col is the output column). */
    function siteCheck(fr, key, one, many, col, policy) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], sch = c[key];
        const Many = many[0].toUpperCase() + many.slice(1), One = one[0].toUpperCase() + one.slice(1);
        if (!sch) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(sch, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const zone = (UrbanLenses.SEISMIC_ZONE || {})[fr.city];
        const shaky = zone && zone !== 'II';
        const fl = c['flood_future.any_pct_now'], wl = c['waterlogging.waterlogging_index'], hand = c['terrain.hand_m'];
        const cover = c['building_stock.cover_2023_pct'], major = c['osm_roads.major_km_km2'], sec = c['osm_roads.secondary_km_km2'];
        const ind = c['landuse.industrial_pct'], noise = c['traffic_noise.lden_db'];
        const road = major ? within(g, Float64Array.from({ length: n }, (_, i) => v(major, i) + v(sec, i)), DEEP_KM) : null;
        const nearInd = ind ? within(g, Float64Array.from({ length: n }, (_, i) => (v(ind, i) >= INDUSTRY_PCT ? 1 : 0)), NEXT_KM) : null;
        const HAZ = [
            ['flood', 'in the 100-year flood', fl, i => v(fl, i) >= FLOOD_PCT],
            ['waterlog', 'waterlogged', wl, i => v(wl, i) >= WET_INDEX],
            ['quake', `on soft ground in seismic zone ${zone || ''}`, shaky && hand, i => _fin(hand[i]) && hand[i] < SOFT_HAND_M],
            ['lanes', 'packed, with no main road within 300 m', cover && road, i => v(cover, i) >= PACKED_PCT && road[i] <= 0],
            ['industry', `within ${NEXT_KM * 1000} m of industry`, nearInd, i => nearInd[i] > 0],
            ['noise', `with road noise of ${LOUD_DB} dB+`, noise, i => v(noise, i) >= LOUD_DB],
        ].filter(h => h[2]);
        if (!HAZ.length) return null;
        const count = new Float64Array(n).fill(NaN);
        for (const i of idx) count[i] = HAZ.reduce((a, h) => a + (h[3](i) ? 1 : 0), 0);
        const total = idx.reduce((a, i) => a + sch[i], 0);
        const share = pred => _round(100 * idx.reduce((a, i) => a + (pred(i) ? sch[i] : 0), 0) / total);
        const stats = HAZ.map(([, label, , test]) => ({ label: `${Many} ${label}`, value: `${share(test)}%` }));
        const multi = idx.filter(i => count[i] >= 2);
        stats.unshift({ label: `${Many} mapped`, value: _round(total).toLocaleString('en-IN') },
            { label: `${Many} facing two or more hazards`, value: `${share(i => count[i] >= 2)}% (${multi.length} blocks)` });
        const score = Float64Array.from({ length: n }, (_, i) => (count[i] >= 1 ? count[i] * count[i] * v(sch, i) * (1 + v(pop, i) / 10000) : 0));
        spaced(g, multi.length ? multi : idx.filter(i => count[i] >= 1), score).forEach((i, k) => stats.push({
            label: `${One} check ${k + 1}: ${g.codes[i]}`,
            value: `${_round(sch[i])} ${sch[i] > 1 ? many : one}; ${HAZ.filter(h => h[3](i)).map(h => h[1]).join(', ') || 'no hazard flagged'}` }));
        return {
            columns: { [col]: count }, idx, weightKey: col, noHotspots: true,
            metric: { label: `${Many} facing two or more hazards`, value: share(i => count[i] >= 2), unit: '%', higherIs: 'worse' },
            headline: `${share(i => count[i] >= 2)}% of the city's ${_round(total).toLocaleString('en-IN')} mapped ${many} sit in blocks with two or more hazards out of ${HAZ.length} checked (${HAZ.map(h => h[0]).join(', ')}), and ${share(i => count[i] >= 1)}% face at least one. The blocks listed have the most ${many} with the most hazards, the first for hazard audits under ${policy}, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    const schoolsafe = fr => siteCheck(fr, 'emergency_access.schools', 'school', 'schools', 'school_hazards', 'the NDMA School Safety Policy');
    const hospitalsafe = fr => siteCheck(fr, 'places.hospitals', 'hospital', 'hospitals', 'hospital_hazards', 'the NDMA hospital safety guidelines');
    // Listed monuments of all three grades, summed into one column for siteCheck.
    function heritagesafe(fr) {
        const c = fr.cols, keys = ['heritage.national', 'heritage.state', 'heritage.local'].filter(k => c[k]);
        if (!keys.length) return null;
        c['heritage.all'] = Float64Array.from({ length: fr.grid.n }, (_, i) => keys.reduce((a, k) => a + (_fin(c[k][i]) ? c[k][i] : 0), 0));
        return siteCheck(fr, 'heritage.all', 'monument', 'monuments', 'heritage_hazards', 'the NDMA guidelines on cultural heritage sites (2017)');
    }

    // Crowded suburban stations. Without open timetables or ticket counts, a station's load is the residents for whom
    // it is the nearest suburban rail station, within CATCH_KM (a walk or a short shared-auto ride). Overloaded
    // platforms and doorways are where commuters fall from trains and crowds crush on foot-overbridges.
    const CATCH_KM = 2;

    function stationload(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], st = c['rail_access.rail_stations'];
        if (!st || !pop) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const stations = [];
        for (let i = 0; i < n; i++) if (v(st, i) > 0) stations.push(i);
        if (stations.length < 3) return null;
        const load = new Float64Array(n), nearest = new Int32Array(n).fill(-1), dist = new Float64Array(n).fill(Infinity);
        const idx = [];
        for (let i = 0; i < n; i++) {
            if (v(pop, i) <= 0) continue;
            for (const j of stations) {
                const d = Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx);
                if (d < dist[i]) { dist[i] = d; nearest[i] = j; }
            }
            if (dist[i] <= CATCH_KM) { load[nearest[i]] += pop[i]; idx.push(i); }
        }
        const per = j => load[j] / v(st, j);
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = per(nearest[i]);
        const served = idx.reduce((a, i) => a + pop[i], 0);
        const all = _sumOver(pop, Array.from({ length: n }, (_, i) => i).filter(i => v(pop, i) > 0), () => true);
        const loads = stations.map(per).sort((a, b) => b - a);
        const totalSt = stations.reduce((a, j) => a + v(st, j), 0);
        const stats = [
            { label: 'Suburban rail stations mapped', value: String(totalSt) },
            { label: `Residents within ${CATCH_KM} km of one`, value: `${_people(served)} (${_round(100 * served / (all || 1))}%)` },
            { label: 'Residents per station, median station', value: _people(loads[Math.floor(loads.length / 2)]) },
            { label: 'Residents per station, busiest tenth', value: `${_people(loads[Math.floor(loads.length / 10)])} or more` },
        ];
        spaced(g, stations, Float64Array.from({ length: n }, (_, i) => (v(st, i) > 0 ? per(i) : 0))).forEach((j, k) => stats.push({
            label: `Crowded station ${k + 1}: ${g.codes[j]}`,
            value: `${_people(per(j))} residents for whom it is the nearest suburban station within ${CATCH_KM} km` }));
        return {
            columns: { station_load: out }, idx, weightKey: 'station_load', noHotspots: true,
            metric: { label: 'Residents per suburban station (median)', value: _round(loads[Math.floor(loads.length / 2)]), unit: 'people', higherIs: 'worse' },
            headline: `${totalSt} suburban rail stations serve ${_people(served)} residents within ${CATCH_KM} km. The median station is the nearest for ${_people(loads[Math.floor(loads.length / 2)])} people, and the busiest tenth for ${_people(loads[Math.floor(loads.length / 10)])} or more: the catchments where platforms, doorways and foot-overbridges fill first. The stations listed have the largest catchments, at least ${SPACING_KM} km apart. Catchment size stands in for ridership; open timetables and ticket counts would sharpen it.`,
            stats,
        };
    }

    // Older people in walk-ups. The National Building Code asks for a lift above 15 m, so three- to five-storey blocks
    // (WALKUP_LO to WALKUP_HI metres on average) are mostly climbed on foot: hard on knees and hearts, and slow to
    // evacuate or carry a patient down. Care is near when a pharmacy is listed within PHARMA_KM.
    const WALKUP_LO = 9, WALKUP_HI = 15, PHARMA_KM = 0.5;

    function walkups(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, old = c['demographics.elderly_60plus'], h = c['building_stock.height_2023_m'];
        const ph = c['places.pharmacies'];
        if (!old || !h) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(old, i) > 0 && v(h, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const near = ph ? within(g, Float64Array.from({ length: n }, (_, i) => v(ph, i)), PHARMA_KM) : null;
        const walk = i => h[i] >= WALKUP_LO && h[i] < WALKUP_HI, far = i => near && near[i] <= 0;
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = walk(i) ? old[i] : 0;
        const ws = idx.filter(walk), fs = ws.filter(far);
        const all = _sumOver(old, idx, () => true), pW = _sumOver(old, ws, () => true), pF = _sumOver(old, fs, () => true);
        const stats = [
            { label: 'Residents aged 60+', value: _people(all) },
            { label: `…in blocks of ${WALKUP_LO}-${WALKUP_HI} m buildings (about 3-5 storeys, mostly without lifts)`, value: `${_people(pW)} (${_round(100 * pW / (all || 1))}%)` },
        ];
        if (near) stats.push({ label: `…with no pharmacy listed within ${PHARMA_KM * 1000} m`, value: `${_people(pF)} (${fs.length} blocks)` });
        const score = Float64Array.from({ length: n }, (_, i) => (walk(i) ? v(old, i) * (far(i) ? 2 : 1) : 0));
        spaced(g, ws, score).forEach((i, k) => stats.push({
            label: `Walk-up ${k + 1}: ${g.codes[i]}`,
            value: `${_people(old[i])} residents aged 60+; buildings ${_round(h[i])} m on average${near ? `; ${near[i] > 0 ? `${_round(near[i])} pharmac${near[i] > 1 ? 'ies' : 'y'}` : 'no pharmacy'} within ${PHARMA_KM * 1000} m` : ''}` }));
        return {
            columns: { elderly_walkup: out }, idx, weightKey: 'elderly_walkup', noHotspots: true,
            metric: { label: 'Older residents in walk-up blocks', value: _round(100 * pW / (all || 1)), unit: '%', higherIs: 'worse' },
            headline: `${_people(pW)} residents aged 60 or over (${_round(100 * pW / (all || 1))}%) live in blocks of three- to five-storey buildings, the height band where the building code does not require a lift${near ? `; ${_people(pF)} of them have no pharmacy listed within ${PHARMA_KM * 1000} m` : ''}. These are where stair lifts, ground-floor transfers, doorstep medicine delivery and stretcher-friendly stairwells matter most. The blocks listed have the most older people, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Trees that fall in the monsoon. Old rain trees, gulmohars and peepals over busy roads come down in storms every
    // year, on cars, wires and people. Tall canopy is a mean tree height of TALL_TREE_M or more (Meta canopy height)
    // (block mean height over tree cover) covering TREE_COVER_PCT of the block; busy means main and secondary road density in the city's top half.
    const TALL_TREE_M = 10, TREE_COVER_PCT = 15;

    function treefall(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const ch = c['vegetation.canopy_m'], cov = c['vegetation.tree_canopy_pct'], major = c['osm_roads.major_km_km2'], sec = c['osm_roads.secondary_km_km2'];
        const heavy = c['rainfall.heavy_rain_days'], wind = c['cyclones.wind_rl50_kmh'];
        if (!ch || !cov || !major) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const roads = Float64Array.from({ length: n }, (_, i) => v(major, i) + v(sec, i));
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 || roads[i] > 0) idx.push(i);
        if (idx.length < 5) return null;
        const withRoad = idx.filter(i => roads[i] > 0);
        const busyQ = withRoad.length ? wquantile(roads, null, withRoad, 0.5) : Infinity;
        // canopy_m is the block-wide mean height, so the trees' own height is that divided by their cover.
        const treeH = i => (v(cov, i) > 0 ? v(ch, i) / (v(cov, i) / 100) : 0);
        const tall = i => v(cov, i) >= TREE_COVER_PCT && treeH(i) >= TALL_TREE_M, busy = i => roads[i] > 0 && roads[i] >= busyQ;
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = tall(i) ? (busy(i) ? 2 : 1) : 0;
        const ts = idx.filter(tall), bs = ts.filter(busy);
        // Main-road length under tall canopy: road density × block area × canopy share.
        const km = bs.reduce((a, i) => a + roads[i] * g.cellKm2 * v(cov, i) / 100, 0);
        const pB = _sumOver(pop, bs, () => true);
        const stats = [
            { label: `Blocks with tall trees (${TALL_TREE_M} m+, ${TREE_COVER_PCT}%+ canopy)`, value: String(ts.length) },
            { label: '…over busy main roads (city\'s top half by main-road density)', value: `${bs.length} blocks, about ${Math.round(km)} km of main road under canopy` },
            { label: '…residents in those blocks', value: _people(pB) },
        ];
        if (heavy) stats.push({ label: 'Heavy-rain days a year in those blocks (mean)', value: _round(bs.reduce((a, i) => a + v(heavy, i), 0) / (bs.length || 1), 1) });
        const score = Float64Array.from({ length: n }, (_, i) => (tall(i) && busy(i) ? roads[i] * v(cov, i) * treeH(i) * (1 + v(heavy, i) / 10) * (1 + Math.max(0, v(wind, i) - 60) / 60) : 0));
        spaced(g, bs.length ? bs : ts, score).forEach((i, k) => stats.push({
            label: `Prune ${k + 1}: ${g.codes[i]}`,
            value: `trees about ${_round(treeH(i))} m tall over ${_round(v(cov, i))}% of the block; ${_round(roads[i], 1)} km of main road per km²${heavy ? `; ${_round(v(heavy, i), 1)} heavy-rain days a year` : ''}` }));
        return {
            columns: { tree_fall: out }, idx, weightKey: 'tree_fall', noHotspots: true,
            metric: { label: 'Main road under tall canopy', value: Math.round(km), unit: 'km', higherIs: null },
            headline: `About ${Math.round(km)} km of busy main road runs under tall tree canopy, in ${bs.length} blocks home to ${_people(pB)} residents. These are the city's shadiest streets and also where storms bring trees down on traffic, wires and walkers. The blocks listed have the tallest, densest canopy over the busiest roads${heavy ? ' and the most heavy-rain days' : ''}: the first for pre-monsoon tree surveys and pruning (not felling), at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Substations under water. A flooded substation is switched off for safety, blacking out pumps, hospitals and lifts
    // far beyond the flood itself (Mumbai 2005, Chennai 2015). Substations (OpenStreetMap) are checked against the flood
    // and waterlogging thresholds of critwater; residents for whom a wet substation is the nearest within SUB_KM are counted.
    const SUB_KM = 3;

    function gridflood(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], sub = c['power_lines.substations'];
        const fl = c['flood_future.any_pct_now'], wl = c['waterlogging.waterlogging_index'], fl50 = c['flood_future.any_pct_2050'];
        if (!sub || !(fl || wl)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const subs = [];
        for (let i = 0; i < n; i++) if (v(sub, i) > 0) subs.push(i);
        if (subs.length < 3) return null;
        const level = i => (v(fl, i) >= FLOOD_PCT ? 2 : v(wl, i) >= WET_INDEX ? 1 : 0);
        const later = i => !level(i) && v(fl50, i) >= FLOOD_PCT;
        const idx = [], nearest = new Int32Array(n).fill(-1);
        for (let i = 0; i < n; i++) {
            if (v(pop, i) <= 0) continue;
            let best = Infinity;
            for (const j of subs) {
                const d = Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx);
                if (d < best) { best = d; nearest[i] = j; }
            }
            if (best <= SUB_KM) idx.push(i);
        }
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = level(nearest[i]);
        const total = subs.reduce((a, j) => a + sub[j], 0);
        const count = pred => subs.reduce((a, j) => a + (pred(j) ? sub[j] : 0), 0);
        const dark = idx.filter(i => level(nearest[i]) > 0), pDark = _sumOver(pop, dark, () => true), pAll = _sumOver(pop, idx, () => true);
        const stats = [
            { label: 'Substations mapped', value: String(total) },
            { label: `…in the 100-year flood (${FLOOD_PCT}%+ of the block) / waterlogged`, value: `${count(j => level(j) === 2)} / ${count(j => level(j) === 1)}` },
        ];
        if (fl50) stats.push({ label: '…dry today but in the 100-year flood by 2050', value: String(count(later)) });
        stats.push({ label: `Residents whose nearest substation (within ${SUB_KM} km) is on wet ground`, value: `${_people(pDark)} (${_round(100 * pDark / (pAll || 1))}% of those near one)` });
        const served = new Float64Array(n);
        for (const i of idx) served[nearest[i]] += pop[i];
        const wet = subs.filter(j => level(j) > 0);
        spaced(g, wet, Float64Array.from({ length: n }, (_, j) => served[j] * level(j))).forEach((j, k) => stats.push({
            label: `Raise or wall ${k + 1}: ${g.codes[j]}`,
            value: `${_round(sub[j])} substation${sub[j] > 1 ? 's' : ''}; ${level(j) === 2 ? `${_round(v(fl, j))}% of the block in the 100-year flood` : `waterlogging index ${_round(v(wl, j))}`}; nearest for ${_people(served[j])} residents` }));
        return {
            columns: { substation_wet: out }, idx, weightKey: 'substation_wet', noHotspots: true,
            metric: { label: 'Substations on flood-prone or waterlogged ground', value: _round(100 * count(j => level(j) > 0) / (total || 1)), unit: '%', higherIs: 'worse' },
            headline: `${count(j => level(j) > 0)} of ${total} mapped substations stand on flood-prone or waterlogged ground${fl50 && count(later) ? `, and ${count(later)} more join them by 2050` : ''}. ${_people(pDark)} residents have one of those as their nearest substation: when it floods and is switched off, their pumps, lifts and clinics go dark too. The substations listed serve the most people, the first to raise or flood-wall, at least ${SPACING_KM} km apart. Grid feeds are not public, so the nearest substation stands in for the one that serves a home.`,
            stats,
        };
    }

    // Coaching hubs. Students crowd into coaching classes, libraries and PG hostels packed into old blocks, often in
    // basements: the 2023 Mukherjee Nagar fire and the 2024 Old Rajinder Nagar basement flood in Delhi. A hub block has
    // HUB_MIN coaching centres within HUB_KM and is in the city's top tenth; it is then checked for waterlogging
    // (basements flood first), packed lanes (fire access) and distance to a fire station.
    const HUB_KM = 0.5, HUB_MIN = 10, HUB_Q = 0.9;

    function coaching(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], co = c['places.coaching'];
        if (!co) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const wl = c['waterlogging.waterlogging_index'], cover = c['building_stock.cover_2023_pct'], fire = c['places.fire_stations'];
        const major = c['osm_roads.major_km_km2'], sec = c['osm_roads.secondary_km_km2'], hostels = c['places.hostels'];
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 || v(co, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(co, i)), HUB_KM);
        const q = Math.max(HUB_MIN, wquantile(near, null, idx.filter(i => near[i] > 0), HUB_Q));
        const hubs = idx.filter(i => near[i] >= q);
        if (!hubs.length) return null;
        const road = major ? within(g, Float64Array.from({ length: n }, (_, i) => v(major, i) + v(sec, i)), DEEP_KM) : null;
        const fs = fire ? within(g, Float64Array.from({ length: n }, (_, i) => v(fire, i)), FIRE_KM) : null;
        const stations = fire ? idx.reduce((a, i) => a + v(fire, i), 0) : 0;
        const CHECKS = [
            ['waterlogged (basements flood first)', i => v(wl, i) >= WET_INDEX * 0.75],
            ['packed, no main road within 300 m', i => road && v(cover, i) >= PACKED_PCT && road[i] <= 0],
            [`no fire station within ${FIRE_KM} km`, i => stations >= FIRE_MIN && fs[i] <= 0],
            [`packed (${PACKED_PCT}%+ under roofs)`, i => v(cover, i) >= PACKED_PCT],
        ];
        const flags = i => CHECKS.filter(([, t]) => t(i)).map(([l]) => l);
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = near[i] >= q ? 1 + Math.min(2, flags(i).length) : 0;
        const stats = [{ label: `Coaching hub blocks (${_round(q)}+ coaching centres within ${HUB_KM * 1000} m)`, value: String(hubs.length) }];
        for (const [l, t] of CHECKS) stats.push({ label: `…${l}`, value: String(hubs.filter(t).length) });
        const score = Float64Array.from({ length: n }, (_, i) => (near[i] >= q ? near[i] * (1 + flags(i).length) * (1 + v(hostels, i) / 10) : 0));
        spaced(g, hubs, score).forEach((i, k) => stats.push({
            label: `Hub ${k + 1}: ${g.codes[i]}`,
            value: `${_round(near[i])} coaching centres within ${HUB_KM * 1000} m${hostels && v(hostels, i) > 0 ? `, ${_round(v(hostels, i))} hostel${v(hostels, i) > 1 ? 's' : ''} in the block` : ''}; ${flags(i).join(', ') || 'no hazard flagged'}` }));
        const flagged = hubs.filter(i => flags(i).length).length;
        return {
            columns: { coaching_hub: out }, idx, weightKey: 'coaching_hub', noHotspots: true,
            metric: { label: 'Coaching hub blocks with a hazard flag', value: _round(100 * flagged / hubs.length), unit: '%', higherIs: 'worse' },
            headline: `${hubs.length} blocks are coaching hubs, with ${_round(q)} or more coaching centres within ${HUB_KM * 1000} m; ${flagged} of them carry a hazard flag (waterlogging, packed buildings or lanes, or a far fire station). Students study and sleep here in basements and upper floors of crowded buildings, the setting of Delhi's 2023 Mukherjee Nagar fire and 2024 Old Rajinder Nagar basement flood. The hubs listed are the biggest and most flagged, the first for basement, exit and fire-safety checks, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Rooftop rainwater. Every roof is a catchment: roof area × annual rain × RUNOFF (CGWB's coefficient for hard roofs)
    // is what a block could harvest. Set against each resident's need of LPCD litres a day (CPHEEO) and the local fall
    // in groundwater, it shows where harvesting tanks and recharge wells pay back most.
    const RUNOFF = 0.8, LPCD = 135;

    function rainharvest(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const cover = c['building_stock.cover_2023_pct'], rain = c['rainfall.rain_annual_mm'], fall = c['water_risk.groundwater_decline_cm_yr'];
        if (!cover || !rain) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(cover, i) > 0 && v(rain, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const m3 = Float64Array.from({ length: n }, (_, i) => v(cover, i) / 100 * g.cellKm2 * 1e6 * v(rain, i) / 1000 * RUNOFF);
        const lpd = new Float64Array(n).fill(NaN);
        for (const i of idx) lpd[i] = v(pop, i) > 0 ? m3[i] * 1000 / 365 / pop[i] : NaN;
        const total = idx.reduce((a, i) => a + m3[i], 0), people = _sumOver(pop, idx, () => true);
        const lived = idx.filter(i => v(pop, i) > 0);
        const med = lived.length ? wquantile(lpd, pop, lived, 0.5) : 0;
        const falling = fall ? lived.filter(i => v(fall, i) > 0) : [];
        const stats = [
            { label: 'Rain falling on roofs a year (80% captured)', value: `${_round(total / 1e6, 1)} million m³` },
            { label: '…per resident a day, median resident', value: `${_round(med)} litres (${_round(100 * med / LPCD)}% of the ${LPCD} l/day norm)` },
            { label: '…as a share of what residents need in a year', value: `${_round(100 * total * 1000 / 365 / (people * LPCD || 1))}%` },
        ];
        if (fall) stats.push({ label: 'Residents where groundwater is falling', value: `${_people(_sumOver(pop, falling, () => true))} (${_round(100 * _sumOver(pop, falling, () => true) / (people || 1))}%)` });
        const score = Float64Array.from({ length: n }, (_, i) => m3[i] * (1 + Math.max(0, v(fall, i)) / 10));
        spaced(g, lived, score).forEach((i, k) => stats.push({
            label: `Harvest ${k + 1}: ${g.codes[i]}`,
            value: `${_round(m3[i] / 1000, 1)} thousand m³ a year off ${_round(v(cover, i))}% roof cover; ${_round(lpd[i])} l per resident a day${fall ? `; groundwater ${v(fall, i) > 0 ? `falling ${_round(v(fall, i), 1)} cm a year` : 'steady or rising'}` : ''}` }));
        return {
            columns: { harvest_m3: m3, harvest_lpd: lpd }, idx, weightKey: 'harvest_m3', noHotspots: true,
            metric: { label: 'Roof rain per resident a day (median)', value: _round(med), unit: 'l', higherIs: 'better' },
            headline: `About ${_round(total / 1e6, 1)} million m³ of rain falls on the city's roofs each year and could be caught at ${Math.round(RUNOFF * 100)}% efficiency: ${_round(med)} litres per resident a day for the median resident, ${_round(100 * total * 1000 / 365 / (people * LPCD || 1))}% of what the whole city needs at ${LPCD} litres a day. Most of it runs into drains in a few monsoon weeks, so storage or recharge wells decide how much is kept. The blocks listed would yield the most${falling.length ? ', weighted to where groundwater is falling' : ''}, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Construction dust and heat. Open sites throw dust over the homes, classrooms and wards beside them, and their
    // labourers work in the open through the pre-monsoon heat. Sites are cleared (1), building up (2) or stalled bare (3)
    // in the sites dataset; sensitive means a school or hospital within DUST_KM; hot means a surface temperature HOT_ABOVE_C
    // above the city median (Landsat, pre-monsoon), with no drinking-water point mapped within DUST_KM.
    const DUST_KM = 0.5, HOT_ABOVE_C = 2;

    function sitedust(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], st = c['sites.site_status'];
        if (!st) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const sch = c['emergency_access.schools'], hosp = c['places.hospitals'], uhi = c['surface_heat.uhi_anomaly_c'], water = c['street_infra.drinking_water'];
        const active = i => v(st, i) >= 1;   // cleared, building up or stalled: all bare ground that blows dust
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 || active(i)) idx.push(i);
        const sites = idx.filter(active);
        if (idx.length < 5 || !sites.length) return null;
        const sens = within(g, Float64Array.from({ length: n }, (_, i) => v(sch, i) + v(hosp, i)), DUST_KM);
        const ppl = within(g, Float64Array.from({ length: n }, (_, i) => v(pop, i)), DUST_KM);
        const tap = water ? within(g, Float64Array.from({ length: n }, (_, i) => v(water, i)), DUST_KM) : null;
        const hot = i => v(uhi, i) >= HOT_ABOVE_C, dry = i => tap && tap[i] <= 0;
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = active(i) ? 1 + (sens[i] > 0 ? 1 : 0) + (hot(i) ? 1 : 0) : 0;
        const nearSens = sites.filter(i => sens[i] > 0), hotSites = sites.filter(hot), hotDry = hotSites.filter(dry);
        // Residents within DUST_KM of any active site.
        const nearSite = within(g, Float64Array.from({ length: n }, (_, i) => (active(i) ? 1 : 0)), DUST_KM);
        const exposed = idx.filter(i => v(pop, i) > 0 && nearSite[i] > 0);
        const pExp = _sumOver(pop, exposed, () => true), all = _sumOver(pop, idx, () => true);
        const stats = [
            { label: 'Construction blocks (cleared, building up or stalled bare)', value: String(sites.length) },
            { label: `Residents within ${DUST_KM * 1000} m of one`, value: `${_people(pExp)} (${_round(100 * pExp / (all || 1))}%)` },
            { label: `…sites with a school or hospital within ${DUST_KM * 1000} m`, value: String(nearSens.length) },
            { label: `…sites ${HOT_ABOVE_C}°C+ hotter than the city (surface, pre-monsoon)`, value: `${hotSites.length}${tap ? `, ${hotDry.length} with no drinking-water point mapped within ${DUST_KM * 1000} m` : ''}` },
        ];
        const score = Float64Array.from({ length: n }, (_, i) => (active(i) ? ppl[i] * (1 + sens[i]) * (hot(i) ? 1.5 : 1) : 0));
        spaced(g, sites, score).forEach((i, k) => stats.push({
            label: `Dust control ${k + 1}: ${g.codes[i]}`,
            value: `${['', 'cleared this year', 'building up', 'stalled, still bare'][v(st, i)] || 'site'}; ${_people(ppl[i])} residents and ${_round(sens[i])} school${sens[i] === 1 ? '' : 's'} or hospitals within ${DUST_KM * 1000} m${hot(i) ? `; ${_round(v(uhi, i), 1)}°C above the city` : ''}` }));
        return {
            columns: { site_dust: out }, idx, weightKey: 'site_dust', noHotspots: true,
            metric: { label: `Residents within ${DUST_KM * 1000} m of active construction`, value: _round(100 * pExp / (all || 1)), unit: '%', higherIs: 'worse' },
            headline: `${sites.length} blocks are construction sites (cleared, building up or stalled bare), and ${_people(pExp)} residents live within ${DUST_KM * 1000} m of one; ${nearSens.length} of those sites have a school or hospital within ${DUST_KM * 1000} m. ${hotSites.length} sites are ${HOT_ABOVE_C}°C or more hotter than the city at the surface, where labourers work in the open through April and May${tap ? `, ${hotDry.length} with no drinking-water point mapped nearby` : ''}. The sites listed have the most neighbours, classrooms and wards around them: the first for dust screens, wet suppression and covered loads, and for shaded rest and water for workers, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Budget-hotel clusters. Guest houses packed into old, narrow-laned quarters burn with guests asleep who do not
    // know the exits (Karol Bagh's Hotel Arpit Palace, 2019). A cluster block has HUB_MIN lodgings within HUB_KM and is
    // in the city's top HOTEL_Q share; it is flagged for packed buildings, deep lanes, a far fire station and old stock.
    const HOTEL_Q = 0.97;

    function hotelfire(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], lodge = c['places.lodging'];
        if (!lodge) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const cover = c['building_stock.cover_2023_pct'], fire = c['places.fire_stations'], sy = c['building_dynamics.settled_year'];
        const major = c['osm_roads.major_km_km2'], sec = c['osm_roads.secondary_km_km2'];
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 || v(lodge, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(lodge, i)), HUB_KM);
        const q = Math.max(HUB_MIN, wquantile(near, null, idx.filter(i => near[i] > 0), HOTEL_Q));
        const hubs = idx.filter(i => near[i] >= q);
        if (!hubs.length) return null;
        const road = major ? within(g, Float64Array.from({ length: n }, (_, i) => v(major, i) + v(sec, i)), DEEP_KM) : null;
        const fs = fire ? within(g, Float64Array.from({ length: n }, (_, i) => v(fire, i)), FIRE_KM) : null;
        const stations = fire ? idx.reduce((a, i) => a + v(fire, i), 0) : 0;
        const CHECKS = [
            [`packed (${PACKED_PCT}%+ under roofs)`, i => v(cover, i) >= PACKED_PCT],
            [`no main road within ${DEEP_KM * 1000} m`, i => road && road[i] <= 0],
            [`no fire station within ${FIRE_KM} km`, i => stations >= FIRE_MIN && fs[i] <= 0],
            [`settled by ${OLD_YEAR}`, i => sy && _fin(sy[i]) && sy[i] <= OLD_YEAR],
        ];
        const flags = i => CHECKS.filter(([, t]) => t(i)).map(([l]) => l);
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = near[i] >= q ? 1 + Math.min(2, flags(i).length) : 0;
        const stats = [{ label: `Hotel cluster blocks (${_round(q)}+ hotels and guest houses within ${HUB_KM * 1000} m)`, value: String(hubs.length) }];
        for (const [l, t] of CHECKS) stats.push({ label: `…${l}`, value: String(hubs.filter(t).length) });
        const score = Float64Array.from({ length: n }, (_, i) => (near[i] >= q ? near[i] * (1 + flags(i).length) : 0));
        spaced(g, hubs, score).forEach((i, k) => stats.push({
            label: `Hotel audit ${k + 1}: ${g.codes[i]}`,
            value: `${_round(near[i])} hotels and guest houses within ${HUB_KM * 1000} m; ${flags(i).join(', ') || 'no hazard flagged'}` }));
        const multi = hubs.filter(i => flags(i).length >= 2).length;
        return {
            columns: { hotel_fire: out }, idx, weightKey: 'hotel_fire', noHotspots: true,
            metric: { label: 'Hotel clusters with two or more fire flags', value: _round(100 * multi / hubs.length), unit: '%', higherIs: 'worse' },
            headline: `${hubs.length} blocks are hotel and guest-house clusters, with ${_round(q)} or more within ${HUB_KM * 1000} m; ${multi} of them carry two or more fire flags (packed buildings, no main road within ${DEEP_KM * 1000} m, a far fire station, old stock). Guests asleep in unfamiliar buildings are the hardest to get out, as Karol Bagh's 2019 Hotel Arpit Palace fire showed. The clusters listed are the biggest and most flagged, the first for fire NOC, exit and rooftop-structure checks, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Quarries beside homes. Working quarries blast and throw dust; abandoned ones fill with rain into deep, steep-sided
    // pits where children swim and drown. A quarry block has QUARRY_PCT of its land mapped as quarry (OpenStreetMap);
    // flooded means PIT_WATER_PCT of it is open water (ESA WorldCover). Residents and children within NEXT_KM are counted.
    const QUARRY_PCT = 10, PIT_WATER_PCT = 5;

    function quarries(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], qy = c['landuse.quarry_pct'];
        if (!qy) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const water = c['land_cover.water_pct'], kids = c['demographics.children_pct'];
        const isQ = i => v(qy, i) >= QUARRY_PCT, wet = i => isQ(i) && v(water, i) >= PIT_WATER_PCT;
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 || isQ(i)) idx.push(i);
        const qs = idx.filter(isQ);
        if (idx.length < 5 || !qs.length) return null;
        const nearQ = within(g, Float64Array.from({ length: n }, (_, i) => (isQ(i) ? 1 : 0)), NEXT_KM);
        const nearW = within(g, Float64Array.from({ length: n }, (_, i) => (wet(i) ? 1 : 0)), NEXT_KM);
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = nearW[i] > 0 ? 2 : nearQ[i] > 0 ? 1 : 0;
        const nq = idx.filter(i => v(pop, i) > 0 && nearQ[i] > 0), nw = idx.filter(i => v(pop, i) > 0 && nearW[i] > 0);
        const child = i => v(pop, i) * v(kids, i) / 100;
        const sum = (list, f) => list.reduce((a, i) => a + f(i), 0);
        const ppl = within(g, Float64Array.from({ length: n }, (_, i) => v(pop, i)), NEXT_KM);
        const stats = [
            { label: `Quarry blocks (${QUARRY_PCT}%+ mapped as quarry)`, value: `${qs.length}, ${qs.filter(wet).length} holding water` },
            { label: `Residents within ${NEXT_KM * 1000} m of a quarry`, value: _people(sum(nq, i => v(pop, i))) },
            { label: `…of a flooded quarry pit`, value: `${_people(sum(nw, i => v(pop, i)))}${kids ? `, about ${_people(sum(nw, child))} of them children` : ''}` },
        ];
        spaced(g, qs, Float64Array.from({ length: n }, (_, i) => (isQ(i) ? ppl[i] * (wet(i) ? 3 : 1) : 0))).forEach((i, k) => stats.push({
            label: `Fence or fill ${k + 1}: ${g.codes[i]}`,
            value: `${_round(v(qy, i))}% quarry${wet(i) ? `, ${_round(v(water, i))}% standing water` : ''}; ${_people(ppl[i])} residents within ${NEXT_KM * 1000} m` }));
        return {
            columns: { quarry_near: out }, idx, weightKey: 'quarry_near', noHotspots: true,
            metric: { label: 'Residents within 500 m of a flooded quarry pit', value: Math.round(sum(nw, i => v(pop, i))), unit: 'people', higherIs: 'worse' },
            headline: `${qs.length} blocks are mapped as quarries, ${qs.filter(wet).length} of them holding water. ${_people(sum(nq, i => v(pop, i)))} residents live within ${NEXT_KM * 1000} m of one, breathing blast dust${nw.length ? `, and ${_people(sum(nw, i => v(pop, i)))} within ${NEXT_KM * 1000} m of a flooded pit${kids ? ` (about ${_people(sum(nw, child))} children)` : ''}: deep, cold, steep-sided water where children swim and drown` : ''}. Quarry mapping is patchy, so treat these as a floor. The quarries listed have the most people around them, the first to fence, sign or fill, at least ${SPACING_KM} km apart.`,
            stats,
        };
    }

    // Fuel stations among homes. Petrol and CNG stations store tens of thousands of litres under the forecourt; siting
    // rules keep them clear of schools and hospitals and out of crowded lanes. At block scale (about 250 m) a station
    // is flagged when its block also holds a school or hospital, is packed, or lies in the 100-year flood (tank leaks).
    function fuelsafe(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], fuel = c['places.fuel'];
        if (!fuel) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const sch = c['emergency_access.schools'], hosp = c['places.hospitals'], cover = c['building_stock.cover_2023_pct'], fl = c['flood_future.any_pct_now'];
        const idx = [];
        for (let i = 0; i < n; i++) if (v(fuel, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const CHECKS = [
            ['sharing a block with a school or hospital', i => v(sch, i) + v(hosp, i) > 0],
            [`in a packed block (${PACKED_PCT}%+ under roofs)`, i => v(cover, i) >= PACKED_PCT],
            ['in the 100-year flood', i => v(fl, i) >= FLOOD_PCT],
        ];
        const flags = i => CHECKS.filter(([, t]) => t(i)).map(([l]) => l);
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = flags(i).length;
        const total = idx.reduce((a, i) => a + fuel[i], 0);
        const count = t => idx.reduce((a, i) => a + (t(i) ? fuel[i] : 0), 0);
        const stats = [{ label: 'Fuel stations listed', value: String(total) }];
        for (const [l, t] of CHECKS) stats.push({ label: `…${l}`, value: String(count(t)) });
        const multi = count(i => flags(i).length >= 2);
        spaced(g, idx, Float64Array.from({ length: n }, (_, i) => (v(fuel, i) > 0 ? flags(i).length * (1 + v(pop, i) / 1000) : 0))).forEach((i, k) => stats.push({
            label: `Fuel station check ${k + 1}: ${g.codes[i]}`,
            value: `${_round(fuel[i])} station${fuel[i] > 1 ? 's' : ''}; ${_people(v(pop, i))} residents in the block; ${flags(i).join(', ') || 'no flag'}` }));
        return {
            columns: { fuel_flags: out }, idx, weightKey: 'fuel_flags', noHotspots: true,
            metric: { label: 'Fuel stations sharing a block with a school or hospital', value: _round(100 * count(CHECKS[0][1]) / (total || 1)), unit: '%', higherIs: 'worse' },
            headline: `${count(CHECKS[0][1])} of ${total} listed fuel stations share a block (about 250 m across) with a school or hospital, ${count(CHECKS[1][1])} stand in packed blocks and ${count(CHECKS[2][1])} in the 100-year flood; ${multi} carry two or more of these flags. The stations listed have the most flags and the most residents around them, the first to check against the siting and safety-distance rules, at least ${SPACING_KM} km apart. A block cannot show the 30-50 m distances the rules set, so this is where to measure.`,
            stats,
        };
    }

    // Tests, teeth and eyes. Blood tests and scans, dental care and cataract checks are mostly paid for out of pocket at
    // private labs and clinics; the lens counts listed ones within reach of where people live, and old-age homes against
    // the over-60s. Government dispensaries and hospital labs are only partly listed, so gaps are where to check first.
    const LAB_KM = 2, DENT_KM = 2, EYE_KM = 3;

    function carekit(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], old = c['demographics.elderly_60plus'];
        const lab = c['places.diagnostics'], dent = c['places.dental'], eye = c['places.eyecare'], homes = c['places.elder_homes'];
        if (!pop || !lab || !dent || !eye) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) idx.push(i);
        const sum = a => idx.reduce((s, i) => s + v(a, i), 0);
        if (idx.length < 5 || sum(lab) < 10) return null;
        const reach = (a, km) => within(g, Float64Array.from({ length: n }, (_, i) => v(a, i)), km);
        const labN = reach(lab, LAB_KM), dentN = reach(dent, DENT_KM), eyeN = reach(eye, EYE_KM);
        const gaps = new Float64Array(n).fill(NaN);
        for (const i of idx) gaps[i] = (labN[i] <= 0 ? 1 : 0) + (dentN[i] <= 0 ? 1 : 0) + (eyeN[i] <= 0 ? 1 : 0);
        const all = _sumOver(pop, idx, () => true), pct = p => _round(100 * p / (all || 1), 1);
        const noLab = _sumOver(pop, idx, i => labN[i] <= 0), noDent = _sumOver(pop, idx, i => dentN[i] <= 0);
        const noEye = _sumOver(pop, idx, i => eyeN[i] <= 0), none = _sumOver(pop, idx, i => gaps[i] === 3);
        const stats = [
            { label: 'Diagnostic labs and imaging centres / dentists / eye clinics listed', value: `${_round(sum(lab))} / ${_round(sum(dent))} / ${_round(sum(eye))}` },
            { label: `Residents with no lab or scan centre within ${LAB_KM} km`, value: `${_people(noLab)} (${pct(noLab)}%)` },
            { label: `…with no dentist within ${DENT_KM} km`, value: `${_people(noDent)} (${pct(noDent)}%)` },
            { label: `…with no eye clinic within ${EYE_KM} km`, value: `${_people(noEye)} (${pct(noEye)}%)` },
            { label: '…with none of the three', value: `${_people(none)} (${pct(none)}%)` },
        ];
        if (old) {
            const o = _sumOver(old, idx, () => true), oEye = _sumOver(old, idx, i => eyeN[i] <= 0);
            stats.push({ label: `Residents 60+ (cataract age) with no eye clinic within ${EYE_KM} km`, value: `${_people(oEye)} (${_round(100 * oEye / (o || 1), 1)}%)` });
            if (homes && sum(homes) > 0) stats.push({ label: 'Residents 60+ per listed old-age home or senior service', value: _people(o / sum(homes)) });
        }
        const far = idx.filter(i => labN[i] <= 0);
        spaced(g, far, Float64Array.from({ length: n }, (_, i) => v(pop, i) * (1 + (_fin(gaps[i]) ? gaps[i] : 0)))).forEach((i, k) => stats.push({
            label: `Care point ${k + 1}: ${g.codes[i]}`,
            value: `${_people(v(pop, i))} residents; missing ${[labN[i] <= 0 && 'a lab', dentN[i] <= 0 && 'a dentist', eyeN[i] <= 0 && 'an eye clinic'].filter(Boolean).join(', ')}` }));
        return {
            columns: { care_gaps: gaps, labs_2km: labN }, idx, weightKey: 'care_gaps', noHotspots: true,
            metric: { label: `Residents with no diagnostic lab or scan centre listed within ${LAB_KM} km`, value: pct(noLab), unit: '%', higherIs: 'worse' },
            headline: `${_people(noLab)} residents (${pct(noLab)}%) have no diagnostic lab or scan centre listed within ${LAB_KM} km, ${pct(noDent)}% no dentist within ${DENT_KM} km and ${pct(noEye)}% no eye clinic within ${EYE_KM} km; ${_people(none)} lack all three. Collection centres, hospital labs and government dispensaries are only partly listed, so the blocks named are where to check for a gap first.`,
            stats,
        };
    }

    // Coal smoke upwind. Coal plants' tall stacks carry sulphur dioxide and fine sulphate particles tens of kilometres
    // downwind; the lens ranks blocks by coal capacity weighted by how often the wind blows from each plant towards them.
    const COAL_NEAR_KM = 20, PLUME_Q = 0.9;

    function coalplume(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], plume = c['power_plants.coal_plume'];
        const ckm = c['power_plants.coal_km'], c50 = c['power_plants.coal_mw_50km'], kids = c['demographics.under5'], pm = c['air_quality.pm25_ugm3'];
        if (!pop || !plume) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && _fin(plume[i])) idx.push(i);
        if (idx.length < 5 || !idx.some(i => plume[i] > 0)) return null;
        const all = _sumOver(pop, idx, () => true), pct = p => _round(100 * p / (all || 1), 1);
        const mean = idx.reduce((s, i) => s + pop[i] * plume[i], 0) / (all || 1);
        const q = wquantile(plume, pop, idx, PLUME_Q);
        const top = idx.filter(i => plume[i] >= q && plume[i] > 0), pTop = _sumOver(pop, top, () => true);
        const near = ckm ? _sumOver(pop, idx, i => _fin(ckm[i]) && ckm[i] <= COAL_NEAR_KM) : 0;
        const cap = idx.reduce((m, i) => Math.max(m, v(c50, i)), 0);
        const stats = [
            { label: 'Coal power capacity within 50 km of the most exposed block', value: `${_people(cap)} MW` },
            { label: `Residents within ${COAL_NEAR_KM} km of a coal plant`, value: `${_people(near)} (${pct(near)}%)` },
            { label: 'Upwind coal index, resident-weighted mean', value: String(_round(mean, 1)) },
            { label: `Residents in the most exposed tenth (index ${_round(q, 1)}+)`, value: _people(pTop) },
        ];
        if (kids) stats.push({ label: '…of them children under 5', value: _people(_sumOver(kids, top, () => true)) });
        if (pm) {
            const pmTop = top.reduce((s, i) => s + pop[i] * v(pm, i), 0) / (pTop || 1);
            stats.push({ label: 'Satellite PM2.5 in the most exposed tenth vs the city', value: `${_round(pmTop, 1)} vs ${_round(idx.reduce((s, i) => s + pop[i] * v(pm, i), 0) / (all || 1), 1)} µg/m³` });
        }
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = plume[i];
        spaced(g, top, Float64Array.from({ length: n }, (_, i) => v(pop, i) * v(plume, i))).forEach((i, k) => stats.push({
            label: `SO₂ monitor ${k + 1}: ${g.codes[i]}`,
            value: `upwind coal index ${_round(plume[i], 1)}; ${ckm && _fin(ckm[i]) ? `nearest coal plant ${_round(ckm[i])} km; ` : ''}${_people(pop[i])} residents` }));
        return {
            columns: { coal_plume: out }, idx, weightKey: 'coal_plume', noHotspots: true,
            metric: { label: 'Upwind coal index (resident-weighted)', value: _round(mean, 1), unit: 'index', higherIs: 'worse' },
            headline: `${_people(near)} residents (${pct(near)}%) live within ${COAL_NEAR_KM} km of a coal power plant, and ${_people(pTop)} live in the tenth of the city most often downwind of coal capacity. The index weighs each plant's megawatts by how often the wind blows from it towards the block and by distance; it shows where SO₂ and sulphate monitors and FGD deadlines matter most, not measured pollution.`,
            stats,
        };
    }

    // Smoke downwind of dumps and factories. Landfill fires (Ghazipur, Deonar, Perungudi, Brahmapuram) and odour, and
    // industrial stacks, reach the blocks the wind blows towards most often; the downwind dataset weights each source's
    // area by that wind share and distance.
    const OFTEN_PCT = 30, SMOKE_Q = 0.9;

    function dumpsmoke(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], ls = c['downwind.landfill_smoke'];
        const is = c['downwind.industry_smoke'], up = c['downwind.landfill_upwind'], kids = c['demographics.under5'];
        if (!pop || !ls) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && _fin(ls[i])) idx.push(i);
        if (idx.length < 5 || !idx.some(i => ls[i] > 0)) return null;
        const all = _sumOver(pop, idx, () => true), pct = p => _round(100 * p / (all || 1), 1);
        const often = idx.filter(i => ls[i] > 0 && v(up, i) >= OFTEN_PCT), pOften = _sumOver(pop, often, () => true);
        const near = _sumOver(pop, idx, i => ls[i] > 0);
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = ls[i];
        const stats = [
            { label: 'Residents within 3 km of a mapped landfill or dump, on its downwind side', value: `${_people(near)} (${pct(near)}%)` },
            { label: `…where ${OFTEN_PCT}%+ of the wind blows from a landfill`, value: `${_people(pOften)} (${pct(pOften)}%)` },
        ];
        if (kids) stats.push({ label: '…of them children under 5', value: _people(_sumOver(kids, often, () => true)) });
        if (is) {
            const q = wquantile(is, pop, idx, SMOKE_Q);
            const topI = idx.filter(i => v(is, i) >= q && v(is, i) > 0);
            stats.push({ label: 'Residents most often downwind of industrial land (top tenth, within 3 km)', value: _people(_sumOver(pop, topI, () => true)) });
        }
        spaced(g, idx.filter(i => ls[i] > 0), Float64Array.from({ length: n }, (_, i) => v(pop, i) * v(ls, i))).forEach((i, k) => stats.push({
            label: `Air and odour check ${k + 1}: ${g.codes[i]}`,
            value: `landfill smoke index ${_round(ls[i], 1)}; ${_round(v(up, i))}% of the wind from a landfill; ${_people(pop[i])} residents` }));
        return {
            columns: { landfill_smoke: out }, idx, weightKey: 'landfill_smoke', noHotspots: true,
            metric: { label: `Residents where ${OFTEN_PCT}%+ of the wind blows from a landfill within 3 km`, value: pct(pOften), unit: '%', higherIs: 'worse' },
            headline: `${_people(pOften)} residents (${pct(pOften)}%) live within 3 km of a mapped landfill or dump that ${OFTEN_PCT}% or more of the wind blows from, the first to get its smoke when it burns and its smell every day. The blocks named carry the most landfill area upwind for the most people: places for air monitors, fire watch and odour complaints to be logged. Unmapped dumps are missing.`,
            stats,
        };
    }

    // Power cuts from space. On a clear night a block whose lights drop while the rest of the city stays lit has most
    // likely lost supply; NASA's Black Marble daily night lights give two years of such nights for every ~1 km block.
    const CUTS_PCT = 5, CUTS_HEAT_C = 40;

    function powercuts(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], dark = c['blackouts.dark_nights_pct'];
        const old = c['demographics.elderly_60plus'], hot = c['humid_heat.hot_days_40c'], care = c['places.hospitals'];
        if (!pop || !dark) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && _fin(dark[i])) idx.push(i);
        if (idx.length < 5) return null;
        const all = _sumOver(pop, idx, () => true), pct = p => _round(100 * p / (all || 1), 1);
        const mean = idx.reduce((s, i) => s + pop[i] * dark[i], 0) / (all || 1);
        const freq = idx.filter(i => dark[i] >= CUTS_PCT), pF = _sumOver(pop, freq, () => true);
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = dark[i];
        const stats = [
            { label: 'Clear nights a block went dark while the city stayed lit, resident-weighted', value: `${_round(mean, 1)}%` },
            { label: `Residents in blocks dark on ${CUTS_PCT}%+ of clear nights`, value: `${_people(pF)} (${pct(pF)}%)` },
        ];
        if (old) stats.push({ label: '…of them aged 60+', value: _people(_sumOver(old, freq, () => true)) });
        if (hot) stats.push({ label: `…in blocks with ${CUTS_HEAT_C} °C+ days most years (fans and coolers stop)`, value: _people(_sumOver(pop, freq, i => v(hot, i) >= 1)) });
        if (care) stats.push({ label: '…hospitals listed in those blocks (backup power to check)', value: String(_round(freq.reduce((s, i) => s + v(care, i), 0))) });
        spaced(g, freq, Float64Array.from({ length: n }, (_, i) => v(pop, i) * v(dark, i))).forEach((i, k) => stats.push({
            label: `Feeder to check ${k + 1}: ${g.codes[i]}`, value: `dark on ${_round(dark[i], 1)}% of clear nights; ${_people(pop[i])} residents` }));
        return {
            columns: { dark_nights_pct: out }, idx, weightKey: 'dark_nights_pct', noHotspots: true,
            metric: { label: `Residents in blocks dark on ${CUTS_PCT}%+ of clear nights`, value: pct(pF), unit: '%', higherIs: 'worse' },
            headline: `${_people(pF)} residents (${pct(pF)}%) live in blocks that went dark on ${CUTS_PCT}% or more of clear nights while the rest of the city stayed lit, the signature of local power cuts in NASA's daily night-lights record. The typical resident's block went dark on ${_round(mean, 1)}% of clear nights. Satellite passes are after midnight, so evening load-shedding is missed and street lights switched off count too: read these as feeders to check.`,
            stats,
        };
    }

    // Homes on the forest edge. Where housing meets large forest (Aarey and Sanjay Gandhi National Park in Mumbai,
    // Bannerghatta, the Delhi Ridge), leopards, snakes and forest fires reach homes; children outdoors at dusk on dark,
    // unlit edges are most at risk. Forest is a block mostly under trees or protected; the edge is lived-in blocks near one.
    const FOREST_TREE_PCT = 60, FOREST_PROT_PCT = 50, FOREST_MIN = 25, EDGE_KM = 0.5, DARK_Q = 0.25;

    function wildedge(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], tree = c['land_cover.tree_pct'];
        const prot = c['landuse.protected_pct'], kids = c['demographics.under5'], rad = c['nightlights.radiance'];
        if (!pop || !tree) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const forest = Float64Array.from({ length: n }, (_, i) => (v(tree, i) >= FOREST_TREE_PCT || v(prot, i) >= FOREST_PROT_PCT ? 1 : 0));
        // a lone wooded block is a park, not a forest: require FOREST_MIN forest blocks within 1 km
        const mass = within(g, forest, 1);
        const big = Float64Array.from({ length: n }, (_, i) => (forest[i] && mass[i] >= FOREST_MIN ? 1 : 0));
        const near = within(g, big, EDGE_KM);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) idx.push(i);
        const edge = idx.filter(i => near[i] > 0 && !big[i]);
        if (idx.length < 5 || edge.length < 3) return null;
        const all = _sumOver(pop, idx, () => true), pE = _sumOver(pop, edge, () => true);
        const darkQ = rad ? wquantile(rad, pop, idx, DARK_Q) : null;
        const dark = rad ? edge.filter(i => v(rad, i) <= darkQ) : [];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = big[i] ? 2 : near[i] > 0 ? 1 : 0;
        const stats = [
            { label: `Residents within ${EDGE_KM * 1000} m of large forest or protected land`, value: `${_people(pE)} (${_round(100 * pE / (all || 1), 1)}%)` },
        ];
        if (kids) stats.push({ label: '…of them children under 5', value: _people(_sumOver(kids, edge, () => true)) });
        if (rad) stats.push({ label: "…in the darkest quarter of the city's blocks at night", value: _people(_sumOver(pop, dark, () => true)) });
        stats.push({ label: 'Residents living inside forest or protected blocks', value: _people(_sumOver(pop, idx, i => big[i] > 0)) });
        const score = Float64Array.from({ length: n }, (_, i) => v(pop, i) * (1 + v(near, i) / 10) * (rad && v(rad, i) <= darkQ ? 2 : 1));
        spaced(g, edge, score).forEach((i, k) => stats.push({
            label: `Edge to light and fence ${k + 1}: ${g.codes[i]}`,
            value: `${_people(pop[i])} residents${kids ? `, ${_people(v(kids, i))} under 5` : ''}; ${_round(near[i])} forest blocks within ${EDGE_KM * 1000} m${rad ? `; night radiance ${_round(v(rad, i), 1)}` : ''}` }));
        return {
            columns: { forest_edge: out }, idx, weightKey: 'forest_edge', noHotspots: true,
            metric: { label: `Residents within ${EDGE_KM * 1000} m of large forest`, value: _round(100 * pE / (all || 1), 1), unit: '%', higherIs: null },
            headline: `${_people(pE)} residents live within ${EDGE_KM * 1000} m of large forest or protected land, where wildlife (leopards on Mumbai's, Pune's and Bengaluru's edges), snakes and fire reach homes${rad ? `; ${_people(_sumOver(pop, dark, () => true))} of them in the darkest blocks at night` : ''}. Street lights, toilets indoors and cleared garbage on these edges cut conflicts; the blocks named have the most people on the darkest edges.`,
            stats,
        };
    }

    // School within walking distance. The Right to Education rules ask for a primary school within 1 km of every child
    // and an upper primary within 3 km. The lens counts school-age children (5-14) against mapped schools in reach.
    const RTE_KM = 1, UPPER_KM = 3, COLLEGE_KM = 5;

    function schoolgap(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, kids = c['demographics.school_age'], sch = c['emergency_access.schools'];
        const youth = c['demographics.youth_15_24'], col = c['places.colleges'];
        if (!kids || !sch) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(kids, i) > 0) idx.push(i);
        const schools = Float64Array.from({ length: n }, (_, i) => v(sch, i));
        if (idx.length < 5 || schools.reduce((a, b) => a + b, 0) < 10) return null;
        const near = within(g, schools, RTE_KM), far = within(g, schools, UPPER_KM);
        const kidsNear = within(g, Float64Array.from({ length: n }, (_, i) => v(kids, i)), RTE_KM);
        const all = _sumOver(kids, idx, () => true), pct = p => _round(100 * p / (all || 1), 1);
        const none1 = _sumOver(kids, idx, i => near[i] <= 0), none3 = _sumOver(kids, idx, i => far[i] <= 0);
        const per = new Float64Array(n).fill(NaN);
        for (const i of idx) per[i] = near[i] > 0 ? kidsNear[i] / near[i] : NaN;
        const gap = new Float64Array(n).fill(NaN);
        for (const i of idx) gap[i] = near[i] <= 0 ? (far[i] <= 0 ? 2 : 1) : 0;
        const crowd = wquantile(per, kids, idx.filter(i => _fin(per[i])), 0.5);
        const stats = [
            { label: 'Children aged 5-14', value: _people(all) },
            { label: 'Schools mapped (OpenStreetMap)', value: String(_round(idx.reduce((a, i) => a + v(sch, i), 0))) },
            { label: `Children with no mapped school within ${RTE_KM} km (RTE primary norm)`, value: `${_people(none1)} (${pct(none1)}%)` },
            { label: `…with none within ${UPPER_KM} km (upper primary norm)`, value: `${_people(none3)} (${pct(none3)}%)` },
            { label: `School-age children per mapped school within ${RTE_KM} km, typical child`, value: _people(crowd) },
        ];
        if (youth && col) {
            const cn = within(g, Float64Array.from({ length: n }, (_, i) => v(col, i)), COLLEGE_KM);
            const y = _sumOver(youth, idx, () => true), yNone = _sumOver(youth, idx, i => cn[i] <= 0);
            stats.push({ label: `Young people 15-24 with no college listed within ${COLLEGE_KM} km`, value: `${_people(yNone)} (${_round(100 * yNone / (y || 1), 1)}%)` });
        }
        spaced(g, idx.filter(i => near[i] <= 0), Float64Array.from({ length: n }, (_, i) => kidsNear[i])).forEach((i, k) => stats.push({
            label: `School site ${k + 1}: ${g.codes[i]}`, value: `${_people(kidsNear[i])} children 5-14 within ${RTE_KM} km and no mapped school` }));
        return {
            columns: { school_gap: gap, kids_per_school: per }, idx, weightKey: 'school_gap', noHotspots: true,
            metric: { label: `Children 5-14 with no mapped school within ${RTE_KM} km`, value: pct(none1), unit: '%', higherIs: 'worse' },
            headline: `${_people(none1)} children aged 5-14 (${pct(none1)}%) have no mapped school within ${RTE_KM} km, the Right to Education norm for primary schools, and ${_people(none3)} none within ${UPPER_KM} km. OpenStreetMap misses many government and low-fee schools, so check the blocks named against UDISE+ before calling them gaps; the typical child shares a nearby school with ${_people(crowd)} others.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'marketfire', equity: false, title: 'Fire risk in crowded markets', icon: '🔥',
            question: 'Which markets are packed tight and far from a fire station?',
            field: { key: 'market_fire', label: 'Market block (1), plus packed (2), plus no fire station within 3 km (3)', unit: '0-3', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            extra: [{ key: 'trade_500m', label: `Shops and eateries within ${MARKET_KM * 1000} m`, unit: 'places', higherIs: null, ramp: 'viridis', domain: [0, 400] }],
            needs: ['places.shopping', 'places.food', 'places.fire_stations', 'building_stock.cover_2023_pct', 'population.population'],
            method: `Market blocks are the city's top 5% by Overture Maps shops and eateries within ${MARKET_KM * 1000} m (and at least ${MARKET_MIN}). Packed means Google Open Buildings 2.5D (2023) roofs cover ${PACKED_PCT}% or more of the block, so buildings stand wall to wall. Far means no Overture-listed fire station within ${FIRE_KM} km straight line, a rough stand-in for the 3-5 minute urban response the Standing Fire Advisory Council norms aim for; reach is only judged where at least ${FIRE_MIN} stations are listed. Lane widths, wiring and stock are not in open data, so the picks are where to audit first, not a fire-risk rating.`,
            refs: 'Overture Maps places; Google Open Buildings 2.5D Temporal; Standing Fire Advisory Council norms (DGFS, MHA); National Building Code 2016 Part 4' },
        { id: 'oldtall', equity: false, title: 'Old buildings, now tall', icon: '🏚️',
            question: 'Where do people live in old, tall buildings that need a structural audit?',
            field: { key: 'audit_due', label: `Settled by ${OLD_YEAR} (1), plus buildings ${TALL_M} m+ (2), plus floors added since 2016 (3)`, unit: '0-3', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            needs: ['building_dynamics.settled_year', 'building_dynamics.built_1975_pct', 'building_dynamics.height_change_m', 'building_stock.height_2023_m', 'population.population'],
            method: `Old blocks were settled by ${OLD_YEAR} in the World Settlement Footprint Evolution (Landsat, 1985–2015, so ${OLD_YEAR} means "by ${OLD_YEAR}") or were at least ${OLD_1975}% built in GHSL 1975. Tall means a mean building height of ${TALL_M} m or more in Google Open Buildings 2.5D (2023), about three storeys. Floors added means the block's mean height grew ${ADDED_M}-${REBUILT_M} m from 2016 to 2023, half a storey to a storey across the block; a rise of ${REBUILT_M} m or more counts as rebuilt and drops out, since new towers on old land are built to current codes. Picks weigh residents by height, capped at ${MID_M} m. Construction year of single buildings is not in open data, and heights are model estimates (±3 m per building), so the map shows where audits should start, not which buildings are unsafe. Mumbai's municipal law (MMC Act s. 353B) already asks owners of buildings over 30 years old to file a structural audit.`,
            refs: 'World Settlement Footprint Evolution (Marconcini et al. 2021); GHSL P2023A; Google Open Buildings 2.5D Temporal (Sirko et al. 2023); IS 1893 (Part 1): 2016; IS 13920: 2016; MMC Act 1888 s. 353B' },
        { id: 'critwater', equity: false, title: 'Emergency services on wet ground', icon: '🏥',
            question: 'Which hospitals, fire and police stations flood or waterlog?',
            field: { key: 'facility_wet', label: 'Blocks with emergency services: dry (0), waterlogged (1), in the 100-year flood (2)', unit: '0-2', higherIs: 'worse', ramp: 'blues', domain: [0, 2] },
            needs: ['places.hospitals', 'places.fire_stations', 'places.police', 'emergency_access.schools', 'flood_future.any_pct_now', 'waterlogging.waterlogging_index', 'population.population'],
            method: `Hospitals, fire stations and police stations are Overture Maps places; schools (used as relief camps) are OpenStreetMap. A block is flood-prone where ${FLOOD_PCT}% or more of it lies in WRI Aqueduct's 1-in-100-year river or coastal flood today (about 1 km, no defences), and waterlogged where its rain waterlogging index (Sentinel-1 standing water 2021–2025, hollows, wetness and height above drainage) is ${WET_INDEX} or more. Stranded residents have at least one listed hospital within ${CARE_KM_WET} km, all of them on wet ground. A facility's own plinth, generator and access road are not in open data, so the picks are where to check first.`,
            refs: 'Overture Maps places; OpenStreetMap; WRI Aqueduct Floods v2; Sentinel-1 GRD; NDMA Guidelines on Hospital Safety (2016); NDMA Urban Flooding Guidelines (2010)' },
        { id: 'quake', equity: false, title: 'Earthquake shaking on soft ground', icon: '🫨',
            question: 'Who lives on soft or sandy ground that shakes hardest in an earthquake?',
            field: { key: 'quake_ground', label: `Soft ground (1), plus sandy (2), plus buildings ${QUAKE_TALL_M} m+ (3)`, unit: '0-3', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            needs: ['terrain.hand_m', 'soil.sand_pct', 'building_stock.height_2023_m', 'population.population'],
            method: `Soft ground is a block whose mean height above the nearest drain (MERIT Hydro HAND) is under ${SOFT_HAND_M} m: young floodplain and coastal sediments with a shallow water table, which amplify shaking. Sandy soft ground has ${SAND_PCT}% or more sand in the topsoil (SoilGrids 250 m), the soils that liquefy when saturated. Tall means a mean building height of ${QUAKE_TALL_M} m or more (Google Open Buildings 2.5D, 2023), about five storeys, whose sway period can match soft soil. The seismic zone is IS 1893 (Part 1): 2016. This is a proxy: borehole data, shear-wave velocity and groundwater depth are not open, and published microzonation studies (Delhi 2016, Kolkata, Chennai) are the authority where they exist.`,
            refs: 'MERIT Hydro (Yamazaki et al. 2019); SoilGrids 2.0 (Poggio et al. 2021); Google Open Buildings 2.5D Temporal; IS 1893 (Part 1): 2016; NDMA Guidelines on Seismic Microzonation (2011)' },
        { id: 'factoryhomes', equity: false, title: 'Homes beside factories', icon: '🏭',
            question: 'Where do homes and factories share the same ground?',
            field: { key: 'factory_homes', label: `Within ${NEXT_KM * 1000} m of industry (1), mixed block (2), mixed with thermal hotspots (3)`, unit: '0-3', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            needs: ['landuse.industrial_pct', 'landuse.residential_pct', 'fires.fire_days_yr', 'population.population'],
            method: `Industrial blocks have ${INDUSTRY_PCT}% or more of their land mapped as industrial in OpenStreetMap land use (via Overture Maps); mixed blocks also have ${HOMES_PCT}% or more mapped as housing. Thermal hotspots are VIIRS 375 m active-fire detections on ${HOT_DAYS} or more days a year, which in a city are mostly furnaces, kilns and waste burning. Residents within ${NEXT_KM * 1000} m are counted on the block grid. Land-use polygons can overlap, so the two shares can add past 100%. Hazardous-industry registers (Major Accident Hazard units under the MSIHC Rules 1989) and factory licences are not open, and mapping of land use is uneven, so this shows where to inspect, not which units are unsafe.`,
            refs: 'OpenStreetMap land use via Overture Maps; NASA FIRMS VIIRS 375 m active fires; MSIHC Rules 1989; Master Plan for Delhi 2021 (non-conforming industrial areas)' },
        { id: 'refuge', equity: false, title: 'Storm-surge shelter gaps', icon: '🌀',
            question: 'Who in the cyclone storm-surge zone has no shelter nearby?',
            field: { key: 'refuge_gap', label: `In the surge zone with a refuge (1), none within ${REFUGE_KM} km (2)`, unit: '0-2', higherIs: 'worse', ramp: 'reds', domain: [0, 2] },
            needs: ['flood_future.coast_pct_now', 'flood_future.coast_pct_2050', 'cyclones.wind_rl50_kmh', 'emergency_access.schools', 'places.community_centres', 'population.population'],
            method: `Exposed blocks have ${SURGE_PCT}% or more of their area in WRI Aqueduct's 1-in-100-year coastal flood today or by 2050 under RCP4.5 (storm surge, sea-level rise and subsidence, about 1 km, no defences). Refuges are schools (OpenStreetMap) and community halls (Overture), the buildings disaster plans open as shelters. Per-refuge load is the exposed residents within ${REFUGE_KM} km divided by the refuges there. Cyclone wind alone is left out: pucca homes ride it out, while the surge forces people to move. Whether a building is raised, sound and stocked is not in open data; inland cities return nothing.`,
            refs: 'WRI Aqueduct Floods v2; IBTrACS; NDMA Guidelines on Management of Cyclones (2008); National Cyclone Risk Mitigation Project (multipurpose cyclone shelters)' },
        { id: 'firelanes', equity: false, title: 'Fire engines in packed lanes', icon: '🚒',
            question: 'Where are homes packed deep in lanes a fire engine cannot reach?',
            field: { key: 'fire_lanes', label: `Packed (1), plus no main road within ${DEEP_KM * 1000} m (2), plus no fire station within ${FIRE_KM} km (3)`, unit: '0-3', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            needs: ['building_stock.cover_2023_pct', 'osm_roads.major_km_km2', 'osm_roads.secondary_km_km2', 'places.fire_stations', 'population.population'],
            method: `Packed blocks have ${PACKED_PCT}% or more of their area under roofs (Google Open Buildings 2.5D, 2023). Deep means no OpenStreetMap main or secondary road in the block or within ${DEEP_KM * 1000} m, so a fire tender (which needs a road about 4.5 m wide, NBC 2016 Part 4) stops short. Far means no Overture-listed fire station within ${FIRE_KM} km, judged only where ${FIRE_MIN} or more stations are listed (Overture lists fewer than half of them). Lane widths are not in open data, so this is where to check access, not a fire-risk rating.`,
            refs: 'Google Open Buildings 2.5D Temporal; OpenStreetMap roads; Overture Maps places; National Building Code 2016 Part 4; Standing Fire Advisory Council norms' },
        { id: 'schoolsafe', equity: false, title: 'School safety check', icon: '🏫',
            question: 'Which schools face floods, quakes, fire access, industry or road noise?',
            field: { key: 'school_hazards', label: 'Hazards at blocks with schools (flood, waterlogging, soft ground, packed lanes, industry, noise)', unit: 'hazards', higherIs: 'worse', ramp: 'reds', domain: [0, 4] },
            needs: ['emergency_access.schools', 'flood_future.any_pct_now', 'waterlogging.waterlogging_index', 'terrain.hand_m', 'building_stock.cover_2023_pct',
                'osm_roads.major_km_km2', 'osm_roads.secondary_km_km2', 'landuse.industrial_pct', 'traffic_noise.lden_db', 'population.population'],
            method: `Schools are OpenStreetMap schools counted per block. Each block with a school is checked against six hazards, with the thresholds of the other safety lenses: ${FLOOD_PCT}%+ of the block in the 1-in-100-year river or coastal flood (Aqueduct); a rain waterlogging index of ${WET_INDEX}+; soft ground under ${SOFT_HAND_M} m above the nearest drain where the city is in seismic zone III or higher; ${PACKED_PCT}%+ under roofs with no main or secondary road within ${DEEP_KM * 1000} m; industry within ${NEXT_KM * 1000} m; and modelled road noise of ${LOUD_DB} dB Lden or more. A hazard whose data is missing for a city is skipped. Building condition, fire exits and drills are not in open data.`,
            refs: 'NDMA School Safety Policy Guidelines (2016); OpenStreetMap; WRI Aqueduct Floods v2; MERIT Hydro; Google Open Buildings 2.5D; WHO Environmental Noise Guidelines (2018)' },
        { id: 'hospitalsafe', equity: false, title: 'Hospital safety check', icon: '🏥',
            question: 'Which hospitals face floods, quakes, fire access, industry or road noise?',
            field: { key: 'hospital_hazards', label: 'Hazards at blocks with hospitals (flood, waterlogging, soft ground, packed lanes, industry, noise)', unit: 'hazards', higherIs: 'worse', ramp: 'reds', domain: [0, 4] },
            needs: ['places.hospitals', 'flood_future.any_pct_now', 'waterlogging.waterlogging_index', 'terrain.hand_m', 'building_stock.cover_2023_pct',
                'osm_roads.major_km_km2', 'osm_roads.secondary_km_km2', 'landuse.industrial_pct', 'traffic_noise.lden_db', 'population.population'],
            method: `Places listed as hospitals in Overture Maps, counted per block, checked against the same six hazards as the school safety check: ${FLOOD_PCT}%+ of the block in the 1-in-100-year flood; a waterlogging index of ${WET_INDEX}+; soft ground under ${SOFT_HAND_M} m above the nearest drain in seismic zone III or higher; ${PACKED_PCT}%+ under roofs with no main road within ${DEEP_KM * 1000} m (ambulance and fire access); industry within ${NEXT_KM * 1000} m; road noise of ${LOUD_DB} dB Lden or more (WHO advises much less near wards). Structural and fire-safety status is not in open data.`,
            refs: 'NDMA Guidelines on Hospital Safety (2016); Overture Maps places; WRI Aqueduct Floods v2; MERIT Hydro; Google Open Buildings 2.5D; WHO Environmental Noise Guidelines (2018)' },
        { id: 'stationload', equity: false, title: 'Crowded local-train stations', icon: '🚆',
            question: 'Which suburban rail stations serve the most people?',
            field: { key: 'station_load', label: 'Residents sharing this block\'s nearest suburban station', unit: 'people per station', higherIs: 'worse', ramp: 'reds', domain: [0, 300000] },
            needs: ['rail_access.rail_stations', 'population.population'],
            method: `Suburban rail stations are Overture Maps and OpenStreetMap station points on mainline track (the rail_access dataset). Every lived-in block within ${CATCH_KM} km of a station is assigned to its nearest one (straight line on the block grid), and a station's load is the residents assigned to it, split across stations in the same block. This is a catchment, not ridership: it misses commuters who change trains, ride from farther away or choose a faster station, and open timetables (item 67) are still not available for Mumbai locals.`,
            refs: 'Overture Maps; OpenStreetMap; WorldPop; Commissioner of Railway Safety reports on suburban crowding' },
        { id: 'walkups', equity: true, title: 'Older people in walk-up flats', icon: '🪜',
            question: 'Where do older people live up stairs with no lift?',
            field: { key: 'elderly_walkup', label: `Residents 60+ in blocks of ${WALKUP_LO}-${WALKUP_HI} m buildings`, unit: 'people', higherIs: 'worse', ramp: 'reds', domain: [0, 1500] },
            needs: ['demographics.elderly_60plus', 'building_stock.height_2023_m', 'places.pharmacies'],
            method: `Residents aged 60+ are WorldPop age structure per block. Walk-up blocks have a mean building height of ${WALKUP_LO}-${WALKUP_HI} m in Google Open Buildings 2.5D (2023), about three to five storeys: the National Building Code 2016 asks for lifts above 15 m, so most such buildings have none. Pharmacies are Overture Maps places within ${PHARMA_KM * 1000} m. A block average mixes buildings, and lift retrofits are not in open data, so this ranks where to look.`,
            refs: 'WorldPop age structures; Google Open Buildings 2.5D Temporal; National Building Code 2016 Part 4 and Part 8 (lifts); Harmonised Guidelines for Universal Accessibility (MoHUA 2021)' },
        { id: 'treefall', equity: false, title: 'Monsoon tree-fall risk', icon: '🌳',
            question: 'Where do tall trees hang over busy roads before the monsoon?',
            field: { key: 'tree_fall', label: 'Tall canopy (1), over busy main roads (2)', unit: '0-2', higherIs: 'worse', ramp: 'greens', domain: [0, 2] },
            needs: ['vegetation.canopy_m', 'vegetation.tree_canopy_pct', 'osm_roads.major_km_km2', 'osm_roads.secondary_km_km2', 'rainfall.heavy_rain_days', 'cyclones.wind_rl50_kmh', 'population.population'],
            method: `Tall canopy covers ${TREE_COVER_PCT}% or more of the block with trees about ${TALL_TREE_M} m tall or more on average: the block's mean canopy height divided by its tree cover (Meta and WRI 1 m canopy height, from the vegetation dataset). Busy blocks are in the city's top half by OpenStreetMap main and secondary road density. Road length under canopy is road density × block area × canopy share. Picks weigh road density, canopy, height, heavy-rain days (CHIRPS) and cyclone wind. Tree species, age, rot and root damage from trenching, the real causes of falls, need a street tree census; this shows where to survey first.`,
            refs: 'Meta/WRI High Resolution Canopy Height (Tolan et al. 2024); OpenStreetMap; CHIRPS; IBTrACS; Indian Roads Congress IRC:SP:21 (roadside plantation)' },
        { id: 'gridflood', equity: false, title: 'Substations under water', icon: '⚡',
            question: 'Which power substations flood, and who loses power when they do?',
            field: { key: 'substation_wet', label: 'Nearest substation: dry (0), waterlogged (1), in the 100-year flood (2)', unit: '0-2', higherIs: 'worse', ramp: 'blues', domain: [0, 2] },
            needs: ['power_lines.substations', 'flood_future.any_pct_now', 'flood_future.any_pct_2050', 'waterlogging.waterlogging_index', 'population.population'],
            method: `Substations are OpenStreetMap power substations counted per block (the power_lines dataset). A substation's block is flood-prone with ${FLOOD_PCT}%+ of it in WRI Aqueduct's 1-in-100-year river or coastal flood (today or by 2050, RCP4.5) and waterlogged with a rain waterlogging index of ${WET_INDEX}+. Each lived-in block within ${SUB_KM} km of a substation is assigned its nearest one. Plinth heights, flood walls and the real feeder network are not open, so this is where to check, not who will lose power.`,
            refs: 'OpenStreetMap power=substation; WRI Aqueduct Floods v2; Sentinel-1; CEA (Technical Standards for Construction of Electrical Plants and Electric Lines) Regulations 2022; Maharashtra fact-finding report on the 26 July 2005 floods' },
        { id: 'coaching', equity: false, title: 'Coaching hub safety', icon: '📚',
            question: 'Which coaching hubs flood, pack tight or sit far from a fire station?',
            field: { key: 'coaching_hub', label: 'Coaching hub (1), plus one hazard flag (2), plus two or more (3)', unit: '0-3', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            needs: ['places.coaching', 'places.hostels', 'waterlogging.waterlogging_index', 'building_stock.cover_2023_pct', 'osm_roads.major_km_km2', 'osm_roads.secondary_km_km2', 'places.fire_stations', 'population.population'],
            method: `Coaching centres and hostels are Overture Maps places. Hub blocks have ${HUB_MIN} or more coaching centres within ${HUB_KM * 1000} m and sit in the city's top ${Math.round(100 * (1 - HUB_Q))}% of blocks with any. Flags: a rain waterlogging index of ${WET_INDEX * 0.75} or more (basements flood before streets do, so a lower bar than critwater); ${PACKED_PCT}%+ under roofs with no main road within ${DEEP_KM * 1000} m; no fire station listed within ${FIRE_KM} km (where ${FIRE_MIN}+ are listed). Basement use, exits and fire NOCs are not in open data.`,
            refs: 'Overture Maps places; Google Open Buildings 2.5D; OpenStreetMap; Delhi Fire Service; MHA guidelines on fire safety in coaching centres (2024); Guidelines for Regulation of Coaching Centres (Ministry of Education, 2024)' },
        { id: 'rainharvest', equity: false, title: 'Rooftop rainwater', icon: '🌧️',
            question: 'How much rain could roofs catch, and where does it matter most?',
            field: { key: 'harvest_m3', label: 'Rain off roofs a year (80% captured)', unit: 'm³', higherIs: 'better', ramp: 'blues', domain: [0, 60000] },
            extra: [{ key: 'harvest_lpd', label: 'Roof rain per resident a day', unit: 'litres', higherIs: 'better', ramp: 'blues', domain: [0, 135] }],
            needs: ['building_stock.cover_2023_pct', 'rainfall.rain_annual_mm', 'water_risk.groundwater_decline_cm_yr', 'population.population'],
            method: `Roof area is Google Open Buildings 2.5D roof cover (2023) × block area; rain is the CHIRPS annual mean (rainfall dataset); the runoff coefficient is ${RUNOFF} for hard roofs (CGWB Manual on Artificial Recharge of Ground Water, 2007). Litres per resident a day spread the year's catch over 365 days against the CPHEEO norm of ${LPCD} l/day for sewered cities; in practice it falls in a few monsoon months, so tank size limits what is used directly. Groundwater trend is the water_risk dataset (GRACE-based, coarse). Many cities make rooftop harvesting compulsory on larger plots (Delhi for plots of 100 m² and more).`,
            refs: 'Google Open Buildings 2.5D Temporal; CHIRPS; CGWB Manual on Artificial Recharge (2007); CPHEEO Manual on Water Supply (1999); Delhi Jal Board rainwater harvesting rules' },
        { id: 'sitedust', equity: false, title: 'Construction dust and heat', icon: '🏗️',
            question: 'Which building sites throw dust on schools and homes, and where do workers bake?',
            field: { key: 'site_dust', label: `Construction site (1), plus a school or hospital within ${DUST_KM * 1000} m (2), plus a hot site (3)`, unit: '0-3', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            needs: ['sites.site_status', 'emergency_access.schools', 'places.hospitals', 'surface_heat.uhi_anomaly_c', 'street_infra.drinking_water', 'population.population'],
            method: `Sites are blocks cleared this year, building up or stalled with bare ground in the sites dataset (Dynamic World built-up and bare-ground probabilities, two dry seasons apart). Residents, OpenStreetMap schools and Overture hospitals within ${DUST_KM * 1000} m are counted on the block grid. Hot sites have a pre-monsoon Landsat surface temperature ${HOT_ABOVE_C}°C or more above the city median; drinking-water points are OpenStreetMap. Site size, dust-control measures and worker numbers are not in open data, so this shows where to inspect.`,
            refs: 'Dynamic World (Brown et al. 2022); Landsat 8/9 thermal; OpenStreetMap; Overture Maps; Construction and Demolition Waste Management Rules 2016; CAQM dust-mitigation directions; NDMA heat action plan guidelines (2019)' },
        { id: 'hotelfire', equity: false, title: 'Hotel cluster fire safety', icon: '🏨',
            question: 'Which hotel and guest-house clusters are packed, deep in lanes or far from a fire station?',
            field: { key: 'hotel_fire', label: 'Hotel cluster (1), plus one fire flag (2), plus two or more (3)', unit: '0-3', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            needs: ['places.lodging', 'building_stock.cover_2023_pct', 'building_dynamics.settled_year', 'osm_roads.major_km_km2', 'osm_roads.secondary_km_km2', 'places.fire_stations', 'population.population'],
            method: `Hotels and guest houses are Overture Maps lodging places. Cluster blocks have ${HUB_MIN} or more within ${HUB_KM * 1000} m and sit in the city's top ${Math.round(100 * (1 - HOTEL_Q))}% of blocks with any. Flags: ${PACKED_PCT}%+ under roofs (Open Buildings 2023); no OpenStreetMap main or secondary road within ${DEEP_KM * 1000} m; no fire station listed within ${FIRE_KM} km (where ${FIRE_MIN}+ are listed); settled by ${OLD_YEAR} (WSF Evolution). Fire NOCs, rooftop structures and exits are not in open data.`,
            refs: 'Overture Maps places; Google Open Buildings 2.5D; OpenStreetMap; WSF Evolution; National Building Code 2016 Part 4; Delhi Fire Service Rules 2010' },
        { id: 'quarries', equity: false, title: 'Quarries and flooded pits near homes', icon: '⛏️',
            question: 'Where do people live beside quarries and water-filled pits?',
            field: { key: 'quarry_near', label: `Within ${NEXT_KM * 1000} m of a quarry (1), of a flooded pit (2)`, unit: '0-2', higherIs: 'worse', ramp: 'reds', domain: [0, 2] },
            needs: ['landuse.quarry_pct', 'land_cover.water_pct', 'demographics.children_pct', 'population.population'],
            method: `Quarry blocks have ${QUARRY_PCT}% or more of their land mapped as quarry in OpenStreetMap land use (via Overture). Flooded quarries also have ${PIT_WATER_PCT}% or more open water in ESA WorldCover 2021. Residents and children (WorldPop age structure) within ${NEXT_KM * 1000} m are counted on the block grid. Whether a quarry is working or abandoned, fenced or guarded is not in open data, and unmapped pits are missed.`,
            refs: 'OpenStreetMap landuse=quarry via Overture Maps; ESA WorldCover 2021; WorldPop; Mines and Minerals (Development and Regulation) Act 1957 (mine closure)' },
        { id: 'heritagesafe', equity: false, title: 'Heritage at risk', icon: '🏛️',
            question: 'Which monuments face floods, waterlogging, soft ground, packed lanes, industry or traffic?',
            field: { key: 'heritage_hazards', label: 'Hazards at blocks with listed monuments (flood, waterlogging, soft ground, packed lanes, industry, noise)', unit: 'hazards', higherIs: 'worse', ramp: 'reds', domain: [0, 4] },
            needs: ['heritage.national', 'heritage.state', 'heritage.local', 'flood_future.any_pct_now', 'waterlogging.waterlogging_index', 'terrain.hand_m', 'building_stock.cover_2023_pct',
                'osm_roads.major_km_km2', 'osm_roads.secondary_km_km2', 'landuse.industrial_pct', 'traffic_noise.lden_db', 'population.population'],
            method: `Monuments are Wikidata heritage listings (national, state and other grades) counted per block, checked against the six hazards of the school safety check: ${FLOOD_PCT}%+ of the block in the 1-in-100-year flood; a waterlogging index of ${WET_INDEX}+ (rising damp and foundation scour); soft ground under ${SOFT_HAND_M} m above the nearest drain in seismic zone III or higher; ${PACKED_PCT}%+ under roofs with no main road within ${DEEP_KM * 1000} m (fire access); industry within ${NEXT_KM * 1000} m (soot and acid deposition); road noise of ${LOUD_DB} dB Lden or more (heavy traffic and vibration). A monument's own condition and conservation plan are not in open data.`,
            refs: 'Wikidata; NDMA National Disaster Management Guidelines: Management of Cultural Heritage Sites and Precincts (2017); AMASR Act 1958 (amended 2010); WRI Aqueduct Floods v2; MERIT Hydro' },
        { id: 'fuelsafe', equity: false, title: 'Fuel stations among homes', icon: '⛽',
            question: 'Which petrol pumps sit beside schools, hospitals, packed homes or floodwater?',
            field: { key: 'fuel_flags', label: 'Flags at fuel-station blocks (school or hospital, packed, flood)', unit: 'flags', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            needs: ['places.fuel', 'emergency_access.schools', 'places.hospitals', 'building_stock.cover_2023_pct', 'flood_future.any_pct_now', 'population.population'],
            method: `Fuel stations are Overture Maps places (petrol, diesel and CNG). Each station block is flagged when it also holds an OpenStreetMap school or Overture hospital, when ${PACKED_PCT}%+ of it is under roofs (Open Buildings 2023), and when ${FLOOD_PCT}%+ of it lies in Aqueduct's 1-in-100-year flood. Siting rules (Petroleum Rules 2002 and oil-company and state guidelines) set distances of tens of metres from schools and hospitals, finer than a block, so a flag means "measure here", not a breach.`,
            refs: 'Overture Maps places; OpenStreetMap; Google Open Buildings 2.5D; WRI Aqueduct Floods v2; Petroleum Rules 2002 (PESO); OISD-STD-244 (retail outlet safety)' },
        { id: 'carekit', equity: true, title: 'Tests, teeth and eyes', icon: '🔬',
            question: 'Where are people far from a diagnostic lab, a dentist or an eye clinic?',
            field: { key: 'care_gaps', label: 'Missing within reach: lab, dentist, eye clinic', unit: 'of 3', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            extra: [{ key: 'labs_2km', label: `Diagnostic labs and scan centres within ${LAB_KM} km`, unit: 'places', higherIs: 'better' }],
            needs: ['places.diagnostics', 'places.dental', 'places.eyecare', 'places.elder_homes', 'demographics.elderly_60plus', 'population.population'],
            method: `Labs are Overture Maps places in the diagnostic imaging, laboratory testing and radiology categories; dentists every dental clinic and dentist category; eye clinics vision and eye care clinics, ophthalmologists and optometrists (not opticians' shops). Reach is straight-line distance between block centres: ${LAB_KM} km for a lab, ${DENT_KM} km for a dentist and ${EYE_KM} km for an eye clinic. Old-age homes are retirement homes and senior citizen services. Listings follow where clinics list themselves online, so public dispensaries, hospital departments and sample-collection points are undercounted.`,
            refs: 'Overture Maps places; WorldPop age structure; National Programme for Control of Blindness and Visual Impairment; Free Diagnostics Service Initiative (NHM, 2015)' },
        { id: 'coalplume', equity: false, title: 'Coal smoke upwind', icon: '🏭',
            question: 'Which neighbourhoods sit downwind of coal power plants?',
            field: { key: 'coal_plume', label: 'Upwind coal index (MW × downwind wind share ÷ km)', unit: 'index', higherIs: 'worse', ramp: 'reds' },
            needs: ['power_plants.coal_plume', 'power_plants.coal_km', 'power_plants.coal_mw_50km', 'demographics.under5', 'air_quality.pm25_ugm3', 'population.population'],
            method: `Coal, gas and oil plants within 150 km come from the WRI Global Power Plant Database (a 2018-2021 snapshot; known retirements such as Delhi's Badarpur removed). Each coal plant adds its capacity × the share of ERA5-Land monthly 10 m wind (2015-2024, speed-weighted, at the city centre) blowing from it towards the block within ±45°, divided by the distance in km (at least 5). The most exposed tenth is by residents. Stack heights, flue-gas desulphurisation status, load factors and terrain are left out: this ranks where plumes are likelier to arrive, it does not measure them.`,
            refs: 'WRI Global Power Plant Database (Byers et al. 2019); ECMWF ERA5-Land; MoEFCC thermal power plant SO₂ norms (2015, FGD deadlines revised 2021 and 2022); CREA studies of Indian coal plant plumes' },
        { id: 'dumpsmoke', equity: true, title: 'Downwind of the dump', icon: '🗑️',
            question: 'Who lives downwind of landfills and industrial land?',
            field: { key: 'landfill_smoke', label: 'Landfill smoke downwind (ha × wind share ÷ km)', unit: 'index', higherIs: 'worse', ramp: 'reds' },
            needs: ['downwind.landfill_smoke', 'downwind.industry_smoke', 'downwind.landfill_upwind', 'demographics.under5', 'population.population'],
            method: `Landfill and dump land is OpenStreetMap land use (via Overture), counted where a block holds 2 ha or more, and industrial land blocks with 10%+ industrial use. Each source's area counts towards a lived-in block in proportion to the share of ERA5-Land daily 10 m wind (2020-2024, speed-weighted, one rose per city) blowing from it towards the block within ±45°, divided by distance (at least 0.5 km), out to 3 km. "Often downwind" means ${OFTEN_PCT}%+ of the wind comes from a landfill's direction. Sea and land breezes, night-time inversions and fire events are not modelled, and unmapped dumps (common in Pune, Jaipur and Lucknow) are missing.`,
            refs: 'OpenStreetMap land use; ECMWF ERA5-Land; Solid Waste Management Rules 2016 (buffer zones); CPCB legacy waste and landfill fire guidelines (2019)' },
        { id: 'powercuts', equity: true, title: 'Power cuts from space', icon: '🔌',
            question: 'Which neighbourhoods lose power most often?',
            field: { key: 'dark_nights_pct', label: 'Clear nights the block went dark while the city stayed lit', unit: '%', higherIs: 'worse', ramp: 'reds', domain: [0, 20] },
            needs: ['blackouts.dark_nights_pct', 'demographics.elderly_60plus', 'humid_heat.hot_days_40c', 'places.hospitals', 'population.population'],
            method: `NASA Black Marble VNP46A2 daily night lights (2023-2024, BRDF and moonlight corrected), high-quality cloud-free nights only, about 500 m pixels averaged to ~1 km blocks. A lit block (median 5+ nW/cm²/sr) counts a dark night when its lights, relative to its own median, fall below half of that night's citywide median ratio, so haze and thin cloud that dim the whole city cancel out. VIIRS passes at about 1:30 am, so evening load-shedding is missed; switched-off street lights and sensor artefacts also count. Discom feeder outage logs (where published) are the ground truth to check against.`,
            refs: 'Román et al. 2018 (NASA Black Marble); Mann, Melaas & Malik 2016 (night lights and Indian power supply); ESMI (Prayas Energy Group) outage monitoring' },
        { id: 'wildedge', equity: false, title: 'Homes on the forest edge', icon: '🐆',
            question: 'Where do homes meet forest, leopards and forest fire?',
            field: { key: 'forest_edge', label: 'Forest edge (1), inside forest or protected land (2)', unit: '0-2', higherIs: null, ramp: 'greens', domain: [0, 2] },
            needs: ['land_cover.tree_pct', 'landuse.protected_pct', 'demographics.under5', 'nightlights.radiance', 'population.population'],
            method: `Forest blocks have ${FOREST_TREE_PCT}%+ tree cover (ESA WorldCover) or ${FOREST_PROT_PCT}%+ mapped protected land (OpenStreetMap), with at least ${FOREST_MIN} such blocks within 1 km so that parks do not count. Edge blocks are lived-in blocks within ${EDGE_KM * 1000} m of one. Dark blocks are the city's darkest quarter by VIIRS night radiance, resident-weighted. Leopard sightings and attack records are not open data; Mumbai's Aarey and SGNP edges are the documented case.`,
            refs: 'ESA WorldCover 2021; OpenStreetMap protected areas; VIIRS night lights; Bhatia et al. 2013 and Odden et al. 2014 (leopards in human landscapes); MoEFCC human-leopard conflict guidelines (2011)' },
        { id: 'schoolgap', equity: true, title: 'A school within 1 km', icon: '🏫',
            question: 'Which children have no school within walking distance?',
            field: { key: 'school_gap', label: 'No mapped school within 1 km (1), nor 3 km (2)', unit: '0-2', higherIs: 'worse', ramp: 'reds', domain: [0, 2] },
            extra: [{ key: 'kids_per_school', label: `Children 5-14 per mapped school within ${RTE_KM} km`, unit: 'children', higherIs: 'worse' }],
            needs: ['demographics.school_age', 'demographics.youth_15_24', 'emergency_access.schools', 'places.colleges', 'population.population'],
            method: `School-age children are WorldPop 2020 ages 5-14 (100 m, district age profiles spread over settlements). Schools are OpenStreetMap schools counted per block; colleges are Overture Maps colleges and universities. Reach is straight-line distance between block centres: ${RTE_KM} km and ${UPPER_KM} km follow the Right of Children to Free and Compulsory Education Act 2009 state rules for primary and upper primary schools. OSM under-maps government and budget private schools, so a gap is a place to check against UDISE+, not a confirmed one.`,
            refs: 'WorldPop age structures 2020; OpenStreetMap; Overture Maps places; RTE Act 2009 and state RTE rules (neighbourhood school norms); UDISE+' },
    ];

    UrbanLenses.register(ENTRIES, { marketfire, oldtall, critwater, quake, factoryhomes, refuge, firelanes, schoolsafe, hospitalsafe, stationload, walkups, treefall, gridflood, coaching, rainharvest, sitedust, hotelfire, quarries, heritagesafe, fuelsafe, carekit, coalplume, dumpsmoke, powercuts, wildedge, schoolgap }, {}, 'jobsmap');
    return { marketfire, oldtall, critwater, quake, factoryhomes, refuge, firelanes, schoolsafe, hospitalsafe, stationload, walkups, treefall, gridflood, coaching, rainharvest, sitedust, hotelfire, quarries, heritagesafe, fuelsafe, carekit, coalplume, dumpsmoke, powercuts, wildedge, schoolgap, ENTRIES };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesSafety = UrbanLensesSafety;
}
