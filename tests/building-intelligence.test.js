import { describe, it, expect } from 'vitest';

// BuildingIntelligence is exposed on globalThis by tests/setup.js. These cover
// the pure scoring internals — the development_potential / fsi_intensity / etc.
// scores that get merged into DataFetcher scores and drive the real-estate
// queries (see tests/query-engine.test.js).
const BI = globalThis.BuildingIntelligence;

const RADIUS = 400; // m -> ~50.3 ha circular query area

const buildings = (over = {}) => ({
    totalCount: 0, avgLevels: 0,
    heights: [], levels: [], types: {}, materials: {}, roofShapes: {},
    ageDecades: {}, heightBands: { low: 0, mid: 0, high: 0, vhigh: 0 },
    ...over,
});

describe('BuildingIntelligence.computeShannon()', () => {
    const H = BI.computeShannon;

    it('is 0 for empty or single-class distributions', () => {
        expect(H({})).toBe(0);
        expect(H({ a: 0 })).toBe(0);
        expect(H({ a: 5 })).toBe(0);
    });

    it('is 100 for a perfectly even distribution (2 or n classes)', () => {
        expect(H({ a: 5, b: 5 })).toBe(100);
        expect(H({ a: 1, b: 1, c: 1, d: 1 })).toBe(100);
    });

    it('is between 0 and 100 for a skewed distribution', () => {
        const v = H({ a: 9, b: 1 });
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(100);
    });

    it('ignores zero and negative counts', () => {
        expect(H({ a: 5, b: 5, c: 0, d: -3 })).toBe(100);
    });
});

describe('BuildingIntelligence.computeBuildingScores()', () => {
    const scoresFor = (b, lcz = null) =>
        BI.computeBuildingScores(b, lcz, BI.computeMetrics(b, lcz, RADIUS));

    it('returns every score as {label, value} with value in 0..100', () => {
        const scores = scoresFor(buildings({ totalCount: 30, avgLevels: 3, materials: { concrete: 10 } }));
        const expectedKeys = [
            'building_density', 'vertical_development', 'fsi_intensity', 'height_diversity',
            'type_mix', 'material_quality', 'development_potential', 'redevelopment_index',
            'urban_compactness', 'modernization',
        ];
        for (const k of expectedKeys) {
            expect(scores[k], k).toBeTruthy();
            expect(typeof scores[k].label).toBe('string');
            expect(Number.isFinite(scores[k].value), `${k}=${scores[k].value}`).toBe(true);
            expect(scores[k].value).toBeGreaterThanOrEqual(0);
            expect(scores[k].value).toBeLessThanOrEqual(100);
        }
    });

    it('defaults modernization to 50 and material_quality to 50 with no data', () => {
        const scores = scoresFor(buildings());
        expect(scores.modernization.value).toBe(50);  // modernizationRatio null
        expect(scores.material_quality.value).toBe(50); // no materials
    });

    it('scores premium materials far above basic/low materials', () => {
        const premium = scoresFor(buildings({ totalCount: 10, materials: { concrete: 10 } }));
        const low = scoresFor(buildings({ totalCount: 10, materials: { mud: 10 } }));
        expect(premium.material_quality.value).toBeGreaterThan(80);
        expect(low.material_quality.value).toBeLessThan(40);
        expect(premium.material_quality.value).toBeGreaterThan(low.material_quality.value);
    });

    it('caps vertical development at 100 for tall stock', () => {
        const scores = scoresFor(buildings({ totalCount: 5, avgLevels: 8 }));
        expect(scores.vertical_development.value).toBe(100);
    });

    it('rates vacant LCZ land as higher development potential than dense core', () => {
        const sparse = buildings({ totalCount: 5, avgLevels: 1 });
        const vacant = scoresFor(sparse, { classId: 14 });    // bare/low-plants land
        const denseCore = scoresFor(sparse, { classId: 1 });  // compact high-rise
        expect(vacant.development_potential.value)
            .toBeGreaterThan(denseCore.development_potential.value);
    });
});
