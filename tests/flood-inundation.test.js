/**
 * FloodInundation pure helpers — grid sampling, bilinear interpolation,
 * and elevation-field upsampling that drive the on-map flood overlay.
 * (The canvas frame build + MapLibre wiring need a DOM/map and are exercised
 * in the browser, not here.)
 */
import { describe, it, expect } from 'vitest';

const { gridPoints, bilinear, upsample } = globalThis.FloodInundation;

describe('FloodInundation.gridPoints()', () => {
    it('produces a g×g grid centred on the cell, row 0 = north', () => {
        const g = 16;
        const { lats, lngs, bounds } = gridPoints(22.72, 75.86, g);
        expect(lats).toHaveLength(g * g);
        expect(lngs).toHaveLength(g * g);
        expect(bounds.north).toBeGreaterThan(bounds.south);   // row 0 is north
        expect(bounds.east).toBeGreaterThan(bounds.west);
        // the box brackets the centre point
        expect(bounds.north).toBeGreaterThan(22.72);
        expect(bounds.south).toBeLessThan(22.72);
        expect(bounds.west).toBeLessThan(75.86);
        expect(bounds.east).toBeGreaterThan(75.86);
        // first sample is the NW corner, last is the SE corner
        expect(lats[0]).toBeCloseTo(bounds.north, 6);
        expect(lngs[0]).toBeCloseTo(bounds.west, 6);
        expect(lats[g * g - 1]).toBeCloseTo(bounds.south, 6);
        expect(lngs[g * g - 1]).toBeCloseTo(bounds.east, 6);
    });

    it('widens longitude span vs latitude to stay roughly square on the ground', () => {
        const { bounds } = gridPoints(60, 10, 16);   // high latitude → big cos() stretch
        const latSpan = bounds.north - bounds.south;
        const lngSpan = bounds.east - bounds.west;
        expect(lngSpan).toBeGreaterThan(latSpan);
    });
});

describe('FloodInundation.bilinear()', () => {
    // 2×2 grid: corners 0,10 / 20,30 (row-major: [TL,TR,BL,BR])
    const grid = Float32Array.from([0, 10, 20, 30]);

    it('returns exact corner values', () => {
        expect(bilinear(grid, 2, 0, 0)).toBe(0);
        expect(bilinear(grid, 2, 1, 0)).toBe(10);
        expect(bilinear(grid, 2, 0, 1)).toBe(20);
        expect(bilinear(grid, 2, 1, 1)).toBe(30);
    });

    it('interpolates the centre as the mean of the four corners', () => {
        expect(bilinear(grid, 2, 0.5, 0.5)).toBeCloseTo(15, 6);
    });

    it('clamps out-of-range coordinates to the edge', () => {
        expect(bilinear(grid, 2, -5, -5)).toBe(0);
        expect(bilinear(grid, 2, 99, 99)).toBe(30);
    });
});

describe('FloodInundation.upsample()', () => {
    it('expands a g×g grid to r×r preserving corner values', () => {
        const g = 2, r = 8;
        const grid = Float32Array.from([0, 10, 20, 30]);
        const field = upsample(grid, g, r);
        expect(field).toHaveLength(r * r);
        expect(field[0]).toBeCloseTo(0, 6);                 // NW
        expect(field[r - 1]).toBeCloseTo(10, 6);            // NE
        expect(field[(r - 1) * r]).toBeCloseTo(20, 6);      // SW
        expect(field[r * r - 1]).toBeCloseTo(30, 6);        // SE
    });

    it('is monotonic along a ramp (no overshoot)', () => {
        const grid = Float32Array.from([0, 10, 20, 30]);
        const field = upsample(grid, 2, 16);
        for (const v of field) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(30);
        }
    });
});
