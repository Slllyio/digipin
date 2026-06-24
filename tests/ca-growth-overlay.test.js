import { describe, it, expect } from 'vitest';

// CAGrowthOverlay is exposed on globalThis by tests/setup.js. The refresh() loop
// needs a live MapLibre map + DataFetcher, so these lock the pure pieces: the
// probability-band colour mapping, the per-cell polygon geometry, and the
// ca_growth_prob extraction (0..1 → 0..100) from a fetched cell result.
const C = globalThis.CAGrowthOverlay;

describe('CAGrowthOverlay.colorFor — urbanization-probability bands', () => {
    it('maps 0..100 probability to the sequential purple bands', () => {
        expect(C.colorFor(80)).toBe('#54278f');   // very likely
        expect(C.colorFor(70)).toBe('#54278f');   // band edge inclusive
        expect(C.colorFor(50)).toBe('#756bb1');   // likely
        expect(C.colorFor(45)).toBe('#756bb1');
        expect(C.colorFor(30)).toBe('#bcbddc');   // possible
        expect(C.colorFor(20)).toBe('#bcbddc');
        expect(C.colorFor(5)).toBe('#efedf5');    // unlikely
        expect(C.colorFor(0)).toBe('#efedf5');
    });

    it('is transparent when there is no signal', () => {
        expect(C.colorFor(null)).toBe('rgba(0,0,0,0)');
        expect(C.colorFor(undefined)).toBe('rgba(0,0,0,0)');
        expect(C.colorFor(NaN)).toBe('rgba(0,0,0,0)');
    });
});

describe('CAGrowthOverlay.cellFeature — sampled-point polygon', () => {
    it('builds a closed square centred on the point, coloured by probability', () => {
        const pt = { lat: 22.7, lng: 75.85, latStep: 0.01, lngStep: 0.02 };
        const f = C.cellFeature(pt, 75);
        expect(f.type).toBe('Feature');
        expect(f.geometry.type).toBe('Polygon');
        const ring = f.geometry.coordinates[0];
        expect(ring).toHaveLength(5);                       // closed ring
        expect(ring[0]).toEqual(ring[4]);                   // first === last
        const lngs = ring.map(c => c[0]), lats = ring.map(c => c[1]);
        expect((Math.min(...lngs) + Math.max(...lngs)) / 2).toBeCloseTo(75.85, 6);
        expect((Math.min(...lats) + Math.max(...lats)) / 2).toBeCloseTo(22.7, 6);
        expect(Math.max(...lngs) - Math.min(...lngs)).toBeCloseTo(0.02, 6);
        expect(Math.max(...lats) - Math.min(...lats)).toBeCloseTo(0.01, 6);
        expect(f.properties.color).toBe('#54278f');
        expect(f.properties.prob).toBe(75);
    });
});

describe('CAGrowthOverlay.probOf — extract ca_growth_prob from a cell result', () => {
    it('reads realtime.growth.ca_growth_prob (0..1) and scales to 0..100', () => {
        const result = { realtime: { growth: { ca_growth_prob: 0.72 } } };
        expect(C.probOf(result)).toBe(72);
    });

    it('clamps out-of-range values into 0..100', () => {
        expect(C.probOf({ realtime: { growth: { ca_growth_prob: 1.5 } } })).toBe(100);
        expect(C.probOf({ realtime: { growth: { ca_growth_prob: -0.2 } } })).toBe(0);
    });

    it('returns null when the CA layer is absent (graceful no-data)', () => {
        expect(C.probOf({})).toBe(null);
        expect(C.probOf({ realtime: {} })).toBe(null);
        expect(C.probOf({ realtime: { growth: {} } })).toBe(null);
        expect(C.probOf({ realtime: { growth: { ca_growth_prob: null } } })).toBe(null);
    });
});

describe('CAGrowthOverlay.BANDS — legend definition', () => {
    it('is a descending-threshold sequential ramp', () => {
        const mins = C.BANDS.map(b => b.min);
        expect(mins).toEqual([...mins].sort((a, b) => b - a));   // strictly descending
        expect(mins[mins.length - 1]).toBe(0);                   // covers down to 0
        for (const b of C.BANDS) expect(b.label).toBeTruthy();
    });
});
