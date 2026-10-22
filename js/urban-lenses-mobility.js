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
     * ``weight(j, k)`` (default 1) multiplies each step's cost, so routes can
     * avoid something; ``dist`` stays the length walked and ``km`` caps it.
     */
    function walkTree(fr, isTarget, km = SHADE_KM, weight = null) {
        const g = fr.grid, n = g.n, c = fr.cols;
        const links = c['osm_walk.links'], can = c['vegetation.tree_canopy_pct'], lst = c['surface_heat.lst_day_c'];
        const useLinks = !!links && links.some(v => v > 0);
        const step = DIRS.map(([a, b]) => Math.hypot(a * g.dy, b * g.dx));
        const dist = new Float64Array(n).fill(Infinity), sh = new Float64Array(n), ht = new Float64Array(n), htw = new Float64Array(n);
        const pred = new Int32Array(n).fill(-1), cost = weight ? new Float64Array(n).fill(Infinity) : dist;
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
        for (let i = 0; i < n; i++) if (isTarget(i)) { dist[i] = 0; cost[i] = 0; push(0, i); }
        while (hd.length) {
            const [d, j] = pop();
            if (d > cost[j]) continue;
            const m = useLinks ? links[j] : 255;
            if (!(m > 0)) continue;
            for (let b = 0; b < 8; b++) {
                if (!((m >> b) & 1)) continue;
                const k = g.cellAt(j, DIRS[b][0], DIRS[b][1]);
                if (k < 0) continue;
                const nl = dist[j] + step[b], nd = weight ? d + step[b] * weight(j, k) : nl;
                if (nl <= km + 1e-9 && nd < cost[k]) {
                    cost[k] = nd; dist[k] = nl; pred[k] = j;
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

    // ── road danger on the walk to school ───────────────────────────────────

    const FAST_KMH = 40, BUSY_PCU = 600, SAFE_KMH = 30;

    /** Pedestrian fatality risk when hit at `v` km/h (Rosén & Sander 2009 logistic). */
    function fatalRisk(v) { return 1 / (1 + Math.exp(6.9 - 0.090 * v)); }

    /**
     * Max of `haz` along each cell's route down a walk tree (the cell itself
     * included), pure given the tree.
     */
    function routeMax(tree, haz) {
        const n = tree.dist.length, out = new Float64Array(n).fill(NaN), order = [];
        for (let i = 0; i < n; i++) if (_fin(tree.dist[i])) order.push(i);
        order.sort((a, b) => tree.dist[a] - tree.dist[b]);
        for (const i of order) {
            const p = tree.pred[i], h = _fin(haz[i]) ? haz[i] : 0;
            out[i] = p >= 0 && _fin(out[p]) ? Math.max(out[p], h) : h;
        }
        return out;
    }

    function roadsafety(fr) {
        const c = fr.cols, g = fr.grid, n = g.n, idx = _residents(fr), pop = c['population.population'];
        const pcu = c['traffic_load.peak_pcu'], spd = c['traffic_load.peak_speed_kmh'], dly = c['traffic_load.delay_pct'];
        const sch = c['emergency_access.schools'], hos = c['emergency_access.hospitals'];
        if (!pcu || !spd || !sch || !sch.some(v => v > 0)) return null;
        // Free-flow speed from the peak speed and its delay: the speed traffic reaches off-peak and after school.
        const ffs = new Float64Array(n).fill(NaN), haz = new Float64Array(n).fill(NaN), danger = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            if (!(pcu[i] > 0) || !_fin(spd[i])) continue;
            ffs[i] = Math.min(80, spd[i] * (1 + (dly && _fin(dly[i]) ? dly[i] : 0) / 100));
            haz[i] = fatalRisk(ffs[i]);
            if (ffs[i] >= FAST_KMH && pcu[i] >= BUSY_PCU) danger[i] = 1;
        }
        const near = g.offsets(ROAD_KM);
        const beside = (i) => { for (const [a, b] of near) { const j = g.cellAt(i, a, b); if (j >= 0 && danger[j]) return true; } return false; };
        const stats = [];
        for (const [col, label] of [[sch, 'Schools'], [hos, 'Hospitals']]) {
            if (!col) continue;
            let all = 0, hit = 0;
            for (let i = 0; i < n; i++) if (col[i] > 0) { all += col[i]; if (beside(i)) hit += col[i]; }
            if (all) stats.push({ label: `${label} within ${ROAD_KM * 1000} m of a fast, busy arterial`, value: `${_people(hit)} of ${_people(all)} (${_round(100 * hit / all)}%)`, raw: hit });
        }
        // Children walk the network to the nearest school; a route that crosses a danger cell counts.
        const tree = walkTree(fr, i => sch[i] > 0);
        const kpct = c['demographics.children_pct'];
        const kids = new Float64Array(n);
        for (const i of idx) kids[i] = (pop[i] || 0) * (kpct && _fin(kpct[i]) ? kpct[i] / 100 : 0.25);
        const reach = idx.filter(i => _fin(tree.dist[i]));
        const kAll = _sumOver(kids, reach, () => true);
        if (!kAll) return null;
        const flag = new Float64Array(n);
        for (let i = 0; i < n; i++) flag[i] = danger[i];
        const crosses = routeMax(tree, flag), worst = routeMax(tree, haz);
        const kHit = _sumOver(kids, reach, i => crosses[i] > 0);
        const route = new Float64Array(n).fill(NaN);
        for (const i of reach) route[i] = _round(100 * worst[i], 1);
        const load = walkerLoad(tree, kids, reach);
        const prio = new Float64Array(n).fill(NaN), order = [];
        for (let i = 0; i < n; i++) if (danger[i] && load[i] > 0) { prio[i] = load[i] * haz[i]; order.push(i); }
        order.sort((a, b) => prio[b] - prio[a]);
        const picks = [];
        for (const i of order) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 0.75)) continue;
            picks.push(i);
        }
        const pct = _round(100 * kHit / kAll);
        stats.unshift({ label: `Children within a ${Math.round(SHADE_KM * 12.5)}-minute walk of a school`, value: _people(kAll) },
            { label: `… whose walk crosses or follows a road at ${FAST_KMH}+ km/h and ${BUSY_PCU}+ PCU/h`, value: `${_people(kHit)} (${pct}%)`, raw: Math.round(kHit) });
        stats.push({ label: `Fatality risk if hit at ${SAFE_KMH} / ${FAST_KMH} / 60 km/h`, value: `${_round(100 * fatalRisk(SAFE_KMH), 1)}% / ${_round(100 * fatalRisk(FAST_KMH), 1)}% / ${_round(100 * fatalRisk(60))}%` });
        picks.forEach((i, r) => stats.push({ label: `Safe crossing ${r + 1}: ${g.codes[i]}`, value: `${_people(load[i])} children walk through, road ${_round(ffs[i])} km/h free-flow, ${_people(pcu[i])} PCU/h at peak` }));
        return {
            columns: { walk_risk: route, crossing_priority: prio }, idx: reach, weightKey: 'walk_risk',
            metric: { label: 'Children whose walk to school crosses a fast, busy road', value: pct, unit: '%', higherIs: 'worse' },
            headline: `${pct}% of children within walking distance of a school (${_people(kHit)}) have to cross or walk along an arterial that runs at ${FAST_KMH}+ km/h with ${BUSY_PCU}+ vehicles an hour at peak`
                + (picks.length ? `; the busiest such crossing carries ${_people(load[picks[0]])} children's walks, a first candidate for a signalised crossing and a ${SAFE_KMH} km/h school zone.` : '.'),
            stats,
        };
    }

    // ── low-stress cycling ──────────────────────────────────────────────────

    const BIKE_KM = 2.5, SMALL_ISLAND_KM2 = 1, AREA_CAP = 10;   // ~3 km ride (×1.3) ≈ 12 minutes at 15 km/h

    function cycling(fr) {
        const c = fr.cols, g = fr.grid, n = g.n, idx = _residents(fr), pop = c['population.population'];
        const isl = c['cycling.island'], area = c['cycling.island_km2'], gain = c['cycling.crossing_gain'];
        if (!isl || !area) return null;
        const sch = c['emergency_access.schools'], ms = c['rail_access.metro_stations'], rs = c['rail_access.rail_stations'];
        const kpct = c['demographics.children_pct'];
        const within = (i, list) => {
            for (const j of list) if (Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) <= BIKE_KM) return true;
            return false;
        };
        const byIsland = (test) => {
            const m = new Map();
            for (let i = 0; i < n; i++) if (_fin(isl[i]) && test(i)) { let l = m.get(isl[i]); if (!l) m.set(isl[i], (l = [])); l.push(i); }
            return m;
        };
        const total = _sumOver(pop, idx, () => true) || 1;
        const stats = [];
        const small = _sumOver(pop, idx, i => !_fin(area[i]) || area[i] < SMALL_ISLAND_KM2);
        stats.push({ label: `Residents who can ride less than ${SMALL_ISLAND_KM2} km² before meeting a main road`, value: `${_people(small)} (${_round(100 * small / total)}%)`, raw: Math.round(small) });
        const med = wquantile(area, pop, idx.filter(i => _fin(area[i])), 0.5);
        if (med != null) stats.push({ label: 'Median low-stress area per resident', value: `${_round(med, 1)} km²` });
        let metric = null, headline = '';
        const reach = new Float64Array(n).fill(NaN);
        if (sch && sch.some(v => v > 0)) {
            const S = byIsland(i => sch[i] > 0);
            let kAll = 0, kOk = 0;
            for (const i of idx) {
                const k = (pop[i] || 0) * (kpct && _fin(kpct[i]) ? kpct[i] / 100 : 0.25);
                kAll += k;
                const ok = _fin(isl[i]) && S.has(isl[i]) && within(i, S.get(isl[i]));
                reach[i] = ok ? 1 : 0;
                if (ok) kOk += k;
            }
            if (kAll) {
                metric = { label: 'Children who can cycle to school without crossing a main road', value: _round(100 * kOk / kAll), unit: '%', higherIs: 'better' };
                stats.unshift({ label: `Children with a school within ${BIKE_KM} km on low-stress streets only`, value: `${_people(kOk)} (${_round(100 * kOk / kAll)}%)`, raw: Math.round(kOk) });
                headline = `${_round(100 * kOk / kAll)}% of children have a school within about ${Math.round(BIKE_KM * 1.3)} km that they can cycle to on quiet streets without crossing a main road`;
            }
        }
        if ((ms && ms.some(v => v > 0)) || (rs && rs.some(v => v > 0))) {
            const T = byIsland(i => (ms && ms[i] > 0) || (rs && rs[i] > 0));
            const ok = _sumOver(pop, idx, i => _fin(isl[i]) && T.has(isl[i]) && within(i, T.get(isl[i])));
            stats.push({ label: `Residents who can cycle to a metro or rail station on low-stress streets (≤ ${BIKE_KM} km)`, value: `${_people(ok)} (${_round(100 * ok / total)}%)` });
            if (!headline) headline = `${_round(100 * ok / total)}% of residents can cycle to a station on quiet streets without crossing a main road`;
        }
        const cyc = c['cycling.cycleway_km'];
        if (cyc) {
            let km = 0;
            for (let i = 0; i < n; i++) if (cyc[i] > 0) km += cyc[i];
            stats.push({ label: 'Mapped cycle tracks', value: `${_round(km)} km (${_round(km / (total / 1e5), 2)} km per lakh residents)` });
        }
        const picks = [];
        if (gain) {
            const order = [];
            for (let i = 0; i < n; i++) if (gain[i] > 0) order.push(i);
            order.sort((a, b) => gain[b] - gain[a]);
            for (const i of order) {
                if (picks.length >= 5) break;
                if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1)) continue;
                picks.push(i);
            }
            picks.forEach((i, r) => stats.push({ label: `Safe cycle crossing ${r + 1}: ${g.codes[i]}`, value: `joins ${_people(gain[i])} residents to a bigger quiet-street network` }));
        }
        headline = (headline ? `${headline}; ` : '') + `${_round(100 * small / total)}% of residents live where main roads box them into less than ${SMALL_ISLAND_KM2} km² of quiet streets`
            + (picks.length ? `, and one safe crossing at ${g.codes[picks[0]]} would join ${_people(gain[picks[0]])} people to a bigger network.` : '.');
        const areaCol = new Float64Array(n).fill(NaN);
        for (const i of idx) if (_fin(area[i])) areaCol[i] = Math.min(AREA_CAP, area[i]);   // one city-wide island would wash out the ramp
        return {
            columns: { cycle_area: areaCol, cycle_school: reach, cycle_crossing: gain ? Float64Array.from(gain, v => (v > 0 ? v : NaN)) : new Float64Array(n).fill(NaN) },
            idx, weightKey: 'cycle_area',
            metric: metric || { label: `Residents boxed into under ${SMALL_ISLAND_KM2} km² of quiet streets`, value: _round(100 * small / total), unit: '%', higherIs: 'worse' },
            headline, stats,
        };
    }

    // ── night walk to the station ───────────────────────────────────────────

    const DARK_RAD = 20, LONELY_DENS = 2000;   // VIIRS nW/cm²/sr; residents/km² with no shop or eatery

    function nightwalk(fr) {
        const c = fr.cols, g = fr.grid, n = g.n, idx = _residents(fr), pop = c['population.population'];
        const rad = c['nightlights.radiance'], ms = c['rail_access.metro_stations'], rs = c['rail_access.rail_stations'];
        if (!rad || (!ms && !rs)) return null;
        const isT = i => (ms && ms[i] > 0) || (rs && rs[i] > 0);
        let any = false;
        for (let i = 0; i < n && !any; i++) any = isT(i);
        if (!any) return null;
        const food = c['osm_amenities.food'], shop = c['osm_amenities.shopping'], dens = c['population.density_km2'];
        const dark = new Float64Array(n), lonely = new Float64Array(n), bad = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            dark[i] = _fin(rad[i]) && rad[i] < DARK_RAD ? 1 : 0;
            const quiet = (food || shop) && !((food && food[i] > 0) || (shop && shop[i] > 0));
            const sparse = dens ? !(dens[i] >= LONELY_DENS) : !(pop[i] > 0);
            lonely[i] = quiet && sparse ? 1 : 0;
            bad[i] = dark[i] || lonely[i] ? 1 : 0;
        }
        const tree = walkTree(fr, isT);
        const reach = idx.filter(i => _fin(tree.dist[i]));
        const pR = _sumOver(pop, reach, () => true);
        if (!pR) return null;
        const dRoute = routeMax(tree, dark), lRoute = routeMax(tree, lonely), bRoute = routeMax(tree, bad);
        const dimmest = routeMax(tree, Float64Array.from(rad, v => (_fin(v) ? -v : 0)));
        const pDark = _sumOver(pop, reach, i => dRoute[i] > 0), pLonely = _sumOver(pop, reach, i => lRoute[i] > 0);
        const pBad = _sumOver(pop, reach, i => bRoute[i] > 0);
        const wpct = c['demographics.women_pct'];
        const women = wpct ? _sumOver(pop.map((p, i) => p * (_fin(wpct[i]) ? wpct[i] / 100 : 0.48)), reach, i => bRoute[i] > 0) : null;
        const route = new Float64Array(n).fill(NaN);
        for (const i of reach) route[i] = _round(-dimmest[i], 1);
        const load = walkerLoad(tree, pop, reach);
        const prio = new Float64Array(n).fill(NaN), order = [];
        for (let i = 0; i < n; i++) if (dark[i] && load[i] > 0) { prio[i] = load[i]; order.push(i); }
        order.sort((a, b) => prio[b] - prio[a]);
        const picks = [];
        for (const i of order) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 0.75)) continue;
            picks.push(i);
        }
        const pct = (v) => _round(100 * v / pR);
        const stats = [
            { label: `Residents within a ${Math.round(SHADE_KM * 12.5)}-minute walk of a metro or rail station`, value: _people(pR) },
            { label: `… whose walk passes a dark stretch (VIIRS < ${DARK_RAD} nW/cm²/sr)`, value: `${_people(pDark)} (${pct(pDark)}%)`, raw: Math.round(pDark) },
            { label: '… whose walk passes a deserted stretch (no shop or eatery, few residents)', value: `${_people(pLonely)} (${pct(pLonely)}%)` },
            { label: '… dark or deserted, either', value: `${_people(pBad)} (${pct(pBad)}%)` },
        ];
        if (women != null) stats.push({ label: 'Women among them (WorldPop share)', value: _people(women) });
        const pol = c['mobility.nearest_police_km'];
        if (pol) { const m = wquantile(pol, pop, reach.filter(i => _fin(pol[i])), 0.5); if (m != null) stats.push({ label: 'Median distance from home to a police station', value: `${_round(m, 1)} km` }); }
        picks.forEach((i, r) => stats.push({ label: `Light first ${r + 1}: ${g.codes[i]}`, value: `on the walk of ${_people(load[i])} residents, ${_round(rad[i], 1)} nW/cm²/sr` }));
        return {
            columns: { night_route: route, light_priority: prio }, idx: reach, weightKey: 'night_route',
            metric: { label: 'Walk to the station passes a dark or deserted stretch', value: pct(pBad), unit: '%', higherIs: 'worse' },
            headline: `${pct(pBad)}% of residents within walking distance of a station (${_people(pBad)}) pass a dark or deserted stretch on the way: ${pct(pDark)}% a dark one, ${pct(pLonely)}% one with no shops or eateries`
                + (picks.length ? `. Lighting the busiest dark cell, ${g.codes[picks[0]]}, covers the walk of ${_people(load[picks[0]])} people.` : '.'),
            stats,
        };
    }

    // ── pedestrian crossing gaps ────────────────────────────────────────────

    const GAP_M = 500;

    function crossing(fr) {
        const c = fr.cols, g = fr.grid, n = g.n, idx = _residents(fr), pop = c['population.population'];
        const gap = c['crossings.max_gap_m'], gkm = c['crossings.gap_km'], mkm = c['crossings.main_km'], cw = c['crossings.crosswalks'];
        if (!gap || !gap.some(v => v > 0)) return null;
        const pcu = c['traffic_load.peak_pcu'];
        const near = g.offsets(ROAD_KM);
        const facing = new Float64Array(n).fill(NaN);      // worst gap on a main road within 250 m of home
        for (const i of idx) {
            let m = -1;
            for (const [a, b] of near) { const j = g.cellAt(i, a, b); if (j >= 0 && gap[j] > m) m = gap[j]; }
            if (m >= 0) facing[i] = Math.min(4 * GAP_M, m);   // a few km-long flyover runs would wash out the ramp
        }
        const beside = idx.filter(i => _fin(facing[i]));
        const pB = _sumOver(pop, beside, () => true);
        if (!pB) return null;
        const total = _sumOver(pop, idx, () => true) || 1;
        const pGap = _sumOver(pop, beside, i => facing[i] > GAP_M);
        const pFar = _sumOver(pop, beside, i => facing[i] > 2 * GAP_M);
        // Need: residents within 250 m of each long-gap road cell, more where traffic is heavy.
        const need = new Float64Array(n).fill(NaN), order = [];
        for (let i = 0; i < n; i++) {
            if (!(gap[i] > GAP_M)) continue;
            let people = 0;
            for (const [a, b] of near) { const j = g.cellAt(i, a, b); if (j >= 0 && pop[j] > 0) people += pop[j]; }
            if (!people) continue;
            need[i] = people * Math.min(3, gap[i] / GAP_M) * (pcu && pcu[i] > 0 ? Math.min(2, 0.5 + pcu[i] / 2000) : 1);
            order.push(i);
        }
        order.sort((a, b) => need[b] - need[a]);
        const picks = [];
        for (const i of order) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1)) continue;
            picks.push(i);
        }
        let main = 0, long = 0, cws = 0;
        for (let i = 0; i < n; i++) { if (mkm && mkm[i] > 0) main += mkm[i]; if (gkm && gkm[i] > 0) long += gkm[i]; if (cw && cw[i] > 0) cws += cw[i]; }
        const med = wquantile(facing, pop, beside, 0.5);
        const stats = [
            { label: `Residents within ${ROAD_KM * 1000} m of a main road`, value: `${_people(pB)} (${_round(100 * pB / total)}%)` },
            { label: `… beside a stretch with no crossing for ${GAP_M}+ m`, value: `${_people(pGap)} (${_round(100 * pGap / pB)}%)`, raw: Math.round(pGap) },
            { label: `… for ${(2 * GAP_M) / 1000}+ km`, value: `${_people(pFar)} (${_round(100 * pFar / pB)}%)` },
        ];
        if (med != null) stats.push({ label: 'Median longest crossing gap near home', value: `${_people(med)} m` });
        if (main) stats.push({ label: `Main-road length on gaps over ${GAP_M} m`, value: `${_round(long)} of ${_round(main)} km (${_round(100 * long / main)}%)` });
        stats.push({ label: 'Mapped zebra crossings', value: `${_people(cws)}${cws < main / 5 ? ' (sparse in open maps, so junctions count as crossings)' : ''}` });
        picks.forEach((i, r) => stats.push({ label: `Add a crossing ${r + 1}: ${g.codes[i]}`, value: `${_people(gap[i])} m without one${pcu && pcu[i] > 0 ? `, ${_people(pcu[i])} PCU/h at peak` : ''}` }));
        return {
            columns: { cross_gap: facing, cross_need: need }, idx: beside, weightKey: 'cross_gap',
            metric: { label: `Main-road residents facing a ${GAP_M}+ m crossing gap`, value: _round(100 * pGap / pB), unit: '%', higherIs: 'worse' },
            headline: `${_round(100 * pGap / pB)}% of the ${_people(pB)} people living beside a main road face a stretch of ${GAP_M} m or more with no junction or crossing, a walk of up to ${(2 * GAP_M) / 1000} km round trip to reach the other side`
                + (picks.length ? `; the most needed new crossing is at ${g.codes[picks[0]]} (${_people(gap[picks[0]])} m gap).` : '.'),
            stats,
        };
    }

    // ── freight and logistics ───────────────────────────────────────────────

    const TRUCK_ROUTE = 100;   // trucks/day on the busiest nearby road

    function freight(fr) {
        const c = fr.cols, g = fr.grid, n = g.n, idx = _residents(fr), pop = c['population.population'];
        const tr = c['freight.trucks_day'], lo = c['freight.logistics'], wh = c['freight.wholesale'], ind = c['freight.industry'];
        if (!tr || !tr.some(v => v > 0)) return null;
        const near = g.offsets(ROAD_KM);
        const truckNear = new Float64Array(n).fill(NaN);
        for (let i = 0; i < n; i++) {
            let m = 0;
            for (const [a, b] of near) { const j = g.cellAt(i, a, b); if (j >= 0 && tr[j] > m) m = tr[j]; }
            if (m > 0) truckNear[i] = m;
        }
        const total = _sumOver(pop, idx, () => true) || 1;
        const pRoute = _sumOver(pop, idx, i => truckNear[i] >= TRUCK_ROUTE);
        const sites = new Float64Array(n).fill(NaN);
        let nLo = 0, nWh = 0, nInd = 0;
        for (let i = 0; i < n; i++) {
            const a = lo && lo[i] > 0 ? lo[i] : 0, b = wh && wh[i] > 0 ? wh[i] : 0, d = ind && ind[i] > 0 ? ind[i] : 0;
            nLo += a; nWh += b; nInd += d;
            if (a + b + d > 0) sites[i] = a + b + d;
        }
        const stats = [
            { label: 'Truck-trip generators mapped (logistics / wholesale / industry)', value: `${_people(nLo)} / ${_people(nWh)} / ${_people(nInd)}` },
            { label: `Residents within ${ROAD_KM * 1000} m of a truck route (${TRUCK_ROUTE}+ trucks a day)`, value: `${_people(pRoute)} (${_round(100 * pRoute / total)}%)`, raw: Math.round(pRoute) },
        ];
        const sch = c['emergency_access.schools'];
        if (sch) {
            let all = 0, hit = 0;
            for (let i = 0; i < n; i++) if (sch[i] > 0) { all += sch[i]; if (truckNear[i] >= TRUCK_ROUTE) hit += sch[i]; }
            if (all) stats.push({ label: 'Schools beside a truck route', value: `${_people(hit)} of ${_people(all)} (${_round(100 * hit / all)}%)` });
        }
        const nox = c['freight.truck_nox_kg_day'];
        if (nox) { let t = 0; for (let i = 0; i < n; i++) if (nox[i] > 0) t += nox[i]; stats.push({ label: 'Truck NOx on first/last-mile routes', value: `${_round(t)} kg a day` }); }
        // Freight clusters: cells with the most sites, 1.5 km apart (candidates for consolidation centres / truck lay-bys).
        const order = [];
        for (let i = 0; i < n; i++) if (sites[i] > 0) order.push(i);
        order.sort((a, b) => sites[b] - sites[a]);
        const picks = [];
        for (const i of order) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1.5)) continue;
            picks.push(i);
        }
        picks.forEach((i, r) => stats.push({ label: `Freight cluster ${r + 1}: ${g.codes[i]}`, value: `${_people(sites[i])} sites${_fin(truckNear[i]) ? `, ${_people(truckNear[i])} trucks a day on the nearest route` : ''}` }));
        return {
            columns: { truck_near: truckNear, freight_sites: sites }, idx, weightKey: 'truck_near',
            metric: { label: 'Residents beside a truck route', value: _round(100 * pRoute / total), unit: '%', higherIs: 'worse' },
            headline: `${_round(100 * pRoute / total)}% of residents (${_people(pRoute)}) live within ${ROAD_KM * 1000} m of a road carrying ${TRUCK_ROUTE}+ trucks a day between ${_people(nLo + nWh + nInd)} logistics, wholesale and industrial sites and the national highways`
                + (picks.length ? `; the densest freight cluster is around ${g.codes[picks[0]]}.` : '.'),
            stats,
        };
    }

    // ── traffic exhaust on the walk ─────────────────────────────────────────

    const CLEAN_ALPHA = 3, CLEAN_SAVE = 30, CLEAN_EXTRA = 20;   // cost weight; "worth it" = ≥30% less exhaust for ≤20% more walking

    /** Exhaust dose along each route of a walk tree: Σ step length × exposure of the two cells. Pure given the tree. */
    function routeDose(fr, tree, ex) {
        const g = fr.grid, n = g.n, dose = new Float64Array(n).fill(NaN), order = [];
        for (let i = 0; i < n; i++) if (_fin(tree.dist[i])) order.push(i);
        order.sort((a, b) => tree.dist[a] - tree.dist[b]);
        for (const i of order) {
            const p = tree.pred[i];
            if (p < 0) { dose[i] = 0; continue; }
            const step = Math.hypot((g.row[i] - g.row[p]) * g.dy, (g.col[i] - g.col[p]) * g.dx);
            dose[i] = (_fin(dose[p]) ? dose[p] : 0) + step * (ex[i] + ex[p]) / 2;
        }
        return dose;
    }

    function cleanwalk(fr) {
        const c = fr.cols, g = fr.grid, n = g.n, idx = _residents(fr), pop = c['population.population'];
        const nox = c['traffic_noise.nox_kg_day'];
        if (!nox || !nox.some(v => v > 0)) return null;
        const ms = c['rail_access.metro_stations'], rs = c['rail_access.rail_stations'], sch = c['emergency_access.schools'];
        const T = sch && sch.some(v => v > 0) ? (i => sch[i] > 0) : (ms || rs) ? (i => (ms && ms[i] > 0) || (rs && rs[i] > 0)) : null;
        if (!T) return null;
        const what = sch && sch.some(v => v > 0) ? 'school' : 'the station';
        // Exposure index: cell NOx emitted by traffic, relative to the city's busiest tenth of road cells.
        const vals = [];
        for (let i = 0; i < n; i++) if (nox[i] > 0) vals.push(nox[i]);
        vals.sort((a, b) => a - b);
        const p90 = vals[Math.floor(0.9 * (vals.length - 1))] || 1;
        const ex = new Float64Array(n);
        for (let i = 0; i < n; i++) ex[i] = nox[i] > 0 ? Math.min(2, nox[i] / p90) : 0;
        const short = walkTree(fr, T), clean = walkTree(fr, T, SHADE_KM * 1.2, (j, k) => 1 + CLEAN_ALPHA * (ex[j] + ex[k]) / 2);
        const dS = routeDose(fr, short, ex), dC = routeDose(fr, clean, ex);
        const reach = idx.filter(i => _fin(short.dist[i]) && short.dist[i] > 0);
        const pR = _sumOver(pop, reach, () => true);
        if (!pR) return null;
        const hot = reach.filter(i => dS[i] / short.dist[i] >= 0.5);           // average route at half the busiest-tenth level or worse
        const pHot = _sumOver(pop, hot, () => true);
        const save = new Float64Array(n).fill(NaN), mean = new Float64Array(n).fill(NaN);
        let pWorth = 0;
        for (const i of reach) {
            mean[i] = _round(100 * dS[i] / short.dist[i]);
            if (!_fin(clean.dist[i]) || !(dS[i] > 0)) { save[i] = 0; continue; }
            const s = Math.max(0, 100 * (1 - dC[i] / dS[i])), extra = 100 * (clean.dist[i] / short.dist[i] - 1);
            save[i] = _round(s);
            if (s >= CLEAN_SAVE && extra <= CLEAN_EXTRA) pWorth += pop[i] || 0;
        }
        const medSave = wquantile(save, pop, hot.length ? hot : reach, 0.5);
        const stats = [
            { label: `Residents within a ${Math.round(SHADE_KM * 12.5)}-minute walk of ${what}`, value: _people(pR) },
            { label: '… whose shortest walk runs along heavy traffic exhaust (route average ≥ half the busiest tenth of road cells)', value: `${_people(pHot)} (${_round(100 * pHot / pR)}%)`, raw: Math.round(pHot) },
            { label: `… who could cut the exhaust on their walk by ${CLEAN_SAVE}%+ with at most ${CLEAN_EXTRA}% more walking`, value: `${_people(pWorth)} (${_round(100 * pWorth / pR)}%)` },
        ];
        if (medSave != null) stats.push({ label: 'Median exhaust saved by the cleaner route (exposed walkers)', value: `${_round(medSave)}%` });
        return {
            columns: { walk_exhaust: mean, clean_save: save }, idx: reach, weightKey: 'walk_exhaust',
            metric: { label: `Walk to ${what} along heavy traffic exhaust`, value: _round(100 * pHot / pR), unit: '%', higherIs: 'worse' },
            headline: `${_round(100 * pHot / pR)}% of residents within walking distance of ${what} walk there along heavy traffic exhaust; ${_round(100 * pWorth / pR)}% could cut that exposure by ${CLEAN_SAVE}% or more on a quieter route no more than ${CLEAN_EXTRA}% longer.`,
            stats,
        };
    }

    // ── mobility scorecard across the cities ────────────────────────────────

    // Pillars over the lens league (data/lenses/league.json). EV charging is
    // left out: open charger data covers too little of India's network to rank on.
    const PILLARS = [
        { id: 'access', label: 'Access', metrics: ['metro', 'transit', 'busgap', 'ambulance'] },
        { id: 'flow', label: 'Traffic flow', metrics: ['traffic', 'monsoon'] },
        { id: 'safety', label: 'Safety & health', metrics: ['roadsafety', 'noise', 'nightwalk', 'freight', 'cleanwalk'] },
        { id: 'walk', label: 'Walking & cycling', metrics: ['fifteen', 'shade', 'walk', 'cycling', 'crossing'] },
    ];

    /**
     * Rank the cities on mobility. Each metric scores 0–100 between the worst
     * and the best city (direction-aware); a pillar is the mean of its metrics,
     * the overall score the mean of the pillars. Pure given the league.
     */
    function scorecard(league) {
        const cities = league && league.cities ? Object.entries(league.cities) : [];
        if (cities.length < 2) return null;
        const meta = {}, score = {};
        for (const p of PILLARS) {
            for (const id of p.metrics) {
                const vals = cities.map(([, c]) => c.metrics[id] && c.metrics[id].value).filter(_fin);
                if (vals.length < 2) continue;
                const m = cities.map(([, c]) => c.metrics[id]).find(Boolean);
                const lo = Math.min(...vals), hi = Math.max(...vals);
                meta[id] = { label: m.label, unit: m.unit, higherIs: m.higherIs, pillar: p.id };
                for (const [name, c] of cities) {
                    const v = c.metrics[id] && c.metrics[id].value;
                    if (!_fin(v)) continue;
                    const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
                    (score[name] = score[name] || {})[id] = Math.round(100 * (m.higherIs === 'worse' ? 1 - t : t));
                }
            }
        }
        const rows = cities.map(([name, c]) => {
            const sc = score[name] || {}, pillars = {};
            for (const p of PILLARS) {
                const xs = p.metrics.filter(id => sc[id] != null).map(id => sc[id]);
                pillars[p.id] = xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
            }
            const ps = Object.values(pillars).filter(v => v != null);
            const ids = Object.keys(sc).sort((a, b) => sc[b] - sc[a]);
            const pick = (id) => id && { id, label: meta[id].label, value: c.metrics[id].value, unit: meta[id].unit, score: sc[id] };
            return { city: name, label: c.label || name, overall: ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : null,
                pillars, scores: sc, best: pick(ids[0]), worst: pick(ids[ids.length - 1]) };
        }).filter(r => r.overall != null).sort((a, b) => b.overall - a.overall);
        rows.forEach((r, i) => { r.rank = i + 1; });
        return { generated: league.generated, pillars: PILLARS.map(p => ({ id: p.id, label: p.label, metrics: p.metrics.filter(id => meta[id]) })), metrics: meta, cities: rows };
    }

    /** The scorecard as plain text (DISHA answers, copy). */
    function scorecardText(sc, city) {
        if (!sc) return 'The cross-city mobility scorecard is not available.';
        const fmt = (x) => `${x.value}${x.unit === '%' ? '%' : ` ${x.unit}`}`;
        const lines = [`Mobility scorecard, ${sc.cities.length} cities (0–100, 100 = best of the cities on every measure; ${sc.pillars.map(p => p.label.toLowerCase()).join(', ')}):`];
        for (const r of sc.cities) {
            lines.push(`${r.rank}. ${r.label} ${r.overall}/100 · ${sc.pillars.map(p => `${p.label.toLowerCase()} ${r.pillars[p.id] ?? '–'}`).join(', ')}`
                + ` · strongest: ${r.best.label.replace(/^./, ch => ch.toLowerCase())} (${fmt(r.best)}); weakest: ${r.worst.label.replace(/^./, ch => ch.toLowerCase())} (${fmt(r.worst)})`);
        }
        const me = city && sc.cities.find(r => r.city === city);
        if (me) lines.unshift(`${me.label} ranks ${me.rank} of ${sc.cities.length} on mobility (${me.overall}/100).`);
        return lines.join('\n');
    }

    const ENTRIES = [
        { id: 'cleanwalk', equity: true, title: 'Exhaust on the walk to school', icon: '😷',
            question: 'How much traffic exhaust do children breathe on the walk to school, and is there a cleaner route?',
            field: { key: 'walk_exhaust', label: 'Traffic exhaust along the shortest walk (100 = busiest tenth of road cells)', unit: 'index', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'clean_save', label: 'Exhaust saved by the cleaner route', unit: '%', higherIs: 'better', ramp: 'greens' }],
            needs: ['traffic_noise.nox_kg_day', 'emergency_access.schools', 'rail_access.metro_stations', 'rail_access.rail_stations', 'osm_walk.links', 'wealth.rwi'],
            method: `Exposure index per cell is the demand model's traffic NOx emitted in it (pipeline/traffic/noise_air.py), relative to the city's busiest tenth of road cells (capped at 2×): near-road exhaust falls off within 100–200 m, so the cell's own emissions are a fair proxy for what a pedestrian breathes. Each resident walks the OpenStreetMap walking network to the nearest school (stations where no school is mapped): once by the shortest route and once by a route that weighs each step by 1 + ${CLEAN_ALPHA}× exposure. Dose is length × exposure summed along the route. "Worth it" is ${CLEAN_SAVE}%+ less dose for at most ${CLEAN_EXTRA}% more walking. A screen for school-street and low-traffic-route planning, not measured air quality.`,
            refs: 'Karner, Eisinger & Niemeier 2010 (near-road pollutant gradients); Hertel et al. 2008 (route choice and cyclist exposure); Davies & Whyatt 2014 (pedestrian route exposure); EEA/COPERT emission factors' },
        { id: 'freight', equity: true, title: 'Freight and truck routes', icon: '🚚',
            question: 'Where do trucks run through neighbourhoods, and where are the freight clusters?',
            field: { key: 'truck_near', label: 'Trucks a day on the busiest road within 250 m', unit: 'trucks/day', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'freight_sites', label: 'Logistics, wholesale and industrial sites', unit: 'sites', higherIs: null, ramp: 'viridis' }],
            needs: ['freight.trucks_day', 'freight.logistics', 'freight.wholesale', 'freight.industry', 'freight.truck_nox_kg_day',
                'emergency_access.schools', 'wealth.rwi'],
            method: `Truck-trip generators are Overture Maps places in logistics (freight, courier, storage, warehouses), wholesale and industry categories. Each gets an indicative number of truck trips a day (12 / 6 / 4) routed on the fastest free-flow arterial path to the nearest national highway node: the first and last mile, at night when most Indian cities let heavy vehicles in. A home is beside a truck route when a road within ${ROAD_KM * 1000} m carries ${TRUCK_ROUTE}+ modelled trucks a day. No truck counts, gate data or entry-time rules, so the routes are indicative; the clusters are where consolidation centres or truck lay-bys would serve the most sites.`,
            refs: 'Holguín-Veras et al. 2011 (freight trip generation); NITI Aayog 2021 (urban freight in India); Overture Maps Foundation places; COPERT heavy-duty vehicle emission factors' },
        { id: 'crossing', equity: true, title: 'Crossing gaps on main roads', icon: '🦓',
            question: 'How far do people walk along a main road before they can cross it?',
            field: { key: 'cross_gap', label: 'Longest main-road stretch with no crossing near home (2,000+ capped)', unit: 'm', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'cross_need', label: 'Residents nearby × gap × traffic (add a crossing here)', unit: 'score', higherIs: 'worse', ramp: 'reds' }],
            needs: ['crossings.max_gap_m', 'crossings.gap_km', 'crossings.main_km', 'crossings.crosswalks', 'traffic_load.peak_pcu', 'wealth.rwi'],
            method: `Overture Maps main roads (trunk, primary, secondary, and tertiary roads the demand model loads with 600+ PCU at peak; motorways are left out) are chained through every connector that no other road, lane or path meets; a junction or a mapped crosswalk ends the chain. The chain's length is the gap a pedestrian walks along before crossing. IRC 103 asks for a crossing every 80–250 m in busy areas; ${GAP_M} m is the line used here. Junctions count as crossings even without a signal or zebra, so gaps are a lower bound. A home is beside a main road within ${ROAD_KM * 1000} m; new-crossing need is residents within ${ROAD_KM * 1000} m × gap (to 3×) × peak traffic.`,
            refs: 'IRC 103-2022 (Guidelines for pedestrian facilities); Overture Maps Foundation transportation; Tiwari 2015 (pedestrian safety in Indian cities)' },
        { id: 'nightwalk', equity: true, title: 'Night walk to the station', icon: '🌙',
            question: 'Is the walk to the metro or train station lit and busy after dark?',
            field: { key: 'night_route', label: 'Dimmest night light along the walk to the station', unit: 'nW/cm²/sr', higherIs: 'better', ramp: 'viridis' },
            extra: [{ key: 'light_priority', label: 'Walkers through a dark cell (light here first)', unit: 'people', higherIs: 'worse', ramp: 'heat' }],
            needs: ['nightlights.radiance', 'rail_access.metro_stations', 'rail_access.rail_stations', 'osm_walk.links', 'osm_amenities.food',
                'osm_amenities.shopping', 'population.density_km2', 'demographics.women_pct', 'mobility.nearest_police_km', 'wealth.rwi'],
            method: `Each resident walks the OpenStreetMap walking network to the nearest metro or rail station, out to ${SHADE_KM} km. A cell on the route is dark when its VIIRS night-time radiance is under ${DARK_RAD} nW/cm²/sr (the dimmest ~5–10% of populated cells in these cities; most read 25–50 at this ~500 m resolution), and deserted when it has no mapped shop or eatery and fewer than ${LONELY_DENS} residents/km² ("eyes on the street", Jacobs 1961). The map shows the dimmest radiance along each walk; lighting priority is walkers routed through each dark cell. Satellite light is an area average, so a lit main road can hide a dark lane; treat it as a screen for audits such as Safetipin's.`,
            refs: 'Elvidge et al. 2017 (VIIRS night lights); Jacobs 1961; Painter 1996 (street lighting and pedestrian fear); Safetipin / UN Women Safe Cities audits' },
        { id: 'cycling', equity: true, title: 'Low-stress cycling', icon: '🚲',
            question: 'Can children cycle to school without crossing a main road?',
            field: { key: 'cycle_area', label: 'Area you can cycle without crossing a main road (10+ = big network)', unit: 'km²', higherIs: 'better', ramp: 'viridis' },
            extra: [{ key: 'cycle_school', label: 'School reachable on quiet streets (1 = yes)', unit: '0-1', higherIs: 'better', ramp: 'greens' },
                { key: 'cycle_crossing', label: 'Residents joined by a safe crossing here', unit: 'people', higherIs: 'better', ramp: 'heat' }],
            needs: ['cycling.island', 'cycling.island_km2', 'cycling.crossing_gain', 'cycling.cycleway_km', 'emergency_access.schools',
                'rail_access.metro_stations', 'rail_access.rail_stations', 'demographics.children_pct', 'wealth.rwi'],
            method: `Level of Traffic Stress (Mekuria, Furth & Nixon 2012) from Overture Maps road classes: motorway, trunk, primary and secondary roads, and tertiary roads the demand model loads with 600+ PCU at peak, are high stress; residential, service, unclassified, living streets, tracks, paths and cycle tracks are low stress. Low-stress streets join into islands that never pass through a main-road junction (no signal or crossing data, so every such junction counts as a barrier). A child can cycle to school when a school lies in the same island within ${BIKE_KM} km as the crow flies (about ${Math.round(BIKE_KM * 1.3)} km ridden); the same test for stations is bike-and-ride. Crossing gain is the residents of the smaller islands a safe crossing at that junction would join to the biggest one.`,
            refs: 'Mekuria, Furth & Nixon 2012 (Low-stress bicycling and network connectivity); Furth et al. 2016 (network connectivity for low-stress bicycling); MoHUA 2017 Cycles4Change; Overture Maps Foundation transportation' },
        { id: 'roadsafety', equity: true, title: 'Road danger on the school walk', icon: '🚸',
            question: 'Which children have to cross a fast, busy road to walk to school?',
            field: { key: 'walk_risk', label: 'Worst fatality risk if hit on the walk to school', unit: '%', higherIs: 'worse', ramp: 'reds' },
            extra: [{ key: 'crossing_priority', label: 'Children walking through × fatality risk (fix this crossing first)', unit: 'children', higherIs: 'worse', ramp: 'heat' }],
            needs: ['traffic_load.peak_pcu', 'traffic_load.peak_speed_kmh', 'traffic_load.delay_pct', 'emergency_access.schools', 'emergency_access.hospitals',
                'osm_walk.links', 'demographics.children_pct', 'wealth.rwi'],
            method: `Each child (residents × WorldPop share under 15, 25% where missing) walks the OpenStreetMap walking network to the nearest school (Overture Maps), out to ${SHADE_KM} km. A road cell is dangerous when the demand model's arterial has a free-flow speed of ${FAST_KMH}+ km/h (peak speed × (1 + peak delay), the speed traffic reaches outside the rush) and ${BUSY_PCU}+ PCU in the peak hour. The map shows the worst fatality risk along each child's route if struck at that speed (Rosén & Sander 2009: about ${_round(100 * fatalRisk(SAFE_KMH))}% at ${SAFE_KMH} km/h, ${_round(100 * fatalRisk(60))}% at 60 km/h); crossing priority is children walking through × that risk. No crossings, signals, footbridges or crash records in the open data, so it ranks exposure, not crashes.`,
            refs: 'Rosén & Sander 2009 (pedestrian fatality risk and impact speed); WHO 2023 Global status report on road safety; IRC SP 32-2023 (road safety for children near schools); Stockholm Declaration 2020 (30 km/h)' },
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

    UrbanLenses.register(ENTRIES, { noise, traffic, ambulance, metro, ev, shade, busgap, roadsafety, cycling, nightwalk, crossing, freight, cleanwalk }, { stationSites, stationWhatIf, stationAsk, walkTree, walkerLoad, routeMax, routeDose, fatalRisk, scorecard, scorecardText, MOBILITY_PILLARS: PILLARS });
    return { ENTRIES, stationSites, stationWhatIf, stationAsk };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesMobility = UrbanLensesMobility;
}
