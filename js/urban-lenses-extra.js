/**
 * Further lenses for UrbanLenses: research and official layers added after urban-lenses-wards.js reached the 150 kB
 * per-module budget (first: Greater Chennai liquefaction susceptibility). Registers itself on load, after urban-lenses.js.
 */
const UrbanLensesExtra = (() => {
    'use strict';
    if (typeof UrbanLenses === 'undefined') return null;
    const { _fin, _round, _people, _residents, wmean } = UrbanLenses._kit;

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
    ];

    UrbanLenses.register(ENTRIES, { liquefy, junctions });
    return { ENTRIES };
})();
