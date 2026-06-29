/**
 * PriorityAnalysis — multi-criteria decision analysis (MCDA) for "where should we
 * act?". Each playbook maps a municipal intervention to a transparent signed-weight
 * blend of cell features, producing a 0-100 priority per DigiPin cell (high = act
 * here first). This is the decision-support core: it turns the feature store into a
 * ranked, paintable list of where a given investment is most needed.
 *
 * Signed weights: + uses the field as-is, − inverts it (100 − v). So "clinics"
 * rewards LOW healthcare access × HIGH population — i.e. underserved + dense.
 * Every playbook is editable/readable by a planner; results carry their drivers.
 *
 * Pure + unit-tested.
 *
 *   PriorityAnalysis.compute(features, 'drainage')  -> { value, band, drivers }
 *   PriorityAnalysis.rank(cells, 'clinics')
 */
const PriorityAnalysis = (() => {
    const PLAYBOOKS = {
        drainage:   { label: 'Drainage / flood works', weights: { flood_risk: 1.0, population_proxy: 0.6, infra_maturity: -0.4 } },
        clinics:    { label: 'Health facilities',       weights: { healthcare_access: -1.0, population_proxy: 0.7, safety: 0.2 } },
        schools:    { label: 'Schools',                 weights: { education_score: -1.0, population_proxy: 0.7 } },
        parks:      { label: 'Parks / green space',     weights: { green: -1.0, population_proxy: 0.6, noise_estimate: 0.3 } },
        transit:    { label: 'Transit / connectivity',  weights: { connectivity: -1.0, population_proxy: 0.7, commercial: 0.4 } },
        sanitation: { label: 'Sanitation / waste',      weights: { public_service: -0.8, population_proxy: 0.8 } },
        policing:   { label: 'Policing / safety',       weights: { safety: -1.0, population_proxy: 0.6 } },
    };
    const GOALS = Object.keys(PLAYBOOKS);

    function _label(id) {
        return (typeof DigiPinIntel !== 'undefined' && DigiPinIntel.field && DigiPinIntel.field(id))
            ? DigiPinIntel.field(id).label : id;
    }
    function _band(v) { return v == null ? 'no data' : v >= 66 ? 'High' : v >= 33 ? 'Moderate' : 'Low'; }

    /** Signed-weight blend over raw fields → priority value + contributions. Pure. */
    function _score(features, weights) {
        let num = 0, den = 0;
        const contribs = [];
        for (const [id, w] of Object.entries(weights)) {
            const v = features ? features[id] : null;
            if (v == null || !Number.isFinite(+v) || !w) continue;
            const oriented = w < 0 ? (100 - +v) : +v;
            const c = Math.abs(w) * oriented;
            num += c; den += Math.abs(w);
            contribs.push({ id, label: _label(id), value: +v, weight: w, contribution: c });
        }
        if (den === 0) return { value: null, contribs: [] };
        return { value: Math.max(0, Math.min(100, Math.round(num / den))), contribs };
    }

    /** Priority for an intervention goal (or custom weights). Pure. */
    function compute(features, goalOrWeights) {
        const def = typeof goalOrWeights === 'string' ? PLAYBOOKS[goalOrWeights] : { label: 'Custom', weights: goalOrWeights };
        if (!def) return null;
        const { value, contribs } = _score(features, def.weights);
        const drivers = contribs.sort((a, b) => b.contribution - a.contribution).slice(0, 3)
            .map(c => ({ id: c.id, label: c.label, value: c.value }));
        return { goal: typeof goalOrWeights === 'string' ? goalOrWeights : null, label: def.label, value, band: _band(value), highMeans: 'risk', drivers };
    }

    /** Rank cell records by priority for a goal (descending = act first). Pure. */
    function rank(cells, goal) {
        return (cells || [])
            .map(c => { const r = compute(c.features || c, goal); return { ...c, priorityValue: r ? r.value : null, band: r ? r.band : null }; })
            .filter(c => c.priorityValue != null)
            .sort((a, b) => b.priorityValue - a.priorityValue);
    }

    function list() { return GOALS.map(g => ({ goal: g, label: PLAYBOOKS[g].label })); }

    return { compute, rank, list, PLAYBOOKS, GOALS };
})();

if (typeof window !== 'undefined') window.PriorityAnalysis = PriorityAnalysis;
