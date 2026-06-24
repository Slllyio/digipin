/**
 * AccessibilityOverlay pure helpers — haversine, nearest facility, banding.
 */
import { describe, it, expect } from 'vitest';

const {
    haversineM, nearestDistanceM, accessClass,
    detourEstimateS, nearestDurationS, accessClassTime,
} = globalThis.AccessibilityOverlay;

describe('AccessibilityOverlay.haversineM()', () => {
    it('is ~0 for identical points', () => {
        expect(haversineM(22.72, 75.86, 22.72, 75.86)).toBeCloseTo(0, 5);
    });

    it('matches a known short distance (~111 m per 0.001° latitude)', () => {
        const d = haversineM(22.72, 75.86, 22.721, 75.86);
        expect(d).toBeGreaterThan(108);
        expect(d).toBeLessThan(114);
    });

    it('is symmetric', () => {
        const a = haversineM(22.72, 75.86, 22.73, 75.87);
        const b = haversineM(22.73, 75.87, 22.72, 75.86);
        expect(a).toBeCloseTo(b, 6);
    });
});

describe('AccessibilityOverlay.nearestDistanceM()', () => {
    const items = [
        { lat: 22.730, lng: 75.860 },   // far
        { lat: 22.7205, lng: 75.860 },  // ~55 m
        { lat: 22.725, lng: 75.864 },   // mid
    ];

    it('returns the minimum distance among items', () => {
        const d = nearestDistanceM(22.72, 75.86, items);
        expect(d).toBeLessThan(70);     // nearest is the ~55 m one
    });

    it('returns Infinity when there are no items', () => {
        expect(nearestDistanceM(22.72, 75.86, [])).toBe(Infinity);
        expect(nearestDistanceM(22.72, 75.86, null)).toBe(Infinity);
    });

    it('skips items with non-finite coordinates', () => {
        const d = nearestDistanceM(22.72, 75.86, [{ lat: NaN, lng: 75.86 }, { lat: 22.7205, lng: 75.860 }]);
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeLessThan(70);
    });
});

describe('AccessibilityOverlay.accessClass()', () => {
    it('bands distance into Excellent / Good / Fair / Gap', () => {
        expect(accessClass(100).level).toBe('Excellent');
        expect(accessClass(300).level).toBe('Excellent');
        expect(accessClass(301).level).toBe('Good');
        expect(accessClass(600).level).toBe('Good');
        expect(accessClass(900).level).toBe('Fair');
        expect(accessClass(1500).level).toBe('Gap');
        expect(accessClass(Infinity).level).toBe('Gap');
    });

    it('each band has a colour and a distance hint', () => {
        const b = accessClass(Infinity);
        expect(b.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(b.hint).toBeTruthy();
    });
});

describe('AccessibilityOverlay.detourEstimateS()', () => {
    it('inflates straight-line distance by the detour factor and divides by speed', () => {
        // 1400 m × 1.3 / 1.4 m/s = 1300 s
        expect(detourEstimateS(1400, 1.4, 1.3)).toBeCloseTo(1300, 6);
    });

    it('always exceeds the crow-flies walking time (detour penalty)', () => {
        const straight = 1400 / 1.4;            // no detour
        expect(detourEstimateS(1400)).toBeGreaterThan(straight);
    });

    it('propagates Infinity and rejects non-positive speed', () => {
        expect(detourEstimateS(Infinity)).toBe(Infinity);
        expect(detourEstimateS(500, 0)).toBe(Infinity);
    });
});

describe('AccessibilityOverlay.nearestDurationS()', () => {
    it('returns the smallest finite duration in a matrix row', () => {
        expect(nearestDurationS([900, 240, 600])).toBe(240);
    });

    it('skips null/NaN entries and returns Infinity when none are reachable', () => {
        expect(nearestDurationS([null, NaN, 300])).toBe(300);
        expect(nearestDurationS([null, NaN])).toBe(Infinity);
        expect(nearestDurationS([])).toBe(Infinity);
        expect(nearestDurationS(null)).toBe(Infinity);
    });
});

describe('AccessibilityOverlay.accessClassTime()', () => {
    it('bands walking seconds into 5/10/15-minute coverage', () => {
        expect(accessClassTime(0).level).toBe('Excellent');
        expect(accessClassTime(300).level).toBe('Excellent');
        expect(accessClassTime(301).level).toBe('Good');
        expect(accessClassTime(600).level).toBe('Good');
        expect(accessClassTime(601).level).toBe('Fair');
        expect(accessClassTime(900).level).toBe('Fair');
        expect(accessClassTime(901).level).toBe('Gap');
        expect(accessClassTime(Infinity).level).toBe('Gap');
    });

    it('each band carries a colour and a minute hint', () => {
        const b = accessClassTime(Infinity);
        expect(b.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(b.hint).toMatch(/min/);
    });
});
