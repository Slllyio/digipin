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
