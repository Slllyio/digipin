import { describe, it, expect, beforeEach } from 'vitest';

// DataFetcherCache is exposed on globalThis by tests/setup.js.
const Cache = globalThis.DataFetcherCache;
const PREFIX = 'digipin:df:';

beforeEach(() => localStorage.clear());

describe('DataFetcherCache get/set', () => {
    it('round-trips a value', () => {
        Cache.set('k', { a: 1 }, 60_000);
        expect(Cache.get('k')).toEqual({ a: 1 });
    });

    it('returns null for a miss', () => {
        expect(Cache.get('absent')).toBeNull();
    });

    it('expires entries past their TTL', () => {
        Cache.set('k', 'v', -1000); // already expired
        expect(Cache.get('k')).toBeNull();
        expect(localStorage.getItem(PREFIX + 'k')).toBeNull(); // and evicts
    });

    it('does not cache null/undefined values', () => {
        Cache.set('n', null, 60_000);
        Cache.set('u', undefined, 60_000);
        expect(Cache.get('n')).toBeNull();
        expect(Cache.get('u')).toBeNull();
    });

    it('refuses entries larger than the per-entry byte cap', () => {
        const huge = 'x'.repeat(600 * 1024); // > 500KB
        Cache.set('big', huge, 60_000);
        expect(Cache.get('big')).toBeNull();
    });

    it('evicts and returns null for a corrupt (non-JSON) slot', () => {
        localStorage.setItem(PREFIX + 'bad', '{not json');
        expect(Cache.get('bad')).toBeNull();
        expect(localStorage.getItem(PREFIX + 'bad')).toBeNull();
    });

    it('evicts a valid-JSON-but-non-object slot (regression: would leak undefined)', () => {
        localStorage.setItem(PREFIX + 'num', '123');
        expect(Cache.get('num')).toBeNull();
        expect(localStorage.getItem(PREFIX + 'num')).toBeNull();
    });
});

describe('DataFetcherCache.clear()', () => {
    it('removes only its own prefixed keys', () => {
        Cache.set('a', 1, 60_000);
        Cache.set('b', 2, 60_000);
        localStorage.setItem('unrelated', 'keep');
        Cache.clear();
        expect(Cache.get('a')).toBeNull();
        expect(Cache.get('b')).toBeNull();
        expect(localStorage.getItem('unrelated')).toBe('keep');
    });
});

describe('DataFetcherCache.keyFor()', () => {
    it('rounds numeric coords to 4 decimals', () => {
        expect(Cache.keyFor('weather', 22.719663, 75.857)).toBe('weather:22.7197,75.8570');
    });
    it('appends an extra segment when given', () => {
        expect(Cache.keyFor('osm', 1, 2, 'r400')).toBe('osm:1.0000,2.0000:r400');
    });
    it('stringifies non-numeric coords', () => {
        expect(Cache.keyFor('x', 'a', 'b')).toBe('x:a,b');
    });
});

describe('DataFetcherCache.memoize()', () => {
    it('calls the factory once, then serves from cache', async () => {
        let calls = 0;
        const factory = async () => { calls++; return { n: calls }; };
        const first = await Cache.memoize('m', 60_000, factory);
        const second = await Cache.memoize('m', 60_000, factory);
        expect(first).toEqual({ n: 1 });
        expect(second).toEqual({ n: 1 }); // cached, factory not re-run
        expect(calls).toBe(1);
    });

    it('re-runs the factory when the cached value is missing/expired', async () => {
        let calls = 0;
        const factory = async () => { calls++; return calls; };
        await Cache.memoize('m', -1000, factory); // stored already-expired
        await Cache.memoize('m', -1000, factory);
        expect(calls).toBe(2);
    });

    it('does not cache a null factory result (refetches next time)', async () => {
        let calls = 0;
        const factory = async () => { calls++; return calls === 1 ? null : 'ok'; };
        const first = await Cache.memoize('m', 60_000, factory);
        const second = await Cache.memoize('m', 60_000, factory);
        expect(first).toBeNull();
        expect(second).toBe('ok');
        expect(calls).toBe(2);
    });
});
