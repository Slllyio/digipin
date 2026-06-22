/**
 * EmergencyAccessScore — pure helpers for the Emergency Accessibility Index (EAI),
 * a per-DIGIPIN-cell measure of how easily police / authorities / emergency
 * vehicles can REACH the cell when an incident (riot, disturbance, emergency)
 * arises. It expands the Law & Order Mobility layer with the road-network
 * *movement* dimension the older mobility_risk omitted.
 *
 * Higher index = easier to reach. The index is a weighted blend of normalised
 * (0..1) signals drawn from the two committed precomputed grids
 * (mobility_grid.json + traffic_grid.json); no live fetch, no DOM. Unit-tested.
 *
 * Defensive framing: this is a planning aid that shows where authorities'
 * movement can be slowed/choked/sealed so access can be PROTECTED, mirroring
 * MobilityScore. See docs/MOBILITY_MODEL.md.
 */
const EmergencyAccessScore = (() => {
    // Bands (best → worst) with map/legend colours. Keep thresholds in sync with
    // bandFor(): >=66 Reachable, >=40 Constrained, else Isolated.
    const CLASSES = [
        { key: 'Reachable',   min: 66, color: '#31a354', label: 'Reachable — authorities can reach quickly' },
        { key: 'Constrained', min: 40, color: '#fc8d59', label: 'Constrained — slowed/limited access' },
        { key: 'Isolated',    min: 0,  color: '#b30000', label: 'Isolated — hard to reach in an emergency' },
    ];
    const _COLOR = CLASSES.reduce((m, c) => (m[c.key] = c.color, m), {});

    // Signal weights (sum = 1.00). Police reach and on/near-arterial network
    // reach dominate; flow, chokepoint, sealability and critical-link refine it.
    const WEIGHTS = {
        policeReach: 0.30,
        networkReach: 0.28,
        flow: 0.17,
        chokepointFree: 0.13,
        notSealable: 0.07,
        criticalLinkFree: 0.05,
    };

    // Normalisation caps.
    const POLICE_CAP_KM = 5;     // >=5 km from a station → policeReach 0
    const BETW_CAP = 0.05;       // edge-betweenness at/above this → full arterial reach
    const DENS_MULT = 2;         // road-density cap = res_m * this

    /** Clamp a number to [0,1]. */
    function _clamp01(x) {
        if (!Number.isFinite(x)) return 0;
        return x < 0 ? 0 : x > 1 ? 1 : x;
    }

    /** Band label for a 0..100 index (null when not finite). */
    function bandFor(index) {
        if (index == null || !Number.isFinite(index)) return null;
        for (const c of CLASSES) if (index >= c.min) return c.key;
        return CLASSES[CLASSES.length - 1].key;
    }

    /** Colour for a band (transparent when unknown). */
    function classColor(band) {
        return _COLOR[band] || 'rgba(0,0,0,0)';
    }

    /**
     * Compute the EAI from a combined per-cell signals object (see
     * EmergencyAccess.combine). Returns { index 0..100, band, components } or
     * null when the cell has no road in either grid (honest "no data").
     * Unknown sub-signals degrade to a neutral 0.5 (police/flow) or 0
     * (network), never throwing.
     */
    function computeIndex(signals) {
        if (!signals || !signals.hasRoad) return null;
        const densCap = (Number(signals.res_m) || 200) * DENS_MULT;

        // policeReach: near a station → 1; at/beyond the cap → 0; unknown → 0.5.
        const policeReach = (signals.nearest_police_km == null)
            ? 0.5
            : _clamp01(1 - signals.nearest_police_km / POLICE_CAP_KM);

        // networkReach: on/near a major artery (edge betweenness) blended with
        // local road density — both make a cell physically easier to drive to.
        const betw = (signals.betweenness_max == null) ? 0 : _clamp01(signals.betweenness_max / BETW_CAP);
        const dens = (signals.road_density_m == null) ? 0 : _clamp01(signals.road_density_m / densCap);
        const networkReach = 0.6 * betw + 0.4 * dens;

        // flow: free-flowing roads → faster response; unknown → 0.5.
        const flow = (signals.congestion_risk == null)
            ? 0.5
            : _clamp01(1 - signals.congestion_risk / 100);

        // Penalty signals → "free" sub-scores. A known-clear cell scores 1, a
        // flagged one 0, and an *unknown* flag (null/undefined — e.g. a
        // traffic-only road cell with no mobility record) a neutral 0.5 rather
        // than the optimistic 1, so missing data never inflates accessibility.
        const _free = (flag) => (flag == null ? 0.5 : (flag ? 0 : 1));
        const chokepointFree = _free(signals.on_chokepoint);
        const notSealable = _free(signals.sealable);
        const criticalLinkFree = _free(signals.has_critical_link);

        const components = { policeReach, networkReach, flow, chokepointFree, notSealable, criticalLinkFree };
        let sum = 0;
        for (const k in WEIGHTS) sum += WEIGHTS[k] * components[k];
        const index = Math.round(_clamp01(sum) * 100);
        return { index, band: bandFor(index), components };
    }

    return { CLASSES, WEIGHTS, computeIndex, bandFor, classColor };
})();

if (typeof window !== 'undefined') window.EmergencyAccessScore = EmergencyAccessScore;
