/**
 * GrowthScore — Urban Growth Forecast score-model tests.
 *
 * Spec: docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md §5
 * Plan: docs/superpowers/plans/2026-05-24-urban-growth-forecast.md Tasks 2-6
 *
 * GrowthScore is loaded as a globalThis property by tests/setup.js
 * (which uses the IIFE-global-expose pattern).
 */

import { describe, it, expect } from 'vitest';

describe('GrowthScore.bueSubScore()', () => {
    it('returns the 50 anchor for flat year + zero osm', () => {
        const s = globalThis.GrowthScore.bueSubScore({
            buildings_temporal: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],  // 2016-2023, flat
            heights: [3, 3, 3, 3, 3, 3, 3, 3],
            osm_construction_count: 0,
        });
        expect(s).toBe(50);
    });

    it('rises above 50 for strong YoY growth', () => {
        const s = globalThis.GrowthScore.bueSubScore({
            buildings_temporal: [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],   // +16% YoY 2022→2023
            heights: [3, 3, 3, 4, 4, 5, 5, 6],
            osm_construction_count: 3,
        });
        expect(s).toBeGreaterThan(70);
        expect(s).toBeLessThanOrEqual(100);
    });

    it('returns null when buildings_temporal is empty', () => {
        const s = globalThis.GrowthScore.bueSubScore({
            buildings_temporal: [],
            heights: [],
            osm_construction_count: 5,
        });
        expect(s).toBeNull();
    });

    it('returns null (not NaN) when the last temporal band is no-data NaN', () => {
        const s = globalThis.GrowthScore.bueSubScore({
            buildings_temporal: [0.5, 0.5, 0.5, NaN],   // COG no-data cell
            heights: [3, 3, 3, 3],
            osm_construction_count: 2,
        });
        expect(s).toBeNull();
    });

    it('ignores NaN heights instead of poisoning the score', () => {
        const s = globalThis.GrowthScore.bueSubScore({
            buildings_temporal: [0.5, 0.5, 0.5, 0.5],   // flat → 50 anchor
            heights: [3, 3, 3, NaN],
            osm_construction_count: 0,
        });
        expect(s).toBe(50);
    });
});

describe('GrowthScore.denSubScore()', () => {
    it('returns 50 for zero population growth and zero commercial', () => {
        const s = globalThis.GrowthScore.denSubScore({
            ghsl_pop_5yr_pct: 0,
            osm_commercial_density: 0,
        });
        expect(s).toBe(50);
    });

    it('saturates near the upper bound for +30% population growth', () => {
        const s = globalThis.GrowthScore.denSubScore({
            ghsl_pop_5yr_pct: 30,
            osm_commercial_density: 80,
        });
        expect(s).toBeGreaterThan(80);
    });

    it('returns null when ghsl_pop_5yr_pct is missing', () => {
        const s = globalThis.GrowthScore.denSubScore({
            ghsl_pop_5yr_pct: null,
            osm_commercial_density: 10,
        });
        expect(s).toBeNull();
    });

    it('returns null (not NaN) when ghsl_pop_5yr_pct is no-data NaN', () => {
        const s = globalThis.GrowthScore.denSubScore({
            ghsl_pop_5yr_pct: NaN,
            osm_commercial_density: 10,
        });
        expect(s).toBeNull();
    });
});

describe('GrowthScore.capSubScore()', () => {
    const projects = [
        // [project_value_rupees, age_years, distance_km]
        { value: 100_000_000, age_yrs: 1, distance_km: 0.5 },
        { value: 250_000_000, age_yrs: 2, distance_km: 1.0 },
        { value: 50_000_000,  age_yrs: 3, distance_km: 2.0 },
    ];

    it('returns 0 for empty project list', () => {
        const s = globalThis.GrowthScore.capSubScore({ rera_projects: [] });
        expect(s).toBe(0);
    });

    it('returns null when rera_projects is undefined (out-of-state)', () => {
        const s = globalThis.GrowthScore.capSubScore({ rera_projects: null });
        expect(s).toBeNull();
    });

    it('produces a positive score for nearby recent projects', () => {
        const s = globalThis.GrowthScore.capSubScore({ rera_projects: projects });
        expect(s).toBeGreaterThan(20);
        expect(s).toBeLessThanOrEqual(100);
    });

    it('weights closer/newer projects more than far/old ones', () => {
        const near = globalThis.GrowthScore.capSubScore({
            rera_projects: [{ value: 100_000_000, age_yrs: 0.5, distance_km: 0.3 }]
        });
        const far = globalThis.GrowthScore.capSubScore({
            rera_projects: [{ value: 100_000_000, age_yrs: 5, distance_km: 1.8 }]
        });
        expect(near).toBeGreaterThan(far);
    });
});

