import { describe, it, expect } from 'vitest';

const Q = globalThis.Quality3D;
const U = globalThis.URLState;

describe('Quality3D', () => {
    it('detects a level from the device', () => {
        expect(Q.detectTier({ deviceMemory: 8, cores: 8, coarse: false, width: 1440 })).toBe('high');
        expect(Q.detectTier({ deviceMemory: 4, cores: 8 })).toBe('balanced');
        expect(Q.detectTier({ cores: 8, coarse: true, width: 390 })).toBe('balanced');
        expect(Q.detectTier({ deviceMemory: 2, cores: 8 })).toBe('lite');
        expect(Q.detectTier({ cores: 2 })).toBe('lite');
        expect(Q.detectTier({})).toBe('high');
    });
    it('reads the median frame rate and needs enough samples', () => {
        expect(Q.medianFps(Array(30).fill(50))).toBeCloseTo(20, 5);
        expect(Q.medianFps(Array(30).fill(16.7).concat([900]))).toBeGreaterThan(55);
        expect(Q.medianFps([16, 16, 16])).toBe(null);
    });
    it('steps down high → balanced → lite and stops', () => {
        expect(Q.nextDown('high')).toBe('balanced');
        expect(Q.nextDown('balanced')).toBe('lite');
        expect(Q.nextDown('lite')).toBe(null);
    });
    it('lite drops trees, shadows and terrain; unknown means high', () => {
        expect(Q.limitsFor('lite')).toMatchObject({ parkTrees: 0, streetTrees: 0, shadows: 0, terrain: false, maxDpr: 1 });
        expect(Q.limitsFor('nope').tier).toBe('high');
        expect(Q.limitsFor('balanced').shadows).toBeLessThan(Q.limitsFor('high').shadows);
    });
});

describe('URLState 3D camera and sun', () => {
    it('round-trips pitch, bearing and the sun hour', () => {
        const qs = U.stringify({ ll: { lat: 22.7186, lng: 75.8553 }, z: 16.2, pitch: 62, bearing: -32, sun: { date: '2026-10-21', min: 1005 }, bcolor: 'lst_monthly:lst_day_c' });
        expect(qs).toContain('p=62');
        expect(qs).toContain('b=-32');
        expect(qs).toContain('sun=2026-10-21T16%3A45');
        const st = U.parse('?' + qs);
        expect(st).toMatchObject({ pitch: 62, bearing: -32, sun: { date: '2026-10-21', min: 1005 }, bcolor: 'lst_monthly:lst_day_c', z: 16.2 });
    });
    it('leaves a flat 2D view without camera params and rejects junk', () => {
        expect(U.stringify({ z: 14, pitch: 0, bearing: 30 })).not.toMatch(/(^|&)p=/);
        const st = U.parse('?p=200&b=abc&sun=2026-10-21T25:00');
        expect(st.pitch).toBeUndefined();
        expect(st.bearing).toBeUndefined();
        expect(st.sun).toBeUndefined();
        expect(U.parse('?b=350').bearing).toBe(-10);
    });
});
