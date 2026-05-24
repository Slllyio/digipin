/**
 * GrowthScore — pure functions for the Urban Growth Forecast score model.
 *
 * Spec reference: docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md §5
 *
 * All functions are deterministic, side-effect-free, and DOM-free —
 * fully testable in Vitest without mocks. The browser orchestrator
 * (js/realtime-growth.js) supplies the inputs; this module just does math.
 */

const GrowthScore = (() => {
    /** Built-up Expansion (BUE).
     *  Inputs:
     *    buildings_temporal: number[]  Open Buildings Temporal V1 presence 2016..2023
     *    heights:            number[]  building heights (metres) 2016..2023
     *    osm_construction_count: number  OSM landuse=construction POIs in 500m radius
     *  Returns 0..100 or null when no temporal data is available. */
    function bueSubScore({ buildings_temporal, heights, osm_construction_count }) {
        if (!buildings_temporal || buildings_temporal.length < 2) return null;
        const n = buildings_temporal.length;
        const last = buildings_temporal[n - 1];
        const prev = buildings_temporal[n - 2];
        const yoyPct = prev > 0 ? ((last - prev) / prev) * 100 : 0;
        const heightYoy = heights && heights.length >= 2
            ? (heights[heights.length - 1] - heights[heights.length - 2])
            : 0;
        const osmBoost = Math.min(10, (osm_construction_count || 0) * 2);
        const score = 50
            + 25 * Math.tanh(yoyPct / 8)
            + 15 * Math.tanh(heightYoy)
            + osmBoost;
        return Math.max(0, Math.min(100, score));
    }

    return { bueSubScore };
})();

if (typeof window !== 'undefined') window.GrowthScore = GrowthScore;
