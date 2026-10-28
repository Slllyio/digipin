/**
 * Civic lenses for UrbanLenses: what statutory plans and municipal facility lists say about a block (planned road
 * widths and new links, cremation and burial grounds, public borewells, waste bins, large
 * projects with environmental clearance, coastal and eco-sensitive building limits,
 * police stations, lake and drain buffers, parks and layout open spaces, birdlife). They read datasets baked from
 * city and development-authority maps. Registers itself on load, after urban-lenses.js.
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

    // Waste bin reach. Where no public bin stands within a short walk, rubbish piles up on street corners and vacant
    // plots (the "garbage vulnerable points" cities chase). Residents with no listed bin within BIN_M, judged where the
    // list reaches (within BIN_JUDGE_KM of a listed bin).
    const BIN_M = 250, BIN_JUDGE_KM = 1;

    function binreach(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], bn = c['waste_bins.bins'];
        if (!pop || !bn || !bn.some(v => v > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const arr = Float64Array.from({ length: n }, (_, i) => v(bn, i));
        const near = within(g, arr, BIN_M / 1000), cover = within(g, arr, BIN_JUDGE_KM);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && cover[i] > 0) idx.push(i);
        if (idx.length < 5) return null;
        const bins = idx.reduce((a, i) => a + v(bn, i), 0), all = _sumOver(pop, idx, () => true);
        const none = idx.filter(i => !(near[i] > 0)), pNone = _sumOver(pop, none, () => true);
        const stats = [
            { label: 'Public bins listed', value: _people(bins) },
            { label: 'Residents per bin', value: _people(all / Math.max(bins, 1)) },
            { label: `Residents with no listed bin within ${BIN_M} m`, value: `${_people(pNone)} (${_round(100 * pNone / (all || 1))}%)` },
        ];
        const gap = Float64Array.from({ length: n }, (_, i) => (near[i] > 0 ? 0 : v(pop, i)));
        const need = within(g, gap, 0.5);
        spaced(g, none, need).forEach((i, k) => stats.push({ label: `Bins needed ${k + 1}: ${g.codes[i]}`, value: `${_people(need[i])} residents within 500 m have no bin within ${BIN_M} m` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(v(pop, i) / Math.max(near[i], 0.5));
        return {
            columns: { residents_per_bin: out }, idx, weightKey: 'residents_per_bin', noHotspots: true,
            metric: { label: `Residents with no public bin within ${BIN_M} m`, value: _round(100 * pNone / (all || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `The corporation lists ${_people(bins)} public bins here, one for every ${_people(all / Math.max(bins, 1))} residents; ${_people(pNone)} residents (${_round(100 * pNone / (all || 1))}%) have none within ${BIN_M} m. Door-to-door collection replaces bins in many wards, so a gap is a place to check collection, not proof of dumping.`,
            stats,
        };
    }

    // Large-project pipeline. Every building project of 20,000 m² or more needs state environmental clearance, so the
    // SEIAA map is where big apartment blocks, tech parks and malls are coming up: new supply for buyers and new load on
    // roads, water and sewers around them.
    const PROJ_KM = 2, PROJ_CLUSTER = 5;

    function bigprojects(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], pj = c['big_projects.projects'];
        const res = c['big_projects.residential'], com = c['big_projects.commercial'];
        if (!pop || !pj || !pj.some(v => v > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(pj, i)), PROJ_KM);
        const nRes = within(g, Float64Array.from({ length: n }, (_, i) => v(res, i)), PROJ_KM);
        const nCom = within(g, Float64Array.from({ length: n }, (_, i) => v(com, i)), PROJ_KM);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 || near[i] > 0) idx.push(i);
        if (idx.length < 5) return null;
        const sum = a => { let t = 0; for (let i = 0; i < n; i++) t += v(a, i); return t; };
        const total = sum(pj), all = _sumOver(pop, idx, () => true), busy = idx.filter(i => near[i] >= PROJ_CLUSTER);
        const pBusy = _sumOver(pop, busy, () => true);
        const stats = [
            { label: 'Large projects cleared (20,000 m² or more)', value: _people(total) },
            { label: '…residential', value: _people(sum(res)) },
            { label: '…commercial (offices, IT parks, malls, hotels; mixed use in both)', value: _people(sum(com)) },
            { label: `Residents with ${PROJ_CLUSTER} or more large projects within ${PROJ_KM} km`, value: `${_people(pBusy)} (${_round(100 * pBusy / (all || 1))}%)` },
        ];
        spaced(g, idx.filter(i => near[i] > 0), near).forEach((i, k) => stats.push({ label: `Cluster ${k + 1}: ${g.codes[i]}`,
            value: `${_round(near[i])} large projects within ${PROJ_KM} km (${_round(nRes[i])} residential, ${_round(nCom[i])} commercial)` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(near[i]);
        return {
            columns: { projects_2km: out }, idx, weightKey: 'projects_2km', noHotspots: true,
            metric: { label: `Residents with ${PROJ_CLUSTER}+ large projects within ${PROJ_KM} km`, value: _round(100 * pBusy / (all || 1), 1), unit: '%', higherIs: 'better' },
            headline: `SEIAA Karnataka has cleared ${_people(total)} construction projects of 20,000 m² or more in Bengaluru Urban, ${_people(sum(res))} residential and ${_people(sum(com))} commercial; ${_people(pBusy)} residents (${_round(100 * pBusy / (all || 1))}%) live with ${PROJ_CLUSTER} or more of them within ${PROJ_KM} km. Clearance is not completion: some projects are built, some stalled, and the map gives no dates or sizes.`,
            stats,
        };
    }

    // Building limits. Inside the Coastal Regulation Zone (CRZ Notification 2019) new building is barred or capped at the
    // old floor area, and inside an eco-sensitive zone commercial and large construction need clearance or are barred.
    // Residents and built-up land there sit on a legal ceiling that the master plan alone does not show.
    function buildlimits(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], built = c['built_up.built_pct'];
        const crz = c['eco_limits.crz_pct'], esz = c['eco_limits.esz_pct'], pa = c['eco_limits.protected_pct'];
        const pj = c['big_projects.projects'];
        if (!pop) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const share = i => Math.min(100, Math.max(v(crz, i), v(esz, i) + v(pa, i)));
        const idx = [];
        for (let i = 0; i < n; i++) if (share(i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        let pIn = 0, bIn = 0, pjIn = 0, pCrz = 0, pEsz = 0;
        for (const i of idx) {
            const f = share(i) / 100;
            pIn += v(pop, i) * f; bIn += v(built, i) / 100 * g.cellKm2 * f; pjIn += v(pj, i) * f;
            pCrz += v(pop, i) * v(crz, i) / 100; pEsz += v(pop, i) * Math.min(100, v(esz, i) + v(pa, i)) / 100;
        }
        const all = _sumOver(pop, Array.from({ length: n }, (_, i) => i), () => true);
        const stats = [
            { label: 'Residents inside a coastal or eco-sensitive building limit', value: `${_people(pIn)} (${_round(100 * pIn / (all || 1), 1)}%)` },
            { label: 'Built-up land inside it', value: `${_round(bIn, 1)} km²` },
        ];
        if (crz) stats.push({ label: '…in the Coastal Regulation Zone', value: _people(pCrz) });
        if (esz || pa) stats.push({ label: '…in an eco-sensitive zone or protected area', value: _people(pEsz) });
        if (pj && pjIn > 0) stats.push({ label: 'Large projects with clearance standing inside it', value: _people(pjIn) });
        spaced(g, idx.filter(i => v(pop, i) > 0), Float64Array.from({ length: n }, (_, i) => v(pop, i) * share(i))).forEach((i, k) =>
            stats.push({ label: `Most affected ${k + 1}: ${g.codes[i]}`, value: `${_round(share(i))}% of the block restricted, ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(share(i));
        return {
            columns: { limit_pct: out }, idx, weightKey: 'limit_pct', noHotspots: true,
            metric: { label: 'Residents inside a coastal or eco-sensitive building limit', value: _round(100 * pIn / (all || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(pIn)} residents (${_round(100 * pIn / (all || 1), 1)}%) and ${_round(bIn, 1)} km² of built-up land sit inside ${crz ? 'the Coastal Regulation Zone' : 'an eco-sensitive zone or protected area'}, where new building is barred or capped at the existing floor area. ${crz ? 'The zone is rebuilt from the official CRZ line; site-level limits need the approved Coastal Zone Management Plan map.' : 'Boundaries are the Forest Department\'s 2022 maps.'}`,
            stats,
        };
    }

    // Police reach. BPR&D's norms ask for an urban police station for every 1-1.5 lakh residents; a station more than
    // a few kilometres off means slower response and a long trip to file an FIR.
    const POLICE_KM = 2, POLICE_JUDGE_KM = 3.5;   // without a jurisdiction map, beyond 3.5 km of every listed station is taken as outside the map's area

    function policereach(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], ps = c['police_official.stations'];
        if (!pop || !ps) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const st = [];
        for (let i = 0; i < n; i++) if (v(ps, i) > 0) st.push(i);
        if (st.length < 5) return null;
        const km = new Float64Array(n).fill(Infinity);
        for (let i = 0; i < n; i++) {
            if (!(v(pop, i) > 0)) continue;
            for (const j of st) {
                const d = Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx);
                if (d < km[i]) km[i] = d;
            }
        }
        const area = c['police_official.in_area'], mapped = area && area.some(x => x > 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && (mapped ? v(area, i) > 0 : km[i] <= POLICE_JUDGE_KM)) idx.push(i);
        if (idx.length < 5) return null;
        const stations = st.reduce((a, i) => a + v(ps, i), 0), outposts = c['police_official.outposts'] ? Array.from({ length: n }, (_, i) => v(c['police_official.outposts'], i)).reduce((a, b) => a + b, 0) : 0;
        const all = _sumOver(pop, idx, () => true), far = idx.filter(i => km[i] > POLICE_KM), pFar = _sumOver(pop, far, () => true);
        const stats = [
            { label: 'Police stations on the state police map', value: _people(stations) },
            { label: 'Residents per station (BPR&D norm: 1-1.5 lakh)', value: _people(all / stations) },
            { label: `Residents more than ${POLICE_KM} km from a station`, value: `${_people(pFar)} (${_round(100 * pFar / (all || 1))}%)` },
        ];
        if (outposts) stats.push({ label: 'Police outposts as well', value: _people(outposts) });
        const inArea = new Uint8Array(n);
        for (const i of idx) inArea[i] = 1;
        const farPop = Float64Array.from({ length: n }, (_, i) => (inArea[i] && km[i] > POLICE_KM ? v(pop, i) : 0));
        const gain = within(g, farPop, POLICE_KM);
        spaced(g, far.filter(i => gain[i] > 0), gain).forEach((i, k) => stats.push({ label: `New station ${k + 1}: ${g.codes[i]}`,
            value: `${_people(gain[i])} residents now beyond ${POLICE_KM} km would be within it; nearest station ${_round(km[i], 1)} km` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(km[i], 1);
        return {
            columns: { police_km: out }, idx, weightKey: 'police_km', noHotspots: true,
            metric: { label: `Residents more than ${POLICE_KM} km from a police station`, value: _round(100 * pFar / (all || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `The state police map lists ${_people(stations)} police stations here, one for every ${_people(all / stations)} residents; ${_people(pFar)} residents (${_round(100 * pFar / (all || 1))}%) live more than ${POLICE_KM} km from one. Distances are straight-line; jurisdiction lines, not distance, decide which station takes a complaint.`,
            stats,
        };
    }

    // Lake buffers. Bengaluru's zoning regulations keep a 30 m no-build buffer round every lake (the NGT's 2016 order of
    // 75 m was set aside by the Supreme Court in 2019) and Hyderabad's building rules 30 m or 9 m by tank size; building there blocks inflow channels,
    // and those plots carry the legal risk of a demolition drive.
    function lakebuffer(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], built = c['built_up.built_pct'];
        const b30 = c['lake_buffers.buffer30_pct'], b75 = c['lake_buffers.buffer75_pct'], lake = c['lake_buffers.lake_pct'];
        if (!b30 || !built) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(b75, i) > 0 || v(b30, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        // Built land in the buffer, pro rata: the block's built share times its buffer share.
        const in30 = Float64Array.from({ length: n }, (_, i) => v(built, i) / 100 * v(b30, i) / 100 * g.cellKm2);
        let k30 = 0, k75 = 0, a30 = 0, p30 = 0, lakeKm2 = 0;
        for (let i = 0; i < n; i++) {
            k30 += in30[i]; k75 += v(built, i) / 100 * v(b75, i) / 100 * g.cellKm2;
            a30 += v(b30, i) / 100 * g.cellKm2; p30 += v(pop, i) * v(b30, i) / 100; lakeKm2 += v(lake, i) / 100 * g.cellKm2;
        }
        const stats = [
            { label: 'Lakes and tanks on the official map', value: `${_round(lakeKm2, 1)} km²` },
            { label: 'Land in the statutory no-build buffer', value: `${_round(a30, 1)} km²` },
            { label: '…of it built up (pro rata)', value: `${_round(k30, 2)} km² (${_round(100 * k30 / (a30 || 1))}%)` },
            { label: 'Built up within 75 m (wider screen; NGT 2016 buffer for Bengaluru, set aside in 2019)', value: `${_round(k75, 2)} km²` },
            { label: 'Residents living in the buffer (pro rata)', value: _people(p30) },
        ];
        spaced(g, idx.filter(i => in30[i] > 0), in30).forEach((i, k) => stats.push({ label: `Most built buffer ${k + 1}: ${g.codes[i]}`,
            value: `${_round(v(b30, i))}% of the block in the buffer, ${_round(v(built, i))}% of the block built up` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(Math.min(v(b30, i), v(built, i)), 1);
        return {
            columns: { buffer_built: out }, idx, weightKey: 'buffer_built', noHotspots: true,
            metric: { label: 'Share of the statutory lake buffer built up', value: _round(100 * k30 / (a30 || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `The official map's ${_round(lakeKm2, 1)} km² of lakes and tanks are ringed by ${_round(a30, 1)} km² of statutory no-build buffer, of which about ${_round(k30, 2)} km² (${_round(100 * k30 / (a30 || 1))}%) is built up, home to some ${_people(p30)} residents. Figures are pro rata within each block, so they flag blocks to check against the survey sketch, not individual plots.`,
            stats,
        };
    }

    // Park reach. URDPFI asks for a housing-area park within about half a kilometre's walk. Hyderabad's layout open
    // spaces are land already reserved in approved layouts, so where they sit beside unserved homes they are the
    // cheapest new parks.
    const PARK_M = 500, PARK_JUDGE_KM = 3;

    function parkreach(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const pk = c['parks_official.parks'], pg = c['parks_official.playgrounds'], os = c['parks_official.open_spaces'];
        if (!pop || !pk) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const green = Float64Array.from({ length: n }, (_, i) => v(pk, i) + v(pg, i));
        const total = green.reduce((a, b) => a + b, 0);
        if (total < 5) return null;
        const near = within(g, green, PARK_M / 1000), listed = within(g, green, PARK_JUDGE_KM);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && listed[i] > 0) idx.push(i);
        if (idx.length < 5) return null;
        const all = _sumOver(pop, idx, () => true), far = idx.filter(i => !(near[i] > 0)), pFar = _sumOver(pop, far, () => true);
        const stats = [
            { label: 'Parks and gardens on the corporation list', value: _people(Array.from({ length: n }, (_, i) => v(pk, i)).reduce((a, b) => a + b, 0)) },
        ];
        if (pg) stats.push({ label: '…and playgrounds', value: _people(Array.from({ length: n }, (_, i) => v(pg, i)).reduce((a, b) => a + b, 0)) });
        if (c['parks_official.park_m2']) stats.push({ label: 'Garden area per resident', value: `${_round(Array.from({ length: n }, (_, i) => v(c['parks_official.park_m2'], i)).reduce((a, b) => a + b, 0) / (all || 1), 2)} m²` });
        stats.push({ label: `Residents with no listed park or playground within ${PARK_M} m`, value: `${_people(pFar)} (${_round(100 * pFar / (all || 1))}%)` });
        const farPop = Float64Array.from({ length: n }, (_, i) => (v(pop, i) > 0 && listed[i] > 0 && !(near[i] > 0) ? v(pop, i) : 0));
        const gain = within(g, farPop, PARK_M / 1000);
        const allSpaces = os ? Array.from({ length: n }, (_, i) => i).filter(i => v(os, i) > 0 && gain[i] > 0) : [];
        if (os) {
            stats.push({ label: 'Layout open spaces next to unserved homes', value: _people(allSpaces.reduce((a, i) => a + v(os, i), 0)) });
            spaced(g, allSpaces, gain).forEach((i, k) => stats.push({ label: `Open space to develop ${k + 1}: ${g.codes[i]}`,
                value: `${_people(gain[i])} residents with no park within ${PARK_M} m would gain one` }));
        } else {
            spaced(g, far.filter(i => gain[i] > 0), gain).forEach((i, k) => stats.push({ label: `New park ${k + 1}: ${g.codes[i]}`,
                value: `${_people(gain[i])} residents with no park within ${PARK_M} m would gain one` }));
        }
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = near[i] > 0 ? 1 : 0;
        return {
            columns: { park_near: out }, idx, weightKey: 'park_near', noHotspots: true,
            metric: { label: `Residents with no listed park or playground within ${PARK_M} m`, value: _round(100 * pFar / (all || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(pFar)} residents (${_round(100 * pFar / (all || 1))}%) have no park or playground on the corporation's list within ${PARK_M} m${os ? `; ${_people(allSpaces.reduce((a, i) => a + v(os, i), 0))} open spaces already reserved in approved layouts lie within ${PARK_M} m of them` : ''}. Reach is straight-line on the block grid, and the lists leave out private and institutional green space.`,
            stats,
        };
    }

    // Drain buffers. Bengaluru's Revised Master Plan 2015 keeps building back from storm-water drains (50, 25 and 15 m
    // from the centre of primary, secondary and tertiary drains); building there narrows the drains that flood in a
    // cloudburst, and those plots are the ones the drain-clearance drives demolish.
    function drainbuffer(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], built = c['built_up.built_pct'];
        const bf = c['drain_buffers.buffer_pct'], ngt = c['drain_buffers.buffer_ngt_pct'];
        if (!bf || !built) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(bf, i) > 0 || v(ngt, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const inBuf = Float64Array.from({ length: n }, (_, i) => v(built, i) / 100 * v(bf, i) / 100 * g.cellKm2);
        let kB = 0, kN = 0, aB = 0, pB = 0;
        const len = k => Array.from({ length: n }, (_, i) => v(c[`drain_buffers.${k}_m`], i)).reduce((a, b) => a + b, 0) / 1000;
        for (let i = 0; i < n; i++) {
            kB += inBuf[i]; kN += v(built, i) / 100 * v(ngt, i) / 100 * g.cellKm2;
            aB += v(bf, i) / 100 * g.cellKm2; pB += v(pop, i) * v(bf, i) / 100;
        }
        const stats = [
            { label: 'Storm-water drains mapped (primary, secondary, tertiary)', value: `${_round(len('primary'))} km, ${_round(len('secondary'))} km, ${_round(len('tertiary'))} km` },
            { label: 'Land in the RMP 2015 drain buffer', value: `${_round(aB, 1)} km²` },
            { label: '…of it built up (pro rata)', value: `${_round(kB, 1)} km² (${_round(100 * kB / (aB || 1))}%)` },
            { label: 'Built up in the wider NGT 2016 buffer (set aside in 2019)', value: `${_round(kN, 1)} km²` },
            { label: 'Residents living in the RMP buffer (pro rata)', value: _people(pB) },
        ];
        spaced(g, idx.filter(i => inBuf[i] > 0), inBuf).forEach((i, k) => stats.push({ label: `Most built drain buffer ${k + 1}: ${g.codes[i]}`,
            value: `${_round(v(bf, i))}% of the block in the buffer, ${_round(v(built, i))}% of the block built up` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(Math.min(v(bf, i), v(built, i)), 1);
        return {
            columns: { drain_built: out }, idx, weightKey: 'drain_built', noHotspots: true,
            metric: { label: 'Share of the RMP 2015 drain buffer built up', value: _round(100 * kB / (aB || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `BBMP's drain maps put ${_round(aB, 1)} km² of Bengaluru inside the Revised Master Plan's storm-water drain buffer, and about ${_round(kB, 1)} km² of it (${_round(100 * kB / (aB || 1))}%) is built up, home to some ${_people(pB)} residents. Buffers are measured from the drain centreline and built land is pro rata within each block, so this flags blocks to survey, not plots.`,
            stats,
        };
    }

    // Birdlife. Citizen-science bird lists (eBird, iNaturalist) are the densest biodiversity record Indian cities have.
    // Raw species counts follow birding effort, so blocks are compared on species expected in 200 records.
    const BIRD_FEW = 20, BIRD_HOT = 1000;   // hotspots need 1,000+ records: a few long checklists can fake richness

    function birdlife(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const rec = c['birds.records'], sp = c['birds.species'], rich = c['birds.rich200'], tree = c['vegetation.tree_canopy_pct'];
        if (!rec || !rich || !rich.some(_fin)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        // The dataset is per ~1 km block: one representative block per parent code.
        const first = new Map();
        for (let i = 0; i < n; i++) { const k = g.codes[i].slice(0, 6); if (!first.has(k)) first.set(k, i); }
        const reps = [...first.values()];
        const rated = reps.filter(i => _fin(rich[i]));
        if (rated.length < 5) return null;
        const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 || _fin(rich[i])) idx.push(i);
        const all = _sumOver(pop, idx, () => true), thin = idx.filter(i => v(rec, i) < BIRD_FEW), pThin = _sumOver(pop, thin, () => true);
        const stats = [
            { label: 'Bird records since 2015 (CC0 and CC BY)', value: _people(reps.reduce((a, i) => a + v(rec, i), 0)) },
            { label: 'Most species in one ~1 km block', value: _people(Math.max(...reps.map(i => v(sp, i)))) },
            { label: '~1 km blocks with 200+ records (comparable)', value: `${rated.length} of ${reps.length}` },
            { label: 'Median species expected in 200 records', value: _round(med(rated.map(i => rich[i])), 1) },
            { label: `Residents in blocks with under ${BIRD_FEW} records (unsurveyed)`, value: `${_people(pThin)} (${_round(100 * pThin / (all || 1))}%)` },
        ];
        if (tree) {
            const t = rated.filter(i => _fin(tree[i])).sort((a, b) => tree[a] - tree[b]), k = Math.floor(t.length / 3);
            if (k >= 3) stats.push({ label: 'Species in 200 records: least vs most tree canopy (thirds of rated blocks; lakes and scrub count as low canopy)', value: `${_round(med(t.slice(0, k).map(i => rich[i])), 1)} vs ${_round(med(t.slice(-k).map(i => rich[i])), 1)}` });
        }
        spaced(g, rated.filter(i => v(rec, i) >= BIRD_HOT), Float64Array.from({ length: n }, (_, i) => (_fin(rich[i]) ? rich[i] : 0))).forEach((i, k) => stats.push({ label: `Bird hotspot ${k + 1}: ${g.codes[i]}`,
            value: `${_round(rich[i], 1)} species expected in 200 records; ${_people(v(sp, i))} species in ${_people(v(rec, i))} records` }));
        const out = new Float64Array(n).fill(NaN);
        for (let i = 0; i < n; i++) if (_fin(rich[i])) out[i] = _round(rich[i], 1);
        return {
            columns: { bird_rich: out }, idx, weightKey: 'bird_rich', noHotspots: true,
            metric: { label: 'Median bird species expected in 200 records', value: _round(med(rated.map(i => rich[i])), 1), unit: 'species', higherIs: 'better' },
            headline: `Citizen scientists have logged ${_people(reps.reduce((a, i) => a + v(rec, i), 0))} bird records here since 2015. Across the ${rated.length} ~1 km blocks with enough records to compare, a typical block yields ${_round(med(rated.map(i => rich[i])), 1)} species in 200 records; ${_people(pThin)} residents (${_round(100 * pThin / (all || 1))}%) live in blocks almost nobody has surveyed. Records follow birders, so gaps are gaps in watching, not proof of no birds.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'birdlife', equity: false, title: 'Birdlife', icon: '🐦',
            question: 'Where are birds richest, and which neighbourhoods has nobody surveyed?',
            field: { key: 'bird_rich', label: 'Bird species expected in 200 records (~1 km block)', unit: 'species', higherIs: 'better', ramp: 'greens', domain: [20, 100] },
            needs: ['birds.records', 'birds.species', 'birds.rich200', 'vegetation.tree_canopy_pct', 'population.population'],
            method: `GBIF occurrence records of birds since 2015 under CC0 or CC BY 4.0 only (mostly the eBird Observation Dataset and iNaturalist research-grade; CC BY-NC records left out), one GBIF search per ~1 km DIGIPIN block faceted by species. Richness is rarefied to 200 records with the hypergeometric expectation, so a birding hotspot and a lightly visited block compare fairly; blocks with fewer records are not rated. Blocks with under ${BIRD_FEW} records count as unsurveyed. Hotspots are blocks with ${BIRD_HOT} or more records, ${SPACING_KM} km apart, with the highest rarefied richness.`,
            refs: 'GBIF.org occurrence search (CC0 and CC BY 4.0 records); eBird Observation Dataset (Cornell Lab of Ornithology); Gotelli & Colwell (2001), rarefaction' },
        { id: 'drainbuffer', equity: false, title: 'Storm-water drain buffer building', icon: '🌊',
            question: 'How much building stands in the no-build buffer along storm-water drains?',
            field: { key: 'drain_built', label: 'Built-up share inside the RMP 2015 drain buffer (upper bound per block)', unit: '%', higherIs: 'worse', ramp: 'reds', domain: [0, 60] },
            needs: ['drain_buffers.buffer_pct', 'drain_buffers.buffer_ngt_pct', 'drain_buffers.primary_m', 'drain_buffers.secondary_m', 'drain_buffers.tertiary_m', 'built_up.built_pct', 'population.population'],
            method: 'BBMP\'s 2022 primary, secondary and tertiary storm-water drain maps on data.opencity.in (public domain), drawn on a 10 m raster. The buffer is the Revised Master Plan 2015 zoning rule: 50 m from the centre of a primary drain (rajakaluve), 25 m from a secondary and 15 m from a tertiary; the National Green Tribunal\'s wider 2016 buffer (50, 35 and 25 m from the edge) was set aside by the Supreme Court in 2019 and is kept as a screen. Built land in the buffer is estimated pro rata (the block\'s built-up share times its buffer share), and the map value is the smaller of the two shares, an upper bound per block. Many tertiary drains run beside streets, so their buffer takes in road space as well as plots. Bengaluru only.',
            refs: 'Revised Master Plan 2015 zoning regulations (BDA); NGT order in Forward Foundation v. State of Karnataka (2016); Supreme Court, Civil Appeal 5016 of 2016 (2019); BBMP via OpenCity' },
        { id: 'parkreach', equity: true, title: 'Neighbourhood park reach', icon: '🌳',
            question: 'Who has no park or playground nearby, and which reserved open spaces could fix it?',
            field: { key: 'park_near', label: `Listed park or playground within ${PARK_M} m (1 yes, 0 no)`, unit: '', higherIs: 'better', ramp: 'greens', domain: [0, 1] },
            needs: ['parks_official.parks', 'parks_official.playgrounds', 'parks_official.open_spaces', 'parks_official.park_m2', 'population.population'],
            method: `Parks, playgrounds and layout open spaces from the corporations' maps on data.opencity.in (public domain): GHMC parks (823), playgrounds (488) and open spaces left in approved layouts (1,355), 2018, for Hyderabad; PMC parks and gardens (198 outlines, about 200 ha) for Pune. A block is served when a listed park or playground lies within ${PARK_M} m on the block grid (URDPFI's housing-area park); blocks more than ${PARK_JUDGE_KM} km from any listed park are outside the corporation's map and not judged. Hyderabad picks are layout open spaces ${SPACING_KM} km apart with the most unserved residents within ${PARK_M} m; Pune picks are unserved blocks; the cantonments run their own gardens and are not on PMC's list.`,
            refs: 'URDPFI Guidelines 2015 (MoHUA), open space hierarchy; GHMC and PMC via OpenCity' },
        { id: 'lakebuffer', equity: false, title: 'Lake buffer building', icon: '🏞️',
            question: 'How much building stands inside the no-build buffer round lakes?',
            field: { key: 'buffer_built', label: 'Built-up share inside the statutory lake buffer (upper bound per block)', unit: '%', higherIs: 'worse', ramp: 'reds', domain: [0, 40] },
            needs: ['lake_buffers.lake_pct', 'lake_buffers.buffer30_pct', 'lake_buffers.buffer75_pct', 'built_up.built_pct', 'population.population'],
            method: 'Lakes, tanks and other wetlands from the Karnataka GIS wetland map of Bengaluru Urban (265 polygons) and GHMC\'s reservoirs and tanks for Hyderabad (849 polygons) on data.opencity.in (public domain), filled on a 10 m raster. The statutory buffer is 30 m round every lake in Bengaluru\'s zoning regulations, and in Hyderabad 30 m round tanks of 10 ha or more and 9 m round smaller ones (GO Ms 168, 2012); 75 m is the buffer the National Green Tribunal ordered for Bengaluru in 2016 (set aside by the Supreme Court in 2019), kept as a wider screen. Built land in a buffer is estimated pro rata (the block\'s built-up share times its buffer share) and the map value is the smaller of the two shares, an upper bound on the buffer\'s built share in that block. Bengaluru and Hyderabad; the maps carry no lake names, and the mapped outline is not the surveyed full tank level.',
            refs: 'Revised Master Plan 2015 zoning regulations (BDA); NGT order in Forward Foundation v. State of Karnataka (2016); GO Ms 168 (2012) building rules; KGIS and GHMC via OpenCity' },
        { id: 'policereach', equity: true, title: 'Police station reach', icon: '🚓',
            question: 'Who lives far from a police station?',
            field: { key: 'police_km', label: 'Distance to the nearest police station', unit: 'km', higherIs: 'worse', ramp: 'reds', domain: [0, 5] },
            needs: ['police_official.stations', 'police_official.outposts', 'police_official.in_area', 'population.population'],
            method: `Police stations from the state police maps on data.opencity.in (public domain): Mumbai Police (101 stations), Karnataka Police KGIS for Bengaluru Urban (115 stations, 12 outposts) and Telangana Police for Hyderabad district and the Cyberabad and Rachakonda suburbs (95 law-and-order stations; traffic stations, quarters and offices left out by name). Straight-line distance from each lived-in block to the nearest station; only blocks inside the city police's own jurisdiction map are judged in Mumbai and Bengaluru (so Thane is not read as a gap in Mumbai Police's map); in Hyderabad, whose jurisdiction map covers only the city commissionerate, blocks more than ${POLICE_JUDGE_KM} km from every listed station are not judged. New-station picks are blocks ${SPACING_KM} km apart that bring the most residents now beyond ${POLICE_KM} km within ${POLICE_KM} km.`,
            refs: 'BPR&D Data on Police Organisations (station norms); Mumbai, Karnataka and Telangana Police via OpenCity' },
        { id: 'buildlimits', equity: false, title: 'Coastal and eco-sensitive building limits', icon: '🚧',
            question: 'Where does coastal or forest law cap new building?',
            field: { key: 'limit_pct', label: 'Share of the block inside the Coastal Regulation Zone or an eco-sensitive zone', unit: '%', higherIs: 'worse', ramp: 'blues', domain: [0, 100] },
            needs: ['eco_limits.crz_pct', 'eco_limits.esz_pct', 'eco_limits.protected_pct', 'population.population', 'built_up.built_pct', 'big_projects.projects'],
            method: 'Chennai: the Tamil Nadu CRZ boundary (TNGIS) on data.opencity.in (public domain) draws the landward CRZ line 500 m from the high-tide line and the edges of the zone along the tidal Adyar, Cooum and Buckingham Canal, not the zone itself; the zone is rebuilt on a 20 m raster as the 500 m band seaward of the line plus the narrow walled strips along the waterways (a walled pocket more than 600 m wide is ordinary land between two zones). Bengaluru: the Karnataka Forest Department 2022 boundaries of the Bannerghatta National Park eco-sensitive zone and the protected areas (Bannerghatta, Puttenahalli Lake Bird Conservation Reserve), filled on the same raster. Each block carries the share of its land inside; residents and built-up land are counted pro rata. The CRZ category (I-IV) and the exact high-tide line need the approved Coastal Zone Management Plan map.',
            refs: 'CRZ Notification 2019 (MoEFCC); Eco-sensitive zone notification for Bannerghatta National Park (MoEFCC, 2020); TNGIS and Karnataka Forest Department via OpenCity' },
        { id: 'bigprojects', equity: false, title: 'Large-project pipeline', icon: '🏗️',
            question: 'Where are big apartment and commercial projects coming up?',
            field: { key: 'projects_2km', label: `Large projects (20,000 m²+) cleared within ${PROJ_KM} km`, unit: 'projects', higherIs: 'better', ramp: 'heat', domain: [0, 30] },
            needs: ['big_projects.projects', 'big_projects.residential', 'big_projects.commercial', 'population.population'],
            method: `SEIAA Karnataka's map of construction projects with state environmental clearance in Bengaluru Urban (KGIS, about 600 projects) on data.opencity.in (public domain). Projects of 20,000 m² or more built-up need this clearance (EIA Notification 2006, item 8(a)), so the map covers every large apartment, office, mall and hotel project that applied. The type is read from the project name (mixed use counts as both). Counts within ${PROJ_KM} km on the block grid; clusters are blocks ${SPACING_KM} km apart with the most projects nearby. The map has no dates, sizes or completion status. Bengaluru only.`,
            refs: 'EIA Notification 2006 (item 8(a), building and construction projects); SEIAA Karnataka via KGIS and OpenCity' },
        { id: 'binreach', equity: true, title: 'Waste bin reach', icon: '🗑️',
            question: 'Where do residents have no public waste bin nearby?',
            field: { key: 'residents_per_bin', label: `Residents in the block per listed bin within ${BIN_M} m`, unit: 'people', higherIs: 'worse', ramp: 'reds', domain: [0, 5000] },
            needs: ['waste_bins.bins', 'population.population'],
            method: `Public bins from the corporations' maps on data.opencity.in (public domain): GCC street bins for Chennai (2022, about 11,000) and GHMC dumper bins for Hyderabad (2018, about 2,900; many since removed under GHMC's bin-free drive). Straight-line reach of ${BIN_M} m on the block grid; blocks more than ${BIN_JUDGE_KM} km from any listed bin are not judged. Picks are unserved blocks ${SPACING_KM} km apart with the most unserved residents within 500 m.`,
            refs: 'Solid Waste Management Rules 2016; Swachh Bharat Mission (Urban) 2.0 garbage-free cities protocol; OpenCity bin maps' },
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

    UrbanLenses.register(ENTRIES, { roadplan, lastrites, wellrisk, binreach, bigprojects, buildlimits, policereach, lakebuffer, parkreach, drainbuffer, birdlife });
    return { ENTRIES };
})();
