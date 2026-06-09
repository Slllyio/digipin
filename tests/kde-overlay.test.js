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
