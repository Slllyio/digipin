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
