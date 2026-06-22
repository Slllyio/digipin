import { describe, it, expect } from 'vitest';

// DeckBuildings is exposed on globalThis by tests/setup.js. deck.gl itself is
// absent under jsdom, so available() is false and the GL paths are inert — we
// test the pure data helpers that prep Overture geometry for the deck layer.
const DB = globalThis.DeckBuildings;

describe('DeckBuildings.featureHeight', () => {
    it('prefers explicit height, then floors, then class fallbacks', () => {
        expect(DB.featureHeight({ height: 80 })).toBe(80);
        expect(DB.featureHeight({ height: 1 })).toBe(3);        // floored at 3m
        expect(DB.featureHeight({ num_floors: 10 })).toBeCloseTo(36);
        expect(DB.featureHeight({ class: 'commercial' })).toBe(35);
        expect(DB.featureHeight({})).toBe(12);                  // default
    });
});

describe('DeckBuildings.estimateHeight', () => {
    it('uses real height/floors when present', () => {
        expect(DB.estimateHeight({ height: 90 }, 5000, 'a')).toBe(90);
        expect(DB.estimateHeight({ num_floors: 20 }, 5000, 'a')).toBeCloseTo(72);
    });
    it('estimates from footprint area when no height data (bigger plot → taller)', () => {
        const small = DB.estimateHeight({}, 120, 'k1');
        const big = DB.estimateHeight({}, 8000, 'k1');   // same seed isolates the area effect
        expect(big).toBeGreaterThan(small);
        expect(small).toBeGreaterThanOrEqual(6);          // floored
        expect(big).toBeLessThanOrEqual(150);             // capped
    });
    it('is deterministic per seed but varies between buildings', () => {
        expect(DB.estimateHeight({}, 1000, 'x')).toBe(DB.estimateHeight({}, 1000, 'x'));
        expect(DB.estimateHeight({}, 1000, 'x')).not.toBe(DB.estimateHeight({}, 1000, 'y'));
    });
});

describe('DeckBuildings.featuresToPolygons', () => {
    const at = (lng, lat) => ({
        type: 'Feature',
        properties: { height: 50 },
        geometry: { type: 'Polygon', coordinates: [[
            [lng, lat], [lng + 0.0001, lat], [lng + 0.0001, lat + 0.0001], [lng, lat + 0.0001], [lng, lat]
        ]] }
    });
    const focus = { lat: 22.7196, lng: 75.8577 };

    it('extracts outer ring + height and de-dupes by centroid', () => {
        const near = at(75.8577, 22.7196);
        const recs = DB.featuresToPolygons([near, near], focus, 220);
        expect(recs).toHaveLength(1);                           // duplicate collapsed
        expect(recs[0].height).toBe(50);
        expect(Array.isArray(recs[0].polygon)).toBe(true);
        expect(recs[0].sel).toBe(true);                        // within focus radius
    });

    it('tags only buildings within the focus radius as selected', () => {
        const far = at(75.95, 22.80);
        const recs = DB.featuresToPolygons([far], focus, 220);
        expect(recs[0].sel).toBe(false);
        // no focus → nothing selected
        expect(DB.featuresToPolygons([far], null)[0].sel).toBe(false);
    });

    it('handles MultiPolygon and skips degenerate rings', () => {
        const multi = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [
            [[[75.8, 22.7], [75.8001, 22.7], [75.8001, 22.7001], [75.8, 22.7001], [75.8, 22.7]]],
            [[[75.81, 22.71], [75.81, 22.71]]]   // degenerate (<4 pts) → dropped
        ] } };
        expect(DB.featuresToPolygons([multi], null)).toHaveLength(1);
        expect(DB.featuresToPolygons([], null)).toEqual([]);
    });
});

describe('DeckBuildings.ringPaths', () => {
    const center = { lat: 22.7196, lng: 75.8577 };
    it('builds one closed ring per radius at the right distance', () => {
        const rings = DB.ringPaths(center, [150, 300]);
        expect(rings).toHaveLength(2);
        for (const r of rings) {
            expect(r.path[0]).toEqual(r.path[r.path.length - 1]);   // closed
            const [lng, lat] = r.path[0];
            const dLat = (lat - center.lat) * 111320;
            const dLng = (lng - center.lng) * 111320 * Math.cos(center.lat * Math.PI / 180);
            expect(Math.abs(Math.hypot(dLat, dLng) - r.radius)).toBeLessThan(r.radius * 0.05);
        }
        expect(DB.ringPaths(null)).toEqual([]);
        // default radii (no second arg) match the 150/300/450 focus-ring contract
        expect(DB.ringPaths(center).map(r => r.radius)).toEqual([150, 300, 450]);
    });
});

describe('DeckBuildings.available', () => {
    it('is false without deck.gl loaded (jsdom) and the GL methods stay inert', () => {
        expect(DB.available()).toBe(false);
        expect(DB.enable({}, () => null)).toBe(false);
        expect(DB.isEnabled()).toBe(false);
    });
});
