import { describe, it, expect } from 'vitest';

const T = globalThis.Trees3D;
// A ~200 m square park in central Indore.
const park = { type: 'Polygon', coordinates: [[[75.856, 22.718], [75.858, 22.718], [75.858, 22.720], [75.856, 22.720], [75.856, 22.718]]] };
const bbox = [75.85, 22.71, 75.87, 22.73];

describe('Trees3D placement', () => {
    it('plants a stable jittered grid of trees inside green polygons only', () => {
        const a = T.treePoints([park], bbox);
        expect(a.length).toBeGreaterThan(40);
        expect(a.length).toBeLessThan(180);
        for (const p of a) {
            expect(p.lng).toBeGreaterThan(75.856); expect(p.lng).toBeLessThan(75.858);
            expect(p.lat).toBeGreaterThan(22.718); expect(p.lat).toBeLessThan(22.720);
        }
        expect(T.treePoints([park], bbox)).toEqual(a);           // deterministic
    });

    it('respects the view box, holes and the cap', () => {
        expect(T.treePoints([park], [0, 0, 1, 1])).toEqual([]);
        const holed = { type: 'Polygon', coordinates: [park.coordinates[0], [[75.8562, 22.7182], [75.8578, 22.7182], [75.8578, 22.7198], [75.8562, 22.7198], [75.8562, 22.7182]]] };
        expect(T.treePoints([holed], bbox).length).toBeLessThan(T.treePoints([park], bbox).length / 2);
        expect(T.treePoints([park], bbox, 17, 5)).toHaveLength(5);
        expect(T.treePoints([{ type: 'LineString', coordinates: [] }, null], bbox)).toEqual([]);
    });

    it('builds a floating canopy over a trunk for each tree', () => {
        const fc = T.treeFeatures([{ lng: 75.857, lat: 22.719, r: 0.5 }]);
        expect(fc.features).toHaveLength(2);
        const [canopy, trunk] = fc.features;
        expect(canopy.properties.part).toBe('canopy');
        expect(canopy.properties.b).toBeGreaterThan(0);
        expect(canopy.properties.h).toBeGreaterThan(canopy.properties.b);
        expect(trunk.properties.b).toBe(0);
        expect(canopy.geometry.coordinates[0]).toHaveLength(9);
    });

    it('uses sage canopies in light and deep teal in dark', () => {
        expect(JSON.stringify(T.paint(true)['fill-extrusion-color'])).toContain('#b4c6a0');
        expect(JSON.stringify(T.paint(false)['fill-extrusion-color'])).toContain('#1c5446');
        expect(T.paint(true)['fill-extrusion-base']).toEqual(['get', 'b']);
    });
});
