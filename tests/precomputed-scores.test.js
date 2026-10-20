import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// PrecomputedScores + DigiPin + DataFetcher are exposed by tests/setup.js.
const PS = globalThis.PrecomputedScores;
const DigiPin = globalThis.DigiPin;
const DataFetcher = globalThis.DataFetcher;

const LAT = 22.70, LNG = 75.80, LEVEL = 6;
const CODE = DigiPin.encode(LAT, LNG).replace(/-/g, '').slice(0, LEVEL);
const PREFIX = CODE.slice(0, 2);
const FIELDS = Object.keys(DataFetcher.computeScores({}));
const VALUES = FIELDS.map((_, i) => (i * 7) % 101);  // arbitrary 0..100

const COVERAGE = {
    version: 1, generated: '2026-06-09T00:00:00Z', radiusM: 400, fields: FIELDS,
    regions: [{
        name: 'indore_pilot', level: LEVEL, shardPrefixLen: 2, shards: [PREFIX],
        bbox: { south: 22.5, west: 75.6, north: 22.9, east: 76.0 },
        path: 'data/scores/indore_pilot/',
    }],
};
const SHARD = { [CODE]: VALUES };

function mockFetch(routes) {
    return vi.fn(async (url) => {
        for (const [frag, body] of routes) {
            if (url.includes(frag)) {
                return body === 404
                    ? new Response('nf', { status: 404 })
                    : new Response(JSON.stringify(body), { status: 200 });
            }
        }
        return new Response('nf', { status: 404 });
    });
}

beforeEach(() => { delete window.DIGIPIN_CONFIG; });
afterEach(() => vi.restoreAllMocks());

describe('PrecomputedScores.init()', () => {
    it('enables when coverage.json is present', async () => {
        globalThis.fetch = mockFetch([['coverage.json', COVERAGE]]);
        expect(await PS.init()).toBe(true);
        expect(PS.isEnabled()).toBe(true);
    });

    it('stays disabled (silently) when coverage.json 404s', async () => {
        globalThis.fetch = mockFetch([['coverage.json', 404]]);
        expect(await PS.init()).toBe(false);
        expect(PS.isEnabled()).toBe(false);
    });

    it('respects the DIGIPIN_CONFIG.precomputedScores kill switch', async () => {
        window.DIGIPIN_CONFIG = { precomputedScores: false };
        globalThis.fetch = mockFetch([['coverage.json', COVERAGE]]);
        expect(await PS.init()).toBe(false);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});

describe('PrecomputedScores.hasCoverage()', () => {
    it('reports coverage by bbox', async () => {
        globalThis.fetch = mockFetch([['coverage.json', COVERAGE]]);
        await PS.init();
        expect(PS.hasCoverage(LAT, LNG)).toBe(true);
        expect(PS.hasCoverage(28.6, 77.2)).toBe(false);  // Delhi, uncovered
    });
});

describe('PrecomputedScores.lookup()', () => {
    it('returns scores in the {id:{label,value}} contract', async () => {
        globalThis.fetch = mockFetch([['coverage.json', COVERAGE], [`${PREFIX}.json`, SHARD]]);
        await PS.init();
        const out = await PS.lookup(LAT, LNG);
        expect(out).not.toBeNull();
        expect(out.code).toBe(DigiPin.format(CODE));
        // every field rehydrated with its live label + the shard value
        for (let i = 0; i < FIELDS.length; i++) {
            expect(out.scores[FIELDS[i]].value).toBe(VALUES[i]);
            expect(typeof out.scores[FIELDS[i]].label).toBe('string');
        }
        // matches the live contract consumers read
        expect(out.scores.walkability).toHaveProperty('value');
    });

    it('returns null for an uncovered point', async () => {
        globalThis.fetch = mockFetch([['coverage.json', COVERAGE]]);
        await PS.init();
        expect(await PS.lookup(28.6, 77.2)).toBeNull();
    });

    it('returns null when the cell is absent from its shard', async () => {
        globalThis.fetch = mockFetch([['coverage.json', COVERAGE], [`${PREFIX}.json`, {}]]);
        await PS.init();
        expect(await PS.lookup(LAT, LNG)).toBeNull();
    });
});

describe('PrecomputedScores.lookupViewport()', () => {
    it('returns covered cells intersecting the viewport with decoded rects', async () => {
        globalThis.fetch = mockFetch([['coverage.json', COVERAGE], [`${PREFIX}.json`, SHARD]]);
        await PS.init();
        const cells = await PS.lookupViewport({ south: 22.69, west: 75.79, north: 22.71, east: 75.81 });
        expect(Array.isArray(cells)).toBe(true);
        expect(cells.length).toBe(1);
        expect(cells[0].code).toBe(DigiPin.format(CODE));
        expect(cells[0].bounds).toHaveProperty('south');
        expect(cells[0].scores.walkability.value).toBe(VALUES[FIELDS.indexOf('walkability')]);
    });

    it('returns null when no region covers the viewport centre', async () => {
        globalThis.fetch = mockFetch([['coverage.json', COVERAGE], [`${PREFIX}.json`, SHARD]]);
        await PS.init();
        const cells = await PS.lookupViewport({ south: 28.5, west: 77.1, north: 28.7, east: 77.3 });
        expect(cells).toBeNull();
    });
});
