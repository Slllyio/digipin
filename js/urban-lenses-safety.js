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

    const ENTRIES = [
        { id: 'marketfire', equity: false, title: 'Fire risk in crowded markets', icon: '🔥',
            question: 'Which markets are packed tight and far from a fire station?',
            field: { key: 'market_fire', label: 'Market block (1), plus packed (2), plus no fire station within 3 km (3)', unit: '0-3', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            extra: [{ key: 'trade_500m', label: `Shops and eateries within ${MARKET_KM * 1000} m`, unit: 'places', higherIs: null, ramp: 'viridis', domain: [0, 400] }],
            needs: ['places.shopping', 'places.food', 'places.fire_stations', 'building_stock.cover_2023_pct', 'population.population'],
            method: `Market blocks are the city's top 5% by Overture Maps shops and eateries within ${MARKET_KM * 1000} m (and at least ${MARKET_MIN}). Packed means Google Open Buildings 2.5D (2023) roofs cover ${PACKED_PCT}% or more of the block, so buildings stand wall to wall. Far means no Overture-listed fire station within ${FIRE_KM} km straight line, a rough stand-in for the 3-5 minute urban response the Standing Fire Advisory Council norms aim for; reach is only judged where at least ${FIRE_MIN} stations are listed. Lane widths, wiring and stock are not in open data, so the picks are where to audit first, not a fire-risk rating.`,
            refs: 'Overture Maps places; Google Open Buildings 2.5D Temporal; Standing Fire Advisory Council norms (DGFS, MHA); National Building Code 2016 Part 4' },
    ];

    UrbanLenses.register(ENTRIES, { marketfire }, {}, 'jobsmap');
    return { marketfire, ENTRIES };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesSafety = UrbanLensesSafety;
}
