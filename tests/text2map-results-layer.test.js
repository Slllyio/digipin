import { describe, it, expect } from 'vitest';

// Text2MapResultsLayer + DigiPin are exposed on globalThis by tests/setup.js.
// show()/clear() need a live MapLibre map, so we exercise the pure geometry
// builder (_toGeoJSON) that turns ranked Text2Map results into the highlight
// FeatureCollection + framing extent.
const T2ML = globalThis.Text2MapResultsLayer;

describe('Text2MapResultsLayer._toGeoJSON', () => {
    it('builds one ranked polygon per result and an enclosing extent', () => {
        const results = [
            { code: '', lat: 22.72, lng: 75.85, score: 88 },
            { code: '', lat: 22.70, lng: 75.90, score: 61 },
            { code: '', lat: 22.75, lng: 75.80, score: 33 },
        ];
        const { fc, extent } = T2ML._toGeoJSON(results);

        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features).toHaveLength(3);

        // Rank is 1-based and follows result order; score is carried through.
        expect(fc.features.map(f => f.properties.rank)).toEqual([1, 2, 3]);
        expect(fc.features[0].properties.score).toBe(88);

        // Each feature is a closed rectangle ring (5 coords, first === last).
        const ring = fc.features[0].geometry.coordinates[0];
        expect(ring).toHaveLength(5);
        expect(ring[0]).toEqual(ring[4]);

        // Extent is [[minLng,minLat],[maxLng,maxLat]] enclosing every cell.
        expect(extent[0][0]).toBeLessThanOrEqual(75.80);
        expect(extent[1][0]).toBeGreaterThanOrEqual(75.90);
        expect(extent[0][1]).toBeLessThanOrEqual(22.70);
        expect(extent[1][1]).toBeGreaterThanOrEqual(22.75);
    });

    it('prefers the true DIGIPIN cell rectangle when the code decodes', () => {
        // A real 10-char DIGIPIN encodes to a cell whose decoded bounds should
        // drive the polygon (not the ~90m lat/lng fallback square).
        const code = DigiPin.encode(22.7196, 75.8577);
        const { fc } = T2ML._toGeoJSON([{ code, lat: 0, lng: 0, score: 50 }]);
        const decoded = DigiPin.decode(code);
        const ring = fc.features[0].geometry.coordinates[0];
        const west = ring[0][0], east = ring[1][0];
        expect(west).toBeCloseTo(decoded.bounds.west, 6);
        expect(east).toBeCloseTo(decoded.bounds.east, 6);
        // Cell, not the centred-on-(0,0) fallback square.
        expect(west).toBeGreaterThan(70);
    });

    it('returns no features and a null extent for empty input', () => {
        const { fc, extent } = T2ML._toGeoJSON([]);
        expect(fc.features).toHaveLength(0);
        expect(extent).toBeNull();
    });
});
