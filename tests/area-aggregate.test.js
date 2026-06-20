import { describe, it, expect } from 'vitest';

// AreaAggregate is exposed on globalThis by tests/setup.js. The geometry +
// aggregation helpers are pure; the drag/render UI is browser-only.
const A = globalThis.AreaAggregate;

describe('AreaAggregate.rectFromPoints / rectContains', () => {
    const rect = A.rectFromPoints({ lat: 22.8, lng: 75.7 }, { lat: 22.6, lng: 75.9 });

    it('normalises two corners into W/S/E/N', () => {
        expect(rect).toEqual({ west: 75.7, east: 75.9, south: 22.6, north: 22.8 });
    });
    it('contains interior points and excludes outside ones', () => {
        expect(A.rectContains(rect, 22.7, 75.8)).toBe(true);
        expect(A.rectContains(rect, 22.9, 75.8)).toBe(false);
        expect(A.rectContains(rect, 22.7, 76.5)).toBe(false);
    });
});

describe('AreaAggregate.samplePoints', () => {
    const rect = { west: 0, east: 1, south: 0, north: 1 };
    it('produces n×n evenly spaced centres inside the rect', () => {
        const pts = A.samplePoints(rect, 4);
        expect(pts).toHaveLength(16);
        for (const p of pts) {
            expect(p.lat).toBeGreaterThan(0);
            expect(p.lat).toBeLessThan(1);
            expect(p.lng).toBeGreaterThan(0);
            expect(p.lng).toBeLessThan(1);
        }
    });
    it('returns nothing for a degenerate (zero-area) rect', () => {
        expect(A.samplePoints({ west: 1, east: 1, south: 0, north: 1 }, 4)).toHaveLength(0);
    });
});

describe('AreaAggregate.aggregate', () => {
    const cells = [
        { scores: { livability: { value: 80, label: 'Livability' }, safety: { value: 60, label: 'Safety' } } },
        { scores: { livability: { value: 60, label: 'Livability' }, safety: { value: 40, label: 'Safety' } } },
        { scores: { livability: { value: 70, label: 'Livability' } } },   // no safety
        { scores: {} },                                                    // unscored — ignored
        null,                                                              // ignored
    ];
    const agg = A.aggregate(cells);

    it('counts only scored cells', () => {
        expect(agg.count).toBe(3);
    });
    it('computes avg/min/max per score', () => {
        expect(agg.perScore.livability).toEqual({ avg: 70, min: 60, max: 80, label: 'Livability' });
        expect(agg.perScore.safety).toEqual({ avg: 50, min: 40, max: 60, label: 'Safety' });
    });
    it('handles empty input', () => {
        expect(A.aggregate([])).toEqual({ count: 0, perScore: {} });
    });
    it('accepts plain {key:value} score maps too', () => {
        const a = A.aggregate([{ walk: 50 }, { walk: 100 }]);
        expect(a.perScore.walk).toEqual({ avg: 75, min: 50, max: 100, label: 'walk' });
    });
});
