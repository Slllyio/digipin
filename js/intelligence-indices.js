/**
 * IntelIndices — composite urban-intelligence indices computed per DigiPin cell
 * from the Feature Store record. These diversify the platform's use cases beyond
 * the raw signals into the questions a ULB actually asks:
 *
 *   livability          — overall quality of life (town planning)
 *   climateResilience   — green + drainage + low nuisance (climate adaptation)
 *   disasterRisk        — hazard × exposure ÷ mitigation (disaster management)
 *   serviceGap          — where services are thin relative to need (equity/works)
 *   investmentPotential — revenue & growth signal (economy / tax base)
 *   economicVitality    — current economic activity (commerce / livelihoods)
 *   sustainability      — low-carbon, walkable, digital (long-term planning)
 *
 * Every index is a TRANSPARENT signed-weight blend of feature fields. A positive
 * weight uses the field as-is; a negative weight inverts it (100 − v), so each
 * index can mix "more is good" and "less is good" signals explicitly. Each result
 * carries a band and its top contributing `drivers` for explainability — never a
 * black box. All functions are pure and unit-tested.
 *
 *   IntelIndices.all(features)            -> { livability:{...}, ... }
 *   IntelIndices.compute(features, 'disasterRisk')
 */
const IntelIndices = (() => {
    // highMeans: 'good' (higher is better) | 'risk' (higher is worse/more need).
    // weights: field id -> signed weight (sign sets orientation, magnitude sets
    // influence). Designed to be read and challenged by a planner.
    const DEFS = {
        livability: {
            label: 'Livability', highMeans: 'good',
            description: 'Holistic quality of life: access, safety, greenery, quiet, low flood risk.',
            weights: { walkability: 1.0, green: 0.9, safety: 1.0, healthcare_access: 0.8,
                       education_score: 0.7, public_service: 0.6, connectivity: 0.6,
                       noise_estimate: -0.6, flood_risk: -0.6 },
        },
        climateResilience: {
            label: 'Climate resilience', highMeans: 'good',
            description: 'Capacity to absorb heat & rain stress: green cover, drainage/infra, low flood, low nuisance.',
            weights: { green: 1.0, infra_maturity: 0.8, walkability: 0.4,
                       flood_risk: -1.0, noise_estimate: -0.3 },
        },
        disasterRisk: {
            label: 'Disaster risk', highMeans: 'risk',
            description: 'Flood hazard amplified by population exposure, reduced by infrastructure maturity.',
            weights: { flood_risk: 1.0, population_proxy: 0.6, infra_maturity: -0.4 },
        },
        serviceGap: {
            label: 'Service gap', highMeans: 'risk',
            description: 'Underserved areas — thin healthcare, education, public services & connectivity where people live.',
            weights: { healthcare_access: -1.0, education_score: -0.8, public_service: -0.8,
                       connectivity: -0.5, population_proxy: 0.4 },
        },
        investmentPotential: {
            label: 'Investment potential', highMeans: 'good',
            description: 'Revenue & development signal: investment, real-estate growth, commerce, access, infra, low flood.',
            weights: { investment: 1.0, real_estate_growth: 0.9, commercial: 0.7,
                       connectivity: 0.6, infra_maturity: 0.5, flood_risk: -0.4 },
        },
        economicVitality: {
            label: 'Economic vitality', highMeans: 'good',
            description: 'Current economic activity: commerce, entertainment, tourism, food, jobs proxy.',
            weights: { commercial: 1.0, entertainment_score: 0.7, tourism: 0.6,
                       food_diversity: 0.5, real_estate_growth: 0.4 },
        },
        sustainability: {
            label: 'Sustainability', highMeans: 'good',
            description: 'Low-carbon urban form: green, walkable (less car-dependent), quiet, digitally enabled, low flood.',
            weights: { green: 1.0, walkability: 0.9, digital_readiness: 0.5,
                       noise_estimate: -0.5, flood_risk: -0.4 },
        },
    };
    const IDS = Object.keys(DEFS);

    function _label(id) {
        return (typeof DigiPinIntel !== 'undefined' && DigiPinIntel.field && DigiPinIntel.field(id))
            ? DigiPinIntel.field(id).label : id;
    }

    function _band(value, highMeans) {
        if (value == null) return 'no data';
        if (highMeans === 'risk') return value >= 66 ? 'High' : value >= 33 ? 'Moderate' : 'Low';
        return value >= 70 ? 'Strong' : value >= 40 ? 'Moderate' : 'Weak';
    }

    /** Signed-weight blend over RAW field values. Returns value + per-field contribs. Pure. */
    function _compose(features, weights) {
        let num = 0, den = 0;
        const contribs = [];
        for (const [id, w] of Object.entries(weights)) {
            const raw = features ? features[id] : null;
            if (raw == null || !Number.isFinite(+raw) || !w) continue;
            const oriented = w < 0 ? (100 - +raw) : +raw;     // negative weight = "less is better"
            const contribution = Math.abs(w) * oriented;
            num += contribution; den += Math.abs(w);
            contribs.push({ id, label: _label(id), value: +raw, weight: w, contribution });
        }
        if (den === 0) return { value: null, contribs: [] };
        return { value: Math.max(0, Math.min(100, Math.round(num / den))), contribs };
    }

    /** Compute one index from a flat feature map. Returns {id,label,value,band,highMeans,description,drivers}. */
    function compute(features, id) {
        const def = DEFS[id];
        if (!def) return null;
        const { value, contribs } = _compose(features, def.weights);
        const drivers = contribs
            .sort((a, b) => b.contribution - a.contribution)
            .slice(0, 3)
            .map(c => ({ id: c.id, label: c.label, value: c.value }));
        return {
            id, label: def.label, value, band: _band(value, def.highMeans),
            highMeans: def.highMeans, description: def.description, drivers,
        };
    }

    /** All indices for a feature map → { id: result }. */
    function all(features) {
        const out = {};
        for (const id of IDS) out[id] = compute(features, id);
        return out;
    }

    /** Convenience: compute an index straight from a Feature Store record. */
    function forRecord(record, id) {
        const f = record && record.features ? record.features : record;
        return id ? compute(f, id) : all(f);
    }

    function list() { return IDS.map(id => ({ id, label: DEFS[id].label, highMeans: DEFS[id].highMeans, description: DEFS[id].description })); }

    return { all, compute, forRecord, list, DEFS, IDS };
})();

if (typeof window !== 'undefined') window.IntelIndices = IntelIndices;