describe('GrowthScore.composite()', () => {
    const sub = { bue: 80, den: 60, cap: 40 };

    it('applies nowcast weights 0.4/0.3/0.3', () => {
        const c = globalThis.GrowthScore.composite(sub, 'nowcast');
        // 0.4*80 + 0.3*60 + 0.3*40 = 32 + 18 + 12 = 62
        expect(c.composite).toBe(62);
        expect(c.effective_weights).toEqual({ bue: 0.4, den: 0.3, cap: 0.3 });
    });

    it('applies 1-2 year weights 0.2/0.2/0.6', () => {
        const c = globalThis.GrowthScore.composite(sub, 'year_2');
        // 0.2*80 + 0.2*60 + 0.6*40 = 16 + 12 + 24 = 52
        expect(c.composite).toBe(52);
    });

    it('re-weights remaining when cap is null', () => {
        const c = globalThis.GrowthScore.composite(
            { bue: 80, den: 60, cap: null },
            'nowcast'
        );
        // Original weights 0.4 + 0.3 = 0.7; normalised: bue=0.571, den=0.429
        // 0.571*80 + 0.429*60 = 45.7 + 25.7 = 71.4 → 71
        expect(c.composite).toBe(71);
        expect(c.effective_weights.cap).toBe(0);
        expect(c.effective_weights.bue + c.effective_weights.den).toBeCloseTo(1, 5);
    });

    it('returns composite=null when all sub-scores are null', () => {
        const c = globalThis.GrowthScore.composite(
            { bue: null, den: null, cap: null },
            'nowcast'
        );
        expect(c.composite).toBeNull();
    });
});

describe('GrowthScore.linearTrend()', () => {
    it('returns slope=1 + r²=1 for a perfect line y=x', () => {
        const t = globalThis.GrowthScore.linearTrend([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(t.slope).toBeCloseTo(1, 5);
        expect(t.r_squared).toBeCloseTo(1, 5);
    });

    it('returns slope=0 for a flat series', () => {
        const t = globalThis.GrowthScore.linearTrend([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
        expect(t.slope).toBeCloseTo(0, 5);
    });

    it('returns null for series shorter than 3', () => {
        expect(globalThis.GrowthScore.linearTrend([0.5, 0.5])).toBeNull();
    });
});

describe('GrowthScore.emergingClass()', () => {
    const ec = (l, s, o) => globalThis.GrowthScore.emergingClass(l, s, o);

    it('returns null when level is unknown', () => {
        expect(ec(null, 1)).toBeNull();
        expect(ec(NaN, 1)).toBeNull();
    });

    it('classifies hot cells by trend direction', () => {
        expect(ec(80, 3).category).toBe('intensifying');   // high + rising
        expect(ec(80, -3).category).toBe('diminishing');   // high + falling
        expect(ec(80, 0).category).toBe('persistent');     // high + flat
    });

    it('classifies cool cells by trend direction', () => {
        expect(ec(30, 3).category).toBe('emerging');       // low but rising → forming
        expect(ec(30, -3).category).toBe('cooling');       // low + falling
        expect(ec(30, 0).category).toBe('stable');         // low + flat
    });

    it('treats a non-finite slope as flat', () => {
        expect(ec(80, NaN).category).toBe('persistent');
        expect(ec(30, undefined).category).toBe('stable');
    });

    it('honours custom thresholds and yields a colour + label', () => {
        const r = ec(50, 2, { hotLevel: 40, slopeEps: 1 });
        expect(r.category).toBe('intensifying');
        expect(r.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(r.label).toBeTruthy();
    });
});

describe('GrowthScore.confidenceBand()', () => {
    it('returns 5 for nowcast regardless of r²', () => {
        expect(globalThis.GrowthScore.confidenceBand('nowcast', 0.0)).toBe(5);
        expect(globalThis.GrowthScore.confidenceBand('nowcast', 1.0)).toBe(5);
    });

    it('returns 10 for year_2 regardless of r²', () => {
        expect(globalThis.GrowthScore.confidenceBand('year_2', 0.5)).toBe(10);
    });

    it('returns ±10 (floor) for year_5 with r²=1', () => {
        expect(globalThis.GrowthScore.confidenceBand('year_5', 1.0)).toBe(10);
    });

    it('returns ±25 for year_5 with r²=0', () => {
        expect(globalThis.GrowthScore.confidenceBand('year_5', 0.0)).toBe(25);
    });

    it('returns floor ±10 for negative or null r²', () => {
        expect(globalThis.GrowthScore.confidenceBand('year_5', null)).toBe(25);
        expect(globalThis.GrowthScore.confidenceBand('year_5', -0.2)).toBe(25);
    });
});
