/**
 * FootprintGrid — pure grid index/sample logic over the precomputed
 * building-footprint density grid.
 */
import { describe, it, expect } from 'vitest';

const FG = globalThis.FootprintGrid;

// 2×2 grid over a 0.4°×0.4° bbox; row 0 = north.
const GRID = {
    res_m: 100,
    bounds: { west: 75.6, south: 22.5, east: 76.0, north: 22.9 },
    nx: 2, ny: 2,
    count: [10, 20, 30, 40],          // [NW, NE, SW, SE]
    coveragePct: [12, 24, 36, 48],
    meanAreaM2: [80, 90, 100, 110],
    source: 'google_open_buildings',
};

describe('FootprintGrid.indexFor()', () => {
    it('maps NW / NE / SW / SE corners to the right cells', () => {
        expect(FG.indexFor(GRID, 22.88, 75.61)).toBe(0); // NW
        expect(FG.indexFor(GRID, 22.88, 75.99)).toBe(1); // NE
        expect(FG.indexFor(GRID, 22.51, 75.61)).toBe(2); // SW
        expect(FG.indexFor(GRID, 22.51, 75.99)).toBe(3); // SE
    });
    it('returns -1 outside the grid bounds', () => {
        expect(FG.indexFor(GRID, 50, 50)).toBe(-1);
        expect(FG.indexFor(GRID, 22.7, 80)).toBe(-1);
    });
});

describe('FootprintGrid.sample()', () => {
    it('returns the cell stats for a lat/lng', () => {
        const s = FG.sample(GRID, 22.51, 75.99);   // SE cell
        expect(s.count).toBe(40);
        expect(s.coveragePct).toBe(48);
        expect(s.meanAreaM2).toBe(110);
        expect(s.source).toBe('google_open_buildings');
    });
    it('returns null outside the grid', () => {
        expect(FG.sample(GRID, 0, 0)).toBeNull();
    });
});
