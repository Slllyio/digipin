/**
 * EmergencyAccess — bridges the two committed precomputed grids
 * (mobility_grid.json via MobilityGrid + traffic_grid.json via TrafficGrid) into
 * the Emergency Accessibility Index. combine() is pure (unit-tested); sampleAt()
 * scores a single lat/lng for the cell panel; sampleGrids() computes the whole
 * aligned grid for the choropleth overlay. No DOM. See EmergencyAccessScore.
 */
const EmergencyAccess = (() => {
    /**
     * Pure — merge a MobilityGrid sample (mob, may be null) and a TrafficGrid
     * sample (traf, may be null) into the signals object EmergencyAccessScore
     * .computeIndex consumes. `hasRoad` is true when either grid scored the cell.
     */
    function combine(mob, traf) {
        mob = mob || null;
        traf = traf || null;
        const trafHasRoad = !!(traf && (
            (traf.road_density_m != null && traf.road_density_m > 0) ||
            (traf.betweenness_max != null && traf.betweenness_max > 0)
        ));
        return {
            hasRoad: !!mob || trafHasRoad,
            nearest_police_km: mob ? mob.nearest_police_km : null,
            on_chokepoint: !!(mob && mob.on_chokepoint),
            sealable: !!(mob && mob.sealable),
            betweenness_max: traf ? traf.betweenness_max : null,
            road_density_m: traf ? traf.road_density_m : null,
            congestion_risk: traf ? traf.congestion_risk : null,
            has_critical_link: !!(traf && traf.has_critical_link),
            res_m: (traf && traf.res_m) || (mob && mob.res_m) || 200,
        };
    }

    /** Per-cell mobility record straight from a loaded grid by row-major index
     *  (mirrors MobilityGrid.sample); null for an unscored cell. */
    function _mobAt(grid, i) {
        if (!grid) return null;
        const risk = grid.mobility_risk ? grid.mobility_risk[i] : null;
        const cls = grid.access_class ? grid.access_class[i] : null;
        if (risk == null && cls == null) return null;
        return {
            mobility_risk: risk,
            access_class: cls,
            sealable: !!(grid.sealable && grid.sealable[i]),
            on_chokepoint: !!(grid.on_chokepoint && grid.on_chokepoint[i]),
            nearest_police_km: grid.nearest_police_km ? grid.nearest_police_km[i] : null,
        };
    }

    /** Per-cell traffic record straight from a loaded grid by row-major index
     *  (mirrors TrafficGrid.sample's EAI-relevant fields). */
    function _trafAt(grid, i) {
        if (!grid) return null;
        const at = (arr) => (arr && arr[i] != null) ? arr[i] : null;
        return {
            congestion_risk: at(grid.congestion_risk),
            road_density_m: at(grid.road_density_m),
            has_critical_link: !!at(grid.has_critical_link),
            betweenness_max: at(grid.betweenness_max),
            res_m: grid.res_m,
        };
    }

    /**
     * Pure — compute the EAI for every scored cell of the two aligned grids
     * (they share bounds/nx/ny). Returns a parallel grid
     * { bounds, nx, ny, res_m, index:[..|null], band:[..|null] } or null when
     * neither grid is usable. Used by the choropleth overlay.
     */
    function sampleGrids(mobGrid, trafGrid) {
        const ref = mobGrid || trafGrid;
        if (!ref || !ref.bounds || !ref.nx || !ref.ny) return null;
        if (typeof EmergencyAccessScore === 'undefined') return null;
        const nx = ref.nx, ny = ref.ny, n = nx * ny;
        const index = new Array(n).fill(null);
        const band = new Array(n).fill(null);
        for (let i = 0; i < n; i++) {
            const r = EmergencyAccessScore.computeIndex(combine(_mobAt(mobGrid, i), _trafAt(trafGrid, i)));
            if (r) { index[i] = r.index; band[i] = r.band; }
        }
        return { bounds: ref.bounds, nx, ny, res_m: ref.res_m, index, band };
    }

    /** Load both grids (best-effort) and return them as { mobGrid, trafGrid }. */
    async function loadGrids() {
        const [mobGrid, trafGrid] = await Promise.all([
            (typeof MobilityGrid !== 'undefined') ? MobilityGrid.load() : Promise.resolve(null),
            (typeof TrafficGrid !== 'undefined') ? TrafficGrid.load() : Promise.resolve(null),
        ]);
        return { mobGrid, trafGrid };
    }

    /** Async — EAI for a single lat/lng (samples both grids); null when unscored. */
    async function sampleAt(lat, lng) {
        if (typeof EmergencyAccessScore === 'undefined') return null;
        const [mob, traf] = await Promise.all([
            (typeof MobilityGrid !== 'undefined') ? MobilityGrid.sampleAt(lat, lng) : Promise.resolve(null),
            (typeof TrafficGrid !== 'undefined') ? TrafficGrid.sampleAt(lat, lng) : Promise.resolve(null),
        ]);
        return EmergencyAccessScore.computeIndex(combine(mob, traf));
    }

    return { combine, sampleGrids, sampleAt, loadGrids };
})();

if (typeof window !== 'undefined') window.EmergencyAccess = EmergencyAccess;
