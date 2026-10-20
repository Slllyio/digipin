import { describe, it, expect } from 'vitest';

describe('PitchMap pure helpers', () => {
    it('metersPerPixel matches Web-Mercator ground resolution at the equator', () => {
        // At lat 0, zoom 0, a 256px tile spans the world: ~156543 m/px.
        expect(PitchMap.metersPerPixel(0, 0)).toBeCloseTo(156543.034, 1);
        // Each zoom level halves the resolution.
        expect(PitchMap.metersPerPixel(0, 1)).toBeCloseTo(156543.034 / 2, 1);
        expect(PitchMap.metersPerPixel(0, 10)).toBeCloseTo(156543.034 / 1024, 2);
    });

    it('metersPerPixel shrinks with latitude (cos factor)', () => {
        const eq = PitchMap.metersPerPixel(0, 14);
        const hi = PitchMap.metersPerPixel(60, 14);
        expect(hi).toBeCloseTo(eq * Math.cos(60 * Math.PI / 180), 6);
        expect(hi).toBeLessThan(eq);
    });

    it('niceScaleBar rounds down to a 1/2/5×10ⁿ value', () => {
        expect(PitchMap.niceScaleBar(437)).toBe(200);
        expect(PitchMap.niceScaleBar(900)).toBe(500);
        expect(PitchMap.niceScaleBar(1500)).toBe(1000);
        expect(PitchMap.niceScaleBar(60)).toBe(50);
        expect(PitchMap.niceScaleBar(12)).toBe(10);
        expect(PitchMap.niceScaleBar(0)).toBe(0);
    });

    it('niceScaleBar result never exceeds the budget', () => {
        for (const m of [13, 99, 250, 333, 4096, 7777]) {
            expect(PitchMap.niceScaleBar(m)).toBeLessThanOrEqual(m);
        }
    });

    it('formatDistance switches to km at/above 1000 m', () => {
        expect(PitchMap.formatDistance(500)).toBe('500 m');
        expect(PitchMap.formatDistance(1000)).toBe('1 km');
        expect(PitchMap.formatDistance(2000)).toBe('2 km');
    });

    it('filename strips dashes and uses a .png extension', () => {
        expect(PitchMap.filename('39J-49L-L8T4')).toBe('digipin_pitch_39J49LL8T4.png');
        expect(PitchMap.filename(null)).toBe('digipin_pitch_view.png');
    });
});
