/**
 * data-fetcher.js smoke tests — exercises the pure-function helpers
 * that don't need network. The IIFE is loaded via tests/setup.js.
 */

import { describe, it, expect } from 'vitest';

describe('DataFetcher.classifyElements()', () => {
    it('returns an object keyed by feature with zero counts for empty input', () => {
        const result = globalThis.DataFetcher.classifyElements([]);
        expect(result).toBeTypeOf('object');
        // every feature bucket should be initialized
        const firstKey = Object.keys(result)[0];
        expect(result[firstKey]).toMatchObject({ count: 0, names: [], items: [] });
    });

    it('counts a tagged element into the right feature bucket', () => {
        const elements = [
            { type: 'node', lat: 22.71, lon: 75.85, tags: { amenity: 'restaurant', name: 'Test Cafe' } }
        ];
        const result = globalThis.DataFetcher.classifyElements(elements);
        expect(result.restaurants?.count || 0).toBeGreaterThanOrEqual(1);
    });
});

describe('DataFetcher AQI sub-index (contiguous NAQI bands)', () => {
    const pm25 = globalThis.DataFetcher.computeAQI_PM25;
    const pm10 = globalThis.DataFetcher.computeAQI_PM10;

    it('maps band-boundary concentrations to a number (no null gaps)', () => {
        // These fractional values fell into the old non-contiguous gaps.
        for (const c of [30.5, 60.7, 90.4, 120.9]) {
            expect(pm25(c), `PM2.5 ${c}`).toBeTypeOf('number');
            expect(Number.isNaN(pm25(c))).toBe(false);
        }
        for (const c of [50.5, 100.7, 250.3, 430.9]) {
            expect(pm10(c), `PM10 ${c}`).toBeTypeOf('number');
        }
    });

    it('keeps the standard anchor points', () => {
        expect(pm25(0)).toBe(0);
        expect(pm25(30)).toBe(50);
        expect(pm25(60)).toBe(100);
        expect(pm25(250)).toBe(400);
        expect(pm10(100)).toBe(100);
        expect(pm10(430)).toBe(400);
    });

    it('is monotonic across a former gap and caps above scale', () => {
        expect(pm25(60.5)).toBeGreaterThanOrEqual(pm25(60));
        expect(pm25(700)).toBe(500);    // above-scale cap
        expect(pm25(-5)).toBeNull();    // invalid
        expect(pm25(NaN)).toBeNull();
    });
});
