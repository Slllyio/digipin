/**
 * Civic lenses for UrbanLenses: what statutory plans and municipal facility lists say about a block (planned road
 * widths and new links, cremation and burial grounds, public borewells, waste bins, large
 * projects with environmental clearance, coastal and eco-sensitive building limits,
 * police stations). They read datasets baked from
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

    const ENTRIES = [
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

    UrbanLenses.register(ENTRIES, { roadplan, lastrites, wellrisk, binreach, bigprojects, buildlimits, policereach });
    return { ENTRIES };
})();
