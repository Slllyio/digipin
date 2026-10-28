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
    const { _fin, _round, _people, _sumOver, _residents, within } = UrbanLenses._kit;

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
        const near = within(g, green, PARK_M / 1000), area = c['parks_official.in_area'], mapped = area && area.some(x => x > 0);
        const listed = mapped ? area : within(g, green, PARK_JUDGE_KM);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && v(listed, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const all = _sumOver(pop, idx, () => true), far = idx.filter(i => !(near[i] > 0)), pFar = _sumOver(pop, far, () => true);
        const stats = [
            { label: 'Parks and gardens on the corporation list', value: _people(Array.from({ length: n }, (_, i) => v(pk, i)).reduce((a, b) => a + b, 0)) },
        ];
        if (pg) stats.push({ label: '…and playgrounds', value: _people(Array.from({ length: n }, (_, i) => v(pg, i)).reduce((a, b) => a + b, 0)) });
        if (c['parks_official.park_m2']) stats.push({ label: 'Garden area per resident', value: `${_round(Array.from({ length: n }, (_, i) => v(c['parks_official.park_m2'], i)).reduce((a, b) => a + b, 0) / (all || 1), 2)} m²` });
        stats.push({ label: `Residents with no listed park or playground within ${PARK_M} m`, value: `${_people(pFar)} (${_round(100 * pFar / (all || 1))}%)` });
        const farPop = Float64Array.from({ length: n }, (_, i) => (v(pop, i) > 0 && v(listed, i) > 0 && !(near[i] > 0) ? v(pop, i) : 0));
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

    // Storm-drain gaps on wet streets. Where a corporation's drain map shows few storm drains along a block's streets and
    // the block pools water (the wettest quarter on the waterlogging index, or a reported flood spot), rain has nowhere to
    // go. Drains are compared with OpenStreetMap street length; judged inside the corporation near its mapped network.
    const SWD_THIN_PCT = 30, SWD_JUDGE_KM = 1.5, SWD_WET_Q = 0.75;

    function stormgap(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], swd = c['storm_drains.swd_m'];
        const road = c['osm_roads.road_km_km2'], wl = c['waterlogging.waterlogging_index'], spots = c['flood_reports.flood_spots'];
        const area = c['storm_drains.in_area'], nalla = c['storm_drains.nalla_m'];
        if (!pop || !swd || !road || !swd.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const near = within(g, Float64Array.from({ length: n }, (_, i) => v(swd, i) + v(nalla, i)), SWD_JUDGE_KM);
        const inCity = area && area.some(x => x > 0), idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && v(road, i) > 0 && near[i] > 0 && (!inCity || v(area, i) > 0)) idx.push(i);
        if (idx.length < 5) return null;
        const cover = i => Math.min(100, 100 * v(swd, i) / (v(road, i) * g.cellKm2 * 1000));
        const wls = idx.map(i => v(wl, i)).filter(x => x > 0).sort((a, b) => a - b);
        const wetCut = wls.length ? wls[Math.floor(wls.length * SWD_WET_Q)] : Infinity;
        const wet = i => v(wl, i) >= wetCut || v(spots, i) > 0;
        const thin = idx.filter(i => cover(i) < SWD_THIN_PCT), wetThin = thin.filter(wet);
        const all = _sumOver(pop, idx, () => true), pThin = _sumOver(pop, thin, () => true), pWet = _sumOver(pop, wetThin, () => true);
        const km = k => _round(Array.from({ length: n }, (_, i) => v(c[`storm_drains.${k}`], i)).reduce((a, b) => a + b, 0) / 1000);
        const stats = [
            { label: 'Storm-water drains mapped', value: `${km('swd_m')} km${km('closed_m') > 0 ? ` (${km('closed_m')} km covered)` : ''}${km('nalla_m') > 0 ? `, plus ${km('nalla_m')} km of nalas and major drains` : ''}` },
            { label: `Residents where drains run along under ${SWD_THIN_PCT}% of the streets`, value: `${_people(pThin)} (${_round(100 * pThin / (all || 1))}%)` },
            { label: '…of them in blocks that pool water or had reported floods', value: `${_people(pWet)} (${_round(100 * pWet / (all || 1))}% of residents)` },
        ];
        const score = Float64Array.from({ length: n }, (_, i) => v(pop, i) * (1 + v(wl, i) / 100) * (1 + Math.min(3, v(spots, i))));
        spaced(g, wetThin, score).forEach((i, k) => stats.push({ label: `Drain next ${k + 1}: ${g.codes[i]}`,
            value: `drains along ${_round(cover(i))}% of the streets; waterlogging ${_round(v(wl, i))}/100${v(spots, i) > 0 ? `, ${_round(v(spots, i))} flood spot${v(spots, i) > 1 ? 's' : ''} nearby` : ''}; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(cover(i));
        return {
            columns: { storm_cover_pct: out }, idx, weightKey: 'storm_cover_pct', noHotspots: true,
            metric: { label: 'Residents on wet streets with few storm drains', value: _round(100 * pWet / (all || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(pThin)} residents (${_round(100 * pThin / (all || 1))}%) live where the corporation's map shows storm drains along under ${SWD_THIN_PCT}% of the streets, and ${_people(pWet)} of them are in blocks that pool water or have reported flood spots: the first places to build or desilt drains. Small lane drains are often left off the maps, so check a block on the ground before acting.`,
            stats,
        };
    }

    // Piped water gaps. Where BWSSB's map shows no water line in or next to a block, homes rely on borewells and tankers.
    // Same yardsticks as the sewer-gap lens: none within WATER_NEAR_KM, or lines along under WATER_THIN_PCT of the streets.
    const WATER_NEAR_KM = 0.25, WATER_THIN_PCT = 30, WATER_JUDGE_KM = 2;

    function watergap(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], wp = c['water_lines.pipe_m'];
        const road = c['osm_roads.road_km_km2'], area = c['water_lines.in_area'], sw = c['sewers.sewer_m'], wells = c['borewells.borewells'];
        if (!pop || !wp || !wp.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const arr = Float64Array.from({ length: n }, (_, i) => v(wp, i));
        const svc = within(g, arr, WATER_JUDGE_KM), near = within(g, arr, WATER_NEAR_KM);
        const inCity = area && area.some(x => x > 0), idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && svc[i] > 0 && (!inCity || v(area, i) > 0)) idx.push(i);
        if (idx.length < 5) return null;
        const pct = i => (road && v(road, i) > 0 ? Math.min(100, 100 * v(wp, i) / (v(road, i) * g.cellKm2 * 1000)) : NaN);
        const none = idx.filter(i => !(near[i] > 0)), thin = idx.filter(i => near[i] > 0 && pct(i) < WATER_THIN_PCT);
        const all = _sumOver(pop, idx, () => true), pNone = _sumOver(pop, none, () => true), pThin = _sumOver(pop, thin, () => true);
        const stats = [
            { label: 'Water supply lines mapped', value: `${_people(arr.reduce((a, x) => a + x, 0) / 1000)} km` },
            { label: `Residents with no water line within ${WATER_NEAR_KM * 1000} m`, value: `${_people(pNone)} (${_round(100 * pNone / (all || 1))}%)` },
            { label: `Residents with a line nearby but along under ${WATER_THIN_PCT}% of their streets`, value: `${_people(pThin)} (${_round(100 * pThin / (all || 1))}%)` },
        ];
        if (sw && sw.some(x => x > 0)) {
            const swNear = within(g, Float64Array.from({ length: n }, (_, i) => v(sw, i)), WATER_NEAR_KM);
            stats.push({ label: '…with neither a water line nor a sewer within 250 m', value: _people(_sumOver(pop, none.filter(i => !(swNear[i] > 0)), () => true)) });
        }
        if (wells) stats.push({ label: 'Public borewells in blocks with no water line nearby', value: _people(none.reduce((a, i) => a + v(wells, i), 0)) });
        const gapPop = Float64Array.from({ length: n }, (_, i) => (near[i] > 0 ? 0 : v(pop, i)));
        const need = within(g, gapPop, 0.5);
        spaced(g, none, need).forEach((i, k) => stats.push({ label: `Water line next ${k + 1}: ${g.codes[i]}`, value: `${_people(need[i])} residents within 500 m with no water line close by` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = near[i] > 0 ? (_fin(pct(i)) ? _round(pct(i)) : 100) : 0;
        return {
            columns: { water_cover_pct: out }, idx, weightKey: 'water_cover_pct', noHotspots: true,
            metric: { label: `Residents with no water line within ${WATER_NEAR_KM * 1000} m`, value: _round(100 * pNone / (all || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(pNone)} residents (${_round(100 * pNone / (all || 1))}%) inside the corporation have no water supply line within ${WATER_NEAR_KM * 1000} m on BWSSB's map, and ${_people(pThin)} more live where lines run along under ${WATER_THIN_PCT}% of the streets; these homes lean on borewells and tankers. Lines laid since the map (Cauvery stage V reached many of the 110 villages from 2024) will be missing.`,
            stats,
        };
    }

    // Sewage treatment plants. Homes beside a plant live with its smell and trucks, and a city whose plants are smaller
    // than the sewage its people make sends the rest raw into lakes and rivers.
    const STP_NEAR_KM = 0.5, STP_JUDGE_KM = 3, SEWAGE_LPCD = 135 * 0.8;   // CPHEEO: 135 L a day, 80% returns as sewage

    function stpnear(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], st = c['stps.stps'], cap = c['stps.capacity_mld'], prop = c['stps.proposed'];
        if (!pop || !st || !st.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const arr = k => Float64Array.from({ length: n }, (_, i) => v(k, i));
        const stA = arr(st), near = within(g, stA, STP_NEAR_KM), mid = within(g, stA, 1), judge = within(g, stA, STP_JUDGE_KM);
        const pNear = prop ? within(g, arr(prop), STP_NEAR_KM) : null;
        const idx = _residents(fr).filter(i => judge[i] > 0);
        if (idx.length < 5) return null;
        const plants = stA.reduce((a, x) => a + x, 0), mld = arr(cap).reduce((a, x) => a + x, 0);
        const people = _sumOver(pop, _residents(fr), () => true), made = people * SEWAGE_LPCD / 1e6;
        const inNear = _sumOver(pop, idx.filter(i => near[i] > 0), () => true);
        const stats = [
            { label: 'Sewage treatment plants mapped', value: `${_round(plants)}${mld > 0 ? `, ${_people(mld)} MLD` : ''}` },
            { label: `Residents within ${STP_NEAR_KM * 1000} m of a plant`, value: `${_people(inNear)} (${_round(100 * inNear / (people || 1), 1)}%)` },
        ];
        let noCap = 0;
        for (let i = 0; i < n; i++) if (v(st, i) > 0 && !(v(cap, i) > 0)) noCap += v(st, i);
        const capKnown = noCap <= plants * 0.15;   // a few plants without a listed capacity still give a fair total
        if (capKnown && mld > 0) stats.push({ label: `Sewage made by ${_people(people)} residents (${SEWAGE_LPCD} L a day each) vs plant capacity`, value: `${_people(made)} MLD vs ${_people(mld)} MLD (${_round(100 * mld / (made || 1))}%)${noCap ? `; ${_round(noCap)} plant${noCap > 1 ? 's' : ''} without a listed capacity` : ''}` });
        if (pNear && pNear.some(x => x > 0)) stats.push({ label: `Residents within ${STP_NEAR_KM * 1000} m of a proposed plant`, value: _people(_sumOver(pop, idx.filter(i => pNear[i] > 0 && !(near[i] > 0)), () => true)) });
        const around = within(g, arr(pop), STP_NEAR_KM), sites = [];
        for (let i = 0; i < n; i++) if (v(st, i) > 0) sites.push(i);
        spaced(g, sites, around).forEach((i, k) => stats.push({ label: `Most hemmed-in plant ${k + 1}: ${g.codes[i]}`, value: `${_people(around[i])} residents within ${STP_NEAR_KM * 1000} m${v(cap, i) > 0 ? `; ${_round(v(cap, i))} MLD` : ''}` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = near[i] > 0 ? 2 : mid[i] > 0 ? 1 : 0;
        return {
            columns: { stp_near: out }, idx, weightKey: 'stp_near', noHotspots: true,
            metric: { label: `Residents within ${STP_NEAR_KM * 1000} m of a sewage treatment plant`, value: _round(100 * inNear / (people || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(inNear)} residents live within ${STP_NEAR_KM * 1000} m of one of the ${_round(plants)} mapped sewage treatment plants${capKnown && mld > 0 ? `, and the plants' rated capacity equals about ${_round(100 * mld / (made || 1))}% of the sewage the city's residents make (at ${SEWAGE_LPCD} litres a head a day; plants often run below their rating)` : ''}. Nearness flags smell and truck traffic to check on a visit, not a health risk.`,
            stats,
        };
    }

    // Basic services together. A home is short of a basic network when no water line, sewer or storm drain runs within
    // 250 m, no public bin within 250 m, or no public toilet within 1 km. Only the networks a city has mapped count, and a
    // network is judged only within 2 km of its mapped lines, inside the corporation.
    const BASICS = [
        { key: 'water', label: 'water line', cols: ['water_lines.pipe_m'], km: 0.25 },
        { key: 'sewer', label: 'sewer', cols: ['sewers.sewer_m'], km: 0.25 },
        { key: 'drain', label: 'storm drain', cols: ['storm_drains.swd_m', 'storm_drains.nalla_m'], km: 0.25 },
        { key: 'bin', label: 'public bin', cols: ['waste_bins.bins'], km: 0.25 },
        { key: 'toilet', label: 'public toilet', cols: ['toilets_official.toilets'], km: 1 },
    ];
    const BASICS_JUDGE_KM = 2;

    function basics(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        if (!pop) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const nets = BASICS.map(b => ({ ...b, arr: Float64Array.from({ length: n }, (_, i) => b.cols.reduce((a, k) => a + v(c[k], i), 0)) }))
            .filter(b => b.arr.some(x => x > 0))
            .map(b => ({ ...b, near: within(g, b.arr, b.km), reach: within(g, b.arr, BASICS_JUDGE_KM) }));
        if (nets.length < 2) return null;
        const areas = ['sewers.in_area', 'storm_drains.in_area', 'water_lines.in_area'].map(k => c[k]).filter(a => a && a.some(x => x > 0));
        const inCity = i => !areas.length || areas.some(a => v(a, i) > 0);
        const idx = _residents(fr).filter(i => inCity(i) && nets.every(b => b.reach[i] > 0));
        if (idx.length < 5) return null;
        const missing = Float64Array.from({ length: n }, (_, i) => nets.reduce((a, b) => a + (b.near[i] > 0 ? 0 : 1), 0));
        const all = _sumOver(pop, idx, () => true), short2 = idx.filter(i => missing[i] >= 2), pShort2 = _sumOver(pop, short2, () => true);
        const stats = [{ label: 'Networks mapped for this city', value: nets.map(b => b.label).join(', ') }];
        for (const b of nets) {
            const p = _sumOver(pop, idx.filter(i => !(b.near[i] > 0)), () => true);
            stats.push({ label: `Residents with no ${b.label} within ${b.km * 1000} m`, value: `${_people(p)} (${_round(100 * p / (all || 1))}%)` });
        }
        stats.push({ label: 'Residents short of two or more of them', value: `${_people(pShort2)} (${_round(100 * pShort2 / (all || 1))}%)` });
        const score = Float64Array.from({ length: n }, (_, i) => missing[i] * v(pop, i));
        spaced(g, short2, score).forEach((i, k) => stats.push({ label: `Most underserved ${k + 1}: ${g.codes[i]}`,
            value: `no ${nets.filter(b => !(b.near[i] > 0)).map(b => b.label).join(', no ')} nearby; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = missing[i];
        return {
            columns: { basics_missing: out }, idx, weightKey: 'basics_missing', noHotspots: true,
            metric: { label: 'Residents short of two or more basic networks', value: _round(100 * pShort2 / (all || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(pShort2)} residents (${_round(100 * pShort2 / (all || 1))}%) inside the corporation live where two or more of the city's mapped basic networks (${nets.map(b => b.label).join(', ')}) are missing nearby, on the city agencies' own maps. These are the pockets to check first for tanker water, septic tanks, flooding and dumping.`,
            stats,
        };
    }

    // Property registration offices. Every plot registers at the sub-registrar office (SRO) whose jurisdiction holds it,
    // and that office's guidance values apply. Offices serve very unequal populations, and fringe blocks can sit far
    // from theirs.
    const SRO_FAR_KM = 10;

    function sroload(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], sid = c['registration.sro_id'], d = c['registration.sro_km'];
        const big = c['big_projects.projects'];
        if (!pop || !sid || !d || !sid.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => v(sid, i) > 0 && _fin(d[i]));
        if (idx.length < 5) return null;
        const groups = new Map();
        for (const i of idx) {
            const k = sid[i], gr = groups.get(k) || { pop: 0, big: 0, office: i, near: Infinity };
            gr.pop += v(pop, i); gr.big += v(big, i);
            if (d[i] < gr.near) { gr.near = d[i]; gr.office = i; }
            groups.set(k, gr);
        }
        const list = [...groups.values()].sort((a, b) => b.pop - a.pop);
        const all = _sumOver(pop, idx, () => true), far = _sumOver(pop, idx, i => d[i] > SRO_FAR_KM);
        const med = list[Math.floor(list.length / 2)].pop;
        const dist = idx.slice().sort((a, b) => d[a] - d[b]);
        let acc = 0, medKm = 0;
        for (const i of dist) { acc += v(pop, i); if (acc >= all / 2) { medKm = d[i]; break; } }
        const stats = [
            { label: 'Sub-registrar offices covering the city', value: `${list.length}` },
            { label: 'Residents per office (median; busiest)', value: `${_people(med)}; ${_people(list[0].pop)}` },
            { label: 'Distance to one\'s own office (half of residents within)', value: `${_round(medKm, 1)} km` },
            { label: `Residents more than ${SRO_FAR_KM} km from their office`, value: `${_people(far)} (${_round(100 * far / (all || 1))}%)` },
        ];
        list.slice(0, 3).forEach((gr, k) => stats.push({ label: `Busiest office ${k + 1}, near ${g.codes[gr.office]}`, value: `${_people(gr.pop)} residents in its jurisdiction${big && gr.big > 0 ? `; ${_round(gr.big)} large project${gr.big > 1 ? 's' : ''}` : ''}` }));
        const score = Float64Array.from({ length: n }, (_, i) => v(d, i) * v(pop, i));
        spaced(g, idx.filter(i => d[i] > SRO_FAR_KM), score, 3).forEach((i, k) => stats.push({ label: `Far from its office ${k + 1}: ${g.codes[i]}`, value: `${_round(d[i], 1)} km to the sub-registrar office; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(d[i], 1);
        return {
            columns: { sro_km: out }, idx, weightKey: 'sro_km', noHotspots: true,
            metric: { label: 'Residents per sub-registrar office (median)', value: Math.round(med), unit: 'people', higherIs: 'worse' },
            headline: `${list.length} sub-registrar offices register property across the city: the median office serves ${_people(med)} residents and the busiest ${_people(list[0].pop)}. Half of residents live within ${_round(medKm, 1)} km of their own office, and ${_people(far)} live more than ${SRO_FAR_KM} km away.`,
            stats,
        };
    }

    const PIN_BIG = 500000;

    function pinsize(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], pin = c['pincodes.pincode'], km2 = c['pincodes.pin_km2'];
        if (!pop || !pin || !pin.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = _residents(fr).filter(i => v(pin, i) > 0);
        if (idx.length < 5) return null;
        const groups = new Map();
        for (const i of idx) {
            const gr = groups.get(pin[i]) || { pin: pin[i], pop: 0, km2: v(km2, i), at: i, top: -1 };
            gr.pop += v(pop, i);
            if (v(pop, i) > gr.top) { gr.top = v(pop, i); gr.at = i; }
            groups.set(pin[i], gr);
        }
        const list = [...groups.values()].sort((a, b) => b.pop - a.pop);
        const all = list.reduce((t, gr) => t + gr.pop, 0), big = list.filter(gr => gr.pop > PIN_BIG);
        const inBig = big.reduce((t, gr) => t + gr.pop, 0);
        const med = list[Math.floor(list.length / 2)].pop;
        const areas = list.map(gr => gr.km2).filter(x => x > 0).sort((a, b) => a - b);
        const medKm2 = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
        const stats = [
            { label: 'Pincodes covering the city\'s homes', value: `${list.length}` },
            { label: 'Residents per pincode (median; largest)', value: `${_people(med)}; ${_people(list[0].pop)}` },
            { label: 'Area a pincode covers (median)', value: `${_round(medKm2, 1)} km²` },
            { label: `Residents in pincodes of more than ${_people(PIN_BIG)} people`, value: `${_people(inBig)} (${_round(100 * inBig / (all || 1))}%) in ${big.length} pincode${big.length === 1 ? '' : 's'}` },
        ];
        list.slice(0, 3).forEach((gr, k) => stats.push({ label: `Most crowded pincode ${k + 1}: ${gr.pin} (near ${g.codes[gr.at]})`, value: `${_people(gr.pop)} residents over ${_round(gr.km2, 1)} km²` }));
        const per = new Map(list.map(gr => [gr.pin, gr.pop]));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = Math.round(per.get(pin[i]) / 1000);
        return {
            columns: { pin_people: out }, idx, weightKey: 'pin_people', noHotspots: true,
            metric: { label: 'Residents per pincode (median)', value: Math.round(med), unit: 'people', higherIs: 'worse' },
            headline: `${list.length} pincodes cover the city's homes: the median one holds ${_people(med)} residents over ${_round(medKm2, 1)} km², and the most crowded ${_people(list[0].pop)}. ${big.length ? `${_round(100 * inBig / (all || 1))}% of residents share a pincode with more than ${_people(PIN_BIG)} people, where a pincode alone says little about where a door is and a DigiPin says most.` : `No pincode here holds more than ${_people(PIN_BIG)} people.`}`,
            stats,
        };
    }

    function potholes(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, rep = c['potholes.reports'], fixed = c['potholes.fixed'], cuts = c['potholes.road_cuts'];
        const m2 = c['potholes.pothole_m2'], rs = c['potholes.repair_rs'], main = c['potholes.main_road'], road = c['osm_roads.road_km_km2'];
        if (!rep || !rep.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(rep, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const sum = a => idx.reduce((t, i) => t + v(a, i), 0);
        const total = sum(rep), done = sum(fixed), cut = sum(cuts), onMain = sum(main), area = sum(m2), cost = sum(rs);
        const perKm = Float64Array.from({ length: n }, (_, i) => {
            const km = v(road, i) * g.cellKm2;
            return v(rep, i) > 0 ? v(rep, i) / Math.max(km, 0.5) : 0;
        });
        const open = Float64Array.from({ length: n }, (_, i) => Math.max(v(rep, i) - v(fixed, i), 0));
        const stats = [
            { label: 'Complaints the BBMP accepted (May-June 2022)', value: `${Math.round(total).toLocaleString('en-IN')}` },
            { label: 'Fixed by the end of June 2022', value: `${Math.round(done).toLocaleString('en-IN')} (${_round(100 * done / total)}%)` },
            { label: 'Roads dug up by a utility and left unrepaired', value: `${Math.round(cut).toLocaleString('en-IN')} (${_round(100 * cut / total)}%)` },
            { label: 'On arterial and sub-arterial roads', value: `${Math.round(onMain).toLocaleString('en-IN')} (${_round(100 * onMain / total)}%)` },
            { label: 'Road surface to repair; engineers\' estimate', value: `${Math.round(area).toLocaleString('en-IN')} m²; ₹${_round(cost / 1e7, 1)} crore` },
        ];
        spaced(g, idx, open, 5).forEach((i, k) => stats.push({ label: `Pothole cluster ${k + 1}: ${g.codes[i]}`, value: `${Math.round(v(rep, i))} complaints (${Math.round(v(fixed, i))} fixed); ${_round(perKm[i], 1)} per km of street` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(perKm[i], 1);
        return {
            columns: { pothole_per_km: out }, idx, weightKey: 'pothole_per_km', noHotspots: true,
            metric: { label: 'Pothole complaints fixed within the two months', value: _round(100 * done / total), unit: '%', higherIs: 'better' },
            headline: `In May and June 2022 the BBMP accepted ${Math.round(total).toLocaleString('en-IN')} pothole complaints across ${idx.length.toLocaleString('en-IN')} blocks and had fixed ${_round(100 * done / total)}% by the end of June. ${_round(100 * cut / total)}% were roads dug up by a utility and left open; ${_round(100 * onMain / total)}% were on main roads. The engineers put the repairs at ₹${_round(cost / 1e7, 1)} crore.`,
            stats,
        };
    }

    function revvillage(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], vid = c['villages.village_id'], km2 = c['villages.village_km2'], town = c['villages.in_town'];
        if (!pop || !vid || !vid.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const lived = _residents(fr), idx = lived.filter(i => v(vid, i) > 0);
        if (idx.length < 5) return null;
        const groups = new Map();
        for (const i of idx) {
            const gr = groups.get(vid[i]) || { pop: 0, km2: v(km2, i), at: i, top: -1 };
            gr.pop += v(pop, i);
            if (v(pop, i) > gr.top) { gr.top = v(pop, i); gr.at = i; }
            groups.set(vid[i], gr);
        }
        const list = [...groups.values()].sort((a, b) => b.pop - a.pop);
        const all = _sumOver(pop, lived, () => true), inV = list.reduce((t, gr) => t + gr.pop, 0), inT = _sumOver(pop, lived, i => v(town, i) > 0);
        const med = list[Math.floor(list.length / 2)].pop, big = list.filter(gr => gr.pop > 100000);
        const stats = [
            { label: 'Revenue villages under the city\'s homes', value: `${list.length}` },
            { label: 'Residents on village land (the map names their village)', value: `${_people(inV)} (${_round(100 * inV / (all || 1))}%)` },
            { label: 'Residents inside a town, municipal or cantonment limit on the map', value: `${_people(inT)} (${_round(100 * inT / (all || 1))}%)` },
            { label: 'Residents per village (median; most)', value: `${_people(med)}; ${_people(list[0].pop)}` },
            { label: 'Villages now home to more than 1 lakh people', value: `${big.length}` },
        ];
        list.slice(0, 3).forEach((gr, k) => stats.push({ label: `Most lived-in village ${k + 1}, near ${g.codes[gr.at]}`, value: `${_people(gr.pop)} residents on a village of ${_round(gr.km2, 1)} km²` }));
        const per = new Map([...groups.entries()].map(([k, gr]) => [k, gr.pop]));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = Math.round(per.get(vid[i]) / 1000);
        return {
            columns: { village_people: out }, idx, weightKey: 'village_people', noHotspots: true,
            metric: { label: 'Revenue villages under the city\'s homes', value: list.length, unit: 'villages', higherIs: 'better' },
            headline: `The city's homes sit on ${list.length} revenue villages: ${_round(100 * inV / (all || 1))}% of residents live on land the Survey of India map files under a village (median ${_people(med)} people per village), and ${big.length} village${big.length === 1 ? ' is' : 's are'} now home to more than 1 lakh people. Click a block for its village, tehsil and district, the names land records are kept under.`,
            stats,
        };
    }

    function bdalayout(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, lid = c['bda_layouts.layout_id'], built = c['built_up.built_pct'], pop = c['population.population'];
        const fresh = c['building_stock.new_buildings'];
        if (!lid || !lid.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(lid, i) > 0) idx.push(i);
        if (idx.length < 5) return null;
        const groups = new Map();
        for (const i of idx) {
            const gr = groups.get(lid[i]) || { blocks: 0, built: 0, pop: 0, fresh: 0, at: i };
            gr.blocks++; gr.built += v(built, i); gr.pop += v(pop, i); gr.fresh += v(fresh, i);
            groups.set(lid[i], gr);
        }
        for (const gr of groups.values()) { gr.km2 = gr.blocks * g.cellKm2; gr.builtPct = gr.built / gr.blocks; }
        const list = [...groups.values()];
        const all = pop ? _sumOver(pop, _residents(fr), () => true) : 0, inL = list.reduce((t, gr) => t + gr.pop, 0);
        const area = list.reduce((t, gr) => t + gr.km2, 0), builtAll = list.reduce((t, gr) => t + gr.built, 0) / idx.length;
        const sizable = list.filter(gr => gr.km2 >= 1);
        const empty = sizable.slice().sort((a, b) => a.builtPct - b.builtPct), filling = sizable.slice().sort((a, b) => b.fresh / b.km2 - a.fresh / a.km2);
        const stats = [
            { label: 'BDA layouts on the map', value: `${list.length}, about ${_round(area, 0)} km²` },
            { label: 'Residents living in a BDA layout', value: all ? `${_people(inL)} (${_round(100 * inL / all)}%)` : `${_people(inL)}` },
            { label: 'Ground built over, across the layouts', value: `${_round(builtAll)}%` },
        ];
        empty.slice(0, 3).forEach((gr, k) => stats.push({ label: `Least built-out layout ${k + 1}, near ${g.codes[gr.at]}`, value: `${_round(gr.builtPct)}% built over across ${_round(gr.km2, 1)} km²; ${_people(gr.pop)} residents` }));
        if (fresh) filling.slice(0, 3).forEach((gr, k) => stats.push({ label: `Fastest-filling layout ${k + 1}, near ${g.codes[gr.at]}`, value: `${Math.round(gr.fresh).toLocaleString('en-IN')} new buildings since 2016 (${Math.round(gr.fresh / gr.km2).toLocaleString('en-IN')} per km²)` }));
        const per = new Map([...groups.entries()].map(([k, gr]) => [k, gr.builtPct]));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(per.get(lid[i]));
        return {
            columns: { layout_built_pct: out }, idx, weightKey: 'layout_built_pct', noHotspots: true,
            metric: { label: 'Ground built over across BDA layouts', value: _round(builtAll), unit: '%', higherIs: 'better' },
            headline: `${list.length} BDA layouts cover about ${_round(area, 0)} km²${all ? ` and house ${_round(100 * inL / all)}% of residents` : ''}. Across them ${_round(builtAll)}% of the ground is built over; the emptiest large layout, near ${g.codes[empty[0]?.at ?? idx[0]]}, is only ${_round(empty[0]?.builtPct ?? 0)}% built. Click a block for its layout name.`,
            stats,
        };
    }

    // Impervious Cover Model (Schueler 1994; Center for Watershed Protection 2003): stream health falls with paved share.
    const ICM = [[10, 'sensitive'], [25, 'impacted'], [60, 'non-supporting'], [Infinity, 'urban drainage']];

    function watershedpave(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, mid = c['watersheds.mws_id'], km2 = c['watersheds.mws_km2'], built = c['built_up.built_pct'];
        const pop = c['population.population'], grow = c['built_up.built_change_pct'];
        if (!mid || !built || !mid.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const groups = new Map();
        for (let i = 0; i < n; i++) {
            if (!(v(mid, i) > 0) || !_fin(built[i])) continue;
            const gr = groups.get(mid[i]) || { idx: [], built: 0, pop: 0, grow: 0, km2: v(km2, i) };
            gr.idx.push(i); gr.built += built[i]; gr.pop += v(pop, i); gr.grow += v(grow, i);
            groups.set(mid[i], gr);
        }
        // judge only micro-watersheds mostly inside the view, so a sliver does not stand for the whole catchment
        const list = [...groups.values()].filter(gr => gr.km2 > 0 && gr.idx.length * g.cellKm2 >= 0.5 * gr.km2);
        if (list.length < 3) return null;
        for (const gr of list) { gr.pct = gr.built / gr.idx.length; gr.cls = ICM.findIndex(([hi]) => gr.pct <= hi); gr.growPct = gr.grow / gr.idx.length; }
        const idx = list.flatMap(gr => gr.idx);
        const count = k => list.filter(gr => gr.cls === k).length, people = k => list.filter(gr => gr.cls === k).reduce((t, gr) => t + gr.pop, 0);
        const allPop = list.reduce((t, gr) => t + gr.pop, 0);
        const stats = ICM.map(([hi, name], k) => ({ label: `Micro-watersheds ${name} (${k ? `${ICM[k - 1][0]}-` : 'up to '}${hi === Infinity ? '100' : hi}% built over)`, value: `${count(k)} of ${list.length}; ${_people(people(k))} residents` }));
        const tipping = list.filter(gr => gr.cls === 1 && gr.pct > 20).sort((a, b) => b.pct - a.pct);
        list.slice().sort((a, b) => b.pct - a.pct).slice(0, 3).forEach((gr, k) => stats.push({ label: `Most paved micro-watershed ${k + 1}, around ${g.codes[gr.idx[Math.floor(gr.idx.length / 2)]]}`, value: `${_round(gr.pct)}% built over across ${_round(gr.km2, 1)} km²` }));
        tipping.slice(0, 3).forEach((gr, k) => stats.push({ label: `Near the 25% line ${k + 1}, around ${g.codes[gr.idx[Math.floor(gr.idx.length / 2)]]}`, value: `${_round(gr.pct)}% built over${grow ? `; built-up grew ${_round(gr.growPct)}% recently` : ''}` }));
        const out = new Float64Array(n).fill(NaN);
        for (const gr of list) for (const i of gr.idx) out[i] = _round(gr.pct);
        const over = list.filter(gr => gr.cls >= 2).length;
        return {
            columns: { mws_built_pct: out }, idx, weightKey: 'mws_built_pct', noHotspots: true,
            metric: { label: 'Micro-watersheds more than 25% built over', value: _round(100 * over / list.length), unit: '%', higherIs: 'worse' },
            headline: `${over} of ${list.length} micro-watersheds here are more than 25% built over, past the point where the Impervious Cover Model expects streams and lakes to stop supporting healthy life and floods to rise${count(3) ? `; ${count(3)} ${count(3) === 1 ? 'is' : 'are'} past 60%, drained mostly by pipes and channels` : ''}. ${_round(100 * people(0) / (allPop || 1))}% of residents live in catchments still under 10%. ${tipping.length} more sit between 20 and 25%.`,
            stats,
        };
    }

    const STUDENT_KM = 2;
    // outstation pull: universities and engineering colleges draw students from far more than PU colleges do
    const PULL = { 'colleges.degree': 1, 'colleges.engineering': 2, 'colleges.polytechnic': 1, 'colleges.university': 3 };

    function studenthousing(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, all = c['colleges.colleges'], hostels = c['places.hostels'];
        if (!all || !all.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const pull = Float64Array.from({ length: n }, (_, i) => Object.entries(PULL).reduce((t, [k, w]) => t + w * v(c[k], i), 0));
        const nearPull = within(g, pull, STUDENT_KM), nearCol = within(g, Float64Array.from({ length: n }, (_, i) => v(all, i)), STUDENT_KM);
        const nearBeds = hostels ? within(g, Float64Array.from({ length: n }, (_, i) => v(hostels, i)), STUDENT_KM) : new Float64Array(n);
        const idx = [];
        for (let i = 0; i < n; i++) if (nearCol[i] > 0) idx.push(i);
        if (idx.length < 5) return null;
        const gap = Float64Array.from({ length: n }, (_, i) => (nearPull[i] > 0 ? nearPull[i] / (1 + nearBeds[i]) : 0));
        const sum = k => idx.length && c[k] ? Array.from({ length: n }, (_, i) => v(c[k], i)).reduce((a, b) => a + b, 0) : 0;
        const hubs = spaced(g, idx, nearPull, 3), gaps = spaced(g, idx.filter(i => nearPull[i] >= 5), gap, 5);
        const stats = [
            { label: 'Colleges and universities on the state maps', value: `${Math.round(sum('colleges.colleges'))} (${Math.round(sum('colleges.pu'))} PU, ${Math.round(sum('colleges.degree'))} degree, ${Math.round(sum('colleges.engineering'))} engineering, ${Math.round(sum('colleges.polytechnic'))} polytechnic, ${Math.round(sum('colleges.university'))} universities)` },
            { label: `Hostels and PGs listed within ${STUDENT_KM} km of a college`, value: hostels ? `${Math.round(idx.reduce((t, i) => t + v(hostels, i), 0))}` : 'not mapped here' },
        ];
        hubs.forEach((i, k) => stats.push({ label: `College cluster ${k + 1}: ${g.codes[i]}`, value: `${Math.round(nearCol[i])} colleges within ${STUDENT_KM} km (pull ${Math.round(nearPull[i])}); ${Math.round(nearBeds[i])} hostels and PGs listed` }));
        gaps.forEach((i, k) => stats.push({ label: `Student-housing gap ${k + 1}: ${g.codes[i]}`, value: `pull ${Math.round(nearPull[i])} from ${Math.round(nearCol[i])} colleges within ${STUDENT_KM} km, ${nearBeds[i] < 0.5 ? 'no' : `only ${Math.round(nearBeds[i])}`} hostels or PGs listed` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(gap[i], 1);
        const top = gaps[0];
        return {
            columns: { student_gap: out }, idx, weightKey: 'student_gap', noHotspots: true,
            metric: { label: `Blocks within ${STUDENT_KM} km of a college`, value: idx.length, unit: 'blocks', higherIs: 'better' },
            headline: `The state maps place ${Math.round(sum('colleges.colleges'))} colleges and universities here. ${top !== undefined ? `The widest gap between student pull and listed hostels and PGs is around ${g.codes[top]}: ${Math.round(nearCol[top])} colleges within ${STUDENT_KM} km and ${nearBeds[top] < 0.5 ? 'no hostel or PG' : `${Math.round(nearBeds[top])} hostels or PGs`} listed.` : ''} Pull weights universities 3, engineering colleges 2 and degree colleges and polytechnics 1, for the students they draw from out of town.`,
            stats,
        };
    }

    const VACANT_17 = 40;

    function vacant2017(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, vac = c['landuse_2017.vacant_pct'], res = c['landuse_2017.residential_pct'];
        const com = c['landuse_2017.commercial_pct'], ind = c['landuse_2017.industrial_pct'], fresh = c['building_stock.new_buildings'];
        if (!vac || !res || !res.some(x => x > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0), nb = i => Math.max(v(fresh, i), 0);
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(res[i]) || _fin(vac[i])) idx.push(i);
        if (idx.length < 5) return null;
        const km2 = (a, f = () => true) => idx.reduce((t, i) => t + (f(i) ? v(a, i) / 100 * g.cellKm2 : 0), 0);
        const open17 = idx.filter(i => v(vac, i) >= VACANT_17);
        const fills = open17.map(nb).sort((a, b) => a - b), medFill = fills.length ? fills[Math.floor(fills.length / 2)] : 0;
        const still = open17.filter(i => nb(i) <= Math.min(medFill, 5)), filled = open17.filter(i => nb(i) > medFill);
        const area = idx.length * g.cellKm2;
        const stats = [
            { label: 'Ground mapped in the 2017 land use map', value: `${_round(area, 0)} km²` },
            { label: 'Residential; commercial; industrial (2017)', value: `${_round(100 * km2(res) / area)}%; ${_round(100 * km2(com) / area)}%; ${_round(100 * km2(ind) / area)}%` },
            { label: 'Vacant land and unbuilt layouts in 2017', value: `${_round(km2(vac), 1)} km² (${_round(100 * km2(vac) / area)}%)` },
            { label: `Blocks at least ${VACANT_17}% vacant in 2017`, value: `${open17.length}` },
            ...(fresh ? [{ label: 'Of them, with few or no new buildings since 2016', value: `${still.length} (${_round(100 * still.length / (open17.length || 1))}%)` }] : []),
        ];
        const keep = Float64Array.from({ length: n }, (_, i) => v(vac, i) * g.cellKm2 / (1 + nb(i)));
        spaced(g, still, keep, 4).forEach((i, k) => stats.push({ label: `Still open since 2017 ${k + 1}: ${g.codes[i]}`, value: `${_round(v(vac, i))}% vacant in 2017; ${Math.round(nb(i))} new buildings since 2016` }));
        if (fresh) spaced(g, filled, Float64Array.from({ length: n }, (_, i) => nb(i)), 3).forEach((i, k) => stats.push({ label: `Filled in since 2017 ${k + 1}: ${g.codes[i]}`, value: `${_round(v(vac, i))}% vacant in 2017; ${Math.round(nb(i))} new buildings since 2016` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(v(vac, i));
        return {
            columns: { vacant_2017_pct: out }, idx, weightKey: 'vacant_2017_pct', noHotspots: true,
            metric: { label: 'Vacant land and unbuilt layouts in 2017', value: _round(km2(vac), 1), unit: 'km²', higherIs: 'better' },
            headline: `KSRSAC's 2017 map puts ${_round(km2(vac), 1)} km² of the city (${_round(100 * km2(vac) / area)}%) as vacant land or laid-out but unbuilt layouts. ${open17.length} blocks were at least ${VACANT_17}% vacant${fresh ? `; ${still.length} of them have added few or no buildings since 2016, the land still most likely open today` : ''}.`,
            stats,
        };
    }

    function landchange(fr) {
        const g = fr.grid, c = fr.cols, n = g.n;
        const a = k => c[`landuse_2011.${k}_pct`], b = k => c[`landuse_2017.${k}_pct`];
        if (!a('residential') || !b('residential') || !a('residential').some(x => x > 0)) return null;
        const v = (arr, i) => (arr && _fin(arr[i]) ? arr[i] : 0);
        const idx = [];
        for (let i = 0; i < n; i++) if ((_fin(a('residential')[i]) || _fin(a('vacant')?.[i])) && (_fin(b('residential')[i]) || _fin(b('vacant')?.[i]))) idx.push(i);
        if (idx.length < 5) return null;
        const open = (f, i) => v(f('vacant'), i) + v(f('farm'), i);
        const built = (f, i) => ['residential', 'commercial', 'industrial', 'civic', 'road'].reduce((t, k) => t + v(f(k), i), 0);
        const conv = Float64Array.from({ length: n }, (_, i) => Math.max(open(a, i) - open(b, i), 0));
        const km2 = fn => idx.reduce((t, i) => t + fn(i) / 100 * g.cellKm2, 0);
        const open11 = km2(i => open(a, i)), open17 = km2(i => open(b, i)), converted = km2(i => conv[i]);
        const gain = k => km2(i => Math.max(v(b(k), i) - v(a(k), i), 0));
        const lost = k => km2(i => Math.max(v(a(k), i) - v(b(k), i), 0));
        const builtGain = km2(i => Math.max(built(b, i) - built(a, i), 0));
        const stats = [
            { label: 'Vacant and farm land, 2011 to 2017', value: `${_round(open11, 1)} km² to ${_round(open17, 1)} km²` },
            { label: 'Open land converted in blocks that lost it', value: `${_round(converted, 1)} km²` },
            { label: 'Gross gain in homes; shops and offices; industry', value: `${_round(gain('residential'), 1)}; ${_round(gain('commercial'), 1)}; ${_round(gain('industrial'), 1)} km²` },
            { label: 'Built-up ground added (all built classes and roads)', value: `${_round(builtGain, 1)} km²` },
            { label: 'Green and water ground lost (gross)', value: `${_round(lost('green'), 1)} km² green; ${_round(lost('water'), 1)} km² water` },
        ];
        spaced(g, idx, conv, 5).forEach((i, k) => stats.push({ label: `Most converted ${k + 1}: ${g.codes[i]}`, value: `${_round(open(a, i))}% vacant or farm in 2011, ${_round(open(b, i))}% in 2017` }));
        const wl = Float64Array.from({ length: n }, (_, i) => Math.max(v(a('water'), i) - v(b('water'), i), 0));
        spaced(g, idx.filter(i => wl[i] >= 20), wl, 3).forEach((i, k) => stats.push({ label: `Water lost ${k + 1}: ${g.codes[i]}`, value: `${_round(v(a('water'), i))}% water in 2011, ${_round(v(b('water'), i))}% in 2017 (check: the two maps draw lakes differently)` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(conv[i]);
        return {
            columns: { converted_pct: out }, idx, weightKey: 'converted_pct', noHotspots: true,
            metric: { label: 'Open land converted 2011-2017', value: _round(converted, 1), unit: 'km²', higherIs: 'worse' },
            headline: `Between KSRSAC's 2011 and 2017 maps, vacant and farm land in the BBMP area went from ${_round(open11, 1)} km² to ${_round(open17, 1)} km²: ${_round(converted, 1)} km² was converted in the blocks that lost it, mostly to homes (${_round(gain('residential'), 1)} km² gross gain) with ${_round(gain('commercial') + gain('industrial'), 1)} km² to shops, offices and industry.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'landchange', equity: false, title: 'Land converted 2011-2017', icon: '🔄',
            question: 'Which vacant and farm land turned into homes, shops or industry between 2011 and 2017?',
            field: { key: 'converted_pct', label: 'Share of the block that went from vacant or farm (2011) to another use (2017)', unit: 'points', higherIs: 'worse', ramp: 'reds', domain: [0, 60] },
            needs: ['landuse_2011.residential_pct', 'landuse_2011.commercial_pct', 'landuse_2011.industrial_pct', 'landuse_2011.vacant_pct', 'landuse_2011.farm_pct', 'landuse_2011.green_pct', 'landuse_2011.water_pct', 'landuse_2011.civic_pct', 'landuse_2011.road_pct',
                'landuse_2017.residential_pct', 'landuse_2017.commercial_pct', 'landuse_2017.industrial_pct', 'landuse_2017.vacant_pct', 'landuse_2017.farm_pct', 'landuse_2017.green_pct', 'landuse_2017.water_pct', 'landuse_2017.civic_pct', 'landuse_2017.road_pct'],
            method: 'KSRSAC\'s 2011 and 2017 urban land use maps of the BBMP area on data.opencity.in (public domain), each sampled per block on a 6 x 6 grid of points into the same nine groups (the 2011 map\'s numeric classes follow its published index). Converted land is the fall in vacant plus farm share from 2011 to 2017, block by block; gains and losses per class are gross (summed over blocks that gained or lost). The 2011 map rarely draws roads apart from the land beside them, so the lens compares built classes and roads together rather than residential alone, and the two maps outline lakes differently, so water losses are flagged for checking.',
            refs: 'KSRSAC Bengaluru urban land use and land cover 2011 and 2017 via OpenCity; NRSC LULC classification' },
        { id: 'vacant2017', equity: false, title: 'Vacant land in 2017, and since', icon: '🏗️',
            question: 'Where was land vacant in the official 2017 map, and which of it is still open?',
            field: { key: 'vacant_2017_pct', label: 'Vacant land and unbuilt layouts in 2017 (KSRSAC)', unit: '%', higherIs: 'better', ramp: 'viridis', domain: [0, 80] },
            needs: ['landuse_2017.vacant_pct', 'landuse_2017.residential_pct', 'landuse_2017.commercial_pct', 'landuse_2017.industrial_pct', 'building_stock.new_buildings'],
            method: `The Karnataka State Remote Sensing Applications Centre's 2017 urban land use map of the BBMP area on data.opencity.in (public domain; about 157,000 polygons). Each block is sampled on a 6 x 6 grid of points (about 40 m apart) and each point takes its polygon's class: residential, commercial, industrial, vacant land and laid-out but unbuilt layouts, civic, green, farm, water or road. Blocks at least ${VACANT_17}% vacant in 2017 are then checked against new buildings since 2016 from the building stock layer: those at or below the median (and at most 5) are "still open", those above it "filled in". The 2017 map covers the old BBMP area only, and its vacant class includes defence and government land kept open, so a pick is a lead to check, not a plot for sale.`,
            refs: 'KSRSAC Bengaluru urban land use and land cover 2017 via OpenCity; NRSC LULC classification (level I-III); Google Open Buildings temporal' },
        { id: 'studenthousing', equity: false, title: 'Student housing near colleges', icon: '🎓',
            question: 'Where do colleges draw students but few hostels or PGs are listed nearby?',
            field: { key: 'student_gap', label: `College pull within ${STUDENT_KM} km per listed hostel or PG (plus one)`, unit: 'index', higherIs: 'worse', ramp: 'reds', domain: [0, 12] },
            needs: ['colleges.colleges', 'colleges.pu', 'colleges.degree', 'colleges.engineering', 'colleges.polytechnic', 'colleges.university', 'places.hostels'],
            method: `Karnataka's 2023 higher-education maps for Bengaluru Urban on data.opencity.in (public domain, KGIS): 706 PU colleges, 371 degree colleges, 97 engineering colleges, 70 polytechnics and 24 universities. For each block the lens adds up the colleges within ${STUDENT_KM} km on the block grid, weighted by how many students they draw from out of town (universities 3, engineering 2, degree and polytechnic 1; PU colleges 0, as their students mostly live at home), and divides by one plus the hostels and PGs Overture Maps lists within the same distance. Picks are blocks with a pull of at least 5, ${SPACING_KM} km apart. Overture misses many informal PGs, so a gap is a lead for a site visit, not a count of beds.`,
            refs: 'Karnataka Department of Higher Education and KGIS (2023) via OpenCity; Overture Maps places; AISHE (All India Survey on Higher Education)' },
        { id: 'watershedpave', equity: false, title: 'Paved-over watersheds', icon: '💧',
            question: 'How much of each small catchment is paved over, and which are near the tipping point?',
            field: { key: 'mws_built_pct', label: 'Ground built over in the block\'s micro-watershed', unit: '%', higherIs: 'worse', ramp: 'reds', domain: [0, 60] },
            needs: ['watersheds.mws_id', 'watersheds.mws_km2', 'built_up.built_pct', 'built_up.built_change_pct', 'population.population'],
            method: 'Micro-watershed boundaries (Watershed Atlas of India codes) for Bengaluru, Chennai, Delhi, Hyderabad, Kolkata, Mumbai and Pune on data.opencity.in (public domain). Each block takes the micro-watershed holding its centre (DuckDB spatial); the lens averages the satellite built-over share of its blocks and judges only micro-watersheds at least half inside the view. Classes follow the Impervious Cover Model: up to 10% sensitive, 10 to 25% impacted, 25 to 60% non-supporting, over 60% urban drainage. Built-over ground stands in for impervious cover (it leaves out paved yards and roads outside built-up pixels), so the shares are a floor.',
            refs: 'Schueler (1994) The importance of imperviousness; Center for Watershed Protection (2003) Impacts of Impervious Cover on Aquatic Systems; Watershed Atlas of India (AISLUS/NRSC); OpenCity' },
        { id: 'bdalayout', equity: false, title: 'BDA layouts', icon: '🗺️',
            question: 'Is this land in a BDA-formed layout, and how built-out is each layout?',
            field: { key: 'layout_built_pct', label: 'Ground built over in the block\'s BDA layout', unit: '%', higherIs: 'better', ramp: 'viridis', domain: [0, 60] },
            needs: ['bda_layouts.layout_id', 'built_up.built_pct', 'building_stock.new_buildings', 'population.population'],
            method: 'The Bangalore Development Authority\'s layout boundaries on data.opencity.in (public domain; 149 outlines of 59 layouts). Every block whose centre falls in a layout takes it (DuckDB spatial), lived-in or not, so empty layouts show. Plots in a BDA layout were acquired and allotted by the BDA, so titles run back to the authority, unlike private or revenue layouts. Build-out is the mean built-over share of the layout\'s blocks (satellite built-up layer); filling speed is new buildings since 2016 per km² (building stock layer). Large layouts are those of 1 km² or more.',
            refs: 'Bangalore Development Authority Act 1976; BDA layout boundaries via OpenCity; Revised Master Plan 2015 (BDA)' },
        { id: 'revvillage', equity: false, title: 'Revenue villages (land records)', icon: '📜',
            question: 'Which revenue village and tehsil is this land in, and how many people now live on each old village?',
            field: { key: 'village_people', label: 'Residents on the block\'s revenue village (thousands)', unit: 'thousand', higherIs: 'better', ramp: 'viridis', domain: [0, 300] },
            needs: ['villages.village_id', 'villages.village_km2', 'villages.in_town', 'population.population'],
            method: 'Survey of India village boundaries on data.opencity.in (public domain): Bengaluru Urban (702 villages), Pune district (1,922), Ahmedabad district (559), south Kolkata (70) and Delhi\'s eleven districts (2022). Each lived-in block takes the village whose boundary holds its centre (DuckDB spatial), with its tehsil and district, the names under which land records (RTC, 7/12 extract, khasra, jamabandi) are filed. Where the map draws a town, municipal or cantonment limit instead of villages (old BBMP core and the former city municipalities in Bengaluru, Pune\'s urban core, Kolkata\'s suburbs, the Delhi and Ahmedabad cantonments) the block is marked in a town limit: land there is on the city survey. Delhi\'s maps cover its villages, not the urbanised core. The lens sums residents per village within the city view. Boundaries are the survey\'s, not a title record.',
            refs: 'Survey of India village boundaries via OpenCity; Digital India Land Records Modernisation Programme (DILRMP); Bhoomi (Karnataka), Mahabhumi (Maharashtra), AnyROR (Gujarat), Banglarbhumi (West Bengal), Delhi Bhulekh' },
        { id: 'potholes', equity: false, title: 'Pothole complaints', icon: '🕳️',
            question: 'Where do people report potholes and dug-up roads, and how many got fixed?',
            field: { key: 'pothole_per_km', label: 'Pothole complaints per km of street (May-June 2022)', unit: 'per km', higherIs: 'worse', ramp: 'reds', domain: [0, 20] },
            needs: ['potholes.reports', 'potholes.fixed', 'potholes.road_cuts', 'potholes.pothole_m2', 'potholes.repair_rs', 'potholes.main_road', 'osm_roads.road_km_km2'],
            method: `BBMP's Fix My Street pothole log for May and June 2022 on data.opencity.in (public domain): about 16,500 requests, of which the 13,400 the BBMP did not reject are kept, each with its location, status, work type (pothole or road cutting), road class, measured size and the engineer's repair estimate. Complaints are counted per block and set against the block's street length from OpenStreetMap (at least 0.5 km, so a short lane does not inflate the rate). Fixed means marked work done or resolved by the end of June 2022. Clusters are the blocks with the most unfixed complaints, ${SPACING_KM} km apart. It is a two-month snapshot of what was reported, not a survey of every road.`,
            refs: 'BBMP Fix My Street (Sahaaya) pothole data via OpenCity; IRC:82-2015 Code of Practice for Maintenance of Bituminous Roads' },
        { id: 'pinsize', equity: false, title: 'Pincode crowding', icon: '📮',
            question: 'How many people share each pincode, and where is a pincode too coarse to find an address?',
            field: { key: 'pin_people', label: 'Residents sharing the block\'s pincode (thousands)', unit: 'thousand', higherIs: 'worse', ramp: 'reds', domain: [0, 800] },
            needs: ['pincodes.pincode', 'pincodes.pin_km2', 'population.population'],
            method: `India Post's 2025 all-India pincode boundaries (19,312 pincodes) on data.opencity.in (public domain). Each lived-in block takes the pincode whose boundary holds its centre (DuckDB spatial); the lens sums the block population estimates per pincode within the city view (a pincode reaching past the view is counted only for its part inside) and flags pincodes of more than ${PIN_BIG.toLocaleString('en-IN')} residents. The block's pincode, post office and postal division are in the pincodes layer. Pincode boundaries are India Post's delivery areas, not legal limits.`,
            refs: 'India Post pincode directory and 2025 boundary map; Department of Posts DIGIPIN (2025); OpenCity' },
        { id: 'sroload', equity: false, title: 'Property registration offices', icon: '🏛️',
            question: 'Which sub-registrar office registers property here, and how loaded and far is it?',
            field: { key: 'sro_km', label: 'Distance to the block\'s own sub-registrar office', unit: 'km', higherIs: 'worse', ramp: 'reds', domain: [0, 20] },
            needs: ['registration.sro_id', 'registration.sro_km', 'big_projects.projects', 'population.population'],
            method: `Sub-registrar office (SRO) jurisdictions and office locations on data.opencity.in (public domain): Karnataka Stamps and Registration for Bengaluru Urban (50 jurisdictions, KGIS office points) and Tamil Nadu Registration (697 jurisdictions and 699 offices, TNGIS) for Chennai. Each lived-in block takes the SRO whose jurisdiction holds its centre (DuckDB spatial), and the straight-line distance to that office (matched by name; a match more than 30 km away is dropped as another district's office of the same name). The lens sums residents per office (and SEIAA large projects in Bengaluru) and flags blocks more than ${SRO_FAR_KM} km from their office. The block's SRO and district registrar are in the registration layer; guidance values are set per SRO.`,
            refs: 'Registration Act 1908; Karnataka Stamps and Registration Department (KAVERI); Tamil Nadu Registration Department (TNREGINET); OpenCity' },
        { id: 'basics', equity: true, title: 'Basic services together', icon: '🧰',
            question: 'Where are homes short of several basic services at once?',
            field: { key: 'basics_missing', label: 'Basic networks missing nearby (water line, sewer, storm drain, bin, toilet; mapped ones only)', unit: 'networks', higherIs: 'worse', ramp: 'reds', domain: [0, 4] },
            needs: ['water_lines.pipe_m', 'water_lines.in_area', 'sewers.sewer_m', 'sewers.in_area', 'storm_drains.swd_m', 'storm_drains.nalla_m', 'storm_drains.in_area', 'waste_bins.bins', 'toilets_official.toilets', 'population.population'],
            method: `Crosses the city agencies' own network maps on data.opencity.in (public domain): BWSSB water lines (Bengaluru), sewers (BWSSB, CMWSSB, PMC, HMWSSB core city), storm drains (GCC, PMC), public bins (GCC, GHMC) and public toilets (GCC, PMC, GHMC, BMC). A lived-in block is short of a network when none runs or stands within 250 m (1 km for toilets) on the block grid. Only networks the city has mapped count (at least two), each judged only within ${BASICS_JUDGE_KM} km of its mapped lines, and only inside the corporation where a ward map gives the limit. Picks are blocks short of two or more, ${SPACING_KM} km apart, ranked by networks missing times residents. Maps lag new works, so a pick is a pocket to check, not a verdict.`,
            refs: 'CPHEEO manuals on water supply (1999), sewerage (2013) and storm-water drainage (2019); Swachh Bharat Mission (Urban) 2.0; AMRUT 2.0; agency maps via OpenCity' },
        { id: 'stpnear', equity: false, title: 'Sewage treatment plants nearby', icon: '🏭',
            question: 'Who lives next to a sewage treatment plant, and can the plants treat the city\'s sewage?',
            field: { key: 'stp_near', label: 'Sewage treatment plant within 500 m (2), within 1 km (1), farther (0)', unit: '0-2', higherIs: 'worse', ramp: 'reds', domain: [0, 2] },
            needs: ['stps.stps', 'stps.capacity_mld', 'stps.proposed', 'population.population'],
            method: `Sewage treatment plants on data.opencity.in (public domain): BWSSB's list of 39 plants with coordinates and capacity (Bengaluru, about 1,370 MLD), CMWSSB's plant outlines (Chennai, 8 plants; capacity only for some) and PMC's existing (9, about 470 MLD) and proposed (8) plants (Pune). Lived-in blocks within ${STP_JUDGE_KM} km of a plant are judged on the block grid: within ${STP_NEAR_KM * 1000} m, within 1 km, or farther. Where nearly every plant (85% or more) has a listed capacity, the total is set against the sewage the city's residents make at CPHEEO's 135 litres a head a day with 80% returned as sewage. Picks are plants ${SPACING_KM} km apart with the most residents within ${STP_NEAR_KM * 1000} m.`,
            refs: 'CPHEEO Manual on Sewerage and Sewage Treatment Systems (2013); BWSSB, CMWSSB and PMC via OpenCity' },
        { id: 'watergap', equity: true, title: 'Piped water gaps', icon: '🚰',
            question: 'Which neighbourhoods have no piped water line nearby?',
            field: { key: 'water_cover_pct', label: 'Water line length as a share of street length (0 = none within 250 m)', unit: '%', higherIs: 'better', ramp: 'blues', domain: [0, 100] },
            needs: ['water_lines.pipe_m', 'water_lines.in_area', 'osm_roads.road_km_km2', 'sewers.sewer_m', 'borewells.borewells', 'population.population'],
            method: `BWSSB's detailed water supply line maps on data.opencity.in (public domain): lines of 300 mm or less (about 10,800 km) and mains wider than 300 mm (about 940 km), cut into 25 m pieces and summed per block. A lived-in block inside the corporation's wards and within ${WATER_JUDGE_KM} km of a mapped line has no water line nearby when none runs in it or within ${WATER_NEAR_KM * 1000} m, and is thinly served when its line length is under ${WATER_THIN_PCT}% of its OpenStreetMap street length. It also counts residents with neither a water line nor a sewer within 250 m and public borewells in unpiped blocks. Picks are unpiped blocks ${SPACING_KM} km apart with the most unserved residents within 500 m. Bengaluru only; a line nearby does not mean every home is connected or gets water daily.`,
            refs: 'BWSSB water supply line maps via OpenCity; CPHEEO Manual on Water Supply and Treatment (1999); AMRUT 2.0; BWSSB Cauvery Water Supply Scheme stage V' },
        { id: 'stormgap', equity: true, title: 'Storm-drain gaps on wet streets', icon: '🌧️',
            question: 'Which waterlogging-prone streets have no storm-water drains?',
            field: { key: 'storm_cover_pct', label: 'Storm-drain length as a share of street length', unit: '%', higherIs: 'better', ramp: 'blues', domain: [0, 100] },
            needs: ['storm_drains.swd_m', 'storm_drains.closed_m', 'storm_drains.nalla_m', 'storm_drains.in_area', 'osm_roads.road_km_km2', 'waterlogging.waterlogging_index', 'flood_reports.flood_spots', 'population.population'],
            method: `Storm-water drain maps on data.opencity.in (public domain): GCC's 2023 drain map for Chennai (about 10,300 drains, 2,225 km, mostly covered), the storm drains and nalas in PMC's drainage map for Pune (1,122 km and 404 km). BBMP's maps hold only Bengaluru's major drains, too few to judge streets by. Each drain is cut into 25 m pieces and summed per block and compared with the block's OpenStreetMap street length (capped at 100%). Lived-in blocks inside the corporation's wards and within ${SWD_JUDGE_KM} km of a mapped drain are judged. A block is wet when it is in the wettest quarter of judged blocks on the waterlogging index (radar-seen standing water, hollows, wetness, height above drainage, sealing) or has a reported flood spot within 300 m. Picks are wet blocks with drains along under ${SWD_THIN_PCT}% of the streets, ${SPACING_KM} km apart, ranked by residents, waterlogging and flood spots.`,
            refs: 'CPHEEO Manual on Storm Water Drainage Systems (2019); GCC, PMC and BBMP drain maps via OpenCity; waterlogging and flood_reports datasets' },
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
            needs: ['parks_official.parks', 'parks_official.playgrounds', 'parks_official.open_spaces', 'parks_official.park_m2', 'parks_official.in_area', 'population.population'],
            method: `Parks, playgrounds and layout open spaces from the corporations' maps on data.opencity.in (public domain): GHMC parks (823), playgrounds (488) and open spaces left in approved layouts (1,355), 2018, for Hyderabad; PMC parks and gardens (198 outlines, about 200 ha) for Pune; BMC gardens, parks, play grounds and zoos (950; names with P.G., playground or maidan count as playgrounds) for Mumbai, judged only inside the BMC area. A block is served when a listed park or playground lies within ${PARK_M} m on the block grid (URDPFI's housing-area park); blocks more than ${PARK_JUDGE_KM} km from any listed park are outside the corporation's map and not judged. Hyderabad picks are layout open spaces ${SPACING_KM} km apart with the most unserved residents within ${PARK_M} m; Pune picks are unserved blocks; the cantonments run their own gardens and are not on PMC's list.`,
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

    UrbanLenses.register(ENTRIES, { roadplan, lastrites, wellrisk, binreach, bigprojects, buildlimits, policereach, lakebuffer, parkreach, drainbuffer, birdlife, stormgap, watergap, stpnear, basics, sroload, pinsize, potholes, revvillage, bdalayout, watershedpave, studenthousing, vacant2017, landchange });
    return { ENTRIES };
})();
