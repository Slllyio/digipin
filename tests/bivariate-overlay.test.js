/**
 * BivariateOverlay.classify() — pure 3×3 bivariate binning.
 * Modules are loaded as globals via tests/setup.js.
 */
import { describe, it, expect } from 'vitest';

const { classify } = globalThis.BivariateOverlay;

describe('BivariateOverlay.classify()', () => {
    it('returns transparent / null idx when either score is missing', () => {
        expect(classify(null, 50).idx).toBeNull();
        expect(classify(50, null).idx).toBeNull();
        expect(classify(NaN, 50).idx).toBeNull();
        expect(classify(null, 50).color).toBe('rgba(0,0,0,0)');
    });

    it('bins low/med/high at the 40 and 70 thresholds', () => {
        expect(classify(0, 0).xBin).toBe(0);
        expect(classify(39.9, 0).xBin).toBe(0);
        expect(classify(40, 0).xBin).toBe(1);
        expect(classify(69.9, 0).xBin).toBe(1);
        expect(classify(70, 0).xBin).toBe(2);
        expect(classify(100, 0).xBin).toBe(2);
        // y axis bins independently
        expect(classify(0, 40).yBin).toBe(1);
        expect(classify(0, 85).yBin).toBe(2);
    });

    it('computes idx = yBin*3 + xBin and a 9-colour palette', () => {
        expect(classify(10, 10).idx).toBe(0);   // low,low
        expect(classify(100, 100).idx).toBe(8); // high,high
        expect(classify(80, 10).idx).toBe(2);   // x-high, y-low
        // corners are distinct colours
        const colors = new Set([
            classify(10, 10).color, classify(100, 10).color,
            classify(10, 100).color, classify(100, 100).color,
        ]);
        expect(colors.size).toBe(4);
    });
});
