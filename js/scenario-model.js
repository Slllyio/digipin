/**
 * ScenarioModel — "what-if" lenses applied on top of the base CA-ML growth
 * probability (CAGrowthOverlay / realtime-growth `ca_growth_prob`).
 *
 * IMPORTANT (honesty): this is NOT a re-trained model run. Regenerating the
 * CA-RF surface needs the offline pipeline (pipeline/growth/urban_ca_ml.py) and
 * cannot run in the browser. Instead these are transparent, explainable
 * adjustments to the base probability so a planner can reason about "what would
 * steer growth here" — each is a simple, documented rule, badged "illustrative".
 *
 * Pure + unit-tested (tests/scenario-model.test.js). See docs/CA_GROWTH_MODEL.md.
 */
const ScenarioModel = (() => {
    const SCENARIOS = [
        { id: 'baseline',      label: 'Baseline (model as-is)',      needsAnchor: false },
        { id: 'transit_hub',   label: 'New transit hub (pick a point)', needsAnchor: true },
        { id: 'protect_flood', label: 'Protect flood-prone land',    needsAnchor: false },
        { id: 'curb_sprawl',   label: 'Curb urban-edge sprawl',      needsAnchor: false },
    ];

    /** "Likely urban" threshold (matches CAGrowthOverlay's "Likely" band). */
    const LIKELY = 45;

    function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    /**
     * Adjust one cell's base probability for a scenario. Pure.
     * @param {string} scenario  one of SCENARIOS[].id
     * @param {object} ctx       { prob:0..100|null, floodRisk:0..100|null,
     *                             roadDensity:metres|null, anchorKm:km|null }
     * @returns {{prob:number|null, delta:number}}
     */
    function adjust(scenario, ctx) {
        const base = ctx && Number.isFinite(ctx.prob) ? ctx.prob : null;
        if (base == null) return { prob: null, delta: 0 };
        let p = base;

        if (scenario === 'transit_hub' && Number.isFinite(ctx.anchorKm)) {
            // A new hub lifts nearby growth: +25 at the hub, linearly to 0 by 3 km.
            p += 25 * _clamp(1 - ctx.anchorKm / 3, 0, 1);
        } else if (scenario === 'protect_flood') {
            // Steer growth away from flood-prone land.
            const fr = Number.isFinite(ctx.floodRisk) ? ctx.floodRisk : 0;
            if (fr >= 60) p *= 0.4;
            else if (fr >= 40) p *= 0.7;
        } else if (scenario === 'curb_sprawl') {
            // Suppress growth where little road exists yet (the sprawling edge).
            const rd = Number.isFinite(ctx.roadDensity) ? ctx.roadDensity : null;
            if (rd != null && rd < 50) p *= 0.5;
            else if (rd != null && rd < 150) p *= 0.8;
        }

        p = Math.round(_clamp(p, 0, 100));
        return { prob: p, delta: p - base };
    }

    /**
     * Aggregate scenario impact across sampled cells. Pure.
     * @param {Array<{base:number|null, scen:number|null}>} cells
     * @returns {{gained:number, lost:number, meanDelta:number, n:number}}
     *   gained/lost = cells crossing the LIKELY threshold up/down.
     */
    function summarize(cells) {
        let gained = 0, lost = 0, sumDelta = 0, n = 0;
        for (const c of cells || []) {
            if (!c || !Number.isFinite(c.base) || !Number.isFinite(c.scen)) continue;
            n++;
            sumDelta += (c.scen - c.base);
            const wasLikely = c.base >= LIKELY, nowLikely = c.scen >= LIKELY;
            if (!wasLikely && nowLikely) gained++;
            else if (wasLikely && !nowLikely) lost++;
        }
        return { gained, lost, meanDelta: n ? Math.round(sumDelta / n) : 0, n };
    }

    return { SCENARIOS, adjust, summarize, LIKELY };
})();

if (typeof window !== 'undefined') window.ScenarioModel = ScenarioModel;
