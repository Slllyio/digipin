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
