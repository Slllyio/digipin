import { describe, it, expect } from 'vitest';

// QueryEngine + DataFetcher are exposed on globalThis by tests/setup.js.
const QE = globalThis.QueryEngine;
const DataFetcher = globalThis.DataFetcher;

/** Build a scores object of the {key: {value}} shape computeQueryScore reads. */
const scoresOf = (obj) => Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, { value: v }])
);

describe('QueryEngine.computeQueryScore()', () => {
    it('computes a weight-normalised average over matching scores', () => {
        const scores = scoresOf({ a: 80, b: 40 });
        // (80*2 + 40*1) / (2 + 1) = 200/3
        expect(QE.computeQueryScore(scores, { a: 2, b: 1 })).toBeCloseTo(200 / 3, 9);
    });

    it('uses |weight| in the denominator so negative weights invert ranking', () => {
        const scores = scoresOf({ healthcare_access: 100, population_proxy: 100 });
        // want LOW healthcare: (100*-3 + 100*3) / (3 + 3) = 0
        expect(QE.computeQueryScore(scores, { healthcare_access: -3, population_proxy: 3 })).toBe(0);
        const low = scoresOf({ healthcare_access: 0, population_proxy: 100 });
        expect(QE.computeQueryScore(low, { healthcare_access: -3, population_proxy: 3 })).toBe(50);
    });

    it('ignores weight keys with no matching score', () => {
        const scores = scoresOf({ a: 90 });
        // missing `b` must not count toward numerator or denominator
        expect(QE.computeQueryScore(scores, { a: 2, b: 5 })).toBe(90);
    });

    it('skips non-finite values instead of poisoning the ranking with NaN', () => {
        const scores = { a: { value: 80 }, b: { value: NaN }, c: { value: null } };
        // only `a` is finite -> 80
        const result = QE.computeQueryScore(scores, { a: 1, b: 1, c: 1 });
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBe(80);
    });

    it('re-normalises over available scores rather than diluting with a null', () => {
        const withNull = { a: { value: 80 }, b: { value: null } };
        const without = { a: { value: 80 } };
        expect(QE.computeQueryScore(withNull, { a: 1, b: 1 }))
            .toBe(QE.computeQueryScore(without, { a: 1, b: 1 }));
    });

    it('returns 0 for null scores, null weights, or empty weights (no throw)', () => {
        expect(QE.computeQueryScore(null, { a: 1 })).toBe(0);
        expect(QE.computeQueryScore(scoresOf({ a: 1 }), null)).toBe(0);
        expect(QE.computeQueryScore(scoresOf({ a: 1 }), {})).toBe(0);
    });
});

describe('QueryEngine SECTORS catalogue', () => {
    const sectors = QE.getSectors();
    const allQueries = sectors.flatMap((s) => s.queries);

    it('every query has an id, name, and non-empty weights', () => {
        for (const q of allQueries) {
            expect(q.id, JSON.stringify(q)).toBeTruthy();
            expect(q.name).toBeTruthy();
            expect(Object.keys(q.weights || {}).length).toBeGreaterThan(0);
        }
    });

    it('query ids are unique across all sectors', () => {
        const ids = allQueries.map((q) => q.id);
        expect(ids.length).toBe(new Set(ids).size);
    });

    it('every weight key resolves to a real score (composite or building-intel)', () => {
        // Guard against typo'd weight keys, which would silently drop a ranking
        // criterion. Valid keys come from DataFetcher.computeScores (OSM-derived)
        // or the BuildingIntelligence module (merged into scores at fetch time).
        const compositeKeys = new Set(Object.keys(DataFetcher.computeScores({})));
        const buildingIntelKeys = new Set([
            'building_density', 'vertical_development', 'fsi_intensity', 'height_diversity',
            'type_mix', 'material_quality', 'development_potential', 'redevelopment_index',
            'urban_compactness', 'modernization',
        ]);
        const valid = new Set([...compositeKeys, ...buildingIntelKeys]);

        const unresolved = new Set();
        for (const q of allQueries) {
            for (const key of Object.keys(q.weights)) {
                if (!valid.has(key)) unresolved.add(`${q.id}:${key}`);
            }
        }
        expect([...unresolved]).toEqual([]);
    });
});
