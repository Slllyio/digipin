/**
 * FloodSCS — SCS Curve Number rainfall→runoff model.
 *
 * The classic empirical model from USDA Soil Conservation Service.
 * Used by virtually every civil engineering hydrology textbook in
 * India. Inputs: a rainfall depth (mm) and a Curve Number CN that
 * encodes the soil + land use combination. Output: direct runoff
 * depth (mm) — the portion of rainfall that becomes overland flow
 * rather than infiltrating or being intercepted.
 *
 * Formula:
 *     S  = 25400 / CN - 254       potential maximum retention (mm)
 *     Iₐ = 0.2 × S                initial abstraction (mm)
 *     Q  = (P - Iₐ)² / (P - Iₐ + S)   when P > Iₐ, else 0
 *
 * Typical CN values (Hydrologic Soil Group B, AMC II):
 *     30  - dense forest
 *     50  - rural mix
 *     65  - residential, mostly pervious
 *     80  - urban India, mixed pavement + roof + small green   <-- default
 *     90  - dense urban, mostly paved
 *     98  - impervious roof / asphalt
 *
 * Why default CN=80 for DigiPin: most cells in the Indore pilot are
 * a mix of low-rise residential + roads. CN 80 produces realistic
 * runoff for the 50-150 mm/day monsoon events the slider explores.
 *
 * Depth-of-flood conversion:
 *   Real conversion of runoff (mm) to local flood depth (m) requires
 *   a hydraulic model (cross-section + Manning's roughness + routing).
 *   We don't have that. The portal exposes a transparent linear scale
 *   instead: 1 mm of runoff → DEPTH_PER_RUNOFF_MM metres of extra
 *   inundation depth (default 0.02 m). The disclaimer makes this clear
 *   in the UI.
 */

const FloodSCS = (() => {
    const DEFAULT_CN = 80;
    const DEFAULT_DEPTH_PER_RUNOFF_MM = 0.02;
    // Initial-abstraction ratio Ia/S. Classic SCS uses 0.2; modern NRCS (2015)
    // and recent literature favour ~0.05 (0.2 over-estimates infiltration, i.e.
    // under-estimates runoff). Caller-overridable; the 0.2 default keeps the
    // long-standing Indore behaviour unchanged.
    const DEFAULT_IA_RATIO = 0.2;

    /** SCS-CN runoff depth (mm) for a given rainfall depth (mm), CN and Ia/S ratio. */
    function runoffMm(rainfallMm, cn = DEFAULT_CN, iaRatio = DEFAULT_IA_RATIO) {
        if (!(rainfallMm > 0) || !(cn > 0)) return 0;
        const S = (25400 / cn) - 254;
        const Ia = iaRatio * S;
        if (rainfallMm <= Ia) return 0;
        const num = (rainfallMm - Ia) ** 2;
        const den = (rainfallMm - Ia) + S;
        return num / den;
    }

    /** Linear-scale conversion runoff (mm) → extra inundation depth (m).
     *  Intentionally simple; disclosed in the UI. */
    function depthFromRunoff(runoffMmValue, depthPerRunoffMm = DEFAULT_DEPTH_PER_RUNOFF_MM) {
        if (!(runoffMmValue > 0)) return 0;
        return runoffMmValue * depthPerRunoffMm;
    }

    /** Convenience: rainfall → extra-depth in one call.
     *  Returns the intermediate runoff value too so the UI can show it. */
    function rainfallToExtraDepth(rainfallMm, cn = DEFAULT_CN, depthPerRunoffMm = DEFAULT_DEPTH_PER_RUNOFF_MM) {
        const runoff = runoffMm(rainfallMm, cn);
        return {
            rainfall_mm: rainfallMm,
            cn,
            runoff_mm: runoff,
            extra_depth_m: depthFromRunoff(runoff, depthPerRunoffMm),
        };
    }

    return { runoffMm, depthFromRunoff, rainfallToExtraDepth, DEFAULT_CN, DEFAULT_IA_RATIO };
})();

if (typeof window !== 'undefined') {
    window.FloodSCS = FloodSCS;
}
