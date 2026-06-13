/**
 * KDEOverlay kernel maths — pure Gaussian KDE.
 */
import { describe, it, expect } from 'vitest';

const { gaussian, kdeAt } = globalThis.KDEOverlay;

describe('KDEOverlay.gaussian()', () => {
    it('peaks at distance 0 and decays monotonically', () => {
        const inv = 1 / (2 * 0.13 * 0.13);
        expect(gaussian(0, inv)).toBe(1);
        expect(gaussian(0.01, inv)).toBeLessThan(1);
        expect(gaussian(0.04, inv)).toBeLessThan(gaussian(0.01, inv));
        expect(gaussian(1, inv)).toBeGreaterThan(0); // never negative
    });
});

describe('KDEOverlay.kdeAt()', () => {
    const bw = 0.13;

    it('is maximal at a lone sample and falls off with distance', () => {
        const samples = [{ x: 0.5, y: 0.5, w: 1 }];
        const atCenter = kdeAt(0.5, 0.5, samples, bw);
        const nearby = kdeAt(0.55, 0.5, samples, bw);
        const far = kdeAt(0.9, 0.5, samples, bw);
        expect(atCenter).toBeCloseTo(1, 6);
        expect(nearby).toBeLessThan(atCenter);
        expect(far).toBeLessThan(nearby);
    });

    it('sums contributions from multiple samples (denser cluster = higher peak)', () => {
        const lone = [{ x: 0.5, y: 0.5, w: 1 }];
        const cluster = [
            { x: 0.5, y: 0.5, w: 1 },
            { x: 0.52, y: 0.5, w: 1 },
            { x: 0.5, y: 0.52, w: 1 },
        ];
        expect(kdeAt(0.5, 0.5, cluster, bw)).toBeGreaterThan(kdeAt(0.5, 0.5, lone, bw));
    });

    it('respects per-sample weights', () => {
        const light = [{ x: 0.5, y: 0.5, w: 10 }];
        const heavy = [{ x: 0.5, y: 0.5, w: 90 }];
        expect(kdeAt(0.5, 0.5, heavy, bw)).toBeCloseTo(9 * kdeAt(0.5, 0.5, light, bw), 6);
    });

    it('returns 0 for no samples', () => {
        expect(kdeAt(0.5, 0.5, [], bw)).toBe(0);
    });
});

describe('KDEOverlay.ramp() — viridis, colourblind-safe', () => {
    const { ramp } = globalThis.KDEOverlay;

    it('is fully transparent at zero density and opaque-ish at the top', () => {
        expect(ramp(0)[3]).toBe(0);            // empty stays clear
        expect(ramp(1)[3]).toBeGreaterThan(150);
    });

    it('alpha increases monotonically with density', () => {
        const a = [0.1, 0.3, 0.6, 0.9, 1].map(t => ramp(t)[3]);
        for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThanOrEqual(a[i - 1]);
    });

    it('hits viridis endpoints (dark purple → yellow) and stays in 0-255', () => {
        const lo = ramp(0.001), hi = ramp(1);
        expect(lo.slice(0, 3)).toEqual([68, 1, 84]);     // dark purple
        expect(hi.slice(0, 3)).toEqual([253, 231, 37]);  // yellow
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            for (const c of ramp(t)) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(255); }
        }
    });

    it('clamps out-of-range input', () => {
        expect(ramp(-1).slice(0, 3)).toEqual([68, 1, 84]);
        expect(ramp(2).slice(0, 3)).toEqual([253, 231, 37]);
        expect(ramp(-1)[3]).toBe(0);
    });
});
