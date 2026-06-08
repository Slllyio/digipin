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
        // COG no-data cells can surface as NaN; a NaN here would propagate to a
        // NaN composite that the consumer's `== null` check wouldn't catch.
        if (!Number.isFinite(last) || !Number.isFinite(prev)) return null;
        const yoyPct = prev > 0 ? ((last - prev) / prev) * 100 : 0;
        const h1 = heights && heights.length >= 2 ? heights[heights.length - 1] : null;
        const h0 = heights && heights.length >= 2 ? heights[heights.length - 2] : null;
        const heightYoy = (Number.isFinite(h1) && Number.isFinite(h0)) ? (h1 - h0) : 0;
        const osmBoost = Math.min(10, (osm_construction_count || 0) * 2);
        const score = 50
            + 25 * Math.tanh(yoyPct / 8)
            + 15 * Math.tanh(heightYoy)
            + osmBoost;
        return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null;
    }

    /** Densification (DEN).
     *  Inputs:
     *    ghsl_pop_5yr_pct:       number  GHSL pop grid delta 2020→2025 (%)
     *    osm_commercial_density: number  POI density per km² */
    function denSubScore({ ghsl_pop_5yr_pct, osm_commercial_density }) {
        if (ghsl_pop_5yr_pct == null || !Number.isFinite(ghsl_pop_5yr_pct)) return null;
        const popTerm = 25 * Math.tanh(ghsl_pop_5yr_pct / 15);
        const commTerm = Math.min(15, (osm_commercial_density || 0) / 8);
        return Math.max(0, Math.min(100, 50 + popTerm + commTerm));
    }

    /** Log-scale normaliser: maps 0..anchor to 0..100 smoothly.
     *  Same shape as the normLog used in data-fetcher.js. */
    function normLog(val, anchor) {
        if (val <= 0) return 0;
        return Math.min(100, Math.round((Math.log(1 + val) / Math.log(1 + anchor)) * 100));
    }

    /** Capital Flow (CAP).
     *  rera_projects: Array<{ value, age_yrs, distance_km }>  | null
     *  null = source unavailable (out of state). Empty array = no projects nearby. */
    function capSubScore({ rera_projects }) {
        if (rera_projects == null) return null;
        if (rera_projects.length === 0) return 0;
        const weightedSum = rera_projects.reduce((acc, p) => {
            const w = Math.exp(-p.age_yrs / 2) * Math.exp(-p.distance_km / 1.5);
            return acc + (p.value || 0) * w;
        }, 0);
        return normLog(weightedSum, 500_000_000);
    }

    const HORIZON_WEIGHTS = {
        nowcast: { bue: 0.4, den: 0.3, cap: 0.3 },
        year_2:  { bue: 0.2, den: 0.2, cap: 0.6 },
        year_5:  { bue: 0.4, den: 0.3, cap: 0.3 },  // base weights; year_5 also uses linearTrend
    };

    /** Composite for one horizon. Re-normalises weights when sub-scores are null.
     *  Returns { composite, effective_weights }. */
    function composite(sub, horizon) {
        const base = HORIZON_WEIGHTS[horizon] || HORIZON_WEIGHTS.nowcast;
        let totalWeight = 0;
        const effective = { bue: 0, den: 0, cap: 0 };
        for (const dim of ['bue', 'den', 'cap']) {
            if (sub[dim] != null) {
                effective[dim] = base[dim];
                totalWeight += base[dim];
            }
        }
        if (totalWeight === 0) {
            return { composite: null, effective_weights: effective };
        }
        // Renormalise
        for (const dim of ['bue', 'den', 'cap']) {
            effective[dim] = effective[dim] / totalWeight;
        }
        let value = 0;
        for (const dim of ['bue', 'den', 'cap']) {
            if (sub[dim] != null) value += effective[dim] * sub[dim];
        }
        return {
            composite: Math.round(value),
            effective_weights: effective,
        };
    }

    /** Ordinary least squares trend on a uniformly-spaced series.
     *  Returns { slope, intercept, r_squared } or null if too short. */
    function linearTrend(values) {
        if (!values || values.length < 3) return null;
        const n = values.length;
        const xs = values.map((_, i) => i);
        const meanX = xs.reduce((a, b) => a + b, 0) / n;
        const meanY = values.reduce((a, b) => a + b, 0) / n;
        let num = 0, den = 0, totSS = 0;
        for (let i = 0; i < n; i++) {
            num += (xs[i] - meanX) * (values[i] - meanY);
            den += (xs[i] - meanX) ** 2;
            totSS += (values[i] - meanY) ** 2;
        }
        const slope = den === 0 ? 0 : num / den;
        const intercept = meanY - slope * meanX;
        let resSS = 0;
        for (let i = 0; i < n; i++) {
            const pred = slope * xs[i] + intercept;
            resSS += (values[i] - pred) ** 2;
        }
        const r_squared = totSS === 0 ? 1 : Math.max(0, Math.min(1, 1 - resSS / totSS));
        return { slope, intercept, r_squared };
    }

    /** Per-horizon confidence band (±value). */
    function confidenceBand(horizon, r_squared) {
        if (horizon === 'nowcast') return 5;
        if (horizon === 'year_2') return 10;
        // year_5: tight when trend is stable, wide when noisy. Floor at ±10.
        const r2 = (r_squared == null || r_squared < 0) ? 0 : r_squared;
        return Math.max(10, Math.round(25 * (1 - r2)));
    }

    return { bueSubScore, denSubScore, capSubScore, normLog,
             composite, HORIZON_WEIGHTS, linearTrend, confidenceBand };
})();

if (typeof window !== 'undefined') window.GrowthScore = GrowthScore;
