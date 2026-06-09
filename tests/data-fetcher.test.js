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

describe('DataFetcher request coalescing (_coalesce)', () => {
    const { _coalesce } = globalThis.DataFetcher;

    it('funnels concurrent same-key calls onto one factory invocation', async () => {
        const inflight = new Map();
        let calls = 0;
        const factory = () => { calls++; return new Promise(r => setTimeout(() => r('v'), 10)); };
        const [a, b, c] = await Promise.all([
            _coalesce(inflight, 'k', factory),
            _coalesce(inflight, 'k', factory),
            _coalesce(inflight, 'k', factory),
        ]);
        expect(calls).toBe(1);                 // 3 callers, 1 network fetch
        expect([a, b, c]).toEqual(['v', 'v', 'v']);
        expect(inflight.size).toBe(0);         // cleaned up after settle
    });

    it('re-invokes after the in-flight settles (it coalesces, it does not cache)', async () => {
        const inflight = new Map();
        let calls = 0;
        const factory = () => { calls++; return Promise.resolve('v'); };
        await _coalesce(inflight, 'k', factory);
        await _coalesce(inflight, 'k', factory);
        expect(calls).toBe(2);
    });

    it('keeps distinct keys independent', async () => {
        const inflight = new Map();
        let calls = 0;
        const factory = () => { calls++; return Promise.resolve('v'); };
        await Promise.all([_coalesce(inflight, 'a', factory), _coalesce(inflight, 'b', factory)]);
        expect(calls).toBe(2);
    });

    it('propagates rejection to all callers and clears the in-flight entry', async () => {
        const inflight = new Map();
        const failing = _coalesce(inflight, 'k', () => Promise.reject(new Error('boom')));
        await expect(failing).rejects.toThrow('boom');
        expect(inflight.size).toBe(0);
    });
});
