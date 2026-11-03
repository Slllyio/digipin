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
        // Tri-state booleans: a flag is known true/false only when its source
        // record exists (the grids' flag arrays are dense, so absence within a
        // present record means "not flagged" = false). When the whole record is
        // missing (e.g. a traffic-only road cell has no mobility record) the
        // flag is genuinely unknown → null, which EmergencyAccessScore scores
        // neutrally rather than as an optimistic win.
        return {
            hasRoad: !!mob || trafHasRoad,
            nearest_police_km: mob ? mob.nearest_police_km : null,
            on_chokepoint: mob ? !!mob.on_chokepoint : null,
            sealable: mob ? !!mob.sealable : null,
            betweenness_max: traf ? traf.betweenness_max : null,
            road_density_m: traf ? traf.road_density_m : null,
            congestion_risk: traf ? traf.congestion_risk : null,
            has_critical_link: traf ? !!traf.has_critical_link : null,
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
    /** True when two grids share the same dimensions + bounds (so a row-major
     *  index refers to the same cell in both). */
    function _aligned(a, b) {
        if (a.nx !== b.nx || a.ny !== b.ny) return false;
        const x = a.bounds, y = b.bounds;
        return x.west === y.west && x.south === y.south && x.east === y.east && x.north === y.north;
    }

    function sampleGrids(mobGrid, trafGrid) {
        const ref = mobGrid || trafGrid;
        if (!ref || !ref.bounds || !ref.nx || !ref.ny) return null;
        if (typeof EmergencyAccessScore === 'undefined') return null;
        // If both grids are present but misregistered, a shared index would mix
        // different locations → wrong scores. Degrade to the reference grid
        // alone rather than emit a corrupted choropleth.
        let mg = mobGrid, tg = trafGrid;
        if (mg && tg && !_aligned(mg, tg)) {
            if (ref === mg) tg = null; else mg = null;
            console.warn('[EmergencyAccess] mobility/traffic grids misaligned — scoring from one grid');
        }
        const nx = ref.nx, ny = ref.ny, n = nx * ny;
        const index = new Array(n).fill(null);
        const band = new Array(n).fill(null);
        for (let i = 0; i < n; i++) {
            const r = EmergencyAccessScore.computeIndex(combine(_mobAt(mg, i), _trafAt(tg, i)));
            if (r) { index[i] = r.index; band[i] = r.band; }
        }
        return { bounds: ref.bounds, nx, ny, res_m: ref.res_m, index, band };
    }

    /** Resolve a promise to its value, or null if it rejects — so one grid's
     *  failure never breaks best-effort single-grid degradation. */
    function _safe(p) { return Promise.resolve(p).catch(() => null); }

    /** Load both grids (best-effort) and return them as { mobGrid, trafGrid }. */
    async function loadGrids() {
        const [mobGrid, trafGrid] = await Promise.all([
            (typeof MobilityGrid !== 'undefined') ? _safe(MobilityGrid.load()) : Promise.resolve(null),
            (typeof TrafficGrid !== 'undefined') ? _safe(TrafficGrid.load()) : Promise.resolve(null),
        ]);
        return { mobGrid, trafGrid };
    }

    /** Async — EAI for a single lat/lng (samples both grids); null when unscored. */
    async function sampleAt(lat, lng) {
        if (typeof EmergencyAccessScore === 'undefined') return null;
        const [mob, traf] = await Promise.all([
            (typeof MobilityGrid !== 'undefined') ? _safe(MobilityGrid.sampleAt(lat, lng)) : Promise.resolve(null),
            (typeof TrafficGrid !== 'undefined') ? _safe(TrafficGrid.sampleAt(lat, lng)) : Promise.resolve(null),
        ]);
        return EmergencyAccessScore.computeIndex(combine(mob, traf));
    }

    return { combine, sampleGrids, sampleAt, loadGrids };
})();

if (typeof window !== 'undefined') window.EmergencyAccess = EmergencyAccess;
