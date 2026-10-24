/**
 * Safety lenses for UrbanLenses: fire risk in crowded markets and other hazards where people, buildings and access
 * meet. They read places, building_stock and osm_roads. Registers itself on load, after urban-lenses.js.
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
    ];

    UrbanLenses.register(ENTRIES, { marketfire, oldtall, critwater, quake, factoryhomes }, {}, 'jobsmap');
    return { marketfire, oldtall, critwater, quake, factoryhomes, ENTRIES };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesSafety = UrbanLensesSafety;
}
