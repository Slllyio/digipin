import { describe, it, expect } from 'vitest';

// GrowthOverlay is exposed on globalThis by tests/setup.js. The render loop
// needs a live MapLibre map + DataFetcher, so these lock the pure pieces: the
// band colour mapping, the per-cell polygon geometry, and horizon state.
const G = globalThis.GrowthOverlay;

describe('GrowthOverlay.colorFor — growth-intensity bands', () => {
    it('maps composite scores to the diverging band colours', () => {
        expect(G.colorFor(90)).toBe('#b2182b');   // intensifying
        expect(G.colorFor(75)).toBe('#b2182b');   // band edge inclusive
        expect(G.colorFor(70)).toBe('#ef8a62');   // rising
        expect(G.colorFor(50)).toBe('#fddbc7');   // emerging
        expect(G.colorFor(20)).toBe('#67a9cf');   // stable / cooling
        expect(G.colorFor(0)).toBe('#67a9cf');
    });

    it('is transparent when there is no signal', () => {
        expect(G.colorFor(null)).toBe('rgba(0,0,0,0)');
        expect(G.colorFor(undefined)).toBe('rgba(0,0,0,0)');
        expect(G.colorFor(NaN)).toBe('rgba(0,0,0,0)');
    });
});

describe('GrowthOverlay.cellFeature — sampled-point polygon', () => {
    it('builds a closed square centred on the point, coloured by score', () => {
        const pt = { lat: 22.7, lng: 75.85, latStep: 0.01, lngStep: 0.02 };
        const f = G.cellFeature(pt, 80);
        expect(f.type).toBe('Feature');
        expect(f.geometry.type).toBe('Polygon');
        const ring = f.geometry.coordinates[0];
        expect(ring).toHaveLength(5);                       // closed ring
        expect(ring[0]).toEqual(ring[4]);                   // first === last
        // Centre of the ring's bbox is the sample point.
        const lngs = ring.map(c => c[0]), lats = ring.map(c => c[1]);
        expect((Math.min(...lngs) + Math.max(...lngs)) / 2).toBeCloseTo(75.85, 6);
        expect((Math.min(...lats) + Math.max(...lats)) / 2).toBeCloseTo(22.7, 6);
        // Half-step extents.
        expect(Math.max(...lngs) - Math.min(...lngs)).toBeCloseTo(0.02, 6);
        expect(Math.max(...lats) - Math.min(...lats)).toBeCloseTo(0.01, 6);
        expect(f.properties.color).toBe('#b2182b');
        expect(f.properties.score).toBe(80);
    });
});

describe('GrowthOverlay horizons', () => {
    it('exposes three forecast horizons with labels', () => {
        expect(G.HORIZONS.map(h => h.key)).toEqual(['nowcast', 'year_2', 'year_5']);
        for (const h of G.HORIZONS) expect(h.label).toBeTruthy();
    });

    it('defaults to nowcast and only accepts known horizons', () => {
        expect(G.getHorizon()).toBe('nowcast');
        G.setHorizon('year_5');                             // not active → state only
        expect(G.getHorizon()).toBe('year_5');
        G.setHorizon('bogus');                              // ignored
        expect(G.getHorizon()).toBe('year_5');
        G.setHorizon('nowcast');                            // restore for other tests
        expect(G.getHorizon()).toBe('nowcast');
    });
});
