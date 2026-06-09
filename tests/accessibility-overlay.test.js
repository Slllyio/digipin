/**
 * AccessibilityOverlay pure helpers — haversine, nearest facility, banding.
 */
import { describe, it, expect } from 'vitest';

const { haversineM, nearestDistanceM, accessClass } = globalThis.AccessibilityOverlay;

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
