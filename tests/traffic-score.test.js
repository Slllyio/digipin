import { describe, it, expect } from 'vitest';

// TrafficScore is exposed on globalThis by tests/setup.js. Pure helpers — these
// lock the LOS definition shared with pipeline/traffic/road_network.py.
const T = globalThis.TrafficScore;

describe('TrafficScore.capacityForClass', () => {
    it('orders arterials above local streets', () => {
        expect(T.capacityForClass('trunk')).toBeGreaterThan(T.capacityForClass('residential'));
        expect(T.capacityForClass('motorway')).toBe(1.0);
    });
    it('falls back to a default for unknown / missing classes', () => {
        expect(T.capacityForClass('nonsense')).toBe(T.DEFAULT_CAPACITY);
        expect(T.capacityForClass(null)).toBe(T.DEFAULT_CAPACITY);
        expect(T.capacityForClass(['primary'])).toBe(T.capacityForClass('primary'));
    });
});

describe('TrafficScore.losFromVC — HCM volume/capacity breakpoints', () => {
    it('maps the V/C ratio to a LOS grade A–F', () => {
        expect(T.losFromVC(0.0).grade).toBe('A');
        expect(T.losFromVC(0.5).grade).toBe('B');
        expect(T.losFromVC(0.7).grade).toBe('C');
        expect(T.losFromVC(0.85).grade).toBe('D');
        expect(T.losFromVC(0.95).grade).toBe('E');
        expect(T.losFromVC(1.5).grade).toBe('F');
    });
    it('returns null for a missing ratio', () => {
        expect(T.losFromVC(null)).toBeNull();
        expect(T.losFromVC(NaN)).toBeNull();
    });
});

describe('TrafficScore.vcRatio & congestionRisk', () => {
    it('a busy low-capacity road scores worse than the same load on a trunk', () => {
        const local = T.vcRatio(0.2, T.capacityForClass('residential'));
        const trunk = T.vcRatio(0.2, T.capacityForClass('trunk'));
        expect(local).toBeGreaterThan(trunk);
    });
    it('clamps congestion risk into 0..100', () => {
        expect(T.congestionRisk(1.5)).toBe(100);
        expect(T.congestionRisk(0)).toBe(0);
        expect(T.congestionRisk(null)).toBeNull();
    });
});

describe('TrafficScore.transitAccessScore', () => {
    it('rewards frequent service over sparse', () => {
        expect(T.transitAccessScore(5, 4)).toBeGreaterThan(T.transitAccessScore(30, 1));
    });
    it('stays within 0..100, including unknown headway', () => {
        for (const v of [T.transitAccessScore(5, 4), T.transitAccessScore(60, 0), T.transitAccessScore(null, 0)]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(100);
        }
    });
});
