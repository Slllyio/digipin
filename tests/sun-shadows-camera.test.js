import { describe, it, expect } from 'vitest';

const S = globalThis.SunShadows;
const C = globalThis.CameraPresets;

describe('SunShadows geometry', () => {
    it('points the shadow away from the sun, longer when the sun is low', () => {
        // Sun due east (azimuth 90°) → shadow runs west (negative longitude offset).
        const [dx, dy] = S.offset(45, 90, 20, 22.7);
        expect(dx).toBeLessThan(0);
        expect(Math.abs(dy)).toBeLessThan(1e-9);
        const high = Math.hypot(...S.offset(60, 180, 20, 22.7));
        const low = Math.hypot(...S.offset(15, 180, 20, 22.7));
        expect(low).toBeGreaterThan(high);
    });

    it('caps very long shadows and returns nothing below the horizon', () => {
        const [, dy] = S.offset(1, 180, 100, 0);
        expect(Math.abs(dy) * 111320).toBeCloseTo(S.MAX_LEN_M, 0);
        expect(S.offset(-5, 180, 20, 22)).toEqual([0, 0]);
    });

    it('hull is closed and contains footprint plus tip', () => {
        const sq = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
        const h = S.hull(sq.concat(sq.map(([x, y]) => [x + 2, y])));
        expect(h[0]).toEqual(h[h.length - 1]);
        const xs = h.map(p => p[0]);
        expect(Math.min(...xs)).toBe(0);
        expect(Math.max(...xs)).toBe(3);
    });

    it('shadowRing skips flat buildings and a low sun', () => {
        const ring = [[75.85, 22.71], [75.8501, 22.71], [75.8501, 22.7101], [75.85, 22.7101], [75.85, 22.71]];
        expect(S.shadowRing(ring, 0.2, 40, 120)).toBe(null);
        expect(S.shadowRing(ring, 20, 1, 120)).toBe(null);
        expect(S.shadowRing(ring, 20, 40, 120).length).toBeGreaterThanOrEqual(5);
    });
});

describe('SunShadows.skyFor', () => {
    const day = { 'sky-color': '#efeeea', 'horizon-color': '#f5f4f2', 'fog-color': '#f3f3f1', 'sky-horizon-blend': 0.5 };
    it('keeps the theme sky by day and darkens through dusk to night', () => {
        expect(S.skyFor(40, 'light', day)).toEqual(day);
        const dusk = S.skyFor(-3, 'light', day), night = S.skyFor(-20, 'light', day);
        const lum = c => parseInt(c.slice(1, 3), 16) + parseInt(c.slice(3, 5), 16) + parseInt(c.slice(5, 7), 16);
        expect(lum(dusk['sky-color'])).toBeLessThan(lum(day['sky-color']));
        expect(lum(night['sky-color'])).toBeLessThan(lum(dusk['sky-color']));
        expect(night['sky-horizon-blend']).toBe(0.5);
    });
});

describe('CameraPresets.presetsFor', () => {
    it('gives three shots, Bird’s eye and Street framed on the city landmark', () => {
        const city = { id: 'delhi', name: 'New Delhi', lat: 28.6139, lng: 77.209 };
        const p = C.presetsFor(city, 75);
        expect(p.map(x => x.id)).toEqual(['overview', 'bird', 'street']);
        expect(p[0].camera.center).toEqual([77.209, 28.6139]);
        expect(p[2].detail).toBe('Connaught Place');
        expect(p[2].camera.zoom).toBeGreaterThan(p[1].camera.zoom);
        expect(p[1].camera.zoom).toBeGreaterThan(p[0].camera.zoom);
    });

    it('respects the pitch cap and falls back to the city centre', () => {
        const p = C.presetsFor({ id: 'nowhere', name: 'X', lat: 10, lng: 20 }, 60);
        expect(p[2].camera.pitch).toBe(60);
        expect(p[1].camera.center).toEqual([20, 10]);
        expect(C.presetsFor(null)).toEqual([]);
    });

    it('has a landmark for every city in the selector', () => {
        for (const c of globalThis.CitySelector.getCities()) expect(C.LANDMARKS[c.id], c.id).toBeTruthy();
    });
});
