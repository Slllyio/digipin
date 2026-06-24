import { describe, it, expect } from 'vitest';

// DataFetcher + DigiPin are exposed on globalThis by tests/setup.js. These lock
// the pure GeoJSON builders (the DOM download wrappers aren't unit-tested, same
// as exportToJSON/CSV).
const DF = globalThis.DataFetcher;

// A real Indore-area DIGIPIN (10-char) and a truncated precomputed-style code.
const FULL = '4P3-JK8-39LM';
const PARTIAL = '4P3JK8'; // level-6 cell, as the precomputed grid emits

describe('DataFetcher.cellToFeature()', () => {
    it('builds a closed Polygon ring matching the cell bounds', () => {
        const f = DF.cellToFeature(FULL, { safety: { label: 'Safety', value: 72 } });
        expect(f.type).toBe('Feature');
        expect(f.geometry.type).toBe('Polygon');
        const ring = f.geometry.coordinates[0];
        expect(ring.length).toBe(5);
        expect(ring[0]).toEqual(ring[4]); // closed

        // ring corners equal the decoded bounds (lng,lat order)
        const b = DigiPin.decodePartial(FULL).bounds;
        expect(ring[0]).toEqual([b.west, b.south]);
        expect(ring[2]).toEqual([b.east, b.north]);
    });

    it('flattens {id:{label,value}} scores into numeric properties', () => {
        const f = DF.cellToFeature(FULL, { safety: { label: 'Safety', value: 72 }, green: { value: 0 } });
        expect(f.properties.safety).toBe(72);
        expect(f.properties.green).toBe(0);
        expect(f.properties.digipin).toBe(DigiPin.format(FULL));
    });

    it('accepts already-flat {id:value} scores too', () => {
        const f = DF.cellToFeature(FULL, { safety: 50 });
        expect(f.properties.safety).toBe(50);
    });

    it('handles truncated precomputed codes via decodePartial', () => {
        const f = DF.cellToFeature(PARTIAL, { livability: { value: 60 } });
        expect(f.geometry.coordinates[0].length).toBe(5);
        expect(f.properties.livability).toBe(60);
    });

    it('drops null/undefined extra props but keeps real ones', () => {
        const f = DF.cellToFeature(FULL, {}, { score: 88.4, area: undefined });
        expect(f.properties.score).toBe(88.4);
        expect('area' in f.properties).toBe(false);
    });
});

describe('DataFetcher.cellToGeoJSON()', () => {
    it('wraps a single cell in a FeatureCollection', () => {
        const fc = DF.cellToGeoJSON({ code: FULL, scores: { safety: { value: 1 } } });
        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].properties.safety).toBe(1);
    });

    it('is empty when no code is present', () => {
        expect(DF.cellToGeoJSON({ scores: {} }).features).toHaveLength(0);
    });
});

describe('DataFetcher.rankedToGeoJSON()', () => {
    const results = [
        { code: FULL, score: 81.27, area: 'Rajwada', scores: { safety: { value: 70 } } },
        { code: PARTIAL, score: 40, area: '', scores: { safety: { value: 30 } } },
    ];

    it('builds one feature per ranked row, rounding the score', () => {
        const fc = DF.rankedToGeoJSON(results);
        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features).toHaveLength(2);
        expect(fc.features[0].properties.score).toBe(81.3); // rounded to 1dp
        expect(fc.features[0].properties.area).toBe('Rajwada');
        expect(fc.features[0].properties.safety).toBe(70);
        // empty area is dropped
        expect('area' in fc.features[1].properties).toBe(false);
    });

    it('skips rows without a code and tolerates empty input', () => {
        expect(DF.rankedToGeoJSON([{ score: 1 }]).features).toHaveLength(0);
        expect(DF.rankedToGeoJSON(null).features).toHaveLength(0);
    });
});
