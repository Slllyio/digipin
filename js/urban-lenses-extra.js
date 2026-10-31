/**
 * Further lenses for UrbanLenses: research and official layers added after urban-lenses-wards.js reached the 150 kB
 * per-module budget (first: Greater Chennai liquefaction susceptibility). Registers itself on load, after urban-lenses.js.
 */
const UrbanLensesExtra = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _residents, wmean, wquantile } = UrbanLenses._kit;

    // Ground that could liquefy. A published first-level assessment of Greater Chennai scores 20 m pixels for liquefaction
    // susceptibility (lithology, landform, groundwater and bedrock depth) and overlays amplified shaking into a hazard class.
    function liquefy(fr) {
        const c = fr.cols, n = fr.grid.n, likely = c['liquefaction.lq_likely_pct'], poss = c['liquefaction.lq_possible_pct'];
        const high = c['liquefaction.sh_high_pct'], pop = c['population.population'];
        if (!likely || !likely.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(likely[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((s, i) => s + pop[i], 0) || 1;
        const sum = pred => idx.filter(pred).reduce((s, i) => s + pop[i], 0), pct = x => _round(100 * x / P, 0);
        const mostly = sum(i => likely[i] >= 50), any = sum(i => likely[i] + (poss && _fin(poss[i]) ? poss[i] : 0) >= 50);
        const hazard = high ? sum(i => _fin(high[i]) && high[i] >= 50) : NaN;
        const stats = [
            { label: 'Residents in blocks mostly on ground where liquefaction is likely', value: `${_people(mostly)} (${pct(mostly)}%)` },
            { label: 'Residents in blocks mostly on ground where it is likely or possible', value: `${_people(any)} (${pct(any)}%)` },
            { label: 'Residents in blocks mostly in the high seismic hazard class', value: _fin(hazard) ? `${_people(hazard)} (${pct(hazard)}%)` : 'n/a' },
            { label: 'Share of ground likely to liquefy (residents-weighted)', value: `${_round(wmean(likely, pop, idx), 0)}%` },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = likely[i];
        return {
            columns: { liquefy_likely_pct: out }, idx, weightKey: 'liquefy_likely_pct',
            metric: { label: 'Residents in blocks mostly on ground likely to liquefy', value: pct(mostly), unit: '%', higherIs: 'worse' },
            headline: `${_people(mostly)} residents here (${pct(mostly)}%) live in blocks mostly on ground a published assessment rates likely to liquefy in a strong earthquake${_fin(hazard) ? `, and ${pct(hazard)}% in blocks mostly in its high seismic hazard class` : ''}. Chennai is in seismic zone III, so this is about how the ground would behave, not how likely a quake is.`,
            stats,
        };
    }

    // Counted junction traffic. BBMP's 2024 traffic infrastructure plan counted vehicles turning through 28 junctions on
    // its study corridors; each nearby block takes its nearest counted junction's busier peak hour.
    function junctions(fr) {
        const c = fr.cols, n = fr.grid.n, veh = c['junction_counts.jc_peak_veh'], km = c['junction_counts.jc_km'];
        const daily = c['junction_counts.jc_daily_veh'], pop = c['population.population'];
        if (!veh || !veh.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(veh[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((s, i) => s + pop[i], 0) || 1;
        const sum = pred => idx.filter(pred).reduce((s, i) => s + pop[i], 0), pct = x => _round(100 * x / P, 0);
        const heavy = sum(i => veh[i] >= 12000), close = sum(i => veh[i] >= 12000 && _fin(km[i]) && km[i] <= 0.5);
        const top = Math.max(...idx.map(i => veh[i])), dmax = daily ? Math.max(...idx.filter(i => _fin(daily[i])).map(i => daily[i])) : NaN;
        const stats = [
            { label: 'Residents near a junction carrying 12,000+ vehicles in its peak hour', value: `${_people(heavy)} (${pct(heavy)}%)` },
            { label: 'Of them, within 500 m of it', value: `${_people(close)} (${pct(close)}%)` },
            { label: 'Busiest counted junction near here (vehicles in the peak hour)', value: _round(top, 0).toLocaleString('en-IN') },
            { label: 'Busiest 24-hour count near here (vehicles a day)', value: _fin(dmax) ? _round(dmax, 0).toLocaleString('en-IN') : 'n/a' },
            { label: 'Peak hour vehicles at the nearest counted junction (residents-weighted)', value: _round(wmean(veh, pop, idx), 0).toLocaleString('en-IN') },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = veh[i];
        return {
            columns: { junction_peak_veh: out }, idx, weightKey: 'junction_peak_veh',
            metric: { label: 'Residents near a junction with 12,000+ peak hour vehicles', value: pct(heavy), unit: '%', higherIs: 'worse' },
            headline: `${pct(heavy)}% of residents within 2 km of a counted junction live nearest one that carried 12,000 or more vehicles in its busiest hour in BBMP's 2024 surveys; the busiest near here counted ${_round(top, 0).toLocaleString('en-IN')}. These are measured counts at 28 junctions on the study corridors, so most of the city is not covered.`,
            stats,
        };
    }

    // Traffic tickets by police station. Mumbai Traffic Police publish the violations they booked in 2024 in each station
    // area, by offence; every block carries its station's figures. This is enforcement, not a measure of bad driving.
    function challans(fr) {
        const c = fr.cols, n = fr.grid.n, per = c['traffic_challans.tc_per_1000'], helmet = c['traffic_challans.tc_helmet_pct'];
        const signal = c['traffic_challans.tc_signal_pct'], wrong = c['traffic_challans.tc_wrongway_pct'], obst = c['traffic_challans.tc_obstruct_pct'];
        const pop = c['population.population'];
        if (!per || !per.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(per[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((s, i) => s + pop[i], 0) || 1;
        const sum = pred => idx.filter(pred).reduce((s, i) => s + pop[i], 0), pct = x => _round(100 * x / P, 0);
        const heavy = sum(i => per[i] >= 100), med = wquantile(per, pop, idx, 0.5);
        const w = col => (col ? _round(wmean(col, pop, idx), 0) : NaN);
        const stats = [
            { label: 'Violations booked per 1,000 residents of the station area (residents-weighted median)', value: _round(med, 0) },
            { label: 'Residents in station areas booking 100+ per 1,000 residents', value: `${_people(heavy)} (${pct(heavy)}%)` },
            { label: 'Share booked for riding without a helmet', value: `${w(helmet)}%` },
            { label: 'Share booked for causing obstruction (mostly parking)', value: `${w(obst)}%` },
            { label: 'Share booked for jumping a signal', value: `${w(signal)}%` },
            { label: 'Share booked for wrong-side driving or entering a one-way', value: `${w(wrong)}%` },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = per[i];
        return {
            columns: { challans_per_1000: out }, idx, weightKey: 'challans_per_1000',
            metric: { label: 'Residents in station areas booking 100+ violations per 1,000 residents', value: pct(heavy), unit: '%', higherIs: null },
            headline: `In 2024 the traffic police booked a median ${_round(med, 0)} violations per 1,000 residents in the station areas here, and ${pct(heavy)}% of residents live where they booked 100 or more; riding without a helmet made up ${w(helmet)}% of bookings and obstruction ${w(obst)}%. These count enforcement, so a high number can mean more patrolling as well as worse driving.`,
            stats,
        };
    }

    // The city's temperatures since 1951. IMD's daily series for the city's grid cell, the 1991-2020 normal against
    // 1951-1980: one value per city, so the lens tells the city's story rather than mapping blocks.
    function since1951(fr) {
        const c = fr.cols, n = fr.grid.n, tx = c['city_climate.cc_tmax_change'], tn = c['city_climate.cc_tmin_change'];
        const hotThen = c['city_climate.cc_hot_then'], hotNow = c['city_climate.cc_hot_now'], warm = c['city_climate.cc_warm_nights_now'];
        const f40a = c['city_climate.cc_40_then'], f40b = c['city_climate.cc_40_now'];
        if (!tx || !tx.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(tx[i]));
        if (idx.length < 5) return null;
        const i0 = idx[0], v = col => (col && _fin(col[i0]) ? col[i0] : NaN), sgn = x => `${x > 0 ? '+' : ''}${_round(x, 1)}`;
        const dTx = v(tx), dTn = v(tn), hb = v(hotThen), ha = v(hotNow), wn = v(warm), a40 = v(f40a), b40 = v(f40b);
        const stats = [
            { label: 'Change in the average daily high, 1991-2020 vs 1951-1980', value: `${sgn(dTx)} °C` },
            { label: 'Change in the average daily low (nights)', value: `${sgn(dTn)} °C` },
            { label: 'Unusually hot days a year (hottest 5% of 1951-1980), then and now', value: `${_round(hb, 0)} → ${_round(ha, 0)}` },
            { label: 'Unusually warm nights a year by the same yardstick, 1991-2020', value: `${_round(wn, 0)} (18 in 1951-1980)` },
            { label: 'Days a year at 40 °C or more, then and now', value: _fin(a40) && (a40 > 0.5 || b40 > 0.5) ? `${_round(a40, 0)} → ${_round(b40, 0)}` : 'almost none' },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = ha;
        const nights = dTn > dTx + 0.2;
        return {
            columns: { since1951_hot_days: out }, idx, weightKey: 'since1951_hot_days',
            metric: { label: 'Unusually hot days a year now (18 in 1951-1980)', value: _round(ha, 0), unit: 'days', higherIs: 'worse' },
            headline: `Compared with 1951-1980, the 1991-2020 average daily high here is ${sgn(dTx)} °C and the daily low ${sgn(dTn)} °C. Days that used to be the hottest 5% (about 18 a year) now come ${_round(ha, 0)} times a year, and warm nights ${_round(wn, 0)} times.${nights ? ' The warming here is mostly at night, which matters for sleep and for people without cooling.' : ''} This is one series for the whole city, from IMD's daily grid.`,
            stats,
        };
    }

    // Slopes that can slide. NASA's global landslide susceptibility map (about 1 km) sampled under each block, crossed with
    // mapped slums where the city has them: hillside settlements are where monsoon slides kill.
    function slidezone(fr) {
        const c = fr.cols, n = fr.grid.n, cls = c['landslide_susceptibility.ls_class'], near = c['landslide_susceptibility.ls_near_max'];
        const slum = c['slums_mapped.slum_pct'], pop = c['population.population'];
        if (!cls || !cls.some(x => _fin(x) && x >= 3)) return null;
        const idx = _residents(fr).filter(i => _fin(cls[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((s, i) => s + pop[i], 0) || 1;
        const sum = pred => idx.filter(pred).reduce((s, i) => s + pop[i], 0), pct = x => _round(100 * x / P, 1);
        const mod = sum(i => cls[i] >= 3), high = sum(i => cls[i] >= 4), nearHigh = sum(i => _fin(near[i]) && near[i] >= 4);
        const slumMod = slum ? idx.filter(i => cls[i] >= 3).reduce((s, i) => s + pop[i] * Math.min(_fin(slum[i]) ? slum[i] : 0, 100) / 100, 0) : NaN;
        const stats = [
            { label: 'Residents on ground of moderate or higher landslide susceptibility', value: `${_people(mod)} (${pct(mod)}%)` },
            { label: 'Of them on high or very high', value: `${_people(high)} (${pct(high)}%)` },
            { label: 'Residents within about 1 km of high or very high ground', value: `${_people(nearHigh)} (${pct(nearHigh)}%)` },
            { label: 'Residents of mapped slums on moderate or higher ground', value: _fin(slumMod) ? _people(slumMod) : 'no slum map' },
        ];
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = cls[i];
        return {
            columns: { slide_class: out }, idx, weightKey: 'slide_class',
            metric: { label: 'Residents on moderate or higher landslide susceptibility', value: pct(mod), unit: '%', higherIs: 'worse' },
            headline: `${_people(mod)} residents here (${pct(mod)}%) live on ground NASA's global map rates moderate or higher for landslides, ${_people(high)} on high or very high${_fin(slumMod) && slumMod >= 100 ? `; about ${_people(slumMod)} of them in mapped slums, the hillside settlements where monsoon slides do most harm` : ''}. The map is about 1 km coarse, so it flags neighbourhoods with slopes that can fail, not single buildings.`,
            stats,
        };
    }

    // Flooded in a named event. Sentinel-1 radar flood proxy maps from the Earth Observatory of Singapore for the Yamuna
    // flood of July 2023 (Delhi) and Cyclone Amphan (Kolkata, May 2020).
    function radarflood(fr) {
        const c = fr.cols, n = fr.grid.n, fl = c['sar_floods.sf_flooded_pct'], yr = c['sar_floods.sf_year'], dm = c['sar_floods.sf_damage_pct'], pop = c['population.population'];
        if (!fl || !fl.some(x => _fin(x) && x > 0)) return null;
        const idx = _residents(fr).filter(i => _fin(fl[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((s, i) => s + pop[i], 0) || 1;
        const sum = pred => idx.filter(pred).reduce((s, i) => s + pop[i], 0), pct = x => _round(100 * x / P, 1);
        const most = sum(i => fl[i] >= 50), some = sum(i => fl[i] >= 10);
        const year = yr ? yr.find(_fin) : NaN;
        const event = year === 2023 ? 'the Yamuna flood of July 2023' : year === 2020 ? 'Cyclone Amphan in May 2020' : 'the mapped flood';
        const stats = [
            { label: 'Residents in blocks mostly flagged as flooded', value: `${_people(most)} (${pct(most)}%)` },
            { label: 'Residents in blocks with at least a tenth flagged', value: `${_people(some)} (${pct(some)}%)` },
            { label: 'Share of ground flagged (residents-weighted)', value: `${_round(wmean(fl, pop, idx), 1)}%` },
        ];
        const di = dm ? idx.filter(i => _fin(dm[i])) : [];
        let dmg = '';
        if (di.length >= 5) {
            const hit = sum(i => _fin(dm[i]) && dm[i] >= 10);
            stats.push({ label: 'Residents where the radar damage map flags at least a tenth of the ground', value: `${_people(hit)} (${pct(hit)}%)` });
            dmg = ` A second radar map of change before and after the storm flags at least a tenth of the ground around ${_people(hit)} residents (${pct(hit)}%) as likely damaged, felled trees included.`;
        }
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = fl[i];
        return {
            columns: { radar_flooded_pct: out }, idx, weightKey: 'radar_flooded_pct',
            metric: { label: 'Residents in blocks mostly flagged as flooded', value: pct(most), unit: '%', higherIs: 'worse' },
            headline: `Radar images taken during ${event} flag ${_people(most)} residents here (${pct(most)}%) in blocks mostly under water and ${_people(some)} where at least a tenth of the ground was. Radar misses water in narrow streets between tall buildings, so built-up areas are under-counted.${dmg}`,
            stats,
        };
    }

    function unpaved(fr) {
        const c = fr.cols, n = fr.grid.n, up = c['road_surface.rs_unpaved_pct'], kn = c['road_surface.rs_known_pct'], wl = c['waterlogging.waterlogging_index'], pop = c['population.population'];
        if (!up || !up.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(up[i]));
        if (idx.length < 5) return null;
        const all = _residents(fr).reduce((s, i) => s + pop[i], 0) || 1;
        const P = idx.reduce((s, i) => s + pop[i], 0) || 1;
        const sum = pred => idx.filter(pred).reduce((s, i) => s + pop[i], 0), pct = x => _round(100 * x / P, 1);
        const some = sum(i => up[i] >= 20), most = sum(i => up[i] >= 50);
        const cover = kn ? _round(wmean(kn, pop, _residents(fr).filter(i => _fin(kn[i]))), 0) : NaN;
        const stats = [
            { label: 'Residents where a fifth or more of the known roads are unpaved', value: `${_people(some)} (${pct(some)}%)` },
            { label: 'Residents where most known roads are unpaved', value: `${_people(most)} (${pct(most)}%)` },
            { label: 'Unpaved share of known road length (residents-weighted)', value: `${_round(wmean(up, pop, idx), 1)}%` },
            { label: 'Residents covered (300 m or more of road with a known surface)', value: `${_people(P)} (${_round(100 * P / all, 1)}%)` },
        ];
        if (_fin(cover)) stats.push({ label: 'Road length nearby with a known surface (residents-weighted)', value: `${cover}%` });
        let mud = '';
        if (wl && idx.some(i => _fin(wl[i]))) {
            const m = sum(i => up[i] >= 20 && _fin(wl[i]) && wl[i] >= 60);
            stats.push({ label: 'Residents with a fifth or more unpaved and a high waterlogging score (60+)', value: `${_people(m)} (${pct(m)}%)` });
            mud = ` ${_people(m)} (${pct(m)}%) live where those roads are also in low, waterlogging-prone ground, likely to turn to mud in the monsoon.`;
        }
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = up[i];
        return {
            columns: { unpaved_pct: out }, idx, weightKey: 'unpaved_pct',
            metric: { label: 'Residents where a fifth or more of the known roads are unpaved', value: pct(some), unit: '%', higherIs: 'worse' },
            headline: `Of the residents whose nearby roads have a known surface, ${_people(some)} (${pct(some)}%) live where a fifth or more of that road length is unpaved, and ${_people(most)} where most of it is. Only part of the network is known (a street photo or an OpenStreetMap tag), so read this as a sample of the streets, not a full survey.${mud}`,
            stats,
        };
    }

    // Generated by pipeline/realestate/socialties.py --js (Meta Social Connectedness Index, public domain).
    const TIES = {"ahmedabad":{"districts":[["Dungarpur","Rajasthan",24829],["Sirohi","Rajasthan",16536],["Jalor","Rajasthan",13653],["Banswara","Rajasthan",12218],["Udaipur","Rajasthan",11506]],"countries":[["Kuwait",28439],["the UAE",26992],["Nepal",21900],["Canada",19721],["Oman",19266]],"distinct":[["Canada",20.0],["Australia",15.7],["New Zealand",12.0]]},"bengaluru":{"districts":[["Hailakandi","Assam",20856],["Karimganj","Assam",16643],["Krishnagiri","Tamil Nadu",13574],["North Tripura","Tripura",13445],["Cachar","Assam",12363]],"countries":[["Nepal",72788],["the UAE",56596],["Bahrain",41992],["Qatar",41495],["Kuwait",37504]],"distinct":[["Luxembourg",20.9],["Ireland",16.7],["Australia",10.2]]},"bhopal":{"districts":[["Lalitpur","Uttar Pradesh",21615],["Jhalawar","Rajasthan",10319],["Jhansi","Uttar Pradesh",9492],["Baran","Rajasthan",8281],["Mungeli","Chhattisgarh",7382]],"countries":[["the UAE",21658],["Oman",14146],["Qatar",13402],["Kuwait",13362],["Nepal",12097]],"distinct":[]},"chennai":{"districts":[["Puducherry","Puducherry",24947],["Karaikal","Puducherry",20990],["Sipahijala","Tripura",12042],["Nawada","Bihar",8031],["Peren","Nagaland",8002]],"countries":[["Singapore",95771],["the UAE",70449],["Kuwait",59055],["Qatar",56462],["Bahrain",53885]],"distinct":[["Singapore",37.2],["Luxembourg",15.6],["Sri Lanka",13.6]]},"delhi":{"districts":[["Gautam Buddha Nagar","Uttar Pradesh",13492],["Budaun","Uttar Pradesh",13466],["Sambhal","Uttar Pradesh",12300],["Gurgaon","Haryana",12235],["Darbhanga","Bihar",11730]],"countries":[["Nepal",40054],["the UAE",38375],["Qatar",30539],["Kuwait",28958],["Oman",25828]],"distinct":[["Canada",8.1],["New Zealand",7.1],["Australia",6.0]]},"guna":{"districts":[["Baran","Rajasthan",218380],["Jhalawar","Rajasthan",92383],["Kota","Rajasthan",31671],["Lalitpur","Uttar Pradesh",25059],["Bundi","Rajasthan",20016]],"countries":[["the UAE",11062],["Oman",10127],["Kuwait",8841],["Qatar",8375],["Saudi Arabia",7375]],"distinct":[]},"hyderabad":{"districts":[["Bidar","Karnataka",23066],["Prakasam","Andhra Pradesh",15426],["Yanam","Puducherry",14397],["Guntur","Andhra Pradesh",14369],["East Godavari","Andhra Pradesh",13653]],"countries":[["the UAE",48373],["Kuwait",45123],["Bahrain",42330],["Qatar",40314],["Oman",32164]],"distinct":[["the US",15.2],["Australia",13.3],["Somalia",11.7]]},"indore_pilot":{"districts":[["Lalitpur","Uttar Pradesh",23910],["Jhalawar","Rajasthan",11897],["Pratapgarh","Rajasthan",7425],["Kota","Rajasthan",6115],["Baran","Rajasthan",6082]],"countries":[["the UAE",17323],["Kuwait",15609],["Oman",11695],["Qatar",10024],["Bahrain",9979]],"distinct":[]},"jaipur":{"districts":[["Sheopur","Madhya Pradesh",29961],["Mahendragarh","Haryana",20463],["Rewari","Haryana",8939],["Mewat","Haryana",8642],["Morena","Madhya Pradesh",8443]],"countries":[["the UAE",33104],["Kuwait",22139],["Oman",21855],["Qatar",20592],["Bahrain",17985]],"distinct":[["Mauritius",2.2]]},"kolkata":{"districts":[["Banka","Bihar",11809],["South Andaman","Andaman and Nicobar",9068],["Jamui","Bihar",7557],["Giridih","Jharkhand",7250],["Nawada","Bihar",6970]],"countries":[["the UAE",34139],["Oman",26236],["Qatar",23970],["Kuwait",22704],["Bangladesh",22268]],"distinct":[["Bhutan",4.2],["Bangladesh",3.1],["Singapore",2.6]]},"lucknow":{"districts":[["Panchkula","Haryana",5331],["Gurgaon","Haryana",5313],["Jhajjar","Haryana",4337],["West","Delhi",4296],["Sonipat","Haryana",4271]],"countries":[["Kuwait",53752],["Oman",44900],["Saudi Arabia",44379],["the UAE",42707],["Bahrain",27083]],"distinct":[["Saudi Arabia",3.2],["Kuwait",2.4],["Brunei",2.3]]},"mumbai":{"districts":[["Siddharth Nagar","Uttar Pradesh",20960],["Shravasti","Uttar Pradesh",16516],["Bahraich","Uttar Pradesh",15204],["Balrampur","Uttar Pradesh",15203],["Gonda","Uttar Pradesh",13788]],"countries":[["the UAE",64920],["Kuwait",52191],["Qatar",49072],["Oman",42614],["Bahrain",39703]],"distinct":[["Ireland",11.7],["New Zealand",10.2],["Canada",9.6]]},"pune":{"districts":[["Siddharth Nagar","Uttar Pradesh",8677],["Bidar","Karnataka",8526],["Balrampur","Uttar Pradesh",6925],["Chitrakoot","Uttar Pradesh",6758],["Umaria","Madhya Pradesh",6469]],"countries":[["the UAE",34864],["Nepal",32196],["Oman",22745],["Kuwait",22379],["Qatar",22363]],"distinct":[["Ireland",11.6],["Australia",6.8],["Canada",6.0]]}};
    function friends(fr) {
        const c = fr.cols, n = fr.grid.n, top = c['social_ties.st_top_out_sci'], t = TIES[fr.city];
        if (!t || !top || !top.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(top[i]));
        if (idx.length < 5) return null;
        const list = (a, k) => { const w = a.slice(0, k).map(x => x[0] + (x.length > 2 ? ` (${x[1]})` : '')); return w.length > 1 ? `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}` : w.join(''); };
        const d = t.districts, far = d.filter(x => x[2] >= 0.5 * d[0][2]);
        const stats = d.map((x, k) => ({ label: `Most-connected district outside the home state ${k + 1}`, value: `${x[0]}, ${x[1]} (SCI ${x[2].toLocaleString('en-IN')})` }));
        stats.push({ label: 'Countries people here are most likely to have friends in', value: list(t.countries, 5) });
        if (t.distinct.length) stats.push({ label: 'Ties abroad far above a typical Indian district', value: t.distinct.map(x => `${x[0]} (${x[1]}×)`).join(', ') });
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = top[i];
        return {
            columns: { friends_top_sci: out }, idx, weightKey: 'friends_top_sci',
            metric: { label: 'Social connectedness with the most-connected district outside the home state', value: d[0][2], unit: 'SCI', higherIs: null },
            headline: `Outside its own state, this city is most tied by friendship to ${list(far.length > 1 ? far : d, 3)}: strong ties to a distant district usually mean people who moved here from there. Abroad, people here are most likely to have friends in ${list(t.countries, 3)}${t.distinct.length ? `, and far more than a typical Indian district in ${t.distinct.map(x => x[0]).slice(0, 2).join(' and ')}` : ''}. One reading for the whole city, from Facebook friendships.`,
            stats,
        };
    }

    function foodbasket(fr) {
        const c = fr.cols, n = fr.grid.n, b = c['food_prices.fp_basket_rs'], vs = c['food_prices.fp_vs_median_pct'], ten = c['food_prices.fp_10y_pct'];
        const sw = c['food_prices.fp_onion_swing'], yr = c['food_prices.fp_last_year'], pci = c['district_income.di_pci'];
        if (!b || !b.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(b[i]));
        if (idx.length < 5) return null;
        const i0 = idx[0], v = col => (col && _fin(col[i0]) ? col[i0] : NaN), rs = x => `₹${Math.round(x).toLocaleString('en-IN')}`;
        const cost = v(b), d = v(vs), t = v(ten), o = v(sw), y = v(yr);
        const stats = [
            { label: `A month's kitchen basket at retail prices (12 months to ${_fin(y) ? y : 'the latest'})`, value: rs(cost) },
            { label: 'Against the median of the eleven price-centre cities', value: _fin(d) ? `${d > 0 ? '+' : ''}${d}%` : 'n/a' },
            { label: 'Change over ten years (same months)', value: _fin(t) ? `+${t}%` : 'n/a' },
            { label: 'Dearest over cheapest monthly onion price, last five years', value: _fin(o) ? `${o}×` : 'n/a' },
        ];
        const pc = pci ? wmean(pci, c['population.population'], idx.filter(i => _fin(pci[i]))) : NaN;
        let share = '';
        if (_fin(pc) && pc > 0) {
            const sh = _round(100 * cost * 12 / (pc * 4.5), 1);
            stats.push({ label: 'Basket over a year as a share of district income for a household of 4.5', value: `${sh}%` });
            share = ` At the district's average income per head (a mean that high earners pull up) that is about ${sh}% of a household's income, far more for a low-wage family.`;
        }
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = cost;
        const rel = !_fin(d) || Math.abs(d) < 3 ? 'about the same as the other price-centre cities' : d > 0 ? `${d}% dearer than the median price-centre city` : `${-d}% cheaper than the median price-centre city`;
        return {
            columns: { food_basket_rs: out }, idx, weightKey: 'food_basket_rs',
            metric: { label: "A month's kitchen basket at retail prices", value: Math.round(cost), unit: '₹', higherIs: 'worse' },
            headline: `A month's basket of staples for a family (rice, atta, dal, oil, sugar, milk, vegetables, tea and salt) cost ${rs(cost)} here in the year to ${_fin(y) ? y : 'the latest data'}, ${rel}${_fin(t) ? `, and ${t}% more than ten years earlier` : ''}.${share} Onion prices swung ${_fin(o) ? `${o}-fold` : 'widely'} between their cheapest and dearest months over five years. One price series for the whole city.`,
            stats,
        };
    }

    function footpaths(fr) {
        const c = fr.cols, n = fr.grid.n, fp = c['pune_prabhag_2016.pp_footpath_pct'], sw = c['pune_prabhag_2016.pp_swd_pct'];
        const slum = c['pune_prabhag_2016.pp_slum_hh'], pr = c['pune_prabhag_2016.pp_prabhag'], pop = c['population.population'];
        if (!fp || !fp.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(fp[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((s, i) => s + pop[i], 0) || 1;
        const sum = pred => idx.filter(pred).reduce((s, i) => s + pop[i], 0), pct = x => _round(100 * x / P, 1);
        const low = sum(i => fp[i] < 20), none = sum(i => fp[i] < 5);
        const both = sw ? sum(i => fp[i] < 20 && _fin(sw[i]) && sw[i] < 30) : 0;
        const stats = [
            { label: 'Residents in prabhags where under a fifth of roads have usable footpaths', value: `${_people(low)} (${pct(low)}%)` },
            { label: 'Residents in prabhags with almost no usable footpaths (under 5%)', value: `${_people(none)} (${pct(none)}%)` },
            { label: 'Usable footpath share of roads (residents-weighted)', value: `${_round(wmean(fp, pop, idx), 1)}%` },
        ];
        if (sw) stats.push({ label: 'Roads with a storm-water drain (residents-weighted)', value: `${_round(wmean(sw, pop, idx.filter(i => _fin(sw[i]))), 1)}%` },
            { label: 'Residents with under a fifth footpaths and under 30% drained roads', value: `${_people(both)} (${pct(both)}%)` });
        if (slum && pr) {
            const seen = new Map();
            for (const i of idx) if (_fin(pr[i]) && _fin(slum[i])) seen.set(pr[i], [slum[i], fp[i]]);
            const rows = [...seen.values()], hh = rows.reduce((s, r) => s + r[0], 0), lowHh = rows.filter(r => r[1] < 20).reduce((s, r) => s + r[0], 0);
            if (hh > 0) stats.push({ label: 'Slum households in prabhags where under a fifth of roads have usable footpaths', value: `${Math.round(lowHh).toLocaleString('en-IN')} of ${Math.round(hh).toLocaleString('en-IN')} (${_round(100 * lowHh / hh, 0)}%)` });
        }
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = fp[i];
        return {
            columns: { usable_footpath_pct: out }, idx, weightKey: 'usable_footpath_pct',
            metric: { label: 'Residents in prabhags where under a fifth of roads have usable footpaths', value: pct(low), unit: '%', higherIs: 'worse' },
            headline: `In PMC's 2016 survey of its 76 prabhags, ${_people(low)} residents here (${pct(low)}%) live where under a fifth of the roads have a usable footpath, and ${_people(none)} where almost none do. The figures are PMC's own, ten years old, for the prabhags of 2012-2017.`,
            stats,
        };
    }

    function intercity(fr) {
        const c = fr.cols, n = fr.grid.n, t5 = c['intercity_trains.it_trains_5km'], hk = c['intercity_trains.it_hub_km'], ht = c['intercity_trains.it_hub_trains'], pop = c['population.population'];
        if (!t5 || !t5.some(_fin)) return null;
        const idx = _residents(fr).filter(i => _fin(t5[i]));
        if (idx.length < 5) return null;
        const P = idx.reduce((s, i) => s + pop[i], 0) || 1;
        const sum = pred => idx.filter(pred).reduce((s, i) => s + pop[i], 0), pct = x => _round(100 * x / P, 1);
        const none = sum(i => t5[i] === 0), rich = sum(i => t5[i] >= 100);
        const hi = hk ? idx.filter(i => _fin(hk[i])) : [];
        const far = hi.length ? sum(i => _fin(hk[i]) && hk[i] > 10) : NaN;
        const stats = [
            { label: 'Residents with no long-distance train stop within 5 km', value: `${_people(none)} (${pct(none)}%)` },
            { label: 'Residents with 100 or more long-distance trains stopping within 5 km', value: `${_people(rich)} (${pct(rich)}%)` },
            { label: 'Long-distance trains within 5 km for the middle resident', value: `${_round(wquantile(t5, pop, idx, 0.5), 0)}` },
        ];
        if (hi.length) {
            stats.push({ label: 'Distance to the nearest big station (50+ long-distance trains), middle resident', value: `${_round(wquantile(hk, pop, hi, 0.5), 1)} km` });
            stats.push({ label: 'Residents more than 10 km from a big station', value: `${_people(far)} (${pct(far)}%)` });
        }
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) out[i] = t5[i];
        return {
            columns: { intercity_trains_5km: out }, idx, weightKey: 'intercity_trains_5km',
            metric: { label: 'Residents with no long-distance train stop within 5 km', value: pct(none), unit: '%', higherIs: 'worse' },
            headline: `${_people(none)} residents here (${pct(none)}%) have no station within 5 km where an express or superfast train stops, while ${_people(rich)} (${pct(rich)}%) have 100 or more such trains within 5 km.${hi.length ? ` The middle resident is ${_round(wquantile(hk, pop, hi, 0.5), 1)} km from a station with 50 or more.` : ''} Counts come from the 2016 Indian Railways timetable, so newer trains such as the Vande Bharat expresses are missing.`,
            stats,
        };
    }

    const ENTRIES = [
        { id: 'liquefy', title: 'Ground that could liquefy', icon: '🫨',
            question: 'Would the ground under my home turn soft in an earthquake?',
            field: { key: 'liquefy_likely_pct', label: 'Ground where liquefaction is likely (share of block)', unit: '%', higherIs: 'worse', ramp: 'reds', domain: [0, 100] },
            needs: ['liquefaction.lq_likely_pct', 'liquefaction.lq_possible_pct', 'liquefaction.sh_high_pct', 'population.population'],
            method: `Manoharan and Ganapathy's first-level GIS assessment of Greater Chennai (Zenodo record 19105121, CC BY 4.0) scores every 20 m pixel for liquefaction susceptibility by weighting lithology, landform, depth to groundwater (ward wells, 2016-2020, interpolated) and depth to bedrock with AHP weights, and classes it as liquefaction not likely (score up to 2.2), possible (2.2-2.75) or likely (above 2.75); a seismic hazard class then adds surface shaking amplified by soil type. Each block takes the share of pixels within 120 m of its centre in each class. It is a desk assessment from mapped geology and well levels, not borehole tests, and says nothing about how strong or likely a quake is: Chennai sits in seismic zone III. Only the authors' own derived rasters are used. Greater Chennai only.`,
            refs: 'S. G. Manoharan and G. P. Ganapathy, Integrated seismic hazard and liquefaction susceptibility mapping of a coastal megacity: dataset and GIS workflow, Zenodo 19105121 (CC BY 4.0); IS 1893 seismic zones' },
        { id: 'junctions', title: 'Counted junction traffic', icon: '🚥',
            question: 'How many vehicles actually pass through the big junction near me at rush hour?',
            field: { key: 'junction_peak_veh', label: 'Vehicles through the nearest counted junction in its busier peak hour', unit: 'vehicles/h', higherIs: 'worse', ramp: 'reds', domain: [6000, 17000] },
            needs: ['junction_counts.jc_peak_veh', 'junction_counts.jc_km', 'junction_counts.jc_daily_veh', 'population.population'],
            method: `BBMP's Comprehensive Bengaluru City Traffic Management Infrastructure Plan (final feasibility report, December 2024, via data.opencity.in) reprints the classified turning-volume counts its consultants made in 2024 at 28 junctions on Tumkur Road, JC Road, Hosur Road, Mysore Road and the north-south tunnel study area, with morning and evening peak hour vehicles and PCUs, plus 24-hour counts at seven central junctions and nine cordon roads. The tables were transcribed by hand and each site placed at its OpenStreetMap location by name. Blocks within 2 km of a counted junction take that junction's busier peak hour; vehicles are mapped because the studies used different PCU factors. Only the study corridors were counted, so blank areas mean no count, not no traffic. A check against DigiPin's own modelled traffic load found it does not rank these junctions well (Spearman about 0.1), so measured counts and the model should be read side by side.`,
            refs: 'BBMP, Comprehensive Bengaluru City Traffic Management Infrastructure Plan, final feasibility report (December 2024), tables 10, 44, 77, 93, 153 and 158, via data.opencity.in (public domain); sites © OpenStreetMap contributors' },
        { id: 'challans', title: 'Traffic tickets by police station', icon: '🎫',
            question: 'What do the traffic police book people for around here?',
            field: { key: 'challans_per_1000', label: 'Traffic violations booked per 1,000 residents of the station area, 2024', unit: 'per 1,000', higherIs: null, ramp: 'reds', domain: [0, 200] },
            needs: ['traffic_challans.tc_per_1000', 'traffic_challans.tc_helmet_pct', 'traffic_challans.tc_signal_pct', 'traffic_challans.tc_wrongway_pct', 'traffic_challans.tc_obstruct_pct', 'population.population'],
            method: `Mumbai Traffic Police tables of violations booked from 1 January to 31 December 2024 by police station and offence (via data.opencity.in, public domain), about 8.5 lakh in all. Each block takes the figures of the law-and-order police station whose jurisdiction map holds it; all 91 station names in the table were matched to the map (21 by spelling fixes). Per 1,000 residents uses the residents of the station area, but many tickets go to people driving through, so market and transit areas score high (Pydhonie, Jogeshwari, Malvani and Khar book the most per resident). These are bookings: they show where and for what the police enforce, not how badly people drive. Mumbai only.`,
            refs: 'Mumbai Traffic Police, violations and challans 2024 by police station, via data.opencity.in (public domain); station areas from Mumbai Police jurisdiction maps' },
        { id: 'since1951', title: 'Hotter than in 1951?', icon: '🌡️',
            question: 'How much hotter has my city got since my grandparents were young?',
            field: { key: 'since1951_hot_days', label: 'Unusually hot days a year, 1991-2020 (18 a year in 1951-1980)', unit: 'days', higherIs: 'worse', ramp: 'reds', domain: [10, 40] },
            needs: ['city_climate.cc_tmax_change', 'city_climate.cc_tmin_change', 'city_climate.cc_hot_then', 'city_climate.cc_hot_now', 'city_climate.cc_warm_nights_now', 'city_climate.cc_40_then', 'city_climate.cc_40_now', 'population.population'],
            method: `India Meteorological Department daily maximum and minimum temperatures for Delhi, Mumbai, Chennai, Bengaluru, Ahmedabad, Hyderabad, Pune and Kolkata, republished on data.opencity.in (public domain). Up to 2020 the values match IMD's gridded daily series for the city's grid cell; from 2021 the file switches source (Mumbai's mean low jumps 2 °C in one year, Pune's drops 2.3 °C), so only 1951-2020 is used, and the rain column is left out (it does not describe the city before 2021). The 1991-2020 normal period is compared with 1951-1980: changes in the mean daily high and low, how often a day beats the hottest 5% of 1951-1980 days (about 18 a year then) and a night the warmest 5% of nights, and days at 40 °C or more. A grid cell is about 100 km across, so this is the regional climate around the city; the heat maps for blocks are the hot-day, hot-night and heated-up lenses. Delhi and Kolkata show little change in daytime highs, as other studies of the Indo-Gangetic plain have found (haze and irrigation damp daytime warming), but their nights have warmed.`,
            refs: 'India Meteorological Department daily temperature 1951-2024 for eight cities, via data.opencity.in (public domain); WMO 1991-2020 climate normals convention' },
        { id: 'slidezone', title: 'Slopes that can slide', icon: '⛰️',
            question: 'Is my neighbourhood on ground that could give way in heavy rain?',
            field: { key: 'slide_class', label: 'Landslide susceptibility (1 very low ... 5 very high)', unit: 'class', higherIs: 'worse', ramp: 'reds', domain: [1, 5] },
            needs: ['landslide_susceptibility.ls_class', 'landslide_susceptibility.ls_near_max', 'slums_mapped.slum_pct', 'population.population'],
            method: `NASA's global landslide susceptibility map (Stanley and Kirschbaum, Natural Hazards 2017; 2023 update; public domain) scores each cell of about 1 km from very low to very high using slope, geology, distance to faults, road cuts and forest loss. It is the static layer behind NASA's LHASA landslide nowcasts, which add rainfall. Each block takes the class under its centre and the highest class in the 3 x 3 cells around it; residents of mapped slums (where the city has a slum map) on moderate or higher ground are counted separately because monsoon slides in Indian cities mostly hit hillside settlements. At 1 km the map mixes slopes with the flat ground below them, so it marks neighbourhoods to check rather than unsafe buildings; the hillside lens adds the finer DEM slope and the slides on record.`,
            refs: 'T. Stanley and D. B. Kirschbaum, A heuristic approach to global landslide susceptibility mapping, Natural Hazards 87 (2017); NASA GPM global landslide susceptibility map, 2023 update (public domain)' },
        { id: 'radarflood', title: 'Under water in a named flood', icon: '🛰️',
            question: 'Was my area under water in the last big flood?',
            field: { key: 'radar_flooded_pct', label: 'Ground flagged as flooded by radar in the event (share of block)', unit: '%', higherIs: 'worse', ramp: 'blues', domain: [0, 100] },
            needs: ['sar_floods.sf_flooded_pct', 'sar_floods.sf_year', 'sar_floods.sf_damage_pct', 'population.population'],
            method: `Flood proxy maps by the Earth Observatory of Singapore Remote Sensing Lab (EOS-RS; ARIA-SG with NASA-JPL for 2020), via the Humanitarian Data Exchange under CC BY 4.0: Copernicus Sentinel-1 radar images taken during the flood are compared with images from before, and pixels of about 30 m that turned to likely water are flagged. Delhi: 12 July 2023, during the Yamuna flood (the river reached a record 208.66 m on 13 July, so the peak is a day later than the image). Kolkata: 22 May 2020, after Cyclone Amphan. Each block takes the share of flagged pixels in about 250 m around its centre. Radar sees open water and flooded fields well but misses water in narrow streets between buildings, and EOS-RS call the maps less reliable over urban and vegetated areas, so read blank built-up blocks as not seen rather than dry. For Amphan, the ARIA-SG damage proxy map (Sentinel-1 track P048, v0.4) is added: it flags pixels whose radar coherence changed sharply between images before and after the storm, which picks out roof and wall damage, debris and fallen trees; scattered single pixels can be false alarms, and it is least reliable over vegetation.`,
            refs: 'Earth Observatory of Singapore Remote Sensing Lab flood proxy maps: New Delhi floods 12 Jul 2023 v0.9; Cyclone Amphan 22 May 2020 v0.8 and damage proxy map P048 v0.4 (ARIA-SG), via data.humdata.org (CC BY 4.0); contains modified Copernicus Sentinel data' },
        { id: 'unpaved', title: 'Unpaved streets', icon: '🛤️',
            question: 'Are the streets around me still dirt roads?',
            field: { key: 'unpaved_pct', label: 'Unpaved share of nearby roads with a known surface', unit: '%', higherIs: 'worse', ramp: 'reds', domain: [0, 60] },
            needs: ['road_surface.rs_unpaved_pct', 'road_surface.rs_known_pct', 'road_surface.rs_unpaved_km', 'waterlogging.waterlogging_index', 'population.population'],
            method: `HeiGIT's road surface dataset for India (Heidelberg Institute for Geoinformation Technology, via the Humanitarian Data Exchange, ODbL) labels each OpenStreetMap road paved or unpaved: from its OSM surface tag where one exists, otherwise from a deep-learning model run over Mapillary street-level photos taken along it (Randhawa et al. 2024). Footways, paths, steps and cycleways are left out. Each block takes the drivable roads whose middle lies within 500 m and gets an unpaved share when at least 300 m of them have a known surface. Only 7-27% of road length in most cities is known (59% in Lucknow), and known roads lean towards main roads that are tagged or photographed, so the share is a sample, likely to under-count unpaved lanes; outer, thinly built blocks carry most of the unpaved roads (rank correlation with residents about -0.35 to -0.42 in Bengaluru, Delhi and Hyderabad). Blocks with a fifth or more unpaved and a waterlogging index of 60 or more (DigiPin's terrain and monsoon-water score) are counted as likely to turn to mud in the rains.`,
            refs: 'HeiGIT, Mapillary-based road surface data for India (via data.humdata.org, ODbL); A. Randhawa et al., Paved or unpaved? A deep learning derived road surface global dataset from Mapillary street-view imagery, arXiv 2410.19874; © OpenStreetMap contributors' },
        { id: 'friends', title: 'Where people here have ties', icon: '🤝',
            question: 'Where do people in this city come from, and where are their friends abroad?',
            field: { key: 'friends_top_sci', label: 'Social connectedness with the most-connected district outside the home state', unit: 'SCI', higherIs: null, ramp: 'viridis' },
            needs: ['social_ties.st_top_out_sci', 'social_ties.st_gulf_sci', 'social_ties.st_abroad_ratio', 'population.population'],
            method: `Meta's Social Connectedness Index (Bailey, Cao, Kuchler, Stroebel and others; 2025 release via the Humanitarian Data Exchange, public domain) measures the relative probability that a Facebook user in one place is friends with a user in another, from an anonymised snapshot of all active users. The city is its GADM district (Mumbai averages Mumbai City and Mumbai Suburban; Delhi is one unit). DigiPin lists the five districts outside the city's home state with the highest index, the five countries with the highest index, and the countries where the city's index is at least twice the median Indian district's (only where the city's index is 5,000 or more, so tiny states do not crowd the list). Strong ties to a far district usually trace migration; the index reflects Facebook users, who skew younger, urban and male in India, and says nothing about any one person. The map is a single value for the city.`,
            refs: 'M. Bailey, R. Cao, T. Kuchler, J. Stroebel and A. Wong, Social Connectedness: Measurement, Determinants, and Effects, Journal of Economic Perspectives 32(3), 2018; Meta Data for Good, Social Connectedness Index (2025 release), via data.humdata.org (public domain); district names from GADM 4.1' },
        { id: 'foodbasket', title: 'Kitchen basket cost', icon: '🧺',
            question: 'What does a month of staples cost in this city, and how fast has it risen?',
            field: { key: 'food_basket_rs', label: "A month's kitchen basket at retail prices", unit: '₹', higherIs: 'worse', ramp: 'reds' },
            needs: ['food_prices.fp_basket_rs', 'food_prices.fp_vs_median_pct', 'food_prices.fp_10y_pct', 'food_prices.fp_onion_swing', 'food_prices.fp_last_year', 'district_income.di_pci', 'population.population'],
            method: `Monthly retail prices from the Department of Consumer Affairs' price monitoring cell, republished by the World Food Programme on the Humanitarian Data Exchange (CC BY-IGO), 1994 to July 2023; eleven DigiPin cities are price centres (Pune and Guna are not). A fixed month's basket for a family of four or five (10 kg rice, 10 kg wheat flour, 3 kg lentils, 2 kg mustard oil, 2 kg sugar, 30 litres milk, 5 kg potatoes, 4 kg onions, 3 kg tomatoes, 250 g tea, 1 kg salt) is priced in each month that has every item, and the last 12 such months are averaged. The ten-year change compares the same calendar months a decade earlier over the items priced then, weighted by today's basket. The basket is illustrative, the same in every city: real diets differ (rice-heavy in the south and east, mustard oil mostly in the north and east), and the prices are what the monitoring centres record, not every shop. Where district income figures exist the basket is set against a household of 4.5 at the district's income per head.`,
            refs: 'World Food Programme, India food prices (via data.humdata.org, CC BY-IGO), data from the Department of Consumer Affairs, Government of India, price monitoring cell' },
        { id: 'footpaths', title: 'Usable footpaths (Pune)', icon: '🚶',
            question: 'Can I walk on a footpath here, or do I walk on the road?',
            field: { key: 'usable_footpath_pct', label: 'Roads with usable footpaths in the prabhag (PMC 2016)', unit: '%', higherIs: 'better', ramp: 'viridis', domain: [0, 100] },
            needs: ['pune_prabhag_2016.pp_footpath_pct', 'pune_prabhag_2016.pp_swd_pct', 'pune_prabhag_2016.pp_slum_hh', 'pune_prabhag_2016.pp_prabhag', 'population.population'],
            method: `Pune Municipal Corporation's 2016 prabhag tables (via data.opencity.in, public domain) give, for each of the 76 prabhags used from 2012 to 2017, the length of roads, the length with a footpath on one or both sides, the share of roads with usable footpaths, the share of roads with a storm-water drain and the number of slum households. The prabhags are placed with DataMeet's trace of the 2012 electoral wards (Municipal Spatial Data, CC BY 4.0), and each block takes its prabhag's row. These are the corporation's own reported figures, not a field audit, and are ten years old; footpaths built or lost since are not counted. PMC's table of homes with drainage connections on the same prabhags is left out because it reads 100% almost everywhere.`,
            refs: 'Pune Municipal Corporation prabhag-wise roads and footpaths, storm-water drain coverage and slum tables, 2016 (data.opencity.in, public domain); DataMeet, Municipal Spatial Data, Pune electoral wards 2012 (CC BY 4.0)' },
        { id: 'intercity', title: 'Long-distance trains within reach', icon: '🚆',
            question: 'How easily can I catch a long-distance train from here?',
            field: { key: 'intercity_trains_5km', label: 'Long-distance trains stopping within 5 km (2016 timetable)', unit: 'trains', higherIs: 'better', ramp: 'viridis', domain: [0, 300] },
            needs: ['intercity_trains.it_trains_5km', 'intercity_trains.it_hub_km', 'intercity_trains.it_hub_trains', 'population.population'],
            method: `DataMeet's Indian Railways data (github.com/datameet/railways, CC0), gathered from the 2016 timetable: 8,990 stations, 5,208 trains and 417,080 scheduled stops. Only express-class trains count (Express, Superfast, Mail, Rajdhani, Shatabdi, Jan Shatabdi, Duronto, Garib Rath, Sampark Kranti); passenger, MEMU/DEMU and suburban trains are left out, and a station a train runs through without stopping (arrival equal to departure) is not counted. Each block adds up the distinct trains stopping at stations within 5 km in a straight line and finds the nearest station with 50 or more. A train counts once however many days a week it runs. The timetable is ten years old: trains added since, including the Vande Bharat expresses, are missing, and a few stations have been renamed or rebuilt.`,
            refs: 'DataMeet, Indian Railways stations, trains and schedules (S. Bhangar and S. Hussain, 2016), github.com/datameet/railways (CC0)' },
    ];

    UrbanLenses.register(ENTRIES, { liquefy, junctions, challans, since1951, slidezone, radarflood, unpaved, friends, foodbasket, footpaths, intercity });
    return { ENTRIES };
})();
