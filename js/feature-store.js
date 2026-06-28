/**
 * DigiPinIntel — the per-cell Feature Store: one unified, queryable record per
 * DigiPin cell that fuses every intelligence signal behind a single API.
 *
 * This is the substrate the rest of the urban-intelligence layer queries
 * (composite indices, real-time exposure, the agentic assistant). It does NOT
 * recompute anything — it composes what the platform already produces
 * (PrecomputedScores shards keyed by DigiPin code) into a stable schema, adds
 * the DigiPin hierarchy (L6/L8/L10 by truncation), and provides ranking.
 *
 * Why a feature store: a ULB's value comes from JOINING domains at one location
 * (revenue + risk + services + mobility). Keying everything to a DigiPin cell
 * makes that join O(1) and interoperable — the cell code is the foreign key.
 *
 * Pure helpers (schema, rank, group, levels, flatten) are deterministic and
 * unit-tested; cell()/viewport() are thin async wrappers over PrecomputedScores.
 *
 *   await DigiPinIntel.cell(22.72, 75.86)  -> unified record
 *   DigiPinIntel.rank(cells, { flood_risk: 1, population_proxy: 0.5 })
 *   DigiPinIntel.schema()                  -> field + domain catalogue
 */
const DigiPinIntel = (() => {
    // The per-cell field catalogue (matches data/scores/coverage.json `fields`),
    // each tagged with a human label, the domain it belongs to, and polarity:
    // +1 = higher is better, -1 = higher is worse (risk/nuisance). Polarity lets
    // composite indices and ranking treat "good" and "bad" signals consistently.
    const FIELDS = [
        { id: 'walkability',        label: 'Walkability',          domain: 'mobility',       polarity: +1 },
        { id: 'connectivity',       label: 'Connectivity',         domain: 'mobility',       polarity: +1 },
        { id: 'safety',             label: 'Safety',               domain: 'social',         polarity: +1 },
        { id: 'education_score',    label: 'Education access',      domain: 'social',         polarity: +1 },
        { id: 'healthcare_access',  label: 'Healthcare access',    domain: 'social',         polarity: +1 },
        { id: 'public_service',     label: 'Public services',      domain: 'social',         polarity: +1 },
        { id: 'entertainment_score',label: 'Entertainment',        domain: 'social',         polarity: +1 },
        { id: 'tourism',            label: 'Tourism',              domain: 'social',         polarity: +1 },
        { id: 'food_diversity',     label: 'Food diversity',       domain: 'social',         polarity: +1 },
        { id: 'religious_diversity',label: 'Religious diversity',  domain: 'social',         polarity: +1 },
        { id: 'green',              label: 'Green cover',          domain: 'environment',    polarity: +1 },
        { id: 'noise_estimate',     label: 'Noise',               domain: 'environment',    polarity: -1 },
        { id: 'flood_risk',         label: 'Flood risk',           domain: 'risk',           polarity: -1 },
        { id: 'commercial',         label: 'Commercial activity',  domain: 'economy',        polarity: +1 },
        { id: 'investment',         label: 'Investment signal',    domain: 'economy',        polarity: +1 },
        { id: 'real_estate_growth', label: 'Real-estate growth',   domain: 'economy',        polarity: +1 },
        { id: 'infra_maturity',     label: 'Infrastructure',       domain: 'infrastructure', polarity: +1 },
        { id: 'digital_readiness',  label: 'Digital readiness',    domain: 'infrastructure', polarity: +1 },
        { id: 'livability',         label: 'Livability',           domain: 'composite',      polarity: +1 },
        { id: 'population_proxy',   label: 'Population density',    domain: 'demographics',   polarity: +1 },
    ];
    const _byId = Object.fromEntries(FIELDS.map(f => [f.id, f]));
    const DOMAINS = ['mobility', 'social', 'environment', 'risk', 'economy', 'infrastructure', 'demographics', 'composite'];
    const LEVELS = [6, 8, 10];                 // planning / operations / addressing

    function _dashless(code) { return String(code || '').replace(/-/g, ''); }

    /** DigiPin hierarchy for a code: the same code truncated to each level. */
    function levels(code) {
        const raw = _dashless(code);
        const out = {};
        for (const L of LEVELS) {
            const slice = raw.slice(0, L);
            out[L] = (typeof DigiPin !== 'undefined' && DigiPin.format) ? DigiPin.format(slice) : slice;
        }
        return out;
    }

    /** PrecomputedScores returns { id: {label, value} }; flatten to { id: value }. */
    function flatten(scores) {
        const out = {};
        for (const [id, sc] of Object.entries(scores || {})) {
            out[id] = sc && typeof sc === 'object' ? sc.value : sc;
        }
        return out;
    }

    /** Group a flat feature map into { domain: { id: value } }. Pure. */
    function group(features) {
        const out = {};
        for (const d of DOMAINS) out[d] = {};
        for (const [id, v] of Object.entries(features || {})) {
            const dom = (_byId[id] && _byId[id].domain) || 'other';
            (out[dom] = out[dom] || {})[id] = v;
        }
        return out;
    }

    /** Field metadata catalogue. Pure. */
    function schema() {
        return {
            version: 1,
            levels: LEVELS,
            domains: DOMAINS,
            fields: FIELDS.map(f => ({ ...f })),
        };
    }
    function field(id) { return _byId[id] ? { ..._byId[id] } : null; }

    /**
     * Weighted composite over a feature map. Weights are keyed by field id;
     * each field is oriented by polarity (risk fields are inverted: 100 - v) so
     * a positive weight always means "more of the good version of this". Returns
     * 0..100. Missing fields are skipped (renormalised over present weights). Pure.
     */
    function score(features, weights) {
        let num = 0, den = 0;
        for (const [id, w] of Object.entries(weights || {})) {
            const v = features ? features[id] : null;
            if (v == null || !Number.isFinite(+v) || !w) continue;
            const pol = (_byId[id] && _byId[id].polarity) || 1;
            const oriented = pol < 0 ? (100 - +v) : +v;
            num += Math.abs(w) * oriented * (w < 0 ? -1 : 1);
            den += Math.abs(w);
        }
        if (den === 0) return null;
        return Math.max(0, Math.min(100, Math.round(num / den)));
    }

    /** Rank cell records (each {code, features, ...}) by a weighted composite.
     *  Returns a new array sorted desc with a `.score` added. Pure. */
    function rank(cells, weights) {
        return (cells || [])
            .map(c => ({ ...c, score: score(c.features || flatten(c.scores), weights) }))
            .filter(c => c.score != null)
            .sort((a, b) => b.score - a.score);
    }

    function _enabled() {
        return typeof PrecomputedScores !== 'undefined'
            && PrecomputedScores.isEnabled && PrecomputedScores.isEnabled();
    }

    /** Build a unified record skeleton for a DigiPin code (addressing always works). */
    function _record(code10, center) {
        return {
            digipin: { code: code10, dashless: _dashless(code10), levels: levels(code10) },
            geometry: { center },
            region: null,
            available: false,
            features: {},
            domains: {},
        };
    }

    /**
     * The unified per-cell record at (lat,lng). Always returns a record — the
     * DigiPin address resolves anywhere in India; `available` flags whether
     * fused intelligence features are present (i.e. the point is in a covered
     * region). Async because feature lookup reads tile shards.
     */
    async function cell(lat, lng) {
        const code10 = (typeof DigiPin !== 'undefined' && DigiPin.encode)
            ? DigiPin.encode(lat, lng) : '';
        const rec = _record(code10, { lat, lng });
        if (!_enabled()) return rec;
        const region = PrecomputedScores.regionFor(lat, lng);
        if (!region) return rec;
        rec.region = region.name;
        const look = await PrecomputedScores.lookup(lat, lng);
        if (look) {
            rec.digipin.cell = look.code;
            rec.features = flatten(look.scores);
            rec.domains = group(rec.features);
            rec.available = true;
            if (typeof DigiPin !== 'undefined' && DigiPin.decodePartial) {
                const d = DigiPin.decodePartial(_dashless(look.code));
                rec.geometry.center = { lat: d.lat, lng: d.lng };
                rec.geometry.bounds = d.bounds;
            }
        }
        return rec;
    }

    /** Record for a DigiPin code string (decodes geometry, then fuses features). */
    async function cellByCode(code) {
        if (typeof DigiPin === 'undefined' || !DigiPin.decodePartial) return null;
        const d = DigiPin.decodePartial(_dashless(code));
        return cell(d.lat, d.lng);
    }

    /** Every covered cell intersecting `bounds`, as unified records. */
    async function viewport(bounds) {
        if (!_enabled()) return [];
        const cells = await PrecomputedScores.lookupViewport(bounds);
        if (!cells) return [];
        return cells.map(c => ({
            digipin: { code: c.code, dashless: _dashless(c.code), levels: levels(c.code) },
            geometry: { center: c.center, bounds: c.bounds },
            available: true,
            features: flatten(c.scores),
            domains: group(flatten(c.scores)),
        }));
    }

    return {
        schema, field, levels, flatten, group, score, rank,
        cell, cellByCode, viewport,
        FIELDS, DOMAINS, LEVELS,
    };
})();

if (typeof window !== 'undefined') window.DigiPinIntel = DigiPinIntel;
