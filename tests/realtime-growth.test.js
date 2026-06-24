import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';

// Load growth-score.js (dependency) first, then realtime-growth.js
const ctx = { globalThis, window: globalThis };
const scoreCode = readFileSync(path.join(process.cwd(), 'js/growth-score.js'), 'utf-8');
vm.runInNewContext(scoreCode, ctx);
const rtCode = readFileSync(path.join(process.cwd(), 'js/realtime-growth.js'), 'utf-8');
vm.runInNewContext(rtCode, ctx);

describe('RealtimeGrowth.scoreCell()', () => {
    const sample = {
        buildings_temporal: [0.30, 0.32, 0.35, 0.40, 0.45, 0.50, 0.55, 0.62],   // strong upward
        heights: [3, 3, 3, 4, 4, 5, 5, 6],
        viirs: [1.0, 1.0, 1.2, 1.5, 1.7, 1.9, 2.0, 2.2, 2.3],
        ghsl_pop_5yr_pct: 8,
        osm_commercial_density: 12,
        osm_construction_count: 4,
        rera_projects: [
            { value: 100_000_000, age_yrs: 1, distance_km: 0.8 },
            { value: 250_000_000, age_yrs: 2, distance_km: 1.2 },
        ],
    };

    it('returns a populated result.realtime.growth schema', () => {
        const r = globalThis.RealtimeGrowth.scoreCell(sample);
        expect(r.horizons.nowcast.composite).toBeGreaterThan(50);
        expect(r.horizons.year_2.composite).toBeGreaterThan(50);
        expect(r.horizons.year_5.composite).toBeGreaterThan(50);
        expect(r.horizons.nowcast.confidence_band).toBe(5);
        expect(r.horizons.year_2.confidence_band).toBe(10);
        expect(r.horizons.year_5.confidence_band).toBeGreaterThanOrEqual(10);
        expect(r.horizons.year_5.confidence_band).toBeLessThanOrEqual(25);
    });

    it('returns growth=null when every source is missing', () => {
        const r = globalThis.RealtimeGrowth.scoreCell({
            buildings_temporal: null,
            heights: null,
            viirs: null,
            ghsl_pop_5yr_pct: null,
            osm_commercial_density: null,
            osm_construction_count: 0,
            rera_projects: null,
        });
        expect(r).toBeNull();
    });

    it('reports source availability in result.sources', () => {
        const r = globalThis.RealtimeGrowth.scoreCell({
            ...sample,
            rera_projects: null,    // out of state
        });
        expect(r.sources.rera_mp).toBe('out_of_state');
        expect(r.sources.buildings_temporal).toBe('ok');
    });
});
