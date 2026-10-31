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

    const ENTRIES = [
        { id: 'liquefy', title: 'Ground that could liquefy', icon: '🫨',
            question: 'Would the ground under my home turn soft in an earthquake?',
            field: { key: 'liquefy_likely_pct', label: 'Ground where liquefaction is likely (share of block)', unit: '%', higherIs: 'worse', ramp: 'reds', domain: [0, 100] },
            needs: ['liquefaction.lq_likely_pct', 'liquefaction.lq_possible_pct', 'liquefaction.sh_high_pct', 'population.population'],
            method: `Manoharan and Ganapathy's first-level GIS assessment of Greater Chennai (Zenodo record 19105121, CC BY 4.0) scores every 20 m pixel for liquefaction susceptibility by weighting lithology, landform, depth to groundwater (ward wells, 2016-2020, interpolated) and depth to bedrock with AHP weights, and classes it as liquefaction not likely (score up to 2.2), possible (2.2-2.75) or likely (above 2.75); a seismic hazard class then adds surface shaking amplified by soil type. Each block takes the share of pixels within 120 m of its centre in each class. It is a desk assessment from mapped geology and well levels, not borehole tests, and says nothing about how strong or likely a quake is: Chennai sits in seismic zone III. Only the authors' own derived rasters are used. Greater Chennai only.`,
            refs: 'S. G. Manoharan and G. P. Ganapathy, Integrated seismic hazard and liquefaction susceptibility mapping of a coastal megacity: dataset and GIS workflow, Zenodo 19105121 (CC BY 4.0); IS 1893 seismic zones' },
    ];

    UrbanLenses.register(ENTRIES, { liquefy });
    return { ENTRIES };
})();
