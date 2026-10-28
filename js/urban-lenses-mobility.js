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
    const JOB_MIN = 45, JOB_LOW = 10;
    // Hourly share of daily traffic (%) as in pipeline/traffic/demand_model.py HOURLY_SHARE; 9 % at the 09:00 peak.
    const HOURLY = [0.6, 0.4, 0.3, 0.3, 0.5, 1.1, 2.4, 4.4, 7.0, 9.0, 7.6, 5.6, 5.0, 4.8, 4.6, 4.8, 5.4, 7.0, 8.8, 7.8, 5.6, 3.6, 2.2, 1.2];
    const HOURLY_PEAK = 9.0, JAM_MAX = 4, WORKDAYS = 300, PERSONS_PER_PCU = 2.7, RS_PER_PCU_HR = 2.7 * 100 + 0.4 * 100;
    const SCHOOL_GATE_KM = 0.15, SCHOOL_KM = 0.8, SCHOOL_BUSY_VC = 0.7, KIDS_PCT = 25;
    const TOD_BUILT = 10, TOD_LOW = 1, TOD_TARGET = 4, STOREY_M = 3;
    const PARK_CAP = 3, PARK_HOT = 5, FEEDER_MAX = 30, FEEDERS = 5;
    const STOP_KM = 0.4, STOP_HOT = 40, STOP_BARE = 10, SHELTERS = 5, FEW_STOPS = 50;
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

    /** Jobs within 45 minutes: by car at 9 am versus by train and walking (cumulative opportunities). */
    function jobaccess(fr) {
        const c = fr.cols, idx = _residents(fr), n = fr.grid.n, pop = c['population.population'];
        const car = c['job_access.jobs_car_pct'], tr = c['job_access.jobs_transit_pct'];
        if (!tr) return null;
        const tCol = new Float64Array(n).fill(NaN), gCol = new Float64Array(n).fill(NaN);
        const use = idx.filter(i => _fin(tr[i]));
        for (const i of use) {
            tCol[i] = tr[i];
            if (car && _fin(car[i])) gCol[i] = Math.max(0, car[i] - tr[i]);
        }
        if (!use.length) return null;
        const mT = wmean(tCol, pop, use), mC = car ? wmean(car, pop, use.filter(i => _fin(car[i]))) : null;
        const stats = [
            { label: `Jobs and activities within ${JOB_MIN} min by train and walking (average resident)`, value: `${_round(mT)}%`, raw: _round(mT) },
        ];
        if (mC != null) stats.push({ label: `… by car at 9 am`, value: `${_round(mC)}%` });
        const total = _sumOver(pop, use, () => true) || 1;
        const cut = _sumOver(pop, use, i => tr[i] < JOB_LOW);
        stats.push({ label: `Residents who reach under ${JOB_LOW}% of jobs without a car`, value: `${_people(cut)} (${_round(100 * cut / total)}%)` });
        const rwi = c['wealth.rwi'];
        let poorT = null;
        if (rwi) {
            const q20 = wquantile(rwi, pop, use, 0.2), q80 = wquantile(rwi, pop, use, 0.8);
            if (q20 != null && q80 != null) {
                const poor = use.filter(i => rwi[i] <= q20), rich = use.filter(i => rwi[i] >= q80);
                poorT = poor.length ? wmean(tCol, pop, poor) : null;
                const richT = rich.length ? wmean(tCol, pop, rich) : null;
                if (poorT != null && richT != null) stats.push({ label: 'Poorest vs richest fifth, jobs reachable by train and walking', value: `${_round(poorT)}% vs ${_round(richT)}%` });
            }
        }
        return {
            columns: { jobs_transit: tCol, jobs_car_gap: gCol }, idx: use, weightKey: 'jobs_transit',
            metric: { label: `Jobs within ${JOB_MIN} min by train and walking`, value: _round(mT), unit: '%', higherIs: 'better' },
            headline: `The average resident can reach ${_round(mT)}% of the city's jobs and activities within ${JOB_MIN} minutes by train and walking`
                + (mC != null ? `, against ${_round(mC)}% by car at 9 am` : '')
                + `; ${_round(100 * cut / total)}% reach under ${JOB_LOW}% without a car.`,
            stats,
        };
    }

    /** Heat and shade at bus stops: who waits in the sun, and where a shelter or trees would help most. */
    function busheat(fr) {
        const g = fr.grid, c = fr.cols, idx = _residents(fr), n = g.n, pop = c['population.population'];
        const st = c['bus_stop_heat.stops'], hb = c['bus_stop_heat.hot_bare_stops'], pr = c['bus_stop_heat.shelter_priority'];
        const lst = c['bus_stop_heat.stop_lst_c'];
        if (!st) return null;
        let nS = 0, nH = 0;
        const stops = [];
        for (let i = 0; i < n; i++) if (st[i] > 0) { nS += st[i]; nH += hb && hb[i] > 0 ? hb[i] : 0; stops.push(i); }
        if (!nS) return null;
        const prCol = new Float64Array(n).fill(NaN), tCol = new Float64Array(n).fill(NaN);
        for (const i of stops) { if (pr && _fin(pr[i])) prCol[i] = pr[i]; if (lst && _fin(lst[i])) tCol[i] = lst[i]; }
        // Residents whose nearest mapped stops (within a 5-minute walk) include a hot, bare one.
        const off = g.offsets(STOP_KM), near = new Uint8Array(n), sun = new Uint8Array(n);
        for (const i of idx) {
            for (const [a, b] of off) {
                const j = g.cellAt(i, a, b);
                if (j < 0 || !(st[j] > 0)) continue;
                near[i] = 1;
                if (hb && hb[j] > 0) sun[i] = 1;
            }
        }
        const total = _sumOver(pop, idx, () => true) || 1, pNear = _sumOver(pop, idx, i => near[i]), pSun = _sumOver(pop, idx, i => sun[i]);
        const share = _round(100 * nH / nS);
        const stats = [
            { label: 'Bus stops mapped', value: _people(nS) + (nS < FEW_STOPS ? ' (few mapped: OpenStreetMap stops are added on the next data refresh)' : '') },
            { label: `Stops at ${STOP_HOT}+ °C surface with under ${STOP_BARE}% tree canopy`, value: `${_people(nH)} (${share}%)`, raw: share },
            { label: 'Residents within a 5-minute walk of a mapped stop', value: `${_people(pNear)} (${_round(100 * pNear / total)}%)` },
            { label: '… whose nearby stop is hot and bare', value: `${_people(pSun)} (${_round(100 * pSun / (pNear || 1))}% of them)` },
        ];
        stops.filter(i => _fin(prCol[i]) && prCol[i] > 0).sort((a, b) => prCol[b] - prCol[a]).slice(0, SHELTERS)
            .forEach((i, k) => stats.push({ label: `Shelter or trees ${k + 1}: ${g.codes[i]}`, value: `${_fin(tCol[i]) ? _round(tCol[i]) + ' °C, ' : ''}${st[i]} stop${st[i] > 1 ? 's' : ''}, score ${_people(prCol[i])}` }));
        const rwi = c['wealth.rwi'];
        if (rwi && pNear) {
            const q20 = wquantile(rwi, pop, idx, 0.2);
            const poorNear = q20 != null ? _sumOver(pop, idx, i => near[i] && rwi[i] <= q20) : 0;
            if (poorNear) stats.push({ label: 'Poorest fifth near a stop: share whose stop is hot and bare', value: `${_round(100 * _sumOver(pop, idx, i => sun[i] && rwi[i] <= q20) / poorNear)}% (all: ${_round(100 * pSun / pNear)}%)` });
        }
        return {
            columns: { shelter_priority: prCol, stop_heat: tCol }, idx: stops, weightKey: 'shelter_priority', noHotspots: true,
            metric: { label: 'Bus stops hot and unshaded', value: share, unit: '%', higherIs: 'worse' },
            headline: `${share}% of the ${_people(nS)} mapped bus stops sit at ${STOP_HOT}+ °C surface temperature with under ${STOP_BARE}% tree canopy; ${_people(pSun)} residents live within a 5-minute walk of one.`,
            stats,
        };
    }

    /** Parking pressure: where more vehicles arrive than kerbs and lots can hold, and who lives with the spill-over. */
    function parking(fr) {
        const g = fr.grid, c = fr.cols, idx = _residents(fr), n = g.n, pop = c['population.population'];
        const pr = c['parking.pressure'], dem = c['parking.demand_ecs'], sup = c['parking.supply_ecs'];
        if (!pr || !dem) return null;
        const pCol = new Float64Array(n).fill(NaN), oCol = new Float64Array(n).fill(NaN), cells = [];
        let dTot = 0, dOver = 0, over = 0;
        for (let i = 0; i < n; i++) {
            if (!_fin(pr[i]) || !_fin(dem[i])) continue;
            cells.push(i);
            pCol[i] = Math.min(PARK_CAP, pr[i]);
            dTot += dem[i];
            if (pr[i] > 1) { dOver += dem[i]; const o = dem[i] - (_fin(sup[i]) ? sup[i] : 0); oCol[i] = o; over += o; }
        }
        if (!cells.length) return null;
        const total = _sumOver(pop, idx, () => true) || 1, pSpill = _sumOver(pop, idx, i => pr[i] > 1);
        const share = _round(100 * dOver / (dTot || 1));
        const stats = [
            { label: 'Parking demand in streets that overflow', value: `${share}%`, raw: share },
            { label: 'Vehicles with no kerb or lot space at the late-morning peak', value: `${_people(over)} car spaces` },
            { label: 'Residents living on overflowing streets', value: `${_people(pSpill)} (${_round(100 * pSpill / total)}%)` },
        ];
        const rw = c['rail_access.rail_walk_min'];
        if (rw) {
            const near = cells.filter(i => pr[i] > 1 && rw[i] <= STATION_WALK);
            if (near.length) stats.push({ label: `Overflowing cells within a ${STATION_WALK}-minute walk of a station`, value: `${near.length} (park-and-ride or feeder candidates)` });
        }
        cells.filter(i => _fin(oCol[i])).sort((a, b) => oCol[b] - oCol[a]).slice(0, PARK_HOT)
            .forEach((i, k) => stats.push({ label: `Parking hotspot ${k + 1}: ${g.codes[i]}`, value: `${_people(dem[i])} vehicles for ${_people(sup[i] || 0)} spaces (${_round(pr[i], 1)}×)` }));
        return {
            columns: { park_pressure: pCol, park_overflow: oCol }, idx: cells, weightKey: 'park_overflow',
            metric: { label: 'Parking demand on overflowing streets', value: share, unit: '%', higherIs: 'worse' },
            headline: `${share}% of late-morning parking demand falls on streets where it outstrips the kerb and lots, leaving about ${_people(over)} vehicles on footpaths, main roads or double-parked.`,
            stats,
        };
    }

    /** Metro last mile: residents too far to walk to a station and with no bus stop within a 5-minute walk. */
    function feeder(fr) {
        const g = fr.grid, c = fr.cols, idx = _residents(fr), n = g.n, pop = c['population.population'];
        const mw = c['rail_access.metro_walk_min'], rw = c['rail_access.rail_walk_min'];
        const w = mw && mw.some(v => _fin(v)) ? mw : rw;
        const srcs = ['bus_stop_heat.stops', 'osm_transit.stops', 'bus_service.stops'].map(k => c[k]).filter(Boolean);
        if (!w || !srcs.length) return null;
        const hasStop = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (srcs.some(a => a[i] > 0)) hasStop[i] = 1;
        const off = g.offsets(STOP_KM);
        const band = idx.filter(i => _fin(w[i]) && w[i] > STATION_WALK && w[i] <= FEEDER_MAX);
        if (!band.length) return null;
        const gap = new Float64Array(n).fill(NaN), walk = new Float64Array(n).fill(NaN), unserved = new Uint8Array(n);
        for (const i of band) {
            walk[i] = w[i];
            let ok = false;
            for (const [a, b] of off) { const j = g.cellAt(i, a, b); if (j >= 0 && hasStop[j]) { ok = true; break; } }
            if (!ok) { unserved[i] = 1; gap[i] = pop[i]; }
        }
        const total = _sumOver(pop, idx, () => true) || 1, pBand = _sumOver(pop, band, () => true), pGap = _sumOver(pop, band, i => unserved[i]);
        const share = _round(100 * pGap / (pBand || 1));
        const metroWord = w === mw ? 'metro' : 'rail';
        const stats = [
            { label: `Residents ${STATION_WALK}–${FEEDER_MAX} min on foot from a ${metroWord} station (feeder range)`, value: `${_people(pBand)} (${_round(100 * pBand / total)}% of the city)` },
            { label: '… with no mapped bus stop within a 5-minute walk', value: `${_people(pGap)} (${share}%)`, raw: share },
        ];
        // Feeder clusters: unserved cells, ~1.5 km apart, by residents within 800 m.
        const area = g.offsets(0.8), score = new Map();
        for (const i of band) {
            if (!unserved[i]) continue;
            let p = 0;
            for (const [a, b] of area) { const j = g.cellAt(i, a, b); if (j >= 0 && unserved[j]) p += pop[j]; }
            score.set(i, p);
        }
        const picks = [];
        for (const i of [...score.keys()].sort((a, b) => score.get(b) - score.get(a))) {
            if (picks.length >= FEEDERS) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1.5)) continue;
            picks.push(i);
        }
        picks.forEach((i, k) => stats.push({ label: `Feeder route stop ${k + 1}: ${g.codes[i]}`, value: `${_people(score.get(i))} residents within 800 m, ${_round(w[i])} min walk from the ${metroWord}` }));
        const rwi = c['wealth.rwi'];
        if (rwi) {
            const q20 = wquantile(rwi, pop, idx, 0.2);
            const poor = q20 != null ? band.filter(i => rwi[i] <= q20) : [];
            const pp = _sumOver(pop, poor, () => true);
            if (pp) stats.push({ label: 'Poorest fifth in feeder range with no bus stop', value: `${_round(100 * _sumOver(pop, poor, i => unserved[i]) / pp)}% (all: ${share}%)` });
        }
        return {
            columns: { feeder_gap: gap, station_walk_min: walk }, idx: band, weightKey: 'feeder_gap',
            metric: { label: `Feeder-range residents with no bus stop nearby`, value: share, unit: '%', higherIs: 'worse' },
            headline: `${_people(pBand)} people live ${STATION_WALK}–${FEEDER_MAX} minutes on foot from a ${metroWord} station; ${share}% of them have no mapped bus stop within a 5-minute walk to make that last mile.`,
            stats,
        };
    }

    /** Commute length and carbon by home location: the cost of distance between homes and activity. */
    function commute(fr) {
        const c = fr.cols, idx = _residents(fr), n = fr.grid.n, pop = c['population.population'];
        const tk = c['commute_carbon.trip_km'], co = c['commute_carbon.co2_kg_day'];
        if (!tk) return null;
        const use = idx.filter(i => _fin(tk[i]));
        if (!use.length) return null;
        const kCol = new Float64Array(n).fill(NaN), yCol = new Float64Array(n).fill(NaN);
        for (const i of use) { kCol[i] = tk[i]; if (co && _fin(co[i])) yCol[i] = co[i] * 365; }
        const mk = wmean(kCol, pop, use), my = co ? wmean(yCol, pop, use.filter(i => _fin(yCol[i]))) : null;
        const q20 = wquantile(kCol, pop, use, 0.2), q80 = wquantile(kCol, pop, use, 0.8);
        const stats = [
            { label: 'Average motorised trip from home', value: `${_round(mk, 1)} km`, raw: _round(mk, 1) },
        ];
        if (my != null) stats.push({ label: 'Transport CO2 per resident', value: `${_round(my)} kg a year` });
        if (q20 != null && q80 != null) {
            const inner = use.filter(i => kCol[i] <= q20), outer = use.filter(i => kCol[i] >= q80);
            const ki = wmean(kCol, pop, inner), ko = wmean(kCol, pop, outer);
            if (ki != null && ko != null) stats.push({ label: 'Best-placed fifth vs worst-placed fifth', value: `${_round(ki, 1)} km vs ${_round(ko, 1)} km a trip (${_round(ko / ki, 1)}×)` });
        }
        const rwi = c['wealth.rwi'];
        if (rwi) {
            const r20 = wquantile(rwi, pop, use, 0.2), r80 = wquantile(rwi, pop, use, 0.8);
            if (r20 != null && r80 != null) {
                const kp = wmean(kCol, pop, use.filter(i => rwi[i] <= r20)), kr = wmean(kCol, pop, use.filter(i => rwi[i] >= r80));
                if (kp != null && kr != null) stats.push({ label: 'Poorest vs richest fifth, average trip', value: `${_round(kp, 1)} km vs ${_round(kr, 1)} km` });
            }
        }
        return {
            columns: { trip_km: kCol, co2_kg_year: yCol }, idx: use, weightKey: 'trip_km',
            metric: { label: 'Average motorised trip from home', value: _round(mk, 1), unit: 'km', higherIs: 'worse' },
            headline: `The average resident's motorised trip is ${_round(mk, 1)} km` + (my != null ? `, about ${_round(my)} kg of CO2 a year from the tailpipe` : '') + '; homes far from jobs and shops travel the furthest.',
            stats,
        };
    }

    /** Hours and rupees lost to congestion over a day (hourly BPR delay on the modelled arterials). */
    function jamcost(fr) {
        const g = fr.grid, c = fr.cols, idx = _residents(fr), n = g.n, pop = c['population.population'];
        const vc = c['traffic_load.peak_vc'], sp = c['traffic_load.peak_speed_kmh'], dl = c['traffic_load.delay_pct'], vkm = c['traffic_load.daily_vkm'];
        if (!vc || !sp || !vkm) return null;
        const hCol = new Float64Array(n).fill(NaN), rCol = new Float64Array(n).fill(NaN), cells = [];
        let hrs = 0;
        for (let i = 0; i < n; i++) {
            if (!(vkm[i] > 0) || !_fin(vc[i]) || !(sp[i] > 0)) continue;
            const ffs = sp[i] * (1 + (_fin(dl && dl[i]) ? dl[i] : 0) / 100);
            let h = 0;
            for (const sh of HOURLY) {
                const v = vc[i] * sh / HOURLY_PEAK;
                h += vkm[i] * sh / 100 / ffs * (Math.min(JAM_MAX, 1 + 0.15 * v ** 4) - 1);
            }
            if (h <= 0) continue;
            hCol[i] = h; rCol[i] = h * WORKDAYS * RS_PER_PCU_HR / 1e5; hrs += h; cells.push(i);
        }
        if (!cells.length) return null;
        const pHrs = hrs * PERSONS_PER_PCU, crore = hrs * WORKDAYS * RS_PER_PCU_HR / 1e7;
        const total = _sumOver(pop, idx, () => true) || 1;
        const perTraveller = 60 * pHrs / (total * 0.9 * 0.5);                // minutes a day per motorised commuter (two trips)
        const stats = [
            { label: 'Person-hours lost in traffic a day', value: _people(pHrs), raw: Math.round(pHrs) },
            { label: 'Delay per motorised traveller', value: `${_round(perTraveller)} min a day` },
            { label: 'Cost of the delay (time + fuel)', value: `₹${_people(crore)} crore a year` },
        ];
        const picks = [];
        for (const i of cells.slice().sort((a, b) => hCol[b] - hCol[a])) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1.5)) continue;
            picks.push(i);
        }
        picks.forEach((i, k) => stats.push({ label: `Costliest jam ${k + 1}: ${g.codes[i]}`, value: `${_people(hCol[i] * PERSONS_PER_PCU)} person-hours a day, ₹${_round(rCol[i] / 100, 1)} crore a year` }));
        // A few junction cells dwarf the rest; cap the map columns at the 95th percentile so the pattern shows.
        const sorted = cells.map(i => hCol[i]).sort((a, b) => a - b), cap = sorted[Math.floor(0.95 * (sorted.length - 1))];
        for (const i of cells) if (hCol[i] > cap) { rCol[i] *= cap / hCol[i]; hCol[i] = cap; }
        return {
            columns: { jam_hours: hCol, jam_cost: rCol }, idx: cells, weightKey: 'jam_hours',
            metric: { label: 'Delay per motorised traveller', value: _round(perTraveller), unit: 'min/day', higherIs: 'worse' },
            headline: `Congestion on the modelled arterials costs about ${_people(pHrs)} person-hours a day, ${_round(perTraveller)} minutes per motorised traveller, or ₹${_people(crore)} crore a year in time and fuel.`,
            stats,
        };
    }

    /** Transit-oriented development: how densely station areas are built, and where low-rise land sits next to the metro. */
    function tod(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const mw = c['rail_access.metro_walk_min'], vol = c['built_up.volume_m3_m2'], bp = c['built_up.built_pct'];
        if (!mw || !vol || !bp) return null;
        const area = [], rest = [];
        for (let i = 0; i < n; i++) {
            if (!_fin(vol[i]) || !_fin(bp[i]) || bp[i] < TOD_BUILT) continue;
            (mw[i] <= STATION_WALK ? area : rest).push(i);
        }
        if (area.length < 3) return null;
        const far = i => vol[i] / STOREY_M;
        const mean = cells => cells.reduce((a, i) => a + far(i), 0) / (cells.length || 1);
        const fA = mean(area), fR = mean(rest);
        const low = area.filter(i => far(i) < TOD_LOW);
        const farCol = new Float64Array(n).fill(NaN), gapCol = new Float64Array(n).fill(NaN);
        for (const i of area) farCol[i] = Math.min(TOD_TARGET, far(i));
        for (const i of low) gapCol[i] = TOD_TARGET - far(i);
        const share = _round(100 * low.length / area.length);
        const popOf = cells => cells.reduce((a, i) => a + (pop && pop[i] > 0 ? pop[i] : 0), 0);
        const dA = popOf(area) / area.length, dR = popOf(rest) / (rest.length || 1);
        const cellKm2 = g.dy * g.dx;
        const stats = [
            { label: `Built-up land within a ${STATION_WALK}-minute walk of the metro, floor area ratio (approx.)`, value: `${_round(fA, 2)} (rest of the city: ${_round(fR, 2)})` },
            { label: `… share built low-rise (FAR under ${TOD_LOW})`, value: `${share}%`, raw: share },
            { label: 'Residents per km² near stations vs elsewhere', value: `${_people(dA / cellKm2)} vs ${_people(dR / cellKm2)}` },
            { label: `Extra floor space if low-rise station land reached FAR ${TOD_TARGET}`, value: `${_round(low.reduce((a, i) => a + (TOD_TARGET - far(i)), 0) * cellKm2, 1)} km²` },
        ];
        const picks = [];
        for (const i of low.slice().sort((a, b) => gapCol[b] - gapCol[a] || mw[a] - mw[b])) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1)) continue;
            picks.push(i);
        }
        picks.forEach((i, k) => stats.push({ label: `TOD site ${k + 1}: ${g.codes[i]}`, value: `FAR about ${_round(far(i), 2)}, ${_round(mw[i])} min walk from the metro` }));
        return {
            columns: { station_far: farCol, tod_gap: gapCol }, idx: area, weightKey: 'tod_gap', noHotspots: true,
            metric: { label: 'Station-area land built low-rise', value: share, unit: '%', higherIs: 'worse' },
            headline: `Built-up land within a ${STATION_WALK}-minute walk of the metro averages a floor area ratio of about ${_round(fA, 2)} against ${_round(fR, 2)} elsewhere; ${share}% of it is low-rise (FAR under ${TOD_LOW}), room for transit-oriented growth.`,
            stats,
        };
    }

    /** School drop-off: schools whose gate sits on a road jammed in the 8–9 am school run, and school-street candidates. */
    function schoolrun(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'];
        const sch = c['emergency_access.schools'], am = c['traffic_load.am_vc'] || c['traffic_load.peak_vc'], pcu = c['traffic_load.peak_pcu'];
        const kids = c['demographics.children_pct'];
        if (!sch || !am) return null;
        const schools = [];
        for (let i = 0; i < n; i++) if (sch[i] > 0) schools.push(i);
        if (!schools.length) return null;
        const gate = g.offsets(SCHOOL_GATE_KM), catch_ = g.offsets(SCHOOL_KM);
        const vcCol = new Float64Array(n).fill(NaN), kidCol = new Float64Array(n).fill(NaN);
        let nS = 0, nJam = 0, nBusy = 0;
        const jammed = [];
        for (const i of schools) {
            let v = 0;
            for (const [a, b] of gate) { const j = g.cellAt(i, a, b); if (j >= 0 && _fin(am[j]) && am[j] > v) v = am[j]; }
            let k = 0;
            for (const [a, b] of catch_) { const j = g.cellAt(i, a, b); if (j >= 0 && pop[j] > 0) k += pop[j] * ((kids && _fin(kids[j]) ? kids[j] : KIDS_PCT) / 100); }
            vcCol[i] = Math.min(2, v); kidCol[i] = k;
            nS += sch[i];
            if (v >= JAM_VC) { nJam += sch[i]; jammed.push(i); } else if (v >= SCHOOL_BUSY_VC) nBusy += sch[i];
        }
        const share = _round(100 * nJam / (nS || 1));
        const near = new Uint8Array(n);
        for (const i of jammed) for (const [a, b] of catch_) { const j = g.cellAt(i, a, b); if (j >= 0) near[j] = 1; }
        let kidsJam = 0;
        for (let j = 0; j < n; j++) if (near[j] && pop[j] > 0) kidsJam += pop[j] * ((kids && _fin(kids[j]) ? kids[j] : KIDS_PCT) / 100);
        const stats = [
            { label: 'Schools mapped', value: _people(nS) },
            { label: `Schools beside a road at V/C ${JAM_VC}+ in the 9 am peak`, value: `${_people(nJam)} (${share}%)`, raw: share },
            { label: `… beside a road at V/C ${SCHOOL_BUSY_VC}–${JAM_VC}`, value: _people(nBusy) },
            { label: `Children living within ${SCHOOL_KM * 1000} m of those jammed schools`, value: _people(kidsJam) },
        ];
        const picks = [];
        for (const i of jammed.slice().sort((a, b) => kidCol[b] - kidCol[a])) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1)) continue;
            picks.push(i);
        }
        picks.forEach((i, k) => stats.push({ label: `School street ${k + 1}: ${g.codes[i]}`, value: `${sch[i]} school${sch[i] > 1 ? 's' : ''}, gate road V/C ${_round(vcCol[i], 2)}, ${_people(kidCol[i])} children within ${SCHOOL_KM * 1000} m${pcu && _fin(pcu[i]) ? `, ${_people(pcu[i])} PCU/h` : ''}` }));
        return {
            columns: { school_gate_vc: vcCol, school_kids: kidCol }, idx: schools, weightKey: 'school_kids', noHotspots: true,
            metric: { label: 'Schools on a jammed road at the school run', value: share, unit: '%', higherIs: 'worse' },
            headline: `${share}% of the ${_people(nS)} mapped schools sit beside a road that is jammed (V/C ${JAM_VC}+) in the 9 am school run; ${_people(kidsJam)} children live within ${SCHOOL_KM * 1000} m of them. The top sites are candidates for school streets closed to through traffic at drop-off.`,
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
        { id: 'access', label: 'Access', metrics: ['metro', 'jobaccess', 'feeder', 'transit', 'busgap', 'ambulance'] },
        { id: 'flow', label: 'Traffic flow', metrics: ['traffic', 'jamcost', 'monsoon', 'parking'] },
        { id: 'safety', label: 'Safety & health', metrics: ['roadsafety', 'schoolrun', 'commute', 'noise', 'nightwalk', 'freight', 'cleanwalk'] },
        { id: 'walk', label: 'Walking & cycling', metrics: ['fifteen', 'shade', 'busheat', 'walk', 'cycling', 'crossing'] },
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

    // Recorded crashes. Bengaluru Traffic Police station-wise crash counts on its 2022 jurisdictions: where fatal crashes
    // are densest, and where they have risen since before the pandemic.
    const RISE_PCT = 25;

    function crashrecord(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], fk = c['road_crashes.fatal_per_km2'];
        const fy = c['road_crashes.fatal_yr'], cy = c['road_crashes.crashes_yr'], ch = c['road_crashes.fatal_change_pct'];
        if (!pop || !fk || !fy) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : NaN);
        const idx = [];
        for (let i = 0; i < n; i++) if (_fin(pop[i]) && pop[i] > 0 && _fin(fk[i])) idx.push(i);
        if (idx.length < 5) return null;
        const groups = new Map();       // one group per jurisdiction: identical counts
        for (const i of idx) {
            const k = `${v(cy, i)}|${v(fy, i)}`;
            const gr = groups.get(k) || { pop: 0, rep: i, best: 0 };
            gr.pop += pop[i];
            if (pop[i] > gr.best) { gr.best = pop[i]; gr.rep = i; }
            groups.set(k, gr);
        }
        const gs = [...groups.values()], fatal = gs.reduce((s, gr) => s + (v(fy, gr.rep) || 0), 0), all = gs.reduce((s, gr) => s + (v(cy, gr.rep) || 0), 0);
        const dens = gs.map(gr => fk[gr.rep]).sort((a, b) => a - b), hi = 2 * dens[(dens.length - 1) >> 1];
        const tot = _sumOver(pop, idx, () => true), pct = p => _round(100 * p / (tot || 1), 1);
        const pHi = _sumOver(pop, idx, i => fk[i] >= hi), pRise = ch ? _sumOver(pop, idx, i => v(ch, i) >= RISE_PCT) : 0;
        const stats = [
            { label: 'Traffic police jurisdictions with crash records', value: String(gs.length) },
            { label: 'Road crashes a year in them (2023-2025)', value: `${_people(all)}, ${_people(fatal)} fatal` },
            { label: `Residents where fatal crashes per km² are twice the median jurisdiction's (${_round(hi, 2)}+)`, value: `${_people(pHi)} (${pct(pHi)}%)` },
        ];
        if (ch) stats.push({ label: `Residents where fatal crashes rose ${RISE_PCT}%+ since 2018-2019`, value: `${_people(pRise)} (${pct(pRise)}%)` });
        gs.sort((a, b) => fk[b.rep] - fk[a.rep]).slice(0, 8).forEach((gr, k) => {
            const i = gr.rep;
            stats.push({ label: `Crash zone ${k + 1}, around ${g.codes[i]}`,
                value: `${_round(fk[i], 2)} fatal crashes a year per km²; ${_round(v(fy, i), 1)} fatal of ${_round(v(cy, i))} crashes a year${_fin(v(ch, i)) ? `; fatal ${v(ch, i) >= 0 ? '+' : ''}${_round(v(ch, i))}% since 2018-19` : ''}` });
        });
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = fk[i];
        return {
            columns: { fatal_per_km2: out }, idx, weightKey: 'fatal_per_km2', noHotspots: true,
            metric: { label: 'Fatal road crashes a year (police records)', value: _round(fatal), unit: 'crashes', higherIs: 'worse' },
            headline: `Police recorded about ${_people(all)} road crashes a year in 2023-2025, ${_people(fatal)} of them fatal; ${_people(pHi)} residents (${pct(pHi)}%) live where fatal crashes per km² are at least twice the median jurisdiction's${ch ? `, and ${_people(pRise)} where fatal crashes have risen ${RISE_PCT}% or more since 2018-2019` : ''}. Counts are per traffic police station, so every block in a jurisdiction shares its rate; through-traffic on highways and the ring road inflates the outer stations' totals.`,
            stats,
        };
    }

    // Anganwadi reach. Children under five walk (or are carried) to the anganwadi for meals, pre-school and immunisation;
    // the ICDS urban norm is a centre for every 400-800 people, within easy walking distance.
    const AWC_KM = 0.5, AWC_KIDS = 60;

    function anganwadi(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], awc = c['anganwadis.centres'];
        const kids = c['demographics.under5'], slum = c['slums_mapped.slum_pct'];
        if (!pop || !awc || !awc.some(v => v > 0)) return null;
        const idx = _residents(fr);
        if (idx.length < 5) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const tree = walkTree(fr, i => awc[i] > 0, 2 * AWC_KM);
        const kid = i => (kids && _fin(kids[i]) ? kids[i] : pop[i] * 0.08);
        const far = idx.filter(i => !(tree.dist[i] <= AWC_KM));
        const kAll = idx.reduce((a, i) => a + kid(i), 0), kFar = far.reduce((a, i) => a + kid(i), 0);
        const centres = idx.reduce((a, i) => a + v(awc, i), 0), pAll = _sumOver(pop, idx, () => true);
        const stats = [
            { label: 'Anganwadi centres mapped in lived-in blocks', value: _people(centres) },
            { label: 'Residents per centre (ICDS urban norm 400-800)', value: _people(pAll / Math.max(centres, 1)) },
            { label: `Children under 5 more than ${AWC_KM * 1000} m walk from one`, value: `${_people(kFar)} of ${_people(kAll)} (${_round(100 * kFar / (kAll || 1))}%)` },
        ];
        if (slum && far.some(i => v(slum, i) >= 20)) stats.push({ label: '…of them in blocks a fifth or more mapped slum', value: _people(far.filter(i => v(slum, i) >= 20).reduce((a, i) => a + kid(i), 0)) });
        const gap = new Float64Array(n);
        for (const i of far) gap[i] = kid(i);
        const need = within(g, gap, AWC_KM);
        const picks = [];
        for (const i of far.slice().sort((a, b) => need[b] - need[a])) {
            if (picks.length >= 5 || need[i] < AWC_KIDS) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 2 * AWC_KM)) continue;
            picks.push(i);
        }
        picks.forEach((i, k) => stats.push({ label: `New centre ${k + 1}: ${g.codes[i]}`, value: `${_people(need[i])} children under 5 within ${AWC_KM * 1000} m have none closer` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _fin(tree.dist[i]) ? _round(tree.dist[i] * 1000) : 2000 * AWC_KM;
        return {
            columns: { awc_walk_m: out }, idx, weightKey: 'awc_walk_m', noHotspots: true,
            metric: { label: `Children under 5 beyond a ${AWC_KM * 1000} m walk of an anganwadi`, value: _round(100 * kFar / (kAll || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(kFar)} children under five (${_round(100 * kFar / (kAll || 1))}%) live more than a ${AWC_KM * 1000} m walk from an anganwadi, and the city has one centre for every ${_people(pAll / Math.max(centres, 1))} residents (the ICDS urban norm is 400-800 people in the areas it serves). Centres come from the state's anganwadi map, which can lag openings and closures.`,
            stats,
        };
    }

    // Free clinic reach. The corporations' own primary care network (UPHCs, Namma Clinics, health centres): who lives more
    // than a 1 km walk from free primary care. Maps cover only the corporation or district, so only blocks within
    // COVER_KM of a listed centre are judged.
    const CLINIC_KM = 1, COVER_KM = 3, CLINIC_POP = 5000;

    function freeclinic(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], pc = c['public_care.primary'];
        const slum = c['slums_mapped.slum_pct'];
        if (!pop || !pc || !pc.some(v => v > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const cover = within(g, Float64Array.from({ length: n }, (_, i) => v(pc, i)), COVER_KM);
        const idx = _residents(fr).filter(i => cover[i] > 0);
        if (idx.length < 5) return null;
        const tree = walkTree(fr, i => pc[i] > 0, 2 * CLINIC_KM);
        const far = idx.filter(i => !(tree.dist[i] <= CLINIC_KM));
        const all = _sumOver(pop, idx, () => true), pFar = _sumOver(pop, far, () => true);
        const centres = idx.reduce((a, i) => a + v(pc, i), 0);
        const stats = [
            { label: 'Public primary care centres listed', value: _people(centres) },
            { label: 'Residents per centre in the area the list covers (NUHM norm: one UPHC per 50,000)', value: _people(all / Math.max(centres, 1)) },
            { label: `Residents more than a ${CLINIC_KM} km walk from one`, value: `${_people(pFar)} (${_round(100 * pFar / (all || 1))}%)` },
        ];
        if (slum && far.some(i => v(slum, i) >= 20)) stats.push({ label: '…in blocks a fifth or more mapped slum', value: _people(_sumOver(pop, far, i => v(slum, i) >= 20)) });
        const gap = new Float64Array(n);
        for (const i of far) gap[i] = pop[i];
        const need = within(g, gap, CLINIC_KM), picks = [];
        for (const i of far.slice().sort((a, b) => need[b] - need[a])) {
            if (picks.length >= 5 || need[i] < CLINIC_POP) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 2 * CLINIC_KM)) continue;
            picks.push(i);
        }
        picks.forEach((i, k) => stats.push({ label: `New clinic ${k + 1}: ${g.codes[i]}`, value: `${_people(need[i])} residents within ${CLINIC_KM} km have none closer` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _fin(tree.dist[i]) ? _round(tree.dist[i] * 1000) : 2000 * CLINIC_KM;
        return {
            columns: { clinic_walk_m: out }, idx, weightKey: 'clinic_walk_m', noHotspots: true,
            metric: { label: `Residents beyond a ${CLINIC_KM} km walk of free primary care`, value: _round(100 * pFar / (all || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(pFar)} residents (${_round(100 * pFar / (all || 1))}%) of the area the corporation's clinic list covers live more than a ${CLINIC_KM} km walk from a free public primary care centre. Private clinics and hospitals are not counted, and blocks more than ${COVER_KM} km from any listed centre are left out because the list may not cover them.`,
            stats,
        };
    }

    // Subsidised canteens. Indira Canteens, Amma Unavagams and Annapurna centres sell a meal for ₹1-10 to whoever walks
    // in, mostly daily-wage workers. Who lives more than a MEAL_KM walk from one, and how many of them in mapped slums.
    const MEAL_KM = 1, MEAL_POP = 5000;

    function canteen(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], ct = c['canteens.canteens'];
        const slum = c['slums_mapped.slum_pct'];
        if (!pop || !ct || !ct.some(v => v > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0);
        const cover = within(g, Float64Array.from({ length: n }, (_, i) => v(ct, i)), COVER_KM);
        const idx = _residents(fr).filter(i => cover[i] > 0);
        if (idx.length < 5) return null;
        const tree = walkTree(fr, i => ct[i] > 0, 2 * MEAL_KM);
        const far = idx.filter(i => !(tree.dist[i] <= MEAL_KM));
        const all = _sumOver(pop, idx, () => true), pFar = _sumOver(pop, far, () => true);
        const sl = i => v(pop, i) * Math.min(100, v(slum, i)) / 100;
        const stats = [
            { label: 'Subsidised canteens listed', value: _people(idx.reduce((a, i) => a + v(ct, i), 0)) },
            { label: 'Residents per canteen in the area the list covers', value: _people(all / Math.max(idx.reduce((a, i) => a + v(ct, i), 0), 1)) },
            { label: `Residents more than a ${MEAL_KM} km walk from one`, value: `${_people(pFar)} (${_round(100 * pFar / (all || 1))}%)` },
        ];
        if (slum && idx.some(i => v(slum, i) > 0)) {
            const sAll = idx.reduce((a, i) => a + sl(i), 0), sFar = far.reduce((a, i) => a + sl(i), 0);
            stats.push({ label: `Slum residents more than a ${MEAL_KM} km walk from one`, value: `${_people(sFar)} of ${_people(sAll)} (${_round(100 * sFar / (sAll || 1))}%)` });
        }
        const gap = new Float64Array(n), farPop = new Float64Array(n);
        for (const i of far) { gap[i] = pop[i] + sl(i); farPop[i] = pop[i]; }
        const need = within(g, gap, MEAL_KM), reach = within(g, farPop, MEAL_KM), picks = [];
        for (const i of far.slice().sort((a, b) => need[b] - need[a])) {
            if (picks.length >= 5 || need[i] < MEAL_POP) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 2 * MEAL_KM)) continue;
            picks.push(i);
        }
        picks.forEach((i, k) => stats.push({ label: `New canteen ${k + 1}: ${g.codes[i]}`, value: `${_people(reach[i])} residents within ${MEAL_KM} km have none closer` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _fin(tree.dist[i]) ? _round(tree.dist[i] * 1000) : 2000 * MEAL_KM;
        return {
            columns: { canteen_walk_m: out }, idx, weightKey: 'canteen_walk_m', noHotspots: true,
            metric: { label: `Residents beyond a ${MEAL_KM} km walk of a subsidised canteen`, value: _round(100 * pFar / (all || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(pFar)} residents (${_round(100 * pFar / (all || 1))}%) of the area the canteen list covers live more than a ${MEAL_KM} km walk from a subsidised public canteen. Lists date from 2018-2023, so some canteens may have closed or opened since.`,
            stats,
        };
    }

    // Sewer gaps. Where the water board has laid no sewer in or next to a block, homes drain to septic tanks, soak pits or open
    // drains that foul lakes and groundwater. A block is unsewered when no sewer runs within SEWER_NEAR_KM, and thin
    // when sewers run along under THIN_PCT of its street length. Judged within SERVICE_KM of the mapped network.
    const SEWER_NEAR_KM = 0.25, THIN_PCT = 30, SERVICE_KM = 2;

    function sewergap(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], sw = c['sewers.sewer_m'];
        const road = c['osm_roads.road_km_km2'], slum = c['slums_mapped.slum_pct'];
        if (!pop || !sw || !sw.some(v => v > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0), area = g.dx * g.dy;
        const swArr = Float64Array.from({ length: n }, (_, i) => v(sw, i));
        const svc = within(g, swArr, SERVICE_KM), near = within(g, swArr, SEWER_NEAR_KM);
        const idx = _residents(fr).filter(i => svc[i] > 0);
        if (idx.length < 5) return null;
        const pct = i => (road && v(road, i) > 0 ? Math.min(100, 100 * v(sw, i) / (v(road, i) * area * 1000)) : NaN);
        const none = idx.filter(i => !(near[i] > 0)), thin = idx.filter(i => near[i] > 0 && pct(i) < THIN_PCT);
        const all = _sumOver(pop, idx, () => true), pNone = _sumOver(pop, none, () => true), pThin = _sumOver(pop, thin, () => true);
        const stats = [
            { label: 'Sewer lines mapped', value: `${_people(swArr.reduce((a, x) => a + x, 0) / 1000)} km` },
            { label: `Residents with no sewer within ${SEWER_NEAR_KM * 1000} m`, value: `${_people(pNone)} (${_round(100 * pNone / (all || 1))}%)` },
            { label: `Residents with a sewer nearby but along under ${THIN_PCT}% of their streets`, value: `${_people(pThin)} (${_round(100 * pThin / (all || 1))}%)` },
        ];
        if (slum && none.some(i => v(slum, i) > 0)) stats.push({ label: 'Mapped slum residents with no sewer nearby', value: _people(none.reduce((a, i) => a + v(pop, i) * Math.min(100, v(slum, i)) / 100, 0)) });
        const gapPop = Float64Array.from({ length: n }, (_, i) => (near[i] > 0 ? 0 : v(pop, i)));
        const need = within(g, gapPop, 0.5), picks = [];
        for (const i of none.slice().sort((a, b) => need[b] - need[a])) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1.5)) continue;
            picks.push(i);
        }
        picks.forEach((i, k) => stats.push({ label: `Sewer next ${k + 1}: ${g.codes[i]}`, value: `${_people(need[i])} residents within 500 m with no sewer close by` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = near[i] > 0 ? (_fin(pct(i)) ? _round(pct(i)) : 100) : 0;
        return {
            columns: { sewer_cover_pct: out }, idx, weightKey: 'sewer_cover_pct', noHotspots: true,
            metric: { label: `Residents with no sewer within ${SEWER_NEAR_KM * 1000} m`, value: _round(100 * pNone / (all || 1), 1), unit: '%', higherIs: 'worse' },
            headline: `${_people(pNone)} residents (${_round(100 * pNone / (all || 1))}%) in the area the water board's sewer maps cover have no sewer line within ${SEWER_NEAR_KM * 1000} m, and ${_people(pThin)} more live where sewers run along under ${THIN_PCT}% of the streets; these homes rely on septic tanks, soak pits or open drains. The maps may lag lines laid recently in the city's added areas.`,
            stats,
        };
    }

    // Street light poles. BBMP's pole survey says how densely streets are lit: lamps every 30-40 m on main roads and up
    // to ~60 m on lanes means 15 or more poles per km of street, so a block under DIM_POLES per road km has dark
    // stretches. Judged only on surveyed ground (SURVEY_SHARE of lived-in blocks within 500 m have listed poles).
    const DIM_POLES = 15, SURVEY_SHARE = 0.75;

    function streetpoles(fr) {
        const g = fr.grid, c = fr.cols, n = g.n, pop = c['population.population'], pl = c['street_lights.poles'], led = c['street_lights.led'];
        const road = c['osm_roads.road_km_km2'];
        if (!pop || !pl || !road || !pl.some(v => v > 0)) return null;
        const v = (a, i) => (a && _fin(a[i]) ? a[i] : 0), area = g.dx * g.dy;
        const has = Float64Array.from({ length: n }, (_, i) => (v(pop, i) > 0 && v(pl, i) > 0 ? 1 : 0));
        const lived = Float64Array.from({ length: n }, (_, i) => (v(pop, i) > 0 ? 1 : 0));
        const hN = within(g, has, 0.5), lN = within(g, lived, 0.5);
        const idx = [];
        for (let i = 0; i < n; i++) if (v(pop, i) > 0 && v(road, i) > 0 && lN[i] > 0 && hN[i] / lN[i] >= SURVEY_SHARE) idx.push(i);
        if (idx.length < 5) return null;
        const km = i => v(road, i) * area, per = i => v(pl, i) / km(i);
        const poles = idx.reduce((a, i) => a + v(pl, i), 0), roadKm = idx.reduce((a, i) => a + km(i), 0);
        const dim = idx.filter(i => per(i) < DIM_POLES), all = _sumOver(pop, idx, () => true), pDim = _sumOver(pop, dim, () => true);
        const stats = [
            { label: 'Street light poles listed (surveyed blocks)', value: _people(poles) },
            { label: 'Poles per km of street', value: String(_round(poles / (roadKm || 1), 1)) },
            { label: `Residents in blocks under ${DIM_POLES} poles per street km`, value: `${_people(pDim)} (${_round(100 * pDim / (all || 1))}%)` },
            { label: 'Street km in those blocks', value: `${_people(dim.reduce((a, i) => a + km(i), 0))} km` },
        ];
        if (led) stats.push({ label: 'Poles with LED lamps', value: `${_round(100 * idx.reduce((a, i) => a + v(led, i), 0) / (poles || 1))}%` });
        const need = Float64Array.from({ length: n }, (_, i) => (per(i) < DIM_POLES ? v(pop, i) * (DIM_POLES - per(i)) : 0));
        const picks = [];
        for (const i of dim.slice().sort((a, b) => need[b] - need[a])) {
            if (picks.length >= 5) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < 1)) continue;
            picks.push(i);
        }
        picks.forEach((i, k) => stats.push({ label: `Light here ${k + 1}: ${g.codes[i]}`,
            value: `${_round(per(i), 1)} poles per street km over ${_round(km(i), 1)} km of street; ${_people(v(pop, i))} residents` }));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = _round(per(i), 1);
        return {
            columns: { poles_per_km: out }, idx, weightKey: 'poles_per_km', noHotspots: true,
            metric: { label: 'Street light poles per km of street', value: _round(poles / (roadKm || 1), 1), unit: 'poles/km', higherIs: 'better' },
            headline: `BBMP's survey lists ${_people(poles)} street light poles here, ${_round(poles / (roadKm || 1), 1)} per km of mapped street; ${_people(pDim)} residents (${_round(100 * pDim / (all || 1))}%) live in blocks with under ${DIM_POLES} per km, where stretches go dark. Only four of BBMP's eight zones are mapped, and a listed pole may not be working.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'streetpoles', equity: true, title: 'Street light poles', icon: '💡',
            question: 'Which streets have too few light poles to be lit at night?',
            field: { key: 'poles_per_km', label: 'Street light poles per km of street', unit: 'poles/km', higherIs: 'better', ramp: 'viridis', domain: [0, 40] },
            needs: ['street_lights.poles', 'street_lights.led', 'osm_roads.road_km_km2', 'population.population'],
            method: `BBMP's 2024 street light pole maps on data.opencity.in (public domain) for Bangalore East, RR Nagar, Bommanahalli and Dasarahalli zones (about 1.9 lakh distinct poles, with lamp type), counted per block and divided by the block's OpenStreetMap street length. A block under ${DIM_POLES} poles per street km has gaps longer than the 30-60 m spacing urban lighting codes use. Blocks are judged only where ${SURVEY_SHARE * 100}% of the lived-in blocks within 500 m have listed poles, since the other zones are not mapped. Picks rank dim blocks by residents times the pole shortfall, 1 km apart. Pole counts say nothing about lamps that are out; VIIRS night light (Night walk lens) shows what actually glows.`,
            refs: 'BBMP street light survey 2024 (OpenCity); OpenStreetMap; IS 1944 / NBC street lighting spacing' },
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
        { id: 'crashrecord', equity: true, title: 'Recorded road crashes', icon: '🚑',
            question: 'Where do the police record the most fatal road crashes, and where are they rising?',
            field: { key: 'fatal_per_km2', label: 'Fatal road crashes a year per km² (traffic police jurisdiction)', unit: '/km²/yr', higherIs: 'worse', ramp: 'reds', domain: [0, 3] },
            needs: ['road_crashes.fatal_per_km2', 'road_crashes.fatal_yr', 'road_crashes.crashes_yr', 'road_crashes.fatal_change_pct', 'population.population'],
            method: `Bengaluru Traffic Police station-wise crash tables for 2018-2025 and its 2022 jurisdiction map, both public domain on data.opencity.in. Each lived-in block takes its jurisdiction's crashes and fatal crashes a year (2023-2025 mean) and the fatal count per km²; stations opened since 2022 (Mahadevapura, Bellanduru, JP Nagar, Thalagattapura, Jnanabharathi, Kodigehalli) are added to the jurisdiction they were carved from, so the change against 2018-2019 compares like with like. 'Twice the median' uses the median jurisdiction's fatal crashes per km². Bengaluru only; no other city in DISHA publishes station-wise crash counts with a jurisdiction map.`,
            refs: 'Bengaluru Traffic Police station-wise road crash data 2018-2025 and jurisdiction map 2022 (data.opencity.in); MoRTH Road Accidents in India 2024; WHO 2023 Global status report on road safety' },
        { id: 'anganwadi', equity: true, title: 'Anganwadi reach', icon: '🍼',
            question: 'Which young children live too far from an anganwadi?',
            field: { key: 'awc_walk_m', label: 'Walk to the nearest anganwadi', unit: 'm', higherIs: 'worse', ramp: 'reds', domain: [0, 1000] },
            needs: ['anganwadis.centres', 'demographics.under5', 'slums_mapped.slum_pct', 'osm_walk.links', 'population.population'],
            method: `Anganwadi (ICDS) centres from the state and city maps on data.opencity.in: Telangana for Hyderabad, Karnataka (KGIS) for Bengaluru, and Greater Chennai (2023). Children under 5 are WorldPop's under-5 count (8% of residents where missing). The walk follows the OpenStreetMap walking network between blocks, out to ${2 * AWC_KM} km. New-centre picks are blocks with at least ${AWC_KIDS} unserved children under 5 within ${AWC_KM * 1000} m, ${2 * AWC_KM} km apart. The ICDS urban norm is one centre per 400-800 people in the areas it serves, so the city-wide ratio overstates the gap where better-off homes do not use it. Chennai's map covers the corporation only, so suburbs such as Pallavaram show as gaps; the maps can lag openings and closures.`,
            refs: 'Integrated Child Development Services (Ministry of Women and Child Development) population norms; Saksham Anganwadi and Poshan 2.0 guidelines 2022; OpenCity anganwadi maps' },
        { id: 'canteen', equity: true, title: 'Subsidised canteen reach', icon: '🍛',
            question: 'Who lives far from a cheap public canteen?',
            field: { key: 'canteen_walk_m', label: 'Walk to the nearest subsidised canteen', unit: 'm', higherIs: 'worse', ramp: 'reds', domain: [0, 2000] },
            needs: ['canteens.canteens', 'slums_mapped.slum_pct', 'osm_walk.links', 'population.population'],
            method: `Subsidised canteens from the city maps on data.opencity.in (public domain): Indira Canteens in Bengaluru (KGIS, 2022), Amma Unavagams in Chennai (GCC, 2023) and Annapurna meal centres in Hyderabad (GHMC, 2018). The walk follows the OpenStreetMap walking network; blocks more than ${COVER_KM} km from any listed canteen are left out, as each list covers only its corporation. New-canteen picks are blocks, ${2 * MEAL_KM} km apart, with the most residents beyond a ${MEAL_KM} km walk nearby, counting slum residents twice.`,
            refs: 'Indira Canteen scheme (Karnataka, 2017); Amma Unavagam (Tamil Nadu, 2013); Annapurna meals (GHMC, 2014); OpenCity canteen maps' },
        { id: 'sewergap', equity: true, title: 'Sewer gaps', icon: '🚽',
            question: 'Which neighbourhoods have no sewer line nearby?',
            field: { key: 'sewer_cover_pct', label: 'Sewer length as a share of street length (0 = none within 250 m)', unit: '%', higherIs: 'better', ramp: 'blues', domain: [0, 100] },
            needs: ['sewers.sewer_m', 'osm_roads.road_km_km2', 'slums_mapped.slum_pct', 'population.population'],
            method: `BWSSB sewerage line maps (KGIS, about 10,400 km) for Bengaluru and CMWSSB's sewer main network (about 4,200 km) for Chennai on data.opencity.in (public domain), all diameters: each line is cut into 25 m pieces and summed per block. A block is unsewered when no sewer runs in it or within ${SEWER_NEAR_KM * 1000} m, and thin when its sewer length is under ${THIN_PCT}% of its OpenStreetMap street length. Blocks more than ${SERVICE_KM} km from any mapped sewer are not judged. Picks are unsewered blocks 1.5 km apart with the most unserved residents within 500 m. Bengaluru and Chennai.`,
            refs: 'BWSSB sewerage network (KGIS) and CMWSSB sewer main network via OpenCity; CPHEEO Manual on Sewerage and Sewage Treatment (2013); AMRUT 2.0' },
        { id: 'freeclinic', equity: true, title: 'Free clinic reach', icon: '🏥',
            question: 'Who lives far from a free public clinic?',
            field: { key: 'clinic_walk_m', label: 'Walk to the nearest public primary care centre', unit: 'm', higherIs: 'worse', ramp: 'reds', domain: [0, 2000] },
            needs: ['public_care.primary', 'slums_mapped.slum_pct', 'osm_walk.links', 'population.population'],
            method: `Public primary care centres from the corporations' maps on data.opencity.in: Greater Chennai UPHCs, Hyderabad district health centres, and BBMP UPHCs with Namma Clinics (2026) for Bengaluru. Mumbai City's maps round locations to about 1 km, too coarse for this. The walk follows the OpenStreetMap walking network out to ${2 * CLINIC_KM} km; only blocks within ${COVER_KM} km of a listed centre are judged, since the maps cover only the corporation or district. New-clinic picks need ${_people(CLINIC_POP)}+ unserved residents within ${CLINIC_KM} km, ${2 * CLINIC_KM} km apart. The National Urban Health Mission norm is one UPHC per 50,000 people.`,
            refs: 'National Urban Health Mission framework (2013); Namma Clinic (Karnataka, 2022); OpenCity health facility maps' },
        { id: 'busgap', equity: true, title: 'Bus gaps on busy roads', icon: '🚌',
            question: 'Which busy commute corridors have no frequent bus?',
            field: { key: 'corridor_pcu', label: 'Peak-hour traffic on the nearest busy arterial', unit: 'PCU/h', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'bus_hr', label: 'Buses per hour within 400 m (07–10 h)', unit: 'per hour', higherIs: 'better', ramp: 'viridis' }],
            needs: ['traffic_load.peak_pcu', 'bus_service.peak_departures_hr', 'osm_transit.stops', 'osm_transit.rapid', 'wealth.rwi'],
            method: `Busy corridors are arterials in the top fifth of modelled peak-hour traffic (demand model PCU); a home within ${ROAD_KM * 1000} m of one counts as beside it. Served means a bus every ${60 / BUS_FREQ_HR} minutes or better within ${BUS_KM * 1000} m in the 07–10 h timetable (cities with open GTFS, currently Bengaluru and Hyderabad), or any mapped bus stop within ${BUS_KM * 1000} m elsewhere, or a rail/metro/BRT station within 800 m. Gaps are where car traffic is heavy and buses are not: candidates for new or more frequent routes.`,
            refs: 'Demand model (pipeline/traffic/demand_model.py); GTFS (BMTC, Vonter; TGSRTC, Telangana open data via OpenCity); MoHUA 2017 Metro Rail Policy (feeder bus within 500 m); ITDP BRT Standard' },
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
        { id: 'jobaccess', equity: true, title: 'Jobs within 45 minutes', icon: '💼',
            question: 'How much of the city can people reach for work in 45 minutes, by car versus by train and walking?',
            field: { key: 'jobs_transit', label: 'Jobs within 45 min by train and walking', unit: '%', higherIs: 'better', ramp: 'viridis' },
            extra: [{ key: 'jobs_car_gap', label: 'Car advantage (car minus train share)', unit: 'pts', higherIs: 'worse', ramp: 'reds' }],
            needs: ['job_access.jobs_car_pct', 'job_access.jobs_transit_pct', 'wealth.rwi'],
            method: `Cumulative-opportunity accessibility over the demand model's ~1 km zones: the share of the city's jobs and activities (GHSL non-residential floor space plus OpenStreetMap amenities) reachable within ${JOB_MIN} minutes. Car: walk-speed access to the nearest arterial, then the 9 am congested arterial times (BPR). Train: walk to the nearest metro or rail station within 20 minutes, a 5-minute wait, 33 km/h over the straight line × 1.25 to the station nearest the destination, and walk out; or walk all the way. Every station is assumed connected and buses are left out, so the train figure is an upper bound for rail and a lower bound for all public transport.`,
            refs: 'Hansen 1959 (accessibility); Geurs & van Wee 2004; Overture Maps Foundation places; GHSL 2023' },
        { id: 'busheat', equity: true, title: 'Heat at bus stops', icon: '🚏',
            question: 'Which bus stops leave people waiting in the sun, and where would a shelter or trees help most?',
            field: { key: 'shelter_priority', label: 'Shelter / tree priority', unit: 'score', higherIs: 'worse', ramp: 'reds' },
            extra: [{ key: 'stop_heat', label: 'Surface temperature at the stops', unit: '°C', higherIs: 'worse', ramp: 'heat' }],
            needs: ['bus_stop_heat.stops', 'bus_stop_heat.hot_bare_stops', 'bus_stop_heat.shelter_priority', 'bus_stop_heat.stop_lst_c', 'wealth.rwi'],
            method: `Bus stops are OpenStreetMap highway=bus_stop, open GTFS stops (Bengaluru BMTC, Hyderabad TGSRTC) and Overture Maps bus stations, merged within 30 m; in other cities the open map lists only part of the network until OpenStreetMap stops are pulled on the next data refresh. Each stop takes the Landsat summer daytime surface temperature and the tree canopy of its cell. Hot and bare is ${STOP_HOT}+ °C with under ${STOP_BARE}% canopy. The priority score is residents within about a 5-minute walk × degrees above 35 °C × the unshaded share. Surface temperature is not air temperature, and 30 m canopy misses single trees and shelter roofs.`,
            refs: 'OpenStreetMap; BMTC GTFS (Vonter, ODbL); TGSRTC GTFS (Telangana open data); Overture Maps Foundation places; Landsat 8/9 surface temperature; Lanza & Durand 2021 (heat and transit waiting)' },
        { id: 'parking', equity: false, title: 'Parking pressure', icon: '🅿️',
            question: 'Where do more vehicles arrive than the kerbs and lots can hold?',
            field: { key: 'park_pressure', label: 'Parking pressure (demand / spaces)', unit: '×', higherIs: 'worse', ramp: 'reds' },
            extra: [{ key: 'park_overflow', label: 'Vehicles with no space', unit: 'car spaces', higherIs: 'worse', ramp: 'heat' }],
            needs: ['parking.pressure', 'parking.demand_ecs', 'parking.supply_ecs', 'rail_access.rail_walk_min'],
            method: 'Demand is the traffic model\'s trip attraction (GHSL non-residential floor space and OpenStreetMap amenities): half of the city\'s 0.9 motorised trips per resident end away from home, cars (15% at 1.6 people) and two-wheelers (40% at 1.2, a quarter of a car bay each) in equivalent car spaces, 60% of them parked at once late in the morning. Supply is usable kerb on local and secondary streets (both sides, a bay every 5.5 m, 40% usable after junctions, driveways and no-parking stretches) plus Overture parking lots at 40 spaces each; main roads are left out. Indicative: no parking surveys or occupancy counts, and open data maps few off-street lots.',
            refs: 'IRC SP 12 (parking norms); MoHUA 2016 National Urban Transport Policy parking guidance; Overture Maps Foundation places; GHSL 2023' },
        { id: 'feeder', equity: true, title: 'Metro last mile', icon: '🚌',
            question: 'Who lives too far to walk to a metro station and has no bus stop nearby to get there?',
            field: { key: 'feeder_gap', label: 'Residents with no bus stop in feeder range', unit: 'people', higherIs: 'worse', ramp: 'reds' },
            extra: [{ key: 'station_walk_min', label: 'Walk to the nearest station', unit: 'min', higherIs: 'worse', ramp: 'heat' }],
            needs: ['rail_access.metro_walk_min', 'rail_access.rail_walk_min', 'bus_stop_heat.stops', 'osm_transit.stops', 'bus_service.stops', 'wealth.rwi'],
            method: `The feeder range is homes ${STATION_WALK}–${FEEDER_MAX} minutes on foot from the nearest metro station (any rail station where the city has no metro): too far to walk comfortably, close enough for a feeder bus, shared auto or bicycle. A home counts as served when a mapped bus stop (OpenStreetMap, open GTFS or Overture) is within about ${STOP_KM * 1000} m. Feeder stops are picked greedily, 1.5 km apart, by unserved residents within 800 m. Stop lists outside Bengaluru and Hyderabad are partial until OpenStreetMap stops are pulled on the next data refresh, so gaps are upper bounds there; shared autos and e-rickshaws are not mapped.`,
            refs: 'Overture Maps Foundation; OpenStreetMap; BMTC GTFS; MoHUA 2017 Metro Rail Policy (last-mile connectivity within 5 km)' },
        { id: 'commute', equity: true, title: 'Commute length and carbon', icon: '🌍',
            question: 'How far do people travel from each neighbourhood, and what does it emit?',
            field: { key: 'trip_km', label: 'Average motorised trip from home', unit: 'km', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'co2_kg_year', label: 'Transport CO2 per resident', unit: 'kg/year', higherIs: 'worse', ramp: 'reds' }],
            needs: ['commute_carbon.trip_km', 'commute_carbon.co2_kg_day', 'wealth.rwi'],
            method: 'The traffic model\'s morning trips (gravity on arterial travel times, trips within the ~1 km home zone included) give each zone a trip-weighted mean distance (straight line × 1.3). CO2 is 0.9 motorised trips a day × that distance × the model\'s city-wide mode mix (two-wheelers 40%, cars 15%, autos 15%, buses 30%; about 0.036 kg CO2 per person-km, tailpipe). With one mode mix for the whole city, the map shows the cost of distance between homes and activity, not of car ownership; walking and cycling trips are left out.',
            refs: 'Hansen 1959; Ewing & Cervero 2010 (travel and the built environment); ICCT India emission factors; ARAI 2008' },
        { id: 'jamcost', equity: false, title: 'Cost of congestion', icon: '⏱️',
            question: 'How many hours and rupees does traffic congestion cost the city each day?',
            field: { key: 'jam_hours', label: 'Vehicle-hours of delay a day', unit: 'PCU-h/day', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'jam_cost', label: 'Cost of the delay', unit: '₹ lakh/year', higherIs: 'worse', ramp: 'reds' }],
            needs: ['traffic_load.peak_vc', 'traffic_load.peak_speed_kmh', 'traffic_load.delay_pct', 'traffic_load.daily_vkm'],
            method: 'Each road cell\'s daily vehicle-km (PCU) is spread over the day with the model\'s hourly profile; each hour\'s volume/capacity is the peak V/C scaled by that hour\'s share, and its delay is the BPR travel-time factor (1 + 0.15·(V/C)⁴, at most 4×) minus one, at the cell\'s free-flow speed. Person-hours use 2.7 people per PCU (the model\'s mode mix); cost is ₹100 an hour of people\'s time plus 0.4 litres of fuel per PCU-hour at ₹100, over 300 working days. Arterials only: side streets and junction signals are not modelled, so this is a floor. The map caps cells at the city\'s 95th percentile.',
            refs: 'BPR (1964); IRC SP 30 (value of travel time); TomTom Traffic Index for comparison; Boston Consulting Group 2018 (Indian congestion costs)' },
        { id: 'tod', equity: false, title: 'Transit-oriented development', icon: '🏙️',
            question: 'How densely are metro station areas built, and where is low-rise land next to a station?',
            field: { key: 'tod_gap', label: 'Floor area ratio short of the TOD target', unit: 'FAR', higherIs: 'worse', ramp: 'reds' },
            extra: [{ key: 'station_far', label: 'Floor area ratio near stations (approx.)', unit: 'FAR', higherIs: 'better', ramp: 'viridis' }],
            needs: ['rail_access.metro_walk_min', 'built_up.volume_m3_m2', 'built_up.built_pct', 'population.population'],
            method: `Station areas are built-up cells (at least ${TOD_BUILT}% built) within a ${STATION_WALK}-minute walk of a metro station. Floor area ratio is approximated as GHSL built volume per m² of land ÷ ${STOREY_M} m a storey. Low-rise is FAR under ${TOD_LOW}; the target is FAR ${TOD_TARGET}, inside the 3–5 range the 2017 National TOD Policy suggests for station influence zones. TOD sites are the lowest-FAR station cells, 1 km apart. Parks, heritage zones, airports and defence land are not masked, so check sites against the master plan.`,
            refs: 'MoHUA 2017 National Transit Oriented Development Policy; Cervero & Kockelman 1997 (3Ds); GHSL 2023 built-up volume' },
        { id: 'schoolrun', equity: false, title: 'School-run traffic', icon: '🎒',
            question: 'Which schools sit on roads jammed at drop-off, and where would a school street help most?',
            field: { key: 'school_gate_vc', label: 'Busiest road at the school gate, 9 am (V/C)', unit: 'V/C', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'school_kids', label: 'Children living within 800 m', unit: 'children', higherIs: 'worse', ramp: 'reds' }],
            needs: ['emergency_access.schools', 'traffic_load.am_vc', 'traffic_load.peak_vc', 'traffic_load.peak_pcu', 'demographics.children_pct'],
            method: `Schools are Overture Maps places tagged as schools (confidence ≥ 0.6). The gate road is the busiest modelled arterial within about ${SCHOOL_GATE_KM * 1000} m in the 09:00 hour, close to the 8–9 am school run. Jammed is V/C ${JAM_VC}+ (LOS E/F), busy ${SCHOOL_BUSY_VC}–${JAM_VC}. Children are residents within ${SCHOOL_KM * 1000} m × WorldPop's district child share (${KIDS_PCT}% where missing). The model has no school-trip purpose and no side streets, so drop-off queues on lanes are not seen; the top sites are where a school street (no through traffic at drop-off and pick-up) or staggered timings are worth a site visit.`,
            refs: 'Overture Maps Foundation places; WorldPop 2020 age structure; Hopkinson et al. 2021 (school streets, London); Bloomberg Philanthropies child-friendly street guidance' },
        { id: 'ev', equity: false, title: 'EV charging gaps', icon: '🔌',
            question: 'How far are homes and traffic from a known public EV charger?',
            field: { key: 'ev_km', label: 'Distance to the nearest known charger', unit: 'km', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'ev_gap', label: 'Vehicle-km within 1 km with no charger in 2 km', unit: 'veh-km/day', higherIs: 'worse', ramp: 'reds' }],
            needs: ['ev_charging.charger_km', 'ev_charging.chargers', 'ev_charging.parking', 'ev_charging.fuel', 'traffic_load.daily_vkm'],
            method: `Known public chargers are OpenStreetMap, Overture Maps and (when keyed) Open Charge Map points; open data lists only part of India's network, so distances are upper bounds and counts lower bounds. The gap layer is daily vehicle-km from the demand model within 1 km of each cell, where the nearest known charger is more than ${EV_NEAR_KM} km away. Use the EV siting preset for ranked sites.`,
            refs: 'Overture Maps Foundation places; OpenStreetMap amenity=charging_station; Open Charge Map; MoP 2024 guidelines for EV charging infrastructure (a charger every 3 km in cities)' },
    ];

    UrbanLenses.register(ENTRIES, { noise, traffic, ambulance, metro, jobaccess, busheat, parking, feeder, commute, jamcost, tod, schoolrun, ev, shade, busgap, roadsafety, cycling, nightwalk, crossing, freight, cleanwalk, crashrecord, anganwadi, freeclinic, streetpoles, canteen, sewergap }, { stationSites, stationWhatIf, stationAsk, walkTree, walkerLoad, routeMax, routeDose, fatalRisk, scorecard, scorecardText, MOBILITY_PILLARS: PILLARS });
    return { ENTRIES, stationSites, stationWhatIf, stationAsk };
})();

if (typeof window !== 'undefined') {
    window.UrbanLensesMobility = UrbanLensesMobility;
}
