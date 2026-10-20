import { describe, it, expect } from 'vitest';

// DataFetcher is exposed on globalThis by tests/setup.js. sourceState maps a
// Promise.allSettled outcome to the per-source health the panel surfaces.
const { sourceState } = globalThis.DataFetcher;

describe('DataFetcher.sourceState()', () => {
    it('reports ok for a fulfilled, non-null result', () => {
        expect(sourceState({ status: 'fulfilled', value: { a: 1 } })).toBe('ok');
        expect(sourceState({ status: 'fulfilled', value: [] })).toBe('ok'); // loaded, empty is still ok
        expect(sourceState({ status: 'fulfilled', value: 0 })).toBe('ok');
    });

    it('reports unavailable for rejected / null / missing outcomes', () => {
        expect(sourceState({ status: 'rejected', reason: 'boom' })).toBe('unavailable');
        expect(sourceState({ status: 'fulfilled', value: null })).toBe('unavailable');
        expect(sourceState({ status: 'fulfilled', value: undefined })).toBe('unavailable');
        expect(sourceState(undefined)).toBe('unavailable');
        expect(sourceState(null)).toBe('unavailable');
    });
});
