/**
 * Mobility lenses for UrbanLenses: road noise, traffic load, hospital access at
 * rush hour, metro catchments (with the new-station what-if) and EV charging
 * gaps. Split from js/urban-lenses.js to keep modules small; registers itself
 * on load, so it must load after urban-lenses.js.
 */
const UrbanLensesMobility = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { KM_LAT, DIRS, _fin, _round, _people, _sumOver, _residents, wmean, wquantile, within, frame, allNeeds } = UrbanLenses._kit;

    const ROAD_KM = 0.25, JAM_VC = 0.9;
    const NOISE_WHO = 53, NOISE_HIGH = 65;
    const HOSP_GOLDEN = 10, HOSP_FAR = 20;
    const EV_NEAR_KM = 2, EV_GRID_KM = 3;
    const STATION_WALK = 10, WALK_M_MIN = 80, WALK_DETOUR = 1.3, NEW_STATIONS = 3;
    const STATION_KM = STATION_WALK * WALK_M_MIN / WALK_DETOUR / 1000;   // ~615 m straight line

    function noise(fr) {
        const c = fr.cols, idx = _residents(fr), n = fr.grid.n;
        const ld = c['traffic_noise.lden_db'], nox = c['traffic_noise.nox_kg_day'], co2 = c['traffic_noise.co2_t_day'];
        const pop = c['population.population'];
        if (!ld) return null;
        const lden = new Float64Array(n).fill(NaN), noxN = new Float64Array(n).fill(NaN);
        for (const i of idx) { if (_fin(ld[i])) lden[i] = ld[i]; if (nox && _fin(nox[i])) noxN[i] = nox[i]; }
        const total = _sumOver(pop, idx, () => true) || 1;
        const who = idx.filter(i => ld[i] >= NOISE_WHO), high = idx.filter(i => ld[i] >= NOISE_HIGH);
        const pWho = _sumOver(pop, who, () => true), pHigh = _sumOver(pop, high, () => true);
        const stats = [
            { label: `Residents at or above ${NOISE_WHO} dB Lden (WHO road guideline)`, value: `${_people(pWho)} (${_round(100 * pWho / total)}%)`, raw: Math.round(pWho) },
            { label: `Residents at or above ${NOISE_HIGH} dB Lden`, value: `${_people(pHigh)} (${_round(100 * pHigh / total)}%)`, raw: Math.round(pHigh) },
        ];
        const u5 = c['demographics.under5'], old = c['demographics.elderly_60plus'];
        if (u5 && old) stats.push({ label: `Children under 5 / people 60+ at ${NOISE_HIGH}+ dB`, value: `${_people(_sumOver(u5, high, () => true))} / ${_people(_sumOver(old, high, () => true))}` });
        if (nox) { let t = 0; for (let i = 0; i < n; i++) if (_fin(nox[i])) t += nox[i]; stats.push({ label: 'Traffic NOx emitted on the arterials', value: `${_round(t / 1000, 1)} t/day` }); }
        if (co2) { let t = 0; for (let i = 0; i < n; i++) if (_fin(co2[i])) t += co2[i]; stats.push({ label: 'Traffic CO₂ on the arterials', value: `${_people(t)} t/day` }); }
        let poorShare = null;
        const rwi = c['wealth.rwi'];
        if (rwi && pHigh > 0) {
            const q20 = wquantile(rwi, pop, idx, 0.2);
            if (q20 != null) {
                poorShare = 100 * _sumOver(pop, high, i => rwi[i] <= q20) / pHigh;
                stats.push({ label: `Share of the ${NOISE_HIGH}+ dB residents in the poorest fifth (RWI; 20% if even)`, value: `${_round(poorShare)}%` });
            }
        }
        return {
            columns: { noise_lden: lden, noise_nox: noxN }, idx, weightKey: 'noise_lden',
            metric: { label: `Residents above ${NOISE_WHO} dB`, value: _round(100 * pWho / total), unit: '%', higherIs: 'worse' },
            headline: `${_people(pWho)} people (${_round(100 * pWho / total)}% of residents) live where main-road noise reaches the WHO guideline of ${NOISE_WHO} dB Lden`
                + (pHigh ? `; ${_people(pHigh)} of them at ${NOISE_HIGH} dB or more` : '')
                + (poorShare != null ? `, ${_round(poorShare)}% of those in the poorest fifth.` : '.'),
            stats,
        };
    }

    function traffic(fr) {
        const c = fr.cols, g = fr.grid, idx = _residents(fr), n = g.n;
        const vc = c['traffic_load.peak_vc'], sp = c['traffic_load.peak_speed_kmh'];
        const delay = c['traffic_load.delay_pct'], vkm = c['traffic_load.daily_vkm'];
        const pop = c['population.population'];
        if (!vc) return null;
        const near = new Float64Array(n).fill(NaN), speed = new Float64Array(n).fill(NaN);
        const off = g.offsets(ROAD_KM);
        for (const i of idx) {
            let worst = -1, sSum = 0, sW = 0;
            for (const [a, b] of off) {
                const j = g.cellAt(i, a, b);
                if (j < 0 || !_fin(vc[j])) continue;
                if (vc[j] > worst) worst = vc[j];
                if (sp && _fin(sp[j])) { const w = vkm && vkm[j] > 0 ? vkm[j] : 1; sSum += sp[j] * w; sW += w; }
            }
            if (worst >= 0) near[i] = worst;
            if (sW) speed[i] = sSum / sW;
        }
        const total = _sumOver(pop, idx, () => true) || 1;
        const jam = _sumOver(pop, idx, i => near[i] >= JAM_VC);
        // Same 250 m test per time of day, where the model has the three patterns.
        const byPeriod = {};
        for (const [k, col] of [['morning', 'traffic_load.am_vc'], ['evening', 'traffic_load.pm_vc'], ['midday', 'traffic_load.mid_vc']]) {
            const v = c[col];
            if (!v) continue;
            byPeriod[k] = _sumOver(pop, idx, i => {
                for (const [a, b] of off) { const j = g.cellAt(i, a, b); if (j >= 0 && v[j] >= JAM_VC) return true; }
                return false;
            });
        }
        const nearRoad = _sumOver(pop, idx, i => _fin(near[i]));
        const all = [];
        for (let i = 0; i < n; i++) if (_fin(vc[i])) all.push(i);
        const vSpeed = sp ? wmean(sp, vkm, all) : null, vDelay = delay ? wmean(delay, vkm, all) : null;
        let km = 0;
        if (vkm) for (const i of all) km += vkm[i] > 0 ? vkm[i] : 0;
        const stats = [
            { label: 'Residents within 250 m of an arterial at LOS E/F', value: `${_people(jam)} (${_round(100 * jam / total)}%)`, raw: Math.round(jam) },
            { label: 'Residents within 250 m of any modelled arterial', value: `${_people(nearRoad)} (${_round(100 * nearRoad / total)}%)` },
        ];
        if (vSpeed != null) stats.push({ label: 'Average peak-hour arterial speed (per vehicle-km)', value: `${_round(vSpeed)} km/h` });
        if (vDelay != null) stats.push({ label: 'Peak-hour delay over free flow (per vehicle-km)', value: `+${_round(vDelay)}% (${_round(1 + vDelay / 100, 1)}× the time)` });
        if (km) stats.push({ label: 'Vehicle-km on arterials per day (PCU)', value: `${_people(km)} km` });
        for (const [k, v] of Object.entries(byPeriod)) {
            stats.push({ label: `Residents beside a jammed arterial: ${k} (${{ morning: '09:00', evening: '18:00', midday: '13:00' }[k]})`, value: `${_people(v)} (${_round(100 * v / total)}%)` });
        }
        return {
            columns: { traffic_vc: near, traffic_speed: speed }, idx, weightKey: 'traffic_vc',
            metric: { label: 'Residents beside a jammed arterial', value: _round(100 * jam / total), unit: '%', higherIs: 'worse' },
            headline: `${_people(jam)} people (${_round(100 * jam / total)}% of residents) live within 250 m of an arterial that runs at or over capacity in ${byPeriod.morning != null ? 'the morning or evening peak' : 'the morning peak'}`
                + (vSpeed != null ? `; arterial traffic averages ${_round(vSpeed)} km/h` : '')
                + (vDelay != null ? ` and a peak trip on them takes ${_round(1 + vDelay / 100, 1)}× its free-flow time.` : '.'),
            stats,
        };
    }

    function ambulance(fr) {
        const c = fr.cols, g = fr.grid, idx = _residents(fr), n = g.n;
        const night = c['emergency_access.hospital_min_night'], am = c['emergency_access.hospital_min_am'];
        const pm = c['emergency_access.hospital_min_pm'], pop = c['population.population'];
        if (!night || !am) return null;
        const peak = new Float64Array(n).fill(NaN), delay = new Float64Array(n).fill(NaN);
        const reach = [];
        for (const i of idx) {
            if (!_fin(night[i]) || !_fin(am[i])) continue;
            peak[i] = Math.max(am[i], pm && _fin(pm[i]) ? pm[i] : am[i]);
            delay[i] = Math.max(0, peak[i] - night[i]);
            reach.push(i);
        }
        if (!reach.length) return null;
        const total = _sumOver(pop, reach, () => true) || 1;
        const pNight = _sumOver(pop, reach, i => night[i] <= HOSP_GOLDEN);
        const pPeak = _sumOver(pop, reach, i => peak[i] <= HOSP_GOLDEN);
        const pFar = _sumOver(pop, reach, i => peak[i] > HOSP_FAR);
        const lost = Math.max(0, pNight - pPeak);
        const medPeak = wquantile(peak, pop, reach, 0.5), medNight = wquantile(night, pop, reach, 0.5);
        const stats = [
            { label: `Residents within ${HOSP_GOLDEN} min of a hospital at 03:00`, value: `${_people(pNight)} (${_round(100 * pNight / total)}%)` },
            { label: `… at the worse rush hour (09:00 or 18:00)`, value: `${_people(pPeak)} (${_round(100 * pPeak / total)}%)`, raw: Math.round(pPeak) },
            { label: `Residents more than ${HOSP_FAR} min away at rush hour`, value: `${_people(pFar)} (${_round(100 * pFar / total)}%)`, raw: Math.round(pFar) },
        ];
        if (medPeak != null && medNight != null) stats.push({ label: 'Median drive to hospital: night / rush hour', value: `${_round(medNight, 1)} / ${_round(medPeak, 1)} min` });
        const eld = c['demographics.elderly_60plus'];
        if (eld) stats.push({ label: `People 60+ who lose ${HOSP_GOLDEN}-minute reach at rush hour`, value: _people(_sumOver(eld, reach, i => night[i] <= HOSP_GOLDEN && peak[i] > HOSP_GOLDEN)) });
        // Schools beside jammed or noisy roads (schools are counted per cell, wherever they are).
        const sch = c['emergency_access.schools'], ld = c['traffic_noise.lden_db'], vc = c['traffic_load.peak_vc'];
        if (sch && (ld || vc)) {
            const off = g.offsets(ROAD_KM);
            let all = 0, noisy = 0, jammed = 0, either = 0;
            for (let i = 0; i < n; i++) {
                if (!(sch[i] > 0)) continue;
                all += sch[i];
                const loud = !!ld && _fin(ld[i]) && ld[i] >= NOISE_HIGH;
                let jam = false;
                if (vc) for (const [a, b] of off) { const j = g.cellAt(i, a, b); if (j >= 0 && vc[j] >= JAM_VC) { jam = true; break; } }
                if (loud) noisy += sch[i];
                if (jam) jammed += sch[i];
                if (loud || jam) either += sch[i];
            }
            if (all) {
                stats.push({ label: `Schools at ${NOISE_HIGH}+ dB road noise`, value: `${_people(noisy)} of ${_people(all)} (${_round(100 * noisy / all)}%)` });
                stats.push({ label: `Schools within ${ROAD_KM * 1000} m of a jammed arterial`, value: `${_people(jammed)} (${_round(100 * jammed / all)}%)` });
                stats.push({ label: 'Schools beside a noisy or jammed road', value: `${_people(either)} (${_round(100 * either / all)}%)`, raw: either });
            }
        }
        let poorShare = null;
        const rwi = c['wealth.rwi'];
        if (rwi && pFar > 0) {
            const q20 = wquantile(rwi, pop, reach, 0.2);
            if (q20 != null) {
                poorShare = 100 * _sumOver(pop, reach, i => peak[i] > HOSP_FAR && rwi[i] <= q20) / pFar;
                stats.push({ label: `Share of the ${HOSP_FAR}+ min residents in the poorest fifth (RWI; 20% if even)`, value: `${_round(poorShare)}%` });
            }
        }
        return {
            columns: { hosp_peak: peak, hosp_delay: delay }, idx: reach, weightKey: 'hosp_peak',
            metric: { label: `Within ${HOSP_GOLDEN} min of a hospital at rush hour`, value: _round(100 * pPeak / total), unit: '%', higherIs: 'better' },
            headline: `${_round(100 * pPeak / total)}% of residents can reach a hospital by road within ${HOSP_GOLDEN} minutes at rush hour, against ${_round(100 * pNight / total)}% at 3 am`
                + (lost > 0 ? `: traffic takes ${HOSP_GOLDEN}-minute reach away from ${_people(lost)} people` : '')
                + (pFar > 0 ? `, and ${_people(pFar)} are more than ${HOSP_FAR} minutes away.` : '.'),
            stats,
        };
    }

    /** Residents newly within the station catchment if a station opened at cell i (served: 0/1 per cell). */
    function _stationGain(g, pop, served, i) {
        let s = 0;
        for (const [a, b] of g.offsets(STATION_KM)) {
            const j = g.cellAt(i, a, b);
            if (j >= 0 && !served[j] && pop[j] > 0) s += pop[j];
        }
        return s;
    }

    /** Greedy best sites for new metro stations: [{ rank, code, people, nearestMin }]. */
    function stationSites(fr, k = NEW_STATIONS) {
        const c = fr.cols, g = fr.grid, mw = c['rail_access.metro_walk_min'], pop = c['population.population'];
        if (!mw || !pop) return [];
        const served = new Uint8Array(g.n), idx = _residents(fr);
        for (const i of idx) if (mw[i] <= STATION_WALK) served[i] = 1;
        const out = [];
        for (let r = 0; r < k; r++) {
            let best = -1, bestGain = 0;
            for (const i of idx) {
                if (served[i]) continue;
                const v = _stationGain(g, pop, served, i);
                if (v > bestGain) { bestGain = v; best = i; }
            }
            if (best < 0) break;
            out.push({ rank: r + 1, code: g.codes[best], people: Math.round(bestGain), nearestMin: _fin(mw[best]) ? _round(mw[best], 1) : null });
            for (const [a, b] of g.offsets(STATION_KM)) { const j = g.cellAt(best, a, b); if (j >= 0) served[j] = 1; }
        }
        return out;
    }

    function metro(fr) {
        const c = fr.cols, idx = _residents(fr), n = fr.grid.n;
        const mw = c['rail_access.metro_walk_min'], rw = c['rail_access.rail_walk_min'], pop = c['population.population'];
        if (!mw && !rw) return null;
        const mCol = new Float64Array(n).fill(NaN), rCol = new Float64Array(n).fill(NaN);
        for (const i of idx) { if (mw && _fin(mw[i])) mCol[i] = mw[i]; if (rw && _fin(rw[i])) rCol[i] = rw[i]; }
        const total = _sumOver(pop, idx, () => true) || 1;
        const pM = mw ? _sumOver(pop, idx, i => mw[i] <= STATION_WALK) : 0;
        const pAny = rw ? _sumOver(pop, idx, i => rw[i] <= STATION_WALK) : pM;
        let nM = 0, nR = 0;
        const ms = c['rail_access.metro_stations'], rs = c['rail_access.rail_stations'];
        for (let i = 0; i < n; i++) { if (ms && ms[i] > 0) nM += ms[i]; if (rs && rs[i] > 0) nR += rs[i]; }
        const stats = [];
        if (mw) stats.push({ label: `Residents within a ${STATION_WALK}-minute walk of a metro station`, value: `${_people(pM)} (${_round(100 * pM / total)}%)`, raw: Math.round(pM) });
        stats.push({ label: `… of any metro or suburban rail station`, value: `${_people(pAny)} (${_round(100 * pAny / total)}%)` });
        if (nM || nR) stats.push({ label: 'Stations mapped (metro / rail)', value: `${_people(nM)} / ${_people(nR)}` });
        const med = mw ? wquantile(mCol, pop, idx.filter(i => _fin(mCol[i])), 0.5) : null;
        if (med != null) stats.push({ label: 'Median walk to a metro station', value: `${_round(med)} min` });
        const sites = mw && nM ? stationSites(fr) : [];
        sites.forEach(x => stats.push({ label: `New station site ${x.rank}: ${x.code}`, value: `+${_people(x.people)} residents within ${STATION_WALK} min (now ${x.nearestMin} min from the metro)` }));
        let poorShare = null;
        const rwi = c['wealth.rwi'];
        if (rwi && mw && pM > 0) {
            const q20 = wquantile(rwi, pop, idx, 0.2);
            if (q20 != null) {
                const poor = _sumOver(pop, idx, i => rwi[i] <= q20);
                poorShare = poor ? 100 * _sumOver(pop, idx, i => rwi[i] <= q20 && mw[i] <= STATION_WALK) / poor : null;
                if (poorShare != null) stats.push({ label: 'Poorest fifth within a 10-minute walk of the metro', value: `${_round(poorShare)}% (city: ${_round(100 * pM / total)}%)` });
            }
        }
        const gain = sites.reduce((a, x) => a + x.people, 0);
        return {
            columns: { metro_walk: mCol, station_walk: rCol }, idx, weightKey: 'metro_walk',
            metric: { label: `Within ${STATION_WALK} min walk of the metro`, value: _round(100 * (mw ? pM : pAny) / total), unit: '%', higherIs: 'better' },
            headline: (mw && nM
                ? `${_round(100 * pM / total)}% of residents live within a ${STATION_WALK}-minute walk of a metro station (${_round(100 * pAny / total)}% counting suburban rail)`
                : `${_round(100 * pAny / total)}% of residents live within a ${STATION_WALK}-minute walk of a rail station`)
                + (sites.length ? `; the best ${sites.length} new station sites would bring ${_people(gain)} more people within walking distance.` : '.'),
            stats,
        };
    }

    /** What if a metro station opened at (lat, lng)? Residents newly within the catchment. */
    function stationWhatIf(fr, lat, lng) {
        const g = fr.grid, c = fr.cols, mw = c['rail_access.metro_walk_min'], pop = c['population.population'];
        if (!mw || !pop || !g.n) return null;
        let i0 = -1, d0 = Infinity;
        for (let i = 0; i < g.n; i++) {
            const d = (g.lat[i] - lat) ** 2 + ((g.lng[i] - lng) * Math.cos(lat * Math.PI / 180)) ** 2;
            if (d < d0) { d0 = d; i0 = i; }
        }
        if (i0 < 0 || Math.sqrt(d0) * KM_LAT > 2) return null;
        const served = new Uint8Array(g.n);
        for (let i = 0; i < g.n; i++) if (mw[i] <= STATION_WALK) served[i] = 1;
        const people = _stationGain(g, pop, served, i0);
        const total = _sumOver(pop, _residents(fr), () => true) || 1;
        let already = 0;
        for (const [a, b] of g.offsets(STATION_KM)) { const j = g.cellAt(i0, a, b); if (j >= 0 && served[j] && pop[j] > 0) already += pop[j]; }
        return { code: g.codes[i0], people: Math.round(people), alreadyServed: Math.round(already), nearestMin: _fin(mw[i0]) ? _round(mw[i0], 1) : null,
            sharePts: _round(100 * people / total, 2), walkMin: STATION_WALK };
    }

    async function stationAsk(city, lat, lng, store) {
        const fr = await frame(city, store, allNeeds(['metro']));
        const w = lat != null ? stationWhatIf(fr, lat, lng) : null;
        return { city, at: w, sites: stationSites(fr) };
    }

    function ev(fr) {
        const c = fr.cols, g = fr.grid, idx = _residents(fr), n = g.n;
        const km = c['ev_charging.charger_km'], ch = c['ev_charging.chargers'], pop = c['population.population'];
        if (!km) return null;
        const vk = c['traffic_load.daily_vkm'];
        const vNear = vk ? within(g, vk, 1) : null;
        const kmCol = new Float64Array(n).fill(NaN), gap = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            if (_fin(km[i])) kmCol[i] = km[i];
            if (vNear && _fin(km[i])) gap[i] = km[i] > EV_NEAR_KM ? vNear[i] : 0;
        }
        const total = _sumOver(pop, idx, () => true) || 1;
        const pNear = _sumOver(pop, idx, i => km[i] <= EV_NEAR_KM), pGrid = _sumOver(pop, idx, i => km[i] <= EV_GRID_KM);
        let nCh = 0, vAll = 0, vIn = 0;
        for (let i = 0; i < n; i++) {
            if (ch && ch[i] > 0) nCh += ch[i];
            if (vk && vk[i] > 0) { vAll += vk[i]; if (km[i] <= EV_NEAR_KM) vIn += vk[i]; }
        }
        const stats = [
            { label: 'Known public charging sites', value: `${_people(nCh)} (${_round(1e5 * nCh / total, 2)} per lakh residents)` },
            { label: `Residents within ${EV_NEAR_KM} km of a known charger`, value: `${_people(pNear)} (${_round(100 * pNear / total)}%)`, raw: Math.round(pNear) },
            { label: `Residents within ${EV_GRID_KM} km (the 3 km grid in India's charging guidelines)`, value: `${_people(pGrid)} (${_round(100 * pGrid / total)}%)` },
        ];
        if (vAll) stats.push({ label: `Arterial vehicle-km within ${EV_NEAR_KM} km of a known charger`, value: `${_round(100 * vIn / vAll)}%` });
        const med = wquantile(kmCol, pop, idx.filter(i => _fin(kmCol[i])), 0.5);
        if (med != null) stats.push({ label: 'Median distance from home to a known charger', value: `${_round(med, 1)} km` });
        return {
            columns: { ev_km: kmCol, ev_gap: gap }, idx, weightKey: 'ev_km',
            metric: { label: `Residents within ${EV_GRID_KM} km of a known charger`, value: _round(100 * pGrid / total), unit: '%', higherIs: 'better' },
            headline: `${_people(nCh)} public charging sites are on open maps here; ${_round(100 * pGrid / total)}% of residents live within ${EV_GRID_KM} km of one`
                + (vAll ? ` and ${_round(100 * vIn / vAll)}% of arterial traffic passes within ${EV_NEAR_KM} km.` : '.'),
            stats,
        };
    }

    // ── shaded walks ────────────────────────────────────────────────────────

    const SHADE_KM = 1.6;          // ~20 minutes on foot
    const SHADE_LOW = 10;          // % tree canopy along the route counted as unshaded

    /**
     * One multi-source Dijkstra over the walking network (osm_walk links; all
     * 8 neighbours where a city has none) from every target cell, out to `km`.
     * Returns per cell: dist (km), shade (mean tree canopy % along the route),
     * heat (mean daytime LST along it), pred (next cell towards the target).
     */
    function walkTree(fr, isTarget, km = SHADE_KM) {
        const g = fr.grid, n = g.n, c = fr.cols;
        const links = c['osm_walk.links'], can = c['vegetation.tree_canopy_pct'], lst = c['surface_heat.lst_day_c'];
        const useLinks = !!links && links.some(v => v > 0);
        const step = DIRS.map(([a, b]) => Math.hypot(a * g.dy, b * g.dx));
        const dist = new Float64Array(n).fill(Infinity), sh = new Float64Array(n), ht = new Float64Array(n), htw = new Float64Array(n);
        const pred = new Int32Array(n).fill(-1);
        const cv = (i) => (can && _fin(can[i]) ? can[i] : 0);
        const hv = (i) => (lst && _fin(lst[i]) ? lst[i] : NaN);
        const hd = [], hj = [];
        const push = (d, j) => {
            let k = hd.length; hd.push(d); hj.push(j);
            while (k > 0) { const p = (k - 1) >> 1; if (hd[p] <= d) break; hd[k] = hd[p]; hj[k] = hj[p]; k = p; }
            hd[k] = d; hj[k] = j;
        };
        const pop = () => {
            const d = hd[0], j = hj[0], ld = hd.pop(), lj = hj.pop();
            if (hd.length) {
                let k = 0;
                for (;;) {
                    let ch = 2 * k + 1;
                    if (ch >= hd.length) break;
                    if (ch + 1 < hd.length && hd[ch + 1] < hd[ch]) ch++;
                    if (hd[ch] >= ld) break;
                    hd[k] = hd[ch]; hj[k] = hj[ch]; k = ch;
                }
                hd[k] = ld; hj[k] = lj;
            }
            return [d, j];
        };
        for (let i = 0; i < n; i++) if (isTarget(i)) { dist[i] = 0; push(0, i); }
        while (hd.length) {
            const [d, j] = pop();
            if (d > dist[j]) continue;
            const m = useLinks ? links[j] : 255;
            if (!(m > 0)) continue;
            for (let b = 0; b < 8; b++) {
                if (!((m >> b) & 1)) continue;
                const k = g.cellAt(j, DIRS[b][0], DIRS[b][1]);
                if (k < 0) continue;
                const nd = d + step[b];
                if (nd <= km + 1e-9 && nd < dist[k]) {
                    dist[k] = nd; pred[k] = j;
                    sh[k] = sh[j] + step[b] * (cv(j) + cv(k)) / 2;
                    const h = (hv(j) + hv(k)) / 2;
                    ht[k] = ht[j] + (_fin(h) ? step[b] * h : 0); htw[k] = htw[j] + (_fin(h) ? step[b] : 0);
                    push(nd, k);
                }
            }
        }
        const shade = new Float64Array(n).fill(NaN), heat = new Float64Array(n).fill(NaN);
        for (let i = 0; i < n; i++) {
            if (!_fin(dist[i])) continue;
            shade[i] = dist[i] > 0 ? sh[i] / dist[i] : cv(i);
            heat[i] = htw[i] > 0 ? ht[i] / htw[i] : hv(i);
        }
        return { dist, shade, heat, pred };
    }

    /** Walkers through each cell when every resident walks the tree to its target. */
    function walkerLoad(tree, pop, idx) {
        const n = tree.dist.length, load = new Float64Array(n);
        for (const i of idx) if (_fin(tree.dist[i]) && pop[i] > 0) load[i] += pop[i];
        const order = [];
        for (let i = 0; i < n; i++) if (_fin(tree.dist[i])) order.push(i);
        order.sort((a, b) => tree.dist[b] - tree.dist[a]);
        for (const i of order) if (tree.pred[i] >= 0) load[tree.pred[i]] += load[i];
        return load;
    }

    function shade(fr) {
        const c = fr.cols, g = fr.grid, idx = _residents(fr), pop = c['population.population'];
        if (!c['vegetation.tree_canopy_pct']) return null;
        const ms = c['rail_access.metro_stations'], rs = c['rail_access.rail_stations'], sch = c['emergency_access.schools'];
        if (!ms && !rs && !sch) return null;
        const total = _sumOver(pop, idx, () => true) || 1;
        const can = c['vegetation.tree_canopy_pct'];
        const stats = [], out = {};
        let shadeCol = null, plant = null, headline = '';
        for (const [key, label, isT] of [
            ['station', 'a metro or rail station', (ms || rs) ? (i => (ms && ms[i] > 0) || (rs && rs[i] > 0)) : null],
            ['school', 'a school', sch ? (i => sch[i] > 0) : null]]) {
            if (!isT) continue;
            const t = walkTree(fr, isT);
            const reach = idx.filter(i => _fin(t.dist[i]));
            const pR = _sumOver(pop, reach, () => true);
            if (!pR) continue;
            const pLow = _sumOver(pop, reach, i => t.shade[i] < SHADE_LOW);
            const mean = wmean(t.shade, pop, reach), heat = wmean(t.heat, pop, reach.filter(i => _fin(t.heat[i])));
            out[key] = { pR, pLow, mean };
            stats.push({ label: `Residents within a ${Math.round(SHADE_KM * 12.5)}-minute walk of ${label}`, value: `${_people(pR)} (${_round(100 * pR / total)}%)` });
            stats.push({ label: `… whose walk there has under ${SHADE_LOW}% tree cover`, value: `${_people(pLow)} (${_round(100 * pLow / pR)}%)`, raw: Math.round(pLow) });
            if (mean != null) stats.push({ label: `Average tree cover along the walk to ${label}`, value: `${_round(mean)}%` + (heat != null ? ` (surface ${_round(heat)} °C)` : '') });
            if (key === 'station' || !shadeCol) {
                shadeCol = new Float64Array(g.n).fill(NaN);
                for (const i of reach) shadeCol[i] = t.shade[i];
                const load = walkerLoad(t, pop, reach);
                plant = new Float64Array(g.n).fill(NaN);
                for (let i = 0; i < g.n; i++) if (load[i] > 0) plant[i] = load[i] * (1 - (_fin(can[i]) ? can[i] : 0) / 100);
            }
        }
        if (!shadeCol) return null;
        const order = [];
        for (let i = 0; i < g.n; i++) if (_fin(plant[i]) && plant[i] > 0) order.push(i);
        order.sort((a, b) => plant[b] - plant[a]);
        const picks = [];
        for (const i of order) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 0.75)) continue;
            picks.push(i);
        }
        picks.forEach((i, r) => stats.push({ label: `Plant first ${r + 1}: ${g.codes[i]}`, value: `on the route of ${_people(plant[i] / (1 - (_fin(can[i]) ? can[i] : 0) / 100))} residents, ${_round(_fin(can[i]) ? can[i] : 0)}% canopy` }));
        const st = out.station, sc = out.school, main = st || sc;
        const pct = (o) => _round(100 * o.pLow / o.pR);
        const parts = [];
        if (st) parts.push(`${pct(st)}% of residents within a 20-minute walk of a station get there under less than ${SHADE_LOW}% tree cover`);
        if (sc) parts.push(st ? `${pct(sc)}% on the walk to school` : `${pct(sc)}% of residents near a school walk there under less than ${SHADE_LOW}% tree cover`);
        headline = parts.join('; ') + (picks.length ? '. The busiest unshaded walking cells are listed for planting first.' : '.');
        return {
            columns: { walk_shade: shadeCol, plant_priority: plant }, idx, weightKey: 'walk_shade',
            metric: { label: 'Walk to a station or school under 10% tree cover', value: _round(100 * main.pLow / main.pR), unit: '%', higherIs: 'worse' },
            headline, stats,
        };
    }

    // ── bus gaps on busy corridors ──────────────────────────────────────────

    const BUS_KM = 0.4, BUS_FREQ_HR = 6, CORRIDOR_Q = 0.8;

    function busgap(fr) {
        const c = fr.cols, g = fr.grid, idx = _residents(fr), n = g.n, pop = c['population.population'];
        const pcu = c['traffic_load.peak_pcu'];
        const dep = c['bus_service.peak_departures_hr'], stops = c['osm_transit.stops'], rapid = c['osm_transit.rapid'];
        if (!pcu || (!dep && !stops)) return null;
        const gtfs = !!dep && dep.some(v => v > 0);
        const road = [];
        for (let i = 0; i < n; i++) if (pcu[i] > 0) road.push(i);
        if (road.length < 10) return null;
        const vals = road.map(i => pcu[i]).sort((a, b) => a - b);
        const cut = vals[Math.floor(CORRIDOR_Q * (vals.length - 1))];
        const near = g.offsets(ROAD_KM), bus = g.offsets(BUS_KM), rail = g.offsets(0.8);
        const corr = new Float64Array(n).fill(NaN), busHr = new Float64Array(n).fill(NaN);
        const served = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            let m = 0;
            for (const [a, b] of near) { const j = g.cellAt(i, a, b); if (j >= 0 && pcu[j] > m) m = pcu[j]; }
            if (m < cut) continue;
            corr[i] = m;
            let hr = 0, any = false;
            for (const [a, b] of bus) {
                const j = g.cellAt(i, a, b);
                if (j < 0) continue;
                if (gtfs && dep[j] > 0) hr += dep[j];
                if (stops && stops[j] > 0) any = true;
            }
            let r = false;
            if (rapid) for (const [a, b] of rail) { const j = g.cellAt(i, a, b); if (j >= 0 && rapid[j] > 0) { r = true; break; } }
            busHr[i] = gtfs ? hr : (any ? 1 : 0);
            served[i] = (gtfs ? hr >= BUS_FREQ_HR : any) || r ? 1 : 0;
        }
        const total = _sumOver(pop, idx, () => true) || 1;
        const along = idx.filter(i => _fin(corr[i]));
        const pAlong = _sumOver(pop, along, () => true);
        if (!pAlong) return null;
        const pGap = _sumOver(pop, along, i => !served[i]);
        const gaps = [];
        for (let i = 0; i < n; i++) if (_fin(corr[i]) && !served[i]) gaps.push(i);
        gaps.sort((a, b) => corr[b] - corr[a]);
        const picks = [];
        for (const i of gaps) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1.5)) continue;
            picks.push(i);
        }
        const what = gtfs ? `a bus every ${60 / BUS_FREQ_HR} minutes or better (07–10 h, GTFS)` : 'any mapped bus stop';
        const stats = [
            { label: `Residents beside the busiest fifth of arterials (by peak traffic)`, value: `${_people(pAlong)} (${_round(100 * pAlong / total)}%)` },
            { label: `… with no ${gtfs ? 'frequent bus' : 'bus stop'} within ${BUS_KM * 1000} m and no station within 800 m`, value: `${_people(pGap)} (${_round(100 * pGap / pAlong)}%)`, raw: Math.round(pGap) },
            { label: 'Service test', value: gtfs ? 'Timetable (GTFS) frequency' : 'OpenStreetMap stops (no timetable for this city)' },
        ];
        picks.forEach((i, r) => stats.push({ label: `Corridor gap ${r + 1}: ${g.codes[i]}`, value: `${_people(corr[i])} PCU in the peak hour, ${gtfs ? `${_round(busHr[i])} buses/hour nearby` : 'no stop mapped nearby'}` }));
        return {
            columns: { corridor_pcu: corr, bus_hr: busHr }, idx: along, weightKey: 'corridor_pcu',
            metric: { label: 'Busy-corridor residents without good bus service', value: _round(100 * pGap / pAlong), unit: '%', higherIs: 'worse' },
            headline: `${_round(100 * pGap / pAlong)}% of the ${_people(pAlong)} people living beside the busiest fifth of arterials have no ${gtfs ? 'frequent bus' : 'bus stop'} within ${BUS_KM * 1000} m or station within 800 m`
                + (picks.length ? `; the heaviest unserved corridor carries ${_people(corr[picks[0]])} vehicles (PCU) in the peak hour.` : '.'),
            stats,
        };
    }

    const ENTRIES = [
        { id: 'busgap', equity: true, title: 'Bus gaps on busy roads', icon: '🚌',
            question: 'Which busy commute corridors have no frequent bus?',
            field: { key: 'corridor_pcu', label: 'Peak-hour traffic on the nearest busy arterial', unit: 'PCU/h', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'bus_hr', label: 'Buses per hour within 400 m (07–10 h)', unit: 'per hour', higherIs: 'better', ramp: 'viridis' }],
            needs: ['traffic_load.peak_pcu', 'bus_service.peak_departures_hr', 'osm_transit.stops', 'osm_transit.rapid', 'wealth.rwi'],
            method: `Busy corridors are arterials in the top fifth of modelled peak-hour traffic (demand model PCU); a home within ${ROAD_KM * 1000} m of one counts as beside it. Served means a bus every ${60 / BUS_FREQ_HR} minutes or better within ${BUS_KM * 1000} m in the 07–10 h timetable (cities with open GTFS, currently Bengaluru), or any mapped bus stop within ${BUS_KM * 1000} m elsewhere, or a rail/metro/BRT station within 800 m. Gaps are where car traffic is heavy and buses are not: candidates for new or more frequent routes.`,
            refs: 'Demand model (pipeline/traffic/demand_model.py); GTFS (BMTC, Vonter); MoHUA 2017 Metro Rail Policy (feeder bus within 500 m); ITDP BRT Standard' },
        { id: 'shade', equity: true, title: 'Shaded walks', icon: '🌳',
            question: 'How much tree shade is there on the walk to the station and to school?',
            field: { key: 'walk_shade', label: 'Tree cover along the walk to the nearest station', unit: '%', higherIs: 'better', ramp: 'greens' },
            extra: [{ key: 'plant_priority', label: 'Walkers × missing canopy (plant here first)', unit: 'people', higherIs: 'worse', ramp: 'reds' }],
            needs: ['osm_walk.links', 'vegetation.tree_canopy_pct', 'surface_heat.lst_day_c', 'rail_access.metro_stations', 'rail_access.rail_stations', 'emergency_access.schools', 'wealth.rwi'],
            method: `A walking tree from every station (and every school) over the OpenStreetMap walking network (8-direction cell links), out to ${SHADE_KM} km (about 20 minutes). Each home takes the route to its nearest target; shade is the mean tree canopy of the cells the route crosses (Meta/WRI 1 m canopy height), heat the mean daytime land surface temperature. Walker load routes every resident down the tree; planting priority is that load × the share of the cell without canopy.`,
            refs: 'Tran et al. 2024 (1 m canopy height); Deilami et al. 2018 (urban heat and shade); WHO 2016 (urban green spaces and health)' },
        { id: 'noise', equity: true, title: 'Road noise', icon: '🔊',
            question: 'Who lives with main-road noise above the WHO guideline?',
            field: { key: 'noise_lden', label: 'Road noise at home (Lden)', unit: 'dB(A)', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'noise_nox', label: 'Traffic NOx emitted nearby', unit: 'kg/day', higherIs: 'worse', ramp: 'heat' }],
            needs: ['traffic_noise.lden_db', 'traffic_noise.nox_kg_day', 'traffic_noise.co2_t_day', 'demographics.under5', 'demographics.elderly_60plus', 'wealth.rwi'],
            method: `Road noise at each home cell from the traffic model's daily volumes on the arterials, by the UK CRTN method (every modelled road within 300 m, energy-summed, converted to Lden). The WHO 2018 guideline for road traffic is ${NOISE_WHO} dB Lden; ${NOISE_HIGH} dB is a high exposure. No barriers, building shielding or local streets, so it describes the road-facing side. Exhaust uses fleet-average emission factors per vehicle-km; modelled NOx tracks Sentinel-5P NO₂ across each city (rank correlation in data/traffic/<city>/summary.json).`,
            refs: 'DoT 1988 (CRTN); Abbott & Nelson 2002 (CRTN to Lden); WHO 2018 Environmental Noise Guidelines' },
        { id: 'traffic', equity: true, title: 'Traffic load', icon: '🚦',
            question: 'Who lives next to roads that jam in the morning peak?',
            field: { key: 'traffic_vc', label: 'Worst peak-hour V/C within 250 m', unit: 'ratio', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'traffic_speed', label: 'Peak-hour arterial speed nearby', unit: 'km/h', higherIs: 'better', ramp: 'heat' }],
            needs: ['traffic_load.peak_vc', 'traffic_load.peak_speed_kmh', 'traffic_load.delay_pct', 'traffic_load.daily_vkm',
                'traffic_load.am_vc', 'traffic_load.pm_vc', 'traffic_load.mid_vc'],
            method: `Peak hours from the demand model (pipeline/traffic/demand_model.py): residents make motorised trips to jobs and activity floor space, distributed by a gravity model and routed on the OpenStreetMap arterials with BPR congestion feedback; the 09:00 commute, the 18:00 trip home and midday errands are assigned separately and the worse peak counts. For each home cell, the worst volume/capacity ratio on any arterial within ${ROAD_KM * 1000} m (its own or a neighbouring cell); at or above ${JAM_VC} is Level of Service E/F (at or over capacity). Speeds and delay are vehicle-km weighted. A strategic model with stated assumptions, not traffic counts.`,
            refs: 'Ortúzar & Willumsen, Modelling Transport (4-step model); BPR (1964) link performance; IRC 106-1990 urban road capacities; HCM LOS' },
        { id: 'ambulance', equity: true, title: 'Hospital at rush hour', icon: '🚑',
            question: 'How far is a hospital by road at 9 am, compared with 3 am?',
            field: { key: 'hosp_peak', label: 'Drive to nearest hospital, worse peak', unit: 'min', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'hosp_delay', label: 'Extra minutes at rush hour', unit: 'min', higherIs: 'worse', ramp: 'reds' }],
            needs: ['emergency_access.hospital_min_night', 'emergency_access.hospital_min_am', 'emergency_access.hospital_min_pm',
                'emergency_access.rush_delay_min', 'emergency_access.schools', 'traffic_noise.lden_db', 'traffic_load.peak_vc',
                'demographics.elderly_60plus', 'wealth.rwi'],
            method: `Drive time from each home cell to the nearest hospital on the OpenStreetMap arterials: at 03:00 with free-flow speeds, and at 09:00 and 18:00 with each road slowed by the demand model's volume/capacity (BPR, at most 4× free-flow time), plus the walk-speed access to and from the road. Hospitals and schools are Overture Maps places (confidence ≥ 0.6); places tagged hospital include smaller nursing homes, and there is no bed, ward or ambulance-siren priority data, so treat it as general-traffic reach. ${HOSP_GOLDEN} minutes is the reporting threshold. Schools count as exposed when their cell is at ${NOISE_HIGH}+ dB Lden or within ${ROAD_KM * 1000} m of an arterial at LOS E/F.`,
            refs: 'Overture Maps Foundation places; BPR (1964); Wilde 2013 (ambulance response time and outcomes); WHO 2018 noise guidelines' },
        { id: 'metro', equity: true, title: 'Metro catchments', icon: '🚇',
            question: 'Who lives within a 10-minute walk of a metro station, and where would a new one help most?',
            field: { key: 'metro_walk', label: 'Walk to the nearest metro station', unit: 'min', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'station_walk', label: 'Walk to any metro or rail station', unit: 'min', higherIs: 'worse', ramp: 'heat' }],
            needs: ['rail_access.metro_walk_min', 'rail_access.rail_walk_min', 'rail_access.metro_stations', 'rail_access.rail_stations', 'wealth.rwi'],
            method: `Walking time from each home cell to the nearest station: straight line × ${WALK_DETOUR} detour at ${WALK_M_MIN * 60 / 1000} km/h; ${STATION_WALK} minutes (about ${Math.round(STATION_KM * 1000)} m as the crow flies) is the catchment. Stations are Overture Maps and OpenStreetMap station points, classed metro when the nearest Overture rail track is subway, light rail or monorail and rail when it is standard or narrow gauge. New-station sites are picked greedily: each is the cell whose ${STATION_WALK}-minute catchment adds the most residents not already served, ignoring track alignment and cost.`,
            refs: 'Overture Maps Foundation places & transportation; Guerra, Cervero & Tischler 2012 (transit catchments in practice); UN SDG 11.2.1' },
        { id: 'ev', equity: false, title: 'EV charging gaps', icon: '🔌',
            question: 'How far are homes and traffic from a known public EV charger?',
            field: { key: 'ev_km', label: 'Distance to the nearest known charger', unit: 'km', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'ev_gap', label: 'Vehicle-km within 1 km with no charger in 2 km', unit: 'veh-km/day', higherIs: 'worse', ramp: 'reds' }],
            needs: ['ev_charging.charger_km', 'ev_charging.chargers', 'ev_charging.parking', 'ev_charging.fuel', 'traffic_load.daily_vkm'],
            method: `Known public chargers are OpenStreetMap, Overture Maps and (when keyed) Open Charge Map points; open data lists only part of India's network, so distances are upper bounds and counts lower bounds. The gap layer is daily vehicle-km from the demand model within 1 km of each cell, where the nearest known charger is more than ${EV_NEAR_KM} km away. Use the EV siting preset for ranked sites.`,
            refs: 'Overture Maps Foundation places; OpenStreetMap amenity=charging_station; Open Charge Map; MoP 2024 guidelines for EV charging infrastructure (a charger every 3 km in cities)' },
    ];

    UrbanLenses.register(ENTRIES, { noise, traffic, ambulance, metro, ev, shade, busgap }, { stationSites, stationWhatIf, stationAsk, walkTree, walkerLoad });
    return { ENTRIES, stationSites, stationWhatIf, stationAsk };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesMobility = UrbanLensesMobility;
}
