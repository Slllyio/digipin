/**
 * TrafficScore — pure scoring helpers for the structural traffic feature.
 *
 * Mirrors pipeline/traffic/road_network.py so the browser and the pipeline agree
 * on the Level-of-Service definition. No DOM, no fetch — unit-tested.
 *
 *   capacityForClass(highway)  → relative road capacity 0..1 (OSM highway class)
 *   losFromVC(vcRatio)         → { grade:'A'..'F', ratio }  (HCM V/C breakpoints)
 *   congestionRisk(vcRatio)    → 0..100 congestion-risk score
 *   transitAccessScore(headwayMin, routeCount) → 0..100 transit access
 *
 * Honest framing: a *structural* congestion proxy (betweenness ÷ capacity), not
 * live traffic. See docs/TRAFFIC_MODEL.md.
 */
const TrafficScore = (() => {
    // Keep in sync with CLASS_CAPACITY in pipeline/traffic/road_network.py.
    const CLASS_CAPACITY = {
        motorway: 1.00, motorway_link: 0.80,
        trunk: 0.90, trunk_link: 0.70,
        primary: 0.75, primary_link: 0.55,
        secondary: 0.55, secondary_link: 0.45,
        tertiary: 0.40, tertiary_link: 0.35,
        unclassified: 0.30,
        residential: 0.25, living_street: 0.15,
        service: 0.15, track: 0.10,
    };
    const DEFAULT_CAPACITY = 0.30;
    const LOS_GRADES = ['A', 'B', 'C', 'D', 'E', 'F'];
    const LOS_CUTS = [0.35, 0.55, 0.75, 0.90, 1.00];   // upper edge of A,B,C,D,E

    function capacityForClass(highway) {
        if (Array.isArray(highway)) highway = highway[0];
        return CLASS_CAPACITY[highway] != null ? CLASS_CAPACITY[highway] : DEFAULT_CAPACITY;
    }

    /** { grade:'A'..'F', ratio } from a volume/capacity ratio, or null. */
    function losFromVC(vcRatio) {
        if (vcRatio == null || !Number.isFinite(vcRatio)) return null;
        for (let i = 0; i < LOS_CUTS.length; i++) {
            if (vcRatio <= LOS_CUTS[i]) return { grade: LOS_GRADES[i], ratio: vcRatio };
        }
        return { grade: 'F', ratio: vcRatio };
    }

    /** Volume/capacity proxy: normalised betweenness ÷ class capacity. */
    function vcRatio(betweenness, capacity) {
        const cap = (capacity && capacity > 0) ? capacity : DEFAULT_CAPACITY;
        if (betweenness == null || !Number.isFinite(betweenness)) return null;
        return betweenness / cap;
    }

    /** 0..100 congestion-risk score from a V/C ratio (clamped), or null. */
    function congestionRisk(vcRatioVal) {
        if (vcRatioVal == null || !Number.isFinite(vcRatioVal)) return null;
        return Math.round(Math.max(0, Math.min(1, vcRatioVal)) * 100);
    }

    /** 0..100 transit-access score from headway (min) + route breadth.
     *  Frequency dominates (5 min → ~100, 30 min → ~0); routes add a bonus. */
    function transitAccessScore(headwayMin, routeCount) {
        let freq;
        if (headwayMin == null || !Number.isFinite(headwayMin)) freq = 10;
        else freq = Math.max(0, Math.min(100, 100 - (headwayMin - 5) * (100 / 25)));
        const breadth = Math.min(20, (routeCount || 0) * 5);
        return Math.round(Math.min(100, freq * 0.8 + breadth));
    }

    return { CLASS_CAPACITY, DEFAULT_CAPACITY, LOS_GRADES,
        capacityForClass, losFromVC, vcRatio, congestionRisk, transitAccessScore };
})();

if (typeof window !== 'undefined') window.TrafficScore = TrafficScore;
