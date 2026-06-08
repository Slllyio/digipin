/**
 * Viewshed.computeViewshed() — pure line-of-sight visibility.
 */
import { describe, it, expect } from 'vitest';

const { computeViewshed } = globalThis.Viewshed;

describe('Viewshed.computeViewshed()', () => {
    it('marks the whole disc visible on a flat plane', () => {
        const W = 11, H = 11;
        const elev = new Float32Array(W * H); // all zero
        const mask = computeViewshed(elev, W, H, 5, 5, { eyeM: 1.7, radiusPx: 5, metersPerPixel: 1 });
        expect(mask[5 * W + 5]).toBe(1);   // observer
        expect(mask[5 * W + 9]).toBe(1);   // 4px east, inside radius
        expect(mask[1 * W + 5]).toBe(1);   // 4px north
    });

    it('leaves pixels outside the radius unmarked', () => {
        const W = 21, H = 1;
        const elev = new Float32Array(W * H);
        const mask = computeViewshed(elev, W, H, 0, 0, { radiusPx: 5, metersPerPixel: 1 });
        expect(mask[5]).toBe(1);    // on the radius edge
        expect(mask[6]).toBe(0);    // beyond radius
        expect(mask[20]).toBe(0);
    });

    it('occludes terrain behind a tall wall', () => {
        const W = 21, H = 1;
        const elev = new Float32Array(W * H);
        elev[5] = 100;   // a 100 m wall 5 px east of the observer
        const mask = computeViewshed(elev, W, H, 0, 0, { eyeM: 1.7, radiusPx: 20, metersPerPixel: 1 });
        expect(mask[0]).toBe(1);    // observer
        expect(mask[3]).toBe(1);    // ground before the wall — visible
        expect(mask[5]).toBe(1);    // the wall face itself — visible
        expect(mask[8]).toBe(0);    // ground behind the wall — hidden
        expect(mask[15]).toBe(0);   // still hidden further back
    });

    it('returns an all-zero mask for an out-of-bounds observer', () => {
        const elev = new Float32Array(25);
        const mask = computeViewshed(elev, 5, 5, 99, 99, {});
        expect(mask.every(v => v === 0)).toBe(true);
    });
});
