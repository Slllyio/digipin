/**
 * Civic lenses for UrbanLenses: what statutory plans and municipal facility lists say about a block (planned road
 * widths and new links, cremation and burial grounds, public borewells). They read datasets baked from city and development-authority
 * maps. Registers itself on load, after urban-lenses.js.
 */
const UrbanLensesCivic = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _sumOver, within } = UrbanLenses._kit;

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

    // Planned road widths. Bengaluru's Revised Master Plan 2015 fixes a right of way for every major road and proposes
    // new links. Plots on roads to be widened give up a front strip (compensated in transferable development rights),
    // and road width decides how densely and for what a plot may be built, so the plan reshapes value along these roads.
    const WIDE_M = 24;

    function roadplan(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const pk = c['road_plan.plan_km'], wk = c['road_plan.wide_km'], lk = c['road_plan.link_km'], mw = c['road_plan.max_width_m'];
        if (!pop || !pk || !mw || !pk.some(v => v > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pk, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const lived = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0) lived.push(i);
        const all = _sumOver(pop, lived, () => true);
        const pWide = _sumOver(pop, lived, i => v(mw, i) >= WIDE_M), pLink = _sumOver(pop, lived, i => v(lk, i) > 0);
        const sum = a => idx.reduce((t, i) => t + v(a, i), 0);
        const stats = [
            { label: 'Roads with a planned width (RMP 2015)', value: `${_people(sum(pk))} km` },
            { label: `…planned ${WIDE_M} m wide or more`, value: `${_people(sum(wk))} km` },
            { label: '…proposed new link roads', value: `${_people(sum(lk))} km` },
            { label: `Residents in blocks on a road planned ${WIDE_M} m or wider`, value: `${_people(pWide)} (${_round(100 * pWide / (all || 1))}%)` },
            { label: 'Residents in blocks a proposed new link crosses', value: `${_people(pLink)} (${_round(100 * pLink / (all || 1))}%)` },
        ];
        const score = Float64Array.from({ length: n }, (_, i) => v(lk, i) * v(pop, i));
        spaced(g, idx.filter(i => v(lk, i) > 0 && v(pop, i) > 0), score).forEach((i, k) => stats.push({
            label: `New link through homes ${k + 1}: ${g.codes[i]}`,
            value: `${_round(v(lk, i) * 1000)} m of proposed link road; widest planned road here ${_round(v(mw, i))} m; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = v(mw, i);
        return {
            columns: { planned_width_m: out }, idx, weightKey: 'planned_width_m', noHotspots: true,
            metric: { label: `Residents on roads planned ${WIDE_M} m or wider`, value: _round(100 * pWide / (all || 1), 1), unit: '%', higherIs: 'better' },
            headline: `Bengaluru's Revised Master Plan 2015 sets widths for ${_people(sum(pk))} km of roads, ${_people(sum(wk))} km of them ${WIDE_M} m or wider, and proposes ${_people(sum(lk))} km of new links. ${_people(pWide)} residents (${_round(100 * pWide / (all || 1))}%) live in blocks on a road planned ${WIDE_M} m or wider, where frontages face widening and denser building is allowed; many widenings are years behind the plan.`,
            stats,
        };
    }

    // Cremation and burial grounds. Every family needs one within reach, and in the 2021 Covid wave crematoriums ran out of
    // slots. Distance from each block to the nearest listed site, residents per site, and the share that are electric or
    // gas (cleaner than open pyres). Lists stop at the corporation, so blocks beyond FUNERAL_JUDGE_KM are not judged.
    const FUNERAL_KM = 3, FUNERAL_JUDGE_KM = 8;

    function lastrites(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], fs = c['funeral_sites.sites'], el = c['funeral_sites.electric'];
        if (!pop || !fs) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const st = [];
        for (let i = 0; i < n; i++) if (v(fs, i) > 0) st.push(i);
        if (st.length < 5) return null;
        const km = new Float64Array(n).fill(Infinity);
        for (let i = 0; i < n; i++) {
            if (!(v(pop, i) > 0)) continue;
            for (const j of st) {
                const d = Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx);
                if (d < km[i]) km[i] = d;
            }
        }
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && km[i] <= FUNERAL_JUDGE_KM) idx.push(i);
        if (idx.length < 5) return null;
        const sites = st.reduce((a, i) => a + v(fs, i), 0), elec = st.reduce((a, i) => a + v(el, i), 0);
        const all = _sumOver(pop, idx, () => true), far = idx.filter(i => km[i] > FUNERAL_KM), pFar = _sumOver(pop, far, () => true);
        const stats = [
            { label: 'Cremation and burial grounds listed', value: _people(sites) },
            { label: 'Residents per site', value: _people(all / sites) },
            { label: `Residents more than ${FUNERAL_KM} km from one`, value: `${_people(pFar)} (${_round(100 * pFar / (all || 1))}%)` },
            { label: 'Electric or gas crematoriums among them', value: elec ? _people(elec) : 'none listed' },
        ];
        const farPop = Float64Array.from({ length: n }, (_, i) => (km[i] > FUNERAL_KM && km[i] <= FUNERAL_JUDGE_KM ? v(pop, i) : 0));
        const gain = within(g, farPop, FUNERAL_KM);
        spaced(g, far.filter(i => gain[i] > 0), gain).forEach((i, k) => stats.push({ label: `New site ${k + 1}: ${g.codes[i]}`,
            value: `${_people(gain[i])} residents now beyond ${FUNERAL_KM} km would be within it; nearest site ${_round(km[i], 1)} km` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(km[i], 1);
        return {
            columns: { funeral_km: out }, idx, weightKey: 'funeral_km', noHotspots: true,
            metric: { label: `Residents more than ${FUNERAL_KM} km from a cremation or burial ground`, value: _round(100 * pFar / (all || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `The corporation lists ${_people(sites)} cremation and burial grounds, one for every ${_people(all / sites)} residents; ${_people(pFar)} residents (${_round(100 * pFar / (all || 1))}%) live more than ${FUNERAL_KM} km from one. Distances are straight-line, and a site may serve only one community.`,
            stats,
        };
    }

    // Borewells beside septic tanks. Where the city pumps drinking water from public borewells but sewers are missing or
    // thin, homes drain into septic tanks and soak pits that seep into the same aquifer (CPHEEO asks for 15-30 m between
    // a soak pit and a well, rarely possible on small plots). Wells in such blocks are the ones to test first.
    const WELL_SEWER_KM = 0.25, WELL_THIN_PCT = 30;

    function wellrisk(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], bw = c['borewells.borewells'], sw = c['sewers.sewer_m'];
        const road = c['osm_roads.road_km_km2'];
        if (!pop || !bw || !sw || !bw.some(v => v > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0), area = g.dx * g.dy;
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(sw, i)), WELL_SEWER_KM);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(bw, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const pct = i => (v(road, i) > 0 ? 100 * v(sw, i) / (v(road, i) * area * 1000) : 100);
        const level = i => (!(near[i] > 0) ? 2 : pct(i) < WELL_THIN_PCT ? 1 : 0);
        const wells = idx.reduce((a, i) => a + v(bw, i), 0);
        const wAt = k => idx.filter(i => level(i) === k).reduce((a, i) => a + v(bw, i), 0);
        const wNone = wAt(2), wThin = wAt(1), pRisk = _sumOver(pop, idx, i => level(i) > 0);
        const stats = [
            { label: 'Public borewells listed', value: _people(wells) },
            { label: `…in blocks with no sewer within ${WELL_SEWER_KM * 1000} m`, value: `${_people(wNone)} (${_round(100 * wNone / wells)}%)` },
            { label: `…in blocks where sewers run along under ${WELL_THIN_PCT}% of the streets`, value: `${_people(wThin)} (${_round(100 * wThin / wells)}%)` },
            { label: 'Residents of those well blocks', value: _people(pRisk) },
        ];
        const score = Float64Array.from({ length: n }, (_, i) => level(i) * v(bw, i) * v(pop, i));
        spaced(g, idx.filter(i => level(i) > 0), score).forEach((i, k) => stats.push({ label: `Test water here ${k + 1}: ${g.codes[i]}`,
            value: `${v(bw, i)} public borewell${v(bw, i) > 1 ? 's' : ''}; ${level(i) === 2 ? `no sewer within ${WELL_SEWER_KM * 1000} m` : `sewers along ${Math.round(pct(i))}% of streets`}; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = level(i);
        const share = _round(100 * (wNone + wThin) / wells);
        return {
            columns: { well_risk: out }, idx, weightKey: 'well_risk', noHotspots: true,
            metric: { label: 'Public borewells where sewers are missing or thin', value: _round(100 * (wNone + wThin) / wells, 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(wNone + wThin)} of ${_people(wells)} public borewells (${share}%) stand where sewers are missing or run along under ${WELL_THIN_PCT}% of the streets, so many homes around them drain into septic tanks and soak pits over the same groundwater; ${_people(pRisk)} people live in those blocks. This flags where to test the water, not measured contamination.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'wellrisk', equity: true, title: 'Borewells beside septic tanks', icon: '🚰',
            question: 'Which public borewells sit where homes have no sewer?',
            field: { key: 'well_risk', label: 'Borewell block: sewered (0), thinly sewered (1), no sewer nearby (2)', unit: '0-2', higherIs: 'worse', ramp: 'reds', domain: [0, 2] },
            needs: ['borewells.borewells', 'sewers.sewer_m', 'osm_roads.road_km_km2', 'population.population'],
            method: `BWSSB's public borewell map (KGIS, about 7,200 distinct wells) and sewerage line maps on data.opencity.in (public domain). A well block has no sewer nearby when no mapped sewer runs within ${WELL_SEWER_KM * 1000} m, and is thinly sewered when its sewer length is under ${WELL_THIN_PCT}% of its OpenStreetMap street length. CPHEEO's manual asks for 15-30 m between a soak pit and a drinking-water well. Picks are such well blocks ${SPACING_KM} km apart ranked by level times wells times residents. Bengaluru only; this marks where to test, not tested water.`,
            refs: 'CPHEEO Manual on Water Supply and Treatment (1999) and on Sewerage (2013); BWSSB borewell and sewer maps via OpenCity; Bureau of Indian Standards IS 10500 (drinking water)' },
        { id: 'lastrites', equity: true, title: 'Cremation and burial grounds', icon: '🕯️',
            question: 'Who lives far from a cremation or burial ground, and where is another needed?',
            field: { key: 'funeral_km', label: 'Distance to the nearest cremation or burial ground', unit: 'km', higherIs: 'worse', ramp: 'reds', domain: [0, 8] },
            needs: ['funeral_sites.sites', 'funeral_sites.electric', 'population.population'],
            method: `Cremation grounds, crematoriums and burial grounds from the corporations' maps on data.opencity.in (public domain): BMC (Mumbai, 189), PMC (Pune, 76), GCC (Chennai, 210) and BBMP (Bengaluru, 12 electric crematoriums and 68 burial grounds; its list leaves out open cremation grounds). Straight-line distance from each lived-in block to the nearest site; blocks more than ${FUNERAL_JUDGE_KM} km from any site are not judged. New-site picks are blocks ${SPACING_KM} km apart that bring the most residents now beyond ${FUNERAL_KM} km within ${FUNERAL_KM} km. Sites often serve one community, which the lists do not record consistently.`,
            refs: 'URDPFI Guidelines 2014 (cremation and burial ground provision); OpenCity cremation and burial ground maps' },
        { id: 'roadplan', equity: false, title: 'Planned road widening', icon: '🛣️',
            question: 'Which roads does the master plan widen or add, and whose homes are on them?',
            field: { key: 'planned_width_m', label: 'Widest planned road in the block (RMP 2015)', unit: 'm', higherIs: 'better', ramp: 'viridis', domain: [0, 45] },
            needs: ['road_plan.plan_km', 'road_plan.wide_km', 'road_plan.link_km', 'road_plan.max_width_m', 'population.population'],
            method: `BDA's Revised Master Plan 2015 road width map on data.opencity.in (public domain): 23,238 road segments with a planned right of way (12 to 67 m, a few 100 m corridors) and a type, widening or new connection. Each line is cut into pieces of at most 25 m summed per block, with the widest planned road per block. Residents are WorldPop counts in blocks on a road planned ${WIDE_M} m or wider, or crossed by a proposed link; picks are populated blocks 1.5 km apart with the most proposed link length times residents, where new roads would need land. The plan's widths are targets: many are not yet acquired or built, and the 2041 plan may change them. Bengaluru only.`,
            refs: 'BDA Revised Master Plan 2015 (Zoning of Land Use and Regulations); Karnataka TDR rules; OpenCity Bengaluru road width map' },
    ];

    UrbanLenses.register(ENTRIES, { roadplan, lastrites, wellrisk });
    return { ENTRIES };
})();
